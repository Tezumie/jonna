//! Downloads from browser previews (the tab's frame, site windows and sites shown inside a tab):
//! the IDE's own list with progress, open, show in folder and cancel, instead of the engine's
//! download bubble. Each change goes to the IDE over the browser Channel
//! (`BrowserEvent::Download`).
//!
//! On Windows the WebView2 download operation is followed directly (`DownloadStarting`, marked
//! handled so WebView2 shows no UI of its own): bytes received, total, cancel. Elsewhere Tauri's
//! download hook says only when a download starts and ends, so there is no progress and no cancel.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::netlog::{BrowserEvent, NetLog};
use crate::error::{Error, Result};

/// The list keeps this many (finished ones are dropped first).
const MAX_KEPT: usize = 200;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub id: u64,
    pub url: String,
    /// The file's name (the last part of its path, else of the URL).
    pub file_name: String,
    /// Where it is saved (unknown on macOS until it finishes, and sometimes after).
    pub path: Option<String>,
    pub received: u64,
    /// The size the server announced, if any.
    pub total: Option<u64>,
    /// "progress", "done", "failed" or "cancelled".
    pub state: &'static str,
    pub error: Option<String>,
    pub started_ms: f64,
    /// Whether this platform can cancel it.
    pub can_cancel: bool,
    /// The webview it came from ("main" for a tab's frame).
    pub webview: String,
}

#[derive(Default)]
pub struct Downloads {
    list: Mutex<Vec<Download>>,
    next: AtomicU64,
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// The name shown for a download: the path's file name, else the URL's last segment.
pub fn file_name(path: Option<&str>, url: &str) -> String {
    let from_path = path
        .and_then(|p| p.rsplit(['/', '\\']).next())
        .filter(|n| !n.is_empty());
    if let Some(name) = from_path {
        return name.to_string();
    }
    let without_query = url.split(['?', '#']).next().unwrap_or(url);
    without_query
        .rsplit('/')
        .find(|s| !s.is_empty() && !s.contains(':'))
        .unwrap_or("download")
        .to_string()
}

impl Downloads {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Vec<Download>>> {
        self.list
            .lock()
            .map_err(|_| Error::Invalid("lock poisoned".into()))
    }

    /// A download started; returns its id.
    pub fn begin(
        &self,
        log: &NetLog,
        url: &str,
        path: Option<String>,
        total: Option<u64>,
        webview: &str,
        can_cancel: bool,
    ) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let item = Download {
            id,
            url: url.to_string(),
            file_name: file_name(path.as_deref(), url),
            path,
            received: 0,
            total,
            state: "progress",
            error: None,
            started_ms: now_ms(),
            can_cancel,
            webview: webview.to_string(),
        };
        if let Ok(mut list) = self.lock() {
            list.push(item.clone());
            while list.len() > MAX_KEPT {
                match list.iter().position(|d| d.state != "progress") {
                    Some(at) => {
                        list.remove(at);
                    }
                    None => break,
                }
            }
        }
        log.send(BrowserEvent::Download(item));
        id
    }

    /// Changes a download and tells the IDE (unless nothing changed).
    pub fn update(&self, log: &NetLog, id: u64, change: impl FnOnce(&mut Download)) {
        let changed = {
            let Ok(mut list) = self.lock() else { return };
            let Some(item) = list.iter_mut().find(|d| d.id == id) else {
                return;
            };
            let before = item.clone();
            change(item);
            if let Some(path) = item.path.as_deref() {
                item.file_name = file_name(Some(path), &item.url);
            }
            (*item != before).then(|| item.clone())
        };
        if let Some(item) = changed {
            log.send(BrowserEvent::Download(item));
        }
    }

    /// The newest download in progress for `url` (Tauri's hook names downloads by URL only).
    pub fn find_running(&self, url: &str) -> Option<u64> {
        self.lock()
            .ok()?
            .iter()
            .rev()
            .find(|d| d.url == url && d.state == "progress")
            .map(|d| d.id)
    }

