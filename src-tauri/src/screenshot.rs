//! Webview screenshots (agents look at the running IDE or a page; D96). The webview renders
//! itself to a PNG: WebKitGTK's `get_snapshot` on Linux, WebView2's `CapturePreview` on Windows.
//! What is captured is what the window shows — the IDE with its iframes (browser tabs), or an
//! external browser window. macOS isn't supported yet.

use tauri::{AppHandle, Manager};

use crate::error::{Error, Result};

/// PNG bytes of the webview `label` ("main", or a browser window) as it is on screen.
pub async fn capture(app: &AppHandle, label: &str) -> Result<Vec<u8>> {
    // By webview: the IDE's, a site's window, or a site shown inside a browser tab.
    let webview = app
        .get_webview(label)
        .ok_or_else(|| Error::Invalid(format!("no window {label}")))?;
    let (tx, rx) = tokio::sync::oneshot::channel::<std::result::Result<Vec<u8>, String>>();
    webview
        .with_webview(move |platform| platform_capture(platform, tx))
        .map_err(|e| Error::Invalid(format!("couldn't reach the window: {e}")))?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), rx)
        .await
        .map_err(|_| Error::Invalid("the screenshot timed out".into()))?
        .map_err(|_| Error::Invalid("the screenshot was dropped".into()))?;
    result.map_err(|e| Error::Invalid(format!("screenshot failed: {e}")))
}

type Reply = tokio::sync::oneshot::Sender<std::result::Result<Vec<u8>, String>>;

#[cfg(any(
    target_os = "linux",
    target_os = "dragonfly",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd"
))]
fn platform_capture(platform: tauri::webview::PlatformWebview, tx: Reply) {
    use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};
    let view = platform.inner();
    view.snapshot(
        SnapshotRegion::Visible,
        SnapshotOptions::NONE,
        None::<&webkit2gtk::gio::Cancellable>,
        move |result| {
            let png = result.map_err(|e| e.to_string()).and_then(|surface| {
                let image = cairo::ImageSurface::try_from(surface)
                    .map_err(|_| "not an image surface".to_string())?;
                let mut out = Vec::new();
                image.write_to_png(&mut out).map_err(|e| e.to_string())?;
                Ok(out)
            });
            let _ = tx.send(png);
        },
    );
}

#[cfg(windows)]
fn platform_capture(platform: tauri::webview::PlatformWebview, tx: Reply) {
    use std::sync::{Arc, Mutex};
    use webview2_com::{
        CapturePreviewCompletedHandler,
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
    };
    use windows::Win32::System::Com::{STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};
    use windows::Win32::UI::Shell::SHCreateMemStream;

    // Answered exactly once: by the completion handler, or here if the call itself failed.
    let reply = Arc::new(Mutex::new(Some(tx)));
    let answer = |reply: &Arc<Mutex<Option<Reply>>>,
                  value: std::result::Result<Vec<u8>, String>| {
        if let Some(tx) = reply.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = tx.send(value);
        }
    };
    let handler_reply = reply.clone();
    let run = || -> windows::core::Result<()> {
        // SAFETY: WebView2 COM calls on the UI thread (with_webview runs there); the stream and
        // handler are reference-counted COM objects that the closures keep alive.
        unsafe {
            let webview = platform.controller().CoreWebView2()?;
            let stream = SHCreateMemStream(None).ok_or_else(windows::core::Error::from_thread)?;
            let reader = stream.clone();
            let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
                let png = (|| -> windows::core::Result<Vec<u8>> {
                    result?;
                    let mut stat = STATSTG::default();
                    reader.Stat(&mut stat, STATFLAG_NONAME)?;
                    reader.Seek(0, STREAM_SEEK_SET, None)?;
                    let mut bytes = vec![0u8; stat.cbSize as usize];
                    let mut read = 0u32;
                    reader
                        .Read(
                            bytes.as_mut_ptr().cast(),
                            bytes.len() as u32,
                            Some(&mut read),
                        )
                        .ok()?;
                    bytes.truncate(read as usize);
                    Ok(bytes)
                })();
                answer(&handler_reply, png.map_err(|e| e.message()));
                Ok(())
            }));
            webview.CapturePreview(
                COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                &stream,
                &handler,
            )
        }
    };
    if let Err(e) = run() {
        answer(&reply, Err(e.message()));
    }
}

#[cfg(target_os = "macos")]
fn platform_capture(_platform: tauri::webview::PlatformWebview, tx: Reply) {
    let _ = tx.send(Err("screenshots aren't supported on macOS yet".into()));
}
