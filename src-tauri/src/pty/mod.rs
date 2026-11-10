//! Pseudo-terminals via `portable-pty` (Unix) and the IDE's own ConPTY spawner (Windows,
//! `conpty.rs`). Output streams to the frontend as raw bytes over a Tauri Channel. Flow control:
//! the frontend acknowledges bytes after rendering them; the reader pauses while too much is
//! unacknowledged, so `cat huge.log` can't flood the webview (PLAN §13). Terminals outlive a page
//! reload for a grace period and are reattached by the reloaded page (`revive.rs`). Which shell
//! starts: `shell.rs`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{ChildKiller, CommandBuilder, PtySize};
use serde::Serialize;

use crate::error::{Error, Result};

pub mod bash_idioms;
pub mod chain;
pub mod commands;
#[cfg(windows)]
pub mod conpty;
pub mod globals;
pub mod integration;
pub mod profiles;
pub mod revive;
pub mod shell;
pub mod suggest;
pub mod tasks;

use commands::{CommandRecord, CommandTracker};
use profiles::ProfileSpec;
use revive::Ring;
#[cfg(windows)]
pub use shell::find_pwsh;
use shell::{apply_run_env, default_shell_command, profile_command};
#[cfg_attr(not(windows), allow(unused_imports))]
pub use tasks::{expand_env, task_command, windows_program, RunSpec};

/// Pause reading when this many bytes are sent but not yet acknowledged by the frontend.
const HIGH_WATER: usize = 512 * 1024;
/// Resume once the frontend has caught up below this.
const LOW_WATER: usize = 128 * 1024;
const READ_CHUNK: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyInfo {
    pub id: u32,
    pub pid: Option<u32>,
    pub shell: String,
    pub cwd: String,
    /// Shell integration scripts were loaded (bash, zsh, fish, PowerShell).
    pub integration: bool,
    /// The secret the scripts add to their command-line marks (D192): output can't forge them.
    pub nonce: Option<String>,
    /// A Windows bash (Git Bash): it reports folders as `/c/…` and wants POSIX paths typed.
    pub msys: bool,
    /// The secret a reloaded page gives back to reattach this terminal (`attach`).
    pub key: String,
}

/// What a reattached page gets (`attach`): the terminal as it was started, where its replay
/// starts, and the console's size now.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attached {
    pub info: PtyInfo,
    /// Offset of the first byte sent on the new channel (the replay, then live output).
    pub from: u64,
    /// The replay starts exactly at the offset the page asked for (see `revive::Replay`).
    pub complete: bool,
    pub cols: u16,
    pub rows: u16,
    /// Shell integration's last command started and hasn't ended (a dev server, a build).
    pub running: bool,
}

/// One message to the page: output bytes, or the exit code at the end.
pub enum Output {
    Data(Vec<u8>),
    Exit(i64),
}

/// Where a terminal's output goes: the page's channel (false: it's gone).
pub type Sink = Box<dyn Fn(Output) -> bool + Send + Sync>;

/// Commands seen in a terminal (shell integration) and its current folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCommands {
    pub integration_active: bool,
    pub cwd: Option<String>,
    pub running: Option<CommandRecord>,
    pub commands: Vec<CommandRecord>,
}

/// How long output waits for the view's acks before going on anyway.
const ACK_PATIENCE: Duration = Duration::from_secs(5);

#[derive(Default)]
struct Flow {
    unacked: Mutex<usize>,
    resume: Condvar,
    closed: AtomicBool,
    /// No page shows the terminal (a reload): output isn't held back for acks that won't come.
    detached: AtomicBool,
}

impl Flow {
    fn wait_for_room(&self) {
        let Ok(mut unacked) = self.unacked.lock() else {
            return;
        };
        let since = std::time::Instant::now();
        while *unacked > HIGH_WATER
            && !self.closed.load(Ordering::Relaxed)
            && !self.detached.load(Ordering::Relaxed)
        {
            // No acks for this long (a lost write callback, a webview that stalled): carry on
            // rather than freeze the terminal for good (D192).
            if since.elapsed() > ACK_PATIENCE {
                *unacked = 0;
                return;
            }
            match self
                .resume
                .wait_timeout(unacked, Duration::from_millis(500))
            {
                Ok((guard, _)) => unacked = guard,
                Err(_) => return,
            }
        }
    }

    fn sent(&self, n: usize) {
        if let Ok(mut unacked) = self.unacked.lock() {
            *unacked += n;
        }
    }

    fn ack(&self, n: usize) {
        if let Ok(mut unacked) = self.unacked.lock() {
            *unacked = unacked.saturating_sub(n);
            if *unacked < LOW_WATER {
                self.resume.notify_all();
            }
        }
    }