    pub fn list(&self) -> Vec<Download> {
        self.lock().map(|l| l.clone()).unwrap_or_default()
    }

    pub fn get(&self, id: u64) -> Option<Download> {
        self.lock().ok()?.iter().find(|d| d.id == id).cloned()
    }

    /// Forgets the finished ones (running downloads stay).
    pub fn clear_finished(&self) {
        if let Ok(mut list) = self.lock() {
            list.retain(|d| d.state == "progress");
        }
    }

    /// The saved file of a finished download.
    pub fn finished_path(&self, id: u64) -> Result<PathBuf> {
        let item = self
            .get(id)
            .ok_or_else(|| Error::Invalid(format!("no download {id}")))?;
        if item.state != "done" {
            return Err(Error::Invalid(format!(
                "{} isn't finished ({})",
                item.file_name, item.state
            )));
        }
        let path = item
            .path
            .ok_or_else(|| Error::Invalid("this platform didn't say where it was saved".into()))?;
        let path = PathBuf::from(path);
        if !path.is_file() {
            return Err(Error::Invalid(format!(
                "{} isn't there any more",
                path.display()
            )));
        }
        Ok(path)
    }
}

/// Follows a webview's downloads (Windows: the WebView2 operation itself).
#[cfg(windows)]
pub fn attach<R: tauri::Runtime>(app: &tauri::AppHandle<R>, webview: &tauri::Webview<R>) {
    use tauri::Manager;
    let label = webview.label().to_string();
    let app = app.clone();
    let _ = webview.with_webview(move |platform| {
        let Some(state) = app.try_state::<crate::AppState>() else {
            return;
        };
        let shared = state.browser.shared.clone();
        // SAFETY: WebView2 COM calls on the UI thread (with_webview runs there, and so do the
        // event handlers); a failure leaves WebView2's own download handling.
        unsafe {
            let _ = windows_com::listen(platform, shared, label);
        }
    });
}

