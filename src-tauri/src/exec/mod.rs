//! Non-interactive command execution for agents (`run_command`): the user's shell runs the command
//! line in a workspace folder, stdout and stderr stream back (merged, in order of arrival) and the
//! call ends with the exit code. A timeout or `cancel` kills the whole process tree's leader.

pub mod format;
pub mod sandbox;
pub mod sandbox_net;
pub mod sandbox_protect;
pub mod sandbox_read;
#[cfg(all(test, windows))]
mod sandbox_win_tests;

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub duration_ms: u64,
    /// It ran in the command sandbox (D336).
    pub sandboxed: bool,
    /// Hosts the sandbox's network filter refused (D350).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub blocked_hosts: Vec<String>,
    /// What the sandbox couldn't set up (a secret it couldn't hide, D349).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sandbox_notes: Vec<String>,
}

/// The shell and its "run this string" flag.
pub(crate) fn shell_command(command: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let (shell, script) = powershell_script(command);
        let mut cmd = Command::new(shell);
        // The browser pane's debugging port (D204) is for the IDE's own webviews only.
        cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
        cmd.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script.as_str(),
        ]);
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }
    #[cfg(not(windows))]
    {
        // A login shell picks up the user's PATH (nvm, cargo, pyenv…) even when the IDE was
        // started from a desktop launcher.
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut cmd = Command::new(shell);
        // The browser pane's debugging port is for the IDE's own webviews (D229).
        cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
        cmd.args(["-lc", command]);
        // Own process group, so a timeout or cancel kills `npm test`'s children too.
        std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
        cmd
    }
}

/// Windows: the PowerShell to run (7 when installed, else 5.1) and the script for its `-Command`.
#[cfg(windows)]
pub(crate) fn powershell_script(command: &str) -> (PathBuf, String) {
    {
        let pwsh = crate::pty::find_pwsh();
        let legacy = pwsh.is_none();
        let shell = pwsh.unwrap_or_else(|| PathBuf::from("powershell.exe"));
        // Bash habits (`rm -rf`, `| head`, `2>/dev/null`) that fail in PowerShell (D144).
        let translated = crate::pty::bash_idioms::powershell_from_bash(command);
        let command = translated.as_deref().unwrap_or(command);
        // Windows PowerShell 5.1 has no && / || (models write them all the time).
        let command = if legacy {
            crate::pty::chain::ps5_chain(command).unwrap_or_else(|| command.to_string())
        } else {
            command.to_string()
        };
        // UTF-8 both ways: the console's code page garbled names like José and box drawing.
        // `-Command` exits with 1 for any failure; the program's own exit code (a hook's 2, a test
        // runner's) is passed on instead (D227). On a new line, so a trailing `# comment` in the
        // command can't swallow it. A failed cmdlet (no exit code of its own) still gives 1. A
        // rewritten `a && b` (ps5_chain) ends in an `if`, so its `$__ideOk` says how it went.
        // Windows PowerShell 5.1's `>` and `>>` write UTF-16 (`echo x >> notes.txt` made a file
        // git calls binary): UTF-8 there, as PowerShell 7 does.
        let redirects = if legacy {
            "$PSDefaultParameterValues['Out-File:Encoding']='utf8'; "
        } else {
            ""
        };
        let command = format!(
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; {redirects}$global:LASTEXITCODE = $null; {command}\nif (-not $? -or $__ideOk -eq $false) {{ if ($LASTEXITCODE) {{ exit $LASTEXITCODE }} else {{ exit 1 }} }}"
        );
        (shell, command)
    }
}

/// How long output readers may keep going after the process exited (see `wait_for_readers`).
const READER_GRACE: Duration = Duration::from_secs(2);

/// Joins reader threads that finish within `grace`; the rest are left detached. A pipe stays open
/// as long as any process holding it lives, so a backgrounded grandchild would otherwise make a
/// plain `join` block forever.
pub(crate) fn wait_for_readers<T>(readers: Vec<std::thread::JoinHandle<T>>, grace: Duration) {
    let deadline = Instant::now() + grace;
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
}

