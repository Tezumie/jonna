//! Anthropic's native Messages API (`/v1/models`, `/v1/messages` with SSE), D112. Unlike the
//! OpenAI-compatible layer it has prompt caching and returns thinking:
//! - **Caching**: one explicit breakpoint at the end of the system prompt (tools + system are the
//!   stable prefix of every request in a session) and the top-level automatic breakpoint, which
//!   sits on the last block and moves forward as the conversation grows, so each step reads the
//!   previous step's prefix from the cache.
//! - **Thinking**: adaptive thinking with summarized display; each finished thinking (or
//!   redacted_thinking) block is emitted as `Reasoning` and sent back unchanged in the assistant
//!   message (required while tools are in use).
//! - No `temperature`: current models reject non-default sampling parameters.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use super::{
    error_body, http_error, url, ChatEvent, ChatRequest, LineBuffer, Message, ModelDetails,
    ModelInfo,
};
use crate::error::{Error, Result};

const VERSION: &str = "2023-06-01";
/// Output budget when the caller doesn't set one (the model's own maximum may be lower).
const DEFAULT_MAX_TOKENS: u32 = 32_000;

fn api(base: &str, path: &str) -> String {
    let b = base.trim_end_matches('/');
    if b.ends_with("/v1") {
        url(b, path)
    } else {
        url(&url(b, "v1"), path)
    }
}

fn with_key(builder: reqwest::RequestBuilder, key: Option<String>) -> reqwest::RequestBuilder {
    let builder = builder.header("anthropic-version", VERSION);
    match key.filter(|k| !k.is_empty()) {
        Some(k) => builder.header("x-api-key", k),
        None => builder,
    }
}

pub async fn list_models(
    client: &reqwest::Client,
    base: &str,
    key: Option<String>,
) -> Result<Vec<ModelInfo>> {
    let response = with_key(client.get(api(base, "models?limit=1000")), key)
        .send()
        .await
        .map_err(http_error)?;
    if !response.status().is_success() {
        return Err(error_body(response).await);
    }
    let body: Value = response.json().await.map_err(http_error)?;
    Ok(parse_models(&body))
}

