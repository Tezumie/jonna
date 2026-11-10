//! Workspace-scoped file system access. Every path from the frontend is resolved with
//! [`Workspace::resolve`], which rejects anything outside the open workspace folder.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::store::{atomic_write, simplify};

pub mod encoding;
mod sort;
pub use sort::natural_cmp;

/// Directory names never shown in the explorer (VS Code's default `files.exclude`).
const ALWAYS_HIDDEN: &[&str] = &[".git", ".hg", ".svn", ".DS_Store", "Thumbs.db"];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub is_symlink: bool,
    /// Matched by .gitignore / .ignore: shown dimmed, like VS Code.
    pub ignored: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub kind: EntryKind,
    pub size: u64,
    pub mtime_ms: f64,
    pub readonly: bool,
}

#[derive(Default)]
pub struct Workspace {
    root: RwLock<Option<PathBuf>>,
    /// Files outside the folder the user opened themselves (D190: a file from elsewhere, as in
    /// VS Code). Only these exact files are in scope (read, save, watch their folder); nothing
    /// else around them, and never for deleting or renaming.
    extra: RwLock<std::collections::HashSet<PathBuf>>,
    /// Folders let in besides the open one while an agent works there (D246): a helper's git
    /// worktree of the same repository, run in this window (headless helpers). Everything inside
    /// is in scope like the open folder's, until the helper ends (`forget_root`) or the folder
    /// changes.
    roots: RwLock<Vec<PathBuf>>,
    /// The workspace's other folders (several folders in one window, like VS Code's
    /// `.code-workspace`), canonical, in order. The first folder is `root` (the primary); these
    /// are in scope exactly like it, until the folder list changes or another folder opens.
    folders: RwLock<Vec<PathBuf>>,
    /// The `.code-workspace` file this window has open (canonical), if any: what names the window
    /// (its state, its place in the window registry) instead of the root.
    file: RwLock<Option<PathBuf>>,
    /// The remote the open folders are on (D252, its authority: `ssh:box`). Then `root` and
    /// `folders` are the remote's POSIX paths (canonical there, as its server answered), scope
    /// is checked by their names here (and again, with links resolved, by the server), and
    /// nothing touches the local disk with them.
    remote: RwLock<Option<String>>,
}

/// `path` (POSIX, absolute) with `.`, `..` and repeated or trailing `/` taken out; None when it
/// isn't absolute. (`\` counts as `/`: a Windows `PathBuf::join` adds them.)
pub fn normalize_posix(path: &str) -> Option<String> {
    let path = path.replace('\\', "/");
    if !path.starts_with('/') {
        return None;
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            p => parts.push(p),
        }
    }
    Some(format!("/{}", parts.join("/")))
}

/// Whether POSIX path `path` is `dir` or inside it (both normalized).
fn posix_within(path: &str, dir: &str) -> bool {
    dir == "/"
        || path == dir
        || path
            .strip_prefix(dir)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// One folder asked for in `Workspace::set_folders`: its canonical path when it's in the
/// workspace, else why not (a missing folder stays listed in the workspace file; the frontend
/// shows it as missing).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderStatus {
    pub path: String,
    pub canonical: Option<String>,
    pub error: Option<String>,
}

/// Whether `name` ends with `.code-workspace` (any case): the only files the workspace-file
/// commands read and write.
pub fn is_workspace_file_name(path: &Path) -> bool {
    path.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
        let lower = n.to_ascii_lowercase();
        lower.len() > ".code-workspace".len() && lower.ends_with(".code-workspace")
    })
}

/// A network path (`\\host\share`, `//host/share`, `\\?\UNC\…`): touching it makes Windows
/// connect to the host and offer the user's credentials (D161), so it's refused before any IO.
pub(crate) fn is_unc(p: &str) -> bool {
    // `\\?\` and `\\.\` paths are local only with a drive (`\\?\C:\`) or a volume
    // (`\\?\Volume{…}`) after them: `\\?\UNC\…` and `\\?\GLOBALROOT\Device\Mup\…` reach
    // the network (D203 audit).
    let norm = p.replace('/', "\\");
    if let Some(rest) = norm
        .strip_prefix("\\\\?\\")
        .or_else(|| norm.strip_prefix("\\\\.\\"))
    {
        let b = rest.as_bytes();
        let drive = b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':';
        // `get`, not `[..7]`: byte 7 may fall inside a character (`\\?\abcdefé`), which panics.
        let volume = rest
            .get(..7)
            .is_some_and(|s| s.eq_ignore_ascii_case("Volume{"));
        return !(drive || volume);
    }
    norm.starts_with("\\\\")
}

