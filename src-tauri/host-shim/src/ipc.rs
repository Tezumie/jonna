//! Channels, raw request bodies and raw replies, with the framework's names and shapes.

use std::marker::PhantomData;
use std::sync::Arc;

use serde::Serialize;

use crate::Result;

/// What a command was called with: JSON arguments or raw bytes.
#[derive(Debug, Clone)]
pub enum InvokeBody {
    Json(serde_json::Value),
    Raw(Vec<u8>),
}

/// What goes back to the client: JSON text or raw bytes.
#[derive(Debug, Clone)]
pub enum InvokeResponseBody {
    Json(String),
    Raw(Vec<u8>),
}

impl From<String> for InvokeResponseBody {
    fn from(text: String) -> Self {
        Self::Json(text)
    }
}

impl From<Vec<u8>> for InvokeResponseBody {
    fn from(bytes: Vec<u8>) -> Self {
        Self::Raw(bytes)
    }
}

/// A value that can be sent to the client: anything serializable (as JSON), or a body as it is.
pub trait IpcResponse {
    fn body(self) -> Result<InvokeResponseBody>;
}

impl<T: Serialize> IpcResponse for T {
    fn body(self) -> Result<InvokeResponseBody> {
        Ok(InvokeResponseBody::Json(serde_json::to_string(&self)?))
    }
}

impl IpcResponse for InvokeResponseBody {
    fn body(self) -> Result<InvokeResponseBody> {
        Ok(self)
    }
}

/// A command's reply that isn't serialized: bytes go to the client as they are.
#[derive(Debug)]
pub struct Response {
    body: InvokeResponseBody,
}

impl Response {
    pub fn new(body: impl Into<InvokeResponseBody>) -> Self {
        Self { body: body.into() }
    }
}

impl IpcResponse for Response {
    fn body(self) -> Result<InvokeResponseBody> {
        Ok(self.body)
    }
}

/// A command's raw request: its body and headers.
#[derive(Debug, Clone, Copy)]
pub struct Request<'a> {
    body: &'a InvokeBody,
    headers: &'a http::HeaderMap,
}

impl<'a> Request<'a> {
    pub fn new(body: &'a InvokeBody, headers: &'a http::HeaderMap) -> Self {
        Self { body, headers }
    }

    pub fn body(&self) -> &'a InvokeBody {
        self.body
    }

    pub fn headers(&self) -> &'a http::HeaderMap {
        self.headers
    }
}

type OnMessage = dyn Fn(InvokeResponseBody) -> Result<()> + Send + Sync;
type OnEnd = dyn Fn() + Send + Sync;

/// What every clone of a channel shares. Dropped with the last clone: nothing more will ever be
/// sent, which `on_end` reports.
struct Shared {
    on_message: Box<OnMessage>,
    on_end: Option<Box<OnEnd>>,
}

impl Drop for Shared {
    fn drop(&mut self) {
        if let Some(on_end) = &self.on_end {
            on_end();
        }
    }
}

/// A stream of messages from a command to the client, in send order. Cloning it gives another
/// handle to the same stream.
pub struct Channel<TSend = InvokeResponseBody> {
    id: u32,
    shared: Arc<Shared>,
    phantom: PhantomData<fn(TSend)>,
}

impl<TSend> Clone for Channel<TSend> {
    fn clone(&self) -> Self {
        Self {
            id: self.id,
            shared: self.shared.clone(),
            phantom: PhantomData,
        }
    }
}

impl<TSend> std::fmt::Debug for Channel<TSend> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Channel").field("id", &self.id).finish()
    }
}

impl<TSend> Channel<TSend> {
    /// A channel whose messages go to `on_message` (tests, and code that listens itself).
    pub fn new<F>(on_message: F) -> Self
    where
        F: Fn(InvokeResponseBody) -> Result<()> + Send + Sync + 'static,
    {
        Self {
            id: 0,
            shared: Arc::new(Shared {
                on_message: Box::new(on_message),
                on_end: None,
            }),
            phantom: PhantomData,
        }
    }

    /// A channel bound to the id the client chose. `on_end` runs once, when the last clone is
    /// dropped.
    pub fn bound<F, E>(id: u32, on_message: F, on_end: E) -> Self
    where
        F: Fn(InvokeResponseBody) -> Result<()> + Send + Sync + 'static,
        E: Fn() + Send + Sync + 'static,
    {
        Self {
            id,
            shared: Arc::new(Shared {
                on_message: Box::new(on_message),
                on_end: Some(Box::new(on_end)),
            }),
            phantom: PhantomData,
        }
    }

    pub fn id(&self) -> u32 {
        self.id
    }

    /// Sends one message. Fails once the client has closed the channel or is gone.
    pub fn send(&self, data: TSend) -> Result<()>
    where
        TSend: IpcResponse,
    {
        (self.shared.on_message)(data.body()?)
    }
}
