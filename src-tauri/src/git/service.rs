//! The open repositories: the workspace's own (found from the workspace root, which may be a
//! subfolder of it) and, D204, the repositories found inside the workspace (nested ones and
//! submodules, `discover`). Commands name one of them by its root (`repo`), or none for the
//! workspace's; anything else is refused, so a command can't be pointed at an arbitrary folder.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, RwLock};

use serde::Serialize;
use tauri::ipc::Channel;

use super::watch::GitWatcher;
use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Absolute repository root (paths in status are relative to it, with `/`).
    pub root: String,
    pub git_dir: String,
}

/// A repository found inside the workspace (D204).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundRepo {
    pub root: String,
    pub git_dir: String,
    /// "submodule" (listed by `git submodule status`), "nested", or "folder" (the repository of
    /// another folder of a multi-root workspace).
    pub kind: &'static str,
}

/// One repository's root and git directory.
#[derive(Debug, Clone)]
pub struct Repo {
    pub root: PathBuf,
    pub git_dir: PathBuf,
}

#[derive(Default)]
pub struct GitService {
    repo: RwLock<Option<(PathBuf, PathBuf)>>,
    /// Repositories found inside the workspace (not the workspace's own).
    extra: RwLock<Vec<(PathBuf, PathBuf)>>,
    watcher: GitWatcher,
    /// The found repositories' watchers, by root.
    extra_watchers: Mutex<HashMap<PathBuf, GitWatcher>>,
}

fn poisoned() -> Error {
    Error::Invalid("git lock poisoned".into())
}

fn no_repo() -> Error {
    Error::Git("This folder isn't a git repository.".into())
}

/// Two paths name the same folder (case-insensitive on Windows, either separator).
fn same_dir(a: &Path, b: &Path) -> bool {
    let norm = |p: &Path| {
        let s = p.to_string_lossy().replace('\\', "/");
        let s = s.trim_end_matches('/').to_string();
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s
        }
    };
    if norm(a) == norm(b) {
        return true;
    }
    // The same folder spelled two ways: Windows' short 8.3 names (`C:\Users\RUNNER~1\…`, a
    // user name over 8 letters) against git's long ones, or a link. Resolved, they agree.
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => norm(&x) == norm(&y),
        _ => false,
    }
}

/// Folders never looked into for repositories (VS Code's git.repositoryScanIgnoredFolders).
const SKIPPED: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    ".venv",
    "venv",
    "dist",
    "build",
];

/// Folders under `root` (to `max_depth` levels down, not `root` itself) holding a `.git`
/// directory or file; `ignored` names more folders to skip. Sorted, at most `limit`.
pub fn scan_for_repos(
    root: &Path,
    max_depth: u32,
    ignored: &[String],
    limit: usize,
) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut level = vec![root.to_path_buf()];
    // A remote window's folders are listed there (D252), a request per folder.
    let remote = crate::remote::of_dir(root).is_some();
    for _ in 0..max_depth {
        let mut next = Vec::new();
        for dir in &level {
            let mut children: Vec<PathBuf> = if remote {
                crate::remote::subdirs_blocking(&crate::remote::posix(dir))
                    .into_iter()
                    .map(PathBuf::from)
                    .collect()
            } else {
                let Ok(entries) = std::fs::read_dir(dir) else {
                    continue;
                };
                entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                    .map(|e| e.path())
                    .collect()
            };
            children.sort();
            for child in children {
                let name = child
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if SKIPPED.contains(&name.as_str()) || ignored.iter().any(|i| i == &name) {
                    continue;
                }
                let has_git = if remote {
                    crate::remote::kind_blocking(&crate::remote::join(
                        &crate::remote::posix(&child),
                        ".git",
                    ))
                    .is_some()
                } else {
                    child.join(".git").exists()
                };
                if has_git {
                    found.push(child.clone());
                    if found.len() >= limit {
                        return found;
                    }
                }
                next.push(child);
            }
        }
        level = next;
    }
    found
}

/// The submodule paths `git submodule status --recursive` lists (relative to `root`).
pub fn parse_submodule_status(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| {
            // " <sha> path (describe)", "-<sha> path" (not initialized), "+<sha> path", "U<sha> path".
            let rest = line.get(1..)?;
            let mut parts = rest.splitn(2, ' ');
            let _sha = parts.next()?;
            let tail = parts.next()?.trim();
            let path = match tail.rfind(" (") {
                Some(i) if tail.ends_with(')') => &tail[..i],
                _ => tail,
            };
            (!path.is_empty() && !line.starts_with('-')).then(|| path.to_string())
        })
        .collect()
}

