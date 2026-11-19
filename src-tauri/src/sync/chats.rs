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
    push_text(api, ring, data, collection, id, expect, text, None)
        .await
        .map(Some)
}

/// Uploads `text` (a chat's file as it should travel) with the chat `id`'s images, as the
/// record `collection`/`id`.
#[allow(clippy::too_many_arguments)]
pub async fn push_text(
    api: &Api,
    ring: &Keyring,
    data: &Path,
    collection: &str,
    id: &str,
    expect: Option<u64>,
    text: String,
    only_images: Option<&std::collections::BTreeSet<String>>,
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
            if only_images.is_some_and(|named| !named.contains(&image)) {
                continue;
            }
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
/// (`conversation`), written nowhere. None when the record holds none. Refused
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
    let chat: Value = serde_json::from_slice(&bytes)?;
    // Built anew from what a conversation is: what the other side's app sent isn't believed.
    Ok(Some(serde_json::to_string(&conversation(&chat))?))
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

/// The fields of a chat's items that are the conversation, by the item's type. Everything else
/// an item holds stays behind: what was attached and the editor's state with a message, the
/// provider's own reasoning blocks, costs, reviews, buttons, pasted images and their previews.
const ITEM_FIELDS: &[(&str, &[&str])] = &[
    (
        "user",
        &[
            "id", "text", "auto", "to", "mode", "steer", "turn", "sideTask",
        ],
    ),
    (
        "assistant",
        &[
            "id",
            "text",
            "thinking",
            "thinkingMs",
            "raw",
            "model",
            "modelKey",
            "speaker",
            "media",
        ],
    ),
    (
        "tool",
        &[
            "id", "callId", "name", "args", "status", "result", "summary", "detail", "changes",
            "media", "check",
        ],
    ),
    ("summary", &["id", "text", "count", "auto"]),
    ("notice", &["id", "text", "tone", "detail"]),
];

/// An image a chat's item names (`media`: id and type), and nothing else of it.
fn image_refs(media: &Value) -> Vec<Value> {
    media
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|image| {
            let id = image["id"].as_str().filter(|id| image_id(id))?;
            let mime = image["mime"].as_str().filter(|m| m.len() <= 80)?;
            Some(serde_json::json!({ "id": id, "mime": mime }))
        })
        .collect()
}

/// Whether a name is an image's id as a chat makes them, safe as a file's name everywhere.
pub(crate) fn image_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && !super::snapshot::unsafe_name(id)
}

/// A chat as a conversation and nothing more, built anew from what is named here (so a
/// field this doesn't know never comes along): its title and when it changed, its items
/// with the fields that are content (`ITEM_FIELDS`), the turn counter and how tool calls are
/// written. No costs, plans, pull requests, modes, members, rooms, models chosen, limits,
/// pending edits, grants or paths: the chat is then a new one's history. Used on what is
/// shared with teammates before it leaves, and again on what arrives from one (what the
/// other side's app sent is not believed).
pub fn conversation(chat: &Value) -> Value {
    let mut meta = serde_json::Map::new();
    if let Some(title) = chat["meta"]["title"].as_str() {
        let title: String = title
            .chars()
            .filter(|c| !c.is_control())
            .take(160)
            .collect();
        meta.insert("title".into(), Value::String(title));
    }
    if let Some(updated) = chat["meta"]["updated"].as_u64() {
        meta.insert("updated".into(), Value::from(updated));
    }
    let mut items = Vec::new();
    for item in chat["items"].as_array().into_iter().flatten() {
        let Some(kind) = item["type"].as_str() else {
            continue;
        };
        let Some((_, fields)) = ITEM_FIELDS.iter().find(|(name, _)| *name == kind) else {
            continue;
        };
        let mut kept = serde_json::Map::new();
        kept.insert("type".into(), Value::String(kind.to_string()));
        for field in *fields {
            let Some(value) = item.get(*field) else {
                continue;
            };
            let value = if *field == "media" {
                Value::Array(image_refs(value))
            } else {
                value.clone()
            };
            kept.insert((*field).to_string(), value);
        }
        match kind {
            "assistant" => {
                // A reply that was still being written is one that ended.
                kept.insert("streaming".into(), Value::Bool(false));
                kept.entry("thinking")
                    .or_insert(Value::String(String::new()));
            }
            // What was attached to a message stays behind; that something was is said.
            "user" => {
                let had = item["attachments"]
                    .as_array()
                    .is_some_and(|a| !a.is_empty())
                    || item["context"].as_array().is_some_and(|c| !c.is_empty())
                    || item["images"].as_array().is_some_and(|i| !i.is_empty())
                    || item["previews"].as_array().is_some_and(|p| !p.is_empty());
                if had {
                    let text = kept.get("text").and_then(Value::as_str).unwrap_or("");
                    kept.insert(
                        "text".into(),
                        Value::String(format!(
                            "{text}\n\n[Attachments are not part of the shared chat.]"
                        )),
                    );
                }
            }
            _ => {}
        }
        items.push(Value::Object(kept));
    }
    let mut top = serde_json::Map::new();
    top.insert("meta".into(), Value::Object(meta));
    top.insert("items".into(), Value::Array(items));
    if let Some(turn) = chat["turn"].as_u64() {
        top.insert("turn".into(), Value::from(turn));
    }
    if let Some(protocol) = chat["textProtocol"].as_bool() {
        top.insert("textProtocol".into(), Value::Bool(protocol));
    }
    Value::Object(top)
}

