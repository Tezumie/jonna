//! Restoring a snapshot: the whole folder (`restore`) or one file (`restore_file`), what
//! stands in the way (`local_changes`), and where the folder's own changes are set aside.

use std::path::{Path, PathBuf};

use futures_util::StreamExt;
use serde::Serialize;

use super::capture::git_changes;
use super::compare::same_content;
use super::git::{git, is_git, safe_remote, scratch_file, stash_paths, stashes, take_bundle};
use super::manifest::{
    beyond_a_snapshot, within_limits, FileEntry, Manifest, MAX_FILE_BYTES, WRITES_AT_ONCE,
};
use super::paths::{not_a_repository_of_its_own, safe_join, sync_error, Project};
use crate::error::{Error, Result};
use crate::sync::api::Api;
use crate::sync::chunks::{self, Stored};
use crate::sync::crypto::Keyring;

/// What a restore set aside of the folder's own before it changed anything: said with any
/// error that comes after, so the work never just looks gone.
pub(super) enum Aside {
    /// A git stash: its message and its commit.
    Stash { name: String, commit: String },
    /// A folder the replaced files were copied to.
    Folder(PathBuf),
}

impl Aside {
    pub(super) fn describe(&self, root: &Path) -> String {
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
pub(super) fn with_aside(error: Error, note: &str) -> Error {
    match error {
        Error::Sync(code, text) => Error::Sync(code, format!("{text} {note}")),
        Error::Git(text) => Error::Git(format!("{text}\n{note}")),
        Error::GitSettingsChanged(text) => Error::GitSettingsChanged(format!("{text}\n{note}")),
        other => Error::Sync("Sync", format!("{other}. {note}")),
    }
}

/// A new folder `parent/name`, or `parent/name-1`, `-2`… when that one is taken: never one
/// something else already uses.
pub(super) fn fresh_dir(parent: &Path, name: &str) -> Result<PathBuf> {
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
    let tmp = dir.join(format!(".{name}.tmp-{}", crate::sync::crypto::new_id()?));
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
        not_a_repository_of_its_own(root, [path])?;
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
pub(super) fn commit_id(text: &str) -> bool {
    (40..=64).contains(&text.len()) && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// Whether a branch named in a snapshot can be a branch's name (it becomes an argument of
/// git): never something git would read as an option or a revision expression.
pub(super) fn branch_name(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 1024
        && !text.starts_with('-')
        && !text.contains("..")
        && !text.contains("@{")
        && !text
            .chars()
            .any(|c| c.is_control() || matches!(c, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
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
    not_a_repository_of_its_own(root, manifest.files.iter().map(|f| f.p.as_str()))?;
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