/// The repositories inside `workspace` besides `primary` (blocking: scans folders, runs git):
/// the submodules of `primary` (at most 10, like VS Code's git.detectSubmodulesLimit) and
/// folders with their own `.git` down to `max_depth` levels.
pub fn find_repos(
    primary: Option<&Repo>,
    workspace: &Path,
    max_depth: u32,
    ignored: &[String],
    submodules: bool,
) -> Vec<FoundRepo> {
    let mut out: Vec<FoundRepo> = Vec::new();
    let mut add = |root: PathBuf, kind: &'static str| {
        let dup = |r: &str| same_dir(Path::new(r), &root);
        if primary.is_some_and(|p| same_dir(&p.root, &root)) || out.iter().any(|f| dup(&f.root)) {
            return;
        }
        // The folder's own repository (not one above it that ignores it).
        let Some(top) = super::repo_root(&root) else {
            return;
        };
        if !same_dir(&top, &root) {
            return;
        }
        if let Some(dir) = super::git_dir(&top) {
            out.push(FoundRepo {
                root: top.to_string_lossy().into_owned(),
                git_dir: dir.to_string_lossy().into_owned(),
                kind,
            });
        }
    };
    if submodules {
        if let Some(p) = primary {
            let text = super::run(&p.root, &["submodule", "status", "--recursive"], None)
                .unwrap_or_default();
            for rel in parse_submodule_status(&text).into_iter().take(10) {
                add(p.root.join(rel), "submodule");
            }
        }
    }
    for dir in scan_for_repos(workspace, max_depth.min(8), ignored, 50) {
        add(dir, "nested");
    }
    out
}

/// The repository holding `dir` (its enclosing repository's top level, as `git_open` finds the
/// root's); None outside one.
pub fn repo_of(dir: &Path) -> Option<Repo> {
    let root = super::repo_root(dir)?;
    let git_dir = super::git_dir(&root)?;
    Some(Repo { root, git_dir })
}

/// The repositories of a multi-root workspace besides `primary` (blocking): each other folder's
/// own repository first (kind "folder", unless it's the primary's), then the submodules and
/// nested repositories of the root (`find_repos`), then those of each other folder. Each
/// repository once.
pub fn find_workspace_repos(
    primary: Option<&Repo>,
    root: &Path,
    others: &[PathBuf],
    max_depth: u32,
    ignored: &[String],
    submodules: bool,
) -> Vec<FoundRepo> {
    let mut out: Vec<FoundRepo> = Vec::new();
    let push = |out: &mut Vec<FoundRepo>, found: FoundRepo| {
        let at = Path::new(&found.root);
        if primary.is_some_and(|p| same_dir(&p.root, at))
            || out.iter().any(|f| same_dir(Path::new(&f.root), at))
        {
            return;
        }
        out.push(found);
    };
    let folder_repos: Vec<Option<Repo>> = others.iter().map(|f| repo_of(f)).collect();
    for repo in folder_repos.iter().flatten() {
        push(
            &mut out,
            FoundRepo {
                root: repo.root.to_string_lossy().into_owned(),
                git_dir: repo.git_dir.to_string_lossy().into_owned(),
                kind: "folder",
            },
        );
    }
    for found in find_repos(primary, root, max_depth, ignored, submodules) {
        push(&mut out, found);
    }
    for (folder, repo) in others.iter().zip(&folder_repos) {
        for found in find_repos(repo.as_ref(), folder, max_depth, ignored, submodules) {
            push(&mut out, found);
        }
    }
    out
}

impl GitService {
    /// Looks for the repository containing `workspace`; None if there is none (or no git).
    pub fn open(&self, workspace: &Path) -> Result<Option<RepoInfo>> {
        // Paused (D392): said as such, not as "no repository" (`repo_root` drops the error).
        if crate::remote::of_dir(workspace).is_none() && crate::wsl::of_dir(workspace).is_none() {
            super::guard::check(workspace)?;
        }
        let found = super::repo_root(workspace)
            .and_then(|root| super::git_dir(&root).map(|dir| (root, dir)));
        let info = found.as_ref().map(|(root, dir)| RepoInfo {
            root: root.to_string_lossy().into_owned(),
            git_dir: dir.to_string_lossy().into_owned(),
        });
        if found.is_none() {
            self.watcher.stop()?;
        }
        *self.repo.write().map_err(|_| poisoned())? = found;
        Ok(info)
    }

    /// The workspace's own repository, if one is open.
    pub fn primary(&self) -> Option<Repo> {
        self.at(None).ok()
    }

    /// Remembers the repositories `find_repos` found (the old set is replaced; watchers of
    /// repositories no longer listed stop).
    pub fn set_found(&self, found: &[FoundRepo]) -> Result<()> {
        let roots: Vec<(PathBuf, PathBuf)> = found
            .iter()
            .map(|f| (PathBuf::from(&f.root), PathBuf::from(&f.git_dir)))
            .collect();
        {
            let mut watchers = self.extra_watchers.lock().map_err(|_| poisoned())?;
            watchers.retain(|root, w| {
                let keep = roots.iter().any(|(r, _)| same_dir(r, root));
                if !keep {
                    let _ = w.stop();
                }
                keep
            });
        }
        *self.extra.write().map_err(|_| poisoned())? = roots;
        Ok(())
    }

