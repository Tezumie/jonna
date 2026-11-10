//! One connection to a remote server (docs/remote.md): requests with ids, answered in any order
//! (`call`, `call_blocking`), notifications both ways, and streams (a program's output, a TCP
//! connection's bytes) routed to whoever opened them. A reader thread owns the server's output;
//! writes take a lock so frames never interleave. When the connection ends every waiting call
//! fails, every stream hears `Lost`, and `on_lost` runs once.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};

use super::frame;
use crate::error::{Error, Result};

/// How long a request waits for its answer unless the caller says otherwise.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);

/// What a stream's owner hears.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEvent {
    /// Output: `fd` 1 (standard output, a terminal, a TCP connection) or 2.
    Data { fd: u8, bytes: Vec<u8> },
    /// The program ended (`code`, or the `signal` that ended it); a TCP connection closed.
    Exit {
        code: Option<i32>,
        signal: Option<i32>,
    },
    /// The connection to the remote ended first.
    Lost(String),
}

impl StreamEvent {
    /// A process exit code for `Exit` as a shell reports it (a signal is 128 + its number).
    pub fn exit_code(code: Option<i32>, signal: Option<i32>) -> i32 {
        match (code, signal) {
            (Some(c), _) => c,
            (None, Some(s)) => 128 + s,
            (None, None) => 255,
        }
    }
}

/// Server notifications that aren't a stream's (`index.changes`, `search.event`, `watch.batch`).
pub type Notify = Arc<dyn Fn(&str, &Value) + Send + Sync>;

/// Called once when the connection ends, with why.
pub type OnLost = Box<dyn FnOnce(String) + Send>;

type Reply = Result<Value>;

enum Responder {
    Blocking(mpsc::Sender<Reply>),
    Async(tokio::sync::oneshot::Sender<Reply>),
}

impl Responder {
    fn send(self, reply: Reply) {
        match self {
            Responder::Blocking(tx) => {
                let _ = tx.send(reply);
            }
            Responder::Async(tx) => {
                let _ = tx.send(reply);
            }
        }
    }
}

struct Pending {
    responder: Responder,
    /// The request opens a stream (`proc.spawn`, `tcp.connect`): its events go here, registered
    /// by the reader before the response is handed on, so no output can arrive unrouted.
    stream: Option<mpsc::Sender<StreamEvent>>,
}

pub struct RemoteConn {
    writer: Mutex<Box<dyn Write + Send>>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Pending>>,
    streams: Mutex<HashMap<u64, mpsc::Sender<StreamEvent>>>,
    alive: AtomicBool,
    /// Why it ended (once it has).
    lost: Mutex<Option<String>>,
    /// The transport (ssh, wsl.exe), killed by `close`.
    child: Mutex<Option<Child>>,
}

/// A remote error (`{ code, message }`) as the app's own, so the frontend tells it apart the
/// same way. The server's messages already carry the app's wording ("invalid argument: …").
pub fn remote_error(error: &Value) -> Error {
    let code = error.get("code").and_then(Value::as_str).unwrap_or("Io");
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("the remote failed")
        .to_string();
    let strip = |prefix: &str| message.strip_prefix(prefix).unwrap_or(&message).to_string();
    let io = |kind: std::io::ErrorKind| Error::Io(std::io::Error::new(kind, message.clone()));
    match code {
        "NotFound" => io(std::io::ErrorKind::NotFound),
        "AlreadyExists" => io(std::io::ErrorKind::AlreadyExists),
        "PermissionDenied" => io(std::io::ErrorKind::PermissionDenied),
        "IsADirectory" => io(std::io::ErrorKind::IsADirectory),
        "NotADirectory" => io(std::io::ErrorKind::NotADirectory),
        "Io" => io(std::io::ErrorKind::Other),
        "OutsideScope" => Error::OutsideScope(strip("path is outside the open workspace: ")),
        "NoWorkspace" => Error::NoWorkspace,
        "Invalid" => Error::Invalid(strip("invalid argument: ")),
        "Pty" => Error::Pty(strip("terminal error: ")),
        "Watch" => Error::Watch(strip("watch error: ")),
        "Protocol" => Error::Invalid(format!("the remote server can't do this: {message}")),
        _ => Error::Exec(message),
    }
}

