//! Remote MCP servers (D193): the client side of MCP's Streamable HTTP transport. Each JSON-RPC
//! message the agent sends is POSTed to the server's URL; the answer is JSON or a stream of
//! server-sent events carrying messages. Rust makes the request so there's no CORS, and header
//! values with `${secret:mcp.…}` (password inputs) are filled in here, out of the webview's reach.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;

use crate::error::{Error, Result};

/// What came back from one POST.
#[derive(Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteReply {
    pub status: u16,
    /// The server's `Mcp-Session-Id`, to send with every later request.
    pub session_id: Option<String>,
    /// JSON-RPC messages (responses, server requests and notifications), as JSON text.
    pub messages: Vec<String>,
}

/// Only https, or http to this machine (a server the user runs locally).
pub fn check_url(url: &str) -> Result<reqwest::Url> {
    let parsed = reqwest::Url::parse(url).map_err(|e| Error::Invalid(format!("{url}: {e}")))?;
    let local = matches!(
        parsed.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    match parsed.scheme() {
        "https" => Ok(parsed),
        "http" if local => Ok(parsed),
        _ => Err(Error::Invalid(format!(
            "{url}: an MCP server must use https (or http on localhost)"
        ))),
    }
}

/// An address ending in `/sse` is the old HTTP+SSE transport (a GET stream plus a POST endpoint).
fn status_is_legacy_sse(url: &reqwest::Url) -> bool {
    url.path().trim_end_matches('/').ends_with("/sse")
}

/// A client for remote MCP servers that doesn't follow redirects: the address was checked (https,
/// or local http), and a redirect could send the headers (with their secrets) elsewhere.
pub fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap_or_default()
        })
        .clone()
}

/// The messages in a JSON body: one message or a batch.
pub fn messages_in_json(text: &str) -> Vec<String> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Array(list)) => list.iter().map(Value::to_string).collect(),
        Ok(v @ Value::Object(_)) => vec![v.to_string()],
        _ => Vec::new(),
    }
}

/// Server-sent events, fed as they arrive: complete events' `data` (joined lines).
#[derive(Default)]
pub struct SseParser {
    /// Bytes of the line in progress: decoded only once whole (a character can straddle chunks).
    buffer: Vec<u8>,
    data: Vec<String>,
    /// The last event's `id:` (sent back as Last-Event-ID when a GET stream reconnects).
    pub last_id: Option<String>,
    /// The server's `retry:` (milliseconds before reconnecting).
    pub retry_ms: Option<u64>,
}

impl SseParser {
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
            let raw: Vec<u8> = self.buffer.drain(..=end).collect();
            let text = String::from_utf8_lossy(&raw[..end]);
            let line = text.trim_end_matches('\r').to_string();
            if line.is_empty() {
                if !self.data.is_empty() {
                    out.push(self.data.join("\n"));
                    self.data.clear();
                }
            } else if let Some(rest) = line.strip_prefix("data:") {
                self.data
                    .push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
            } else if let Some(rest) = line.strip_prefix("id:") {
                let id = rest.trim();
                // An id with a NUL is ignored (the SSE specification).
                if !id.contains('\0') {
                    self.last_id = Some(id.to_string()).filter(|i| !i.is_empty());
                }
            } else if let Some(rest) = line.strip_prefix("retry:") {
                if let Ok(ms) = rest.trim().parse::<u64>() {
                    self.retry_ms = Some(ms);
                }
            }
            // `event:` and comments don't change what we do.
        }
        out
    }
}

/// The id of a JSON-RPC request in `body`, if it is one (notifications and responses have none
/// to wait for).
fn request_id(body: &str) -> Option<Value> {
    let v: Value = serde_json::from_str(body).ok()?;
    v.get("method")?;
    v.get("id").cloned()
}

