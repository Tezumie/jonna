//! Looking inside a snapshot without restoring it: its files against the folder, a chunk at
//! a time, and one file as text.

use std::path::Path;

use serde::Serialize;

use super::manifest::{FileEntry, Manifest};
use super::paths::Project;
use crate::error::Result;
use crate::sync::api::Api;
use crate::sync::chunks::{self, Stored};
use crate::sync::crypto::Keyring;

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
pub(super) fn same_content(
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

pub(super) fn too_large(size: u64) -> FileText {
    FileText {
        text: None,
        size,
        reason: Some("large"),
    }
}

/// A file's bytes as text: refused when they aren't UTF-8 or hold a NUL (as git tells binary).
pub(super) fn as_text(bytes: Vec<u8>) -> FileText {
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
