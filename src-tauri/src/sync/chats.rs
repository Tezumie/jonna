//! A chat as it syncs: its file and its images stored as chunks, named by one record that
//! also carries the chat's summary (title, when, which project), so another computer can list
//! it without fetching it.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::api::Api;
use super::chunks::{self, Stored, Uploader};
use super::crypto::Keyring;
use super::records::{self, Put};
use crate::agent;
use crate::error::{Error, Result};
use crate::store::atomic_write;

/// What a chat's record holds.
#[derive(Debug, Serialize, Deserialize)]
struct Entry {
    /// The chat file's `meta`, as it was when pushed.
    meta: Value,
    file: Stored,
    /// Image id to its content.
    #[serde(default)]
    media: BTreeMap<String, Stored>,
}

fn media_dir(data: &Path, chat: &str) -> std::path::PathBuf {
    data.join("agent").join("media").join(chat)
}

fn image_ids(data: &Path, chat: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(media_dir(data, chat)) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter_map(|e| Some(e.file_name().to_str()?.strip_suffix(".bin")?.to_string()))
        .collect();
    ids.sort();
    ids
}

/// Uploads the chat `id` as the record `collection`/`id`, over the version `expect`.
/// None when the chat has no file.
pub async fn push(
    api: &Api,
    ring: &Keyring,
    data: &Path,
    collection: &str,
    id: &str,
    expect: Option<u64>,
) -> Result<Option<Put>> {
    let Some(text) = agent::load_session(data, id)? else {
        return Ok(None);
    };
    let meta = serde_json::from_str::<Value>(&text)?
        .get("meta")
        .cloned()
        .unwrap_or(Value::Null);
    // Twice at most: a sweep of unneeded chunks in between means checking them again.
    for _ in 0..3 {
        let mut uploader = Uploader::new(api, ring);
        let file = uploader.add(text.as_bytes()).await?;
        let mut media = BTreeMap::new();
        for image in image_ids(data, id) {
            let bytes = std::fs::read(media_dir(data, id).join(format!("{image}.bin")))?;
            media.insert(image, uploader.add(&bytes).await?);
        }
        let (refs, gc_epoch) = match uploader.finish().await {
            Ok(done) => done,
            Err(Error::Sync("SyncRetry", _)) => {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                continue;
            }
            Err(e) => return Err(e),
        };
        let entry = serde_json::to_string(&Entry {
            meta: meta.clone(),
            file,
            media,
        })?;
        // Readable by the service: when it changed and how large it is. Not its title.
        let info = serde_json::json!({
            "updated": meta.get("updated").and_then(Value::as_u64).unwrap_or(0),
            "bytes": text.len(),
        });
        match records::put_labeled(
            api,
            ring,
            collection,
            id,
            expect,
            Some(&entry),
            Some((&refs, gc_epoch)),
            Some(&info),
        )
        .await?
        {
            Put::Gc { .. } => continue,
            other => return Ok(Some(other)),
        }
    }
    Err(Error::Sync(
        "SyncRetry",
        "The chat couldn't be uploaded just now; trying again later.".into(),
    ))
}

/// Whether the chat saved here has exactly the content the record `collection`/`id` names.
pub async fn same(
    api: &Api,
    ring: &Keyring,
    data: &Path,
    collection: &str,
    id: &str,
) -> Result<bool> {
    let Some(text) = agent::load_session(data, id)? else {
        return Ok(false);
    };
    let Some(record) = records::get(api, ring, collection, id).await? else {
        return Ok(false);
    };
    let Some(entry) = record
        .text
        .as_deref()
        .filter(|_| !record.deleted)
        .and_then(|t| serde_json::from_str::<Entry>(t).ok())
    else {
        return Ok(false);
    };
    let mut ids = Vec::new();
    for piece in text.as_bytes().chunks(chunks::CHUNK_BYTES) {
        ids.push(ring.chunk_id(piece)?);
    }
    Ok(ids == entry.file.chunks)
}

#[allow(clippy::too_many_arguments)]
/// Downloads the chat in the record `collection`/`id` and saves it as the chat `save_as`
/// (the same id, or a new one for a copy). `workspace` replaces the chat's project folder,
/// which is a path on the computer that pushed it (None: a chat with no folder).
/// Returns the record's version, or None when it has no readable content.
pub async fn pull(
    api: &Api,
    ring: &Keyring,
    data: &Path,
    collection: &str,
    id: &str,
    save_as: &str,
    workspace: Option<&str>,
    if_stamp: Option<&str>,
) -> Result<Option<u64>> {
    // A name for a chat's file and folder, nothing else (it reaches paths below).
    if save_as.is_empty()
        || save_as.len() > 80
        || !save_as
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(Error::Invalid(format!("bad id: {save_as}")));
    }
    let stamp = || {
        agent::session_stamps(data, &[save_as.to_string()])
            .pop()
            .flatten()
    };
    // Saved here since the caller looked: left for the next pass.
    if stamp().as_deref() != if_stamp {
        return Ok(None);
    }
    let Some(record) = records::get(api, ring, collection, id).await? else {
        return Ok(None);
    };
    let Some(text) = record.text.as_deref().filter(|_| !record.deleted) else {
        return Ok(None);
    };
    // A chat deleted on another computer: its record says so, and holds nothing to fetch.
    if serde_json::from_str::<Value>(text)?["deleted"] == Value::Bool(true) {
        return Ok(None);
    }
    let entry: Entry = serde_json::from_str(text)?;
    let bytes = chunks::read(api, ring, &entry.file).await?;
    let mut chat: Value = serde_json::from_slice(&bytes)?;
    if let Some(meta) = chat.get_mut("meta").and_then(Value::as_object_mut) {
        match workspace {
            Some(w) => meta.insert("workspace".into(), Value::String(w.to_string())),
            None => meta.insert("workspace".into(), Value::Null),
        };
        // A worktree is a folder on the other computer.
        meta.remove("worktree");
    }
    // Images first: a chat that names an image it doesn't have yet shows a gap.
    for (image, stored) in &entry.media {
        if !image
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            || image.is_empty()
        {
            continue;
        }
        let dir = media_dir(data, save_as);
        let target = dir.join(format!("{image}.bin"));
        if target.metadata().is_ok_and(|m| m.len() == stored.size) {
            continue;
        }
        std::fs::create_dir_all(&dir)?;
        atomic_write(&target, &chunks::read(api, ring, stored).await?)?;
    }
    // Again, after the downloads: a save made meanwhile wins.
    if stamp().as_deref() != if_stamp {
        return Ok(None);
    }
    agent::save_session_if(data, save_as, &serde_json::to_string(&chat)?, None)?;
    Ok(Some(record.version))
}
