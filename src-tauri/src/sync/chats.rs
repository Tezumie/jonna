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
    push_text(api, ring, data, collection, id, expect, text)
        .await
        .map(Some)
}

/// Uploads `text` (a chat's file as it should travel) with the chat `id`'s images, as the
/// record `collection`/`id`.
pub async fn push_text(
    api: &Api,
    ring: &Keyring,
    data: &Path,
    collection: &str,
    id: &str,
    expect: Option<u64>,
    text: String,
) -> Result<Put> {
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
            other => return Ok(other),
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

/// What a chat's record says of it without fetching it: for a list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatLabel {
    pub title: String,
    /// When it last changed, in ms (as its writer said).
    pub updated: u64,
    /// Its file's size.
    pub bytes: u64,
    pub images: usize,
    /// Its images' sizes together, as the record says them.
    pub image_bytes: u64,
}

/// The label in a chat record's text; None when it isn't a chat's record (or says deleted).
pub fn label(text: &str) -> Option<ChatLabel> {
    let entry: Entry = serde_json::from_str(text).ok()?;
    let title: String = entry.meta["title"]
        .as_str()
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(160)
        .collect();
    Some(ChatLabel {
        title: title.trim().to_string(),
        updated: entry.meta["updated"].as_u64().unwrap_or(0),
        bytes: entry.file.size,
        images: entry.media.len(),
        image_bytes: entry
            .media
            .values()
            .fold(0u64, |sum, stored| sum.saturating_add(stored.size)),
    })
}

/// A chat's file from the record `collection`/`id`, as a conversation and nothing more
/// (`neutralise`, with no folder), written nowhere. None when the record holds none. Refused
/// when the file says it is larger than `max` bytes.
pub async fn read_text(
    api: &Api,
    ring: &Keyring,
    collection: &str,
    id: &str,
    max: u64,
) -> Result<Option<String>> {
    let Some(record) = records::get(api, ring, collection, id).await? else {
        return Ok(None);
    };
    let Some(text) = record.text.as_deref().filter(|_| !record.deleted) else {
        return Ok(None);
    };
    let Ok(entry) = serde_json::from_str::<Entry>(text) else {
        return Ok(None);
    };
    // What the record says isn't believed further than this: reading stops at the pieces'
    // own sizes (`chunks::read`), and a file over the limit isn't fetched at all.
    if entry.file.size > max {
        return Err(Error::Sync(
            "Sync",
            "That chat is too large to show.".into(),
        ));
    }
    let bytes = chunks::read(api, ring, &entry.file).await?;
    let mut chat: Value = serde_json::from_slice(&bytes)?;
    neutralise(&mut chat, None);
    Ok(Some(serde_json::to_string(&chat)?))
}

/// The folder a chat's file says it belongs to (`meta.workspace`); None: none, or not a chat.
pub fn folder_of(chat: &Value) -> Option<&str> {
    chat["meta"]["workspace"].as_str().filter(|w| !w.is_empty())
}

/// Whether two folders are the same one as this computer spells paths: either slash, no
/// trailing one, and letter case ignored where the file system ignores it.
pub fn same_folder(a: &str, b: &str) -> bool {
    let plain = |path: &str| {
        let unified = path.replace('\\', "/");
        let trimmed = unified.trim_end_matches('/');
        if cfg!(any(windows, target_os = "macos")) {
            trimmed.to_lowercase()
        } else {
            trimmed.to_string()
        }
    };
    plain(a) == plain(b)
}

