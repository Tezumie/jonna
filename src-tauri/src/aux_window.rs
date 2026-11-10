//! Auxiliary windows (D101): the IDE moves a tab into a window of its own by calling
//! `window.open("about:blank", …)` from the main webview and filling that document itself, like
//! VS Code's auxiliary windows. The new webview is related to the main one (same process /
//! environment), so the main window's code keeps running the view: agents, commands and
//! DevTools work unchanged. Any other `window.open` from the IDE's own webview is denied.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Runtime, Url, WebviewUrl, WebviewWindowBuilder};

pub const AUX_PREFIX: &str = "aux-";
static COUNTER: AtomicU32 = AtomicU32::new(0);
/// The newest auxiliary window's label (the frontend asks right after opening one).
static LATEST: Mutex<Option<String>> = Mutex::new(None);

pub fn latest() -> Option<String> {
    LATEST.lock().ok().and_then(|l| l.clone())
}

pub fn on_new_window<R: Runtime>(
    app: &AppHandle<R>,
    url: Url,
    features: NewWindowFeatures,
) -> NewWindowResponse<R> {
    if url.as_str() != "about:blank" {
        return NewWindowResponse::Deny;
    }
    let label = format!(
        "{AUX_PREFIX}{}",
        COUNTER.fetch_add(1, Ordering::Relaxed) + 1
    );
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .window_features(features)
        .title(app.config().product_name.clone().unwrap_or_default())
        .min_inner_size(320.0, 240.0)
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        })
        .build();
    match built {
        Ok(window) => {
            crate::dev_icon(&window);
            crate::accelerators::disable_browser_accelerators(&window);
            crate::frame_guard::guard_frames(&window);
            if let Ok(mut latest) = LATEST.lock() {
                *latest = Some(label);
            }
            NewWindowResponse::Create { window }
        }
        Err(e) => {
            eprintln!("couldn't open an auxiliary window: {e}");
            NewWindowResponse::Deny
        }
    }
}

/// Lets the main webview's own code open auxiliary windows without a fresh user gesture (the
/// command runs after awaits). WebKitGTK blocks script-opened windows by default; WebView2
/// asks `on_new_window` either way.
pub fn allow_script_windows<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    ))]
    {
        use tauri::Manager;
        use webkit2gtk::{SettingsExt, WebViewExt};
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.with_webview(|webview| {
                if let Some(settings) = webview.inner().settings() {
                    settings.set_javascript_can_open_windows_automatically(true);
                }
            });
        }
    }
    #[cfg(not(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    )))]
    let _ = app;
}