impl Workspace {
    /// Sets the workspace root (canonicalized). Returns the canonical path.
    pub fn open(&self, path: &str) -> Result<PathBuf> {
        let root = simplify(fs::canonicalize(path)?);
        if !root.is_dir() {
            return Err(Error::Invalid(format!("not a folder: {}", root.display())));
        }
        let mut guard = self
            .root
            .write()
            .map_err(|_| Error::Invalid("lock poisoned".into()))?;
        *guard = Some(root.clone());
        // Files let in from outside belonged to the folder open before (D190).
        self.forget_extra();
        self.set_remote(None);
        Ok(root)
    }

    /// Opens a folder on the window's remote (D252): `canonical` as its server resolved it,
    /// `authority` the remote's (`ssh:box`).
    pub fn open_remote(&self, canonical: &str, authority: &str) -> Result<PathBuf> {
        let root = normalize_posix(canonical)
            .ok_or_else(|| Error::Invalid(format!("not a folder on the remote: {canonical}")))?;
        let root = PathBuf::from(root);
        *self
            .root
            .write()
            .map_err(|_| Error::Invalid("lock poisoned".into()))? = Some(root.clone());
        self.forget_extra();
        self.set_remote(Some(authority.to_string()));
        Ok(root)
    }

    /// A remote workspace's other folders, canonical there (the server checked each).
    pub fn set_remote_folders(&self, canonical: &[String]) -> Result<()> {
        let root = self.root()?;
        let mut kept: Vec<PathBuf> = Vec::new();
        for c in canonical {
            if let Some(dir) = normalize_posix(c).map(PathBuf::from) {
                if dir != root && !kept.contains(&dir) {
                    kept.push(dir);
                }
            }
        }
        *self
            .folders
            .write()
            .map_err(|_| Error::Invalid("lock poisoned".into()))? = kept;
        Ok(())
    }

    fn set_remote(&self, authority: Option<String>) {
        if let Ok(mut r) = self.remote.write() {
            *r = authority;
        }
    }

    /// The remote the open folder is on (`ssh:box`), if it is on one.
    pub fn remote(&self) -> Option<String> {
        self.remote.read().ok().and_then(|r| r.clone())
    }

    /// A remote workspace's `path` (POSIX, absolute) normalized, when it's inside one of its
    /// folders. Links aren't resolved here: the server does that for every file operation.
    fn resolve_remote(&self, path: &str) -> Result<PathBuf> {
        let normalized = normalize_posix(path)
            .ok_or_else(|| Error::Invalid(format!("path must be absolute: {path}")))?;
        let inside = self
            .all_folders()
            .iter()
            .any(|f| posix_within(&normalized, &crate::remote::posix(f)));
        if inside {
            Ok(PathBuf::from(normalized))
        } else {
            Err(Error::OutsideScope(path.to_string()))
        }
    }

    fn forget_extra(&self) {
        if let Ok(mut extra) = self.extra.write() {
            extra.clear();
        }
        // A helper's worktree belonged to the folder open before, too.
        if let Ok(mut roots) = self.roots.write() {
            roots.clear();
        }
        // And the workspace's other folders and its workspace file: the frontend sets them again
        // after opening the first folder of a workspace.
        if let Ok(mut folders) = self.folders.write() {
            folders.clear();
        }
        if let Ok(mut file) = self.file.write() {
            *file = None;
        }
    }

