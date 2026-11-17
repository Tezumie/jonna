//! A snapshot's manifest and record: their types, the limits a list is read within, the
//! parts it is stored in, and reading, listing, pinning and rewriting one.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use super::paths::sync_error;
use crate::error::{Error, Result};
use crate::sync::api::Api;
use crate::sync::chunks::{self, Stored, Uploader};
use crate::sync::crypto::Keyring;
use crate::sync::records::{self, Put};

/// Files larger than this are left out (and listed as left out).
pub(super) const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
pub(super) const MAX_FILES: usize = 200_000;
/// About this many files to a part of the stored list.
const SHARD_FILES: usize = 400;
/// Files written at once on a restore.
pub(super) const WRITES_AT_ONCE: usize = 4;
/// After this many bundles a fresh, complete one is made.
pub(super) const MAX_BUNDLE_CHAIN: usize = 24;
/// A snapshot's list of files (its index and every part) is at most this large when read.
const MAX_MANIFEST_BYTES: u64 = 256 * 1024 * 1024;
/// The list is stored in at most this many parts (`shard_count`).
const MAX_SHARDS: usize = 1024;
/// Everything a copy of a shared snapshot brings (its files, its bundles, its staged patch)
/// is at most this much.
pub const MAX_COPY_BYTES: u64 = 20 * 1024 * 1024 * 1024;

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
pub(super) fn shard_of(path: &str, parts: usize) -> usize {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in path.as_bytes() {
        hash = (hash ^ u32::from(*byte)).wrapping_mul(0x0100_0193);
    }
    hash as usize % parts.max(1)
}

/// How many parts a list of `files` files is stored in: a power of two, so it changes
/// rarely as a project grows.
pub(super) fn shard_count(files: usize) -> usize {
    (files / SHARD_FILES).max(1).next_power_of_two().min(1024)
}

/// Stores a manifest: its files in parts (each sorted, so the same files give the same
/// bytes), then the rest with where the parts are.
pub(super) async fn store_manifest(
    uploader: &mut Uploader<'_>,
    manifest: &Manifest,
) -> Result<Stored> {
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

pub(super) fn beyond_a_snapshot(what: &str) -> Error {
    sync_error(format!(
        "That snapshot can't be read: {what} than a snapshot holds."
    ))
}

/// Whether a snapshot's list, as read, is one a capture could have written: no more files
/// than a snapshot holds, none larger than a file in one may be, and no content with more
/// chunks than its length allows. A list is only what whoever wrote it says (a share's is a
/// teammate's): nothing is fetched, compared or written from one that isn't.
pub(super) fn within_limits(manifest: &Manifest) -> Result<()> {
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
pub(super) fn label(summary: &Summary) -> serde_json::Value {
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