pub fn parse_models(body: &Value) -> Vec<ModelInfo> {
    body.get("data")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|m| m.get("lifecycle").and_then(Value::as_str) != Some("retired"))
                .filter_map(|m| {
                    Some(ModelInfo {
                        id: m.get("id")?.as_str()?.to_string(),
                        family: m.get("line").and_then(Value::as_str).map(str::to_string),
                        remote: true,
                        ..ModelInfo::default()
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub async fn model(
    client: &reqwest::Client,
    base: &str,
    model: &str,
    key: Option<String>,
) -> Result<ModelDetails> {
    let response = with_key(client.get(api(base, &format!("models/{model}"))), key)
        .send()
        .await
        .map_err(http_error)?;
    if !response.status().is_success() {
        // An alias the endpoint doesn't describe still works for chat.
        return Ok(ModelDetails {
            tools: Some(true),
            ..ModelDetails::default()
        });
    }
    let body: Value = response.json().await.map_err(http_error)?;
    Ok(parse_model(&body))
}

pub fn parse_model(m: &Value) -> ModelDetails {
    let supported = |path: &str| m.pointer(path).and_then(Value::as_bool);
    ModelDetails {
        tools: Some(true),
        thinking: supported("/capabilities/thinking/supported"),
        vision: supported("/capabilities/image_input/supported"),
        context_length: m.get("max_input_tokens").and_then(Value::as_u64),
        max_output_tokens: m.get("max_tokens").and_then(Value::as_u64),
    }
}

fn cache_control(ttl: Option<&str>) -> Value {
    match ttl {
        Some("1h") => json!({ "type": "ephemeral", "ttl": "1h" }),
        _ => json!({ "type": "ephemeral" }),
    }
}

fn image_block(data: &str) -> Value {
    let media = if data.starts_with("/9j/") {
        "image/jpeg"
    } else {
        "image/png"
    };
    json!({ "type": "image", "source": { "type": "base64", "media_type": media, "data": data } })
}

/// Appends `blocks` to the last message when it has `role`, else starts a new message (the API
/// wants user and assistant turns to alternate; tool results are user content).
fn push(out: &mut Vec<Value>, role: &str, blocks: Vec<Value>) {
    if blocks.is_empty() {
        return;
    }
    if let Some(last) = out.last_mut() {
        if last["role"] == role {
            if let Some(content) = last["content"].as_array_mut() {
                content.extend(blocks);
                return;
            }
        }
    }
    out.push(json!({ "role": role, "content": blocks }));
}

fn text_block(text: &str) -> Option<Value> {
    (!text.trim().is_empty()).then(|| json!({ "type": "text", "text": text }))
}

/// The system prompt (all system messages) and the conversation as Messages API turns.
pub fn convert(messages: &[Message]) -> (String, Vec<Value>) {
    let mut system = Vec::new();
    let mut out: Vec<Value> = Vec::new();
    for m in messages {
        match m.role.as_str() {
            "system" => {
                if !m.content.trim().is_empty() {
                    system.push(m.content.clone());
                }
            }
            "assistant" => {
                let mut blocks: Vec<Value> = m.thinking_blocks.clone();
                blocks.extend(text_block(&m.content));
                for c in &m.tool_calls {
                    let input = if c.arguments.is_object() {
                        c.arguments.clone()
                    } else {
                        json!({})
                    };
                    blocks.push(
                        json!({ "type": "tool_use", "id": c.id, "name": c.name, "input": input }),
                    );
                }
                // A reply that was only thinking (cut off at the output limit) can't be sent
                // back: "the final block in an assistant message cannot be `thinking`" (400).
                // Without text or a tool call it carries nothing for the model anyway.
                if blocks
                    .iter()
                    .all(|b| matches!(b["type"].as_str(), Some("thinking" | "redacted_thinking")))
                {
                    blocks.clear();
                }
                push(&mut out, "assistant", blocks);
            }
            "tool" => {
                let text = if m.content.is_empty() {
                    "(no output)".to_string()
                } else {
                    m.content.clone()
                };
                let mut content = vec![json!({ "type": "text", "text": text })];
                content.extend(m.images.iter().map(|i| image_block(i)));
                push(
                    &mut out,
                    "user",
                    vec![json!({
                        "type": "tool_result",
                        "tool_use_id": m.tool_call_id.clone().unwrap_or_default(),
                        "content": content,
                    })],
                );
            }
            _ => {
                let mut blocks: Vec<Value> = m.images.iter().map(|i| image_block(i)).collect();
                blocks.extend(text_block(&m.content));
                push(&mut out, "user", blocks);
            }
        }
    }
    // The conversation must start with a user turn.
    if out.first().map(|m| m["role"] != "user").unwrap_or(false) {
        out.insert(
            0,
            json!({ "role": "user", "content": [{ "type": "text", "text": "(continuing)" }] }),
        );
    }
    (system.join("\n\n"), out)
}

pub fn request_body(req: &ChatRequest) -> Value {
    let (system, messages) = convert(&req.messages);
    let ttl = req.cache_ttl.as_deref();
    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
        "messages": messages,
        "stream": true,
    });
    if !req.no_cache {
        // Automatic caching: the breakpoint follows the end of the conversation.
        body["cache_control"] = cache_control(ttl);
    }
    if !system.is_empty() {
        // Explicit breakpoint: tools + system, the part every request of the session shares.
        body["system"] = if req.no_cache {
            json!([{ "type": "text", "text": system }])
        } else {
            json!([{ "type": "text", "text": system, "cache_control": cache_control(ttl) }])
        };
    }
    if !req.tools.is_empty() {
        body["tools"] = req
            .tools
            .iter()
            .map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.parameters }))
            .collect();
    }
    if req.think == Some(true) {
        body["thinking"] = json!({ "type": "adaptive", "display": "summarized" });
    }
    if let Some(effort) = req.effort.as_deref().filter(|e| !e.is_empty()) {
        body["output_config"] = json!({ "effort": effort });
    }
    body
}

#[derive(Default)]
struct Block {
    kind: String,
    /// Text, thinking text, or the tool input JSON being assembled.
    text: String,
    signature: String,
    id: String,
    name: String,
    /// redacted_thinking's opaque data.
    data: String,
    progress: super::ToolStreamProgress,
}

/// Accumulates SSE events into chat events.
#[derive(Default)]
pub struct SseParser {
    blocks: BTreeMap<u64, Block>,
    stop_reason: Option<String>,
    input_tokens: Option<u64>,
    cache_read: Option<u64>,
    cache_write: Option<u64>,
    output_tokens: Option<u64>,
    finished: bool,
}

impl SseParser {
    fn usage(&mut self, u: &Value) {
        let n = |k: &str| u.get(k).and_then(Value::as_u64);
        if let Some(v) = n("input_tokens") {
            self.input_tokens = Some(v);
        }
        if let Some(v) = n("cache_read_input_tokens") {
            self.cache_read = Some(v);
        }
        if let Some(v) = n("cache_creation_input_tokens") {
            self.cache_write = Some(v);
        }
        if let Some(v) = n("output_tokens") {
            self.output_tokens = Some(v);
        }
    }

