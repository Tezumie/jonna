//! The IDE's executable as a stdio MCP server (D223): external agents that take only stdio MCP
//! servers (no `mcpCapabilities.http`) get the IDE's own tools by starting
//! `<the IDE's binary> --mcp-stdio-proxy <url>` with the token in `IDE_MCP_PROXY_TOKEN` (the
//! environment, not the command line, which other programs on the machine can read). The proxy
//! reads newline-delimited JSON-RPC from stdin, POSTs each message to the lent Streamable HTTP
//! server (mod.rs, http.rs) with the bearer token and its `Mcp-Session-Id`, and writes every
//! message of the answer (JSON or server-sent events) to stdout, one per line. Only a loopback
//! address is taken, so the token never leaves the machine. Requests run side by side (a tool
//! call waiting for the user's permission doesn't hold up the rest); initialize and
//! notifications keep their order. When stdin closes the session is ended (DELETE) and the
//! process exits. Nothing of the app starts: no window, no webview.
//!
//! After `notifications/initialized` the proxy also opens the standalone GET stream (Streamable
//! HTTP, D233): `GET <url>` with `Accept: text/event-stream`, the session and protocol version,
//! on which the server may send requests and notifications of its own while no POST is open
//! (a list_changed, a sampling request); each goes to stdout like any other message, and the
//! agent's answers come back on stdin and are POSTed. A server without one answers 405 (or
//! something that isn't an event stream) and nothing more is tried; a stream that ends or fails
//! is opened again after a pause (stream.rs's `backoff`, the server's `retry:`) with
//! `Last-Event-ID`; 404 (the session ended), 401 or 403 stop it.

use std::io::{BufRead, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Value};

use super::remote::{messages_in_json, SseParser};
use super::stream::backoff;

/// The flag that turns the binary into the proxy.
pub const FLAG: &str = "--mcp-stdio-proxy";
/// Where the bearer token comes from.
pub const TOKEN_ENV: &str = "IDE_MCP_PROXY_TOKEN";
/// A call may wait for the user's permission (the IDE's own bridge gives up after 10 minutes).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(900);
/// The largest line read from the agent (a tool call's arguments).
const MAX_LINE: usize = 16 * 1024 * 1024;
/// A GET stream that ends sooner than this counts as a failure (the pauses keep growing).
const SHORT_STREAM: Duration = Duration::from_secs(10);
/// GET streams that failed in a row before the proxy stops opening them.
const MAX_STREAM_FAILURES: u32 = 20;

/// Started as the proxy: runs it and returns the exit code; None when this isn't a proxy run.
pub fn client() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next()? != FLAG {
        return None;
    }
    let Some(url) = args.next().map(|u| u.to_string_lossy().into_owned()) else {
        eprintln!("{FLAG}: the MCP server's address is missing");
        return Some(2);
    };
    let token = std::env::var(TOKEN_ENV).unwrap_or_default();
    // Not passed on to anything this process might start.
    std::env::remove_var(TOKEN_ENV);
    Some(run(&url, &token))
}

