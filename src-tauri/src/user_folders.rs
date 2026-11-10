//! The user's Downloads, Desktop and temp folders (D213), for the risky-folder checks in the
//! front end (`src/core/security/riskyFolders.ts`): a folder opened there is asked about, and
//! agents stay out of Downloads. Each list holds the folder as the OS reports it and, when it
//! differs, its canonical path (symbolic links resolved, Windows' `\\?\` prefix removed), so the
//! canonical workspace root compares against either.
//!
//! - Windows: the Known Folders (FOLDERID_Downloads, FOLDERID_Desktop) through Tauri's path
//!   resolver (`SHGetKnownFolderPath`), so a Downloads folder moved to another drive is found;
//!   plus `%USERPROFILE%\Downloads`, where browsers fall back to.
//! - macOS: `~/Downloads`, `~/Desktop`.
//! - Linux: `XDG_DOWNLOAD_DIR` / `XDG_DESKTOP_DIR` from `user-dirs.dirs` (parsed here, tested),
//!   and `~/Downloads` too, which some browsers use whatever the XDG name.
//!
//! `IDE_TEST_DOWNLOADS_DIR` replaces the Downloads list (manual tests; UI scripts use the
//! `security.setTestDownloadsFolder` command instead).

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager, Runtime};

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct UserFolders {
    downloads: Vec<String>,
    desktop: Vec<String>,
    temp: Vec<String>,
}

static FOLDERS: OnceLock<UserFolders> = OnceLock::new();

/// The folders, worked out once per process.
pub fn user_folders<R: Runtime>(app: &AppHandle<R>) -> UserFolders {
    FOLDERS.get_or_init(|| resolve(app)).clone()
}

fn resolve<R: Runtime>(app: &AppHandle<R>) -> UserFolders {
    let paths = app.path();
    let home = paths.home_dir().ok();
    let mut downloads: Vec<PathBuf> = Vec::new();
    let mut desktop: Vec<PathBuf> = Vec::new();
    if let Some(dir) = std::env::var_os("IDE_TEST_DOWNLOADS_DIR").filter(|v| !v.is_empty()) {
        downloads.push(PathBuf::from(dir));
    } else {
        #[cfg(target_os = "linux")]
        if let Some(home) = &home {
            let config = std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .filter(|p| p.is_absolute())
                .unwrap_or_else(|| home.join(".config"));
            if let Ok(text) = std::fs::read_to_string(config.join("user-dirs.dirs")) {
                downloads.extend(parse_user_dir(&text, "XDG_DOWNLOAD_DIR", home));
                desktop.extend(parse_user_dir(&text, "XDG_DESKTOP_DIR", home));
            }
        }
        downloads.extend(paths.download_dir().ok());
        downloads.extend(home.as_ref().map(|h| h.join("Downloads")));
    }
    desktop.extend(paths.desktop_dir().ok());
    #[cfg(unix)]
    let temp = vec![
        std::env::temp_dir(),
        PathBuf::from("/tmp"),
        PathBuf::from("/var/tmp"),
    ];
    #[cfg(not(unix))]
    let temp = vec![std::env::temp_dir()];
    UserFolders {
        downloads: with_canonical(downloads),
        desktop: with_canonical(desktop),
        temp: with_canonical(temp),
    }
}

/// Each folder and its canonical form, without repeats (the folder needn't exist).
fn with_canonical(folders: Vec<PathBuf>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |p: &Path| {
        let s = p.to_string_lossy().into_owned();
        if !s.is_empty() && !out.contains(&s) {
            out.push(s);
        }
    };
    for folder in folders {
        push(&folder);
        if let Ok(canonical) = std::fs::canonicalize(&folder) {
            push(&crate::store::simplify(canonical));
        }
    }
    out
}

