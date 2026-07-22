use crate::{config, error::AppError};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{collections::BTreeMap, env, fs, path::PathBuf};
#[derive(Default, Serialize, Deserialize)]
struct File {
    default: Option<String>,
    workspaces: Option<Vec<String>>,
    #[serde(flatten)]
    keys: BTreeMap<String, String>,
}
pub struct CredentialStore {
    path: PathBuf,
    pub default: Option<String>,
    pub keys: BTreeMap<String, String>,
}
impl CredentialStore {
    pub fn load() -> Result<Self, AppError> {
        let path = config::config_path()?.join("credentials.toml");
        if !path.exists() {
            return Ok(Self {
                path,
                default: None,
                keys: BTreeMap::new(),
            });
        }
        let raw = fs::read_to_string(&path)
            .map_err(|e| AppError::config(format!("read credentials: {e}")))?;
        let f: File = toml::from_str(&raw)
            .map_err(|e| AppError::config(format!("parse credentials: {e}")))?;
        Ok(Self {
            path,
            default: f.default,
            keys: f
                .workspaces
                .unwrap_or_default()
                .into_iter()
                .map(|w| (w, String::new()))
                .collect(),
        })
    }
    pub fn save(&self) -> Result<(), AppError> {
        let f = File {
            default: self.default.clone(),
            workspaces: Some(self.keys.keys().cloned().collect()),
            keys: BTreeMap::new(),
        };
        config::write_atomic(
            &self.path,
            &toml::to_string_pretty(&f).map_err(|e| AppError::config(e.to_string()))?,
        )?;
        let mut p = fs::metadata(&self.path)
            .map_err(|e| AppError::config(e.to_string()))?
            .permissions();
        #[cfg(unix)]
        {
            p.set_mode(0o600);
            fs::set_permissions(&self.path, p).map_err(|e| AppError::config(e.to_string()))?;
        }
        Ok(())
    }
    pub fn set_token(&self, workspace: &str, token: &str) -> Result<(), AppError> {
        keyring_set(workspace, token)
    }
    pub fn delete_token(&self, workspace: &str) -> Result<(), AppError> {
        keyring_delete(workspace)
    }
    pub fn token(&self, workspace: Option<&str>) -> Result<String, AppError> {
        if let Ok(key) = env::var("LINEAR_API_KEY") {
            if !key.is_empty() {
                return Ok(key);
            }
        }
        let ws = workspace.or(self.default.as_deref()).ok_or_else(|| {
            AppError::auth("no default workspace; set LINEAR_API_KEY or run auth login")
        })?;
        keyring_get(ws).ok_or_else(|| AppError::auth(format!("no credential for workspace: {ws}")))
    }
}
fn keyring_command() -> (&'static str, &'static [&'static str]) {
    if cfg!(target_os = "macos") {
        (
            "security",
            &["find-generic-password", "-s", "magi-linear-axi", "-a"],
        )
    } else {
        (
            "secret-tool",
            &["lookup", "service", "magi-linear-axi", "workspace"],
        )
    }
}
fn keyring_get(workspace: &str) -> Option<String> {
    let (program, prefix) = keyring_command();
    let mut c = std::process::Command::new(program);
    c.args(prefix).arg(workspace);
    let out = c.output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
        .filter(|s| !s.is_empty())
}
fn keyring_set(workspace: &str, token: &str) -> Result<(), AppError> {
    if cfg!(target_os = "macos") {
        std::process::Command::new("security")
            .args([
                "add-generic-password",
                "-U",
                "-s",
                "magi-linear-axi",
                "-a",
                workspace,
                "-w",
                token,
            ])
            .status()
    } else {
        std::process::Command::new("secret-tool")
            .args([
                "store",
                "--label=magi-linear-axi",
                "service",
                "magi-linear-axi",
                "workspace",
                workspace,
            ])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut p| {
                use std::io::Write;
                p.stdin.take().unwrap().write_all(token.as_bytes())?;
                p.wait()
            })
    }
    .map_err(|e| AppError::auth(format!("secure keyring unavailable: {e}")))
    .and_then(|s| {
        s.success()
            .then_some(())
            .ok_or_else(|| AppError::auth("secure keyring rejected credential"))
    })
}
fn keyring_delete(workspace: &str) -> Result<(), AppError> {
    std::process::Command::new(if cfg!(target_os = "macos") {
        "security"
    } else {
        "secret-tool"
    })
    .args(if cfg!(target_os = "macos") {
        vec![
            "delete-generic-password",
            "-s",
            "magi-linear-axi",
            "-a",
            workspace,
        ]
    } else {
        vec![
            "clear",
            "service",
            "magi-linear-axi",
            "workspace",
            workspace,
        ]
    })
    .status()
    .map_err(|e| AppError::auth(e.to_string()))
    .and_then(|s| {
        s.success()
            .then_some(())
            .ok_or_else(|| AppError::auth("secure keyring rejected operation"))
    })
}
