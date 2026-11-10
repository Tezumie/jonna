//! Agent commands: model providers (keys stay on this side) and sessions/checkpoints in app data.

use crate::agent::{FileSnapshot, SessionSummary};
use crate::ai::{secrets, ChatEvent, ChatRequest, ModelDetails, ModelInfo, Provider};
use crate::error::Result;
use crate::{agent, AppState};
use tauri::ipc::Channel;
use tauri::State;

// Model provider commands (`crate::ai`). Keys are stored and read on this side only.
fn key(state: &AppState, provider: &Provider) -> Option<String> {
    secrets::get(&state.dirs.data.join("secrets.json"), &provider.id)
}

#[tauri::command]
pub async fn ai_list_models(
    state: State<'_, AppState>,
    provider: Provider,
) -> Result<Vec<ModelInfo>> {
    let key = key(&state, &provider);
    state.ai.list_models(&provider, key).await
}

#[tauri::command]
pub async fn ai_model_details(
    state: State<'_, AppState>,
    provider: Provider,
    model: String,
) -> Result<ModelDetails> {
    let key = key(&state, &provider);
    state.ai.model_details(&provider, &model, key).await
}

/// Streams a chat completion to `on_event`; resolves when it's finished (or fails / is cancelled).
#[tauri::command]
pub async fn ai_chat(
    state: State<'_, AppState>,
    webview: tauri::Webview,
    request_id: String,
    request: ChatRequest,
    on_event: Channel<ChatEvent>,
) -> Result<()> {
    let key = key(&state, &request.provider);
    state
        .ai
        .chat(&request_id, webview.label(), request, key, move |event| {
            let _ = on_event.send(event);
        })
        .await
}

/// An image from a provider's images API (OpenAI's `gpt-image`, D381): `[{ mime, data }]`, the
/// data as base64.
#[tauri::command]
pub async fn ai_image_generate(
    state: State<'_, AppState>,
    webview: tauri::Webview,
    request_id: String,
    request: crate::ai::ImageRequest,
) -> Result<Vec<serde_json::Value>> {
    let key = key(&state, &request.provider);
    let images = state
        .ai
        .generate_image(&request_id, webview.label(), request, key)
        .await?;
    Ok(images
        .into_iter()
        .map(|(mime, data)| serde_json::json!({ "mime": mime, "data": data }))
        .collect())
}

/// One fill-in-the-middle completion for suggestions as you type (D204); `supported: false` when
/// the provider or model has no FIM endpoint.
#[tauri::command]
pub async fn ai_fim(
    state: State<'_, AppState>,
    webview: tauri::Webview,
    request_id: String,
    request: crate::ai::fim::FimRequest,
) -> Result<crate::ai::fim::FimReply> {
    let key = key(&state, &request.provider);
    state
        .ai
        .fim(&request_id, webview.label(), request, key)
        .await
}

/// Fetches a web page (http/https, redirects followed, at most `max_bytes`) for agent context.
#[tauri::command]
pub async fn web_fetch(
    state: State<'_, AppState>,
    url: String,
    max_bytes: Option<usize>,
) -> Result<crate::ai::web::WebPage> {
    let client = state.ai.client();
    crate::ai::web::fetch(
        &client,
        &url,
        max_bytes.unwrap_or(crate::ai::web::MAX_BYTES),
    )
    .await
}

/// Searches the web with `provider` (brave, tavily, exa or searxng). The provider's key is read
/// from the secrets file here (`websearch.<provider>`); SearXNG takes its address instead.
#[tauri::command]
pub async fn web_search(
    state: State<'_, AppState>,
    provider: String,
    query: String,
    count: Option<usize>,
    searxng_url: Option<String>,
    // Domains and depth (D320); absent: none, the standard search.
    options: Option<crate::ai::search::SearchOptions>,
) -> Result<Vec<crate::ai::search::SearchResult>> {
    use crate::ai::search;
    let key = if search::needs_key(&provider) {
        secrets::get(
            &state.dirs.data.join("secrets.json"),
            &search::key_id(&provider),
        )
    } else {
        None
    };
    search::search(
        &state.ai.client(),
        &provider,
        &query,
        count.unwrap_or(8),
        key,
        searxng_url.as_deref(),
        &options.unwrap_or_default(),
    )
    .await
}