/// One `XDG_*_DIR="$HOME/…"` line of `user-dirs.dirs` as a path. The format (xdg-user-dirs):
/// `KEY="value"`, the value either `$HOME/relative` or absolute, `\` escaping a character;
/// comments start with `#`. `$HOME` alone is the home folder (what xdg-user-dirs writes for a
/// folder the user turned off) and isn't taken as Downloads.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn parse_user_dir(text: &str, key: &str, home: &Path) -> Option<PathBuf> {
    let mut found = None;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some(rest) = line.strip_prefix(key) else {
            continue;
        };
        let Some(value) = rest.trim_start().strip_prefix('=') else {
            continue;
        };
        let value = value.trim();
        let Some(inner) = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')) else {
            continue;
        };
        let mut unescaped = String::new();
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                if let Some(next) = chars.next() {
                    unescaped.push(next);
                }
            } else {
                unescaped.push(c);
            }
        }
        let path = if let Some(rel) = unescaped.strip_prefix("$HOME") {
            let rel = rel.trim_start_matches('/');
            if rel.is_empty() {
                None
            } else {
                Some(home.join(rel))
            }
        } else if unescaped.starts_with('/') {
            Some(PathBuf::from(unescaped))
        } else {
            None
        };
        // The last line wins, as the shell would read it.
        if path.is_some() {
            found = path;
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_xdg_user_dirs() {
        let home = Path::new("/home/me");
        let text = "# This file is written by xdg-user-dirs-update\n\
XDG_DESKTOP_DIR=\"$HOME/Desktop\"\n\
XDG_DOWNLOAD_DIR=\"$HOME/T\u{e9}l\u{e9}chargements\"\n\
XDG_MUSIC_DIR=\"$HOME\"\n";
        assert_eq!(
            parse_user_dir(text, "XDG_DOWNLOAD_DIR", home),
            Some(PathBuf::from("/home/me/T\u{e9}l\u{e9}chargements"))
        );
        assert_eq!(
            parse_user_dir(text, "XDG_DESKTOP_DIR", home),
            Some(PathBuf::from("/home/me/Desktop"))
        );
        // `$HOME` alone: the folder is turned off, not the home folder.
        assert_eq!(parse_user_dir(text, "XDG_MUSIC_DIR", home), None);
        assert_eq!(parse_user_dir(text, "XDG_VIDEOS_DIR", home), None);
    }

    #[test]
    fn parses_absolute_escaped_and_commented_values() {
        let home = Path::new("/home/me");
        let text = "#XDG_DOWNLOAD_DIR=\"/nope\"\n  XDG_DOWNLOAD_DIR = \"/data/My \\\"dl\\\"\"\n";
        assert_eq!(
            parse_user_dir(text, "XDG_DOWNLOAD_DIR", home),
            Some(PathBuf::from("/data/My \"dl\""))
        );
        // A relative value isn't valid; an unquoted one isn't either.
        assert_eq!(
            parse_user_dir("XDG_DOWNLOAD_DIR=\"dl\"\n", "XDG_DOWNLOAD_DIR", home),
            None
        );
        assert_eq!(
            parse_user_dir("XDG_DOWNLOAD_DIR=$HOME/dl\n", "XDG_DOWNLOAD_DIR", home),
            None
        );
        // A longer key with the same start isn't this one.
        assert_eq!(
            parse_user_dir("XDG_DOWNLOAD_DIRS=\"/x\"\n", "XDG_DOWNLOAD_DIR", home),
            None
        );
        // The last line wins.
        assert_eq!(
            parse_user_dir(
                "XDG_DOWNLOAD_DIR=\"/a\"\nXDG_DOWNLOAD_DIR=\"$HOME/b/\"\n",
                "XDG_DOWNLOAD_DIR",
                home
            ),
            Some(PathBuf::from("/home/me/b/"))
        );
    }

    #[test]
    fn keeps_each_folder_once_with_its_canonical_form() {
        let dir = std::env::temp_dir();
        let list = with_canonical(vec![
            dir.clone(),
            dir.clone(),
            PathBuf::from("/no/such/dir"),
        ]);
        assert!(list.contains(&dir.to_string_lossy().into_owned()));
        assert!(list.contains(&"/no/such/dir".to_string()) || cfg!(windows));
        let mut sorted = list.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), list.len());
    }
}
