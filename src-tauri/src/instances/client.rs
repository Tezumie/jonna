//! The command line's side (D209), before any window starts: `<cli> folder` (or a
//! `.code-workspace` file) focuses the window that has it open; `<cli> file[:line[:col]]` and
//! `--diff a b` go to a running window (the one with the file's folder, else the last focused);
//! `--add <folder>` goes to the last focused window; `--wait` blocks until their tabs are
//! closed (git's `core.editor`), starting a window first when none runs. Started from a shell
//! (the PATH shim, or a terminal), a new window is started detached, so the shell gets its prompt
//! back — unless `--wait` or `--verbose`.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use super::{alive, read_entries, registry_dir, send, target_for_files, Entry, Request};
use crate::cli::CliArgs;

/// The variable the PATH shim sets (shell_command.rs): this start is the command line's.
pub const CLI_ENV: &str = "IDE_CLI";

/// How long `--wait` waits for a window it started to listen.
const START_WAIT: Duration = Duration::from_secs(45);

/// What this launch does: hand over to a running window and exit with the code, or None to start
/// as a window itself.
pub fn forward() -> Option<i32> {
    let cli = CliArgs::current();
    if cli.test_script.is_some() {
        return None;
    }
    let from_shell = started_from_shell() && !cli.verbose;
    // A plain window (`<cli>`, `<cli> -n`, `<cli> -n --add <folder>`): from a shell it's
    // detached, so the prompt comes back (the PATH shim's cmd.exe waits for the program it
    // runs, GUI or not).
    if cli.new_window && cli.files.is_empty() && cli.diff.is_none() || !cli.wants_something() {
        return detached_or_here(from_shell, cli.wait);
    }
    let dir = registry_dir(cli.user_data_dir.as_deref())?;
    let live: Vec<Entry> = read_entries(&dir)
        .into_iter()
        .map(|(_, e)| e)
        .filter(|e| e.pid != std::process::id() && alive(e))
        .collect();
    let opening_files = !cli.files.is_empty() || cli.diff.is_some();
    let adding = !cli.add.is_empty();
    // A link to the IDE (D255): the window used last takes it; with none, this one starts.
    if !opening_files && !adding && cli.folder.is_none() {
        if let Some(url) = &cli.open_url {
            let request = Request::Open {
                files: Vec::new(),
                diff: None,
                wait: false,
                add: Vec::new(),
                url: Some(url.clone()),
            };
            return match live.iter().max_by_key(|e| e.focused_ms) {
                Some(entry) => Some(hand_over(entry, &request, false)),
                None if from_shell => Some(detach()),
                None => None,
            };
        }
    }
    if !opening_files && !adding {
        // A folder (or a workspace file): its window if one has it open (VS Code), else a new
        // window.
        let folder = canonical(cli.folder.as_ref()?);
        let window = live.iter().find(|e| {
            e.folder
                .as_deref()
                .is_some_and(|f| super::same_folder(f, &folder))
        });
        if let Some(entry) = window {
            allow_foreground(entry.pid);
            return Some(
                if send(entry, &Request::Focus, Duration::from_secs(3)).is_ok() {
                    0
                } else {
                    1
                },
            );
        }
        return if from_shell { Some(detach()) } else { None };
    }
    let paths: Vec<String> = cli
        .files
        .iter()
        .map(|f| f.path.clone())
        .chain(cli.diff.iter().map(|(_, b)| b.clone()))
        .collect();
    let request = Request::Open {
        files: cli.files.clone(),
        diff: cli.diff.clone(),
        wait: cli.wait,
        add: if adding {
            cli.folders_to_add()
        } else {
            Vec::new()
        },
        url: cli.open_url.clone(),
    };
    // Folders to add go to the window used last (VS Code's `--add`), files with them; files
    // alone to the window that has their folder.
    let target = if adding {
        live.iter().max_by_key(|e| e.focused_ms)
    } else {
        target_for_files(&live, &paths)
    };
    if let Some(entry) = target {
        return Some(hand_over(entry, &request, cli.wait));
    }
    // No window runs.
    if !cli.wait {
        // This process becomes the window (it opens its own files; the first folder to add is
        // its folder, `CliArgs::into_window`), or a detached one does.
        return if from_shell { Some(detach()) } else { None };
    }
    // --wait: a window of its own (without the files), then hand them over and wait.
    if spawn_window(&cli, false).is_err() {
        return Some(1);
    }
    let deadline = Instant::now() + START_WAIT;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
        let started: Vec<Entry> = read_entries(&dir)
            .into_iter()
            .map(|(_, e)| e)
            .filter(alive)
            .collect();
        if let Some(entry) = started.iter().max_by_key(|e| e.focused_ms) {
            return Some(hand_over(entry, &request, true));
        }
    }
    Some(1)
}

