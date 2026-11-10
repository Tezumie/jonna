//! WebView2 (Windows) consumes some "browser accelerator" keys itself — Ctrl+Shift+P (an InPrivate
//! window in Edge) never reached the page, so the command palette's key didn't work there.
//! Turning the browser's accelerators off hands every key to the page (D138); the IDE's own
//! keybindings, and `browserDefaults.ts` for the ones nothing claims, decide what they do.
//! Clipboard keys and typing are not accelerators and keep working. Other platforms: nothing to do.

/// Turns WebView2's browser accelerator keys off for `window`'s webview (Windows only).
pub fn disable_browser_accelerators<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    disable_for_webview(window.as_ref());
}

/// The same for any webview (a site shown inside a browser tab, browser/embed.rs).
pub fn disable_for_webview<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    #[cfg(windows)]
    {
        let _ = webview.with_webview(|platform| {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
            use windows::core::Interface;
            // SAFETY: WebView2 COM calls on the UI thread (with_webview runs there); a failure
            // leaves the default behavior (accelerators on).
            unsafe {
                let settings = platform
                    .controller()
                    .CoreWebView2()
                    .and_then(|core| core.Settings());
                if let Ok(settings) = settings {
                    if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
                        let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
                    }
                }
            }
        });
    }
    #[cfg(not(windows))]
    let _ = webview;
}
