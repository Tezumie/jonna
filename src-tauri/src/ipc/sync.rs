//! Sync (src-tauri/src/sync, D435). `base` is the accounts server, as for the account itself.
//! One step at a time: a status check may be handing this device new keys while another
//! command wants them.

use tauri::State;

use crate::error::{Error, Result};
use crate::sync::records::{self, Changes, Put, Record};
use crate::sync::vault::{Status, Vault};
use crate::AppState;

static STEP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// One snapshot or restore at a time: two at once would read and write the same folder.
pub(crate) static SNAPSHOT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn vault(state: &AppState, base: &str) -> Vault {
    Vault::new(base, &state.dirs.data)
}

/// Whether a collection is the backend's own: `sys` (the account's member key, the pins of
/// its teammates' keys, its trusted devices) and `shares` (the keyrings of the projects it
/// shares). Their records are read and written in Rust only (`sync::vault`, `sync::share`).
/// The name is compared as it is: `named` has made sure it is one part of an address, so no
/// other spelling reaches the same collection.
fn backend_only(collection: &str) -> bool {
    collection == "sys" || collection == "shares"
}

/// The record a front end's command names (`collection`/`id`), before anything is asked:
/// both are names the service takes (`records::named`: one part of an address each, so
/// `x/../sys` names nothing), and the collection isn't one the backend keeps for itself. No
/// command of the front end reads the content of such a record, writes it, deletes it, or
/// uses it as a snapshot or a chat.
fn front_end_record(collection: &str, id: &str) -> Result<()> {
    records::named(collection, id)?;
    if backend_only(collection) {
        return Err(Error::Invalid(
            "that collection isn't the front end's".into(),
        ));
    }
    Ok(())
}

/// A record as the front end gets it: the backend's own (which hold keys, or say whose keys
/// are trusted) without their content. The front end sees that they are there and what
/// version they are. Every record handed to the front end passes here: a listed one, one
/// asked for, and the one a refused write comes back with (`for_front_end`).
fn without_keys(mut record: Record) -> Record {
    if backend_only(&record.collection) {
        record.text = None;
        record.info = None;
    }
    record
}

/// What a write came to, as the front end gets it: a conflict hands back the record as it
/// is now, which is a record like any other.
fn for_front_end(put: Put) -> Put {
    match put {
        Put::Conflict { current } => Put::Conflict {
            current: current.map(without_keys),
        },
        other => other,
    }
}

/// Where sync stands for this device and account, catching up with changes made elsewhere.
#[tauri::command]
pub async fn sync_status(state: State<'_, AppState>, base: String) -> Result<Status> {
    let _step = STEP.lock().await;
    vault(&state, &base).status().await
}

/// Makes the keys for turning sync on and returns the recovery key to show. Nothing is sent.
#[tauri::command]
pub async fn sync_prepare(
    state: State<'_, AppState>,
    base: String,
    name: String,
) -> Result<String> {
    let _step = STEP.lock().await;
    vault(&state, &base).prepare(&name)
}

/// Turns sync on for the account, once the recovery key was typed back.
#[tauri::command]
pub async fn sync_setup(state: State<'_, AppState>, base: String, typed: String) -> Result<()> {
    let _step = STEP.lock().await;
    vault(&state, &base).setup(&typed).await
}

/// Starts checking a waiting device. The code both computers show appears in the status
/// once the waiting one has answered.
#[tauri::command]
pub async fn sync_review_device(
    state: State<'_, AppState>,
    base: String,
    device: String,
) -> Result<()> {
    let _step = STEP.lock().await;
    vault(&state, &base).review(&device).await
}

/// Asks to join an account that already syncs. The code to compare shows (in the status)
/// once a computer that syncs starts checking this one.
#[tauri::command]
pub async fn sync_join(state: State<'_, AppState>, base: String, name: String) -> Result<()> {
    let _step = STEP.lock().await;
    vault(&state, &base).join(&name).await
}

/// Gives this computer another name in the account's list; returns the name as kept.
#[tauri::command]
pub async fn sync_rename_device(
    state: State<'_, AppState>,
    base: String,
    name: String,
) -> Result<String> {
    let _step = STEP.lock().await;
    vault(&state, &base).rename(&name).await
}

