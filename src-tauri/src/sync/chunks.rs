//! Content too large for a record (a chat, an image, a file in a snapshot) is stored as
//! chunks: pieces of at most 4 MB, each sealed and named by a keyed hash of its content, so
//! the same content is uploaded and stored once however many items use it.

use std::collections::{HashMap, HashSet};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::api::Api;
use super::crypto::Keyring;
use crate::error::{Error, Result};

const PURPOSE: &str = "chunks";
pub const CHUNK_BYTES: usize = 4 * 1024 * 1024;
/// Sealed chunks are sent together up to this much.
const BATCH_BYTES: usize = 12 * 1024 * 1024;
const HAVE_MAX: usize = 2000;
/// Upload requests in flight together, and download requests for one item.
const UPLOADS_AT_ONCE: usize = 3;
const DOWNLOADS_AT_ONCE: usize = 3;
const ID_LEN: usize = 22;

/// Where some content is: its chunks in order, and its length.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stored {
    pub chunks: Vec<String>,
    pub size: u64,
}

fn frame(out: &mut Vec<u8>, id: &str, bytes: &[u8]) {
    out.extend_from_slice(id.as_bytes());
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

/// Splits a reply of frames into (id, bytes); an empty frame is a chunk the server lacks.
fn unframe(buf: &[u8]) -> Result<Vec<(String, &[u8])>> {
    let broken = || Error::Sync("Sync", "A download was cut off.".into());
    let mut out = Vec::new();
    let mut at = 0;
    while at < buf.len() {
        let head = buf.get(at..at + ID_LEN + 4).ok_or_else(broken)?;
        let id = std::str::from_utf8(&head[..ID_LEN])
            .map_err(|_| broken())?
            .to_string();
        let length = u32::from_be_bytes([
            head[ID_LEN],
            head[ID_LEN + 1],
            head[ID_LEN + 2],
            head[ID_LEN + 3],
        ]) as usize;
        at += ID_LEN + 4;
        out.push((id, buf.get(at..at + length).ok_or_else(broken)?));
        at += length;
    }
    Ok(out)
}

/// Uploads content as chunks, skipping what the server has. One per operation: it remembers
/// what it stored, for the record that will name those chunks.
pub struct Uploader<'a> {
    api: &'a Api,
    ring: &'a Keyring,
    /// Sealed chunks waiting to be sent.
    pending: Vec<(String, Vec<u8>)>,
    pending_bytes: usize,
    /// Every chunk this operation's content uses.
    used: HashSet<String>,
    /// Chunks the server is known to hold (asked, or sent).
    present: HashSet<String>,
    /// The sweep count the server's chunks were checked under; a change means start over.
    gc_epoch: Option<u64>,
    /// Chunks named again without their content at hand (an unchanged file): they must still
    /// be on the server, which `finish` checks.
    kept: Vec<String>,
    pub uploaded_bytes: u64,
}

impl<'a> Uploader<'a> {
    pub fn new(api: &'a Api, ring: &'a Keyring) -> Self {
        Self {
            api,
            ring,
            pending: Vec::new(),
            pending_bytes: 0,
            used: HashSet::new(),
            present: HashSet::new(),
            gc_epoch: None,
            kept: Vec::new(),
            uploaded_bytes: 0,
        }
    }

    /// Queues `data` for storing and says where it will be.
    pub async fn add(&mut self, data: &[u8]) -> Result<Stored> {
        let mut chunks = Vec::new();
        for piece in data.chunks(CHUNK_BYTES) {
            let id = self.ring.chunk_id(piece)?;
            if self.used.insert(id.clone()) && !self.present.contains(&id) {
                let sealed = self.ring.seal(PURPOSE, &id, piece)?;
                self.pending_bytes += sealed.len();
                self.pending.push((id.clone(), sealed));
            }
            chunks.push(id);
            if self.pending_bytes >= BATCH_BYTES || self.pending.len() >= HAVE_MAX {
                self.flush().await?;
            }
        }
        Ok(Stored {
            chunks,
            size: data.len() as u64,
        })
    }

    /// Names content stored before without reading it again.
    pub fn keep(&mut self, stored: &Stored) {
        for id in &stored.chunks {
            if self.used.insert(id.clone()) && !self.present.contains(id) {
                self.kept.push(id.clone());
            }
        }
    }

    fn note_epoch(&mut self, reply: &Value) -> Result<()> {
        let now = reply["gcEpoch"].as_u64().unwrap_or(0);
        match self.gc_epoch {
            Some(before) if before != now => Err(Error::Sync(
                "SyncRetry",
                "Unneeded data was being cleaned up meanwhile; trying again.".into(),
            )),
            _ => {
                self.gc_epoch = Some(now);
                Ok(())
            }
        }
    }

    /// Sends what is queued: asks which chunks are missing, uploads those.
    pub async fn flush(&mut self) -> Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let pending = std::mem::take(&mut self.pending);
        self.pending_bytes = 0;
        let ids: Vec<&str> = pending.iter().map(|(id, _)| id.as_str()).collect();
        let reply = self
            .api
            .post("blobs/have", &json!({ "ids": ids }))
            .await?
            .into_ok()?;
        self.note_epoch(&reply)?;
        let missing: HashSet<&str> = reply["missing"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let mut batches: Vec<Vec<u8>> = Vec::new();
        let mut frames = Vec::new();
        for (id, sealed) in &pending {
            if !missing.contains(id.as_str()) {
                continue;
            }
            if !frames.is_empty() && frames.len() + sealed.len() > BATCH_BYTES {
                batches.push(std::mem::take(&mut frames));
            }
            frame(&mut frames, id, sealed);
        }
        if !frames.is_empty() {
            batches.push(frames);
        }
        // A few batches at once: a large first upload isn't one request after another.
        self.uploaded_bytes += batches.iter().map(|b| b.len() as u64).sum::<u64>();
        let api = self.api;
        let replies: Vec<Result<Value>> = futures_util::stream::iter(batches)
            .map(|batch| api.upload(batch))
            .buffer_unordered(UPLOADS_AT_ONCE)
            .collect()
            .await;
        for reply in replies {
            self.note_epoch(&reply?)?;
        }
        self.present.extend(pending.into_iter().map(|(id, _)| id));
        Ok(())
    }

