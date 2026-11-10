//! Browser previews (PLAN §8.5). `proxy.rs` serves local dev servers and workspace folders to the
//! IDE's in-dock browser frame with the bridge script injected; `BrowserService` keeps one proxy
//! per target. External sites open in their own window (`open_window`), or in a webview over the
//! tab (`embed.rs`), with the same bridge as the initialization script; it reports through
//! `browser_bridge_post` and the IDE calls it with `send_to_window` (an `eval` of
//! `__ideBridge.receive(<json>)`). `downloads.rs`: the IDE's downloads list.

pub mod downloads;
pub mod embed;
pub mod netlog;
pub mod proxy;
mod stream;
pub mod trusted_input;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};
pub use proxy::Target;

/// Window labels of external browser windows start with this.
pub const WINDOW_PREFIX: &str = "browser-";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyInfo {
    /// The proxy's own origin, e.g. "http://127.0.0.1:53211" (what the frame loads; an
    /// extension webview's is on localhost, D265).
    pub origin: String,
    /// What it serves: the dev server's origin, or the folder.
    pub target: String,
}

struct Running {
    info: ProxyInfo,
    cancel: CancellationToken,
}

#[derive(Default)]
pub struct BrowserService {
    proxies: std::sync::Arc<Mutex<HashMap<String, Running>>>,
    windows: Mutex<u32>,
    /// Network log and live-preview overlays, shared by every proxy.
    pub shared: std::sync::Arc<proxy::Shared>,
}

fn lock<T>(m: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    m.lock().map_err(|_| Error::Invalid("lock poisoned".into()))
}

/// A dev-server URL this machine serves: http on localhost / 127.x / ::1 / 0.0.0.0 / *.localhost.
pub fn local_target(url: &str) -> Result<Target> {
    let parsed = reqwest::Url::parse(url).map_err(|e| Error::Invalid(format!("{url}: {e}")))?;
    if parsed.scheme() != "http" {
        return Err(Error::Invalid(format!(
            "{url} isn't a local http address (open it in a browser window instead)"
        )));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| Error::Invalid(format!("{url} has no host")))?
        .trim_matches(['[', ']'])
        .to_string();
    let local = host == "localhost"
        || host.ends_with(".localhost")
        || host == "::1"
        || host == "0.0.0.0"
        // A 127.x.y.z address, not a name that starts with "127." (127.evil.com).
        || host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.is_loopback());
    if !local {
        return Err(Error::Invalid(format!("{url} isn't on this machine")));
    }
    let port = parsed.port_or_known_default().unwrap_or(80);
    let connect = match host.as_str() {
        "0.0.0.0" => "127.0.0.1".to_string(),
        h if h.ends_with(".localhost") => "localhost".to_string(),
        h => h.to_string(),
    };
    let shown = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.clone()
    };
    Ok(Target::Upstream {
        host: connect,
        port,
        origin: format!("http://{shown}:{port}"),
    })
}

/// A proxy key of an extension's webview files (see `proxy`).
fn is_extension_key(key: &str) -> bool {
    key.ends_with("\0ext") || key.ends_with("\0embed")
}

impl BrowserService {
    /// The proxy for `target` (started on first use).
    pub async fn proxy(&self, target: Target) -> Result<ProxyInfo> {
        let key = match &target {
            Target::Upstream { origin, .. } => origin.clone(),
            Target::Static { root, csp } => {
                format!(
                    "{}{}",
                    root.to_string_lossy(),
                    match csp {
                        Some(c) if *c == WEBVIEW_EMBED_CSP => "\0embed",
                        Some(_) => "\0ext",
                        None => "",
                    }
                )
            }
        };
        if let Some(running) = lock(&self.proxies)?.get(&key) {
            return Ok(running.info.clone());
        }
        let cancel = CancellationToken::new();
        let host = proxy::origin_host(&target);
        let port = proxy::serve(target, cancel.clone(), self.shared.clone()).await?;
        let info = ProxyInfo {
            origin: format!("http://{host}:{port}"),
            target: key.clone(),
        };
        let mut proxies = lock(&self.proxies)?;
        if let Some(existing) = proxies.get(&key) {
            // Started twice at once: keep the first.
            cancel.cancel();
            return Ok(existing.info.clone());
        }
        proxies.insert(
            key,
            Running {
                info: info.clone(),
                cancel,
            },
        );
        Ok(info)
    }

    /// Stops the folder's proxies (folder closed): previews of its servers and files. Extensions'
    /// webview proxies stay — extensions outlive the folder, and an extension keeps using the
    /// origin it was given (stopping them showed "127.0.0.1 refused to connect" in its views).
    pub fn stop_all(&self) {
        if let Ok(mut proxies) = self.proxies.lock() {
            proxies.retain(|key, running| {
                let keep = is_extension_key(key);
                if !keep {
                    running.cancel.cancel();
                }
                keep
            });
        }
    }

    /// Whether `url` is served by one of the proxies (a popped-out local page).
    fn is_proxy_url(proxies: &Mutex<HashMap<String, Running>>, url: &reqwest::Url) -> bool {
        let origin = url.origin().ascii_serialization();
        proxies
            .lock()
            .is_ok_and(|p| p.values().any(|r| r.info.origin == origin))
    }

