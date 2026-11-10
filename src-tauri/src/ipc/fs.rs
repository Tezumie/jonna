//! Workspace and file commands: open/close, read/write/list, watching, the quick-open index, and
//! search/replace.

use crate::error::{Error, Result};
use crate::fs::{DirEntry, Stat};
use crate::index::QueryResult;
use crate::search::{ReplaceResult, SearchEvent, SearchOptions};
use crate::watch::WatchBatch;
use crate::{fs, remote, AppState};
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::State;

/// `path` as the remote's server takes it, when it's on the window's remote (D252): checked
/// against the workspace's folders by name first (the server checks again, links resolved).
fn remote_path(state: &AppState, path: &str) -> Result<Option<String>> {
    if !remote::is_remote_path(path) {
        return Ok(None);
    }
    Ok(Some(remote::posix(&state.workspace.resolve(path)?)))
}

/// The same for an entry that's deleted, renamed or moved (never a workspace folder itself).
fn remote_entry(state: &AppState, path: &str) -> Result<Option<String>> {
    if !remote::is_remote_path(path) {
        return Ok(None);
    }
    Ok(Some(remote::posix(&state.workspace.resolve_entry(path)?)))
}

/// What a remote window can't do yet (the error the frontend shows).
pub(crate) fn not_in_remote_window(what: &str) -> Error {
    Error::Invalid(format!("{what} isn't available in a remote window yet."))
}

/// Opens `path` as the workspace folder and returns its canonical path. All other fs commands are
/// confined to this folder. In a remote window (D252) `path` is the remote's.
#[tauri::command]
pub async fn workspace_open(state: State<'_, AppState>, path: String) -> Result<String> {
    if remote::is_remote_path(&path) {
        let r = remote::active()
            .ok_or_else(|| Error::Exec("This window isn't connected to a remote.".into()))?;
        let canonical = remote::fs::open(&path).await?;
        state
            .workspace
            .open_remote(&canonical, &r.authority.as_string())?;
        // The file list is the server's.
        state.index.close();
        let location = state
            .workspace
            .location()
            .ok()
            .map(|p| p.to_string_lossy().into_owned());
        crate::instances::server::set_folder(location);
        return Ok(canonical);
    }
    let root = state.workspace.open(&path)?;
    state.index.open(root.clone());
    let root = root.to_string_lossy().into_owned();
    // Other launches find this window by its folder (D209).
    crate::instances::server::set_folder(Some(root.clone()));
    Ok(root)
}

