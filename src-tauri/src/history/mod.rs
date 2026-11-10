//! Local history (like VS Code's): a snapshot of a workspace file's content each time the app
//! writes it (save, agent edit, replace all, restore), plus the content it had before the app
//! first wrote it. Lives in `<appData>/history/<hash of path>/` as one file per snapshot and an
//! `entries.json` index. Identical consecutive snapshots are kept once; each file keeps the last
//! 50; files over 1 MB are skipped.
//!
//! The app trash (`<appData>/trash/<id>/<name>`, with `<id>.json` saying where it came from)
//! holds deleted files and folders so a delete can be undone — also after the undo entry is
//! gone ("Restore deleted files…"); entries older than 30 days are removed at startup.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};
use crate::store::atomic_write;

const MAX_ENTRIES: usize = 50;
const MAX_BYTES: usize = 1024 * 1024;
/// Deleted items stay restorable this long ("Restore deleted files…", D141).
const TRASH_DAYS: u64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    /// Milliseconds since the Unix epoch.
    pub timestamp: u64,
    /// "original" (before the app first wrote it), "save", "agent", "replace", "restore"…
    pub source: String,
    pub size: u64,
    pub hash: String,
}

/// A deleted item waiting in the app trash.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Trashed {
    pub id: String,
    /// Where it was.
    pub path: String,
    /// Milliseconds since the Unix epoch.
    pub deleted: u64,
    pub is_dir: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Index {
    resource: String,
    entries: Vec<Entry>,
}

pub struct LocalHistory {
    dir: PathBuf,
    trash: PathBuf,
    lock: Mutex<()>,
    counter: AtomicU64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .take(16)
        .map(|b| format!("{b:02x}"))
        .collect()
}

impl LocalHistory {
    pub fn new(data_dir: &Path) -> Self {
        let history = Self {
            dir: data_dir.join("history"),
            trash: data_dir.join("trash"),
            lock: Mutex::new(()),
            counter: AtomicU64::new(0),
        };
        history.sweep_trash(Duration::from_secs(TRASH_DAYS * 86_400));
        history
    }

    fn folder(&self, path: &Path) -> PathBuf {
        let key = hash(path.to_string_lossy().as_bytes());
        self.dir.join(&key[..16])
    }