/// Joins with the recovery key.
#[tauri::command]
pub async fn sync_join_recovery(
    state: State<'_, AppState>,
    base: String,
    name: String,
    key: String,
) -> Result<()> {
    let _step = STEP.lock().await;
    vault(&state, &base).join_with_recovery(&name, &key).await
}

/// Hands the account's keys to a waiting device.
#[tauri::command]
pub async fn sync_approve(state: State<'_, AppState>, base: String, device: String) -> Result<()> {
    let _step = STEP.lock().await;
    vault(&state, &base).approve(&device).await
}

/// Removes a device from the account; this one's own id turns sync off here.
#[tauri::command]
pub async fn sync_remove_device(
    state: State<'_, AppState>,
    base: String,
    device: String,
) -> Result<()> {
    let _step = STEP.lock().await;
    vault(&state, &base).remove(&device).await
}

/// Replaces the recovery key and returns the new one to show.
#[tauri::command]
pub async fn sync_new_recovery_key(state: State<'_, AppState>, base: String) -> Result<String> {
    let _step = STEP.lock().await;
    vault(&state, &base).new_recovery_key().await
}

/// Records changed after `since`, opened.
#[tauri::command]
pub async fn sync_changes(state: State<'_, AppState>, base: String, since: u64) -> Result<Changes> {
    let v = vault(&state, &base);
    let mut changes = records::changes(&v.api, &v.keyring()?, since).await?;
    changes.records = changes.records.into_iter().map(without_keys).collect();
    Ok(changes)
}

#[tauri::command]
pub async fn sync_record_get(
    state: State<'_, AppState>,
    base: String,
    collection: String,
    id: String,
) -> Result<Option<Record>> {
    let v = vault(&state, &base);
    Ok(records::get(&v.api, &v.keyring()?, &collection, &id)
        .await?
        .map(without_keys))
}

/// Writes a record over the version it was made from (`expect`; null: it must be new).
/// `text` null deletes it. `info` is a label the service can read (never content).
#[tauri::command]
pub async fn sync_record_put(
    state: State<'_, AppState>,
    base: String,
    collection: String,
    id: String,
    expect: Option<u64>,
    text: Option<String>,
    info: Option<serde_json::Value>,
) -> Result<Put> {
    front_end_record(&collection, &id)?;
    let v = vault(&state, &base);
    records::put_labeled(
        &v.api,
        &v.keyring()?,
        &collection,
        &id,
        expect,
        text.as_deref(),
        None,
        info.as_ref(),
    )
    .await
    .map(for_front_end)
}

/// Uploads a chat as the record `collection`/`id` (null when the chat has no file).
#[tauri::command]
pub async fn sync_chat_push(
    state: State<'_, AppState>,
    base: String,
    collection: String,
    id: String,
    expect: Option<u64>,
) -> Result<Option<Put>> {
    front_end_record(&collection, &id)?;
    let v = vault(&state, &base);
    crate::sync::chats::push(
        &v.api,
        &v.keyring()?,
        &state.dirs.data,
        &collection,
        &id,
        expect,
    )
    .await
    .map(|put| put.map(for_front_end))
}

/// Downloads the chat in the record `collection`/`id` and saves it as the chat `save_as`,
/// in the project folder `workspace` (null: none). Returns the record's version.
#[tauri::command]
pub async fn sync_chat_pull(
    state: State<'_, AppState>,
    base: String,
    collection: String,
    id: String,
    save_as: String,
    workspace: Option<String>,
    if_stamp: Option<String>,
) -> Result<Option<u64>> {
    front_end_record(&collection, &id)?;
    let v = vault(&state, &base);
    crate::sync::chats::pull(
        &v.api,
        &v.keyring()?,
        &state.dirs.data,
        &collection,
        &id,
        &save_as,
        workspace.as_deref(),
        if_stamp.as_deref(),
    )
    .await
}

/// Chats deleted on this computer that sync hasn't been told about yet (ids).
#[tauri::command]
pub async fn sync_chats_deleted(state: State<'_, AppState>) -> Result<Vec<String>> {
    Ok(crate::agent::deleted_sessions(&state.dirs.data))
}

