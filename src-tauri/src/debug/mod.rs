//! Debugger transport (D143): a minimal WebSocket client for inspector protocols on this machine
//! (Node's `--inspect`, Chrome DevTools Protocol). Only `ws://127.0.0.1`, `ws://localhost` and
//! `ws://[::1]` are allowed — the debuggee is always a local process the IDE started — so the
//! webview's CSP stays closed to sockets. Text frames in and out; pings answered; the protocol
//! itself is TS (`src/extensions/debug/cdp.ts`). Debug adapters that speak DAP over stdio use
//! the stdio host (`crate::lsp`) instead; those that listen on a local port (Delve's `dlv dap`,
//! D204) get `connect_dap`, the same channel with DAP's Content-Length framing instead of
//! WebSocket frames. `autoattach` registers Node child processes and debug terminals' programs,
//! `processes` lists processes to attach to.

pub mod autoattach;
pub mod browsers;
pub mod pane_port;
pub mod processes;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

use crate::error::{Error, Result};

/// Larger messages close the socket (a runaway debuggee shouldn't take the IDE's memory).
const MAX_MESSAGE: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SocketEvent {
    Message { body: String },
    Closed { reason: String },
}

enum Outgoing {
    Text(String),
    Pong(Vec<u8>),
    Close,
}

#[derive(Default)]
pub struct DebugSockets {
    open: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Outgoing>>>>,
}

/// `ws://host:port/path` → (host, port, path), local hosts only.
pub fn parse_local_url(url: &str) -> Result<(String, u16, String)> {
    let rest = url
        .strip_prefix("ws://")
        .ok_or_else(|| Error::Invalid(format!("not a ws:// address: {url}")))?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let (host, port) = match authority.rfind(':') {
        Some(i) if !authority[i..].contains(']') => (&authority[..i], &authority[i + 1..]),
        _ => return Err(Error::Invalid(format!("no port in {url}"))),
    };
    if !matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
        return Err(Error::Invalid(format!(
            "debugger sockets must be on this machine, not {host}"
        )));
    }
    let port: u16 = port
        .parse()
        .map_err(|_| Error::Invalid(format!("bad port in {url}")))?;
    Ok((
        host.trim_matches(['[', ']']).to_string(),
        port,
        path.to_string(),
    ))
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn random<const N: usize>() -> Result<[u8; N]> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).map_err(|e| Error::Invalid(format!("no randomness: {e}")))?;
    Ok(b)
}

/// A client frame (always masked).
pub fn encode_frame(opcode: u8, payload: &[u8], mask: [u8; 4]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 14);
    out.push(0x80 | opcode);
    let len = payload.len();
    if len < 126 {
        out.push(0x80 | len as u8);
    } else if len <= 0xFFFF {
        out.push(0x80 | 126);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        out.push(0x80 | 127);
        out.extend_from_slice(&(len as u64).to_be_bytes());
    }
    out.extend_from_slice(&mask);
    out.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
    out
}