    fn next_id(&self) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        format!("{:x}-{n:x}", now_ms())
    }

    fn load(&self, folder: &Path) -> Index {
        fs::read(folder.join("entries.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn guard(&self) -> Result<std::sync::MutexGuard<'_, ()>> {
        self.lock
            .lock()
            .map_err(|_| Error::Invalid("lock poisoned".into()))
    }

    /// Records `bytes` as the file's newest snapshot (unless it equals the newest one already).
    /// Returns the entry that now holds this content, or None for large files.
    pub fn record(&self, path: &Path, bytes: &[u8], source: &str) -> Result<Option<Entry>> {
        if bytes.len() > MAX_BYTES {
            return Ok(None);
        }
        let _guard = self.guard()?;
        let folder = self.folder(path);
        let mut index = self.load(&folder);
        let digest = hash(bytes);
        if let Some(last) = index.entries.last() {
            if last.hash == digest {
                return Ok(Some(last.clone()));
            }
        }
        fs::create_dir_all(&folder)?;
        let entry = Entry {
            id: self.next_id(),
            timestamp: now_ms(),
            source: source.to_string(),
            size: bytes.len() as u64,
            hash: digest,
        };
        atomic_write(&folder.join(&entry.id), bytes)?;
        index.resource = path.to_string_lossy().into_owned();
        index.entries.push(entry.clone());
        while index.entries.len() > MAX_ENTRIES {
            let old = index.entries.remove(0);
            let _ = fs::remove_file(folder.join(old.id));
        }
        atomic_write(&folder.join("entries.json"), &serde_json::to_vec(&index)?)?;
        Ok(Some(entry))
    }

    /// Before the app overwrites `path`: snapshots what is on disk now if it differs from the
    /// newest snapshot (the first write, or a change made outside the app).
    pub fn before_write(&self, path: &Path) -> Result<Option<Entry>> {
        // Too large to keep anyway (`record` skips it): not read at all, a 300 MB file each save.
        if fs::metadata(path).is_ok_and(|m| m.len() > MAX_BYTES as u64) {
            return Ok(None);
        }
        match fs::read(path) {
            Ok(bytes) => {
                let source = if self.list(path).is_empty() {
                    "original"
                } else {
                    "external"
                };
                self.record(path, &bytes, source)
            }
            Err(_) => Ok(None),
        }
    }

    /// Snapshots of `path`, newest first.
    pub fn list(&self, path: &Path) -> Vec<Entry> {
        let mut entries = self.load(&self.folder(path)).entries;
        entries.reverse();
        entries
    }

    pub fn read(&self, path: &Path, id: &str) -> Result<Vec<u8>> {
        // Ids are the history's own names: anything else (`C:foo`, a separator) could leave
        // its folder (D203 audit).
        if id.is_empty()
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        {
            return Err(Error::Invalid("bad history id".into()));
        }
        Ok(fs::read(self.folder(path).join(id))?)
    }

    /// Moves `path` into the app trash and returns the trash id (undo moves it back).
    ///
    /// Never deletes for good: a move that fails because something inside is in use (Windows
    /// locks open files) is an error and nothing changes. Only when the trash is on another
    /// drive is the item copied there first and then removed — and if the removal stops half
    /// way, what was removed is copied back, so the folder is whole again.
    pub fn trash(&self, path: &Path) -> Result<Option<String>> {
        let name = path
            .file_name()
            .ok_or_else(|| Error::Invalid("nothing to trash".into()))?;
        let meta = fs::symlink_metadata(path)?;
        let id = self.next_id();
        let slot = self.trash.join(&id);
        fs::create_dir_all(&slot)?;
        let dest = slot.join(name);
        let note = Trashed {
            id: id.clone(),
            path: path.to_string_lossy().into_owned(),
            deleted: now_ms(),
            is_dir: meta.is_dir(),
        };
        let note_file = self.trash.join(format!("{id}.json"));
        let _ = atomic_write(&note_file, &serde_json::to_vec(&note)?);
        let result = self.trash_into(path, &slot, &dest, meta.is_dir());
        if result.is_err() {
            let _ = fs::remove_file(&note_file);
        }
        result.map(|()| Some(id))
    }

    fn trash_into(&self, path: &Path, slot: &Path, dest: &Path, is_dir: bool) -> Result<()> {
        match fs::rename(path, dest) {
            Ok(()) => Ok(()),
            Err(e) if crosses_devices(&e) => self.trash_across(path, slot, dest, is_dir),
            Err(e) => {
                let _ = fs::remove_dir_all(slot);
                Err(Error::Invalid(not_deleted(path, &e)))
            }
        }
    }

    /// The trash is on another drive than `path` (a project on D:, the app's data on C:).
    ///
    /// `path` is first renamed aside on its own drive, which works whole or not at all: on
    /// Windows a folder that a program has open (a terminal or a server running inside it)
    /// can't be renamed, so nothing is touched and the message says why. Deleting it in place
    /// after copying used to empty the folder and then fail on the folder itself, leaving an
    /// empty folder that vanished only when that program closed (and "os error 2" meanwhile).
    fn trash_across(&self, path: &Path, slot: &Path, dest: &Path, is_dir: bool) -> Result<()> {
        let fail = |message: String| {
            let _ = fs::remove_dir_all(slot);
            Err(Error::Invalid(message))
        };
        let Some(staged) = staging_path(path) else {
            return fail(format!("Couldn't delete {}", path.display()));
        };
        if let Err(e) = fs::rename(path, &staged) {
            return fail(not_deleted(path, &e));
        }
        // From here `path` is gone from the folder; any failure puts it back.
        let put_back = |reason: String| match fs::rename(&staged, path) {
            Ok(()) => fail(format!(
                "Couldn't delete {}: {reason}. Nothing was deleted.",
                path.display()
            )),
            Err(e) => Err(Error::Invalid(format!(
                "Couldn't delete {} ({reason}) nor put it back ({e}): it is at {}.",
                path.display(),
                staged.display()
            ))),
        };
        if let Err(e) = copy_tree(&staged, dest) {
            return put_back(format!("it couldn't be copied to the trash ({e})"));
        }
        let removed = if is_dir {
            fs::remove_dir_all(&staged)
        } else {
            fs::remove_file(&staged)
        };
        match removed {
            Ok(()) => Ok(()),
            // Only if a program opened it in the instant between: restore what was removed.
            Err(e) => match copy_missing(dest, &staged) {
                Ok(()) => put_back(e.to_string()),
                Err(repair) => Err(Error::Invalid(format!(
                    "Couldn't delete {} completely ({e}) nor put it back ({repair}). A full copy is kept at {}.",
                    path.display(),
                    dest.display()
                ))),
            },
        }
    }

    /// Everything in the app trash, newest first.
    pub fn trash_list(&self) -> Vec<Trashed> {
        let Ok(dir) = fs::read_dir(&self.trash) else {
            return Vec::new();
        };
        let mut out: Vec<Trashed> = dir
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
            .filter_map(|e| serde_json::from_slice::<Trashed>(&fs::read(e.path()).ok()?).ok())
            .filter(|t| self.has_trashed(&t.id))
            .collect();
        out.sort_by_key(|t| std::cmp::Reverse(t.deleted));
        out
    }

    /// Moves a trashed item back to `dest` (which must not exist).
    pub fn untrash(&self, id: &str, dest: &Path) -> Result<()> {
        if !valid_trash_id(id) {
            return Err(Error::Invalid("bad trash id".into()));
        }
        if fs::symlink_metadata(dest).is_ok() {
            return Err(Error::Invalid(format!(
                "{} exists again; not restoring over it",
                dest.display()
            )));
        }
        let slot = self.trash.join(id);
        let item = fs::read_dir(&slot)?
            .next()
            .ok_or_else(|| Error::Invalid("the trashed item is gone".into()))??
            .path();
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        match fs::rename(&item, dest) {
            Ok(()) => {}
            // The trash is on another drive: copy back, and only then let go of the trash copy.
            Err(e) if crosses_devices(&e) => {
                if let Err(e) = copy_tree(&item, dest) {
                    let _ = if fs::symlink_metadata(dest).is_ok_and(|m| m.is_dir()) {
                        fs::remove_dir_all(dest)
                    } else {
                        fs::remove_file(dest)
                    };
                    return Err(Error::Invalid(format!(
                        "Couldn't restore {}: {e}",
                        dest.display()
                    )));
                }
            }
            Err(e) => return Err(e.into()),
        }
        let _ = fs::remove_dir_all(slot);
        let _ = fs::remove_file(self.trash.join(format!("{id}.json")));
        Ok(())
    }

    /// Whether a trashed item is still there to restore.
    pub fn has_trashed(&self, id: &str) -> bool {
        valid_trash_id(id)
            && fs::read_dir(self.trash.join(id)).is_ok_and(|mut d| d.next().is_some())
    }

    fn sweep_trash(&self, max_age: Duration) {
        let Ok(dir) = fs::read_dir(&self.trash) else {
            return;
        };
        for slot in dir.flatten() {
            let old = slot
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > max_age);
            if old {
                let path = slot.path();
                if path.is_dir() {
                    let _ = fs::remove_dir_all(&path);
                } else {
                    let _ = fs::remove_file(&path);
                }
            }
        }
    }
}

