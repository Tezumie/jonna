//! ACP agent registry commands (D215, `crate::acp_agents`): the registry file and icons, and
//! downloading, cancelling and removing binary agents.

use tauri::ipc::Channel;
use tauri::State;

use crate::acp_agents::{self, InstallRequest, Installed, OnDisk, Progress};
use crate::error::Result;
use crate::AppState;

/// This machine's platform in the registry's terms (`linux-x86_64`…), if it has one.
#[tauri::command]
pub fn acp_registry_platform() -> Option<String> {
    acp_agents::platform().map(str::to_string)
}

/// The registry file, fetched now (and cached); `url` is honored by test builds only.
#[tauri::command]
pub async fn acp_registry_fetch(state: State<'_, AppState>, url: Option<String>) -> Result<String> {
    acp_agents::fetch_registry(&state.dirs.data, url.as_deref()).await
}

/// The registry file fetched last time.
#[tauri::command]
pub fn acp_registry_cached(state: State<'_, AppState>) -> Option<String> {
    acp_agents::cached_registry(&state.dirs.data)
}

/// An agent's icon as SVG text (cached for a week).
#[tauri::command]
pub async fn acp_registry_icon(
    state: State<'_, AppState>,
    id: String,
    url: String,
) -> Result<Option<String>> {
    acp_agents::fetch_icon(&state.dirs.data, &id, &url).await
}

/// Downloads and unpacks a binary agent, streaming progress to `on_progress`.
#[tauri::command]
pub async fn acp_agent_install(
    state: State<'_, AppState>,
    request: InstallRequest,
    on_progress: Channel<Progress>,
) -> Result<Installed> {
    acp_agents::install(&state.dirs.data, request, move |p| {
        let _ = on_progress.send(p);
    })
    .await
}

/// Stops an install under way.
#[tauri::command]
pub fn acp_agent_cancel(id: String) -> bool {
    acp_agents::cancel(&id)
}

/// Deletes a downloaded agent's folder.
#[tauri::command]
pub async fn acp_agent_remove(state: State<'_, AppState>, id: String) -> Result<bool> {
    let data = state.dirs.data.clone();
    tauri::async_runtime::spawn_blocking(move || acp_agents::remove(&data, &id))
        .await
        .map_err(|e| crate::error::Error::Invalid(e.to_string()))?
}

/// The agents downloaded here.
#[tauri::command]
pub fn acp_agents_on_disk(state: State<'_, AppState>) -> Vec<OnDisk> {
    acp_agents::on_disk(&state.dirs.data)
}
