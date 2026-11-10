//! The workspace's scope, as the app's `fs::Workspace`: every `fs.*` path must be inside one of
//! the open folders (canonical, symlinks resolved, `..` can't escape), and a folder itself is
//! never deleted, renamed or moved. The first folder is the one `ws.open` opened; the others come
//! from `ws.setFolders` (a helper's worktree, say: the app decides which are let in).

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;

use serde::Serialize;

use crate::error::{Error, Result};

#[derive(Default)]
pub struct Workspace {
    folders: RwLock<Vec<PathBuf>>,
}

/// One folder of `ws.setFolders`: its canonical path, or why it wasn't let in (the app's
/// `fs::FolderStatus`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderResult {
    pub path: String,
    pub canonical: Option<String>,
    pub error: Option<String>,
}

impl Workspace {
    /// Opens `path` as the workspace (replacing every folder). Returns its canonical path.
    pub fn open(&self, path: &str) -> Result<PathBuf> {
        let root = canonical_folder(path)?;
        *self.write()? = vec![root.clone()];
        Ok(root)
    }

    /// Replaces the folders besides the first with `paths`.
    pub fn set_folders(&self, paths: &[String]) -> Result<Vec<FolderResult>> {
        let mut folders = self.write()?;
        let first = folders.first().cloned().ok_or(Error::NoWorkspace)?;
        let mut next = vec![first];
        let mut results = Vec::new();
        for path in paths {
            match canonical_folder(path) {
                Ok(dir) => {
                    if !next.contains(&dir) {
                        next.push(dir.clone());
                    }
                    results.push(FolderResult {
                        path: path.clone(),
                        canonical: Some(dir.to_string_lossy().into_owned()),
                        error: None,
                    });
                }
                Err(e) => results.push(FolderResult {
                    path: path.clone(),
                    canonical: None,
                    error: Some(e.to_string()),
                }),
            }
        }
        *folders = next;
        Ok(results)
    }

    pub fn close(&self) -> Result<()> {
        self.write()?.clear();
        Ok(())
    }

    /// Every open folder, the first one first.
    pub fn folders(&self) -> Vec<PathBuf> {
        self.folders.read().map(|f| f.clone()).unwrap_or_default()
    }

    /// `path` when it is one of the open folders (where a search or a file listing may run).
    pub fn scope_root(&self, path: &str) -> Result<PathBuf> {
        let folders = self.folders();
        if folders.is_empty() {
            return Err(Error::NoWorkspace);
        }
        let dir = canonicalize(path)?;
        if folders.contains(&dir) {
            Ok(dir)
        } else {
            Err(Error::OutsideScope(path.to_string()))
        }
    }

    /// The open folder holding `resolved` (canonical): the innermost one, so a folder opened
    /// inside another is still a folder (never deleted) rather than an entry of the outer one.
    pub fn root_of(&self, resolved: &Path) -> Result<PathBuf> {
        self.folders()
            .into_iter()
            .filter(|f| resolved.starts_with(f))
            .max_by_key(|f| f.components().count())
            .ok_or_else(|| Error::OutsideScope(resolved.to_string_lossy().into_owned()))
    }

    /// Resolves `path` (absolute) to a canonical path inside one of the folders. Paths that don't
    /// exist yet are resolved through their nearest existing ancestor.
    pub fn resolve(&self, path: &str) -> Result<PathBuf> {
        let folders = self.folders();
        let mut first_error = None;
        for folder in &folders {
            match resolve_under(folder, path) {
                Ok(p) => return Ok(p),
                Err(e) => {
                    first_error.get_or_insert(e);
                }
            }
        }
        Err(first_error.unwrap_or(Error::NoWorkspace))
    }

    /// Like `resolve`, but a symlink stays the link (its folder is resolved, its own name kept):
    /// deleting, renaming or moving a link acts on the link, never on what it points to. Never
    /// one of the folders themselves.
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
        if self.folders().contains(&resolved) {
            return Err(Error::OutsideScope(path.to_string()));
        }
        self.root_of(&resolved)?;
        Ok(resolved)
    }

    fn write(&self) -> Result<std::sync::RwLockWriteGuard<'_, Vec<PathBuf>>> {
        self.folders
            .write()
            .map_err(|_| Error::Invalid("lock poisoned".into()))
    }
}

/// `fs::canonicalize` without the verbatim prefix Windows adds (`\\?\C:\x` → `C:\x`), so the
/// unit tests compare paths there as on Linux, where the server runs.
pub fn canonicalize(path: impl AsRef<Path>) -> std::io::Result<PathBuf> {
    let canonical = fs::canonicalize(path)?;
    #[cfg(windows)]
    {
        let text = canonical.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            let b = rest.as_bytes();
            if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
                return Ok(PathBuf::from(rest));
            }
        }
    }
    Ok(canonical)
}