/// Trash ids come from `next_id` (`<hex millis>-<hex counter>`). Anything else is refused: an
/// empty id would name the trash folder itself, and `untrash` would move (and then delete) an
/// arbitrary entry of it.
fn valid_trash_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
        && id.bytes().any(|b| b.is_ascii_hexdigit())
}

/// A hidden name beside `path` (same drive) to move it to while it's copied to the trash.
fn staging_path(path: &Path) -> Option<PathBuf> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    let parent = path.parent()?;
    (0..100)
        .map(|n| {
            parent.join(format!(
                ".{name}.deleting{}",
                if n == 0 {
                    String::new()
                } else {
                    format!("-{n}")
                }
            ))
        })
        .find(|p| fs::symlink_metadata(p).is_err())
}

/// Why `path` couldn't be deleted, in words (Windows says "access denied" for a folder in use).
fn not_deleted(path: &Path, e: &std::io::Error) -> String {
    let in_use = matches!(e.raw_os_error(), Some(5 | 32 | 145)) && cfg!(windows)
        || e.kind() == std::io::ErrorKind::PermissionDenied;
    if in_use {
        format!(
            "Couldn't delete {}: it is in use. Close terminals, servers or programs running inside it (or files open in them), then try again. Nothing was deleted.",
            path.display()
        )
    } else {
        format!(
            "Couldn't delete {}: {e}. Nothing was deleted (is a file inside open in another program?)",
            path.display()
        )
    }
}

fn crosses_devices(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::CrossesDevices
        || (cfg!(unix) && e.raw_os_error() == Some(18))
        || (cfg!(windows) && e.raw_os_error() == Some(17))
}

/// Copies a file or folder (symlinks as links on Unix).
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(from)?;
    #[cfg(unix)]
    if meta.file_type().is_symlink() {
        return std::os::unix::fs::symlink(fs::read_link(from)?, to);
    }
    if meta.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(from, to).map(|_| ())
    }
}

