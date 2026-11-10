//! Browser previews (crate::browser): proxies for local dev servers and workspace folders,
//! external windows with the bridge, sites shown inside a tab (embed) and downloads.

use tauri::{AppHandle, State, Webview};

use crate::browser::netlog::BrowserEvent;
use crate::browser::{self, ProxyInfo, WINDOW_PREFIX};
use crate::error::{Error, Result};
use crate::AppState;

/// Starts (or reuses) the preview proxy for a local dev server URL (`http://localhost:5173`) or a
/// workspace folder (an absolute path).
#[tauri::command]
pub async fn browser_proxy(state: State<'_, AppState>, target: String) -> Result<ProxyInfo> {
    let target = if target.starts_with("http://") || target.starts_with("https://") {
        browser::local_target(&target)?
    } else {
        let root = state.workspace.resolve(&target)?;
        if !root.is_dir() {
            return Err(Error::Invalid(format!("{target} is not a folder")));
        }
        browser::static_target(root)
    };
    state.browser.proxy(target).await
}

#[tauri::command]
pub async fn browser_proxy_stop_all(state: State<'_, AppState>) -> Result<()> {
    state.browser.stop_all();
    Ok(())
}

/// Opens an http(s) page in its own window with the bridge; returns the window label. `popup`:
/// another tab's `window.open` asked for it (its bridge gets a relaying `window.opener`).
#[tauri::command]
pub async fn browser_window_open(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
    title: String,
    popup: Option<bool>,
    name: Option<String>,
) -> Result<String> {
    state
        .browser
        .open_window(&app, &url, &title, popup.unwrap_or(false), name.as_deref())
}

/// Shows an http(s) page in a webview over a browser tab's page area (`browser.embedSites`):
/// `host` is the IDE window that shows the tab ("main" or an auxiliary window), `bounds` the
/// area in physical pixels. Returns the webview's label (used like a site window's).
#[tauri::command]
pub async fn browser_embed_open(
    app: AppHandle,
    state: State<'_, AppState>,
    host: String,
    url: String,
    bounds: browser::embed::Bounds,
    popup: Option<bool>,
    name: Option<String>,
) -> Result<String> {
    state
        .browser
        .open_embedded(
            &app,
            &host,
            &url,
            popup.unwrap_or(false),
            name.as_deref(),
            bounds,
        )
        .await
}

/// Places a tab's site webview (bounds in physical pixels, shown or hidden, page zoom).
#[tauri::command]
pub async fn browser_embed_place(
    app: AppHandle,
    label: String,
    host: String,
    bounds: browser::embed::Bounds,
    visible: bool,
    zoom: Option<f64>,
) -> Result<()> {
    browser::embed::place(&app, &label, &host, bounds, visible, zoom.unwrap_or(1.0))
}

/// Gives the keyboard to a tab's site webview.
#[tauri::command]
pub async fn browser_embed_focus(app: AppHandle, label: String) -> Result<()> {
    browser::embed::focus(&app, &label)
}

/// Sends a call to the bridge in an external window.
#[tauri::command]
pub async fn browser_window_send(
    app: AppHandle,
    label: String,
    message: serde_json::Value,
) -> Result<()> {
    browser::send_to_window(&app, &label, &message)
}

/// Closes a site's window, or its webview inside a tab.
#[tauri::command]
pub async fn browser_window_close(app: AppHandle, label: String) -> Result<()> {
    browser::embed::close(&app, &label)
}

/// The IDE's stream of browser events: network log entries, external windows' bridge reports,
/// window closes.
#[tauri::command]
pub async fn browser_subscribe(
    state: State<'_, AppState>,
    channel: tauri::ipc::Channel<BrowserEvent>,
) -> Result<()> {
    state.browser.shared.log.subscribe(channel);
    Ok(())
}

/// From the bridge in an external window (the only command those pages may call): forwarded to
/// the IDE's browser Channel. Page data, untrusted.
#[tauri::command]
pub async fn browser_bridge_post(
    state: State<'_, AppState>,
    webview: Webview,
    message: serde_json::Value,
) -> Result<()> {
    let label = webview.label().to_string();
    if !label.starts_with(WINDOW_PREFIX) {
        return Err(Error::Invalid("not a browser window".into()));
    }
    state
        .browser
        .shared
        .log
        .send(BrowserEvent::Bridge { label, message });
    Ok(())
}

/// The downloads list (previews, site windows, sites inside tabs).
#[tauri::command]
pub async fn browser_downloads(
    state: State<'_, AppState>,
) -> Result<Vec<browser::downloads::Download>> {
    Ok(state.browser.shared.downloads.list())
}

/// Cancels a running download (Windows only; elsewhere an error says so).
#[tauri::command]
pub async fn browser_download_cancel(app: AppHandle, id: u64) -> Result<()> {
    browser::downloads::cancel(&app, id)
}

/// Opens a finished download with the system's program for it.
#[tauri::command]
pub async fn browser_download_open(state: State<'_, AppState>, id: u64) -> Result<()> {
    let path = state.browser.shared.downloads.finished_path(id)?;
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| Error::Invalid(e.to_string()))
}

