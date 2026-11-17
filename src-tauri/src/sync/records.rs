//! Encrypted records: small named items (a settings map, a chat's entry, a snapshot's entry),
//! each with a version the server counts. A write names the version it was made from; when
//! someone else wrote in between, the caller gets the other version to merge with.

//!
//! Opening with the account's keys isn't all a record must pass. The service could hand back
//! a record under another's name, an older version of it, or one sealed with keys from before
//! a device was removed. So: a record is opened under the name that was asked for; every record
//! carries a counter inside its sealed text that only goes up (`seen`), and a copy with a
//! lower one than this computer has seen is never used; and a collection may have a floor, a
//! key generation below which nothing is taken (`Checks`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

use super::api::Api;
use super::crypto::{b64, unb64, Keyring};
use super::seen::{self, Found};
use crate::error::{Error, Result};

const PURPOSE: &str = "records";

/// What a record read through an `Api` must pass beyond opening with the keys.
#[derive(Debug, Clone, Default)]
pub struct Checks {
    /// Where the counters this computer has seen are kept (None: nothing is compared).
    pub seen: Option<PathBuf>,
    /// Every computer of the account writes counters (the trusted list says so), so a record
    /// without one, where one was seen, is an older copy. While some computer runs a version
    /// from before the counters, a record without one is taken as that computer's write.
    pub strict: bool,
    /// By collection: the key generation below which a record isn't taken (after a device
    /// was removed, the records of these collections were sealed again with the new keys).
    pub floors: BTreeMap<String, u32>,
}

impl Checks {
    pub fn of(data_dir: &Path) -> Self {
        Self {
            seen: Some(data_dir.join("sync").join("seen.json")),
            ..Default::default()
        }
    }
}

/// What a record's counter says about it, against the highest this computer has seen.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    Take,
    /// No counter, from a computer on an older version: taken, and what was seen is forgotten
    /// (so the record isn't refused later for it).
    TakeAndForget,
    /// An older copy than one this computer has seen.
    Stale,
}

fn verdict(counter: u64, highest: u64, strict: bool) -> Verdict {
    match (counter, highest) {
        (0, 0) => Verdict::Take,
        (0, _) if strict => Verdict::Stale,
        (0, _) => Verdict::TakeAndForget,
        (c, h) if c < h => Verdict::Stale,
        _ => Verdict::Take,
    }
}

const COUNTER_FIELD: &str = "{\"~n\":";

/// `text` (a JSON object, as every record is) with its counter as the first field. Readers
/// from before the counters skip a field they don't know. None: not an object, sent as it is.
fn with_counter(text: &str, counter: u64) -> Option<String> {
    let rest = text.strip_prefix('{')?;
    let comma = if rest.trim_start().starts_with('}') {
        ""
    } else {
        ","
    };
    Some(format!("{COUNTER_FIELD}{counter}{comma}{rest}"))
}

/// A record's text without its counter, and the counter (0: it carries none).
fn split_counter(text: &str) -> (u64, String) {
    let Some(rest) = text.strip_prefix(COUNTER_FIELD) else {
        return (0, text.to_string());
    };
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    let (Ok(counter), after) = (rest[..digits].parse::<u64>(), &rest[digits..]) else {
        return (0, text.to_string());
    };
    match after.strip_prefix(',') {
        Some(fields) => (counter, format!("{{{fields}")),
        None if after.trim_start().starts_with('}') => (counter, format!("{{{after}")),
        None => (0, text.to_string()),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// The counter of a write over a record whose highest seen is `highest`: above it, and never
/// below the time. A computer that never saw the record (it was removed from the account and
/// is made again) so still writes above what any computer wrote before.
fn next_counter(highest: u64, now_ms: u64) -> u64 {
    highest.saturating_add(1).max(now_ms)
}

/// The name a keyring's counters are kept under: another vault, or a share, has its own.
fn scope(ring: &Keyring) -> Result<String> {
    ring.name_of("counters seen")
}

fn stale() -> Error {
    Error::Sync(
        "SyncStale",
        "The sync service gave back an older copy of a synced item; it wasn't used.".into(),
    )
}

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
    /// An older copy than one this computer has seen, or sealed with keys from before the
    /// collection's floor: its content is never used (no text), and the next write replaces it.
    pub stale: bool,
    /// The key generation it was sealed under, when it opened.
    #[serde(skip)]
    pub generation: Option<u32>,
    /// How many chunks it names.
    pub refs: u64,
    pub device: Option<String>,
    pub updated_at: Option<u64>,
    /// The record's label, readable by the service (a project's name, a snapshot's date and
    /// size): what the account page lists. Not sealed, so never trusted for anything here.
    pub info: Option<Value>,
    /// Marked to keep from the account page (a snapshot pinned there): history never removes
    /// it. The service's mark, beside the record: not sealed, and not part of its content.
    pub keep: bool,
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

/// A collection's name as the service takes one: letters, digits, `:`, `.`, `_` and `-`, at
/// most 80, and not `.` or `..`.
pub fn valid_collection(text: &str) -> bool {
    (1..=80).contains(&text.len())
        && text != "."
        && text != ".."
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '.' | '_' | '-'))
}

