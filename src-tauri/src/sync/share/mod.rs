//! Sharing a project with a team (`docs/sync.md`, "Sharing a project with a team"): a share is
//! a small vault of its own that the sharer's computer writes snapshots into and the team's
//! members read. The service stores it and decides who may ask; it never has a key.
//!
//! - `keys`: a member's fingerprint; a share's keyring boxed from the sharer's member key to
//!   one member's (a wrap), and how a wrap is opened.
//! - `pins`: whose key is whose. Each teammate's key as first seen, and whether it was verified.
//! - `plan`: what the sharer's computer decides: key files, a remote's address, what to do
//!   about a share's keys.
//! - here: what an account keeps (its member key, the pins) and the team as the service lists
//!   it. `sharer`: starting a share, its keys, its snapshots. `reader`: opening one and
//!   reading it. Everything is in the signed-in account's name.
//!
//! What this account keeps, sealed in its own vault (so each of its computers and the recovery
//! key have it): `sys/member` (its member key pair), `sys/team` (the pins), and
//! `shares/<project>` (the keyring of each project it shares).
//!
//! Nothing a share holds is trusted: ids are checked before they go into an address, names
//! are cleaned before they are shown, paths go through the snapshot code's own rules, and a
//! remote's address is used only when it is an ordinary one.

pub mod keys;
pub mod pins;
pub mod plan;
mod reader;
mod sharer;

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use self::keys::{fingerprint, split_share_id, valid_key, valid_record_id, valid_uid};
use self::pins::{reconcile, FirstSights, Member, MemberState, Pins, Remote, Waiting};
use super::api::Api;
use super::crypto::{Keyring, PrivateKey};
use super::records::{self, Put, Record};
use super::snapshot::{Manifest, Restored, Standing, Summary};
use super::vault::Vault;
use crate::error::{Error, Result};
use crate::store::atomic_write;

/// The account's member key pair, in its own vault.
const MEMBER: (&str, &str) = ("sys", "member");
/// The pins, in its own vault.
const PINS: (&str, &str) = ("sys", "team");
/// The keyrings of the projects this account shares, in its own vault: `shares/<project>`.
const OWN: &str = "shares";
/// A share's snapshots, and what it says of the project.
const SNAP: &str = "snap";
const INFO: (&str, &str) = ("project", "info");
/// A share keeps this many snapshots.
const KEEP_SNAPSHOTS: usize = 10;
/// How long an opened keyring is used without asking the service for the share's keys again.
const RING_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_MEMBERS: usize = 500;
const MAX_SHARES: usize = 5_000;

/// One step at a time on the account's own records (the member key, the pins, a share's
/// keyring): two at once would only meet as write conflicts.
static STEP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Held {
    ring: Keyring,
    key_version: u64,
    at: Instant,
}

/// Keyrings opened in this session, by server, account and share.
static RINGS: Mutex<Option<HashMap<String, Held>>> = Mutex::new(None);

fn failed(code: &'static str, text: &str) -> Error {
    Error::Sync(code, text.to_string())
}

fn share_gone() -> Error {
    failed(
        "ShareGone",
        "That share isn't there (it was stopped, or this account isn't in its team).",
    )
}