/// `path` canonical when it is an existing absolute folder.
fn canonical_folder(path: &str) -> Result<PathBuf> {
    if !Path::new(path).is_absolute() {
        return Err(Error::Invalid(format!("path must be absolute: {path}")));
    }
    let dir = canonicalize(path)?;
    if !dir.is_dir() {
        return Err(Error::Invalid(format!("not a folder: {}", dir.display())));
    }
    Ok(dir)
}

/// Resolves `path` (absolute) to a canonical path inside `root` (canonical). Paths that don't
/// exist yet are resolved through their nearest existing ancestor, so `..` and symlinks can't
/// escape.
pub fn resolve_under(root: &Path, path: &str) -> Result<PathBuf> {
    let requested = Path::new(path);
    if !requested.is_absolute() {
        return Err(Error::Invalid(format!("path must be absolute: {path}")));
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
    let mut resolved = canonicalize(&existing)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn temp_dir(name: &str) -> Result<PathBuf> {
        let dir = std::env::temp_dir().join(format!("rs-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir)?;
        Ok(canonicalize(&dir)?)
    }

    fn text(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn scope_rejects_escapes() -> Result<()> {
        let dir = temp_dir("scope")?;
        fs::create_dir_all(dir.join("ws/src"))?;
        fs::create_dir_all(dir.join("other"))?;
        let ws = Workspace::default();
        assert!(matches!(ws.resolve(&text(&dir)), Err(Error::NoWorkspace)));
        let root = ws.open(&text(&dir.join("ws")))?;
        assert!(ws.resolve(&text(&root.join("src/new/file.ts"))).is_ok());
        let escape = format!("{}/../other/x.txt", root.display());
        assert!(matches!(ws.resolve(&escape), Err(Error::OutsideScope(_))));
        let missing_escape = format!("{}/nope/../../other/x.txt", root.display());
        assert!(matches!(
            ws.resolve(&missing_escape),
            Err(Error::OutsideScope(_))
        ));
        assert!(matches!(ws.resolve("relative.txt"), Err(Error::Invalid(_))));
        assert!(ws.resolve(&text(&dir.join("other"))).is_err());
        fs::remove_dir_all(&dir)?;
        Ok(())
    }

    #[test]
    fn folders_are_never_entries_and_extra_folders_are_in_scope() -> Result<()> {
        let dir = temp_dir("folders")?;
        fs::create_dir_all(dir.join("a/inner"))?;
        fs::create_dir_all(dir.join("b"))?;
        fs::write(dir.join("b/f.txt"), "x")?;
        let ws = Workspace::default();
        let a = ws.open(&text(&dir.join("a")))?;
        assert!(ws.resolve_entry(&text(&a)).is_err());
        assert!(ws.resolve_entry(&text(&a.join("inner"))).is_ok());
        let results = ws.set_folders(&[
            text(&dir.join("b")),
            text(&dir.join("missing")),
            text(&a.join("inner")),
        ])?;
        assert!(results[0].canonical.is_some());
        assert!(results[1].error.is_some());
        assert!(ws.resolve(&text(&dir.join("b/f.txt"))).is_ok());
        // An open folder inside another one is a folder, not an entry of the outer one.
        assert!(ws.resolve_entry(&text(&a.join("inner"))).is_err());
        assert_eq!(ws.root_of(&a.join("inner/x"))?, a.join("inner"));
        assert!(ws.scope_root(&text(&dir.join("b"))).is_ok());
        assert!(ws.scope_root(&text(&dir)).is_err());
        ws.set_folders(&[])?;
        assert!(ws.resolve(&text(&dir.join("b/f.txt"))).is_err());
        ws.close()?;
        assert!(matches!(ws.set_folders(&[]), Err(Error::NoWorkspace)));
        fs::remove_dir_all(&dir)?;
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape() -> Result<()> {
        let dir = temp_dir("links")?;
        fs::create_dir_all(dir.join("ws"))?;
        fs::create_dir_all(dir.join("out"))?;
        std::os::unix::fs::symlink(dir.join("out"), dir.join("ws/link"))?;
        let ws = Workspace::default();
        let root = ws.open(&text(&dir.join("ws")))?;
        assert!(ws.resolve(&text(&root.join("link/x"))).is_err());
        // The link itself can be removed (it's inside), never what it points at.
        assert_eq!(
            ws.resolve_entry(&text(&root.join("link")))?,
            root.join("link")
        );
        fs::remove_dir_all(&dir)?;
        Ok(())
    }
}