/// Only the IDE's own server on this machine (http to a loopback address, path `/mcp`).
pub fn check_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("{url}: {e}"))?;
    let loopback = matches!(
        parsed.host_str(),
        Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
    );
    if parsed.scheme() != "http" || !loopback || parsed.port().is_none() {
        return Err(format!(
            "{url}: the proxy only connects to the IDE's MCP server on this computer"
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(format!("{url}: no credentials in the address"));
    }
    Ok(parsed)
}

/// A JSON-RPC message as one line (servers' events may hold line breaks; JSON needs none).
pub fn one_line(message: &str) -> Option<String> {
    serde_json::from_str::<Value>(message)
        .ok()
        .filter(Value::is_object)
        .map(|v| v.to_string())
}

/// The error answer for a request the server couldn't be asked about.
pub fn error_reply(id: &Value, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": message } })
        .to_string()
}

/// What a line from the agent is: its request id (None for notifications and responses) and
/// whether it's `initialize`.
pub fn classify(line: &str) -> Option<(Option<Value>, bool)> {
    let v: Value = serde_json::from_str(line).ok()?;
    if !v.is_object() {
        return None;
    }
    let method = v.get("method").and_then(Value::as_str);
    let id = method.and(v.get("id").cloned()).filter(|id| !id.is_null());
    Some((id, method == Some("initialize")))
}

/// Whether a line from the agent is `notifications/initialized` (the GET stream opens after it).
pub fn is_initialized(line: &str) -> bool {
    serde_json::from_str::<Value>(line).is_ok_and(|v| {
        v.get("method").and_then(Value::as_str) == Some("notifications/initialized")
            && v.get("id").is_none()
    })
}

/// How a GET stream's answer is taken (the MCP spec's rules for the standalone stream).
#[derive(Debug, PartialEq)]
pub enum StreamAnswer {
    /// An event stream: read it.
    Open,
    /// The server has none (405, or a success that isn't an event stream): never ask again.
    Unsupported,
    /// The session is gone (404) or the token refused (401, 403): stop.
    Stop,
    /// Anything else (a 5xx): try again after a pause.
    Retry,
}

pub fn stream_answer(status: u16, content_type: &str) -> StreamAnswer {
    let success = (200..300).contains(&status);
    if status == 405 || (success && !content_type.starts_with("text/event-stream")) {
        StreamAnswer::Unsupported
    } else if success {
        StreamAnswer::Open
    } else if matches!(status, 401 | 403 | 404) {
        StreamAnswer::Stop
    } else {
        StreamAnswer::Retry
    }
}

/// The proxy's state for one run.
pub struct Proxy {
    url: reqwest::Url,
    auth: String,
    http: reqwest::Client,
    session: Mutex<Option<String>>,
    protocol: Mutex<String>,
    out: Arc<dyn Fn(String) + Send + Sync>,
    /// The GET stream was started (once per run).
    listening: AtomicBool,
}

impl Proxy {
    pub fn new(url: reqwest::Url, token: &str, out: Arc<dyn Fn(String) + Send + Sync>) -> Self {
        Self {
            url,
            auth: format!("Bearer {token}"),
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .build()
                .unwrap_or_default(),
            session: Mutex::new(None),
            protocol: Mutex::new("2025-06-18".into()),
            out,
            listening: AtomicBool::new(false),
        }
    }

    fn session(&self) -> Option<String> {
        self.session.lock().ok().and_then(|s| s.clone())
    }

    /// Sends one message and writes what comes back. Errors for a request become its answer.
    pub async fn forward(&self, line: String) {
        let Some((id, initialize)) = classify(&line) else {
            eprintln!("{FLAG}: skipped a line that isn't a JSON-RPC message");
            return;
        };
        if let Err(message) = self.send(line, initialize).await {
            match &id {
                Some(id) => (self.out)(error_reply(id, &message)),
                None => eprintln!("{FLAG}: {message}"),
            }
        }
    }

    async fn send(&self, line: String, initialize: bool) -> Result<(), String> {
        let protocol = self.protocol.lock().map(|p| p.clone()).unwrap_or_default();
        let mut request = self
            .http
            .post(self.url.clone())
            .timeout(REQUEST_TIMEOUT)
            .header("Authorization", &self.auth)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream");
        if !initialize {
            request = request.header("MCP-Protocol-Version", protocol);
        }
        if let Some(session) = self.session() {
            request = request.header("Mcp-Session-Id", session);
        }
        let response = request.body(line).send().await.map_err(|e| {
            if e.is_connect() {
                "The IDE's MCP server isn't running (the IDE closed, or its tools were turned off)."
                    .to_string()
            } else {
                format!("The IDE's MCP server didn't answer: {e}")
            }
        })?;
        if let Some(session) = response
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            if let Ok(mut s) = self.session.lock() {
                *s = Some(session.to_string());
            }
        }
        let status = response.status();
        if status == reqwest::StatusCode::ACCEPTED {
            return Ok(());
        }
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            let text: String = text.chars().take(300).collect();
            return Err(format!(
                "The IDE's MCP server answered {}{}",
                status.as_u16(),
                if text.trim().is_empty() {
                    String::new()
                } else {
                    format!(": {}", text.trim())
                }
            ));
        }
        let kind = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let deliver = |message: String| {
            if let Some(line) = one_line(&message) {
                if initialize {
                    self.note_protocol(&line);
                }
                (self.out)(line);
            }
        };
        if kind.starts_with("text/event-stream") {
            let mut parser = SseParser::default();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk =
                    chunk.map_err(|e| format!("The IDE's MCP server's answer broke off: {e}"))?;
                for data in parser.feed(&chunk) {
                    deliver(data);
                }
            }
        } else {
            let text = response.text().await.map_err(|e| e.to_string())?;
            for message in messages_in_json(&text) {
                deliver(message);
            }
        }
        Ok(())
    }

    /// The protocol version the server chose at initialize (sent with every later request).
    fn note_protocol(&self, line: &str) {
        let version = serde_json::from_str::<Value>(line).ok().and_then(|v| {
            v.pointer("/result/protocolVersion")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
        if let (Some(version), Ok(mut p)) = (version, self.protocol.lock()) {
            *p = version;
        }
    }

    /// Keeps the standalone GET stream open until the run ends (the task is aborted then).
    pub async fn listen(self: Arc<Self>) {
        let mut last_id: Option<String> = None;
        let mut retry_ms: Option<u64> = None;
        let mut failures = 0u32;
        loop {
            let protocol = self.protocol.lock().map(|p| p.clone()).unwrap_or_default();
            let mut request = self
                .http
                .get(self.url.clone())
                .header("Authorization", &self.auth)
                .header("Accept", "text/event-stream")
                .header("MCP-Protocol-Version", protocol);
            if let Some(session) = self.session() {
                request = request.header("Mcp-Session-Id", session);
            }
            if let Some(id) = &last_id {
                request = request.header("Last-Event-ID", id);
            }
            let mut lasted = false;
            if let Ok(response) = request.send().await {
                let kind = response
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                match stream_answer(response.status().as_u16(), &kind) {
                    StreamAnswer::Unsupported => return,
                    StreamAnswer::Stop => {
                        eprintln!(
                            "{FLAG}: the server's message stream closed ({})",
                            response.status().as_u16()
                        );
                        return;
                    }
                    StreamAnswer::Retry => {}
                    StreamAnswer::Open => {
                        let opened = tokio::time::Instant::now();
                        let mut parser = SseParser::default();
                        let mut body = response.bytes_stream();
                        while let Some(Ok(chunk)) = body.next().await {
                            for data in parser.feed(&chunk) {
                                if let Some(line) = one_line(&data) {
                                    (self.out)(line);
                                }
                            }
                            if parser.last_id.is_some() {
                                last_id.clone_from(&parser.last_id);
                            }
                            if parser.retry_ms.is_some() {
                                retry_ms = parser.retry_ms;
                            }
                        }
                        lasted = opened.elapsed() >= SHORT_STREAM;
                    }
                }
            }
            if lasted {
                failures = 0;
            } else {
                failures += 1;
                if failures >= MAX_STREAM_FAILURES {
                    eprintln!("{FLAG}: the server's message stream stopped answering");
                    return;
                }
            }
            tokio::time::sleep(backoff(failures.saturating_sub(1), retry_ms)).await;
        }
    }

    /// Ends the session on the server (the agent went away).
    pub async fn close(&self) {
        if let Some(session) = self.session() {
            let _ = self
                .http
                .delete(self.url.clone())
                .timeout(Duration::from_secs(5))
                .header("Authorization", &self.auth)
                .header("Mcp-Session-Id", session)
                .send()
                .await;
        }
    }

    /// Forwards every line until `lines` ends: initialize and notifications in order, other
    /// messages side by side.
    pub async fn pump(self: Arc<Self>, mut lines: tokio::sync::mpsc::UnboundedReceiver<String>) {
        let mut running = Vec::new();
        let mut listener: Option<tokio::task::JoinHandle<()>> = None;
        while let Some(line) = lines.recv().await {
            match classify(&line) {
                Some((Some(_), false)) => {
                    let me = self.clone();
                    running.push(tokio::spawn(async move { me.forward(line).await }));
                }
                _ => {
                    let initialized = is_initialized(&line);
                    self.forward(line).await;
                    // Initialized (its POST answered, so the session is known): the server's
                    // own messages have a stream to come on from now on.
                    if initialized && !self.listening.swap(true, Ordering::SeqCst) {
                        listener = Some(tokio::spawn(self.clone().listen()));
                    }
                }
            }
            running.retain(|t: &tokio::task::JoinHandle<()>| !t.is_finished());
        }
        for task in running {
            task.abort();
        }
        if let Some(task) = listener {
            task.abort();
        }
        self.close().await;
    }
}

fn run(url: &str, token: &str) -> i32 {
    let url = match check_url(url) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("{FLAG}: {e}");
            return 2;
        }
    };
    if token.is_empty() {
        eprintln!("{FLAG}: {TOKEN_ENV} isn't set");
        return 2;
    }
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{FLAG}: {e}");
            return 1;
        }
    };
    let stdout = Arc::new(Mutex::new(std::io::stdout()));
    let out: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |line: String| {
        if let Ok(mut s) = stdout.lock() {
            let _ = s.write_all(line.as_bytes());
            let _ = s.write_all(b"\n");
            let _ = s.flush();
        }
    });
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    // stdin is read on a thread of its own (a blocking read; tokio's stdin isn't built here).
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut reader = stdin.lock();
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader
                .by_ref()
                .take(MAX_LINE as u64 + 1)
                .read_until(b'\n', &mut buf)
            {
                Ok(0) | Err(_) => break,
                Ok(_) if buf.len() > MAX_LINE => {
                    eprintln!("{FLAG}: a message over 16 MB was skipped");
                    // The rest of that line is skipped too, unless the newline was already read
                    // (a line of exactly the limit): then the next line is a message of its own.
                    if buf.last() == Some(&b'\n') {
                        continue;
                    }
                    // Skipped without keeping it: reading the rest into a buffer held all of an
                    // endless line in memory, the very thing the limit is for.
                    if reader.skip_until(b'\n').is_err() {
                        break;
                    }
                }
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf).trim().to_string();
                    if !line.is_empty() && tx.send(line).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let proxy = Arc::new(Proxy::new(url, token, out));
    runtime.block_on(proxy.pump(rx));
    0
}

#[cfg(test)]
#[path = "stdio_proxy_tests.rs"]
mod tests;
