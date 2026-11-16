//! Snapshots (D435): a project's files as they are, captured on one computer and restored on
//! another or later. Git is asked, never bypassed, and nothing is written inside `.git` to
//! make one.
//!
//! - **A git project:** the commit checked out and its branch; commits no remote has (as git
//!   bundles, each carrying only what the bundles before it lack); what is staged (a patch);
//!   and every file that differs from that commit, new files included. Ignored files stay out.
//! - **A folder without git:** every file, minus well-known heavy folders and oversized files.
//!
//! A snapshot is a manifest (stored as chunks) that names each file's chunks, and a record
//! that names every chunk the snapshot needs, so the server keeps them while it exists.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use super::api::Api;
use super::chunks::{self, Stored, Uploader};
use super::crypto::Keyring;
use super::records::{self, Put};
use crate::error::{Error, Result};
use crate::store::atomic_write;

/// Files larger than this are left out (and listed as left out).
const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_FILES: usize = 200_000;
/// What a project lists to keep out of its snapshots, in `.gitignore` syntax.
const IGNORE_FILE: &str = ".syncignore";
/// About this many files to a part of the stored list.
const SHARD_FILES: usize = 400;
/// Files written at once on a restore.
const WRITES_AT_ONCE: usize = 4;
/// After this many bundles a fresh, complete one is made.
const MAX_BUNDLE_CHAIN: usize = 24;
/// Folders that never travel from a folder without git (dependencies, build output, caches).
const HEAVY_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "dist",
    "build",
    "out",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".nuxt",
    ".gradle",
    ".cache",
    ".turbo",
    ".parcel-cache",
    "coverage",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    "bower_components",
    "vendor",
    "Pods",
    ".dart_tool",
    ".terraform",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileEntry {
    /// Relative to the project, with `/`.
    pub p: String,
    pub s: Stored,
    /// Executable (Unix).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub x: bool,
    /// Size and modified time as they were, to skip reading an unchanged file next time.
    pub t: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct Bundle {
    pub file: Stored,
    /// The ref tips when it was made: the next bundle leaves out what these reach.
    pub tips: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GitState {
    /// The commit checked out (None: no commit yet).
    pub head: Option<String>,
    /// The branch checked out (None: detached).
    pub branch: Option<String>,
    /// `origin`'s address (or the first remote's), to fetch from where the project isn't yet.
    pub remote: Option<String>,
    pub bundles: Vec<Bundle>,
    /// `git diff --cached --binary` against the commit: what was staged.
    pub staged: Option<Stored>,
    /// Every stash, newest first: its commit (carried by the bundles) and its message.
    #[serde(default)]
    pub stashes: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Manifest {
    pub v: u32,
    pub git: Option<GitState>,
    /// Git: files that differ from the commit. No git: every file.
    pub files: Vec<FileEntry>,
    /// Git: files of the commit that are gone from the folder.
    #[serde(default)]
    pub deleted: Vec<String>,
    /// Left out, with why ("too large", "a link").
    #[serde(default)]
    pub skipped: Vec<(String, String)>,
    /// As stored: the files in parts, by a hash of each path, so a snapshot that changed a
    /// few files stores a few small parts again, not the whole list. (`files` is then empty
    /// in the stored form and filled when read.)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shards: Vec<Stored>,
}

/// What a snapshot's record says without its manifest: enough to list it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub v: u32,
    pub device: String,
    pub device_name: String,
    /// When, in ms.
    pub time: u64,
    pub kind: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub files: usize,
    pub deleted: usize,
    /// Bytes of the files it names (not what it added to storage).
    pub bytes: u64,
    pub skipped: usize,
    pub manifest: Stored,
    /// What the folder looked like, to tell "nothing changed since".
    pub fingerprint: String,
    /// Kept whatever its age, under this name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub id: String,
    pub summary: Summary,
    pub uploaded_bytes: u64,
}

fn sync_error(message: impl Into<String>) -> Error {
    Error::Sync("Sync", message.into())
}

fn rel(path: &str) -> String {
    path.replace('\\', "/")
}

/// A manifest's path as a place under `root`; refuses anything that climbs out or into `.git`.
fn safe_join(root: &Path, relative: &str) -> Result<PathBuf> {
    let path = Path::new(relative);
    let mut out = root.to_path_buf();
    let mut first = true;
    for part in path.components() {
        match part {
            Component::Normal(name) => {
                let text = name.to_string_lossy();
                // Windows drops trailing dots and spaces and reads short names and streams:
                // ".git.", ".git ", "GIT~1" and ".git::$INDEX_ALLOCATION" are all .git there.
                // No repository's own folder at any depth, either.
                let plain = text.trim_end_matches(['.', ' ']).to_ascii_lowercase();
                let stem = plain.split('.').next().unwrap_or("");
                let reserved = matches!(stem, "con" | "prn" | "aux" | "nul")
                    || (stem.len() == 4
                        && (stem.starts_with("com") || stem.starts_with("lpt"))
                        && stem.ends_with(|c: char| c.is_ascii_digit()));
                if plain == ".git"
                    || reserved
                    || plain.starts_with("git~")
                    || text.contains(':')
                    || text.ends_with(['.', ' '])
                {
                    return Err(sync_error(format!(
                        "a snapshot may not write there: {relative}"
                    )));
                }
                out.push(name);
            }
            _ => {
                return Err(sync_error(format!(
                    "a snapshot names a path outside the project: {relative}"
                )))
            }
        }
        first = false;
    }
    if first {
        return Err(sync_error("a snapshot names an empty path"));
    }
    Ok(out)
}

/// Whether an address from a snapshot may become a git remote: an ordinary https, ssh or git
/// address. Not a local path, not a transport that runs a program, not an option.
fn safe_remote(url: &str) -> bool {
    let url = url.trim();
    if url.starts_with('-') || url.contains("::") || url.chars().any(char::is_control) {
        return false;
    }
    let scheme = ["https://", "http://", "ssh://", "git://"]
        .iter()
        .any(|s| url.starts_with(s));
    // The short SSH form: user@host:path.
    let short = !url.contains("://") && url.contains('@') && url.contains(':');
    (scheme || short) && super::project::normalize_remote(url).is_some()
}

fn stamp(meta: &std::fs::Metadata) -> u64 {
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    // Size and time in one number: either changing changes it.
    modified.wrapping_mul(1_000_003).wrapping_add(meta.len())
}

#[cfg(unix)]
fn executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}
#[cfg(not(unix))]
fn executable(_meta: &std::fs::Metadata) -> bool {
    false
}

fn git(root: &Path, args: &[&str]) -> Result<String> {
    crate::git::run(root, args, None)
}

fn is_git(root: &Path) -> bool {
    root.join(".git").exists() && git(root, &["rev-parse", "--is-inside-work-tree"]).is_ok()
}

// ---------------------------------------------------------------- what is in the folder

/// What differs from the commit in a git project: (path, exists).
fn git_changes(root: &Path) -> Result<Vec<(String, bool)>> {
    let out = git(
        root,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--no-renames",
        ],
    )?;
    let mut changes = Vec::new();
    let ignored = sync_ignore(root);
    for entry in out.split('\0') {
        let path = match entry.as_bytes().first() {
            Some(b'?') => entry.get(2..),
            // "1 XY sub mH mI mW hH hI path": eight fields, then the path (which may hold spaces).
            Some(b'1') => {
                // A submodule is its own repository: not copied.
                if entry
                    .split(' ')
                    .nth(2)
                    .is_some_and(|sub| sub.starts_with('S'))
                {
                    continue;
                }
                entry.splitn(9, ' ').nth(8)
            }
            // "u XY sub m1 m2 m3 mW h1 h2 h3 path".
            Some(b'u') => entry.splitn(11, ' ').nth(10),
            _ => None,
        };
        let Some(path) = path.filter(|p| !p.is_empty()) else {
            continue;
        };
        // What the project itself keeps out of snapshots.
        if ignored
            .as_ref()
            .is_some_and(|i| i.matched_path_or_any_parents(path, false).is_ignore())
        {
            continue;
        }
        let exists = std::fs::symlink_metadata(root.join(path)).is_ok();
        changes.push((rel(path), exists));
    }
    Ok(changes)
}

