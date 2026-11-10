//! The browser pane as a debugging target (D204). On Windows the IDE's webviews are WebView2,
//! which opens the Chrome DevTools Protocol on a local port when started with
//! `--remote-debugging-port`; the debugger then attaches to the pane's frame like to a page in
//! Edge. The port is a setting (`debug.browserPane.debuggingPort`), saved here by the frontend and
//! read at the next start, since WebView2 takes browser arguments only when its environment is
//! created. Every webview of the process must share those arguments, so they go through
//! WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, which is removed from every process the IDE starts
//! (terminals, commands, language servers, agents, debug adapters, git, another window: D229),
//! so no other WebView2 program opens a debugging port.
//! WebKitGTK (Linux) and WKWebView (macOS) have no such protocol: the setting does nothing there.

use std::path::{Path, PathBuf};

use crate::error::Result;

/// WebView2's variable for extra browser arguments.
pub const WEBVIEW2_ARGS_VAR: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

fn file(data: &Path) -> PathBuf {
    data.join("browser-pane-debug-port")
}

/// Saves the port for the next start (0 removes it).
pub fn save(data: &Path, port: u16) -> Result<()> {
    if port == 0 {
        let _ = std::fs::remove_file(file(data));
        return Ok(());
    }
    std::fs::create_dir_all(data)?;
    std::fs::write(file(data), port.to_string())?;
    Ok(())
}

/// The saved port, if any (read at start on Windows).
#[cfg_attr(not(windows), allow(dead_code))]
pub fn load(data: &Path) -> Option<u16> {
    std::fs::read_to_string(file(data))
        .ok()
        .and_then(|t| t.trim().parse::<u16>().ok())
        .filter(|p| *p > 0)
}

#[cfg_attr(not(windows), allow(dead_code))]
/// The browser arguments for a debugging port: Tauri's defaults plus the port (the variable
/// replaces the arguments Tauri would pass).
pub fn browser_args(port: u16) -> String {
    format!(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_round_trips() {
        let tmp = std::env::temp_dir().join(format!("ide-pane-port-{}", std::process::id()));
        save(&tmp, 9333).unwrap();
        assert_eq!(load(&tmp), Some(9333));
        save(&tmp, 0).unwrap();
        assert_eq!(load(&tmp), None);
        assert!(browser_args(9333).ends_with("--remote-debugging-port=9333"));
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
