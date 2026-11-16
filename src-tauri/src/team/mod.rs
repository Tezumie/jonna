//! A team's library: what a team publishes on purpose so every member's IDE works the same way
//! (rules, skills, commands, agents, output styles, snippets, a list of MCP servers, default
//! settings, recommended extensions). The accounts server keeps it under `/api/team/`, in the
//! signed-in account's name (the client is sync's, `sync::api`); this computer keeps a copy
//! (`cache`) and the front end decides which items are on.
//!
//! A library comes from other people. Nothing it says is trusted to name a place: every item's
//! kind and name is checked here again (`paths`), what is taken is capped, and unknown kinds are
//! left out. What an item may *do* once it is on is the front end's (no user-level trust).

pub mod cache;
pub mod paths;

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};
use crate::sync::api::{Api, Body, Reply};

/// The service's own limits, kept to here whatever it sends.
pub const MAX_ITEMS: usize = 500;
pub const MAX_ITEM_BYTES: u64 = 256 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TeamRef {
    pub id: String,
    pub name: String,
}

/// One item of the library, without its text.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub kind: String,
    pub path: String,
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub version: u64,
    #[serde(default)]
    pub size: u64,
    /// Who published this version, as the service names them.
    #[serde(default)]
    pub by: String,
    /// When, in ms.
    #[serde(default)]
    pub updated_at: Option<u64>,
}

/// The library as the service lists it, after the checks.
#[derive(Debug, PartialEq, Eq)]
pub struct Listing {
    pub team: TeamRef,
    pub state: String,
    pub items: Vec<Item>,
}

/// What a publish came to.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum Put {
    Published {
        id: String,
        version: u64,
    },
    /// Someone published a newer version meanwhile: nothing was written. `current` is theirs.
    Conflict {
        current: Option<Item>,
        text: Option<String>,
    },
}

fn text_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn number_of(value: &Value, key: &str) -> Option<u64> {
    let v = value.get(key)?;
    v.as_u64()
        .or_else(|| v.as_f64().filter(|n| *n >= 0.0).map(|n| n as u64))
}

/// One listed item, when it is one this build can use: a known kind, a name of that kind's
/// shape, an id that is one, a size within the limit.
fn item_of(value: &Value) -> Option<Item> {
    let id = text_of(value, "id");
    let kind = text_of(value, "kind");
    let path = text_of(value, "path");
    let size = number_of(value, "size").unwrap_or(0);
    if !paths::valid_id(&id)
        || !paths::KINDS.contains(&kind.as_str())
        || paths::check(&kind, &path).is_none()
        || size > MAX_ITEM_BYTES
    {
        return None;
    }
    // A name, never markup or a line of its own: it is shown.
    let by: String = text_of(value, "by")
        .chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect();
    Some(Item {
        id,
        kind,
        path,
        is_default: value.get("isDefault").and_then(Value::as_bool) == Some(true),
        version: number_of(value, "version").unwrap_or(0),
        size,
        by,
        updated_at: number_of(value, "updatedAt"),
    })
}

/// The library a reply lists, with what can't be used left out and the limits kept: at most
/// `MAX_ITEMS` items and `MAX_TOTAL_BYTES` of them, one item per id and per name.
pub fn parse_listing(json: &Value) -> Option<Listing> {
    let team = json.get("team")?;
    let id = match team.get("id")? {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    if id.is_empty() {
        return None;
    }
    let name: String = text_of(team, "name")
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect();
    let mut items = Vec::new();
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    let mut bytes = 0u64;
    for value in json
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if items.len() >= MAX_ITEMS {
            break;
        }
        let Some(item) = item_of(value) else {
            continue;
        };
        // The same name twice would be one file here; names differing only by case too, on
        // the file systems that don't tell them apart.
        // (Whatever its kind: the name alone says where the file goes.)
        let name_key = item.path.to_lowercase();
        if ids.contains(&item.id) || names.contains(&name_key) {
            continue;
        }
        if bytes + item.size > MAX_TOTAL_BYTES {
            break;
        }
        bytes += item.size;
        ids.insert(item.id.clone());
        names.insert(name_key);
        items.push(item);
    }
    // A name that is also a folder of another item's (`skills/a/b` beside `skills/a/b/c.md`)
    // can't be both a file and a folder here: the file is left out, like any other name that
    // can't be used, so the rest of the library still applies.
    items.retain(|item| {
        let folder = format!("{}/", item.path.to_lowercase());
        !names.iter().any(|other| other.starts_with(&folder))
    });
    Some(Listing {
        team: TeamRef { id, name },
        state: if text_of(json, "state") == "lapsed" {
            "lapsed".into()
        } else {
            "on".into()
        },
        items,
    })
}

