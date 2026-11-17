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
/// A snapshot's list of files (its index and every part) is at most this large when read.
const MAX_MANIFEST_BYTES: u64 = 256 * 1024 * 1024;
/// The list is stored in at most this many parts (`shard_count`).
const MAX_SHARDS: usize = 1024;
/// Everything a copy of a shared snapshot brings (its files, its bundles, its staged patch)
/// is at most this much.
pub const MAX_COPY_BYTES: u64 = 20 * 1024 * 1024 * 1024;
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

/// Whether what is at a path stands for another place: a symbolic link, and on Windows a
/// junction too (the standard library reads both as a link; a file kept in the cloud is none).
fn is_link(meta: &std::fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

fn through_a_link(relative: &str) -> Error {
    sync_error(format!(
        "a snapshot's path leaves the project through a link: {relative}"
    ))
}

/// Whether `real` (a folder's resolved path) is `real_root` or under it, by names a snapshot
/// may name: a path that only resolves into a repository's own folder (through another
/// spelling of its name) is not.
fn names_inside(real_root: &Path, real: &Path) -> bool {
    real.strip_prefix(real_root).is_ok_and(|rest| {
        rest.components().all(
            |part| matches!(part, Component::Normal(name) if !unsafe_name(&name.to_string_lossy())),
        )
    })
}

/// Whether a path of the project passes through a link before its last part: what is there
/// is then somewhere else, and is never read into a snapshot.
fn passes_a_link(root: &Path, relative: &str) -> bool {
    let mut at = root.to_path_buf();
    let mut parts = Path::new(relative).components().peekable();
    while let Some(part) = parts.next() {
        at.push(part);
        if parts.peek().is_none() {
            break;
        }
        if std::fs::symlink_metadata(&at).is_ok_and(|meta| is_link(&meta)) {
            return true;
        }
    }
    false
}

/// The folder a snapshot is restored into, as every write, read and deletion of a restore
/// finds its place in it.
struct Project<'a> {
    root: &'a Path,
    /// The folder resolved, once.
    real: PathBuf,
}

impl<'a> Project<'a> {
    fn new(root: &'a Path) -> Result<Self> {
        Ok(Self {
            root,
            real: std::fs::canonicalize(root)?,
        })
    }

    /// A manifest's path as a place under the folder: by `safe_join`'s rules for names, and
    /// with no link anywhere on the way. A link that the snapshot's own commit checked out
    /// (`x -> .git`, `y -> /home/someone`) would otherwise take a write into the repository's
    /// settings or a deletion out of the folder. Each part that exists is looked at without
    /// following it; what exists is then resolved and must still be inside, under names a
    /// snapshot may name. The last part may be a link: the caller replaces or removes the link
    /// itself, never what it points at.
    fn place(&self, relative: &str) -> Result<PathBuf> {
        let target = safe_join(self.root, relative)?;
        let rest = target
            .strip_prefix(self.root)
            .map_err(|_| through_a_link(relative))?;
        let mut at = self.root.to_path_buf();
        let mut deepest: Option<PathBuf> = None;
        let mut parts = rest.components().peekable();
        while let Some(part) = parts.next() {
            at.push(part);
            if parts.peek().is_none() {
                break;
            }
            match std::fs::symlink_metadata(&at) {
                Ok(meta) if is_link(&meta) => return Err(through_a_link(relative)),
                Ok(_) => deepest = Some(at.clone()),
                // Not there yet: nothing below it is either.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                Err(e) => return Err(e.into()),
            }
        }
        if let Some(folder) = deepest {
            if !names_inside(&self.real, &std::fs::canonicalize(folder)?) {
                return Err(through_a_link(relative));
            }
        }
        Ok(target)
    }

    /// `place`, and when a link is at the place itself, the link is removed (not what it
    /// points at): what is written there is then a file of the folder.
    fn place_for_writing(&self, relative: &str) -> Result<PathBuf> {
        let target = self.place(relative)?;
        if std::fs::symlink_metadata(&target).is_ok_and(|meta| is_link(&meta)) {
            // (A link to a folder is removed as a folder on Windows.)
            if std::fs::remove_file(&target).is_err() {
                std::fs::remove_dir(&target)?;
            }
        }
        Ok(target)
    }
}

/// Whether an address from a snapshot may become a git remote: an ordinary https, ssh or git
/// address. Not a local path, not a transport that runs a program, not an option.
pub(super) fn safe_remote(url: &str) -> bool {
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
    /// Files that stay out whatever the ignore files say (`CreateOptions::leave_out`).
    leave_out: Option<LeaveOut>,
}

/// For a path of the project (with `/`): why it stays out of a snapshot, or None when it travels.
pub type LeaveOut = fn(&str) -> Option<&'static str>;