    /// A page has the terminal (`true`) or none does; either way nothing is owed.
    fn set_detached(&self, detached: bool) {
        if let Ok(mut unacked) = self.unacked.lock() {
            *unacked = 0;
        }
        self.detached.store(detached, Ordering::Relaxed);
        self.resume.notify_all();
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.resume.notify_all();
    }
}

/// The page side of a terminal: who gets its output, and what it printed lately.
struct Listener {
    sink: Option<Sink>,
    /// The page that has it (its token; `page_loaded` detaches the other pages' terminals).
    page: Option<String>,
    /// When the last page let it go; None while a page has it.
    detached_at: Option<Instant>,
    ring: Ring,
}

impl Listener {
    fn new(sink: Sink, page: Option<String>) -> Self {
        Self {
            sink: Some(sink),
            page,
            detached_at: None,
            ring: Ring::new(revive::RING_BYTES),
        }
    }

    fn detach(&mut self) {
        self.sink = None;
        self.page = None;
        self.detached_at.get_or_insert_with(Instant::now);
    }
}

/// The console the shell runs in: resized from the resize worker, dropped with the session.
enum Console {
    #[cfg(windows)]
    Con(conpty::ConPty),
    #[cfg(not(windows))]
    Native(Box<dyn portable_pty::MasterPty + Send>),
    /// A remote window's terminal (D252): the pty is on the remote.
    Remote(Arc<crate::remote::pty::RemotePty>),
}

impl Console {
    fn resize(&self, size: PtySize) {
        match self {
            Console::Remote(pty) => pty.resize(size.rows, size.cols),
            #[cfg(windows)]
            Console::Con(pty) => {
                let _ = pty.resize(size);
            }
            #[cfg(not(windows))]
            Console::Native(master) => {
                let _ = master.resize(size);
            }
        }
    }
}

struct Session {
    console: Mutex<Console>,
    /// Input for the shell, written in order by the session's writer thread: keystrokes and
    /// pastes arrive as separate IPC calls, and a write can block while the program isn't
    /// reading (a big paste), which must neither reorder input nor hold up the caller.
    input: mpsc::Sender<Vec<u8>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    flow: Arc<Flow>,
    tracker: Arc<Mutex<CommandTracker>>,
    listener: Arc<Mutex<Listener>>,
    /// The shell's process id (its whole tree is ended on close, Windows).
    #[cfg_attr(not(windows), allow(dead_code))]
    pid: Option<u32>,
    /// The latest size asked for, applied by one resize thread at a time (D192): resizing can
    /// block on Windows while the console writes, and must not hold up the caller or reorder.
    pending_size: Arc<Mutex<Option<PtySize>>>,
    /// The size last asked for (a reattaching page that can't measure yet draws at it).
    size: Mutex<PtySize>,
    /// The folder the shell started in (relative paths of suggestions resolve against the one
    /// shell integration reports, else this).
    cwd: PathBuf,
    /// The program the terminal started ("wsl · <distro>" in a WSL folder).
    shell: String,
    /// As the page that started it was told (a reattaching page gets the same).
    info: PtyInfo,
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<u32, Arc<Session>>>>,
    next_id: AtomicU32,
    /// How long a detached terminal waits for a page (`revive::ORPHAN_GRACE`; shorter in tests).
    grace: Duration,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self {
            sessions: Arc::default(),
            next_id: AtomicU32::new(0),
            grace: revive::ORPHAN_GRACE,
        }
    }
}

/// How a terminal starts, besides its folder and size (the IPC command's fields).
#[derive(Default)]
pub struct SpawnOptions {
    /// Where shell integration's scripts are (None: start without them).
    pub integration_dir: Option<PathBuf>,
    pub run: Option<RunSpec>,
    pub profile: Option<ProfileSpec>,
    pub extra_env: HashMap<String, String>,
    /// The page that starts it (`detach_except`).
    pub page: Option<String>,
}