    pub fn line(&mut self, line: &str) -> Result<Vec<ChatEvent>> {
        let mut out = Vec::new();
        let Some(data) = line.strip_prefix("data:") else {
            return Ok(out);
        };
        let v: Value = serde_json::from_str(data.trim())?;
        let index = v.get("index").and_then(Value::as_u64).unwrap_or(0);
        match v.get("type").and_then(Value::as_str).unwrap_or("") {
            "message_start" => {
                if let Some(u) = v.pointer("/message/usage") {
                    self.usage(u);
                }
            }
            "content_block_start" => {
                let b = v.get("content_block").cloned().unwrap_or(Value::Null);
                let s = |k: &str| b.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                self.blocks.insert(
                    index,
                    Block {
                        kind: s("type"),
                        id: s("id"),
                        name: s("name"),
                        data: s("data"),
                        ..Block::default()
                    },
                );
            }
            "content_block_delta" => {
                let d = v.get("delta").cloned().unwrap_or(Value::Null);
                let s = |k: &str| d.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                let block = self.blocks.entry(index).or_default();
                match s("type").as_str() {
                    "text_delta" => {
                        let t = s("text");
                        if !t.is_empty() {
                            out.push(ChatEvent::Text { text: t });
                        }
                    }
                    "thinking_delta" => {
                        let t = s("thinking");
                        block.text.push_str(&t);
                        if !t.is_empty() {
                            out.push(ChatEvent::Thinking { text: t });
                        }
                    }
                    "signature_delta" => block.signature.push_str(&s("signature")),
                    "input_json_delta" => {
                        block.text.push_str(&s("partial_json"));
                        if let Some(e) = block.progress.update(&block.id, &block.name, &block.text)
                        {
                            out.push(e);
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                if let Some(b) = self.blocks.remove(&index) {
                    match b.kind.as_str() {
                        "thinking" => out.push(ChatEvent::Reasoning {
                            block: json!({ "type": "thinking", "thinking": b.text, "signature": b.signature }),
                        }),
                        "redacted_thinking" => out.push(ChatEvent::Reasoning {
                            block: json!({ "type": "redacted_thinking", "data": b.data }),
                        }),
                        "tool_use" => out.push(ChatEvent::ToolCall {
                            id: b.id,
                            name: b.name,
                            arguments: if b.text.trim().is_empty() {
                                Value::Object(Map::new())
                            } else {
                                serde_json::from_str(&b.text).unwrap_or(Value::String(b.text))
                            },
                        }),
                        _ => {}
                    }
                }
            }
            "message_delta" => {
                if let Some(r) = v.pointer("/delta/stop_reason").and_then(Value::as_str) {
                    self.stop_reason = Some(r.to_string());
                }
                if let Some(u) = v.get("usage") {
                    self.usage(u);
                }
            }
            "message_stop" => out.extend(self.finish()),
            "error" => {
                let e = v.get("error").cloned().unwrap_or(Value::Null);
                let kind = e.get("type").and_then(Value::as_str).unwrap_or("error");
                let msg = e
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("provider error");
                // "overloaded_error" → retried like HTTP 529 (isTransientError).
                let code = match kind {
                    "overloaded_error" => " (529)",
                    "rate_limit_error" => " (429)",
                    "api_error" => " (500)",
                    _ => "",
                };
                return Err(Error::Ai(format!("{msg}{code}")));
            }
            _ => {}
        }
        Ok(out)
    }

    /// The final Done (once). Input tokens include the cached ones (the API reports them apart).
    pub fn finish(&mut self) -> Vec<ChatEvent> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        let input = match (self.input_tokens, self.cache_read, self.cache_write) {
            (None, None, None) => None,
            (a, b, c) => Some(a.unwrap_or(0) + b.unwrap_or(0) + c.unwrap_or(0)),
        };
        vec![ChatEvent::Done {
            stop_reason: match self.stop_reason.as_deref() {
                Some("max_tokens") => "length".into(),
                Some("tool_use") => "tool_calls".into(),
                Some(r) => r.to_string(),
                None => "stop".into(),
            },
            input_tokens: input,
            output_tokens: self.output_tokens,
            cache_read_tokens: self.cache_read,
            cache_write_tokens: self.cache_write,
            cost: None,
        }]
    }
}

pub async fn chat<F: FnMut(ChatEvent)>(
    client: &reqwest::Client,
    req: &ChatRequest,
    key: Option<String>,
    mut emit: F,
    seen: &mut super::SeenLimits,
) -> Result<()> {
    let response = with_key(client.post(api(&req.provider.base_url, "messages")), key)
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
    // Every complete reply ends with message_stop.
    if !parser.finished {
        return Err(super::cut_off());
    }
    Ok(())
}
