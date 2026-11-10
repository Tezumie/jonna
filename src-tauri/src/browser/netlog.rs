//! The preview proxy's network log (the DevTools Network panel and `browser.network`): every
//! request the previewed page makes passes through the proxy, so each one is recorded with its
//! headers, status, size, timing and (up to 2 MB each, 64 MB in all) its bodies. A summary goes to
//! the IDE over the browser Channel (`BrowserEvent::Network`) when the response starts and when
//! it ends; bodies are fetched on demand.

use std::collections::VecDeque;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::task::{Context, Poll};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use hyper::body::{Body, Frame, Incoming, SizeHint};
use serde::Serialize;
use tauri::ipc::Channel;

const MAX_ENTRIES: usize = 3000;
pub const BODY_CAP: usize = 2 * 1024 * 1024;
const BODY_BUDGET: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetEvent {
    pub id: u64,
    /// The proxy's origin ("http://127.0.0.1:53211"): which preview made the request.
    pub origin: String,
    pub method: String,
    /// Path and query as the page asked for it.
    pub url: String,
    pub status: u16,
    pub mime: String,
    /// Response body bytes (so far, for "response"; total for "done").
    pub size: u64,
    pub start_ms: f64,
    /// Time to response headers, then to the end of the body.
    pub ttfb_ms: f64,
    pub duration_ms: f64,
    pub req_headers: Vec<(String, String)>,
    pub res_headers: Vec<(String, String)>,
    pub error: Option<String>,
    /// "response" (headers in) or "done" (body finished or failed).
    pub phase: &'static str,
    /// "http" or "websocket".
    pub protocol: &'static str,
    /// The stored body is cut short (over 2 MB).
    pub truncated: bool,
    pub has_request_body: bool,
}

/// Everything the browser service streams to the IDE (one Channel, `browser_subscribe`).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BrowserEvent {
    Network(NetEvent),
    /// A report from the bridge in an external window (page data, untrusted).
    Bridge {
        label: String,
        message: serde_json::Value,
    },
    WindowClosed {
        label: String,
    },
    /// A download started, moved on or ended (`downloads.rs`).
    Download(super::downloads::Download),
}