/// Forgets those deletions, once the account knows of them.
#[tauri::command]
pub async fn sync_chats_deleted_clear(state: State<'_, AppState>, ids: Vec<String>) -> Result<()> {
    crate::agent::forget_deleted_sessions(&state.dirs.data, &ids)
}

/// The project name a git remote's address gives (the same on every computer of the account,
/// and meaningless to anyone without its keys); null for an address that is only local.
#[tauri::command]
pub async fn sync_project_name(
    state: State<'_, AppState>,
    base: String,
    remote: String,
) -> Result<Option<String>> {
    let Some(address) = crate::sync::project::normalize_remote(&remote) else {
        return Ok(None);
    };
    Ok(Some(vault(&state, &base).keyring()?.name_of(&address)?))
}

/// What a computer keeps of its last snapshot of a project: to tell "nothing changed", and to
/// skip reading files that didn't change.
#[derive(serde::Serialize, serde::Deserialize)]
struct LastSnapshot {
    root: String,
    fingerprint: String,
    manifest: crate::sync::snapshot::Manifest,
}

fn last_snapshot_file(v: &Vault, collection: &str) -> std::path::PathBuf {
    let name: String = collection
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    v.sync_file("snapshots").join(format!("{name}.json"))
}

/// The open local folder a snapshot is made of or restored into.
pub(crate) fn snapshot_root(state: &AppState, root: &str) -> Result<std::path::PathBuf> {
    if state.workspace.remote().is_some() {
        return Err(Error::Sync(
            "Sync",
            "Snapshots are for folders on this computer, not a remote window's.".into(),
        ));
    }
    state.workspace.scope_root(root)
}

/// Where the picture of a folder as a restore left it is kept: while the folder still looks
/// like that, its uncommitted changes are the snapshot's, not work done here.
fn restored_mark(state: &AppState, root: &std::path::Path) -> std::path::PathBuf {
    use sha2_10::{Digest, Sha256};
    let name = crate::sync::crypto::b64(&Sha256::digest(root.to_string_lossy().as_bytes())[..12]);
    state.dirs.data.join("sync").join("restored").join(name)
}

