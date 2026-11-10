//! The saved chats' list without reading every chat. Listing only needs each chat's `meta`
//! (title, dates, folder…), but the chat files hold whole transcripts, and the Chats list is
//! refreshed every 30 s: with hundreds of long chats, reading and parsing them all each time
//! is heavy. So each chat's `meta` is kept with the file's stamp (size and modified time) and a
//! chat is read again only when its stamp moved.
//!
//! The cache lives in memory per sessions folder and is also saved next to the chats
//! (`INDEX_FILE`, written atomically), so the first list after a restart is cheap too. The
//! saved index is only a hint: every entry is checked against the file's current stamp before
//! it's used, so a stale index (another window wrote it, or a chat changed while the IDE was
//! closed) costs a re-read, never a wrong title. A missing, unreadable or corrupt index is
//! simply rebuilt.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::SessionSummary;
use crate::store::atomic_write;

/// The saved index, in the sessions folder. Not a `.json` file, so it's never taken for a chat
/// (the list, and older versions of the IDE, only read `*.json`).
pub const INDEX_FILE: &str = ".meta-index";

/// Bumped when the index's shape changes: an index of another version is ignored (rebuilt).
const INDEX_VERSION: u32 = 1;

/// One chat's `meta` as of the file's `stamp`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    stamp: String,
    meta: Value,
}

#[derive(Deserialize)]
struct IndexFile {
    version: u32,
    entries: HashMap<String, Entry>,
}

#[derive(Serialize)]
struct IndexFileRef<'a> {
    version: u32,
    entries: &'a HashMap<String, Entry>,
}

/// One sessions folder's cache, by chat id.
#[derive(Default)]
struct DirCache {
    entries: HashMap<String, Entry>,
    /// Whether the saved index was read into `entries` (once per process).
    loaded: bool,
    /// How many chat files were read and parsed (tests check that unchanged ones aren't).
    parses: u64,
}

/// Per sessions folder (one in the app; tests use their own).
static CACHES: OnceLock<Mutex<HashMap<PathBuf, DirCache>>> = OnceLock::new();

fn caches() -> MutexGuard<'static, HashMap<PathBuf, DirCache>> {
    // A panic elsewhere while listing leaves at worst an incomplete cache, which the stamps
    // check anyway: keep using it rather than failing every later list.
    CACHES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// The folder's cache, with the saved index read in the first time.
fn dir_cache<'a>(all: &'a mut HashMap<PathBuf, DirCache>, dir: &Path) -> &'a mut DirCache {
    let cache = all.entry(dir.to_path_buf()).or_default();
    if !cache.loaded {
        cache.entries = load_index(dir);
        cache.loaded = true;
    }
    cache
}

fn load_index(dir: &Path) -> HashMap<String, Entry> {
    fs::read(dir.join(INDEX_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<IndexFile>(&bytes).ok())
        .filter(|index| index.version == INDEX_VERSION)
        .map(|index| index.entries)
        .unwrap_or_default()
}

fn save_index(dir: &Path, entries: &HashMap<String, Entry>) {
    let index = IndexFileRef {
        version: INDEX_VERSION,
        entries,
    };
    // Best effort: without the saved index the next start only reads every chat once.
    if let Ok(bytes) = serde_json::to_vec(&index) {
        let _ = atomic_write(&dir.join(INDEX_FILE), &bytes);
    }
}

/// A file's stamp: its size and modified time (ns). Saves are atomic renames of a closed file,
/// so each one moves it; None when the time can't be read (then the file is always read).
fn stamp(meta: &fs::Metadata) -> Option<String> {
    let nanos = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some(format!("{}:{nanos}", meta.len()))
}

/// A chat file's `meta`: Null when the file isn't a chat (bad JSON, no `meta`); None when it
/// couldn't be read (locked mid-save on Windows, say), so it isn't cached and is tried again.
fn read_meta(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    Some(
        serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|mut v| v.get_mut("meta").map(Value::take))
            .unwrap_or(Value::Null),
    )
}