impl Capture<'_> {
    async fn file(&mut self, path: &str) -> Result<()> {
        // Before anything of it is looked at: such a file is never read, only named.
        if let Some(why) = self.leave_out.and_then(|leave| leave(path)) {
            self.manifest.skipped.push((path.to_string(), why.into()));
            return Ok(());
        }
        let full = self.root.join(path);
        let meta = match std::fs::symlink_metadata(&full) {
            Ok(m) => m,
            Err(_) => return Ok(()),
        };
        // A link is named, never followed: not at the file itself, and not on the way to it
        // (what is behind a linked folder is somewhere else, outside the project perhaps).
        if is_link(&meta) || passes_a_link(self.root, path) {
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
        // Grown since it was looked at: a snapshot never names a file it wouldn't read back.
        if bytes.len() as u64 > MAX_FILE_BYTES {
            self.manifest
                .skipped
                .push((path.to_string(), "too large".into()));
            return Ok(());
        }
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

/// Which commits a snapshot's bundles carry.
#[derive(Clone, Default)]
struct Scope {
    /// Only what the commit checked out needs: no other branch, no tag, no stash (a share).
    head_only: bool,
    /// What is left out because a remote has it, as git's option for it: `--remotes` (any
    /// remote's), `--remotes=<name>` (one remote's). None: nothing is left out, the bundles
    /// carry the whole history.
    not_remotes: Option<String>,
    /// Files that must not travel inside commits either (`CreateOptions::leave_out`): with
    /// `head_only`, commits that add or change one refuse the capture.
    leave_out: Option<LeaveOut>,
}

/// The option that leaves out what the remote `name` has. None for a name git would read as
/// a pattern: nothing is left out then.
fn only_remote(name: &str) -> Option<String> {
    (!name.is_empty() && !name.contains(['*', '?', '[', '\\'])).then(|| format!("--remotes={name}"))
}

/// What a snapshot's bundles leave out because a remote has it (`Scope::not_remotes`).
/// `remote`: the name of the project's remote (`origin`, else the first). `named`: the
/// snapshot says its address. Left out only when whoever restores can get it there: a remote
/// the snapshot doesn't name (a share drops a local or `file://` one) counts as none, and
/// the bundles then carry the whole history. A share leaves out what that one remote has,
/// not what any other has: its reader clones from that one.
fn remotes_left_out(
    remote: Option<&str>,
    named: bool,
    head_only: bool,
    everything: bool,
) -> Option<String> {
    match remote {
        Some(name) if named && !everything => {
            if head_only {
                only_remote(name)
            } else {
                Some("--remotes".into())
            }
        }
        _ => None,
    }
}

/// What the next bundle is made of: the tips it is made for, what it names (`what`) and
/// what it leaves out (`not`), as git's revision arguments.
struct BundleRange {
    tips: Vec<String>,
    what: Vec<String>,
    not: Vec<String>,
}

impl BundleRange {
    /// As revision arguments: `what… [--not not…]`.
    fn args(&self) -> Vec<String> {
        let mut args = self.what.clone();
        if !self.not.is_empty() {
            args.push("--not".into());
            args.extend(self.not.iter().cloned());
        }
        args
    }
}

fn bundle_range(root: &Path, chain: &[Bundle], scope: &Scope) -> BundleRange {
    let known = |sha: &str| git(root, &["cat-file", "-e", &format!("{sha}^{{commit}}")]).is_ok();
    let (tips, what) = if scope.head_only {
        // Only the commit checked out: what other branches and stashes hold stays here.
        let head = git(root, &["rev-parse", "-q", "--verify", "HEAD"])
            .map(|sha| sha.trim().to_string())
            .unwrap_or_default();
        (vec![head], vec!["HEAD".to_string()])
    } else {
        // Every ref but the ones an earlier restore put here (they are another computer's),
        // and the commit checked out, which may have no ref.
        let mut what: Vec<String> = vec![
            "--exclude=refs/synced/*".into(),
            "--all".into(),
            "HEAD".into(),
        ];
        // Older stashes have no ref of their own: named by commit, they go into the pack too.
        what.extend(stashes(root).into_iter().map(|(sha, _)| sha));
        (ref_tips(root), what)
    };
    let mut not: Vec<String> = Vec::new();
    if let Some(remotes) = &scope.not_remotes {
        not.push(remotes.clone());
    }
    for bundle in chain {
        for tip in &bundle.tips {
            // Only commits can be excluded (a tag may point at something else).
            if known(tip) && !not.contains(tip) {
                not.push(tip.clone());
            }
        }
    }
    BundleRange { tips, what, not }
}

/// The files `leave` names among those the commits of `range` add or change: what a bundle
/// of that range would carry of them. (A deletion carries nothing of the file.)
fn left_out_in_commits(root: &Path, range: &BundleRange, leave: LeaveOut) -> Result<Vec<String>> {
    let mut args: Vec<String> = [
        "log",
        "--format=",
        "--name-only",
        "-z",
        "--no-renames",
        // A merge is compared with each of its parents: what only the merge itself brought in
        // is listed too.
        "-m",
        "--diff-filter=d",
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();
    args.extend(range.args());
    // (No paths may follow: a revision is never read as one.)
    args.push("--".into());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = git(root, &refs)?;
    let mut found: Vec<String> = out
        .split(['\0', '\n'])
        .map(rel)
        .filter(|path| !path.is_empty() && leave(path).is_some())
        .collect();
    found.sort();
    found.dedup();
    Ok(found)
}

/// The refusal of a share's capture whose unpushed commits hold key files.
fn key_files_in_history(files: &[String]) -> Error {
    let shown: Vec<&str> = files.iter().take(10).map(String::as_str).collect();
    let more = match files.len() - shown.len() {
        0 => String::new(),
        n => format!(" and {n} more"),
    };
    Error::Sync(
        "ShareKeyFilesInHistory",
        format!(
            "These key files are in commits that haven't been pushed, so they would be shared: {}{more}. Push or remove them, then share again.",
            shown.join(", ")
        ),
    )
}

/// The bundles a snapshot needs: the ones before (while their commits are still here) and a
/// new one for what the refs reach now that those, and the remotes, don't have.
async fn bundles(
    capture: &mut Capture<'_>,
    data: &Path,
    before: Option<&GitState>,
    scope: &Scope,
) -> Result<Vec<Bundle>> {
    let root = capture.root;
    let mut chain: Vec<Bundle> = before.map(|g| g.bundles.clone()).unwrap_or_default();
    // A commit an earlier bundle relied on that is gone (history rewritten and collected), or a
    // chain grown long: start again with one complete bundle.
    let known = |sha: &str| git(root, &["cat-file", "-e", &format!("{sha}^{{commit}}")]).is_ok();
    let intact = chain
        .iter()
        .flat_map(|b| b.tips.iter())
        .all(|t| known(t) || git(root, &["cat-file", "-e", t]).is_ok());
    // A share carries only what the commit checked out builds on: a bundle made while another
    // line of commits was checked out isn't part of that.
    let beside = scope.head_only
        && chain
            .iter()
            .flat_map(|b| b.tips.iter())
            .any(|tip| git(root, &["merge-base", "--is-ancestor", tip, "HEAD"]).is_err());
    if !intact || beside || chain.len() >= MAX_BUNDLE_CHAIN {
        chain.clear();
    }
    let range = bundle_range(root, &chain, scope);
    let tips = range.tips.clone();
    if chain.last().is_some_and(|b| b.tips == tips) {
        for b in &chain {
            capture.uploader.keep(&b.file);
        }
        return Ok(chain);
    }
    let revisions = range.args();
    // Asked first, in a way that doesn't depend on git's language: is there anything the
    // remotes and the earlier bundles lack?
    let mut probe: Vec<&str> = vec!["rev-list", "--max-count=1"];
    probe.extend(revisions.iter().map(String::as_str));
    if git(root, &probe).is_ok_and(|out| out.trim().is_empty()) {
        for b in &chain {
            capture.uploader.keep(&b.file);
        }
        return Ok(chain);
    }
    // A share: the commits about to travel are looked through first. A key file committed
    // and not pushed would go out inside them, whatever is left out of the files.
    if let (true, Some(leave)) = (scope.head_only, scope.leave_out) {
        let found = left_out_in_commits(root, &range, leave)?;
        if !found.is_empty() {
            return Err(key_files_in_history(&found));
        }
    }
    let file = scratch_file(data, "bundle")?;
    let mut args: Vec<String> = vec![
        "bundle".into(),
        "create".into(),
        file.to_string_lossy().to_string(),
    ];
    args.extend(revisions);
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
    /// Files that stay out of this snapshot whatever the ignore files say, each listed as
    /// skipped with the reason given (a share's key files). None: the vault's own snapshots.
    pub leave_out: Option<LeaveOut>,
    /// How the remote's address is written into the snapshot (a share takes a sign-in out of
    /// it; an address it can't show is left out). None: as git has it.
    pub remote_as: Option<fn(&str) -> Option<String>>,
    /// A share's capture: of the commits no remote has, only those the commit checked out
    /// builds on travel (no other branch, no tag, no stash); commits among them that add or
    /// change a file `leave_out` names refuse the capture (`ShareKeyFilesInHistory`); and a
    /// remote whose address isn't written into the snapshot counts as no remote, so the
    /// bundles carry the whole history the commit needs. False: the vault's own snapshots.
    pub head_only: bool,
}

/// What is staged, as a patch against the commit, without the files `leave_out` names: a key
/// file that was staged must not travel inside the patch either.
fn staged_patch(root: &Path, leave_out: Option<LeaveOut>) -> Result<String> {
    let mut args: Vec<String> = [
        "diff",
        "--cached",
        "--binary",
        "--full-index",
        "--no-renames",
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();
    if let Some(leave) = leave_out {
        let names = git(
            root,
            &["diff", "--cached", "--name-only", "-z", "--no-renames"],
        )?;
        let out: Vec<String> = names
            .split('\0')
            .filter(|p| !p.is_empty() && leave(&rel(p)).is_some())
            // From the top of the repository, taken as written (never as a pattern).
            .map(|p| format!(":(top,exclude,literal){p}"))
            .collect();
        if !out.is_empty() {
            args.push("--".into());
            args.push(":(top)".into());
            args.extend(out);
        }
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    git(root, &refs)
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
        leave_out: options.leave_out,
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
        let picked = remotes
            .iter()
            .find(|r| r.name == "origin")
            .or_else(|| remotes.first());
        // The address as the snapshot says it (a share shows only an ordinary one).
        let remote = match (picked, options.remote_as) {
            (Some(r), Some(shown)) => shown(&r.url),
            (Some(r), None) => Some(r.url.clone()),
            (None, _) => None,
        };
        let scope = Scope {
            head_only: options.head_only,
            not_remotes: remotes_left_out(
                picked.map(|r| r.name.as_str()),
                remote.is_some(),
                options.head_only,
                options.everything,
            ),
            leave_out: options.leave_out,
        };
        let before_git = options.before.and_then(|m| m.git.as_ref());
        let chain = if head.is_some() {
            bundles(&mut capture, data, before_git, &scope).await?
        } else {
            Vec::new()
        };
        let staged = match &head {
            Some(_) => {
                let patch = staged_patch(root, options.leave_out)?;
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
            // A share carries no stash (a stash may hold anything, key files included).
            stashes: if options.head_only {
                Vec::new()
            } else {
                stashes(root)
            },
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

fn beyond_a_snapshot(what: &str) -> Error {
    sync_error(format!(
        "That snapshot can't be read: {what} than a snapshot holds."
    ))
}

/// Whether a snapshot's list, as read, is one a capture could have written: no more files
/// than a snapshot holds, none larger than a file in one may be, and no content with more
/// chunks than its length allows. A list is only what whoever wrote it says (a share's is a
/// teammate's): nothing is fetched, compared or written from one that isn't.
fn within_limits(manifest: &Manifest) -> Result<()> {
    if manifest.files.len() > MAX_FILES || manifest.deleted.len() > MAX_FILES {
        return Err(beyond_a_snapshot("it names more files"));
    }
    // (One more than the files: the line that says how many were left out.)
    if manifest.skipped.len() > MAX_FILES + 1 {
        return Err(beyond_a_snapshot("it lists more left-out files"));
    }
    for file in &manifest.files {
        if file.s.size > MAX_FILE_BYTES {
            return Err(beyond_a_snapshot("it names a larger file"));
        }
        chunks::plausible(&file.s)?;
    }
    if let Some(state) = &manifest.git {
        if state.bundles.len() > MAX_BUNDLE_CHAIN + 1 {
            return Err(beyond_a_snapshot("it names more bundles of commits"));
        }
        for bundle in &state.bundles {
            chunks::plausible(&bundle.file)?;
        }
        if let Some(staged) = &state.staged {
            chunks::plausible(staged)?;
        }
    }
    Ok(())
}

/// The bytes a restore of this snapshot fetches and writes: its files, its bundles of
/// commits, its staged patch.
pub fn carried_bytes(manifest: &Manifest) -> u64 {
    let mut total: u64 = 0;
    for file in &manifest.files {
        total = total.saturating_add(file.s.size);
    }
    if let Some(state) = &manifest.git {
        for bundle in &state.bundles {
            total = total.saturating_add(bundle.file.size);
        }
        if let Some(staged) = &state.staged {
            total = total.saturating_add(staged.size);
        }
    }
    total
}

/// Refuses a snapshot that would bring more than `most` bytes (a copy of a shared one).
pub fn within_bytes(manifest: &Manifest, most: u64) -> Result<()> {
    if carried_bytes(manifest) > most {
        return Err(sync_error(format!(
            "That snapshot is larger than a copy may be ({} GB).",
            most / (1024 * 1024 * 1024)
        )));
    }
    Ok(())
}

pub async fn manifest(api: &Api, ring: &Keyring, summary: &Summary) -> Result<Manifest> {
    let bytes = chunks::read_within(api, ring, &summary.manifest, MAX_MANIFEST_BYTES).await?;
    let mut manifest: Manifest = serde_json::from_slice(&bytes)?;
    drop(bytes);
    // What a stored list never has: files beside its parts are not taken from it.
    if !manifest.shards.is_empty() {
        manifest.files.clear();
    }
    // The parts together are bounded as the list itself is, before any is fetched.
    let mut listed = summary.manifest.size;
    for shard in &manifest.shards {
        listed = listed.saturating_add(shard.size);
    }
    if manifest.shards.len() > MAX_SHARDS || listed > MAX_MANIFEST_BYTES {
        return Err(beyond_a_snapshot("its list of files is larger"));
    }
    // The files, from their parts, a few at once.
    let shards = manifest.shards.clone();
    let mut parts = futures_util::stream::iter(shards)
        .map(|shard| async move { chunks::read(api, ring, &shard).await })
        .buffered(WRITES_AT_ONCE);
    while let Some(part) = parts.next().await {
        let files: Vec<FileEntry> = serde_json::from_slice(&part?)?;
        manifest.files.extend(files);
        // Stopped as soon as there are too many, not after every part was read.
        if manifest.files.len() > MAX_FILES {
            return Err(beyond_a_snapshot("it names more files"));
        }
    }
    drop(parts);
    within_limits(&manifest)?;
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
fn standing(
    ring: &Keyring,
    project: &Project<'_>,
    entry: &FileEntry,
    piece: &mut Vec<u8>,
) -> Standing {
    // A path a snapshot may not name, or one that passes through a link (what is behind it
    // is somewhere else): not read.
    let Ok(target) = project.place(&entry.p) else {
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
    // (A folder that can't be resolved: nothing in it is compared.)
    let project = Project::new(root).ok();
    let files = entries
        .into_iter()
        .enumerate()
        .map(|(n, (path, entry))| {
            let (size, deleted) = match &entry {
                Entry::File(f) => (f.s.size, false),
                Entry::Deleted(_) => (0, true),
            };
            let state = match (&project, entry) {
                (Some(project), Entry::File(f)) if n < limit => {
                    standing(ring, project, f, &mut piece)
                }
                (Some(project), Entry::Deleted(p)) if n < limit => match project.place(p) {
                    Ok(target) if std::fs::symlink_metadata(&target).is_ok() => Standing::Differs,
                    Ok(_) => Standing::Same,
                    Err(_) => Standing::Unknown,
                },
                _ => Standing::Unknown,
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
    // The cap holds for what arrives, not for what the list says: reading stops with an
    // error the moment the file is longer than its entry (`chunks::read_into`).
    Ok(Some(as_text(
        chunks::read_within(api, ring, &entry.s, TEXT_MAX_BYTES).await?,
    )))
}

/// Writes the content `stored` names to `target`, a chunk at a time (a large file is never
/// in memory whole), through a file beside it that takes its place once it is complete.
async fn stream_to(api: &Api, ring: &Keyring, stored: &Stored, target: &Path) -> Result<()> {
    use std::io::Write;
    let dir = target
        .parent()
        .ok_or_else(|| sync_error("a snapshot names an empty path"))?;
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{name}.tmp-{}", super::crypto::new_id()?));
    let written: Result<()> = async {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        chunks::read_into(api, ring, stored, |piece| {
            file.write_all(piece)?;
            Ok(())
        })
        .await?;
        file.sync_all()?;
        // A file that is replaced keeps who may read and write it.
        if let Ok(meta) = std::fs::symlink_metadata(target) {
            if meta.is_file() {
                let _ = std::fs::set_permissions(&tmp, meta.permissions());
            }
        }
        drop(file);
        std::fs::rename(&tmp, target)?;
        Ok(())
    }
    .await;
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

async fn write_file(
    api: &Api,
    ring: &Keyring,
    project: &Project<'_>,
    entry: &FileEntry,
) -> Result<()> {
    // Checked again here, whoever read the list: nothing is fetched for an entry a capture
    // couldn't have written.
    if entry.s.size > MAX_FILE_BYTES {
        return Err(beyond_a_snapshot("it names a larger file"));
    }
    // No link on the way, before a folder is made or anything is written (`Project::place`).
    let target = project.place(&entry.p)?;
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Looked at again now that the folders are there, and never through a link at the file
    // itself: the link goes, the file takes its place.
    let target = project.place_for_writing(&entry.p)?;
    stream_to(api, ring, &entry.s, &target).await?;
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
        return write_file(api, ring, &Project::new(root)?, entry).await;
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
    /// The snapshot's remote may be asked (fetched from, and added to a repository made
    /// here): true for the account's own snapshots, whose remote is the person's own. False
    /// for a copy of a teammate's share: the address is one someone else chose, so nothing
    /// here reaches out to it (the copy's caller clones first, when the person agreed).
    pub network: bool,
}

/// Whether a commit named in a snapshot is a commit's id and nothing else (it becomes an
/// argument of git).
fn commit_id(text: &str) -> bool {
    (40..=64).contains(&text.len()) && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// Whether a branch named in a snapshot can be a branch's name (it becomes an argument of
/// git): never something git would read as an option or a revision expression.
fn branch_name(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 1024
        && !text.starts_with('-')
        && !text.contains("..")
        && !text.contains("@{")
        && !text
            .chars()
            .any(|c| c.is_control() || matches!(c, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
}

/// Takes a bundle's commits into the repository: its objects, then its refs under a
/// namespace of their own (nothing of this computer's refs is moved by it).
fn take_bundle(root: &Path, file: &Path) -> Result<()> {
    let file = file.to_string_lossy();
    // The objects first, whatever the bundle's refs are called: a bundle made for a share
    // names only `HEAD`, which the fetch below (of `refs/*`) wouldn't ask for.
    git(root, &["bundle", "unbundle", &file])?;
    git(
        root,
        &["fetch", "-q", "--no-tags", &file, "+refs/*:refs/synced/*"],
    )?;
    Ok(())
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
    // Before anything is changed: every path the snapshot names is one it may name, and what
    // it says of git are a commit's id and a branch's name.
    within_limits(manifest)?;
    for path in manifest
        .files
        .iter()
        .map(|f| &f.p)
        .chain(manifest.deleted.iter())
    {
        safe_join(root, path)?;
    }
    if let Some(state) = &manifest.git {
        if state.head.as_deref().is_some_and(|head| !commit_id(head))
            || state.branch.as_deref().is_some_and(|b| !branch_name(b))
        {
            return Err(sync_error(
                "That snapshot names a commit or a branch that isn't one.",
            ));
        }
    }
    if let Some(state) = &manifest.git {
        if !is_git(root) {
            // The project isn't here yet: an empty repository that the bundles and the remote fill.
            if std::fs::read_dir(root)?.next().is_some() {
                return Err(sync_error(
                    "This folder has files but isn't the git project the snapshot is from.",
                ));
            }
            git(root, &["init", "-q"])?;
            let remote = state.remote.as_deref().filter(|u| safe_remote(u));
            if let Some(url) = remote.filter(|_| options.network) {
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
        if options.network && (!state.bundles.is_empty() || state.head.is_some()) {
            let _ = git(root, &["fetch", "-q", "origin"]);
        }
        for (n, bundle) in state.bundles.iter().enumerate() {
            let file = scratch_file(data, &format!("restore-{n}"))?;
            // Straight to the file, a chunk at a time: a bundle can be a whole history.
            let taken = match stream_to(api, ring, &bundle.file, &file).await {
                Ok(()) => take_bundle(root, &file),
                Err(e) => Err(e),
            };
            let _ = std::fs::remove_file(&file);
            taken?;
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
            if !present(root) && state.remote.is_some() && options.network {
                // The commit is on the remote: this needs the network and the user's git access.
                let _ = git(root, &["fetch", "-q", "origin"]);
            }
            if !present(root) {
                return Err(sync_error(if options.network {
                    "The snapshot's commit isn't here and couldn't be fetched from the remote. Fetch it, then try again."
                } else {
                    "The snapshot builds on commits that are only on the project's remote, and the folder wasn't cloned from it."
                }));
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
        let project = Project::new(root)?;
        for entry in &manifest.files {
            // Never read through a link, on the way or at the file itself: what is behind
            // one isn't this folder's file (a link at the file itself is replaced below).
            let target = project.place(&entry.p)?;
            if !std::fs::symlink_metadata(&target).is_ok_and(|meta| meta.is_file()) {
                continue;
            }
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
                std::fs::copy(project.place(path)?, &target)?;
            }
            done.notes.push(format!(
                "{} file(s) of this folder were replaced; their earlier versions are in {}.",
                differing.len(),
                keep.display()
            ));
        }
    }
    // A few files at once; the first failure stops the rest.
    // (Resolved now: a git checkout above may have put the folder's parts where they are.)
    let project = Project::new(root)?;
    let project = &project;
    let mut writes = futures_util::stream::iter(manifest.files.clone())
        .map(|entry| async move { write_file(api, ring, project, &entry).await })
        .buffer_unordered(WRITES_AT_ONCE);
    while let Some(written) = writes.next().await {
        written?;
        done.files += 1;
    }
    drop(writes);
    for path in &manifest.deleted {
        // Never through a link: a deletion would otherwise reach a file outside the folder.
        // (A link at the place itself is removed as the link it is.)
        let target = project.place(path)?;
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

    /// A link at `link` to the folder `to`: a symbolic link, or on Windows a junction (which
    /// needs no privilege). False when none could be made.
    fn link_dir(to: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(to, link).is_ok()
        }
        #[cfg(windows)]
        {
            std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(to)
                .output()
                .is_ok_and(|out| out.status.success())
        }
    }

    #[test]
    fn a_resolved_path_must_stay_under_names_a_snapshot_may_name() {
        let root = Path::new("/home/me/project");
        assert!(names_inside(root, root));
        assert!(names_inside(root, &root.join("src").join("deep")));
        // Resolved into the repository's own folder, under any spelling of its name.
        assert!(!names_inside(root, &root.join(".git")));
        assert!(!names_inside(root, &root.join(".git").join("hooks")));
        assert!(!names_inside(root, &root.join(".GIT")));
        assert!(!names_inside(root, &root.join("sub").join("GIT~1")));
        assert!(!names_inside(root, &root.join("sub").join(".git")));
        // Resolved out of the folder.
        assert!(!names_inside(root, Path::new("/home/me")));
        assert!(!names_inside(root, Path::new("/home/me/other")));
        assert!(!names_inside(root, Path::new("/home/me/project2/src")));
        assert!(!names_inside(root, Path::new("/etc")));
    }

    #[test]
    fn a_restore_never_passes_through_a_link_in_the_folder() {
        let dir = std::env::temp_dir().join(format!("sync-links-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let root = dir.join("project");
        let outside = dir.join("outside");
        for folder in [root.join(".git"), root.join("src"), outside.clone()] {
            std::fs::create_dir_all(folder).unwrap();
        }
        std::fs::write(root.join(".git").join("config"), "ORIGINAL").unwrap();
        std::fs::write(root.join("src").join("a.txt"), "a").unwrap();
        std::fs::write(outside.join("victim.txt"), "mine").unwrap();
        // What a snapshot's own commit can check out: a link to the repository's folder, and
        // one to somewhere else on the computer.
        if !link_dir(&root.join(".git"), &root.join("x")) || !link_dir(&outside, &root.join("y")) {
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        let project = Project::new(&root).unwrap();
        // Writing `x/config` would replace `.git/config`; `y/…` is outside the folder.
        for through in [
            "x/config",
            "x/hooks/post-checkout",
            "y/victim.txt",
            "y/new/deep.txt",
            "y/sub/../victim.txt",
        ] {
            assert!(project.place(through).is_err(), "{through}");
            assert!(project.place_for_writing(through).is_err(), "{through}");
        }
        assert_eq!(text(&root, ".git/config"), "ORIGINAL");
        assert_eq!(text(&outside, "victim.txt"), "mine");
        // The folder's own places, there or not yet.
        for inside in ["src/a.txt", "src/new/b.txt", "new.txt", "new/deep/c.txt"] {
            assert!(project.place(inside).is_ok(), "{inside}");
        }
        // The link checks are of what is on the way: a capture doesn't read through one.
        assert!(passes_a_link(&root, "y/victim.txt"));
        assert!(passes_a_link(&root, "x/config"));
        assert!(!passes_a_link(&root, "src/a.txt"));
        assert!(
            !passes_a_link(&root, "y"),
            "the link itself is named, as a link"
        );
        let listed = folder_files(&root);
        assert!(
            !listed
                .iter()
                .any(|f| f.starts_with("y/") || f.starts_with("x/")),
            "{listed:?}"
        );
        // Comparing reads nothing through a link either, and says nothing of what is there.
        let ring = Keyring::generate().unwrap();
        let manifest = Manifest {
            v: 1,
            files: vec![entry(&ring, "y/victim.txt", b"mine")],
            deleted: vec!["y/victim.txt".into(), "x/config".into()],
            ..Default::default()
        };
        let compared = compare(&ring, &root, &manifest, COMPARE_MAX);
        assert!(compared.files.iter().all(|f| f.state == Standing::Unknown));
        // A link at the place itself is replaced as the link it is: what it points at stays.
        let at = project.place_for_writing("y").unwrap();
        assert_eq!(at, root.join("y"));
        assert!(std::fs::symlink_metadata(root.join("y")).is_err());
        assert_eq!(text(&outside, "victim.txt"), "mine");
        let at = project.place_for_writing("x").unwrap();
        assert!(std::fs::symlink_metadata(&at).is_err());
        assert_eq!(text(&root, ".git/config"), "ORIGINAL");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_a_file_is_never_read_into_a_snapshot_or_followed_by_a_restore() {
        let dir = std::env::temp_dir().join(format!("sync-filelink-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let root = dir.join("project");
        let outside = dir.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "outside").unwrap();
        std::fs::write(root.join("own.txt"), "own").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("dir")).unwrap();
        // A folder without git: a link is not among its files, nor what is behind one.
        assert_eq!(folder_files(&root), ["own.txt"]);
        // A git project: git names the link itself; the capture looks at it without
        // following it (`Capture::file` skips it as "a link").
        assert!(is_link(
            &std::fs::symlink_metadata(root.join("link.txt")).unwrap()
        ));
        assert!(passes_a_link(&root, "dir/secret.txt"));
        // A restore that writes or deletes `link.txt` replaces the link, not the file behind.
        let project = Project::new(&root).unwrap();
        let at = project.place_for_writing("link.txt").unwrap();
        std::fs::write(&at, "restored").unwrap();
        assert_eq!(text(&outside, "secret.txt"), "outside");
        assert_eq!(text(&root, "link.txt"), "restored");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_list_beyond_what_a_snapshot_holds_is_refused() {
        let ring = Keyring::generate().unwrap();
        let fine = Manifest {
            v: 1,
            files: vec![entry(&ring, "a.txt", b"a"), entry(&ring, "b.txt", b"")],
            ..Default::default()
        };
        assert!(within_limits(&fine).is_ok());
        let id = ring.chunk_id(b"x").unwrap();
        let lying = |size: u64, chunks: usize| FileEntry {
            p: "big.bin".into(),
            s: Stored {
                chunks: vec![id.clone(); chunks],
                size,
            },
            x: false,
            t: 0,
        };
        let with = |file: FileEntry| Manifest {
            v: 1,
            files: vec![file],
            ..Default::default()
        };
        // A file larger than a capture would have taken (a length nobody could hold).
        assert!(within_limits(&with(lying(MAX_FILE_BYTES + 1, 26))).is_err());
        assert!(within_limits(&with(lying(u64::MAX, 1))).is_err());
        assert!(within_limits(&with(lying(MAX_FILE_BYTES, 25))).is_ok());
        // One chunk named a hundred thousand times under a small length.
        assert!(within_limits(&with(lying(10, 100_000))).is_err());
        // More files, deletions or bundles than a snapshot holds.
        let mut many = fine.clone();
        many.files = vec![entry(&ring, "a.txt", b"a"); MAX_FILES + 1];
        assert!(within_limits(&many).is_err());
        let mut many = fine.clone();
        many.deleted = vec!["gone.txt".to_string(); MAX_FILES + 1];
        assert!(within_limits(&many).is_err());
        let mut many = fine.clone();
        many.git = Some(GitState {
            bundles: vec![Bundle::default(); MAX_BUNDLE_CHAIN + 2],
            ..Default::default()
        });
        assert!(within_limits(&many).is_err());
        // A bundle or a staged patch that is a chunk bomb.
        let mut bomb = fine.clone();
        bomb.git = Some(GitState {
            bundles: vec![Bundle {
                file: lying(10, 5_000).s,
                tips: Vec::new(),
            }],
            ..Default::default()
        });
        assert!(within_limits(&bomb).is_err());
        // What a copy brings is counted before anything is fetched: files, bundles, the patch.
        let mut heavy = with(lying(MAX_FILE_BYTES, 25));
        heavy.files.push(lying(MAX_FILE_BYTES, 25));
        heavy.git = Some(GitState {
            bundles: vec![Bundle {
                file: lying(1_000, 1).s,
                tips: Vec::new(),
            }],
            staged: Some(lying(24, 1).s),
            ..Default::default()
        });
        assert_eq!(carried_bytes(&heavy), 2 * MAX_FILE_BYTES + 1_024);
        assert!(within_bytes(&heavy, 2 * MAX_FILE_BYTES + 1_024).is_ok());
        assert!(within_bytes(&heavy, 2 * MAX_FILE_BYTES).is_err());
        assert!(within_bytes(&fine, MAX_COPY_BYTES).is_ok());
        // Lengths that would overflow a sum are still more than a copy may bring.
        let mut endless = fine.clone();
        endless.git = Some(GitState {
            bundles: vec![
                Bundle {
                    file: lying(u64::MAX, 1).s,
                    tips: Vec::new(),
                };
                2
            ],
            ..Default::default()
        });
        assert!(within_bytes(&endless, MAX_COPY_BYTES).is_err());
    }

    #[test]
    fn what_a_snapshot_says_of_git_is_a_commit_and_a_branch_or_refused() {
        assert!(commit_id(&"a1".repeat(20)));
        assert!(commit_id(&"0f".repeat(32)));
        for bad in [
            "",
            "HEAD",
            "--upload-pack=x",
            "abc123",
            "refs/heads/main",
            &"g".repeat(40)[..],
            &"a".repeat(65)[..],
        ] {
            assert!(!commit_id(bad), "{bad}");
        }
        for ok in ["main", "feature/x-1", "release_2.0", "ünïcode"] {
            assert!(branch_name(ok), "{ok}");
        }
        for bad in [
            "", "-b", "--detach", "a..b", "a b", "x@{1}", "a~1", "a^", "a:b", "a\nb", "a*",
        ] {
            assert!(!branch_name(bad), "{bad}");
        }
    }

    fn commit(dir: &Path, files: &[(&str, &str)], message: &str) -> String {
        for (file, text) in files {
            let path = dir.join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        git(dir, &["add", "-A"]).unwrap();
        git(dir, &["commit", "-q", "-m", message]).unwrap();
        sha(dir, "HEAD")
    }

    fn sha(dir: &Path, rev: &str) -> String {
        git(dir, &["rev-parse", rev]).unwrap().trim().to_string()
    }

    /// Says that `origin` (at `url`) has everything up to the commit checked out now.
    fn pushed(dir: &Path, url: &str) {
        let branch = git(dir, &["symbolic-ref", "--short", "HEAD"]).unwrap();
        git(dir, &["remote", "add", "origin", url]).unwrap();
        git(
            dir,
            &[
                "update-ref",
                &format!("refs/remotes/origin/{}", branch.trim()),
                "HEAD",
            ],
        )
        .unwrap();
    }

    fn revisions(dir: &Path, range: &BundleRange) -> Vec<String> {
        let mut args = vec!["rev-list".to_string()];
        args.extend(range.args());
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        git(dir, &refs)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn has_commit(dir: &Path, commit: &str) -> bool {
        git(dir, &["cat-file", "-e", &format!("{commit}^{{commit}}")]).is_ok()
    }

    fn share_scope(named: bool) -> Scope {
        Scope {
            head_only: true,
            not_remotes: remotes_left_out(Some("origin"), named, true, false),
            leave_out: Some(crate::sync::share::plan::key_file),
        }
    }

    #[test]
    fn a_shares_bundle_carries_only_what_the_commit_checked_out_needs() {
        let dir = repo("share-head", &[("a.txt", "a")]);
        let base = sha(&dir, "HEAD");
        pushed(&dir, "https://example.com/owner/repo.git");
        let main = git(&dir, &["symbolic-ref", "--short", "HEAD"]).unwrap();
        let main = main.trim();
        let head = commit(&dir, &[("notes.txt", "notes")], "not pushed");
        // Another branch with a key file committed and not pushed, and a stash with one.
        git(&dir, &["checkout", "-q", "-b", "side"]).unwrap();
        let side = commit(&dir, &[(".env", "TOKEN=hunter2")], "a key on a branch");
        git(&dir, &["checkout", "-q", main]).unwrap();
        std::fs::write(dir.join("a.txt"), "work").unwrap();
        std::fs::write(dir.join(".env.local"), "TOKEN=stashed").unwrap();
        git(&dir, &["stash", "push", "-u", "-q"]).unwrap();
        let stash = sha(&dir, "refs/stash");

        // The vault's own snapshot carries all of it, as before.
        let vault = Scope {
            head_only: false,
            not_remotes: remotes_left_out(Some("origin"), true, false, false),
            leave_out: None,
        };
        let all = revisions(&dir, &bundle_range(&dir, &[], &vault));
        assert!(all.contains(&head) && all.contains(&side) && all.contains(&stash));

        // A share: the commit checked out, down to what the remote has. Nothing else.
        let range = bundle_range(&dir, &[], &share_scope(true));
        assert_eq!(range.tips, std::slice::from_ref(&head));
        assert_eq!(range.args(), ["HEAD", "--not", "--remotes=origin"]);
        assert_eq!(revisions(&dir, &range), std::slice::from_ref(&head));
        // None of those commits holds a key file (the ones on the branch and in the stash
        // don't travel, so they don't count).
        let leave = crate::sync::share::plan::key_file;
        assert!(left_out_in_commits(&dir, &range, leave).unwrap().is_empty());

        // The bundle as it is made, taken into a copy that has what the remote has.
        let file = dir.with_extension("bundle");
        let mut args = vec![
            "bundle".to_string(),
            "create".into(),
            file.to_string_lossy().to_string(),
        ];
        args.extend(range.args());
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        git(&dir, &refs).unwrap();
        let copy = dir.with_extension("copy");
        let _ = std::fs::remove_dir_all(&copy);
        std::fs::create_dir_all(&copy).unwrap();
        git(&copy, &["init", "-q"]).unwrap();
        let from = dir.to_string_lossy().to_string();
        let tracking = format!("refs/remotes/origin/{main}:refs/heads/base");
        git(&copy, &["fetch", "-q", &from, &tracking]).unwrap();
        assert!(has_commit(&copy, &base) && !has_commit(&copy, &head));
        take_bundle(&copy, &file).unwrap();
        assert!(has_commit(&copy, &head), "the commit checked out arrived");
        assert!(!has_commit(&copy, &side), "the other branch stayed");
        assert!(!has_commit(&copy, &stash), "the stash stayed");
        git(&copy, &["checkout", "-q", "--detach", &head]).unwrap();
        assert_eq!(text(&copy, "notes.txt"), "notes");
        assert!(!copy.join(".env").exists() && !copy.join(".env.local").exists());

        // The next snapshot leaves out what that bundle carried.
        let chain = [Bundle {
            file: Stored::default(),
            tips: range.tips.clone(),
        }];
        let next = commit(&dir, &[("more.txt", "more")], "later");
        let range = bundle_range(&dir, &chain, &share_scope(true));
        assert_eq!(revisions(&dir, &range), [next]);
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir_all(&copy);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn key_files_in_commits_that_would_travel_refuse_a_shares_capture() {
        let dir = repo(
            "share-keys",
            &[("a.txt", "a"), ("old.key", "pushed long ago")],
        );
        pushed(&dir, "https://example.com/owner/repo.git");
        let leave = crate::sync::share::plan::key_file;
        // Deleting a key file the remote already has carries nothing of it.
        std::fs::remove_file(dir.join("old.key")).unwrap();
        commit(&dir, &[("b.txt", "b")], "tidy");
        let range = bundle_range(&dir, &[], &share_scope(true));
        assert!(left_out_in_commits(&dir, &range, leave).unwrap().is_empty());
        // Committed and not pushed: in the bundle, whatever is left out of the files. Even
        // when a later commit removed it again.
        commit(
            &dir,
            &[(".env", "TOKEN=hunter2"), ("conf/server.pem", "KEY")],
            "oops",
        );
        std::fs::remove_file(dir.join(".env")).unwrap();
        commit(&dir, &[("c.txt", "c")], "removed again");
        let range = bundle_range(&dir, &[], &share_scope(true));
        let found = left_out_in_commits(&dir, &range, leave).unwrap();
        assert_eq!(found, [".env", "conf/server.pem"]);
        match key_files_in_history(&found) {
            Error::Sync("ShareKeyFilesInHistory", text) => {
                assert!(
                    text.contains(".env, conf/server.pem") && text.contains("Push or remove"),
                    "{text}"
                );
            }
            other => panic!("unexpected: {other:?}"),
        }
        // Many of them: the first ten are named, the rest counted.
        let many: Vec<String> = (0..13).map(|n| format!("k{n:02}.pem")).collect();
        assert!(matches!(
            key_files_in_history(&many),
            Error::Sync("ShareKeyFilesInHistory", text)
                if text.contains("k09.pem and 3 more") && !text.contains("k10.pem")
        ));
        // Once they are pushed (the remote has those commits) nothing of them travels.
        let branch = git(&dir, &["symbolic-ref", "--short", "HEAD"]).unwrap();
        git(
            &dir,
            &[
                "update-ref",
                &format!("refs/remotes/origin/{}", branch.trim()),
                "HEAD",
            ],
        )
        .unwrap();
        let range = bundle_range(&dir, &[], &share_scope(true));
        assert!(revisions(&dir, &range).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_share_that_doesnt_name_its_remote_carries_the_whole_history() {
        // Which remotes count as having commits.
        let left_out = remotes_left_out;
        assert_eq!(
            left_out(Some("origin"), true, false, false).as_deref(),
            Some("--remotes"),
            "the vault's own: any remote's"
        );
        assert_eq!(
            left_out(Some("origin"), true, true, false).as_deref(),
            Some("--remotes=origin"),
            "a share: the one remote its reader clones from"
        );
        assert_eq!(left_out(Some("origin"), false, true, false), None);
        assert_eq!(left_out(Some("origin"), true, false, true), None);
        assert_eq!(left_out(None, false, false, false), None);
        assert_eq!(left_out(Some("we*ird"), true, true, false), None);

        // A project whose origin is a folder on this computer: the share doesn't say where
        // (`plan::public_remote` drops it), so a reader can't get anything from it.
        let dir = repo("share-local", &[("a.txt", "a")]);
        let first = sha(&dir, "HEAD");
        let head = commit(&dir, &[("b.txt", "b")], "second");
        pushed(&dir, "/srv/git/thing.git");
        assert_eq!(
            crate::sync::share::plan::public_remote("/srv/git/thing.git"),
            None
        );
        // Counted as a remote (as before), nothing would travel, and a copy has no commits.
        let as_before = Scope {
            head_only: true,
            not_remotes: Some("--remotes".into()),
            leave_out: None,
        };
        assert!(revisions(&dir, &bundle_range(&dir, &[], &as_before)).is_empty());
        // Counted as none: the whole history the commit needs is in the bundle.
        let range = bundle_range(&dir, &[], &share_scope(false));
        assert_eq!(range.args(), ["HEAD"]);
        assert_eq!(revisions(&dir, &range), [head.clone(), first.clone()]);
        let file = dir.with_extension("bundle");
        git(&dir, &["bundle", "create", &file.to_string_lossy(), "HEAD"]).unwrap();
        // A copy with nothing in it gets every commit from the bundle alone.
        let copy = dir.with_extension("copy");
        let _ = std::fs::remove_dir_all(&copy);
        std::fs::create_dir_all(&copy).unwrap();
        git(&copy, &["init", "-q"]).unwrap();
        take_bundle(&copy, &file).unwrap();
        assert!(has_commit(&copy, &head) && has_commit(&copy, &first));
        git(&copy, &["checkout", "-q", "--detach", &head]).unwrap();
        assert_eq!(text(&copy, "b.txt"), "b");
        // Still looked through for key files: the whole history travels.
        commit(&dir, &[("id_rsa", "KEY")], "a key");
        let range = bundle_range(&dir, &[], &share_scope(false));
        let leave = crate::sync::share::plan::key_file;
        assert_eq!(
            left_out_in_commits(&dir, &range, leave).unwrap(),
            ["id_rsa"]
        );
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir_all(&copy);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_staged_file_that_stays_out_is_not_in_the_staged_patch() {
        let dir = repo("staged-left-out", &[("a.txt", "a\n")]);
        std::fs::write(dir.join("a.txt"), "a\nstaged\n").unwrap();
        std::fs::write(dir.join(".env"), "TOKEN=hunter2\n").unwrap();
        std::fs::create_dir_all(dir.join("conf")).unwrap();
        std::fs::write(dir.join("conf").join("server.pem"), "PRIVATE-KEY-BYTES\n").unwrap();
        git(&dir, &["add", "-A"]).unwrap();
        // The vault's own snapshot: everything staged, as before.
        let whole = staged_patch(&dir, None).unwrap();
        assert!(whole.contains("hunter2") && whole.contains("PRIVATE-KEY-BYTES"));
        fn leave(path: &str) -> Option<&'static str> {
            (path == ".env" || path.ends_with(".pem")).then_some("a key file")
        }
        let patch = staged_patch(&dir, Some(leave)).unwrap();
        assert!(patch.contains("+staged"), "{patch}");
        assert!(!patch.contains("hunter2"), "{patch}");
        assert!(!patch.contains("PRIVATE-KEY-BYTES"), "{patch}");
        assert!(!patch.contains(".env") && !patch.contains("server.pem"));
        // Nothing staged that stays out: the same patch as without the rule.
        git(&dir, &["reset", "-q", "--", ".env", "conf/server.pem"]).unwrap();
        assert_eq!(
            staged_patch(&dir, Some(leave)).unwrap(),
            staged_patch(&dir, None).unwrap()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
