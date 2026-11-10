//! The standing GET stream of a remote MCP server (Streamable HTTP, D207): after initialize the
//! client opens `GET <url>` with `Accept: text/event-stream`, and the server sends its own
//! requests and notifications there (tools/list_changed, resources/updated, a sampling request)
//! while no POST is open. A server without one answers 405 and nothing more is tried. A stream
//! that ends or fails is opened again after a pause (1 s, doubling to a minute, or the server's
//! `retry:`), with `Last-Event-ID` so a server that keeps events can resend the missed ones;
//! stopping the server cancels it. Same rules as POST (remote.rs): https or local http, no
//! redirects, the server's own inputs only, the OAuth token refreshed once after a 401.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::remote::{check_url, client, SseParser};

/// What the page hears from a stream.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StreamEvent {
    /// A JSON-RPC message from the server.
    Message { text: String },
    /// "open", "retrying" (with the pause), "unsupported" (405) or "closed" (why).
    State {
        state: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
}

fn state(state: &str, detail: Option<String>) -> StreamEvent {
    StreamEvent::State {
        state: state.into(),
        detail,
    }
}

/// The pause before reconnect number `attempt` (0-based, counting streams that failed or ended
/// at once): 1 s doubling to 60 s. The server's `retry:` sets the first pause; after that the
/// pauses still grow, so a server that keeps closing the stream isn't asked again ten times a
/// second.
pub fn backoff(attempt: u32, retry_ms: Option<u64>) -> Duration {
    let grown = (1000u64 << attempt.min(6)).min(60_000);
    Duration::from_millis(match retry_ms.map(|ms| ms.clamp(100, 60_000)) {
        Some(ms) if attempt == 0 => ms,
        Some(ms) => ms.max(grown),
        None => grown,
    })
}

/// A stream that ends sooner than this counts as a failure (the pauses keep growing).
const SHORT_STREAM: Duration = Duration::from_secs(10);

/// Streams by id, so a stop (or the server's stop) can cancel one.
#[derive(Default)]
pub struct Streams {
    running: Mutex<HashMap<String, (u64, CancellationToken)>>,
    next: std::sync::atomic::AtomicU64,
}

impl Streams {
    /// A new stream under `id` (one there already is cancelled); its number for `ended`.
    pub fn add(&self, id: &str) -> (u64, CancellationToken) {
        let token = CancellationToken::new();
        let n = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if let Ok(mut map) = self.running.lock() {
            if let Some((_, old)) = map.insert(id.to_string(), (n, token.clone())) {
                old.cancel();
            }
        }
        (n, token)
    }

    /// Cancels every stream (the page that opened them reloaded: nothing reads them now).
    pub fn stop_all(&self) {
        if let Ok(mut map) = self.running.lock() {
            for (_, (_, token)) in map.drain() {
                token.cancel();
            }
        }
    }

    pub fn stop(&self, id: &str) -> bool {
        let entry = self.running.lock().ok().and_then(|mut m| m.remove(id));
        entry.map(|(_, t)| t.cancel()).is_some()
    }

    /// Forgets a stream that ended by itself (unless a newer one took its id).
    pub fn ended(&self, id: &str, n: u64) {
        if let Ok(mut map) = self.running.lock() {
            if map.get(id).is_some_and(|(m, _)| *m == n) {
                map.remove(id);
            }
        }
    }
}

pub struct ListenRequest {
    pub secrets: PathBuf,
    pub server: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub session_id: Option<String>,
}

/// Consecutive failures (no stream opened) before giving up.
const MAX_FAILURES: u32 = 20;

