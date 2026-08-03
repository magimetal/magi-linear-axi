use crate::error::AppError;
use std::{
    env, fs,
    path::{Path, PathBuf},
};
#[derive(Debug, Clone, Default, serde::Deserialize)]
struct FileConfig {
    endpoint: Option<String>,
}

impl FileConfig {
    fn overlay(&mut self, other: Self) {
        if other.endpoint.is_some() {
            self.endpoint = other.endpoint;
        }
    }

    fn non_empty(mut self) -> Self {
        self.endpoint = non_empty(self.endpoint);
        self
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

pub fn api_key() -> Result<String, AppError> {
    env::var("LINEAR_API_KEY")
        .ok()
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| AppError::auth("LINEAR_API_KEY must be set and non-empty"))
}

fn read_config(path: &Path) -> Result<Option<FileConfig>, AppError> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(AppError::config(format!(
                "cannot read config {}: {error}",
                path.display()
            )));
        }
    };
    toml::from_str::<FileConfig>(&raw)
        .map(|config| Some(config.non_empty()))
        .map_err(|error| {
            AppError::config(format!("cannot parse config {}: {error}", path.display()))
        })
}

fn resolve(
    cli_endpoint: Option<String>,
    cli_workspace: Option<String>,
    env_endpoint: Option<String>,
    env_workspace: Option<String>,
    file: FileConfig,
) -> Config {
    Config {
        endpoint: non_empty(cli_endpoint)
            .or_else(|| non_empty(env_endpoint))
            .or(file.endpoint)
            .unwrap_or_else(|| "https://api.linear.app/graphql".into()),
        workspace: non_empty(cli_workspace).or_else(|| non_empty(env_workspace)),
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub endpoint: String,
    pub workspace: Option<String>,
}
impl Config {
    pub fn load(endpoint: Option<String>, workspace: Option<String>) -> Result<Self, AppError> {
        let mut file = config_file()
            .map(|path| read_config(&path))
            .transpose()?
            .flatten()
            .unwrap_or_default();
        if let Some(project) = read_config(Path::new(".linear.toml"))? {
            file.overlay(project);
        }
        Ok(resolve(
            endpoint,
            workspace,
            env::var("LINEAR_API_URL").ok(),
            env::var("LINEAR_WORKSPACE").ok(),
            file,
        ))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_config_cannot_supply_workspace() {
        let config = resolve(
            None,
            None,
            None,
            None,
            FileConfig {
                endpoint: Some("file-endpoint".into()),
            },
        );
        assert_eq!(config.endpoint, "file-endpoint");
        assert_eq!(config.workspace, None);
    }

    #[test]
    fn malformed_project_and_global_configs_report_paths() {
        let dir = tempfile::tempdir().unwrap();
        for relative in [".linear.toml", "linear/linear.toml"] {
            let path = dir.path().join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&path, "endpoint = [").unwrap();
            let error = read_config(&path).unwrap_err().to_string();
            assert!(error.contains("cannot parse config"));
            assert!(error.contains(path.to_str().unwrap()));
        }
    }

    #[test]
    fn missing_config_is_ignored() {
        let path = tempfile::tempdir().unwrap().path().join("missing.toml");
        assert!(read_config(&path).unwrap().is_none());
    }
}
