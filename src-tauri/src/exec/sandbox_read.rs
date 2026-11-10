//! What a sandboxed command may not read (D349): the user's secrets, from `agent.sandbox.denyRead`
//! (the webview sends the list). Entries are paths (`~/` is the home folder) or one of:
//!
//! - `${secrets}`: the IDE's own secrets file (`<data>/secrets.json`);
//! - `${browserProfiles}`: the browsers' profile folders (cookies, saved passwords);
//! - `${keychains}`: the keychain files (macOS Keychains, GNOME keyring, pass);
//! - `${envFiles}`: `.env*` files outside the command's folders (macOS: all of them, by pattern;
//!   Linux and Windows: those in the home folder and the folder's parents, found each run).
//!
//! How each system hides them: macOS `(deny file-read* …)` in the sandbox-exec profile; Linux an
//! empty tmpfs over a folder and /dev/null over a file in bubblewrap; Windows a mandatory label
//! (medium, no-read-up) on each, set once and recorded, so the low-integrity command can't read
//! them while the user's own programs (medium) still can (`windows_hide`). A path that holds one
//! of the command's own folders is skipped (it would hide the work itself).

use std::path::{Path, PathBuf};

/// The paths to hide from one command, and whether `.env*` files outside its folders are hidden
/// by pattern (macOS).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ReadLimits {
    pub paths: Vec<PathBuf>,
    pub env_pattern: bool,
}

/// The browsers' profile folders under `home`, per system (none on Windows: see the decision —
/// the browsers' own sandboxed processes run at low integrity and read their profile).
fn browser_profiles(home: &Path) -> Vec<PathBuf> {
    let rel: &[&str] = if cfg!(target_os = "macos") {
        &[
            "Library/Application Support/Google/Chrome",
            "Library/Application Support/Chromium",
            "Library/Application Support/Microsoft Edge",
            "Library/Application Support/BraveSoftware",
            "Library/Application Support/Arc",
            "Library/Application Support/Firefox",
            "Library/Safari",
            "Library/Cookies",
        ]
    } else if cfg!(windows) {
        &[]
    } else {
        &[
            ".config/google-chrome",
            ".config/chromium",
            ".config/microsoft-edge",
            ".config/BraveSoftware",
            ".mozilla",
            "snap/firefox/common/.mozilla",
            "snap/chromium/common/chromium",
        ]
    };
    rel.iter().map(|r| home.join(r)).collect()
}

/// The keychains' files (none on Windows: Credential Manager isn't a file a label can cover).
fn keychains(home: &Path) -> Vec<PathBuf> {
    let rel: &[&str] = if cfg!(target_os = "macos") {
        &["Library/Keychains"]
    } else if cfg!(windows) {
        &[]
    } else {
        &[".local/share/keyrings", ".password-store"]
    };
    rel.iter().map(|r| home.join(r)).collect()
}

/// `.env*` files directly in `dir`.
fn env_files_in(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| {
            e.file_name().to_string_lossy().starts_with(".env")
                && e.file_type().map(|t| t.is_file()).unwrap_or(false)
        })
        .map(|e| e.path())
        .collect()
}

