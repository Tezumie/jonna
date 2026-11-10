//! Trusted input for the built-in browser (D346): pointer and keyboard events sent through the
//! webview's own DevTools protocol, in process (WebView2's `CallDevToolsProtocolMethod`), so the
//! page sees `isTrusted` events as from a person. No debugging port is opened: only this process
//! can call it, and only the `Input.*` methods below. The IDE (TypeScript) decides where a point
//! lands and checks the page's frame is what's there before it calls. Windows only: WebKit has no
//! such entry point, so elsewhere the call fails and the IDE falls back to the bridge's
//! synthesized events.

use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};

/// The only protocol methods this entry point passes on: input, nothing that reads or changes
/// anything else of a webview (the IDE's own page included).
const ALLOWED: &[&str] = &[
    "Input.dispatchMouseEvent",
    "Input.dispatchKeyEvent",
    "Input.insertText",
];

/// Whether `method` may be sent.
pub fn allowed(method: &str) -> bool {
    ALLOWED.contains(&method)
}

/// Sends one `Input.*` call to webview `label` and returns the protocol's answer (JSON).
pub async fn call(
    app: &AppHandle,
    label: &str,
    method: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value> {
    if !allowed(method) {
        return Err(Error::Invalid(format!("{method} isn't an input method")));
    }
    if !params.is_object() {
        return Err(Error::Invalid("params must be an object".into()));
    }
    let webview = app
        .get_webview(label)
        .ok_or_else(|| Error::Invalid(format!("no webview {label}")))?;
    let (tx, rx) = tokio::sync::oneshot::channel::<std::result::Result<String, String>>();
    let method = method.to_string();
    let params = params.to_string();
    webview
        .with_webview(move |platform| platform_call(platform, method, params, tx))
        .map_err(|e| Error::Invalid(format!("couldn't reach the webview: {e}")))?;
    let text = tokio::time::timeout(std::time::Duration::from_secs(10), rx)
        .await
        .map_err(|_| Error::Invalid("the input call timed out".into()))?
        .map_err(|_| Error::Invalid("the input call was dropped".into()))?
        .map_err(Error::Invalid)?;
    if text.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    Ok(serde_json::from_str(&text)?)
}

type Reply = tokio::sync::oneshot::Sender<std::result::Result<String, String>>;

#[cfg(windows)]
fn platform_call(
    platform: tauri::webview::PlatformWebview,
    method: String,
    params: String,
    tx: Reply,
) {
    use std::sync::{Arc, Mutex};
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::HSTRING;

    // Answered exactly once: by the completion handler, or here if the call itself failed.
    let reply = Arc::new(Mutex::new(Some(tx)));
    let answer = |reply: &Arc<Mutex<Option<Reply>>>, value: std::result::Result<String, String>| {
        if let Some(tx) = reply.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = tx.send(value);
        }
    };
    let handler_reply = reply.clone();
    let run = || -> windows::core::Result<()> {
        // SAFETY: WebView2 COM calls on the UI thread (with_webview runs there, and so does the
        // completion handler); the handler is a reference-counted COM object WebView2 keeps
        // until it has called it.
        unsafe {
            let webview = platform.controller().CoreWebView2()?;
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |result, json| {
                    answer(
                        &handler_reply,
                        result.map(|_| json).map_err(|e| e.message()),
                    );
                    Ok(())
                },
            ));
            webview.CallDevToolsProtocolMethod(
                &HSTRING::from(method),
                &HSTRING::from(params),
                &handler,
            )
        }
    };
    if let Err(e) = run() {
        answer(&reply, Err(e.message()));
    }
}

#[cfg(not(windows))]
fn platform_call(
    _platform: tauri::webview::PlatformWebview,
    _method: String,
    _params: String,
    tx: Reply,
) {
    let _ = tx.send(Err("trusted input needs WebView2 (Windows)".into()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_input_methods_pass() {
        assert!(allowed("Input.dispatchMouseEvent"));
        assert!(allowed("Input.dispatchKeyEvent"));
        assert!(allowed("Input.insertText"));
        assert!(!allowed("Runtime.evaluate"));
        assert!(!allowed("Page.navigate"));
        assert!(!allowed("Input.setInterceptDrags"));
        assert!(!allowed("input.dispatchMouseEvent"));
    }
}
