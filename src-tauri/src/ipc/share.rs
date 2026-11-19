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
    Ask, ChatsSynced, CopiedChat, CopyPlan, Folder, Me, MemberInfo, News, OpenedCopy, Readers,
    ShareInfo, SharedChat, SharedFiles, SharedSnapshot, Shares, Shown, Synced,
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

/// Starts over with a new member key (the person's word, after sharing was refused because
/// the account's own record of its keys couldn't be read): teammates see the key as changed.
#[tauri::command]
pub async fn share_start_over(state: State<'_, AppState>, base: String) -> Result<()> {
    shares(&state, &base)?.start_over().await
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
/// verified ones), and, with the open folder `root`, takes its first snapshot. Whom it is
/// shared with (D453): `readers`, the chosen members' ids; else `whole_team` true for
/// everyone; neither: as it is (the whole team for a new share). Chosen people need a service
/// that keeps to it (`ShareNeedsService` otherwise; nothing is made).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn share_start(
    state: State<'_, AppState>,
    base: String,
    root: Option<String>,
    project: String,
    name: String,
    chats: bool,
    only_verified: bool,
    whole_team: Option<bool>,
    readers: Option<Vec<String>>,
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
    s.start_and_sync(
        &project,
        &name,
        chats,
        only_verified,
        Readers::from_input(whole_team, readers),
        folder,
    )
    .await
}

/// Changes a share's name, whether its chats are shared, and (as for `share_start`) whom it
/// is shared with. Someone taken off is refused by the service at once and the keys are
/// renewed here.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn share_update(
    state: State<'_, AppState>,
    base: String,
    project: String,
    name: String,
    chats: bool,
    only_verified: Option<bool>,
    whole_team: Option<bool>,
    readers: Option<Vec<String>>,
) -> Result<ShareInfo> {
    shares(&state, &base)?
        .update(
            &project,
            &name,
            chats,
            Readers::from_input(whole_team, readers),
            only_verified.unwrap_or(false),
        )
        .await
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

/// Makes the chats of this account's share of `project` the chats `chats` (the project's
/// chats on this computer, newest first; D454): new and changed ones are written, sealed
/// under the share's keys, and whatever else the share held of chats is taken out. With the
/// share's chats switch off, or an empty list, every shared chat goes. What travels is the
/// conversation only: nothing that grants something, no folder, and not what a tool read
/// from a key file. `root`: the open folder the project syncs from; a chat is shared only
/// when its own file says that folder is its. Without `root` nothing is written (what is
/// shared only goes). The folder must be the one this computer shares `project` from (the
/// backend keeps which that is). `busy`: chats being written now, left as they are. A chat
/// is taken out only when this computer wrote it and its file is gone or moved to another
/// folder, never because a pass didn't name it.
#[tauri::command]
pub async fn share_chats_sync(
    state: State<'_, AppState>,
    base: String,
    project: String,
    root: Option<String>,
    chats: Vec<String>,
    busy: Option<Vec<String>>,
) -> Result<ChatsSynced> {
    let root = match root {
        Some(root) => Some(snapshot_root(&state, &root)?),
        None => None,
    };
    shares(&state, &base)?
        .sync_chats(&project, root.as_deref(), chats, busy.unwrap_or_default())
        .await
}

/// The chats a share holds, newest first (empty: it shares none). Titles are a teammate's text.
#[tauri::command]
pub async fn share_chats(
    state: State<'_, AppState>,
    base: String,
    id: String,
) -> Result<Vec<SharedChat>> {
    shares(&state, &base)?.chats(&id).await
}

/// One chat of a share as its file's text, written nowhere (null: the share doesn't hold
/// it). A teammate's conversation: for reading, never to act on.
#[tauri::command]
pub async fn share_chat_text(
    state: State<'_, AppState>,
    base: String,
    id: String,
    chat: String,
) -> Result<Option<String>> {
    shares(&state, &base)?.chat_text(&id, &chat).await
}

/// Copies a chat of a share into this account's own chats as the new chat `save_as`, in the
/// folder `workspace` (none: a chat with no folder). `owner`: the sharer's name as the list
/// showed it, for the copy's title. The copy grants nothing, has nothing waiting, and ends
/// with a line saying that what is above is a teammate's. Nothing goes back to the share.
#[tauri::command]
pub async fn share_chat_copy(
    state: State<'_, AppState>,
    base: String,
    id: String,
    chat: String,
    save_as: String,
    workspace: Option<String>,
    owner: String,
) -> Result<CopiedChat> {
    shares(&state, &base)?
        .copy_chat(&id, &chat, &save_as, workspace.as_deref(), &owner)
        .await
}

/// Asks the teammate `uid` to share a project with this account (D455): a note their app
/// shows. It names no project and carries no text.
#[tauri::command]
pub async fn share_ask(state: State<'_, AppState>, base: String, uid: String) -> Result<()> {
    shares(&state, &base)?.ask(&uid).await
}

/// The teammates who asked this account to share a project, newest first. Empty from a
/// service that doesn't keep asks.
#[tauri::command]
pub async fn share_asks(state: State<'_, AppState>, base: String) -> Result<Vec<Ask>> {
    shares(&state, &base)?.asks().await
}

/// Forgets the ask the teammate `uid` made of this account (answered, or dismissed).
#[tauri::command]
pub async fn share_ask_clear(state: State<'_, AppState>, base: String, uid: String) -> Result<()> {
    shares(&state, &base)?.clear_ask(&uid).await
}

/// What is new among the teammates' shares the list shows now (`shown`: each one's id and
/// whether its chats are shared), for this computer: a share it hasn't seen, or one whose
/// chats weren't shared when it last looked. Remembered here, so each is said once. The
/// first look of an account on a computer says nothing (what was there before isn't news).
/// `asks`: the asks made of this account now (who, when); `asks` in the answer are the
/// ones this computer hasn't said yet (each is said once a computer, across restarts).
#[tauri::command]
pub async fn share_news(
    state: State<'_, AppState>,
    base: String,
    shown: Vec<Shown>,
    asks: Option<Vec<AskShown>>,
) -> Result<NewsNow> {
    let asks = asks
        .unwrap_or_default()
        .into_iter()
        .map(|ask| (ask.uid, ask.at))
        .collect();
    let (shares, asks) = shares(&state, &base)?.news(shown, asks)?;
    Ok(NewsNow { shares, asks })
}

/// An ask as the list shows it now.
#[derive(Debug, serde::Deserialize)]
pub struct AskShown {
    pub uid: String,
    #[serde(default)]
    pub at: u64,
}

/// What `share_news` answers.
#[derive(Debug, serde::Serialize)]
pub struct NewsNow {
    pub shares: Vec<News>,
    /// Who newly asked this account to share a project.
    pub asks: Vec<String>,
}
