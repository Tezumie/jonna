//! Chats across windows (D359, `agent::window_chats`): this window's chats published for the
//! others, the other live windows' chats, and the mailbox for messages between them.

use tauri::State;

use crate::agent::{reports, window_chats};
use crate::error::{Error, Result};
use crate::AppState;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| Error::Invalid(format!("task failed: {e}")))
}

/// Publishes this window's chats (`json`: `{ folder, chats }`); Rust adds its pid and the time.
#[tauri::command]
pub async fn agent_windows_publish(state: State<'_, AppState>, json: String) -> Result<()> {
    window_chats::publish(&state.dirs.data, std::process::id(), &json)
}

/// Takes this window's chats back out (it's closing, or has no chats).
#[tauri::command]
pub async fn agent_windows_unpublish(state: State<'_, AppState>) -> Result<()> {
    window_chats::remove(&state.dirs.data, std::process::id());
    Ok(())
}

/// The other live windows' records (their JSON text) and this window's pid.
#[tauri::command]
pub async fn agent_windows_list(state: State<'_, AppState>) -> Result<(u32, Vec<String>)> {
    let data = state.dirs.data.clone();
    blocking(move || {
        let own = std::process::id();
        let live = crate::instances::server::other_live_pids();
        (own, window_chats::list(&data, own, live.as_deref()))
    })
    .await
}

/// Leaves a message (`text`) for chat `chat`, under the id `id`.
#[tauri::command]
pub async fn agent_mail_put(
    state: State<'_, AppState>,
    id: String,
    chat: String,
    text: String,
) -> Result<()> {
    reports::put_at(&window_chats::mail_dir(&state.dirs.data), &id, &chat, &text)
}

/// The messages waiting (id, chat, when), without their text.
#[tauri::command]
pub async fn agent_mail_list(state: State<'_, AppState>) -> Result<Vec<reports::PendingEntry>> {
    reports::list_at(&window_chats::mail_dir(&state.dirs.data))
}

/// Takes a message: its text, or null when another window took it first.
#[tauri::command]
pub async fn agent_mail_claim(state: State<'_, AppState>, id: String) -> Result<Option<String>> {
    reports::claim_at(&window_chats::mail_dir(&state.dirs.data), &id)
}
