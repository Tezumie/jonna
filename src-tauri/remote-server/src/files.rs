//! File operations, as the app's `fs` module does them: listing (sorted and dimmed the same
//! way), stat, atomic writes, create, rename, move, copy (" copy" names) and delete. The caller
//! has already resolved every path against the workspace's scope.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use crate::error::{Error, Result};

/// Names never shown in the explorer (VS Code's default `files.exclude`).
const ALWAYS_HIDDEN: &[&str] = &[".git", ".hg", ".svn", ".DS_Store", "Thumbs.db"];

/// The most `fs.read` returns: its base64 must fit in one 64 MiB frame.
pub const MAX_READ: u64 = 48 * 1024 * 1024;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub is_symlink: bool,
    /// Matched by .gitignore / .ignore: shown dimmed, like VS Code.
    pub ignored: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub kind: EntryKind,
    pub size: u64,
    pub mtime_ms: f64,
    pub readonly: bool,
}

/// Lists one folder level: folders first, then natural order by name.
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

/// A file's bytes, at most `max_bytes` (then `truncated`). Without a limit a file over MAX_READ is
/// refused rather than cut short, so a caller never mistakes part of a file for all of it.
pub fn read(path: &Path, max_bytes: Option<u64>) -> Result<(Vec<u8>, bool)> {
    let meta = fs::metadata(path)?;
    if meta.is_dir() {
        return Err(Error::Invalid(format!("is a folder: {}", path.display())));
    }
    let limit = match max_bytes {
        Some(n) => n.min(MAX_READ),
        None if meta.len() > MAX_READ => {
            return Err(Error::Invalid(format!(
                "file too large to read ({} bytes): {}",
                meta.len(),
                path.display()
            )))
        }
        None => MAX_READ,
    };
    let mut bytes = Vec::new();
    // One byte past the limit tells whether there was more (the size may change while reading).
    fs::File::open(path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    let truncated = bytes.len() as u64 > limit;
    bytes.truncate(limit as usize);
    Ok((bytes, truncated))
}

pub fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    if path.is_dir() {
        return Err(Error::Invalid(format!("is a folder: {}", path.display())));
    }
    // The path is already scope-checked; saving into a folder that isn't there yet creates it.
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    atomic_write(path, bytes)
}

/// Writes `bytes` to `path` atomically (temp file in the same folder, fsync, rename). Follows a
/// symlink at `path` (writes its target) and keeps the existing file's permissions, so editing an
/// executable script doesn't drop its `+x` bit.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let target = match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => fs::canonicalize(path)?,
        _ => path.to_path_buf(),
    };
    let dir = target
        .parent()
        .ok_or_else(|| Error::Invalid(format!("no parent folder: {}", target.display())))?;
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(
        ".{name}.tmp-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, AtomicOrdering::Relaxed)
    ));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        if let Ok(meta) = fs::metadata(&target) {
            fs::set_permissions(&tmp, meta.permissions())?;
        }
        drop(file);
        fs::rename(&tmp, &target)?;
        // Makes the rename durable. Best effort: not every file system syncs folders.
        #[cfg(unix)]
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
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
    // over the other one would destroy it.
    let same_file = fs::symlink_metadata(&target).is_ok()
        && fs::canonicalize(&target).ok() == fs::canonicalize(path).ok()
        && target.to_string_lossy().to_lowercase() == path.to_string_lossy().to_lowercase();
    if fs::symlink_metadata(&target).is_ok() && !same_file {
        return Err(already_exists(&target));
    }
    fs::rename(path, &target)?;
    Ok(target)
}

