//! Extensions from elsewhere (D185): a git repository cloned shallowly into a scratch folder
//! beside the installed extensions (the frontend finds the extension folders in it, installs one
//! through `install`, then discards the download), and GitHub avatars of extension authors,
//! cached for a week.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::ExtensionStore;
use crate::error::{Error, Result};

const DOWNLOADS: &str = ".downloads";
const AVATARS: &str = ".avatars";
/// Downloads older than this are cleared on the next one (a crash mid-install leaves them).
const STALE_DOWNLOAD: Duration = Duration::from_secs(24 * 60 * 60);
pub const AVATAR_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
pub const AVATAR_MAX_BYTES: usize = 1024 * 1024;

impl ExtensionStore {
    pub(super) fn downloads(&self) -> PathBuf {
        self.dir.join(DOWNLOADS)
    }

    /// `git clone --depth 1 [--branch <reference>] -- <url>` into a new scratch folder; its
    /// `.git` is removed (only the files are wanted). Returns the folder.
    pub fn download_git(&self, url: &str, reference: Option<&str>) -> Result<PathBuf> {
        let url = url.trim();
        // `ext::` / `fd::` transports run commands: refused like option-looking input.
        if url.is_empty()
            || url.starts_with('-')
            || url.contains("::")
            || url.chars().any(char::is_control)
        {
            return Err(Error::Invalid("That isn't a repository URL.".into()));
        }
        let reference = reference.map(str::trim).filter(|r| !r.is_empty());
        if let Some(r) = reference {
            let ok = !r.starts_with('-')
                && r.len() <= 200
                && r.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'));
            if !ok {
                return Err(Error::Invalid(format!(
                    "\"{r}\" isn't a branch or tag name."
                )));
            }
        }
        let parent = self.downloads();
        fs::create_dir_all(&parent)?;
        clear_stale(&parent);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
            .to_string();
        let mut args = vec!["clone", "--depth", "1", "--quiet"];
        if let Some(r) = reference {
            args.extend(["--branch", r]);
        }
        args.extend(["--", url, &stamp]);
        let dest = parent.join(&stamp);
        if let Err(e) = crate::git::ops::remote_op(&parent, &args, |_| {}) {
            let _ = remove_tree(&dest);
            return Err(e);
        }
        if let Err(e) = remove_tree(&dest.join(".git")) {
            let _ = remove_tree(&dest);
            return Err(e);
        }
        Ok(dest)
    }

    /// Deletes a folder `download_git` made (nothing else).
    pub fn discard_download(&self, folder: &str) -> Result<()> {
        let path = fs::canonicalize(folder)?;
        let parent = fs::canonicalize(self.downloads())?;
        if path.parent() != Some(parent.as_path()) {
            return Err(Error::Invalid(format!(
                "{} isn't a download",
                path.display()
            )));
        }
        remove_tree(&path)
    }

    /// Where a GitHub user's avatar is cached; the login is checked (GitHub's own rules).
    pub fn avatar_path(&self, login: &str) -> Result<PathBuf> {
        let ok = !login.is_empty()
            && login.len() <= 39
            && !login.starts_with('-')
            && login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        if !ok {
            return Err(Error::Invalid(format!(
                "\"{login}\" isn't a GitHub user name."
            )));
        }
        Ok(self
            .dir
            .join(AVATARS)
            .join(format!("{}.img", login.to_ascii_lowercase())))
    }
}