/// Every string in `value`, at any depth (a string that is itself JSON is looked into).
fn string_leaves<'a>(value: &'a Value, out: &mut Vec<std::borrow::Cow<'a, str>>, depth: usize) {
    if depth > 12 {
        return;
    }
    match value {
        Value::String(text) => match serde_json::from_str::<Value>(text) {
            Ok(inner) if inner.is_object() || inner.is_array() => {
                let mut found = Vec::new();
                string_leaves(&inner, &mut found, depth + 1);
                out.extend(
                    found
                        .into_iter()
                        .map(|s| std::borrow::Cow::Owned(s.into_owned())),
                );
            }
            _ => out.push(std::borrow::Cow::Borrowed(text)),
        },
        Value::Array(list) => list.iter().for_each(|v| string_leaves(v, out, depth + 1)),
        Value::Object(map) => map.values().for_each(|v| string_leaves(v, out, depth + 1)),
        _ => {}
    }
}

/// Whether a tool call's arguments name a key file anywhere: as a value at any depth, or as
/// a word of one (a command line: `cat .env | head`).
fn names_key_file(args: &Value, key_file: fn(&str) -> Option<&'static str>) -> bool {
    let mut leaves = Vec::new();
    string_leaves(args, &mut leaves, 0);
    leaves.iter().any(|leaf| {
        let is_one = |word: &str| {
            let word = word.trim_matches(|c: char| "\"'`()[]{}<>|;,=&".contains(c));
            !word.is_empty() && word.len() < 1024 && key_file(&word.replace('\\', "/")).is_some()
        };
        (leaf.len() < 4096 && is_one(leaf))
            || leaf
                .split(|c: char| c.is_whitespace() || "|;<>=,&()".contains(c))
                .take(4096)
                .any(is_one)
    })
}

/// `text` without the folder `root` in it (either slash, any letter case where the file
/// system ignores it), and with what looks like a secret taken out (the rules the
/// diagnostics report goes by: keys and tokens by their shape, a home folder's name).
fn scrubbed(text: &str, root: Option<&str>) -> String {
    let mut out = text.to_string();
    if let Some(root) = root
        .map(|r| r.trim_end_matches(['/', '\\']))
        .filter(|r| r.len() > 3)
    {
        for form in [
            root.to_string(),
            root.replace('\\', "/"),
            root.replace('/', "\\"),
        ] {
            let pattern = if cfg!(any(windows, target_os = "macos")) {
                format!("(?i){}", regex::escape(&form))
            } else {
                regex::escape(&form)
            };
            if let Ok(re) = regex::Regex::new(&pattern) {
                out = re.replace_all(&out, ".").into_owned();
            }
        }
    }
    crate::diagnostics::redact::redact(&out, None)
}

fn scrub_all(value: &mut Value, root: Option<&str>, depth: usize) {
    if depth > 12 {
        return;
    }
    match value {
        Value::String(text) => *text = scrubbed(text, root),
        Value::Array(list) => list.iter_mut().for_each(|v| scrub_all(v, root, depth + 1)),
        Value::Object(map) => map.values_mut().for_each(|v| scrub_all(v, root, depth + 1)),
        _ => {}
    }
}

/// What `for_teammates` made of a chat.
pub struct Shared {
    pub chat: Value,
    /// Tool calls left out because they named a key file.
    pub key_files: usize,
    /// The images the shared chat still names: only these travel.
    pub images: std::collections::BTreeSet<String>,
}