/// A launch that becomes a window of its own: from a shell (without `--wait`) a detached copy
/// starts and this process exits 0; else None (this process is the window).
fn detached_or_here(from_shell: bool, wait: bool) -> Option<i32> {
    if should_detach(from_shell, wait) {
        Some(detach())
    } else {
        None
    }
}

/// Whether a window started from the command line runs detached from the shell: always from a
/// shell, except with `--wait` (the shell waits on purpose: `<cli> --wait` with nothing to open
/// waits for the window, as VS Code's `code -w` does).
pub fn should_detach(from_shell: bool, wait: bool) -> bool {
    from_shell && !wait
}

/// Sends the files and, with `wait`, blocks until the window says their tabs are closed (or the
/// window goes away).
fn hand_over(entry: &Entry, request: &Request, wait: bool) -> i32 {
    allow_foreground(entry.pid);
    let Ok((reply, stream)) = send(entry, request, Duration::from_secs(5)) else {
        return 1;
    };
    if !reply.ok {
        return 1;
    }
    if !wait {
        return 0;
    }
    let _ = stream.set_read_timeout(None);
    let mut line = String::new();
    // A "done" line, or the end of the stream when the window closed: either way the edit is over.
    let _ = BufReader::new(&stream).read_line(&mut line);
    0
}

/// Started by a shell rather than the desktop: the PATH shim's variable, or a terminal on stdout
/// (Unix: a shell waits for the program it ran, so a window started from it must detach).
fn started_from_shell() -> bool {
    if std::env::var_os(CLI_ENV).is_some_and(|v| !v.is_empty()) {
        return true;
    }
    #[cfg(unix)]
    {
        // SAFETY: isatty only reads the descriptor's state.
        unsafe { libc::isatty(libc::STDOUT_FILENO) == 1 }
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// Starts this same command as a window of its own, detached from the shell; the shell's prompt
/// comes back at once.
fn detach() -> i32 {
    match spawn_window(&CliArgs::current(), true) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

/// Starts a window process. `with_args`: the same arguments (it opens them itself); else only
/// the profile folder (the files come over the socket).
fn spawn_window(cli: &CliArgs, with_args: bool) -> std::io::Result<()> {
    let exe = std::env::current_exe()?;
    let mut cmd = std::process::Command::new(exe);
    // The browser pane's debugging port is for the IDE's own webviews (D229).
    cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
    if with_args {
        cmd.args(
            std::env::args_os()
                .skip(1)
                .filter(|a| a != "--wait" && a != "-w"),
        );
    } else if let Some(dir) = &cli.user_data_dir {
        cmd.arg("--user-data-dir").arg(dir);
    }
    cmd.env_remove(CLI_ENV)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group: the terminal closing (SIGHUP to its jobs) doesn't end it.
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn().map(|_| ())
}

fn canonical(path: &PathBuf) -> String {
    std::fs::canonicalize(path)
        .map(crate::store::simplify)
        .unwrap_or_else(|_| path.clone())
        .to_string_lossy()
        .into_owned()
}

/// Windows lets only the foreground process bring another one's window forward: the launch (or
/// the window the user acted in) hands that right to `pid` first. Nothing to do elsewhere.
pub fn allow_foreground(pid: u32) {
    #[cfg(windows)]
    {
        // SAFETY: a plain Win32 call with a process id; failure only means no permission.
        let _ = unsafe { windows::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow(pid) };
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_from_a_shell_detaches_unless_waited_for() {
        // `<cli>` / `<cli> -n` from the PATH shim or a terminal: the prompt comes back.
        assert!(should_detach(true, false));
        // `<cli> -w`: the shell waits for the window on purpose.
        assert!(!should_detach(true, true));
        // From the desktop (a shortcut, the jump list): this process is the window.
        assert!(!should_detach(false, false));
    }
}