/// The extension folders in a download, relative ("" for the top): folders with an
/// extension.json, or a VS Code extension's package.json; three levels deep at most (a catalog
/// repository keeps one per folder, maybe under `extensions/`).
pub fn find_manifests(root: &Path) -> Vec<String> {
    fn walk(root: &Path, dir: &Path, depth: usize, seen: &mut usize, out: &mut Vec<String>) {
        *seen += 1;
        if *seen > 2000 || out.len() >= 200 {
            return;
        }
        let rel = || {
            dir.strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default()
        };
        if dir.join("extension.json").is_file() {
            out.push(rel());
            return;
        }
        let vscode = fs::read_to_string(dir.join("package.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .is_some_and(|v| v["engines"]["vscode"].is_string() && v["contributes"].is_object());
        if vscode {
            out.push(rel());
            return;
        }
        if depth == 3 {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        let mut dirs: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter(|e| {
                let name = e.file_name();
                let name = name.to_string_lossy();
                !name.starts_with('.') && name != "node_modules"
            })
            .map(|e| e.path())
            .collect();
        dirs.sort();
        for d in dirs {
            walk(root, &d, depth + 1, seen, out);
        }
    }
    let mut out = Vec::new();
    walk(root, root, 0, &mut 0, &mut out);
    out
}

/// Downloads left behind by an install that didn't finish.
fn clear_stale(parent: &Path) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > STALE_DOWNLOAD);
        if old {
            let _ = remove_tree(&entry.path());
        }
    }
}

/// `remove_dir_all`, also when files are read-only (git's objects are, on Windows).
pub fn remove_tree(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    // A downloaded .vsix (the store's, D254) is one file.
    if path.is_file() {
        fs::remove_file(path)?;
        return Ok(());
    }
    if fs::remove_dir_all(path).is_ok() {
        return Ok(());
    }
    make_writable(path);
    fs::remove_dir_all(path)?;
    Ok(())
}

fn make_writable(path: &Path) {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.is_dir() {
            if let Ok(entries) = fs::read_dir(path) {
                for entry in entries.filter_map(|e| e.ok()) {
                    make_writable(&entry.path());
                }
            }
        }
        let mut perms = meta.permissions();
        if perms.readonly() && !meta.file_type().is_symlink() {
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            let _ = fs::set_permissions(path, perms);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ide-dl-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git(dir: &Path, args: &[&str]) -> bool {
        std::process::Command::new("git")
            .env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR)
            .args(args)
            .current_dir(dir)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn downloads_a_repository_without_its_history() {
        let repo = temp("repo");
        fs::create_dir_all(repo.join("hello")).unwrap();
        fs::write(repo.join("hello/extension.json"), r#"{"id":"acme.hello"}"#).unwrap();
        let ok = git(&repo, &["init", "-q", "-b", "main"])
            && git(
                &repo,
                &["-c", "user.email=t@e.st", "-c", "user.name=T", "add", "."],
            )
            && git(
                &repo,
                &[
                    "-c",
                    "user.email=t@e.st",
                    "-c",
                    "user.name=T",
                    "commit",
                    "-qm",
                    "x",
                ],
            );
        if !ok {
            eprintln!("git isn't available: skipped");
            return;
        }
        let store = ExtensionStore::new(&temp("data"));
        let url = repo.to_string_lossy().into_owned();
        let folder = store.download_git(&url, Some("main")).unwrap();
        assert!(folder.join("hello/extension.json").is_file());
        assert_eq!(find_manifests(&folder), ["hello"]);
        assert!(!folder.join(".git").exists());
        // Only its own downloads can be discarded.
        assert!(store.discard_download(repo.to_str().unwrap()).is_err());
        store.discard_download(folder.to_str().unwrap()).unwrap();
        assert!(!folder.exists());
        // Option-like input is refused before git sees it.
        assert!(store.download_git("--upload-pack=x", None).is_err());
        assert!(store
            .download_git("ext::sh -c touch% /tmp/pwned", None)
            .is_err());
        assert!(store.download_git(&url, Some("--evil")).is_err());
        assert!(store.download_git(&url, Some("no-such-branch")).is_err());
    }

    #[test]
    fn avatar_logins_are_checked() {
        let store = ExtensionStore::new(&temp("data-avatar"));
        assert!(store
            .avatar_path("Tezumie")
            .unwrap()
            .ends_with("tezumie.img"));
        assert!(store.avatar_path("../x").is_err());
        assert!(store.avatar_path("-x").is_err());
        assert!(store.avatar_path("").is_err());
    }
}