/// Speech to text for the agent's voice input (D180): base64 audio from the page, sent to the
/// provider's OpenAI-compatible `/audio/transcriptions` with its key (which stays here).
#[tauri::command]
pub async fn ai_transcribe(
    state: State<'_, AppState>,
    provider: Provider,
    model: String,
    audio: String,
    mime: String,
    language: Option<String>,
) -> Result<String> {
    let key = key(&state, &provider);
    let bytes = crate::ai::transcribe::decode_base64(&audio)?;
    crate::ai::transcribe::transcribe(
        &state.ai.client(),
        &provider.base_url,
        key,
        &model,
        &bytes,
        &mime,
        language.as_deref(),
    )
    .await
}

/// Embeddings for the codebase index (D227): the provider's `/embeddings`, with its key.
#[tauri::command]
pub async fn ai_embed(
    state: State<'_, AppState>,
    provider: Provider,
    model: String,
    inputs: Vec<String>,
) -> Result<Vec<Vec<f32>>> {
    let key = key(&state, &provider);
    crate::ai::embed::embed(&state.ai.client(), &provider, key, &model, &inputs).await
}

#[tauri::command]
pub async fn ai_cancel(state: State<'_, AppState>, request_id: String) -> Result<()> {
    state.ai.cancel(&request_id)
}

/// Stores (or with `null`, removes) the API key for provider `id`.
#[tauri::command]
pub async fn ai_set_key(state: State<'_, AppState>, id: String, key: Option<String>) -> Result<()> {
    secrets::set(&state.dirs.data.join("secrets.json"), &id, key.as_deref())
}

#[tauri::command]
pub async fn ai_has_key(state: State<'_, AppState>, id: String) -> Result<bool> {
    Ok(secrets::has(&state.dirs.data.join("secrets.json"), &id))
}

/// What a provider has said about its limits (D201): the rate-limit headers of its last
/// response this run, and for OpenRouter the key's credits (one GET of `/key`).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLimits {
    pub rate: Option<crate::ai::limits::RateLimits>,
    pub credits: Option<crate::ai::limits::Credits>,
    /// Why the credits couldn't be read (the key endpoint failed).
    pub credits_error: Option<String>,
}

