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
    error::AppError,
    output::Output,
};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};
fn executable_path() -> Result<String, AppError> {
    std::env::current_exe()
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|e| AppError::config(format!("cannot resolve current executable: {e}")))
}

fn js_string_literal(value: &str) -> String {
    serde_json::to_string(value).expect("string serialization cannot fail")
}
pub fn parse_variable(s: &str) -> Result<(String, Value), String> {
    let (k, v) = s.split_once('=').ok_or("expected key=value")?;
    Ok((
        k.into(),
        serde_json::from_str(v).unwrap_or(Value::String(v.into())),
    ))
}
fn ctx(cli: &Cli) -> Result<(crate::client::LinearClient, Output), AppError> {
    let c = config::Config::load(cli.endpoint.clone(), cli.workspace.clone())?;
    let token = config::api_key()?;
    Ok((
        crate::client::LinearClient::new(c.endpoint, token)?,
        Output::new(cli.format.clone(), cli.full),
    ))
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
        c.raw_paginate(&q, Value::Object(vars))?
    } else {
        c.raw(&q, Value::Object(vars))?
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
    match cmd {
        AuthCommand::Whoami => {
            let (client, output) = ctx(cli)?;
            output.render(&client.query("query Viewer { viewer { id name email } }", json!({}))?)
        }
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
        "live": {"format": cli.format, "auth": "LINEAR_API_KEY"},
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
pub fn setup(a: SetupArgs) -> Result<(), AppError> {
    let executable = executable_path()?;
    let executable_literal = js_string_literal(&executable);
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
                merge_claude_hooks(&p, &mut v, &executable)?;
                write_json(&p, &v)?;
            }
            "codex" => {
                let cfg = home.join(".codex/config.toml");
                let mut parsed = read_toml(&cfg)?;
                let table = parsed
                    .as_table_mut()
                    .ok_or_else(|| schema_error(&cfg, "top-level table"))?;
                let features = table
                    .entry("features")
                    .or_insert_with(|| toml::Value::Table(Default::default()))
                    .as_table_mut()
                    .ok_or_else(|| schema_error(&cfg, "features table"))?;
                features.insert("hooks".into(), toml::Value::Boolean(true));
                let p = home.join(".codex/hooks.json");
                let mut v = read_json(&p)?;
                merge_codex_hooks(&p, &mut v, &executable)?;
                write_json(&p, &v)?;
                config::write_atomic(
                    &cfg,
                    &toml::to_string_pretty(&parsed)
                        .map_err(|e| AppError::config(format!("{}: {e}", cfg.display())))?,
                )?;
            }
            "opencode" => {
                let p = home.join(".config/opencode/plugins/magi-linear-axi.js");
                let plugin = format!(
                    "export const LinearAxiPlugin = async ({{ $, directory }}) => {{\n  return {{\n    \"experimental.chat.system.transform\": async (_input, output) => {{\n      const result = await $`${{{executable_literal}}} --format toon`.cwd(directory).quiet().nothrow();\n      if (result.exitCode === 0) {{\n        const context = result.stdout.toString().trim().slice(0, 8192);\n        if (context) output.system.push(context);\n      }}\n    }},\n  }};\n}};\n",
                );
                config::write_atomic(&p, &plugin)?;
            }
            _ => unreachable!(),
        }
    }
    Ok(())
}
fn schema_error(path: &std::path::Path, expected: &str) -> AppError {
    AppError::config(format!("{}: expected {expected}", path.display()))
}
fn read_toml(path: &std::path::Path) -> Result<toml::Value, AppError> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            return Err(AppError::config(format!(
                "cannot read config {}: {e}",
                path.display()
            )));
        }
    };
    if raw.trim().is_empty() {
        Ok(toml::Value::Table(Default::default()))
    } else {
        toml::from_str(&raw)
            .map_err(|e| AppError::config(format!("cannot parse config {}: {e}", path.display())))
    }
}
fn merge_claude_hooks(
    path: &std::path::Path,
    value: &mut Value,
    executable: &str,
) -> Result<(), AppError> {
    let root = value
        .as_object_mut()
        .ok_or_else(|| schema_error(path, "object"))?;
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    let events = hooks
        .as_object_mut()
        .ok_or_else(|| schema_error(path, "hooks object"))?;
    let session = events.entry("SessionStart").or_insert_with(|| json!([]));
    let entries = session
        .as_array_mut()
        .ok_or_else(|| schema_error(path, "hooks.SessionStart array"))?;
    let mut found = false;
    entries.retain_mut(|entry| {
        let Some(object) = entry.as_object_mut() else {
            return true;
        };
        let Some(nested) = object.get_mut("hooks") else {
            return true;
        };
        let Some(nested) = nested.as_array_mut() else {
            return true;
        };
        nested.retain_mut(|hook| {
            let Some(hook) = hook.as_object_mut() else {
                return true;
            };
            let Some(command) = hook
                .get_mut("command")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
            else {
                return true;
            };
            if is_managed_command(&command) {
                if found {
                    false
                } else {
                    hook.insert("command".into(), json!(executable));
                    found = true;
                    true
                }
            } else {
                true
            }
        });
        true
    });
    if !found {
        entries.push(json!({"hooks":[{"type":"command","command":executable}]}));
    }
    Ok(())
}
fn merge_codex_hooks(
    path: &std::path::Path,
    value: &mut Value,
    executable: &str,
) -> Result<(), AppError> {
    let root = value
        .as_object_mut()
        .ok_or_else(|| schema_error(path, "object"))?;
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    let events = hooks
        .as_object_mut()
        .ok_or_else(|| schema_error(path, "hooks object"))?;
    let session = events.entry("SessionStart").or_insert_with(|| json!([]));
    let entries = session
        .as_array_mut()
        .ok_or_else(|| schema_error(path, "hooks.SessionStart array"))?;
    let mut found = false;
    entries.retain_mut(|entry| {
        let Some(object) = entry.as_object_mut() else {
            return true;
        };
        let Some(command) = object
            .get_mut("command")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
        else {
            return true;
        };
        if is_managed_command(&command) {
            if found {
                false
            } else {
                object.insert("command".into(), json!(executable));
                found = true;
                true
            }
        } else {
            true
        }
    });
    if !found {
        entries.push(json!({"command":executable}));
    }
    Ok(())
}
fn is_managed_command(command: &str) -> bool {
    command == "magi-linear-axi"
        || std::path::Path::new(command)
            .file_name()
            .is_some_and(|name| name == "magi-linear-axi")
}
fn read_json(path: &std::path::Path) -> Result<Value, AppError> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let raw = fs::read_to_string(path)
        .map_err(|e| AppError::config(format!("cannot read config {}: {e}", path.display())))?;
    serde_json::from_str(&raw)
        .map_err(|e| AppError::config(format!("cannot parse config {}: {e}", path.display())))
}
fn write_json(path: &std::path::Path, value: &Value) -> Result<(), AppError> {
    config::write_atomic(
        path,
        &serde_json::to_string_pretty(value)
            .map_err(|e| AppError::config(format!("{}: {e}", path.display())))?,
    )
}

pub fn issues(cli: &Cli, cmd: Option<IssueCommand>) -> Result<(), AppError> {
    let command = cmd.unwrap_or(IssueCommand::Query(QueryArgs::default()));
    issue::execute(cli, command)
}
