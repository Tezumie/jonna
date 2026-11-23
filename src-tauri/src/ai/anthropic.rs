//! Anthropic's native Messages API (`/v1/models`, `/v1/messages` with SSE), D112. Unlike the
//! OpenAI-compatible layer it has prompt caching and returns thinking:
//! - **Caching**: one explicit breakpoint at the end of the system prompt (tools + system are the
//!   stable prefix of every request in a session) and the top-level automatic breakpoint, which
//!   sits on the last block and moves forward as the conversation grows, so each step reads the
//!   previous step's prefix from the cache.
//! - **Thinking**: adaptive thinking with summarized display; each finished thinking (or
//!   redacted_thinking) block is emitted as `Reasoning` and sent back unchanged in the assistant
//!   message (required while tools are in use).
//! - **Its own web search** (D450, `hosted_search`): the API's web search tool runs on its side.
//!   The call, its result and the text around them are emitted as `Reasoning` too and go back in
//!   the order they came (the results' encrypted content must return unchanged).
//! - No `temperature`: current models reject non-default sampling parameters.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use super::{
    error_body, http_error, url, ChatEvent, ChatRequest, LineBuffer, Message, ModelDetails,
    ModelInfo, SearchHit,
};
use crate::error::{Error, Result};

const VERSION: &str = "2023-06-01";
/// Output budget when the caller doesn't set one (the model's own maximum may be lower).
const DEFAULT_MAX_TOKENS: u32 = 32_000;
/// The name the API gives its web search tool (D450).
const HOSTED_SEARCH_NAME: &str = "web_search";

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

/// A block the provider made on its side (D450): its own tool call or that call's result.
fn server_block(kind: &str) -> bool {
    kind == "server_tool_use" || (kind.ends_with("_tool_result") && kind != "tool_result")
}

