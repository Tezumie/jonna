//! Remote development (D252, docs/remote.md): a window connected to one remote (`ssh:<host>`,
//! or `wsl:<distro>` for local development and the UI tests) works on a folder there. The IDE
//! starts the remote's server over the transport (`install.rs`, one sign-in), then speaks the
//! framed protocol to it (`connection.rs`). In a remote window the workspace's paths are the
//! remote's POSIX paths (`/home/me/app`): the IPC layer sends what touches them to the server
//! (`is_remote_path`), and programs (git, tasks, the agent's commands, language servers) start
//! through the relay (`relay.rs`, `command`), terminals as remote ptys (`pty.rs`). The app's own
//! files (settings, state, extensions) stay local.
//!
//! One remote per window, and every window is a process of its own: the remote is process-wide
//! (`active`), reachable from code that has no `AppState` (git's `command`).

pub mod connection;
pub mod docker;
pub mod frame;
pub mod fs;
pub mod install;
pub mod ports;
pub mod pty;
pub mod relay;
pub mod transport;

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::Manager;

use crate::error::{Error, Result};
use connection::RemoteConn;
pub use transport::{Authority, Kind};

/// How long the whole setup (sign-in prompts included) may take before it's given up.
const SETUP_TIMEOUT: Duration = Duration::from_secs(6 * 60);
/// Lines of ssh's and the server's standard error kept for `remote_log`.
const LOG_LINES: usize = 2000;

/// What the window's remote is (sent to the frontend after connecting).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub authority: String,
    pub label: String,
    pub os: String,
    pub arch: String,
    pub home: String,
    pub user: String,
    pub shell: String,
    pub version: String,
}

/// Progress, sign-in prompts and the end of the connection, on the connect call's channel.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RemoteEvent {
    Progress {
        message: String,
    },
    /// ssh asks something (a password, a passphrase, whether to trust a new host key):
    /// answered with `remote_askpass_answer(id, answer | null)`. `secret`: mask the input.
    Askpass {
        id: u64,
        prompt: String,
        secret: bool,
    },
    /// ssh stopped waiting for prompt `id` (it timed out): close it.
    AskpassCancel {
        id: u64,
    },
    Disconnected {
        reason: String,
    },
}

/// The connection's log: ssh's own messages and the server's standard error, and the steps.
#[derive(Default)]
pub struct Log {
    lines: Mutex<VecDeque<String>>,
}

impl Log {
    pub fn push(&self, line: &str) {
        if let Ok(mut lines) = self.lines.lock() {
            if lines.len() >= LOG_LINES {
                lines.pop_front();
            }
            lines.push_back(line.to_string());
        }
    }

