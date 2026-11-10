//! Dictation on this computer (D384): the speech models (status, download, remove) and speech to
//! text with one. See `speech/mod.rs`.

use tauri::ipc::{Channel, InvokeBody, Request};
use tauri::State;

use crate::acp_agents::Progress;
use crate::error::{Error, Result};
use crate::speech;
use crate::AppState;

/// Recordings stop by themselves at five minutes (the composer's limit); a little over is allowed.
const MAX_SECONDS: usize = 330;

#[tauri::command]
pub fn speech_status(state: State<'_, AppState>) -> Vec<speech::ModelStatus> {
    speech::status(&state.dirs.data)
}

/// Downloads a model; its path. `url` and `sha256` (test builds only): a local stand-in.
#[tauri::command]
pub async fn speech_install(
    state: State<'_, AppState>,
    model: String,
    url: Option<String>,
    sha256: Option<String>,
    on_progress: Channel<Progress>,
) -> Result<String> {
    let source = speech::source(&model, url.zip(sha256))?;
    speech::install(&state.dirs.data, &model, source, move |p| {
        let _ = on_progress.send(p);
    })
    .await
}

#[tauri::command]
pub fn speech_cancel(model: String) -> bool {
    speech::cancel(&model)
}

#[tauri::command]
pub fn speech_remove(state: State<'_, AppState>, model: String) -> Result<bool> {
    speech::remove(&state.dirs.data, &model)
}

/// Body: 16 kHz mono samples, little-endian f32. Headers: `x-model`, `x-language` (optional).
#[tauri::command]
pub async fn speech_transcribe(state: State<'_, AppState>, request: Request<'_>) -> Result<String> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let model = header("x-model").ok_or_else(|| Error::Invalid("missing x-model header".into()))?;
    let language = header("x-language").unwrap_or_default();
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(Error::Invalid("expected a raw byte body".into()));
    };
    let samples = speech::samples_from(bytes, MAX_SECONDS)?;
    speech::transcribe(&state.dirs.data, &model, samples, language).await
}