fn random_hex(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    let _ = getrandom::fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

impl PtyManager {
    pub fn spawn(
        &self,
        cwd: PathBuf,
        cols: u16,
        rows: u16,
        sink: Sink,
        options: SpawnOptions,
    ) -> Result<PtyInfo> {
        let SpawnOptions {
            integration_dir,
            run,
            profile,
            extra_env,
            page,
        } = options;
        let size = PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        };
        // A remote window's folder (D252): the shell, or the task, runs there in a remote pty.
        let remote = crate::remote::of_dir(&cwd);
        // A folder inside WSL (D192): the shell, or the task, runs in the distribution.
        let wsl = if remote.is_some() {
            None
        } else {
            crate::wsl::of_dir(&cwd)
        };
        // A tail of the command line passed as written (cmd.exe tasks; Windows only).
        let mut verbatim: Option<String> = None;
        let (mut cmd, shell, integration) = match (&run, &wsl) {
            _ if remote.is_some() => {
                let label = crate::remote::active()
                    .map(|r| format!("{} · {}", r.authority.scheme(), r.authority.host))
                    .unwrap_or_else(|| "remote".into());
                let cmd = match &run {
                    // The task's command line through its own shell there, else the login shell.
                    Some(spec) => {
                        let line = if spec.kind == "process" {
                            std::iter::once(&spec.command)
                                .chain(spec.args.iter())
                                .map(|a| tasks::shell_quote(a))
                                .collect::<Vec<_>>()
                                .join(" ")
                        } else {
                            spec.command.clone()
                        };
                        let (program, args) = tasks::remote_task_shell(spec, line);
                        let mut cmd = CommandBuilder::new(program);
                        cmd.args(args);
                        apply_run_env(&mut cmd, &spec.env);
                        cmd
                    }
                    // The user's interactive login shell; no integration scripts yet (they live
                    // on this side).
                    None => CommandBuilder::new_default_prog(),
                };
                (cmd, label, false)
            }
            (Some(spec), Some(at)) => {
                let line = if spec.kind == "process" {
                    std::iter::once(&spec.command)
                        .chain(spec.args.iter())
                        .map(|a| tasks::shell_quote(&expand_env(a)))
                        .collect::<Vec<_>>()
                        .join(" ")
                } else {
                    expand_env(&spec.command)
                };
                let (program, args) = tasks::wsl_task_shell(spec, line);
                let mut cmd = CommandBuilder::new("wsl.exe");
                for a in crate::wsl::wrap_args(at, &program, &args) {
                    cmd.arg(a);
                }
                apply_run_env(&mut cmd, &spec.env);
                (cmd, format!("wsl · {}", at.distro), false)
            }
            (None, Some(at)) => {
                // The user's login shell there, in the folder (`--cd`); no integration scripts
                // yet (they live on the Windows side).
                let mut cmd = CommandBuilder::new("wsl.exe");
                for a in ["-d", &at.distro, "--cd", &at.linux] {
                    cmd.arg(a);
                }
                (cmd, format!("wsl · {}", at.distro), false)
            }
            (Some(spec), None) => {
                let launch = task_command(spec);
                let mut cmd = launch.cmd;
                verbatim = launch.verbatim;
                apply_run_env(&mut cmd, &spec.env);
                (cmd, launch.program, false)
            }
            (None, None) => match &profile {
                Some(spec) => profile_command(spec, integration_dir.as_deref())?,
                None => {
                    let (default_cmd, shell) = default_shell_command();
                    let integrated = integration_dir.and_then(|dir| {
                        integration::command_with_integration(&shell, &dir, None)
                            .ok()
                            .flatten()
                    });
                    let integration = integrated.is_some();
                    (integrated.unwrap_or(default_cmd), shell, integration)
                }
            },
        };
        let msys = wsl.is_none() && remote.is_none() && integration::is_windows_bash(&shell);
        // A WSL folder isn't a working directory Windows starts processes in (`--cd` sets it).
        match (&remote, &wsl, std::env::var_os("USERPROFILE")) {
            (Some(dir), _, _) => cmd.cwd(dir),
            (None, Some(_), Some(home)) => cmd.cwd(home),
            _ => cmd.cwd(&cwd),
        }
        // Command lines from shell integration carry a secret only the scripts know (they read
        // and unset it): a printed file or a program can't plant commands in the history that
        // "Run recent command" would run (VS Code does the same, D192).
        // Always one, so a terminal without the scripts (cmd.exe, WSL) accepts no command lines.
        let nonce = Some(random_hex(8));
        if let (true, Some(n)) = (integration, &nonce) {
            cmd.env("IDE_SHELL_NONCE", n);
        }
        for (key, value) in &extra_env {
            cmd.env(key, expand_env(value));
        }
        // The browser pane's debugging port (D204) is for the IDE's own webviews only.
        if std::env::var_os(crate::debug::pane_port::WEBVIEW2_ARGS_VAR).is_some() {
            cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Who the terminal is, like VS Code's "vscode": programs that adapt to their editor (Claude
        // Code, Gemini CLI) see this IDE, not one it was started from (D192).
        cmd.env("TERM_PROGRAM", crate::product_term_program());
        cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        // GUI apps on macOS often start without a locale, which breaks Unicode in the shell.
        // (A remote shell gets the remote's own, or the server's C.UTF-8.)
        if std::env::var_os("LANG").is_none() && !cfg!(windows) && remote.is_none() {
            cmd.env("LANG", "en_US.UTF-8");
        }
        // In WSL, only variables listed in WSLENV reach Linux (TERM, task env, TERM_PROGRAM).
        if wsl.is_some() {
            let names: Vec<String> = cmd
                .iter_extra_env_as_str()
                .map(|(k, _)| k.to_string())
                .collect();
            let existing = std::env::var("WSLENV").ok();
            let value = crate::wsl::wslenv(existing.as_deref(), names.iter().map(String::as_str));
            if !value.is_empty() {
                cmd.env("WSLENV", value);
            }
        }
        let console = match &remote {
            Some(_) => Opened::Remote(Arc::new(crate::remote::pty::RemotePty::open(
                size.rows, size.cols,
            )?)),
            None => open_console(size)?,
        };
        // Drain output from the moment the console exists: ConPTY writes its first frames while
        // the child starts, and a full pipe with nobody reading can stall the start (Windows).
        let (reader, writer) = console.io()?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (input, input_rx) = mpsc::channel::<Vec<u8>>();
        {
            let mut writer = writer;
            thread::Builder::new()
                .name(format!("pty-{id}-write"))
                .spawn(move || {
                    // Ends when the session (the sender) is dropped or the console is gone.
                    for data in input_rx {
                        if writer
                            .write_all(&data)
                            .and_then(|()| writer.flush())
                            .is_err()
                        {
                            break;
                        }
                    }
                })?;
        }
        let flow = Arc::new(Flow::default());
        let mut fresh = CommandTracker::default();
        fresh.nonce = nonce.clone();
        fresh.msys = msys;
        let tracker = Arc::new(Mutex::new(fresh));
        let listener = Arc::new(Mutex::new(Listener::new(sink, page)));
        let (exit_tx, exit_rx) = mpsc::channel::<i64>();
        {
            let flow = flow.clone();
            let tracker = tracker.clone();
            let listener = listener.clone();
            thread::Builder::new()
                .name(format!("pty-{id}-read"))
                .spawn(move || {
                    read_loop(reader, &flow, &listener, &tracker);
                    let code = exit_rx.recv_timeout(Duration::from_secs(5)).unwrap_or(-1);
                    if let Ok(l) = listener.lock() {
                        if let Some(sink) = &l.sink {
                            sink(Output::Exit(code));
                        }
                    }
                })?;
        }
        let mut child = match console.spawn(cmd, verbatim.as_deref()) {
            Ok(child) => child,
            Err(e) => {
                // Dropping the console closes it, which ends the reader with EOF.
                flow.close();
                let _ = exit_tx.send(-1);
                return Err(e);
            }
        };
        let pid = child.process_id();
        // The terminal's shell (and what runs in it) ends with the IDE (D180). Windows: it was
        // put in the job before it started running (`conpty`).
        #[cfg(not(windows))]
        if let Some(pid) = pid {
            crate::job::adopt(pid);
        }
        let info = PtyInfo {
            id,
            pid,
            shell: shell.clone(),
            cwd: cwd.to_string_lossy().into_owned(),
            integration,
            nonce,
            msys,
            key: random_hex(16),
        };
        let session = Arc::new(Session {
            console: Mutex::new(console.into_console()),
            input,
            killer: Mutex::new(child.clone_killer()),
            flow,
            tracker,
            listener,
            pid,
            pending_size: Arc::new(Mutex::new(None)),
            size: Mutex::new(size),
            cwd: cwd.clone(),
            shell,
            info: info.clone(),
        });
        self.lock()?.insert(id, session);

        // Waiter: reaps the child, then closes the session so the reader sees EOF on every platform
        // (ConPTY only reports EOF once the master side is dropped).
        let sessions = self.sessions.clone();
        thread::Builder::new()
            .name(format!("pty-{id}-wait"))
            .spawn(move || {
                let code = child.wait().map(|s| i64::from(s.exit_code())).unwrap_or(-1);
                let _ = exit_tx.send(code);
                // Let trailing output drain first.
                thread::sleep(Duration::from_millis(300));
                // Take the session out, then let it go *after* the lock is released: dropping it
                // closes the console, and on Windows ClosePseudoConsole can block until its output
                // is drained. Holding the shared lock meanwhile froze every later terminal start
                // (seen after closing a folder: new terminals stayed blank until the 10 s notice).
                let removed = sessions.lock().ok().and_then(|mut map| map.remove(&id));
                if let Some(session) = removed {
                    session.flow.close();
                    drop(session);
                }
            })?;

        Ok(info)
    }

    /// A reloaded page takes terminal `id` back (VS Code's process revival): it must give the
    /// key it was told and the terminal must have no page. Output after `since` (the offset the
    /// page's saved screen reflects) is sent on `sink` first, then the live output; `size` is the
    /// page's (None: it can't measure yet, keep the console's).
    pub fn attach(
        &self,
        id: u32,
        key: &str,
        page: Option<String>,
        sink: Sink,
        since: Option<u64>,
        size: Option<(u16, u16)>,
    ) -> Result<Attached> {
        let session = self
            .get(id)
            .map_err(|_| Error::Pty(format!("no terminal {id} to reattach (Gone)")))?;
        if !revive::same_key(&session.info.key, key) {
            return Err(Error::Pty(format!("no terminal {id} to reattach (Gone)")));
        }
        let replay = {
            let mut listener = session
                .listener
                .lock()
                .map_err(|_| Error::Pty("lock poisoned".into()))?;
            if listener.sink.is_some() {
                return Err(Error::Pty(format!(
                    "terminal {id} is shown by a page already (AlreadyAttached)"
                )));
            }
            let replay = listener.ring.replay(since);
            session.flow.set_detached(false);
            // Sent before the live output can be (the reader takes this lock for each chunk).
            if !replay.bytes.is_empty() {
                session.flow.sent(replay.bytes.len());
                if !sink(Output::Data(replay.bytes.clone())) {
                    session.flow.set_detached(true);
                    return Err(Error::Pty("the page went away while reattaching".into()));
                }
            }
            listener.sink = Some(sink);
            listener.page = page;
            listener.detached_at = None;
            replay
        };
        if let Some((cols, rows)) = size {
            let current = session.size.lock().map(|s| (s.cols, s.rows)).ok();
            if current != Some((cols.max(1), rows.max(1))) {
                self.resize(id, cols, rows)?;
            }
        }
        let (cols, rows) = session
            .size
            .lock()
            .map(|s| (s.cols, s.rows))
            .unwrap_or((80, 24));
        let running = session
            .tracker
            .lock()
            .map(|t| t.running().is_some())
            .unwrap_or(false);
        Ok(Attached {
            info: session.info.clone(),
            from: replay.from,
            complete: replay.complete,
            cols,
            rows,
            running,
        })
    }

    /// Terminal `id` has no page now (its view went before it was shown): it waits to be
    /// reattached, then is killed after the grace period.
    pub fn detach(&self, id: u32) -> Result<()> {
        let session = self.get(id)?;
        if let Ok(mut listener) = session.listener.lock() {
            listener.detach();
        }
        session.flow.set_detached(true);
        self.reap_later();
        Ok(())
    }

    /// The main page (re)loaded: every terminal another page had is detached, to be reattached by
    /// this one within the grace period or killed (a page `page` started or reattached keeps its
    /// own). Returns how many were detached.
    pub fn detach_except(&self, page: Option<&str>) -> usize {
        let all: Vec<Arc<Session>> = match self.sessions.lock() {
            Ok(map) => map.values().cloned().collect(),
            Err(_) => return 0,
        };
        let mut count = 0;
        let mut waiting = 0;
        for session in all {
            let Ok(mut listener) = session.listener.lock() else {
                continue;
            };
            let mine = page.is_some() && listener.page.as_deref() == page;
            if listener.sink.is_some() && !mine {
                listener.detach();
                session.flow.set_detached(true);
                count += 1;
            }
            if listener.sink.is_none() {
                waiting += 1;
            }
        }
        // Also those whose page went without a notice (their output found nobody).
        if waiting > 0 {
            self.reap_later();
        }
        count
    }

    /// Kills the terminals no page holds now (`terminal.enablePersistentSessions` off: the new
    /// page won't take them back, and a dev server among them would hold its port for the grace
    /// period, D203). Returns how many.
    pub fn kill_detached(&self) -> usize {
        let all: Vec<Arc<Session>> = match self.sessions.lock() {
            Ok(map) => map.values().cloned().collect(),
            Err(_) => return 0,
        };
        let mut count = 0;
        for session in all {
            let detached = session
                .listener
                .lock()
                .map(|l| l.sink.is_none())
                .unwrap_or(false);
            if detached {
                end_session(&session);
                count += 1;
            }
        }
        count
    }

    /// After the grace period, kills the terminals still without a page.
    fn reap_later(&self) {
        let sessions = self.sessions.clone();
        let grace = self.grace;
        let _ = thread::Builder::new()
            .name("pty-reaper".into())
            .spawn(move || {
                thread::sleep(grace + Duration::from_millis(250));
                let expired: Vec<Arc<Session>> = match sessions.lock() {
                    Ok(map) => map
                        .values()
                        .filter(|s| {
                            s.listener.lock().is_ok_and(|l| {
                                revive::expired(l.detached_at.map(|t| t.elapsed()), grace)
                            })
                        })
                        .cloned()
                        .collect(),
                    Err(_) => return,
                };
                for session in expired {
                    end_session(&session);
                }
            });
    }

    /// Ids of terminals waiting for a page (the tests' view of detached sessions).
    #[cfg(test)]
    pub fn detached_ids(&self) -> Vec<u32> {
        let Ok(map) = self.sessions.lock() else {
            return Vec::new();
        };
        let mut ids: Vec<u32> = map
            .iter()
            .filter(|(_, s)| s.listener.lock().is_ok_and(|l| l.sink.is_none()))
            .map(|(id, _)| *id)
            .collect();
        ids.sort_unstable();
        ids
    }

    /// The program terminal `id` started (its aliases are read from it, `globals`).
    pub fn shell_program(&self, id: u32) -> Result<String> {
        Ok(self.get(id)?.shell.clone())
    }

    /// The folder a terminal's shell is in now (shell integration), else the one it started in.
    pub fn current_dir(&self, id: u32) -> Result<PathBuf> {
        let session = self.get(id)?;
        let reported = session.tracker.lock().ok().and_then(|t| t.cwd.clone());
        Ok(reported
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| session.cwd.clone()))
    }

    /// Command records (newest last, at most `limit`) and the cwd reported by the shell.
    pub fn commands(&self, id: u32, limit: usize) -> Result<TerminalCommands> {
        let session = self.get(id)?;
        let tracker = session
            .tracker
            .lock()
            .map_err(|_| Error::Pty("lock poisoned".into()))?;
        let skip = tracker.records.len().saturating_sub(limit);
        Ok(TerminalCommands {
            integration_active: tracker.active,
            cwd: tracker.cwd.clone(),
            running: tracker.running().cloned(),
            commands: tracker.records[skip..].to_vec(),
        })
    }

    pub fn write(&self, id: u32, data: &str) -> Result<()> {
        let session = self.get(id)?;
        session
            .input
            .send(data.as_bytes().to_vec())
            .map_err(|_| Error::Pty("the terminal's input is closed".into()))
    }

    /// Asks for a new size; applied off the caller's thread, the latest one winning (D192).
    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<()> {
        let session = self.get(id)?;
        let size = PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        };
        if let Ok(mut current) = session.size.lock() {
            *current = size;
        }
        let start_worker = {
            let mut pending = session
                .pending_size
                .lock()
                .map_err(|_| Error::Pty("lock poisoned".into()))?;
            let idle = pending.is_none();
            *pending = Some(size);
            idle
        };
        if start_worker {
            let worker = Arc::clone(&session);
            thread::Builder::new()
                .name(format!("pty-{id}-resize"))
                .spawn(move || loop {
                    // Take the latest size; stop when none is left (the next resize starts a
                    // new worker). The pending slot is emptied only after it's applied, so a
                    // size asked for meanwhile is never lost.
                    let Some(next) = worker.pending_size.lock().ok().and_then(|p| *p) else {
                        return;
                    };
                    if let Ok(console) = worker.console.lock() {
                        console.resize(next);
                    }
                    let Ok(mut pending) = worker.pending_size.lock() else {
                        return;
                    };
                    if *pending == Some(next) {
                        *pending = None;
                        return;
                    }
                })
                .map_err(|e| Error::Pty(e.to_string()))?;
        }
        Ok(())
    }

    pub fn ack(&self, id: u32, bytes: usize) -> Result<()> {
        // Acks can race with exit; a missing session is not an error.
        if let Ok(session) = self.get(id) {
            session.flow.ack(bytes);
        }
        Ok(())
    }

    pub fn kill(&self, id: u32) -> Result<()> {
        let session = self.get(id)?;
        session.flow.close();
        // Windows: the shell's children (a dev server, Claude Code and its MCP servers) end with
        // it, not when the console's close reaches them, or never (D192). `taskkill` takes a
        // moment: off the caller's (async runtime) thread, the tree first while the shell still
        // ties it together, then the shell.
        #[cfg(windows)]
        {
            let spawned = thread::Builder::new()
                .name(format!("pty-{id}-kill"))
                .spawn(move || end_session(&session));
            spawned.map(|_| ()).map_err(Error::from)
        }
        #[cfg(not(windows))]
        {
            let mut killer = session
                .killer
                .lock()
                .map_err(|_| Error::Pty("lock poisoned".into()))?;
            killer.kill()?;
            Ok(())
        }
    }

    /// Kills every terminal; called when the app exits so no shells are left behind.
    pub fn kill_all(&self) {
        // Kill outside the lock (see the waiter in `spawn`).
        let all: Vec<Arc<Session>> = match self.sessions.lock() {
            Ok(map) => map.values().cloned().collect(),
            Err(_) => return,
        };
        for session in all {
            // The shells' children too, as `kill` does (a reload left dev servers holding their
            // ports until the IDE exited; D203 audit).
            end_session(&session);
        }
    }

    fn get(&self, id: u32) -> Result<Arc<Session>> {
        self.lock()?
            .get(&id)
            .cloned()
            .ok_or_else(|| Error::Pty(format!("no terminal with id {id}")))
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, HashMap<u32, Arc<Session>>>> {
        self.sessions
            .lock()
            .map_err(|_| Error::Pty("lock poisoned".into()))
    }
}