async fn read_frame(stream: &mut tokio::net::tcp::OwnedReadHalf) -> Result<(bool, u8, Vec<u8>)> {
    let mut head = [0u8; 2];
    stream.read_exact(&mut head).await?;
    let fin = head[0] & 0x80 != 0;
    let opcode = head[0] & 0x0F;
    let masked = head[1] & 0x80 != 0;
    let mut len = u64::from(head[1] & 0x7F);
    if len == 126 {
        let mut b = [0u8; 2];
        stream.read_exact(&mut b).await?;
        len = u64::from(u16::from_be_bytes(b));
    } else if len == 127 {
        let mut b = [0u8; 8];
        stream.read_exact(&mut b).await?;
        len = u64::from_be_bytes(b);
    }
    if len as usize > MAX_MESSAGE {
        return Err(Error::Invalid("debugger message too large".into()));
    }
    let mut mask = [0u8; 4];
    if masked {
        stream.read_exact(&mut mask).await?;
    }
    let mut payload = vec![0u8; len as usize];
    stream.read_exact(&mut payload).await?;
    if masked {
        for (i, b) in payload.iter_mut().enumerate() {
            *b ^= mask[i % 4];
        }
    }
    Ok((fin, opcode, payload))
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// The inspector's targets at `host:port` (`GET /json/list`, Node's `--inspect` and Chrome's
/// `--remote-debugging-port`): its JSON, for attaching. Local addresses only, as for sockets.
pub async fn inspector_targets(host: &str, port: u16) -> Result<String> {
    local_get(host, port, "/json/list").await
}

/// `http://host:port/path` → (host, port, path), local hosts only (D196: source maps of a page
/// being debugged, served by a dev server on this machine).
pub fn parse_local_http(url: &str) -> Result<(String, u16, String)> {
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| Error::Invalid(format!("not an http:// address on this machine: {url}")))?;
    let (host, port, path) = parse_local_url(&format!("ws://{}", with_port(rest)))?;
    Ok((host, port, path))
}

/// "localhost/a" → "localhost:80/a" (an address without a port uses HTTP's).
fn with_port(rest: &str) -> String {
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let has_port = authority
        .rfind(':')
        .is_some_and(|i| !authority[i..].contains(']'));
    if has_port {
        format!("{authority}{path}")
    } else {
        format!("{authority}:80{path}")
    }
}