/// The project's own list of what stays out of snapshots (`.syncignore`, written as a
/// `.gitignore` is), when it has one.
fn sync_ignore(root: &Path) -> Option<ignore::gitignore::Gitignore> {
    let file = root.join(IGNORE_FILE);
    if !file.is_file() {
        return None;
    }
    let mut builder = ignore::gitignore::GitignoreBuilder::new(root);
    builder.add(file);
    builder.build().ok()
}

/// Every file of a folder without git that travels: not the heavy folders, and not what the
/// folder's own `.gitignore`, `.ignore` or `.syncignore` files leave out.
fn folder_files(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    let walker = ignore::WalkBuilder::new(root)
        .standard_filters(false)
        .git_ignore(true)
        .require_git(false)
        .ignore(true)
        .parents(false)
        .add_custom_ignore_filename(IGNORE_FILE)
        .hidden(false)
        .follow_links(false)
        .filter_entry(|e| {
            !(e.file_type().is_some_and(|t| t.is_dir())
                && e.file_name()
                    .to_str()
                    .is_some_and(|n| HEAVY_DIRS.contains(&n)))
        })
        .build();
    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if let Ok(path) = entry.path().strip_prefix(root) {
            if let Some(text) = path.to_str() {
                files.push(rel(text));
            }
        }
        if files.len() >= MAX_FILES {
            break;
        }
    }
    files.sort();
    files
}

/// A cheap picture of the folder: when it is the same as the last snapshot's, nothing changed.
pub fn fingerprint(root: &Path) -> Result<String> {
    use sha2_10::{Digest, Sha256};
    let mut hash = Sha256::new();
    fn note(hash: &mut Sha256, root: &Path, path: &str) {
        hash.update(path.as_bytes());
        match std::fs::symlink_metadata(root.join(path)) {
            Ok(meta) => hash.update(stamp(&meta).to_be_bytes()),
            Err(_) => hash.update(b"gone"),
        }
    }
    if is_git(root) {
        hash.update(git(root, &["rev-parse", "--verify", "-q", "HEAD"]).unwrap_or_default());
        hash.update(git(root, &["symbolic-ref", "-q", "HEAD"]).unwrap_or_default());
        // Unpushed commits on other branches and stashes are part of the picture.
        hash.update(git(
            root,
            &[
                "for-each-ref",
                "--format=%(objectname) %(refname)",
                "refs/heads",
                "refs/stash",
                "refs/tags",
            ],
        )?);
        hash.update(git(root, &["diff", "--cached", "--raw", "--no-renames"]).unwrap_or_default());
        hash.update(git(root, &["stash", "list", "--format=%H"]).unwrap_or_default());
        for (path, _) in git_changes(root)? {
            note(&mut hash, root, &path);
        }
    } else {
        for path in folder_files(root) {
            note(&mut hash, root, &path);
        }
    }
    Ok(super::crypto::b64(&hash.finalize()[..16]))
}

