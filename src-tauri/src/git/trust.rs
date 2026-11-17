//! Git stays off in a workspace folder until its authors are trusted. Git runs programs a
//! repository's own settings name (`core.fsmonitor` on every `git status`, hooks, filters,
//! `core.sshCommand`, `diff.external`), and no set of `-c` overrides switches all of them off:
//! filters and diff drivers are named freely. So, as VS Code does in restricted mode, the IDE
//! runs no git there at all, whoever asks (the source control view, an agent's tool, a sync
//! snapshot), except the two questions that only read: where the repository is and what its
//! remotes are (a project's sync id is derived from them).
//!
//! A folder is held from the moment it opens (`hold`, before the window knows the answer) and
//! released when the window says the workspace is trusted (`set`). Folders that are not the
//! open workspace's (a clone into a new folder, an extension's download) are never held.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::error::{Error, Result};

/// The held folders, as `guard::key` spells them.
static HELD: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn held() -> std::sync::MutexGuard<'static, Vec<String>> {
    HELD.lock().unwrap_or_else(|e| e.into_inner())
}

/// Holds `folders` too (folders that just opened or joined the workspace).
pub fn hold(folders: &[PathBuf]) {
    let mut list = held();
    for folder in folders {
        let key = super::guard::key(folder);
        if !list.contains(&key) {
            list.push(key);
        }
    }
}

/// The window's answer for the open workspace: trusted releases everything, otherwise exactly
/// `folders` are held.
pub fn set(trusted: bool, folders: &[PathBuf]) {
    held().clear();
    if !trusted {
        hold(folders);
    }
}

/// Releases one folder (tests run side by side and hold their own).
#[cfg(test)]
pub fn release_for_test(folder: &Path) {
    let key = super::guard::key(folder);
    held().retain(|k| *k != key);
}

/// Whether `dir` is in a held folder.
pub fn is_held(dir: &Path) -> bool {
    let list = held();
    if list.is_empty() {
        return false;
    }
    let key = super::guard::key(dir);
    list.iter().any(|folder| super::guard::holds(folder, &key))
}

/// The commands that run nothing a repository names: where it is, and its remotes' addresses.
fn only_reads(args: &[&str]) -> bool {
    match super::guard::subcommand(args) {
        // `git --version` and the like.
        None => true,
        Some("rev-parse") => true,
        Some("remote") => args == ["remote", "-v"],
        Some(_) => false,
    }
}

/// Refuses `git <args>` in a held folder.
pub fn check(dir: &Path, args: &[&str]) -> Result<()> {
    if only_reads(args) || !is_held(dir) {
        return Ok(());
    }
    Err(Error::Git(
        "Git is off until this folder is trusted: it would run the repository's own settings. \
         Trust the folder (Manage workspace trust) to use it."
            .into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_held_folder_runs_only_the_commands_that_read() {
        let base = std::env::temp_dir().join(format!("ide-git-trust-{}", std::process::id()));
        let folder = base.join("held");
        let other = base.join("other");
        std::fs::create_dir_all(folder.join("src")).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        hold(std::slice::from_ref(&folder));
        assert!(is_held(&folder));
        assert!(is_held(&folder.join("src")));
        assert!(!is_held(&other));
        assert!(!is_held(&base));
        for args in [
            &["status", "--porcelain=v2"][..],
            &["diff"],
            &["init"],
            &["fetch", "origin"],
            &["-c", "a=b", "log"],
            &["remote", "add", "x", "ext::sh -c id"],
            &["remote", "update"],
            &["config", "core.fsmonitor", "x"],
        ] {
            assert!(check(&folder.join("src"), args).is_err(), "{args:?}");
            assert!(check(&other, args).is_ok(), "{args:?}");
        }
        for args in [
            &["rev-parse", "--show-toplevel"][..],
            &["remote", "-v"],
            &["--version"],
        ] {
            assert!(check(&folder, args).is_ok(), "{args:?}");
        }
        // Released for this folder alone (other tests hold their own).
        release_for_test(&folder);
        assert!(check(&folder, &["status"]).is_ok());
        let _ = std::fs::remove_dir_all(base);
    }
}