/// POSTs one message. A request waits for its response (the stream may carry other messages
/// first); a notification or a response gets 202 and no messages. With `on_server_message`, the
/// server's own requests and notifications in the stream (an elicitation, a list_changed) are
/// handed over as they arrive, since the server may wait for the answer to one before it sends
/// the response (D200); the rest come back in the reply.
pub async fn post(
    secrets: &Path,
    server: &str,
    url: &str,
    headers: &HashMap<String, String>,
    session_id: Option<&str>,
    body: String,
    on_server_message: Option<&(dyn Fn(String) + Send + Sync)>,
) -> Result<RemoteReply> {
    // The address as configured: what OAuth tokens are stored against (D204).
    let raw = url.to_string();
    let url = check_url(url)?;
    if status_is_legacy_sse(&url) {
        return Err(Error::Invalid(format!(
            "{url}: this looks like the older SSE transport, which isn't supported; use the server's Streamable HTTP address (usually …/mcp)"
        )));
    }
    let wanted = request_id(&body);
    // A configured Authorization header wins; else the OAuth sign-in's token, if any (D204).
    let configured = headers
        .keys()
        .any(|k| k.eq_ignore_ascii_case("authorization"));
    let mut oauth = if configured {
        None
    } else {
        super::oauth::access_token(&client(), secrets, server, &raw, false).await
    };
    let mut retried = false;
    let response = loop {
        let mut request = client()
            .post(url.clone())
            .timeout(Duration::from_secs(300))
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", "2025-06-18");
        for (name, value) in headers {
            request = request.header(
                name,
                crate::ai::secrets::expand(secrets, value, Some(server))?,
            );
        }
        if let Some(token) = &oauth {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        if let Some(id) = session_id {
            request = request.header("Mcp-Session-Id", id);
        }
        let response = request
            .body(body.clone())
            .send()
            .await
            .map_err(crate::ai::http_error)?;
        let status = response.status().as_u16();
        if status == 401 && !configured {
            if let Some(h) = response
                .headers()
                .get("www-authenticate")
                .and_then(|v| v.to_str().ok())
            {
                super::oauth::note_challenge(server, h);
            }
            // An expired or revoked token: refresh once and try again.
            if oauth.is_some() && !retried {
                retried = true;
                oauth = super::oauth::access_token(&client(), secrets, server, &raw, true).await;
                if oauth.is_some() {
                    continue;
                }
            }
        }
        break response;
    };
    let status = response.status().as_u16();
    let session = response
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    // A token without the scope this call needs: the page signs in again asking for it (MCP's
    // step-up authorization, D207) and sends the request once more.
    if status == 403 && !configured {
        if let Some(h) = response
            .headers()
            .get("www-authenticate")
            .and_then(|v| v.to_str().ok())
        {
            if let Some(scope) = super::oauth::insufficient_scope(h) {
                super::oauth::note_challenge(server, h);
                return Err(Error::Ai(format!(
                    "insufficient_scope: the server needs more access{}; sign in again to grant it",
                    scope.map(|s| format!(" ({s})")).unwrap_or_default()
                )));
            }
        }
    }
    if status == 401 || status == 403 {
        return Err(Error::Ai(if configured {
            format!("the server refused the configured Authorization header ({status}): check the token (MCP servers… → Forget its stored inputs asks again)")
        } else {
            format!("the server needs a sign-in ({status}): use Sign in on the MCP servers page (or agent.mcpSignIn)")
        }));
    }
    if !response.status().is_success() {
        return Err(crate::ai::error_body(response).await);
    }
    let kind = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut reply = RemoteReply {
        status,
        session_id: session,
        messages: Vec::new(),
    };
    if kind.starts_with("text/event-stream") {
        let mut parser = SseParser::default();
        let mut stream = response.bytes_stream();
        'read: while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(crate::ai::http_error)?;
            for data in parser.feed(&chunk) {
                let done = wanted.as_ref().is_some_and(|id| {
                    serde_json::from_str::<Value>(&data)
                        .is_ok_and(|m| m.get("method").is_none() && m.get("id") == Some(id))
                });
                let from_server = !done
                    && serde_json::from_str::<Value>(&data)
                        .is_ok_and(|m| m.get("method").is_some());
                match on_server_message {
                    Some(deliver) if from_server => deliver(data),
                    _ => reply.messages.push(data),
                }
                if done {
                    break 'read;
                }
            }
        }
        let answered = wanted.as_ref().is_none_or(|id| {
            reply.messages.iter().any(|m| {
                serde_json::from_str::<Value>(m)
                    .is_ok_and(|m| m.get("method").is_none() && m.get("id") == Some(id))
            })
        });
        if !answered {
            return Err(Error::Ai(
                "the server ended its reply without an answer".into(),
            ));
        }
    } else {
        let text = response.text().await.map_err(crate::ai::http_error)?;
        reply.messages = messages_in_json(&text);
    }
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_are_split_across_chunks() {
        let mut p = SseParser::default();
        assert!(p.feed(b"event: message\ndata: {\"a\"").is_empty());
        assert_eq!(p.feed(b":1}\n\ndata: x\r\n").as_slice(), ["{\"a\":1}"]);
        assert_eq!(p.feed(b"data: y\n\n").as_slice(), ["x\ny"]);
        // id: and retry: are kept for a GET stream's reconnect.
        let mut q = SseParser::default();
        assert_eq!(q.feed(b"id: 7\nretry: 2500\ndata: z\n\n").as_slice(), ["z"]);
        assert_eq!(q.last_id.as_deref(), Some("7"));
        assert_eq!(q.retry_ms, Some(2500));
        // A character split between chunks survives.
        let e = "data: \u{e9}\n\n".as_bytes();
        assert!(p.feed(&e[..7]).is_empty());
        assert_eq!(p.feed(&e[7..]).as_slice(), ["\u{e9}"]);
    }

    #[test]
    fn only_secure_or_local_addresses() {
        assert!(check_url("https://mcp.example.com/mcp").is_ok());
        assert!(check_url("http://localhost:3000/mcp").is_ok());
        assert!(check_url("http://127.0.0.1:3000/mcp").is_ok());
        assert!(check_url("http://example.com/mcp").is_err());
        assert!(check_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn json_bodies_hold_one_message_or_a_batch() {
        assert_eq!(messages_in_json("{\"id\":1}").len(), 1);
        assert_eq!(messages_in_json("[{\"id\":1},{\"id\":2}]").len(), 2);
        assert!(messages_in_json("").is_empty());
        assert_eq!(
            request_id("{\"id\":3,\"method\":\"x\"}"),
            Some(Value::from(3))
        );
        assert_eq!(request_id("{\"id\":3,\"result\":{}}"), None);
    }
}
