//! Sync (src-tauri/src/sync, D435). `base` is the accounts server, as for the account itself.
//! One step at a time: a status check may be handing this device new keys while another
//! command wants them.

use tauri::State;

use crate::error::{Error, Result};
use crate::sync::records::{self, Changes, Put, Record};
use crate::sync::vault::{Status, Vault};
use crate::AppState;

static STEP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn vault(state: &AppState, base: &str) -> Vault {
    Vault::new(base, &state.dirs.data)
}

/// The collections a front end may write: not the ones the backend keeps for itself.
fn writable(collection: &str) -> Result<()> {
    if collection == "sys" {
        return Err(Error::Invalid(
            "that collection isn't the front end's".into(),
        ));
    }
    Ok(())
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

/// Asks to join an account that already syncs; returns the code both computers show.
#[tauri::command]
pub async fn sync_join(state: State<'_, AppState>, base: String, name: String) -> Result<String> {
    let _step = STEP.lock().await;
    vault(&state, &base).join(&name).await
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
    records::changes(&v.api, &v.keyring()?, since).await
}

#[tauri::command]
pub async fn sync_record_get(
    state: State<'_, AppState>,
    base: String,
    collection: String,
    id: String,
) -> Result<Option<Record>> {
    let v = vault(&state, &base);
    records::get(&v.api, &v.keyring()?, &collection, &id).await
}

/// Writes a record over the version it was made from (`expect`; null: it must be new).
/// `text` null deletes it.
#[tauri::command]
pub async fn sync_record_put(
    state: State<'_, AppState>,
    base: String,
    collection: String,
    id: String,
    expect: Option<u64>,
    text: Option<String>,
) -> Result<Put> {
    writable(&collection)?;
    let v = vault(&state, &base);
    records::put(
        &v.api,
        &v.keyring()?,
        &collection,
        &id,
        expect,
        text.as_deref(),
        None,
    )
    .await
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
    writable(&collection)?;
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
) -> Result<Option<u64>> {
    let v = vault(&state, &base);
    crate::sync::chats::pull(
        &v.api,
        &v.keyring()?,
        &state.dirs.data,
        &collection,
        &id,
        &save_as,
        workspace.as_deref(),
    )
    .await
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
