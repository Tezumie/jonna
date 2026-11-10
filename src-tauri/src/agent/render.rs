//! Documentation pages that need JavaScript, rendered for @docs (D233): the page is loaded in a
//! hidden window of its own (`docs-render-<n>`, InPrivate / incognito, so no cookies or storage
//! are shared with the IDE or kept), and a small initialization script waits for the load and for
//! the page to stop changing (800 ms without DOM changes, 8 s at most), then posts
//! `document.body.innerText` back through the one command such windows may call
//! (`docs_render_post`, capability `docs-render`). Navigations stay on the page's origin, new
//! windows are refused, and the window is destroyed after the text comes or the time runs out.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::{Error, Result};

/// The windows' label prefix (the capability matches it).
pub const PREFIX: &str = "docs-render-";
/// Most characters taken from a page.
const MAX_TEXT: usize = 2_000_000;
/// The longest a page may take, whatever the caller asks.
const MAX_TIMEOUT_MS: u64 = 60_000;

/// What the page's script sends: its text and title.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rendered {
    pub url: String,
    pub title: String,
    pub text: String,
}

type Waiting = HashMap<String, tokio::sync::oneshot::Sender<Rendered>>;

fn waiting() -> &'static Mutex<Waiting> {
    static WAITING: OnceLock<Mutex<Waiting>> = OnceLock::new();
    WAITING.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT: AtomicU64 = AtomicU64::new(1);

/// Runs in the hidden window: waits for the page to settle, then posts its text once.
const SCRIPT: &str = r#"(() => {
  if (window.top !== window || window.__ideDocsRender) return;
  window.__ideDocsRender = true;
  let sent = false;
  const send = () => {
    if (sent) return;
    sent = true;
    try {
      window.__TAURI_INTERNALS__.invoke("docs_render_post", {
        url: location.href,
        title: document.title || "",
        text: (document.body && document.body.innerText) || "",
      });
    } catch (_) {}
  };
  const settle = () => {
    let timer = 0;
    const done = () => {
      observer.disconnect();
      send();
    };
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, 800);
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    timer = setTimeout(done, 800);
    setTimeout(done, 8000);
  };
  if (document.readyState === "complete") settle();
  else window.addEventListener("load", settle, { once: true });
})();"#;

/// Whether a navigation in the hidden window may go ahead: the same origin, http(s) only.
pub fn same_origin(start: &reqwest::Url, next: &tauri::Url) -> bool {
    matches!(next.scheme(), "http" | "https")
        && next.origin().ascii_serialization() == start.origin().ascii_serialization()
}

/// Clips the text to MAX_TEXT characters (on a character boundary).
pub fn clip(mut text: String) -> String {
    if text.len() > MAX_TEXT {
        let mut end = MAX_TEXT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text
}

/// Loads `url` in a hidden window and returns what it shows; None when it didn't answer in time.
pub async fn render(app: &AppHandle, url: &str, timeout_ms: u64) -> Result<Option<Rendered>> {
    let start = crate::ai::web::check_url(url)?;
    let label = format!("{PREFIX}{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let (tx, rx) = tokio::sync::oneshot::channel();
    waiting()
        .lock()
        .map_err(|_| Error::Invalid("render state poisoned".into()))?
        .insert(label.clone(), tx);
    let origin = start.clone();
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(start))
        .title("")
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .incognito(true)
        .inner_size(1200.0, 900.0)
        .initialization_script(SCRIPT)
        .on_navigation(move |next| same_origin(&origin, next))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build();
    let window = match built {
        Ok(w) => w,
        Err(e) => {
            forget(&label);
            return Err(Error::Invalid(format!(
                "couldn't open a window for the page: {e}"
            )));
        }
    };
    let limit = Duration::from_millis(timeout_ms.clamp(1000, MAX_TIMEOUT_MS));
    let got = tokio::time::timeout(limit, rx)
        .await
        .ok()
        .and_then(|r| r.ok());
    forget(&label);
    let _ = window.destroy();
    // A window that outlived its destroy (a platform quirk) is closed by label too.
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.destroy();
    }
    Ok(got.map(|r| Rendered {
        text: clip(r.text),
        ..r
    }))
}

fn forget(label: &str) {
    if let Ok(mut w) = waiting().lock() {
        w.remove(label);
    }
}

/// The page's text from its window (the first post only; later ones and other windows' are
/// ignored). Page data, untrusted: it only becomes @docs text.
pub fn post(label: &str, rendered: Rendered) -> Result<()> {
    if !label.starts_with(PREFIX) {
        return Err(Error::Invalid("not a docs render window".into()));
    }
    let sender = waiting().lock().ok().and_then(|mut w| w.remove(label));
    if let Some(tx) = sender {
        let _ = tx.send(rendered);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigations_stay_on_the_origin() {
        let start = reqwest::Url::parse("https://docs.example.com/guide/").unwrap();
        let ok = tauri::Url::parse("https://docs.example.com/api#x").unwrap();
        let other = tauri::Url::parse("https://evil.example.com/").unwrap();
        let scheme = tauri::Url::parse("file:///etc/passwd").unwrap();
        let port = tauri::Url::parse("https://docs.example.com:8443/").unwrap();
        assert!(same_origin(&start, &ok));
        assert!(!same_origin(&start, &other));
        assert!(!same_origin(&start, &scheme));
        assert!(!same_origin(&start, &port));
    }

    #[test]
    fn long_text_is_clipped_on_a_character() {
        let text = "é".repeat(MAX_TEXT);
        let clipped = clip(text);
        assert!(clipped.len() <= MAX_TEXT);
        assert!(clipped.chars().all(|c| c == 'é'));
        assert_eq!(clip("short".into()), "short");
    }

    #[test]
    fn posts_from_other_windows_are_refused() {
        let r = Rendered {
            url: "https://x/".into(),
            title: String::new(),
            text: String::new(),
        };
        assert!(post("main", r.clone()).is_err());
        // Nobody waiting: accepted and dropped.
        assert!(post("docs-render-999", r).is_ok());
    }
}
