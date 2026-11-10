//! OpenAI-compatible Chat Completions (`/v1/models`, `/v1/chat/completions` with SSE). Tool-call
//! arguments arrive as string fragments per index and are assembled before being emitted.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::{
    error_body, http_error, openai_api, parse_pricing, ChatEvent, ChatRequest, LineBuffer, Message,
    ModelInfo,
};
use crate::error::Result;

fn with_key(builder: reqwest::RequestBuilder, key: Option<String>) -> reqwest::RequestBuilder {
    match key.filter(|k| !k.is_empty()) {
        Some(k) => builder.bearer_auth(k),
        None => builder,
    }
}

/// `base` may or may not end with "/v1" (people paste both), or name its own version (D212).
fn api(base: &str, path: &str) -> String {
    openai_api(base, path)
}

pub async fn list_models(
    client: &reqwest::Client,
    base: &str,
    key: Option<String>,
) -> Result<Vec<ModelInfo>> {
    let response = with_key(client.get(api(base, "models")), key)
        .send()
        .await
        .map_err(http_error)?;
    if !response.status().is_success() {
        return Err(error_body(response).await);
    }
    let body: Value = response.json().await.map_err(http_error)?;
    Ok(body
        .get("data")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    Some(ModelInfo {
                        id: m.get("id")?.as_str()?.to_string(),
                        remote: true,
                        pricing: parse_pricing(m.get("pricing")),
                        output_images: m
                            .pointer("/architecture/output_modalities")
                            .and_then(Value::as_array)
                            .is_some_and(|a| a.iter().any(|x| x == "image")),
                        ..ModelInfo::default()
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

fn message_json(m: &Message) -> Value {
    let content = if m.images.is_empty() {
        json!(m.content)
    } else {
        let mut parts = vec![json!({ "type": "text", "text": m.content })];
        for img in &m.images {
            parts.push(json!({ "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{img}") } }));
        }
        json!(parts)
    };
    let mut v = json!({ "role": m.role, "content": content });
    if !m.tool_calls.is_empty() {
        v["tool_calls"] = m
            .tool_calls
            .iter()
            .map(|c| json!({ "id": c.id, "type": "function", "function": { "name": c.name, "arguments": c.arguments.to_string() } }))
            .collect();
    }
    if let Some(id) = &m.tool_call_id {
        v["tool_call_id"] = json!(id);
    }
    v
}

pub fn request_body(req: &ChatRequest) -> Value {
    let mut body = json!({
        "model": req.model,
        "messages": req.messages.iter().map(message_json).collect::<Vec<_>>(),
        "stream": true,
        "stream_options": { "include_usage": true },
    });
    if !req.tools.is_empty() {
        body["tools"] = req
            .tools
            .iter()
            .map(|t| json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.parameters } }))
            .collect();
    }
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if !req.no_cache && wants_cache_hints(req) {
        add_cache_hints(&mut body);
    }
    if let Some(n) = req.max_tokens {
        body["max_tokens"] = json!(n);
    }
    if let Some(m) = req.modalities.as_ref().filter(|m| !m.is_empty()) {
        body["modalities"] = json!(m);
    }
    body
}

/// An image part of a reply (D381): OpenRouter's `{ "type": "image_url", "image_url": { "url" } }`
/// in `delta.images` or in a `content` array; a `data:` URL gives the bytes, any other a link.
pub fn image_event(part: &Value) -> Option<ChatEvent> {
    let url = part
        .pointer("/image_url/url")
        .or_else(|| part.get("url"))
        .and_then(Value::as_str)?;
    if let Some(rest) = url.strip_prefix("data:") {
        let (head, data) = rest.split_once(',')?;
        let mime = head.trim_end_matches(";base64").to_string();
        if !head.ends_with(";base64") || !mime.starts_with("image/") {
            return None;
        }
        return Some(ChatEvent::Image {
            mime,
            data: data.to_string(),
            url: None,
        });
    }
    (url.starts_with("https://") || url.starts_with("http://")).then(|| ChatEvent::Image {
        mime: "image/png".into(),
        data: String::new(),
        url: Some(url.to_string()),
    })
}