    /// Sets the workspace's other folders (besides the root, which stays the first). Each must
    /// be an existing local folder, given absolute; duplicates and the root itself are added
    /// once (the root not at all). One status per path given, in order: a folder that can't be
    /// added (missing, not a folder, a network path) is reported with its error and left out.
    pub fn set_folders(&self, paths: &[String]) -> Result<Vec<FolderStatus>> {
        let root = self.root()?;
        if self.remote().is_some() {
            return Err(Error::Invalid(
                "a remote workspace's folders are set through its server".into(),
            ));
        }
        let root_unc = is_unc(&root.to_string_lossy());
        let mut statuses = Vec::with_capacity(paths.len());
        let mut kept: Vec<PathBuf> = Vec::new();
        for path in paths {
            let checked = if (is_unc(path) && !root_unc) || !Path::new(path).is_absolute() {
                Err(format!("{path} isn't a local folder given in full"))
            } else {
                match fs::canonicalize(path).map(simplify) {
                    Ok(dir) if dir.is_dir() => Ok(dir),
                    Ok(dir) => Err(format!("not a folder: {}", dir.display())),
                    Err(e) => Err(format!("{path}: {e}")),
                }
            };
            match checked {
                Ok(dir) => {
                    statuses.push(FolderStatus {
                        path: path.clone(),
                        canonical: Some(dir.to_string_lossy().into_owned()),
                        error: None,
                    });
                    if dir != root && !kept.contains(&dir) {
                        kept.push(dir);
                    }
                }
                Err(error) => statuses.push(FolderStatus {
                    path: path.clone(),
                    canonical: None,
                    error: Some(error),
                }),
            }
        }
        *self
            .folders
            .write()
            .map_err(|_| Error::Invalid("lock poisoned".into()))? = kept;
        Ok(statuses)
    }

    /// The workspace's other folders (not the root), canonical, in order.
    pub fn folders(&self) -> Vec<PathBuf> {
        self.folders.read().map(|f| f.clone()).unwrap_or_default()
    }

    /// Every folder of the workspace: the root first, then the others. Empty with none open.
    /// (Not a headless helper's worktree: that one is let in for a while, not a folder of it.)
    pub fn all_folders(&self) -> Vec<PathBuf> {
        let Ok(root) = self.root() else {
            return Vec::new();
        };
        std::iter::once(root).chain(self.folders()).collect()
    }

    /// The workspace folder (the root or another one, not a helper's worktree) that holds
    /// `resolved` (canonical); the root first when folders nest.
    pub fn folder_of(&self, resolved: &Path) -> Option<PathBuf> {
        // The innermost when folders nest (a package folder added beside its repository), as the
        // frontend's `folderOf` picks it: a file belongs to the most specific folder.
        self.all_folders()
            .into_iter()
            .filter(|f| resolved.starts_with(f))
            .max_by_key(|f| f.components().count())
    }

    /// Whether `path` (canonical) is one of the roots in scope itself: the root, another
    /// workspace folder or a helper's worktree. Those are never deleted, renamed or moved.
    pub fn is_scope_root(&self, path: &Path) -> bool {
        self.all_folders().iter().any(|f| f == path) || self.extra_roots().iter().any(|r| r == path)
    }

    /// Sets (or with None clears) the `.code-workspace` file this window has open: absolute,
    /// local, named `*.code-workspace`. Canonical when it exists (else its folder is). Returns
    /// the path kept.
    pub fn set_file(&self, path: Option<&str>) -> Result<Option<PathBuf>> {
        let file = match path.filter(|p| !p.is_empty()) {
            None => None,
            Some(p) => Some(checked_workspace_file(p)?),
        };
        *self
            .file
            .write()
            .map_err(|_| Error::Invalid("lock poisoned".into()))? = file.clone();
        Ok(file)
    }

    /// The `.code-workspace` file this window has open, if any.
    pub fn file(&self) -> Option<PathBuf> {
        self.file.read().ok().and_then(|f| f.clone())
    }

    /// What names this window's workspace: its `.code-workspace` file when one is open, else the
    /// root (the per-workspace state, the window registry, the window's place).
    pub fn location(&self) -> Result<PathBuf> {
        // A remote folder is named with its remote (`ssh://box/home/me/app`): the same path on
        // two hosts are two workspaces, and none is a local folder.
        if let Some(authority) = self.remote() {
            let root = self.root()?;
            let at = crate::remote::Authority::parse(&authority)?;
            return Ok(PathBuf::from(at.location(&crate::remote::posix(&root))));
        }
        match self.file() {
            Some(file) => Ok(file),
            None => self.root(),
        }
    }