/// Ends a terminal's shell (and on Windows everything it started); the waiter removes it.
fn end_session(session: &Session) {
    session.flow.close();
    #[cfg(windows)]
    if let Some(pid) = session.pid {
        kill_tree(pid);
    }
    if let Ok(mut killer) = session.killer.lock() {
        let _ = killer.kill();
    }
}

/// A console just opened, before its shell starts.
enum Opened {
    #[cfg(windows)]
    Con(conpty::ConPty),
    #[cfg(not(windows))]
    Native(portable_pty::PtyPair),
    Remote(Arc<crate::remote::pty::RemotePty>),
}

type Io = (Box<dyn Read + Send>, Box<dyn Write + Send>);

fn open_console(size: PtySize) -> Result<Opened> {
    #[cfg(windows)]
    {
        conpty::open(size)
            .map(Opened::Con)
            .map_err(|e| Error::Pty(e.to_string()))
    }
    #[cfg(not(windows))]
    {
        portable_pty::native_pty_system()
            .openpty(size)
            .map(Opened::Native)
            .map_err(|e| Error::Pty(e.to_string()))
    }
}

impl Opened {
    fn io(&self) -> Result<Io> {
        match self {
            Opened::Remote(pty) => pty.io(),
            #[cfg(windows)]
            Opened::Con(pty) => Ok((Box::new(pty.reader()?), Box::new(pty.take_writer()?))),
            #[cfg(not(windows))]
            Opened::Native(pair) => {
                let reader = pair
                    .master
                    .try_clone_reader()
                    .map_err(|e| Error::Pty(e.to_string()))?;
                let writer = pair
                    .master
                    .take_writer()
                    .map_err(|e| Error::Pty(e.to_string()))?;
                Ok((reader, writer))
            }
        }
    }