/// OpenRouter passes `cache_control` through to models that need explicit breakpoints (Anthropic,
/// Gemini); other OpenAI-compatible APIs cache prefixes on their own.
fn wants_cache_hints(req: &ChatRequest) -> bool {
    req.provider.base_url.contains("openrouter.ai")
        && (req.model.starts_with("anthropic/") || req.model.starts_with("google/gemini"))
}

/// Breakpoints on the system prompt and on the newest user message (D112).
pub fn add_cache_hints(body: &mut Value) {
    let Some(messages) = body["messages"].as_array_mut() else {
        return;
    };
    let last_user = messages.iter().rposition(|m| m["role"] == "user");
    for (i, m) in messages.iter_mut().enumerate() {
        let first_system = i == 0 && m["role"] == "system";
        if !(first_system || Some(i) == last_user) {
            continue;
        }
        let parts = match m["content"].take() {
            Value::String(text) => vec![json!({ "type": "text", "text": text })],
            Value::Array(parts) => parts,
            other => vec![json!({ "type": "text", "text": other.as_str().unwrap_or_default() })],
        };
        let mut parts = parts;
        if let Some(last) = parts.iter_mut().rev().find(|p| p["type"] == "text") {
            last["cache_control"] = json!({ "type": "ephemeral" });
        }
        m["content"] = Value::Array(parts);
    }
}

#[derive(Default)]
struct PartialCall {
    id: String,
    name: String,
    arguments: String,
    progress: super::ToolStreamProgress,
}

/// Accumulates SSE `data:` payloads into events.
#[derive(Default)]
pub struct SseParser {
    calls: BTreeMap<u64, PartialCall>,
    stop_reason: Option<String>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cached_tokens: Option<u64>,
    /// OpenRouter's `usage.cost` (dollars).
    cost: Option<f64>,
    finished: bool,
}

impl SseParser {
    pub fn line(&mut self, line: &str) -> Result<Vec<ChatEvent>> {
        let mut out = Vec::new();
        let Some(data) = line.strip_prefix("data:") else {
            return Ok(out);
        };
        let data = data.trim();
        if data == "[DONE]" {
            out.extend(self.finish());
            return Ok(out);
        }
        let v: Value = serde_json::from_str(data)?;
        if let Some(err) = v.get("error") {
            let msg = err
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("provider error");
            return Err(crate::error::Error::Ai(msg.to_string()));
        }
        if let Some(usage) = v.get("usage").filter(|u| u.is_object()) {
            self.input_tokens = usage.get("prompt_tokens").and_then(Value::as_u64);
            self.output_tokens = usage.get("completion_tokens").and_then(Value::as_u64);
            // OpenAI's automatic prefix cache (also DeepSeek's prompt_cache_hit_tokens).
            self.cached_tokens = usage
                .pointer("/prompt_tokens_details/cached_tokens")
                .or_else(|| usage.get("prompt_cache_hit_tokens"))
                .and_then(Value::as_u64);
            self.cost = usage
                .get("cost")
                .and_then(Value::as_f64)
                .filter(|c| *c >= 0.0);
        }
        for choice in v
            .get("choices")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let delta = choice.get("delta").or_else(|| choice.get("message"));
            if let Some(d) = delta {
                for key in ["reasoning_content", "reasoning"] {
                    if let Some(t) = d.get(key).and_then(Value::as_str).filter(|t| !t.is_empty()) {
                        out.push(ChatEvent::Thinking {
                            text: t.to_string(),
                        });
                    }
                }
                match d.get("content") {
                    Some(Value::String(t)) if !t.is_empty() => out.push(ChatEvent::Text {
                        text: t.to_string(),
                    }),
                    // Parts: text and images (some providers answer that way, D381).
                    Some(Value::Array(parts)) => {
                        for p in parts {
                            if let Some(t) = p.get("text").and_then(Value::as_str) {
                                if !t.is_empty() {
                                    out.push(ChatEvent::Text {
                                        text: t.to_string(),
                                    });
                                }
                            } else if let Some(e) = image_event(p) {
                                out.push(e);
                            }
                        }
                    }
                    _ => {}
                }
                // OpenRouter's image models: `images` beside the text (D381).
                for p in d
                    .get("images")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let Some(e) = image_event(p) {
                        out.push(e);
                    }
                }
                for (n, call) in d
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    let index = call
                        .get("index")
                        .and_then(Value::as_u64)
                        .unwrap_or(n as u64);
                    let entry = self.calls.entry(index).or_default();
                    if let Some(id) = call.get("id").and_then(Value::as_str) {
                        entry.id = id.to_string();
                    }
                    if let Some(f) = call.get("function") {
                        if let Some(name) = f.get("name").and_then(Value::as_str) {
                            entry.name.push_str(name);
                        }
                        match f.get("arguments") {
                            Some(Value::String(s)) => entry.arguments.push_str(s),
                            Some(Value::Object(_)) => entry.arguments = f["arguments"].to_string(),
                            _ => {}
                        }
                    }
                    if let Some(e) = entry
                        .progress
                        .update(&entry.id, &entry.name, &entry.arguments)
                    {
                        out.push(e);
                    }
                }
            }
            if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                self.stop_reason = Some(reason.to_string());
            }
        }
        Ok(out)
    }

    /// Emits assembled tool calls and the final Done (once).
    pub fn finish(&mut self) -> Vec<ChatEvent> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        let mut out: Vec<ChatEvent> = std::mem::take(&mut self.calls)
            .into_iter()
            .map(|(i, c)| ChatEvent::ToolCall {
                id: if c.id.is_empty() {
                    format!("call_{i}")
                } else {
                    c.id
                },
                name: c.name,
                arguments: if c.arguments.trim().is_empty() {
                    json!({})
                } else {
                    serde_json::from_str(&c.arguments).unwrap_or(Value::String(c.arguments))
                },
            })
            .collect();
        out.push(ChatEvent::Done {
            stop_reason: self.stop_reason.clone().unwrap_or_else(|| "stop".into()),
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cache_read_tokens: self.cached_tokens,
            cache_write_tokens: None,
            cost: self.cost,
        });
        out
    }
}

