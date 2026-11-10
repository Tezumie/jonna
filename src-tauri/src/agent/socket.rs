//! The agent's WebSocket monitors (D328, Claude Code's Monitor with `ws`): a client socket whose
//! incoming frames are events. `ws://` and `wss://` to any host the user approved (the monitor
//! tool asks first, like a command); the webview's CSP stays closed to sockets. The handshake
//! goes through reqwest (HTTP/1.1 upgrade, its TLS for `wss://`), the frames through the
//! in-house framing (`crate::mcp::ide_ws` reads, `crate::debug` writes masked client frames).
//! Text frames arrive whole (fragments joined); binary frames as their size; pings answered;
//! the close code goes out last. Each socket has a lifetime: the monitor's timeout, so a page
//! that reloaded can't leave one open.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;

use crate::error::{Error, Result};

/// One text message larger than this closes the socket (a runaway server).
const MAX_MESSAGE: usize = 4 * 1024 * 1024;
/// The longest a socket stays open (the monitor's own timeout is shorter).
const MAX_LIFETIME_MS: u64 = 2 * 3600 * 1000;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SocketEvent {
    /// A text frame (fragments joined): one event.
    Text { text: String },
    /// A binary frame: only its size.
    Binary { bytes: usize },
    /// Something went wrong; `Closed` follows.
    Error { message: String },
    /// The end: the server's close code and reason (none when the connection just dropped).
    Closed { code: Option<u16>, reason: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    /// The subprotocol the server picked (`Sec-WebSocket-Protocol`).
    pub protocol: Option<String>,
}

#[derive(Default)]
pub struct MonitorSockets {
    open: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Outgoing>>>>,
}

enum Outgoing {
    Pong(Vec<u8>),
    Close,
}

/// `ws://…` → `http://…`, `wss://…` → `https://…` (what reqwest connects to).
pub fn http_url(url: &str) -> Result<String> {
    let url = url.trim();
    let (scheme, rest) = if let Some(rest) = url.strip_prefix("ws://") {
        ("http://", rest)
    } else if let Some(rest) = url.strip_prefix("wss://") {
        ("https://", rest)
    } else {
        return Err(Error::Invalid(format!(
            "not a ws:// or wss:// address: {url}"
        )));
    };
    if rest.is_empty() || rest.starts_with('/') || rest.chars().any(char::is_whitespace) {
        return Err(Error::Invalid(format!("not a WebSocket address: {url}")));
    }
    Ok(format!("{scheme}{rest}"))
}

/// Subprotocol names are HTTP tokens; anything else would break the request's header.
pub fn valid_protocol(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 128
        && p.chars()
            .all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c))
}

/// The close frame's payload: its code (when there is one) and reason.
pub fn close_payload(payload: &[u8]) -> (Option<u16>, String) {
    if payload.len() < 2 {
        return (None, String::new());
    }
    let code = u16::from_be_bytes([payload[0], payload[1]]);
    (
        Some(code),
        String::from_utf8_lossy(&payload[2..]).trim().to_string(),
    )
}

fn random<const N: usize>() -> Result<[u8; N]> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).map_err(|e| Error::Invalid(format!("no randomness: {e}")))?;
    Ok(b)
}

/// The opening handshake: an HTTP/1.1 upgrade to `url`, checked. The subprotocol the server
/// picked and the connection, now carrying frames.
pub async fn handshake(
    url: &str,
    protocols: &[String],
) -> Result<(Option<String>, reqwest::Upgraded)> {
    let target = http_url(url)?;
    if let Some(bad) = protocols.iter().find(|p| !valid_protocol(p)) {
        return Err(Error::Invalid(format!("not a subprotocol name: {bad}")));
    }
    let key = crate::mcp::ide_ws::base64(&random::<16>()?);
    let client = reqwest::Client::builder()
        .http1_only()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| Error::Invalid(format!("couldn't make a client: {e}")))?;
    let mut request = client
        .get(&target)
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", &key);
    if !protocols.is_empty() {
        request = request.header("Sec-WebSocket-Protocol", protocols.join(", "));
    }
    let response = tokio::time::timeout(Duration::from_secs(15), request.send())
        .await
        .map_err(|_| Error::Invalid(format!("{url} didn't answer")))?
        .map_err(|e| Error::Invalid(format!("couldn't connect to {url}: {e}")))?;
    let status = response.status();
    if status.as_u16() != 101 {
        return Err(Error::Invalid(format!(
            "{url} answered {status} instead of opening a WebSocket"
        )));
    }
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    if header("sec-websocket-accept").as_deref()
        != Some(crate::mcp::ide_ws::accept_key(&key).as_str())
    {
        return Err(Error::Invalid(format!(
            "{url} answered with a wrong WebSocket handshake"
        )));
    }
    let protocol = header("sec-websocket-protocol");
    let upgraded = response
        .upgrade()
        .await
        .map_err(|e| Error::Invalid(format!("the WebSocket to {url} failed: {e}")))?;
    Ok((protocol, upgraded))
}