/// The system prompt (all system messages) and the conversation as Messages API turns.
/// An assistant message goes back as it came (D451): its thinking and text blocks in their order
/// (`thinking_blocks` holds both, when the reply was read by this parser), then its tool calls.
/// With `hosted` (the provider's own web search is on, D450) its searches and their results too;
/// without it those are left out. With `declared` (the deferred tools the request declares,
/// D452) a tool search's result is the references that load them, not their text.
pub fn convert(
    messages: &[Message],
    hosted: bool,
    declared: Option<&HashSet<&str>>,
) -> (String, Vec<Value>) {
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
                let mut blocks: Vec<Value> = m
                    .thinking_blocks
                    .iter()
                    .filter(|b| hosted || !server_block(b["type"].as_str().unwrap_or("")))
                    .map(|b| {
                        let mut b = b.clone();
                        // A citation points into a search result that isn't sent.
                        if !hosted {
                            if let Some(o) = b.as_object_mut() {
                                o.remove("citations");
                            }
                        }
                        b
                    })
                    .collect();
                // The reply's text came with its blocks (in their order): not a second time.
                if !blocks.iter().any(|b| b["type"] == "text") {
                    blocks.extend(text_block(&m.content));
                }
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
                // A reply that ends in thinking (cut off at the output limit, or all of it was)
                // can't be sent back: "the final block in an assistant message cannot be
                // `thinking`" (400). Thinking with nothing after it carries nothing anyway.
                while blocks.last().is_some_and(|b| {
                    matches!(b["type"].as_str(), Some("thinking" | "redacted_thinking"))
                }) {
                    blocks.pop();
                }
                push(&mut out, "assistant", blocks);
            }
            "tool" => {
                let text = if m.content.is_empty() {
                    "(no output)".to_string()
                } else {
                    m.content.clone()
                };
                let refs: Vec<Value> = declared
                    .map(|names| {
                        m.tool_refs
                            .iter()
                            .filter(|n| names.contains(n.as_str()))
                            .map(|n| json!({ "type": "tool_reference", "tool_name": n }))
                            .collect()
                    })
                    .unwrap_or_default();
                let content = if refs.is_empty() {
                    let mut content = vec![json!({ "type": "text", "text": text })];
                    content.extend(m.images.iter().map(|i| image_block(i)));
                    content
                } else {
                    refs
                };
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

/// Our own tool that loads deferred tools (the front end's `tool_search`).
const TOOL_SEARCH_NAME: &str = "tool_search";
/// The beta for clearing old tool results on the provider's side.
const TRIM_BETA: &str = "context-management-2025-06-27";
/// Tool results the provider keeps whole when it clears (as many as the front end keeps).
const TRIM_KEEP: u64 = 10;

/// The deferred tools a conversation has loaded: the ones a tool search gave, and the ones it
/// called by name.
fn loaded_tools(messages: &[Message]) -> HashSet<&str> {
    let mut names = HashSet::new();
    for m in messages {
        names.extend(m.tool_refs.iter().map(String::as_str));
        names.extend(m.tool_calls.iter().map(|c| c.name.as_str()));
    }
    names
}

fn tool_json(t: &super::ToolSpec) -> Value {
    json!({ "name": t.name, "description": t.description, "input_schema": t.parameters })
}

/// The request. Without `extras` it is as the plain Messages API takes it: deferred tools are
/// sent once loaded.
/// With `extras` (D452): every deferred tool is declared from the first request, marked
/// `defer_loading`, so loading one changes nothing already sent (a tool search's result refers
/// to it); and the provider is asked to clear old tool results itself (`trim_at`).
pub fn request_body(req: &ChatRequest, extras: bool) -> Value {
    // Only beside a tool that isn't deferred: the API refuses a list in which every tool is.
    let declared: Option<HashSet<&str>> =
        (extras && !req.deferred_tools.is_empty() && !req.tools.is_empty())
            .then(|| req.deferred_tools.iter().map(|t| t.name.as_str()).collect());
    let (system, messages) = convert(
        &req.messages,
        req.hosted_search.is_some(),
        declared.as_ref(),
    );
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
    let mut tools: Vec<Value> = req
        .tools
        .iter()
        // The provider's search has this name too (D450): one of them.
        .filter(|t| req.hosted_search.is_none() || t.name != HOSTED_SEARCH_NAME)
        .map(tool_json)
        .collect();
    // What the chat has loaded: what the front end says (the whole chat), and what the
    // messages sent show.
    let mut loaded = loaded_tools(&req.messages);
    loaded.extend(req.loaded_tools.iter().map(String::as_str));
    if declared.is_some() {
        // What a tool search's result still sent refers to: the API loads those itself.
        let referred: HashSet<&str> = req
            .messages
            .iter()
            .flat_map(|m| m.tool_refs.iter().map(String::as_str))
            .collect();
        tools.extend(req.deferred_tools.iter().map(|t| {
            let mut tool = tool_json(t);
            // A loaded tool nothing refers to any more (a summary took the search that
            // loaded it, or it was called by name) would be out of the model's reach while
            // the chat says it is loaded: it is offered outright.
            let name = t.name.as_str();
            if !loaded.contains(name) || referred.contains(name) {
                tool["defer_loading"] = json!(true);
            }
            tool
        }));
    } else {
        tools.extend(
            req.deferred_tools
                .iter()
                .filter(|t| loaded.contains(t.name.as_str()))
                .map(tool_json),
        );
    }
    if let Some(max_uses) = req.hosted_search {
        // The basic version: every model has it, and its results come as plain blocks (the later
        // ones run the search from code execution, with blocks of their own).
        tools.push(json!({
            "type": "web_search_20250305",
            "name": HOSTED_SEARCH_NAME,
            "max_uses": max_uses.clamp(1, 20),
        }));
    }
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools);
    }
    if req.think == Some(true) {
        body["thinking"] = json!({ "type": "adaptive", "display": "summarized" });
    }
    if let Some(effort) = req.effort.as_deref().filter(|e| !e.is_empty()) {
        body["output_config"] = json!({ "effort": effort });
    }
    if let Some(at) = req.trim_at.filter(|_| extras) {
        let mut edit = json!({
            "type": "clear_tool_uses_20250919",
            "trigger": { "type": "input_tokens", "value": at },
            "keep": { "type": "tool_uses", "value": TRIM_KEEP },
            // Each clearing rewrites the cached prompt: only when it frees something worth it.
            "clear_at_least": { "type": "input_tokens", "value": (at / 20).max(2000) },
        });
        // What a tool search loaded stays loaded.
        if req.tools.iter().any(|t| t.name == TOOL_SEARCH_NAME) {
            edit["exclude_tools"] = json!([TOOL_SEARCH_NAME]);
        }
        body["context_management"] = json!({ "edits": [edit] });
    }
    body
}

/// Whether the request has something the extras change (D452).
fn wants_extras(req: &ChatRequest) -> bool {
    !req.deferred_tools.is_empty() || req.trim_at.is_some()
}

/// Models whose endpoint refused the extras and took the plain request, and when: not asked
/// again for a while (`PLAIN_FOR`), so a chat's tool list doesn't change shape from one request
/// to the next. Not for ever: the refusal may have been of one request, not of the model.
fn plain_only() -> &'static Mutex<HashMap<String, Instant>> {
    static PLAIN: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    PLAIN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// How long a model that refused the extras is asked without them.
const PLAIN_FOR: Duration = Duration::from_secs(30 * 60);

