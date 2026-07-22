use crate::error::AppError;
use serde_json::Value;
pub struct Output {
    format: String,
    full: bool,
}
impl Output {
    pub fn new(format: String, full: bool) -> Self {
        Self { format, full }
    }
    pub fn render(&self, v: &Value) -> Result<(), AppError> {
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
        Value::String(s) if s.chars().count() > 240 => {
            let prefix: String = s.chars().take(240).collect();
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
    #[test]
    fn valid_toon() {
        let s = toon_format::encode(
            &serde_json::json!({"x":1}),
            &toon_format::EncodeOptions::default(),
        )
        .unwrap();
        assert!(s.contains("x"));
    }
}