// ---------------------------------------------------------------- capture

struct Capture<'a> {
    root: &'a Path,
    /// The last snapshot's files, to skip reading what didn't change.
    before: HashMap<&'a str, &'a FileEntry>,
    uploader: Uploader<'a>,
    manifest: Manifest,
}

impl Capture<'_> {
    async fn file(&mut self, path: &str) -> Result<()> {
        let full = self.root.join(path);
        let meta = match std::fs::symlink_metadata(&full) {
            Ok(m) => m,
            Err(_) => return Ok(()),
        };
        if meta.file_type().is_symlink() {
            self.manifest
                .skipped
                .push((path.to_string(), "a link".into()));
            return Ok(());
        }
        if meta.is_dir() {
            // An untracked folder that is a repository of its own shows as one entry.
            self.manifest
                .skipped
                .push((path.to_string(), "a repository inside".into()));
            return Ok(());
        }
        if meta.len() > MAX_FILE_BYTES {
            self.manifest
                .skipped
                .push((path.to_string(), "too large".into()));
            return Ok(());
        }
        let t = stamp(&meta);
        if let Some(same) = self.before.get(path).filter(|f| f.t == t) {
            // Named again without reading it: its chunks are known to be the same.
            self.uploader.keep(&same.s);
            self.manifest.files.push((*same).clone());
            return Ok(());
        }
        let bytes = match tokio::task::spawn_blocking(move || std::fs::read(full)).await {
            Ok(Ok(b)) => b,
            // Locked or gone since it was listed: said, not fatal.
            _ => {
                self.manifest
                    .skipped
                    .push((path.to_string(), "couldn't be read".into()));
                return Ok(());
            }
        };
        let s = self.uploader.add(&bytes).await?;
        self.manifest.files.push(FileEntry {
            p: path.to_string(),
            s,
            x: executable(&meta),
            t,
        });
        Ok(())
    }
}

/// The stashes, newest first: (commit, message).
fn stashes(root: &Path) -> Vec<(String, String)> {
    git(root, &["stash", "list", "--format=%H %gs"])
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let (sha, message) = line.split_once(' ')?;
            Some((sha.to_string(), message.to_string()))
        })
        .collect()
}

fn ref_tips(root: &Path) -> Vec<String> {
    let mut tips: Vec<String> = git(
        root,
        &[
            "for-each-ref",
            "--format=%(objectname)",
            "refs/heads",
            "refs/tags",
            "refs/stash",
        ],
    )
    .unwrap_or_default()
    .lines()
    .map(str::to_string)
    .collect();
    // Only the newest stash is a ref; the older ones are named here so a bundle carries them.
    tips.extend(stashes(root).into_iter().map(|(sha, _)| sha));
    // A commit made with no branch (a detached HEAD, the middle of a rebase) has no ref either.
    if let Ok(head) = git(root, &["rev-parse", "-q", "--verify", "HEAD"]) {
        tips.push(head.trim().to_string());
    }
    tips.sort();
    tips.dedup();
    tips
}

fn scratch_file(data: &Path, name: &str) -> Result<PathBuf> {
    let dir = data.join("sync").join("tmp");
    std::fs::create_dir_all(&dir)?;
    // A name of its own: two snapshots at once (two windows) never share a file.
    Ok(dir.join(format!("{name}-{}", super::crypto::new_id()?)))
}