/// The rate limits every provider reported this run, by provider id (no network).
#[tauri::command]
pub async fn ai_rate_limits(
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, crate::ai::limits::RateLimits>> {
    Ok(state.ai.rate_limits())
}

/// One provider's limits; OpenRouter's credits are fetched with its key (kept on this side).
#[tauri::command]
pub async fn ai_provider_limits(
    state: State<'_, AppState>,
    provider: Provider,
) -> Result<ProviderLimits> {
    let rate = state.ai.rate_limits().remove(&provider.id);
    let (credits, credits_error) = if crate::ai::limits::is_openrouter(&provider.base_url) {
        match crate::ai::limits::openrouter_credits(
            &state.ai.client(),
            &provider.base_url,
            key(&state, &provider),
        )
        .await
        {
            Ok(c) => (c, None),
            Err(e) => (None, Some(e.to_string())),
        }
    } else {
        (None, None)
    };
    Ok(ProviderLimits {
        rate,
        credits,
        credits_error,
    })
}

// The usage log in app data (`crate::agent::usage`, D201): local only, never sent anywhere.
#[tauri::command]
pub async fn usage_append(
    state: State<'_, AppState>,
    records: Vec<serde_json::Value>,
) -> Result<()> {
    agent::usage::append(&state.dirs.data, &records, crate::ai::limits::now_ms())
}

#[tauri::command]
pub async fn usage_load(state: State<'_, AppState>, since: u64) -> Result<Vec<serde_json::Value>> {
    agent::usage::load(&state.dirs.data, since, crate::ai::limits::now_ms())
}

#[tauri::command]
pub async fn usage_clear(state: State<'_, AppState>) -> Result<usize> {
    agent::usage::clear(&state.dirs.data)
}

// A chat's private folder with no folder open (`crate::agent::scratch`, D208): an external agent
// runs there, and its file requests reach nothing outside it.
#[tauri::command]
pub async fn agent_scratch_dir(state: State<'_, AppState>, session: String) -> Result<String> {
    Ok(agent::scratch::dir(&state.dirs.data, &session)?
        .to_string_lossy()
        .into_owned())
}

#[tauri::command]
pub async fn agent_scratch_read(
    state: State<'_, AppState>,
    root: String,
    path: String,
) -> Result<String> {
    agent::scratch::read(&state.dirs.data, &root, &path)
}

#[tauri::command]
pub async fn agent_scratch_write(
    state: State<'_, AppState>,
    root: String,
    path: String,
    content: String,
) -> Result<()> {
    agent::scratch::write(&state.dirs.data, &root, &path, &content)
}

// Worktree agents' setup and comparison (`crate::agent::worktree`, D204): only on a worktree of
// the open repository.
#[tauri::command]
pub async fn agent_worktree_copy(
    state: State<'_, AppState>,
    path: String,
    files: Vec<String>,
) -> Result<Vec<String>> {
    let root = state.git.at(None)?.root;
    tauri::async_runtime::spawn_blocking(move || {
        let wt = agent::worktree::check(&root, &path)?;
        agent::worktree::copy_files(&root, &wt, &files)
    })
    .await
    .map_err(|e| crate::error::Error::Invalid(format!("copy failed: {e}")))?
}

/// Runs the project's setup script in a new worktree (the agent's shell, like run_command);
/// output on `on_output`, cancellable with exec_cancel(id). `env` is the worktree's PORT and
/// WORKTREE_* (D207), the same names a worktree's window may be given.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn agent_worktree_run(
    state: State<'_, AppState>,
    webview: tauri::Webview,
    path: String,
    command: String,
    id: String,
    timeout_ms: Option<u64>,
    env: Option<std::collections::HashMap<String, String>>,
    on_output: tauri::ipc::Channel<String>,
) -> Result<crate::exec::ExecResult> {
    let mut vars: Vec<(String, String)> = Vec::new();
    for (name, value) in env.unwrap_or_default() {
        if !crate::ipc::app::new_window_env_allowed(&name) {
            return Err(crate::error::Error::Invalid(format!(
                "not an environment variable a setup script may get: {name}"
            )));
        }
        vars.push((name, value));
    }
    let root = state.git.at(None)?.root;
    let wt = {
        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || agent::worktree::check(&root, &path))
            .await
            .map_err(|e| crate::error::Error::Invalid(format!("{e}")))??
    };
    let exec = state.exec.clone();
    exec.set_owner(&id, webview.label());
    let timeout =
        std::time::Duration::from_millis(timeout_ms.unwrap_or(600_000).clamp(1_000, 3_600_000));
    tauri::async_runtime::spawn_blocking(move || {
        let sink = on_output.clone();
        let result = exec.run_with_env(&id, &command, &wt, timeout, &vars, move |chunk| {
            let _ = sink.send(chunk);
        });
        let _ = on_output.send(crate::ipc::process::EXEC_END.to_string());
        result
    })
    .await
    .map_err(|e| crate::error::Error::Exec(format!("setup failed: {e}")))?
}

#[tauri::command]
pub async fn agent_worktree_diff(
    state: State<'_, AppState>,
    path: String,
    base: String,
    max: Option<usize>,
) -> Result<agent::worktree::WorktreeDiff> {
    let root = state.git.at(None)?.root;
    tauri::async_runtime::spawn_blocking(move || {
        let wt = agent::worktree::check(&root, &path)?;
        agent::worktree::diff(&wt, &base, max.unwrap_or(400_000).min(4_000_000))
    })
    .await
    .map_err(|e| crate::error::Error::Invalid(format!("diff failed: {e}")))?
}