/// A record's id as the service takes one: letters, digits, `_`, `-` and `.`, at most 80,
/// not starting with a dot.
pub fn valid_id(text: &str) -> bool {
    (1..=80).contains(&text.len())
        && !text.starts_with('.')
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

/// The one place every call that names a record goes through, before anything is asked:
/// both names go into an address, where `x/../sys` would be read as another record (the
/// account's own keys) than the one a caller was allowed to name. A name is one part of
/// the address or it is refused.
pub fn named(collection: &str, id: &str) -> Result<()> {
    if valid_collection(collection) && valid_id(id) {
        return Ok(());
    }
    Err(Error::Invalid("that isn't a synced item's name".into()))
}

/// Whether the service marks a record as one to keep. Only a plain `true` counts: a reply
/// without the mark (an older service), or with anything else in its place, keeps nothing.
fn kept(v: &Value) -> bool {
    v.get("keep").and_then(Value::as_bool).unwrap_or(false)
}

/// Sets or clears the service's "keep" mark on a record (a snapshot pinned from the account
/// page). The record's content and version are untouched.
pub async fn set_keep(api: &Api, collection: &str, id: &str, keep: bool) -> Result<()> {
    named(collection, id)?;
    api.post(
        "keep",
        &json!({ "collection": collection, "id": id, "keep": keep }),
    )
    .await?
    .into_ok()?;
    Ok(())
}

/// What reading records needs beside the keys: the checks, the name the keyring's counters
/// are kept under, and what was found (kept by `Reading::keep` before anything is handed on).
struct Reading<'a> {
    ring: &'a Keyring,
    checks: &'a Checks,
    scope: String,
    found: Found,
}

impl<'a> Reading<'a> {
    fn new(ring: &'a Keyring, checks: &'a Checks) -> Result<Self> {
        Ok(Self {
            ring,
            checks,
            scope: scope(ring)?,
            found: Found::default(),
        })
    }

    fn keep(&mut self) -> Result<()> {
        match &self.checks.seen {
            Some(path) => seen::keep(path, &self.scope, std::mem::take(&mut self.found)),
            None => Ok(()),
        }
    }

    /// Whether a record that opened (sealed under `generation`, carrying `counter`) is the
    /// newest this computer knows of, noting what it found.
    fn current(&mut self, collection: &str, place: &str, generation: u32, counter: u64) -> bool {
        if self
            .checks
            .floors
            .get(collection)
            .is_some_and(|floor| generation < *floor)
        {
            return false;
        }
        let Some(path) = &self.checks.seen else {
            return true;
        };
        let highest = seen::highest(path, &self.scope, place);
        match verdict(counter, highest, self.checks.strict) {
            Verdict::Stale => false,
            Verdict::TakeAndForget => {
                self.found.forget(place);
                true
            }
            Verdict::Take => {
                if counter > highest {
                    self.found.raise(place, counter);
                }
                true
            }
        }
    }
}

