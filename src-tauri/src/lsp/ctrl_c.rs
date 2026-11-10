//! Ctrl+C for a program on Windows (an extension's `process.interrupt`, a notebook kernel's
//! interrupt). Programs here are started without a window (`CREATE_NO_WINDOW`), which still gives
//! each one a hidden console of its own. A process can send Ctrl+C only to a console it is
//! attached to, and attaching changes that whole process's console state (its ignore-Ctrl+C flag
//! is inherited by every program it starts meanwhile, its standard handles may point at the
//! other console afterwards). So the IDE doesn't attach itself: it starts its own executable as
//! a short-lived helper (`--send-ctrl-c <pid>`, handled in `main.rs` before anything else) that
//! leaves its own console, attaches to the program's, ignores the event itself, sends it and
//! exits. That works from development runs with a console too.

#[cfg(windows)]
use std::time::{Duration, Instant};

/// The helper's flag (internal; never shown in `--help`).
pub const HELPER_FLAG: &str = "--send-ctrl-c";

/// How long the helper may take.
#[cfg(windows)]
const HELPER_TIMEOUT: Duration = Duration::from_secs(5);

/// Sends Ctrl+C to the console of process `pid` (the program and anything it started there).
#[cfg(windows)]
pub fn send_ctrl_c(pid: u32) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let exe =
        std::env::current_exe().map_err(|e| format!("Couldn't interrupt the program ({e})."))?;
    let mut child = std::process::Command::new(exe)
        .arg(HELPER_FLAG)
        .arg(pid.to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Couldn't interrupt the program ({e})."))?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => return Err(
                "Couldn't reach the program's console to interrupt it; send it a message instead."
                    .into(),
            ),
            Ok(None) if start.elapsed() < HELPER_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(20))
            }
            Ok(None) => {
                let _ = child.kill();
                return Err("Interrupting the program timed out.".into());
            }
            Err(e) => return Err(format!("Couldn't interrupt the program ({e}).")),
        }
    }
}

/// When this process was started as the Ctrl+C helper: send it and return the exit code
/// (0 sent, 1 not). None for any other start.
pub fn helper() -> Option<i32> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some(HELPER_FLAG) {
        return None;
    }
    let pid: u32 = args.next().and_then(|p| p.parse().ok())?;
    Some(helper_send(pid))
}

#[cfg(windows)]
fn helper_send(pid: u32) -> i32 {
    use windows::Win32::System::Console::{
        AttachConsole, FreeConsole, GenerateConsoleCtrlEvent, SetConsoleCtrlHandler, CTRL_C_EVENT,
    };
    // SAFETY: plain Win32 console calls in a process that exists only for this.
    unsafe {
        let _ = FreeConsole();
        if AttachConsole(pid).is_err() {
            return 1;
        }
        // The event reaches this process too: it must not end it before it's sent.
        if SetConsoleCtrlHandler(None, true).is_err() {
            return 1;
        }
        if GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0).is_err() {
            return 1;
        }
    }
    0
}

#[cfg(not(windows))]
fn helper_send(_pid: u32) -> i32 {
    1
}