/// Every chat in `dir` (`<id>.json`) with its `meta`, in the folder's order (the caller sorts).
/// Same result as reading each file, but a file whose stamp hasn't moved isn't read.
pub fn list(dir: &Path) -> Vec<SessionSummary> {
    let mut all = caches();
    let Ok(read) = fs::read_dir(dir) else {
        all.remove(dir);
        return Vec::new();
    };
    let cache = dir_cache(&mut all, dir);
    let mut fresh = HashMap::with_capacity(cache.entries.len());
    let mut changed = false;
    let mut out = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        let Some(id) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // The directory listing's own metadata (free on Windows); a link is followed, as the
        // read below would.
        let file_meta = match entry.metadata() {
            Ok(m) if m.file_type().is_symlink() => fs::metadata(&path).ok(),
            other => other.ok(),
        };
        let now = file_meta.as_ref().and_then(stamp);
        let cached = cache.entries.remove(&id);
        let meta = match (now, cached) {
            (Some(now), Some(e)) if e.stamp == now => {
                let meta = e.meta.clone();
                fresh.insert(id.clone(), e);
                meta
            }
            (now, _) => {
                cache.parses += 1;
                match read_meta(&path) {
                    Some(meta) => {
                        if let Some(stamp) = now {
                            fresh.insert(
                                id.clone(),
                                Entry {
                                    stamp,
                                    meta: meta.clone(),
                                },
                            );
                            changed = true;
                        }
                        meta
                    }
                    None => Value::Null,
                }
            }
        };
        out.push(SessionSummary { id, meta });
    }
    // What's left was deleted (or can't be listed any more).
    changed |= !cache.entries.is_empty();
    cache.entries = fresh;
    if changed {
        save_index(dir, &cache.entries);
    }
    out
}

/// Forgets a chat's entry (it was saved or deleted). The stamp would catch the change anyway;
/// this also covers a file system whose times are too coarse to tell two quick saves of the
/// same size apart. Not updated from the save itself: another window may save the same chat
/// between this write and its stamp, and its stamp would then vouch for this window's `meta`.
pub fn forget(dir: &Path, id: &str) {
    let mut all = caches();
    dir_cache(&mut all, dir).entries.remove(id);
}

#[cfg(test)]
pub fn parse_count(dir: &Path) -> u64 {
    caches().get(dir).map_or(0, |c| c.parses)
}

/// As after a restart: the memory cache is dropped (the parse count is kept).
#[cfg(test)]
pub fn drop_memory(dir: &Path) {
    if let Some(cache) = caches().get_mut(dir) {
        cache.entries.clear();
        cache.loaded = false;
    }
}

#[cfg(test)]
mod tests {
    use super::super::{delete_session, list_sessions, save_session, sessions_dir};
    use super::*;