fn is_as_restored(state: &AppState, root: &std::path::Path) -> bool {
    let Ok(mark) = std::fs::read_to_string(restored_mark(state, root)) else {
        return false;
    };
    crate::sync::snapshot::fingerprint(root).is_ok_and(|now| now == mark.trim())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Captures the open folder `root` as a new snapshot in `collection`. Null when nothing
/// changed since this computer's last one (unless `force`), or when `baseline` only noted
/// the folder's state.
#[tauri::command]
pub async fn sync_snapshot_create(
    state: State<'_, AppState>,
    base: String,
    root: String,
    collection: String,
    everything: bool,
    force: bool,
    baseline: Option<bool>,
) -> Result<Option<crate::sync::snapshot::Created>> {
    use crate::sync::snapshot;
    if !records::valid_collection(&collection) || backend_only(&collection) {
        return Err(Error::Invalid(
            "that collection isn't the front end's".into(),
        ));
    }
    let _one = SNAPSHOT.lock().await;
    let root = snapshot_root(&state, &root)?;
    let v = vault(&state, &base);
    let ring = v.keyring()?;
    let (device, device_name) = v
        .device()
        .ok_or_else(|| Error::Sync("SyncOff", "Sync isn't on for this device.".into()))?;
    let cache = last_snapshot_file(&v, &collection);
    let last: Option<LastSnapshot> = std::fs::read(&cache)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .filter(|l: &LastSnapshot| l.root == root.to_string_lossy());
    let picture = snapshot::fingerprint(&root)?;
    if !force && last.as_ref().is_some_and(|l| l.fingerprint == picture) {
        return Ok(None);
    }
    // `baseline`: another computer's snapshots of this project exist and this one has made
    // none. The folder as it is now is only noted, so this computer's first snapshot is of
    // work done here, not of a state older than the one it could continue from.
    if !force && baseline == Some(true) && last.is_none() {
        if let Some(dir) = cache.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let noted = LastSnapshot {
            root: root.to_string_lossy().to_string(),
            fingerprint: picture,
            manifest: snapshot::Manifest::default(),
        };
        if let Ok(bytes) = serde_json::to_vec(&noted) {
            let _ = crate::store::atomic_write(&cache, &bytes);
        }
        return Ok(None);
    }
    let created = snapshot::create(
        &v.api,
        &ring,
        &state.dirs.data,
        &root,
        snapshot::CreateOptions {
            collection: &collection,
            device: &device,
            device_name: &device_name,
            everything,
            before: last.as_ref().map(|l| &l.manifest),
            now_ms: now_ms(),
            leave_out: None,
            remote_as: None,
            head_only: false,
        },
    )
    .await?;
    // Kept for the next time; losing it only costs reading the files again.
    if let Ok(manifest) = snapshot::manifest(&v.api, &ring, &created.summary).await {
        if let Some(dir) = cache.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let last = LastSnapshot {
            root: root.to_string_lossy().to_string(),
            fingerprint: created.summary.fingerprint.clone(),
            manifest,
        };
        if let Ok(bytes) = serde_json::to_vec(&last) {
            let _ = crate::store::atomic_write(&cache, &bytes);
        }
    }
    Ok(Some(created))
}

/// The files a snapshot holds: for a git project the changed files and the deletions, for a
/// folder without git every file.
#[tauri::command]
pub async fn sync_snapshot_files(
    state: State<'_, AppState>,
    base: String,
    collection: String,
    id: String,
) -> Result<Vec<crate::sync::snapshot::ListedFile>> {
    use crate::sync::snapshot;
    front_end_record(&collection, &id)?;
    let v = vault(&state, &base);
    let ring = v.keyring()?;
    let summary = snapshot::summary(&v.api, &ring, &collection, &id).await?;
    Ok(snapshot::list(
        &snapshot::manifest(&v.api, &ring, &summary).await?,
    ))
}

/// A snapshot's files, each with how it stands against the open folder `root`: the same,
/// different, or not there. Only the snapshot's list is fetched; the folder's files are read
/// here and nothing is written.
#[tauri::command]
pub async fn sync_snapshot_compare(
    state: State<'_, AppState>,
    base: String,
    collection: String,
    id: String,
    root: String,
) -> Result<crate::sync::snapshot::Compared> {
    use crate::sync::snapshot;
    front_end_record(&collection, &id)?;
    let root = snapshot_root(&state, &root)?;
    let v = vault(&state, &base);
    let ring = v.keyring()?;
    let summary = snapshot::summary(&v.api, &ring, &collection, &id).await?;
    let manifest = snapshot::manifest(&v.api, &ring, &summary).await?;
    // Reading the folder's files takes a while in a large one: off the async threads.
    tokio::task::spawn_blocking(move || {
        snapshot::compare(&ring, &root, &manifest, snapshot::COMPARE_MAX)
    })
    .await
    .map_err(|e| Error::Sync("Sync", e.to_string()))
}

/// One file of a snapshot as text, written nowhere. Null when the snapshot doesn't hold the
/// file; without text (and with why) when it is too large to show or isn't text.
#[tauri::command]
pub async fn sync_snapshot_file_text(
    state: State<'_, AppState>,
    base: String,
    collection: String,
    id: String,
    path: String,
) -> Result<Option<crate::sync::snapshot::FileText>> {
    use crate::sync::snapshot;
    front_end_record(&collection, &id)?;
    let v = vault(&state, &base);
    let ring = v.keyring()?;
    let summary = snapshot::summary(&v.api, &ring, &collection, &id).await?;
    let manifest = snapshot::manifest(&v.api, &ring, &summary).await?;
    snapshot::read_text(&v.api, &ring, &manifest, &path).await
}

/// The open folder's own changed files: what a restore would have to set aside first.
#[tauri::command]
pub async fn sync_snapshot_local_changes(
    state: State<'_, AppState>,
    root: String,
) -> Result<Vec<String>> {
    let root = snapshot_root(&state, &root)?;
    // Changes a restore put there aren't this computer's own.
    if is_as_restored(&state, &root) {
        return Ok(Vec::new());
    }
    crate::sync::snapshot::local_changes(&root)
}

/// Brings the open folder `root` to a snapshot. With local changes: refused (`SyncDirty`)
/// unless `stash`, which puts them in a git stash first.
#[tauri::command]
pub async fn sync_snapshot_restore(
    state: State<'_, AppState>,
    base: String,
    collection: String,
    id: String,
    root: String,
    stash: bool,
) -> Result<crate::sync::snapshot::Restored> {
    use crate::sync::snapshot;
    front_end_record(&collection, &id)?;
    let _one = SNAPSHOT.lock().await;
    let root = snapshot_root(&state, &root)?;
    let v = vault(&state, &base);
    let ring = v.keyring()?;
    let summary = snapshot::summary(&v.api, &ring, &collection, &id).await?;
    let manifest = snapshot::manifest(&v.api, &ring, &summary).await?;
    let restored = snapshot::restore(
        &v.api,
        &ring,
        &state.dirs.data,
        &root,
        &manifest,
        snapshot::RestoreOptions {
            stash,
            as_restored: is_as_restored(&state, &root),
            from: &summary.device_name,
            // The account's own snapshot: its remote is the person's own.
            network: true,
        },
    )
    .await?;
    // The folder as it is now is the snapshot: remembered, so the next restore replaces it
    // without asking, and so this computer doesn't store the same state again as its own.
    if let Ok(picture) = snapshot::fingerprint(&root) {
        let mark = restored_mark(&state, &root);
        if let Some(dir) = mark.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = crate::store::atomic_write(&mark, picture.as_bytes());
        let cache = last_snapshot_file(&v, &collection);
        if let Some(dir) = cache.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let last = LastSnapshot {
            root: root.to_string_lossy().to_string(),
            fingerprint: picture,
            manifest,
        };
        if let Ok(bytes) = serde_json::to_vec(&last) {
            let _ = crate::store::atomic_write(&cache, &bytes);
        }
    }
    Ok(restored)
}

/// Writes one file of a snapshot back where it was.
#[tauri::command]
pub async fn sync_snapshot_restore_file(
    state: State<'_, AppState>,
    base: String,
    collection: String,
    id: String,
    root: String,
    path: String,
) -> Result<()> {
    use crate::sync::snapshot;
    front_end_record(&collection, &id)?;
    let root = snapshot_root(&state, &root)?;
    let v = vault(&state, &base);
    let ring = v.keyring()?;
    let summary = snapshot::summary(&v.api, &ring, &collection, &id).await?;
    let manifest = snapshot::manifest(&v.api, &ring, &summary).await?;
    snapshot::restore_file(&v.api, &ring, &root, &manifest, &path).await
}

/// Pins a snapshot under a name (kept whatever its age), or unpins it (`name` null).
#[tauri::command]
pub async fn sync_snapshot_pin(
    state: State<'_, AppState>,
    base: String,
    collection: String,
    id: String,
    name: Option<String>,
) -> Result<()> {
    use crate::sync::snapshot;
    front_end_record(&collection, &id)?;
    let v = vault(&state, &base);
    let ring = v.keyring()?;
    let record = records::get(&v.api, &ring, &collection, &id)
        .await?
        .filter(|r| !r.deleted)
        .ok_or_else(|| Error::Sync("Sync", "That snapshot is gone.".into()))?;
    let summary: snapshot::Summary = serde_json::from_str(record.text.as_deref().unwrap_or(""))?;
    let next = serde_json::to_string(&snapshot::pinned(&summary, name.as_deref()))?;
    match snapshot::rewrite(&v.api, &ring, &collection, &id, record.version, &next).await? {
        Put::Done { .. } => Ok(()),
        _ => Err(Error::Sync(
            "Sync",
            "The snapshot changed; try again.".into(),
        )),
    }
}

/// Sets or clears the mark the account page puts on a snapshot to keep it ("pinned from your
/// account page"): history never removes a marked snapshot. The name a snapshot is pinned
/// under on a computer is another thing (`sync_snapshot_pin`); a snapshot can have both.
#[tauri::command]
pub async fn sync_snapshot_keep(
    state: State<'_, AppState>,
    base: String,
    collection: String,
    id: String,
    keep: bool,
) -> Result<()> {
    if !collection.starts_with("snap.") {
        return Err(Error::Invalid("only a snapshot is kept this way".into()));
    }
    records::set_keep(&vault(&state, &base).api, &collection, &id, keep).await
}

/// Asks the service to remove stored content nothing refers to any more (after snapshots or
/// chats were deleted); the bytes in use when it finished.
#[tauri::command]
pub async fn sync_gc(state: State<'_, AppState>, base: String) -> Result<Option<u64>> {
    let v = vault(&state, &base);
    let reply = v.api.post("gc", &serde_json::json!({})).await?.into_ok()?;
    Ok(reply["usageBytes"].as_u64())
}

fn user_roots(state: &AppState) -> crate::sync::user_files::Roots {
    crate::sync::user_files::Roots {
        config: crate::store::simplify(state.dirs.config.clone()),
        skills: crate::ipc::skills::user_skills_dir(state),
    }
}

/// The user's own files that sync (keybindings, rules, snippets, subagents, commands, output
/// styles, skills), each under a name that is the same on every computer.
#[tauri::command]
pub async fn sync_user_files(state: State<'_, AppState>) -> Result<crate::sync::user_files::Scan> {
    Ok(user_roots(&state).scan())
}

#[tauri::command]
pub async fn sync_user_file_read(
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<String>> {
    user_roots(&state).read(&path)
}

/// Writes one of those files (`text` null removes it); its new entry.
#[tauri::command]
pub async fn sync_user_file_write(
    state: State<'_, AppState>,
    path: String,
    text: Option<String>,
) -> Result<Option<crate::sync::user_files::UserFile>> {
    user_roots(&state).write(&path, text.as_deref())
}

/// What the front end's sync loop keeps between runs (what this computer last synced).
#[tauri::command]
pub async fn sync_state_load(state: State<'_, AppState>) -> Result<Option<String>> {
    match std::fs::read_to_string(state.dirs.data.join("sync").join("front.json")) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
pub async fn sync_state_save(state: State<'_, AppState>, text: String) -> Result<()> {
    serde_json::from_str::<serde_json::Value>(&text)?;
    let dir = state.dirs.data.join("sync");
    std::fs::create_dir_all(&dir)?;
    crate::store::atomic_write(&dir.join("front.json"), text.as_bytes())
}

/// How long a window's claim on the sync loop holds without being renewed.
const LEASE_MS: u64 = 90_000;

/// Claims the sync loop for `owner` (a window): true when it has it. One window of a profile
/// syncs at a time; the claim is renewed by asking again, and passes on when its holder stops.
#[tauri::command]
pub async fn sync_lease(state: State<'_, AppState>, owner: String) -> Result<bool> {
    let dir = state.dirs.data.join("sync");
    let file = dir.join("lease.json");
    let now = now_ms();
    let held = std::fs::read_to_string(&file)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    if let Some(held) = held {
        let theirs = held["owner"].as_str().unwrap_or("") != owner;
        let fresh = now.saturating_sub(held["at"].as_u64().unwrap_or(0)) < LEASE_MS;
        if theirs && fresh {
            return Ok(false);
        }
    }
    std::fs::create_dir_all(&dir)?;
    crate::store::atomic_write(
        &file,
        serde_json::json!({ "owner": owner, "at": now })
            .to_string()
            .as_bytes(),
    )?;
    // Two windows claiming in the same moment: the one whose write is the file's has it.
    let after = std::fs::read_to_string(&file).unwrap_or_default();
    Ok(serde_json::from_str::<serde_json::Value>(&after)
        .is_ok_and(|v| v["owner"].as_str() == Some(owner.as_str())))
}

/// Which project a folder is (D435).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectIdentity {
    pub id: String,
    /// "file": an id kept in the project's own settings folder. "remote": from its git
    /// remote's address, nothing written.
    pub kind: &'static str,
}

/// The id file's name in the project's settings folder.
const PROJECT_FILE: &str = "project.json";

fn project_folder_name(name: &str) -> Result<&str> {
    crate::fs::validate_name(name)?;
    Ok(name)
}

/// The open folder's project identity: the id file when there is one (it wins, so a remote
/// added later doesn't split the project), else its git remote's address, else (only with
/// `create`, when sync is turned on for the project) a new id file. `folder_name` is
/// product.json's `workspaceFolderName`. Null: no identity yet.
#[tauri::command]
pub async fn sync_project(
    state: State<'_, AppState>,
    base: String,
    root: String,
    folder_name: String,
    create: bool,
) -> Result<Option<ProjectIdentity>> {
    let root = snapshot_root(&state, &root)?;
    let file = root
        .join(project_folder_name(&folder_name)?)
        .join(PROJECT_FILE);
    let stored = std::fs::read_to_string(&file)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["id"].as_str().map(str::to_string))
        .filter(|id| {
            id.len() == 22
                && id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        });
    if let Some(id) = stored {
        return Ok(Some(ProjectIdentity { id, kind: "file" }));
    }
    // `origin` first, then by name (the same rule a share is matched to a folder by).
    if let Some(address) = crate::sync::project::folder_remote(&root) {
        let id = vault(&state, &base).keyring()?.name_of(&address)?;
        return Ok(Some(ProjectIdentity { id, kind: "remote" }));
    }
    if !create {
        return Ok(None);
    }
    let id = crate::sync::crypto::new_id()?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    crate::store::atomic_write(
        &file,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&serde_json::json!({ "id": id }))?
        )
        .as_bytes(),
    )?;
    Ok(Some(ProjectIdentity { id, kind: "file" }))
}

