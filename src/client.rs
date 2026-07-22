use crate::error::AppError;
use serde_json::{Value, json};
use ureq::Agent;
#[derive(Debug, Clone)]
pub struct LinearClient {
    endpoint: String,
    token: String,
    agent: Agent,
}
impl LinearClient {
    pub fn new(endpoint: String, token: String) -> Result<Self, AppError> {
        let url =
            url::Url::parse(&endpoint).map_err(|_| AppError::config("invalid GraphQL endpoint"))?;
        if url.scheme() != "https"
            && !matches!(
                url.host_str(),
                Some("localhost") | Some("127.0.0.1") | Some("[::1]")
            )
        {
            return Err(AppError::config("GraphQL endpoint must use HTTPS"));
        }
        Ok(Self {
            endpoint,
            token,
            agent: Agent::new_with_defaults(),
        })
    }
    pub fn query(&self, query: &str, variables: Value) -> Result<Value, AppError> {
        let body = json!({"query": query, "variables": variables});
        let response = self
            .agent
            .post(&self.endpoint)
            .header("Authorization", &self.token)
            .header("Content-Type", "application/json")
            .send_json(body)
            .map_err(|e| AppError::network(sanitize(&e.to_string())))?;
        let value: Value = response
            .into_body()
            .read_json()
            .map_err(|e| AppError::network(e.to_string()))?;
        if let Some(errors) = value.get("errors") {
            if errors.as_array().is_none_or(|items| !items.is_empty()) {
                return Err(AppError::api(errors.to_string()));
            }
        }
        Ok(value.get("data").cloned().unwrap_or(value))
    }

    pub fn paginate(&self, query: &str, mut variables: Value) -> Result<Value, AppError> {
        let mut merged: Option<Value> = None;
        loop {
            let page = self.query(query, variables.clone())?;
            let Some((path, nodes, has_next, cursor)) = find_connection(&page, &[]) else {
                return Ok(merged.unwrap_or(page));
            };
            let first_page = merged.is_none();
            if first_page {
                merged = Some(page.clone());
            }
            let root = merged.as_mut().unwrap();
            if let Some(connection) = path_value_mut(root, &path) {
                if !first_page {
                    if let Some(existing) =
                        connection.get_mut("nodes").and_then(Value::as_array_mut)
                    {
                        existing.extend(nodes);
                    }
                }
                if let Some(info) = connection
                    .get_mut("pageInfo")
                    .and_then(Value::as_object_mut)
                {
                    info.insert("hasNextPage".into(), Value::Bool(has_next));
                    info.insert(
                        "endCursor".into(),
                        cursor.clone().map_or(Value::Null, Value::String),
                    );
                }
            }
            if !has_next {
                return Ok(merged.unwrap());
            }
            variables
                .as_object_mut()
                .ok_or_else(|| AppError::usage("--paginate requires object variables"))?
                .insert("after".into(), cursor.map_or(Value::Null, Value::String));
        }
    }
    pub fn upload(&self, path: &std::path::Path, make_public: bool) -> Result<String, AppError> {
        let data = std::fs::read(path).map_err(|e| AppError::usage(e.to_string()))?;
        if data.len() > 100 * 1024 * 1024 {
            return Err(AppError::usage("file exceeds Linear 100MB upload limit"));
        }
        let filename = path
            .file_name()
            .and_then(|x| x.to_str())
            .ok_or_else(|| AppError::usage("invalid upload filename"))?;
        let result = self.query("mutation FileUpload($contentType:String!,$filename:String!,$size:Int!,$makePublic:Boolean){fileUpload(contentType:$contentType,filename:$filename,size:$size,makePublic:$makePublic){success uploadFile{assetUrl uploadUrl headers{key value}}}}", json!({"contentType":"application/octet-stream","filename":filename,"size":data.len(),"makePublic":make_public}))?;
        let file = result
            .get("fileUpload")
            .and_then(|x| x.get("uploadFile"))
            .ok_or_else(|| AppError::api("Linear did not return upload URL"))?;
        let url = file
            .get("uploadUrl")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::api("Linear upload response missing uploadUrl"))?;
        self.agent
            .put(url)
            .header("Content-Type", "application/octet-stream")
            .send(&data)
            .map_err(|e| AppError::network(e.to_string()))?;
        file.get("assetUrl")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| AppError::api("Linear upload response missing assetUrl"))
    }
}

type Connection = (Vec<String>, Vec<Value>, bool, Option<String>);
fn find_connection(v: &Value, path: &[String]) -> Option<Connection> {
    let obj = v.as_object()?;
    if let (Some(nodes), Some(info)) = (
        obj.get("nodes").and_then(Value::as_array),
        obj.get("pageInfo").and_then(Value::as_object),
    ) {
        return Some((
            path.to_vec(),
            nodes.clone(),
            info.get("hasNextPage")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            info.get("endCursor")
                .and_then(Value::as_str)
                .map(str::to_owned),
        ));
    }
    for (key, value) in obj {
        let mut next = path.to_vec();
        next.push(key.clone());
        if let Some(found) = find_connection(value, &next) {
            return Some(found);
        }
    }
    None
}

fn path_value_mut<'a>(mut value: &'a mut Value, path: &[String]) -> Option<&'a mut Value> {
    for key in path {
        value = value.get_mut(key)?;
    }
    Some(value)
}
fn sanitize(s: &str) -> String {
    s.replace("lin_api_", "lin_api_[redacted]")
}
mod url {
    pub use url::*;
}