/// A chat's file as it is shared with teammates (D454): the conversation, with nothing that
/// grants something or names a place on this computer (`neutralise`, and no folder, no
/// checkpoints), and without what a tool read from a key file (`key_file` says which paths
/// are: the same rule that leaves them out of a shared snapshot). How many results were
/// left out.
pub fn for_teammates(chat: &mut Value, key_file: fn(&str) -> Option<&'static str>) -> usize {
    neutralise(chat, None);
    let Some(top) = chat.as_object_mut() else {
        return 0;
    };
    // This computer's own snapshots of the folder, by turn: they mean nothing elsewhere.
    top.remove("checkpoints");
    let mut left_out = 0;
    let Some(items) = top.get_mut("items").and_then(Value::as_array_mut) else {
        return 0;
    };
    for item in items {
        if item["type"] != "tool" {
            continue;
        }
        let names_key_file = item["args"].as_object().is_some_and(|args| {
            args.values()
                .filter_map(Value::as_str)
                .any(|v| v.len() < 1024 && key_file(&v.replace('\\', "/")).is_some())
        });
        if !names_key_file {
            continue;
        }
        if let Some(tool) = item.as_object_mut() {
            tool.insert(
                "result".into(),
                Value::String("[Left out of the shared chat: a key file.]".into()),
            );
            for field in ["detail", "images", "media", "diff"] {
                tool.remove(field);
            }
            // What was written to it travels as little as what was read from it.
            if let Some(args) = tool.get_mut("args").and_then(Value::as_object_mut) {
                for field in ["content", "text", "new_string", "old_string", "patch"] {
                    if args.contains_key(field) {
                        args.insert(field.into(), Value::String("[left out]".into()));
                    }
                }
            }
            left_out += 1;
        }
    }
    left_out
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

/// How much of a chat is fetched at most, for one that comes from someone else (a share):
/// what its record says isn't believed further than this, and reading stops as soon as more
/// arrives than was said (`chunks::read`).
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub file: u64,
    pub images: usize,
    pub image_bytes: u64,
}

impl Limits {
    /// The account's own chats: as large as it made them.
    pub const OWN: Limits = Limits {
        file: u64::MAX,
        images: usize::MAX,
        image_bytes: u64::MAX,
    };

    fn refuse(self, entry: &Entry) -> bool {
        entry.file.size > self.file
            || entry.media.len() > self.images
            || entry
                .media
                .values()
                .fold(0u64, |sum, stored| sum.saturating_add(stored.size))
                > self.image_bytes
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
    limits: Limits,
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
    // Checked on the record that is fetched from, not on one looked at earlier.
    if limits.refuse(&entry) {
        return Err(Error::Sync(
            "Sync",
            "That chat is too large to copy.".into(),
        ));
    }
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

        // Whose folder a chat is: by its own file, compared as paths are spelled here.
        let of = json!({ "meta": { "workspace": "C:\\work\\p\\" } });
        assert_eq!(folder_of(&of), Some("C:\\work\\p\\"));
        assert!(same_folder("C:\\work\\p\\", "C:/work/p"));
        assert!(!same_folder("C:/work/p", "C:/work/p2"));
        assert_eq!(folder_of(&json!({ "meta": { "workspace": null } })), None);
        assert_eq!(folder_of(&json!({ "meta": {} })), None);

        // Shared with teammates: no checkpoints, and nothing a tool read from a key file.
        let mut shared = json!({
            "meta": { "title": "t", "workspace": "/home/me/p" },
            "checkpoints": [1, 2],
            "seen": { "a": "b" },
            "items": [
                { "type": "user", "id": "u", "text": "read the env" },
                { "type": "tool", "id": "t1", "name": "read_file", "args": { "path": "app/.env" }, "result": "SECRET=1", "detail": "SECRET=1" },
                { "type": "tool", "id": "t2", "name": "write_file", "args": { "path": "C:\\p\\id_rsa", "content": "KEY" }, "result": "ok" },
                { "type": "tool", "id": "t3", "name": "read_file", "args": { "path": "src/main.rs" }, "result": "fn main() {}" },
            ],
        });
        let key_file = |path: &str| -> Option<&'static str> {
            let name = path.rsplit('/').next().unwrap_or(path);
            (name == ".env" || name == "id_rsa").then_some("a key file")
        };
        assert_eq!(for_teammates(&mut shared, key_file), 2);
        assert!(shared.get("checkpoints").is_none() && shared.get("seen").is_none());
        assert_eq!(shared["meta"]["workspace"], Value::Null);
        let text = shared.to_string();
        assert!(
            !text.contains("SECRET=1") && !text.contains("KEY\""),
            "{text}"
        );
        assert_eq!(shared["items"][3]["result"], json!("fn main() {}"));
        assert_eq!(shared["items"][0]["text"], json!("read the env"));

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
