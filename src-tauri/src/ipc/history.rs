//! Local history and the app trash (crate::history): list/read/restore a file's snapshots, and
//! deletes that can be undone.

use crate::error::{Error, Result};
use crate::history::{Entry, Trashed};
use crate::{fs, remote, AppState};
use tauri::ipc::Response;
use tauri::State;

/// A workspace file's snapshots, newest first. (A remote file has none: local history keeps
/// local files, D252.)
#[tauri::command]
pub async fn history_list(state: State<'_, AppState>, path: String) -> Result<Vec<Entry>> {
    if remote::is_remote_path(&path) {
        return Ok(Vec::new());
    }
    Ok(state.history.list(&state.workspace.resolve(&path)?))
}

/// The remote path of an entry to delete or restore (its folder's links resolved by the
/// server, so a link inside the workspace can't move something outside it), when it's remote.
async fn remote_entry(state: &AppState, path: &str) -> Result<Option<String>> {
    if !remote::is_remote_path(path) {
        return Ok(None);
    }
    let entry = remote::posix(&state.workspace.resolve_entry(path)?);
    let (parent, name) = entry
        .rsplit_once('/')
        .ok_or_else(|| Error::OutsideScope(path.to_string()))?;
    let parent = if parent.is_empty() { "/" } else { parent };
    let canonical = remote::call("fs.canonical", serde_json::json!({ "path": parent })).await?;
    let canonical = canonical
        .as_str()
        .ok_or_else(|| Error::OutsideScope(path.to_string()))?;
    Ok(Some(remote::join(canonical, name)))
}

/// One snapshot's bytes.
#[tauri::command]
pub async fn history_read(
    state: State<'_, AppState>,
    path: String,
    id: String,
) -> Result<Response> {
    if remote::is_remote_path(&path) {
        return Err(crate::ipc::fs::not_in_remote_window("Local history"));
    }
    let bytes = state.history.read(&state.workspace.resolve(&path)?, &id)?;
    Ok(Response::new(bytes))
}

/// Writes a snapshot back to its file (recorded as "restore"). With `expect_hash`, refuses when the
/// file no longer has that content (someone changed it since: undo must not clobber it).
#[tauri::command]
pub async fn history_restore(
    state: State<'_, AppState>,
    path: String,
    id: String,
    expect_hash: Option<String>,
) -> Result<()> {
    if remote::is_remote_path(&path) {
        return Err(crate::ipc::fs::not_in_remote_window("Local history"));
    }
    let resolved = state.workspace.resolve(&path)?;
    if let Some(expected) = expect_hash {
        let current = std::fs::read(&resolved).unwrap_or_default();
        if crate::history::hash(&current) != expected {
            return Err(Error::Invalid(format!(
                "{} changed since; not undoing over it",
                resolved.display()
            )));
        }
    }
    let bytes = state.history.read(&resolved, &id)?;
    let _ = state.history.before_write(&resolved);
    fs::write(&resolved, &bytes)?;
    let _ = state.history.record(&resolved, &bytes, "restore");
    Ok(())
}

/// Deletes a file or folder by moving it into the app trash. Returns the trash id to undo with.
/// Never deletes permanently: when the move fails (a file inside in use), nothing changes and
/// the error says so (D141).
#[tauri::command]
pub async fn fs_trash(state: State<'_, AppState>, path: String) -> Result<Option<String>> {
    // A remote item goes to the trash there (D252: `~/<serverDir>/trash`), undoable from this
    // window.
    if let Some(target) = remote_entry(&state, &path).await? {
        let canonical_roots: Vec<String> = state
            .workspace
            .all_folders()
            .iter()
            .map(|f| remote::posix(f))
            .collect();
        if canonical_roots.contains(&target) {
            return Err(Error::Invalid(
                "refusing to delete a workspace folder".into(),
            ));
        }
        let id = tauri::async_runtime::spawn_blocking(move || remote::trash(&target))
            .await
            .map_err(|e| Error::Exec(e.to_string()))??;
        return Ok(Some(id));
    }
    let resolved = state.workspace.resolve_entry(&path)?;
    // No workspace folder itself (the root or another one), nor a helper's worktree.
    if state.workspace.is_scope_root(&resolved) {
        return Err(Error::Invalid(
            "refusing to delete a workspace folder".into(),
        ));
    }
    // The IDE's own watchers inside it would keep it "in use" on Windows: let go first, and
    // watch again if it couldn't be deleted after all.
    let released = crate::ipc::fs::release_watches(&state, &resolved);
    let mut result = state.history.trash(&resolved);
    if result.is_err() && released.iter().any(|r| !r.is_empty()) {
        // Windows closes a released watch's handle a moment later.
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        result = state.history.trash(&resolved);
    }
    if result.is_err() {
        crate::ipc::fs::rewatch(&state, released);
    }
    result
}

/// Whether a trashed item can still be restored (undo checks before it changes anything).
#[tauri::command]
pub async fn fs_trash_exists(state: State<'_, AppState>, id: String) -> Result<bool> {
    Ok(remote::is_trashed(&id) || state.history.has_trashed(&id))
}

/// Restores a trashed item to `path` (its old location; must not exist).
#[tauri::command]
pub async fn fs_untrash(state: State<'_, AppState>, id: String, path: String) -> Result<()> {
    if let Some(dest) = remote_entry(&state, &path).await? {
        return tauri::async_runtime::spawn_blocking(move || remote::untrash(&id, &dest))
            .await
            .map_err(|e| Error::Exec(e.to_string()))?;
    }
    state
        .history
        .untrash(&id, &state.workspace.resolve_entry(&path)?)
}

/// What the app trash holds (deleted items that can still be restored), newest first.
#[tauri::command]
pub async fn fs_trash_list(state: State<'_, AppState>) -> Result<Vec<Trashed>> {
    Ok(state.history.trash_list())
}

/// The content hash local history uses (`history_restore`'s `expect_hash`), or "" when the file
/// isn't there: a multi-file undo checks every file before changing any (D141).
#[tauri::command]
pub async fn fs_hash(state: State<'_, AppState>, path: String) -> Result<String> {
    if remote::is_remote_path(&path) {
        let target = remote::posix(&state.workspace.resolve(&path)?);
        return Ok(remote::fs::read(&target)
            .await
            .map(|b| crate::history::hash(&b))
            .unwrap_or_default());
    }
    let resolved = state.workspace.resolve(&path)?;
    Ok(std::fs::read(&resolved)
        .map(|b| crate::history::hash(&b))
        .unwrap_or_default())
}