    /// Lets a linked git worktree of the open folder's repository in as an extra root (a
    /// headless helper works there). Anything else is refused: a plain folder, another
    /// repository's worktree, a network or relative path. Returns its canonical path.
    pub fn allow_root(&self, path: &str) -> Result<PathBuf> {
        if is_unc(path) || !Path::new(path).is_absolute() {
            return Err(Error::OutsideScope(path.to_string()));
        }
        let dir = simplify(fs::canonicalize(path)?);
        if !dir.is_dir() {
            return Err(Error::Invalid(format!("not a folder: {path}")));
        }
        let root = self.root()?;
        if dir == root {
            return Ok(dir);
        }
        let same_repo = match (
            linked_worktree_common_dir(&dir),
            repository_common_dir(&root),
        ) {
            (Some(a), Some(b)) => a == b,
            _ => false,
        };
        if !same_repo {
            return Err(Error::OutsideScope(format!(
                "{path} isn't a git worktree of the open folder's repository"
            )));
        }
        let mut roots = self
            .roots
            .write()
            .map_err(|_| Error::Invalid("lock poisoned".into()))?;
        if !roots.contains(&dir) {
            roots.push(dir.clone());
        }
        Ok(dir)
    }

    /// Takes an extra root (`allow_root`) out of scope again. Unknown paths are ignored.
    pub fn forget_root(&self, path: &str) -> Result<()> {
        let dir = fs::canonicalize(path)
            .map(simplify)
            .unwrap_or_else(|_| simplify(PathBuf::from(path)));
        self.roots
            .write()
            .map_err(|_| Error::Invalid("lock poisoned".into()))?
            .retain(|r| *r != dir);
        Ok(())
    }

    /// `path` (a folder) when it is one of the workspace's folders or one of the extra roots:
    /// where a search or a file listing may run. Canonical.
    pub fn scope_root(&self, path: &str) -> Result<PathBuf> {
        let root = self.root()?;
        if self.remote().is_some() {
            let dir = normalize_posix(path)
                .map(PathBuf::from)
                .ok_or_else(|| Error::OutsideScope(path.to_string()))?;
            return if self.is_scope_root(&dir) {
                Ok(dir)
            } else {
                Err(Error::OutsideScope(path.to_string()))
            };
        }
        if is_unc(path) && !is_unc(&root.to_string_lossy()) {
            return Err(Error::OutsideScope(path.to_string()));
        }
        let dir = simplify(fs::canonicalize(path)?);
        if self.is_scope_root(&dir) {
            Ok(dir)
        } else {
            Err(Error::OutsideScope(path.to_string()))
        }
    }

    fn extra_roots(&self) -> Vec<PathBuf> {
        self.roots.read().map(|r| r.clone()).unwrap_or_default()
    }

    /// The root (a workspace folder, or an extra root) that holds `resolved` (canonical): what a
    /// delete must never remove, and where a command's working folder must stay. The root first,
    /// then the other folders in order, when folders nest.
    pub fn root_of(&self, resolved: &Path) -> Result<PathBuf> {
        self.root()?;
        if let Some(folder) = self.folder_of(resolved) {
            return Ok(folder);
        }
        self.extra_roots()
            .into_iter()
            .find(|r| resolved.starts_with(r))
            .ok_or_else(|| Error::OutsideScope(resolved.to_string_lossy().into_owned()))
    }

    /// Forgets the workspace root (nothing is in scope until a folder opens again).
    pub fn close(&self) -> Result<()> {
        *self
            .root
            .write()
            .map_err(|_| Error::Invalid("lock poisoned".into()))? = None;
        self.forget_extra();
        self.set_remote(None);
        Ok(())
    }

    pub fn root(&self) -> Result<PathBuf> {
        self.root
            .read()
            .map_err(|_| Error::Invalid("lock poisoned".into()))?
            .clone()
            .ok_or(Error::NoWorkspace)
    }

    /// Like `resolve`, but a symlink stays the link (its folder is resolved, its own name kept):
    /// deleting, renaming or moving a link acts on the link, never on what it points to (D141).
    pub fn resolve_entry(&self, path: &str) -> Result<PathBuf> {
        let requested = Path::new(path);
        let name = requested
            .file_name()
            .filter(|n| {
                Path::new(n)
                    .components()
                    .all(|c| matches!(c, Component::Normal(_)))
            })
            .ok_or_else(|| Error::OutsideScope(path.to_string()))?;
        let parent = requested
            .parent()
            .ok_or_else(|| Error::OutsideScope(path.to_string()))?;
        let resolved = self.resolve(&parent.to_string_lossy())?.join(name);
        // Inside a workspace folder or an extra root (a helper's worktree), never one of those
        // itself (a folder nested in another included); the files let in one by one (D190) are
        // never deleted or renamed.
        // Another spelling of a workspace folder (other case, an 8.3 short name, a trailing dot)
        // names the folder itself too: what it resolves to is checked as well (not for a link,
        // which is acted on as the link).
        let names_scope_root = || {
            fs::symlink_metadata(&resolved).is_ok_and(|m| !m.file_type().is_symlink())
                && fs::canonicalize(&resolved)
                    .map(simplify)
                    .is_ok_and(|c| self.is_scope_root(&c))
        };
        match self.root_of(&resolved) {
            Ok(base)
                if resolved != base && !self.is_scope_root(&resolved) && !names_scope_root() =>
            {
                Ok(resolved)
            }
            _ => Err(Error::OutsideScope(path.to_string())),
        }
    }

