//! Other sites inside a browser tab (`browser.embedSites`): a site can't be framed or proxied, so
//! it gets its own webview, a child of the IDE window that shows the tab (Tauri's multi-webview,
//! the `unstable` feature), placed over the tab's page area. The tab keeps it there: it sends the
//! area's bounds whenever the layout moves, hides it while the tab isn't shown or while a menu,
//! dialog or other overlay of the IDE covers it (a native webview is always drawn above the IDE's
//! own page), and closes it with the tab. The webview runs the same bridge and has the same link
//! handling as a site's own window (`BrowserService::open_window`); its label has the same prefix,
//! so the bridge commands, screenshots and downloads treat both alike.
//!
//! Linux isn't supported: there Tauri packs child webviews into the window's box instead of
//! placing them, so the tab falls back to the site's own window.

use serde::Deserialize;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl};

use super::{init_script, site_url, BrowserService};
use crate::error::{Error, Result};

/// The page area in physical pixels, relative to the host window's client area.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Bounds {
    /// Whole pixels, at least 1×1 (a zero-sized webview is refused on some platforms).
    fn physical(self) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
        let clamp = |v: f64| if v.is_finite() { v.round() } else { 0.0 };
        (
            PhysicalPosition::new(clamp(self.x) as i32, clamp(self.y) as i32),
            PhysicalSize::new(
                clamp(self.width).clamp(1.0, 16384.0) as u32,
                clamp(self.height).clamp(1.0, 16384.0) as u32,
            ),
        )
    }
}

/// The IDE windows a tab can be in: the main one, or an auxiliary window (a tab moved out).
fn host_window(app: &AppHandle, host: &str) -> Result<tauri::Window> {
    if host != "main" && !host.starts_with(crate::aux_window::AUX_PREFIX) {
        return Err(Error::Invalid(format!("{host} isn't an IDE window")));
    }
    app.get_window(host)
        .ok_or_else(|| Error::Invalid(format!("no window {host}")))
}

/// Whether this platform can place a webview inside a window.
pub const SUPPORTED: bool = cfg!(any(windows, target_os = "macos"));

impl BrowserService {
    /// Shows `url` in a new webview over `bounds` of the window `host`; returns its label.
    pub async fn open_embedded(
        &self,
        app: &AppHandle,
        host: &str,
        url: &str,
        popup: bool,
        name: Option<&str>,
        bounds: Bounds,
    ) -> Result<String> {
        if !SUPPORTED {
            return Err(Error::Invalid(
                "sites can't be shown inside a tab on this platform".into(),
            ));
        }
        let parsed = site_url(url)?;
        let window = host_window(app, host)?;
        let label = self.next_label()?;
        let (navigation, new_window) = self.handlers(&label);
        let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(parsed))
            .initialization_script(init_script(popup, name))
            .on_navigation(navigation)
            .on_new_window(new_window)
            // The IDE keeps the keyboard until the user clicks into the page.
            .focused(false);
        #[cfg(not(windows))]
        let builder = builder.on_download(super::downloads::hook(self.shared.clone()));
        let (position, size) = bounds.physical();
        // `add_child` waits for the UI thread: not on an async worker (Tauri's own warning).
        let webview =
            tauri::async_runtime::spawn_blocking(move || window.add_child(builder, position, size))
                .await
                .map_err(|e| Error::Invalid(e.to_string()))?
                .map_err(|e| Error::Invalid(format!("couldn't show the site in the tab: {e}")))?;
        #[cfg(windows)]
        {
            super::downloads::attach(app, &webview);
            crate::accelerators::disable_for_webview(&webview);
        }
        #[cfg(not(windows))]
        let _ = webview;
        Ok(label)
    }
}

/// Moves a tab's site webview to `bounds` of the window `host` (moving it to that window if the
/// tab moved), shows or hides it, and sets its zoom (device mode scales the page down).
pub fn place(
    app: &AppHandle,
    label: &str,
    host: &str,
    bounds: Bounds,
    visible: bool,
    zoom: f64,
) -> Result<()> {
    let webview = embedded(app, label)?;
    if webview.window().label() != host {
        let window = host_window(app, host)?;
        webview
            .reparent(&window)
            .map_err(|e| Error::Invalid(e.to_string()))?;
    }
    let fail = |e: tauri::Error| Error::Invalid(e.to_string());
    if !visible {
        return webview.hide().map_err(fail);
    }
    let (position, size) = bounds.physical();
    webview
        .set_bounds(tauri::Rect {
            position: position.into(),
            size: size.into(),
        })
        .map_err(fail)?;
    if zoom.is_finite() && (0.1..=4.0).contains(&zoom) {
        webview.set_zoom(zoom).map_err(fail)?;
    }
    webview.show().map_err(fail)
}

/// Gives the keyboard to a tab's site webview (a click on the tab's page area, `focus()`).
pub fn focus(app: &AppHandle, label: &str) -> Result<()> {
    embedded(app, label)?
        .set_focus()
        .map_err(|e| Error::Invalid(e.to_string()))
}

/// A site webview shown inside a tab (not a site's own window, not the IDE's).
fn embedded(app: &AppHandle, label: &str) -> Result<tauri::Webview> {
    if !label.starts_with(super::WINDOW_PREFIX) {
        return Err(Error::Invalid("not a browser webview".into()));
    }
    let webview = app
        .get_webview(label)
        .ok_or_else(|| Error::Invalid(format!("the page {label} is closed")))?;
    if webview.window().label() == label {
        return Err(Error::Invalid(format!("{label} is a window of its own")));
    }
    Ok(webview)
}

/// The page of window `window` (re)loaded: the sites embedded in it belonged to the old page's
/// tabs, which nobody will place or close any more, and a native webview is drawn above the new
/// page (D233 audit). Returns how many were closed.
pub fn close_embedded_in(app: &AppHandle, window: &str) -> usize {
    let mut closed = 0;
    for (label, webview) in app.webviews() {
        if label.starts_with(super::WINDOW_PREFIX)
            && webview.window().label() == window
            && label != window
            && webview.close().is_ok()
        {
            closed += 1;
        }
    }
    closed
}

/// Closes a site's webview: its own window, or the one inside a tab.
pub fn close(app: &AppHandle, label: &str) -> Result<()> {
    if !label.starts_with(super::WINDOW_PREFIX) {
        return Err(Error::Invalid("not a browser window".into()));
    }
    if let Some(w) = app.get_webview_window(label) {
        return w.close().map_err(|e| Error::Invalid(e.to_string()));
    }
    if let Some(webview) = app.get_webview(label) {
        webview.close().map_err(|e| Error::Invalid(e.to_string()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_are_whole_and_never_empty() {
        let (p, s) = Bounds {
            x: 10.4,
            y: 20.6,
            width: 0.0,
            height: f64::NAN,
        }
        .physical();
        assert_eq!((p.x, p.y), (10, 21));
        assert_eq!((s.width, s.height), (1, 1));
    }
}
