//! The file index for quick open, as the app's `index` module: one `ignore` walk per workspace
//! folder (honoring .gitignore, skipping `.git`) builds a list of relative paths in a background
//! thread; a watcher per folder marks it stale on create/remove/rename and a debounced rebuild
//! follows. On Linux the watcher adds one non-recursive watch per indexed (non-ignored) folder,
//! because inotify would otherwise watch every ignored folder too (node_modules). The same
//! watchers tell a listener (`index.listen`) which files changed, as `index.changes`.

pub mod fuzzy;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use ignore::WalkBuilder;
use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use serde::Serialize;

use crate::error::{Error, Result};
use crate::outbox::Outbox;

/// Upper bound on indexed files per folder (quick open stays responsive; the rest is still
/// searchable).
const MAX_FILES: usize = 300_000;
/// Upper bound on per-folder watches (Linux).
#[cfg(target_os = "linux")]
const MAX_WATCHED_DIRS: usize = 8_000;
const DEBOUNCE: Duration = Duration::from_millis(300);
/// Paths sent per batch to the listener; past that it's told "many" (`overflow`).
const MAX_CHANGED_PATHS: usize = 1000;

/// Files that changed on disk (created, modified, removed, renamed), outside `.git`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IndexChanges {
    /// Absolute paths, at most MAX_CHANGED_PATHS.
    pub paths: Vec<String>,
    /// More changed than listed (a checkout, a build): treat every folder as changed.
    pub overflow: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueryItem {
    /// Relative to its workspace folder (the first one unless `root` says otherwise), `/`
    /// separators.
    pub path: String,
    pub score: i64,
    pub positions: Vec<usize>,
    /// The workspace folder (absolute) holding it, only when that isn't the first one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub items: Vec<QueryItem>,
    /// Files in the index.
    pub total: usize,
    /// A (re)build is running; results may be incomplete.
    pub indexing: bool,
    /// A walk stopped at MAX_FILES.
    pub truncated: bool,
}

/// Who hears about changed files (after `index.listen`).
struct Listener {
    out: Outbox,
    on: AtomicBool,
}

/// One workspace folder's list and watcher.
struct Folder {
    root: PathBuf,
    /// Taken out of the workspace: a build finishing or a watcher event afterwards is dropped.
    closed: AtomicBool,
    state: Mutex<FolderState>,
}

#[derive(Default)]
struct FolderState {
    files: Vec<String>,
    building: bool,
    /// Changes arrived while building: build again when done.
    stale: bool,
    truncated: bool,
    watcher: Option<Debouncer<RecommendedWatcher, NoCache>>,
    #[cfg(target_os = "linux")]
    watched: std::collections::HashSet<PathBuf>,
}

pub struct FileIndex {
    folders: Mutex<Vec<Arc<Folder>>>,
    listener: Arc<Listener>,
}

impl FileIndex {
    pub fn new(out: Outbox) -> Self {
        Self {
            folders: Mutex::new(Vec::new()),
            listener: Arc::new(Listener {
                out,
                on: AtomicBool::new(false),
            }),
        }
    }

    /// Indexes exactly `roots` (canonical, the first one first): folders already indexed keep
    /// their list and watcher, the others start, the ones gone stop.
    pub fn set_folders(&self, roots: &[PathBuf]) {
        let Ok(mut folders) = self.folders.lock() else {
            return;
        };
        let old = std::mem::take(&mut *folders);
        let mut started = Vec::new();
        for root in roots {
            if folders.iter().any(|f| &f.root == root) {
                continue;
            }
            match old.iter().find(|f| &f.root == root) {
                Some(f) => folders.push(f.clone()),
                None => {
                    let folder = Arc::new(Folder {
                        root: root.clone(),
                        closed: AtomicBool::new(false),
                        state: Mutex::new(FolderState::default()),
                    });
                    folders.push(folder.clone());
                    started.push(folder);
                }
            }
        }
        for gone in old.iter().filter(|f| !roots.contains(&f.root)) {
            gone.close();
        }
        drop(folders);
        for folder in started {
            start_watcher(&folder, &self.listener);
            rebuild(&folder);
        }
    }