/// Applies a worktree's changes to the open folder (staged; conflicts marked and listed).
#[tauri::command]
pub async fn agent_worktree_apply(
    state: State<'_, AppState>,
    path: String,
    base: String,
) -> Result<agent::worktree::Applied> {
    let root = state.git.at(None)?.root;
    tauri::async_runtime::spawn_blocking(move || {
        let wt = agent::worktree::check(&root, &path)?;
        agent::worktree::apply(&root, &wt, &base)
    })
    .await
    .map_err(|e| crate::error::Error::Invalid(format!("apply failed: {e}")))?
}

// Documentation indexes for @docs (`crate::agent::docs`, D204).
#[tauri::command]
pub async fn docs_index_save(state: State<'_, AppState>, name: String, json: String) -> Result<()> {
    agent::docs::save(&state.dirs.data, &name, &json)
}

#[tauri::command]
pub async fn docs_index_load(state: State<'_, AppState>, name: String) -> Result<Option<String>> {
    agent::docs::load(&state.dirs.data, &name)
}

#[tauri::command]
pub async fn docs_index_delete(state: State<'_, AppState>, name: String) -> Result<()> {
    agent::docs::delete(&state.dirs.data, &name)
}

// Agent sessions and checkpoints in app data (`crate::agent`).
#[tauri::command]
pub async fn agent_session_save(
    state: State<'_, AppState>,
    id: String,
    json: String,
    expect: Option<String>,
) -> Result<agent::SaveOutcome> {
    agent::save_session_if(&state.dirs.data, &id, &json, expect.as_deref())
}