impl RemoteConn {
    /// Starts speaking the protocol over `reader` / `writer` (the transport's output and input,
    /// the setup already done). `child` is the transport process, if any.
    pub fn start(
        child: Option<Child>,
        reader: Box<dyn Read + Send>,
        writer: Box<dyn Write + Send>,
        notify: Notify,
        on_lost: OnLost,
    ) -> Result<Arc<Self>> {
        let conn = Arc::new(RemoteConn {
            writer: Mutex::new(writer),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
            alive: AtomicBool::new(true),
            lost: Mutex::new(None),
            child: Mutex::new(child),
        });
        let reading = conn.clone();
        std::thread::Builder::new()
            .name("remote-read".into())
            .spawn(move || {
                let mut reader = reader;
                let reason = loop {
                    match frame::read_frame(&mut reader) {
                        Ok(Some(body)) => match serde_json::from_slice::<Value>(&body) {
                            Ok(message) => reading.dispatch(message, &notify),
                            // The protocol says to skip it; nothing else can be done.
                            Err(_) => continue,
                        },
                        Ok(None) => break "the connection closed".to_string(),
                        Err(e) => break format!("the connection failed ({e})"),
                    }
                };
                let reason = reading.end(reason);
                on_lost(reason);
            })?;
        Ok(conn)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    /// Why the connection ended; None while it's up.
    pub fn lost_reason(&self) -> Option<String> {
        self.lost.lock().ok().and_then(|l| l.clone())
    }

    /// Ends the connection: the transport is killed, which ends the reader (and with it every
    /// call and stream). The server ends what it started when its input closes.
    pub fn close(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut c) = child.take() {
                let _ = c.kill();
                // Reaped off the caller's thread: ssh can take a moment to go.
                std::thread::spawn(move || {
                    let _ = c.wait();
                });
            }
        }
        // Without a child (tests), closing the input ends the server and so the reader.
        if let Ok(mut w) = self.writer.lock() {
            *w = Box::new(std::io::sink());
        }
    }

    /// The reader's end: every waiter fails, every stream is told, the reason is kept.
    fn end(&self, reason: String) -> String {
        let reason = self
            .child
            .lock()
            .ok()
            .and_then(|mut c| c.as_mut().and_then(|c| c.try_wait().ok().flatten()))
            .map(|status| format!("{reason} ({status})"))
            .unwrap_or(reason);
        let pending: Vec<Pending> = match self.pending.lock() {
            Ok(mut map) => {
                self.alive.store(false, Ordering::Release);
                map.drain().map(|(_, p)| p).collect()
            }
            Err(_) => Vec::new(),
        };
        if let Ok(mut lost) = self.lost.lock() {
            *lost = Some(reason.clone());
        }
        for p in pending {
            p.responder.send(Err(lost_error(&reason)));
        }
        let streams: Vec<mpsc::Sender<StreamEvent>> = self
            .streams
            .lock()
            .map(|mut s| s.drain().map(|(_, tx)| tx).collect())
            .unwrap_or_default();
        for tx in streams {
            let _ = tx.send(StreamEvent::Lost(reason.clone()));
        }
        reason
    }

    fn dispatch(&self, message: Value, notify: &Notify) {
        if let Some(id) = message.get("id").and_then(Value::as_u64) {
            let Some(pending) = self.pending.lock().ok().and_then(|mut p| p.remove(&id)) else {
                return; // timed out and forgotten
            };
            let reply = match message.get("error") {
                Some(error) if !error.is_null() => Err(remote_error(error)),
                _ => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
            };
            if let (Ok(result), Some(tx)) = (&reply, pending.stream) {
                if let Some(stream) = result.get("stream").and_then(Value::as_u64) {
                    if let Ok(mut streams) = self.streams.lock() {
                        streams.insert(stream, tx);
                    }
                }
            }
            pending.responder.send(reply);
            return;
        }
        let Some(method) = message.get("notify").and_then(Value::as_str) else {
            return;
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        match method {
            "stream.data" => {
                let Some(stream) = params.get("stream").and_then(Value::as_u64) else {
                    return;
                };
                let fd = params.get("fd").and_then(Value::as_u64).unwrap_or(1) as u8;
                let bytes = params
                    .get("data")
                    .and_then(Value::as_str)
                    .and_then(|d| base64::engine::general_purpose::STANDARD.decode(d).ok())
                    .unwrap_or_default();
                let gone = self
                    .streams
                    .lock()
                    .ok()
                    .and_then(|s| s.get(&stream).cloned())
                    .is_some_and(|tx| tx.send(StreamEvent::Data { fd, bytes }).is_err());
                if gone {
                    // Nobody listens any more (the relay went away): stop it there too.
                    if let Ok(mut s) = self.streams.lock() {
                        s.remove(&stream);
                    }
                    let _ =
                        self.notify("stream.kill", json!({ "stream": stream, "signal": "KILL" }));
                }
            }
            "stream.exit" => {
                let Some(stream) = params.get("stream").and_then(Value::as_u64) else {
                    return;
                };
                let code = params
                    .get("code")
                    .and_then(Value::as_i64)
                    .and_then(|c| i32::try_from(c).ok());
                let signal = params
                    .get("signal")
                    .and_then(Value::as_i64)
                    .and_then(|c| i32::try_from(c).ok());
                if let Some(tx) = self.streams.lock().ok().and_then(|mut s| s.remove(&stream)) {
                    let _ = tx.send(StreamEvent::Exit { code, signal });
                }
            }
            other => notify(other, &params),
        }
    }

    fn send(&self, message: &Value) -> Result<()> {
        if !self.is_alive() {
            return Err(lost_error(&self.lost_reason().unwrap_or_default()));
        }
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| Error::Exec("remote lock poisoned".into()))?;
        frame::write_json(&mut *writer, message)
            .map_err(|e| Error::Exec(format!("couldn't reach the remote: {e}")))
    }

    /// A notification to the server (`stream.write`, `stream.kill`, …).
    pub fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.send(&json!({ "notify": method, "params": params }))
    }

    /// A request whose answer nobody waits for (`shutdown` on the way out).
    pub fn fire(&self, method: &str, params: Value) -> Result<()> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.send(&json!({ "id": id, "method": method, "params": params }))
    }

    /// Writes bytes to a stream's input.
    pub fn write_stream(&self, stream: u64, bytes: &[u8]) -> Result<()> {
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        self.notify("stream.write", json!({ "stream": stream, "data": data }))
    }

    /// Forgets a stream's listener (its owner is done; the server's further output is dropped).
    pub fn forget_stream(&self, stream: u64) {
        if let Ok(mut s) = self.streams.lock() {
            s.remove(&stream);
        }
    }

    fn register(
        &self,
        responder: Responder,
        stream: Option<mpsc::Sender<StreamEvent>>,
    ) -> Result<u64> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| Error::Exec("remote lock poisoned".into()))?;
        // Checked under the lock `end` drains: a call can't slip in after the end and wait
        // forever.
        if !self.is_alive() {
            return Err(lost_error(&self.lost_reason().unwrap_or_default()));
        }
        pending.insert(id, Pending { responder, stream });
        Ok(id)
    }

    fn forget(&self, id: u64) {
        if let Ok(mut p) = self.pending.lock() {
            p.remove(&id);
        }
    }

    fn request(&self, id: u64, method: &str, params: Value) -> Result<()> {
        let sent = self.send(&json!({ "id": id, "method": method, "params": params }));
        if sent.is_err() {
            self.forget(id);
        }
        sent
    }

    /// A request from a thread that may block (git, the relay, the file index's callers).
    pub fn call_blocking(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let (tx, rx) = mpsc::channel();
        let id = self.register(Responder::Blocking(tx), None)?;
        self.request(id, method, params)?;
        wait_blocking(self, id, method, &rx, timeout)
    }

    /// A request that opens a stream: its events go to `events` from the first one on.
    pub fn open_stream_blocking(
        &self,
        method: &str,
        params: Value,
        events: mpsc::Sender<StreamEvent>,
        timeout: Duration,
    ) -> Result<Value> {
        let (tx, rx) = mpsc::channel();
        let id = self.register(Responder::Blocking(tx), Some(events))?;
        self.request(id, method, params)?;
        wait_blocking(self, id, method, &rx, timeout)
    }

    /// A request from async code (the IPC commands).
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        self.call_with(method, params, DEFAULT_TIMEOUT).await
    }

    pub async fn call_with(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let id = self.register(Responder::Async(tx), None)?;
        self.request(id, method, params)?;
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err(lost_error(&self.lost_reason().unwrap_or_default())),
            Err(_) => {
                self.forget(id);
                Err(timed_out(method))
            }
        }
    }
}

