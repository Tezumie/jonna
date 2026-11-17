//! Sharing a project with a team (src-tauri/src/sync/share, `docs/sync.md`). `base` is the
//! accounts server, as for sync itself, and sync must be on for this device: what an account
//! keeps of sharing (its member key, the teammates' keys it pinned, the keys of what it
//! shares) is in its own vault.
//!
//! Failures carry a code the front end tells apart: `ShareNoTeam`, `ShareNotMember`,
//! `ShareWaiting` (the keys haven't reached this account), `ShareKeyChanged` (the sharer's key
//! isn't the pinned one), `ShareNoMemberKey`, `ShareNotSharer`, `ShareGone`, `ShareNotShared`,
//! `ShareTooMany`, `ShareKeys`, `ShareTargetNotEmpty`, and sync's own (`SyncLapsed`,
//! `SyncFull`, `SyncOff`, `SyncOffline`…).

use tauri::State;

use crate::error::{Error, Result};
use crate::sync::share::{
    Folder, Me, MemberInfo, OpenedCopy, ShareInfo, SharedFiles, SharedSnapshot, Shares, Synced,
};
use crate::sync::snapshot::FileText;
use crate::sync::vault::Vault;
use crate::AppState;

use super::sync::{snapshot_root, SNAPSHOT};

fn shares(state: &AppState, base: &str) -> Result<Shares> {
    Shares::new(base, &state.dirs.data)
}

/// This computer as the account's vault knows it (a snapshot says which computer took it).
fn device(state: &AppState, base: &str) -> Result<(String, String)> {
    Vault::new(base, &state.dirs.data)
        .device()
        .ok_or_else(|| Error::Sync("SyncOff", "Sync isn't on for this device.".into()))
}

/// This account's fingerprint, and whether its member key is published. The key is made and
/// published here when it wasn't yet.
#[tauri::command]
pub async fn share_me(state: State<'_, AppState>, base: String) -> Result<Me> {
    shares(&state, &base)?.me().await
}

/// The team's members, each with their fingerprint and where they stand for this account
/// ("nokey", "new", "verified", "changed").
#[tauri::command]
pub async fn share_members(state: State<'_, AppState>, base: String) -> Result<Vec<MemberInfo>> {
    shares(&state, &base)?.members().await
}

/// Marks a teammate verified or not. `fingerprint`: the one that was compared (it must be the
/// pinned key's when `verified`).
#[tauri::command]
pub async fn share_set_verified(
    state: State<'_, AppState>,
    base: String,
    uid: String,
    fingerprint: String,
    verified: bool,
) -> Result<()> {
    shares(&state, &base)?
        .set_verified(&uid, &fingerprint, verified)
        .await
}

/// Accepts a teammate's changed key (`fingerprint`: the new key's, as the list showed it).
#[tauri::command]
pub async fn share_accept_key(
    state: State<'_, AppState>,
    base: String,
    uid: String,
    fingerprint: String,
) -> Result<()> {
    shares(&state, &base)?.accept_key(&uid, &fingerprint).await
}

/// The team's shares, each with whether this account can read it.
#[tauri::command]
pub async fn share_list(state: State<'_, AppState>, base: String) -> Result<Vec<ShareInfo>> {
    shares(&state, &base)?.list().await
}

/// Starts sharing `project` under `name` (when it is shared already: sets the name and the
/// chats switch), hands its keys to the members who may have them (`only_verified`: only to
/// verified ones), and, with the open folder `root`, takes its first snapshot.
#[tauri::command]
pub async fn share_start(
    state: State<'_, AppState>,
    base: String,
    root: Option<String>,
    project: String,
    name: String,
    chats: bool,
    only_verified: bool,
) -> Result<Synced> {
    let _one = SNAPSHOT.lock().await;
    let root = match root {
        Some(root) => Some(snapshot_root(&state, &root)?),
        None => None,
    };
    let s = shares(&state, &base)?;
    let (device, device_name) = device(&state, &base)?;
    let folder = root.as_deref().map(|root| Folder {
        root,
        device: &device,
        device_name: &device_name,
    });
    s.start_and_sync(&project, &name, chats, only_verified, folder)
        .await
}

/// Changes a share's name and whether its chats are shared.
#[tauri::command]
pub async fn share_update(
    state: State<'_, AppState>,
    base: String,
    project: String,
    name: String,
    chats: bool,
) -> Result<ShareInfo> {
    shares(&state, &base)?.update(&project, &name, chats).await
}

/// Stops a share (the sharer, or the team's owner): the service deletes it and all it holds.
#[tauri::command]
pub async fn share_stop(state: State<'_, AppState>, base: String, id: String) -> Result<()> {
    shares(&state, &base)?.stop(&id).await
}

/// Sees to the keys of this account's share of `project` (members without them get them; they
/// are renewed when someone left), then writes a snapshot of the open folder `root` into it
/// when the folder changed since the last one.
#[tauri::command]
pub async fn share_sync(
    state: State<'_, AppState>,
    base: String,
    root: String,
    project: String,
    only_verified: bool,
) -> Result<Synced> {
    let _one = SNAPSHOT.lock().await;
    let root = snapshot_root(&state, &root)?;
    let s = shares(&state, &base)?;
    let (device, device_name) = device(&state, &base)?;
    s.sync(
        &project,
        only_verified,
        Folder {
            root: &root,
            device: &device,
            device_name: &device_name,
        },
    )
    .await
}

/// A share's snapshots, newest first.
#[tauri::command]
pub async fn share_snapshots(
    state: State<'_, AppState>,
    base: String,
    id: String,
) -> Result<Vec<SharedSnapshot>> {
    shares(&state, &base)?.snapshots(&id).await
}

/// The files a snapshot of a share holds; with the open folder `root`, each with how it
/// stands against that folder. Nothing is written.
#[tauri::command]
pub async fn share_snapshot_files(
    state: State<'_, AppState>,
    base: String,
    id: String,
    snapshot: String,
    root: Option<String>,
) -> Result<SharedFiles> {
    let root = match root {
        Some(root) => Some(snapshot_root(&state, &root)?),
        None => None,
    };
    shares(&state, &base)?.files(&id, &snapshot, root).await
}

/// One file of a share's snapshot as text, written nowhere. Null when the snapshot doesn't
/// hold the file.
#[tauri::command]
pub async fn share_file_text(
    state: State<'_, AppState>,
    base: String,
    id: String,
    snapshot: String,
    path: String,
) -> Result<Option<FileText>> {
    shares(&state, &base)?
        .file_text(&id, &snapshot, &path)
        .await
}

/// A copy of a share's snapshot in the new or empty folder `target` (one the person picked):
/// cloned from the project's remote when there is one, then the snapshot on top. The folder
/// is opened like any other that someone else made: nothing here trusts it.
#[tauri::command]
pub async fn share_open_copy(
    state: State<'_, AppState>,
    base: String,
    id: String,
    snapshot: String,
    target: String,
) -> Result<OpenedCopy> {
    if state.workspace.remote().is_some() {
        return Err(Error::Sync(
            "Sync",
            "A copy is made on this computer, not in a remote window.".into(),
        ));
    }
    let _one = SNAPSHOT.lock().await;
    shares(&state, &base)?
        .open_copy(&id, &snapshot, std::path::Path::new(&target))
        .await
}