/// `first`'s PATH entries, then the ones only `then` has, without duplicates (case-insensitive
/// when `sep` is ';', Windows). Empty entries are dropped.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn merge_path(first: &str, then: &str, sep: char) -> String {
    let key = |s: &str| {
        let s = s.trim().trim_end_matches(['\\', '/']);
        if sep == ';' {
            s.to_lowercase()
        } else {
            s.to_string()
        }
    };
    let mut seen = HashSet::new();
    let mut out: Vec<&str> = Vec::new();
    for entry in first.split(sep).chain(then.split(sep)) {
        let entry = entry.trim();
        if !entry.is_empty() && seen.insert(key(entry)) {
            out.push(entry);
        }
    }
    out.join(&sep.to_string())
}

/// Windows (D200): reads PATH again as a new process would get it (the machine's, then the
/// user's) and adds the entries that are new, so a tool winget or an installer just added is
/// found without restarting the IDE.
/// Returns whether PATH changed. Elsewhere commands run in a login shell already: no-op.
#[cfg(windows)]
pub fn refresh_path() -> Result<bool> {
    use std::os::windows::process::CommandExt;
    let out = Command::new("powershell.exe")
        .env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR)
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            // UTF-8 out (the console's code page would garble C:\Users\José).
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
        ])
        .creation_flags(0x0800_0000)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()?;
    let fresh = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || fresh.is_empty() {
        return Ok(false);
    }
    let current = std::env::var("PATH").unwrap_or_default();
    // What the IDE was started with keeps its order (a launcher's nvm or venv first); only
    // entries the system added since go at the end.
    let merged = merge_path(&current, &fresh, ';');
    if merged == current {
        return Ok(false);
    }
    std::env::set_var("PATH", merged);
    Ok(true)
}

#[cfg(not(windows))]
pub fn refresh_path() -> Result<bool> {
    Ok(false)
}

/// Kills the process tree rooted at `pid` (Windows): `child.kill()` only ends the direct child,
/// so a `cmd /C foo.cmd` shim would leave `node.exe` running.
#[cfg(windows)]
pub(crate) fn taskkill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(0x0800_0000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// Runs `cmd` (stdin and stderr discarded) and returns its exit status and stdout, or None if it
/// didn't start or didn't finish within `deadline` (then it is killed). For quick probes such as a
/// login shell's `command -v`, where a slow or interactive shell profile must not hang the caller.
// Used by the login-shell probes, which don't exist on Windows.
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn output_within(
    cmd: &mut Command,
    deadline: Duration,
) -> Option<(std::process::ExitStatus, Vec<u8>)> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = crate::job::spawn(cmd).ok()?;
    let (tx, rx) = std::sync::mpsc::channel();
    if let Some(mut out) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = out.read_to_end(&mut buf);
            let _ = tx.send(buf);
        });
    }
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            // Too slow, or we can't tell: don't leave it running.
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    // Something the shell backgrounded may still hold stdout open; don't wait on it for long.
    let out = rx.recv_timeout(READER_GRACE).unwrap_or_default();
    Some((status, out))
}

/// Kills the command and everything it started.
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        if let Ok(pid) = i32::try_from(child.id()) {
            // SAFETY: kill(2) with a negative pid signals the process group we created; no memory
            // is involved.
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
    #[cfg(windows)]
    taskkill_tree(child.id());
    let _ = child.kill();
}

#[derive(Default)]
pub struct ExecService {
    running: Mutex<HashMap<String, Arc<Mutex<std::process::Child>>>>,
    /// Command id → the window that started it (its page reloads: killed, D163).
    owners: Mutex<HashMap<String, String>>,
    /// Ids cancelled before their run registered (Stop right after Allow): never started (D161).
    cancelled_early: Mutex<HashSet<String>>,
    /// A running sandboxed command's refused hosts, read while it runs (D372).
    blocked: Mutex<HashMap<String, BlockedSet>>,
}

type BlockedSet = Arc<Mutex<std::collections::BTreeSet<String>>>;

/// Takes a command's refused-host set out of the map when the run ends, by any path.
struct ForgetBlocked<'a> {
    map: &'a Mutex<HashMap<String, BlockedSet>>,
    id: String,
}

impl Drop for ForgetBlocked<'_> {
    fn drop(&mut self) {
        if let Ok(mut map) = self.map.lock() {
            map.remove(&self.id);
        }
    }
}

