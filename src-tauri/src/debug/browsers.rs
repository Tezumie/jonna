//! Where Chrome or Edge is installed, for launching one to debug a page (D143's browser
//! launcher). The page can't look: fs access is scoped to the workspace and the app's folders, so
//! checking `C:\Program Files\…` from there always said "not found". Only these fixed names are
//! looked up, so this answers nothing about other paths on the machine.

use std::path::{Path, PathBuf};

/// The browser's executable, or None. `kind`: "chrome" or "edge" (Chromium counts as Chrome
/// where Chrome isn't installed, as VS Code's js-debug does on Linux).
pub fn find(kind: &str) -> Option<PathBuf> {
    let edge = kind.eq_ignore_ascii_case("edge");
    candidates(edge)
        .into_iter()
        .find(|p| p.is_file())
        .or_else(|| registered(edge))
        .or_else(|| on_path(edge))
}

#[cfg(windows)]
fn candidates(edge: bool) -> Vec<PathBuf> {
    // Per-machine installs in either Program Files (64-bit Chrome lives in the first, Edge in
    // the x86 one), per-user installs under LOCALAPPDATA.
    let rel: &[&str] = if edge {
        &["Microsoft", "Edge", "Application", "msedge.exe"]
    } else {
        &["Google", "Chrome", "Application", "chrome.exe"]
    };
    let mut roots: Vec<PathBuf> = [
        "ProgramFiles",
        "ProgramW6432",
        "ProgramFiles(x86)",
        "LOCALAPPDATA",
    ]
    .iter()
    .filter_map(std::env::var_os)
    .map(PathBuf::from)
    .collect();
    roots.extend(["C:\\Program Files", "C:\\Program Files (x86)"].map(PathBuf::from));
    let mut out: Vec<PathBuf> = Vec::new();
    for root in roots {
        let p = rel.iter().fold(root, |p, part| p.join(part));
        if !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

#[cfg(target_os = "macos")]
fn candidates(edge: bool) -> Vec<PathBuf> {
    let apps: &[&str] = if edge {
        &["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    } else {
        &[
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
    };
    let mut out: Vec<PathBuf> = apps.iter().map(PathBuf::from).collect();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        out.extend(apps.iter().map(|a| home.join(a.trim_start_matches('/'))));
    }
    out
}

#[cfg(not(any(windows, target_os = "macos")))]
fn candidates(edge: bool) -> Vec<PathBuf> {
    let paths: &[&str] = if edge {
        &[
            "/usr/bin/microsoft-edge",
            "/usr/bin/microsoft-edge-stable",
            "/opt/microsoft/msedge/msedge",
        ]
    } else {
        &[
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/opt/google/chrome/chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
        ]
    };
    paths.iter().map(PathBuf::from).collect()
}

/// Windows' "App Paths" registration (what `start chrome` uses), per user then per machine.
#[cfg(windows)]
fn registered(edge: bool) -> Option<PathBuf> {
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
    };
    let exe = if edge { "msedge.exe" } else { "chrome.exe" };
    let key = HSTRING::from(format!(
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{exe}"
    ));
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let mut buf = [0u16; 1024];
        let mut size = u32::try_from(std::mem::size_of_val(&buf)).unwrap_or(0);
        // SAFETY: the buffer and its byte size are passed together; the default value is read.
        let status = unsafe {
            RegGetValueW(
                hive,
                &key,
                windows::core::PCWSTR::null(),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut size),
            )
        };
        if status.is_err() {
            continue;
        }
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let text = String::from_utf16_lossy(&buf[..len]);
        let path = PathBuf::from(text.trim().trim_matches('"'));
        if is_exe(&path) {
            return Some(path);
        }
    }
    None
}

#[cfg(not(windows))]
fn registered(_edge: bool) -> Option<PathBuf> {
    None
}

fn on_path(edge: bool) -> Option<PathBuf> {
    let names: &[&str] = if edge {
        &["msedge", "microsoft-edge", "microsoft-edge-stable"]
    } else {
        &[
            "chrome",
            "google-chrome",
            "google-chrome-stable",
            "chromium",
            "chromium-browser",
        ]
    };
    names
        .iter()
        .find_map(|n| crate::exec::format::find_program(n))
        .filter(|p| is_exe(p))
}

fn is_exe(path: &Path) -> bool {
    path.is_absolute() && path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_name_the_right_browser() {
        let chrome = candidates(false);
        let edge = candidates(true);
        assert!(!chrome.is_empty() && !edge.is_empty());
        assert!(chrome
            .iter()
            .all(|p| !p.to_string_lossy().to_lowercase().contains("edge")));
        assert!(edge
            .iter()
            .all(|p| p.to_string_lossy().to_lowercase().contains("edge")));
    }

    #[cfg(windows)]
    #[test]
    fn both_program_files_folders_are_searched() {
        let chrome: Vec<String> = candidates(false)
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        assert!(chrome.iter().any(|p| p.starts_with("C:\\Program Files\\")));
        assert!(chrome
            .iter()
            .any(|p| p.starts_with("C:\\Program Files (x86)\\")));
    }
}
