//! Model providers for the built-in agent (PLAN §8.3): local Ollama (found automatically), any
//! OpenAI-compatible endpoint (LM Studio, llama.cpp server, vLLM, OpenRouter, OpenAI…) and
//! Anthropic's native Messages API (prompt caching, thinking with signatures — D112). Rust makes
//! the HTTP calls (no CORS, API keys never reach the webview) and streams normalized events —
//! text, thinking, tool calls, done — over a Channel. Messages use one provider-neutral shape
//! (`Message`); `ollama.rs` and `openai.rs` translate. Parsers are pure and tested (`tests.rs`).

mod anthropic;
pub mod embed;
pub mod fim;
pub mod keychain;
pub mod limits;
mod ollama;
mod openai;
pub mod search;
pub mod secrets;
pub mod transcribe;
pub mod web;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Ollama,
    Openai,
    Anthropic,
}

/// Where to send requests. The API key is looked up by `id` in the secrets store (never sent from
/// the webview).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub kind: ProviderKind,
    pub base_url: String,
}

impl Provider {
    /// Anthropic's endpoint configured as OpenAI-compatible (older settings) uses the native API:
    /// the compatibility layer has no prompt caching and drops thinking.
    pub fn effective_kind(&self) -> ProviderKind {
        if self.kind == ProviderKind::Openai && self.base_url.contains("api.anthropic.com") {
            ProviderKind::Anthropic
        } else {
            self.kind
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    /// Bytes on disk (Ollama), if known.
    pub size: Option<u64>,
    pub family: Option<String>,
    pub parameter_size: Option<String>,
    pub quantization: Option<String>,
    /// Cloud-hosted model reached through the provider (Ollama ":cloud" models).
    pub remote: bool,
    /// Dollars per million tokens, when the provider lists them (OpenRouter, D199).
    pub pricing: Option<ModelPricing>,
    /// It answers with images (OpenRouter's `architecture.output_modalities`, D381).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub output_images: bool,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelPricing {
    pub input: f64,
    pub output: f64,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
}

/// OpenRouter's `pricing` (dollars per token, as strings) → dollars per million tokens.
pub fn parse_pricing(v: Option<&serde_json::Value>) -> Option<ModelPricing> {
    let v = v?;
    let per_million = |k: &str| -> Option<f64> {
        let x = v.get(k)?;
        let n = x
            .as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .or_else(|| x.as_f64())?;
        (n >= 0.0).then(|| (n * 1_000_000.0 * 1_000_000.0).round() / 1_000_000.0)
    };
    Some(ModelPricing {
        input: per_million("prompt")?,
        output: per_million("completion")?,
        cache_read: per_million("input_cache_read"),
        cache_write: per_million("input_cache_write"),
    })
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelDetails {
    /// Native tool calling.
    pub tools: Option<bool>,
    pub thinking: Option<bool>,
    pub vision: Option<bool>,
    pub context_length: Option<u64>,
    /// Most output tokens per request (Anthropic `max_tokens`).
    pub max_output_tokens: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

/// One conversation message, provider-neutral.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// "system" | "user" | "assistant" | "tool"
    pub role: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    /// For role "tool": the call this answers, and the tool's name.
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    /// Base64 images (vision models).
    #[serde(default)]
    pub images: Vec<String>,
    /// Provider reasoning blocks to send back unchanged (Anthropic thinking with signatures).
    #[serde(default)]
    pub thinking_blocks: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub provider: Provider,
    pub model: String,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub tools: Vec<ToolSpec>,
    /// Ask reasoning models to think (Ollama `think`); None = model default.
    pub think: Option<bool>,
    pub temperature: Option<f64>,
    /// Context window to request (Ollama `num_ctx`).
    pub context_length: Option<u64>,
    /// Most tokens to generate (Ollama `num_predict`, OpenAI `max_tokens`): editor completions.
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// Prompt caching lifetime where the provider takes hints ("5m" | "1h"; Anthropic).
    #[serde(default)]
    pub cache_ttl: Option<String>,
    /// Reasoning effort ("low" | "medium" | "high" | "xhigh" | "max"; Anthropic).
    #[serde(default)]
    pub effort: Option<String>,
    /// How long Ollama keeps the model (and its prompt cache) loaded after the request.
    #[serde(default)]
    pub keep_alive: Option<String>,
    /// A one-off prompt: no cache breakpoints (writing to the cache costs extra).
    #[serde(default)]
    pub no_cache: bool,
    /// What the reply may hold (`["image", "text"]` for a model that draws, D381).
    #[serde(default)]
    pub modalities: Option<Vec<String>>,
}

/// What an images API is asked for (D381).
#[derive(Debug, Clone, Deserialize)]
pub struct ImageRequest {
    pub provider: Provider,
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub size: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatEvent {
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    /// An image in the reply (D381): base64 data and its media type, or a link (`url`) when the
    /// provider gave one instead of the bytes.
    Image {
        mime: String,
        data: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
    /// A finished reasoning block to keep with the assistant message and send back as is.
    Reasoning {
        block: Value,
    },
    #[serde(rename_all = "camelCase")]
    ToolCall {
        id: String,
        name: String,
        arguments: Value,
    },
    /// A tool call is being generated (its arguments stream in): which tool, the `path` argument
    /// once it has arrived, and how much has come so far. Lets the UI say "Writing index.html…"
    /// instead of "Thinking…" while a model writes a whole file (D119).
    #[serde(rename_all = "camelCase")]
    ToolProgress {
        name: String,
        path: Option<String>,
        chars: u64,
        /// The call's id, when the provider gave it (the finished call's row adopts the draft).
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        /// For tools drawn while they're written (show_widget, D355): the arguments so far, as
        /// partial JSON, at most every `STREAMED_EVERY`.
        #[serde(skip_serializing_if = "Option::is_none")]
        arguments: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Done {
        stop_reason: String,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        /// Prompt tokens read from / written to the provider's cache (included in input_tokens).
        cache_read_tokens: Option<u64>,
        cache_write_tokens: Option<u64>,
        /// What the provider says the request cost, in dollars (OpenRouter's `usage.cost`).
        #[serde(skip_serializing_if = "Option::is_none")]
        cost: Option<f64>,
    },
}

#[derive(Default)]
pub struct AiService {
    /// Request id → its cancel token and the window that started it (cancelled when that page
    /// reloads, D163).
    running: Mutex<HashMap<String, (CancellationToken, String)>>,
    client: std::sync::OnceLock<reqwest::Client>,
    /// The rate limits each provider (by id) last reported in its response headers (D201).
    limits: Mutex<HashMap<String, limits::RateLimits>>,
}

/// What one response said about its rate limits: the status and the buckets (empty: none).
pub(crate) type SeenLimits = Option<(u16, Vec<limits::LimitBucket>)>;

/// Keeps a response's rate-limit headers for `AiService::rate_limits`.
pub(crate) fn note_limits(seen: &mut SeenLimits, response: &reqwest::Response) {
    *seen = Some((response.status().as_u16(), limits::from_response(response)));
}

pub(crate) fn http_error(e: reqwest::Error) -> Error {
    if e.is_connect() {
        Error::Ai(format!("can't connect: {}", root_cause(&e)))
    } else if e.is_timeout() {
        Error::Ai("the request timed out".into())
    } else {
        Error::Ai(root_cause(&e))
    }
}

fn root_cause(e: &dyn std::error::Error) -> String {
    let mut msg = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        msg = s.to_string();
        source = s.source();
    }
    msg
}

/// A reply stream that ended before the provider said it was done (the connection dropped, a
/// proxy cut it): an error, not a reply that looks finished with half a tool call in it. "stream
/// ended" reads as transient to the agent (isTransientError), which retries when nothing came.
pub(crate) fn cut_off() -> Error {
    Error::Ai("the reply was cut off: the stream ended before the model finished".into())
}

/// How long a reply stream may send nothing at all before it's given up (D223). Providers send
/// keep-alives (Anthropic's `ping`, SSE comments) or tokens long before this, and a local model
/// loading counts from the headers on; a connection that went silent (a sleeping laptop's Wi-Fi,
/// a proxy holding it open) would otherwise wait forever with the turn spinning.
pub(crate) const STREAM_IDLE: Duration = Duration::from_secs(300);

/// The next chunk of a reply stream, or an error once it has been silent for `idle`. The error
/// reads as a timeout, which the agent retries when nothing came yet.
pub(crate) async fn next_chunk_within<S>(
    stream: &mut S,
    idle: Duration,
) -> Option<Result<bytes::Bytes>>
where
    S: futures_util::Stream<Item = reqwest::Result<bytes::Bytes>> + Unpin,
{
    use futures_util::StreamExt;
    match tokio::time::timeout(idle, stream.next()).await {
        Ok(Some(chunk)) => Some(chunk.map_err(http_error)),
        Ok(None) => None,
        Err(_) => Some(Err(Error::Ai(format!(
            "the reply timed out: nothing came from the model for {} seconds",
            idle.as_secs()
        )))),
    }
}

pub(crate) async fn next_chunk<S>(stream: &mut S) -> Option<Result<bytes::Bytes>>
where
    S: futures_util::Stream<Item = reqwest::Result<bytes::Bytes>> + Unpin,
{
    next_chunk_within(stream, STREAM_IDLE).await
}

/// An OpenAI-compatible API path under `base`. People paste the base with or without "/v1"; a
/// base that already names its version keeps it, with no "/v1" added (D212): Gemini's
/// `/v1beta/openai`, Z.ai's `/api/paas/v4`, Groq's `/openai/v1`.
pub(crate) fn openai_api(base: &str, path: &str) -> String {
    let b = base.trim_end_matches('/');
    if has_version_segment(b) {
        url(b, path)
    } else {
        url(&url(b, "v1"), path)
    }
}

/// Whether a path segment after the host is an API version ("v1", "v4", "v1beta").
fn has_version_segment(base: &str) -> bool {
    let rest = base.split_once("://").map_or(base, |(_, r)| r);
    rest.split('/').skip(1).any(|seg| {
        let mut chars = seg.chars();
        matches!(chars.next(), Some('v' | 'V'))
            && chars.next().is_some_and(|c| c.is_ascii_digit())
            && seg.chars().all(|c| c.is_ascii_alphanumeric())
    })
}

/// Joins `base` and `path` with exactly one slash.
pub(crate) fn url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

/// A non-success response's message: `{"error": "..."}` / `{"error": {"message": "..."}}`, else text.
pub(crate) async fn error_body(response: reqwest::Response) -> Error {
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let message = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| {
            v.get("error").and_then(|e| {
                e.as_str()
                    .map(str::to_string)
                    .or_else(|| e.get("message").and_then(Value::as_str).map(str::to_string))
            })
        })
        .unwrap_or_else(|| text.chars().take(300).collect());
    if message.contains("does not support tools") {
        return Error::AiNoTools(message);
    }
    Error::Ai(format!("{} ({})", message.trim(), status.as_u16()))
}

impl AiService {
    pub(crate) fn client(&self) -> reqwest::Client {
        self.client
            .get_or_init(|| {
                reqwest::Client::builder()
                    .connect_timeout(Duration::from_secs(10))
                    .build()
                    .unwrap_or_default()
            })
            .clone()
    }

    pub async fn list_models(
        &self,
        provider: &Provider,
        key: Option<String>,
    ) -> Result<Vec<ModelInfo>> {
        match provider.effective_kind() {
            ProviderKind::Ollama => ollama::list_models(&self.client(), &provider.base_url).await,
            ProviderKind::Openai => {
                openai::list_models(&self.client(), &provider.base_url, key).await
            }
            ProviderKind::Anthropic => {
                anthropic::list_models(&self.client(), &provider.base_url, key).await
            }
        }
    }

    pub async fn model_details(
        &self,
        provider: &Provider,
        model: &str,
        key: Option<String>,
    ) -> Result<ModelDetails> {
        match provider.effective_kind() {
            ProviderKind::Ollama => ollama::show(&self.client(), &provider.base_url, model).await,
            ProviderKind::Openai => Ok(ModelDetails::default()),
            ProviderKind::Anthropic => {
                anthropic::model(&self.client(), &provider.base_url, model, key).await
            }
        }
    }

    /// Streams one chat completion. Returns when the model is done, cancelled or failed.
    /// One image from an images API (OpenAI's, D381), cancellable by `request_id` like a chat.
    pub async fn generate_image(
        &self,
        request_id: &str,
        owner: &str,
        req: ImageRequest,
        key: Option<String>,
    ) -> Result<Vec<(String, String)>> {
        let token = CancellationToken::new();
        self.lock()?
            .insert(request_id.to_string(), (token.clone(), owner.to_string()));
        let client = self.client();
        let result = tokio::select! {
            r = openai::generate_image(
                &client,
                &req.provider.base_url,
                key,
                &req.model,
                &req.prompt,
                req.size.as_deref(),
            ) => r,
            _ = token.cancelled() => Err(Error::Cancelled),
        };
        self.lock()?.remove(request_id);
        result
    }

    pub async fn chat<F: FnMut(ChatEvent)>(
        &self,
        request_id: &str,
        owner: &str,
        request: ChatRequest,
        key: Option<String>,
        emit: F,
    ) -> Result<()> {
        let token = CancellationToken::new();
        self.lock()?
            .insert(request_id.to_string(), (token.clone(), owner.to_string()));
        let client = self.client();
        let mut seen: SeenLimits = None;
        let result = tokio::select! {
            r = async {
                match request.provider.effective_kind() {
                    ProviderKind::Ollama => ollama::chat(&client, &request, emit).await,
                    ProviderKind::Openai => {
                        openai::chat(&client, &request, key, emit, &mut seen).await
                    }
                    ProviderKind::Anthropic => {
                        anthropic::chat(&client, &request, key, emit, &mut seen).await
                    }
                }
            } => r,
            _ = token.cancelled() => Err(Error::Cancelled),
        };
        self.lock()?.remove(request_id);
        if let Some((status, buckets)) = seen.filter(|(_, b)| !b.is_empty()) {
            if let Ok(mut all) = self.limits.lock() {
                all.insert(
                    request.provider.id.clone(),
                    limits::RateLimits {
                        observed_at: limits::now_ms(),
                        buckets,
                        status,
                    },
                );
            }
        }
        result
    }

    /// One fill-in-the-middle completion (D204), cancellable by `request_id` like a chat.
    pub async fn fim(
        &self,
        request_id: &str,
        owner: &str,
        request: fim::FimRequest,
        key: Option<String>,
    ) -> Result<fim::FimReply> {
        let token = CancellationToken::new();
        self.lock()?
            .insert(request_id.to_string(), (token.clone(), owner.to_string()));
        let client = self.client();
        let result = tokio::select! {
            r = fim::complete(&client, &request, key) => r,
            _ = token.cancelled() => Err(Error::Cancelled),
        };
        self.lock()?.remove(request_id);
        result
    }

    /// The rate limits each provider (by id) last reported, this run (D201).
    pub fn rate_limits(&self) -> HashMap<String, limits::RateLimits> {
        self.limits.lock().map(|m| m.clone()).unwrap_or_default()
    }

    pub fn cancel(&self, request_id: &str) -> Result<()> {
        if let Some((token, _)) = self.lock()?.remove(request_id) {
            token.cancel();
        }
        Ok(())
    }

    /// Cancels every request window `owner` started (its page reloaded: nobody reads them, D163).
    pub fn cancel_owner(&self, owner: &str) {
        if let Ok(mut running) = self.running.lock() {
            running.retain(|_, (token, by)| {
                if by == owner {
                    token.cancel();
                }
                by != owner
            });
        }
    }

    #[allow(clippy::type_complexity)]
    fn lock(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, (CancellationToken, String)>>> {
        self.running
            .lock()
            .map_err(|_| Error::Invalid("ai lock poisoned".into()))
    }
}

/// Splits a byte stream into lines (NDJSON, SSE), keeping a partial line between chunks.
#[derive(Default)]
pub(crate) struct LineBuffer {
    pending: Vec<u8>,
}

impl LineBuffer {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(i) = self.pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=i).collect();
            let text = String::from_utf8_lossy(&line);
            lines.push(text.trim_end_matches(['\r', '\n']).to_string());
        }
        lines
    }

    pub fn finish(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        let rest = String::from_utf8_lossy(&self.pending).trim().to_string();
        self.pending.clear();
        (!rest.is_empty()).then_some(rest)
    }
}

#[cfg(test)]
mod tests;

const PATH_SEARCH_BYTES: usize = 4096;

/// Progress reports for one streaming tool call: at its start, when its `path` argument has
/// arrived, and every 2000 characters of arguments.
#[derive(Default, Debug)]
pub struct ToolStreamProgress {
    reported: usize,
    started: bool,
    path: Option<String>,
    /// When the arguments so far were last sent (tools in `STREAMED_TOOLS`).
    streamed_at: Option<std::time::Instant>,
}

/// Tools whose arguments go to the UI while they're written (D355): show_widget's code is drawn
/// as it arrives.
const STREAMED_TOOLS: &[&str] = &["show_widget"];
/// How often a streamed tool's arguments are sent (a repaint each time).
const STREAMED_EVERY: Duration = Duration::from_millis(150);

impl ToolStreamProgress {
    pub fn update(&mut self, id: &str, name: &str, arguments: &str) -> Option<ChatEvent> {
        self.update_at(id, name, arguments, std::time::Instant::now())
    }

    pub fn update_at(
        &mut self,
        id: &str,
        name: &str,
        arguments: &str,
        now: std::time::Instant,
    ) -> Option<ChatEvent> {
        if name.is_empty() {
            return None;
        }
        let streamed = STREAMED_TOOLS.contains(&name);
        if streamed && arguments.len() > self.reported {
            let due = self
                .streamed_at
                .is_none_or(|at| now.duration_since(at) >= STREAMED_EVERY);
            if due {
                self.started = true;
                self.streamed_at = Some(now);
                self.reported = arguments.len();
                return Some(ChatEvent::ToolProgress {
                    name: name.to_string(),
                    path: None,
                    chars: arguments.len() as u64,
                    id: (!id.is_empty()).then(|| id.to_string()),
                    arguments: Some(arguments.to_string()),
                });
            }
            return None;
        }
        let mut report = !self.started;
        self.started = true;
        // The path comes early in practice; only the start is searched (no rescans of a big
        // `content` on every delta).
        if self.path.is_none() && self.reported < PATH_SEARCH_BYTES {
            let mut end = arguments.len().min(PATH_SEARCH_BYTES);
            while !arguments.is_char_boundary(end) {
                end -= 1;
            }
            if let Some(path) = path_argument(&arguments[..end]) {
                self.path = Some(path);
                report = true;
            }
        }
        if arguments.len() >= self.reported + 2000 {
            report = true;
        }
        if !report {
            return None;
        }
        self.reported = arguments.len();
        Some(ChatEvent::ToolProgress {
            name: name.to_string(),
            path: self.path.clone(),
            chars: arguments.len() as u64,
            id: (!id.is_empty()).then(|| id.to_string()),
            arguments: None,
        })
    }
}

/// The value of a complete `"path": "…"` (or file_path / filename) in partial JSON.
fn path_argument(json: &str) -> Option<String> {
    for key in ["\"path\"", "\"file_path\"", "\"filePath\"", "\"filename\""] {
        let Some(at) = json.find(key) else { continue };
        let rest = json[at + key.len()..]
            .trim_start()
            .strip_prefix(':')?
            .trim_start();
        let body = rest.strip_prefix('"')?;
        let mut out = String::new();
        let mut chars = body.chars();
        while let Some(c) = chars.next() {
            match c {
                '"' => return Some(out),
                '\\' => match chars.next()? {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    other => out.push(other),
                },
                c => out.push(c),
            }
        }
        return None;
    }
    None
}