    /// Lets the user's own file from outside the folder in (its canonical path). One that doesn't
    /// exist yet (a file named on the command line, saved later) when its folder does.
    pub fn allow_file(&self, path: &str) -> Result<PathBuf> {
        if is_unc(path) || !Path::new(path).is_absolute() {
            return Err(Error::OutsideScope(path.to_string()));
        }
        let canonical = canonical_file(path).ok_or_else(|| {
            Error::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("no such folder for {path}"),
            ))
        })?;
        if canonical.exists() && !canonical.is_file() {
            return Err(Error::Invalid(format!("not a file: {path}")));
        }
        self.extra
            .write()
            .map_err(|_| Error::Invalid("lock poisoned".into()))?
            .insert(canonical.clone());
        Ok(canonical)
    }

    /// `path` when it is one of the files the user opened from outside the folder.
    fn resolve_extra(&self, path: &str) -> Option<PathBuf> {
        let extra = self.extra.read().ok()?;
        if extra.is_empty() || is_unc(path) || !Path::new(path).is_absolute() {
            return None;
        }
        let canonical = canonical_file(path)?;
        extra.contains(&canonical).then_some(canonical)
    }

    /// Whether `dir` holds a file the user opened from outside the folder (its folder may be
    /// watched, for reloads).
    pub fn holds_extra(&self, dir: &Path) -> bool {
        self.extra
            .read()
            .is_ok_and(|e| e.iter().any(|f| f.parent() == Some(dir)))
    }

    /// Resolves `path` (absolute) to a canonical path inside the workspace (or one of the files
    /// the user opened from outside it). Paths that don't exist yet are resolved through their
    /// nearest existing ancestor, so `..` and symlinks can't escape.
    pub fn resolve(&self, path: &str) -> Result<PathBuf> {
        if self.remote().is_some() && crate::remote::is_remote_path(path) {
            return self.resolve_remote(path);
        }
        match self.resolve_in_root(path) {
            Ok(p) => Ok(p),
            Err(e) => self
                .folders()
                .iter()
                .chain(self.extra_roots().iter())
                .find_map(|r| resolve_under(r, path).ok())
                .or_else(|| self.resolve_extra(path))
                .ok_or(e),
        }
    }

    fn resolve_in_root(&self, path: &str) -> Result<PathBuf> {
        resolve_under(&self.root()?, path)
    }
}

/// `path` as a `.code-workspace` file the workspace-file commands may touch: absolute, local (no
/// network path, D161), without `.` or `..` parts, named `*.code-workspace` (also once links are
/// followed). Canonical when it exists, else its folder canonical (when that exists) joined
/// with its name, else as given.
pub fn checked_workspace_file(path: &str) -> Result<PathBuf> {
    let requested = Path::new(path);
    if is_unc(path)
        || !requested.is_absolute()
        || requested
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(Error::OutsideScope(path.to_string()));
    }
    if !is_workspace_file_name(requested) {
        return Err(Error::Invalid(format!(
            "not a .code-workspace file: {path}"
        )));
    }
    let out = match fs::canonicalize(requested) {
        Ok(p) => simplify(p),
        Err(_) => match (
            requested.parent().and_then(|d| fs::canonicalize(d).ok()),
            requested.file_name(),
        ) {
            (Some(dir), Some(name)) => simplify(dir).join(name),
            _ => requested.to_path_buf(),
        },
    };
    if !is_workspace_file_name(&out) || out.is_dir() || is_unc(&out.to_string_lossy()) {
        return Err(Error::Invalid(format!(
            "not a .code-workspace file: {path}"
        )));
    }
    Ok(out)
}