/// The bundles a snapshot needs: the ones before (while their commits are still here) and a
/// new one for what the refs reach now that those, and the remotes, don't have.
async fn bundles(
    capture: &mut Capture<'_>,
    data: &Path,
    before: Option<&GitState>,
    has_remote: bool,
    everything: bool,
) -> Result<Vec<Bundle>> {
    let root = capture.root;
    let tips = ref_tips(root);
    let mut chain: Vec<Bundle> = before.map(|g| g.bundles.clone()).unwrap_or_default();
    // A commit an earlier bundle relied on that is gone (history rewritten and collected), or a
    // chain grown long: start again with one complete bundle.
    let known = |sha: &str| git(root, &["cat-file", "-e", &format!("{sha}^{{commit}}")]).is_ok();
    let intact = chain
        .iter()
        .flat_map(|b| b.tips.iter())
        .all(|t| known(t) || git(root, &["cat-file", "-e", t]).is_ok());
    if !intact || chain.len() >= MAX_BUNDLE_CHAIN {
        chain.clear();
    }
    if chain.last().is_some_and(|b| b.tips == tips) {
        for b in &chain {
            capture.uploader.keep(&b.file);
        }
        return Ok(chain);
    }
    let file = scratch_file(data, "bundle")?;
    let file_text = file.to_string_lossy().to_string();
    // Every ref but the ones an earlier restore put here (they are another computer's), and
    // the commit checked out, which may have no ref.
    let mut args: Vec<String> = vec![
        "bundle".into(),
        "create".into(),
        file_text,
        "--exclude=refs/synced/*".into(),
        "--all".into(),
        "HEAD".into(),
    ];
    // Older stashes have no ref of their own: named by commit, they go into the pack too.
    args.extend(stashes(root).into_iter().map(|(sha, _)| sha));
    let mut not: Vec<String> = Vec::new();
    if has_remote && !everything {
        not.push("--remotes".into());
    }
    for bundle in &chain {
        for tip in &bundle.tips {
            // Only commits can be excluded (a tag may point at something else).
            if known(tip) && !not.contains(tip) {
                not.push(tip.clone());
            }
        }
    }
    if !not.is_empty() {
        args.push("--not".into());
        args.extend(not);
    }
    // Asked first, in a way that doesn't depend on git's language: is there anything the
    // remotes and the earlier bundles lack?
    let mut probe: Vec<&str> = vec!["rev-list", "--max-count=1"];
    probe.extend(args[3..].iter().map(String::as_str));
    if git(root, &probe).is_ok_and(|out| out.trim().is_empty()) {
        for b in &chain {
            capture.uploader.keep(&b.file);
        }
        return Ok(chain);
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let made = git(root, &refs);
    let result = match made {
        Ok(_) => {
            let path = file.clone();
            let bytes = tokio::task::spawn_blocking(move || std::fs::read(path))
                .await
                .map_err(|e| sync_error(e.to_string()))??;
            let stored = capture.uploader.add(&bytes).await?;
            chain.push(Bundle { file: stored, tips });
            Ok(())
        }
        // Nothing the remotes and earlier bundles lack: no new bundle.
        Err(Error::Git(message)) if message.contains("empty bundle") => Ok(()),
        Err(e) => Err(e),
    };
    let _ = std::fs::remove_file(&file);
    result?;
    for b in &chain {
        capture.uploader.keep(&b.file);
    }
    Ok(chain)
}

pub struct CreateOptions<'a> {
    pub collection: &'a str,
    pub device: &'a str,
    pub device_name: &'a str,
    /// With a remote: the complete history too, not only what the remote lacks.
    pub everything: bool,
    /// The snapshot before this one from this computer, when it is known.
    pub before: Option<&'a Manifest>,
    pub now_ms: u64,
}

/// Captures `root` and stores it as a new snapshot record.
pub async fn create(
    api: &Api,
    ring: &Keyring,
    data: &Path,
    root: &Path,
    options: CreateOptions<'_>,
) -> Result<Created> {
    let mut options = options;
    for _ in 0..4 {
        match create_once(api, ring, data, root, &options).await {
            Err(Error::Sync("SyncRetry", _)) => {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            }
            // What the snapshot before stored is gone from the server: nothing is taken as known.
            Err(Error::Sync("SyncStale", _)) => options.before = None,
            other => return other,
        }
    }
    Err(Error::Sync(
        "SyncRetry",
        "The snapshot couldn't be stored just now; trying again later.".into(),
    ))
}

async fn create_once(
    api: &Api,
    ring: &Keyring,
    data: &Path,
    root: &Path,
    options: &CreateOptions<'_>,
) -> Result<Created> {
    let picture = fingerprint(root)?;
    let before_files: HashMap<&str, &FileEntry> = options
        .before
        .map(|m| m.files.iter().map(|f| (f.p.as_str(), f)).collect())
        .unwrap_or_default();
    let mut capture = Capture {
        root,
        before: before_files,
        uploader: Uploader::new(api, ring),
        manifest: Manifest {
            v: 1,
            ..Default::default()
        },
    };

    if is_git(root) {
        let head = git(root, &["rev-parse", "--verify", "-q", "HEAD"])
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let branch = git(root, &["symbolic-ref", "--short", "-q", "HEAD"])
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let remotes = crate::git::ops::remote_urls(root).unwrap_or_default();
        let remote = remotes
            .iter()
            .find(|r| r.name == "origin")
            .or_else(|| remotes.first())
            .map(|r| r.url.clone());
        let before_git = options.before.and_then(|m| m.git.as_ref());
        let chain = if head.is_some() {
            bundles(
                &mut capture,
                data,
                before_git,
                remote.is_some(),
                options.everything,
            )
            .await?
        } else {
            Vec::new()
        };
        let staged = match &head {
            Some(_) => {
                let patch = git(
                    root,
                    &[
                        "diff",
                        "--cached",
                        "--binary",
                        "--full-index",
                        "--no-renames",
                    ],
                )?;
                if patch.trim().is_empty() {
                    None
                } else {
                    Some(capture.uploader.add(patch.as_bytes()).await?)
                }
            }
            None => None,
        };
        let changes = git_changes(root)?;
        if changes.len() > MAX_FILES {
            capture.manifest.skipped.push((
                format!("{} more changed files", changes.len() - MAX_FILES),
                "more than a snapshot holds".into(),
            ));
        }
        for (path, exists) in changes.into_iter().take(MAX_FILES) {
            if exists {
                capture.file(&path).await?;
            } else {
                capture.manifest.deleted.push(path);
            }
        }
        capture.manifest.git = Some(GitState {
            head,
            branch,
            remote,
            bundles: chain,
            staged,
            stashes: stashes(root),
        });
    } else {
        for path in folder_files(root) {
            capture.file(&path).await?;
        }
    }

    let Capture {
        uploader, manifest, ..
    } = capture;
    let mut uploader = uploader;
    let stored_manifest = store_manifest(&mut uploader, &manifest).await?;
    let uploaded_bytes = uploader.uploaded_bytes;
    let (refs, gc_epoch) = uploader.finish().await?;
    let summary = Summary {
        v: 1,
        device: options.device.to_string(),
        device_name: options.device_name.to_string(),
        time: options.now_ms,
        kind: if manifest.git.is_some() {
            "git"
        } else {
            "folder"
        }
        .to_string(),
        head: manifest.git.as_ref().and_then(|g| g.head.clone()),
        branch: manifest.git.as_ref().and_then(|g| g.branch.clone()),
        files: manifest.files.len(),
        deleted: manifest.deleted.len(),
        bytes: manifest.files.iter().map(|f| f.s.size).sum(),
        skipped: manifest.skipped.len(),
        manifest: stored_manifest,
        fingerprint: picture,
        pinned: None,
    };
    // Ids sort by time; the device's start keeps two computers' apart.
    let id = format!(
        "{:013}-{}",
        options.now_ms,
        options
            .device
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .take(6)
            .collect::<String>()
    );
    match records::put_labeled(
        api,
        ring,
        options.collection,
        &id,
        None,
        Some(&serde_json::to_string(&summary)?),
        Some((&refs, gc_epoch)),
        Some(&label(&summary)),
    )
    .await?
    {
        Put::Done { .. } => Ok(Created {
            id,
            summary,
            uploaded_bytes,
        }),
        Put::Gc { .. } => Err(Error::Sync("SyncRetry", "checking the chunks again".into())),
        Put::Conflict { .. } => Err(sync_error("A snapshot with that name exists already.")),
    }
}