    fn data(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ide-chat-index-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn chat(title: &str, updated: u64) -> String {
        format!(r#"{{"meta":{{"title":"{title}","updated":{updated}}},"items":[]}}"#)
    }

    fn titles(data: &Path) -> Vec<String> {
        list_sessions(data)
            .unwrap()
            .iter()
            .map(|s| format!("{}={}", s.id, s.meta["title"].as_str().unwrap_or("-")))
            .collect()
    }

    /// The list as it was before the cache: every file read.
    fn uncached(data: &Path) -> String {
        let mut out = Vec::new();
        for entry in fs::read_dir(sessions_dir(data)).unwrap().flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let id = path.file_stem().unwrap().to_str().unwrap().to_string();
            let meta = fs::read_to_string(&path)
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .and_then(|v| v.get("meta").cloned())
                .unwrap_or(Value::Null);
            out.push(SessionSummary { id, meta });
        }
        out.sort_by(|a, b| {
            let t =
                |s: &SessionSummary| s.meta.get("updated").and_then(Value::as_f64).unwrap_or(0.0);
            t(b).total_cmp(&t(a))
        });
        serde_json::to_string(&out).unwrap()
    }

    #[test]
    fn an_unchanged_chat_is_not_read_again() {
        let data = data("unchanged");
        let dir = sessions_dir(&data);
        save_session(&data, "a", &chat("first", 1)).unwrap();
        save_session(&data, "b", &chat("second", 2)).unwrap();
        fs::write(dir.join("broken.json"), "not json").unwrap();
        assert_eq!(titles(&data), ["b=second", "a=first", "broken=-"]);
        let parses = parse_count(&dir);
        assert_eq!(parses, 3);
        assert_eq!(titles(&data), ["b=second", "a=first", "broken=-"]);
        assert_eq!(parse_count(&dir), parses, "nothing changed: nothing read");
        // Same size and time but other content: only a read would see it, and none happens.
        let path = dir.join("a.json");
        let time = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, chat("XXXXX", 1)).unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(time)
            .unwrap();
        assert_eq!(titles(&data), ["b=second", "a=first", "broken=-"]);
        assert_eq!(parse_count(&dir), parses);
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn a_changed_or_saved_chat_is_read_again() {
        let data = data("changed");
        let dir = sessions_dir(&data);
        save_session(&data, "a", &chat("first", 1)).unwrap();
        save_session(&data, "b", &chat("second", 2)).unwrap();
        assert_eq!(titles(&data), ["b=second", "a=first"]);
        let parses = parse_count(&dir);
        // Written behind the IDE's back (another version, a sync tool): the stamp moved.
        fs::write(dir.join("a.json"), chat("first, renamed", 3)).unwrap();
        assert_eq!(titles(&data), ["a=first, renamed", "b=second"]);
        assert_eq!(
            parse_count(&dir),
            parses + 1,
            "only the changed chat is read"
        );
        // A save forgets the entry, even if the stamp somehow didn't move.
        save_session(&data, "b", &chat("second", 2)).unwrap();
        titles(&data);
        assert_eq!(parse_count(&dir), parses + 2);
        // A new chat shows up.
        save_session(&data, "c", &chat("third", 4)).unwrap();
        assert_eq!(titles(&data), ["c=third", "a=first, renamed", "b=second"]);
        assert_eq!(
            serde_json::to_string(&list_sessions(&data).unwrap()).unwrap(),
            uncached(&data)
        );
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn a_deleted_chat_drops_out_of_the_list_and_the_index() {
        let data = data("deleted");
        let dir = sessions_dir(&data);
        save_session(&data, "a", &chat("first", 1)).unwrap();
        save_session(&data, "b", &chat("second", 2)).unwrap();
        save_session(&data, "c", &chat("third", 3)).unwrap();
        assert_eq!(titles(&data), ["c=third", "b=second", "a=first"]);
        delete_session(&data, "b").unwrap();
        // Removed outside the IDE too.
        fs::remove_file(dir.join("c.json")).unwrap();
        assert_eq!(titles(&data), ["a=first"]);
        let saved = load_index(&dir);
        assert_eq!(saved.keys().collect::<Vec<_>>(), ["a"]);
        // The whole folder gone: an empty list.
        fs::remove_dir_all(&data).unwrap();
        assert!(list_sessions(&data).unwrap().is_empty());
    }

    #[test]
    fn the_saved_index_carries_over_a_restart_and_a_corrupt_one_is_rebuilt() {
        let data = data("restart");
        let dir = sessions_dir(&data);
        save_session(&data, "a", &chat("first", 1)).unwrap();
        save_session(&data, "b", &chat("second", 2)).unwrap();
        let before = titles(&data);
        let parses = parse_count(&dir);
        assert!(dir.join(INDEX_FILE).is_file());
        // A restart: the saved index answers, nothing is read.
        drop_memory(&dir);
        assert_eq!(titles(&data), before);
        assert_eq!(parse_count(&dir), parses);
        // A corrupt index: ignored, every chat read once, and the index written again.
        for junk in [&b"{ not json"[..], b"", br#"{"version":999,"entries":{}}"#] {
            drop_memory(&dir);
            fs::write(dir.join(INDEX_FILE), junk).unwrap();
            let parses = parse_count(&dir);
            assert_eq!(titles(&data), before);
            assert_eq!(parse_count(&dir), parses + 2);
            assert_eq!(load_index(&dir).len(), 2);
        }
        // A deleted index: rebuilt the same way.
        drop_memory(&dir);
        fs::remove_file(dir.join(INDEX_FILE)).unwrap();
        assert_eq!(titles(&data), before);
        assert!(dir.join(INDEX_FILE).is_file());
        // The index itself never shows up as a chat.
        assert_eq!(list_sessions(&data).unwrap().len(), 2);
        assert_eq!(
            serde_json::to_string(&list_sessions(&data).unwrap()).unwrap(),
            uncached(&data)
        );
        let _ = fs::remove_dir_all(&data);
    }
}