/// A chat's file as it is shared with teammates (D454, D457): the conversation only
/// (`conversation`), and of it
/// - a tool call whose arguments name a key file anywhere (`key_file`: the rule that leaves
///   such files out of a shared snapshot) keeps its name and nothing else: no arguments, no
///   result, no images;
/// - the project's folder (`root`) is written `.` wherever it is spelled out, and what has
///   the shape of a key or token is taken out of every text (`scrubbed`).
///
/// What this can't know stays: a secret the model repeated in its own words, or one of a
/// shape no rule has, in a file with an ordinary name.
pub fn for_teammates(
    chat: &Value,
    key_file: fn(&str) -> Option<&'static str>,
    root: Option<&str>,
) -> Shared {
    let mut chat = conversation(chat);
    let mut key_files = 0;
    let mut images = std::collections::BTreeSet::new();
    if let Some(title) = chat["meta"]["title"].as_str().map(|t| scrubbed(t, root)) {
        chat["meta"]["title"] = Value::String(title);
    }
    for item in chat["items"].as_array_mut().into_iter().flatten() {
        let Some(fields) = item.as_object_mut() else {
            continue;
        };
        if fields.get("type").and_then(Value::as_str) == Some("tool")
            && fields
                .get("args")
                .is_some_and(|args| names_key_file(args, key_file))
        {
            fields.retain(|name, _| {
                matches!(name.as_str(), "type" | "id" | "callId" | "name" | "status")
            });
            fields.insert("args".into(), serde_json::json!({}));
            fields.insert(
                "result".into(),
                Value::String("[Left out of the shared chat: a key file.]".into()),
            );
            key_files += 1;
            continue;
        }
        for (name, value) in fields.iter_mut() {
            match name.as_str() {
                "media" => {
                    for image in value.as_array().into_iter().flatten() {
                        if let Some(id) = image["id"].as_str() {
                            images.insert(id.to_string());
                        }
                    }
                }
                "type" | "id" | "callId" | "status" | "auto" | "mode" | "tone" => {}
                _ => scrub_all(value, root, 0),
            }
        }
    }
    Shared {
        chat,
        key_files,
        images,
    }
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
    /// One image at most (it is read into memory whole).
    pub image_each: u64,
    pub image_bytes: u64,
}

impl Limits {
    /// The account's own chats: as large as it made them.
    pub const OWN: Limits = Limits {
        file: u64::MAX,
        images: usize::MAX,
        image_each: u64::MAX,
        image_bytes: u64::MAX,
    };

    fn refuse(self, entry: &Entry) -> bool {
        entry.file.size > self.file
            || entry.media.len() > self.images
            || entry
                .media
                .values()
                .any(|stored| stored.size > self.image_each)
            || entry
                .media
                .values()
                .fold(0u64, |sum, stored| sum.saturating_add(stored.size))
                > self.image_bytes
    }
}

/// A name for a chat's file and folder, nothing else (it reaches paths).
fn chat_name(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        && !super::snapshot::unsafe_name(id)
}