/// Shows a finished download in the system's file manager.
#[tauri::command]
pub async fn browser_download_reveal(state: State<'_, AppState>, id: u64) -> Result<()> {
    let path = state.browser.shared.downloads.finished_path(id)?;
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| Error::Invalid(e.to_string()))
}

/// Forgets finished downloads (the files stay).
#[tauri::command]
pub async fn browser_downloads_clear(state: State<'_, AppState>) -> Result<()> {
    state.browser.shared.downloads.clear_finished();
    Ok(())
}

/// A logged request's body ("request" or "response"), as raw bytes.
#[tauri::command]
pub async fn browser_network_body(
    state: State<'_, AppState>,
    id: u64,
    which: String,
) -> Result<tauri::ipc::Response> {
    let bytes = state
        .browser
        .shared
        .log
        .body(id, &which)
        .ok_or_else(|| Error::Invalid("that body isn't kept (too old or too large)".into()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The bridge's script (D341): the IDE installs it, over the DevTools protocol, in a page of the
/// user's own Chrome or Edge that the browser tools act on. Only the IDE's own source.
#[tauri::command]
pub fn browser_bridge_source() -> String {
    browser::proxy::BRIDGE_JS.to_string()
}

/// Trusted input for a browser tab's page (D346): one `Input.*` DevTools protocol call into
/// webview `label` (the IDE's own, whose frame shows the page, or a site's), in process. The IDE
/// checks that the point is on the page's frame before it calls.
#[tauri::command]
pub async fn browser_trusted_input(
    app: AppHandle,
    label: String,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value> {
    if label != "main"
        && !label.starts_with(WINDOW_PREFIX)
        && !label.starts_with(crate::aux_window::AUX_PREFIX)
    {
        return Err(Error::Invalid(format!("{label} is not an IDE webview")));
    }
    browser::trusted_input::call(&app, &label, &method, &params).await
}

/// "Disable cache" for previews (conditional requests dropped, responses no-store).
#[tauri::command]
pub async fn browser_set_no_cache(state: State<'_, AppState>, on: bool) -> Result<()> {
    state
        .browser
        .shared
        .log
        .no_cache
        .store(on, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// Unsaved editor text for a workspace file, served by static previews instead of the file on
/// disk (`text: null` removes it: the file is the truth again). Either way previews open in an
/// outside browser hear of the change (D284).
#[tauri::command]
pub async fn browser_overlay(
    state: State<'_, AppState>,
    path: String,
    text: Option<String>,
) -> Result<()> {
    let resolved = state.workspace.resolve(&path)?;
    let canonical = std::fs::canonicalize(&resolved).unwrap_or(resolved);
    let mut overlays = state
        .browser
        .shared
        .overlays
        .lock()
        .map_err(|_| Error::Invalid("lock poisoned".into()))?;
    match text {
        Some(t) => {
            overlays.insert(canonical, t.into_bytes());
        }
        None => {
            overlays.remove(&canonical);
        }
    }
    drop(overlays);
    // Typed or saved: previews open in an outside browser reload (D284).
    state.browser.shared.bump_live();
    Ok(())
}

/// Whether something listens on a local port (server detection confirms printed addresses).
#[tauri::command]
pub async fn net_port_open(port: u16) -> Result<bool> {
    use std::time::Duration;
    use tokio::net::TcpStream;
    for host in ["127.0.0.1", "::1"] {
        let attempt =
            tokio::time::timeout(Duration::from_millis(400), TcpStream::connect((host, port)))
                .await;
        if matches!(attempt, Ok(Ok(_))) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// A PNG of a window as it is on screen: the IDE ("main", with its browser tabs) or a browser
/// window. Returned as raw bytes.
#[tauri::command]
pub async fn screenshot_window(
    app: AppHandle,
    label: Option<String>,
) -> Result<tauri::ipc::Response> {
    let label = label.unwrap_or_else(|| "main".into());
    if label != "main"
        && !label.starts_with(WINDOW_PREFIX)
        && !label.starts_with(crate::aux_window::AUX_PREFIX)
    {
        return Err(Error::Invalid(format!("{label} is not an IDE window")));
    }
    Ok(tauri::ipc::Response::new(
        crate::screenshot::capture(&app, &label).await?,
    ))
}

/// The label of the auxiliary window opened last (to screenshot or focus it).
#[tauri::command]
pub async fn aux_window_label() -> Result<Option<String>> {
    Ok(crate::aux_window::latest())
}

/// Closes an auxiliary window (script `window.close()` doesn't on every engine).
#[tauri::command]
pub async fn aux_window_close(app: AppHandle, label: String) -> Result<()> {
    use tauri::Manager;
    if !label.starts_with(crate::aux_window::AUX_PREFIX) {
        return Err(Error::Invalid("not an auxiliary window".into()));
    }
    // The window, not the webview window: a site shown inside a tab there is a second webview.
    if let Some(w) = app.get_window(&label) {
        w.close().map_err(|e| Error::Invalid(e.to_string()))?;
    }
    Ok(())
}