impl MonitorSockets {
    /// Opens socket `id` (replacing one with that id) and streams its frames to `on_event`.
    /// Resolves once the server accepted the upgrade.
    pub async fn open(
        &self,
        id: &str,
        url: &str,
        protocols: &[String],
        lifetime_ms: u64,
        on_event: Channel<SocketEvent>,
    ) -> Result<Opened> {
        self.close(id);
        let (protocol, upgraded) = handshake(url, protocols).await?;
        let (mut reader, mut writer) = tokio::io::split(upgraded);

        let (tx, mut rx) = mpsc::unbounded_channel::<Outgoing>();
        self.lock()?.insert(id.to_string(), tx.clone());

        // Writer: pongs and the close frame (a monitor only listens).
        tauri::async_runtime::spawn(async move {
            while let Some(out) = rx.recv().await {
                let Ok(mask) = random::<4>() else { break };
                let (frame, last) = match out {
                    Outgoing::Pong(p) => (crate::debug::encode_frame(0xA, &p, mask), false),
                    // 1000: a normal close.
                    Outgoing::Close => (
                        crate::debug::encode_frame(0x8, &1000u16.to_be_bytes(), mask),
                        true,
                    ),
                };
                if writer.write_all(&frame).await.is_err() || last {
                    break;
                }
            }
            let _ = writer.shutdown().await;
        });

        // Reader: one event per message; ends with one Closed event.
        let open = self.open.clone();
        let own = tx;
        let id = id.to_string();
        let lifetime = Duration::from_millis(lifetime_ms.clamp(1000, MAX_LIFETIME_MS));
        tauri::async_runtime::spawn(async move {
            let reading = async {
                let mut message: Vec<u8> = Vec::new();
                let mut binary = false;
                loop {
                    let (fin, opcode, payload) =
                        match crate::mcp::ide_ws::read_frame(&mut reader).await {
                            Ok(f) => f,
                            Err(e) => {
                                let gone = matches!(&e, Error::Io(io)
                                    if io.kind() == std::io::ErrorKind::UnexpectedEof);
                                if !gone {
                                    let _ = on_event.send(SocketEvent::Error {
                                        message: e.to_string(),
                                    });
                                }
                                return (None, "the connection was lost".to_string());
                            }
                        };
                    match opcode {
                        0x0..=0x2 => {
                            if opcode != 0x0 {
                                binary = opcode == 0x2;
                                message.clear();
                            }
                            message.extend_from_slice(&payload);
                            if message.len() > MAX_MESSAGE {
                                let _ = on_event.send(SocketEvent::Error {
                                    message: "a message was too large".into(),
                                });
                                return (None, "closed by the IDE".to_string());
                            }
                            if fin {
                                let event = if binary {
                                    SocketEvent::Binary {
                                        bytes: message.len(),
                                    }
                                } else {
                                    SocketEvent::Text {
                                        text: String::from_utf8_lossy(&message).into_owned(),
                                    }
                                };
                                message.clear();
                                if on_event.send(event).is_err() {
                                    // Nobody listens any more (the page reloaded).
                                    return (None, "closed by the IDE".to_string());
                                }
                            }
                        }
                        0x8 => return close_payload(&payload),
                        0x9 => {
                            let _ = own.send(Outgoing::Pong(payload));
                        }
                        _ => {}
                    }
                }
            };
            let (code, reason) = match tokio::time::timeout(lifetime, reading).await {
                Ok(end) => end,
                Err(_) => (None, "closed by the IDE (its time was up)".to_string()),
            };
            let _ = own.send(Outgoing::Close);
            if let Ok(mut map) = open.lock() {
                if map.get(&id).is_some_and(|tx| tx.same_channel(&own)) {
                    map.remove(&id);
                }
            }
            let _ = on_event.send(SocketEvent::Closed { code, reason });
        });
        Ok(Opened { protocol })
    }