fn wait_blocking(
    conn: &RemoteConn,
    id: u64,
    method: &str,
    rx: &mpsc::Receiver<Reply>,
    timeout: Duration,
) -> Result<Value> {
    match rx.recv_timeout(timeout) {
        Ok(reply) => reply,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            conn.forget(id);
            Err(timed_out(method))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err(lost_error(&conn.lost_reason().unwrap_or_default()))
        }
    }
}

fn timed_out(method: &str) -> Error {
    Error::Exec(format!("the remote didn't answer in time ({method})"))
}

/// The error calls get once the connection is gone.
pub fn lost_error(reason: &str) -> Error {
    if reason.is_empty() {
        Error::Exec("Not connected to the remote (Disconnected).".into())
    } else {
        Error::Exec(format!(
            "The connection to the remote was lost (Disconnected): {reason}"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A server on the other end of two pipes: answers with `answer`, after `delay` for
    /// requests it's told to hold back.
    fn fake_server(
        mut from_app: std::io::PipeReader,
        mut to_app: std::io::PipeWriter,
        answer: impl Fn(&str, &Value) -> Vec<Value> + Send + 'static,
    ) {
        std::thread::spawn(move || {
            while let Ok(Some(message)) = frame::read_json(&mut from_app) {
                let method = message
                    .get("method")
                    .or_else(|| message.get("notify"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                for out in answer(&method, &message) {
                    if frame::write_json(&mut to_app, &out).is_err() {
                        return;
                    }
                }
            }
        });
    }

    type Seen = Arc<Mutex<Vec<(String, Value)>>>;

    fn connect(
        answer: impl Fn(&str, &Value) -> Vec<Value> + Send + 'static,
    ) -> (Arc<RemoteConn>, Seen, mpsc::Receiver<String>) {
        let (app_read, server_write) = std::io::pipe().unwrap();
        let (server_read, app_write) = std::io::pipe().unwrap();
        fake_server(server_read, server_write, answer);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let notes = seen.clone();
        let notify: Notify = Arc::new(move |m: &str, p: &Value| {
            notes.lock().unwrap().push((m.to_string(), p.clone()));
        });
        let (lost_tx, lost_rx) = mpsc::channel();
        let conn = RemoteConn::start(
            None,
            Box::new(app_read),
            Box::new(app_write),
            notify,
            Box::new(move |reason| {
                let _ = lost_tx.send(reason);
            }),
        )
        .unwrap();
        (conn, seen, lost_rx)
    }

    #[test]
    fn responses_find_their_requests_in_any_order() {
        // The first request's answer comes after the second's.
        let held: Arc<Mutex<Option<Value>>> = Arc::default();
        let (conn, _, _) = connect(move |method, message| {
            let id = message["id"].clone();
            match method {
                "slow" => {
                    *held.lock().unwrap() = Some(json!({ "id": id, "result": "slow" }));
                    vec![]
                }
                "fast" => {
                    let mut out = vec![json!({ "id": id, "result": "fast" })];
                    out.extend(held.lock().unwrap().take());
                    out
                }
                _ => vec![json!({ "id": id, "error": { "code": "NotFound", "message": "gone" } })],
            }
        });
        let slow = {
            let conn = conn.clone();
            std::thread::spawn(move || conn.call_blocking("slow", json!({}), DEFAULT_TIMEOUT))
        };
        std::thread::sleep(Duration::from_millis(100));
        let fast = conn
            .call_blocking("fast", json!({}), DEFAULT_TIMEOUT)
            .unwrap();
        assert_eq!(fast, "fast");
        assert_eq!(slow.join().unwrap().unwrap(), "slow");
        let err = conn
            .call_blocking("other", json!({}), DEFAULT_TIMEOUT)
            .unwrap_err();
        assert_eq!(err.code(), "NotFound");
        assert_eq!(err.to_string(), "gone");
    }

    #[test]
    fn stream_output_reaches_its_owner_and_other_notes_the_handler() {
        let (conn, seen, _) = connect(|method, message| {
            let id = message["id"].clone();
            match method {
                "proc.spawn" => vec![
                    json!({ "id": id, "result": { "stream": 7, "pid": 42 } }),
                    // Output right after the response is routed, not lost.
                    json!({ "notify": "stream.data", "params": { "stream": 7, "fd": 1, "data": "aGk=" } }),
                    json!({ "notify": "stream.data", "params": { "stream": 7, "fd": 2, "data": "IQ==" } }),
                    json!({ "notify": "stream.exit", "params": { "stream": 7, "code": null, "signal": 15 } }),
                    json!({ "notify": "watch.batch", "params": { "watcher": "", "dirs": [], "paths": [] } }),
                ],
                _ => vec![],
            }
        });
        let (tx, rx) = mpsc::channel();
        let started = conn
            .open_stream_blocking("proc.spawn", json!({}), tx, DEFAULT_TIMEOUT)
            .unwrap();
        assert_eq!(started["pid"], 42);
        let events: Vec<StreamEvent> = rx.iter().take(3).collect();
        assert_eq!(
            events,
            vec![
                StreamEvent::Data {
                    fd: 1,
                    bytes: b"hi".to_vec()
                },
                StreamEvent::Data {
                    fd: 2,
                    bytes: b"!".to_vec()
                },
                StreamEvent::Exit {
                    code: None,
                    signal: Some(15)
                },
            ]
        );
        assert_eq!(StreamEvent::exit_code(None, Some(15)), 143);
        for _ in 0..50 {
            if !seen.lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(seen.lock().unwrap()[0].0, "watch.batch");
    }

    #[test]
    fn a_lost_connection_fails_waiters_and_tells_streams() {
        let (conn, _, lost) = connect(|method, message| {
            let id = message["id"].clone();
            match method {
                "proc.spawn" => vec![json!({ "id": id, "result": { "stream": 1, "pid": 1 } })],
                _ => vec![], // never answered
            }
        });
        let (tx, rx) = mpsc::channel();
        conn.open_stream_blocking("proc.spawn", json!({}), tx, DEFAULT_TIMEOUT)
            .unwrap();
        let waiting = {
            let conn = conn.clone();
            std::thread::spawn(move || conn.call_blocking("hang", json!({}), DEFAULT_TIMEOUT))
        };
        std::thread::sleep(Duration::from_millis(100));
        conn.close();
        let err = waiting.join().unwrap().unwrap_err();
        assert!(err.to_string().contains("Disconnected"), "{err}");
        assert!(matches!(rx.recv().unwrap(), StreamEvent::Lost(_)));
        assert!(lost.recv_timeout(Duration::from_secs(5)).is_ok());
        assert!(!conn.is_alive());
        assert!(conn.call_blocking("x", json!({}), DEFAULT_TIMEOUT).is_err());
    }

    #[test]
    fn a_request_times_out_and_its_late_answer_is_dropped() {
        let (conn, _, _) = connect(|_, _| vec![]);
        let err = conn
            .call_blocking("never", json!({}), Duration::from_millis(50))
            .unwrap_err();
        assert!(err.to_string().contains("in time"));
        assert!(conn.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn remote_errors_keep_the_apps_codes_and_words() {
        let e = remote_error(
            &json!({ "code": "OutsideScope", "message": "path is outside the open workspace: /etc" }),
        );
        assert_eq!(e.code(), "OutsideScope");
        assert_eq!(e.to_string(), "path is outside the open workspace: /etc");
        let e = remote_error(&json!({ "code": "Invalid", "message": "invalid argument: bad" }));
        assert_eq!(e.to_string(), "invalid argument: bad");
        assert_eq!(
            remote_error(&json!({ "code": "AlreadyExists", "message": "x" })).code(),
            "AlreadyExists"
        );
        assert_eq!(
            remote_error(&json!({ "code": "Weird", "message": "x" })).code(),
            "Exec"
        );
    }
}