/// Sets the workspace's other folders (a multi-root workspace: the first folder is the one
/// `workspace_open` opened, these come after it). They're in scope like it, indexed for quick
/// open and searched. One status per path given: a missing folder is reported and left out.
#[tauri::command]
pub async fn workspace_folders_set(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<Vec<fs::FolderStatus>> {
    if state.workspace.remote().is_some() {
        // The server checks each folder and indexes them.
        let statuses = remote::fs::set_folders(&paths).await?;
        let kept: Vec<String> = statuses
            .iter()
            .filter_map(|s| s.canonical.clone())
            .collect();
        state.workspace.set_remote_folders(&kept)?;
        return Ok(statuses);
    }
    let statuses = state.workspace.set_folders(&paths)?;
    state.index.set_folders(state.workspace.folders());
    Ok(statuses)
}

/// The workspace's folders, the first (the root) first.
#[tauri::command]
pub async fn workspace_folders(state: State<'_, AppState>) -> Result<Vec<String>> {
    Ok(state
        .workspace
        .all_folders()
        .iter()
        .map(|f| f.to_string_lossy().into_owned())
        .collect())
}

/// The `.code-workspace` file this window has open (null: none, the folder alone). While one is
/// set, the window's state is kept for it and other launches find this window by it. Returns
/// the path kept (canonical).
#[tauri::command]
pub async fn workspace_set_file(
    state: State<'_, AppState>,
    file: Option<String>,
) -> Result<Option<String>> {
    let kept = state.workspace.set_file(file.as_deref())?;
    // Other launches find this window by its workspace file, else its folder (D209).
    let location = state
        .workspace
        .location()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    crate::instances::server::set_folder(location);
    Ok(kept.map(|p| p.to_string_lossy().into_owned()))
}

/// A `.code-workspace` file is at most this big.
const MAX_WORKSPACE_FILE: u64 = 4 * 1024 * 1024;

/// Reads a `.code-workspace` file (absolute, local, named `*.code-workspace`).
#[tauri::command]
pub async fn workspace_file_read(path: String) -> Result<String> {
    let file = fs::checked_workspace_file(&path)?;
    if std::fs::metadata(&file)?.len() > MAX_WORKSPACE_FILE {
        return Err(Error::Invalid(format!(
            "{} is too large to be a workspace file",
            file.display()
        )));
    }
    Ok(std::fs::read_to_string(&file)?)
}

/// Writes a `.code-workspace` file atomically (absolute, local, named `*.code-workspace`). Its
/// folder must exist, unless it's in the app's data folder (an untitled workspace's).
#[tauri::command]
pub async fn workspace_file_write(
    state: State<'_, AppState>,
    path: String,
    text: String,
) -> Result<()> {
    let file = fs::checked_workspace_file(&path)?;
    if text.len() as u64 > MAX_WORKSPACE_FILE {
        return Err(Error::Invalid("the workspace file is too large".into()));
    }
    let parent = file
        .parent()
        .ok_or_else(|| Error::Invalid(format!("no folder for {path}")))?;
    if !parent.is_dir() {
        let data = crate::store::simplify(state.dirs.data.clone());
        let canonical_data = std::fs::canonicalize(&state.dirs.data)
            .map(crate::store::simplify)
            .unwrap_or_else(|_| data.clone());
        if !parent.starts_with(&data) && !parent.starts_with(&canonical_data) {
            return Err(Error::Invalid(format!(
                "{} doesn't exist",
                parent.display()
            )));
        }
        std::fs::create_dir_all(parent)?;
    }
    crate::store::atomic_write(&file, text.as_bytes())
}

/// A new, unused path for an untitled workspace's file:
/// `<data>/workspaces/untitled/<unix-ms>.code-workspace` (its folder made; the file isn't).
#[tauri::command]
pub async fn workspace_untitled_path(state: State<'_, AppState>) -> Result<String> {
    let dir = state.dirs.data.join("workspaces").join("untitled");
    std::fs::create_dir_all(&dir)?;
    Ok(untitled_workspace_path(&dir, crate::instances::now_ms())
        .to_string_lossy()
        .into_owned())
}

/// The first `<ms>.code-workspace` in `dir` that isn't there yet, from `ms` on.
fn untitled_workspace_path(dir: &std::path::Path, ms: u64) -> std::path::PathBuf {
    let mut n = ms;
    loop {
        let candidate = dir.join(format!("{n}.code-workspace"));
        if std::fs::symlink_metadata(&candidate).is_err() {
            return candidate;
        }
        n += 1;
    }
}

/// Makes a new project folder `name` inside `parent` (a folder the user chose or accepted, for a
/// workspace to open next — D121), and returns its path. `name` is one path part; an existing
/// empty folder is fine (it's reused), a non-empty one is refused.
#[tauri::command]
pub async fn workspace_create_folder(parent: String, name: String) -> Result<String> {
    let name = name.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
    {
        return Err(Error::Invalid(format!("\"{name}\" isn't a folder name.")));
    }
    // Absolute and local: a network parent makes Windows connect and offer the user's
    // credentials (D161), and a relative one would land beside the app's working folder.
    if fs::is_unc(&parent) || !std::path::Path::new(&parent).is_absolute() {
        return Err(Error::Invalid(format!("{parent} isn't a local folder.")));
    }
    let parent = std::path::PathBuf::from(parent);
    std::fs::create_dir_all(&parent)?;
    let dir = parent.join(name);
    if dir.is_dir() {
        if std::fs::read_dir(&dir)?.next().is_some() {
            return Err(Error::Invalid(format!(
                "{} already exists and isn't empty.",
                dir.display()
            )));
        }
    } else {
        std::fs::create_dir(&dir)?;
    }
    // As opening it will name it (D273: the folder is trusted by this path before it opens).
    let dir = std::fs::canonicalize(&dir)
        .map(crate::store::simplify)
        .unwrap_or(dir);
    Ok(dir.to_string_lossy().into_owned())
}

/// Closes the workspace: file commands are out of scope until a folder opens again.
#[tauri::command]
pub async fn workspace_close(state: State<'_, AppState>) -> Result<()> {
    state
        .lsp
        .blocking(|host| {
            host.stop_folder_servers();
            Ok(())
        })
        .await?;
    state.browser.stop_all();
    crate::instances::server::set_folder(None);
    if state.workspace.remote().is_some() {
        // A lost connection has nothing open there any more.
        let _ = remote::fs::close().await;
    }
    state.workspace.close()
}

/// Reads a file as raw bytes (an `ArrayBuffer` in JS, no JSON encoding).
#[tauri::command]
pub async fn fs_read(state: State<'_, AppState>, path: String) -> Result<Response> {
    if let Some(p) = remote_path(&state, &path)? {
        return Ok(Response::new(remote::fs::read(&p).await?));
    }
    let resolved = crate::ipc::settings::resolve_path(&state, &path)?;
    Ok(Response::new(std::fs::read(resolved)?))
}

/// Writes raw bytes atomically. Body = file bytes; header `x-path` = percent-encoded path.
#[tauri::command]
pub async fn fs_write(state: State<'_, AppState>, request: Request<'_>) -> Result<()> {
    let header = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| Error::Invalid("missing x-path header".into()))?;
    let path = percent_decode(header)?;
    let source = request
        .headers()
        .get("x-source")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("save")
        .to_string();
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(Error::Invalid("expected a raw byte body".into()));
    };
    // A remote file (D252): written there; local history keeps local files only.
    if let Some(p) = remote_path(&state, &path)? {
        return remote::fs::write(&p, bytes).await;
    }
    let resolved = crate::ipc::settings::resolve_write_path(&state, &path)?;
    // Local history for workspace files, in any of its folders (not user settings): what was
    // there, then what was written.
    let tracked = state.workspace.folder_of(&resolved).is_some();
    if tracked {
        let _ = state.history.before_write(&resolved);
    }
    fs::write(&resolved, bytes)?;
    if tracked {
        let _ = state.history.record(&resolved, bytes, &source);
    }
    Ok(())
}

