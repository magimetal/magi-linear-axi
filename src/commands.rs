pub mod cycle;
pub mod document;
pub mod initiative;
pub mod initiative_update;
pub mod issue;
pub mod label;
pub mod milestone;
pub mod project;
pub mod project_update;
pub mod resource;
pub mod team;
pub mod user;

use crate::{
    cli::Cli,
    cli::{ApiArgs, AuthCommand, IssueCommand, QueryArgs, SetupArgs},
    config,
    credentials::CredentialStore,
    error::AppError,
    output::Output,
};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};
pub fn parse_variable(s: &str) -> Result<(String, Value), String> {
    let (k, v) = s.split_once('=').ok_or("expected key=value")?;
    Ok((
        k.into(),
        serde_json::from_str(v).unwrap_or(Value::String(v.into())),
    ))
}
fn ctx(cli: &Cli) -> Result<(crate::client::LinearClient, Output), AppError> {
    let c = config::Config::load(cli.endpoint.clone(), cli.workspace.clone())?;
    let t = c
        .api_key
        .clone()
        .or_else(env_key)
        .or_else(|| {
            CredentialStore::load()
                .ok()
                .and_then(|s| s.token(c.workspace.as_deref()).ok())
        })
        .ok_or_else(|| {
            AppError::auth("no API key; set LINEAR_API_KEY, configure api_key, or run auth login")
        })?;
    Ok((
        crate::client::LinearClient::new(c.endpoint, t)?,
        Output::new(cli.format.clone(), cli.full),
    ))
}

fn env_key() -> Option<String> {
    std::env::var("LINEAR_API_KEY")
        .ok()
        .filter(|s| !s.is_empty())
}
pub fn api(cli: &Cli, a: ApiArgs) -> Result<(), AppError> {
    let q = Cli::read_query(a.query)?;
    let mut vars = if let Some(v) = a.variables_json {
        serde_json::from_str::<serde_json::Map<String, Value>>(&v)
            .map_err(|e| AppError::usage(format!("invalid --variables-json: {e}")))?
    } else {
        serde_json::Map::new()
    };
    for (k, v) in a.variable {
        vars.insert(k, v);
    }
    let (c, o) = ctx(cli)?;
    let v = if a.paginate {
        c.paginate(&q, Value::Object(vars))?
    } else {
        c.query(&q, Value::Object(vars))?
    };
    if !a.silent { o.render(&v) } else { Ok(()) }
}
pub fn schema(cli: &Cli, path: Option<PathBuf>) -> Result<(), AppError> {
    let (c, o) = ctx(cli)?;
    let v = c.query("query FullSchema { __schema { queryType { name } mutationType { name } subscriptionType { name } types { kind name description fields(includeDeprecated:true) { name description isDeprecated deprecationReason args { name description defaultValue type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } inputFields { name description defaultValue type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } interfaces { kind name } enumValues(includeDeprecated:true) { name description isDeprecated deprecationReason } possibleTypes { kind name } } } }", json!({}))?;
    if let Some(p) = path {
        config::write_atomic(&p, &serde_json::to_string_pretty(&v).unwrap())
    } else {
        o.render(&v)
    }
}
pub fn auth(cli: &Cli, cmd: AuthCommand) -> Result<(), AppError> {
    let mut s = CredentialStore::load()?;
    match cmd {
        AuthCommand::Login { key, workspace } => {
            let key = key.ok_or_else(|| AppError::auth("--key or LINEAR_API_KEY required"))?;
            s.set_token(&workspace, &key)?;
            s.keys.insert(workspace.clone(), String::new());
            s.default.get_or_insert(workspace);
            s.save()
        }
        AuthCommand::List => Output::new(cli.format.clone(), cli.full)
            .render(&json!({"workspaces":s.keys.keys().collect::<Vec<_>>(),"default":s.default})),
        AuthCommand::Default { workspace } => {
            if !s.keys.contains_key(&workspace) {
                return Err(AppError::auth("workspace not configured"));
            }
            s.default = Some(workspace);
            s.save()
        }
        AuthCommand::Logout { workspace } => {
            let w = workspace
                .or(s.default.clone())
                .ok_or_else(|| AppError::auth("no workspace configured"))?;
            s.delete_token(&w)?;
            s.keys.remove(&w);
            s.save()
        }
        AuthCommand::Token => {
            println!("{}", s.token(cli.workspace.as_deref())?);
            Ok(())
        }
        AuthCommand::Whoami => api(
            cli,
            ApiArgs {
                query: Some("{ viewer { id name email } }".into()),
                variable: vec![],
                variables_json: None,
                paginate: false,
                silent: false,
            },
        ),
    }
}
pub fn home(cli: &Cli) -> Result<(), AppError> {
    let bin = std::env::current_exe()
        .ok()
        .map(|path| display_home_path(&path))
        .unwrap_or_else(|| "magi-linear-axi".into());
    Output::new(cli.format.clone(), cli.full).render(&json!({
        "bin": bin,
        "description": "Agent-native Linear GraphQL CLI",
        "live": {"format": cli.format, "auth": "LINEAR_API_KEY or auth login"},
        "help": ["magi-linear-axi --help", "magi-linear-axi api <graphql>", "magi-linear-axi issue list"]
    }))
}
fn display_home_path(path: &std::path::Path) -> String {
    let path = path.to_string_lossy();
    std::env::var_os("HOME")
        .and_then(|home| {
            path.strip_prefix(home.to_string_lossy().as_ref())
                .map(str::to_owned)
        })
        .filter(|suffix| !suffix.is_empty())
        .map(|suffix| format!("~{suffix}"))
        .unwrap_or_else(|| path.into_owned())
}
pub fn config(path: Option<PathBuf>, team: Option<String>) -> Result<(), AppError> {
    let p = path.unwrap_or_else(|| PathBuf::from(".linear.toml"));
    let existing = fs::read_to_string(&p).unwrap_or_default();
    let mut value: toml::Value =
        toml::from_str(&existing).unwrap_or_else(|_| toml::Value::Table(Default::default()));
    if let Some(team) = team {
        value
            .as_table_mut()
            .unwrap()
            .insert("team_id".into(), toml::Value::String(team));
    }
    config::write_atomic(
        &p,
        &toml::to_string_pretty(&value).map_err(|e| AppError::config(e.to_string()))?,
    )
}

