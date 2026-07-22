use crate::error::AppError;
use std::{
    env, fs,
    path::{Path, PathBuf},
};
#[derive(Debug, Clone, Default, serde::Deserialize)]
struct FileConfig {
    endpoint: Option<String>,
    workspace: Option<String>,
    api_key: Option<String>,
    team_id: Option<String>,
}
#[derive(Debug, Clone)]
pub struct Config {
    pub endpoint: String,
    pub workspace: Option<String>,
    pub api_key: Option<String>,
    pub team_id: Option<String>,
}
impl Config {
    pub fn load(endpoint: Option<String>, workspace: Option<String>) -> Result<Self, AppError> {
        let mut file = FileConfig::default();
        for path in [Some(PathBuf::from(".linear.toml")), config_file()]
            .into_iter()
            .flatten()
        {
            if let Ok(raw) = fs::read_to_string(path) {
                if let Ok(next) = toml::from_str::<FileConfig>(&raw) {
                    file = next;
                    break;
                }
            }
        }
        let endpoint = endpoint
            .or_else(|| env::var("LINEAR_API_URL").ok())
            .or(file.endpoint)
            .unwrap_or_else(|| "https://api.linear.app/graphql".into());
        if endpoint.trim().is_empty() {
            return Err(AppError::config("LINEAR_API_URL cannot be empty"));
        }
        Ok(Self {
            endpoint,
            workspace: workspace
                .or_else(|| env::var("LINEAR_WORKSPACE").ok())
                .or(file.workspace),
            api_key: env::var("LINEAR_API_KEY").ok().or(file.api_key),
            team_id: file.team_id,
        })
    }
}
fn config_file() -> Option<PathBuf> {
    let base = if cfg!(target_os = "windows") {
        env::var_os("APPDATA").map(PathBuf::from)
    } else {
        env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    };
    base.map(|p| p.join("linear").join("linear.toml"))
}
pub fn write_atomic(path: &Path, content: &str) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::config(e.to_string()))?
    };
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, content).map_err(|e| AppError::config(e.to_string()))?;
    fs::rename(&tmp, path).map_err(|e| AppError::config(e.to_string()))
}
pub fn config_path() -> Result<PathBuf, AppError> {
    if let Some(x) = env::var_os("XDG_CONFIG_HOME") {
        return Ok(PathBuf::from(x).join("linear"));
    }
    env::var_os("HOME")
        .map(|h| PathBuf::from(h).join(".config/linear"))
        .ok_or_else(|| AppError::config("cannot determine config directory"))
}