    /// Starts the shell or task; `verbatim` ends the command line as written (Windows).
    fn spawn(
        &self,
        cmd: CommandBuilder,
        verbatim: Option<&str>,
    ) -> Result<Box<dyn portable_pty::Child + Send + Sync>> {
        match self {
            Opened::Remote(pty) => pty.spawn(&cmd),
            #[cfg(windows)]
            Opened::Con(pty) => pty
                .spawn(&cmd, verbatim)
                .map(|c| Box::new(c) as Box<dyn portable_pty::Child + Send + Sync>)
                .map_err(|e| Error::Pty(e.to_string())),
            #[cfg(not(windows))]
            Opened::Native(pair) => {
                let mut cmd = cmd;
                if let Some(tail) = verbatim {
                    cmd.arg(tail);
                }
                pair.slave
                    .spawn_command(cmd)
                    .map_err(|e| Error::Pty(e.to_string()))
            }
        }
    }

    fn into_console(self) -> Console {
        match self {
            Opened::Remote(pty) => Console::Remote(pty),
            #[cfg(windows)]
            Opened::Con(pty) => Console::Con(pty),
            // The slave end closes here (the shell has its own): EOF reaches the reader when the
            // shell ends.
            #[cfg(not(windows))]
            Opened::Native(pair) => Console::Native(pair.master),
        }
    }
}

