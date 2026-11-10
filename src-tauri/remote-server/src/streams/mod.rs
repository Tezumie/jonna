//! Streams: the programs the server runs (`proc.spawn`) and the TCP connections it makes
//! (`tcp.connect`). Each has an id; its output goes out as `stream.data` in chunks of up to
//! 64 KiB, then one `stream.exit` after the last of it; the app's `stream.write`,
//! `stream.closeStdin`, `stream.resize` and `stream.kill` notifications act on it.
//!
//! Every program gets its own process group (a terminal its own session), so `stream.kill`
//! reaches what it started too, and when the server ends (its input closed) everything it
//! started is killed.

pub mod ports;
mod tcp;
#[cfg(unix)]
mod unix;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::outbox::Outbox;

/// The most one `stream.data` carries.
const CHUNK: usize = 64 * 1024;
/// How long output readers may keep going after the program exited: a pipe stays open as long
/// as any process holding it lives, so a backgrounded grandchild would otherwise hold back
/// `stream.exit` forever.
const READER_GRACE: Duration = Duration::from_secs(2);
/// How long programs get to end on SIGTERM / SIGHUP when the server ends, before SIGKILL.
const SHUTDOWN_GRACE: Duration = Duration::from_millis(500);

/// Run once a request's response is queued: a stream's first data must never reach the app
/// before the id that names it.
pub type Starter = Box<dyn FnOnce() + Send>;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnParams {
    #[serde(default)]
    pub cwd: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Variables to set; a null value unsets one.
    #[serde(default)]
    pub env: HashMap<String, Option<String>>,
    pub pty: Option<PtySize>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[cfg_attr(not(unix), allow(dead_code))]
pub struct PtySize {
    pub rows: u16,
    pub cols: u16,
}

pub(crate) enum Input {
    Data(Vec<u8>),
    Close,
}

enum Kind {
    Proc {
        pid: u32,
        #[cfg(unix)]
        pty: Option<Arc<unix::Pty>>,
    },
    Tcp(std::net::TcpStream),
}

struct Stream {
    input: Sender<Input>,
    kind: Kind,
}

/// Sends a stream's data and its one exit, in order: once the exit is out, later data (from a
/// reader past its grace period) is dropped.
pub(crate) struct Emitter {
    out: Outbox,
    id: u64,
    exited: Mutex<bool>,
}

impl Emitter {
    fn new(out: Outbox, id: u64) -> Arc<Self> {
        Arc::new(Self {
            out,
            id,
            exited: Mutex::new(false),
        })
    }

    /// False once the stream has exited (the reader can stop).
    fn data(&self, fd: u8, bytes: &[u8]) -> bool {
        let Ok(exited) = self.exited.lock() else {
            return false;
        };
        if *exited {
            return false;
        }
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        self.out.notify(
            "stream.data",
            json!({ "stream": self.id, "fd": fd, "data": data }),
        );
        true
    }

    fn exit(&self, code: Option<i32>, signal: Option<i32>) {
        let Ok(mut exited) = self.exited.lock() else {
            return;
        };
        if !*exited {
            *exited = true;
            self.out.notify(
                "stream.exit",
                json!({ "stream": self.id, "code": code, "signal": signal }),
            );
        }
    }
}

/// Reads `source` to its end into `stream.data` (a terminal's EIO when its programs are gone
/// counts as the end).
pub(crate) fn pump(mut source: impl Read, fd: u8, emitter: &Emitter) {
    let mut buf = vec![0u8; CHUNK];
    loop {
        match source.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if !emitter.data(fd, &buf[..n]) {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
}

/// Writes what the app sends to `sink`, in order, until the stream goes away; `Close` ends
/// the input (`close` says how: drop the pipe, half-close the socket, or nothing).
pub(crate) fn feed<W: Write>(mut sink: W, rx: Receiver<Input>, close: impl Fn(&mut W) -> bool) {
    while let Ok(input) = rx.recv() {
        match input {
            Input::Data(bytes) => {
                if sink.write_all(&bytes).and_then(|()| sink.flush()).is_err() {
                    // The program stopped reading; what follows can't reach it either.
                    break;
                }
            }
            Input::Close => {
                if close(&mut sink) {
                    break;
                }
            }
        }
    }
}

#[derive(Clone)]
pub struct Streams {
    out: Outbox,
    next: Arc<AtomicU64>,
    live: Arc<Mutex<HashMap<u64, Arc<Stream>>>>,
    /// Process groups (or terminal sessions) whose first program exited while others in them
    /// still ran (a server started in the background): killed when the server ends.
    orphans: Arc<Mutex<Vec<(u32, bool)>>>,
}

impl Streams {
    pub fn new(out: Outbox) -> Self {
        Self {
            out,
            next: Arc::new(AtomicU64::new(1)),
            live: Arc::new(Mutex::new(HashMap::new())),
            orphans: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn next_id(&self) -> u64 {
        self.next.fetch_add(1, Ordering::Relaxed)
    }

    fn add(&self, id: u64, stream: Stream) {
        if let Ok(mut live) = self.live.lock() {
            live.insert(id, Arc::new(stream));
        }
    }

    fn get(&self, id: u64) -> Option<Arc<Stream>> {
        self.live.lock().ok().and_then(|l| l.get(&id).cloned())
    }

    fn remove(&self, id: u64) {
        if let Ok(mut live) = self.live.lock() {
            live.remove(&id);
        }
    }

    /// `proc.spawn`: starts a program (or the login shell, `program` ""), returns
    /// `{ stream, pid }` and what starts its output once that is sent.
    pub fn spawn(&self, params: SpawnParams) -> Result<(Value, Starter)> {
        let home = crate::system::home();
        let cwd = match params.cwd.trim() {
            "" => home.clone(),
            dir => crate::system::expand_home(dir, &home),
        };
        if !Path::new(&cwd).is_dir() {
            return Err(Error::Exec(format!("no such folder: {cwd}")));
        }
        let (program, args) = if params.program.is_empty() {
            let mut args = vec!["-l".to_string()];
            args.extend(params.args);
            (crate::system::login_shell(), args)
        } else {
            (params.program, params.args)
        };
        let mut cmd = Command::new(&program);
        cmd.args(&args).current_dir(&cwd).env_clear();
        cmd.envs(crate::system::base_env());
        let terminal = params.pty.is_some();
        if terminal {
            // What a terminal's programs expect when the app doesn't say otherwise.
            let base = crate::system::base_env();
            let has =
                |k: &str| params.env.contains_key(k) || base.contains_key(std::ffi::OsStr::new(k));
            if !params.env.contains_key("TERM") {
                cmd.env("TERM", "xterm-256color");
            }
            if !has("LANG") && !has("LC_ALL") {
                cmd.env("LANG", "C.UTF-8");
            }
        }
        for (key, value) in &params.env {
            match value {
                Some(v) => cmd.env(key, v),
                None => cmd.env_remove(key),
            };
        }
        let not_started = |e: std::io::Error| Error::Exec(format!("couldn't start {program}: {e}"));
        let id = self.next_id();
        match params.pty {
            None => {
                cmd.stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                #[cfg(unix)]
                unix::own_group(&mut cmd);
                let child = spawn_child(cmd).map_err(not_started)?;
                Ok(self.start_pipes(id, child))
            }
            #[cfg(unix)]
            Some(size) => {
                let pty = Arc::new(unix::Pty::open(size)?);
                pty.attach(&mut cmd)?;
                let child = spawn_child(cmd).map_err(not_started)?;
                // The terminal's other end belongs to the program now: with our copy closed, the
                // reader sees the end once the program's side is gone.
                pty.close_slave();
                self.start_pty(id, child, pty)
            }
            #[cfg(not(unix))]
            Some(_) => {
                let _ = cmd;
                Err(Error::Pty("terminals need a Unix server".into()))
            }
        }
    }

    fn start_pipes(&self, id: u64, mut child: Child) -> (Value, Starter) {
        let pid = child.id();
        let (tx, rx) = channel();
        self.add(
            id,
            Stream {
                input: tx,
                kind: Kind::Proc {
                    pid,
                    #[cfg(unix)]
                    pty: None,
                },
            },
        );
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let emitter = Emitter::new(self.out.clone(), id);
        let streams = self.clone();
        let starter: Starter = Box::new(move || {
            if let Some(stdin) = stdin {
                // Closing standard input ends the feed, which drops the pipe: the program reads
                // its end.
                std::thread::spawn(move || feed(stdin, rx, |_| true));
            }
            let mut readers = Vec::new();
            if let Some(out) = stdout {
                let e = emitter.clone();
                readers.push(std::thread::spawn(move || pump(out, 1, &e)));
            }
            if let Some(err) = stderr {
                let e = emitter.clone();
                readers.push(std::thread::spawn(move || pump(err, 2, &e)));
            }
            std::thread::spawn(move || streams.wait(id, child, readers, emitter, false));
        });
        (json!({ "stream": id, "pid": pid }), starter)
    }

    #[cfg(unix)]
    fn start_pty(&self, id: u64, child: Child, pty: Arc<unix::Pty>) -> Result<(Value, Starter)> {
        let pid = child.id();
        let reader = pty.reader()?;
        let writer = pty.writer()?;
        let (tx, rx) = channel();
        self.add(
            id,
            Stream {
                input: tx,
                kind: Kind::Proc {
                    pid,
                    pty: Some(pty),
                },
            },
        );
        let emitter = Emitter::new(self.out.clone(), id);
        let streams = self.clone();
        let starter: Starter = Box::new(move || {
            // A terminal has no end of input to close (Ctrl+D is the program's business).
            std::thread::spawn(move || feed(writer, rx, |_| false));
            let e = emitter.clone();
            let readers = vec![std::thread::spawn(move || pump(reader, 1, &e))];
            std::thread::spawn(move || streams.wait(id, child, readers, emitter, true));
        });
        Ok((json!({ "stream": id, "pid": pid }), starter))
    }

    /// Waits for the program, then for its output (a while), then sends its exit.
    fn wait(
        &self,
        id: u64,
        mut child: Child,
        readers: Vec<JoinHandle<()>>,
        emitter: Arc<Emitter>,
        terminal: bool,
    ) {
        let status = child.wait();
        let deadline = Instant::now() + READER_GRACE;
        let mut pending = readers;
        while !pending.is_empty() && Instant::now() < deadline {
            let (done, rest): (Vec<_>, Vec<_>) = pending.into_iter().partition(|r| r.is_finished());
            for r in done {
                let _ = r.join();
            }
            pending = rest;
            if !pending.is_empty() {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        let (code, signal) = match &status {
            Ok(s) => exit_parts(s),
            Err(_) => (None, None),
        };
        // Out of the table first: once the app has the exit, the stream's id is gone here too.
        self.remove(id);
        emitter.exit(code, signal);
        if group_alive(child.id(), terminal) {
            if let Ok(mut orphans) = self.orphans.lock() {
                orphans.push((child.id(), terminal));
            }
        }
    }

    /// `tcp.connect`.
    pub fn connect(&self, host: &str, port: u16) -> Result<(Value, Starter)> {
        let socket = tcp::connect(host, port)?;
        let id = self.next_id();
        let (tx, rx) = channel();
        let reader = socket.try_clone()?;
        let writer = socket.try_clone()?;
        self.add(
            id,
            Stream {
                input: tx,
                kind: Kind::Tcp(socket),
            },
        );
        let emitter = Emitter::new(self.out.clone(), id);
        let streams = self.clone();
        let starter: Starter = Box::new(move || {
            std::thread::spawn(move || {
                feed(writer, rx, |s| {
                    let _ = s.shutdown(std::net::Shutdown::Write);
                    true
                })
            });
            std::thread::spawn(move || {
                pump(&reader, 1, &emitter);
                streams.remove(id);
                emitter.exit(Some(0), None);
            });
        });
        Ok((json!({ "stream": id }), starter))
    }

    /// The app's notifications about a stream. Unknown streams (already ended) are ignored.
    pub fn notification(&self, method: &str, params: &Value) -> Result<()> {
        let id = params
            .get("stream")
            .and_then(Value::as_u64)
            .ok_or_else(|| Error::Invalid(format!("{method} needs a stream")))?;
        let Some(stream) = self.get(id) else {
            return Ok(());
        };
        match method {
            "stream.write" => {
                let data = params.get("data").and_then(Value::as_str).unwrap_or("");
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .map_err(|e| Error::Invalid(format!("bad base64: {e}")))?;
                let _ = stream.input.send(Input::Data(bytes));
            }
            "stream.closeStdin" => {
                let _ = stream.input.send(Input::Close);
            }
            "stream.resize" => {
                let rows = params.get("rows").and_then(Value::as_u64).unwrap_or(24);
                let cols = params.get("cols").and_then(Value::as_u64).unwrap_or(80);
                stream.resize(clamp_u16(rows), clamp_u16(cols))?;
            }
            "stream.kill" => {
                let signal = signal_name(params.get("signal"));
                stream.kill(&signal);
            }
            other => return Err(Error::Protocol(format!("unknown notification {other}"))),
        }
        Ok(())
    }

    /// Ends everything the server started (its input closed, or `shutdown`): programs get
    /// SIGTERM (terminals SIGHUP) and a moment to end, then SIGKILL; connections close.
    pub fn shutdown(&self) {
        let streams: Vec<Arc<Stream>> = self
            .live
            .lock()
            .map(|l| l.values().cloned().collect())
            .unwrap_or_default();
        let mut procs = Vec::new();
        for stream in &streams {
            match &stream.kind {
                Kind::Tcp(socket) => {
                    let _ = socket.shutdown(std::net::Shutdown::Both);
                }
                Kind::Proc { .. } => {
                    stream.kill(if stream.is_terminal() { "HUP" } else { "TERM" });
                    procs.push(stream.clone());
                }
            }
        }
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        while Instant::now() < deadline && self.live_procs() > 0 {
            std::thread::sleep(Duration::from_millis(20));
        }
        for stream in &procs {
            stream.kill("KILL");
        }
        let orphans = self.orphans.lock().map(|o| o.clone()).unwrap_or_default();
        for (pid, terminal) in orphans {
            kill_tree(pid, terminal, None, "KILL");
        }
    }

    fn live_procs(&self) -> usize {
        self.live
            .lock()
            .map(|l| {
                l.values()
                    .filter(|s| matches!(s.kind, Kind::Proc { .. }))
                    .count()
            })
            .unwrap_or(0)
    }
}

impl Stream {
    fn is_terminal(&self) -> bool {
        match &self.kind {
            #[cfg(unix)]
            Kind::Proc { pty, .. } => pty.is_some(),
            #[cfg(not(unix))]
            Kind::Proc { .. } => false,
            Kind::Tcp(_) => false,
        }
    }

    fn kill(&self, signal: &str) {
        match &self.kind {
            Kind::Tcp(socket) => {
                let _ = socket.shutdown(std::net::Shutdown::Both);
            }
            #[cfg(unix)]
            Kind::Proc { pid, pty } => {
                kill_tree(*pid, pty.is_some(), pty.as_deref(), signal);
            }
            #[cfg(not(unix))]
            Kind::Proc { pid } => kill_tree(*pid, false, None, signal),
        }
    }

    fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        match &self.kind {
            #[cfg(unix)]
            Kind::Proc { pty: Some(pty), .. } => pty.resize(rows, cols),
            _ => {
                let _ = (rows, cols);
                Ok(())
            }
        }
    }
}

/// Spawns on the one long-lived thread that starts programs (Linux ties a child's "kill me
/// when my parent dies" to the thread that started it, not the process).
fn spawn_child(cmd: Command) -> std::io::Result<Child> {
    #[cfg(unix)]
    {
        unix::spawn_on_spawner(cmd)
    }
    #[cfg(not(unix))]
    {
        let mut cmd = cmd;
        cmd.spawn()
    }
}

#[cfg(unix)]
type PtyRef<'a> = Option<&'a unix::Pty>;
#[cfg(not(unix))]
type PtyRef<'a> = Option<&'a ()>;

/// Signals a program's whole process group, or for a terminal its whole session.
fn kill_tree(pid: u32, terminal: bool, pty: PtyRef<'_>, signal: &str) {
    #[cfg(unix)]
    unix::kill_tree(pid, terminal, pty, signal);
    #[cfg(not(unix))]
    {
        let _ = (terminal, pty, signal);
        // Only the unit tests run the server on Windows.
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Signals process group `pid` (the login-shell probe, which got its own).
pub fn kill_group(pid: u32, signal: &str) {
    kill_tree(pid, false, None, signal);
}

/// Whether anything still runs in process group (or session) `pid`.
fn group_alive(pid: u32, terminal: bool) -> bool {
    #[cfg(target_os = "linux")]
    {
        unix::group_alive(pid, terminal)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (pid, terminal);
        false
    }
}

/// `(pid, process group, session)` from a `/proc/<pid>/stat` line. The program name in
/// parentheses may hold spaces and parentheses itself, so fields are counted after the last `)`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_stat(text: &str) -> Option<(i32, i32, i32)> {
    let (head, tail) = text.rsplit_once(')')?;
    let pid = head.split_whitespace().next()?.parse().ok()?;
    let mut fields = tail.split_whitespace();
    // state, ppid, pgrp, session
    let group = fields.nth(2)?.parse().ok()?;
    let session = fields.next()?.parse().ok()?;
    Some((pid, group, session))
}

/// Every process's `(pid, group, session)`.
#[cfg(target_os = "linux")]
fn proc_stats() -> Vec<(i32, i32, i32)> {
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    dir.flatten()
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| n.bytes().all(|b| b.is_ascii_digit()))
        })
        .filter_map(|e| std::fs::read_to_string(e.path().join("stat")).ok())
        .filter_map(|text| parse_stat(&text))
        .collect()
}

fn exit_parts(status: &std::process::ExitStatus) -> (Option<i32>, Option<i32>) {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        (status.code(), status.signal())
    }
    #[cfg(not(unix))]
    {
        (status.code(), None)
    }
}

fn clamp_u16(n: u64) -> u16 {
    u16::try_from(n.clamp(1, u64::from(u16::MAX))).unwrap_or(u16::MAX)
}

/// `stream.kill`'s signal: a name (`TERM`, `SIGINT`) or a number; TERM by default.
fn signal_name(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) if !s.trim().is_empty() => {
            let s = s.trim().to_ascii_uppercase();
            s.strip_prefix("SIG").unwrap_or(&s).to_string()
        }
        Some(Value::Number(n)) => n.to_string(),
        _ => "TERM".into(),
    }
}

/// The signal number for a name from `signal_name` (or a number); None for an unknown one.
#[cfg_attr(not(unix), allow(dead_code))]
pub fn signal_number(name: &str) -> Option<i32> {
    if let Ok(n) = name.parse::<i32>() {
        return (1..=64).contains(&n).then_some(n);
    }
    // The Linux numbers on every architecture the server is built for (x86_64, aarch64).
    Some(match name {
        "HUP" => 1,
        "INT" => 2,
        "QUIT" => 3,
        "KILL" => 9,
        "USR1" => 10,
        "USR2" => 12,
        "TERM" => 15,
        "CONT" => 18,
        "STOP" => 19,
        "TSTP" => 20,
        "WINCH" => 28,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outbox::Out;

    #[test]
    fn signal_names_and_numbers() {
        assert_eq!(signal_name(None), "TERM");
        assert_eq!(signal_name(Some(&json!("sigint"))), "INT");
        assert_eq!(signal_name(Some(&json!(9))), "9");
        assert_eq!(signal_number("INT"), Some(2));
        assert_eq!(signal_number("9"), Some(9));
        assert_eq!(signal_number("0"), None);
        assert_eq!(signal_number("BOGUS"), None);
        assert_eq!(clamp_u16(0), 1);
        assert_eq!(clamp_u16(1 << 40), u16::MAX);
    }

    #[test]
    fn reads_proc_stat_lines() {
        assert_eq!(
            parse_stat("4242 (my (odd) prog) S 1 4242 4000 34816 4242 4194560 0"),
            Some((4242, 4242, 4000))
        );
        assert_eq!(parse_stat("garbage"), None);
    }

    #[test]
    fn data_never_follows_the_exit() -> Result<()> {
        let (out, rx) = Outbox::new();
        let emitter = Emitter::new(out, 4);
        assert!(emitter.data(1, b"hi"));
        emitter.exit(Some(0), None);
        assert!(!emitter.data(1, b"late"));
        emitter.exit(Some(1), None);
        let mut messages = Vec::new();
        while let Ok(Out::Frame(bytes)) = rx.try_recv() {
            messages.push(serde_json::from_slice::<Value>(&bytes)?);
        }
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["params"]["data"], "aGk=");
        assert_eq!(messages[1]["notify"], "stream.exit");
        assert_eq!(messages[1]["params"]["code"], 0);
        Ok(())
    }

    #[test]
    fn tcp_streams_carry_bytes_both_ways() -> Result<()> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let echo = std::thread::spawn(move || -> std::io::Result<()> {
            let (mut conn, _) = listener.accept()?;
            let mut buf = Vec::new();
            conn.read_to_end(&mut buf)?;
            conn.write_all(&buf)?;
            Ok(())
        });
        let (out, rx) = Outbox::new();
        let streams = Streams::new(out);
        let (value, start) = streams.connect("127.0.0.1", port)?;
        start();
        let id = value["stream"].clone();
        streams.notification("stream.write", &json!({ "stream": id, "data": "cGluZw==" }))?;
        streams.notification("stream.closeStdin", &json!({ "stream": id }))?;
        let mut got = Vec::new();
        // Generous: a busy machine (a UI suite beside it) can stall the echo thread for seconds.
        while let Ok(Out::Frame(bytes)) = rx.recv_timeout(Duration::from_secs(30)) {
            let message: Value = serde_json::from_slice(&bytes)?;
            got.push(message["notify"].as_str().unwrap_or("").to_string());
            if message["notify"] == "stream.data" {
                assert_eq!(message["params"]["data"], "cGluZw==");
            }
            if message["notify"] == "stream.exit" {
                break;
            }
        }
        assert_eq!(got, ["stream.data", "stream.exit"]);
        let _ = echo.join();
        assert!(streams.get(id.as_u64().unwrap_or(0)).is_none());
        Ok(())
    }
}