    /// A new label for a site's webview (its own window, or embedded in a tab).
    fn next_label(&self) -> Result<String> {
        let mut n = lock(&self.windows)?;
        *n += 1;
        Ok(format!("{WINDOW_PREFIX}{n}"))
    }

    /// Opens `url` (http/https) in a new window with the bridge. Returns its label. `popup`: the
    /// page was opened by another tab's `window.open`, so the bridge gives it a `window.opener`
    /// that relays to that tab (D209). `name`: the tab's window name (`window.open(url, name)`,
    /// a link's `target`), which the page sees as `window.name`.
    ///
    /// Where its links go (D209): a navigation to a local server (an OAuth sign-in coming back
    /// to `http://localhost:5173/callback`) is cancelled here and handed to the tab, which shows
    /// it in its frame through the proxy; new windows (`target=_blank`, `window.open` the bridge
    /// didn't catch) become IDE browser tabs. Without these, WebView2 dropped them silently.
    pub fn open_window(
        &self,
        app: &AppHandle,
        url: &str,
        title: &str,
        popup: bool,
        name: Option<&str>,
    ) -> Result<String> {
        let parsed = site_url(url)?;
        let label = self.next_label()?;
        let (navigation, new_window) = self.handlers(&label);
        let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed))
            .title(title)
            .inner_size(1100.0, 800.0)
            .initialization_script(init_script(popup, name))
            .on_navigation(navigation)
            .on_new_window(new_window);
        #[cfg(not(windows))]
        let builder = builder.on_download(downloads::hook(self.shared.clone()));
        let window = builder
            .build()
            .map_err(|e| Error::Invalid(format!("couldn't open a browser window: {e}")))?;
        #[cfg(windows)]
        downloads::attach(app, window.as_ref());
        #[cfg(not(windows))]
        let _ = window;
        Ok(label)
    }

    /// What every site webview does with its navigations and new windows (see `open_window`).
    fn handlers(
        &self,
        label: &str,
    ) -> (
        impl Fn(&tauri::Url) -> bool + Send + 'static,
        impl Fn(
                tauri::Url,
                tauri::webview::NewWindowFeatures,
            ) -> tauri::webview::NewWindowResponse<tauri::Wry>
            + Send
            + 'static,
    ) {
        let report = |shared: std::sync::Arc<proxy::Shared>, label: String| {
            move |url: &str, disposition: &str| {
                shared.log.send(netlog::BrowserEvent::Bridge {
                    label: label.clone(),
                    message: serde_json::json!({
                        "ns": "ide-bridge",
                        "type": "open",
                        "url": url,
                        "disposition": disposition,
                    }),
                });
            }
        };
        let to_tab = report(self.shared.clone(), label.to_string());
        let new_window = report(self.shared.clone(), label.to_string());
        let proxies = self.proxies.clone();
        let navigation = move |url: &tauri::Url| {
            if is_app_origin(url) {
                return false;
            }
            let local = url.scheme() == "http" && local_target(url.as_str()).is_ok();
            if !local || Self::is_proxy_url(&proxies, url) {
                return true;
            }
            to_tab(url.as_str(), "self");
            false
        };
        let popups = move |url: tauri::Url, _features| {
            if matches!(url.scheme(), "http" | "https") && !is_app_origin(&url) {
                new_window(url.as_str(), "tab");
            }
            tauri::webview::NewWindowResponse::Deny
        };
        (navigation, popups)
    }
}

/// An http(s) address a site webview may show.
fn site_url(url: &str) -> Result<reqwest::Url> {
    let parsed = reqwest::Url::parse(url).map_err(|e| Error::Invalid(format!("{url}: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https") || is_app_origin(&parsed) {
        return Err(Error::Invalid(format!(
            "{url}: only http and https pages open here"
        )));
    }
    Ok(parsed)
}

/// The IDE's own origins (its pages and IPC): a site's webview never goes there, so a page can't
/// load the IDE's code under the IDE's origin next to it.
fn is_app_origin(url: &reqwest::Url) -> bool {
    matches!(url.scheme(), "tauri" | "ipc" | "asset")
        || url.host_str().is_some_and(|h| {
            let h = h.to_ascii_lowercase();
            h == "tauri.localhost" || h == "ipc.localhost" || h == "asset.localhost"
        })
}

/// The bridge as a site webview's initialization script.
fn init_script(popup: bool, name: Option<&str>) -> String {
    let name = name
        .filter(|n| !n.is_empty() && n.len() <= 200)
        .and_then(|n| serde_json::to_string(n).ok())
        .map(|json| format!("window.__IDE_WINDOW_NAME__={json};"))
        .unwrap_or_default();
    format!(
        "window.__IDE_BRIDGE_MODE__=\"external\";{}{name}
{}",
        if popup {
            "window.__IDE_POPUP__=true;"
        } else {
            ""
        },
        proxy::BRIDGE_JS
    )
}

/// WebKitGTK refuses every cookie in a third-party frame by default (its "no third party"
/// policy), and the preview frame is one (127.0.0.1 inside the IDE's own page): a dev server's
/// sign-in never stuck and even `document.cookie` stayed empty (D209). Accept them, as WebView2
/// does by default (with SameSite=None, which the proxy sets). The policy belongs to the web
/// context, which the main window shares with the IDE's other windows.
pub fn allow_frame_cookies<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    #[cfg(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    ))]
    {
        use webkit2gtk::{CookieManagerExt, WebViewExt, WebsiteDataManagerExt};
        let _ = window.with_webview(|webview| {
            if let Some(cookies) = webview
                .inner()
                .website_data_manager()
                .and_then(|data| data.cookie_manager())
            {
                cookies.set_accept_policy(webkit2gtk::CookieAcceptPolicy::Always);
            }
        });
    }
    #[cfg(not(any(
        target_os = "linux",
        target_os = "dragonfly",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd"
    )))]
    let _ = window;
}