/// `path` canonical; one that doesn't exist yet as its canonical folder joined with its name.
fn canonical_file(path: &str) -> Option<PathBuf> {
    match fs::canonicalize(path) {
        Ok(p) => Some(simplify(p)),
        // Not there yet, maybe with folders that aren't either (`<cli> new/dir/file.txt`: saving
        // creates them, as VS Code does): the nearest folder that exists, canonical, joined with
        // the plain names after it (no `..`, so the result stays where the path says).
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut existing = Path::new(path);
            let mut rest: Vec<&std::ffi::OsStr> = Vec::new();
            loop {
                let name = existing.file_name()?;
                if !matches!(
                    Path::new(name).components().next(),
                    Some(Component::Normal(_))
                ) {
                    return None;
                }
                rest.push(name);
                existing = existing.parent()?;
                if existing.exists() {
                    break;
                }
            }
            let mut out = simplify(fs::canonicalize(existing).ok()?);
            if !out.is_dir() {
                return None;
            }
            for name in rest.iter().rev() {
                out.push(name);
            }
            Some(out)
        }
        Err(_) => None,
    }
}

/// The shared git folder of a linked worktree (`dir/.git` is a file: `gitdir: <common>/worktrees/
/// <name>`, whose `commondir` names the common folder). None for anything else.
fn linked_worktree_common_dir(dir: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(dir.join(".git")).ok()?;
    let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    // A relative gitdir is relative to the worktree; `join` keeps an absolute one as is.
    let gitdir = simplify(fs::canonicalize(dir.join(target)).ok()?);
    let common = fs::read_to_string(gitdir.join("commondir")).ok()?;
    Some(simplify(fs::canonicalize(gitdir.join(common.trim())).ok()?))
}

/// The shared git folder of the repository `dir` is in (the nearest `.git` above it): the `.git`
/// folder itself, or a linked worktree's common folder.
pub(crate) fn repository_common_dir(dir: &Path) -> Option<PathBuf> {
    let top = dir.ancestors().find(|d| d.join(".git").exists())?;
    let dot = top.join(".git");
    if dot.is_dir() {
        Some(simplify(fs::canonicalize(dot).ok()?))
    } else {
        linked_worktree_common_dir(top)
    }
}

/// Resolves `path` (absolute) to a canonical path inside `root` (canonical). Paths that don't
/// exist yet are resolved through their nearest existing ancestor, so `..` and symlinks can't
/// escape. The workspace's scope, and a chat's private folder's (D208, `agent::scratch`).
pub(crate) fn resolve_under(root: &Path, path: &str) -> Result<PathBuf> {
    let requested = Path::new(path);
    if !requested.is_absolute() {
        return Err(Error::Invalid(format!("path must be absolute: {path}")));
    }
    // A network path outside a local workspace is refused before any IO: `exists()` on
    // `\\host\share` makes Windows connect to the host (and offer the user's credentials, D161).
    if is_unc(path) && !is_unc(&root.to_string_lossy()) {
        return Err(Error::OutsideScope(path.to_string()));
    }
    let mut existing = requested.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        match (existing.file_name(), existing.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name.to_os_string());
                existing = parent.to_path_buf();
            }
            _ => return Err(Error::OutsideScope(path.to_string())),
        }
    }
    let mut resolved = simplify(fs::canonicalize(&existing)?);
    for name in rest.iter().rev() {
        if Path::new(name)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(Error::OutsideScope(path.to_string()));
        }
        resolved.push(name);
    }
    if resolved.starts_with(root) {
        Ok(resolved)
    } else {
        Err(Error::OutsideScope(path.to_string()))
    }
}