/// What a request does about thinking blocks its history may have outdated (D451).
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Replay {
    /// Sent as they are.
    AsIs,
    /// Sent, with the API asked to drop the ones that no longer fit instead of refusing.
    DropStale,
    /// None sent: the reply's text and tool calls only.
    Strip,
}

/// The beta that lets a request say what happens to thinking blocks that no longer fit.
const BINDING_BETA: &str = "thinking-binding-controls-2026-08-01";
/// How the API's refusal of such a block reads.
const STALE_THINKING: &str = "bound to a different conversation";

/// Whether `base` is the provider's own API (where the binding controls are known to exist).
fn official(base: &str) -> bool {
    reqwest::Url::parse(base)
        .ok()
        .and_then(|u| u.host_str().map(|h| h == "api.anthropic.com"))
        .unwrap_or(false)
}

/// A setting of the request a 400 names as one the model or endpoint doesn't take.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Unsupported {
    /// The `thinking` setting (adaptive thinking, or its `display`).
    Thinking,
    /// `output_config.effort`.
    Effort,
}

/// What a 400's message says the model doesn't take, when it is a setting the request can go
/// without. Not the refusals that are about thinking blocks in the history (`STALE_THINKING`,
/// the binding controls): those have their own way out.
pub fn unsupported_setting(message: &str) -> Option<Unsupported> {
    let m = message.to_ascii_lowercase();
    if m.contains(STALE_THINKING) || m.contains("block_binding") {
        return None;
    }
    if m.contains("output_config") || m.contains("effort") {
        return Some(Unsupported::Effort);
    }
    let about_the_setting = [
        "adaptive",
        "thinking.type",
        "thinking.display",
        "does not support",
        "not supported",
        "not permitted",
    ];
    (m.contains("thinking") && about_the_setting.iter().any(|s| m.contains(s)))
        .then_some(Unsupported::Thinking)
}

/// How the API says a request is over the model's context (no other shape of it would fit).
const TOO_LONG: &str = "prompt is too long";

