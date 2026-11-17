//! Sharing a project with a team (src-tauri/src/sync/share, `docs/sync.md`). `base` is the
//! accounts server, as for sync itself, and sync must be on for this device: what an account
//! keeps of sharing (its member key, the teammates' keys it pinned, the keys of what it
//! shares) is in its own vault.
//!
//! Failures carry a code the front end tells apart: `ShareNoTeam`, `ShareNotMember`,
//! `ShareWaiting` (the keys haven't reached this account), `ShareKeyChanged` (the sharer's key
//! isn't the pinned one), `ShareNoMemberKey`, `ShareNotSharer`, `ShareGone`, `ShareNotShared`,
//! `ShareTooMany`, `ShareKeys`, `ShareTargetNotEmpty`, `SharePins` (the list of teammates'
//! keys couldn't be read as far as it was written: nothing is shared or read),
//! `ShareKeyFilesInHistory` (commits that weren't pushed hold key files: the share isn't
//! written), `ShareRemoteChanged` (a copy's clone address isn't the one that was shown), and
//! sync's own (`SyncLapsed`, `SyncFull`, `SyncOff`, `SyncOffline`…).

use tauri::State;

use crate::error::{Error, Result};
use crate::sync::share::{
    CopyPlan, Folder, Me, MemberInfo, OpenedCopy, ShareInfo, SharedFiles, SharedSnapshot, Shares,
    Synced,
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

/// What a copy of a share's snapshot would do first: `remote`, the address the folder would
/// be cloned from (the one the sharer works from; null: none that can be shown). The person
/// is shown it and asked before `share_open_copy` clones. Nothing is written, and nothing is
/// asked of that address.
#[tauri::command]
pub async fn share_copy_plan(
    state: State<'_, AppState>,
    base: String,
    id: String,
    snapshot: String,
) -> Result<CopyPlan> {
    shares(&state, &base)?.copy_plan(&id, &snapshot).await
}

/// Whether the open folder `root` is a clone of the repository the share `id` is of: their
/// git remotes are the same address once normalised. False when either has none. (A
/// reader's own sync id of the project is never the sharer's, so the ids can't say.)
#[tauri::command]
pub async fn share_matches_folder(
    state: State<'_, AppState>,
    base: String,
    id: String,
    root: String,
) -> Result<bool> {
    let root = snapshot_root(&state, &root)?;
    shares(&state, &base)?.matches_folder(&id, &root).await
}

/// A copy of a share's snapshot in the new or empty folder `target` (one the person picked).
/// With `clone` the folder is cloned first from `remote`, the address `share_copy_plan` gave
/// and the person agreed to: refused (`ShareRemoteChanged`) when the share names another one
/// by now. The clone runs without any prompt and for a bounded time; when it fails the copy
/// is made of what the snapshot carries, and `note` says so. Without `clone` nothing reaches
/// out to that address. Then the snapshot goes on top. The folder is opened like any other
/// that someone else made: nothing here trusts it.
#[tauri::command]
pub async fn share_open_copy(
    state: State<'_, AppState>,
    base: String,
    id: String,
    snapshot: String,
    target: String,
    clone: bool,
    remote: Option<String>,
) -> Result<OpenedCopy> {
    if state.workspace.remote().is_some() {
        return Err(Error::Sync(
            "Sync",
            "A copy is made on this computer, not in a remote window.".into(),
        ));
    }
    let clone_from = match (clone, remote.as_deref()) {
        (false, _) => None,
        (true, Some(address)) => Some(address),
        (true, None) => {
            return Err(Error::Invalid(
                "a clone needs the address that was shown".into(),
            ))
        }
    };
    // The one-snapshot-at-a-time guard is taken inside, for the restore only: never while
    // the clone waits on a server someone else chose.
    shares(&state, &base)?
        .open_copy(
            &id,
            &snapshot,
            std::path::Path::new(&target),
            clone_from,
            &SNAPSHOT,
        )
        .await
}