// ---------------------------------------------------------------- reading one back

pub async fn summary(api: &Api, ring: &Keyring, collection: &str, id: &str) -> Result<Summary> {
    let record = records::get(api, ring, collection, id)
        .await?
        .filter(|r| !r.deleted)
        .ok_or_else(|| sync_error("That snapshot is gone."))?;
    let text = record
        .text
        .ok_or_else(|| sync_error("That snapshot can't be read on this device yet."))?;
    Ok(serde_json::from_str(&text)?)
}

/// Which part of the stored list a path is in, of `parts`.
fn shard_of(path: &str, parts: usize) -> usize {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in path.as_bytes() {
        hash = (hash ^ u32::from(*byte)).wrapping_mul(0x0100_0193);
    }
    hash as usize % parts.max(1)
}

/// How many parts a list of `files` files is stored in: a power of two, so it changes
/// rarely as a project grows.
fn shard_count(files: usize) -> usize {
    (files / SHARD_FILES).max(1).next_power_of_two().min(1024)
}

/// Stores a manifest: its files in parts (each sorted, so the same files give the same
/// bytes), then the rest with where the parts are.
async fn store_manifest(uploader: &mut Uploader<'_>, manifest: &Manifest) -> Result<Stored> {
    let parts = shard_count(manifest.files.len());
    let mut shards: Vec<Vec<&FileEntry>> = vec![Vec::new(); parts];
    for file in &manifest.files {
        shards[shard_of(&file.p, parts)].push(file);
    }
    let mut stored = Vec::with_capacity(parts);
    for shard in &mut shards {
        shard.sort_by(|a, b| a.p.cmp(&b.p));
        stored.push(uploader.add(&serde_json::to_vec(shard)?).await?);
    }
    let index = Manifest {
        v: 2,
        git: manifest.git.clone(),
        files: Vec::new(),
        deleted: manifest.deleted.clone(),
        skipped: manifest.skipped.clone(),
        shards: stored,
    };
    uploader.add(&serde_json::to_vec(&index)?).await
}

pub async fn manifest(api: &Api, ring: &Keyring, summary: &Summary) -> Result<Manifest> {
    let bytes = chunks::read(api, ring, &summary.manifest).await?;
    let mut manifest: Manifest = serde_json::from_slice(&bytes)?;
    // The files, from their parts, a few at once.
    let shards = manifest.shards.clone();
    let mut parts = futures_util::stream::iter(shards)
        .map(|shard| async move { chunks::read(api, ring, &shard).await })
        .buffered(WRITES_AT_ONCE);
    while let Some(part) = parts.next().await {
        let files: Vec<FileEntry> = serde_json::from_slice(&part?)?;
        manifest.files.extend(files);
    }
    drop(parts);
    manifest.files.sort_by(|a, b| a.p.cmp(&b.p));
    Ok(manifest)
}

/// What a first snapshot of a folder would take: to say so before it starts.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    /// "git" (only what differs from the commit travels as files) or "folder" (every file).
    pub kind: String,
    pub files: usize,
    pub bytes: u64,
    /// Files over the size limit, which stay out.
    pub too_large: usize,
    /// The largest top-level folders and files: (name, bytes, files).
    pub largest: Vec<(String, u64, usize)>,
    /// The list was cut at the most files a snapshot holds.
    pub truncated: bool,
}

