//! App-level commands: app info and test hooks, the audit log, and the state store.

use crate::error::{Error, Result};
use crate::store::atomic_write;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    data_dir: String,
    config_dir: String,
    logs_dir: String,
    audit_log: String,
    os: &'static str,
    arch: &'static str,
    /// Wall-clock time the native process started (ms since epoch), for cold-start measurement.
    process_start_ms: f64,
    debug_build: bool,
    /// Folder passed on the command line (`<binary> <folder>`), if it exists.
    launch_folder: Option<String>,
    /// A "New window" start: no folder means an empty window, not the last folder.
    new_window: bool,
    /// `--run-test-script <file>`: the script to run after startup (then the app exits).
    test_script: Option<TestScript>,
    /// Windows build number (e.g. 22631), for the terminal's ConPTY handling; None elsewhere.
    os_build: Option<u32>,
    /// The user's home folder (where new projects are suggested, D121).
    home_dir: Option<String>,
    /// Downloads, Desktop and temp folders, for the risky-folder checks (D213).
    user_folders: crate::user_folders::UserFolders,
    /// The remote this window works on (D252, `ssh:box`): the frontend connects before it opens
    /// the folder (`launch_folder` is then the remote's path). Null for a local window.
    remote: Option<String>,
}

/// Windows build number from `ver` ("Microsoft Windows [Version 10.0.22631.4317]"), once.
fn os_build() -> Option<u32> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::sync::OnceLock;
        static BUILD: OnceLock<Option<u32>> = OnceLock::new();
        *BUILD.get_or_init(|| {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let out = std::process::Command::new("cmd")
                .env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR)
                .args(["/C", "ver"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .ok()?;
            parse_build(&String::from_utf8_lossy(&out.stdout))
        })
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// The third number of a Windows version string: `10.0.22631.4317` → 22631.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_build(text: &str) -> Option<u32> {
    let start = text.find(|c: char| c.is_ascii_digit())?;
    let version: String = text[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    version.split('.').nth(2)?.parse().ok()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TestScript {
    path: String,
    text: String,
}

#[tauri::command]
pub async fn app_info(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<AppInfo> {
    Ok(AppInfo {
        data_dir: state.dirs.data.to_string_lossy().into_owned(),
        config_dir: state.dirs.config.to_string_lossy().into_owned(),
        logs_dir: state.dirs.logs.to_string_lossy().into_owned(),
        audit_log: state.audit.path().to_string_lossy().into_owned(),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        process_start_ms: state.process_start_ms,
        debug_build: cfg!(debug_assertions),
        launch_folder: launch_folder(&state.cli),
        new_window: state.cli.new_window,
        test_script: state.cli.test_script.as_ref().map(|p| TestScript {
            path: p.to_string_lossy().into_owned(),
            text: std::fs::read_to_string(p).unwrap_or_default(),
        }),
        os_build: os_build(),
        home_dir: std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(|h| std::path::PathBuf::from(h).to_string_lossy().into_owned()),
        user_folders: crate::user_folders::user_folders(&app),
        remote: crate::remote::active().map(|r| r.authority.as_string()),
    })
}

/// A line of test-run output on stdout (what CI shows).
/// Reads PATH again from the system (Windows, D200: after installing a language server with
/// winget); returns whether it changed.
#[tauri::command]
pub async fn app_refresh_path() -> Result<bool> {
    tokio::task::spawn_blocking(crate::exec::refresh_path)
        .await
        .map_err(|e| crate::error::Error::Exec(e.to_string()))?
}

/// Shows the mouse pointer before a native file dialog opens (D210). On Windows, "hide pointer
/// while typing" can leave it hidden over a dialog opened straight from a key press (Clone
/// repository's Enter), since the webview never sees the mouse move that shows it again. Not
/// async: Tauri runs it on the main thread, the one that owns the window the dialog belongs to.
/// Elsewhere it does nothing.
#[tauri::command]
pub fn app_show_cursor() {
    #[cfg(windows)]
    // SAFETY: plain user32 calls on the calling (main) thread, no pointers kept.
    unsafe {
        use ::windows::Win32::UI::WindowsAndMessaging::{
            LoadCursorW, SetCursor, ShowCursor, IDC_ARROW,
        };
        // The display count shows the pointer at 0 or more: raise it to 0 if it's below, and
        // undo the probe if it was already shown.
        let mut count = ShowCursor(true);
        if count > 0 {
            ShowCursor(false);
        }
        let mut guard = 0;
        while count < 0 && guard < 64 {
            count = ShowCursor(true);
            guard += 1;
        }
        if let Ok(arrow) = LoadCursorW(None, IDC_ARROW) {
            SetCursor(Some(arrow));
        }
    }
}

/// Asks for the user's attention without taking focus (D254): the taskbar button flashes on
/// Windows, the Dock icon bounces once on macOS, the window is marked urgent on Linux. Stops by
/// itself once the window is focused.
#[tauri::command]
pub fn app_request_attention(window: tauri::WebviewWindow) -> Result<()> {
    window.request_user_attention(Some(tauri::UserAttentionType::Informational))?;
    Ok(())
}

#[tauri::command]
pub async fn test_log(line: String) -> Result<()> {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    writeln!(out, "{line}")?;
    out.flush()?;
    Ok(())
}

/// Ends a test run with `code` (0 = all steps passed). Only in test mode.
#[tauri::command]
pub async fn app_exit(app: tauri::AppHandle, state: State<'_, AppState>, code: i32) -> Result<()> {
    if state.cli.test_script.is_none() {
        return Err(crate::error::Error::Invalid(
            "app_exit is only for test runs".into(),
        ));
    }
    state.pty.kill_all();
    app.exit(code);
    Ok(())
}

/// Starts another IDE window (a second process) on `folder`, with the same profile folder when
/// one was given. Test runs don't spawn (returns false). `restored`: started by the last
/// session's restore, so it opens where that folder's window was (D229). `empty`: the last
/// session's empty window with that backup id (one this start was handed), with its unsaved text.
#[tauri::command]
pub async fn app_new_window(
    state: State<'_, AppState>,
    folder: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
    tag: Option<String>,
    restored: Option<bool>,
    empty: Option<String>,
    // D252: the new window works on this remote (`ssh:box`); `folder` is then its POSIX path.
    remote: Option<String>,
) -> Result<bool> {
    // A remote window's location as the registry and the restore keep it (`ssh://box/path`).
    let (remote, folder) = match (
        remote.filter(|r| !r.is_empty()),
        folder.as_deref().and_then(crate::cli::remote_location),
    ) {
        (None, Some((authority, path))) => (Some(authority), Some(path)),
        (remote, _) => (remote, folder),
    };
    if let Some(authority) = &remote {
        crate::remote::Authority::parse(authority)?;
        if let Some(f) = folder.as_deref().filter(|f| !f.is_empty()) {
            if !f.starts_with('/') || f.split('/').any(|p| p == "..") {
                return Err(Error::Invalid(format!("not a folder on the remote: {f}")));
            }
        }
    }
    if state.cli.test_script.is_some() {
        return Ok(false);
    }
    let exe = std::env::current_exe()?;
    let mut cmd = std::process::Command::new(exe);
    // The browser pane's debugging port is for the IDE's own webviews (D229).
    cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
    // A worktree agent's window gets its own PORT (D204): every command and terminal in it
    // inherits these. Only those names: a list of risky ones would miss some (GIT_SSH_COMMAND,
    // BASH_ENV, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS opening a debugging port…).
    for (name, value) in env.unwrap_or_default() {
        if !new_window_env_allowed(&name) {
            return Err(Error::Invalid(format!(
                "not an environment variable a window may set: {name}"
            )));
        }
        cmd.env(name, value);
    }
    if let Some(authority) = &remote {
        cmd.arg("--remote").arg(authority);
        if let Some(f) = folder.filter(|f| !f.is_empty()) {
            cmd.arg(f);
        }
    } else if let Some(f) = folder.filter(|f| !f.is_empty()) {
        // A folder, or a `.code-workspace` file (the new window opens it as a workspace).
        let path = std::path::Path::new(&f);
        let workspace_file = path.is_file() && crate::fs::is_workspace_file_name(path);
        if f.starts_with('-') || !(path.is_dir() || workspace_file) {
            return Err(Error::Invalid(format!("not a folder: {f}")));
        }
        cmd.arg(f);
    }
    if let Some(dir) = &state.cli.user_data_dir {
        cmd.arg("--user-data-dir").arg(dir);
    }
    cmd.arg("--new-window");
    if restored == Some(true) {
        cmd.arg("--restored");
    }
    if let Some(id) = empty.filter(|i| !i.is_empty()) {
        if !crate::instances::server::offered_empty(&id) {
            return Err(Error::Invalid(format!("not a window to restore: {id}")));
        }
        cmd.arg("--restore-empty").arg(id);
    }
    let child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    // A tagged window (a worktree agent's, D207) is kept, so this window can tell when it
    // has closed; others are left to run on their own.
    if let Some(tag) = tag.filter(|t| !t.is_empty()) {
        windows::remember(tag, child);
    }
    Ok(true)
}

/// Whether the windows started with these tags are still open: true, false (closed), or null
/// when unknown. A tag this process didn't start (or no longer knows: this window restarted)
/// is answered from the window registry when `folders` gives its folder (D222): open when a
/// running window has that folder open, else closed.
#[tauri::command]
pub async fn app_windows_alive(
    tags: Vec<String>,
    folders: Option<Vec<String>>,
) -> Result<Vec<Option<bool>>> {
    let known: Vec<Option<bool>> = tags.iter().map(|t| windows::alive(t)).collect();
    let folders = folders.unwrap_or_default();
    if known.iter().all(Option::is_some) || folders.is_empty() {
        return Ok(known);
    }
    // Pings other windows (up to 400 ms each when one hangs): off the async runtime.
    tokio::task::spawn_blocking(move || {
        known
            .into_iter()
            .enumerate()
            .map(|(i, k)| {
                k.or_else(|| {
                    let folder = folders.get(i).filter(|f| !f.is_empty())?;
                    crate::instances::server::window_open_with(&canonical_folder(folder))
                })
            })
            .collect()
    })
    .await
    .map_err(|e| Error::Exec(e.to_string()))
}

/// The folder as a window's registration names it (canonical, D209), else as given.
fn canonical_folder(folder: &str) -> String {
    // A network folder is compared as given: touching it makes Windows connect (D161).
    if crate::fs::is_unc(folder) {
        return folder.to_string();
    }
    std::fs::canonicalize(folder)
        .map(crate::store::simplify)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| folder.to_string())
}

/// The windows this process started with a tag, by tag (D207).
mod windows {
    use std::process::Child;
    use std::sync::{Mutex, OnceLock};

    /// Kept at most: the oldest are forgotten (asked about, they're unknown).
    const LIMIT: usize = 64;

    fn started() -> &'static Mutex<Vec<(String, Child)>> {
        static STARTED: OnceLock<Mutex<Vec<(String, Child)>>> = OnceLock::new();
        STARTED.get_or_init(|| Mutex::new(Vec::new()))
    }

    pub fn remember(tag: String, child: Child) {
        if let Ok(mut list) = started().lock() {
            list.retain(|(t, _)| *t != tag);
            if list.len() >= LIMIT {
                list.remove(0);
            }
            list.push((tag, child));
        }
    }

    /// Some(true) while it runs, Some(false) once it has exited (reaped here), None: unknown.
    pub fn alive(tag: &str) -> Option<bool> {
        let mut list = started().lock().ok()?;
        let (_, child) = list.iter_mut().find(|(t, _)| t == tag)?;
        Some(matches!(child.try_wait(), Ok(None)))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn a_tagged_process_is_alive_then_closed() {
            let quick = if cfg!(windows) {
                std::process::Command::new("cmd")
                    .args(["/c", "exit"])
                    .spawn()
            } else {
                std::process::Command::new("true").spawn()
            };
            let Ok(child) = quick else { return };
            remember("t-quick".into(), child);
            let mut gone = false;
            for _ in 0..100 {
                if alive("t-quick") == Some(false) {
                    gone = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            assert!(gone);
            assert_eq!(alive("t-unknown"), None);
        }
    }
}

/// The variables a new window may be given (a worktree agent's port, D204), and its setup
/// script (D207).
pub(crate) fn new_window_env_allowed(name: &str) -> bool {
    matches!(
        name,
        "PORT" | "WORKTREE_INDEX" | "WORKTREE_PORT_BASE" | "WORKTREE_PORT_STEP"
    )
}

/// The folder argument (like `code <folder>`), canonical.
fn launch_folder(cli: &crate::cli::CliArgs) -> Option<String> {
    if cli.remote.is_some() {
        return cli.remote_folder.clone();
    }
    cli.folder
        .clone()
        .map(|p| {
            std::fs::canonicalize(&p)
                .map(crate::store::simplify)
                .unwrap_or(p)
        })
        .map(|p| p.to_string_lossy().into_owned())
}

/// Appends one JSON object line to `logs/audit.jsonl`.
#[tauri::command]
pub async fn audit_append(state: State<'_, AppState>, entry: String) -> Result<()> {
    state.audit.append(&entry)
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum StateScope {
    /// App-wide UI state (last opened folder, …).
    Global,
    /// State of the open workspace (layout, tabs, view state).
    Workspace,
}

fn state_file(state: &AppState, scope: StateScope) -> Result<PathBuf> {
    Ok(match scope {
        StateScope::Global => state.dirs.global_state_file(),
        // Kept for the `.code-workspace` file when one is open, else for the folder.
        StateScope::Workspace => state
            .dirs
            .workspace_state_file(&state.workspace.location()?),
    })
}

/// Returns the stored JSON text, or `null` if nothing was saved yet.
#[tauri::command]
pub async fn state_load(state: State<'_, AppState>, scope: StateScope) -> Result<Option<String>> {
    match std::fs::read_to_string(state_file(&state, scope)?) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Atomically replaces the stored state. `json` must parse as JSON.
#[tauri::command]
pub async fn state_save(state: State<'_, AppState>, scope: StateScope, json: String) -> Result<()> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| Error::Invalid(e.to_string()))?;
    atomic_write(&state_file(&state, scope)?, json.as_bytes())
}

#[cfg(test)]
mod tests {
    #[test]
    fn windows_build_from_ver() {
        assert_eq!(
            super::parse_build("\r\nMicrosoft Windows [Version 10.0.22631.4317]\r\n"),
            Some(22631)
        );
        assert_eq!(super::parse_build("nothing"), None);
    }

    #[test]
    fn a_new_window_gets_only_the_worktree_port_variables() {
        assert!(super::new_window_env_allowed("PORT"));
        assert!(super::new_window_env_allowed("WORKTREE_PORT_STEP"));
        for bad in [
            "PATH",
            "GIT_SSH_COMMAND",
            "BASH_ENV",
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "port",
            "",
        ] {
            assert!(!super::new_window_env_allowed(bad), "{bad}");
        }
    }
}