/// Text → bytes in a legacy encoding (D204). Body = the text as UTF-8; header `x-encoding` = a
/// WHATWG label. Refused, naming the characters, when the encoding can't hold some of them.
#[tauri::command]
pub async fn encoding_encode(request: Request<'_>) -> Result<Response> {
    let label = request
        .headers()
        .get("x-encoding")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| Error::Invalid("missing x-encoding header".into()))?;
    let encoding = fs::encoding::for_label(label)
        .ok_or_else(|| Error::Invalid(format!("Unknown encoding {label}.")))?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(Error::Invalid("expected a raw text body".into()));
    };
    let text = std::str::from_utf8(bytes)
        .map_err(|_| Error::Invalid("the text to encode isn't UTF-8".into()))?;
    fs::encoding::encode(text, encoding)
        .map(Response::new)
        .map_err(|bad| {
            let chars: Vec<String> = bad.0.iter().map(|c| format!("\"{c}\"")).collect();
            Error::Invalid(format!("can't hold {}", chars.join(", ")))
        })
}

/// The likely encoding of some bytes (D204, files.autoGuessEncoding): a lower-case WHATWG name,
/// or null for plain ASCII. Body = the bytes.
#[tauri::command]
pub async fn encoding_guess(request: Request<'_>) -> Result<Option<String>> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(Error::Invalid("expected a raw byte body".into()));
    };
    Ok(fs::encoding::guess(bytes))
}

#[tauri::command]
pub async fn fs_stat(state: State<'_, AppState>, path: String) -> Result<Stat> {
    if let Some(p) = remote_path(&state, &path)? {
        return remote::fs::stat(&p).await;
    }
    fs::stat(&crate::ipc::settings::resolve_path(&state, &path)?)
}

#[tauri::command]
pub async fn fs_list_dir(state: State<'_, AppState>, path: String) -> Result<Vec<DirEntry>> {
    if let Some(p) = remote_path(&state, &path)? {
        return remote::fs::list_dir(&p).await;
    }
    fs::list_dir(&crate::ipc::settings::resolve_path(&state, &path)?)
}

