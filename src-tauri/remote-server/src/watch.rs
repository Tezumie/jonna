//! Folder watching for the explorer and open documents, as the app's `watch` module: only the
//! folders the app asks for, each non-recursively unless asked otherwise, debounced into
//! `watch.batch` notifications (the app's `WatchBatch`). Independent sets (the explorer's, the
//! open documents') are told apart by `watcher`, a name the app picks, echoed in each batch.
//!
//! Folders on network file systems (NFS, SMB, 9p as in WSL's `/mnt/c`, FUSE such as sshfs) get
//! no change notifications from the kernel: those, and any folder inotify refuses (out of
//! watches), are polled every 2 s instead.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify::{EventKind, PollWatcher, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use serde::Serialize;
use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::outbox::Outbox;

const DEBOUNCE: Duration = Duration::from_millis(150);
const POLL_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WatchBatch {
    /// Folders whose listing may have changed (parents of changed paths).
    pub dirs: Vec<String>,
    /// Paths that changed (created, modified, removed or renamed).
    pub paths: Vec<String>,
}

struct WatchSet {
    mode: RecursiveMode,
    native: Debouncer<RecommendedWatcher, NoCache>,
    poll: Option<Debouncer<PollWatcher, NoCache>>,
    /// Watched folders, and whether each is polled.
    dirs: HashMap<PathBuf, bool>,
}

pub struct Watches {
    out: Outbox,
    sets: Mutex<HashMap<String, WatchSet>>,
}

impl Watches {
    pub fn new(out: Outbox) -> Self {
        Self {
            out,
            sets: Mutex::new(HashMap::new()),
        }
    }

    /// Replaces the folders set `name` watches with `dirs` (absolute; missing ones are skipped).
    /// No folders stops the set.
    pub fn set_dirs(&self, name: &str, dirs: Vec<PathBuf>, recursive: bool) -> Result<()> {
        let mode = if recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };
        let mut sets = self
            .sets
            .lock()
            .map_err(|_| Error::Watch("lock poisoned".into()))?;
        let wanted: HashSet<PathBuf> = dirs.into_iter().filter(|d| d.is_dir()).collect();
        if wanted.is_empty() {
            sets.remove(name);
            return Ok(());
        }
        if sets.get(name).is_some_and(|s| s.mode != mode) {
            sets.remove(name);
        }
        let set = match sets.entry(name.to_string()) {
            std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
            std::collections::hash_map::Entry::Vacant(e) => e.insert(self.new_set(name, mode)?),
        };
        let gone: Vec<(PathBuf, bool)> = set
            .dirs
            .iter()
            .filter(|(d, _)| !wanted.contains(*d))
            .map(|(d, p)| (d.clone(), *p))
            .collect();
        for (dir, polled) in gone {
            match (polled, set.poll.as_mut()) {
                (true, Some(poll)) => {
                    let _ = poll.unwatch(&dir);
                }
                _ => {
                    let _ = set.native.unwatch(&dir);
                }
            }
            set.dirs.remove(&dir);
        }
        for dir in wanted {
            if set.dirs.contains_key(&dir) {
                continue;
            }
            // A folder can vanish between the request and now; skip it rather than fail them all.
            let native = !needs_polling(&dir) && set.native.watch(&dir, mode).is_ok();
            let polled = !native
                && set
                    .poll
                    .as_mut()
                    .is_some_and(|p| p.watch(&dir, mode).is_ok());
            if native || polled {
                set.dirs.insert(dir, polled);
            }
        }
        Ok(())
    }

    fn new_set(&self, name: &str, mode: RecursiveMode) -> Result<WatchSet> {
        // No file-id cache (D250): it would walk and open every file under a recursive watch.
        let native = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
            DEBOUNCE,
            None,
            handler(self.out.clone(), name),
            NoCache,
            notify::Config::default(),
        )
        .map_err(|e| Error::Watch(e.to_string()))?;
        let poll = new_debouncer_opt::<_, PollWatcher, NoCache>(
            DEBOUNCE,
            None,
            handler(self.out.clone(), name),
            NoCache,
            notify::Config::default().with_poll_interval(POLL_INTERVAL),
        )
        .ok();
        Ok(WatchSet {
            mode,
            native,
            poll,
            dirs: HashMap::new(),
        })
    }
}

