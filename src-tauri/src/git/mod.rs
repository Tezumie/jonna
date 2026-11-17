//! Git through the user's `git` CLI (PLAN D5): zero added size, and the user's config, hooks and
//! credential helpers just work. Every call runs in the repository root with prompts disabled
//! (`GIT_TERMINAL_PROMPT=0`) so nothing can hang waiting for input; credential helpers with their
//! own UI (Git Credential Manager on Windows) still work. Output parsing lives in `status.rs` (tested);
//! `ops.rs` holds the operations.

pub mod askpass;
pub mod github;
pub mod guard;
pub mod journal;
pub mod lens;
pub mod ops;
pub mod rebase;
pub mod service;
pub mod status;
pub mod trust;
mod watch;
pub mod worktree;

pub use service::{FoundRepo, GitService, RepoInfo};

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::error::{Error, Result};

/// Settings for the git on this machine (not a remote's or WSL's, which run on Linux). Git for
/// Windows refuses paths over 260 characters (deep `node_modules`, monorepos, worktrees under a
/// long folder) unless `core.longpaths` is on, and it's off by default; `-c` turns it on for
/// the IDE's own calls without touching the user's config.
#[cfg(windows)]
const LOCAL_CONFIG: &[&str] = &["-c", "core.longpaths=true"];
#[cfg(not(windows))]
const LOCAL_CONFIG: &[&str] = &[];

/// A folder is never taken for a repository because of its own files: a folder holding `HEAD`,
/// `objects`, `refs` and a `config` is a bare repository to git, which would then read that
/// `config` and run what it names (`core.fsmonitor` on a `git status`). Such files can arrive
/// in a folder without git (an archive, a synced snapshot, a teammate's shared copy). With
/// this, git finds a repository only through a `.git` entry, or where the IDE names the git
/// folder itself (`--git-dir`). Git passes `-c` on to the git programs it starts. Git before
/// 2.38 doesn't know the setting and ignores it.
const BARE_CONFIG: &[&str] = &["-c", "safe.bareRepository=explicit"];