/// What a refusal means to the person using it.
fn refusal(status: u16, json: &Value) -> Error {
    let code = json.get("error").and_then(Value::as_str).unwrap_or("");
    let said = json
        .get("error_description")
        .and_then(Value::as_str)
        .unwrap_or("The service refused the request.")
        .to_string();
    match (status, code) {
        (401, _) => Error::Sync(
            "TeamSignedOut",
            "Sign in again to use the team's library.".into(),
        ),
        (404, "no_team") => Error::Sync("TeamNone", "This account isn't in a team.".into()),
        (403, "not_publisher") => Error::Sync(
            "TeamNotPublisher",
            "Only the team's publishers can change its library.".into(),
        ),
        (402, "sync_lapsed") => Error::Sync(
            "TeamLapsed",
            "The team's subscription ended: its library can be read, not changed.".into(),
        ),
        (409, "name_taken") => Error::Sync(
            "TeamNameTaken",
            "Another item of the library already has that name.".into(),
        ),
        (409, _) => Error::Sync(
            "TeamConflict",
            "Someone changed that item meanwhile. Refresh the library and try again.".into(),
        ),
        (413, _) => Error::Sync(
            "TeamTooLarge",
            "That is too large for the library (256 KiB an item at most).".into(),
        ),
        (507, _) => Error::Sync("TeamFull", "The team's library is full.".into()),
        (404, _) => Error::Sync(
            "TeamMissing",
            "That item isn't in the library any more.".into(),
        ),
        (429, _) => Error::Sync(
            "TeamOffline",
            "The service is pausing for a moment (too many requests).".into(),
        ),
        (s, _) if s >= 500 => Error::Sync(
            "TeamOffline",
            "The service has a problem; trying again later.".into(),
        ),
        (400, _) => Error::Sync("TeamInvalid", said),
        _ => Error::Sync("Team", said),
    }
}

fn ok(reply: Reply) -> Result<Value> {
    if reply.ok() {
        return Ok(reply.json);
    }
    Err(refusal(reply.status, &reply.json))
}

/// The client for a team's library, in the signed-in account's name.
pub fn api(base: &str, data_dir: &std::path::Path) -> Api {
    Api::of("team", base, data_dir)
}

/// The library's list (no text). None when the account is in no team.
pub async fn listing(api: &Api) -> Result<Option<Listing>> {
    let reply = api
        .call(reqwest::Method::GET, "library", Body::None)
        .await?;
    if reply.status == 404 && reply.error() == "no_team" {
        return Ok(None);
    }
    let json = ok(reply)?;
    parse_listing(&json)
        .map(Some)
        .ok_or_else(|| Error::Sync("Team", "The service's answer couldn't be read.".into()))
}

/// One item's text and the version it is. Refused when it is larger than an item may be.
pub async fn item_text(api: &Api, id: &str) -> Result<(u64, String)> {
    if !paths::valid_id(id) {
        return Err(Error::Invalid(format!("not an item of the library: {id}")));
    }
    let json = ok(api
        .call(reqwest::Method::GET, &format!("library/{id}"), Body::None)
        .await?)?;
    let text = json
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Sync("Team", "The service's answer couldn't be read.".into()))?;
    if text.len() as u64 > MAX_ITEM_BYTES {
        return Err(Error::Sync(
            "TeamTooLarge",
            format!("An item of the library is larger than an item may be: {id}"),
        ));
    }
    Ok((number_of(&json, "version").unwrap_or(0), text.to_string()))
}

/// Publishes an item over the version it was made from (`expect`; None: it must be new).
pub async fn put(
    api: &Api,
    id: &str,
    kind: &str,
    path: &str,
    text: &str,
    is_default: bool,
    expect: Option<u64>,
) -> Result<Put> {
    if !paths::valid_id(id) || paths::check(kind, path).is_none() {
        return Err(Error::Invalid(format!(
            "not a name the library takes: {kind} {path}"
        )));
    }
    if text.len() as u64 > MAX_ITEM_BYTES {
        return Err(refusal(413, &Value::Null));
    }
    let body = serde_json::json!({
        "kind": kind,
        "path": path,
        "text": text,
        "isDefault": is_default,
        "expect": expect,
    });
    let reply = api.put(&format!("library/{id}"), &body).await?;
    if reply.status == 409 && reply.error() == "conflict" {
        let current = reply.json.get("current");
        return Ok(Put::Conflict {
            current: current.and_then(item_of),
            text: current
                .and_then(|c| c.get("text"))
                .and_then(Value::as_str)
                .filter(|t| t.len() as u64 <= MAX_ITEM_BYTES)
                .map(str::to_string),
        });
    }
    let json = ok(reply)?;
    Ok(Put::Published {
        id: id.to_string(),
        version: number_of(&json, "version").unwrap_or(0),
    })
}