/// Moves `path` into the folder `dest`. Refuses a workspace folder, a folder into itself or its
/// own subfolder, and existing targets.
pub fn move_into(path: &Path, dest: &Path, folders: &[PathBuf]) -> Result<PathBuf> {
    if folders.iter().any(|f| f == path) {
        return Err(Error::Invalid("refusing to move a workspace folder".into()));
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
        return Err(already_exists(&target));
    }
    fs::rename(path, &target)?;
    Ok(target)
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

// Windows only builds the unit tests; a link there is left out rather than replaced by a copy.
#[cfg(not(unix))]
fn copy_symlink(_from: &Path, _to: &Path) -> Result<()> {
    Ok(())
}

/// Deletes a file or folder (recursively); a link is removed, never what it points at.
pub fn delete(path: &Path, folders: &[PathBuf]) -> Result<()> {
    if folders.iter().any(|f| f == path) {
        return Err(Error::Invalid(
            "refusing to delete a workspace folder".into(),
        ));
    }
    let meta = fs::symlink_metadata(path)?;
    if meta.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn already_exists(target: &Path) -> Error {
    Error::Io(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        format!("already exists: {}", target.display()),
    ))
}

/// Case-insensitive "natural" order like VS Code's explorer: digit runs compare by value,
/// so `file-2` sorts before `file-10`. Ties fall back to a plain comparison for stability.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(cx), Some(cy)) if cx.is_ascii_digit() && cy.is_ascii_digit() => {
                let take_digits = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut digits = String::new();
                    while let Some(c) = it.peek().copied().filter(char::is_ascii_digit) {
                        digits.push(c);
                        it.next();
                    }
                    digits
                };
                let (dx, dy) = (take_digits(&mut x), take_digits(&mut y));
                let (tx, ty) = (dx.trim_start_matches('0'), dy.trim_start_matches('0'));
                let ord = tx.len().cmp(&ty.len()).then_with(|| tx.cmp(ty));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(cx), Some(cy)) => {
                let ord = cx.to_lowercase().cmp(cy.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                x.next();
                y.next();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::canonicalize;

    fn setup(name: &str) -> Result<PathBuf> {
        let dir = std::env::temp_dir().join(format!("rs-files-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src"))?;
        fs::write(dir.join("src/main.ts"), "x")?;
        fs::write(dir.join(".gitignore"), "build/\n")?;
        fs::create_dir_all(dir.join("build"))?;
        fs::create_dir_all(dir.join(".git"))?;
        fs::write(dir.join("B.txt"), "")?;
        fs::write(dir.join("a.txt"), "")?;
        Ok(canonicalize(&dir)?)
    }

    #[test]
    fn lists_dirs_first_and_flags_ignored() -> Result<()> {
        let root = setup("list")?;
        let names: Vec<(String, bool)> = list_dir(&root)?
            .into_iter()
            .map(|e| (e.name, e.ignored))
            .collect();
        assert_eq!(
            names,
            vec![
                ("build".into(), true),
                ("src".into(), false),
                (".gitignore".into(), false),
                ("a.txt".into(), false),
                ("B.txt".into(), false),
            ]
        );
        fs::remove_dir_all(&root)?;
        Ok(())
    }

    #[test]
    fn natural_order() {
        let mut names = vec![
            "file-10.txt",
            "File-2.txt",
            "file-1.txt",
            "a",
            "B",
            "file-02.txt",
        ];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            names,
            vec![
                "a",
                "B",
                "file-1.txt",
                "File-2.txt",
                "file-02.txt",
                "file-10.txt"
            ]
        );
    }

    #[test]
    fn create_rename_delete_and_read() -> Result<()> {
        let root = setup("ops")?;
        let file = create_file(&root, "new.ts")?;
        assert!(create_file(&root, "new.ts").is_err());
        assert!(create_file(&root, "../x").is_err());
        let renamed = rename(&file, "renamed.ts")?;
        assert!(renamed.exists() && !file.exists());
        write(&renamed, b"hello world")?;
        assert_eq!(read(&renamed, None)?, (b"hello world".to_vec(), false));
        assert_eq!(read(&renamed, Some(5))?, (b"hello".to_vec(), true));
        assert!(read(&root, None).is_err());
        let dir = create_dir(&root, "folder")?;
        delete(&dir, std::slice::from_ref(&root))?;
        assert!(!dir.exists());
        assert!(delete(&root, std::slice::from_ref(&root)).is_err());
        fs::remove_dir_all(&root)?;
        Ok(())
    }

    #[test]
    fn move_and_copy_into_folders() -> Result<()> {
        let root = setup("move")?;
        let roots = [root.clone()];
        let file = root.join("a.txt");
        let src = root.join("src");
        let moved = move_into(&file, &src, &roots)?;
        assert_eq!(moved, src.join("a.txt"));
        assert!(!file.exists());
        assert!(move_into(&src, &src, &roots).is_err());
        assert!(move_into(&root, &src, &roots).is_err());
        assert_eq!(copy_into(&moved, &src)?, src.join("a copy.txt"));
        assert_eq!(copy_into(&moved, &src)?, src.join("a copy 2.txt"));
        let tree = copy_into(&src, &root)?;
        assert_eq!(tree, root.join("src copy"));
        assert!(tree.join("main.ts").exists());
        fs::remove_dir_all(&root)?;
        Ok(())
    }

    #[test]
    fn writes_are_atomic_and_keep_the_mode() -> Result<()> {
        let root = setup("write")?;
        let file = root.join("deep/new/file.sh");
        write(&file, b"one")?;
        write(&file, b"two")?;
        assert_eq!(fs::read(&file)?, b"two");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&file, fs::Permissions::from_mode(0o755))?;
            write(&file, b"three")?;
            assert_eq!(fs::metadata(&file)?.permissions().mode() & 0o777, 0o755);
        }
        let leftovers = fs::read_dir(root.join("deep/new"))?.count();
        assert_eq!(leftovers, 1, "no temp files left behind");
        assert!(write(&root.join("src"), b"x").is_err());
        fs::remove_dir_all(&root)?;
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn copy_keeps_symlinks_as_links() -> Result<()> {
        let root = setup("copylink")?;
        let folder = root.join("linked");
        fs::create_dir_all(&folder)?;
        std::os::unix::fs::symlink("/etc", folder.join("dir-link"))?;
        let copy = copy_into(&folder, &root)?;
        assert!(fs::symlink_metadata(copy.join("dir-link"))?
            .file_type()
            .is_symlink());
        fs::remove_dir_all(&root)?;
        Ok(())
    }
}