    pub fn text(&self) -> String {
        self.lines
            .lock()
            .map(|l| l.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default()
    }

    /// The last few lines that say something (for an error message).
    fn tail(&self, since: usize) -> Vec<String> {
        self.lines
            .lock()
            .map(|l| {
                l.iter()
                    .skip(since)
                    .filter(|s| !s.trim().is_empty() && !s.starts_with("· "))
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .map(|v| v[v.len().saturating_sub(3)..].to_vec())
            .unwrap_or_default()
    }

    fn len(&self) -> usize {
        self.lines.lock().map(|l| l.len()).unwrap_or(0)
    }
}

pub struct Remote {
    pub authority: Authority,
    conn: RwLock<Option<Arc<RemoteConn>>>,
    info: RwLock<Option<RemoteInfo>>,
    pub log: Arc<Log>,
    relay: Mutex<Option<relay::Listener>>,
    pub ports: ports::Forwards,
    /// Searches running there, by the id sent with them.
    searches: Mutex<HashMap<String, Channel<crate::search::SearchEvent>>>,
    next_search: AtomicU64,
    /// The latest connect call's channel (progress, prompts, "disconnected").
    events: Mutex<Option<Channel<RemoteEvent>>>,
    /// Which connect the current connection belongs to: an older one's end is not news.
    generation: AtomicU64,
}

static ACTIVE: RwLock<Option<Arc<Remote>>> = RwLock::new(None);

/// The window's remote; None for a local window.
pub fn active() -> Option<Arc<Remote>> {
    ACTIVE.read().ok().and_then(|a| a.clone())
}

/// The window works on a remote (connected or not: its paths are still the remote's).
pub fn is_remote_window() -> bool {
    active().is_some()
}

/// Folders that stay local in a remote window on a Unix host (the app's own), set at startup.
static LOCAL_DIRS: RwLock<Vec<PathBuf>> = RwLock::new(Vec::new());

pub fn set_local_dirs(dirs: Vec<PathBuf>) {
    if let Ok(mut d) = LOCAL_DIRS.write() {
        *d = dirs;
    }
}

/// Whether `path` is on the window's remote (the one place that decides it). On Windows a
/// remote path is POSIX (starts with `/`, not `//`, which no Windows path does); elsewhere the
/// window is remote and the path isn't under the app's own folders.
pub fn is_remote_path(path: &str) -> bool {
    is_remote_path_in(
        is_remote_window(),
        path,
        &LOCAL_DIRS.read().map(|d| d.clone()).unwrap_or_default(),
    )
}

fn is_remote_path_in(remote_window: bool, path: &str, local_dirs: &[PathBuf]) -> bool {
    if !remote_window || !path.starts_with('/') || path.starts_with("//") {
        return false;
    }
    if cfg!(windows) {
        return true;
    }
    !local_dirs.iter().any(|d| Path::new(path).starts_with(d))
}

/// `dir` as a remote POSIX path, when it is one.
pub fn of_dir(dir: &Path) -> Option<String> {
    let p = posix(dir);
    is_remote_path(&p).then_some(p)
}

/// A path as the remote writes it: `/` separators (a `PathBuf::join` on Windows adds `\`).
pub fn posix(path: &Path) -> String {
    let s = path.to_string_lossy();
    if cfg!(windows) {
        s.replace('\\', "/")
    } else {
        s.into_owned()
    }
}

/// `base/name` on the remote.
pub fn join(base: &str, name: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        name.trim_start_matches('/')
    )
}

/// The current connection, or why there is none.
pub fn conn() -> Result<Arc<RemoteConn>> {
    let remote =
        active().ok_or_else(|| Error::Exec("This window isn't connected to a remote.".into()))?;
    remote.conn()
}

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

impl Remote {
    fn new(authority: Authority) -> Self {
        Remote {
            authority,
            conn: RwLock::new(None),
            info: RwLock::new(None),
            log: Arc::new(Log::default()),
            relay: Mutex::new(None),
            ports: ports::Forwards::default(),
            searches: Mutex::new(HashMap::new()),
            next_search: AtomicU64::new(1),
            events: Mutex::new(None),
            generation: AtomicU64::new(0),
        }
    }

    pub fn conn(&self) -> Result<Arc<RemoteConn>> {
        let conn = self.conn.read().ok().and_then(|c| c.clone());
        match conn {
            Some(c) if c.is_alive() => Ok(c),
            Some(c) => Err(connection::lost_error(&c.lost_reason().unwrap_or_default())),
            None => Err(Error::Exec(format!(
                "Not connected to {} (Disconnected): reconnect from the status bar.",
                self.authority.label()
            ))),
        }
    }

    pub fn info(&self) -> Option<RemoteInfo> {
        self.info.read().ok().and_then(|i| i.clone())
    }

    pub fn is_connected(&self) -> bool {
        self.conn().is_ok()
    }

    fn event(&self, event: RemoteEvent) -> bool {
        self.events
            .lock()
            .ok()
            .and_then(|e| e.clone())
            .is_some_and(|ch| ch.send(event).is_ok())
    }

    fn progress(&self, message: &str) {
        self.log.push(&format!("· {message}"));
        self.event(RemoteEvent::Progress {
            message: message.to_string(),
        });
    }

    /// The relay listener's address and token (`IDE_REMOTE_RELAY`), started on first use.
    pub fn relay_spec(&self) -> Result<String> {
        let mut relay = self
            .relay
            .lock()
            .map_err(|_| Error::Exec("remote lock poisoned".into()))?;
        if relay.is_none() {
            *relay = Some(relay::listen(conn)?);
        }
        let l = relay
            .as_ref()
            .ok_or_else(|| Error::Exec("no relay".into()))?;
        Ok(format!("127.0.0.1:{} {}", l.port, l.token))
    }

    /// A search's id there: the search view's own (`detached` false) replaces the one before.
    pub fn search_id(&self, detached: bool) -> String {
        if detached {
            format!("x{}", self.next_search.fetch_add(1, Ordering::Relaxed))
        } else {
            "view".to_string()
        }
    }

    pub fn add_search(&self, id: &str, channel: Channel<crate::search::SearchEvent>) {
        if let Ok(mut s) = self.searches.lock() {
            s.insert(id.to_string(), channel);
        }
    }

    fn take_search(&self, id: &str, done: bool) -> Option<Channel<crate::search::SearchEvent>> {
        let mut s = self.searches.lock().ok()?;
        if done {
            s.remove(id)
        } else {
            s.get(id).cloned()
        }
    }

    /// Sets up the connection (blocking: ssh, prompts, the upload). `generation` is this
    /// connect's.
    fn establish(self: &Arc<Self>, app: &tauri::AppHandle, generation: u64) -> Result<RemoteInfo> {
        let at = self.authority.clone();
        self.progress(&format!("Connecting to {}…", at.label()));
        let resources = app.path().resource_dir().ok();
        let builds = install::bundled_builds(resources.as_deref());
        let hashes: Vec<(&str, Option<&str>)> = builds
            .iter()
            .map(|(arch, b)| (*arch, b.as_ref().map(|(_, h)| h.as_str())))
            .collect();
        let script = install::script(
            install::server_dir_name(),
            install::server_version(),
            &hashes,
        );
        // ssh's questions (password, passphrase, a new host key) come to this connect's channel.
        let mut route_token: Option<String> = None;
        let mut askpass_env: Vec<(String, String)> = Vec::new();
        if at.kind == Kind::Ssh {
            let me = Arc::downgrade(self);
            let (token, env) = crate::git::askpass::route(Arc::new(move |req| {
                let Some(me) = me.upgrade() else { return false };
                if req.kind == "cancel" {
                    me.event(RemoteEvent::AskpassCancel { id: req.id })
                } else {
                    me.log.push(&format!("· ssh asks: {}", req.prompt.trim()));
                    me.event(RemoteEvent::Askpass {
                        id: req.id,
                        prompt: req.prompt,
                        secret: req.secret,
                    })
                }
            }))?;
            route_token = Some(token);
            askpass_env = env;
        }
        let unroute = |token: &Option<String>| {
            if let Some(t) = token {
                crate::git::askpass::unroute(t);
            }
        };
        let log_start = self.log.len();
        let mut command = transport::command(&at, &script, &askpass_env);
        self.log.push(&format!(
            "· running {} for {}",
            command.get_program().to_string_lossy(),
            at.as_string()
        ));
        let mut child = match command.spawn() {
            Ok(c) => c,
            Err(e) => {
                unroute(&route_token);
                return Err(Error::Exec(if e.kind() == std::io::ErrorKind::NotFound {
                    match at.kind {
                        Kind::Ssh => "ssh isn't installed: add the OpenSSH client (Windows: Settings → Optional features).".to_string(),
                        Kind::Wsl => "WSL isn't installed.".to_string(),
                        Kind::Container => "Docker isn't installed (or isn't on PATH): install Docker Desktop or Docker Engine, or set remote.containers.dockerPath.".to_string(),
                    }
                } else {
                    format!("Couldn't start {}: {e}", at.scheme())
                }));
            }
        };
        if let Some(stderr) = child.stderr.take() {
            let log = self.log.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut buf = Vec::new();
                loop {
                    buf.clear();
                    match reader.read_until(b'\n', &mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => log.push(String::from_utf8_lossy(&buf).trim_end()),
                    }
                }
            });
        }
        let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            unroute(&route_token);
            return Err(Error::Exec("the transport has no pipes".into()));
        };
        let mut stdout = BufReader::new(stdout);
        // The setup reads the transport's output: a remote that never answers (a prompt nobody
        // answers, a hung login) is killed after a while, which ends the read.
        let child = Arc::new(Mutex::new(Some(child)));
        let done = Arc::new(AtomicBool::new(false));
        {
            let child = child.clone();
            let done = done.clone();
            std::thread::spawn(move || {
                let start = std::time::Instant::now();
                while start.elapsed() < SETUP_TIMEOUT {
                    if done.load(Ordering::Acquire) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
                if !done.load(Ordering::Acquire) {
                    if let Ok(mut c) = child.lock() {
                        if let Some(c) = c.as_mut() {
                            let _ = c.kill();
                        }
                    }
                }
            });
        }
        let binary = |arch: &str| -> Result<Vec<u8>> {
            let file = builds
                .iter()
                .find(|(a, _)| *a == arch)
                .and_then(|(_, b)| b.as_ref().map(|(p, _)| p.clone()))
                .ok_or_else(|| {
                    Error::Exec(format!(
                        "This build of the IDE has no server for Linux on {arch} (node scripts/build-server.mjs)."
                    ))
                })?;
            Ok(std::fs::read(file)?)
        };
        let progress = |m: &str| self.progress(m);
        let fail = |e: Error, child: &Arc<Mutex<Option<std::process::Child>>>| -> Error {
            done.store(true, Ordering::Release);
            if let Ok(mut c) = child.lock() {
                if let Some(mut c) = c.take() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
            }
            // ssh's own words say most (refused, unknown host, permission denied).
            std::thread::sleep(Duration::from_millis(150));
            let tail = self.log.tail(log_start);
            let message = if tail.is_empty() {
                e.to_string()
            } else {
                format!("{e} — {}", tail.join(" · "))
            };
            self.log.push(&format!("· failed: {message}"));
            Error::Exec(message)
        };
        let uname = match install::handshake(&mut stdout, &mut stdin, &binary, &progress) {
            Ok(u) => u,
            Err(e) => {
                unroute(&route_token);
                return Err(fail(e, &child));
            }
        };
        done.store(true, Ordering::Release);
        unroute(&route_token);
        let transport = child.lock().ok().and_then(|mut c| c.take());
        let notify_app = app.clone();
        let me = Arc::downgrade(self);
        let conn = RemoteConn::start(
            transport,
            Box::new(stdout),
            Box::new(stdin),
            Arc::new(move |method: &str, params: &Value| dispatch(&notify_app, method, params)),
            Box::new(move |reason| {
                if let Some(me) = me.upgrade() {
                    if me.generation.load(Ordering::Acquire) == generation {
                        let tail = me.log.tail(0);
                        let reason = match tail.last() {
                            Some(last) => format!("{reason} — {last}"),
                            None => reason,
                        };
                        me.log.push(&format!("· disconnected: {reason}"));
                        me.event(RemoteEvent::Disconnected { reason });
                    }
                }
            }),
        )?;
        let hello = conn
            .call_blocking(
                "hello",
                json!({ "version": install::server_version() }),
                Duration::from_secs(30),
            )
            .inspect_err(|_| {
                // Its end is this connect's failure, not a lost connection to report.
                self.generation.fetch_add(1, Ordering::AcqRel);
                conn.close();
            })?;
        let field = |k: &str| {
            hello
                .get(k)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let info = RemoteInfo {
            authority: at.as_string(),
            label: at.label(),
            os: field("os"),
            arch: if field("arch").is_empty() {
                uname.arch
            } else {
                field("arch")
            },
            home: field("home"),
            user: field("user"),
            shell: field("shell"),
            version: field("version"),
        };
        if self.generation.load(Ordering::Acquire) != generation {
            // Another connect (or a disconnect) came meanwhile: this one isn't wanted.
            conn.close();
            return Err(Error::Exec("cancelled by another connection".into()));
        }
        if let Ok(mut c) = self.conn.write() {
            *c = Some(conn);
        }
        if let Ok(mut i) = self.info.write() {
            *i = Some(info.clone());
        }
        self.log.push(&format!(
            "· connected: {} {} {}, server {}",
            info.user, info.os, info.arch, info.version
        ));
        Ok(info)
    }

    /// Closes the connection (the server ends what it started).
    fn close(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        let conn = self.conn.write().ok().and_then(|mut c| c.take());
        if let Some(conn) = conn {
            // The server ends what it started (also when its input closes, killing the
            // transport).
            let _ = conn.fire("shutdown", json!({}));
            conn.close();
        }
    }
}

/// Connects this window to `authority` (reconnecting when it's the window's remote already).
pub async fn connect(
    app: tauri::AppHandle,
    authority: &str,
    events: Channel<RemoteEvent>,
) -> Result<RemoteInfo> {
    let at = Authority::parse(authority)?;
    let remote = {
        let mut active = ACTIVE
            .write()
            .map_err(|_| Error::Exec("remote lock poisoned".into()))?;
        match active.as_ref() {
            Some(r) if r.authority == at => r.clone(),
            Some(r) if r.is_connected() => {
                return Err(Error::Invalid(format!(
                    "This window is connected to {}: connect to another remote in a new window.",
                    r.authority.label()
                )))
            }
            _ => {
                let r = Arc::new(Remote::new(at));
                *active = Some(r.clone());
                r
            }
        }
    };
    if let Ok(mut e) = remote.events.lock() {
        *e = Some(events);
    }
    // Still connected (the page reloaded and connects again): the same connection serves on.
    if let (true, Some(info)) = (remote.is_connected(), remote.info()) {
        return Ok(info);
    }
    remote.close();
    let generation = remote.generation.load(Ordering::Acquire);
    let r = remote.clone();
    tauri::async_runtime::spawn_blocking(move || r.establish(&app, generation))
        .await
        .map_err(|e| Error::Exec(e.to_string()))?
}

/// The window is local again: the connection closes, forwards stop.
pub fn disconnect() {
    let remote = ACTIVE.write().ok().and_then(|mut a| a.take());
    if let Some(r) = remote {
        r.ports.clear();
        r.close();
    }
}

/// Makes this window a remote one before anything connects (`--remote` at startup): its paths
/// are the remote's from the first call on, even if connecting fails.
pub fn set_window_remote(authority: &str) -> Result<()> {
    let at = Authority::parse(authority)?;
    let mut active = ACTIVE
        .write()
        .map_err(|_| Error::Exec("remote lock poisoned".into()))?;
    if active.is_none() {
        *active = Some(Arc::new(Remote::new(at)));
    }
    Ok(())
}

/// Notifications from the server that aren't a stream's: watch batches to the watcher that
/// asked (by name), the file index's changes, search results.
fn dispatch(app: &tauri::AppHandle, method: &str, params: &Value) {
    let Some(state) = app.try_state::<crate::AppState>() else {
        return;
    };
    let strings = |key: &str| -> Vec<String> {
        params
            .get(key)
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    match method {
        "watch.batch" => {
            let watcher = match params.get("watcher").and_then(Value::as_str).unwrap_or("") {
                "settings" => &state.settings_watcher,
                "docs" => &state.docs_watcher,
                "skills" => &state.skills_watcher,
                _ => &state.watcher,
            };
            if let Some(channel) = watcher.channel() {
                let _ = channel.send(crate::watch::WatchBatch {
                    dirs: strings("dirs"),
                    paths: strings("paths"),
                });
            }
        }
        "index.changes" => {
            if let Some(channel) = state.index.listener() {
                let _ = channel.send(crate::index::IndexChanges {
                    paths: strings("paths"),
                    overflow: params
                        .get("overflow")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                });
            }
        }
        "search.event" => {
            let Some(remote) = active() else { return };
            let id = match params.get("search") {
                Some(Value::String(s)) => s.clone(),
                Some(other) => other.to_string(),
                None => return,
            };
            let Some(event) = params
                .get("event")
                .and_then(|e| serde_json::from_value::<crate::search::SearchEvent>(e.clone()).ok())
            else {
                return;
            };
            let done = matches!(event, crate::search::SearchEvent::Done { .. });
            if let Some(channel) = remote.take_search(&id, done) {
                let _ = channel.send(event);
            }
        }
        _ => {}
    }
}

/// A program run in remote folder `dir` through the relay: `program` with `args` there (`""`:
/// the login shell, with `-l`). The caller adds its own options and variables, then calls
/// `share_env`. Started where it is, it fails with a message when the window isn't connected.
pub fn command(dir: &str, program: &str, args: &[String]) -> Command {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("ide"));
    let mut cmd = Command::new(exe);
    // The browser pane's debugging port is for the IDE's own webviews (D229).
    cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
    cmd.args(relay::relay_args(dir, program, args));
    match active().map(|r| r.relay_spec()) {
        Some(Ok(spec)) => {
            cmd.env(relay::ENV_RELAY, spec);
        }
        _ => {
            cmd.env_remove(relay::ENV_RELAY);
        }
    }
    // A local folder to start in: the remote one isn't a working directory here.
    if let Some(home) = home_dir() {
        cmd.current_dir(home);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// Variables a local process sets that mean nothing there (local paths and the IDE's own
/// plumbing).
const NOT_SHARED: [&str; 12] = [
    "PATH",
    "WSLENV",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "SSH_ASKPASS_REQUIRE",
    "USERPROFILE",
    "HOME",
    "TEMP",
    "TMP",
    "IDE_ASKPASS_PORT",
    "IDE_ASKPASS_TOKEN",
    "DISPLAY",
];

/// The `IDE_REMOTE_ENV` list for the names set on a command (not the IDE's plumbing).
pub fn shared_names<'a>(names: impl IntoIterator<Item = &'a str>) -> String {
    let mut out: Vec<&str> = Vec::new();
    for name in names {
        let plumbing = name.starts_with("IDE_REMOTE_")
            || NOT_SHARED.iter().any(|n| n.eq_ignore_ascii_case(name))
            || name.contains(',');
        if !plumbing && !out.contains(&name) {
            out.push(name);
        }
    }
    out.join(",")
}

/// Lets the variables set on `cmd` (a relay command) reach the program there; call it after the
/// last `.env(...)`.
pub fn share_env(cmd: &mut Command) {
    let names: Vec<String> = cmd
        .get_envs()
        .filter(|(_, v)| v.is_some())
        .filter_map(|(k, _)| k.to_str().map(str::to_string))
        .collect();
    let list = shared_names(names.iter().map(String::as_str));
    cmd.env(relay::ENV_SHARED, list);
}

/// A request from blocking code; the remote's answer or why there is none.
pub fn call_blocking(method: &str, params: Value) -> Result<Value> {
    conn()?.call_blocking(method, params, connection::DEFAULT_TIMEOUT)
}

/// A request from async code.
pub async fn call(method: &str, params: Value) -> Result<Value> {
    conn()?.call(method, params).await
}

/// What's at a remote path (`browse.stat`, anywhere readable): "file", "dir", or None.
pub fn kind_blocking(path: &str) -> Option<String> {
    call_blocking("browse.stat", json!({ "path": path }))
        .ok()
        .and_then(|v| v.get("kind").and_then(Value::as_str).map(str::to_string))
}

/// `path.is_dir()` for local and remote paths alike.
pub fn is_dir(path: &Path) -> bool {
    match of_dir(path) {
        Some(p) => kind_blocking(&p).as_deref() == Some("dir"),
        None => path.is_dir(),
    }
}

/// `path.is_file()` for local and remote paths alike.
pub fn is_file(path: &Path) -> bool {
    match of_dir(path) {
        Some(p) => kind_blocking(&p).as_deref() == Some("file"),
        None => path.is_file(),
    }
}

/// Whether a remote folder exists (from async code).
pub async fn is_dir_async(path: &str) -> bool {
    call("browse.stat", json!({ "path": path }))
        .await
        .ok()
        .and_then(|v| v.get("kind").and_then(Value::as_str).map(|k| k == "dir"))
        .unwrap_or(false)
}

/// The folders directly in a remote folder (`browse.listDir`), as full paths.
pub fn subdirs_blocking(dir: &str) -> Vec<String> {
    call_blocking("browse.listDir", json!({ "path": dir }))
        .ok()
        .and_then(|v| v.as_array().cloned())
        .map(|entries| {
            entries
                .iter()
                .filter(|e| e.get("kind").and_then(Value::as_str) == Some("dir"))
                .filter(|e| e.get("isSymlink").and_then(Value::as_bool) != Some(true))
                .filter_map(|e| e.get("path").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Runs `sh -c script sh args…` there (blocking) and returns its exit code and output. For the
/// few things the protocol has no method for (the trash); the arguments are never parsed by a
/// shell, only `script` is.
pub fn run_sh(script: &str, args: &[String], timeout: Duration) -> Result<(i32, String)> {
    let conn = conn()?;
    let (tx, rx) = std::sync::mpsc::channel();
    let mut argv = vec!["-c".to_string(), script.to_string(), "sh".to_string()];
    argv.extend(args.iter().cloned());
    conn.open_stream_blocking(
        "proc.spawn",
        json!({ "cwd": "", "program": "/bin/sh", "args": argv }),
        tx,
        connection::DEFAULT_TIMEOUT,
    )?;
    let deadline = std::time::Instant::now() + timeout;
    let mut out = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        match rx.recv_timeout(left) {
            Ok(connection::StreamEvent::Data { bytes, .. }) => out.extend(bytes),
            Ok(connection::StreamEvent::Exit { code, signal }) => {
                return Ok((
                    connection::StreamEvent::exit_code(code, signal),
                    String::from_utf8_lossy(&out).into_owned(),
                ))
            }
            Ok(connection::StreamEvent::Lost(reason)) => {
                return Err(connection::lost_error(&reason))
            }
            Err(_) => {
                return Err(Error::Exec(
                    "the remote command didn't finish in time".into(),
                ))
            }
        }
    }
}

/// Where deleted items go on the remote: `~/<serverDir>/trash/<id>/<name>`.
fn trash_dir_script() -> String {
    format!("\"$HOME/{}/trash\"", install::server_dir_name())
}

/// Items this window moved to the remote's trash: id → (where it was, its place in the trash).
static TRASHED: Mutex<Option<HashMap<String, (String, String)>>> = Mutex::new(None);

/// Deletes `path` (canonical there, never a workspace folder) into the remote's trash; the id
/// to undo with. Items over 30 days old there are emptied on the way.
pub fn trash(path: &str) -> Result<String> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(|e| Error::Invalid(format!("no randomness: {e}")))?;
    let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let name = path
        .rsplit('/')
        .next()
        .filter(|n| !n.is_empty())
        .ok_or_else(|| Error::Invalid("nothing to trash".into()))?;
    let script = format!(
        "R={}; T=\"$R/{id}\"; mkdir -p \"$T\" && mv -- \"$1\" \"$T/\" || exit 1; find \"$R\" -mindepth 1 -maxdepth 1 -mtime +30 -exec rm -rf {{}} + 2>/dev/null; printf %s \"$T\"",
        trash_dir_script()
    );
    let (code, out) = run_sh(&script, &[path.to_string()], Duration::from_secs(120))?;
    if code != 0 || out.trim().is_empty() {
        return Err(Error::Invalid(format!(
            "Couldn't move {path} to the trash on the remote."
        )));
    }
    let place = join(out.trim(), name);
    if let Ok(mut t) = TRASHED.lock() {
        t.get_or_insert_with(HashMap::new)
            .insert(id.clone(), (path.to_string(), place));
    }
    Ok(id)
}

/// Whether trashed item `id` is one of this window's remote ones.
pub fn is_trashed(id: &str) -> bool {
    TRASHED
        .lock()
        .ok()
        .is_some_and(|t| t.as_ref().is_some_and(|m| m.contains_key(id)))
}

/// Puts remote trashed item `id` back at `dest` (which must not exist).
pub fn untrash(id: &str, dest: &str) -> Result<()> {
    let place = TRASHED
        .lock()
        .ok()
        .and_then(|t| t.as_ref().and_then(|m| m.get(id).map(|(_, p)| p.clone())))
        .ok_or_else(|| Error::Invalid("the trashed item is gone".into()))?;
    let script = "if [ -e \"$2\" ] || [ -L \"$2\" ]; then exit 3; fi; mv -- \"$1\" \"$2\" && rmdir \"$(dirname \"$1\")\" 2>/dev/null; [ -e \"$2\" ] || [ -L \"$2\" ]";
    let (code, _) = run_sh(script, &[place, dest.to_string()], Duration::from_secs(120))?;
    match code {
        0 => {
            if let Ok(mut t) = TRASHED.lock() {
                if let Some(m) = t.as_mut() {
                    m.remove(id);
                }
            }
            Ok(())
        }
        3 => Err(Error::Invalid(format!(
            "{dest} exists again; not restoring over it"
        ))),
        _ => Err(Error::Invalid(format!("Couldn't restore {dest}."))),
    }
}

/// Git's directory changes in a remote window (`git_watch`): the server's watcher reports
/// nothing inside `.git`, so HEAD, the index and the refs are looked at every two seconds
/// instead (one small request each). Stops when the flag is set.
pub fn poll_git_dir(git_dir: String, channel: Channel<()>) -> Arc<AtomicBool> {
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    std::thread::spawn(move || {
        let watched: Vec<String> = [
            "HEAD",
            "index",
            "FETCH_HEAD",
            "ORIG_HEAD",
            "MERGE_HEAD",
            "packed-refs",
            "refs/heads",
            "refs/tags",
            "refs/remotes/origin",
            "refs/stash",
        ]
        .iter()
        .map(|p| join(&git_dir, p))
        .collect();
        let look = || -> Vec<Option<(u64, u64)>> {
            watched
                .iter()
                .map(|p| {
                    call_blocking("browse.stat", json!({ "path": p }))
                        .ok()
                        .filter(|v| !v.is_null())
                        .map(|v| {
                            (
                                v.get("mtimeMs").and_then(Value::as_f64).unwrap_or(0.0) as u64,
                                v.get("size").and_then(Value::as_u64).unwrap_or(0),
                            )
                        })
                })
                .collect()
        };
        let mut last = look();
        while !stopped.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_secs(2));
            if stopped.load(Ordering::Acquire) || !is_remote_window() {
                break;
            }
            if conn().is_err() {
                continue;
            }
            let now = look();
            if now != last {
                last = now;
                if channel.send(()).is_err() {
                    break;
                }
            }
        }
    });
    stop
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_paths_are_told_apart_from_local_ones() {
        let local = vec![PathBuf::from("/home/me/.config/app")];
        assert!(is_remote_path_in(true, "/home/me/app/src/a.ts", &local));
        assert!(!is_remote_path_in(false, "/home/me/app", &local));
        assert!(!is_remote_path_in(true, "//server/share", &local));
        assert!(!is_remote_path_in(true, r"C:\Users\me\a.ts", &local));
        assert!(!is_remote_path_in(true, "relative/x", &local));
        // The app's own folders stay local on a Unix host; on Windows they're never POSIX.
        assert_eq!(
            is_remote_path_in(true, "/home/me/.config/app/settings.json", &local),
            cfg!(windows)
        );
    }

    #[test]
    fn remote_paths_join_and_print_with_slashes() {
        assert_eq!(join("/home/me/", "/a"), "/home/me/a");
        let joined = Path::new("/home/me/app").join("src").join("a.ts");
        assert_eq!(posix(&joined), "/home/me/app/src/a.ts");
    }

    #[test]
    fn only_the_programs_own_variables_cross() {
        assert_eq!(
            shared_names([
                "TERM",
                "PATH",
                "GIT_EDITOR",
                "IDE_REMOTE_RELAY",
                "TERM",
                "IDE_ASKPASS_TOKEN",
                "CI"
            ]),
            "TERM,GIT_EDITOR,CI"
        );
    }

    #[test]
    fn a_relay_command_runs_the_program_there() {
        let cmd = command("/home/me/app", "git", &["status".into()]);
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            [
                relay::RELAY_FLAG,
                "--cwd",
                "/home/me/app",
                "--",
                "git",
                "status"
            ]
        );
    }

    #[test]
    fn the_log_keeps_its_last_lines_and_says_what_failed() {
        let log = Log::default();
        for i in 0..(LOG_LINES + 5) {
            log.push(&format!("line {i}"));
        }
        assert_eq!(log.len(), LOG_LINES);
        log.push("· a step");
        log.push("ssh: connect to host box port 22: Connection refused");
        assert_eq!(
            log.tail(LOG_LINES - 2).last().map(String::as_str),
            Some("ssh: connect to host box port 22: Connection refused")
        );
    }
}