/// A share deleted while it was asked answers as a vault that is gone: said as what it is.
fn gone(error: Error) -> Error {
    match error {
        Error::Sync("SyncReset", _) => share_gone(),
        other => other,
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// A name from the service or from a share, as it may be shown: one line, not too long.
fn clean(text: &str, max: usize) -> String {
    text.chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect::<String>()
        .trim()
        .to_string()
}

/// The members a reply lists (`uid`, `name`, `memberKey`): only ids and keys that are ones.
fn members_of(list: &Value) -> Vec<Member> {
    list.as_array()
        .into_iter()
        .flatten()
        .take(MAX_MEMBERS)
        .filter_map(|m| {
            let uid = m["uid"].as_str().filter(|u| valid_uid(u))?;
            let name = clean(m["name"].as_str().unwrap_or(""), 120);
            Some(Member {
                uid: uid.to_string(),
                name: if name.is_empty() {
                    "Member".into()
                } else {
                    name
                },
                key: m["memberKey"]
                    .as_str()
                    .filter(|k| valid_key(k))
                    .map(str::to_string),
            })
        })
        .collect()
}

// ---------------------------------------------------------------- what the front end gets

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Me {
    /// This account's member key, as a teammate checks it.
    pub fingerprint: String,
    /// The service has the key (false while the subscription is ended: it takes none then).
    pub published: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberInfo {
    pub uid: String,
    pub name: String,
    pub you: bool,
    pub state: MemberState,
    /// Of the pinned key (for `you`: this account's own).
    pub fingerprint: Option<String>,
    /// Of the key the service shows now, while the state is "changed".
    pub pending_fingerprint: Option<String>,
    /// When the key was pinned, in ms.
    pub pinned_at: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    pub uid: String,
    pub name: String,
}

/// The newest snapshot's label, as the service read it off the record. For showing only.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Latest {
    pub time: Option<u64>,
    pub computer: String,
    pub kind: String,
    pub files: u64,
    pub bytes: u64,
    pub branch: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    pub id: String,
    pub project: String,
    pub name: String,
    pub chats: bool,
    pub owner: Owner,
    pub mine: bool,
    /// "mine"; "ready" (its keys are here for this account); "waiting" (not yet: the sharer's
    /// computer hasn't handed them over, or the sharer has no key); "keyChanged" (the
    /// sharer's key isn't the one this account pinned: nothing of theirs is read until the new
    /// key is accepted).
    pub state: &'static str,
    pub key_version: u64,
    pub rotation_needed: bool,
    pub usage_bytes: u64,
    pub updated_at: Option<u64>,
    pub latest: Option<Latest>,
}

/// What a start or a sync of a share came to.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Synced {
    pub id: String,
    /// The snapshot taken; None when the folder is as the share's last snapshot left it (or
    /// no folder was given).
    pub snapshot: Option<String>,
    /// How many key files the share's newest snapshot left out.
    pub key_files: usize,
    /// Members who were handed the keys just now.
    pub wraps_added: usize,
    /// The keys were renewed (someone left the team, or a key changed).
    pub renewed: bool,
    /// Members who don't have the keys, and why.
    pub waiting: Vec<Waiting>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedSnapshot {
    pub id: String,
    pub summary: Summary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedFile {
    pub path: String,
    pub size: u64,
    pub deleted: bool,
    /// Against the folder that was given; None when none was.
    pub state: Option<Standing>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedFiles {
    pub files: Vec<SharedFile>,
    /// How many were left uncompared (a snapshot can name more than are compared).
    pub truncated: usize,
    /// What the snapshot left out, with why ("a key file", "too large"…).
    pub skipped: Vec<(String, String)>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedCopy {
    pub path: String,
    /// The folder was cloned from the project's remote first.
    pub cloned: bool,
    /// Said when there was a remote and it couldn't be cloned from.
    pub note: Option<String>,
    pub restored: Restored,
}

// ---------------------------------------------------------------- what is kept

/// `shares/<project>` in the account's own vault.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Own {
    v: u32,
    /// The share's id.
    share: String,
    /// The share's keyring (`Keyring::to_bytes`, as text).
    ring: String,
    /// When this keyring was made, in ms.
    created_at: u64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    chats: bool,
}

struct OwnRead {
    own: Option<(Own, Keyring)>,
    /// The record's version (a deleted or damaged one has a version too).
    version: Option<u64>,
}

/// `project/info` in a share.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Info {
    v: u32,
    name: String,
    computer: String,
    git: bool,
    remote: Option<String>,
}

/// What this computer keeps of its last snapshot into a share: to tell "nothing changed", and
/// to skip reading files that didn't change. Beside the vault's own (`sync/snapshots`), never
/// in its place: a share's chunks are named under the share's keys.
#[derive(Serialize, Deserialize)]
struct Last {
    root: String,
    fingerprint: String,
    /// Which keyring the manifest's chunks are named under (a share made again has another).
    tag: String,
    manifest: Manifest,
}

/// The pins as this computer last read or wrote them, so a record that is withheld or rolled
/// back doesn't lose them.
#[derive(Serialize, Deserialize)]
struct KeptPins {
    base: String,
    uid: String,
    pins: Pins,
}

enum Read {
    Absent {
        version: Option<u64>,
    },
    /// There, and not content: nothing opens it.
    Damaged {
        version: Option<u64>,
    },
    Text {
        text: String,
        version: u64,
    },
}

/// A sealed record, told apart as the callers here need it. One sealed with keys this
/// computer doesn't hold yet is an error: nothing is decided from it or written over it.
async fn read(api: &Api, ring: &Keyring, collection: &str, id: &str) -> Result<Read> {
    let Some(record) = records::get(api, ring, collection, id).await? else {
        return Ok(Read::Absent { version: None });
    };
    if record.unreadable {
        return Err(failed(
            "SyncKeys",
            "This computer doesn't have the account's newest keys yet; try again in a moment.",
        ));
    }
    let version = Some(record.version);
    if record.deleted {
        return Ok(Read::Absent { version });
    }
    match record.text {
        Some(text) if !record.damaged => Ok(Read::Text {
            text,
            version: record.version,
        }),
        _ => Ok(Read::Damaged { version }),
    }
}

/// Writes a record over the version it was read at (`text` None deletes it). False: someone
/// wrote in between, read it again.
async fn write(
    api: &Api,
    ring: &Keyring,
    (collection, id): (&str, &str),
    expect: Option<u64>,
    text: Option<&str>,
) -> Result<bool> {
    match records::put(api, ring, collection, id, expect, text, None).await? {
        Put::Done { .. } => Ok(true),
        Put::Conflict { .. } | Put::Gc { .. } => Ok(false),
    }
}

/// A share opened for reading or writing what it holds.
pub struct Opened {
    pub api: Api,
    pub ring: Keyring,
    /// The keyring came from this session's memory (it may be behind the share's keys).
    cached: bool,
}

struct Maintained {
    ring: Keyring,
    name: String,
    wraps_added: usize,
    renewed: bool,
    waiting: Vec<Waiting>,
}

/// What `sync` captures: the open folder, and this computer as the vault knows it.
pub struct Folder<'a> {
    pub root: &'a Path,
    pub device: &'a str,
    pub device_name: &'a str,
}

/// Sharing, for the signed-in account on this computer. Sync must be on here: everything this
/// account keeps of sharing is in its own vault.
pub struct Shares {
    vault: Vault,
    team: Api,
    base: String,
    data: PathBuf,
    uid: String,
    /// The account's own keyring.
    ring: Keyring,
}

impl Shares {
    pub fn new(base: &str, data: &Path) -> Result<Self> {
        let vault = Vault::new(base, data);
        let uid = vault
            .uid()
            .ok_or_else(|| failed("SyncSignedOut", "Sign in to share with a team."))?;
        // The keys held here must be this account's (another may have signed in since).
        if vault.joined_as().as_deref() != Some(uid.as_str()) || !valid_uid(&uid) {
            return Err(failed("SyncOff", "Sync isn't on for this device."));
        }
        let ring = vault.keyring()?;
        Ok(Self {
            team: Api::of("team", base, data),
            base: vault.api.base().to_string(),
            data: data.to_path_buf(),
            vault,
            uid,
            ring,
        })
    }

    fn share_api(&self, id: &str) -> Result<Api> {
        Api::share(&self.base, &self.data, id)
    }

    fn cache_key(&self, id: &str) -> String {
        format!("{}\n{}\n{id}", self.base, self.uid)
    }

    fn held(&self, id: &str) -> Option<Keyring> {
        let rings = RINGS.lock().unwrap_or_else(|e| e.into_inner());
        rings
            .as_ref()?
            .get(&self.cache_key(id))
            .filter(|h| h.at.elapsed() < RING_TTL)
            .map(|h| h.ring.clone())
    }

    fn hold(&self, id: &str, ring: &Keyring, key_version: u64) {
        let mut rings = RINGS.lock().unwrap_or_else(|e| e.into_inner());
        rings.get_or_insert_with(HashMap::new).insert(
            self.cache_key(id),
            Held {
                ring: ring.clone(),
                key_version,
                at: Instant::now(),
            },
        );
    }

    /// Forgets a held keyring (`key_version` None: whatever it is; else unless it is that one).
    fn forget(&self, id: &str, unless: Option<u64>) {
        let mut rings = RINGS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(rings) = rings.as_mut() {
            let key = self.cache_key(id);
            if rings
                .get(&key)
                .is_some_and(|h| unless != Some(h.key_version))
            {
                rings.remove(&key);
            }
        }
    }

    // ------------------------------------------------------------ the member key

    /// This account's member key from its own vault; with `create`, made when there is none
    /// (two computers may make one at the same moment: the record's version decides, and the
    /// other takes what won).
    async fn member_key(&self, create: bool) -> Result<Option<PrivateKey>> {
        for _ in 0..4 {
            let version = match read(&self.vault.api, &self.ring, MEMBER.0, MEMBER.1).await? {
                Read::Text { text, version } => {
                    let stored = serde_json::from_str::<Value>(&text)
                        .ok()
                        .and_then(|v| v["key"].as_str().map(PrivateKey::from_text));
                    if let Some(Ok(key)) = stored {
                        return Ok(Some(key));
                    }
                    Some(version)
                }
                Read::Absent { version } | Read::Damaged { version } => version,
            };
            if !create {
                return Ok(None);
            }
            let key = PrivateKey::generate()?;
            let text = json!({ "v": 1, "key": key.to_text(), "publicKey": key.public() });
            if write(
                &self.vault.api,
                &self.ring,
                MEMBER,
                version,
                Some(&text.to_string()),
            )
            .await?
            {
                return Ok(Some(key));
            }
        }
        Err(failed(
            "Sync",
            "This account's key for sharing kept changing; try again.",
        ))
    }

    async fn own_key(&self) -> Result<PrivateKey> {
        self.member_key(true).await?.ok_or_else(|| {
            failed(
                "ShareNoMemberKey",
                "This account has no key for sharing yet.",
            )
        })
    }

    /// Publishes the public half, with proof of holding the private one (as a device proves
    /// its key).
    async fn publish(&self, key: &PrivateKey) -> Result<()> {
        let challenge = self.vault.proof(key).await?;
        let body = json!({ "publicKey": key.public(), "challenge": challenge });
        self.team.put("key", &body).await?.into_ok()?;
        Ok(())
    }

    /// The member key, published when the service shows none or another for this account
    /// (`shown`). True when the service has it now; false while it takes none (the
    /// subscription ended).
    async fn ensure_member_key(&self, shown: Option<&str>) -> Result<(PrivateKey, bool)> {
        let key = self.own_key().await?;
        if shown == Some(key.public().as_str()) {
            return Ok((key, true));
        }
        match self.publish(&key).await {
            Ok(()) => Ok((key, true)),
            Err(Error::Sync("SyncLapsed", _)) => Ok((key, false)),
            Err(e) => Err(e),
        }
    }

    // ------------------------------------------------------------ the team and the pins

    /// The team's members as the service lists them now. Who is in the team is the service's
    /// to say; whose key is whose is not (`pins`).
    async fn team_members(&self) -> Result<Vec<Member>> {
        let view = self.team.get("").await?;
        if !view["team"].is_object() {
            return Err(failed("ShareNoTeam", "This account isn't in a team."));
        }
        Ok(members_of(&view["team"]["members"]))
    }

    fn shown_for_me<'a>(&self, members: &'a [Member]) -> Option<&'a str> {
        members
            .iter()
            .find(|m| m.uid == self.uid)
            .and_then(|m| m.key.as_deref())
    }

    fn pins_file(&self) -> PathBuf {
        self.vault.sync_file("team-pins.json")
    }

    fn kept_pins(&self) -> Option<Pins> {
        let kept: KeptPins = serde_json::from_slice(&std::fs::read(self.pins_file()).ok()?).ok()?;
        (kept.base == self.base && kept.uid == self.uid).then_some(kept.pins)
    }

    /// Best effort: without it this computer only has the record to go by.
    fn keep_pins(&self, pins: &Pins) {
        let kept = KeptPins {
            base: self.base.clone(),
            uid: self.uid.clone(),
            pins: pins.clone(),
        };
        let file = self.pins_file();
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(bytes) = serde_json::to_vec(&kept) {
            let _ = atomic_write(&file, &bytes);
        }
    }

    /// Reads the pins, changes them and writes them back when they changed, again when
    /// another of the account's computers wrote in between. `change` says whether it changed
    /// anything, and notes the keys it pinned at first sight. `lapse_ok`: when the account
    /// takes no writes (its subscription ended), the result is used as it is, kept on this
    /// computer only.
    async fn pins_with<F>(&self, lapse_ok: bool, mut change: F) -> Result<Pins>
    where
        F: FnMut(&mut Pins, &mut FirstSights) -> Result<bool>,
    {
        let kept = self.kept_pins();
        let mut first = FirstSights::new();
        for _ in 0..6 {
            let (remote, version) = match read(&self.vault.api, &self.ring, PINS.0, PINS.1).await? {
                Read::Absent { version } => (Remote::Absent, version),
                Read::Damaged { version } => (Remote::Damaged, version),
                Read::Text { text, version } => match Pins::parse(&text) {
                    Some(pins) => (Remote::Read(pins), Some(version)),
                    None => (Remote::Damaged, Some(version)),
                },
            };
            let (mut pins, mut dirty) = reconcile(remote, kept.as_ref());
            dirty |= pins.merge_first_sights(&first);
            dirty |= change(&mut pins, &mut first)?;
            if !dirty {
                self.keep_pins(&pins);
                return Ok(pins);
            }
            let floor = pins.n.max(kept.as_ref().map_or(0, |k| k.n));
            pins.n = floor + 1;
            match write(
                &self.vault.api,
                &self.ring,
                PINS,
                version,
                Some(&pins.text()?),
            )
            .await
            {
                Ok(true) => {
                    self.keep_pins(&pins);
                    return Ok(pins);
                }
                Ok(false) => {}
                Err(Error::Sync("SyncLapsed", _)) if lapse_ok => {
                    // Not written: kept here under the number the record has.
                    pins.n = floor;
                    self.keep_pins(&pins);
                    return Ok(pins);
                }
                Err(e) => return Err(e),
            }
        }
        Err(failed(
            "Sync",
            "The list of teammates' keys kept changing; try again.",
        ))
    }

    /// The pins after taking in what the service shows now.
    async fn observe(&self, members: &[Member]) -> Result<Pins> {
        let now = now_ms();
        self.pins_with(true, |pins, first| {
            Ok(pins.observe(members, &self.uid, now, first))
        })
        .await
    }

    /// This account's fingerprint, and whether its key is published (making and publishing
    /// the key when that wasn't done yet).
    pub async fn me(&self) -> Result<Me> {
        let _step = STEP.lock().await;
        let members = self.team_members().await?;
        let (key, published) = self.ensure_member_key(self.shown_for_me(&members)).await?;
        Ok(Me {
            fingerprint: fingerprint(&key.public())?,
            published,
        })
    }

    /// The team's members, each with where they stand for this account.
    pub async fn members(&self) -> Result<Vec<MemberInfo>> {
        let _step = STEP.lock().await;
        let members = self.team_members().await?;
        // (No key of its own yet and no writes taken, the subscription having ended: the list
        // is still read.)
        let mine = match self.ensure_member_key(self.shown_for_me(&members)).await {
            Ok((key, _)) => key.public(),
            Err(Error::Sync("SyncLapsed", _)) => String::new(),
            Err(e) => return Err(e),
        };
        let pins = self.observe(&members).await?;
        let print = |key: &str| fingerprint(key).ok();
        Ok(members
            .iter()
            .map(|m| {
                let shown = m.key.as_deref();
                if m.uid == self.uid {
                    return MemberInfo {
                        uid: m.uid.clone(),
                        name: m.name.clone(),
                        you: true,
                        state: match shown {
                            None => MemberState::NoKey,
                            Some(k) if k == mine => MemberState::Verified,
                            Some(_) => MemberState::Changed,
                        },
                        fingerprint: print(&mine),
                        pending_fingerprint: None,
                        pinned_at: None,
                    };
                }
                let pin = pins.members.get(&m.uid);
                let state = pins.state(&m.uid, shown);
                MemberInfo {
                    uid: m.uid.clone(),
                    name: m.name.clone(),
                    you: false,
                    state,
                    fingerprint: pin.and_then(|p| print(&p.key)),
                    pending_fingerprint: match state {
                        MemberState::Changed => shown.and_then(print),
                        _ => None,
                    },
                    pinned_at: pin.map(|p| p.at),
                }
            })
            .collect())
    }

    /// Marks a teammate verified, or not. `shown`: the fingerprint that was compared.
    pub async fn set_verified(&self, uid: &str, shown: &str, verified: bool) -> Result<()> {
        let _step = STEP.lock().await;
        self.pins_with(false, |pins, _| pins.set_verified(uid, shown, verified))
            .await?;
        Ok(())
    }

    /// Accepts a teammate's changed key (`shown`: its fingerprint as the list showed it). It
    /// is then pinned and not verified.
    pub async fn accept_key(&self, uid: &str, shown: &str) -> Result<()> {
        let _step = STEP.lock().await;
        let now = now_ms();
        self.pins_with(false, |pins, _| {
            pins.accept_changed_key(uid, shown, now)?;
            Ok(true)
        })
        .await?;
        Ok(())
    }

    // ------------------------------------------------------------ the team's shares

    fn share_info(&self, v: &Value, pins: &Pins, members: &[Member]) -> Option<ShareInfo> {
        let id = v["id"].as_str()?;
        let (owner, project) = split_share_id(id)?;
        // A share is its sharer's by its id; an answer that names someone else isn't listed.
        if v["owner"]["uid"].as_str() != Some(owner) {
            return None;
        }
        let mine = owner == self.uid;
        let shown = members
            .iter()
            .find(|m| m.uid == owner)
            .and_then(|m| m.key.as_deref());
        let state = if mine {
            "mine"
        } else {
            match pins.state(owner, shown) {
                MemberState::Changed => "keyChanged",
                MemberState::NoKey => "waiting",
                _ if v["hasWrap"].as_bool() == Some(true) => "ready",
                _ => "waiting",
            }
        };
        let latest = v["latest"].as_object().map(|l| {
            let text = |name: &str| clean(l.get(name).and_then(Value::as_str).unwrap_or(""), 120);
            let number = |name: &str| l.get(name).and_then(Value::as_u64);
            Latest {
                time: number("time"),
                computer: text("computer"),
                kind: text("kind"),
                files: number("files").unwrap_or(0),
                bytes: number("bytes").unwrap_or(0),
                branch: Some(text("branch")).filter(|b| !b.is_empty()),
            }
        });
        Some(ShareInfo {
            id: id.to_string(),
            project: project.to_string(),
            name: clean(v["name"].as_str().unwrap_or(""), 120),
            chats: v["chats"].as_bool() == Some(true),
            owner: Owner {
                uid: owner.to_string(),
                name: clean(v["owner"]["name"].as_str().unwrap_or(""), 120),
            },
            mine,
            state,
            key_version: v["keyVersion"].as_u64().unwrap_or(0),
            rotation_needed: v["rotationNeeded"].as_bool() == Some(true),
            usage_bytes: v["usageBytes"].as_u64().unwrap_or(0),
            updated_at: v["updatedAt"].as_u64(),
            latest,
        })
    }

    async fn listed(&self, pins: &Pins, members: &[Member]) -> Result<Vec<ShareInfo>> {
        let reply = self.team.get("shares").await?;
        let shares: Vec<ShareInfo> = reply["shares"]
            .as_array()
            .ok_or_else(super::api::unreadable)?
            .iter()
            .take(MAX_SHARES)
            .filter_map(|v| self.share_info(v, pins, members))
            .collect();
        // Keys held for another generation than the share is at are asked for again.
        for share in &shares {
            self.forget(&share.id, Some(share.key_version));
        }
        Ok(shares)
    }

    /// The team's shares, each with whether this account can read it.
    pub async fn list(&self) -> Result<Vec<ShareInfo>> {
        let _step = STEP.lock().await;
        let members = self.team_members().await?;
        // A member's key is there from the first look at the team's shares on, so a sharer
        // can hand over keys. (When the subscription ended none is made: the list is still read.)
        match self.ensure_member_key(self.shown_for_me(&members)).await {
            Ok(_) | Err(Error::Sync("SyncLapsed", _)) => {}
            Err(e) => return Err(e),
        }
        let pins = self.observe(&members).await?;
        self.listed(&pins, &members).await
    }
}