/// This computer's name, to offer when it joins sync.
#[tauri::command]
pub async fn sync_device_name() -> Result<String> {
    Ok(crate::sync::vault::default_name())
}

/// Gives up this window's claim on the sync loop (it is closing), so another takes over at once.
#[tauri::command]
pub async fn sync_lease_release(state: State<'_, AppState>, owner: String) -> Result<()> {
    let file = state.dirs.data.join("sync").join("lease.json");
    let held = std::fs::read_to_string(&file)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
    if held.is_some_and(|h| h["owner"].as_str() == Some(owner.as_str())) {
        let _ = std::fs::remove_file(&file);
    }
    Ok(())
}

/// Whether the chat saved here is, byte for byte, the one in the record `collection`/`id`:
/// a computer that lost what it had synced can tell "the same chat" from "changed on both".
#[tauri::command]
pub async fn sync_chat_same(
    state: State<'_, AppState>,
    base: String,
    collection: String,
    id: String,
) -> Result<bool> {
    front_end_record(&collection, &id)?;
    let v = vault(&state, &base);
    crate::sync::chats::same(&v.api, &v.keyring()?, &state.dirs.data, &collection, &id).await
}

/// Makes the open folder `root` the project `id` (one of the account's): writes the id file,
/// so this folder and that project are the same from now on. Refused when the folder already
/// has an id file.
#[tauri::command]
pub async fn sync_project_link(
    state: State<'_, AppState>,
    root: String,
    folder_name: String,
    id: String,
    replace: bool,
) -> Result<()> {
    let root = snapshot_root(&state, &root)?;
    if id.len() != 22
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(Error::Invalid("not a project id".into()));
    }
    let file = root
        .join(project_folder_name(&folder_name)?)
        .join(PROJECT_FILE);
    if file.exists() && !replace {
        return Err(Error::Sync(
            "Sync",
            "This folder already has a project identity.".into(),
        ));
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    crate::store::atomic_write(
        &file,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&serde_json::json!({ "id": id }))?
        )
        .as_bytes(),
    )
}

