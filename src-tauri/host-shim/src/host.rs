//! Calling a command without the desktop framework: one [`Invocation`] in, one [`Reply`] out.
//!
//! The `#[command]` attribute writes an adapter per command that takes each parameter through
//! [`CommandArg`] and turns the return value into a [`Reply`]; `generate_handler!` collects the
//! adapters in a table of [`CommandEntry`]. The host's server looks a command up by name there.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::ipc::{Channel, InvokeBody, InvokeResponseBody, IpcResponse, Request};
use crate::{AppHandle, Manager, Result, State, Webview, WebviewWindow, Window};

/// The client's side of channels: where a command's channel messages go.
pub trait ChannelSink: Send + Sync {
    /// Sends one message on the client's channel `id`. Fails when the client closed that channel
    /// or is gone.
    fn send(&self, id: u32, body: InvokeResponseBody) -> Result<()>;

    /// Every handle to channel `id` is dropped: nothing more will be sent on it.
    fn end(&self, id: u32);
}

/// One call of a command.
pub struct Invocation {
    pub app: AppHandle,
    /// The name of the client that sent it (where the desktop has a window's label).
    pub client: Arc<str>,
    /// The arguments: a JSON object keyed by argument name. `Null` for a raw call.
    pub params: serde_json::Value,
    /// The raw body of a raw call, else the arguments again.
    pub body: InvokeBody,
    /// A raw call's headers (names lower-case).
    pub headers: http::HeaderMap,
    pub channels: Arc<dyn ChannelSink>,
    /// Where the client's sync commands run, one after another.
    pub ordered: SyncQueue,
}

/// What a command answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    /// The result, as JSON text.
    Json(String),
    /// The result, as bytes.
    Raw(Vec<u8>),
    /// The error, as JSON text (the app's error type gives `{"code", "message"}`).
    Error(String),
}

impl Reply {
    /// An error in the app's own shape.
    pub fn error(code: &str, message: &str) -> Self {
        Reply::Error(serde_json::json!({ "code": code, "message": message }).to_string())
    }

    /// Arguments that don't fit the command.
    pub fn invalid(message: &str) -> Self {
        Self::error("Invalid", message)
    }
}

pub type CommandFuture = Pin<Box<dyn Future<Output = Reply> + Send>>;

/// A command by name.
#[derive(Clone, Copy)]
pub struct CommandEntry {
    pub name: &'static str,
    pub run: fn(Invocation) -> CommandFuture,
}

/// A command's parameter, taken from the invocation: by type for what the host provides (state,
/// a channel, the handle, the raw request, the client), else deserialized from the arguments.
pub trait CommandArg<'a>: Sized {
    fn from_invocation(
        invocation: &'a Invocation,
        key: &'static str,
    ) -> std::result::Result<Self, Reply>;
}

/// A plain argument: `params[key]`. A missing key reads as `null`, so an `Option` is `None`;
/// unknown keys are ignored.
impl<'a, D: DeserializeOwned> CommandArg<'a> for D {
    fn from_invocation(
        invocation: &'a Invocation,
        key: &'static str,
    ) -> std::result::Result<Self, Reply> {
        let value = invocation
            .params
            .get(key)
            .unwrap_or(&serde_json::Value::Null);
        D::deserialize(value).map_err(|e| Reply::invalid(&format!("invalid argument `{key}`: {e}")))
    }
}

impl<'a, T: Send + Sync + 'static> CommandArg<'a> for State<'a, T> {
    fn from_invocation(
        invocation: &'a Invocation,
        _key: &'static str,
    ) -> std::result::Result<Self, Reply> {
        invocation.app.try_state::<T>().ok_or_else(|| {
            Reply::error(
                "Unknown",
                &format!("state not managed: {}", std::any::type_name::<T>()),
            )
        })
    }
}

/// A channel argument: `{"__channel": <id>}`, the id the client chose.
impl<'a, TSend> CommandArg<'a> for Channel<TSend> {
    fn from_invocation(
        invocation: &'a Invocation,
        key: &'static str,
    ) -> std::result::Result<Self, Reply> {
        let id = invocation
            .params
            .get(key)
            .and_then(|value| value.get("__channel"))
            .and_then(serde_json::Value::as_u64)
            .and_then(|id| u32::try_from(id).ok())
            .filter(|id| *id > 0)
            .ok_or_else(|| {
                Reply::invalid(&format!(
                    "invalid argument `{key}`: expected a channel ({{\"__channel\": id}})"
                ))
            })?;
        let sink = invocation.channels.clone();
        let ended = invocation.channels.clone();
        Ok(Channel::bound(
            id,
            move |body| sink.send(id, body),
            move || ended.end(id),
        ))
    }
}

