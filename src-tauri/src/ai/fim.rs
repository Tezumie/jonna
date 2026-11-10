//! Fill-in-the-middle completions for suggestions as you type (D204): the code before and after
//! the cursor go to a FIM endpoint, which answers with the middle. Four shapes:
//! Ollama `/api/generate` with `suffix`; OpenAI-style `/v1/completions` with `suffix`; Mistral's
//! Codestral `/v1/fim/completions`; DeepSeek's `/beta/completions`. Not streamed (a suggestion
//! is short and shown whole). A provider or model without FIM answers `supported: false` rather
//! than an error, so the webview falls back to the chat prompt and remembers it.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{http_error, openai_api, url, Provider};
use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FimStyle {
    Ollama,
    Openai,
    Mistral,
    Deepseek,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FimRequest {
    pub provider: Provider,
    pub style: FimStyle,
    pub model: String,
    pub prompt: String,
    pub suffix: String,
    pub max_tokens: u32,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub stop: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FimReply {
    /// False: this provider or model has no FIM (the caller uses its chat prompt instead).
    pub supported: bool,
    pub text: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

/// The endpoint for `style` under the provider's base URL.
pub fn endpoint(style: FimStyle, base: &str) -> String {
    let b = base.trim_end_matches('/');
    let v1 = |path: &str| openai_api(b, path);
    match style {
        FimStyle::Ollama => url(b, "api/generate"),
        FimStyle::Openai => v1("completions"),
        FimStyle::Mistral => v1("fim/completions"),
        // DeepSeek's FIM is on its beta base, beside /v1.
        FimStyle::Deepseek => url(
            b.trim_end_matches("/v1").trim_end_matches("/beta"),
            "beta/completions",
        ),
    }
}

/// Most stop sequences any of the APIs take (OpenAI's limit is 4).
const MAX_STOPS: usize = 4;

pub fn body(req: &FimRequest) -> Value {
    let temperature = req.temperature.unwrap_or(0.1);
    let stop: Vec<&String> = req.stop.iter().take(MAX_STOPS).collect();
    match req.style {
        FimStyle::Ollama => {
            let mut options = json!({ "num_predict": req.max_tokens, "temperature": temperature });
            if !stop.is_empty() {
                options["stop"] = json!(stop);
            }
            json!({
                "model": req.model,
                "prompt": req.prompt,
                "suffix": req.suffix,
                "stream": false,
                "options": options,
            })
        }
        FimStyle::Openai | FimStyle::Mistral | FimStyle::Deepseek => {
            let mut v = json!({
                "model": req.model,
                "prompt": req.prompt,
                "suffix": req.suffix,
                "max_tokens": req.max_tokens,
                "temperature": temperature,
                "stream": false,
            });
            if !stop.is_empty() {
                v["stop"] = json!(stop);
            }
            v
        }
    }
}

/// The middle the model wrote, from the response body.
pub fn parse(style: FimStyle, v: &Value) -> Option<String> {
    match style {
        FimStyle::Ollama => v.get("response")?.as_str().map(str::to_string),
        FimStyle::Openai | FimStyle::Deepseek => {
            let choice = v.get("choices")?.get(0)?;
            choice.get("text")?.as_str().map(str::to_string)
        }
        // Codestral answers like a chat completion.
        FimStyle::Mistral => {
            let choice = v.get("choices")?.get(0)?;
            choice
                .get("message")
                .and_then(|m| m.get("content"))
                .or_else(|| choice.get("text"))?
                .as_str()
                .map(str::to_string)
        }
    }
}

/// Token counts the response reports (Ollama's eval counts, OpenAI-style `usage`).
fn usage(style: FimStyle, v: &Value) -> (Option<u64>, Option<u64>) {
    match style {
        FimStyle::Ollama => (
            v.get("prompt_eval_count").and_then(Value::as_u64),
            v.get("eval_count").and_then(Value::as_u64),
        ),
        _ => {
            let u = v.get("usage");
            (
                u.and_then(|u| u.get("prompt_tokens"))
                    .and_then(Value::as_u64),
                u.and_then(|u| u.get("completion_tokens"))
                    .and_then(Value::as_u64),
            )
        }
    }
}

/// An error that means "no FIM here" (the model's template has no suffix, the server no such
/// route, the parameter is refused) rather than a failure worth showing.
pub fn means_unsupported(status: u16, message: &str) -> bool {
    let m = message.to_lowercase();
    matches!(status, 404 | 405 | 501)
        || m.contains("does not support insert")
        || m.contains("suffix")
        || m.contains("not support")
        || (status == 400
            && (m.contains("fim") || m.contains("unrecognized") || m.contains("unknown")))
}

fn error_message(text: &str) -> String {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| {
            v.get("error").and_then(|e| {
                e.as_str()
                    .map(str::to_string)
                    .or_else(|| e.get("message").and_then(Value::as_str).map(str::to_string))
            })
        })
        .unwrap_or_else(|| text.chars().take(300).collect())
}

pub async fn complete(
    client: &reqwest::Client,
    req: &FimRequest,
    key: Option<String>,
) -> Result<FimReply> {
    let mut builder = client
        .post(endpoint(req.style, &req.provider.base_url))
        .timeout(std::time::Duration::from_secs(30))
        .json(&body(req));
    if let Some(k) = key.filter(|k| !k.is_empty()) {
        builder = builder.bearer_auth(k);
    }
    let response = builder.send().await.map_err(http_error)?;
    let status = response.status();
    let text = response.text().await.map_err(http_error)?;
    if !status.is_success() {
        let message = error_message(&text);
        if means_unsupported(status.as_u16(), &message) {
            return Ok(FimReply::default());
        }
        return Err(Error::Ai(format!(
            "{} ({})",
            message.trim(),
            status.as_u16()
        )));
    }
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| Error::Ai(format!("unreadable completion: {e}")))?;
    let Some(middle) = parse(req.style, &v) else {
        return Ok(FimReply::default());
    };
    let (input_tokens, output_tokens) = usage(req.style, &v);
    Ok(FimReply {
        supported: true,
        text: middle,
        input_tokens,
        output_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::ProviderKind;

    fn req(style: FimStyle) -> FimRequest {
        FimRequest {
            provider: Provider {
                id: "p".into(),
                kind: ProviderKind::Openai,
                base_url: "http://x".into(),
            },
            style,
            model: "m".into(),
            prompt: "def f(".into(),
            suffix: ")\n".into(),
            max_tokens: 64,
            temperature: None,
            stop: vec!["\n".into(), "a".into(), "b".into(), "c".into(), "d".into()],
        }
    }

    #[test]
    fn endpoints() {
        assert_eq!(
            endpoint(FimStyle::Ollama, "http://127.0.0.1:11434/"),
            "http://127.0.0.1:11434/api/generate"
        );
        assert_eq!(
            endpoint(FimStyle::Openai, "http://localhost:8080"),
            "http://localhost:8080/v1/completions"
        );
        assert_eq!(
            endpoint(FimStyle::Openai, "http://localhost:8080/v1"),
            "http://localhost:8080/v1/completions"
        );
        assert_eq!(
            endpoint(FimStyle::Mistral, "https://codestral.mistral.ai/v1"),
            "https://codestral.mistral.ai/v1/fim/completions"
        );
        assert_eq!(
            endpoint(FimStyle::Deepseek, "https://api.deepseek.com/v1"),
            "https://api.deepseek.com/beta/completions"
        );
        assert_eq!(
            endpoint(FimStyle::Deepseek, "https://api.deepseek.com"),
            "https://api.deepseek.com/beta/completions"
        );
    }

    #[test]
    fn bodies() {
        let o = body(&req(FimStyle::Ollama));
        assert_eq!(o["suffix"], ")\n");
        assert_eq!(o["stream"], false);
        assert_eq!(o["options"]["num_predict"], 64);
        assert_eq!(o["options"]["stop"].as_array().map(Vec::len), Some(4));
        let m = body(&req(FimStyle::Mistral));
        assert_eq!(m["max_tokens"], 64);
        assert_eq!(m["prompt"], "def f(");
        let mut none = req(FimStyle::Openai);
        none.stop.clear();
        assert!(body(&none).get("stop").is_none());
    }

    #[test]
    fn replies() {
        assert_eq!(
            parse(FimStyle::Ollama, &json!({ "response": "x" })),
            Some("x".into())
        );
        assert_eq!(
            parse(FimStyle::Openai, &json!({ "choices": [{ "text": "y" }] })),
            Some("y".into())
        );
        assert_eq!(
            parse(
                FimStyle::Mistral,
                &json!({ "choices": [{ "message": { "content": "z" } }] })
            ),
            Some("z".into())
        );
        assert_eq!(parse(FimStyle::Deepseek, &json!({})), None);
        assert_eq!(
            usage(
                FimStyle::Ollama,
                &json!({ "prompt_eval_count": 5, "eval_count": 2 })
            ),
            (Some(5), Some(2))
        );
    }

    #[test]
    fn unsupported() {
        assert!(means_unsupported(
            400,
            "registry.ollama.ai/library/llama3:latest does not support insert"
        ));
        assert!(means_unsupported(404, "Not Found"));
        assert!(means_unsupported(
            400,
            "Unrecognized request argument supplied: suffix"
        ));
        assert!(!means_unsupported(401, "Incorrect API key provided"));
        assert!(!means_unsupported(500, "boom"));
        assert_eq!(error_message(r#"{"error":{"message":"m"}}"#), "m");
        assert_eq!(error_message("plain"), "plain");
    }
}