pub fn estimate(root: &Path) -> Result<Estimate> {
    let git = is_git(root);
    let paths: Vec<String> = if git {
        git_changes(root)?
            .into_iter()
            .filter(|(_, exists)| *exists)
            .map(|(p, _)| p)
            .collect()
    } else {
        folder_files(root)
    };
    let mut bytes = 0;
    let mut too_large = 0;
    let mut files = 0;
    let mut tops: HashMap<String, (u64, usize)> = HashMap::new();
    for path in &paths {
        let Ok(meta) = std::fs::symlink_metadata(root.join(path)) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        if meta.len() > MAX_FILE_BYTES {
            too_large += 1;
            continue;
        }
        files += 1;
        bytes += meta.len();
        let top = path.split('/').next().unwrap_or(path).to_string();
        let entry = tops.entry(top).or_default();
        entry.0 += meta.len();
        entry.1 += 1;
    }
    let mut largest: Vec<(String, u64, usize)> = tops
        .into_iter()
        .map(|(name, (b, n))| (name, b, n))
        .collect();
    largest.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    largest.truncate(8);
    Ok(Estimate {
        kind: if git { "git" } else { "folder" }.to_string(),
        files,
        bytes,
        too_large,
        largest,
        truncated: !git && paths.len() >= MAX_FILES,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedFile {
    pub path: String,
    pub size: u64,
    pub deleted: bool,
}

pub fn list(manifest: &Manifest) -> Vec<ListedFile> {
    let mut out: Vec<ListedFile> = manifest
        .files
        .iter()
        .map(|f| ListedFile {
            path: f.p.clone(),
            size: f.s.size,
            deleted: false,
        })
        .chain(manifest.deleted.iter().map(|p| ListedFile {
            path: p.clone(),
            size: 0,
            deleted: true,
        }))
        .collect();
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

async fn write_file(api: &Api, ring: &Keyring, root: &Path, entry: &FileEntry) -> Result<()> {
    let target = safe_join(root, &entry.p)?;
    let bytes = chunks::read(api, ring, &entry.s).await?;
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir)?;
        // A folder on the way that is a link (checked out from a commit, say) could lead
        // anywhere: the real place must still be inside the project.
        let real = std::fs::canonicalize(dir)?;
        let real_root = std::fs::canonicalize(root)?;
        if !real.starts_with(&real_root) {
            return Err(sync_error(format!(
                "a snapshot's path leaves the project through a link: {}",
                entry.p
            )));
        }
    }
    // Never through a link at the file itself.
    if std::fs::symlink_metadata(&target).is_ok_and(|m| m.file_type().is_symlink()) {
        std::fs::remove_file(&target)?;
    }
    atomic_write(&target, &bytes)?;
    #[cfg(unix)]
    if entry.x {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
    }
    Ok(())
}

/// One file of a snapshot, written where it was (or its deletion repeated).
pub async fn restore_file(
    api: &Api,
    ring: &Keyring,
    root: &Path,
    manifest: &Manifest,
    path: &str,
) -> Result<()> {
    if let Some(entry) = manifest.files.iter().find(|f| f.p == path) {
        return write_file(api, ring, root, entry).await;
    }
    Err(sync_error("That file isn't in the snapshot."))
}

// ---------------------------------------------------------------- restore

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    pub files: usize,
    pub deleted: usize,
    pub branch: Option<String>,
    /// The commit is checked out without its branch (the branch here has other commits).
    pub detached: bool,
    /// Things that went differently than asked, to tell the user.
    pub notes: Vec<String>,
    /// Local changes were put in a stash first, under this name.
    pub stashed: Option<String>,
}

/// What stands in the way of a restore: local changes (paths), when there are any.
pub fn local_changes(root: &Path) -> Result<Vec<String>> {
    if !is_git(root) {
        return Ok(Vec::new());
    }
    Ok(git_changes(root)?.into_iter().map(|(p, _)| p).collect())
}

pub struct RestoreOptions<'a> {
    /// Local changes: false refuses (`SyncDirty`), true stashes them first.
    pub stash: bool,
    /// The folder is exactly as an earlier restore left it: its changes are a snapshot's, not
    /// work done here, so they are replaced without asking.
    pub as_restored: bool,
    pub from: &'a str,
}