    /// Closes socket `id` (a normal close); its Closed event still goes out.
    pub fn close(&self, id: &str) {
        if let Ok(mut map) = self.open.lock() {
            if let Some(tx) = map.remove(id) {
                let _ = tx.send(Outgoing::Close);
            }
        }
    }

    fn lock(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, mpsc::UnboundedSender<Outgoing>>>> {
        self.open
            .lock()
            .map_err(|_| Error::Invalid("socket table unavailable".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses() {
        assert_eq!(
            http_url("ws://127.0.0.1:8080/events").unwrap(),
            "http://127.0.0.1:8080/events"
        );
        assert_eq!(
            http_url(" wss://example.com/feed?x=1 ").unwrap(),
            "https://example.com/feed?x=1"
        );
        assert!(http_url("http://example.com").is_err());
        assert!(http_url("ws://").is_err());
        assert!(http_url("ws://a b").is_err());
    }

    #[test]
    fn protocols_are_tokens() {
        assert!(valid_protocol("graphql-ws"));
        assert!(valid_protocol("v1.json"));
        assert!(!valid_protocol(""));
        assert!(!valid_protocol("a, b"));
        assert!(!valid_protocol("x\r\nHost: evil"));
    }

    /// A server that answers the upgrade (picking the second subprotocol), sends a two-line text
    /// frame, a binary one and a close: the handshake checks out and the frames read back.
    #[tokio::test]
    async fn handshake_and_frames() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut req = Vec::new();
            let mut byte = [0u8; 1];
            while !req.ends_with(b"\r\n\r\n") {
                s.read_exact(&mut byte).await.unwrap();
                req.push(byte[0]);
            }
            let text = String::from_utf8_lossy(&req).to_string();
            let key = text
                .lines()
                .find_map(|l| {
                    let (k, v) = l.split_once(':')?;
                    k.eq_ignore_ascii_case("sec-websocket-key")
                        .then(|| v.trim().to_string())
                })
                .unwrap();
            assert!(text
                .to_ascii_lowercase()
                .contains("sec-websocket-protocol: a, b"));
            let accept = crate::mcp::ide_ws::accept_key(&key);
            s.write_all(format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\nSec-WebSocket-Protocol: b\r\n\r\n").as_bytes()).await.unwrap();
            s.write_all(&crate::mcp::ide_ws::frame(0x1, b"one\ntwo"))
                .await
                .unwrap();
            s.write_all(&crate::mcp::ide_ws::frame(0x2, &[1, 2, 3]))
                .await
                .unwrap();
            let mut close = 1000u16.to_be_bytes().to_vec();
            close.extend_from_slice(b"bye");
            s.write_all(&crate::mcp::ide_ws::frame(0x8, &close))
                .await
                .unwrap();
        });
        let url = format!("ws://127.0.0.1:{port}/feed");
        let (protocol, upgraded) = handshake(&url, &["a".into(), "b".into()]).await.unwrap();
        assert_eq!(protocol.as_deref(), Some("b"));
        let (mut reader, _writer) = tokio::io::split(upgraded);
        let (fin, op, payload) = crate::mcp::ide_ws::read_frame(&mut reader).await.unwrap();
        assert!(fin);
        assert_eq!((op, payload.as_slice()), (0x1, b"one\ntwo".as_slice()));
        let (_, op, payload) = crate::mcp::ide_ws::read_frame(&mut reader).await.unwrap();
        assert_eq!((op, payload.len()), (0x2, 3));
        let (_, op, payload) = crate::mcp::ide_ws::read_frame(&mut reader).await.unwrap();
        assert_eq!(op, 0x8);
        assert_eq!(close_payload(&payload), (Some(1000), "bye".to_string()));
        server.await.unwrap();
    }

    /// A server that isn't a WebSocket: the error says what it answered.
    #[tokio::test]
    async fn refused_upgrade() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf).await;
            let _ = s
                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
                .await;
        });
        let err = handshake(&format!("ws://127.0.0.1:{port}/"), &[])
            .await
            .err()
            .unwrap();
        assert!(err.to_string().contains("404"), "{err}");
    }

    #[test]
    fn close_frames() {
        assert_eq!(close_payload(&[]), (None, String::new()));
        let mut p = 1001u16.to_be_bytes().to_vec();
        p.extend_from_slice(b"going away");
        assert_eq!(close_payload(&p), (Some(1001), "going away".to_string()));
    }
}