pub fn setup(a: SetupArgs) -> Result<(), AppError> {
    let home = a.path.unwrap_or_else(|| {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
    });
    let targets: Vec<&str> = if !a.claude && !a.codex && !a.opencode {
        vec!["claude", "codex", "opencode"]
    } else {
        [
            ("claude", a.claude),
            ("codex", a.codex),
            ("opencode", a.opencode),
        ]
        .into_iter()
        .filter_map(|(n, yes)| yes.then_some(n))
        .collect()
    };
    for target in targets {
        match target {
            "claude" => {
                let p = home.join(".claude/settings.json");
                let mut v = read_json(&p)?;
                let hooks = v
                    .as_object_mut()
                    .unwrap()
                    .entry("hooks")
                    .or_insert_with(|| json!({}));
                let events = hooks.as_object_mut().unwrap();
                events.entry("SessionStart").or_insert_with(
                    || json!([{"hooks":[{"type":"command","command":"magi-linear-axi"}]}]),
                );
                write_json(&p, &v)?;
            }
            "codex" => {
                let p = home.join(".codex/hooks.json");
                let mut v = read_json(&p)?;
                let hooks = v
                    .as_object_mut()
                    .unwrap()
                    .entry("hooks")
                    .or_insert_with(|| json!({}));
                hooks
                    .as_object_mut()
                    .unwrap()
                    .entry("SessionStart")
                    .or_insert_with(|| json!([{"command":"magi-linear-axi"}]));
                write_json(&p, &v)?;
                let cfg = home.join(".codex/config.toml");
                let raw = fs::read_to_string(&cfg).unwrap_or_default();
                let mut parsed: toml::Value =
                    toml::from_str(&raw).unwrap_or_else(|_| toml::Value::Table(Default::default()));
                let table = parsed.as_table_mut().unwrap();
                let features = table
                    .entry("features")
                    .or_insert_with(|| toml::Value::Table(Default::default()))
                    .as_table_mut()
                    .unwrap();
                features.insert("hooks".into(), toml::Value::Boolean(true));
                config::write_atomic(
                    &cfg,
                    &toml::to_string_pretty(&parsed)
                        .map_err(|e| AppError::config(e.to_string()))?,
                )?;
            }
            "opencode" => {
                let p = home.join(".config/opencode/plugins/magi-linear-axi.js");
                config::write_atomic(
                    &p,
                    "export default async function LinearAxiPlugin() {\n  return {\n    \"session.created\": async () => {},\n  };\n}\n",
                )?;
            }
            _ => unreachable!(),
        }
    }
    Ok(())
}
fn read_json(path: &std::path::Path) -> Result<Value, AppError> {
    if !path.exists() {
        return Ok(json!({}));
    }
    serde_json::from_str(&fs::read_to_string(path).map_err(|e| AppError::config(e.to_string()))?)
        .map_err(|e| AppError::config(format!("{}: {e}", path.display())))
}
fn write_json(path: &std::path::Path, value: &Value) -> Result<(), AppError> {
    config::write_atomic(
        path,
        &serde_json::to_string_pretty(value).map_err(|e| AppError::config(e.to_string()))?,
    )
}

pub fn issues(cli: &Cli, cmd: Option<IssueCommand>) -> Result<(), AppError> {
    let command = cmd.unwrap_or(IssueCommand::Query(QueryArgs::default()));
    issue::execute(cli, command)
}