/// Brings `root` to the snapshot: the commit and branch, what was staged, the changed files.
pub async fn restore(
    api: &Api,
    ring: &Keyring,
    data: &Path,
    root: &Path,
    manifest: &Manifest,
    options: RestoreOptions<'_>,
) -> Result<Restored> {
    let mut done = Restored::default();
    std::fs::create_dir_all(root)?;
    if let Some(state) = &manifest.git {
        if !is_git(root) {
            // The project isn't here yet: an empty repository that the bundles and the remote fill.
            if std::fs::read_dir(root)?.next().is_some() {
                return Err(sync_error(
                    "This folder has files but isn't the git project the snapshot is from.",
                ));
            }
            git(root, &["init", "-q"])?;
            if let Some(url) = state.remote.as_deref().filter(|u| safe_remote(u)) {
                git(root, &["remote", "add", "origin", url])?;
            }
        }
        let dirty = local_changes(root)?;
        if !dirty.is_empty() && options.as_restored {
            // Through a stash, so git itself puts the folder back to the commit.
            git(root, &["stash", "push", "--include-untracked", "-q"])?;
            let _ = git(root, &["stash", "drop", "-q"]);
        } else if !dirty.is_empty() {
            if !options.stash {
                return Err(Error::Sync(
                    "SyncDirty",
                    format!(
                        "This folder has {} changed file(s) of its own.",
                        dirty.len()
                    ),
                ));
            }
            let name = format!("Before continuing from {}", options.from);
            git(root, &["stash", "push", "--include-untracked", "-m", &name])?;
            done.stashed = Some(name);
        }
        // What the bundles build on may be on the remote and not here yet (this computer's
        // copy is behind): asked for first. It needs the network and the user's git access;
        // when it fails the bundles say what is missing.
        if !state.bundles.is_empty() || state.head.is_some() {
            let _ = git(root, &["fetch", "-q", "origin"]);
        }
        for (n, bundle) in state.bundles.iter().enumerate() {
            let file = scratch_file(data, &format!("restore-{n}"))?;
            atomic_write(&file, &chunks::read(api, ring, &bundle.file).await?)?;
            // Under a namespace of their own: nothing of this computer's refs is moved by it.
            let fetched = git(
                root,
                &[
                    "fetch",
                    "-q",
                    "--no-tags",
                    &file.to_string_lossy(),
                    "+refs/*:refs/synced/*",
                ],
            );
            let _ = std::fs::remove_file(&file);
            fetched?;
        }
        // The stashes the other computer had, oldest first, so the list ends in its order.
        let here = stashes(root);
        for (sha, message) in state.stashes.iter().rev() {
            let safe = sha.len() >= 40 && sha.chars().all(|c| c.is_ascii_hexdigit());
            if !safe || here.iter().any(|(have, _)| have == sha) {
                continue;
            }
            if git(root, &["cat-file", "-e", &format!("{sha}^{{commit}}")]).is_err()
                || git(root, &["stash", "store", "-m", message, sha]).is_err()
            {
                done.notes
                    .push(format!("A stash couldn't be brought over: {message}"));
            }
        }
        if let Some(head) = &state.head {
            let present =
                |root: &Path| git(root, &["cat-file", "-e", &format!("{head}^{{commit}}")]).is_ok();
            if !present(root) && state.remote.is_some() {
                // The commit is on the remote: this needs the network and the user's git access.
                let _ = git(root, &["fetch", "-q", "origin"]);
            }
            if !present(root) {
                return Err(sync_error(
                    "The snapshot's commit isn't here and couldn't be fetched from the remote. Fetch it, then try again.",
                ));
            }
            match &state.branch {
                Some(branch) => {
                    let local = git(
                        root,
                        &[
                            "rev-parse",
                            "--verify",
                            "-q",
                            &format!("refs/heads/{branch}"),
                        ],
                    )
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                    match local {
                        None => {
                            git(root, &["checkout", "-q", "-b", branch, head])?;
                        }
                        Some(at) if at == *head => {
                            git(root, &["checkout", "-q", branch])?;
                        }
                        Some(at)
                            if git(root, &["merge-base", "--is-ancestor", &at, head]).is_ok() =>
                        {
                            git(root, &["checkout", "-q", branch])?;
                            git(root, &["merge", "-q", "--ff-only", head])?;
                        }
                        Some(_) => {
                            git(root, &["checkout", "-q", "--detach", head])?;
                            done.detached = true;
                            done.notes.push(format!(
                                "The branch {branch} has other commits here, so the snapshot's commit is checked out on its own."
                            ));
                        }
                    }
                    done.branch = Some(branch.clone());
                }
                None => {
                    git(root, &["checkout", "-q", "--detach", head])?;
                    done.detached = true;
                }
            }
            if let Some(staged) = &state.staged {
                let patch = chunks::read(api, ring, staged).await?;
                if crate::git::run(
                    root,
                    &["apply", "--cached", "--binary", "--whitespace=nowarn"],
                    Some(&patch),
                )
                .is_err()
                {
                    done.notes.push("What was staged couldn't be staged again; the files themselves are restored.".into());
                }
            }
        }
    }
    if manifest.git.is_none() && !options.as_restored {
        // No git to ask or to stash into: files here that differ from the snapshot's are this
        // computer's own. They are replaced only when asked, and kept in a folder of their own.
        let mut differing = Vec::new();
        for entry in &manifest.files {
            let target = safe_join(root, &entry.p)?;
            let Ok(bytes) = std::fs::read(&target) else {
                continue;
            };
            let mut ids = Vec::new();
            for piece in bytes.chunks(chunks::CHUNK_BYTES) {
                ids.push(ring.chunk_id(piece)?);
            }
            if ids != entry.s.chunks {
                differing.push((entry.p.clone(), bytes));
            }
        }
        if !differing.is_empty() {
            if !options.stash {
                return Err(Error::Sync(
                    "SyncDirty",
                    format!(
                        "This folder has {} file(s) that differ from the snapshot.",
                        differing.len()
                    ),
                ));
            }
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_secs());
            let keep = data.join("sync-replaced").join(stamp.to_string());
            for (path, bytes) in &differing {
                let target = safe_join(&keep, path)?;
                if let Some(dir) = target.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                atomic_write(&target, bytes)?;
            }
            done.notes.push(format!(
                "{} file(s) of this folder were replaced; their earlier versions are in {}.",
                differing.len(),
                keep.display()
            ));
        }
    }
    // A few files at once; the first failure stops the rest.
    let mut writes = futures_util::stream::iter(manifest.files.clone())
        .map(|entry| async move { write_file(api, ring, root, &entry).await })
        .buffer_unordered(WRITES_AT_ONCE);
    while let Some(written) = writes.next().await {
        written?;
        done.files += 1;
    }
    drop(writes);
    for path in &manifest.deleted {
        let target = safe_join(root, path)?;
        match std::fs::remove_file(&target) {
            Ok(()) => done.deleted += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => done.notes.push(format!("{path} couldn't be removed: {e}")),
        }
    }
    for (path, why) in &manifest.skipped {
        done.notes
            .push(format!("{path} wasn't in the snapshot ({why})."));
    }
    Ok(done)
}