    /// Adds one repository to the found ones (a workspace folder's, just made by `git init`), so
    /// commands may name it before the next `discover`.
    pub fn add_found(&self, repo: &Repo) -> Result<()> {
        let mut extra = self.extra.write().map_err(|_| poisoned())?;
        if !extra.iter().any(|(root, _)| same_dir(root, &repo.root)) {
            extra.push((repo.root.clone(), repo.git_dir.clone()));
        }
        Ok(())
    }

    /// The repository a command names: `repo` is a root `discover` found, or None / "" for the
    /// workspace's own. Anything else is refused.
    pub fn at(&self, repo: Option<&str>) -> Result<Repo> {
        let primary = self.repo.read().map_err(|_| poisoned())?.clone();
        match repo.filter(|r| !r.is_empty()) {
            None => primary
                .map(|(root, git_dir)| Repo { root, git_dir })
                .ok_or_else(no_repo),
            Some(r) => {
                let wanted = Path::new(r);
                if let Some((root, git_dir)) = primary.filter(|(p, _)| same_dir(p, wanted)) {
                    return Ok(Repo { root, git_dir });
                }
                self.extra
                    .read()
                    .map_err(|_| poisoned())?
                    .iter()
                    .find(|(root, _)| same_dir(root, wanted))
                    .map(|(root, git_dir)| Repo {
                        root: root.clone(),
                        git_dir: git_dir.clone(),
                    })
                    .ok_or_else(|| Error::Git(format!("{r} isn't one of the open repositories.")))
            }
        }
    }

    pub fn watch(&self, repo: Option<&str>, channel: Channel<()>) -> Result<()> {
        let at = self.at(repo)?;
        let primary = self.at(None).ok();
        if primary.is_some_and(|p| same_dir(&p.root, &at.root)) {
            return self.watcher.start(&at.git_dir, channel);
        }
        let mut watchers = self.extra_watchers.lock().map_err(|_| poisoned())?;
        watchers
            .entry(at.root.clone())
            .or_default()
            .start(&at.git_dir, channel)
    }
}

pub fn rel_path(root: &Path, path: &str) -> Result<String> {
    let p = Path::new(path);
    // `has_root`: a remote window's POSIX path (D252) isn't absolute on Windows, but rooted.
    let rel = if p.is_absolute() || (p.has_root() && crate::remote::is_remote_path(path)) {
        p.strip_prefix(root)
            .map_err(|_| Error::OutsideScope(path.to_string()))?
            .to_path_buf()
    } else {
        p.to_path_buf()
    };
    if rel
        .components()
        .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(Error::OutsideScope(path.to_string()));
    }
    let parts: Vec<String> = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    if parts.is_empty() {
        return Ok(".".into());
    }
    Ok(parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submodule_status_lines_give_their_paths() {
        let text = " 1234abcd libs/one (v1.0)\n+5678abcd libs/two (heads/main)\n-9abc0000 not/initialized\nU0000aaaa conflicted\n";
        assert_eq!(
            parse_submodule_status(text),
            vec!["libs/one", "libs/two", "conflicted"]
        );
        assert!(parse_submodule_status("").is_empty());
    }

    #[test]
    fn scan_finds_folders_with_their_own_git_to_the_depth_asked() {
        let dir = std::env::temp_dir().join(format!("scan-repos-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for p in ["a/.git", "b/c/.git", "node_modules/x/.git", "d"] {
            std::fs::create_dir_all(dir.join(p)).unwrap();
        }
        // A submodule-style `.git` file counts too.
        std::fs::create_dir_all(dir.join("e")).unwrap();
        std::fs::write(dir.join("e/.git"), "gitdir: ../.git/modules/e").unwrap();
        let names = |found: Vec<PathBuf>| {
            found
                .iter()
                .map(|p| {
                    p.strip_prefix(&dir)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/")
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(names(scan_for_repos(&dir, 1, &[], 50)), vec!["a", "e"]);
        assert_eq!(
            names(scan_for_repos(&dir, 2, &[], 50)),
            vec!["a", "e", "b/c"]
        );
        assert_eq!(
            names(scan_for_repos(&dir, 2, &["b".into()], 50)),
            vec!["a", "e"]
        );
        assert!(scan_for_repos(&dir, 0, &[], 50).is_empty());
        assert_eq!(scan_for_repos(&dir, 2, &[], 1).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn same_dir_ignores_separators_and_trailing_slashes() {
        assert!(same_dir(Path::new("/a/b/"), Path::new("/a/b")));
        assert!(!same_dir(Path::new("/a/b"), Path::new("/a/bc")));
    }
}
