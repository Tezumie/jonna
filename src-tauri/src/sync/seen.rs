//! The highest counter this computer has seen in each record, kept on disk and never synced
//! (`<data>/sync/seen.json`). Every record a client writes carries a counter inside its sealed
//! text that only goes up; a copy handed back with a lower one is an older version of the
//! record (replayed, or rolled back), and is never used.
//!
//! One file for the account's own vault and the shares this computer reads, each under a
//! name made from its keyring (`Keyring::name_of`): a vault that was reset, or a share made
//! again, has other keys and so starts from nothing.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use crate::error::Result;
use crate::store::atomic_write_private;

type Scopes = BTreeMap<String, BTreeMap<String, u64>>;

struct Loaded {
    path: PathBuf,
    /// The file's date when it was read: another window's write is read again.
    modified: Option<SystemTime>,
    scopes: Scopes,
}

static CACHE: Mutex<Vec<Loaded>> = Mutex::new(Vec::new());

fn modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn read(path: &Path) -> Scopes {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn with<T>(path: &Path, f: impl FnOnce(&mut Loaded) -> T) -> T {
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let now = modified(path);
    let at = match cache.iter().position(|l| l.path == path) {
        Some(at) => {
            if cache[at].modified != now {
                cache[at].scopes = read(path);
                cache[at].modified = now;
            }
            at
        }
        None => {
            cache.push(Loaded {
                path: path.to_path_buf(),
                modified: now,
                scopes: read(path),
            });
            cache.len() - 1
        }
    };
    f(&mut cache[at])
}

/// The highest counter seen in `place` (a record's name) of `scope`; 0 when none was.
pub fn highest(path: &Path, scope: &str, place: &str) -> u64 {
    with(path, |l| {
        l.scopes
            .get(scope)
            .and_then(|s| s.get(place))
            .copied()
            .unwrap_or(0)
    })
}

/// What reading or writing records found, to keep: counters to raise, and records an older
/// version of the app wrote without one (`forget`: nothing is known of them any more).
#[derive(Default)]
pub struct Found {
    raise: Vec<(String, u64)>,
    forget: Vec<String>,
}

impl Found {
    pub fn raise(&mut self, place: &str, counter: u64) {
        self.raise.push((place.to_string(), counter));
    }

    pub fn forget(&mut self, place: &str) {
        self.forget.push(place.to_string());
    }
}

/// Keeps what was found. Written before a record's content is handed on, so a copy older
/// than one that was used is refused after a restart too.
pub fn keep(path: &Path, scope: &str, found: Found) -> Result<()> {
    if found.raise.is_empty() && found.forget.is_empty() {
        return Ok(());
    }
    with(path, |l| {
        // Another window may have written since: its counters count too.
        if l.modified != modified(path) {
            for (scope, places) in read(path) {
                let mine = l.scopes.entry(scope).or_default();
                for (place, n) in places {
                    let at = mine.entry(place).or_insert(0);
                    *at = (*at).max(n);
                }
            }
        }
        let places = l.scopes.entry(scope.to_string()).or_default();
        let mut changed = false;
        for place in found.forget {
            changed |= places.remove(&place).is_some();
        }
        for (place, n) in found.raise {
            let at = places.entry(place).or_insert(0);
            if n > *at {
                *at = n;
                changed = true;
            }
        }
        if !changed {
            return Ok(());
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        atomic_write_private(path, &serde_json::to_vec(&l.scopes)?)?;
        l.modified = modified(path);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_only_go_up_and_survive_being_read_again() {
        let dir = std::env::temp_dir().join(format!("ide-seen-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("sync").join("seen.json");
        assert_eq!(highest(&path, "vault", "settings/user"), 0);
        let mut found = Found::default();
        found.raise("settings/user", 7);
        found.raise("files/a", 3);
        keep(&path, "vault", found).unwrap();
        let mut lower = Found::default();
        lower.raise("settings/user", 5);
        keep(&path, "vault", lower).unwrap();
        assert_eq!(highest(&path, "vault", "settings/user"), 7);
        // Another keyring (a share, a vault set up again) knows nothing of it.
        assert_eq!(highest(&path, "share", "settings/user"), 0);
        // What is on disk is what a restart reads.
        let on_disk = read(&path);
        assert_eq!(on_disk["vault"]["settings/user"], 7);
        assert_eq!(on_disk["vault"]["files/a"], 3);
        // A record an older version wrote without a counter starts again from nothing.
        let mut forget = Found::default();
        forget.forget("files/a");
        keep(&path, "vault", forget).unwrap();
        assert_eq!(highest(&path, "vault", "files/a"), 0);
        // Another window's write is picked up.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&path, r#"{"vault":{"settings/user":9}}"#).unwrap();
        assert_eq!(highest(&path, "vault", "settings/user"), 9);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
