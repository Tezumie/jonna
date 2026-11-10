//! Watches a repository's git directory so the UI refreshes after commits, checkouts, staging
//! from a terminal, fetches… Only `<gitdir>` (HEAD, index, FETCH_HEAD…) and `<gitdir>/refs`
//! (recursively, it's small) are watched; working-tree edits come from the explorer watcher and
//! editor saves. `git status` runs with `GIT_OPTIONAL_LOCKS=0`, so refreshing doesn't touch the
//! index and can't loop.

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use tauri::ipc::Channel;

use crate::error::{Error, Result};

const DEBOUNCE: Duration = Duration::from_millis(250);

#[derive(Default)]
pub struct GitWatcher {
    active: Mutex<Option<Debouncer<RecommendedWatcher, RecommendedCache>>>,
    /// A remote window's git directory, looked at every few seconds (D252); set to stop.
    poll: Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>>,
}

/// Lock files come and go during every git operation; the rename to the real name is what counts.
fn interesting(path: &Path) -> bool {
    !path.extension().is_some_and(|e| e == "lock")
        && !path
            .components()
            .any(|c| c.as_os_str() == "objects" || c.as_os_str() == "logs")
}

impl GitWatcher {
    pub fn start(&self, git_dir: &Path, channel: Channel<()>) -> Result<()> {
        self.stop_poll();
        if let Some(dir) = crate::remote::of_dir(git_dir) {
            self.stop()?;
            let stop = crate::remote::poll_git_dir(dir, channel);
            if let Ok(mut p) = self.poll.lock() {
                *p = Some(stop);
            }
            return Ok(());
        }
        let mut debouncer = new_debouncer(DEBOUNCE, None, move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            let relevant = events.iter().any(|e| {
                !matches!(e.kind, EventKind::Access(_)) && e.paths.iter().any(|p| interesting(p))
            });
            if relevant {
                let _ = channel.send(());
            }
        })
        .map_err(|e| Error::Watch(e.to_string()))?;
        debouncer
            .watch(git_dir, RecursiveMode::NonRecursive)
            .map_err(|e| Error::Watch(e.to_string()))?;
        let refs = git_dir.join("refs");
        if refs.is_dir() {
            let _ = debouncer.watch(&refs, RecursiveMode::Recursive);
        }
        let mut guard = self.lock()?;
        if let Some(old) = guard.replace(debouncer) {
            old.stop_nonblocking();
        }
        Ok(())
    }

    pub fn stop(&self) -> Result<()> {
        self.stop_poll();
        if let Some(old) = self.lock()?.take() {
            old.stop_nonblocking();
        }
        Ok(())
    }

    fn stop_poll(&self) {
        if let Some(flag) = self.poll.lock().ok().and_then(|mut p| p.take()) {
            flag.store(true, std::sync::atomic::Ordering::Release);
        }
    }

    fn lock(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, Option<Debouncer<RecommendedWatcher, RecommendedCache>>>>
    {
        self.active
            .lock()
            .map_err(|_| Error::Watch("lock poisoned".into()))
    }
}