impl ExecService {
    /// Runs `command` in `cwd`; output chunks go to `output` as they arrive (lossy UTF-8).
    pub fn run<F: FnMut(String) + Send + 'static>(
        &self,
        id: &str,
        command: &str,
        cwd: &Path,
        timeout: Duration,
        output: F,
    ) -> Result<ExecResult> {
        self.run_with_env(id, command, cwd, timeout, &[], output)
    }

    /// `run` with extra environment variables (a worktree's setup script gets its PORT, D207).
    pub fn run_with_env<F: FnMut(String) + Send + 'static>(
        &self,
        id: &str,
        command: &str,
        cwd: &Path,
        timeout: Duration,
        env: &[(String, String)],
        output: F,
    ) -> Result<ExecResult> {
        self.run_with_input(id, command, cwd, timeout, env, None, output)
    }

    /// `run` in the command sandbox (D336, `sandbox.rs`); `env` as `run_with_env`. A folder on a
    /// remote or in WSL runs as usual (`sandboxed` false in the result).
    #[allow(clippy::too_many_arguments)]
    pub fn run_sandboxed_with<F: FnMut(String) + Send + 'static>(
        &self,
        id: &str,
        command: &str,
        cwd: &Path,
        timeout: Duration,
        env: &[(String, String)],
        sandbox: &sandbox::Sandbox,
        output: F,
    ) -> Result<ExecResult> {
        let result = self.run_inner(id, command, cwd, timeout, env, None, Some(sandbox), output);
        if let Ok(mut owners) = self.owners.lock() {
            owners.remove(id);
        }
        result
    }

    /// `run_sandboxed_with` without extra variables.
    #[cfg(test)]
    pub fn run_sandboxed<F: FnMut(String) + Send + 'static>(
        &self,
        id: &str,
        command: &str,
        cwd: &Path,
        timeout: Duration,
        sandbox: &sandbox::Sandbox,
        output: F,
    ) -> Result<ExecResult> {
        self.run_sandboxed_with(id, command, cwd, timeout, &[], sandbox, output)
    }

    /// `run_with_env` with `input` written to the command's stdin, then closed (the agent's hooks
    /// read their event as JSON there, as Claude Code's do, D227).
    #[allow(clippy::too_many_arguments)]
    pub fn run_with_input<F: FnMut(String) + Send + 'static>(
        &self,
        id: &str,
        command: &str,
        cwd: &Path,
        timeout: Duration,
        env: &[(String, String)],
        input: Option<String>,
        output: F,
    ) -> Result<ExecResult> {
        let result = self.run_inner(id, command, cwd, timeout, env, input, None, output);
        // Done: no longer the window's. A page reload cancels its window's ids, and a finished
        // one left here was marked "cancelled early", so a later run reusing the id never ran.
        if let Ok(mut owners) = self.owners.lock() {
            owners.remove(id);
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn run_inner<F: FnMut(String) + Send + 'static>(
        &self,
        id: &str,
        command: &str,
        cwd: &Path,
        timeout: Duration,
        env: &[(String, String)],
        input: Option<String>,
        sandbox: Option<&sandbox::Sandbox>,
        output: F,
    ) -> Result<ExecResult> {
        let start = Instant::now();
        if self
            .cancelled_early
            .lock()
            .map(|mut set| set.remove(id))
            .unwrap_or(false)
        {
            return Ok(ExecResult {
                exit_code: None,
                timed_out: false,
                cancelled: true,
                duration_ms: 0,
                sandboxed: false,
                blocked_hosts: Vec::new(),
                sandbox_notes: Vec::new(),
            });
        }
        // A remote window's folder (D252): the command runs there, in the user's login shell
        // (`$SHELL -l -c`, through the relay).
        let remote = crate::remote::of_dir(cwd);
        // The sandbox (D336) is this machine's: not for a remote's or WSL's folder.
        let sandbox = sandbox.filter(|_| remote.is_none() && crate::wsl::of_dir(cwd).is_none());
        // What the sandbox holds while the command runs (its network filter, D348).
        let mut guard = sandbox::SandboxGuard::default();
        // A folder inside WSL (D192): the command runs there, in bash.
        let mut cmd = match (&remote, crate::wsl::of_dir(cwd)) {
            (Some(dir), _) => crate::remote::command(dir, "", &["-c".into(), command.into()]),
            (None, Some(at)) => crate::wsl::command(&at, "bash", &["-lc".into(), command.into()]),
            (None, None) => {
                let mut c = match sandbox {
                    Some(sb) => {
                        let (c, g) = sandbox::shell_command(command, sb)?;
                        guard = g;
                        c
                    }
                    None => shell_command(command),
                };
                c.current_dir(cwd);
                c
            }
        };
        cmd.stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("TERM", "dumb")
        .env("NO_COLOR", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("CI", "1");
        for (name, value) in env {
            cmd.env(name, value);
        }
        if remote.is_some() {
            crate::remote::share_env(&mut cmd);
        } else if crate::wsl::of_dir(cwd).is_some() {
            crate::wsl::share_env(&mut cmd);
        }
        // Ends with the IDE, however it ends (D180): in the job before it runs.
        let started = match sandbox {
            Some(_) => sandbox::spawn(&mut cmd)
                .map_err(|e| Error::Exec(format!("the sandbox couldn't start the shell: {e}"))),
            None => crate::job::spawn(&mut cmd)
                .map_err(|e| Error::Exec(format!("couldn't start the shell: {e}"))),
        };
        let mut child = started?;
        // Written from a thread: a command that prints a lot before reading could otherwise fill
        // its stdout pipe while we wait to write. Dropping the pipe closes stdin.
        if let (Some(text), Some(mut pipe)) = (input, child.stdin.take()) {
            std::thread::spawn(move || {
                let _ = pipe.write_all(text.as_bytes());
            });
        }
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let child = Arc::new(Mutex::new(child));
        self.lock()?.insert(id.to_string(), child.clone());
        if let (Some(proxy), Ok(mut map)) = (guard.proxy.as_ref(), self.blocked.lock()) {
            map.insert(id.to_string(), proxy.blocked_set());
        }
        // Gone from the map however the run ends (an early `?` too, D379).
        let _forget_blocked = ForgetBlocked {
            map: &self.blocked,
            id: id.to_string(),
        };
        // A cancel that came while the shell started (after the check above, before the insert)
        // found nothing running and was set aside: it applies now (Stop during a hook, D227).
        if self
            .cancelled_early
            .lock()
            .map(|mut set| set.remove(id))
            .unwrap_or(false)
        {
            self.cancel(id)?;
        }
        let output = Arc::new(Mutex::new(output));
        // Set once we stop waiting for output: a reader that is still alive after that (a
        // backgrounded grandchild keeps the pipe open) must not call `output` any more.
        let closed = Arc::new(AtomicBool::new(false));
        let readers: Vec<_> = [
            stdout.map(|s| Box::new(s) as Box<dyn Read + Send>),
            stderr.map(|s| Box::new(s) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        .map(|mut pipe| {
            let output = output.clone();
            let closed = closed.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 8192];
                // A character split between two reads is kept for the next one (decoding each
                // read on its own turned it into U+FFFD).
                let mut pending: Vec<u8> = Vec::new();
                while let Ok(n) = pipe.read(&mut buf) {
                    if n == 0 || closed.load(Ordering::Acquire) {
                        break;
                    }
                    pending.extend_from_slice(&buf[..n]);
                    let text = take_utf8(&mut pending);
                    if text.is_empty() {
                        continue;
                    }
                    if let Ok(mut f) = output.lock() {
                        f(text);
                    }
                }
                if !pending.is_empty() {
                    if let Ok(mut f) = output.lock() {
                        f(String::from_utf8_lossy(&pending).into_owned());
                    }
                }
            })
        })
        .collect();
        let mut timed_out = false;
        let waited: Result<Option<std::process::ExitStatus>> = loop {
            let done = match child.lock() {
                Ok(mut c) => c.try_wait().map_err(Error::from),
                Err(_) => Err(Error::Exec("lock poisoned".into())),
            };
            match done {
                Ok(Some(status)) => break Ok(Some(status)),
                Ok(None) => {}
                Err(e) => break Err(e),
            }
            if !self.lock()?.contains_key(id) {
                // cancelled: `cancel` removed it and killed the child
                break Ok(None);
            }
            // Kill once: on Windows each kill_tree spawns taskkill, and the loop runs every 20 ms
            // until the shell is reaped.
            if !timed_out && start.elapsed() > timeout {
                timed_out = true;
                if let Ok(mut c) = child.lock() {
                    kill_tree(&mut c);
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        if waited.is_err() {
            // We can't tell whether the child is alive: kill it rather than leave it running
            // untracked.
            if let Ok(mut c) = child.lock() {
                kill_tree(&mut c);
            }
        }
        // The shell is gone, but a grandchild it backgrounded (`npm run dev &`) can hold the pipes
        // open forever: give the readers a moment to drain, then stop waiting and leave them
        // detached (they exit on their own when the pipe closes).
        wait_for_readers(readers, READER_GRACE);
        closed.store(true, Ordering::Release);
        let status = match waited {
            Ok(s) => s,
            Err(e) => {
                self.lock()?.remove(id);
                return Err(e);
            }
        };
        let cancelled = status.is_none();
        let exit_code = match status {
            Some(s) => s.code(),
            None => {
                // Cancelled: reaped without holding the lock while it waits. On Windows `cancel`
                // kills from a thread that needs this lock: a blocking `wait()` that got the lock
                // first waited for a kill that could never come. Its code isn't reported anyway.
                let deadline = Instant::now() + Duration::from_secs(5);
                while Instant::now() < deadline {
                    let done = child
                        .lock()
                        .map(|mut c| !matches!(c.try_wait(), Ok(None)))
                        .unwrap_or(true);
                    if done {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                None
            }
        };
        self.lock()?.remove(id);
        Ok(ExecResult {
            exit_code: if timed_out || cancelled {
                None
            } else {
                exit_code
            },
            timed_out,
            cancelled,
            duration_ms: start.elapsed().as_millis() as u64,
            sandboxed: sandbox.is_some(),
            blocked_hosts: guard
                .proxy
                .as_ref()
                .map(|p| p.blocked())
                .unwrap_or_default(),
            sandbox_notes: guard.notes,
        })
    }

    /// The hosts a running sandboxed command was refused so far (empty when none, or not running).
    pub fn blocked_hosts(&self, id: &str) -> Vec<String> {
        let set = self.blocked.lock().ok().and_then(|m| m.get(id).cloned());
        set.and_then(|s| s.lock().ok().map(|b| b.iter().cloned().collect()))
            .unwrap_or_default()
    }

    pub fn cancel(&self, id: &str) -> Result<()> {
        // Out of the lock first: `run`'s loop takes it every 20 ms.
        let removed = self.lock()?.remove(id);
        if let Some(child) = removed {
            let kill = move || {
                if let Ok(mut c) = child.lock() {
                    kill_tree(&mut c);
                }
            };
            // Windows' `taskkill` takes a moment: not on the caller's (async runtime) thread.
            if cfg!(windows) {
                std::thread::spawn(kill);
            } else {
                kill();
            }
        } else if let Ok(mut early) = self.cancelled_early.lock() {
            // Ids are unique per tool call; the set only grows by cancels of calls that never
            // ran a command, so a bound keeps it small.
            if early.len() > 256 {
                early.clear();
            }
            early.insert(id.to_string());
        }
        Ok(())
    }

    /// Remembers which window runs command `id` (see `cancel_owner`).
    pub fn set_owner(&self, id: &str, owner: &str) {
        if let Ok(mut owners) = self.owners.lock() {
            // Finished commands leave their entry: dropped here once there are many.
            if owners.len() > 512 {
                if let Ok(running) = self.running.lock() {
                    owners.retain(|k, _| running.contains_key(k));
                }
            }
            owners.insert(id.to_string(), owner.to_string());
        }
    }

    /// Kills the commands window `owner` started (its page reloaded, D163).
    pub fn cancel_owner(&self, owner: &str) {
        let ids: Vec<String> = match self.owners.lock() {
            Ok(mut owners) => {
                let ids = owners
                    .iter()
                    .filter(|(_, by)| by.as_str() == owner)
                    .map(|(id, _)| id.clone())
                    .collect();
                owners.retain(|_, by| by != owner);
                ids
            }
            Err(_) => return,
        };
        // `cancel` also covers a command registered to the window but not started yet (the
        // page reloaded between `set_owner` and `run`): it's marked so `run` doesn't start it.
        for id in ids {
            let _ = self.cancel(&id);
        }
    }

    /// Kills every running command (the app is exiting: they'd outlive it untimed, D161).
    pub fn cancel_all(&self) {
        if let Ok(mut running) = self.running.lock() {
            for (_, child) in running.drain() {
                if let Ok(mut c) = child.lock() {
                    kill_tree(&mut c);
                }
            }
        }
    }

    fn lock(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, Arc<Mutex<std::process::Child>>>>> {
        self.running
            .lock()
            .map_err(|_| Error::Exec("lock poisoned".into()))
    }
}

/// Resolves a working directory: inside the workspace only.
/// A folder that was asked for but doesn't exist is an error: running in the root instead would
/// run `rm -rf *` meant for `build/` in the whole project (D161).
pub fn workdir(root: &Path, cwd: Option<PathBuf>) -> Result<PathBuf> {
    match cwd {
        None => Ok(root.to_path_buf()),
        // A remote window's folder is looked at there (D252).
        Some(c) if c.starts_with(root) && crate::remote::is_dir(&c) => Ok(c),
        Some(c) => Err(Error::Exec(format!(
            "the folder {} doesn't exist in the workspace",
            c.display()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn runs_streams_and_reports_exit_codes() {
        let svc = ExecService::default();
        let out = Arc::new(Mutex::new(String::new()));
        let sink = out.clone();
        let r = svc
            .run(
                "a",
                "echo hello; echo oops 1>&2; exit 3",
                &std::env::temp_dir(),
                Duration::from_secs(10),
                move |s| sink.lock().unwrap().push_str(&s),
            )
            .unwrap();
        assert_eq!(r.exit_code, Some(3));
        let text = out.lock().unwrap().clone();
        assert!(text.contains("hello") && text.contains("oops"), "{text}");
        let r = svc
            .run(
                "b",
                "sleep 5",
                &std::env::temp_dir(),
                Duration::from_millis(200),
                |_| {},
            )
            .unwrap();
        assert!(r.timed_out && r.exit_code.is_none());
    }

    #[test]
    fn cancelled_before_running_never_starts() {
        let svc = ExecService::default();
        svc.cancel("early").unwrap();
        let ran = Arc::new(AtomicBool::new(false));
        let flag = ran.clone();
        let r = svc
            .run(
                "early",
                "echo should-not-run",
                &std::env::temp_dir(),
                Duration::from_secs(10),
                move |_| flag.store(true, Ordering::Release),
            )
            .unwrap();
        assert!(r.cancelled && !ran.load(Ordering::Acquire));
        let root = std::env::temp_dir();
        assert!(workdir(&root, Some(root.join("no-such-folder-d161"))).is_err());
        assert_eq!(workdir(&root, None).unwrap(), root);
    }

    /// D293: a finished command isn't its window's any more, so the window's reload doesn't
    /// mark its id "cancelled early" and a later run with that id still runs.
    #[test]
    fn a_finished_command_is_not_cancelled_by_its_window_reloading() {
        let svc = ExecService::default();
        let run = |svc: &ExecService| {
            svc.run(
                "hook-1",
                "echo ran",
                &std::env::temp_dir(),
                Duration::from_secs(10),
                |_| {},
            )
            .unwrap()
        };
        svc.set_owner("hook-1", "main");
        assert!(!run(&svc).cancelled);
        svc.cancel_owner("main");
        svc.set_owner("hook-1", "main");
        assert!(!run(&svc).cancelled);
    }

    #[cfg(unix)]
    #[test]
    fn backgrounded_grandchild_does_not_hang() {
        let svc = ExecService::default();
        let start = Instant::now();
        // The background sleep inherits stdout/stderr and keeps them open after the shell exits.
        let r = svc
            .run(
                "bg",
                "sleep 6 & echo started",
                &std::env::temp_dir(),
                Duration::from_secs(60),
                |_| {},
            )
            .unwrap();
        assert_eq!(r.exit_code, Some(0));
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "{:?}",
            start.elapsed()
        );
        assert!(svc.lock().unwrap().is_empty());
    }
}

/// The user's and the machine's PATH as the registry has them now (Windows): newer than this
/// process's own when something was installed since it started (D192). Bounded: `reg` answers in
/// milliseconds, but nothing here may hang.
#[cfg(windows)]
pub(crate) fn fresh_windows_path() -> Vec<std::path::PathBuf> {
    let keys = [
        "HKCU\\Environment",
        "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    ];
    let mut out = Vec::new();
    for key in keys {
        let mut cmd = Command::new("reg");
        // The browser pane's debugging port is for the IDE's own webviews (D229).
        cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
        cmd.args(["query", key, "/v", "Path"]);
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let Some((_, stdout)) = output_within(&mut cmd, std::time::Duration::from_secs(2)) else {
            continue;
        };
        out.extend(parse_reg_path(&String::from_utf8_lossy(&stdout)));
    }
    out
}

/// The directories in `reg query … /v Path` output, with %VARIABLES% expanded.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn parse_reg_path(text: &str) -> Vec<std::path::PathBuf> {
    let Some(line) = text
        .lines()
        .find(|l| l.trim_start().to_ascii_lowercase().starts_with("path "))
    else {
        return Vec::new();
    };
    let value = line
        .split("REG_EXPAND_SZ")
        .nth(1)
        .or_else(|| line.split("REG_SZ").nth(1))
        .unwrap_or("")
        .trim();
    value
        .split(';')
        .filter(|s| !s.trim().is_empty())
        .map(|s| std::path::PathBuf::from(expand_percent(s.trim())))
        .collect()
}

fn expand_percent(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod reg_path_tests {
    #[test]
    fn reads_the_path_value_of_reg_query() {
        std::env::set_var("IDE_TEST_HOME", "C:\\Users\\a");
        let text = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %IDE_TEST_HOME%\\AppData\\Roaming\\npm;C:\\Tools;;\r\n";
        let dirs = super::parse_reg_path(text);
        assert_eq!(
            dirs,
            vec![
                std::path::PathBuf::from("C:\\Users\\a\\AppData\\Roaming\\npm"),
                std::path::PathBuf::from("C:\\Tools")
            ]
        );
        assert!(super::parse_reg_path("nothing").is_empty());
    }
}

#[cfg(test)]
mod path_tests {
    use super::merge_path;

    #[test]
    fn merge_path_keeps_order_and_drops_duplicates() {
        assert_eq!(
            merge_path("C:\\A;C:\\B\\;", "c:\\b;C:\\Own;;C:\\A", ';'),
            "C:\\A;C:\\B\\;C:\\Own"
        );
        assert_eq!(
            merge_path("/usr/bin:/bin", "/opt/x:/usr/bin", ':'),
            "/usr/bin:/bin:/opt/x"
        );
        // Case matters outside Windows.
        assert_eq!(merge_path("/A", "/a", ':'), "/A:/a");
    }
}

/// The text decodable from the start of `bytes` (invalid bytes replaced), leaving an incomplete
/// character at the end in `bytes` for the next read.
fn take_utf8(bytes: &mut Vec<u8>) -> String {
    let keep = match std::str::from_utf8(bytes) {
        Ok(_) => 0,
        Err(e) if e.error_len().is_none() => bytes.len() - e.valid_up_to(),
        Err(_) => {
            // Invalid in the middle: find an incomplete tail at the very end, if any.
            let tail = bytes.len().saturating_sub(3);
            (tail..bytes.len())
                .find(|&i| {
                    std::str::from_utf8(&bytes[i..])
                        .err()
                        .is_some_and(|e| e.valid_up_to() == 0 && e.error_len().is_none())
                })
                .map_or(0, |i| bytes.len() - i)
        }
    };
    let rest = bytes.split_off(bytes.len() - keep);
    let text = String::from_utf8_lossy(bytes).into_owned();
    *bytes = rest;
    text
}

#[cfg(test)]
mod utf8_tests {
    use super::take_utf8;

    #[test]
    fn keeps_a_character_split_between_reads() {
        let all = "José ─ 漢".as_bytes();
        let mut pending = all[..4].to_vec(); // "Jos" + the first byte of é
        assert_eq!(take_utf8(&mut pending), "Jos");
        pending.extend_from_slice(&all[4..]);
        assert_eq!(take_utf8(&mut pending), "é ─ 漢");
        assert!(pending.is_empty());
        let mut bad = vec![b'a', 0xff, b'b', 0xe6];
        assert_eq!(take_utf8(&mut bad), "a\u{fffd}b");
        assert_eq!(bad, vec![0xe6]);
    }
}