/// The saved transcript's version (modified time and size; None when there's none), D221.
#[tauri::command]
pub async fn agent_session_version(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<String>> {
    agent::session_version(&state.dirs.data, &id)
}

#[tauri::command]
pub async fn agent_session_load(state: State<'_, AppState>, id: String) -> Result<Option<String>> {
    agent::load_session(&state.dirs.data, &id)
}

/// Per chat id, a stamp that changes whenever the chat is saved (size and time), or null (D222).
#[tauri::command]
pub async fn agent_session_stamps(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<Vec<Option<String>>> {
    Ok(agent::session_stamps(&state.dirs.data, &ids))
}

/// A helper's report for a chat not open in the window that started it (D233): kept for
/// whichever window opens that chat.
#[tauri::command]
pub async fn agent_report_put(
    state: State<'_, AppState>,
    id: String,
    chat: String,
    text: String,
) -> Result<()> {
    agent::reports::put(&state.dirs.data, &id, &chat, &text)
}

/// The helper reports waiting for their chats (id, chat, when), without their text (D233).
#[tauri::command]
pub async fn agent_report_list(
    state: State<'_, AppState>,
) -> Result<Vec<agent::reports::PendingEntry>> {
    agent::reports::list(&state.dirs.data)
}

/// Takes a waiting report (its text), or null when another window took it first (D233).
#[tauri::command]
pub async fn agent_report_claim(state: State<'_, AppState>, id: String) -> Result<Option<String>> {
    agent::reports::claim(&state.dirs.data, &id)
}

/// Watches the saved chats' folder (D233): a batch names the chats another window (or this one)
/// saved, so the worktree overview reads them when they change instead of on a timer.
#[tauri::command]
pub async fn agent_sessions_watch(
    state: State<'_, AppState>,
    on_batch: tauri::ipc::Channel<crate::watch::WatchBatch>,
) -> Result<()> {
    let dir = agent::sessions_dir(&state.dirs.data);
    std::fs::create_dir_all(&dir)?;
    state.agent_sessions_watcher.start(on_batch)?;
    state.agent_sessions_watcher.set_dirs(vec![dir])
}

/// Stops watching the saved chats (no page needs it).
#[tauri::command]
pub async fn agent_sessions_unwatch(state: State<'_, AppState>) -> Result<()> {
    state.agent_sessions_watcher.stop()
}

/// A documentation page that needs JavaScript, loaded in a hidden window and read once it
/// settles (D233, @docs with agent.docs.renderJavaScript). Null when it didn't answer in time.
#[tauri::command]
pub async fn docs_render(
    app: tauri::AppHandle,
    url: String,
    timeout_ms: Option<u64>,
) -> Result<Option<agent::render::Rendered>> {
    agent::render::render(&app, &url, timeout_ms.unwrap_or(20_000)).await
}

/// From the hidden window's script (the only command such windows may call): the page's text.
/// Page data, untrusted.
#[tauri::command]
pub async fn docs_render_post(
    webview: tauri::Webview,
    url: String,
    title: String,
    text: String,
) -> Result<()> {
    agent::render::post(
        webview.label(),
        agent::render::Rendered { url, title, text },
    )
}

/// The files of an external agent's folder with their size and time (D233: its changes without
/// git). Only a workspace folder (or a folder in one) or a chat's private folder; `.gitignore`d
/// files, dependency and build folders are left out; at most `max` files (50 000).
#[tauri::command]
pub async fn agent_tree_stats(
    state: State<'_, AppState>,
    root: String,
    max: Option<usize>,
) -> Result<agent::tree::TreeStats> {
    let requested = std::path::Path::new(&root);
    // A network path is refused before it's touched (D161), unless the workspace is on one.
    let network_workspace = state
        .workspace
        .all_folders()
        .iter()
        .any(|f| crate::fs::is_unc(&f.to_string_lossy()));
    if crate::fs::is_unc(&root) && !network_workspace {
        return Err(crate::error::Error::OutsideScope(root));
    }
    let real = crate::store::simplify(std::fs::canonicalize(requested)?);
    // Any folder of the workspace (a multi-root workspace's other folders too).
    let in_workspace = state.workspace.all_folders().iter().any(|f| {
        std::fs::canonicalize(f)
            .map(crate::store::simplify)
            .is_ok_and(|f| real.starts_with(&f))
    });
    let in_scratch = agent::scratch::within(&state.dirs.data, requested).is_some();
    if !in_workspace && !in_scratch {
        return Err(crate::error::Error::OutsideScope(root));
    }
    let max = max.unwrap_or(20_000);
    tokio::task::spawn_blocking(move || agent::tree::stats(&real, max))
        .await
        .map_err(|e| crate::error::Error::Invalid(e.to_string()))
}

#[tauri::command]
pub async fn agent_session_list(state: State<'_, AppState>) -> Result<Vec<SessionSummary>> {
    agent::list_sessions(&state.dirs.data)
}

/// Keeps a chat's image whole (D381), base64 in.
#[tauri::command]
pub async fn agent_media_put(
    state: State<'_, AppState>,
    chat: String,
    image: String,
    data: String,
) -> Result<()> {
    agent::media_put(&state.dirs.data, &chat, &image, &data)
}

/// A chat's image, base64, or null when it isn't kept.
#[tauri::command]
pub async fn agent_media_get(
    state: State<'_, AppState>,
    chat: String,
    image: String,
) -> Result<Option<String>> {
    agent::media_get(&state.dirs.data, &chat, &image)
}

#[tauri::command]
pub async fn agent_session_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    agent::delete_session(&state.dirs.data, &id)
}

#[tauri::command]
pub async fn agent_checkpoint_add(
    state: State<'_, AppState>,
    session: String,
    turn: u32,
    files: Vec<FileSnapshot>,
) -> Result<()> {
    agent::checkpoint_add(&state.dirs.data, &session, turn, files)
}

#[tauri::command]
pub async fn agent_checkpoint_load(
    state: State<'_, AppState>,
    session: String,
    turn: u32,
) -> Result<Vec<FileSnapshot>> {
    agent::checkpoint_load(&state.dirs.data, &session, turn)
}

/// A file the user picked or dropped, to attach to an agent message (D131).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutsideFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
}