    /// The best `limit` files for `query` over every folder, or over `root` alone (canonical, one
    /// of the folders). An empty query lists files, the project's own first.
    pub fn query(&self, query: &str, limit: usize, root: Option<&Path>) -> Result<QueryResult> {
        let folders = self
            .folders
            .lock()
            .map_err(|_| Error::Invalid("file index lock poisoned".into()))?
            .clone();
        let chosen: Vec<(usize, &Arc<Folder>)> = folders
            .iter()
            .enumerate()
            .filter(|(_, f)| root.is_none_or(|r| f.root == r))
            .collect();
        if root.is_some() && chosen.is_empty() {
            return Err(Error::OutsideScope(
                root.map(|r| r.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            ));
        }
        // Every chosen folder locked at once (always in folder order; builds lock one at a time).
        let guards: Vec<(usize, &Arc<Folder>, MutexGuard<'_, FolderState>)> = chosen
            .into_iter()
            .filter_map(|(i, f)| f.state.lock().ok().map(|g| (i, f, g)))
            .collect();
        let lists: Vec<(Option<String>, &[String])> = guards
            .iter()
            .map(|(i, f, g)| (folder_label(*i, &f.root), g.files.as_slice()))
            .collect();
        let mut items = merged_query(&lists, query, limit);
        items.shrink_to_fit();
        Ok(QueryResult {
            items,
            total: guards.iter().map(|(_, _, g)| g.files.len()).sum(),
            indexing: guards.iter().any(|(_, _, g)| g.building),
            truncated: guards.iter().any(|(_, _, g)| g.truncated),
        })
    }

    /// Sends `index.changes` from now on. Returns whether a watcher runs for the first folder
    /// (false: none open, or watching failed, so the app keeps polling).
    pub fn listen(&self) -> bool {
        self.listener.on.store(true, Ordering::Relaxed);
        self.folders
            .lock()
            .ok()
            .and_then(|f| f.first().cloned())
            .and_then(|f| f.state.lock().ok().map(|s| s.watcher.is_some()))
            .unwrap_or(false)
    }
}

impl Folder {
    fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        // Dropped here, not with the last reference (a build thread may hold one for a while).
        let watcher = self.state.lock().ok().and_then(|mut s| s.watcher.take());
        drop(watcher);
    }
}

fn rebuild(folder: &Arc<Folder>) {
    {
        let Ok(mut state) = folder.state.lock() else {
            return;
        };
        if folder.closed.load(Ordering::Relaxed) {
            return;
        }
        if state.building {
            state.stale = true;
            return;
        }
        state.building = true;
        state.stale = false;
    }
    let folder = folder.clone();
    std::thread::spawn(move || {
        let (files, dirs, truncated) = walk(&folder.root);
        let again = {
            let Ok(mut state) = folder.state.lock() else {
                return;
            };
            if folder.closed.load(Ordering::Relaxed) {
                return;
            }
            state.files = files;
            state.truncated = truncated;
            state.building = false;
            #[cfg(target_os = "linux")]
            update_dir_watches(&mut state, dirs);
            #[cfg(not(target_os = "linux"))]
            drop(dirs);
            state.stale
        };
        if again {
            rebuild(&folder);
        }
    });
}

fn start_watcher(folder: &Arc<Folder>, listener: &Arc<Listener>) {
    // Weak: the folder owns the watcher, whose handler must not keep the folder alive.
    let weak: Weak<Folder> = Arc::downgrade(folder);
    let listener = listener.clone();
    let handler = move |result: DebounceEventResult| {
        let Ok(events) = result else { return };
        let Some(folder) = weak.upgrade() else { return };
        if folder.closed.load(Ordering::Relaxed) {
            return;
        }
        if listener.on.load(Ordering::Relaxed) {
            let changes = changed_paths(events.iter().map(|e| (&e.kind, &e.paths[..])));
            if !changes.paths.is_empty() || changes.overflow {
                if let Ok(params) = serde_json::to_value(&changes) {
                    listener.out.notify("index.changes", params);
                }
            }
        }
        let structural = events.iter().any(|e| {
            matches!(
                e.kind,
                EventKind::Create(_)
                    | EventKind::Remove(_)
                    | EventKind::Modify(notify::event::ModifyKind::Name(_))
            ) && !e
                .paths
                .iter()
                .all(|p| p.components().any(|c| c.as_os_str() == ".git"))
        });
        if structural {
            rebuild(&folder);
        }
    };
    // No file-id cache: the recommended one walks the whole folder and opens every file before
    // the first event (D250). Only the changed paths matter here.
    let debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
        DEBOUNCE,
        None,
        handler,
        NoCache,
        notify::Config::default(),
    );
    let Ok(mut debouncer) = debouncer else {
        eprintln!("can't watch {}", folder.root.display());
        return;
    };
    #[cfg(not(target_os = "linux"))]
    let mode = RecursiveMode::Recursive;
    #[cfg(target_os = "linux")]
    let mode = RecursiveMode::NonRecursive;
    if let Err(e) = debouncer.watch(&folder.root, mode) {
        eprintln!("can't watch {}: {e}", folder.root.display());
        return;
    }
    if let Ok(mut state) = folder.state.lock() {
        if !folder.closed.load(Ordering::Relaxed) {
            state.watcher = Some(debouncer);
        }
    }
}

