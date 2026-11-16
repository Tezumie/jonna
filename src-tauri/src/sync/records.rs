//! Encrypted records: small named items (a settings map, a chat's entry, a snapshot's entry),
//! each with a version the server counts. A write names the version it was made from; when
//! someone else wrote in between, the caller gets the other version to merge with.

use serde::Serialize;
use serde_json::{json, Value};

use super::api::Api;
use super::crypto::{b64, unb64, Keyring};
use crate::error::{Error, Result};

const PURPOSE: &str = "records";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub collection: String,
    pub id: String,
    pub version: u64,
    pub seq: u64,
    pub deleted: bool,
    /// The content as text (records are JSON); None when deleted or unreadable.
    pub text: Option<String>,
    /// Sealed with keys this device doesn't hold yet (it catches up at the next status check).
    pub unreadable: bool,
    /// Its content opens with no key, held or to come (cut short, altered, from a reset
    /// account): treated as having no content, so the next write replaces it.
    pub damaged: bool,
    /// How many chunks it names.
    pub refs: u64,
    pub device: Option<String>,
    pub updated_at: Option<u64>,
    /// The record's label, readable by the service (a project's name, a snapshot's date and
    /// size): what the account page lists. Not sealed, so never trusted for anything here.
    pub info: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub epoch: u64,
    pub seq: u64,
    pub gc_epoch: u64,
    pub more: bool,
    pub records: Vec<Record>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum Put {
    Done {
        version: u64,
        seq: u64,
    },
    /// Someone wrote first: the record as it is now (None: it doesn't exist).
    Conflict {
        current: Option<Record>,
    },
    /// Chunks were cleaned up since they were checked: check them again under `gc_epoch`.
    Gc {
        gc_epoch: u64,
    },
}

fn place(collection: &str, id: &str) -> String {
    format!("{collection}/{id}")
}

fn parse(ring: &Keyring, v: &Value) -> Result<Record> {
    let field = |name: &str| {
        v.get(name)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let collection = field("collection");
    let id = field("id");
    let deleted = v.get("deleted").and_then(Value::as_bool).unwrap_or(false);
    let mut text = None;
    let mut unreadable = false;
    let mut damaged = false;
    if let Some(blob) = v.get("blob").and_then(Value::as_str) {
        match unb64(blob) {
            Ok(sealed) => match ring.open(PURPOSE, &place(&collection, &id), &sealed) {
                Ok(plain) => text = Some(String::from_utf8_lossy(&plain).into_owned()),
                Err(_) if ring.awaits(&sealed) => unreadable = true,
                Err(_) => damaged = true,
            },
            Err(_) => damaged = true,
        }
    }
    Ok(Record {
        collection,
        id,
        version: v.get("version").and_then(Value::as_u64).unwrap_or(0),
        seq: v.get("seq").and_then(Value::as_u64).unwrap_or(0),
        deleted,
        text,
        unreadable,
        damaged,
        refs: v.get("refs").and_then(Value::as_u64).unwrap_or(0),
        device: v.get("device").and_then(Value::as_str).map(str::to_string),
        updated_at: v.get("updatedAt").and_then(Value::as_u64),
        info: v.get("info").filter(|i| i.is_object()).cloned(),
    })
}

pub async fn get(api: &Api, ring: &Keyring, collection: &str, id: &str) -> Result<Option<Record>> {
    let reply = api
        .call(
            reqwest::Method::GET,
            &format!("records/{collection}/{id}"),
            super::api::Body::None,
        )
        .await?;
    if reply.status == 404 {
        return Ok(None);
    }
    Ok(Some(parse(ring, &reply.into_ok()?)?))
}

/// Records changed after `since`, oldest change first. A page that left content out (the reply
/// was getting large) has it fetched here, so callers always get the text.
pub async fn changes(api: &Api, ring: &Keyring, since: u64) -> Result<Changes> {
    let v = api.get(&format!("records?since={since}")).await?;
    let mut records = Vec::new();
    for r in v
        .get("records")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let mut record = parse(ring, r)?;
        if !record.deleted && record.text.is_none() && !record.unreadable && !record.damaged {
            if let Some(full) = get(api, ring, &record.collection, &record.id).await? {
                // Only when it is still the version this page spoke of; a later one comes later.
                if full.version == record.version {
                    record = Record {
                        seq: record.seq,
                        ..full
                    };
                }
            }
        }
        records.push(record);
    }
    let number = |name: &str| v.get(name).and_then(Value::as_u64).unwrap_or(0);
    Ok(Changes {
        epoch: number("epoch"),
        seq: number("seq"),
        gc_epoch: number("gcEpoch"),
        more: v.get("more").and_then(Value::as_bool).unwrap_or(false),
        records,
    })
}