/// Lists one directory level, dirs first, then case-insensitive by name.
pub fn list_dir(dir: &Path) -> Result<Vec<DirEntry>> {
    if !dir.is_dir() {
        return Err(Error::Invalid(format!("not a folder: {}", dir.display())));
    }
    // Walk once honoring ignore files to learn which entries are *not* ignored.
    let visible: HashSet<PathBuf> = ignore::WalkBuilder::new(dir)
        .max_depth(Some(1))
        .hidden(false)
        .parents(true)
        .require_git(false)
        .build()
        .filter_map(|e| e.ok())
        .filter(|e| e.depth() == 1)
        .map(|e| e.into_path())
        .collect();

    let mut entries = Vec::new();
    for item in fs::read_dir(dir)? {
        let Ok(item) = item else { continue };
        let name = item.file_name().to_string_lossy().into_owned();
        if ALWAYS_HIDDEN.contains(&name.as_str()) {
            continue;
        }
        let path = item.path();
        let is_symlink = item.file_type().map(|t| t.is_symlink()).unwrap_or(false);
        // Follow symlinks for the kind; a broken link shows as a file.
        let kind = if path.is_dir() {
            EntryKind::Dir
        } else {
            EntryKind::File
        };
        entries.push(DirEntry {
            ignored: !visible.contains(&path),
            path: path.to_string_lossy().into_owned(),
            name,
            kind,
            is_symlink,
        });
    }
    entries.sort_by(|a, b| match (a.kind, b.kind) {
        (EntryKind::Dir, EntryKind::File) => Ordering::Less,
        (EntryKind::File, EntryKind::Dir) => Ordering::Greater,
        _ => natural_cmp(&a.name, &b.name),
    });
    Ok(entries)
}

pub fn stat(path: &Path) -> Result<Stat> {
    let meta = fs::metadata(path)?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    Ok(Stat {
        kind: if meta.is_dir() {
            EntryKind::Dir
        } else {
            EntryKind::File
        },
        size: meta.len(),
        mtime_ms,
        readonly: meta.permissions().readonly(),
    })
}

pub fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    if path.is_dir() {
        return Err(Error::Invalid(format!("is a folder: {}", path.display())));
    }
    // e.g. the first workspace setting creates `<root>/<workspace folder>/` (the path is already scope-checked).
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    atomic_write(path, bytes)
}

/// Validates a single path segment typed by the user (new file/folder name, rename target).
pub fn validate_name(name: &str) -> Result<()> {
    let bad = name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
        || (cfg!(windows) && name.contains([':', '*', '?', '"', '<', '>', '|']));
    if bad {
        return Err(Error::Invalid(format!("invalid file name: {name:?}")));
    }
    Ok(())
}

pub fn create_file(parent: &Path, name: &str) -> Result<PathBuf> {
    validate_name(name)?;
    let path = parent.join(name);
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    Ok(path)
}

pub fn create_dir(parent: &Path, name: &str) -> Result<PathBuf> {
    validate_name(name)?;
    let path = parent.join(name);
    fs::create_dir(&path)?;
    Ok(path)
}

pub fn rename(path: &Path, new_name: &str) -> Result<PathBuf> {
    validate_name(new_name)?;
    let parent = path
        .parent()
        .ok_or_else(|| Error::Invalid(format!("cannot rename {}", path.display())))?;
    let target = parent.join(new_name);
    // A case-only rename (a.ts → A.ts) is allowed when the target *is* this file (a
    // case-insensitive file system); on Linux both names can be different files, and renaming
    // over the other one would destroy it (D141).
    let same_file = fs::symlink_metadata(&target).is_ok()
        && fs::canonicalize(&target).ok() == fs::canonicalize(path).ok()
        && target.to_string_lossy().to_lowercase() == path.to_string_lossy().to_lowercase();
    if fs::symlink_metadata(&target).is_ok() && !same_file {
        return Err(Error::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("already exists: {}", target.display()),
        )));
    }
    fs::rename(path, &target)?;
    Ok(target)
}

/// Moves `path` into the folder `dest` (cut/paste, drag in the explorer). Refuses the workspace
/// root, a folder into itself or its own subfolder, and existing targets.
pub fn move_into(path: &Path, dest: &Path, root: &Path) -> Result<PathBuf> {
    if path == root {
        return Err(Error::Invalid("refusing to move the workspace root".into()));
    }
    if dest.starts_with(path) {
        return Err(Error::Invalid(format!(
            "cannot move {} into itself",
            path.display()
        )));
    }
    let name = path
        .file_name()
        .ok_or_else(|| Error::Invalid(format!("cannot move {}", path.display())))?;
    let target = dest.join(name);
    if target == path {
        return Ok(target);
    }
    if fs::symlink_metadata(&target).is_ok() {
        return Err(Error::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("already exists: {}", target.display()),
        )));
    }
    match fs::rename(path, &target) {
        Ok(()) => Ok(target),
        // Another drive (a multi-root workspace's folders on C: and D:, D251): copied, then the
        // original removed once the copy is whole.
        Err(e) if crosses_devices(&e) => {
            let copied = copy_into(path, dest)?;
            if copied != target {
                let _ = remove_any(&copied);
                return Err(Error::Io(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!("already exists: {}", target.display()),
                )));
            }
            if let Err(err) = remove_any(path) {
                // The copy is there; the original stays too (nothing is lost).
                return Err(Error::Invalid(format!(
                    "copied to {} but couldn't remove {}: {err}",
                    target.display(),
                    path.display()
                )));
            }
            Ok(target)
        }
        Err(e) => Err(e.into()),
    }
}