async fn read_info(api: &Api, ring: &Keyring) -> Result<Read> {
    read(api, ring, INFO.0, INFO.1).await
}

/// A share's snapshot records that are there, by id, and how many of them these keys don't
/// open. Ids that couldn't stand in an address are left out.
async fn snapshot_records(api: &Api, ring: &Keyring) -> Result<(BTreeMap<String, Record>, usize)> {
    let mut found: BTreeMap<String, Record> = BTreeMap::new();
    let mut since = 0;
    // (A share holds a few records; the bound only stops an answer that never ends.)
    for _ in 0..200 {
        let page = records::changes(api, ring, since).await?;
        let mut last = since;
        for record in page.records {
            last = last.max(record.seq);
            if record.collection != SNAP || !valid_record_id(&record.id) {
                continue;
            }
            if record.deleted {
                found.remove(&record.id);
            } else {
                found.insert(record.id.clone(), record);
            }
        }
        if !page.more || last <= since {
            break;
        }
        since = last;
    }
    let hidden = found.values().filter(|r| r.text.is_none()).count();
    Ok((found, hidden))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn members_are_read_with_only_ids_and_keys_that_are_ones() {
        let key = PrivateKey::generate().unwrap().public();
        let list = json!([
            { "uid": "u1", "name": " Ada\nLovelace ", "memberKey": key, "hasWrap": true },
            { "uid": "u2", "name": "", "memberKey": null },
            { "uid": "u3", "name": "Bo", "memberKey": "not-a-key" },
            { "uid": "u/4", "name": "Eve", "memberKey": key },
            { "name": "nobody" },
            "junk",
        ]);
        let members = members_of(&list);
        assert_eq!(
            members,
            [
                Member {
                    uid: "u1".into(),
                    name: "AdaLovelace".into(),
                    key: Some(key)
                },
                Member {
                    uid: "u2".into(),
                    name: "Member".into(),
                    key: None
                },
                Member {
                    uid: "u3".into(),
                    name: "Bo".into(),
                    key: None
                },
            ]
        );
        assert!(members_of(&Value::Null).is_empty());
    }

    #[test]
    fn a_share_deleted_meanwhile_is_said_as_gone() {
        assert!(matches!(
            gone(Error::Sync("SyncReset", "x".into())),
            Error::Sync("ShareGone", _)
        ));
        assert!(matches!(
            gone(Error::Sync("SyncLapsed", "x".into())),
            Error::Sync("SyncLapsed", _)
        ));
    }
}