/// Gives the open folder a new identity of its own (a copy of a project that should be a
/// project of its own): a new id file, replacing the one that came with the copy.
#[tauri::command]
pub async fn sync_project_separate(
    state: State<'_, AppState>,
    root: String,
    folder_name: String,
) -> Result<String> {
    let root = snapshot_root(&state, &root)?;
    let file = root
        .join(project_folder_name(&folder_name)?)
        .join(PROJECT_FILE);
    let id = crate::sync::crypto::new_id()?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    crate::store::atomic_write(
        &file,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&serde_json::json!({ "id": id }))?
        )
        .as_bytes(),
    )?;
    Ok(id)
}

/// What a first snapshot of the open folder would take (files, bytes, the largest parts): to
/// say so before a large folder starts uploading.
#[tauri::command]
pub async fn sync_snapshot_estimate(
    state: State<'_, AppState>,
    root: String,
) -> Result<crate::sync::snapshot::Estimate> {
    let root = snapshot_root(&state, &root)?;
    tokio::task::spawn_blocking(move || crate::sync::snapshot::estimate(&root))
        .await
        .map_err(|e| Error::Invalid(e.to_string()))?
}

/// The open folder's list of what stays out of its snapshots (`.syncignore`, written as a
/// `.gitignore` is): made with a short explanation when it isn't there. Returns its path.
#[tauri::command]
pub async fn sync_ignore_file(state: State<'_, AppState>, root: String) -> Result<String> {
    let root = snapshot_root(&state, &root)?;
    let file = root.join(".syncignore");
    if !file.exists() {
        crate::store::atomic_write(
            &file,
            b"# Folders and files to keep out of this project's synced snapshots.\n# One pattern per line, written as in a .gitignore. For example:\n#   data/\n#   *.mp4\n",
        )?;
    }
    Ok(file.to_string_lossy().to_string())
}