/// A `git` command in `dir`, configured for machine use.
pub fn command(dir: &Path) -> Command {
    // A remote window's repository (D252): git there, through the relay.
    let remote = crate::remote::of_dir(dir);
    // A repository inside WSL (D192): its own git, in the distribution (Windows git on the
    // share is slow and trips over ownership checks).
    let mut cmd = match (&remote, crate::wsl::of_dir(dir)) {
        (Some(at), _) => crate::remote::command(at, "git", &[]),
        (None, Some(at)) => crate::wsl::command(&at, "git", &[]),
        (None, None) => {
            let mut c = Command::new("git");
            // The browser pane's debugging port is for the IDE's own webviews (D229).
            c.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
            c.current_dir(dir);
            c.args(LOCAL_CONFIG);
            c
        }
    };
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        // Merge / rebase --continue / revert never stop for an editor (no one could answer it).
        .env("GIT_EDITOR", "true")
        .args(["-c", "core.quotepath=false", "-c", "color.ui=false"])
        .args(BARE_CONFIG)
        .stdin(Stdio::null());
    if remote.is_some() {
        // The IDE's sign-in prompts don't reach the remote (as in WSL): git there uses its own
        // credential helpers, and fails rather than waits when none answers.
        crate::remote::share_env(&mut cmd);
    } else {
        askpass::apply_env(&mut cmd);
    }
    if remote.is_none() && crate::wsl::of_dir(dir).is_some() {
        crate::wsl::share_env(&mut cmd);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn spawn_error(e: std::io::Error) -> Error {
    if e.kind() == std::io::ErrorKind::NotFound {
        Error::GitMissing
    } else {
        Error::Io(e)
    }
}

/// Runs git with `args` (optionally feeding `stdin`); stdout on success, stderr as the error.
pub fn run(dir: &Path, args: &[&str], stdin: Option<&[u8]>) -> Result<String> {
    let started = std::time::Instant::now();
    // This machine's repositories only: a remote's or WSL's commands never run sandboxed here.
    let local = crate::remote::of_dir(dir).is_none() && crate::wsl::of_dir(dir).is_none();
    // Paused while the repository's settings differ from what was recorded (D392).
    // Off until the folder is trusted (trust.rs), on this machine or another.
    let checked =
        trust::check(dir, args).and_then(|()| if local { guard::check(dir) } else { Ok(()) });
    // Only after git really ran (D407): a refused command's `settle` took the changed settings
    // as the IDE's own, and the next refresh unpaused the repository by itself.
    let ran = checked.is_ok();
    let result = checked.and_then(|()| run_git(dir, args, stdin));
    if local && ran {
        guard::settle(dir, args);
    }
    // The Git output channel lists the command lines (journal.rs).
    let error = match &result {
        Err(Error::Git(msg)) => Some(msg.as_str()),
        Err(Error::GitMissing) => Some("git isn't installed"),
        Err(Error::GitSettingsChanged(msg)) => Some(msg.as_str()),
        _ => None,
    };
    let io_error = match &result {
        Err(Error::Io(e)) => Some(e.to_string()),
        _ => None,
    };
    journal::record(args, started.elapsed(), error.or(io_error.as_deref()));
    result
}

fn run_git(dir: &Path, args: &[&str], stdin: Option<&[u8]>) -> Result<String> {
    let mut cmd = command(dir);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if stdin.is_some() {
        cmd.stdin(Stdio::piped());
    }
    let mut child = cmd.spawn().map_err(spawn_error)?;
    let pipe = child.stdin.take();
    // Feed stdin from a thread while collecting the output: writing it all first deadlocks once
    // git fills its stdout pipe. A failed write (git exited early: broken pipe) isn't returned
    // straight away, or the child would never be reaped and git's own error would be lost.
    let (out, write_error) = std::thread::scope(|scope| {
        let writer = stdin.zip(pipe).map(|(input, mut pipe)| {
            scope.spawn(move || {
                let result = pipe.write_all(input);
                drop(pipe); // close stdin so git sees EOF
                result
            })
        });
        let out = child.wait_with_output();
        let write_error = writer.and_then(|w| match w.join() {
            Ok(result) => result.err(),
            Err(_) => Some(std::io::Error::other("stdin writer panicked")),
        });
        (out, write_error)
    });
    let out = out?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if err.is_empty() {
            let cause = write_error
                .map(|e| format!(", writing its input: {e}"))
                .unwrap_or_default();
            format!(
                "git {} failed ({}{cause})",
                args.first().unwrap_or(&""),
                out.status
            )
        } else {
            err
        };
        Err(Error::Git(msg))
    }
}

/// What `run_unattended` puts before the command: no askpass program from the settings, no
/// transport that reads a local path or runs a program, and a transfer that stalls gives up.
const UNATTENDED_CONFIG: &[&str] = &[
    "-c",
    "core.askPass=",
    "-c",
    "protocol.file.allow=never",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    "http.lowSpeedLimit=1000",
    "-c",
    "http.lowSpeedTime=60",
];

/// Runs git against an address someone else chose (a clone for a copy of a teammate's
/// share): with no prompt of any kind, the IDE's own included, so nobody is asked to sign in
/// to a host they didn't pick, and stopped when it takes longer than `deadline` (a server
/// that never answers, a repository without end). Stored credentials and keys still answer
/// without asking: a private repository both people can reach needs them. Stdout on
/// success; the error says when the time ran out.
pub fn run_unattended(dir: &Path, args: &[&str], deadline: std::time::Duration) -> Result<String> {
    let started = std::time::Instant::now();
    trust::check(dir, args)?;
    let mut cmd = command(dir);
    askpass::deny_env(&mut cmd);
    cmd.args(UNATTENDED_CONFIG)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let result = wait_until(cmd, started + deadline);
    let error = match &result {
        Err(Error::Git(msg)) => Some(msg.clone()),
        Err(Error::GitMissing) => Some("git isn't installed".to_string()),
        Err(Error::Io(e)) => Some(e.to_string()),
        _ => None,
    };
    journal::record(args, started.elapsed(), error.as_deref());
    result
}

/// Spawns `cmd` and waits for it until `until`; then it is killed. Its output is read on
/// threads of their own, which are not waited for after a kill: a helper process git started
/// may still hold the pipes for a moment.
fn wait_until(mut cmd: Command, until: std::time::Instant) -> Result<String> {
    use std::io::Read;
    let mut child = cmd.spawn().map_err(spawn_error)?;
    let read = |pipe: Option<Box<dyn Read + Send>>| {
        let (send, receive) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut out = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut out);
            }
            let _ = send.send(out);
        });
        receive
    };
    let out = read(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let err = read(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() >= until => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Error::Git(
                    "git took too long and was stopped (the server didn't answer in time)".into(),
                ));
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(e) => {
                let _ = child.kill();
                return Err(Error::Io(e));
            }
        }
    };
    // Ended by itself: what it wrote is there (bounded, should a helper linger).
    let grace = std::time::Duration::from_secs(5);
    let stdout = out.recv_timeout(grace).unwrap_or_default();
    let stderr = err.recv_timeout(grace).unwrap_or_default();
    if status.success() {
        Ok(String::from_utf8_lossy(&stdout).into_owned())
    } else {
        let text = String::from_utf8_lossy(&stderr).trim().to_string();
        Err(Error::Git(if text.is_empty() {
            format!("git failed ({status})")
        } else {
            text
        }))
    }
}

/// The repository containing `dir`, or None if it isn't in one (or git is missing).
pub fn repo_root(dir: &Path) -> Option<PathBuf> {
    run(dir, &["rev-parse", "--show-toplevel"], None)
        .ok()
        .map(|s| {
            let s = s.trim();
            // A remote window's git answers with the remote's path: kept as it is (D252).
            if crate::remote::of_dir(dir).is_some() {
                return PathBuf::from(s);
            }
            // Git in WSL answers with a Linux path: back to the Windows path of it (D192).
            if let Some(at) = crate::wsl::of_dir(dir) {
                return crate::wsl::to_windows(&at.distro, s);
            }
            // git prints forward slashes on Windows too.
            if cfg!(windows) {
                PathBuf::from(s.replace('/', "\\"))
            } else {
                PathBuf::from(s)
            }
        })
        .filter(|p| crate::remote::is_dir(p))
}

/// The repository's git directory (absolute), e.g. `<root>/.git` or a worktree's gitdir.
pub fn git_dir(root: &Path) -> Option<PathBuf> {
    run(root, &["rev-parse", "--absolute-git-dir"], None)
        .ok()
        .map(
            |s| match (crate::remote::of_dir(root), crate::wsl::of_dir(root)) {
                (None, Some(at)) => crate::wsl::to_windows(&at.distro, s.trim()),
                _ => PathBuf::from(s.trim()),
            },
        )
        .filter(|p| crate::remote::is_dir(p))
}

#[cfg(test)]
mod tests;