/// The batch handler: changed paths and their folders, to the app.
fn handler(out: Outbox, name: &str) -> impl FnMut(DebounceEventResult) + Send + 'static {
    let name = name.to_string();
    move |result: DebounceEventResult| {
        let Ok(events) = result else { return };
        if let Some(batch) = batch(events.iter().map(|e| (&e.kind, &e.paths[..]))) {
            let mut params: Value = serde_json::to_value(&batch).unwrap_or_else(|_| json!({}));
            params["watcher"] = json!(name);
            out.notify("watch.batch", params);
        }
    }
}

/// What a batch of events changed, outside `.git`, without reads; None when nothing did.
fn batch<'a>(events: impl Iterator<Item = (&'a EventKind, &'a [PathBuf])>) -> Option<WatchBatch> {
    let mut dirs = BTreeSet::new();
    let mut paths = BTreeSet::new();
    for (kind, list) in events {
        if matches!(kind, EventKind::Access(_)) {
            continue;
        }
        for path in list {
            if path.components().any(|c| c.as_os_str() == ".git") {
                continue;
            }
            if let Some(parent) = path.parent() {
                dirs.insert(parent.to_string_lossy().into_owned());
            }
            paths.insert(path.to_string_lossy().into_owned());
        }
    }
    (!paths.is_empty()).then(|| WatchBatch {
        dirs: dirs.into_iter().collect(),
        paths: paths.into_iter().collect(),
    })
}

/// Whether `dir` is on a file system the kernel doesn't report changes for.
#[cfg(target_os = "linux")]
fn needs_polling(dir: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `path` is a valid C string and `info` a properly sized, writable statfs buffer.
    let info = unsafe {
        let mut info: libc::statfs = std::mem::zeroed();
        if libc::statfs(path.as_ptr(), &mut info) != 0 {
            return false;
        }
        info
    };
    // `f_type`'s type differs between C libraries (and architectures).
    #[allow(clippy::unnecessary_cast)]
    let magic = info.f_type as u64;
    is_network_fs(magic)
}

#[cfg(not(target_os = "linux"))]
fn needs_polling(_dir: &Path) -> bool {
    false
}

/// statfs magic numbers of file systems without (reliable) inotify events.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn is_network_fs(magic: u64) -> bool {
    matches!(
        magic & 0xffff_ffff,
        0x6969 // NFS
            | 0x517b // SMB
            | 0xff53_4d42 // CIFS
            | 0xfe53_4d42 // SMB2
            | 0x0102_1997 // 9p (WSL's drvfs, VM shares)
            | 0x6573_5546 // FUSE (sshfs, rclone)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::outbox::Out;

    #[test]
    fn batches_skip_git_and_reads() {
        use notify::event::{AccessKind, CreateKind};
        let create = EventKind::Create(CreateKind::File);
        let access = EventKind::Access(AccessKind::Any);
        let a = [PathBuf::from("/w/a.txt"), PathBuf::from("/w/.git/HEAD")];
        let b = [PathBuf::from("/w/read.txt")];
        let out = batch([(&create, &a[..]), (&access, &b[..])].into_iter());
        let want = WatchBatch {
            dirs: vec![Path::new("/w").to_string_lossy().into_owned()],
            paths: vec![PathBuf::from("/w/a.txt").to_string_lossy().into_owned()],
        };
        assert_eq!(out, Some(want));
        assert_eq!(batch([(&access, &b[..])].into_iter()), None);
        assert!(is_network_fs(0x0102_1997) && !is_network_fs(0xEF53));
    }

    #[test]
    fn a_watched_folder_reports_changes() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("rs-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        let dir = crate::workspace::canonicalize(&dir)?;
        let (out, rx) = Outbox::new();
        let watches = Watches::new(out);
        watches.set_dirs("explorer", vec![dir.clone()], false)?;
        std::thread::sleep(Duration::from_millis(100));
        std::fs::write(dir.join("new.txt"), "x")?;
        let mut seen = false;
        while let Ok(Out::Frame(bytes)) = rx.recv_timeout(Duration::from_secs(5)) {
            let message: Value = serde_json::from_slice(&bytes)?;
            assert_eq!(message["notify"], "watch.batch");
            assert_eq!(message["params"]["watcher"], "explorer");
            if message["params"]["paths"].to_string().contains("new.txt") {
                seen = true;
                break;
            }
        }
        assert!(seen);
        watches.set_dirs("explorer", vec![], false)?;
        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }
}