/// A GET to a server on this machine: the body of a 200 answer (chunked or not), at most 32 MB.
pub async fn local_get(host: &str, port: u16, path: &str) -> Result<String> {
    // An IPv6 host comes back from parse_local_url without its brackets.
    let bracketed = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    let (host, port, _) = parse_local_url(&format!("ws://{bracketed}:{port}/"))?;
    let mut stream = tokio::time::timeout(
        Duration::from_secs(3),
        TcpStream::connect((host.as_str(), port)),
    )
    .await
    .map_err(|_| Error::Invalid(format!("nothing answered on {host}:{port}")))?
    .map_err(|e| Error::Invalid(format!("nothing is listening on {host}:{port} ({e})")))?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: */*\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await?;
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut buf = [0u8; 8192];
        loop {
            let n = stream.read(&mut buf).await?;
            if n == 0 || response.len() > 32 * 1024 * 1024 {
                break;
            }
            response.extend_from_slice(&buf[..n]);
            // Node's inspector keeps the connection open: stop once the body is complete.
            if let Some(end) = find(&response, b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&response[..end]).to_ascii_lowercase();
                let length = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse::<usize>().ok());
                if length.is_some_and(|len| response.len() >= end + 4 + len) {
                    break;
                }
                if head.contains("transfer-encoding: chunked")
                    && (response.ends_with(b"\r\n0\r\n\r\n") || response.len() == end + 4 + 5)
                {
                    break;
                }
            }
        }
        Ok::<_, std::io::Error>(())
    })
    .await
    .map_err(|_| Error::Invalid(format!("{host}:{port} didn't answer")))??;
    let end = find(&response, b"\r\n\r\n")
        .ok_or_else(|| Error::Invalid(format!("bad answer from {host}:{port}")))?;
    let head = String::from_utf8_lossy(&response[..end]).to_string();
    if !head.starts_with("HTTP/1.1 200") && !head.starts_with("HTTP/1.0 200") {
        return Err(Error::Invalid(format!(
            "{host}:{port}{path} answered {}",
            head.lines().next().unwrap_or("")
        )));
    }
    let body = &response[end + 4..];
    let chunked = head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked");
    let bytes = if chunked {
        dechunk(body)
    } else {
        body.to_vec()
    };
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// A chunked body's data (what's well-formed of it).
pub fn dechunk(mut body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(line_end) = find(body, b"\r\n") {
        let size_text = String::from_utf8_lossy(&body[..line_end]);
        let Ok(size) = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
        else {
            break;
        };
        if size == 0 {
            break;
        }
        let start = line_end + 2;
        // `checked_add`: a size line like `ffffffffffffffff` overflowed (a panic in dev builds).
        let Some(chunk) = start.checked_add(size).and_then(|end| body.get(start..end)) else {
            out.extend_from_slice(&body[start.min(body.len())..]);
            break;
        };
        out.extend_from_slice(chunk);
        body = body.get(start + size + 2..).unwrap_or(&[]);
    }
    out
}

impl DebugSockets {
    /// Connects socket `id` (replacing one with that id) and forwards its text messages.
    pub async fn connect(&self, id: &str, url: &str, on_event: Channel<SocketEvent>) -> Result<()> {
        self.close(id);
        let (host, port, path) = parse_local_url(url)?;
        let stream = tokio::time::timeout(
            Duration::from_secs(5),
            TcpStream::connect((host.as_str(), port)),
        )
        .await
        .map_err(|_| Error::Invalid(format!("the debugger at {url} didn't answer")))??;
        stream.set_nodelay(true).ok();
        let (mut reader, mut writer) = stream.into_split();
        let key = base64(&random::<16>()?);
        let request = format!(
            "GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        writer.write_all(request.as_bytes()).await?;
        // The handshake answer, byte by byte up to the blank line (frames may follow at once).
        // Bounded in time too: something listening on the port that never answers (not a
        // debugger, or a paused one) would otherwise hang the connect call forever.
        let handshake = async {
            let mut response = Vec::new();
            let mut byte = [0u8; 1];
            while !response.ends_with(b"\r\n\r\n") {
                if response.len() > 16 * 1024 {
                    return Err(Error::Invalid("bad handshake from the debugger".into()));
                }
                reader.read_exact(&mut byte).await?;
                response.push(byte[0]);
            }
            Ok(response)
        };
        let response = tokio::time::timeout(Duration::from_secs(10), handshake)
            .await
            .map_err(|_| {
                Error::Invalid(format!("the debugger at {url} didn't finish the handshake"))
            })??;
        let status = String::from_utf8_lossy(&response);
        if !status.starts_with("HTTP/1.1 101") {
            let first = status.lines().next().unwrap_or("").to_string();
            return Err(Error::Invalid(format!(
                "the debugger refused the connection: {first}"
            )));
        }

        let (tx, mut rx) = mpsc::unbounded_channel::<Outgoing>();
        self.lock()?.insert(id.to_string(), tx.clone());

        // Writer: text frames, pongs, close.
        tauri::async_runtime::spawn(async move {
            while let Some(out) = rx.recv().await {
                let Ok(mask) = random::<4>() else { break };
                let (frame, last) = match out {
                    Outgoing::Text(t) => (encode_frame(0x1, t.as_bytes(), mask), false),
                    Outgoing::Pong(p) => (encode_frame(0xA, &p, mask), false),
                    Outgoing::Close => (encode_frame(0x8, &[], mask), true),
                };
                if writer.write_all(&frame).await.is_err() || last {
                    break;
                }
            }
            let _ = writer.shutdown().await;
        });

        // Reader: reassembles fragmented messages; ends with one Closed event.
        let open = self.open.clone();
        let own = tx;
        let id = id.to_string();
        tauri::async_runtime::spawn(async move {
            let mut message: Vec<u8> = Vec::new();
            let reason = loop {
                match read_frame(&mut reader).await {
                    Err(e) => break e.to_string(),
                    Ok((fin, opcode, payload)) => match opcode {
                        0x0..=0x2 => {
                            message.extend_from_slice(&payload);
                            if message.len() > MAX_MESSAGE {
                                break "debugger message too large".into();
                            }
                            if fin {
                                let body = String::from_utf8_lossy(&message).into_owned();
                                message.clear();
                                if on_event.send(SocketEvent::Message { body }).is_err() {
                                    break "closed".into();
                                }
                            }
                        }
                        0x8 => break "closed by the debugger".into(),
                        0x9 => {
                            let _ = own.send(Outgoing::Pong(payload));
                        }
                        _ => {}
                    },
                }
            };
            let _ = own.send(Outgoing::Close);
            // A poisoned map can't be cleaned up; the Closed event below still goes out.
            if let Ok(mut map) = open.lock() {
                if map.get(&id).is_some_and(|tx| tx.same_channel(&own)) {
                    map.remove(&id);
                }
            }
            let _ = on_event.send(SocketEvent::Closed { reason });
        });
        Ok(())
    }

    /// Connects `id` to a debug adapter listening on `host:port` (this machine only) and
    /// forwards each DAP message's JSON; `send` frames what goes out.
    pub async fn connect_dap(
        &self,
        id: &str,
        host: &str,
        port: u16,
        on_event: Channel<SocketEvent>,
    ) -> Result<()> {
        self.close(id);
        let (host, port, _) = parse_local_url(&format!("ws://{host}:{port}/"))?;
        let stream = tokio::time::timeout(
            Duration::from_secs(5),
            TcpStream::connect((host.as_str(), port)),
        )
        .await
        .map_err(|_| {
            Error::Invalid(format!("the debug adapter at {host}:{port} didn't answer"))
        })??;
        stream.set_nodelay(true).ok();
        let (mut reader, mut writer) = stream.into_split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Outgoing>();
        self.lock()?.insert(id.to_string(), tx.clone());
        tauri::async_runtime::spawn(async move {
            while let Some(out) = rx.recv().await {
                let Outgoing::Text(body) = out else { break };
                let frame = format!("Content-Length: {}\r\n\r\n{body}", body.len());
                if writer.write_all(frame.as_bytes()).await.is_err() {
                    break;
                }
            }
            let _ = writer.shutdown().await;
        });
        let open = self.open.clone();
        let own = tx;
        let id = id.to_string();
        tauri::async_runtime::spawn(async move {
            let mut buf: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 16 * 1024];
            let reason = 'outer: loop {
                let n = match reader.read(&mut chunk).await {
                    Ok(0) => break "closed by the debug adapter".to_string(),
                    Ok(n) => n,
                    Err(e) => break e.to_string(),
                };
                buf.extend_from_slice(&chunk[..n]);
                loop {
                    match dap_frame(&buf) {
                        Ok(Some((start, len))) => {
                            let body =
                                String::from_utf8_lossy(&buf[start..start + len]).into_owned();
                            buf.drain(..start + len);
                            if on_event.send(SocketEvent::Message { body }).is_err() {
                                break 'outer "closed".to_string();
                            }
                        }
                        Ok(None) => break,
                        Err(e) => break 'outer e,
                    }
                }
            };
            let _ = own.send(Outgoing::Close);
            if let Ok(mut map) = open.lock() {
                if map.get(&id).is_some_and(|tx| tx.same_channel(&own)) {
                    map.remove(&id);
                }
            }
            let _ = on_event.send(SocketEvent::Closed { reason });
        });
        Ok(())
    }

    pub fn send(&self, id: &str, body: String) -> Result<()> {
        let map = self.lock()?;
        let tx = map
            .get(id)
            .ok_or_else(|| Error::Invalid(format!("no debugger connection {id}")))?;
        tx.send(Outgoing::Text(body))
            .map_err(|_| Error::Invalid("the debugger connection closed".into()))
    }

    pub fn close(&self, id: &str) {
        let removed = self.open.lock().ok().and_then(|mut map| map.remove(id));
        if let Some(tx) = removed {
            let _ = tx.send(Outgoing::Close);
        }
    }

    /// Closes every connection (the page that opened them reloaded: nothing reads them, and a
    /// debuggee paused at a breakpoint would keep an inspector session no page can see).
    pub fn close_all(&self) {
        let all: Vec<_> = match self.open.lock() {
            Ok(mut map) => map.drain().map(|(_, tx)| tx).collect(),
            Err(_) => return,
        };
        for tx in all {
            let _ = tx.send(Outgoing::Close);
        }
    }

    fn lock(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, mpsc::UnboundedSender<Outgoing>>>> {
        self.open
            .lock()
            .map_err(|_| Error::Invalid("lock poisoned".into()))
    }
}

/// A complete DAP message at the start of `buf`: (body start, body length), None while more is
/// needed, or an error for a header without a length or a message over the limit.
pub fn dap_frame(buf: &[u8]) -> std::result::Result<Option<(usize, usize)>, String> {
    let Some(end) = find(buf, b"\r\n\r\n") else {
        return if buf.len() > 16 * 1024 {
            Err("bad message header from the debug adapter".into())
        } else {
            Ok(None)
        };
    };
    let head = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
    let len = head
        .lines()
        .find_map(|l| l.strip_prefix("content-length:"))
        .and_then(|v| v.trim().parse::<usize>().ok())
        .ok_or_else(|| "a message without Content-Length from the debug adapter".to_string())?;
    if len > MAX_MESSAGE {
        return Err("debugger message too large".into());
    }
    let start = end + 4;
    Ok((buf.len() >= start + len).then_some((start, len)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dap_frames() {
        assert_eq!(
            dap_frame(b"Content-Length: 2\r\n\r\n{}x"),
            Ok(Some((21, 2)))
        );
        assert_eq!(dap_frame(b"Content-Length: 5\r\n\r\n{}"), Ok(None));
        assert_eq!(dap_frame(b"Content-Len"), Ok(None));
        assert!(dap_frame(b"X: 1\r\n\r\n").is_err());
    }

    #[test]
    fn local_http_only_and_chunks() {
        assert_eq!(
            parse_local_http("http://localhost:5173/src/a.ts.map").ok(),
            Some(("localhost".into(), 5173, "/src/a.ts.map".into()))
        );
        assert_eq!(
            parse_local_http("http://127.0.0.1/x").ok(),
            Some(("127.0.0.1".into(), 80, "/x".into()))
        );
        assert!(parse_local_http("http://example.com:80/x").is_err());
        assert!(parse_local_http("https://localhost:1/x").is_err());
        assert_eq!(
            dechunk(b"4\r\nWiki\r\n5;x=1\r\npedia\r\n0\r\n\r\n"),
            b"Wikipedia"
        );
        // A size that would overflow keeps what's there instead of panicking.
        assert_eq!(dechunk(b"ffffffffffffffff\r\nab"), b"ab");
    }

    #[test]
    fn only_local_sockets() {
        assert_eq!(
            parse_local_url("ws://127.0.0.1:9229/abc-def").unwrap(),
            ("127.0.0.1".into(), 9229, "/abc-def".into())
        );
        assert_eq!(parse_local_url("ws://[::1]:9229/x").unwrap().0, "::1");
        assert!(parse_local_url("ws://example.com:9229/x").is_err());
        assert!(parse_local_url("wss://127.0.0.1:9229/x").is_err());
        assert!(parse_local_url("ws://127.0.0.1/x").is_err());
    }

    #[test]
    fn base64_matches_rfc4648() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn frames_are_masked_with_extended_lengths() {
        let f = encode_frame(1, b"hi", [1, 2, 3, 4]);
        assert_eq!(f, vec![0x81, 0x82, 1, 2, 3, 4, b'h' ^ 1, b'i' ^ 2]);
        let long = encode_frame(1, &[0u8; 300], [0; 4]);
        assert_eq!(&long[..4], &[0x81, 0x80 | 126, 1, 44]);
        let huge = encode_frame(1, &vec![0u8; 70_000], [0; 4]);
        assert_eq!(huge[1], 0x80 | 127);
    }
}
