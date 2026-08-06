use crate::error::AppError;
use serde_json::{Value, json};
use std::{
    fs::OpenOptions,
    io::{Read, Write},
    thread,
    time::{Duration, Instant},
};
use ureq::Agent;

fn timing_event(component: &str, duration_ms: u128) {
    let Some(path) = std::env::var_os("MAGI_LINEAR_TIMING_FILE") else {
        return;
    };
    let label = match component {
        "graphqlAttempt" | "graphqlRetry" => component,
        _ => return,
    };
    let Ok(duration_ms) = u64::try_from(duration_ms) else {
        return;
    };
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let _ = writeln!(
        file,
        "{{\"component\":\"{label}\",\"durationMs\":{duration_ms}}}"
    );
}

fn retry_event() {
    timing_event("graphqlRetry", 0);
}

const RESPONSE_PREVIEW_LIMIT: usize = 512;
const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
const MAX_ATTEMPTS: usize = 3;

#[derive(Debug, Clone, Copy)]
enum Operation {
    Read,
    Mutation,
    Ambiguous,
}

#[derive(Debug)]
struct HttpFailure {
    status: Option<u16>,
    detail: String,
    transient: bool,
}

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
            agent: Agent::config_builder()
                .http_status_as_error(false)
                .build()
                .into(),
        })
    }

    pub fn query(&self, query: &str, variables: Value) -> Result<Value, AppError> {
        self.request(query, variables, Operation::Read)
    }

    pub fn mutation(&self, query: &str, variables: Value) -> Result<Value, AppError> {
        self.request(query, variables, Operation::Mutation)
    }
    pub fn raw(&self, query: &str, variables: Value) -> Result<Value, AppError> {
        self.request(query, variables, Operation::Ambiguous)
    }

    fn request(
        &self,
        query: &str,
        variables: Value,
        operation: Operation,
    ) -> Result<Value, AppError> {
        let body = json!({"query": query, "variables": variables});
        for attempt in 1..=MAX_ATTEMPTS {
            match self.send(&body) {
                Ok(value) => {
                    if let Some(errors) = value.get("errors") {
                        if errors.as_array().is_none_or(|items| !items.is_empty()) {
                            return Err(AppError::api(preview(
                                &errors.to_string(),
                                &self.token,
                                false,
                            )));
                        }
                    }
                    return Ok(value.get("data").cloned().unwrap_or(value));
                }
                Err(failure) if attempt < MAX_ATTEMPTS && should_retry(&failure, operation) => {
                    retry_event();
                    let status = failure
                        .status
                        .map_or_else(|| "connection failure".into(), |s| format!("HTTP {s}"));
                    eprintln!(
                        "retrying Linear request after transient {status} (attempt {attempt}/{MAX_ATTEMPTS})"
                    );
                    thread::sleep(Duration::from_millis(if attempt == 1 { 50 } else { 100 }));
                }
                Err(failure) => {
                    let status = failure
                        .status
                        .map_or_else(|| "connection failure".into(), |s| format!("HTTP {s}"));
                    return Err(AppError::network(format!("{status}: {}", failure.detail)));
                }
            }
        }
        unreachable!()
    }

    fn send(&self, body: &Value) -> Result<Value, HttpFailure> {
        let started = Instant::now();
        let result = self.send_timed(body);
        timing_event("graphqlAttempt", started.elapsed().as_millis());
        result
    }

    fn send_timed(&self, body: &Value) -> Result<Value, HttpFailure> {
        let response = self
            .agent
            .post(&self.endpoint)
            .header("Authorization", &self.token)
            .header("Content-Type", "application/json")
            .send_json(body)
            .map_err(|e| HttpFailure {
                status: None,
                detail: sanitize(&e.to_string(), &self.token),
                transient: transient_transport(&e),
            })?;
        let status = response.status().as_u16();
        let (text, truncated, read_error) = if (200..300).contains(&status) {
            read_limited(response.into_body().into_reader(), MAX_RESPONSE_BYTES)
        } else {
            read_limited(
                response.into_body().into_reader(),
                response_preview_read_limit(&self.token),
            )
        };
        if !(200..300).contains(&status) {
            let detail = read_error.map_or_else(
                || failure_detail(&text, &self.token, truncated),
                |error| sanitize(&format!("response body read failed: {error}"), &self.token),
            );
            return Err(HttpFailure {
                status: Some(status),
                detail,
                transient: false,
            });
        }
        if let Some(error) = read_error {
            return Err(HttpFailure {
                status: None,
                detail: sanitize(&format!("response body read failed: {error}"), &self.token),
                transient: true,
            });
        }
        if truncated {
            return Err(HttpFailure {
                status: Some(status),
                detail: format!("response exceeds {MAX_RESPONSE_BYTES} bytes"),
                transient: false,
            });
        }
        serde_json::from_str(&text).map_err(|e| HttpFailure {
            status: Some(status),
            detail: preview(&format!("{text}: {e}"), &self.token, false),
            transient: false,
        })
    }

    pub fn paginate(&self, query: &str, variables: Value) -> Result<Value, AppError> {
        self.paginate_with_operation(query, variables, Operation::Read)
    }

    pub fn raw_paginate(&self, query: &str, variables: Value) -> Result<Value, AppError> {
        self.paginate_with_operation(query, variables, Operation::Ambiguous)
    }

    fn paginate_with_operation(
        &self,
        query: &str,
        mut variables: Value,
        operation: Operation,
    ) -> Result<Value, AppError> {
        let mut merged: Option<Value> = None;
        loop {
            let page = self.request(query, variables.clone(), operation)?;
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
        let result = self.mutation("mutation FileUpload($contentType:String!,$filename:String!,$size:Int!,$makePublic:Boolean){fileUpload(contentType:$contentType,filename:$filename,size:$size,makePublic:$makePublic){success uploadFile{assetUrl uploadUrl headers{key value}}}}", json!({"contentType":"application/octet-stream","filename":filename,"size":data.len(),"makePublic":make_public}))?;
        let file = result
            .get("fileUpload")
            .and_then(|x| x.get("uploadFile"))
            .ok_or_else(|| AppError::api("Linear did not return upload URL"))?;
        let url = file
            .get("uploadUrl")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::api("Linear upload response missing uploadUrl"))?;
        let response = self
            .agent
            .put(url)
            .header("Content-Type", "application/octet-stream")
            .send(&data)
            .map_err(|e| AppError::network(sanitize(&e.to_string(), &self.token)))?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let (text, truncated, read_error) = read_limited(
                response.into_body().into_reader(),
                response_preview_read_limit(&self.token),
            );
            let detail = read_error.map_or_else(
                || failure_detail(&text, &self.token, truncated),
                |error| sanitize(&format!("response body read failed: {error}"), &self.token),
            );
            return Err(AppError::network(format!("HTTP {status}: {detail}")));
        }
        file.get("assetUrl")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| AppError::api("Linear upload response missing assetUrl"))
    }
}
type Connection = (Vec<String>, Vec<Value>, bool, Option<String>);

