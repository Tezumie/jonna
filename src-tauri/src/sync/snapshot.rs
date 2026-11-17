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

/// Whether one part of a synced path is a name some computer reads as something else: a
/// device's name on Windows, a name with a stream or a trailing dot or space, a repository's
/// own folder.
pub(super) fn unsafe_name(text: &str) -> bool {
    // Windows drops trailing dots and spaces and reads short names and streams:
    // ".git.", ".git ", "GIT~1" and ".git::$INDEX_ALLOCATION" are all .git there.
    // No repository's own folder at any depth, either.
    let plain = text.trim_end_matches(['.', ' ']).to_ascii_lowercase();
    let stem = plain.split('.').next().unwrap_or("");
    let reserved = matches!(stem, "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.ends_with(|c: char| c.is_ascii_digit()));
    plain == ".git"
        || reserved
        || plain.starts_with("git~")
        || text.contains(':')
        || text.ends_with(['.', ' '])
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
                if unsafe_name(&text) {
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

/// The newest stash's commit, when there is a stash.
fn stash_tip(root: &Path) -> Option<String> {
    git(root, &["rev-parse", "-q", "--verify", "refs/stash"])
        .ok()
        .map(|sha| sha.trim().to_string())
        .filter(|sha| !sha.is_empty())
}

/// Puts exactly `paths` (changed, new or deleted files) into a stash, and nothing else: what
/// the project's `.syncignore` names is never in that list, and stays in the folder as it is.
/// The new stash's commit, or None when git had nothing to save (then there is no new stash,
/// and the newest one is still the user's own).
fn stash_paths(root: &Path, paths: &[String], message: Option<&str>) -> Result<Option<String>> {
    // A folder that is a repository of its own is listed as `name/`: git can't stash it.
    let paths: Vec<&String> = paths.iter().filter(|p| !p.ends_with('/')).collect();
    if paths.is_empty() {
        return Ok(None);
    }
    let before = stash_tip(root);
    // The names go in on stdin, taken as they are written: a list of any length (a command
    // line has a limit, a short one on Windows), and no name read as a pattern.
    let mut list = Vec::new();
    for path in paths {
        list.extend_from_slice(path.as_bytes());
        list.push(0);
    }
    let mut args = vec![
        "--literal-pathspecs",
        "stash",
        "push",
        "--include-untracked",
        "-q",
    ];
    if let Some(message) = message {
        args.extend(["-m", message]);
    }
    args.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
    crate::git::run(root, &args, Some(&list))?;
    Ok(stash_tip(root).filter(|now| before.as_ref() != Some(now)))
}

/// What a restore set aside of the folder's own before it changed anything: said with any
/// error that comes after, so the work never just looks gone.
enum Aside {
    /// A git stash: its message and its commit.
    Stash { name: String, commit: String },
    /// A folder the replaced files were copied to.
    Folder(PathBuf),
}

impl Aside {
    fn describe(&self, root: &Path) -> String {
        match self {
            Aside::Stash { name, commit } => {
                // The other computer's stashes may have been put on top of it since.
                match stashes(root).iter().position(|(sha, _)| sha == commit) {
                    Some(n) => format!(
                        "Your own changes are safe in the git stash \"{name}\": bring them back with `git stash pop stash@{{{n}}}`."
                    ),
                    None => format!(
                        "Your own changes are safe in the git stash \"{name}\": see `git stash list`."
                    ),
                }
            }
            Aside::Folder(dir) => format!(
                "The files of this folder that differed were copied to {} first.",
                dir.display()
            ),
        }
    }
}

/// `error`, saying as well where the folder's own changes were put.
fn with_aside(error: Error, note: &str) -> Error {
    match error {
        Error::Sync(code, text) => Error::Sync(code, format!("{text} {note}")),
        Error::Git(text) => Error::Git(format!("{text}\n{note}")),
        Error::GitSettingsChanged(text) => Error::GitSettingsChanged(format!("{text}\n{note}")),
        other => Error::Sync("Sync", format!("{other}. {note}")),
    }
}

/// Reads until `buf` is full or the file ends; how much was read.
fn fill(file: &mut impl std::io::Read, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut at = 0;
    while at < buf.len() {
        match file.read(&mut buf[at..]) {
            Ok(0) => break,
            Ok(n) => at += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(at)
}

/// Whether `file` holds the content `stored` names, read a chunk at a time (`piece` is the
/// room for one chunk): a large file is never in memory whole.
fn same_content(
    ring: &Keyring,
    file: &mut impl std::io::Read,
    stored: &Stored,
    piece: &mut [u8],
) -> Result<bool> {
    let mut ids = stored.chunks.iter();
    loop {
        let n = fill(file, piece)?;
        if n == 0 {
            return Ok(ids.next().is_none());
        }
        match ids.next() {
            Some(id) if *id == ring.chunk_id(&piece[..n])? => {}
            _ => return Ok(false),
        }
        if n < piece.len() {
            return Ok(ids.next().is_none());
        }
    }
}

/// A new folder `parent/name`, or `parent/name-1`, `-2`… when that one is taken: never one
/// something else already uses.
fn fresh_dir(parent: &Path, name: &str) -> Result<PathBuf> {
    std::fs::create_dir_all(parent)?;
    for n in 0..10_000 {
        let dir = if n == 0 {
            parent.join(name)
        } else {
            parent.join(format!("{name}-{n}"))
        };
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
    }
    Err(sync_error(
        "No folder could be made for the replaced files.",
    ))
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

// ---------------------------------------------------------------- looking inside one

/// At most this many of a snapshot's files are compared with the folder (a folder without git
/// can name 200,000): the rest are listed as not compared.
pub const COMPARE_MAX: usize = 5_000;
/// A file larger than this isn't read as text.
pub const TEXT_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// How a snapshot's file stands against the folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Standing {
    /// The folder's file has the same content (a deletion: the file is gone here too).
    Same,
    /// The folder's file has other content (a deletion: the file is still here).
    Differs,
    /// In the snapshot, not in the folder.
    Missing,
    /// Not compared: past `COMPARE_MAX`, not readable, or a path a snapshot may not name.
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparedFile {
    pub path: String,
    pub size: u64,
    /// The snapshot records that the file was deleted.
    pub deleted: bool,
    pub state: Standing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Compared {
    /// Every file and deletion of the snapshot, by path.
    pub files: Vec<ComparedFile>,
    /// How many were left uncompared because the snapshot names more than `COMPARE_MAX`.
    pub truncated: usize,
}

/// How one file of a snapshot stands against the folder: by size first, then by content, a
/// chunk at a time.
fn standing(ring: &Keyring, root: &Path, entry: &FileEntry, piece: &mut Vec<u8>) -> Standing {
    let Ok(target) = safe_join(root, &entry.p) else {
        return Standing::Unknown;
    };
    let meta = match std::fs::symlink_metadata(&target) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Standing::Missing,
        Err(_) => return Standing::Unknown,
    };
    // A link or a folder where the snapshot has a file: not followed, and not the same.
    if !meta.is_file() || meta.len() != entry.s.size {
        return Standing::Differs;
    }
    let Ok(mut file) = std::fs::File::open(&target) else {
        return Standing::Unknown;
    };
    if piece.is_empty() {
        *piece = vec![0u8; chunks::CHUNK_BYTES];
    }
    match same_content(ring, &mut file, &entry.s, piece) {
        Ok(true) => Standing::Same,
        Ok(false) => Standing::Differs,
        // Locked, or gone since it was looked at.
        Err(_) => Standing::Unknown,
    }
}

/// Each file of a snapshot with how it stands against the folder `root`, by path: the first
/// `limit` are compared, the rest are `Unknown` and counted in `truncated`. Nothing is
/// fetched and nothing is written; the folder's files are read a chunk at a time. Reads the
/// disk: call it off the async threads.
pub fn compare(ring: &Keyring, root: &Path, manifest: &Manifest, limit: usize) -> Compared {
    enum Entry<'a> {
        File(&'a FileEntry),
        Deleted(&'a str),
    }
    let mut entries: Vec<(&str, Entry)> = manifest
        .files
        .iter()
        .map(|f| (f.p.as_str(), Entry::File(f)))
        .chain(
            manifest
                .deleted
                .iter()
                .map(|p| (p.as_str(), Entry::Deleted(p))),
        )
        .collect();
    entries.sort_by(|a, b| a.0.cmp(b.0));
    let truncated = entries.len().saturating_sub(limit);
    let mut piece = Vec::new();
    let files = entries
        .into_iter()
        .enumerate()
        .map(|(n, (path, entry))| {
            let (size, deleted) = match &entry {
                Entry::File(f) => (f.s.size, false),
                Entry::Deleted(_) => (0, true),
            };
            let state = if n >= limit {
                Standing::Unknown
            } else {
                match entry {
                    Entry::File(f) => standing(ring, root, f, &mut piece),
                    Entry::Deleted(p) => match safe_join(root, p) {
                        Ok(target) if std::fs::symlink_metadata(&target).is_ok() => {
                            Standing::Differs
                        }
                        Ok(_) => Standing::Same,
                        Err(_) => Standing::Unknown,
                    },
                }
            };
            ComparedFile {
                path: path.to_string(),
                size,
                deleted,
                state,
            }
        })
        .collect();
    Compared { files, truncated }
}

/// One file of a snapshot as text, or why it isn't shown as text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    pub text: Option<String>,
    pub size: u64,
    /// "large" (over `TEXT_MAX_BYTES`) or "binary" (not text).
    pub reason: Option<&'static str>,
}

fn too_large(size: u64) -> FileText {
    FileText {
        text: None,
        size,
        reason: Some("large"),
    }
}

/// A file's bytes as text: refused when they aren't UTF-8 or hold a NUL (as git tells binary).
fn as_text(bytes: Vec<u8>) -> FileText {
    let size = bytes.len() as u64;
    if size > TEXT_MAX_BYTES {
        return too_large(size);
    }
    match String::from_utf8(bytes) {
        Ok(text) if !text.contains('\0') => FileText {
            text: Some(text),
            size,
            reason: None,
        },
        _ => FileText {
            text: None,
            size,
            reason: Some("binary"),
        },
    }
}

/// One file of a snapshot as text, written nowhere: None when the snapshot doesn't hold the
/// file (it isn't listed, or is listed as deleted). A file too large to show is not fetched.
pub async fn read_text(
    api: &Api,
    ring: &Keyring,
    manifest: &Manifest,
    path: &str,
) -> Result<Option<FileText>> {
    let Some(entry) = manifest.files.iter().find(|f| f.p == path) else {
        return Ok(None);
    };
    if entry.s.size > TEXT_MAX_BYTES {
        return Ok(Some(too_large(entry.s.size)));
    }
    Ok(Some(as_text(chunks::read(api, ring, &entry.s).await?)))
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
    let mut aside = None;
    match restore_steps(
        api,
        ring,
        data,
        root,
        manifest,
        options,
        (&mut done, &mut aside),
    )
    .await
    {
        Ok(()) => Ok(done),
        // The folder's own changes were set aside and the restore then failed (offline, a
        // commit that can't be fetched, a locked file): the error says where they are.
        Err(e) => Err(match aside {
            Some(aside) => with_aside(e, &aside.describe(root)),
            None => e,
        }),
    }
}

async fn restore_steps(
    api: &Api,
    ring: &Keyring,
    data: &Path,
    root: &Path,
    manifest: &Manifest,
    options: RestoreOptions<'_>,
    (done, aside): (&mut Restored, &mut Option<Aside>),
) -> Result<()> {
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
            // Through a stash, so git itself puts the folder back to the commit: of the files
            // an earlier restore wrote only, and dropped only when one was really made (with
            // nothing saved, the newest stash is the user's own).
            if stash_paths(root, &dirty, None)?.is_some() {
                let _ = git(root, &["stash", "drop", "-q"]);
            }
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
            if let Some(commit) = stash_paths(root, &dirty, Some(&name))? {
                *aside = Some(Aside::Stash {
                    name: name.clone(),
                    commit,
                });
                done.stashed = Some(name);
            }
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
        // Only their names are kept: the files are read a chunk at a time, and copied later.
        let mut differing: Vec<&str> = Vec::new();
        let mut piece = Vec::new();
        for entry in &manifest.files {
            let target = safe_join(root, &entry.p)?;
            let Ok(mut file) = std::fs::File::open(&target) else {
                continue;
            };
            let Ok(meta) = file.metadata() else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let same = meta.len() == entry.s.size && {
                if piece.is_empty() {
                    piece = vec![0u8; chunks::CHUNK_BYTES];
                }
                match same_content(ring, &mut file, &entry.s, &mut piece) {
                    Ok(same) => same,
                    // Not readable to its end: not known to be the snapshot's, so kept.
                    Err(Error::Io(_)) => false,
                    Err(e) => return Err(e),
                }
            };
            if !same {
                differing.push(&entry.p);
            }
        }
        drop(piece);
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
            // A folder of this restore's own: two in the same second never share one.
            let keep = fresh_dir(&data.join("sync-replaced"), &stamp.to_string())?;
            *aside = Some(Aside::Folder(keep.clone()));
            for path in &differing {
                let target = safe_join(&keep, path)?;
                if let Some(dir) = target.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                // Copied, not read: a large file is never in memory. Nothing of the folder
                // is replaced before every copy is made.
                std::fs::copy(safe_join(root, path)?, &target)?;
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
    Ok(())
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

    /// A git repository of its own under the system's temp folder, with one commit.
    fn repo(name: &str, files: &[(&str, &str)]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sync-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]).unwrap();
        for (key, value) in [
            ("user.name", "Test"),
            ("user.email", "test@example.com"),
            ("core.autocrlf", "false"),
            ("commit.gpgsign", "false"),
        ] {
            git(&dir, &["config", key, value]).unwrap();
        }
        for (file, text) in files {
            let path = dir.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        git(&dir, &["add", "-A"]).unwrap();
        git(&dir, &["commit", "-q", "-m", "first"]).unwrap();
        dir
    }

    fn text(dir: &Path, file: &str) -> String {
        std::fs::read_to_string(dir.join(file)).unwrap()
    }

    #[test]
    fn a_stash_takes_the_listed_files_and_leaves_what_syncignore_names() {
        let dir = repo(
            "stash-paths",
            &[
                ("a.txt", "a"),
                ("gone.txt", "gone"),
                ("local.cfg", "committed"),
                (".syncignore", "local.cfg\ndata/\n"),
            ],
        );
        // The user's own stash, made before: it must still be there afterwards.
        std::fs::write(dir.join("a.txt"), "earlier work").unwrap();
        git(&dir, &["stash", "push", "-q", "-m", "mine"]).unwrap();
        let mine = stashes(&dir);
        assert_eq!(mine.len(), 1);

        std::fs::write(dir.join("a.txt"), "changed").unwrap();
        std::fs::remove_file(dir.join("gone.txt")).unwrap();
        std::fs::write(dir.join("new file.txt"), "new").unwrap();
        std::fs::write(dir.join("*.txt"), "odd name").ok();
        std::fs::write(dir.join("local.cfg"), "edited here").unwrap();
        std::fs::create_dir_all(dir.join("data")).unwrap();
        std::fs::write(dir.join("data").join("x.bin"), "data").unwrap();

        let dirty = local_changes(&dir).unwrap();
        assert!(dirty.contains(&"a.txt".to_string()), "{dirty:?}");
        assert!(dirty.contains(&"new file.txt".to_string()), "{dirty:?}");
        assert!(!dirty
            .iter()
            .any(|p| p == "local.cfg" || p.starts_with("data")));

        let made = stash_paths(&dir, &dirty, None).unwrap();
        assert!(made.is_some());
        assert_eq!(stashes(&dir).len(), 2);
        // The listed files are back at the commit.
        assert_eq!(text(&dir, "a.txt"), "a");
        assert_eq!(text(&dir, "gone.txt"), "gone");
        assert!(!dir.join("new file.txt").exists());
        // What .syncignore names is exactly as it was.
        assert_eq!(text(&dir, "local.cfg"), "edited here");
        assert_eq!(text(&dir, "data/x.bin"), "data");
        assert!(local_changes(&dir).unwrap().is_empty());

        git(&dir, &["stash", "drop", "-q"]).unwrap();
        assert_eq!(stashes(&dir), mine);

        // Nothing to save: no stash is made, so there is none to drop.
        assert_eq!(
            stash_paths(&dir, &["a.txt".to_string()], None).unwrap(),
            None
        );
        assert_eq!(stash_paths(&dir, &[], None).unwrap(), None);
        assert_eq!(stashes(&dir), mine);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_error_after_a_stash_says_where_the_changes_are() {
        let dir = repo("stash-named", &[("a.txt", "a")]);
        std::fs::write(dir.join("a.txt"), "work").unwrap();
        let name = "Before continuing from the laptop";
        let commit = stash_paths(&dir, &["a.txt".to_string()], Some(name))
            .unwrap()
            .unwrap();
        // Another stash put on top (the other computer's): the name still finds the right one.
        std::fs::write(dir.join("a.txt"), "other").unwrap();
        git(&dir, &["stash", "push", "-q", "-m", "theirs"]).unwrap();
        let aside = Aside::Stash {
            name: name.to_string(),
            commit,
        };
        let note = aside.describe(&dir);
        assert!(note.contains(name) && note.contains("stash@{1}"), "{note}");
        match with_aside(Error::Sync("SyncMissing", "Part is missing.".into()), &note) {
            Error::Sync("SyncMissing", text) => {
                assert!(text.starts_with("Part is missing. ") && text.contains("stash@{1}"));
            }
            other => panic!("unexpected: {other:?}"),
        }
        assert!(matches!(
            with_aside(Error::Git("checkout failed".into()), &note),
            Error::Git(text) if text.contains("checkout failed") && text.contains(name)
        ));
        let io = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "locked");
        assert!(matches!(
            with_aside(Error::Io(io), &note),
            Error::Sync("Sync", text) if text.contains("locked") && text.contains(name)
        ));
        git(&dir, &["stash", "pop", "-q", "stash@{1}"]).ok();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_is_compared_a_chunk_at_a_time() {
        let ring = Keyring::generate().unwrap();
        let stored = |data: &[u8]| Stored {
            chunks: data
                .chunks(8)
                .map(|piece| ring.chunk_id(piece).unwrap())
                .collect(),
            size: data.len() as u64,
        };
        let same = |data: &[u8], with: &Stored| {
            // One byte at a time: a short read is not the end of a chunk.
            struct Slow<'a>(&'a [u8]);
            impl std::io::Read for Slow<'_> {
                fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                    let n = self.0.len().min(buf.len()).min(1);
                    buf[..n].copy_from_slice(&self.0[..n]);
                    self.0 = &self.0[n..];
                    Ok(n)
                }
            }
            same_content(&ring, &mut Slow(data), with, &mut [0u8; 8]).unwrap()
        };
        for data in [&b""[..], b"short", b"exactly8", b"more than one chunk here"] {
            assert!(same(data, &stored(data)), "{data:?}");
        }
        assert!(!same(
            b"more than one chunk here",
            &stored(b"more than one chunk HERE")
        ));
        assert!(!same(b"exactly8", &stored(b"exactly8 and more")));
        assert!(!same(b"exactly8 and more", &stored(b"exactly8")));
        assert!(!same(b"", &stored(b"x")));
        assert!(!same(b"x", &stored(b"")));
    }

    /// A snapshot's entry for a file with this content.
    fn entry(ring: &Keyring, path: &str, data: &[u8]) -> FileEntry {
        FileEntry {
            p: path.to_string(),
            s: Stored {
                chunks: data
                    .chunks(chunks::CHUNK_BYTES)
                    .map(|piece| ring.chunk_id(piece).unwrap())
                    .collect(),
                size: data.len() as u64,
            },
            x: false,
            t: 0,
        }
    }

    #[test]
    fn a_snapshot_is_compared_with_the_folder() {
        let ring = Keyring::generate().unwrap();
        let dir = std::env::temp_dir().join(format!("sync-compare-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("folder.txt")).unwrap();
        for (file, text) in [
            ("src/same.rs", "fn main() {}"),
            ("src/edited.rs", "fn main() { 1 }"),
            ("resized.txt", "longer than it was"),
            ("empty.txt", ""),
            ("still-here.txt", "x"),
        ] {
            std::fs::write(dir.join(file), text).unwrap();
        }
        let manifest = Manifest {
            v: 1,
            files: vec![
                entry(&ring, "src/same.rs", b"fn main() {}"),
                // The same size, other content: only the content tells.
                entry(&ring, "src/edited.rs", b"fn main() { 2 }"),
                entry(&ring, "resized.txt", b"short"),
                entry(&ring, "empty.txt", b""),
                entry(&ring, "not/here.txt", b"new"),
                entry(&ring, "folder.txt", b"a file there"),
                entry(&ring, "../outside.txt", b"x"),
            ],
            deleted: vec![
                "still-here.txt".into(),
                "gone.txt".into(),
                ".git/config".into(),
            ],
            ..Default::default()
        };
        let compared = compare(&ring, &dir, &manifest, COMPARE_MAX);
        assert_eq!(compared.truncated, 0);
        let got: Vec<(&str, Standing, bool)> = compared
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.state, f.deleted))
            .collect();
        assert_eq!(
            got,
            [
                ("../outside.txt", Standing::Unknown, false),
                (".git/config", Standing::Unknown, true),
                ("empty.txt", Standing::Same, false),
                ("folder.txt", Standing::Differs, false),
                ("gone.txt", Standing::Same, true),
                ("not/here.txt", Standing::Missing, false),
                ("resized.txt", Standing::Differs, false),
                ("src/edited.rs", Standing::Differs, false),
                ("src/same.rs", Standing::Same, false),
                ("still-here.txt", Standing::Differs, true),
            ]
        );
        let sizes: Vec<u64> = compared.files.iter().map(|f| f.size).collect();
        assert_eq!(sizes, [1, 0, 0, 12, 0, 3, 5, 15, 12, 0]);

        // Past the limit nothing is read: listed, not compared, and counted.
        let few = compare(&ring, &dir, &manifest, 3);
        assert_eq!(few.truncated, 7);
        assert_eq!(few.files.len(), 10);
        assert_eq!(few.files[2].state, Standing::Same);
        assert!(few.files[3..].iter().all(|f| f.state == Standing::Unknown));
        // As the front end reads it.
        let json = serde_json::to_value(&few.files[5]).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "path": "not/here.txt", "size": 3, "deleted": false, "state": "unknown" })
        );
        assert_eq!(
            serde_json::to_value(Standing::Missing).unwrap(),
            serde_json::json!("missing")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_is_shown_as_text_only_when_it_is_text() {
        let text = as_text("héllo\r\nworld".as_bytes().to_vec());
        assert_eq!(text.text.as_deref(), Some("héllo\r\nworld"));
        assert_eq!((text.size, text.reason), (13, None));
        assert_eq!(as_text(Vec::new()).text.as_deref(), Some(""));
        for binary in [&[0xff, 0xfe, 0x00][..], b"text\0with a nul"] {
            let got = as_text(binary.to_vec());
            assert_eq!((got.text, got.reason), (None, Some("binary")));
        }
        let large = as_text(vec![b'a'; TEXT_MAX_BYTES as usize + 1]);
        assert_eq!((large.text, large.reason), (None, Some("large")));
        assert_eq!(large.size, TEXT_MAX_BYTES + 1);
        assert!(as_text(vec![b'a'; TEXT_MAX_BYTES as usize]).text.is_some());
        assert_eq!(
            serde_json::to_value(too_large(9)).unwrap(),
            serde_json::json!({ "text": null, "size": 9, "reason": "large" })
        );
    }

    #[test]
    fn the_folder_for_replaced_files_is_never_shared() {
        let parent = std::env::temp_dir().join(format!("sync-replaced-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&parent);
        let first = fresh_dir(&parent, "1700000000").unwrap();
        let second = fresh_dir(&parent, "1700000000").unwrap();
        let third = fresh_dir(&parent, "1700000000").unwrap();
        assert_eq!(first, parent.join("1700000000"));
        assert_eq!(second, parent.join("1700000000-1"));
        assert_eq!(third, parent.join("1700000000-2"));
        assert!(first.is_dir() && second.is_dir() && third.is_dir());
        let _ = std::fs::remove_dir_all(&parent);
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
