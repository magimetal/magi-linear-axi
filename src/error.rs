use std::fmt;
#[derive(Debug)]
pub enum AppError {
    Usage(String),
    Auth(String),
    Config(String),
    Network(String),
    Api(String),
    Output(String),
}
impl AppError {
    pub fn usage(s: impl Into<String>) -> Self {
        Self::Usage(s.into())
    }
    pub fn auth(s: impl Into<String>) -> Self {
        Self::Auth(s.into())
    }
    pub fn config(s: impl Into<String>) -> Self {
        Self::Config(s.into())
    }
    pub fn network(s: impl Into<String>) -> Self {
        Self::Network(s.into())
    }
    pub fn api(s: impl Into<String>) -> Self {
        Self::Api(s.into())
    }
    pub fn exit_code(&self) -> u8 {
        match self {
            Self::Usage(_) => 2,
            Self::Auth(_) => 1,
            Self::Config(_) => 1,
            Self::Network(_) => 1,
            Self::Api(_) => 1,
            Self::Output(_) => 1,
        }
    }
    fn kind(&self) -> &'static str {
        match self {
            Self::Usage(_) => "usage",
            Self::Auth(_) => "auth",
            Self::Config(_) => "config",
            Self::Network(_) => "network",
            Self::Api(_) => "api",
            Self::Output(_) => "output",
        }
    }
}
impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}",
            match self {
                Self::Usage(x)
                | Self::Auth(x)
                | Self::Config(x)
                | Self::Network(x)
                | Self::Api(x)
                | Self::Output(x) => x,
            }
        )
    }
}
pub fn print(e: &AppError, format: &str) {
    let value = serde_json::json!({"error": {"type": e.kind(), "code": e.exit_code(), "message": e.to_string()}});
    let rendered = if format == "json" {
        serde_json::to_string(&value)
            .unwrap_or_else(|_| "{\"error\":{\"message\":\"output failure\"}}".into())
    } else {
        toon_format::encode(&value, &toon_format::EncodeOptions::default())
            .unwrap_or_else(|_| "error: output failure".into())
    };
    println!("{rendered}");
    eprintln!("error[type={}, code={}]: {}", e.kind(), e.exit_code(), e);
}