fn should_retry(failure: &HttpFailure, operation: Operation) -> bool {
    matches!(operation, Operation::Read)
        && (matches!(failure.status, Some(500 | 502 | 503 | 504)) || failure.transient)
}

fn transient_transport(error: &ureq::Error) -> bool {
    matches!(
        error,
        ureq::Error::Io(_)
            | ureq::Error::Timeout(_)
            | ureq::Error::HostNotFound
            | ureq::Error::ConnectionFailed
            | ureq::Error::ConnectProxyFailed(_)
    )
}

fn response_preview_read_limit(token: &str) -> usize {
    RESPONSE_PREVIEW_LIMIT.saturating_add(token.len())
}

fn read_limited(mut body: impl Read, limit: usize) -> (String, bool, Option<String>) {
    let mut bytes = Vec::with_capacity(limit.min(8192));
    let result = (&mut body).take((limit + 1) as u64).read_to_end(&mut bytes);
    let truncated = bytes.len() > limit;
    bytes.truncate(limit);
    (
        String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
        result.err().map(|error| error.to_string()),
    )
}

fn failure_detail(text: &str, token: &str, truncated: bool) -> String {
    if !truncated {
        if let Ok(value) = serde_json::from_str::<Value>(text) {
            if let Some(errors) = value.get("errors") {
                return preview(&errors.to_string(), token, false);
            }
        }
    }
    preview(text, token, truncated)
}

fn preview(text: &str, token: &str, truncated: bool) -> String {
    let sanitized = sanitize(text, token);
    let mut end = sanitized.len().min(RESPONSE_PREVIEW_LIMIT);
    while !sanitized.is_char_boundary(end) {
        end -= 1;
    }
    let mut output = sanitized[..end].to_owned();
    if truncated || text.len() > RESPONSE_PREVIEW_LIMIT || sanitized.len() > RESPONSE_PREVIEW_LIMIT
    {
        output.push_str("… [truncated]");
    }
    output
}
fn sanitize(text: &str, token: &str) -> String {
    let mut out = text.replace(token, "[redacted]");
    while let Some(start) = out.find("lin_api_") {
        let end = out[start..]
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ',' | '}' | ']'))
            .map_or(out.len(), |n| start + n);
        out.replace_range(start..end, "[redacted-token]");
    }
    out
}

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
mod url {
    pub use url::*;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_retry_is_read_only() {
        let failure = HttpFailure {
            status: Some(503),
            detail: String::new(),
            transient: false,
        };
        assert!(!should_retry(&failure, Operation::Mutation));
        assert!(!should_retry(&failure, Operation::Ambiguous));
    }

    #[test]
    fn response_preview_is_bounded_and_redacted() {
        let token = "lin_api_configured";
        let input = format!("{token} lin_api_shaped {}", "x".repeat(600));
        let output = preview(&input, token, false);
        assert!(output.contains("truncated"));
        assert!(!output.contains(token));
        assert!(!output.contains("lin_api_shaped"));
    }

    #[test]
    fn configured_token_crossing_preview_boundary_is_redacted() {
        let token = "opaque-secret";
        let input = format!("{}{token}", "x".repeat(RESPONSE_PREVIEW_LIMIT - 4));
        let output = preview(&input, token, false);
        assert!(!output.contains(token));
        assert!(!output.contains("opaque"));
        assert!(output.contains("truncated"));
        assert!(response_preview_read_limit(token) >= input.len());
    }

    #[test]
    fn transport_failures_have_no_http_status() {
        let failure = HttpFailure {
            status: None,
            detail: "offline".into(),
            transient: true,
        };
        assert!(should_retry(&failure, Operation::Read));
        assert!(!should_retry(&failure, Operation::Ambiguous));
    }
}
