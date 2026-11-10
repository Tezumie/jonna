//! Workspace file index for quick open. One `ignore` walk (respects .gitignore, skips `.git`)
//! per workspace folder builds a list of relative file paths in a background thread; a watcher
//! per folder marks it stale on create/remove/rename and a debounced rebuild follows. On Linux
//! the watcher adds one non-recursive watch per indexed (non-ignored) folder, because inotify
//! would otherwise watch every ignored folder too (node_modules); elsewhere one recursive watch on
//! the folder is cheap. D220: the same watchers tell a listener (Source control) which files
//! changed, so `git status` runs when something changes on disk instead of on a fast poll.
//!
//! Several folders (a multi-root workspace): the first is the primary (`open`), the others come
//! and go with `set_folders`, each with its own list and watcher. A query merges them; an item
//! from another folder than the primary names it (`root`), its `path` relative to that folder.

pub mod fuzzy;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use ignore::WalkBuilder;
use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::error::{Error, Result};

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

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueryItem {
    /// Relative to its workspace folder (the root unless `root` says otherwise), `/` separators.
    pub path: String,
    pub score: i64,
    pub positions: Vec<usize>,
    /// The workspace folder (absolute) holding it, only when that isn't the primary one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
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

/// One workspace folder's list and watcher.
struct Folder {
    root: PathBuf,
    /// This folder's id, unique for the life of the index: a build or watcher event for a
    /// folder that has since been removed (or reopened) finds no folder with its id.
    id: u64,
    files: Vec<String>,
    building: bool,
    /// Changes arrived while building: build again when done.
    stale: bool,
    truncated: bool,
    watcher: Option<Debouncer<RecommendedWatcher, NoCache>>,
    #[cfg(target_os = "linux")]
    watched: std::collections::HashSet<PathBuf>,
}

impl Folder {
    fn new(root: PathBuf, id: u64) -> Self {
        Folder {
            root,
            id,
            files: Vec::new(),
            building: false,
            stale: false,
            truncated: false,
            watcher: None,
            #[cfg(target_os = "linux")]
            watched: std::collections::HashSet::new(),
        }
    }
}

#[derive(Default)]
struct Inner {
    /// The primary folder first, then the others in the workspace's order. Empty: none open.
    folders: Vec<Folder>,
    /// The last folder id handed out.
    next_id: u64,
}

impl Inner {
    fn new_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    fn folder_mut(&mut self, id: u64) -> Option<&mut Folder> {
        self.folders.iter_mut().find(|f| f.id == id)
    }
}

#[derive(Default, Clone)]
pub struct FileIndex {
    inner: Arc<Mutex<Inner>>,
    /// Who hears about changed files (one: the window's Source control). Kept across folders.
    listener: Arc<Mutex<Option<Channel<IndexChanges>>>>,
}

impl FileIndex {
    /// Indexes `root` (replacing any previous folders) and starts watching it.
    pub fn open(&self, root: PathBuf) {
        let id = {
            let Ok(mut inner) = self.lock() else { return };
            let id = inner.new_id();
            inner.folders = vec![Folder::new(root.clone(), id)];
            id
        };
        self.start_watcher(&root, id);
        self.rebuild(id);
    }

    /// Sets the workspace's other folders (besides the primary, which `open` set): new ones are
    /// indexed and watched, removed ones dropped, the lists of those still there kept. Nothing
    /// happens while no folder is open.
    pub fn set_folders(&self, others: Vec<PathBuf>) {
        let added: Vec<(PathBuf, u64)> = {
            let Ok(mut inner) = self.lock() else { return };
            if inner.folders.is_empty() {
                return;
            }
            let primary = inner.folders.remove(0);
            let mut old = std::mem::take(&mut inner.folders);
            let mut folders = vec![primary];
            let mut added = Vec::new();
            for dir in others {
                if folders.iter().any(|f| f.root == dir) {
                    continue;
                }
                match old.iter().position(|f| f.root == dir) {
                    Some(i) => folders.push(old.swap_remove(i)),
                    None => {
                        let id = inner.new_id();
                        folders.push(Folder::new(dir.clone(), id));
                        added.push((dir, id));
                    }
                }
            }
            // What's left in `old` is dropped here, its watcher with it.
            inner.folders = folders;
            added
        };
        for (dir, id) in added {
            self.start_watcher(&dir, id);
            self.rebuild(id);
        }
    }

    pub fn close(&self) {
        if let Ok(mut inner) = self.lock() {
            inner.folders.clear();
        }
    }

    /// The folders indexed, the primary first.
    pub fn roots(&self) -> Vec<PathBuf> {
        self.lock()
            .map(|i| i.folders.iter().map(|f| f.root.clone()).collect())
            .unwrap_or_default()
    }

    /// Top `limit` files for `query` across every folder (an empty query lists files in index
    /// order: each folder's own files, the primary's first, before any dependencies).
    pub fn query(&self, query: &str, limit: usize) -> Result<QueryResult> {
        let inner = self.lock()?;
        let lists: Vec<(Option<String>, &[String])> = inner
            .folders
            .iter()
            .enumerate()
            .map(|(i, f)| (folder_label(i, &f.root), f.files.as_slice()))
            .collect();
        let mut items = merged_query(&lists, query, limit);
        items.shrink_to_fit();
        Ok(QueryResult {
            items,
            total: inner.folders.iter().map(|f| f.files.len()).sum(),
            indexing: inner.folders.iter().any(|f| f.building),
            truncated: inner.folders.iter().any(|f| f.truncated),
        })
    }

    /// The same for one indexed folder only (`root` canonical); None when it isn't indexed.
    pub fn query_folder(
        &self,
        root: &Path,
        query: &str,
        limit: usize,
    ) -> Result<Option<QueryResult>> {
        let inner = self.lock()?;
        let Some((i, folder)) = inner
            .folders
            .iter()
            .enumerate()
            .find(|(_, f)| f.root == root)
        else {
            return Ok(None);
        };
        let lists = [(folder_label(i, &folder.root), folder.files.as_slice())];
        Ok(Some(QueryResult {
            items: merged_query(&lists, query, limit),
            total: folder.files.len(),
            indexing: folder.building,
            truncated: folder.truncated,
        }))
    }

    /// Sends each batch of changed files to `channel` (replacing an earlier listener). Returns
    /// whether a watcher is running for the open folder (false: none open, or watching failed,
    /// so the caller keeps polling).
    pub fn listen(&self, channel: Channel<IndexChanges>) -> bool {
        if let Ok(mut l) = self.listener.lock() {
            *l = Some(channel);
        }
        self.lock()
            .map(|i| i.folders.first().is_some_and(|f| f.watcher.is_some()))
            .unwrap_or(false)
    }

    /// Who hears about changed files (a remote window's index is the server's, D252: its
    /// changes go to the same listener).
    pub fn listener(&self) -> Option<Channel<IndexChanges>> {
        self.listener.lock().ok().and_then(|l| l.clone())
    }

    /// Every indexed path (for tests and `ide://` state).
    pub fn len(&self) -> usize {
        self.lock()
            .map(|i| i.folders.iter().map(|f| f.files.len()).sum())
            .unwrap_or(0)
    }

    fn rebuild(&self, id: u64) {
        let root = {
            let Ok(mut inner) = self.lock() else { return };
            let Some(folder) = inner.folder_mut(id) else {
                return;
            };
            if folder.building {
                folder.stale = true;
                return;
            }
            folder.building = true;
            folder.stale = false;
            folder.root.clone()
        };
        let this = self.clone();
        std::thread::spawn(move || {
            let (files, dirs, truncated) = walk(&root);
            let again = {
                let Ok(mut inner) = this.lock() else { return };
                let Some(folder) = inner.folder_mut(id) else {
                    return;
                };
                folder.files = files;
                folder.truncated = truncated;
                folder.building = false;
                #[cfg(target_os = "linux")]
                update_dir_watches(folder, dirs);
                #[cfg(not(target_os = "linux"))]
                drop(dirs);
                folder.stale
            };
            if again {
                this.rebuild(id);
            }
        });
    }

    fn start_watcher(&self, root: &Path, id: u64) {
        let this = self.clone();
        // No file-id cache: on Windows and macOS the recommended one walks the whole folder and
        // opens every file (node_modules, build output) before the folder can show, seconds on a
        // big project. Only the changed paths matter here, not pairing renames by file id.
        let handler = move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            let listener = this.listener.lock().ok().and_then(|l| l.clone());
            // Changes were lost (a burst overflowed the watcher, D280): "many changed".
            let rescan = events.iter().any(|e| e.need_rescan());
            if let Some(channel) = listener {
                let mut changes = changed_paths(events.iter().map(|e| (&e.kind, &e.paths[..])));
                changes.overflow |= rescan;
                if !changes.paths.is_empty() || changes.overflow {
                    let _ = channel.send(changes);
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
            if structural || rescan {
                this.rebuild(id);
            }
        };
        let debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
            DEBOUNCE,
            None,
            handler,
            NoCache,
            notify::Config::default(),
        );
        let Ok(mut debouncer) = debouncer else { return };
        #[cfg(not(target_os = "linux"))]
        if debouncer.watch(root, RecursiveMode::Recursive).is_err() {
            return;
        }
        #[cfg(target_os = "linux")]
        let _ = debouncer.watch(root, RecursiveMode::NonRecursive);
        if let Ok(mut inner) = self.lock() {
            if let Some(folder) = inner.folder_mut(id) {
                folder.watcher = Some(debouncer);
            }
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, Inner>> {
        self.inner
            .lock()
            .map_err(|_| Error::Invalid("file index lock poisoned".into()))
    }
}

/// What a folder's items carry as `root`: nothing for the primary (the first), its path for
/// the others.
fn folder_label(index: usize, root: &Path) -> Option<String> {
    (index > 0).then(|| root.to_string_lossy().into_owned())
}

/// The best `limit` items over several folders' lists (`(root label, files)`, the primary
/// first). An empty query lists the folders' own files (in order) before any dependencies; a
/// query ranks them all together (fuzzy, then shorter paths, then folder order).
fn merged_query(
    lists: &[(Option<String>, &[String])],
    query: &str,
    limit: usize,
) -> Vec<QueryItem> {
    if query.trim().is_empty() {
        // The project's own files before dependencies and build output, so a limit doesn't fill
        // up with node_modules in a folder without a .gitignore (the repo map, D174).
        let item = |root: &Option<String>, p: &String| QueryItem {
            path: p.clone(),
            score: 0,
            positions: Vec::new(),
            root: root.clone(),
        };
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
            .map(|(r, p)| item(r, p))
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

fn sort_ranked(items: &mut [QueryItem]) {
    items.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.path.len().cmp(&b.path.len()))
    });
}

/// The files a batch of events touched, outside `.git` (its own watcher covers that), without
/// reads (access events) and without repeats.
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
fn update_dir_watches(folder: &mut Folder, dirs: Vec<PathBuf>) {
    let Some(watcher) = folder.watcher.as_mut() else {
        return;
    };
    let wanted: std::collections::HashSet<PathBuf> =
        dirs.into_iter().take(MAX_WATCHED_DIRS).collect();
    for gone in folder
        .watched
        .difference(&wanted)
        .cloned()
        .collect::<Vec<_>>()
    {
        let _ = watcher.unwatch(&gone);
        folder.watched.remove(&gone);
    }
    for new in wanted
        .difference(&folder.watched)
        .cloned()
        .collect::<Vec<_>>()
    {
        if watcher.watch(&new, RecursiveMode::NonRecursive).is_ok() {
            folder.watched.insert(new);
        }
    }
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

/// A query over a folder that isn't indexed (a headless helper's worktree): one walk, then the
/// same ranking as the index's (an empty query lists files, the project's own first).
pub fn query_walk(root: &Path, query: &str, limit: usize) -> QueryResult {
    let (files, _, truncated) = walk(root);
    let items = merged_query(&[(None, files.as_slice())], query, limit);
    QueryResult {
        items,
        total: files.len(),
        indexing: false,
        truncated,
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
    fn walk_respects_gitignore_and_skips_git() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("ide-index-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src/deep"))?;
        std::fs::create_dir_all(dir.join("build"))?;
        std::fs::create_dir_all(dir.join(".git"))?;
        std::fs::write(dir.join(".gitignore"), "build/\n")?;
        std::fs::write(dir.join("src/deep/a.ts"), "")?;
        std::fs::write(dir.join("build/out.js"), "")?;
        std::fs::write(dir.join(".git/HEAD"), "")?;
        let (mut files, _, truncated) = walk(&dir);
        files.sort();
        assert_eq!(files, vec![".gitignore", "src/deep/a.ts"]);
        assert!(!truncated);
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn queries_merge_folders_and_name_the_other_ones() {
        let primary = strings(&["src/main.ts", "node_modules/x/index.js"]);
        let other = strings(&["lib/main.rs", "target/debug/out"]);
        let lists = [
            (None, primary.as_slice()),
            (Some("/w/other".to_string()), other.as_slice()),
        ];
        // An empty query: every folder's own files (the primary's first), then dependencies.
        let items = merged_query(&lists, "", 10);
        let listed: Vec<(Option<&str>, &str)> = items
            .iter()
            .map(|i| (i.root.as_deref(), i.path.as_str()))
            .collect();
        assert_eq!(
            listed,
            vec![
                (None, "src/main.ts"),
                (Some("/w/other"), "lib/main.rs"),
                (None, "node_modules/x/index.js"),
                (Some("/w/other"), "target/debug/out"),
            ]
        );
        // A query ranks across folders; only the other folder's items name their folder.
        let found = merged_query(&lists, "main", 10);
        assert_eq!(found.len(), 2);
        assert!(found
            .iter()
            .any(|i| i.path == "src/main.ts" && i.root.is_none()));
        assert!(found
            .iter()
            .any(|i| i.path == "lib/main.rs" && i.root.as_deref() == Some("/w/other")));
        assert_eq!(merged_query(&lists, "main", 1).len(), 1);
        // One folder: the item's JSON is what it always was (no `root`).
        let single = merged_query(&lists[..1], "main", 10);
        let json = serde_json::to_string(&single).unwrap_or_default();
        assert!(!json.contains("root"), "{json}");
    }

    #[test]
    fn other_folders_are_indexed_alongside_the_primary() -> Result<()> {
        let base = std::env::temp_dir().join(format!("ide-index-folders-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (a, b, c) = (base.join("a"), base.join("b"), base.join("c"));
        for (dir, file) in [(&a, "one.ts"), (&b, "two.ts"), (&c, "three.ts")] {
            std::fs::create_dir_all(dir)?;
            std::fs::write(dir.join(file), "")?;
        }
        let index = FileIndex::default();
        // Nothing open: other folders are ignored.
        index.set_folders(vec![b.clone()]);
        assert!(index.roots().is_empty());
        index.open(a.clone());
        index.set_folders(vec![b.clone(), a.clone(), c.clone(), b.clone()]);
        assert_eq!(index.roots(), vec![a.clone(), b.clone(), c.clone()]);
        let wait_for = |n: usize| {
            for _ in 0..200 {
                if index
                    .query("", 100)
                    .is_ok_and(|r| !r.indexing && r.total == n)
                {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            false
        };
        assert!(wait_for(3));
        let r = index.query("two", 10)?;
        assert_eq!(r.items.len(), 1);
        assert_eq!(
            r.items[0].root.as_deref(),
            Some(b.to_string_lossy().as_ref())
        );
        let only_c = index.query_folder(&c, "", 10)?.map(|r| r.items.len());
        assert_eq!(only_c, Some(1));
        assert!(index.query_folder(&base, "", 10)?.is_none());
        // Removing one keeps the others; reopening resets to the primary alone.
        index.set_folders(vec![c.clone()]);
        assert_eq!(index.roots(), vec![a.clone(), c.clone()]);
        assert!(wait_for(2));
        index.open(a.clone());
        assert_eq!(index.roots(), vec![a.clone()]);
        index.close();
        assert!(index.roots().is_empty());
        let _ = std::fs::remove_dir_all(&base);
        Ok(())
    }
}