/// Writes a snapshot's record again with other text, still naming the same chunks.
pub async fn rewrite(
    api: &Api,
    ring: &Keyring,
    collection: &str,
    id: &str,
    expect: u64,
    text: &str,
) -> Result<Put> {
    let summary: Summary = serde_json::from_str(text)?;
    let manifest = manifest(api, ring, &summary).await?;
    let mut refs: Vec<String> = summary.manifest.chunks.clone();
    for shard in &manifest.shards {
        refs.extend(shard.chunks.iter().cloned());
    }
    for f in &manifest.files {
        refs.extend(f.s.chunks.iter().cloned());
    }
    if let Some(g) = &manifest.git {
        for b in &g.bundles {
            refs.extend(b.file.chunks.iter().cloned());
        }
        if let Some(s) = &g.staged {
            refs.extend(s.chunks.iter().cloned());
        }
    }
    refs.sort();
    refs.dedup();
    let reply = api
        .post("blobs/have", &serde_json::json!({ "ids": [] }))
        .await?
        .into_ok()?;
    let gc_epoch = reply["gcEpoch"].as_u64().unwrap_or(0);
    records::put_labeled(
        api,
        ring,
        collection,
        id,
        Some(expect),
        Some(text),
        Some((&refs, gc_epoch)),
        Some(&label(&summary)),
    )
    .await
}

/// What the service may read of a snapshot: when, from which computer, how much. No paths.
fn label(summary: &Summary) -> serde_json::Value {
    let mut label = serde_json::json!({
        "time": summary.time,
        "computer": summary.device_name,
        "kind": summary.kind,
        "files": summary.files,
        "bytes": summary.bytes,
    });
    if let Some(branch) = &summary.branch {
        label["branch"] = serde_json::json!(branch);
    }
    if let Some(name) = &summary.pinned {
        label["pinned"] = serde_json::json!(name);
    }
    label
}

/// The record's text with a pin set or cleared.
pub fn pinned(summary: &Summary, name: Option<&str>) -> Summary {
    Summary {
        pinned: name
            .map(|n| n.trim().chars().take(80).collect::<String>())
            .filter(|n| !n.is_empty()),
        ..summary.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stored_list_is_in_stable_parts() {
        assert_eq!(shard_count(0), 1);
        assert_eq!(shard_count(399), 1);
        assert_eq!(shard_count(900), 2);
        assert_eq!(shard_count(100_000), 256);
        assert_eq!(shard_count(10_000_000), 1024);
        // A path is always in the same part, whatever else is in the list.
        assert_eq!(shard_of("src/main.rs", 16), shard_of("src/main.rs", 16));
        assert!(shard_of("src/main.rs", 16) < 16);
        let spread: std::collections::HashSet<usize> = (0..200)
            .map(|i| shard_of(&format!("src/file{i}.rs"), 16))
            .collect();
        assert!(spread.len() > 8, "paths spread over the parts");
    }

    #[test]
    fn a_folder_leaves_out_what_its_ignore_files_say() {
        let dir = std::env::temp_dir().join(format!("sync-ignore-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for sub in ["src", "data", "node_modules/x", "logs"] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
        }
        for (file, text) in [
            ("src/main.py", "print()"),
            ("data/big.bin", "x"),
            ("node_modules/x/index.js", "x"),
            ("logs/today.log", "x"),
            ("notes.txt", "x"),
            (".syncignore", "data/\n"),
            (".gitignore", "*.log\n"),
        ] {
            std::fs::write(dir.join(file), text).unwrap();
        }
        let files = folder_files(&dir);
        assert_eq!(
            files,
            [".gitignore", ".syncignore", "notes.txt", "src/main.py"]
        );
        let estimate = estimate(&dir).unwrap();
        assert_eq!((estimate.kind.as_str(), estimate.files), ("folder", 4));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_an_ordinary_address_becomes_a_remote() {
        for ok in [
            "https://github.com/owner/repo.git",
            "git@github.com:owner/repo.git",
            "ssh://git@example.com:22/a/b",
        ] {
            assert!(safe_remote(ok), "{ok}");
        }
        for bad in [
            "ext::sh -c 'touch x'",
            "--upload-pack=touch x",
            "/srv/repo.git",
            "\\\\server\\share\\repo",
            "file:///srv/repo.git",
            "C:\\repos\\x",
            "",
        ] {
            assert!(!safe_remote(bad), "{bad}");
        }
    }

    #[test]
    fn a_manifest_path_stays_inside_the_project() {
        let root = Path::new("/project");
        assert_eq!(
            safe_join(root, "src/a.rs").unwrap(),
            root.join("src").join("a.rs")
        );
        assert!(safe_join(root, "../outside").is_err());
        assert!(safe_join(root, "a/../../b").is_err());
        assert!(safe_join(root, "/etc/passwd").is_err());
        assert!(safe_join(root, ".git/config").is_err());
        assert!(safe_join(root, ".GIT/hooks/pre-commit").is_err());
        assert!(safe_join(root, "").is_err());
        for bad in [
            "sub/.git/hooks/x",
            ".git./config",
            ".git /config",
            "GIT~1/config",
            "a/.GIT/x",
            "a:b",
            "name./x",
        ] {
            assert!(safe_join(root, bad).is_err(), "{bad}");
        }
        for bad in ["NUL", "con.txt", "sub/COM1", "lpt9.log", "Aux"] {
            assert!(safe_join(root, bad).is_err(), "{bad}");
        }
        assert!(safe_join(root, "console.log").is_ok());
        assert!(safe_join(root, "docs/.gitignore").is_ok());
        assert!(safe_join(root, ".github/workflows/ci.yml").is_ok());
        #[cfg(windows)]
        assert!(safe_join(root, "C:\\Windows\\x").is_err());
    }
}