/// What a folder's items carry as `root`: nothing for the first folder, its path for the others.
fn folder_label(index: usize, root: &Path) -> Option<String> {
    (index > 0).then(|| root.to_string_lossy().into_owned())
}

/// The best `limit` items over several folders' lists (`(root label, files)`, the first folder
/// first). An empty query lists the folders' own files (in order) before any dependencies; a
/// query ranks them all together (fuzzy, then shorter paths, then folder order).
fn merged_query(
    lists: &[(Option<String>, &[String])],
    query: &str,
    limit: usize,
) -> Vec<QueryItem> {
    if query.trim().is_empty() {
        // The project's own files before dependencies and build output, so a limit doesn't fill
        // up with node_modules in a folder without a .gitignore.
        let own = lists.iter().flat_map(|(root, files)| {
            files
                .iter()
                .filter(|p| !is_dependency_path(p))
                .map(move |p| (root, p))
        });
        let deps = lists.iter().flat_map(|(root, files)| {
            files
                .iter()
                .filter(|p| is_dependency_path(p))
                .map(move |p| (root, p))
        });
        return own
            .chain(deps)
            .take(limit)
            .map(|(root, p)| QueryItem {
                path: p.clone(),
                score: 0,
                positions: Vec::new(),
                root: root.clone(),
            })
            .collect();
    }
    let mut all: Vec<QueryItem> = Vec::new();
    for (root, files) in lists {
        all.extend(rank(files, query, limit).into_iter().map(|mut item| {
            item.root.clone_from(root);
            item
        }));
    }
    if lists.len() > 1 {
        // A stable sort: equal items keep their folder's order.
        sort_ranked(&mut all);
        all.truncate(limit);
    }
    all
}

/// The best `limit` of `files` for a non-empty `query` (fuzzy, then shorter paths first).
fn rank(files: &[String], query: &str, limit: usize) -> Vec<QueryItem> {
    let mut scored: Vec<QueryItem> = files
        .iter()
        .filter_map(|p| {
            fuzzy::score(query, p).map(|s| QueryItem {
                path: p.clone(),
                score: s.score,
                positions: s.positions,
                root: None,
            })
        })
        .collect();
    sort_ranked(&mut scored);
    scored.truncate(limit);
    scored
}

fn sort_ranked(items: &mut [QueryItem]) {
    items.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.path.len().cmp(&b.path.len()))
    });
}

/// The files a batch of events touched, outside `.git`, without reads (access events) and
/// without repeats.
fn changed_paths<'a>(events: impl Iterator<Item = (&'a EventKind, &'a [PathBuf])>) -> IndexChanges {
    let mut seen = std::collections::HashSet::new();
    let mut paths = Vec::new();
    let mut overflow = false;
    'events: for (kind, list) in events {
        if matches!(kind, EventKind::Access(_)) {
            continue;
        }
        for p in list {
            if p.components().any(|c| c.as_os_str() == ".git") {
                continue;
            }
            let text = p.to_string_lossy().into_owned();
            if seen.contains(&text) {
                continue;
            }
            if paths.len() >= MAX_CHANGED_PATHS {
                overflow = true;
                break 'events;
            }
            seen.insert(text.clone());
            paths.push(text);
        }
    }
    IndexChanges { paths, overflow }
}

#[cfg(target_os = "linux")]
fn update_dir_watches(state: &mut FolderState, dirs: Vec<PathBuf>) {
    let Some(watcher) = state.watcher.as_mut() else {
        return;
    };
    let wanted: std::collections::HashSet<PathBuf> =
        dirs.into_iter().take(MAX_WATCHED_DIRS).collect();
    for gone in state
        .watched
        .difference(&wanted)
        .cloned()
        .collect::<Vec<_>>()
    {
        let _ = watcher.unwatch(&gone);
        state.watched.remove(&gone);
    }
    for new in wanted
        .difference(&state.watched)
        .cloned()
        .collect::<Vec<_>>()
    {
        if watcher.watch(&new, RecursiveMode::NonRecursive).is_ok() {
            state.watched.insert(new);
        }
    }
}