/// Keeps the GET stream open until `cancel`; every event goes to `emit`.
pub async fn listen(req: ListenRequest, cancel: CancellationToken, emit: impl Fn(StreamEvent)) {
    let url = match check_url(&req.url) {
        Ok(u) => u,
        Err(e) => return emit(state("closed", Some(e.to_string()))),
    };
    let configured = req
        .headers
        .keys()
        .any(|k| k.eq_ignore_ascii_case("authorization"));
    let mut last_id: Option<String> = None;
    let mut retry_ms: Option<u64> = None;
    let mut failures = 0u32;
    let mut refreshed = false;
    loop {
        if cancel.is_cancelled() {
            return;
        }
        let oauth = if configured {
            None
        } else {
            super::oauth::access_token(&client(), &req.secrets, &req.server, &req.url, refreshed)
                .await
        };
        let mut request = client()
            .get(url.clone())
            .header("Accept", "text/event-stream")
            .header("MCP-Protocol-Version", "2025-06-18");
        for (name, value) in &req.headers {
            match crate::ai::secrets::expand(&req.secrets, value, Some(&req.server)) {
                Ok(v) => request = request.header(name, v),
                Err(e) => return emit(state("closed", Some(e.to_string()))),
            }
        }
        if let Some(token) = &oauth {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        if let Some(id) = &req.session_id {
            request = request.header("Mcp-Session-Id", id);
        }
        if let Some(id) = &last_id {
            request = request.header("Last-Event-ID", id);
        }
        let sent = tokio::select! {
            _ = cancel.cancelled() => return,
            r = request.send() => r,
        };
        let mut opened = false;
        if let Ok(response) = sent {
            let status = response.status().as_u16();
            let kind = response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_ascii_lowercase();
            if status == 405
                || (response.status().is_success() && !kind.starts_with("text/event-stream"))
            {
                return emit(state("unsupported", None));
            }
            if status == 404 && req.session_id.is_some() {
                return emit(state("closed", Some("the server ended the session".into())));
            }
            if status == 401 && !configured && !refreshed && oauth.is_some() {
                refreshed = true;
                continue;
            }
            if status == 401 || status == 403 {
                return emit(state("closed", Some(format!("refused ({status})"))));
            }
            if response.status().is_success() {
                let opened_at = tokio::time::Instant::now();
                refreshed = false;
                emit(state("open", None));
                let mut parser = SseParser::default();
                let mut body = response.bytes_stream();
                loop {
                    let chunk = tokio::select! {
                        _ = cancel.cancelled() => return,
                        c = body.next() => c,
                    };
                    let Some(Ok(chunk)) = chunk else { break };
                    for data in parser.feed(&chunk) {
                        emit(StreamEvent::Message { text: data });
                    }
                    if parser.last_id.is_some() {
                        last_id.clone_from(&parser.last_id);
                    }
                    if parser.retry_ms.is_some() {
                        retry_ms = parser.retry_ms;
                    }
                }
                // Only a stream that stayed open a while resets the pauses.
                if opened_at.elapsed() >= SHORT_STREAM {
                    opened = true;
                    failures = 0;
                }
            }
        }
        if !opened {
            failures += 1;
            if failures >= MAX_FAILURES {
                return emit(state("closed", Some("the server stopped answering".into())));
            }
        }
        let pause = backoff(failures.saturating_sub(1), retry_ms);
        emit(state("retrying", Some(format!("{} ms", pause.as_millis()))));
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(pause) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn reconnects_slow_down_to_a_minute() {
        assert_eq!(backoff(0, None), Duration::from_secs(1));
        assert_eq!(backoff(1, None), Duration::from_secs(2));
        assert_eq!(backoff(5, None), Duration::from_secs(32));
        assert_eq!(backoff(9, None), Duration::from_secs(60));
        assert_eq!(backoff(0, Some(2500)), Duration::from_millis(2500));
        assert_eq!(backoff(0, Some(5)), Duration::from_millis(100));
        // Streams that keep ending at once slow down even with a short `retry:`.
        assert_eq!(backoff(3, Some(100)), Duration::from_secs(8));
        assert_eq!(backoff(1, Some(5000)), Duration::from_secs(5));
    }

    /// A server whose first GET sends one event and ends, and whose second stays open after a
    /// second event; it notes each request's Last-Event-ID.
    async fn serve(answer_405: bool) -> (u16, Arc<Mutex<Vec<String>>>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            let mut n = 0;
            while let Ok((mut s, _)) = listener.accept().await {
                n += 1;
                let mut buf = vec![0u8; 4096];
                let len = s.read(&mut buf).await.unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..len]).to_ascii_lowercase();
                let last = head
                    .lines()
                    .find_map(|l| {
                        l.strip_prefix("last-event-id:")
                            .map(|v| v.trim().to_string())
                    })
                    .unwrap_or_default();
                log.lock().unwrap().push(last);
                if answer_405 {
                    let _ = s
                        .write_all(b"HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 0\r\n\r\n")
                        .await;
                    continue;
                }
                let event = format!("id: e{n}\nretry: 100\ndata: {{\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\",\"n\":{n}}}\n\n");
                let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n";
                let _ = s.write_all(format!("{head}{event}").as_bytes()).await;
                if n == 1 {
                    let _ = s.shutdown().await;
                } else {
                    // Held open: the client stops.
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        drop(s);
                    });
                }
            }
        });
        (port, seen)
    }

    fn request(port: u16) -> ListenRequest {
        ListenRequest {
            secrets: std::env::temp_dir()
                .join(format!("ide-stream-{}-none.json", std::process::id())),
            server: "s".into(),
            url: format!("http://127.0.0.1:{port}/mcp"),
            headers: HashMap::new(),
            session_id: Some("sess".into()),
        }
    }

    #[tokio::test]
    async fn the_stream_reconnects_with_the_last_event_id_and_stops_when_cancelled() {
        let (port, seen) = serve(false).await;
        let events = Arc::new(Mutex::new(Vec::new()));
        let got = events.clone();
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let task = tokio::spawn(async move {
            listen(request(port), stop, move |e| got.lock().unwrap().push(e)).await;
        });
        for _ in 0..100 {
            let messages = events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| matches!(e, StreamEvent::Message { .. }))
                .count();
            if messages >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        cancel.cancel();
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        let events = events.lock().unwrap().clone();
        let texts: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::Message { text } => Some(text.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(texts.len(), 2, "{events:?}");
        assert!(texts[1].contains("\"n\":2"));
        assert!(events.contains(&state("open", None)));
        assert!(events.contains(&state("retrying", Some("100 ms".into()))));
        assert_eq!(seen.lock().unwrap().as_slice(), ["", "e1"]);
    }

    #[tokio::test]
    async fn a_server_without_a_stream_is_left_alone() {
        let (port, seen) = serve(true).await;
        let events = Arc::new(Mutex::new(Vec::new()));
        let got = events.clone();
        listen(request(port), CancellationToken::new(), move |e| {
            got.lock().unwrap().push(e)
        })
        .await;
        assert_eq!(
            events.lock().unwrap().as_slice(),
            [state("unsupported", None)]
        );
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_stopped_stream_is_cancelled() {
        let streams = Streams::default();
        let (_, a) = streams.add("x");
        let (n, b) = streams.add("x");
        assert!(a.is_cancelled() && !b.is_cancelled());
        streams.ended("x", n + 1);
        assert!(streams.stop("x"));
        assert!(b.is_cancelled());
        assert!(!streams.stop("x"));
        let (n, _) = streams.add("y");
        streams.ended("y", n);
        assert!(!streams.stop("y"));
        let (_, c) = streams.add("z");
        streams.stop_all();
        assert!(c.is_cancelled() && !streams.stop("z"));
    }
}