/// Calls the bridge in an external window: `message` becomes JSON inside a fixed call.
pub fn send_to_window(app: &AppHandle, label: &str, message: &serde_json::Value) -> Result<()> {
    if !label.starts_with(WINDOW_PREFIX) {
        return Err(Error::Invalid("not a browser window".into()));
    }
    // A site's own window or one shown inside a tab (embed.rs): both are webviews by label.
    let webview = app
        .get_webview(label)
        .ok_or_else(|| Error::Invalid(format!("the browser window {label} is closed")))?;
    let json = serde_json::to_string(message)?;
    webview
        .eval(format!(
            "window.__ideBridge&&window.__ideBridge.receive({json})"
        ))
        .map_err(|e| Error::Invalid(e.to_string()))
}

/// A folder to serve, given an absolute path already checked against the workspace.
pub fn static_target(root: PathBuf) -> Target {
    Target::Static { root, csp: None }
}

/// What an extension's webview page may load and connect to: its own files only (network access
/// goes through `ide.net.fetch` in the worker, which checks the extension's permissions).
pub const WEBVIEW_CSP: &str = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; form-action 'none'";

/// The same, for an extension granted `web.embed` (D187): its pages may frame https sites (a
/// canvas's web page cards). Those sites run in their own origin, sandboxed by the page.
pub const WEBVIEW_EMBED_CSP: &str = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src https:; form-action 'none'";

/// An extension folder served for its webview panels.
/// Interactive notebook outputs (D189): they run the notebook's own code (Plotly, Bokeh, widget
/// libraries, often from a CDN), as in Jupyter; the frame is sandboxed without same-origin, so
/// the page can't reach the IDE except by the messages the notebook view accepts.
pub const NOTEBOOK_OUTPUT_CSP: &str =
    "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'none'";

pub fn webview_target(root: PathBuf, embed: bool) -> Target {
    Target::Static {
        root,
        csp: Some(if embed {
            WEBVIEW_EMBED_CSP
        } else {
            WEBVIEW_CSP
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_proxies_survive_closing_the_folder() {
        assert!(is_extension_key("/data/extensions/bundled.canvas\0ext"));
        assert!(is_extension_key("/data/extensions/bundled.canvas\0embed"));
        assert!(!is_extension_key("/project/site"));
        assert!(!is_extension_key("http://localhost:5173"));
    }

    #[test]
    fn site_webviews_never_load_the_ide() {
        let url = |u: &str| reqwest::Url::parse(u).ok();
        assert!(url("http://tauri.localhost/").is_some_and(|u| is_app_origin(&u)));
        assert!(url("https://IPC.localhost/x").is_some_and(|u| is_app_origin(&u)));
        assert!(url("tauri://localhost").is_some_and(|u| is_app_origin(&u)));
        assert!(url("https://example.com").is_some_and(|u| !is_app_origin(&u)));
        assert!(site_url("http://tauri.localhost/index.html").is_err());
        assert!(site_url("file:///etc/passwd").is_err());
        assert!(site_url("https://example.com/").is_ok());
        let script = init_script(true, Some("results\"</script>"));
        assert!(script
            .starts_with("window.__IDE_BRIDGE_MODE__=\"external\";window.__IDE_POPUP__=true;"));
        assert!(script.contains("window.__IDE_WINDOW_NAME__=\"results\\\"</script>\";"));
        assert!(init_script(false, Some("")).starts_with(
            "window.__IDE_BRIDGE_MODE__=\"external\";
"
        ));
    }

    #[test]
    fn local_targets_only() {
        assert!(matches!(
            local_target("http://localhost:5173/app"),
            Ok(Target::Upstream { port: 5173, .. })
        ));
        assert!(local_target("http://127.0.0.1:3000").is_ok());
        assert!(local_target("http://[::1]:8080").is_ok());
        assert!(local_target("http://app.localhost:8080").is_ok());
        assert!(local_target("http://0.0.0.0:4000").is_ok());
        assert!(local_target("https://localhost:5173").is_err());
        assert!(local_target("http://example.com").is_err());
        assert!(local_target("http://192.168.1.4:3000").is_err());
    }
}