#[cfg(windows)]
mod windows_com {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::Instant;

    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2DownloadOperation, ICoreWebView2_4, COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON,
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED, COREWEBVIEW2_DOWNLOAD_STATE,
        COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED, COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS,
    };
    use webview2_com::{
        take_pwstr, BytesReceivedChangedEventHandler, DownloadStartingEventHandler,
        StateChangedEventHandler,
    };
    use windows::core::{Interface, PWSTR};

    use crate::browser::proxy::Shared;

    thread_local! {
        /// Operations in progress by download id, for cancel (COM objects stay on the UI thread).
        static OPERATIONS: RefCell<HashMap<u64, ICoreWebView2DownloadOperation>> =
            RefCell::new(HashMap::new());
    }

    /// Cancels a running download. Must run on the UI thread.
    pub fn cancel(id: u64) -> bool {
        OPERATIONS.with(|ops| {
            ops.borrow()
                .get(&id)
                // SAFETY: on the UI thread, where the operation was received.
                .map(|op| unsafe { op.Cancel().is_ok() })
                .unwrap_or(false)
        })
    }

    unsafe fn path_of(op: &ICoreWebView2DownloadOperation) -> Option<String> {
        let mut raw = PWSTR::null();
        op.ResultFilePath(&mut raw).ok()?;
        let path = take_pwstr(raw);
        (!path.is_empty()).then_some(path)
    }

    pub unsafe fn listen(
        platform: tauri::webview::PlatformWebview,
        shared: Arc<Shared>,
        label: String,
    ) -> windows::core::Result<()> {
        let webview = platform.controller().CoreWebView2()?;
        let webview4: ICoreWebView2_4 = webview.cast()?;
        let mut token = 0i64;
        webview4.add_DownloadStarting(
            &DownloadStartingEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let op = args.DownloadOperation()?;
                let mut raw = PWSTR::null();
                op.Uri(&mut raw)?;
                let url = take_pwstr(raw);
                let mut total = 0i64;
                op.TotalBytesToReceive(&mut total)?;
                let mut raw = PWSTR::null();
                args.ResultFilePath(&mut raw)?;
                let path = take_pwstr(raw);
                // Shown in the IDE's list instead of WebView2's bubble; saved where WebView2
                // would (the user's Downloads folder, a unique name). A program or script keeps
                // WebView2's own prompt and its warnings (D233 audit): a page shouldn't drop one
                // into Downloads unseen.
                if !super::runs_as_program(&path) {
                    args.SetHandled(true)?;
                }
                let id = shared.downloads.begin(
                    &shared.log,
                    &url,
                    (!path.is_empty()).then_some(path),
                    (total > 0).then_some(total as u64),
                    &label,
                    true,
                );
                OPERATIONS.with(|ops| ops.borrow_mut().insert(id, op.clone()));
                let progress = shared.clone();
                let mut last = Instant::now();
                let mut token = 0i64;
                op.add_BytesReceivedChanged(
                    &BytesReceivedChangedEventHandler::create(Box::new(move |op, _| {
                        // A few updates a second is enough for a progress bar.
                        if last.elapsed().as_millis() < 200 {
                            return Ok(());
                        }
                        last = Instant::now();
                        let Some(op) = op else { return Ok(()) };
                        let mut received = 0i64;
                        op.BytesReceived(&mut received)?;
                        let mut total = 0i64;
                        op.TotalBytesToReceive(&mut total)?;
                        progress.downloads.update(&progress.log, id, |d| {
                            d.received = received.max(0) as u64;
                            if total > 0 {
                                d.total = Some(total as u64);
                            }
                        });
                        Ok(())
                    })),
                    &mut token,
                )?;
                let ended = shared.clone();
                let mut token = 0i64;
                op.add_StateChanged(
                    &StateChangedEventHandler::create(Box::new(move |op, _| {
                        let Some(op) = op else { return Ok(()) };
                        let mut state = COREWEBVIEW2_DOWNLOAD_STATE::default();
                        op.State(&mut state)?;
                        if state == COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS {
                            return Ok(());
                        }
                        let mut received = 0i64;
                        op.BytesReceived(&mut received)?;
                        let mut reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON::default();
                        let _ = op.InterruptReason(&mut reason);
                        let path = path_of(&op);
                        OPERATIONS.with(|ops| ops.borrow_mut().remove(&id));
                        ended.downloads.update(&ended.log, id, |d| {
                            d.received = received.max(0) as u64;
                            if path.is_some() {
                                d.path = path;
                            }
                            d.can_cancel = false;
                            if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
                                d.state = "done";
                            } else if reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED
                            {
                                d.state = "cancelled";
                            } else {
                                d.state = "failed";
                                d.error = Some(format!("interrupted (reason {})", reason.0));
                            }
                        });
                        Ok(())
                    })),
                    &mut token,
                )?;
                Ok(())
            })),
            &mut token,
        )
    }
}

/// Cancels a download (Windows; elsewhere the engine gives no way to).
pub fn cancel<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: u64) -> Result<()> {
    #[cfg(windows)]
    {
        app.run_on_main_thread(move || {
            windows_com::cancel(id);
        })
        .map_err(|e| Error::Invalid(e.to_string()))
    }
    #[cfg(not(windows))]
    {
        let _ = (app, id);
        Err(Error::Invalid(
            "downloads can't be cancelled from the IDE on this platform".into(),
        ))
    }
}