fn outside_files(paths: &[std::path::PathBuf]) -> Vec<OutsideFile> {
    paths
        .iter()
        .filter_map(|p| {
            let meta = std::fs::metadata(p).ok()?;
            Some(OutsideFile {
                name: p.file_name()?.to_string_lossy().into_owned(),
                path: p.to_string_lossy().into_owned(),
                size: meta.len(),
                is_dir: meta.is_dir(),
            })
        })
        .collect()
}

/// Picks files to attach with the system dialog (anywhere on disk: the user chose them). They
/// become the "dropped" files, read with `dropped_read`. None if cancelled. Debug builds (UI
/// tests) may pass `paths` instead.
#[tauri::command]
pub async fn attach_pick(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    paths: Option<Vec<String>>,
) -> Result<Option<Vec<OutsideFile>>> {
    use tauri_plugin_dialog::DialogExt;
    let picked: Vec<std::path::PathBuf> = match paths.filter(|_| cfg!(debug_assertions)) {
        Some(p) => p.into_iter().map(std::path::PathBuf::from).collect(),
        None => {
            let files = tauri::async_runtime::spawn_blocking(move || {
                app.dialog()
                    .file()
                    .set_title("Attach files")
                    .blocking_pick_files()
            })
            .await
            .map_err(|e| crate::error::Error::Invalid(e.to_string()))?;
            let Some(files) = files else {
                return Ok(None);
            };
            files
                .into_iter()
                .filter_map(|f| f.into_path().ok())
                .collect()
        }
    };
    let list = outside_files(&picked);
    *state
        .dropped
        .lock()
        .map_err(|_| crate::error::Error::Invalid("lock poisoned".into()))? = picked;
    Ok(Some(list))
}

/// The files last dropped onto the window from the OS (or picked with `attach_pick`).
#[tauri::command]
pub async fn dropped_list(state: State<'_, AppState>) -> Result<Vec<OutsideFile>> {
    let paths = state
        .dropped
        .lock()
        .map_err(|_| crate::error::Error::Invalid("lock poisoned".into()))?
        .clone();
    Ok(outside_files(&paths))
}

/// Most bytes of one attached file.
const MAX_ATTACH_BYTES: u64 = 20 * 1024 * 1024;

/// Reads one of the dropped / picked files (index into `dropped_list`), raw bytes, capped.
#[tauri::command]
pub async fn dropped_read(
    state: State<'_, AppState>,
    index: usize,
) -> Result<tauri::ipc::Response> {
    let path = state
        .dropped
        .lock()
        .map_err(|_| crate::error::Error::Invalid("lock poisoned".into()))?
        .get(index)
        .cloned()
        .ok_or_else(|| crate::error::Error::Invalid(format!("no dropped file #{index}")))?;
    let meta = std::fs::metadata(&path)?;
    if !meta.is_file() {
        return Err(crate::error::Error::Invalid(format!(
            "{} isn't a file",
            path.display()
        )));
    }
    if meta.len() > MAX_ATTACH_BYTES {
        return Err(crate::error::Error::Invalid(format!(
            "{} is too large to attach ({} MB max)",
            path.display(),
            MAX_ATTACH_BYTES / 1024 / 1024
        )));
    }
    Ok(tauri::ipc::Response::new(std::fs::read(&path)?))
}

/// A monitor's WebSocket (D328): its frames stream to `on_event` until it closes or
/// `lifetime_ms` passes. The monitor tool asked the user before this.
#[tauri::command]
pub async fn agent_monitor_socket_open(
    state: State<'_, AppState>,
    id: String,
    url: String,
    protocols: Vec<String>,
    lifetime_ms: u64,
    on_event: Channel<agent::socket::SocketEvent>,
) -> Result<agent::socket::Opened> {
    state
        .monitor_sockets
        .open(&id, &url, &protocols, lifetime_ms, on_event)
        .await
}

#[tauri::command]
pub async fn agent_monitor_socket_close(state: State<'_, AppState>, id: String) -> Result<()> {
    state.monitor_sockets.close(&id);
    Ok(())
}