/// Copies back what `to` lacks from `from` (repairing a half-finished removal).
fn copy_missing(from: &Path, to: &Path) -> std::io::Result<()> {
    if fs::symlink_metadata(to).is_err() {
        return copy_tree(from, to);
    }
    if fs::symlink_metadata(from)?.is_dir() {
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_missing(&entry.path(), &to.join(entry.file_name()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("history-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn records_dedupes_and_caps() -> Result<()> {
        let dir = temp("records");
        let history = LocalHistory::new(&dir.join("data"));
        let file = dir.join("a.txt");
        fs::write(&file, "one")?;
        assert_eq!(
            history.before_write(&file)?.map(|e| e.source),
            Some("original".into())
        );
        history.record(&file, b"two", "save")?;
        history.record(&file, b"two", "save")?;
        let list = history.list(&file);
        assert_eq!(list.len(), 2);
        assert_eq!(history.read(&file, &list[0].id)?, b"two");
        assert_eq!(history.read(&file, &list[1].id)?, b"one");
        for i in 0..60 {
            history.record(&file, format!("v{i}").as_bytes(), "save")?;
        }
        assert_eq!(history.list(&file).len(), MAX_ENTRIES);
        fs::remove_dir_all(dir)?;
        Ok(())
    }

    #[test]
    fn trash_across_drives_moves_whole_or_not_at_all() -> Result<()> {
        // trash_across is what a delete to a trash on another drive uses; it works the same on
        // one drive, so it's tested directly.
        let dir = temp("across");
        let history = LocalHistory::new(&dir.join("data"));
        let folder = dir.join("ext");
        fs::create_dir_all(folder.join("sub"))?;
        fs::write(folder.join("sub/a.txt"), "a")?;
        let slot = dir.join("slot");
        fs::create_dir_all(&slot)?;
        history.trash_across(&folder, &slot, &slot.join("ext"), true)?;
        assert!(!folder.exists());
        assert_eq!(fs::read_to_string(slot.join("ext/sub/a.txt"))?, "a");
        // No staging folder is left behind.
        assert_eq!(
            fs::read_dir(&dir)?
                .filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().contains("deleting"))
                .count(),
            0
        );

        // The copy fails (its trash slot can't be written): the file is back where it was.
        let file = dir.join("b.txt");
        fs::write(&file, "b")?;
        let missing = dir.join("no-such-slot");
        let err = history.trash_across(&file, &missing, &missing.join("x/b.txt"), false);
        assert!(err.is_err());
        assert_eq!(fs::read_to_string(&file)?, "b");
        Ok(())
    }

    #[test]
    fn trash_ids_are_strict() -> Result<()> {
        let dir = temp("ids");
        let history = LocalHistory::new(&dir);
        let file = dir.join("ws").join("a.txt");
        fs::create_dir_all(file.parent().unwrap_or(&dir))?;
        fs::write(&file, "a")?;
        let id = history.trash(&file)?.expect("same drive");
        assert!(valid_trash_id(&id), "{id}");
        // "" would name the trash folder itself (and lose everything in it).
        for bad in ["", "-", "..", "a/b", "a\\b", "x.json", "zz-1"] {
            assert!(!history.has_trashed(bad), "{bad}");
            assert!(history.untrash(bad, &dir.join("out")).is_err(), "{bad}");
        }
        assert!(history.has_trashed(&id));
        let _ = fs::remove_dir_all(&dir);
        Ok(())
    }

    #[test]
    fn trash_and_restore() -> Result<()> {
        let dir = temp("trash");
        let history = LocalHistory::new(&dir.join("data"));
        let folder = dir.join("ws/sub");
        fs::create_dir_all(&folder)?;
        fs::write(folder.join("x.txt"), "x")?;
        let id = history.trash(&folder)?.expect("same drive");
        assert!(!folder.exists());
        assert!(history.has_trashed(&id));
        let listed = history.trash_list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].path, folder.to_string_lossy());
        assert!(listed[0].is_dir);
        // Never over something that's there again.
        fs::create_dir_all(&folder)?;
        assert!(history.untrash(&id, &folder).is_err());
        fs::remove_dir_all(&folder)?;
        history.untrash(&id, &folder)?;
        assert_eq!(fs::read_to_string(folder.join("x.txt"))?, "x");
        assert!(!history.has_trashed(&id));
        assert!(history.trash_list().is_empty());
        fs::remove_dir_all(dir)?;
        Ok(())
    }

    #[test]
    fn copy_fallback_keeps_everything() -> Result<()> {
        let dir = temp("copy");
        let src = dir.join("proj");
        fs::create_dir_all(src.join("src/deep"))?;
        fs::write(src.join("a.txt"), "a")?;
        fs::write(src.join("src/deep/b.txt"), "b")?;
        let copy = dir.join("copy");
        copy_tree(&src, &copy)?;
        assert_eq!(fs::read_to_string(copy.join("src/deep/b.txt"))?, "b");
        // A half-removed original is repaired from the copy.
        fs::remove_file(src.join("src/deep/b.txt"))?;
        copy_missing(&copy, &src)?;
        assert_eq!(fs::read_to_string(src.join("src/deep/b.txt"))?, "b");
        fs::remove_dir_all(dir)?;
        Ok(())
    }
}
