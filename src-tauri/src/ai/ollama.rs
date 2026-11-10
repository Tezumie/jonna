//! Ollama's native API: `/api/tags` (installed models), `/api/show` (capabilities, context length),
//! `/api/chat` (NDJSON stream; tool calls arrive whole, arguments as an object).

use serde_json::{json, Value};

use super::{
    error_body, http_error, url, ChatEvent, ChatRequest, LineBuffer, Message, ModelDetails,
    ModelInfo,
};
use crate::error::Result;

pub async fn list_models(client: &reqwest::Client, base: &str) -> Result<Vec<ModelInfo>> {
    let response = client
        .get(url(base, "api/tags"))
        .send()
        .await
        .map_err(http_error)?;
    if !response.status().is_success() {
        return Err(error_body(response).await);
    }
    let body: Value = response.json().await.map_err(http_error)?;
    Ok(parse_tags(&body))
}

pub fn parse_tags(body: &Value) -> Vec<ModelInfo> {
    body.get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|m| {
                    let id = m
                        .get("name")
                        .or_else(|| m.get("model"))?
                        .as_str()?
                        .to_string();
                    let details = m.get("details");
                    let detail = |k: &str| {
                        details
                            .and_then(|d| d.get(k))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    };
                    Some(ModelInfo {
                        remote: id.ends_with(":cloud")
                            || id.contains("-cloud")
                            || m.get("remote_host").is_some(),
                        size: m.get("size").and_then(Value::as_u64),
                        family: detail("family"),
                        parameter_size: detail("parameter_size"),
                        quantization: detail("quantization_level"),
                        pricing: None,
                        output_images: false,
                        id,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub async fn show(client: &reqwest::Client, base: &str, model: &str) -> Result<ModelDetails> {
    let response = client
        .post(url(base, "api/show"))
        .json(&json!({ "model": model }))
        .send()
        .await
        .map_err(http_error)?;
    if !response.status().is_success() {
        return Err(error_body(response).await);
    }
    let body: Value = response.json().await.map_err(http_error)?;
    Ok(parse_show(&body))
}

pub fn parse_show(body: &Value) -> ModelDetails {
    let caps: Vec<&str> = body
        .get("capabilities")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let known = !caps.is_empty();
    let context_length = body
        .get("model_info")
        .and_then(Value::as_object)
        .and_then(|info| {
            info.iter()
                .find(|(k, _)| k.ends_with(".context_length"))
                .and_then(|(_, v)| v.as_u64())
        });
    ModelDetails {
        tools: known.then(|| caps.contains(&"tools")),
        thinking: known.then(|| caps.contains(&"thinking")),
        vision: known.then(|| caps.contains(&"vision")),
        context_length,
        max_output_tokens: None,
    }
}

fn message_json(m: &Message) -> Value {
    let mut v = json!({ "role": m.role, "content": m.content });
    if !m.tool_calls.is_empty() {
        v["tool_calls"] = m
            .tool_calls
            .iter()
            .map(|c| json!({ "function": { "name": c.name, "arguments": c.arguments } }))
            .collect();
    }
    if let Some(name) = &m.tool_name {
        v["tool_name"] = json!(name);
    }
    if !m.images.is_empty() {
        v["images"] = json!(m.images);
    }
    v
}

pub fn request_body(req: &ChatRequest) -> Value {
    let mut body = json!({
        "model": req.model,
        "messages": req.messages.iter().map(message_json).collect::<Vec<_>>(),
        "stream": true,
    });
    if !req.tools.is_empty() {
        body["tools"] = req
            .tools
            .iter()
            .map(|t| json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.parameters } }))
            .collect();
    }
    if let Some(think) = req.think {
        body["think"] = json!(think);
    }
    // Keeps the model loaded between turns, so the next request reuses its prompt cache.
    if let Some(k) = &req.keep_alive {
        body["keep_alive"] = json!(k);
    }
    let mut options = serde_json::Map::new();
    if let Some(t) = req.temperature {
        options.insert("temperature".into(), json!(t));
    }
    if let Some(n) = req.context_length {
        options.insert("num_ctx".into(), json!(n));
    }
    if let Some(n) = req.max_tokens {
        options.insert("num_predict".into(), json!(n));
    }
    if !options.is_empty() {
        body["options"] = Value::Object(options);
    }
    body
}

/// Turns one NDJSON line into events. `calls` numbers tool calls (Ollama gives them no ids).
pub fn parse_line(line: &str, calls: &mut u32) -> Result<Vec<ChatEvent>> {
    let mut out = Vec::new();
    if line.trim().is_empty() {
        return Ok(out);
    }
    let v: Value = serde_json::from_str(line)?;
    if let Some(err) = v.get("error").and_then(Value::as_str) {
        return Err(crate::error::Error::Ai(err.to_string()));
    }
    if let Some(msg) = v.get("message") {
        if let Some(t) = msg
            .get("thinking")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
        {
            out.push(ChatEvent::Thinking {
                text: t.to_string(),
            });
        }
        if let Some(t) = msg
            .get("content")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
        {
            out.push(ChatEvent::Text {
                text: t.to_string(),
            });
        }
        for call in msg
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let f = call.get("function").unwrap_or(call);
            *calls += 1;
            let arguments = match f.get("arguments") {
                Some(Value::String(s)) => {
                    serde_json::from_str(s).unwrap_or(Value::String(s.clone()))
                }
                Some(v) => v.clone(),
                None => json!({}),
            };
            out.push(ChatEvent::ToolCall {
                id: call
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("call_{calls}")),
                name: f
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                arguments,
            });
        }
    }
    if v.get("done").and_then(Value::as_bool) == Some(true) {
        out.push(ChatEvent::Done {
            stop_reason: v
                .get("done_reason")
                .and_then(Value::as_str)
                .unwrap_or("stop")
                .to_string(),
            input_tokens: v.get("prompt_eval_count").and_then(Value::as_u64),
            output_tokens: v.get("eval_count").and_then(Value::as_u64),
            cache_read_tokens: None,
            cache_write_tokens: None,
            cost: None,
        });
    }
    Ok(out)
}

pub async fn chat<F: FnMut(ChatEvent)>(
    client: &reqwest::Client,
    req: &ChatRequest,
    mut emit: F,
) -> Result<()> {
    let response = client
        .post(url(&req.provider.base_url, "api/chat"))
        .json(&request_body(req))
        .send()
        .await
        .map_err(http_error)?;
    if !response.status().is_success() {
        return Err(error_body(response).await);
    }
    let mut stream = response.bytes_stream();
    let mut lines = LineBuffer::default();
    let mut calls = 0u32;
    let mut done = false;
    while let Some(chunk) = super::next_chunk(&mut stream).await {
        let chunk = chunk?;
        for line in lines.push(&chunk) {
            for event in parse_line(&line, &mut calls)? {
                done |= matches!(event, ChatEvent::Done { .. });
                emit(event);
            }
        }
    }
    if let Some(line) = lines.finish() {
        for event in parse_line(&line, &mut calls)? {
            done |= matches!(event, ChatEvent::Done { .. });
            emit(event);
        }
    }
    // Ollama's last line says done: without it the reply was cut off (Ollama stopped, the
    // model crashed out of memory).
    if !done {
        return Err(super::cut_off());
    }
    Ok(())
}