/// Fetches the chat in the record `collection`/`id`: its file as it was stored (not yet
/// made harmless, not saved), with its images written into the chat `save_as`'s folder.
/// None when the record has no readable content. The record's version comes with it.
pub async fn fetch(
    api: &Api,
    ring: &Keyring,
    data: &Path,
    collection: &str,
    id: &str,
    save_as: &str,
    limits: Limits,
) -> Result<Option<(Value, u64)>> {
    if !chat_name(save_as) {
        return Err(Error::Invalid(format!("bad id: {save_as}")));
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
    let chat: Value = serde_json::from_slice(&bytes)?;
    // Images first: a chat that names an image it doesn't have yet shows a gap.
    for (image, stored) in &entry.media {
        // (A name some computer reads as a device, or as a path, is no image's.)
        if !image_id(image) {
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
    Ok(Some((chat, record.version)))
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
    if !chat_name(save_as) {
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
    let Some((mut chat, version)) = fetch(api, ring, data, collection, id, save_as, limits).await?
    else {
        return Ok(None);
    };
    neutralise(&mut chat, workspace);
    // Again, after the downloads: a save made meanwhile wins.
    if stamp().as_deref() != if_stamp {
        return Ok(None);
    }
    agent::save_session_if(data, save_as, &serde_json::to_string(&chat)?, None)?;
    Ok(Some(version))
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

        // Shared with teammates (D457): built from a whitelist, so what a chat's file holds
        // besides the conversation never comes along, whatever it is called.
        let mut shared = json!({
            "meta": {
                "title": "t", "workspace": "C:\\work\\p", "model": "openai/gpt", "room": "r1",
                "members": ["scout"], "status": "working", "mode": "custom:x", "updated": 9,
            },
            "checkpoints": [1, 2],
            "seen": { "a": "b" },
            "cost": 12.5,
            "plan": [{ "text": "step" }],
            "pullRequest": { "number": 3 },
            "chatMode": "custom:x",
            "workMode": "plan",
            "toolLimit": ["read_file"],
            "externalSeen": "x",
            "turn": 2,
            "textProtocol": false,
            "items": [
                { "type": "user", "id": "u", "text": "read the env in C:\\work\\p\\src", "state": "open: .env TOKEN=abc",
                  "context": ["<file path=\".env\">TOKEN=abc</file>"], "attachments": [{ "path": ".env" }], "previews": ["data:x"] },
                { "type": "tool", "id": "t1", "callId": "c1", "name": "read_file", "status": "done",
                  "args": { "path": "app/.env" }, "result": "SECRET=1", "detail": "SECRET=1",
                  "previews": ["data:y"], "media": [{ "id": "img1", "mime": "image/png" }] },
                { "type": "tool", "id": "t2", "callId": "c2", "name": "run", "status": "done",
                  "args": { "command": "cat .env | head -3" }, "result": "SECRET=2" },
                { "type": "tool", "id": "t3", "callId": "c3", "name": "multi", "status": "done",
                  "args": "{\"files\":[{\"file\":\"C:\\\\p\\\\id_rsa\"}]}", "result": "KEYDATA" },
                { "type": "tool", "id": "t4", "callId": "c4", "name": "read_file", "status": "done",
                  "args": { "path": "src/main.rs" }, "result": "fn main() {} // C:/work/p/src/main.rs",
                  "media": [{ "id": "img2", "mime": "image/png", "preview": "data:z" }, { "id": "nul", "mime": "image/png" }],
                  "review": { "by": "x" }, "images": ["AAAA"] },
                { "type": "tool", "id": "t5", "callId": "c5", "name": "search", "status": "done",
                  "args": { "query": "TOKEN", "path": "." },
                  "result": "config.txt: key = sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
                { "type": "assistant", "id": "a", "text": "done", "thinking": "hm", "streaming": true,
                  "cost": 3, "reasoning": [{ "type": "thinking", "signature": "sig" }], "toolDraft": { "name": "x" } },
                { "type": "notice", "id": "n", "text": "stopped", "tone": "info", "actions": ["retry"] },
                { "type": "weird", "id": "w", "text": "?" },
            ],
        });
        let key_file = |path: &str| -> Option<&'static str> {
            let name = path.rsplit('/').next().unwrap_or(path);
            (name == ".env" || name == "id_rsa").then_some("a key file")
        };
        let out = for_teammates(&shared, key_file, Some("C:\\work\\p"));
        assert_eq!(
            out.key_files, 3,
            "by value, by a word of a command, inside a string of JSON"
        );
        let top: Vec<&str> = out
            .chat
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(top, ["items", "meta", "textProtocol", "turn"]);
        assert_eq!(out.chat["meta"], json!({ "title": "t", "updated": 9 }));
        let text = out.chat.to_string();
        for gone in [
            "SECRET=1",
            "SECRET=2",
            "KEYDATA",
            "TOKEN=abc",
            "sk-ant-api03",
            "data:",
            "AAAA\"",
            "signature",
            "toolDraft",
            "review",
            "retry",
            "weird",
            "work\\\\p",
            "work/p",
            "id_rsa",
        ] {
            assert!(!text.contains(gone), "{gone} in {text}");
        }
        let items = out.chat["items"].as_array().unwrap();
        assert_eq!(items.len(), 8);
        // A message's attachments stay behind, and it says that there were some.
        assert!(items[0].get("context").is_none() && items[0].get("state").is_none());
        assert!(items[0]["text"]
            .as_str()
            .unwrap()
            .contains("Attachments are not part"));
        assert!(items[0]["text"]
            .as_str()
            .unwrap()
            .contains("read the env in .\\src"));
        // A call that named a key file keeps its name and nothing it said.
        assert_eq!(items[1]["name"], json!("read_file"));
        assert_eq!(items[1]["args"], json!({}));
        assert!(items[1].get("media").is_none() && items[1].get("detail").is_none());
        // Only images the shared chat still names travel; a device's name is no image's.
        assert_eq!(
            out.images.iter().map(String::as_str).collect::<Vec<_>>(),
            ["img2"]
        );
        assert_eq!(
            items[4]["media"],
            json!([{ "id": "img2", "mime": "image/png" }])
        );
        assert!(items[4]["result"]
            .as_str()
            .unwrap()
            .starts_with("fn main() {}"));
        assert_eq!(items[6]["streaming"], json!(false));
        assert!(items[6].get("cost").is_none());
        // The same whitelist on what arrives: a copy carries no spend, plan, room or mode.
        shared["cost"] = json!(-100000);
        let arrived = conversation(&shared);
        for gone in [
            "cost",
            "plan",
            "pullRequest",
            "chatMode",
            "workMode",
            "toolLimit",
            "externalSeen",
        ] {
            assert!(arrived.get(gone).is_none(), "{gone}");
        }
        for gone in ["room", "members", "status", "mode", "model", "workspace"] {
            assert!(arrived["meta"].get(gone).is_none(), "{gone}");
        }
        assert!(image_id("img1") && !image_id("nul") && !image_id("con") && !image_id("a/b"));

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
