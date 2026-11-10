//! The process list for attaching (D204, `${command:pickProcess}`): what `ps` prints on macOS and
//! Linux, or PowerShell's Win32_Process as JSON on Windows. Returned as text with its format; the
//! frontend parses it (`src/extensions/debug/processes.ts`, tested).

use std::time::Duration;

use serde::Serialize;

use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessListing {
    /// "ps" (`pid ppid args` lines) or "windows" (JSON of ProcessId, ParentProcessId, Name,
    /// CommandLine).
    pub format: &'static str,
    pub text: String,
}

pub async fn list() -> Result<ProcessListing> {
    #[cfg(windows)]
    let (format, mut cmd) = {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("powershell.exe");
        // The browser pane's debugging port is for the IDE's own webviews (D229).
        cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
        cmd.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
        ]);
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        ("windows", cmd)
    };
    #[cfg(not(windows))]
    let (format, mut cmd) = {
        let mut cmd = std::process::Command::new("ps");
        // The browser pane's debugging port is for the IDE's own webviews (D229).
        cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
        // -ww: whole command lines (the inspector port is often at the end).
        cmd.args(["-A", "-ww", "-o", "pid=,ppid=,args="]);
        ("ps", cmd)
    };
    cmd.stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let job = tauri::async_runtime::spawn_blocking(move || cmd.output());
    let out = tokio::time::timeout(Duration::from_secs(20), job)
        .await
        .map_err(|_| Error::Invalid("listing processes took too long".into()))?
        .map_err(|e| Error::Invalid(format!("couldn't list the processes: {e}")))??;
    if !out.status.success() && out.stdout.is_empty() {
        return Err(Error::Invalid("couldn't list the processes".into()));
    }
    Ok(ProcessListing {
        format,
        text: String::from_utf8_lossy(&out.stdout).into_owned(),
    })
}