/// The request's body for `replay`, with or without the extras (`request_body`).
pub fn body_for(req: &ChatRequest, replay: Replay, extras: bool) -> Value {
    let mut body = request_body(req, extras);
    match replay {
        Replay::AsIs => {}
        // Only beside the thinking setting the request already sends: adding one would turn
        // thinking on for a model that was asked without it.
        Replay::DropStale => {
            if body["thinking"].is_object() {
                body["thinking"]["block_binding"] =
                    json!({ "prefix_mismatch_behavior": "drop_block" });
            }
        }
        Replay::Strip => {
            if let Some(messages) = body["messages"].as_array_mut() {
                for m in messages.iter_mut() {
                    if let Some(content) = m["content"].as_array_mut() {
                        content.retain(|b| {
                            !matches!(b["type"].as_str(), Some("thinking" | "redacted_thinking"))
                        });
                    }
                }
                messages.retain(|m| {
                    m["content"]
                        .as_array()
                        .map(|c| !c.is_empty())
                        .unwrap_or(true)
                });
            }
        }
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
    /// The block as it started: a server tool's result comes whole there (D450).
    raw: Value,
    /// A text block's citations of search results, which go back with it.
    citations: Vec<Value>,
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
    /// Text blocks are kept too (D451), so the message can go back in the order it came: its
    /// thinking is bound to what came before it, in the reply as well.
    ordered: bool,
    /// What each of the provider's searches asked, by its call's id.
    queries: HashMap<String, String>,
}

impl SseParser {
    /// A parser that keeps the reply's text blocks with its other blocks, in their order (D451).
    pub fn ordered() -> Self {
        Self {
            ordered: true,
            ..Self::default()
        }
    }

    /// What the chat shows of a search the provider ran: the results, or why there are none.
    fn searched(&self, raw: &Value) -> ChatEvent {
        let id = raw["tool_use_id"].as_str().unwrap_or("");
        let content = &raw["content"];
        let text = |v: &Value, k: &str| v[k].as_str().unwrap_or("").to_string();
        ChatEvent::WebSearched {
            query: self.queries.get(id).cloned().unwrap_or_default(),
            results: content
                .as_array()
                .map(|list| {
                    list.iter()
                        .filter(|r| r["url"].is_string())
                        .map(|r| SearchHit {
                            title: text(r, "title"),
                            url: text(r, "url"),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            // On an error the content is one object with the code, not a list.
            error: content
                .is_object()
                .then(|| text(content, "error_code"))
                .filter(|c| !c.is_empty()),
        }
    }

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
                        raw: b.clone(),
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
                        block.text.push_str(&t);
                        if !t.is_empty() {
                            out.push(ChatEvent::Text { text: t });
                        }
                    }
                    "citations_delta" => {
                        if let Some(c) = d.get("citation") {
                            block.citations.push(c.clone());
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
                        // The text is kept as a block too: the message goes back in the order
                        // it came (D451).
                        "text" if self.ordered && !b.text.trim().is_empty() => {
                            let mut block = json!({ "type": "text", "text": b.text });
                            if !b.citations.is_empty() {
                                block["citations"] = Value::Array(b.citations);
                            }
                            out.push(ChatEvent::Reasoning { block });
                        }
                        // The provider's own tool call: kept to send back, with what it asked.
                        "server_tool_use" => {
                            let input: Value = serde_json::from_str(&b.text)
                                .unwrap_or_else(|_| Value::Object(Map::new()));
                            if let Some(q) = input["query"].as_str() {
                                self.queries.insert(b.id.clone(), q.to_string());
                            }
                            let mut block = b.raw;
                            block["input"] = input;
                            out.push(ChatEvent::Reasoning { block });
                        }
                        // And its result, which came whole when the block started.
                        kind if server_block(kind) => {
                            if kind == "web_search_tool_result" {
                                out.push(self.searched(&b.raw));
                            }
                            out.push(ChatEvent::Reasoning { block: b.raw });
                        }
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
    // Thinking blocks are bound to the conversation that made them (D451): after the history
    // changed (older tool results shortened, turns dropped, a tool added), the API refuses the
    // request. Asked to drop what no longer fits where it can be asked; and wherever it still
    // refuses, the request goes once more with no thinking blocks at all.
    let official = official(&req.provider.base_url);
    let mut replay = if official {
        Replay::DropStale
    } else {
        Replay::AsIs
    };
    // Deferred tools declared once and old tool results cleared by the API (D452): on its own
    // API, and given up for the plain request if it refuses them.
    let mut extras = official
        && wants_extras(req)
        && !plain_only()
            .lock()
            .map(|p| {
                p.get(&req.model)
                    .is_some_and(|since| since.elapsed() < PLAIN_FOR)
            })
            .unwrap_or(true);
    // What was done about thinking blocks when the extras were given up: the model is marked
    // only when the very next request, changed in nothing else, was taken. A refusal that
    // was about something else (and ended with the thinking blocks stripped) marks nothing.
    let mut dropped_at: Option<Replay> = None;
    // Settings a 400 named as not taken (`unsupported_setting`): left out from then on, each
    // given up once, instead of failing the turn after retries that send the same thing.
    let mut without: Vec<Unsupported> = Vec::new();
    let response = loop {
        let mut body = body_for(req, replay, extras);
        if let Some(map) = body.as_object_mut() {
            if without.contains(&Unsupported::Thinking) {
                map.remove("thinking");
            }
            if without.contains(&Unsupported::Effort) {
                map.remove("output_config");
            }
        }
        let mut builder = with_key(
            client.post(api(&req.provider.base_url, "messages")),
            key.clone(),
        );
        let mut betas: Vec<&str> = Vec::new();
        if body["thinking"].get("block_binding").is_some() {
            betas.push(BINDING_BETA);
        }
        if body.get("context_management").is_some() {
            betas.push(TRIM_BETA);
        }
        // One header: some endpoints read only the first.
        if !betas.is_empty() {
            builder = builder.header("anthropic-beta", betas.join(","));
        }
        let response = builder.json(&body).send().await.map_err(http_error)?;
        super::note_limits(seen, &response);
        if response.status().is_success() {
            if dropped_at == Some(replay) {
                if let Ok(mut plain) = plain_only().lock() {
                    plain.insert(req.model.clone(), Instant::now());
                }
            }
            break response;
        }
        let refused = response.status() == reqwest::StatusCode::BAD_REQUEST;
        let err = error_body(response).await;
        let text = err.to_string();
        if !refused || text.contains(TOO_LONG) {
            return Err(err);
        }
        let named = unsupported_setting(&text).filter(|u| {
            !without.contains(u)
                && body
                    .get(match u {
                        Unsupported::Thinking => "thinking",
                        Unsupported::Effort => "output_config",
                    })
                    .is_some()
        });
        if let Some(setting) = named {
            without.push(setting);
            continue;
        }
        let stale = text.contains(STALE_THINKING);
        if stale && replay != Replay::Strip {
            replay = Replay::Strip;
        } else if extras && !stale {
            // The refusal may be of the extras themselves (a model or an account without them).
            extras = false;
            dropped_at = Some(replay);
        } else if replay == Replay::DropStale {
            // Or of the asking to drop (an endpoint without it).
            replay = Replay::Strip;
        } else {
            return Err(err);
        }
    };
    let mut stream = response.bytes_stream();
    let mut lines = LineBuffer::default();
    let mut parser = SseParser::ordered();
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