/// Walks `root` honoring .gitignore (also outside git repos), skipping `.git`. Returns relative
/// file paths with `/` separators, the folders visited, and whether MAX_FILES cut it short.
pub fn walk(root: &Path) -> (Vec<String>, Vec<PathBuf>, bool) {
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    let mut truncated = false;
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(false)
        .require_git(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build();
    for entry in walker.flatten() {
        let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
        if is_dir {
            dirs.push(entry.path().to_path_buf());
            continue;
        }
        if files.len() >= MAX_FILES {
            truncated = true;
            break;
        }
        if let Ok(rel) = entry.path().strip_prefix(root) {
            let rel = rel.to_string_lossy().replace('\\', "/");
            if !rel.is_empty() {
                files.push(rel);
            }
        }
    }
    (files, dirs, truncated)
}

/// A path inside a dependency or build folder (listed after the project's own files).
fn is_dependency_path(path: &str) -> bool {
    path.split('/').any(|part| {
        matches!(
            part,
            "node_modules"
                | "target"
                | "vendor"
                | "dist"
                | "build"
                | ".git"
                | "__pycache__"
                | ".venv"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changed_paths_skip_git_access_and_repeats() {
        use notify::event::{AccessKind, CreateKind, ModifyKind};
        let a = [PathBuf::from("/w/src/a.ts"), PathBuf::from("/w/.git/index")];
        let b = [PathBuf::from("/w/src/a.ts"), PathBuf::from("/w/b.txt")];
        let c = [PathBuf::from("/w/read.txt")];
        let modify = EventKind::Modify(ModifyKind::Any);
        let create = EventKind::Create(CreateKind::File);
        let access = EventKind::Access(AccessKind::Any);
        let events = [(&modify, &a[..]), (&create, &b[..]), (&access, &c[..])];
        let out = changed_paths(events.into_iter());
        let want: Vec<String> = [PathBuf::from("/w/src/a.ts"), PathBuf::from("/w/b.txt")]
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        assert_eq!(out.paths, want);
        assert!(!out.overflow);
        let many: Vec<PathBuf> = (0..MAX_CHANGED_PATHS + 5)
            .map(|i| PathBuf::from(format!("/w/f{i}")))
            .collect();
        let out = changed_paths([(&modify, &many[..])].into_iter());
        assert_eq!(out.paths.len(), MAX_CHANGED_PATHS);
        assert!(out.overflow);
    }

    #[test]
    fn merged_query_ranks_folders_together_and_labels_the_others() {
        let first: Vec<String> = vec!["src/main.ts".into(), "node_modules/x/main.js".into()];
        let second: Vec<String> = vec!["main.ts".into(), "lib/other.ts".into()];
        let lists = [
            (None, first.as_slice()),
            (Some("/b".to_string()), second.as_slice()),
        ];
        let listed = merged_query(&lists, "", 10);
        let order: Vec<&str> = listed.iter().map(|i| i.path.as_str()).collect();
        assert_eq!(
            order,
            [
                "src/main.ts",
                "main.ts",
                "lib/other.ts",
                "node_modules/x/main.js"
            ]
        );
        let ranked = merged_query(&lists, "main", 2);
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].path, "main.ts");
        assert_eq!(ranked[0].root.as_deref(), Some("/b"));
        assert_eq!(ranked[1].root, None);
    }

    #[test]
    fn index_builds_and_answers_queries() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("rs-index-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("a/src/deep"))?;
        std::fs::create_dir_all(dir.join("a/build"))?;
        std::fs::create_dir_all(dir.join("a/.git"))?;
        std::fs::create_dir_all(dir.join("b"))?;
        std::fs::write(dir.join("a/.gitignore"), "build/\n")?;
        std::fs::write(dir.join("a/src/deep/needle.ts"), "")?;
        std::fs::write(dir.join("a/build/needle.js"), "")?;
        std::fs::write(dir.join("a/.git/HEAD"), "")?;
        std::fs::write(dir.join("b/needle.md"), "")?;
        let (a, b) = (
            crate::workspace::canonicalize(dir.join("a"))?,
            crate::workspace::canonicalize(dir.join("b"))?,
        );
        let (out, _rx) = Outbox::new();
        let index = FileIndex::new(out);
        index.set_folders(&[a.clone(), b.clone()]);
        let mut result = index.query("needle", 10, None)?;
        for _ in 0..200 {
            if !result.indexing && result.total == 3 {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
            result = index.query("needle", 10, None)?;
        }
        let mut paths: Vec<&str> = result.items.iter().map(|i| i.path.as_str()).collect();
        paths.sort_unstable();
        assert_eq!(paths, ["needle.md", "src/deep/needle.ts"]);
        let only_b = index.query("", 10, Some(&b))?;
        assert_eq!(only_b.items.len(), 1);
        assert!(index.query("", 10, Some(&dir)).is_err());
        index.set_folders(std::slice::from_ref(&a));
        assert_eq!(index.query("needle", 10, None)?.items.len(), 1);
        index.set_folders(&[]);
        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    }
}
