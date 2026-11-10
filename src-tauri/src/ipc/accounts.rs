//! The IDE's own account (src-tauri/src/accounts, D140). `base` is product.json's `accountsUrl`.

use tauri::ipc::Channel;
use tauri::State;

use crate::accounts::{self, Profile};
use crate::error::{Error, Result};
use crate::AppState;

/// The signed-in profile for `base`, or null.
#[tauri::command]
pub async fn account_profile(state: State<'_, AppState>, base: String) -> Result<Option<Profile>> {
    Ok(accounts::profile(
        &accounts::session_file(&state.dirs.data),
        &base,
    ))
}

/// The profile as the server has it now (D414): re-read, with the tokens refreshed when they've
/// run out; null when the server ended the session; the saved one when it can't be reached.
#[tauri::command]
pub async fn account_check(state: State<'_, AppState>, base: String) -> Result<Option<Profile>> {
    accounts::check(&accounts::session_file(&state.dirs.data), &base).await
}

/// Signs in through the browser: `on_url` gets the page to open; resolves with the profile.
#[tauri::command]
pub async fn account_sign_in(
    state: State<'_, AppState>,
    base: String,
    on_url: Channel<String>,
) -> Result<Profile> {
    let pending = accounts::begin(&base)?;
    on_url
        .send(pending.url.clone())
        .map_err(|e| Error::Invalid(e.to_string()))?;
    let (pending, code) = tauri::async_runtime::spawn_blocking(move || {
        let code = accounts::wait_for_code(&pending);
        (pending, code)
    })
    .await
    .map_err(|e| Error::Invalid(e.to_string()))?;
    accounts::finish(&pending, &code?, &accounts::session_file(&state.dirs.data)).await
}

/// Stops waiting for a browser sign-in.
#[tauri::command]
pub async fn account_cancel() -> Result<()> {
    accounts::cancel();
    Ok(())
}

#[tauri::command]
pub async fn account_sign_out(state: State<'_, AppState>) -> Result<()> {
    accounts::sign_out(&accounts::session_file(&state.dirs.data)).await
}

/// A signed-in account's picture (the Accounts icon, like VS Code's): fetched once a day into
/// `<data>/avatars/`, then served from there (also offline). Only https URLs on known hosts
/// (GitHub, or the IDE's accounts server); at most 2 MB.
#[tauri::command]
pub async fn account_avatar(
    state: State<'_, AppState>,
    url: String,
    base: String,
) -> Result<tauri::ipc::Response> {
    let allowed = url.starts_with("https://github.com/")
        || url.starts_with("https://avatars.githubusercontent.com/")
        || (!base.is_empty() && url.starts_with(&format!("{}/", base.trim_end_matches('/'))));
    if !allowed || !url.starts_with("https://") && !url.starts_with("http://127.0.0.1") {
        return Err(Error::Invalid(format!("not an avatar URL: {url}")));
    }
    let dir = state.dirs.data.join("avatars");
    let file = dir.join(format!("{}.img", crate::history::hash(url.as_bytes())));
    let fresh = std::fs::metadata(&file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age.as_secs() < 86_400);
    if !fresh {
        let fetched = async {
            let reply = reqwest::Client::new()
                .get(&url)
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
                .ok()?
                .error_for_status()
                .ok()?;
            let bytes = reply.bytes().await.ok()?;
            (bytes.len() <= 2 * 1024 * 1024).then_some(bytes)
        }
        .await;
        if let Some(bytes) = fetched {
            std::fs::create_dir_all(&dir)?;
            crate::store::atomic_write(&file, &bytes)?;
        }
    }
    // A stale copy beats none when offline.
    Ok(tauri::ipc::Response::new(std::fs::read(&file)?))
}