/// Which of these folders exist on this computer (the folders that sync from it are kept by
/// path: one that was moved or deleted is said to be missing, not silently kept).
#[tauri::command]
pub async fn sync_folders_exist(paths: Vec<String>) -> Result<Vec<bool>> {
    Ok(paths
        .iter()
        .take(500)
        .map(|p| std::path::Path::new(p).is_dir())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(collection: &str, id: &str) -> Record {
        Record {
            collection: collection.into(),
            id: id.into(),
            version: 3,
            seq: 9,
            deleted: false,
            text: Some("{\"key\":\"PRIVATE\"}".into()),
            unreadable: false,
            damaged: false,
            refs: 0,
            device: None,
            updated_at: None,
            info: Some(serde_json::json!({ "name": "x" })),
            keep: false,
        }
    }

    #[test]
    fn the_backends_own_records_are_never_the_front_ends() {
        // Named as they are.
        for (collection, id) in [
            ("sys", "member"),
            ("sys", "team"),
            ("sys", "devices"),
            ("shares", "AbCdEf"),
        ] {
            assert!(
                front_end_record(collection, id).is_err(),
                "{collection}/{id}"
            );
        }
        // Named so that the address would be read as one of them: refused as no name at all,
        // before anything is asked.
        for (collection, id) in [
            ("x/../sys", "member"),
            ("x/../shares", "AbCdEf"),
            ("x", "../sys/member"),
            ("sys/member", "x"),
            ("./sys", "member"),
            ("sys/", "member"),
            ("x\\..\\sys", "member"),
            ("%73ys", "member"),
            ("..", "sys"),
        ] {
            assert!(
                front_end_record(collection, id).is_err(),
                "{collection}/{id}"
            );
        }
        for (collection, id) in [
            ("settings", "user"),
            ("chats", "abc"),
            ("snap.AbC", "1800000000000-abc123"),
            // Another collection, whatever it looks like: the service compares names as written.
            ("system", "member"),
            ("Sys", "member"),
        ] {
            assert!(
                front_end_record(collection, id).is_ok(),
                "{collection}/{id}"
            );
        }
    }

    #[test]
    fn a_record_with_keys_reaches_the_front_end_without_its_content() {
        for (collection, id) in [
            ("sys", "member"),
            ("sys", "team"),
            ("sys", "devices"),
            ("shares", "p1"),
        ] {
            let shown = without_keys(record(collection, id));
            assert_eq!(shown.text, None, "{collection}/{id}");
            assert_eq!(shown.info, None);
            assert_eq!(
                shown.version, 3,
                "that it is there, and its version, are said"
            );
        }
        assert!(without_keys(record("settings", "user")).text.is_some());
        // The record a refused write comes back with is a record like any other.
        match for_front_end(Put::Conflict {
            current: Some(record("sys", "member")),
        }) {
            Put::Conflict {
                current: Some(shown),
            } => assert_eq!(shown.text, None),
            other => panic!("unexpected: {other:?}"),
        }
        match for_front_end(Put::Conflict {
            current: Some(record("settings", "user")),
        }) {
            Put::Conflict {
                current: Some(shown),
            } => assert!(shown.text.is_some()),
            other => panic!("unexpected: {other:?}"),
        }
        assert!(matches!(
            for_front_end(Put::Done { version: 1, seq: 2 }),
            Put::Done { version: 1, seq: 2 }
        ));
    }
}