/// Takes an item out of the library. Whether one was there.
pub async fn delete(api: &Api, id: &str) -> Result<bool> {
    if !paths::valid_id(id) {
        return Err(Error::Invalid(format!("not an item of the library: {id}")));
    }
    let json = ok(api
        .call(
            reqwest::Method::DELETE,
            &format!("library/{id}"),
            Body::None,
        )
        .await?)?;
    Ok(json.get("removed").and_then(Value::as_bool) != Some(false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn listed(id: &str, kind: &str, path: &str) -> Value {
        json!({ "id": id, "kind": kind, "path": path, "isDefault": true, "version": 2,
                "size": 10, "by": "Ada", "updatedAt": 1_800_000_000_000u64 })
    }

    #[test]
    fn a_listing_keeps_what_this_build_can_use() {
        let reply = json!({
            "team": { "id": "t1", "name": "Studio", "role": "member" },
            "state": "on",
            "items": [
                listed("a", "rules", "AGENTS.md"),
                listed("b", "skills", "skills/review/SKILL.md"),
                // Left out: a kind this build doesn't read, names that leave the folder or
                // fit no kind, an id that isn't one, an item larger than one may be, the
                // same id or the same name again.
                listed("c", "providers", "providers.json"),
                listed("d", "hooks", "hooks.json"),
                listed("e", "skills", "skills/../../x"),
                listed("f", "commands", "commands/x.sh"),
                listed("../g", "commands", "commands/g.md"),
                json!({ "id": "h", "kind": "commands", "path": "commands/h.md", "size": 300_000 }),
                listed("a", "commands", "commands/again.md"),
                listed("i", "skills", "skills/Review/skill.md"),
                json!("not an item"),
                listed("j", "commands", "commands/ship.md"),
            ],
        });
        let listing = parse_listing(&reply).unwrap();
        assert_eq!(listing.team.id, "t1");
        assert_eq!(listing.state, "on");
        let ids: Vec<&str> = listing.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["a", "b", "j"]);
        assert_eq!(listing.items[0].by, "Ada");
        assert!(listing.items[0].is_default);
        assert_eq!(listing.items[0].updated_at, Some(1_800_000_000_000));
        // Without a team there is nothing to read.
        assert_eq!(parse_listing(&json!({ "items": [] })), None);
        assert_eq!(
            parse_listing(&json!({ "team": { "id": "t1" }, "state": "lapsed" }))
                .unwrap()
                .state,
            "lapsed"
        );
    }

    #[test]
    fn a_name_that_is_also_another_items_folder_is_left_out() {
        let reply = json!({
            "team": { "id": "t1" },
            "items": [
                // A file and a folder of the same name, in either order and in other case.
                listed("a", "skills", "skills/review/notes"),
                listed("b", "skills", "skills/review/notes/style.md"),
                listed("c", "skills", "skills/Lint/Rules/deep/x.md"),
                listed("d", "skills", "skills/lint/rules"),
                // Only the start of a name, not a folder of it: both stay.
                listed("e", "skills", "skills/review/notes.md"),
                listed("f", "skills", "skills/review/SKILL.md"),
                // The same name in other case: the first stays.
                listed("g", "commands", "commands/Ship.md"),
                listed("h", "commands", "commands/ship.md"),
            ],
        });
        let listing = parse_listing(&reply).unwrap();
        let ids: Vec<&str> = listing.items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["b", "c", "e", "f", "g"]);
    }

    #[test]
    fn a_listing_is_capped() {
        let many: Vec<Value> = (0..MAX_ITEMS + 50)
            .map(|n| listed(&format!("i{n}"), "commands", &format!("commands/c{n}.md")))
            .collect();
        let listing = parse_listing(&json!({ "team": { "id": "t1" }, "items": many })).unwrap();
        assert_eq!(listing.items.len(), MAX_ITEMS);
        // Sizes that add up past the library's size: the rest is left out.
        let heavy: Vec<Value> = (0..200)
            .map(|n| {
                json!({ "id": format!("i{n}"), "kind": "commands",
                        "path": format!("commands/c{n}.md"), "size": MAX_ITEM_BYTES })
            })
            .collect();
        let listing = parse_listing(&json!({ "team": { "id": "t1" }, "items": heavy })).unwrap();
        assert_eq!(listing.items.len() as u64, MAX_TOTAL_BYTES / MAX_ITEM_BYTES);
    }

    #[test]
    fn refusals_have_their_own_codes() {
        let code = |status, error: &str| match refusal(status, &json!({ "error": error })) {
            Error::Sync(code, _) => code,
            other => panic!("unexpected: {other:?}"),
        };
        assert_eq!(code(403, "not_publisher"), "TeamNotPublisher");
        assert_eq!(code(402, "sync_lapsed"), "TeamLapsed");
        assert_eq!(code(409, "name_taken"), "TeamNameTaken");
        assert_eq!(code(409, "conflict"), "TeamConflict");
        assert_eq!(code(413, "too_large"), "TeamTooLarge");
        assert_eq!(code(507, "library_full"), "TeamFull");
        assert_eq!(code(400, "invalid_request"), "TeamInvalid");
        assert_eq!(code(404, "no_team"), "TeamNone");
        assert_eq!(code(401, ""), "TeamSignedOut");
        assert_eq!(code(503, ""), "TeamOffline");
    }
}
