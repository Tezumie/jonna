//! Windows across processes and the command line (D209, instances/): files other launches hand
//! to this window, a folder already open in another window, the last session's windows, and the
//! shell command in PATH.

use tauri::ipc::Channel;
use tauri::State;

use crate::error::{Error, Result};
use crate::instances::jump_list::{JumpList, JumpListResult};
use crate::instances::server::{self, OpenEvent, Restorable};
use crate::instances::shell_command::{self, ShellCommand};
use crate::AppState;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| Error::Exec(e.to_string()))
}

/// The frontend opens what other launches send (`<cli> file:line`, `--diff`, `--wait`) from now
/// on; what came before is delivered at once.
#[tauri::command]
pub fn instances_listen(on_open: Channel<OpenEvent>) -> Result<()> {
    server::listen(on_open)
}

/// The tabs of request `id` are closed: a `--wait` launch returns.
#[tauri::command]
pub fn instances_done(id: u64) {
    server::done(id);
}

/// Brings the other window that has `folder` open to the front; false when none has.
#[tauri::command]
pub async fn instances_focus_folder(folder: String) -> Result<bool> {
    blocking(move || server::focus_window_with(&folder)).await
}

/// The last session's other windows (window.restoreWindows "all"): their folders and the empty
/// windows that kept unsaved untitled text. Once per start.
#[tauri::command]
pub async fn instances_restorable() -> Result<Restorable> {
    Ok(server::take_restorable())
}

/// This window becomes the last session's empty window `id` (its unsaved text comes back here).
#[tauri::command]
pub fn instances_adopt_empty(id: String) -> Result<()> {
    server::adopt_empty(&id)
}

/// The unsaved untitled text this window kept while it had no folder (JSON), or null.
#[tauri::command]
pub async fn instances_empty_backups_load() -> Result<Option<String>> {
    blocking(server::load_empty_backups).await
}

/// Keeps this empty window's unsaved untitled text for the next start; null removes it.
#[tauri::command]
pub async fn instances_empty_backups_save(json: Option<String>) -> Result<()> {
    blocking(move || server::save_empty_backups(json.as_deref())).await?
}

/// Whether another window of the IDE runs (closing this one doesn't end the session).
#[tauri::command]
pub async fn instances_others_running() -> Result<bool> {
    blocking(server::others_running).await
}

/// What "Install shell command in PATH" does here, and whether it's done.
#[tauri::command]
pub async fn shell_command_plan(state: State<'_, AppState>) -> Result<ShellCommand> {
    let data = state.dirs.data.clone();
    blocking(move || shell_command::plan(&data)).await?
}

#[tauri::command]
pub async fn shell_command_install(state: State<'_, AppState>) -> Result<ShellCommand> {
    let data = state.dirs.data.clone();
    blocking(move || shell_command::install(&data)).await?
}

#[tauri::command]
pub async fn shell_command_uninstall(state: State<'_, AppState>) -> Result<ShellCommand> {
    let data = state.dirs.data.clone();
    blocking(move || shell_command::uninstall(&data)).await?
}

/// Replaces the taskbar's jump list (Windows) or the Dock icon's menu (macOS) with these recent
/// folders and "New window" (Linux: `applied: false`; the desktop file has its New window
/// action). Test runs leave the real list alone.
#[tauri::command]
pub async fn jump_list_set(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    list: JumpList,
) -> Result<JumpListResult> {
    if state.cli.test_script.is_some() {
        return Ok(JumpListResult::default());
    }
    #[cfg(target_os = "macos")]
    let result = {
        let dir = state.cli.user_data_dir.clone();
        blocking(move || crate::instances::dock_menu::apply(&app, &list, dir)).await?
    };
    #[cfg(not(target_os = "macos"))]
    let result = {
        use crate::instances::jump_list;
        let id = jump_list::app_id(&app.config().identifier);
        blocking(move || jump_list::apply(&id, &list)).await?
    };
    result.map_err(Error::Exec)
}
