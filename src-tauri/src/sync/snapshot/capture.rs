//! Capturing a folder: what is in it (git's changes or a walk, minus what the ignore files
//! say), its fingerprint, `create` and `estimate`.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use super::git::{bundles, git, is_git, remotes_left_out, staged_patch, stashes, Scope};
use super::manifest::{
    label, store_manifest, FileEntry, GitState, Manifest, Summary, MAX_FILES, MAX_FILE_BYTES,
};
use super::paths::{is_link, passes_a_link, rel, sync_error, RepositoryParts};
use crate::error::{Error, Result};
use crate::sync::api::Api;
use crate::sync::chunks::Uploader;
use crate::sync::crypto::Keyring;
use crate::sync::records::{self, Put};

/// What a project lists to keep out of its snapshots, in `.gitignore` syntax.
const IGNORE_FILE: &str = ".syncignore";
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub id: String,
    pub summary: Summary,
    pub uploaded_bytes: u64,
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

// ---------------------------------------------------------------- what is in the folder

/// What differs from the commit in a git project: (path, exists).
pub(super) fn git_changes(root: &Path) -> Result<Vec<(String, bool)>> {
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
pub(super) fn folder_files(root: &Path) -> Vec<String> {
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
    Ok(crate::sync::crypto::b64(&hash.finalize()[..16]))
}

// ---------------------------------------------------------------- capture

pub(super) struct Capture<'a> {
    pub(super) root: &'a Path,
    /// The last snapshot's files, to skip reading what didn't change.
    before: HashMap<&'a str, &'a FileEntry>,
    pub(super) uploader: Uploader<'a>,
    manifest: Manifest,
    /// Files that stay out whatever the ignore files say (`CreateOptions::leave_out`).
    leave_out: Option<LeaveOut>,
    /// The files to capture have a repository's own at the top (`RepositoryParts`): those
    /// stay out.
    own_repository: bool,
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
        // A repository's own files at the top of the folder don't travel (a restore
        // would refuse the whole snapshot for them).
        if self.own_repository && RepositoryParts::of(path).any() {
            self.manifest
                .skipped
                .push((path.to_string(), "a git repository's own file".into()));
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
        own_repository: false,
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
        capture.own_repository = RepositoryParts::named(
            changes
                .iter()
                .take(MAX_FILES)
                .filter(|(_, exists)| *exists)
                .map(|(path, _)| path.as_str()),
        )
        .is_repository();
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
        let files = folder_files(root);
        capture.own_repository =
            RepositoryParts::named(files.iter().map(String::as_str)).is_repository();
        for path in files {
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
