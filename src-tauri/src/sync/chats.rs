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

/// What a chat's file says besides the conversation, and that a chat from somewhere else must
/// not bring along: whatever grants something, or names a file or a folder outside the chat.
/// These are dropped (the chat reads as it would without them: nothing granted, nothing
/// waiting).
const GRANTS_OR_NAMES_PATHS: &[&str] = &[
    // Edits waiting for review: paths and their original text, written back on "reject".
    "changeset",
    // What the agent last saw of each file, which lets it write a file without reading it.
    "seen",
    // "Go on past the chat's budget" was said on the other computer.
    "budgetAllowed",
    // An external agent's session to pick up again, with the folder it runs in.
    "acpResume",
    // Rules and skills already told, by their paths there: told again here.
    "attachedRules",
    "toldSkills",
];

/// Makes a chat that arrived from the account (another computer's, so possibly someone
/// else's who got into one) a conversation and nothing more: its folder is this computer's
/// (`workspace`), it applies no edits without review, and nothing of
/// `GRANTS_OR_NAMES_PATHS` comes with it. The one place every downloaded chat passes; a chat
/// copied from a share goes through it too.
pub(crate) fn neutralise(chat: &mut Value, workspace: Option<&str>) {
    let Some(top) = chat.as_object_mut() else {
        return;
    };
    for field in GRANTS_OR_NAMES_PATHS {
        top.remove(*field);
    }
    // Applying edits without review is switched on per chat, on the computer it is used on.
    if top.contains_key("autoApply") {
        top.insert("autoApply".into(), Value::Bool(false));
    }
    // Checkpoints are this computer's own snapshots, named by a turn's number.
    if let Some(checkpoints) = top.get_mut("checkpoints") {
        match checkpoints.as_array_mut() {
            Some(turns) => turns.retain(Value::is_u64),
            None => *checkpoints = Value::Array(Vec::new()),
        }
    }
    if let Some(meta) = top.get_mut("meta").and_then(Value::as_object_mut) {
        match workspace {
            Some(w) => meta.insert("workspace".into(), Value::String(w.to_string())),
            None => meta.insert("workspace".into(), Value::Null),
        };
        // A worktree is a folder on the other computer.
        meta.remove("worktree");
        // The count of edits waiting for review: there are none here.
        meta.remove("pending");
    }
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
    neutralise(&mut chat, workspace);
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_downloaded_chat_grants_nothing_and_names_no_paths() {
        let mut chat = json!({
            "meta": {
                "title": "Fix the build",
                "updated": 7,
                "workspace": "/home/other/project",
                "worktree": { "path": "/home/other/wt", "branch": "x" },
                "pending": 2,
                "model": "openai/gpt",
            },
            "items": [{ "type": "user", "id": "u1", "text": "hello" }],
            "turn": 3,
            "autoApply": true,
            "chatMode": "agent",
            "changeset": [{ "path": "C:/Users/me/.ssh/config", "original": "", "proposed": "x" }],
            "applied": { "1#a.ts": { "added": 1, "removed": 0 } },
            "checkpoints": [1, 2, "../../elsewhere", { "turn": 3 }],
            "seen": { "/etc/passwd": "fp" },
            "attachedRules": { "/home/other/rules.md": 1 },
            "toldSkills": { "deploy": 1 },
            "budgetAllowed": true,
            "acpResume": { "agent": "a", "id": "s", "root": "/home/other" },
            "plan": [{ "text": "step" }],
        });
        neutralise(&mut chat, Some("D:/work/project"));
        assert_eq!(chat["autoApply"], json!(false));
        for gone in [
            "changeset",
            "seen",
            "attachedRules",
            "toldSkills",
            "budgetAllowed",
            "acpResume",
        ] {
            assert!(chat.get(gone).is_none(), "{gone}");
        }
        assert_eq!(chat["checkpoints"], json!([1, 2]));
        assert_eq!(chat["meta"]["workspace"], json!("D:/work/project"));
        assert!(chat["meta"].get("worktree").is_none());
        assert!(chat["meta"].get("pending").is_none());
        // The conversation itself is as it was.
        assert_eq!(chat["meta"]["title"], json!("Fix the build"));
        assert_eq!(chat["meta"]["model"], json!("openai/gpt"));
        assert_eq!(chat["items"][0]["text"], json!("hello"));
        assert_eq!(chat["turn"], json!(3));
        assert_eq!(chat["chatMode"], json!("agent"));
        assert_eq!(chat["plan"][0]["text"], json!("step"));
        assert_eq!(chat["applied"]["1#a.ts"]["added"], json!(1));

        // No folder here: none in the chat; odd shapes are left standing, not trusted.
        let mut chat = json!({ "meta": { "workspace": "/x" }, "checkpoints": "all" });
        neutralise(&mut chat, None);
        assert_eq!(chat["meta"]["workspace"], Value::Null);
        assert_eq!(chat["checkpoints"], json!([]));
        assert!(chat.get("autoApply").is_none());
        let mut odd = json!(["not", "a", "chat"]);
        neutralise(&mut odd, None);
        assert_eq!(odd, json!(["not", "a", "chat"]));
    }
}
