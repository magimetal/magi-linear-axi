use crate::{cli::*, config, error::AppError, output::Output};
use serde_json::{Value, json};
use std::process::Command as ProcessCommand;

fn ctx(cli: &Cli) -> Result<(crate::client::LinearClient, Output), AppError> {
    let c = config::Config::load(cli.endpoint.clone(), cli.workspace.clone())?;
    Ok((
        crate::client::LinearClient::new(c.endpoint, config::api_key()?)?,
        Output::new(cli.format.clone(), cli.full),
    ))
}
fn issue_id(value: Option<&str>) -> Result<String, AppError> {
    if let Some(id) = value {
        if !id.trim().is_empty() {
            return Ok(id.to_uppercase());
        }
    }
    if let Ok(branch) = ProcessCommand::new("git")
        .args(["branch", "--show-current"])
        .output()
    {
        let b = String::from_utf8_lossy(&branch.stdout);
        for part in b.split(|c: char| !c.is_ascii_alphanumeric() && c != '-') {
            if part.split_once('-').is_some()
                && part
                    .rsplit_once('-')
                    .and_then(|(_, n)| n.parse::<u64>().ok())
                    .is_some()
            {
                return Ok(part.to_uppercase());
            }
        }
    }
    Err(AppError::usage(
        "issue ID required (for example ENG-123), or run on issue branch",
    ))
}
fn run(cli: &Cli, query: &str, vars: Value) -> Result<(), AppError> {
    let (c, o) = ctx(cli)?;
    o.render(&c.query(query, vars)?)
}
fn one(cli: &Cli, id: &str, field: &str) -> Result<(), AppError> {
    let q =
        format!("query Issue($id:String!) {{ issue(id:$id) {{ identifier title url {field} }} }}");
    let (c, o) = ctx(cli)?;
    let value = c.query(&q, json!({"id":id}))?;
    if value.get("issue").is_none_or(Value::is_null) {
        return Err(AppError::api(format!("issue {id} not found")));
    }
    o.render(&value)
}
pub fn execute(cli: &Cli, command: IssueCommand) -> Result<(), AppError> {
    match command {
        IssueCommand::Id(a) => {
            println!("{}", issue_id(a.issue.as_deref())?);
            Ok(())
        }
        IssueCommand::Title(a) => one(cli, &issue_id(a.issue.as_deref())?, "title"),
        IssueCommand::Url(a) => one(cli, &issue_id(a.issue.as_deref())?, "url"),
        IssueCommand::Describe(a) => one(cli, &issue_id(a.issue.as_deref())?, "description"),
        IssueCommand::View(a) => {
            let id = issue_id(a.issue.issue.as_deref())?;
            if a.issue.web || a.issue.app {
                return open_issue_url(cli, &id, a.issue.web);
            }
            one(
                cli,
                &id,
                match a.fields {
                    Some(FieldPreset::Compact) => "state { name type }",
                    None => {
                        "description state { name type } assignee { name } comments { nodes { id body } }"
                    }
                },
            )
        }
        IssueCommand::Mine(a) => query(cli, a.query, a.fields, true),
        IssueCommand::List(a) | IssueCommand::Query(a) => query(cli, a.query, a.fields, false),
        IssueCommand::Start(a) => {
            let id = issue_id(a.issue.as_deref())?;
            mutate(
                cli,
                "mutation StartIssue($id:String!,$input:IssueUpdateInput!){issueUpdate(id:$id,input:$input){success issue{identifier title url state{name type}}}}",
                json!({"id":id,"input":{"stateId":"started"}}),
            )
        }
        IssueCommand::PullRequest(a) => {
            let id = issue_id(a.issue.as_deref())?;
            let status = ProcessCommand::new("gh")
                .args(["pr", "list", "--head", "HEAD", "--json", "url"])
                .status()
                .map_err(|e| AppError::usage(format!("gh unavailable: {e}")))?;
            if !status.success() {
                return Err(AppError::network("gh pr list failed"));
            }
            one(cli, &id, "url")
        }
        IssueCommand::Commits(a) => {
            let id = issue_id(a.issue.as_deref())?;
            let output = ProcessCommand::new("git")
                .args(["log", "-n", "50", "--pretty=format:%H%x09%s"])
                .output()
                .map_err(|e| AppError::usage(e.to_string()))?;
            let commits: Vec<Value> = String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(|line| {
                    let (hash, subject) = line.split_once('\t').unwrap_or((line, ""));
                    json!({"hash":hash,"subject":subject})
                })
                .collect();
            let _ = id;
            Output::new(cli.format.clone(), cli.full).render(&json!({"commits":commits}))
        }
        IssueCommand::Delete(a) => delete_issue(cli, &issue_id(a.issue.as_deref())?),
        IssueCommand::Create(a) => create(cli, a),
        IssueCommand::Update(a) => update(cli, a),
        IssueCommand::Comment { command } => comment(cli, command),
        IssueCommand::Attach(a) => attach(cli, a),
        IssueCommand::Link(a) => mutate(
            cli,
            "mutation AttachmentCreate($input:AttachmentCreateInput!){ attachmentCreate(input:$input){success attachment{id url title}} }",
            json!({"input":{"issueId":a.issue,"url":a.url,"title":a.title.unwrap_or(a.url)}}),
        ),
        IssueCommand::Relation { command } => relation(cli, command),
        IssueCommand::AgentSession { command } => agent_session(cli, command),
    }
}
fn query(cli: &Cli, a: QueryArgs, fields: Option<FieldPreset>, mine: bool) -> Result<(), AppError> {
    let mut filter = serde_json::Map::new();
    if let Some(s) = a.search {
        filter.insert("title".into(), json!({"containsIgnoreCase": s}));
    }
    if let Some(t) = a.team {
        filter.insert("team".into(), json!({"key": {"eq": t.to_uppercase()}}));
    }
    if let Some(x) = a.assignee {
        filter.insert("assignee".into(), json!({"id": {"eq": x}}));
    }
    if !a.state.is_empty() {
        filter.insert("state".into(), json!({"name":{"in":a.state}}));
    }
    if let Some(project) = a.project {
        filter.insert("project".into(), json!({"id":{"eq":project}}));
    }
    if let Some(milestone) = a.milestone {
        filter.insert("projectMilestone".into(), json!({"id":{"eq":milestone}}));
    }
    if !a.label.is_empty() {
        filter.insert("labels".into(), json!({"some":{"name":{"in":a.label}}}));
    }
    if a.unassigned {
        filter.insert("assignee".into(), json!({"id": null}));
    }
    if mine {
        let (client, _) = ctx(cli)?;
        let viewer = client.query("query Viewer { viewer { id } }", json!({}))?;
        let id = viewer
            .get("viewer")
            .and_then(|v| v.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::api("viewer has no id"))?;
        filter.insert("assignee".into(), json!({"id": {"eq": id}}));
    }
    let q = match fields {
        Some(FieldPreset::Compact) => {
            "query Issues($filter:IssueFilter,$first:Int,$after:String){issues(filter:$filter,first:$first,after:$after){nodes{identifier title} pageInfo{hasNextPage endCursor}}}"
        }
        None => {
            "query Issues($filter:IssueFilter,$first:Int,$after:String){issues(filter:$filter,first:$first,after:$after){nodes{id identifier title url priority state{name type} assignee{name}} pageInfo{hasNextPage endCursor}}}"
        }
    };
    run(
        cli,
        q,
        json!({"filter":filter,"first":a.limit,"after":null}),
    )
}
fn mutate(cli: &Cli, q: &str, v: Value) -> Result<(), AppError> {
    let (c, o) = ctx(cli)?;
    o.render(&c.mutation(q, v)?)
}
fn delete_issue(cli: &Cli, id: &str) -> Result<(), AppError> {
    let (c, o) = ctx(cli)?;
    let value = c.mutation(
        "mutation IssueDelete($id:String!){issueDelete(id:$id){success}}",
        json!({"id":id}),
    )?;
    if value
        .get("issueDelete")
        .and_then(|v| v.get("success"))
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Err(AppError::api("issue delete was not successful"));
    }
    o.render(&value)
}
fn create(cli: &Cli, a: IssueCreateArgs) -> Result<(), AppError> {
    let title = a.title.ok_or_else(|| AppError::usage("--title required"))?;
    let team = a.team.ok_or_else(|| AppError::usage("--team required"))?;
    mutate(
        cli,
        "mutation IssueCreate($input:IssueCreateInput!){ issueCreate(input:$input){success issue{id identifier title url}} }",
        json!({"input":{"title":title,"description":a.description,"teamId":team,"priority":a.priority}}),
    )
}
fn update(cli: &Cli, a: IssueUpdateArgs) -> Result<(), AppError> {
    let id = issue_id(a.issue.as_deref())?;
    let mut input = json!({});
    let o = input.as_object_mut().unwrap();
    if let Some(x) = a.title {
        o.insert("title".into(), x.into());
    }
    if let Some(x) = a.description {
        o.insert("description".into(), x.into());
    }
    if let Some(x) = a.priority {
        o.insert("priority".into(), x.into());
    }
    if a.unassign {
        o.insert("assigneeId".into(), Value::Null);
    };
    if o.is_empty() {
        return Err(AppError::usage("update requires at least one field"));
    }
    mutate(
        cli,
        "mutation IssueUpdate($id:String!,$input:IssueUpdateInput!){ issueUpdate(id:$id,input:$input){success issue{identifier title url}} }",
        json!({"id":id,"input":input}),
    )
}
fn comment(cli: &Cli, c: CommentCommand) -> Result<(), AppError> {
    match c {
        CommentCommand::List(a) => {
            let id = issue_id(a.issue.issue.as_deref())?;
            match a.fields {
                Some(FieldPreset::Compact) => run(
                    cli,
                    "query Comments($id:String!,$first:Int,$after:String){issue(id:$id){comments(first:$first,after:$after){nodes{id body} pageInfo{hasNextPage endCursor}}}}",
                    json!({"id":id,"first":a.limit,"after":null}),
                ),
                None => run(
                    cli,
                    "query Comments($id:String!){ issue(id:$id){ comments{nodes{id body createdAt user{name}}}}}",
                    json!({"id":id}),
                ),
            }
        }
        CommentCommand::Add(a) => mutate(
            cli,
            "mutation CommentCreate($input:CommentCreateInput!){ commentCreate(input:$input){success comment{id body}} }",
            json!({"input":{"issueId":issue_id(a.issue.as_deref())?,"body":a.body.ok_or_else(||AppError::usage("--body required"))?}}),
        ),
        CommentCommand::Delete(a) => mutate(
            cli,
            "mutation CommentDelete($id:String!){ commentDelete(id:$id){success} }",
            json!({"id":a.issue.ok_or_else(||AppError::usage("comment ID required"))?}),
        ),
        CommentCommand::Update(a) => mutate(
            cli,
            "mutation CommentUpdate($id:String!,$input:CommentUpdateInput!){ commentUpdate(id:$id,input:$input){success comment{id body}} }",
            json!({"id":a.comment,"input":{"body":a.body.ok_or_else(||AppError::usage("--body required"))?}}),
        ),
    }
}
fn attach(cli: &Cli, a: AttachArgs) -> Result<(), AppError> {
    if !a.filepath.is_file() {
        return Err(AppError::usage(format!(
            "file not found: {}",
            a.filepath.display()
        )));
    }
    let (client, _) = ctx(cli)?;
    let url = client.upload(&a.filepath, a.public)?;
    mutate(
        cli,
        "mutation AttachmentCreate($input:AttachmentCreateInput!){attachmentCreate(input:$input){success attachment{id url title}}}",
        json!({"input":{"issueId":a.issue,"url":url,"title":a.title.unwrap_or_else(|| a.filepath.file_name().unwrap_or_default().to_string_lossy().into_owned())}}),
    )
}
fn relation(cli: &Cli, c: RelationCommand) -> Result<(), AppError> {
    match c {
        RelationCommand::List(a) => {
            let id = issue_id(a.issue.issue.as_deref())?;
            match a.fields {
                Some(FieldPreset::Compact) => run(
                    cli,
                    "query Relations($id:String!,$first:Int,$after:String){issue(id:$id){identifier relations(first:$first,after:$after){nodes{type relatedIssue{identifier title}} pageInfo{hasNextPage endCursor}} inverseRelations(first:$first,after:$after){nodes{type issue{identifier title}} pageInfo{hasNextPage endCursor}}}}",
                    json!({"id":id,"first":a.limit,"after":null}),
                ),
                None => run(
                    cli,
                    "query Relations($id:String!){issue(id:$id){identifier relations{nodes{id type relatedIssue{identifier title}}} inverseRelations{nodes{id type issue{identifier title}}}}}",
                    json!({"id":id}),
                ),
            }
        }
        RelationCommand::Add(a) => mutate(
            cli,
            "mutation RelationCreate($input:IssueRelationCreateInput!){issueRelationCreate(input:$input){success issueRelation{id}}}",
            json!({"input":{"issueId":issue_id(Some(&a.issue))?,"relatedIssueId":issue_id(Some(&a.related_issue))?,"type":a.relation_type}}),
        ),
        RelationCommand::Delete(a) => mutate(
            cli,
            "mutation RelationDelete($id:String!){issueRelationDelete(id:$id){success}}",
            json!({"id":a.related_issue}),
        ),
    }
}
fn agent_session(cli: &Cli, c: AgentSessionCommand) -> Result<(), AppError> {
    match c {
        AgentSessionCommand::List(a) | AgentSessionCommand::View(a) => run(
            cli,
            "query AgentSessions($id:String!){issue(id:$id){identifier agentSessions{nodes{id status createdAt}}}}",
            json!({"id":issue_id(a.issue.as_deref())?}),
        ),
    }
}
fn open_issue_url(cli: &Cli, id: &str, web: bool) -> Result<(), AppError> {
    let workspace = cli
        .workspace
        .as_deref()
        .ok_or_else(|| AppError::usage("--workspace required for browser opening"))?;
    let url = if web {
        format!("https://linear.app/{workspace}/issue/{id}")
    } else {
        format!("linear://issue/{id}")
    };
    let status = if cfg!(target_os = "macos") {
        ProcessCommand::new("open").arg(url).status()
    } else if cfg!(target_os = "windows") {
        ProcessCommand::new("cmd")
            .args(["/C", "start", &url])
            .status()
    } else {
        ProcessCommand::new("xdg-open").arg(url).status()
    };
    status
        .map_err(|e| AppError::usage(e.to_string()))
        .and_then(|s| {
            s.success()
                .then_some(())
                .ok_or_else(|| AppError::usage("browser open failed"))
        })
}