/// A record out of a reply. `asked`: the name that was asked for. A reply that names another
/// record is refused, and the content is opened under the name asked, so a valid record of
/// another name never stands in for it. A page of changes has no name to compare with: each
/// record there is opened under the name it states, which is the name it then goes by.
fn parse(reading: &mut Reading, v: &Value, asked: Option<(&str, &str)>) -> Result<Record> {
    let field = |name: &str| {
        v.get(name)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let (collection, id) = match asked {
        Some((collection, id)) => {
            let named = |name: &str, asked: &str| {
                v.get(name)
                    .and_then(Value::as_str)
                    .is_none_or(|n| n == asked)
            };
            if !named("collection", collection) || !named("id", id) {
                return Err(super::api::unreadable());
            }
            (collection.to_string(), id.to_string())
        }
        None => (field("collection"), field("id")),
    };
    let deleted = v.get("deleted").and_then(Value::as_bool).unwrap_or(false);
    let mut text = None;
    let mut unreadable = false;
    let mut damaged = false;
    let mut stale = false;
    let mut generation = None;
    if let Some(blob) = v.get("blob").and_then(Value::as_str) {
        let place = place(&collection, &id);
        match unb64(blob) {
            Ok(sealed) => match reading.ring.open(PURPOSE, &place, &sealed) {
                Ok(plain) => {
                    let (counter, plain) = split_counter(&String::from_utf8_lossy(&plain));
                    generation = Keyring::generation_of(&sealed);
                    if reading.current(&collection, &place, generation.unwrap_or(0), counter) {
                        text = Some(plain);
                    } else {
                        stale = true;
                    }
                }
                Err(_) if reading.ring.awaits(&sealed) => unreadable = true,
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
        stale,
        generation,
        refs: v.get("refs").and_then(Value::as_u64).unwrap_or(0),
        device: v.get("device").and_then(Value::as_str).map(str::to_string),
        updated_at: v.get("updatedAt").and_then(Value::as_u64),
        info: v.get("info").filter(|i| i.is_object()).cloned(),
        keep: kept(v),
    })
}

/// One record, as the account has it. An older copy than one this computer has seen is an
/// error here: whoever asks for one record means to use it or to build on it.
pub async fn get(api: &Api, ring: &Keyring, collection: &str, id: &str) -> Result<Option<Record>> {
    match fetch(api, ring, collection, id).await? {
        Some(record) if record.stale => Err(stale()),
        other => Ok(other),
    }
}

/// The version a record is at, whatever is in it (None: it doesn't exist): for a write that
/// replaces a record knowingly, when what is there is exactly what couldn't be used.
pub async fn version(api: &Api, ring: &Keyring, collection: &str, id: &str) -> Result<Option<u64>> {
    Ok(fetch(api, ring, collection, id).await?.map(|r| r.version))
}

/// `get`, with an older copy handed back marked (`stale`, no text) instead of refused.
async fn fetch(api: &Api, ring: &Keyring, collection: &str, id: &str) -> Result<Option<Record>> {
    named(collection, id)?;
    let reply = api
        .call(
            reqwest::Method::GET,
            &format!("records/{collection}/{id}"),
            super::api::Body::None,
        )
        .await?;
    // (A share that is gone answers 404 too, with its own code: that isn't "no such record".)
    if reply.status == 404 && reply.error() != "no_share" {
        return Ok(None);
    }
    let v = reply.into_ok()?;
    // A body that isn't a record must never read as "a record with no content, version 0".
    if !v.is_object() || !v["version"].is_u64() {
        return Err(super::api::unreadable());
    }
    let mut reading = Reading::new(ring, &api.checks)?;
    let record = parse(&mut reading, &v, Some((collection, id)))?;
    reading.keep()?;
    Ok(Some(record))
}

/// A page of changes as the service gives it, refused when it isn't in the shape a page has:
/// a broken reply (which reads as `null`) must never look like "epoch 0", which is how an
/// account that was reset looks.
fn changes_page(v: &Value) -> Result<&Vec<Value>> {
    match (v["epoch"].as_u64(), v["records"].as_array()) {
        (Some(_), Some(records)) => Ok(records),
        _ => Err(super::api::unreadable()),
    }
}

/// Records changed after `since`, oldest change first. A page that left content out (the reply
/// was getting large) has it fetched here, so callers always get the text.
pub async fn changes(api: &Api, ring: &Keyring, since: u64) -> Result<Changes> {
    let v = api.get(&format!("records?since={since}")).await?;
    let mut records = Vec::new();
    let mut reading = Reading::new(ring, &api.checks)?;
    for r in changes_page(&v)? {
        let mut record = parse(&mut reading, r, None)?;
        // (A name the service made up that couldn't stand in an address is never asked for.)
        if !record.deleted
            && record.text.is_none()
            && !record.unreadable
            && !record.damaged
            && !record.stale
            && named(&record.collection, &record.id).is_ok()
        {
            if let Some(full) = fetch(api, ring, &record.collection, &record.id).await? {
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
    // Kept before the page is handed on: what is used now is refused as "older" never again.
    reading.keep()?;
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
    named(collection, id)?;
    let mut body = json!({ "expect": expect });
    if let (Some(info), Some(_)) = (info, text) {
        body["info"] = info.clone();
    }
    let place = place(collection, id);
    let mut reading = Reading::new(ring, &api.checks)?;
    // The counter this write carries: above the highest this computer has seen in the record.
    let mut counter = None;
    match text {
        Some(t) => {
            let counted = api.checks.seen.as_ref().and_then(|path| {
                let next = next_counter(seen::highest(path, &reading.scope, &place), now_ms());
                with_counter(t, next).map(|text| (next, text))
            });
            let sealed = match &counted {
                Some((next, text)) => {
                    counter = Some(*next);
                    ring.seal(PURPOSE, &place, text.as_bytes())?
                }
                None => ring.seal(PURPOSE, &place, t.as_bytes())?,
            };
            body["blob"] = json!(b64(&sealed));
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
            // Opened under the name that was written to, whatever the reply calls it.
            Some(c) => Some(parse(&mut reading, c, Some((collection, id)))?),
        };
        reading.keep()?;
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
    // Only now that the account has it: a counter noted for a write that never arrived
    // would make the record as it still is look older than what this computer has seen.
    if let Some(counter) = counter {
        reading.found.raise(&place, counter);
        reading.keep()?;
    }
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

/// Seals a record again when it was sealed with keys older than the newest (after a device
/// was removed: what the removed device's keys could make is then told from what the
/// account's computers hold now). Records that name chunks are left: their content is large
/// and a write here would drop the names. True: it is (now) sealed with the newest keys, or
/// there is nothing to seal.
pub async fn reseal(api: &Api, ring: &Keyring, collection: &str, id: &str) -> Result<bool> {
    for _ in 0..6 {
        let Some(now) = get(api, ring, collection, id).await? else {
            return Ok(true);
        };
        if now.deleted || now.damaged {
            return Ok(true);
        }
        let Some(text) = now.text.as_deref() else {
            return Ok(false);
        };
        if now.refs > 0 {
            return Ok(false);
        }
        if now.generation.is_some_and(|g| g >= ring.current()) {
            return Ok(true);
        }
        let label = now.info.as_ref();
        match put_labeled(
            api,
            ring,
            collection,
            id,
            Some(now.version),
            Some(text),
            None,
            label,
        )
        .await?
        {
            Put::Done { .. } => return Ok(true),
            Put::Conflict { .. } | Put::Gc { .. } => continue,
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sealed(ring: &Keyring, collection: &str, id: &str, text: &str) -> String {
        b64(&ring
            .seal(PURPOSE, &place(collection, id), text.as_bytes())
            .unwrap())
    }

    fn checks(name: &str) -> Checks {
        let dir = std::env::temp_dir().join(format!("ide-records-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        Checks::of(&dir)
    }

    #[test]
    fn a_reply_is_opened_under_the_name_that_was_asked_for() {
        let ring = Keyring::generate().unwrap();
        let checks = Checks::default();
        let mut reading = Reading::new(&ring, &checks).unwrap();
        // Project B's snapshot, a valid record of this account.
        let other = json!({
            "collection": "snap.B", "id": "y", "version": 4,
            "blob": sealed(&ring, "snap.B", "y", "{\"files\":[]}"),
        });
        // Asked for by its own name: read.
        let own = parse(&mut reading, &other, Some(("snap.B", "y"))).unwrap();
        assert_eq!(own.text.as_deref(), Some("{\"files\":[]}"));
        // Handed back for another name: refused, whatever the reply calls itself.
        assert!(parse(&mut reading, &other, Some(("snap.A", "x"))).is_err());
        let renamed = json!({
            "collection": "snap.A", "id": "x", "version": 4,
            "blob": other["blob"],
        });
        let as_a = parse(&mut reading, &renamed, Some(("snap.A", "x"))).unwrap();
        assert!(
            as_a.text.is_none() && as_a.damaged,
            "B's content never reads as A's"
        );
        // A reply without names is opened under the names asked.
        let unnamed = json!({ "version": 4, "blob": other["blob"] });
        let read = parse(&mut reading, &unnamed, Some(("snap.B", "y"))).unwrap();
        assert_eq!(
            (read.collection.as_str(), read.id.as_str()),
            ("snap.B", "y")
        );
        assert!(read.text.is_some());
    }

    #[test]
    fn the_counter_travels_inside_the_text_and_comes_off_again() {
        assert_eq!(
            with_counter("{\"keys\":{}}", 7).as_deref(),
            Some("{\"~n\":7,\"keys\":{}}")
        );
        assert_eq!(with_counter("{}", 7).as_deref(), Some("{\"~n\":7}"));
        assert_eq!(with_counter("[1]", 7), None);
        for text in ["{\"keys\":{\"a\":1}}", "{}", "{ }", "{\"~x\":1}"] {
            let counted = with_counter(text, 1_800_000_000_123).unwrap();
            // What an older version reads is still the same object, with a field it skips.
            let old: Value = serde_json::from_str(&counted).unwrap();
            assert_eq!(old["~n"], 1_800_000_000_123u64);
            assert_eq!(
                split_counter(&counted),
                (1_800_000_000_123, text.to_string())
            );
        }
        // Text from before the counters, or anything that only looks like one, is left alone.
        for text in [
            "{\"keys\":{}}",
            "{\"~n\":x}",
            "{\"~n\":5",
            "{\"~n\":5x}",
            "[]",
        ] {
            assert_eq!(split_counter(text), (0, text.to_string()), "{text}");
        }
        assert_eq!(next_counter(5, 3), 6);
        assert_eq!(next_counter(5, 900), 900);
        assert_eq!(next_counter(u64::MAX, 1), u64::MAX);
    }

    #[test]
    fn an_older_copy_than_one_seen_is_stale() {
        assert_eq!(verdict(0, 0, true), Verdict::Take);
        assert_eq!(verdict(5, 0, true), Verdict::Take);
        assert_eq!(verdict(5, 5, true), Verdict::Take);
        assert_eq!(verdict(6, 5, false), Verdict::Take);
        assert_eq!(verdict(4, 5, true), Verdict::Stale);
        assert_eq!(verdict(4, 5, false), Verdict::Stale);
        // No counter where one was seen: an older copy once every computer writes them; a
        // computer on an older version's write until then.
        assert_eq!(verdict(0, 5, true), Verdict::Stale);
        assert_eq!(verdict(0, 5, false), Verdict::TakeAndForget);
    }

    #[test]
    fn a_replayed_record_is_never_used_and_the_counter_outlives_the_reading() {
        let ring = Keyring::generate().unwrap();
        let mut checks = checks("replay");
        checks.strict = true;
        let reply = |text: &str, version: u64| {
            json!({
                "collection": "files", "id": "a", "version": version,
                "blob": sealed(&ring, "files", "a", text),
            })
        };
        let old = reply(&with_counter("{\"deleted\":true}", 100).unwrap(), 3);
        let new = reply(&with_counter("{\"content\":\"x\"}", 200).unwrap(), 4);
        let bare = reply("{\"deleted\":true}", 2);
        let read_with = |checks: &Checks, v: &Value| {
            let mut reading = Reading::new(&ring, checks).unwrap();
            let record = parse(&mut reading, v, None).unwrap();
            reading.keep().unwrap();
            record
        };
        let read = |v: &Value| read_with(&checks, v);
        // In order: each is the newest when it is read.
        assert_eq!(read(&old).text.as_deref(), Some("{\"deleted\":true}"));
        assert_eq!(read(&new).text.as_deref(), Some("{\"content\":\"x\"}"));
        // The old tombstone again, and one from before the counters: older copies.
        for replayed in [&old, &bare] {
            let record = read(replayed);
            assert!(record.stale && record.text.is_none() && !record.unreadable);
        }
        // The newest again (the same page read twice) is still the newest.
        assert!(read(&new).text.is_some());
        // Another record is its own count.
        let other = json!({
            "collection": "files", "id": "b", "version": 1,
            "blob": sealed(&ring, "files", "b", "{}"),
        });
        assert!(read(&other).text.is_some());
        // While a computer on an older version may still write: its write is taken, and the
        // record starts again from nothing.
        let mut lenient = checks.clone();
        lenient.strict = false;
        assert!(read_with(&lenient, &bare).text.is_some());
        assert!(read_with(&lenient, &old).text.is_some());
        if let Some(path) = &checks.seen {
            let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
        }
    }

    #[test]
    fn a_record_sealed_below_its_collections_floor_is_never_used() {
        let ring = Keyring::generate().unwrap();
        let next = ring.rotated().unwrap();
        let mut checks = Checks::default();
        let old = json!({
            "collection": "sys", "id": "devices", "version": 9,
            "blob": sealed(&ring, "sys", "devices", "{\"devices\":[]}"),
        });
        let read = |checks: &Checks, v: &Value| {
            let mut reading = Reading::new(&next, checks).unwrap();
            parse(&mut reading, v, None).unwrap()
        };
        // The newer keyring holds the older generation: without a floor it opens.
        let record = read(&checks, &old);
        assert_eq!(record.generation, Some(1));
        assert!(record.text.is_some());
        // With the floor (the list was sealed again after a device was removed): refused.
        checks.floors.insert("sys".into(), 2);
        let record = read(&checks, &old);
        assert!(record.stale && record.text.is_none());
        // Other collections have no floor, and what is sealed with the new keys passes.
        let chat = json!({
            "collection": "chats.p", "id": "c", "version": 1,
            "blob": sealed(&ring, "chats.p", "c", "{}"),
        });
        assert!(read(&checks, &chat).text.is_some());
        let new = json!({
            "collection": "sys", "id": "devices", "version": 10,
            "blob": sealed(&next, "sys", "devices", "{\"devices\":[]}"),
        });
        assert!(read(&checks, &new).text.is_some());
    }

    #[test]
    fn only_a_plain_yes_marks_a_record_to_keep() {
        assert!(kept(&json!({ "id": "a", "keep": true })));
        for not in [
            json!({ "id": "a" }),
            json!({ "id": "a", "keep": false }),
            json!({ "id": "a", "keep": null }),
            json!({ "id": "a", "keep": "true" }),
            json!({ "id": "a", "keep": 1 }),
        ] {
            assert!(!kept(&not), "{not}");
        }
    }

    #[test]
    fn a_records_name_is_one_part_of_an_address_or_refused() {
        for (collection, id) in [
            ("settings", "user"),
            ("sys", "member"),
            ("shares", "AbC-123_x"),
            ("snap.AbCdEfGhIjKlMnOpQrStUv", "1800000000000-abc123"),
            ("chats:p.1", "a.b"),
            (&"c".repeat(80)[..], &"i".repeat(80)[..]),
        ] {
            assert!(named(collection, id).is_ok(), "{collection}/{id}");
        }
        for (collection, id) in [
            // Another record than the one named, once the address is read.
            ("x/../sys", "member"),
            ("..", "member"),
            (".", "member"),
            ("sys/member", "x"),
            ("x", "../sys/member"),
            ("x", ".."),
            ("x", "."),
            ("x", ".hidden"),
            ("x", "a/b"),
            ("x\\..\\sys", "member"),
            ("sys%2Fmember", "x"),
            ("x", "member?since=0"),
            ("x", "member#"),
            ("x y", "member"),
            ("x", "mem ber"),
            ("x", "é"),
            ("", "member"),
            ("x", ""),
            (&"c".repeat(81)[..], "x"),
            ("x", &"i".repeat(81)[..]),
        ] {
            assert!(
                matches!(named(collection, id), Err(Error::Invalid(_))),
                "{collection}/{id}"
            );
        }
    }

    #[test]
    fn a_page_of_changes_must_have_its_shape() {
        let page = json!({ "epoch": 3, "seq": 9, "gcEpoch": 1, "more": false, "records": [] });
        assert!(changes_page(&page).is_ok_and(Vec::is_empty));
        // A body that could not be read, or lacks the count or the list: the same as offline,
        // never "epoch 0" (an account that was reset).
        for broken in [
            Value::Null,
            json!({}),
            json!({ "records": [] }),
            json!({ "epoch": 3 }),
            json!({ "epoch": "3", "records": [] }),
            json!({ "epoch": 3, "records": {} }),
            json!("<html>"),
        ] {
            match changes_page(&broken) {
                Err(Error::Sync(code, _)) => assert_eq!(code, "SyncOffline", "{broken}"),
                other => panic!("unexpected for {broken}: {other:?}"),
            }
        }
    }
}