fn read_loop(
    mut reader: Box<dyn Read + Send>,
    flow: &Flow,
    listener: &Mutex<Listener>,
    tracker: &Mutex<CommandTracker>,
) {
    // Read until EOF whether or not a page listens: a console whose output pipe isn't drained
    // can't close on Windows (see `spawn`), and a detached terminal's output is kept for the page
    // that reattaches. One thread reads; this one gathers what arrives within COALESCE into one
    // message (see there).
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(16);
    thread::scope(|scope| {
        let pump = thread::Builder::new()
            .name("pty-read-raw".into())
            .spawn_scoped(scope, move || {
                let mut buf = vec![0u8; READ_CHUNK];
                loop {
                    flow.wait_for_room();
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if tx.send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        if pump.is_err() {
            return;
        }
        while let Ok(mut chunk) = rx.recv() {
            let until = Instant::now() + COALESCE;
            while chunk.len() < COALESCE_MAX {
                let left = until.saturating_duration_since(Instant::now());
                match rx.recv_timeout(left) {
                    Ok(more) => chunk.extend_from_slice(&more),
                    // Time's up, or the reader ended (what's gathered still goes out).
                    Err(_) => break,
                }
            }
            deliver(&chunk, flow, listener, tracker);
        }
    });
}

/// Output gathered for this long after a read goes to the page as one message (D254): ConPTY
/// hands a flood over in many small reads, and on WebView2 each message and its ack is an IPC
/// round trip, which held a flood to a few hundred lines a second. VS Code buffers 5 ms too.
const COALESCE: Duration = Duration::from_millis(5);
/// …or until this much is gathered.
const COALESCE_MAX: usize = 256 * 1024;

fn deliver(chunk: &[u8], flow: &Flow, listener: &Mutex<Listener>, tracker: &Mutex<CommandTracker>) {
    if let Ok(mut t) = tracker.lock() {
        t.feed(chunk);
    }
    let Ok(mut l) = listener.lock() else {
        return;
    };
    l.ring.push(chunk);
    let delivered = l.sink.as_ref().map(|sink| {
        flow.sent(chunk.len());
        sink(Output::Data(chunk.to_vec()))
    });
    // The page is gone without a reload notice (closed webview): nobody to wait for.
    if delivered == Some(false) {
        l.detach();
        flow.set_detached(true);
    }
}

/// Ends a process and everything it started (Windows `taskkill /T`), without a console window.
#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(0x0800_0000)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;
    use tasks::ShellSpec;

    fn collecting() -> (Sink, Arc<Mutex<Vec<u8>>>) {
        let out = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink_out = out.clone();
        let sink: Sink = Box::new(move |message| {
            if let (Output::Data(bytes), Ok(mut o)) = (message, sink_out.lock()) {
                o.extend_from_slice(&bytes);
            }
            true
        });
        (sink, out)
    }

    fn wait_for(what: impl Fn() -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(15) {
            if what() {
                return true;
            }
            thread::sleep(Duration::from_millis(50));
        }
        false
    }

    /// A terminal survives its page: detached, reattached with its output replayed, detached
    /// again and killed once the grace period passes.
    #[test]
    fn a_detached_terminal_is_reattached_or_reaped() {
        let manager = PtyManager {
            grace: Duration::from_millis(800),
            ..PtyManager::default()
        };
        let spec = if cfg!(windows) {
            RunSpec {
                kind: "shell".into(),
                command: "echo revive-first & ping -n 30 127.0.0.1 >nul".into(),
                args: vec![],
                shell: Some(ShellSpec {
                    executable: std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()),
                    args: vec![],
                }),
                env: HashMap::new(),
            }
        } else {
            RunSpec {
                kind: "shell".into(),
                command: "echo revive-first; sleep 30".into(),
                args: vec![],
                shell: Some(ShellSpec {
                    executable: "/bin/sh".into(),
                    args: vec![],
                }),
                env: HashMap::new(),
            }
        };
        let (sink, first) = collecting();
        let info = match manager.spawn(
            std::env::temp_dir(),
            100,
            30,
            sink,
            SpawnOptions {
                run: Some(spec),
                page: Some("page-1".into()),
                ..SpawnOptions::default()
            },
        ) {
            Ok(info) => info,
            Err(e) => panic!("spawn failed: {e}"),
        };
        // The console asks for the cursor position (xterm.js answers in the app).
        let _ = manager.write(info.id, "\x1b[1;1R");
        let seen = |out: &Arc<Mutex<Vec<u8>>>| {
            out.lock()
                .map(|o| String::from_utf8_lossy(&o).contains("revive-first"))
                .unwrap_or(false)
        };
        assert!(wait_for(|| seen(&first)), "no output from the task");
        // The page that started it keeps it; another page's load detaches it.
        assert_eq!(manager.detach_except(Some("page-1")), 0);
        assert_eq!(manager.detach_except(Some("page-2")), 1);
        assert_eq!(manager.detached_ids(), vec![info.id]);
        // The wrong key: refused.
        let (sink, _) = collecting();
        assert!(manager
            .attach(info.id, "nope", None, sink, None, None)
            .is_err());
        // The right one: the output so far comes again, then the live output.
        let (sink, second) = collecting();
        let attached = match manager.attach(
            info.id,
            &info.key,
            Some("page-2".into()),
            sink,
            None,
            Some((90, 20)),
        ) {
            Ok(a) => a,
            Err(e) => panic!("attach failed: {e}"),
        };
        assert_eq!(attached.info.id, info.id);
        assert_eq!((attached.cols, attached.rows), (90, 20));
        assert!(seen(&second), "the replay is missing the earlier output");
        assert!(manager.detached_ids().is_empty());
        // Shown by a page: a second attach is refused.
        let (sink, _) = collecting();
        let again = manager.attach(info.id, &info.key, None, sink, None, None);
        assert!(again.is_err_and(|e| e.to_string().contains("AlreadyAttached")));
        // Up to date: an attach from the end replays nothing (checked on the ring itself).
        // Let go again and not taken back: ended after the grace period.
        assert!(manager.detach(info.id).is_ok());
        assert!(
            wait_for(|| manager.get(info.id).is_err()),
            "the orphaned terminal was not reaped"
        );
    }
}