/// An image from OpenAI's Images API (`gpt-image-*`, `dall-e-*`, D381): `/images/generations`,
/// the bytes as base64 (`b64_json`). Its media type and data, one per image asked for.
pub async fn generate_image(
    client: &reqwest::Client,
    base: &str,
    key: Option<String>,
    model: &str,
    prompt: &str,
    size: Option<&str>,
) -> Result<Vec<(String, String)>> {
    let mut body = json!({ "model": model, "prompt": prompt, "n": 1 });
    if let Some(s) = size.filter(|s| !s.is_empty()) {
        body["size"] = json!(s);
    }
    // DALL·E answers with a link unless asked for the bytes; gpt-image always sends them.
    if model.starts_with("dall-e") {
        body["response_format"] = json!("b64_json");
    }
    let response = with_key(client.post(api(base, "images/generations")), key)
        .json(&body)
        .send()
        .await
        .map_err(http_error)?;
    if !response.status().is_success() {
        return Err(error_body(response).await);
    }
    let v: Value = response.json().await.map_err(http_error)?;
    let format = v
        .get("output_format")
        .and_then(Value::as_str)
        .unwrap_or("png")
        .to_string();
    Ok(v.get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|d| d.get("b64_json").and_then(Value::as_str))
        .map(|b| (format!("image/{format}"), b.to_string()))
        .collect())
}

pub async fn chat<F: FnMut(ChatEvent)>(
    client: &reqwest::Client,
    req: &ChatRequest,
    key: Option<String>,
    mut emit: F,
    seen: &mut super::SeenLimits,
) -> Result<()> {
    let response = with_key(
        client.post(api(&req.provider.base_url, "chat/completions")),
        key,
    )
    .json(&request_body(req))
    .send()
    .await
    .map_err(http_error)?;
    super::note_limits(seen, &response);
    if !response.status().is_success() {
        return Err(error_body(response).await);
    }
    let mut stream = response.bytes_stream();
    let mut lines = LineBuffer::default();
    let mut parser = SseParser::default();
    while let Some(chunk) = super::next_chunk(&mut stream).await {
        let chunk = chunk?;
        for line in lines.push(&chunk) {
            for event in parser.line(&line)? {
                emit(event);
            }
        }
    }
    if let Some(line) = lines.finish() {
        for event in parser.line(&line)? {
            emit(event);
        }
    }
    // A complete reply has a finish_reason or [DONE]; without either it was cut off.
    if !parser.finished && parser.stop_reason.is_none() {
        return Err(super::cut_off());
    }
    for event in parser.finish() {
        emit(event);
    }
    Ok(())
}