/// `a/b/../c` as `a/c` (without touching the disk: the path may not exist).
pub(crate) fn lexical(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                if !out.pop() {
                    out.push(c);
                }
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// `entries` as paths for a command that writes `writable` (its first is its folder).
pub fn expand(
    entries: &[String],
    home: Option<&Path>,
    data_dir: Option<&Path>,
    writable: &[PathBuf],
) -> ReadLimits {
    let mut out = ReadLimits::default();
    let add = |p: PathBuf, out: &mut ReadLimits| {
        if !out.paths.contains(&p) {
            out.paths.push(p);
        }
    };
    for raw in entries {
        let e = raw.trim();
        match e {
            "" => {}
            "${secrets}" => {
                if let Some(d) = data_dir {
                    add(d.join("secrets.json"), &mut out);
                }
            }
            "${browserProfiles}" => {
                for p in home.map(browser_profiles).unwrap_or_default() {
                    add(p, &mut out);
                }
            }
            "${keychains}" => {
                for p in home.map(keychains).unwrap_or_default() {
                    add(p, &mut out);
                }
            }
            "${envFiles}" => {
                if cfg!(target_os = "macos") {
                    out.env_pattern = true;
                } else {
                    let mut dirs: Vec<PathBuf> = home.map(Path::to_path_buf).into_iter().collect();
                    for w in writable {
                        dirs.extend(w.ancestors().skip(1).map(Path::to_path_buf));
                    }
                    for d in dirs {
                        for f in env_files_in(&d) {
                            add(f, &mut out);
                        }
                    }
                }
            }
            _ => {
                let p = if e == "~" {
                    home.map(Path::to_path_buf)
                } else if let Some(rest) = e.strip_prefix("~/").or_else(|| e.strip_prefix("~\\")) {
                    home.map(|h| h.join(rest))
                } else {
                    Some(PathBuf::from(e)).filter(|p| p.is_absolute())
                };
                if let Some(p) = p {
                    add(lexical(&p), &mut out);
                }
            }
        }
    }
    // A path that holds one of the command's folders would hide its work: skipped. A file in
    // a folder the command writes is still hidden (`.env` files there are the command's own,
    // but they're only added when they're outside).
    out.paths.retain(|p| {
        !writable.iter().any(|w| w.starts_with(p))
            && !(is_env_file(p) && writable.iter().any(|w| p.starts_with(w)))
    });
    out
}

/// A `.env*` file (those inside the command's folders are its own).
fn is_env_file(p: &Path) -> bool {
    p.file_name()
        .map(|n| n.to_string_lossy().starts_with(".env"))
        .unwrap_or(false)
}

/// The macOS profile's read rules (after the write rules): `.env*` files by pattern except in
/// the writable folders, then each path.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn macos_rules(limits: &ReadLimits, writable: &[PathBuf]) -> String {
    let mut out = String::new();
    if limits.env_pattern {
        out.push_str("(deny file-read* (regex #\"/\\.env[^/]*$\"))\n");
        if !writable.is_empty() {
            out.push_str("(allow file-read*");
            for w in writable {
                out.push_str(&format!(
                    "\n  (subpath {})",
                    super::sandbox::sbpl_string(&w.to_string_lossy())
                ));
            }
            out.push_str(")\n");
        }
    }
    if !limits.paths.is_empty() {
        out.push_str("(deny file-read*");
        for p in &limits.paths {
            out.push_str(&format!(
                "\n  (subpath {})",
                super::sandbox::sbpl_string(&p.to_string_lossy())
            ));
        }
        out.push_str(")\n");
    }
    out
}

/// bubblewrap's arguments that hide the paths that exist: an empty tmpfs over a folder,
/// /dev/null over a file. They go after the binds, so they cover what's under them too.
#[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
pub fn bwrap_hide_args(limits: &ReadLimits) -> Vec<String> {
    let mut args = Vec::new();
    for p in &limits.paths {
        let s = p.to_string_lossy().to_string();
        if p.is_dir() {
            args.extend(["--tmpfs".to_string(), s]);
        } else if p.exists() {
            args.extend(["--ro-bind".to_string(), "/dev/null".to_string(), s]);
        }
    }
    args
}

/// Windows (D349): hiding with a mandatory label. Each path gets an explicit medium label with
/// no-read-up (`S:(ML;OICI;NRNW;;;ME)`, inherited by what's in a folder): medium programs (the
/// user's own) read it as before, a low-integrity one (the sandboxed command) can't. Set once;
/// the path's label before is recorded in `<data>/sandbox-hidden.json`, and `unhide_all` puts
/// every recorded one back (the setting's "Show my secrets to sandboxed commands again").
#[cfg(windows)]
pub mod windows_hide {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    use super::super::sandbox::windows_low::{label_text, set_label};

    const RECORD: &str = "sandbox-hidden.json";
    const DIR_LABEL: &str = "S:(ML;OICI;NRNW;;;ME)";
    const FILE_LABEL: &str = "S:(ML;;NRNW;;;ME)";

    fn record_path(data: &Path) -> PathBuf {
        data.join(RECORD)
    }

