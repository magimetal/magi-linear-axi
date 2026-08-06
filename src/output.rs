use crate::error::AppError;
use serde_json::Value;
use std::{fs::OpenOptions, io::Write, time::Instant};

fn timing_event(duration_ms: u128) {
    let Some(path) = std::env::var_os("MAGI_LINEAR_TIMING_FILE") else {
        return;
    };
    let Ok(duration_ms) = u64::try_from(duration_ms) else {
        return;
    };
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let _ = writeln!(
        file,
        "{{\"component\":\"render\",\"durationMs\":{duration_ms}}}"
    );
}

/// Maximum Unicode code points rendered for a string in default output.
pub const AXI_OUTPUT_MAX_UNICODE_CODE_POINTS: usize = 240;

pub struct Output {
    format: String,
    full: bool,
}
impl Output {
    pub fn new(format: String, full: bool) -> Self {
        Self { format, full }
    }
    pub fn render(&self, v: &Value) -> Result<(), AppError> {
        let started = Instant::now();
        let result = self.render_timed(v);
        timing_event(started.elapsed().as_millis());
        result
    }
    fn render_timed(&self, v: &Value) -> Result<(), AppError> {
        let value = if self.full {
            v.clone()
        } else {
            truncate_value(v)
        };
        let text = if self.format == "json" {
            serde_json::to_string(&value).map_err(|e| AppError::Output(e.to_string()))?
        } else {
            toon_format::encode(&value, &toon_format::EncodeOptions::default())
                .map_err(|e| AppError::Output(e.to_string()))?
        };
        println!("{text}");
        Ok(())
    }
}

fn truncate_value(v: &Value) -> Value {
    match v {
        Value::String(s) if s.chars().count() > AXI_OUTPUT_MAX_UNICODE_CODE_POINTS => {
            let prefix: String = s.chars().take(AXI_OUTPUT_MAX_UNICODE_CODE_POINTS).collect();
            Value::String(format!(
                "{prefix}… [truncated, {} chars]",
                s.chars().count()
            ))
        }
        Value::Array(items) => Value::Array(items.iter().map(truncate_value).collect()),
        Value::Object(items) => Value::Object(
            items
                .iter()
                .map(|(k, v)| (k.clone(), truncate_value(v)))
                .collect(),
        ),
        _ => v.clone(),
    }
}
#[cfg(test)]
mod tests {
    use super::{AXI_OUTPUT_MAX_UNICODE_CODE_POINTS, truncate_value};

    #[test]
    fn valid_toon() {
        let encoded = toon_format::encode(
            &serde_json::json!({"x":1}),
            &toon_format::EncodeOptions::default(),
        );
        assert!(encoded.is_ok());
        assert!(encoded.unwrap_or_default().contains("x"));
    }

    #[test]
    fn default_output_limit_counts_unicode_code_points() {
        let exact = "🙂".repeat(AXI_OUTPUT_MAX_UNICODE_CODE_POINTS);
        let exact_value = truncate_value(&serde_json::json!(exact));
        assert_eq!(exact_value, serde_json::json!(exact));

        let oversized = "🙂".repeat(AXI_OUTPUT_MAX_UNICODE_CODE_POINTS + 1);
        let oversized_value = truncate_value(&serde_json::json!(oversized));
        assert_eq!(
            oversized_value,
            serde_json::json!(format!(
                "{}… [truncated, {} chars]",
                "🙂".repeat(AXI_OUTPUT_MAX_UNICODE_CODE_POINTS),
                AXI_OUTPUT_MAX_UNICODE_CODE_POINTS + 1,
            ))
        );
    }
}