/// Tauri's download hook (macOS, Linux): start and end only.
#[cfg(not(windows))]
pub fn hook<R: tauri::Runtime>(
    shared: std::sync::Arc<super::proxy::Shared>,
) -> impl Fn(tauri::Webview<R>, tauri::webview::DownloadEvent<'_>) -> bool + Send + Sync + 'static {
    move |webview, event| {
        match event {
            tauri::webview::DownloadEvent::Requested { url, destination } => {
                let path = destination.to_string_lossy().into_owned();
                shared.downloads.begin(
                    &shared.log,
                    url.as_str(),
                    (!path.is_empty()).then_some(path),
                    None,
                    webview.label(),
                    false,
                );
            }
            tauri::webview::DownloadEvent::Finished { url, path, success } => {
                if let Some(id) = shared.downloads.find_running(url.as_str()) {
                    shared.downloads.update(&shared.log, id, |d| {
                        if let Some(p) = path {
                            d.path = Some(p.to_string_lossy().into_owned());
                        }
                        d.state = if success { "done" } else { "failed" };
                    });
                }
            }
            _ => {}
        }
        true
    }
}

/// Follows the downloads of the main window's webview (a tab's frame): on Windows by attaching to
/// the built webview; elsewhere the builder gets the hook (see `track`).
pub fn attach_main<R: tauri::Runtime>(app: &tauri::AppHandle<R>, window: &tauri::WebviewWindow<R>) {
    #[cfg(windows)]
    attach(app, window.as_ref());
    #[cfg(not(windows))]
    let _ = (app, window);
}

/// The main window's builder with the download hook (macOS, Linux; Windows attaches after).
pub fn track<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: tauri::WebviewWindowBuilder<'a, R, M>,
    shared: std::sync::Arc<super::proxy::Shared>,
) -> tauri::WebviewWindowBuilder<'a, R, M> {
    #[cfg(not(windows))]
    {
        builder.on_download(hook(shared))
    }
    #[cfg(windows)]
    {
        let _ = shared;
        builder
    }
}

/** Whether a downloaded file would run as a program when opened (Windows' risky types). */
#[cfg_attr(not(windows), allow(dead_code))]
pub fn runs_as_program(path: &str) -> bool {
    const RISKY: &[&str] = &[
        "exe", "msi", "msix", "appx", "bat", "cmd", "com", "scr", "pif", "lnk", "url", "hta",
        "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "reg", "cpl", "jar", "dll",
    ];
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| RISKY.iter().any(|r| r.eq_ignore_ascii_case(e)))
}

#[cfg(test)]
mod tests {
    #[test]
    fn programs_and_scripts_keep_the_engine_prompt() {
        assert!(super::runs_as_program(r"C:UsersaDownloadssetup.EXE"));
        assert!(super::runs_as_program("x/run.ps1"));
        assert!(!super::runs_as_program("notes.txt"));
        assert!(!super::runs_as_program("archive"));
    }

    use super::*;

    #[test]
    fn names_come_from_the_path_or_the_url() {
        assert_eq!(
            file_name(Some(r"C:\Users\a\Downloads\report (1).pdf"), "x"),
            "report (1).pdf"
        );
        assert_eq!(file_name(Some("/home/a/x.zip"), "x"), "x.zip");
        assert_eq!(
            file_name(None, "http://127.0.0.1:5/files/data.csv?x=1"),
            "data.csv"
        );
        assert_eq!(file_name(None, "http://127.0.0.1:5/"), "download");
        assert_eq!(file_name(None, "blob:"), "download");
    }

    #[test]
    fn the_list_updates_and_forgets_finished_ones() {
        let log = NetLog::default();
        let d = Downloads::default();
        let a = d.begin(&log, "http://x/a.txt", None, Some(10), "main", true);
        let b = d.begin(&log, "http://x/b.txt", None, None, "main", false);
        d.update(&log, a, |x| {
            x.received = 10;
            x.state = "done";
            x.path = Some("/tmp/a (1).txt".into());
        });
        assert_eq!(d.get(a).map(|x| x.file_name), Some("a (1).txt".into()));
        assert_eq!(d.find_running("http://x/b.txt"), Some(b));
        assert_eq!(d.find_running("http://x/a.txt"), None);
        d.clear_finished();
        assert_eq!(d.list().len(), 1);
        assert!(d.finished_path(b).is_err());
    }
}