struct Record {
    event: NetEvent,
    req_body: Option<Bytes>,
    res_body: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct NetLog {
    records: Mutex<VecDeque<Record>>,
    next: AtomicU64,
    sink: Mutex<Option<Channel<BrowserEvent>>>,
    /// "Disable cache": conditional request headers are dropped, responses say no-store.
    pub no_cache: AtomicBool,
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

pub fn header_list(headers: &hyper::HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .map(|(k, v)| {
            (
                k.as_str().to_string(),
                String::from_utf8_lossy(v.as_bytes()).into_owned(),
            )
        })
        .collect()
}

/// A request in flight: created when it arrives, completed by `NetLog::finish`.
pub struct Pending {
    pub event: NetEvent,
    started: Instant,
    pub req_body: Option<Bytes>,
    /// A request body still streaming to the server (`stream::RequestTap`): what it kept is
    /// read when the exchange is over.
    pub req_tap: Option<std::sync::Arc<Mutex<super::stream::Kept>>>,
}

impl Pending {
    pub fn elapsed_ms(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }
}

impl NetLog {
    /// The IDE's subscription (a newer one replaces it).
    pub fn subscribe(&self, channel: Channel<BrowserEvent>) {
        if let Ok(mut sink) = self.sink.lock() {
            *sink = Some(channel);
        }
    }

    pub fn send(&self, event: BrowserEvent) {
        if let Ok(sink) = self.sink.lock() {
            if let Some(channel) = sink.as_ref() {
                let _ = channel.send(event);
            }
        }
    }

    pub fn begin(
        &self,
        origin: &str,
        method: &str,
        url: &str,
        req_headers: Vec<(String, String)>,
    ) -> Pending {
        Pending {
            event: NetEvent {
                id: self.next.fetch_add(1, Ordering::Relaxed) + 1,
                origin: origin.to_string(),
                method: method.to_string(),
                url: url.to_string(),
                status: 0,
                mime: String::new(),
                size: 0,
                start_ms: now_ms(),
                ttfb_ms: 0.0,
                duration_ms: 0.0,
                req_headers,
                res_headers: Vec::new(),
                error: None,
                phase: "response",
                protocol: "http",
                truncated: false,
                has_request_body: false,
            },
            started: Instant::now(),
            req_body: None,
            req_tap: None,
        }
    }

    /// Response headers are in.
    pub fn respond(&self, pending: &mut Pending, status: u16, headers: &hyper::HeaderMap) {
        pending.event.status = status;
        pending.event.res_headers = header_list(headers);
        pending.event.mime = headers
            .get(hyper::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.split(';').next().unwrap_or("").trim().to_string())
            .unwrap_or_default();
        pending.event.ttfb_ms = pending.elapsed_ms();
        pending.event.phase = "response";
        self.emit(&pending.event);
    }

    /// The exchange is over: stores it and tells the IDE.
    pub fn finish(
        &self,
        mut pending: Pending,
        body: Option<Vec<u8>>,
        size: u64,
        error: Option<String>,
    ) {
        pending.event.size = size;
        pending.event.duration_ms = pending.elapsed_ms();
        pending.event.error = error;
        pending.event.phase = "done";
        if let Some(kept) = pending.req_tap.take() {
            if let Ok(mut kept) = kept.lock() {
                pending.req_body = Some(Bytes::from(std::mem::take(&mut kept.bytes)));
            }
        }
        pending.event.has_request_body = pending.req_body.as_ref().is_some_and(|b| !b.is_empty());
        let body = body.map(|mut b| {
            if b.len() > BODY_CAP {
                b.truncate(BODY_CAP);
                // Truncating keeps the allocation: a 500 MB video kept 500 MB per record.
                b.shrink_to_fit();
                pending.event.truncated = true;
            }
            b
        });
        self.emit(&pending.event);
        let Ok(mut records) = self.records.lock() else {
            return;
        };
        records.push_back(Record {
            event: pending.event,
            req_body: pending.req_body,
            res_body: body,
        });
        while records.len() > MAX_ENTRIES {
            records.pop_front();
        }
        // Over budget: forget the oldest bodies first.
        let mut total: usize = records
            .iter()
            .map(|r| {
                r.res_body.as_ref().map_or(0, Vec::len) + r.req_body.as_ref().map_or(0, Bytes::len)
            })
            .sum();
        for r in records.iter_mut() {
            if total <= BODY_BUDGET {
                break;
            }
            total -= r.res_body.take().map_or(0, |b| b.len());
            total -= r.req_body.take().map_or(0, |b| b.len());
        }
    }

    fn emit(&self, event: &NetEvent) {
        self.send(BrowserEvent::Network(event.clone()));
    }

    /// A stored body: "request" or "response".
    pub fn body(&self, id: u64, which: &str) -> Option<Vec<u8>> {
        let records = self.records.lock().ok()?;
        let r = records.iter().find(|r| r.event.id == id)?;
        match which {
            "request" => r.req_body.as_ref().map(|b| b.to_vec()),
            _ => r.res_body.clone(),
        }
    }
}

type Done = Box<dyn FnOnce(Option<Vec<u8>>, u64, Option<String>) + Send + Sync>;

/// A response body passed through to the page while it's counted and copied (up to the cap).
pub struct Tap {
    inner: Incoming,
    buf: Vec<u8>,
    size: u64,
    done: Option<Done>,
}

impl Tap {
    pub fn new(inner: Incoming, done: Done) -> Self {
        Self {
            inner,
            buf: Vec::new(),
            size: 0,
            done: Some(done),
        }
    }

    fn end(&mut self, error: Option<String>) {
        if let Some(done) = self.done.take() {
            done(Some(std::mem::take(&mut self.buf)), self.size, error);
        }
    }
}

impl Body for Tap {
    type Data = Bytes;
    type Error = hyper::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, hyper::Error>>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    this.size += data.len() as u64;
                    if this.buf.len() < BODY_CAP + 1 {
                        let room = BODY_CAP + 1 - this.buf.len();
                        this.buf.extend_from_slice(&data[..data.len().min(room)]);
                    }
                }
                Poll::Ready(Some(Ok(frame)))
            }
            Poll::Ready(Some(Err(e))) => {
                this.end(Some(e.to_string()));
                Poll::Ready(Some(Err(e)))
            }
            Poll::Ready(None) => {
                this.end(None);
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

impl Drop for Tap {
    fn drop(&mut self) {
        let finished = self.inner.is_end_stream();
        self.end(if finished {
            None
        } else {
            Some("cancelled".into())
        });
    }
}
