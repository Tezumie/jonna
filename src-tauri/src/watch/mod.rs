//! File watching for explorer refresh. Watches only the directories the frontend asks for
//! (the expanded folders), non-recursively. That keeps watch handles proportional to what is on
//! screen, so a 100k-file repo costs the same as a small one. Events are debounced and sent to the
//! frontend in batches over a Tauri Channel.

use std::collections::{BTreeSet, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use notify::{EventKind, PollWatcher, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{
    new_debouncer, new_debouncer_opt, DebounceEventResult, Debouncer, RecommendedCache,
};
use serde::Serialize;
use tauri::ipc::Channel;

use crate::error::{Error, Result};

const DEBOUNCE: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchBatch {
    /// Directories whose listing may have changed (parents of changed paths).
    pub dirs: Vec<String>,
    /// Paths that changed (created, modified, removed or renamed).
    pub paths: Vec<String>,
}

struct Active {
    debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
    /// For folders in WSL (D192): change notifications don't cross that file share, so those
    /// folders are polled (every 2 s, only the few that are watched).
    poll: Option<Debouncer<PollWatcher, RecommendedCache>>,
    dirs: HashSet<PathBuf>,
    mode: RecursiveMode,
}

impl Active {
    fn watch(&mut self, dir: &std::path::Path) -> bool {
        if crate::wsl::of_dir(dir).is_some() {
            return self
                .poll
                .as_mut()
                .is_some_and(|p| p.watch(dir, self.mode).is_ok());
        }
        self.debouncer.watch(dir, self.mode).is_ok()
    }

    fn unwatch(&mut self, dir: &std::path::Path) {
        if crate::wsl::of_dir(dir).is_some() {
            if let Some(p) = self.poll.as_mut() {
                let _ = p.unwatch(dir);
            }
        } else {
            let _ = self.debouncer.unwatch(dir);
        }
    }
}

/// The batch handler: changed paths and their folders, to the frontend.
fn handler(channel: Channel<WatchBatch>) -> impl FnMut(DebounceEventResult) + Send + 'static {
    move |result: DebounceEventResult| {
        let Ok(events) = result else { return };
        let mut dirs = BTreeSet::new();
        let mut paths = BTreeSet::new();
        for event in events {
            if matches!(event.kind, EventKind::Access(_)) {
                continue;
            }
            for path in &event.paths {
                if path.components().any(|c| c.as_os_str() == ".git") {
                    continue;
                }
                if let Some(parent) = path.parent() {
                    dirs.insert(parent.to_string_lossy().into_owned());
                }
                paths.insert(path.to_string_lossy().into_owned());
            }
        }
        if !paths.is_empty() {
            let batch = WatchBatch {
                dirs: dirs.into_iter().collect(),
                paths: paths.into_iter().collect(),
            };
            // The frontend may have gone away (reload); nothing useful to do on failure.
            let _ = channel.send(batch);
        }
    }
}

#[derive(Default)]
pub struct Watcher {
    active: Mutex<Option<Active>>,
    /// Each folder with everything below it (the agent's skills folders, D221), not one level.
    recursive: bool,
    /// Where batches go: also a remote window's folders' (D252: the server watches those and
    /// its batches come here).
    channel: Mutex<Option<Channel<WatchBatch>>>,
}

impl Watcher {
    /// A watcher of folders and everything below them (on Windows one handle per folder, on
    /// the folder itself, so what's inside can still be deleted or renamed).
    pub fn recursive() -> Self {
        Self {
            active: Mutex::new(None),
            recursive: true,
            channel: Mutex::new(None),
        }
    }

    /// Whether it watches folders with everything below them.
    pub fn is_recursive(&self) -> bool {
        self.recursive
    }

    /// The channel batches go to (None before `start`).
    pub fn channel(&self) -> Option<Channel<WatchBatch>> {
        self.channel.lock().ok().and_then(|c| c.clone())
    }

    /// Starts (or restarts) the watcher; batches go to `channel`.
    pub fn start(&self, channel: Channel<WatchBatch>) -> Result<()> {
        if let Ok(mut c) = self.channel.lock() {
            *c = Some(channel.clone());
        }
        let debouncer = new_debouncer(DEBOUNCE, None, handler(channel.clone()))
            .map_err(|e| Error::Watch(e.to_string()))?;
        let poll = new_debouncer_opt::<_, PollWatcher, RecommendedCache>(
            DEBOUNCE,
            None,
            handler(channel),
            RecommendedCache::new(),
            notify::Config::default().with_poll_interval(Duration::from_secs(2)),
        )
        .ok();
        let mut guard = self.lock()?;
        *guard = Some(Active {
            debouncer,
            poll,
            dirs: HashSet::new(),
            mode: if self.recursive {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            },
        });
        Ok(())
    }

    /// Replaces the set of watched directories with `dirs` (already scope-checked).
    pub fn set_dirs(&self, dirs: Vec<PathBuf>) -> Result<()> {
        let mut guard = self.lock()?;
        let active = guard
            .as_mut()
            .ok_or_else(|| Error::Watch("watcher not started".into()))?;
        let wanted: HashSet<PathBuf> = dirs.into_iter().filter(|d| d.is_dir()).collect();
        for gone in active.dirs.difference(&wanted).cloned().collect::<Vec<_>>() {
            active.unwatch(&gone);
            active.dirs.remove(&gone);
        }
        for new in wanted.difference(&active.dirs).cloned().collect::<Vec<_>>() {
            // A folder can vanish between the request and now; skip it rather than fail the batch.
            if active.watch(&new) {
                active.dirs.insert(new);
            }
        }
        Ok(())
    }

    /// Stops watching `path` and the folders under it; returns them (to watch again if needed).
    /// On Windows a watched folder is an open handle, and a folder with an open handle inside
    /// can't be moved or deleted (D190: deleting an expanded folder said "it is in use").
    pub fn release_under(&self, path: &std::path::Path) -> Vec<PathBuf> {
        let Ok(mut guard) = self.lock() else {
            return Vec::new();
        };
        let Some(active) = guard.as_mut() else {
            return Vec::new();
        };
        let under: Vec<PathBuf> = active
            .dirs
            .iter()
            .filter(|d| d.starts_with(path))
            .cloned()
            .collect();
        for d in &under {
            active.unwatch(d);
            active.dirs.remove(d);
        }
        under
    }

    /// Watches folders again that `release_under` let go (the delete didn't happen).
    pub fn rewatch(&self, dirs: Vec<PathBuf>) {
        let Ok(mut guard) = self.lock() else { return };
        let Some(active) = guard.as_mut() else { return };
        for d in dirs {
            if active.watch(&d) {
                active.dirs.insert(d);
            }
        }
    }

    pub fn stop(&self) -> Result<()> {
        let mut guard = self.lock()?;
        if let Some(active) = guard.take() {
            active.debouncer.stop_nonblocking();
            if let Some(p) = active.poll {
                p.stop_nonblocking();
            }
        }
        Ok(())
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Option<Active>>> {
        self.active
            .lock()
            .map_err(|_| Error::Watch("lock poisoned".into()))
    }
}