    fn load(data: &Path) -> BTreeMap<String, String> {
        std::fs::read_to_string(record_path(data))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    fn save(data: &Path, all: &BTreeMap<String, String>) -> std::io::Result<()> {
        let text = serde_json::to_string_pretty(all).map_err(std::io::Error::other)?;
        crate::store::atomic_write(&record_path(data), text.as_bytes())
            .map_err(|e| std::io::Error::other(e.to_string()))
    }

    /// Whether `path` is hidden already (a no-read-up label at medium or above).
    pub fn is_hidden(path: &Path) -> bool {
        label_text(path)
            .map(|s| {
                s.split('(').any(|ace| {
                    ace.starts_with("ML;")
                        && ace.contains("NR")
                        && (ace.contains(";;;ME") || ace.contains(";;;HI") || ace.contains(";;;SI"))
                })
            })
            .unwrap_or(false)
    }

    /// Hides the existing `paths`; what it couldn't hide comes back as one line each.
    pub fn hide_all(paths: &[PathBuf], data: &Path) -> Vec<String> {
        let mut notes = Vec::new();
        let mut record = load(data);
        let mut changed = false;
        for p in paths {
            if !p.exists() || is_hidden(p) {
                continue;
            }
            let before = label_text(p).unwrap_or_default();
            let label = if p.is_dir() { DIR_LABEL } else { FILE_LABEL };
            match set_label(p, label) {
                Ok(()) => {
                    record
                        .entry(p.to_string_lossy().to_string())
                        .or_insert(before);
                    changed = true;
                }
                Err(e) => notes.push(format!(
                    "couldn't hide {} from the sandbox: {e}",
                    p.display()
                )),
            }
        }
        if changed {
            if let Err(e) = save(data, &record) {
                notes.push(format!("couldn't record the hidden paths: {e}"));
            }
        }
        notes
    }

    /// Puts back the label each recorded path had; returns the paths done. A path whose label
    /// was inherited (or none) gets an empty label, inheriting again.
    pub fn unhide_all(data: &Path) -> std::io::Result<Vec<String>> {
        let record = load(data);
        let mut done = Vec::new();
        let mut left = BTreeMap::new();
        for (path, before) in record {
            let p = PathBuf::from(&path);
            if !p.exists() {
                continue;
            }
            // Only explicit label ACEs are put back; inherited ones (ID) come back by themselves.
            let explicit: String = before
                .split('(')
                .filter(|a| {
                    a.starts_with("ML;") && !a.split(';').nth(1).unwrap_or("").contains("ID")
                })
                .map(|a| format!("({a}"))
                .collect();
            let restored = if explicit.is_empty() {
                set_label(&p, "S:")
            } else {
                set_label(&p, &format!("S:{explicit}"))
            };
            match restored {
                Ok(()) => done.push(path),
                Err(_) => {
                    left.insert(path, before);
                }
            }
        }
        save(data, &left)?;
        Ok(done)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_expand_to_paths_and_skip_what_holds_the_folder() {
        let home = PathBuf::from(if cfg!(windows) {
            "C:\\Users\\me"
        } else {
            "/home/me"
        });
        let data = home.join("data");
        let work = home.join("work").join("app");
        let entries: Vec<String> = [
            "~/.ssh",
            "~",
            "${secrets}",
            "",
            "relative/x",
            "${keychains}",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let l = expand(
            &entries,
            Some(&home),
            Some(&data),
            std::slice::from_ref(&work),
        );
        assert_eq!(l.paths[0], home.join(".ssh"));
        let up = expand(&[format!("{}/../secret", work.display())], None, None, &[]);
        assert_eq!(up.paths, vec![home.join("work").join("secret")]);
        // `~` holds the folder: skipped. A relative path means nothing: skipped.
        assert!(!l.paths.contains(&home));
        assert!(l.paths.contains(&data.join("secrets.json")));
        if cfg!(target_os = "macos") {
            assert!(l.paths.contains(&home.join("Library/Keychains")));
        }
        if cfg!(windows) {
            assert_eq!(l.paths.len(), 2);
        }
    }

    #[test]
    fn env_files_outside_the_folder_are_found_and_the_folders_own_are_not() {
        let base = std::env::temp_dir().join(format!("ide-envfiles-{}", std::process::id()));
        let work = base.join("app");
        let _ = std::fs::create_dir_all(&work);
        let _ = std::fs::write(base.join(".env.production"), "x");
        let _ = std::fs::write(work.join(".env"), "x");
        let l = expand(
            &["${envFiles}".to_string()],
            None,
            None,
            std::slice::from_ref(&work),
        );
        if cfg!(target_os = "macos") {
            assert!(l.env_pattern);
        } else {
            assert!(l.paths.contains(&base.join(".env.production")), "{l:?}");
            assert!(!l.paths.contains(&work.join(".env")));
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_macos_rules_deny_env_files_but_the_folders_then_each_path() {
        let l = ReadLimits {
            paths: vec![PathBuf::from("/Users/me/.ssh")],
            env_pattern: true,
        };
        let r = macos_rules(&l, &[PathBuf::from("/Users/me/app")]);
        let env = r.find("(deny file-read* (regex").unwrap_or(usize::MAX);
        let allow = r.find("(allow file-read*").unwrap_or(0);
        let deny = r.find("(subpath \"/Users/me/.ssh\")").unwrap_or(0);
        assert!(env < allow && allow < deny, "{r}");
    }

    #[test]
    fn bubblewrap_hides_folders_with_tmpfs_and_files_with_dev_null() {
        let base = std::env::temp_dir().join(format!("ide-bwraphide-{}", std::process::id()));
        let _ = std::fs::create_dir_all(base.join("dir"));
        let _ = std::fs::write(base.join("file"), "x");
        let l = ReadLimits {
            paths: vec![base.join("dir"), base.join("file"), base.join("missing")],
            env_pattern: false,
        };
        let a = bwrap_hide_args(&l);
        assert_eq!(a.len(), 5, "{a:?}");
        assert_eq!(a[0], "--tmpfs");
        assert_eq!(&a[2..4], ["--ro-bind", "/dev/null"]);
        let _ = std::fs::remove_dir_all(&base);
    }
}