impl<'a> CommandArg<'a> for AppHandle {
    fn from_invocation(
        invocation: &'a Invocation,
        _key: &'static str,
    ) -> std::result::Result<Self, Reply> {
        Ok(invocation.app.clone())
    }
}

impl<'a> CommandArg<'a> for Request<'a> {
    fn from_invocation(
        invocation: &'a Invocation,
        _key: &'static str,
    ) -> std::result::Result<Self, Reply> {
        Ok(Request::new(&invocation.body, &invocation.headers))
    }
}

impl<'a> CommandArg<'a> for Webview {
    fn from_invocation(
        invocation: &'a Invocation,
        _key: &'static str,
    ) -> std::result::Result<Self, Reply> {
        Ok(Webview::new(invocation.app.clone(), &invocation.client))
    }
}

impl<'a> CommandArg<'a> for Window {
    fn from_invocation(
        invocation: &'a Invocation,
        _key: &'static str,
    ) -> std::result::Result<Self, Reply> {
        Ok(Window::new(invocation.app.clone(), &invocation.client))
    }
}

impl<'a> CommandArg<'a> for WebviewWindow {
    fn from_invocation(
        invocation: &'a Invocation,
        _key: &'static str,
    ) -> std::result::Result<Self, Reply> {
        Ok(WebviewWindow::new(
            invocation.app.clone(),
            &invocation.client,
        ))
    }
}

/// The reply for a command that returns a plain value.
pub fn reply_value<T: IpcResponse>(value: T) -> Reply {
    match value.body() {
        Ok(InvokeResponseBody::Json(text)) => Reply::Json(text),
        Ok(InvokeResponseBody::Raw(bytes)) => Reply::Raw(bytes),
        Err(e) => Reply::error("Unknown", &format!("the result can't be sent: {e}")),
    }
}

/// The reply for a command that returns a `Result`: the value, or the error serialized as the
/// desktop framework serializes it.
pub fn reply_result<T: IpcResponse, E: Serialize>(result: std::result::Result<T, E>) -> Reply {
    match result {
        Ok(value) => reply_value(value),
        Err(error) => match serde_json::to_string(&error) {
            Ok(text) => Reply::Error(text),
            Err(e) => Reply::error("Unknown", &format!("the error can't be sent: {e}")),
        },
    }
}

/// The reply when a command panicked: the host answers and keeps running.
pub fn reply_panic(what: &str) -> Reply {
    Reply::error(
        "Unknown",
        &format!("the command failed unexpectedly: {what}"),
    )
}

/// A client's sync commands: run one at a time on one thread, in the order they were called.
/// The desktop framework runs sync commands so (one after another, in the order they were
/// sent), and commands are written for it: a terminal's write is a sync command so that
/// keystrokes can't overtake each other.
#[derive(Clone)]
pub struct SyncQueue {
    jobs: std::sync::mpsc::Sender<Box<dyn FnOnce() + Send>>,
}

impl SyncQueue {
    /// A queue with its thread, which ends once every handle to the queue is dropped and what
    /// was queued has run.
    pub fn new() -> std::io::Result<Self> {
        let (jobs, queued) = std::sync::mpsc::channel::<Box<dyn FnOnce() + Send>>();
        std::thread::Builder::new()
            .name("host-sync-commands".into())
            .spawn(move || {
                for job in queued {
                    job();
                }
            })?;
        Ok(Self { jobs })
    }
}

/// What a panic said, when it said it in words.
fn panic_text(payload: &(dyn std::any::Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("a panic")
}

/// A sync command: queued on `queue` by this call itself (not when the answer is first
/// awaited), so commands run in the order their adapters were called.
pub fn run_ordered<F>(queue: &SyncQueue, command: F) -> CommandFuture
where
    F: FnOnce() -> Reply + Send + 'static,
{
    let (answer, answered) = tokio::sync::oneshot::channel();
    let queued = queue
        .jobs
        .send(Box::new(move || {
            let reply = std::panic::catch_unwind(std::panic::AssertUnwindSafe(command))
                .unwrap_or_else(|payload| reply_panic(panic_text(payload.as_ref())));
            let _ = answer.send(reply);
        }))
        .is_ok();
    Box::pin(async move {
        match answered.await {
            Ok(reply) if queued => reply,
            _ => reply_panic("the sync commands' thread is gone"),
        }
    })
}

/// A sync command marked to run off the caller's thread (the attribute's `async` option): on a
/// blocking thread of its own, in no order, as the desktop framework runs those.
pub fn run_blocking<F>(command: F) -> CommandFuture
where
    F: FnOnce() -> Reply + Send + 'static,
{
    Box::pin(async move {
        match tokio::task::spawn_blocking(command).await {
            Ok(reply) => reply,
            Err(e) => reply_panic(&e.to_string()),
        }
    })
}