/// Writes a record over `expect` (None: it must not exist yet). `text` None deletes it.
/// `refs` are the chunks it needs, with the sweep count they were checked under.
pub async fn put(
    api: &Api,
    ring: &Keyring,
    collection: &str,
    id: &str,
    expect: Option<u64>,
    text: Option<&str>,
    refs: Option<(&[String], u64)>,
) -> Result<Put> {
    put_labeled(api, ring, collection, id, expect, text, refs, None).await
}

/// `put`, with a label the service can read (`info`: a flat object of text, numbers, yes/no).
#[allow(clippy::too_many_arguments)]
pub async fn put_labeled(
    api: &Api,
    ring: &Keyring,
    collection: &str,
    id: &str,
    expect: Option<u64>,
    text: Option<&str>,
    refs: Option<(&[String], u64)>,
    info: Option<&Value>,
) -> Result<Put> {
    let mut body = json!({ "expect": expect });
    if let (Some(info), Some(_)) = (info, text) {
        body["info"] = info.clone();
    }
    match text {
        Some(t) => {
            body["blob"] = json!(b64(&ring.seal(
                PURPOSE,
                &place(collection, id),
                t.as_bytes()
            )?))
        }
        None => body["deleted"] = json!(true),
    }
    if let (Some((ids, gc_epoch)), Some(_)) = (refs, text) {
        body["refs"] = json!(ids);
        body["gcEpoch"] = json!(gc_epoch);
    }
    let reply = api
        .put(&format!("records/{collection}/{id}"), &body)
        .await?;
    if reply.status == 409 && reply.error() == "conflict" {
        let current = match reply.json.get("current") {
            Some(Value::Null) | None => None,
            Some(c) => Some(parse(ring, c)?),
        };
        return Ok(Put::Conflict { current });
    }
    if reply.status == 409 && reply.error() == "gc" {
        return Ok(Put::Gc {
            gc_epoch: reply
                .json
                .get("gcEpoch")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        });
    }
    let v = reply.into_ok()?;
    Ok(Put::Done {
        version: v.get("version").and_then(Value::as_u64).unwrap_or(0),
        seq: v.get("seq").and_then(Value::as_u64).unwrap_or(0),
    })
}

/// Reads a record, changes it and writes it back, again when someone else wrote in between.
pub async fn update<F>(
    api: &Api,
    ring: &Keyring,
    collection: &str,
    id: &str,
    mut change: F,
) -> Result<()>
where
    F: FnMut(Option<&str>) -> Option<String>,
{
    for _ in 0..6 {
        let now = get(api, ring, collection, id).await?;
        let before = now
            .as_ref()
            .filter(|r| !r.deleted)
            .and_then(|r| r.text.as_deref());
        let Some(next) = change(before) else {
            return Ok(());
        };
        match put(
            api,
            ring,
            collection,
            id,
            now.as_ref().map(|r| r.version),
            Some(&next),
            None,
        )
        .await?
        {
            Put::Done { .. } => return Ok(()),
            Put::Conflict { .. } | Put::Gc { .. } => continue,
        }
    }
    Err(Error::Sync(
        "Sync",
        "A synced item kept changing; try again.".into(),
    ))
}
