//! Desktop control for the agent's `computer` tool (D353, `crate::desktop`). The webview decides
//! what is allowed (the setting, the per-app grants); these only act. Blocking work (capture,
//! input with its small pauses) runs off the async runtime.

use crate::desktop::{self, InputOp, Monitor, WindowInfo};
use crate::error::{Error, Result};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    pub supported: bool,
    pub monitors: Vec<Monitor>,
    /// The virtual desktop (all monitors): x, y, width, height in physical pixels.
    pub desktop: (i32, i32, i32, i32),
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| Error::Invalid(e.to_string()))?
}

#[tauri::command]
pub async fn desktop_info() -> Result<DesktopInfo> {
    if !desktop::supported() {
        return Ok(DesktopInfo {
            supported: false,
            monitors: Vec::new(),
            desktop: (0, 0, 0, 0),
        });
    }
    Ok(DesktopInfo {
        supported: true,
        monitors: desktop::monitors()?,
        desktop: desktop::desktop(),
    })
}

/// An area of the desktop scaled to `out_w`×`out_h`: an 8-byte header then BGRA rows.
#[tauri::command]
pub async fn desktop_capture(
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    out_w: i32,
    out_h: i32,
) -> Result<tauri::ipc::Response> {
    let bytes = blocking(move || desktop::capture(x, y, w, h, out_w, out_h)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The app whose window is at the point, or in front without one.
#[tauri::command]
pub async fn desktop_window_at(x: Option<i32>, y: Option<i32>) -> Result<Option<WindowInfo>> {
    let point = x.zip(y);
    blocking(move || desktop::window_at(point)).await
}

#[tauri::command]
pub async fn desktop_input(op: InputOp) -> Result<()> {
    blocking(move || desktop::input(&op)).await
}

/// Shows the always-on-top banner with `text`, or hides it (no text).
#[tauri::command]
pub async fn desktop_banner(text: Option<String>) -> Result<()> {
    blocking(move || {
        desktop::banner(text.as_deref());
        Ok(())
    })
    .await
}

/// Whether the user pressed Esc or the banner's Stop since the last call.
#[tauri::command]
pub async fn desktop_take_stop() -> Result<bool> {
    Ok(desktop::take_stop())
}