    /// Sends the rest and returns what the record must name: every chunk used, and the sweep
    /// count they were checked under.
    pub async fn finish(mut self) -> Result<(Vec<String>, u64)> {
        self.flush().await?;
        let kept = std::mem::take(&mut self.kept);
        for group in kept.chunks(HAVE_MAX) {
            let reply = self
                .api
                .post("blobs/have", &json!({ "ids": group }))
                .await?
                .into_ok()?;
            self.note_epoch(&reply)?;
            if reply["missing"].as_array().is_some_and(|m| !m.is_empty()) {
                return Err(Error::Sync(
                    "SyncStale",
                    "Content an earlier snapshot stored is gone; reading the files again.".into(),
                ));
            }
        }
        let epoch = match self.gc_epoch {
            Some(e) => e,
            // Nothing was sent or asked (no content): the count as it is now.
            None => self
                .api
                .post("blobs/have", &json!({ "ids": [] }))
                .await?
                .into_ok()?["gcEpoch"]
                .as_u64()
                .unwrap_or(0),
        };
        let mut used: Vec<String> = self.used.into_iter().collect();
        used.sort();
        Ok((used, epoch))
    }
}

/// The frames of a reply that are chunks still waited for. A reply with none of them (empty,
/// or only chunks nobody asked for) is an error: asking again would never end.
fn asked_for<'a>(
    wanted: &[String],
    frames: Vec<(String, &'a [u8])>,
) -> Result<Vec<(String, &'a [u8])>> {
    if frames.is_empty() {
        return Err(Error::Sync("Sync", "A download came back empty.".into()));
    }
    let asked: Vec<(String, &[u8])> = frames
        .into_iter()
        .filter(|(id, _)| wanted.contains(id))
        .collect();
    if asked.is_empty() {
        return Err(Error::Sync(
            "Sync",
            "A download brought back something other than what was asked for.".into(),
        ));
    }
    Ok(asked)
}

/// Downloads and opens chunks. Returns them by id; a chunk the server lacks is an error.
pub async fn fetch(api: &Api, ring: &Keyring, ids: &[String]) -> Result<HashMap<String, Vec<u8>>> {
    let mut out = HashMap::new();
    let mut wanted: Vec<String> = Vec::new();
    for id in ids {
        if !wanted.contains(id) {
            wanted.push(id.clone());
        }
    }
    while !wanted.is_empty() {
        let batch: Vec<String> = wanted.iter().take(HAVE_MAX).cloned().collect();
        let reply = api.download(&batch).await?;
        let frames = asked_for(&wanted, unframe(&reply)?)?;
        for (id, sealed) in frames {
            if sealed.is_empty() {
                return Err(Error::Sync(
                    "SyncMissing",
                    "Part of this item is missing from the synced copy.".into(),
                ));
            }
            out.insert(id.clone(), ring.open(PURPOSE, &id, sealed)?);
            wanted.retain(|w| *w != id);
        }
    }
    Ok(out)
}

/// The content `stored` names, whole.
pub async fn read(api: &Api, ring: &Keyring, stored: &Stored) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(stored.size as usize);
    // A few requests at once, each for a few chunks, taken in order: a large item downloads
    // faster without sitting in memory twice.
    let owned: Vec<Vec<String>> = stored.chunks.chunks(2).map(<[String]>::to_vec).collect();
    let mut groups = futures_util::stream::iter(owned)
        .map(|group| async move { fetch(api, ring, &group).await.map(|got| (group, got)) })
        .buffered(DOWNLOADS_AT_ONCE);
    while let Some(next) = groups.next().await {
        let (group, got) = next?;
        for id in &group {
            out.extend_from_slice(got.get(id).map(Vec::as_slice).unwrap_or_default());
        }
    }
    if out.len() as u64 != stored.size {
        return Err(Error::Sync(
            "Sync",
            "A synced item isn't the size it should be.".into(),
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        let mut buf = Vec::new();
        let (a, b) = ("a".repeat(ID_LEN), "b".repeat(ID_LEN));
        frame(&mut buf, &a, b"hello");
        frame(&mut buf, &b, b"");
        let got = unframe(&buf).unwrap();
        assert_eq!(got, vec![(a, &b"hello"[..]), (b, &b""[..])]);
        assert!(unframe(&buf[..buf.len() - 3]).is_err());
        assert!(unframe(&buf[..10]).is_err());
    }

    #[test]
    fn a_reply_without_what_was_asked_for_is_an_error() {
        let (a, b, c) = ("a".repeat(ID_LEN), "b".repeat(ID_LEN), "c".repeat(ID_LEN));
        let wanted = vec![a.clone(), b.clone()];
        // Only what is waited for is taken; the rest is left out.
        let got = asked_for(
            &wanted,
            vec![(c.clone(), &b"x"[..]), (a.clone(), &b"y"[..])],
        )
        .unwrap();
        assert_eq!(got, vec![(a, &b"y"[..])]);
        // Nothing asked for among the frames: the loop that asks again must stop.
        assert!(asked_for(&wanted, vec![(c, &b"x"[..])]).is_err());
        assert!(asked_for(&wanted, Vec::new()).is_err());
    }
}