/// A rename that can't cross volumes (Windows' ERROR_NOT_SAME_DEVICE, Unix's EXDEV).
fn crosses_devices(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::CrossesDevices
        || (cfg!(windows) && e.raw_os_error() == Some(17))
}

/// Removes a file, a link or a folder with everything in it.
fn remove_any(path: &Path) -> std::io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(path),
        Ok(m) => remove_file_or_link(path, m.file_type()),
        Err(e) => Err(e),
    }
}

/// Removes a file or a link (never what it points to). On Windows a folder link or a junction
/// is a folder to the OS: `remove_file` is refused there ("Access is denied"), `remove_dir`
/// takes the link alone.
pub(crate) fn remove_file_or_link(path: &Path, file_type: fs::FileType) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        if file_type.is_symlink_dir() {
            return fs::remove_dir(path);
        }
    }
    #[cfg(not(windows))]
    let _ = file_type;
    fs::remove_file(path)
}

/// Copies `path` (recursively) into `dest`. An existing name gets " copy", " copy 2"… before the
/// extension, like other editors.
pub fn copy_into(path: &Path, dest: &Path) -> Result<PathBuf> {
    if dest.starts_with(path) {
        return Err(Error::Invalid(format!(
            "cannot copy {} into itself",
            path.display()
        )));
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| Error::Invalid(format!("cannot copy {}", path.display())))?;
    let target = unique_target(dest, &name, path.is_dir());
    copy_recursive(path, &target)?;
    Ok(target)
}

fn unique_target(dest: &Path, name: &str, is_dir: bool) -> PathBuf {
    let first = dest.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 && !is_dir => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1..)
        .map(|n| {
            let suffix = if n == 1 {
                " copy".to_string()
            } else {
                format!(" copy {n}")
            };
            dest.join(format!("{stem}{suffix}{ext}"))
        })
        .find(|p| !p.exists())
        .unwrap_or(first)
}

fn copy_recursive(from: &Path, to: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() {
        // Copy the link, not what it points at: `fs::copy` follows it, so a link to `~/.ssh` (or
        // anything outside the workspace) would pull that content into the workspace.
        copy_symlink(from, to)?;
    } else if meta.is_dir() {
        fs::create_dir(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else {
        fs::copy(from, to)?;
    }
    Ok(())
}

#[cfg(unix)]
fn copy_symlink(from: &Path, to: &Path) -> Result<()> {
    std::os::unix::fs::symlink(fs::read_link(from)?, to)?;
    Ok(())
}

#[cfg(windows)]
fn copy_symlink(from: &Path, to: &Path) -> Result<()> {
    let target = fs::read_link(from)?;
    // Whether the link is a directory link decides which call recreates it.
    let is_dir = fs::metadata(from).is_ok_and(|m| m.is_dir());
    let made = if is_dir {
        std::os::windows::fs::symlink_dir(&target, to)
    } else {
        std::os::windows::fs::symlink_file(&target, to)
    };
    // Creating links needs Developer Mode or admin rights on Windows. Without them the link is
    // left out rather than replaced by a copy of its target (which may be outside the workspace).
    if let Err(e) = made {
        if e.kind() != std::io::ErrorKind::PermissionDenied && e.raw_os_error() != Some(1314) {
            return Err(e.into());
        }
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn copy_symlink(_from: &Path, _to: &Path) -> Result<()> {
    Ok(())
}

pub fn delete(path: &Path, root: &Path) -> Result<()> {
    if path == root {
        return Err(Error::Invalid(
            "refusing to delete the workspace root".into(),
        ));
    }
    let meta = fs::symlink_metadata(path)?;
    if meta.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        remove_file_or_link(path, meta.file_type())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