#[tauri::command]
pub async fn fs_create_file(
    state: State<'_, AppState>,
    parent: String,
    name: String,
) -> Result<String> {
    if let Some(p) = remote_path(&state, &parent)? {
        fs::validate_name(&name)?;
        return remote::fs::create_file(&p, &name).await;
    }
    let created = fs::create_file(&state.workspace.resolve(&parent)?, &name)?;
    Ok(created.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn fs_create_dir(
    state: State<'_, AppState>,
    parent: String,
    name: String,
) -> Result<String> {
    if let Some(p) = remote_path(&state, &parent)? {
        fs::validate_name(&name)?;
        return remote::fs::create_dir(&p, &name).await;
    }
    let created = fs::create_dir(&state.workspace.resolve(&parent)?, &name)?;
    Ok(created.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn fs_rename(
    state: State<'_, AppState>,
    path: String,
    new_name: String,
) -> Result<String> {
    if let Some(p) = remote_entry(&state, &path)? {
        fs::validate_name(&new_name)?;
        return remote::fs::rename(&p, &new_name).await;
    }
    let from = state.workspace.resolve_entry(&path)?;
    let released = release_watches(&state, &from);
    let result = fs::rename(&from, &new_name);
    if result.is_err() {
        rewatch(&state, released);
    }
    Ok(result?.to_string_lossy().into_owned())
}

/// The IDE's own folder watchers inside `path` (open handles on Windows, which keep a folder
/// "in use") let go before it's renamed or moved (D190).
pub(crate) fn release_watches(
    state: &AppState,
    path: &std::path::Path,
) -> [Vec<std::path::PathBuf>; 4] {
    [
        state.watcher.release_under(path),
        state.settings_watcher.release_under(path),
        state.docs_watcher.release_under(path),
        state.skills_watcher.release_under(path),
    ]
}

/// Watches again what `release_watches` let go (the operation didn't happen).
pub(crate) fn rewatch(state: &AppState, released: [Vec<std::path::PathBuf>; 4]) {
    let [a, b, c, d] = released;
    state.watcher.rewatch(a);
    state.settings_watcher.rewatch(b);
    state.docs_watcher.rewatch(c);
    state.skills_watcher.rewatch(d);
}

/// Moves a file or folder into another folder of the workspace. Returns the new path.
#[tauri::command]
pub async fn fs_move(state: State<'_, AppState>, path: String, dest_dir: String) -> Result<String> {
    if let Some(p) = remote_entry(&state, &path)? {
        let dest = remote_path(&state, &dest_dir)?
            .ok_or_else(|| Error::OutsideScope(format!("{dest_dir} isn't on the remote")))?;
        return remote::fs::move_into(&p, &dest).await;
    }
    let ws = &state.workspace;
    let from = ws.resolve_entry(&path)?;
    // Resolved before the watches are released: an early error mustn't leave them released.
    let dest = ws.resolve(&dest_dir)?;
    // The folder holding it (`resolve_entry` already refused any workspace folder itself).
    let root = ws.root_of(&from)?;
    let released = release_watches(&state, &from);
    let result = fs::move_into(&from, &dest, &root);
    if result.is_err() {
        rewatch(&state, released);
    }
    Ok(result?.to_string_lossy().into_owned())
}

/// Copies a file or folder (recursively) into a folder of the workspace. Returns the new path.
#[tauri::command]
pub async fn fs_copy(state: State<'_, AppState>, path: String, dest_dir: String) -> Result<String> {
    if let Some(p) = remote_path(&state, &path)? {
        let dest = remote_path(&state, &dest_dir)?
            .ok_or_else(|| Error::OutsideScope(format!("{dest_dir} isn't on the remote")))?;
        return remote::fs::copy_into(&p, &dest).await;
    }
    let ws = &state.workspace;
    let copied = fs::copy_into(&ws.resolve(&path)?, &ws.resolve(&dest_dir)?)?;
    Ok(copied.to_string_lossy().into_owned())
}

/// Copies the files and folders last dropped onto the window from the OS into `dest_dir` (a
/// workspace folder). Only paths the OS reported in a drop can be imported, so the webview can't
/// use this to read arbitrary files.
#[tauri::command]
pub async fn fs_import_dropped(
    state: State<'_, AppState>,
    dest_dir: String,
) -> Result<Vec<String>> {
    if remote::is_remote_path(&dest_dir) {
        return Err(not_in_remote_window("Dropping files from this computer"));
    }
    let dest = state.workspace.resolve(&dest_dir)?;
    let sources = std::mem::take(
        &mut *state
            .dropped
            .lock()
            .map_err(|_| crate::error::Error::Invalid("lock poisoned".into()))?,
    );
    let mut out = Vec::new();
    for source in sources {
        out.push(
            fs::copy_into(&source, &dest)?
                .to_string_lossy()
                .into_owned(),
        );
    }
    Ok(out)
}

/// The paths last dropped onto the window from the OS, each with whether it's a folder (D281:
/// dropped files open in an editor, a dropped folder opens or joins the workspace). Only paths the
/// OS reported in a drop are described, so the webview can't probe the disk with this.
#[tauri::command]
pub async fn fs_dropped_entries(state: State<'_, AppState>) -> Result<Vec<DroppedEntry>> {
    let dropped = state
        .dropped
        .lock()
        .map_err(|_| crate::error::Error::Invalid("lock poisoned".into()))?
        .clone();
    Ok(dropped
        .into_iter()
        .map(|p| DroppedEntry {
            dir: p.is_dir(),
            path: p.to_string_lossy().into_owned(),
        })
        .collect())
}

#[derive(serde::Serialize)]
pub struct DroppedEntry {
    path: String,
    dir: bool,
}

/// Permanently deletes a file or folder (recursively). The frontend command is `destructive`.
#[tauri::command]
pub async fn fs_delete(state: State<'_, AppState>, path: String) -> Result<()> {
    if let Some(p) = remote_entry(&state, &path)? {
        return remote::fs::delete(&p).await;
    }
    let resolved = state.workspace.resolve_entry(&path)?;
    // The root holding it: the open folder, or a helper's worktree (never the root itself).
    let root = state.workspace.root_of(&resolved)?;
    // The IDE's watchers inside it keep an expanded folder "in use" on Windows (D190), as for
    // the trash, a rename or a move: let go first, watch again if it wasn't deleted.
    let released = release_watches(&state, &resolved);
    let result = fs::delete(&resolved, &root);
    if result.is_err() {
        rewatch(&state, released);
    }
    result
}

/// Decodes `%XX` escapes (the JS side uses `encodeURIComponent`, since headers must be ASCII).
pub(crate) fn percent_decode(s: &str) -> Result<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s
                .get(i + 1..i + 3)
                .ok_or_else(|| Error::Invalid("bad escape".into()))?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| Error::Invalid("bad escape".into()))?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| Error::Invalid("path is not UTF-8".into()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(
            super::percent_decode("%2Fa%20b%C3%A9").ok().as_deref(),
            Some("/a bé")
        );
        assert!(super::percent_decode("%2").is_err());
    }

    #[test]
    fn an_untitled_workspace_gets_a_path_not_taken() {
        let dir = std::env::temp_dir().join(format!("ide-untitled-ws-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        let first = super::untitled_workspace_path(&dir, 1000);
        assert_eq!(first, dir.join("1000.code-workspace"));
        let _ = std::fs::write(&first, "{}");
        let _ = std::fs::write(dir.join("1001.code-workspace"), "{}");
        assert_eq!(
            super::untitled_workspace_path(&dir, 1000),
            dir.join("1002.code-workspace")
        );
        assert!(crate::fs::is_workspace_file_name(&first));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Starts watching; debounced change batches arrive on `on_batch`.
#[tauri::command]
pub async fn watch_start(state: State<'_, AppState>, on_batch: Channel<WatchBatch>) -> Result<()> {
    state.watcher.start(on_batch)
}

/// Sets which workspace directories are watched (non-recursively): the explorer's expanded folders.
#[tauri::command]
pub async fn watch_set_dirs(state: State<'_, AppState>, dirs: Vec<String>) -> Result<()> {
    let (remote_dirs, local): (Vec<String>, Vec<String>) =
        dirs.into_iter().partition(|d| remote::is_remote_path(d));
    if remote::is_remote_window() {
        let remote_dirs = remote_dirs
            .iter()
            .map(|d| state.workspace.resolve(d).map(|p| remote::posix(&p)))
            .collect::<Result<Vec<_>>>()?;
        remote::fs::watch("explorer", &remote_dirs, false).await?;
    }
    let resolved = local
        .iter()
        .map(|d| state.workspace.resolve(d))
        .collect::<Result<Vec<_>>>()?;
    state.watcher.set_dirs(resolved)
}

/// Sets which remote folders the server's watcher set `watcher` watches (D252), when the
/// window is remote: the ones in `dirs` on the remote, those outside its workspace left out.
pub(crate) async fn remote_watch(
    state: &AppState,
    watcher: &str,
    dirs: &[String],
    recursive: bool,
) -> Result<()> {
    if !remote::is_remote_window() || state.workspace.remote().is_none() {
        return Ok(());
    }
    let wanted: Vec<String> = dirs
        .iter()
        .filter(|d| remote::is_remote_path(d))
        .filter_map(|d| state.workspace.resolve(d).ok())
        .map(|p| remote::posix(&p))
        .collect();
    remote::fs::watch(watcher, &wanted, recursive).await
}

#[tauri::command]
pub async fn watch_stop(state: State<'_, AppState>) -> Result<()> {
    state.watcher.stop()
}

/// Starts the open-documents watcher (reload from disk): batches go to `on_batch`.
#[tauri::command]
pub async fn docs_watch_start(
    state: State<'_, AppState>,
    on_batch: Channel<WatchBatch>,
) -> Result<()> {
    state.docs_watcher.start(on_batch)
}

/// Sets the folders of open documents to watch (non-recursively); workspace or settings paths.
#[tauri::command]
pub async fn docs_watch_set_dirs(state: State<'_, AppState>, dirs: Vec<String>) -> Result<()> {
    // Open documents on the remote: the server watches their folders (a lost connection
    // doesn't fail the local ones).
    let _ = remote_watch(&state, "docs", &dirs, false).await;
    let resolved = dirs
        .iter()
        .filter(|d| !remote::is_remote_path(d))
        .filter_map(|d| {
            state.workspace.resolve(d).ok().or_else(|| {
                // The folder of a file the user opened from outside the open folder (D190);
                // never a network path (D161) or a relative one.
                if crate::fs::is_unc(d) || !std::path::Path::new(d).is_absolute() {
                    return None;
                }
                let dir = crate::store::simplify(std::fs::canonicalize(d).ok()?);
                state.workspace.holds_extra(&dir).then_some(dir)
            })
        })
        .collect::<Vec<_>>();
    state.docs_watcher.set_dirs(resolved)
}

/// A file from outside the open folder the user chose to open (D190): it can be read, saved
/// and watched from now on (only that file). Returns its canonical path.
#[tauri::command]
pub async fn workspace_allow_file(state: State<'_, AppState>, path: String) -> Result<String> {
    Ok(state
        .workspace
        .allow_file(&path)?
        .to_string_lossy()
        .into_owned())
}

/// A headless helper's git worktree (a linked worktree of the open folder's repository) in scope
/// while the helper works there: its files can be read, written, listed, searched and run in.
/// Returns its canonical path.
#[tauri::command]
pub async fn workspace_allow_root(state: State<'_, AppState>, path: String) -> Result<String> {
    Ok(state
        .workspace
        .allow_root(&path)?
        .to_string_lossy()
        .into_owned())
}

/// Takes a helper's worktree out of scope again (the helper ended).
#[tauri::command]
pub async fn workspace_forget_root(state: State<'_, AppState>, path: String) -> Result<()> {
    state.workspace.forget_root(&path)
}

/// Quick open: the best `limit` workspace files for `query` (fuzzy; see index/fuzzy.rs).
#[tauri::command]
pub async fn index_query(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
    root: Option<String>,
) -> Result<QueryResult> {
    // An empty query lists files (the agent's repo map reads them all, D174): paths only, cheap.
    let cap = if query.trim().is_empty() {
        50_000
    } else {
        1000
    };
    let limit = limit.unwrap_or(100).min(cap);
    // A remote workspace's file list is the server's (the same ranking, D252).
    if state.workspace.remote().is_some() {
        let root = root.map(|r| state.workspace.scope_root(&r)).transpose()?;
        let v = remote::call(
            "index.query",
            serde_json::json!({
                "query": query,
                "limit": limit,
                "root": root.map(|r| remote::posix(&r)),
            }),
        )
        .await?;
        return Ok(serde_json::from_value(v)?);
    }
    if let Some(dir) = root {
        let dir = state.workspace.scope_root(&dir)?;
        // One of the workspace's folders: that folder's list alone.
        if let Some(result) = state.index.query_folder(&dir, &query, limit)? {
            return Ok(result);
        }
        // Another root in scope (a headless helper's worktree, or a folder not indexed yet):
        // walked for this query, not indexed.
        return tauri::async_runtime::spawn_blocking(move || {
            crate::index::query_walk(&dir, &query, limit)
        })
        .await
        .map_err(|e| Error::Invalid(e.to_string()));
    }
    // Every folder of the workspace, merged (an item from another folder than the first names
    // it in `root`).
    state.index.query(&query, limit)
}

/// Sends the files that change on disk to `on_change` (the file index's watcher, D220: Source
/// control runs `git status` from it). Returns whether the folder is being watched.
#[tauri::command]
pub async fn index_watch(
    state: State<'_, AppState>,
    on_change: Channel<crate::index::IndexChanges>,
) -> Result<bool> {
    let local = state.index.listen(on_change);
    // A remote workspace: the server's watcher, its changes to the same listener (D252).
    if state.workspace.remote().is_some() {
        let v = remote::call("index.listen", serde_json::json!({})).await?;
        return Ok(v.as_bool().unwrap_or(false));
    }
    Ok(local)
}

/// Searches the workspace; one event per matching file, then `done`, on `on_event`.
/// Starting a new search cancels the previous one, unless `detached` (an extension's search).
#[tauri::command]
pub async fn search_start(
    state: State<'_, AppState>,
    options: SearchOptions,
    on_event: Channel<SearchEvent>,
    detached: Option<bool>,
    root: Option<String>,
    roots: Option<Vec<String>>,
) -> Result<()> {
    // `root` / `roots`: workspace folders or other roots in scope (a headless helper's
    // worktree), searched in that order; neither: every workspace folder, the first first.
    let asked: Vec<String> = root
        .into_iter()
        .chain(roots.into_iter().flatten())
        .collect();
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    if asked.is_empty() {
        state.workspace.root()?;
        dirs = state.workspace.all_folders();
    } else {
        for dir in &asked {
            let dir = state.workspace.scope_root(dir)?;
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
    }
    let detached = detached.unwrap_or(false);
    // A remote workspace (D252): the server searches; its events come back by the search's id.
    if state.workspace.remote().is_some() {
        let r = remote::active()
            .ok_or_else(|| Error::Exec("This window isn't connected to a remote.".into()))?;
        let id = r.search_id(detached);
        r.add_search(&id, on_event);
        let roots: Vec<String> = dirs.iter().map(|d| remote::posix(d)).collect();
        return remote::call(
            "search.start",
            serde_json::json!({ "search": id, "roots": roots, "options": options }),
        )
        .await
        .map(|_| ());
    }
    state.search.start(dirs, options, detached, move |event| {
        // The view may have closed; nothing to do if the channel is gone.
        let _ = on_event.send(event);
    })
}

#[tauri::command]
pub async fn search_cancel(state: State<'_, AppState>) -> Result<()> {
    state.search.cancel();
    if state.workspace.remote().is_some() {
        let _ = remote::call("search.cancel", serde_json::json!({ "search": "view" })).await;
    }
    Ok(())
}

/// Replaces all matches of `options` with `replacement` in `paths` (workspace files).
#[tauri::command]
pub async fn search_replace(
    state: State<'_, AppState>,
    options: SearchOptions,
    replacement: String,
    paths: Vec<String>,
) -> Result<ReplaceResult> {
    if state.workspace.remote().is_some() {
        return remote_replace(&state, &options, &replacement, &paths).await;
    }
    let resolved = paths
        .iter()
        .map(|p| state.workspace.resolve(p))
        .collect::<Result<Vec<_>>>()?;
    crate::search::replace(&options, &replacement, &resolved, Some(&state.history))
}

/// Replace in a remote workspace (D252): each file read from the server, replaced here, written
/// back. Local history keeps local files only, so there's no snapshot to undo with (`before` and
/// `after` are null; the hashes still guard an undo the frontend makes from its own text).
async fn remote_replace(
    state: &AppState,
    options: &SearchOptions,
    replacement: &str,
    paths: &[String],
) -> Result<ReplaceResult> {
    let re = crate::search::replace_regex(options)?;
    let mut result = ReplaceResult {
        files: 0,
        replacements: 0,
        skipped: Vec::new(),
        changes: Vec::new(),
    };
    for path in paths {
        let target = remote_path(state, path)?.ok_or_else(|| Error::OutsideScope(path.clone()))?;
        let text = match remote::fs::read(&target).await.map(String::from_utf8) {
            Ok(Ok(text)) => text,
            _ => {
                result.skipped.push(path.clone());
                continue;
            }
        };
        let (next, count) = crate::search::replace_in_text(&re, options, replacement, &text);
        if count == 0 {
            continue;
        }
        if remote::fs::write(&target, next.as_bytes()).await.is_err() {
            result.skipped.push(path.clone());
            continue;
        }
        result.changes.push(crate::search::ReplacedFile {
            path: path.clone(),
            before: None,
            after: None,
            before_hash: crate::history::hash(text.as_bytes()),
            after_hash: crate::history::hash(next.as_bytes()),
        });
        result.files += 1;
        result.replacements += count;
    }
    Ok(result)
}

/// Starts a native drag of `paths` (files or folders in the workspace) out of the window, for
/// other apps to take (D200). Called when an explorer drag leaves the window, with the mouse
/// button still down. Returns "dropped" or "cancelled".
#[tauri::command]
pub async fn fs_start_drag(
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
    paths: Vec<String>,
) -> Result<String> {
    if paths.is_empty() {
        return Err(Error::Invalid("nothing to drag".into()));
    }
    if paths.iter().any(|p| remote::is_remote_path(p)) {
        return Err(not_in_remote_window(
            "Dragging remote files out of the window",
        ));
    }
    let mut files = Vec::with_capacity(paths.len());
    for path in &paths {
        let resolved = state.workspace.resolve(path)?;
        if !resolved.exists() {
            return Err(Error::Invalid(format!(
                "{} doesn't exist",
                resolved.display()
            )));
        }
        files.push(resolved);
    }
    let (tx, rx) = tokio::sync::oneshot::channel::<std::result::Result<String, String>>();
    let target = window.clone();
    window.run_on_main_thread(move || {
        let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
        let done = tx.clone();
        let send = move |value: std::result::Result<String, String>| {
            if let Ok(mut slot) = done.lock() {
                if let Some(tx) = slot.take() {
                    let _ = tx.send(value);
                }
            }
        };
        let on_drop = {
            let send = send.clone();
            move |result: drag::DragResult, _at: drag::CursorPosition| {
                send(Ok(match result {
                    drag::DragResult::Dropped => "dropped".to_string(),
                    drag::DragResult::Cancel => "cancelled".to_string(),
                }));
            }
        };
        let image = drag::Image::Raw(include_bytes!("../../icons/32x32.png").to_vec());
        #[cfg(target_os = "linux")]
        let started = match target.gtk_window() {
            Ok(gtk_window) => drag::start_drag(
                &gtk_window,
                drag::DragItem::Files(files),
                image,
                on_drop,
                drag::Options::default(),
            )
            .map_err(|e| e.to_string()),
            Err(e) => Err(e.to_string()),
        };
        #[cfg(not(target_os = "linux"))]
        let started = drag::start_drag(
            &target,
            drag::DragItem::Files(files),
            image,
            on_drop,
            drag::Options::default(),
        )
        .map_err(|e| e.to_string());
        if let Err(message) = started {
            send(Err(message));
        }
    })?;
    match rx.await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(message)) => Err(Error::Invalid(format!(
            "couldn't start the drag: {message}"
        ))),
        Err(_) => Ok("cancelled".to_string()),
    }
}
