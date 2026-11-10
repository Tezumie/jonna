//! Diagnostics (D204): the session log (write, recent lines), the problem report's zip, starting
//! with extensions off, and what the frontend needs to know about this start.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::diagnostics::{self, ExtensionsOff};
use crate::error::{Error, Result};
use crate::AppState;

/// What this start knows about itself and the last one.
pub struct SessionState {
    pub log: std::sync::Arc<diagnostics::log::SessionLog>,
    pub extensions_off: Option<ExtensionsOff>,
    pub previous_version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// This session's log file and the folder of session logs.
    log_file: String,
    logs_dir: String,
    /// The folder of this session's output channel files (D209).
    channels_dir: String,
    /// "commandLine" / "restart" when extensions are off for this session.
    extensions_off: Option<&'static str>,
    /// "off" / "on" when the next start is set to differ.
    next_start: Option<String>,
    /// The version that ran before this one (None on a first start).
    previous_version: Option<String>,
}

#[tauri::command]
pub async fn session_info(state: State<'_, AppState>) -> Result<SessionInfo> {
    let s = &state.session;
    Ok(SessionInfo {
        log_file: s.log.path().to_string_lossy().into_owned(),
        logs_dir: s.log.dir().to_string_lossy().into_owned(),
        channels_dir: s.log.channels_dir().to_string_lossy().into_owned(),
        extensions_off: s.extensions_off.map(ExtensionsOff::as_str),
        next_start: diagnostics::next_start(&state.dirs.data),
        previous_version: s.previous_version.clone(),
    })
}

#[derive(Deserialize)]
pub struct LogEntry {
    level: String,
    source: String,
    message: String,
    /// An output channel's (D209: "exthost", "git", "lsp.<server>"…): its own file.
    channel: Option<String>,
}

/// Appends the frontend's records (errors, failed IPC calls; output channels' lines) to the
/// session log or a channel's file, redacted.
#[tauri::command]
pub async fn log_write(state: State<'_, AppState>, entries: Vec<LogEntry>) -> Result<()> {
    for e in entries.iter().take(500) {
        match e.channel.as_deref() {
            Some(channel) => state
                .session
                .log
                .write_channel(channel, &e.level, &e.source, &e.message),
            None => state.session.log.write(&e.level, &e.source, &e.message),
        }
    }
    Ok(())
}

/// The session log's last `max` records (at most 2000).
#[tauri::command]
pub async fn log_recent(state: State<'_, AppState>, max: usize) -> Result<Vec<String>> {
    let log = state.session.log.clone();
    tokio::task::spawn_blocking(move || log.recent(max.min(2000)))
        .await
        .map_err(|e| Error::Invalid(e.to_string()))
}

#[derive(Deserialize)]
pub struct ReportFile {
    name: String,
    text: Option<String>,
    /// Binary contents (the screenshot), standard base64.
    base64: Option<String>,
}

/// Most a problem report's files may hold together.
const MAX_REPORT_BYTES: usize = 256 * 1024 * 1024;

/// Writes the problem report as a zip to `path` (a path the user picked in the save dialog).
#[tauri::command]
pub async fn report_save_zip(path: String, files: Vec<ReportFile>) -> Result<()> {
    let target = std::path::PathBuf::from(&path);
    if !path.to_ascii_lowercase().ends_with(".zip") {
        return Err(Error::Invalid("the report is saved as a .zip file".into()));
    }
    if !target.parent().is_some_and(|p| p.is_dir()) {
        return Err(Error::Invalid(format!("no such folder for {path}")));
    }
    let mut entries = Vec::new();
    let mut total = 0usize;
    for f in files.into_iter().take(20) {
        let name: String = f
            .name
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
            .collect();
        if name.is_empty() || name.starts_with('.') {
            return Err(Error::Invalid(format!("bad file name: {}", f.name)));
        }
        let bytes = match (f.text, f.base64) {
            (Some(t), _) => t.into_bytes(),
            (None, Some(b)) => crate::ai::transcribe::decode_base64(&b)?,
            (None, None) => Vec::new(),
        };
        // The zip writer has no zip64 (sizes are 32-bit): a report is a few MB anyway.
        total += bytes.len();
        if total > MAX_REPORT_BYTES {
            return Err(Error::Invalid("the report is too large to save".into()));
        }
        entries.push((name, bytes));
    }
    tokio::task::spawn_blocking(move || {
        let bytes = diagnostics::zip::build(&entries)?;
        crate::store::atomic_write(&target, &bytes)
    })
    .await
    .map_err(|e| Error::Invalid(e.to_string()))?
}

/// Sets how the next start runs (`extensionsOff`: true off, false on, null as usual) and, with
/// `restart`, restarts now. Test runs only set the flag (they never restart); returns whether
/// the app restarts.
#[tauri::command]
pub async fn app_relaunch(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    extensions_off: Option<bool>,
    restart: bool,
) -> Result<bool> {
    diagnostics::set_next_start(&state.dirs.data, extensions_off)?;
    if !restart || state.cli.test_script.is_some() {
        return Ok(false);
    }
    state.session.log.write(
        "info",
        "app",
        match extensions_off {
            Some(true) => "Restarting with extensions off.",
            _ => "Restarting.",
        },
    );
    app.restart();
}

/// The git command lines run after `after` (D209 leftovers: the Git output channel lists them),
/// oldest first, redacted. Named outside `git_` so fetching them isn't itself a git call.
#[tauri::command]
pub async fn log_git_commands(after: u64) -> Result<Vec<crate::git::journal::GitCall>> {
    // The user's home folder shows as `~` (their name stays out of the log file).
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok();
    Ok(crate::git::journal::since(after, home.as_deref()))
}
