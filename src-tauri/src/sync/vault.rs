//! This computer as one of the account's devices: its key pair, the account's keyring once a
//! device or the recovery key handed it over, and the steps that change who holds it.
//!
//! Nothing here takes the service's word for who holds the keys or which keys they are:
//!
//! - The keyring travels between devices as an authenticated box, from a device's key to
//!   another's. A device takes keys only from a device it already trusts (the one it paired
//!   with, or one on the account's list as it last read it), and new keys must contain the
//!   ones it holds.
//! - Two devices pair by comparing a code made from both their keys and a random value from
//!   each, the waiting one committing to its value before it sees the other's.
//! - The recovery key's wrap carries a tag only the account's devices can make.
//! - The list of trusted devices is sealed with the account's keys and carries a counter that
//!   only goes up; this computer keeps the newest it has read.
//!
//! On disk: `<data>/sync/local.json` (which account, which device, where it stands, what is
//! still to be written) and two secrets (the device's private key, the keyring), kept as
//! provider keys are: in the OS keychain when there is one.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::api::Api;
use super::crypto::{self, Keyring, PrivateKey};
use super::records;
use crate::accounts;
use crate::ai::secrets;
use crate::error::{Error, Result};
use crate::store::atomic_write_private;

const DEVICE_SECRET: &str = "sync-device-key";
const KEYRING_SECRET: &str = "sync-keyring";
/// The record that lists the devices this account's own devices approved (sealed, so the
/// service can't add one to it).
const TRUSTED: (&str, &str) = ("sys", "devices");

/// A change to the trusted list that is still to be written (the write failed, or the app
/// closed first): done again at the next status check, so the list never stays behind.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
struct TrustChange {
    add: Vec<(String, String)>,
    remove: Vec<String>,
    /// The recovery key's public half and its auth key, when the change sets them.
    pin: Option<(String, String)>,
    /// The list may be made new (only the first device, at setup).
    create: bool,
    /// Devices whose app writes a counter into every record (each says so for itself).
    counted: Vec<String>,
    /// The key generation the records of `FLOORED` were all sealed again with.
    floors: Option<u32>,
    /// The account's member key for sharing, and the counter of its last pins write.
    member: Option<MemberAnchor>,
}

/// What the trusted list says of the account's key for sharing (`share`): its public half,
/// and the counter of the last write of the teammates' pinned keys.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct MemberAnchor {
    pub key: String,
    pub pins: u64,
    /// Another key takes the place of the one named (the person started over, knowingly).
    pub replace: bool,
}

/// Why this computer's keys were put aside, and whose they are: sync is off here, and the
/// keys are neither used nor deleted until the person says which.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
struct Aside {
    /// "reset", "removed", "account" (another account signed in) or "server".
    reason: String,
    /// When, by this computer's clock (ms).
    at: u64,
}

/// The collections with a floor: after a device was removed their records are sealed again
/// with the new keys, and one sealed with older keys is no longer taken.
const FLOORED: [&str; 3] = ["sys", "settings", "files"];
/// The collections sealed again after new keys (small records without chunks).
const SEALED_AGAIN: [&str; 4] = ["sys", "settings", "files", "shares"];
/// How long keys put aside are kept before they are deleted.
const ASIDE_KEPT_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const ASIDE_DEVICE_SECRET: &str = "sync-device-key.aside";
const ASIDE_KEYRING_SECRET: &str = "sync-keyring.aside";

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Local {
    base: String,
    /// The account this state belongs to.
    uid: String,
    epoch: u64,
    device_id: String,
    device_name: String,
    /// The keyring is held (approved, or joined by recovery key).
    joined: bool,
    key_version: u64,
    /// Setup was sent and its reply not seen yet: the vault may or may not exist.
    setting_up: bool,
    /// The trusted list as this computer last read it, and its counter: an older list handed
    /// back by the service is refused, and keys are taken only from a device on it.
    trusted_n: u64,
    trusted: Vec<(String, String)>,
    /// Pairing, while this computer waits: its random value, and (once seen) the approving
    /// computer's key and value, fixed for the code. `revealed`: its value was sent.
    pair_value: String,
    pair_with: Option<(String, String)>,
    revealed: bool,
    /// Changes to the trusted list still to be written.
    pending_trust: Vec<TrustChange>,
    /// A new recovery key whose wrap the service doesn't have yet: (public key, wrap).
    pending_recovery: Option<(String, String)>,
    /// The key generation the trusted list was sealed under when it was last taken: a list
    /// sealed with older keys (from before a device was removed) is refused.
    list_generation: u32,
    /// The floors the trusted list stated, as last read (`records::Checks::floors`).
    floors: std::collections::BTreeMap<String, u32>,
    /// Every device on the trusted list writes counters (`records::Checks::strict`).
    strict: bool,
    /// This computer removed a device and the new keys aren't made yet: made at the next
    /// status check, whatever the service says is needed.
    rotation_owed: bool,
    /// Approved devices the trusted list doesn't name, and when this computer first saw each
    /// (its own clock): how long new keys wait for one that may still be joining.
    first_seen: Vec<(String, String, u64)>,
    /// The account's member key and pins counter as the trusted list stated them.
    member: Option<String>,
    member_pins: u64,
    /// Set while these keys are put aside (sync is off here; nothing above is in use).
    aside: Option<Aside>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub platform: String,
    /// "approved" or "pending".
    pub status: String,
    pub created_at: Option<u64>,
    pub last_seen_at: Option<u64>,
    /// What both computers show while one approves the other: there once both have given
    /// their part (on the approving computer, after `review` and the other's answer).
    pub code: Option<String>,
    /// This computer started checking that waiting one (`review`).
    pub checking: bool,
    pub current: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// "signedOut", "unavailable" (not open to this account), "off", "pending" (waiting to be
    /// approved) or "on".
    pub state: String,
    /// Why sync went off by itself: "reset" (everything synced was deleted from the account
    /// page), "removed" (this device was removed from another) or "keysLost" (this computer's
    /// keys are gone from where they were kept).
    pub notice: Option<String>,
    /// Whether the account has sync set up on some device.
    pub exists: bool,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub code: Option<String>,
    pub devices: Vec<DeviceInfo>,
    pub recovery_created_at: Option<u64>,
    pub usage_bytes: u64,
    pub storage_limit: u64,
    pub epoch: u64,
    /// The account's subscription ended: until then (ms) what is synced can still be read, and
    /// nothing can be written. None while the subscription runs.
    pub lapsed_until: Option<u64>,
    /// This computer's keys, put aside when sync went off by itself.
    pub kept: Option<Kept>,
}

/// Keys put aside: sync is off here, and they are kept until the person removes them, turns
/// sync on again, or `until` passes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kept {
    /// "reset", "removed", "account" or "server".
    pub reason: String,
    pub at: u64,
    /// When they are deleted (ms).
    pub until: u64,
    /// The account lists this computer as before: sync can be turned back on with them.
    pub resumable: bool,
    pub device_name: String,
}

/// What `prepare` made and `setup` sends: nothing reaches the server until the recovery key
/// was typed back.
struct Prepared {
    base: String,
    device: PrivateKey,
    ring: Keyring,
    recovery: PrivateKey,
    name: String,
}

static PREPARED: Mutex<Option<Prepared>> = Mutex::new(None);

/// A waiting device this computer is checking: what it fixed before publishing its own value.
#[derive(Clone)]
struct Review {
    device: String,
    /// The waiting device's key and its commitment, as seen when the check started.
    public: String,
    commit: String,
    /// This computer's value.
    value: String,
    /// The waiting device's value, once it revealed one that fits its commitment.
    revealed: Option<String>,
}

static REVIEWS: Mutex<Vec<Review>> = Mutex::new(Vec::new());

/// The sealed list of devices the account's own devices approved, the recovery key they
/// wrap to, and a counter that only goes up.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Trusted {
    devices: Vec<(String, String)>,
    /// The recovery key's public half and its auth key.
    recovery: Option<(String, String)>,
    n: u64,
    /// Devices whose app writes a counter into every record.
    counted: Vec<String>,
    /// By collection: the key generation its records were all sealed again with.
    floors: std::collections::BTreeMap<String, u32>,
    /// The account's member key for sharing (its public half), and its pins counter.
    member: Option<String>,
    pins: u64,
}

impl Trusted {
    /// Whether every device on the list writes counters.
    fn all_counted(&self) -> bool {
        !self.devices.is_empty() && self.devices.iter().all(|(id, _)| self.counted.contains(id))
    }
}

pub struct Vault {
    pub api: Api,
    data: PathBuf,
}

/// This computer's own name (what the system calls it), to tell devices apart in a list.
pub fn default_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|n| n.trim().chars().take(80).collect::<String>())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Computer".to_string())
}

fn clean_name(name: &str) -> String {
    let name: String = name.trim().chars().take(80).collect();
    if name.is_empty() {
        default_name()
    } else {
        name
    }
}

fn keys_error(message: &str) -> Error {
    Error::Sync("SyncKeys", message.to_string())
}

fn signed_out() -> Error {
    Error::Sync("SyncSignedOut", "Sign in to sync.".into())
}

fn trusted_text(list: &Trusted) -> String {
    json!({
        "devices": list.devices.iter().map(|(id, key)| json!({ "id": id, "publicKey": key })).collect::<Vec<_>>(),
        "recovery": list.recovery.as_ref().map(|r| &r.0),
        "recoveryAuth": list.recovery.as_ref().map(|r| &r.1),
        "n": list.n,
        "counted": list.counted,
        "floors": list.floors,
        "member": list.member,
        "pins": list.pins,
    })
    .to_string()
}

/// The list after `change`, not yet counted up (`n` is the caller's).
fn changed_list(before: &Trusted, change: &TrustChange) -> Trusted {
    let mut next = before.clone();
    next.devices
        .retain(|(id, _)| !change.remove.contains(id) && !change.add.iter().any(|(a, _)| a == id));
    next.devices.extend(change.add.iter().cloned());
    if let Some(pin) = &change.pin {
        next.recovery = Some(pin.clone());
    }
    for id in &change.counted {
        if !next.counted.contains(id) {
            next.counted.push(id.clone());
        }
    }
    // Only a device on the list counts.
    let devices = next.devices.clone();
    next.counted
        .retain(|id| devices.iter().any(|(d, _)| d == id));
    if let Some(generation) = change.floors {
        for collection in FLOORED {
            let floor = next.floors.entry(collection.to_string()).or_insert(0);
            *floor = (*floor).max(generation);
        }
    }
    if let Some(anchor) = &change.member {
        if anchor.replace || next.member.is_none() {
            next.member = Some(anchor.key.clone());
            next.pins = if anchor.replace {
                anchor.pins
            } else {
                next.pins.max(anchor.pins)
            };
        } else if next.member.as_deref() == Some(anchor.key.as_str()) {
            next.pins = next.pins.max(anchor.pins);
        }
    }
    next
}

/// Whether an approved device the trusted list doesn't name may only be new, so new keys
/// wait for the write that adds it: this computer first saw it less than ten minutes ago, by
/// its own clock. (The service's word for when a device was added would let it hold new
/// keys back for as long as it liked.)
fn may_be_joining(first_seen_ms: u64, now_ms: u64) -> bool {
    now_ms.saturating_sub(first_seen_ms) <= JOIN_GRACE_MS
}

impl Vault {
    pub fn new(base: &str, data: &Path) -> Self {
        let mut vault = Self {
            api: Api::new(base, data),
            data: data.to_path_buf(),
        };
        // What a record must pass here, as the trusted list last said it.
        let local = vault.local();
        vault.api.checks.strict = local.strict;
        vault.api.checks.floors = local.floors;
        vault
    }

    fn local_file(&self) -> PathBuf {
        self.data.join("sync").join("local.json")
    }

    fn secrets_file(&self) -> PathBuf {
        self.data.join("secrets.json")
    }

    fn stored_local(&self) -> Local {
        std::fs::read_to_string(self.local_file())
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    /// This computer's state in sync. Keys that were put aside are not it: sync is off then.
    fn local(&self) -> Local {
        let local = self.stored_local();
        if local.aside.is_some() {
            return Local::default();
        }
        local
    }

    /// The state that was put aside with its keys, if any.
    fn kept(&self) -> Option<(Local, Aside)> {
        let local = self.stored_local();
        let aside = local.aside.clone()?;
        Some((local, aside))
    }

    /// Sync went off here by itself (the account says it was reset, or that this computer
    /// was removed; another account signed in). That is the service's word, or a passing
    /// state, and these may be the only copy of the account's keys: they are put aside, out
    /// of use, instead of deleted. A computer that never held the keys has nothing to keep.
    fn leave(&self, local: &Local, reason: &str) -> Result<()> {
        if !local.joined {
            return self.forget();
        }
        let secrets = self.secrets_file();
        for (name, aside) in [
            (DEVICE_SECRET, ASIDE_DEVICE_SECRET),
            (KEYRING_SECRET, ASIDE_KEYRING_SECRET),
        ] {
            // Put aside before it is taken out of use: never in neither place.
            if let Some(value) = secrets::get(&secrets, name) {
                secrets::set(&secrets, aside, Some(&value))?;
            }
            secrets::set(&secrets, name, None)?;
        }
        let mut kept = local.clone();
        kept.aside = Some(Aside {
            reason: reason.to_string(),
            at: now_ms(),
        });
        self.save_local(&kept)
    }

    /// Deletes the keys that were put aside and what was kept with them. Only when the
    /// person said so, turned sync on again from the start, or the time they are kept passed.
    pub fn forget_kept(&self) -> Result<()> {
        if self.kept().is_none() {
            return Ok(());
        }
        secrets::set(&self.secrets_file(), ASIDE_DEVICE_SECRET, None)?;
        secrets::set(&self.secrets_file(), ASIDE_KEYRING_SECRET, None)?;
        match std::fs::remove_dir_all(self.data.join("sync")) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// Whether the account, as the service states it now, still has this computer as the
    /// keys put aside knew it: the same account and server, the same life of the vault, the
    /// device listed.
    fn resumable(&self, kept: &Local, uid: &str, server: &Value) -> bool {
        kept.uid == uid
            && kept.base == self.api.base()
            && server["exists"].as_bool() == Some(true)
            && server["epoch"].as_u64() == Some(kept.epoch)
            && server["devices"].as_array().is_some_and(|l| {
                l.iter().any(|d| {
                    d["id"].as_str() == Some(kept.device_id.as_str())
                        && d["status"].as_str() == Some("approved")
                })
            })
    }

    /// Turns sync back on with the keys that were put aside, when the account has this
    /// computer as before (what turned sync off has passed: an outage, a wrong answer,
    /// signing in as someone else for a while).
    pub async fn resume_kept(&self) -> Result<()> {
        let (mut local, _) = self.kept().ok_or_else(|| {
            Error::Sync("SyncOff", "No sync keys are kept on this computer.".into())
        })?;
        let uid = self.uid().ok_or_else(signed_out)?;
        let server = self.server_state().await?;
        if !self.resumable(&local, &uid, &server) {
            return Err(Error::Sync(
                "SyncKeys",
                "The account doesn't list this computer as it was, so the keys that were kept can't be used. Turn sync on again from the start.".into(),
            ));
        }
        let secrets = self.secrets_file();
        for (name, aside) in [
            (DEVICE_SECRET, ASIDE_DEVICE_SECRET),
            (KEYRING_SECRET, ASIDE_KEYRING_SECRET),
        ] {
            let value = secrets::get(&secrets, aside).ok_or_else(|| {
                keys_error("The keys that were kept are gone from where they were kept.")
            })?;
            secrets::set(&secrets, name, Some(&value))?;
        }
        local.aside = None;
        self.save_local(&local)?;
        secrets::set(&secrets, ASIDE_DEVICE_SECRET, None)?;
        secrets::set(&secrets, ASIDE_KEYRING_SECRET, None)
    }

    fn save_local(&self, local: &Local) -> Result<()> {
        let file = self.local_file();
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        atomic_write_private(&file, &serde_json::to_vec_pretty(local)?)
    }

    /// Forgets this device's part in sync (its keys too). What was synced to disk stays.
    fn forget(&self) -> Result<()> {
        secrets::set(&self.secrets_file(), DEVICE_SECRET, None)?;
        secrets::set(&self.secrets_file(), KEYRING_SECRET, None)?;
        // The whole folder: the state, and the caches that only made sense with these keys.
        match std::fs::remove_dir_all(self.data.join("sync")) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    fn device_key(&self) -> Result<PrivateKey> {
        let text = secrets::get(&self.secrets_file(), DEVICE_SECRET)
            .ok_or_else(|| keys_error("This device's sync key is missing; turn sync on again."))?;
        PrivateKey::from_text(&text)
    }

    /// The account's keys, when this device holds them.
    pub fn keyring(&self) -> Result<Keyring> {
        let text = secrets::get(&self.secrets_file(), KEYRING_SECRET)
            .ok_or_else(|| Error::Sync("SyncOff", "Sync isn't on for this device.".into()))?;
        Keyring::from_bytes(&crypto::unb64(&text)?)
    }

    fn store_keyring(&self, ring: &Keyring) -> Result<()> {
        secrets::set(
            &self.secrets_file(),
            KEYRING_SECRET,
            Some(&crypto::b64(&ring.to_bytes()?)),
        )
    }

    /// This device's id and name while sync is on here.
    pub fn device(&self) -> Option<(String, String)> {
        let local = self.local();
        (local.joined && local.base == self.api.base())
            .then_some((local.device_id, local.device_name))
    }

    /// The account whose keys this computer holds, while sync is on here for this server.
    /// (Another account may have signed in since: its vault isn't opened with these keys.)
    pub(super) fn joined_as(&self) -> Option<String> {
        let local = self.local();
        (local.joined && local.base == self.api.base()).then_some(local.uid)
    }

    /// Whether `epoch` (as a page of changes states it) is the life of the vault this
    /// computer joined. (0 here: joined before epochs were kept; nothing to compare.)
    pub fn same_epoch(&self, epoch: u64) -> bool {
        epoch_matches(self.local().epoch, epoch)
    }

    /// What the trusted list says of the account's key for sharing, as this computer last
    /// read it: the member key's public half (None: the list names none yet) and the pins
    /// counter. Err while this computer has read no list at all: nothing about sharing is
    /// decided before it has (a new computer reads it as soon as it holds the keys).
    pub(super) fn member_anchor(&self) -> Result<(Option<String>, u64)> {
        let local = self.local();
        if !local.joined || local.trusted_n == 0 {
            return Err(keys_error(
                "The account's list of trusted devices hasn't been read on this computer yet; try again in a moment.",
            ));
        }
        Ok((local.member, local.member_pins))
    }

    /// States the member key and pins counter in the trusted list, which can't be rolled
    /// back or withheld without this computer noticing: what a computer with nothing kept
    /// of its own holds `sys/member` and `sys/team` against. `replace`: another key takes
    /// the place of the one named (the person started over).
    pub(super) async fn anchor_member(&self, key: &str, pins: u64, replace: bool) -> Result<()> {
        let mut local = self.local();
        if !replace && local.member.as_deref() == Some(key) && local.member_pins >= pins {
            return Ok(());
        }
        let ring = self.keyring()?;
        let change = TrustChange {
            member: Some(MemberAnchor {
                key: key.to_string(),
                pins,
                replace,
            }),
            ..Default::default()
        };
        // (What the list says after the write is kept here by the write itself.)
        self.write_trust(&mut local, &ring, &change).await
    }

    /// A file under this profile's sync folder (caches; removed when sync goes off here).
    pub fn sync_file(&self, name: &str) -> PathBuf {
        self.data.join("sync").join(name)
    }

    pub(super) fn uid(&self) -> Option<String> {
        accounts::profile(&accounts::session_file(&self.data), self.api.base()).map(|p| p.id)
    }

    fn device_body(&self, local: &Local, public: &str) -> Value {
        json!({ "device": {
            "id": local.device_id,
            "name": local.device_name,
            "platform": std::env::consts::OS,
            "publicKey": public,
        }})
    }

    /// Proof for the service that `key`'s private half is held here (its challenge,
    /// answered), for `purpose`: "setup", "join", "own", "rotate-self" or "member-key". A
    /// service that knows the proof's second form says so in its challenge (`v`: 2), and
    /// the purpose is then part of what is signed; one that doesn't gets the first form.
    pub(super) async fn proof(&self, key: &PrivateKey, purpose: &str) -> Result<Value> {
        let challenge = self
            .api
            .post(
                "challenge",
                &json!({ "publicKey": key.public(), "purpose": purpose }),
            )
            .await?
            .into_ok()?;
        let labelled = challenge["v"].as_u64() == Some(2);
        let answer = key.prove(
            challenge["publicKey"].as_str().unwrap_or(""),
            challenge["nonce"].as_str().unwrap_or(""),
            labelled.then_some(purpose),
        )?;
        Ok(json!({ "id": challenge["id"], "proof": answer }))
    }

    /// Proof that this session's own device key is held here, for a call that changes who
    /// holds the account's keys (approving, new keys, a new recovery key, removing a device):
    /// a stolen sign-in alone can't make one. A proof works once, so each call gets its own.
    async fn own_proof(&self) -> Result<Value> {
        self.proof(&self.device_key()?, "own").await
    }

    /// The account's state as the service gives it, refused when it isn't in the shape a
    /// state has: a broken reply must never read as "sync was reset".
    async fn server_state(&self) -> Result<Value> {
        let state = self.api.get("state").await?;
        if !state["exists"].is_boolean() || !state["devices"].is_array() || !state["epoch"].is_u64()
        {
            return Err(Error::Sync(
                "SyncOffline",
                "The sync service gave an answer that couldn't be read; trying again later.".into(),
            ));
        }
        Ok(state)
    }

    // ------------------------------------------------------------ where things stand

    /// Where sync stands for this device, catching up with what happened elsewhere: handed
    /// the keys, given new ones, removed, or the account's sync reset.
    pub async fn status(&self) -> Result<Status> {
        let Some(uid) = self.uid() else {
            return Ok(Status {
                state: "signedOut".into(),
                ..Default::default()
            });
        };
        let mut server = match self.server_state().await {
            Ok(v) => v,
            Err(Error::Sync("SyncUnavailable", _)) => {
                return Ok(Status {
                    state: "unavailable".into(),
                    ..Default::default()
                });
            }
            Err(Error::Sync("SyncSignedOut", _)) => {
                return Ok(Status {
                    state: "signedOut".into(),
                    ..Default::default()
                });
            }
            Err(e) => return Err(e),
        };
        let mut local = self.local();
        let mut notice = None;
        // Another account signed in here, or another server: that state isn't this one's.
        // Its keys are kept aside: signing in as someone else for a while, or a server named
        // in a setting, must not delete what may be the account's only keys.
        if !local.uid.is_empty() && (local.uid != uid || local.base != self.api.base()) {
            let reason = if local.uid != uid {
                "account"
            } else {
                "server"
            };
            self.leave(&local, reason)?;
            local = Local::default();
        }
        let exists = server["exists"].as_bool().unwrap_or(false);
        let epoch = server["epoch"].as_u64().unwrap_or(0);
        let lapsed_until = server["lapsedUntil"].as_u64();
        let find = |server: &Value, id: &str| {
            server["devices"]
                .as_array()
                .and_then(|l| l.iter().find(|d| d["id"].as_str() == Some(id)))
                .cloned()
        };

        if !local.device_id.is_empty() {
            let mine = find(&server, &local.device_id);
            if local.setting_up && !(exists && mine.is_some()) {
                // Setup was sent and never arrived (or arrived for nobody): start over, quietly.
                self.forget()?;
                local = Local::default();
            } else if !exists || (local.epoch != 0 && local.epoch != epoch) {
                // The service's word alone: sync goes off here and says why, and the keys are
                // put aside (`leave`), not deleted.
                self.leave(&local, "reset")?;
                local = Local::default();
                notice = Some("reset".to_string());
            } else if mine.is_none() {
                self.leave(&local, "removed")?;
                local = Local::default();
                notice = Some("removed".to_string());
            }
        }
        // Keys put aside earlier: said for as long as they are kept, and deleted after that.
        let mut kept = None;
        if let Some((was, aside)) = self.kept() {
            let until = aside.at.saturating_add(ASIDE_KEPT_MS);
            if now_ms() > until {
                self.forget_kept()?;
            } else {
                kept = Some(Kept {
                    resumable: self.resumable(&was, &uid, &server),
                    reason: aside.reason,
                    at: aside.at,
                    until,
                    device_name: was.device_name,
                });
            }
        }

        let mut state = "off";
        let mut own_code = None;
        if !local.device_id.is_empty() {
            let key = self.device_key()?;
            // A new sign-in is a new session: tell the server which device it is again.
            if server["self"].as_str() != Some(local.device_id.as_str()) {
                let mut body = self.device_body(&local, &key.public());
                body["proof"] = self.proof(&key, "join").await?;
                self.api.post("devices", &body).await?.into_ok()?;
                server = self.server_state().await?;
            }
            let mine = find(&server, &local.device_id).unwrap_or(Value::Null);
            state = "pending";
            if mine["status"].as_str() == Some("approved") {
                let version = mine["wrapKeyVersion"].as_u64().unwrap_or(0);
                if let Some(wrap) = mine["wrap"].as_str() {
                    if !local.joined || version != local.key_version {
                        let by = mine["wrapBy"].as_str().unwrap_or("");
                        self.adopt(&mut local, &key, wrap, by, version, epoch)?;
                    }
                }
                if local.joined {
                    match self.keyring() {
                        Ok(ring) => {
                            state = "on";
                            self.catch_up(&mut local, &ring, &server).await;
                        }
                        Err(_) => {
                            // Approved here, and the keys are gone from where they were kept.
                            self.forget()?;
                            local = Local::default();
                            notice = Some("keysLost".to_string());
                            state = "off";
                        }
                    }
                }
            } else if lapsed_until.is_none() {
                own_code = self.pairing(&mut local, &key, &mine).await?;
            }
            // (An ended subscription takes no writes: a waiting computer's answer waits too.)
        }

        let own_public = if local.device_id.is_empty() {
            String::new()
        } else {
            self.device_key().map(|k| k.public()).unwrap_or_default()
        };
        let list = self.device_list(&server, &local, &own_public, own_code.as_deref());
        Ok(Status {
            state: state.into(),
            notice,
            exists,
            device_id: (!local.device_id.is_empty()).then(|| local.device_id.clone()),
            device_name: (!local.device_id.is_empty()).then(|| local.device_name.clone()),
            code: own_code,
            devices: list,
            recovery_created_at: server["recovery"]["createdAt"].as_u64(),
            usage_bytes: server["usageBytes"].as_u64().unwrap_or(0),
            storage_limit: server["storageLimit"].as_u64().unwrap_or(0),
            epoch,
            lapsed_until,
            kept,
        })
    }

    /// The devices as the service lists them, with the pairing code for the ones in a check.
    fn device_list(
        &self,
        server: &Value,
        local: &Local,
        own_public: &str,
        own_code: Option<&str>,
    ) -> Vec<DeviceInfo> {
        let mut reviews = REVIEWS.lock().unwrap_or_else(|e| e.into_inner());
        server["devices"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|d| {
                let text = |name: &str| d[name].as_str().unwrap_or("").to_string();
                let id = text("id");
                let current = !local.device_id.is_empty() && id == local.device_id;
                let review = reviews.iter_mut().find(|r| r.device == id);
                let checking = review.is_some();
                let code = if current {
                    own_code.map(str::to_string)
                } else {
                    review.and_then(|r| {
                        // The waiting device's value counts only when it fits the commitment
                        // this computer fixed before it published its own value.
                        if r.revealed.is_none() {
                            if let Some(value) = d["reveal"].as_str() {
                                if crypto::commitment(&r.public, value) == r.commit {
                                    r.revealed = Some(value.to_string());
                                }
                            }
                        }
                        r.revealed.as_ref().map(|theirs| {
                            crypto::pairing_code(&r.public, own_public, &r.value, theirs)
                        })
                    })
                };
                DeviceInfo {
                    current,
                    checking,
                    code,
                    id,
                    name: text("name"),
                    platform: text("platform"),
                    status: text("status"),
                    created_at: d["createdAt"].as_u64(),
                    last_seen_at: d["lastSeenAt"].as_u64(),
                }
            })
            .collect()
    }

    /// Takes the keyring the service holds for this device, when it really comes from a
    /// device this one trusts: the one it paired with (the first time), or one on the trusted
    /// list as last read (new keys), which must contain the keys already held.
    fn adopt(
        &self,
        local: &mut Local,
        key: &PrivateKey,
        wrap: &str,
        by: &str,
        version: u64,
        epoch: u64,
    ) -> Result<()> {
        let unknown = || {
            keys_error(
                "New sync keys arrived from a computer this one doesn't know; they were not taken.",
            )
        };
        let sender = if by == local.device_id {
            key.public()
        } else if !local.joined {
            local
                .pair_with
                .as_ref()
                .map(|(k, _)| k.clone())
                .ok_or_else(unknown)?
        } else {
            local
                .trusted
                .iter()
                .find(|(id, _)| id == by)
                .map(|(_, k)| k.clone())
                .ok_or_else(unknown)?
        };
        let ring = Keyring::from_bytes(&key.open_from(&sender, wrap)?)?;
        if local.joined {
            let held = self.keyring()?;
            if !ring.extends(&held) {
                return Err(keys_error(
                    "New sync keys don't contain the ones this computer holds; they were not taken.",
                ));
            }
        }
        self.store_keyring(&ring)?;
        local.joined = true;
        local.setting_up = false;
        local.key_version = version;
        local.epoch = epoch;
        local.pair_value.clear();
        local.pair_with = None;
        local.revealed = false;
        self.save_local(local)
    }

    /// With the keys held: writes what is still owed (trusted-list changes, a recovery key),
    /// reads the list, and makes new keys when a device was removed. Each is best effort: the
    /// next check tries again.
    async fn catch_up(&self, local: &mut Local, ring: &Keyring, server: &Value) {
        // An ended subscription takes no writes: what is owed stays owed, and the list is read.
        if server["lapsedUntil"].as_u64().is_some() {
            let _ = self.trusted(local, ring).await;
            return;
        }
        let owed = std::mem::take(&mut local.pending_trust);
        for change in owed {
            if self.write_trust(local, ring, &change).await.is_err() {
                local.pending_trust.push(change);
            }
        }
        if let Some((public, wrap)) = local.pending_recovery.clone() {
            if self.put_recovery(local, &public, &wrap).await.is_ok() {
                local.pending_recovery = None;
            }
        }
        let _ = self.save_local(local);
        if let Ok(list) = self.trusted(local, ring).await {
            // What this computer has to say in the list that the list doesn't say yet.
            let upkeep = self.upkeep(local, &list);
            if upkeep != TrustChange::default() {
                let _ = self.write_trust(local, ring, &upkeep).await;
            }
        }
        // New keys: the service asks for them, or this computer removed a device and owes them.
        if server["rotationNeeded"].as_bool().unwrap_or(false) || local.rotation_owed {
            let _ = self.rotate(local).await;
        }
        // After new keys (made here or elsewhere): the small records sealed again with them.
        if let Ok(ring) = self.keyring() {
            let _ = self.seal_again(local, &ring).await;
        }
    }

    /// The changes this computer owes the trusted list for itself: that its app writes
    /// counters, and the member key and pins counter it knows when the list names none (an
    /// older version wrote the list since, and dropped what it didn't know).
    fn upkeep(&self, local: &Local, list: &Trusted) -> TrustChange {
        let mut change = TrustChange::default();
        if list.devices.iter().any(|(id, _)| *id == local.device_id)
            && !list.counted.contains(&local.device_id)
        {
            change.counted.push(local.device_id.clone());
        }
        if let Some(key) = &local.member {
            let behind =
                list.member.as_deref() == Some(key.as_str()) && list.pins < local.member_pins;
            if list.member.is_none() || behind {
                change.member = Some(MemberAnchor {
                    key: key.clone(),
                    pins: local.member_pins,
                    replace: false,
                });
            }
        }
        change
    }

    async fn put_recovery(&self, local: &Local, public: &str, wrap: &str) -> Result<()> {
        let body = json!({
            "publicKey": public,
            "wrap": wrap,
            "keyVersion": local.key_version,
            "challenge": self.own_proof().await?,
        });
        self.api.put("recovery", &body).await?.into_ok()?;
        Ok(())
    }

    /// Seals the small records of the account again when they were sealed with keys older
    /// than the newest (`SEALED_AGAIN`), then states the floor in the trusted list: from then
    /// on no computer of the account takes a record of `FLOORED` sealed with older keys, which
    /// a removed device could still make. Done by whichever computer finds the floors behind
    /// the keys; doing it twice changes nothing.
    async fn seal_again(&self, local: &mut Local, ring: &Keyring) -> Result<()> {
        let want = ring.current();
        // (With the first keys there is nothing older to tell from.)
        if want <= 1
            || FLOORED
                .iter()
                .all(|c| local.floors.get(*c).copied().unwrap_or(0) >= want)
        {
            return Ok(());
        }
        let mut names = Vec::new();
        let mut since = 0;
        // (The bound only stops an answer that never ends.)
        for _ in 0..2000 {
            let page = self.api.get(&format!("records?since={since}")).await?;
            let records = page["records"]
                .as_array()
                .ok_or_else(super::api::unreadable)?;
            let mut last = since;
            for record in records {
                last = last.max(record["seq"].as_u64().unwrap_or(0));
                let collection = record["collection"].as_str().unwrap_or("");
                let id = record["id"].as_str().unwrap_or("");
                if SEALED_AGAIN.contains(&collection)
                    && record["deleted"].as_bool() != Some(true)
                    && records::named(collection, id).is_ok()
                {
                    names.push((collection.to_string(), id.to_string()));
                }
            }
            if page["more"].as_bool() != Some(true) || last <= since {
                break;
            }
            since = last;
        }
        names.sort();
        names.dedup();
        for (collection, id) in &names {
            if !records::reseal(&self.api, ring, collection, id).await? {
                // One that can't be read or keeps changing: the floor waits for it.
                return Err(keys_error(
                    "A synced item couldn't be sealed with the new keys yet; trying again later.",
                ));
            }
        }
        let change = TrustChange {
            floors: Some(want),
            ..Default::default()
        };
        self.write_trust(local, ring, &change).await
    }

    /// This computer waiting: once an approving computer has published its key and value,
    /// fixes them, reveals its own value, and gives the code both now show.
    async fn pairing(
        &self,
        local: &mut Local,
        key: &PrivateKey,
        mine: &Value,
    ) -> Result<Option<String>> {
        let (Some(theirs), Some(value)) = (mine["codeByKey"].as_str(), mine["codeNonce"].as_str())
        else {
            return Ok(None);
        };
        match &local.pair_with {
            None => {
                local.pair_with = Some((theirs.to_string(), value.to_string()));
                local.revealed = false;
                self.save_local(local)?;
            }
            // Another check started after this computer gave its value away: that value can't
            // be used twice (a key could be picked to fit it). Joining again starts fresh.
            Some((k, v)) if k != theirs || v != value => return Ok(None),
            Some(_) => {}
        }
        if !local.revealed {
            let body = json!({ "nonce": local.pair_value, "codeNonce": value });
            self.api
                .post(&format!("devices/{}/reveal", local.device_id), &body)
                .await?
                .into_ok()?;
            local.revealed = true;
            self.save_local(local)?;
        }
        Ok(Some(crypto::pairing_code(
            &key.public(),
            theirs,
            value,
            &local.pair_value,
        )))
    }

    // ------------------------------------------------------------ the first device

    /// Makes this device's keys, the account's keyring and a recovery key, all in memory, and
    /// returns the recovery key to show. Nothing is sent until `setup` gets it typed back.
    pub fn prepare(&self, name: &str) -> Result<String> {
        let prepared = Prepared {
            base: self.api.base().to_string(),
            device: PrivateKey::generate()?,
            ring: Keyring::generate()?,
            recovery: PrivateKey::generate()?,
            name: clean_name(name),
        };
        let text = crypto::recovery_text(&prepared.recovery);
        *PREPARED.lock().unwrap_or_else(|e| e.into_inner()) = Some(prepared);
        Ok(text)
    }

    /// Turns sync on for the account, once `typed` matches the recovery key shown by `prepare`
    /// (all of it, or its last group: proof that it was kept).
    pub async fn setup(&self, typed: &str) -> Result<()> {
        let prepared = PREPARED
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .filter(|p| p.base == self.api.base())
            .ok_or_else(|| Error::Sync("Sync", "Start turning sync on again.".into()))?;
        let text = crypto::recovery_text(&prepared.recovery);
        if !recovery_confirmed(&text, typed) {
            // Kept for another try: a typo shouldn't make a new key.
            *PREPARED.lock().unwrap_or_else(|e| e.into_inner()) = Some(prepared);
            return Err(Error::Sync(
                "SyncRecoveryKey",
                "That doesn't match the recovery key.".into(),
            ));
        }
        let uid = self.uid().ok_or_else(signed_out)?;
        let public = prepared.device.public();
        let pin = (prepared.recovery.public(), prepared.recovery.auth_key()?);
        let device_id = crypto::new_id()?;
        let mut local = Local {
            base: self.api.base().to_string(),
            uid,
            device_id: device_id.clone(),
            device_name: prepared.name.clone(),
            setting_up: true,
            key_version: 1,
            pending_trust: vec![TrustChange {
                add: vec![(device_id.clone(), public.clone())],
                pin: Some(pin.clone()),
                create: true,
                // The first device writes counters from its first record on.
                counted: vec![device_id],
                ..Default::default()
            }],
            ..Default::default()
        };
        let bytes = prepared.ring.to_bytes()?;
        let mut body = self.device_body(&local, &public);
        body["proof"] = self.proof(&prepared.device, "setup").await?;
        // Boxed from this device to itself: what it takes back, should the reply be lost.
        body["wrap"] = json!(crypto::box_to(&prepared.device, &public, &bytes)?);
        body["recovery"] = json!({
            "publicKey": pin.0,
            "wrap": crypto::recovery_wrap(&pin.0, &pin.1, &bytes, 0)?,
        });
        // Turning sync on from the start is the person's word that keys put aside earlier
        // (another life of the vault, another account) are done with.
        self.forget_kept()?;
        // Everything is kept before it is sent: a reply that never arrives leaves a vault
        // this computer can still open at its next check.
        secrets::set(
            &self.secrets_file(),
            DEVICE_SECRET,
            Some(&prepared.device.to_text()),
        )?;
        self.store_keyring(&prepared.ring)?;
        self.save_local(&local)?;
        let reply = match self
            .api
            .post("setup", &body)
            .await
            .and_then(|r| r.into_ok())
        {
            Ok(reply) => reply,
            // No answer: it may have arrived. The next status check finds out.
            Err(e @ Error::Sync("SyncOffline", _)) => return Err(e),
            // The service said no (the account syncs already, a bad request): nothing was made.
            Err(e) => {
                self.forget()?;
                return Err(e);
            }
        };
        local.epoch = reply["epoch"].as_u64().unwrap_or(1);
        local.setting_up = false;
        local.joined = true;
        self.save_local(&local)?;
        self.catch_up(&mut local, &prepared.ring, &json!({})).await;
        Ok(())
    }

    // ------------------------------------------------------------ joining

    /// Gives this computer another name, here and in the account's list of computers. The
    /// service takes it from the device itself only (with proof of its key).
    pub async fn rename(&self, name: &str) -> Result<String> {
        let mut local = self.local();
        if local.device_id.is_empty() {
            return Err(Error::Sync(
                "SyncOff",
                "Sync isn't on for this device.".into(),
            ));
        }
        local.device_name = clean_name(name);
        let key = self.device_key()?;
        let mut body = self.device_body(&local, &key.public());
        body["proof"] = self.proof(&key, "join").await?;
        self.api.post("devices", &body).await?.into_ok()?;
        // Kept once the account has it, so the two never disagree.
        self.save_local(&local)?;
        Ok(local.device_name)
    }

    /// Registers this device with an account that already syncs, to wait for approval (or
    /// for the recovery key). The code to compare shows once an approving computer starts
    /// checking this one.
    pub async fn join(&self, name: &str) -> Result<()> {
        let uid = self.uid().ok_or_else(signed_out)?;
        let server = self.server_state().await?;
        let mut local = self.local();
        let key = if local.device_id.is_empty() || local.uid != uid {
            let key = PrivateKey::generate()?;
            // Joining from the start: keys put aside earlier are done with (see `setup`).
            self.forget_kept()?;
            local = Local {
                base: self.api.base().to_string(),
                uid,
                epoch: server["epoch"].as_u64().unwrap_or(0),
                device_id: crypto::new_id()?,
                device_name: clean_name(name),
                // This computer's part of the pairing code, kept to itself for now.
                pair_value: crypto::b64(&crypto::random::<16>()?),
                ..Default::default()
            };
            secrets::set(&self.secrets_file(), DEVICE_SECRET, Some(&key.to_text()))?;
            self.save_local(&local)?;
            key
        } else {
            self.device_key()?
        };
        let mut body = self.device_body(&local, &key.public());
        body["device"]["commit"] = json!(crypto::commitment(&key.public(), &local.pair_value));
        body["proof"] = self.proof(&key, "join").await?;
        self.api.post("devices", &body).await?.into_ok()?;
        Ok(())
    }

    /// Starts checking a waiting device: fixes its key and its commitment, chooses this
    /// computer's value and publishes it. The code shows (in the status) once the waiting
    /// device has answered with a value that fits its commitment.
    pub async fn review(&self, device_id: &str) -> Result<()> {
        self.keyring()?;
        let server = self.server_state().await?;
        let device = server["devices"]
            .as_array()
            .and_then(|l| {
                l.iter().find(|d| {
                    d["id"].as_str() == Some(device_id) && d["status"].as_str() == Some("pending")
                })
            })
            .ok_or_else(|| Error::Sync("Sync", "That device is no longer waiting.".into()))?;
        let public = device["publicKey"].as_str().unwrap_or("").to_string();
        let commit = device["commit"].as_str().unwrap_or("").to_string();
        if commit.is_empty() {
            return Err(Error::Sync(
                "Sync",
                "That computer needs a newer version of the app to be checked.".into(),
            ));
        }
        // One check per waiting device: a second would need its value twice.
        if REVIEWS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .any(|r| r.device == device_id && r.public == public && r.commit == commit)
        {
            return Ok(());
        }
        let value = crypto::b64(&crypto::random::<16>()?);
        self.api
            .post(
                &format!("devices/{device_id}/code"),
                &json!({ "nonce": value, "publicKey": public, "commit": commit }),
            )
            .await?
            .into_ok()?;
        let mut reviews = REVIEWS.lock().unwrap_or_else(|e| e.into_inner());
        reviews.retain(|r| r.device != device_id);
        reviews.push(Review {
            device: device_id.to_string(),
            public,
            commit,
            value,
            revealed: None,
        });
        Ok(())
    }

    /// Joins with the recovery key instead of another device's approval.
    pub async fn join_with_recovery(&self, name: &str, typed: &str) -> Result<()> {
        let recovery = crypto::parse_recovery(typed)?;
        self.join(name).await?;
        let mut local = self.local();
        let key = self.device_key()?;
        let stored = self.api.get("recovery").await?;
        // Opens only when one of the account's devices wrapped it: keys made up by whoever
        // stores the wrap carry no valid tag.
        let opened = recovery.open_recovery(stored["wrap"].as_str().unwrap_or(""))?;
        let ring = Keyring::from_bytes(&opened)?;
        // The wrap says, under the same tag, how far the trusted list had counted when it was
        // made: a list older than that isn't the account's current one (this computer has
        // no list of its own to compare with).
        local.trusted_n = local.trusted_n.max(crypto::recovery_floor(&opened));
        let version = stored["keyVersion"].as_u64().unwrap_or(0);
        let public = key.public();
        let body = json!({
            "self": true,
            "wrap": crypto::box_to(&key, &public, &ring.to_bytes()?)?,
            "keyVersion": version,
            "proof": self.proof(&recovery, "rotate-self").await?,
        });
        self.api.post("keyring", &body).await?.into_ok()?;
        self.store_keyring(&ring)?;
        local.joined = true;
        local.key_version = version;
        local.pending_trust.push(TrustChange {
            add: vec![(local.device_id.clone(), public)],
            ..Default::default()
        });
        self.save_local(&local)?;
        // The account's sealed list must open with these keys and name this recovery key.
        match self.trusted(&mut local, &ring).await {
            Ok(list)
                if list
                    .recovery
                    .as_ref()
                    .is_some_and(|(pin, _)| *pin == recovery.public()) => {}
            // Not reachable just now: checked again with everything else at the next status.
            Err(Error::Sync("SyncOffline", _)) => return Ok(()),
            _ => {
                let _ = self.delete_device(&local.device_id).await;
                self.forget()?;
                return Err(Error::Sync(
                    "SyncRecoveryKey",
                    "That recovery key isn't this account's current one.".into(),
                ));
            }
        }
        self.catch_up(&mut local, &ring, &json!({})).await;
        Ok(())
    }

    /// Hands the keys to a waiting device this computer checked (`review`): boxed from this
    /// device's key to the key it fixed then, which is the one the code was made from.
    pub async fn approve(&self, device_id: &str) -> Result<()> {
        let ring = self.keyring()?;
        let review = REVIEWS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|r| r.device == device_id && r.revealed.is_some())
            .cloned()
            .ok_or_else(|| Error::Sync("Sync", "Check that device's code first.".into()))?;
        let mut local = self.local();
        let key = self.device_key()?;
        let body = json!({
            "wrap": crypto::box_to(&key, &review.public, &ring.to_bytes()?)?,
            // The keys as this computer holds them: stale ones are refused, not passed on.
            "keyVersion": local.key_version,
            "publicKey": review.public,
            "challenge": self.own_proof().await?,
        });
        self.api
            .post(&format!("devices/{device_id}/approve"), &body)
            .await?
            .into_ok()?;
        REVIEWS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|r| r.device != device_id);
        self.trust(
            &mut local,
            &ring,
            TrustChange {
                add: vec![(device_id.to_string(), review.public)],
                ..Default::default()
            },
        )
        .await
    }

    /// Removes a device from the account (this one: sync goes off here). The others get new
    /// keys, so what is synced from now on can't be read with the removed device's copy.
    pub async fn remove(&self, device_id: &str) -> Result<()> {
        let mut local = self.local();
        let own = local.device_id == device_id;
        if let (false, Ok(ring)) = (own, self.keyring()) {
            // Out of the trusted list first, so new keys are never wrapped for it. When that
            // can't be written the removal doesn't happen at all.
            let change = TrustChange {
                remove: vec![device_id.to_string()],
                ..Default::default()
            };
            self.write_trust(&mut local, &ring, &change).await?;
            // New keys are owed from here on, and made whatever the service says of them:
            // remembered first, so a window closed now still makes them at its next check.
            local.rotation_owed = true;
            self.save_local(&local)?;
        }
        REVIEWS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|r| r.device != device_id);
        // With proof of this computer's key when it has one (a computer still waiting to be
        // approved withdraws without).
        match self.device_key() {
            Ok(_) => self.delete_device(device_id).await?,
            Err(_) => {
                self.api.delete(&format!("devices/{device_id}")).await?;
            }
        }
        if own {
            // The person turned sync off here: their word, so the keys go.
            self.forget()?;
        } else if self.keyring().is_ok() {
            // Best effort now; owed (and done at the next status check) until it worked.
            let _ = self.rotate(&mut local).await;
            if let Ok(ring) = self.keyring() {
                let _ = self.seal_again(&mut local, &ring).await;
            }
        }
        Ok(())
    }

    /// A new recovery key; the old one stops working. Returns the text to show.
    pub async fn new_recovery_key(&self) -> Result<String> {
        let ring = self.keyring()?;
        let mut local = self.local();
        let recovery = PrivateKey::generate()?;
        let pin = (recovery.public(), recovery.auth_key()?);
        // The account's devices name it first; the service gets its wrap next, and again at
        // the next check should that not arrive. Either way the key shown is the one that works.
        let change = TrustChange {
            pin: Some(pin.clone()),
            ..Default::default()
        };
        self.write_trust(&mut local, &ring, &change).await?;
        // (The wrap states the list's counter as it is now, with the key in it.)
        let wrap = crypto::recovery_wrap(&pin.0, &pin.1, &ring.to_bytes()?, local.trusted_n)?;
        local.pending_recovery = Some((pin.0.clone(), wrap.clone()));
        self.save_local(&local)?;
        if self.put_recovery(&local, &pin.0, &wrap).await.is_ok() {
            local.pending_recovery = None;
            self.save_local(&local)?;
        }
        Ok(crypto::recovery_text(&recovery))
    }

    // ------------------------------------------------------------ the trusted list and new keys

    /// The sealed list as the account has it. Refused when it is missing, can't be opened,
    /// or is older than one this computer has seen: nothing is decided from such a list.
    /// What is read is kept here: its counter, and the devices on it.
    async fn trusted(&self, local: &mut Local, ring: &Keyring) -> Result<Trusted> {
        let untrusted = || {
            keys_error(
                "The account's list of trusted devices couldn't be read; nothing was changed.",
            )
        };
        let record = records::get(&self.api, ring, TRUSTED.0, TRUSTED.1)
            .await?
            .filter(|r| !r.deleted && !r.unreadable)
            .ok_or_else(untrusted)?;
        let list = parse_trusted(record.text.as_deref()).ok_or_else(untrusted)?;
        let generation = record.generation.unwrap_or(0);
        if !list_continues(local, &list, generation) {
            return Err(untrusted());
        }
        self.take_list(local, &list, generation)?;
        Ok(list)
    }

    /// Keeps what a list that was taken says: its counter and devices, the generation it was
    /// sealed under, and what every record is checked against from here on.
    fn take_list(&self, local: &mut Local, list: &Trusted, generation: u32) -> Result<()> {
        let before = serde_json::to_string(local)?;
        local.trusted_n = list.n;
        local.trusted = list.devices.clone();
        local.list_generation = local.list_generation.max(generation);
        local.strict = list.all_counted();
        // Floors only go up: a list an older version wrote names none, and takes none away.
        for (collection, floor) in &list.floors {
            let mine = local.floors.entry(collection.clone()).or_insert(0);
            *mine = (*mine).max(*floor);
        }
        match &list.member {
            Some(key) if local.member.as_deref() != Some(key.as_str()) => {
                local.member = Some(key.clone());
                local.member_pins = list.pins;
            }
            Some(_) => local.member_pins = local.member_pins.max(list.pins),
            None => {}
        }
        if serde_json::to_string(local)? != before {
            self.save_local(local)?;
        }
        Ok(())
    }

    /// Changes the trusted list; when that fails the change is kept and done again at the
    /// next status check.
    async fn trust(&self, local: &mut Local, ring: &Keyring, change: TrustChange) -> Result<()> {
        if let Err(e) = self.write_trust(local, ring, &change).await {
            local.pending_trust.push(change);
            self.save_local(local)?;
            return Err(e);
        }
        Ok(())
    }

    async fn write_trust(
        &self,
        local: &mut Local,
        ring: &Keyring,
        change: &TrustChange,
    ) -> Result<()> {
        let floor = local.trusted_n;
        let mut written: Option<Trusted> = None;
        let mut missing = false;
        records::update(&self.api, ring, TRUSTED.0, TRUSTED.1, |now| {
            let before = match parse_trusted(now) {
                Some(list) if list.n >= floor => list,
                // No list (or one that can't be read): only setup makes it.
                None if change.create => Trusted::default(),
                // A list older than one this computer saw, or none: not built on.
                _ => {
                    missing = true;
                    return None;
                }
            };
            missing = false;
            let mut next = changed_list(&before, change);
            if next == before {
                written = Some(before);
                return None;
            }
            next.n = before.n.max(floor) + 1;
            let text = trusted_text(&next);
            written = Some(next);
            Some(text)
        })
        .await?;
        if missing {
            return Err(keys_error(
                "The account's list of trusted devices couldn't be read; nothing was changed.",
            ));
        }
        if let Some(list) = written {
            if list.n >= local.trusted_n {
                // (Written with the newest keys this computer holds, or read as it is.)
                self.take_list(local, &list, 0)?;
            }
        }
        Ok(())
    }

    /// A new key generation, boxed from this device for every device on the account's sealed
    /// list and wrapped for the recovery key that list names. A device the service lists as
    /// approved that isn't on the list never gets the keys: it is taken off instead.
    ///
    /// Made when the service asks for them, and whenever this computer removed a device
    /// (`rotation_owed`), whatever the service says: a service that sided with the removed
    /// device would simply not ask.
    async fn rotate(&self, local: &mut Local) -> Result<()> {
        let ring = self.keyring()?;
        let key = self.device_key()?;
        let server = self.server_state().await?;
        if !server["rotationNeeded"].as_bool().unwrap_or(false) && !local.rotation_owed {
            // (Another computer made them: what was waited for then says nothing later.)
            if !local.first_seen.is_empty() {
                local.first_seen.clear();
                self.save_local(local)?;
            }
            return Ok(());
        }
        // Nothing is decided from a list that is missing, unreadable or old.
        let trusted = self.trusted(local, &ring).await?;
        if !trusted.devices.iter().any(|(id, _)| *id == local.device_id) {
            return Err(keys_error(
                "This computer isn't on the account's list of trusted devices; nothing was changed.",
            ));
        }
        // The recovery key the account's devices pinned, never one the service names.
        let (recovery, recovery_auth) = trusted.recovery.clone().ok_or_else(|| {
            keys_error("This account's recovery key needs replacing: make a new recovery key.")
        })?;
        let approved: Vec<(String, String)> = server["devices"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|d| d["status"].as_str() == Some("approved"))
            .map(|d| {
                (
                    d["id"].as_str().unwrap_or("").to_string(),
                    d["publicKey"].as_str().unwrap_or("").to_string(),
                )
            })
            .collect();
        let plan = rotation_plan(
            &approved,
            &trusted.devices,
            &local.pending_trust,
            &local.first_seen,
            now_ms(),
        );
        if plan.first_seen != local.first_seen {
            local.first_seen = plan.first_seen.clone();
            self.save_local(local)?;
        }
        // A device that joined moments ago is approved before the list names it (the write
        // that adds it is on its way from the computer that approved it). New keys wait for
        // that write, a few minutes by this computer's clock: made now they would leave it
        // out, and it would be taken off. Nothing is handed to it meanwhile.
        if plan.wait {
            return Ok(());
        }
        let next = ring.rotated()?;
        let bytes = next.to_bytes()?;
        let mut wraps = serde_json::Map::new();
        for (id, public) in &plan.wrap {
            wraps.insert(id.clone(), json!(crypto::box_to(&key, public, &bytes)?));
        }
        for id in &plan.remove {
            // Listed as approved by the service, approved by none of the account's devices.
            self.delete_device(id).await?;
        }
        let body = json!({
            "expectKeyVersion": server["keyVersion"],
            "wraps": wraps,
            "recoveryWrap": crypto::recovery_wrap(&recovery, &recovery_auth, &bytes, trusted.n)?,
            "recoveryPublicKey": recovery,
            "challenge": self.own_proof().await?,
        });
        let reply = self.api.post("keyring", &body).await?.into_ok()?;
        self.store_keyring(&next)?;
        local.key_version = reply["keyVersion"]
            .as_u64()
            .unwrap_or(local.key_version + 1);
        local.rotation_owed = false;
        local.first_seen.clear();
        self.save_local(local)?;
        // The list again, sealed with the new keys and one higher: what the removed device
        // holds can no longer make a list the others would take.
        let floor = local.trusted_n;
        let _ = records::update(&self.api, &next, TRUSTED.0, TRUSTED.1, |now| {
            let mut list = parse_trusted(now)?;
            list.n = list.n.max(floor) + 1;
            Some(trusted_text(&list))
        })
        .await;
        let _ = self.trusted(local, &next).await;
        Ok(())
    }

    /// Removes a device from the account, with proof of this computer's own key.
    async fn delete_device(&self, device_id: &str) -> Result<()> {
        let proof = self.own_proof().await?;
        self.api
            .delete_proved(&format!("devices/{device_id}"), &proof)
            .await?;
        Ok(())
    }
}

fn epoch_matches(joined: u64, stated: u64) -> bool {
    joined == 0 || joined == stated
}

/// How long new keys wait for an approved device the trusted list doesn't name yet.
const JOIN_GRACE_MS: u64 = 10 * 60 * 1000;

/// What making new keys does about the devices the service lists as approved.
#[derive(Debug, PartialEq, Eq)]
struct RotationPlan {
    /// Devices that get the new keys: on the trusted list with that key, or approved by this
    /// computer itself (it compared the code), the list's write still owed.
    wrap: Vec<(String, String)>,
    /// Devices none of the account's computers approved: taken off.
    remove: Vec<String>,
    /// One of them may only be new (`may_be_joining`): the keys are made at a later check.
    wait: bool,
    /// When each unlisted device was first seen here, to keep.
    first_seen: Vec<(String, String, u64)>,
}

fn rotation_plan(
    approved: &[(String, String)],
    trusted: &[(String, String)],
    owed: &[TrustChange],
    first_seen: &[(String, String, u64)],
    now_ms: u64,
) -> RotationPlan {
    let mut plan = RotationPlan {
        wrap: Vec::new(),
        remove: Vec::new(),
        wait: false,
        // Kept until the keys are made, also for devices no longer listed: the wait is
        // counted from the first of them, so a new unlisted device every few minutes
        // doesn't start it again.
        first_seen: first_seen.to_vec(),
    };
    let waiting_since = first_seen
        .iter()
        .map(|(_, _, at)| *at)
        .min()
        .unwrap_or(now_ms);
    let mut unlisted = Vec::new();
    for (id, public) in approved {
        let listed = trusted.iter().any(|(t, k)| t == id && k == public);
        let own_approval = owed
            .iter()
            .any(|change| change.add.iter().any(|(a, k)| a == id && k == public));
        if listed || own_approval {
            plan.wrap.push((id.clone(), public.clone()));
            continue;
        }
        if !first_seen.iter().any(|(i, k, _)| i == id && k == public) && plan.first_seen.len() < 64
        {
            plan.first_seen.push((id.clone(), public.clone(), now_ms));
        }
        unlisted.push(id.clone());
    }
    if !unlisted.is_empty() && may_be_joining(waiting_since, now_ms) {
        plan.wait = true;
    } else {
        plan.remove = unlisted;
    }
    plan
}

fn parse_trusted(text: Option<&str>) -> Option<Trusted> {
    let v = serde_json::from_str::<Value>(text?).ok()?;
    Some(Trusted {
        devices: v["devices"]
            .as_array()?
            .iter()
            .filter_map(|d| {
                Some((
                    d["id"].as_str()?.to_string(),
                    d["publicKey"].as_str()?.to_string(),
                ))
            })
            .collect(),
        recovery: v["recovery"]
            .as_str()
            .zip(v["recoveryAuth"].as_str())
            .map(|(public, auth)| (public.to_string(), auth.to_string())),
        n: v["n"].as_u64().unwrap_or(0),
        counted: v["counted"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|id| id.as_str().map(str::to_string))
            .collect(),
        floors: v["floors"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(collection, floor)| {
                Some((collection.clone(), u32::try_from(floor.as_u64()?).ok()?))
            })
            .collect(),
        member: v["member"].as_str().map(str::to_string),
        pins: v["pins"].as_u64().unwrap_or(0),
    })
}

/// Whether a list read from the account may take the place of the one this computer holds:
/// not older by its counter, not sealed with older keys than the last one taken, and not
/// sealed below the floor it states for its own collection.
fn list_continues(local: &Local, list: &Trusted, generation: u32) -> bool {
    list.n >= local.trusted_n
        && generation >= local.list_generation
        && generation >= list.floors.get(TRUSTED.0).copied().unwrap_or(0)
}

/// Whether what was typed back proves the recovery key was kept: the whole key, or its last
/// group of four.
fn recovery_confirmed(key: &str, typed: &str) -> bool {
    let clean = |s: &str| {
        s.chars()
            .filter(|c| !c.is_whitespace() && *c != '-')
            .map(|c| match c.to_ascii_uppercase() {
                'O' => '0',
                'I' | 'L' => '1',
                other => other,
            })
            .collect::<String>()
    };
    let (key, typed) = (clean(key), clean(typed));
    typed.len() >= 4 && (typed == key || (typed.len() == 4 && key.ends_with(&typed)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair(id: &str, key: &str) -> (String, String) {
        (id.to_string(), key.to_string())
    }

    #[test]
    fn new_keys_wait_for_a_joining_device_by_this_computers_clock_and_not_for_long() {
        let now = 1_800_000_000_000u64;
        let trusted = [pair("d1", "key1")];
        let approved = [pair("d1", "key1"), pair("d2", "key2")];
        // First seen now: it may only be new, so the keys wait, and the time is noted.
        let plan = rotation_plan(&approved, &trusted, &[], &[], now);
        assert!(plan.wait && plan.remove.is_empty());
        assert_eq!(plan.first_seen, vec![("d2".into(), "key2".into(), now)]);
        // Still within the minutes allowed.
        let later = rotation_plan(&approved, &trusted, &[], &plan.first_seen, now + 60_000);
        assert!(later.wait);
        // Past them: the keys are made, and the device nobody approved is taken off.
        // (Whatever the service says of when it was added: nothing of the service's is asked.)
        let past = now + JOIN_GRACE_MS + 1;
        let late = rotation_plan(&approved, &trusted, &[], &plan.first_seen, past);
        assert!(!late.wait);
        assert_eq!(late.wrap, vec![pair("d1", "key1")]);
        assert_eq!(late.remove, vec!["d2".to_string()]);
        // Another unlisted device every few minutes doesn't start the wait again.
        let another = [pair("d1", "key1"), pair("d3", "key3")];
        let again = rotation_plan(&another, &trusted, &[], &plan.first_seen, past);
        assert!(!again.wait);
        assert_eq!(again.remove, vec!["d3".to_string()]);
        // A device this computer approved itself (the list's write still owed) gets the
        // keys and holds nothing up, however long the write is owed.
        let owed = [TrustChange {
            add: vec![pair("d2", "key2")],
            ..Default::default()
        }];
        let own = rotation_plan(&approved, &trusted, &owed, &[], past);
        assert!(!own.wait && own.remove.is_empty());
        assert_eq!(own.wrap, vec![pair("d1", "key1"), pair("d2", "key2")]);
        // Owed for another key: not this device.
        let other = [TrustChange {
            add: vec![pair("d2", "another")],
            ..Default::default()
        }];
        assert!(rotation_plan(&approved, &trusted, &other, &[], now).wait);
        // Nothing unlisted: nothing waits.
        assert!(!rotation_plan(&trusted, &trusted, &[], &[], now).wait);
    }

    #[test]
    fn a_list_sealed_with_older_keys_or_counted_lower_is_not_taken() {
        let list = |n: u64| Trusted {
            devices: vec![pair("d1", "key1")],
            n,
            ..Default::default()
        };
        let local = Local {
            trusted_n: 7,
            list_generation: 3,
            ..Default::default()
        };
        assert!(list_continues(&local, &list(7), 3));
        assert!(list_continues(&local, &list(8), 4));
        // Rolled back by its counter.
        assert!(!list_continues(&local, &list(6), 3));
        // A list a removed device could still make: counted higher, sealed with the keys
        // from before it was removed.
        assert!(!list_continues(&local, &list(99), 2));
        // Sealed below the floor it states itself.
        let mut floored = list(8);
        floored.floors.insert("sys".into(), 5);
        assert!(!list_continues(&local, &floored, 4));
        assert!(list_continues(&local, &floored, 5));
        // A computer that never took a list takes the first it can open.
        assert!(list_continues(&Local::default(), &list(1), 1));
    }

    #[test]
    fn the_list_states_counters_floors_and_the_member_key() {
        let before = Trusted {
            devices: vec![pair("d1", "key1"), pair("d2", "key2")],
            n: 3,
            counted: vec!["d1".into()],
            ..Default::default()
        };
        assert!(!before.all_counted());
        // Each device says for itself that it writes counters; a stranger's word is dropped.
        let counted = changed_list(
            &before,
            &TrustChange {
                counted: vec!["d2".into(), "nobody".into()],
                ..Default::default()
            },
        );
        assert!(counted.all_counted());
        assert_eq!(counted.counted, vec!["d1".to_string(), "d2".to_string()]);
        // A removed device no longer counts.
        let removed = changed_list(
            &counted,
            &TrustChange {
                remove: vec!["d2".into()],
                ..Default::default()
            },
        );
        assert_eq!(removed.counted, vec!["d1".to_string()]);
        assert!(removed.all_counted());
        // Floors go up only.
        let up = |list: &Trusted, g: u32| {
            changed_list(
                list,
                &TrustChange {
                    floors: Some(g),
                    ..Default::default()
                },
            )
        };
        let floored = up(&before, 3);
        assert_eq!(floored.floors.get("sys"), Some(&3));
        assert_eq!(floored.floors.get("files"), Some(&3));
        assert_eq!(floored.floors.get("chats"), None);
        assert_eq!(up(&floored, 2), floored);
        // The member key is named once; another key takes its place only when the person
        // started over, and the pins counter only goes up otherwise.
        let anchor = |key: &str, pins: u64, replace: bool| TrustChange {
            member: Some(MemberAnchor {
                key: key.into(),
                pins,
                replace,
            }),
            ..Default::default()
        };
        let named = changed_list(&before, &anchor("m1", 0, false));
        assert_eq!((named.member.as_deref(), named.pins), (Some("m1"), 0));
        let raised = changed_list(&named, &anchor("m1", 4, false));
        assert_eq!(raised.pins, 4);
        assert_eq!(changed_list(&raised, &anchor("m1", 2, false)), raised);
        assert_eq!(changed_list(&raised, &anchor("other", 9, false)), raised);
        let replaced = changed_list(&raised, &anchor("m2", 5, true));
        assert_eq!((replaced.member.as_deref(), replaced.pins), (Some("m2"), 5));
        // All of it survives being written and read.
        let mut full = up(&replaced, 3);
        full.counted = vec!["d1".into()];
        assert_eq!(parse_trusted(Some(&trusted_text(&full))).unwrap(), full);
    }

    #[test]
    fn changes_of_another_life_of_the_vault_are_not_this_computers() {
        assert!(epoch_matches(4, 4));
        // A page that says "epoch 5" to a computer that joined 4: not taken as a reset by
        // the sync loop (which would start from nothing and take the account's side).
        assert!(!epoch_matches(4, 5));
        assert!(!epoch_matches(4, 3));
        assert!(epoch_matches(0, 7));
    }

    fn temp_vault(name: &str) -> (Vault, PathBuf) {
        let dir = std::env::temp_dir().join(format!("ide-vault-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        (Vault::new("https://accounts.example", &dir), dir)
    }

    #[test]
    fn keys_are_put_aside_when_the_service_says_sync_is_gone_and_only_the_person_deletes_them() {
        let (vault, dir) = temp_vault("aside");
        let device = PrivateKey::generate().unwrap();
        let ring = Keyring::generate().unwrap();
        secrets::set(
            &vault.secrets_file(),
            DEVICE_SECRET,
            Some(&device.to_text()),
        )
        .unwrap();
        vault.store_keyring(&ring).unwrap();
        let local = Local {
            base: "https://accounts.example".into(),
            uid: "u1".into(),
            epoch: 4,
            device_id: "d1".into(),
            device_name: "Laptop".into(),
            joined: true,
            trusted_n: 9,
            ..Default::default()
        };
        vault.save_local(&local).unwrap();
        std::fs::write(vault.sync_file("front.json"), "{}").unwrap();
        // "No vault", "another epoch", "this device isn't listed": the service's word.
        vault.leave(&local, "reset").unwrap();
        // Sync is off here: nothing of it is in use.
        assert!(vault.keyring().is_err());
        assert!(vault.device_key().is_err());
        assert!(vault.device().is_none());
        assert!(vault.local().device_id.is_empty());
        // And nothing is gone: the keys, the state and what was kept with it.
        let (kept, aside) = vault.kept().unwrap();
        assert_eq!(aside.reason, "reset");
        assert_eq!((kept.device_id.as_str(), kept.trusted_n), ("d1", 9));
        assert_eq!(
            secrets::get(&vault.secrets_file(), ASIDE_DEVICE_SECRET).as_deref(),
            Some(device.to_text().as_str())
        );
        assert!(secrets::get(&vault.secrets_file(), ASIDE_KEYRING_SECRET).is_some());
        assert!(vault.sync_file("front.json").exists());
        // The account lists this computer as before (it was an outage, or a wrong answer).
        let listed = json!({ "exists": true, "epoch": 4, "devices": [{ "id": "d1", "status": "approved" }] });
        assert!(vault.resumable(&kept, "u1", &listed));
        for not in [
            json!({ "exists": false, "epoch": 4, "devices": [] }),
            json!({ "exists": true, "epoch": 5, "devices": [{ "id": "d1", "status": "approved" }] }),
            json!({ "exists": true, "epoch": 4, "devices": [{ "id": "d2", "status": "approved" }] }),
            json!({ "exists": true, "epoch": 4, "devices": [{ "id": "d1", "status": "pending" }] }),
        ] {
            assert!(!vault.resumable(&kept, "u1", &not), "{not}");
        }
        assert!(!vault.resumable(&kept, "someone-else", &listed));
        // Only the person's word deletes them.
        vault.forget_kept().unwrap();
        assert!(vault.kept().is_none());
        assert!(secrets::get(&vault.secrets_file(), ASIDE_DEVICE_SECRET).is_none());
        assert!(secrets::get(&vault.secrets_file(), ASIDE_KEYRING_SECRET).is_none());
        assert!(!vault.sync_file("front.json").exists());
        // A computer that never held the keys has nothing to keep.
        let waiting = Local {
            device_id: "d9".into(),
            ..Default::default()
        };
        vault.save_local(&waiting).unwrap();
        vault.leave(&waiting, "removed").unwrap();
        assert!(vault.kept().is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn what_the_trusted_list_says_is_what_records_are_checked_against() {
        let (vault, dir) = temp_vault("checks");
        let mut local = Local {
            joined: true,
            device_id: "d1".into(),
            ..Default::default()
        };
        let mut list = Trusted {
            devices: vec![pair("d1", "key1")],
            n: 2,
            counted: vec!["d1".into()],
            member: Some("m1".into()),
            pins: 3,
            ..Default::default()
        };
        list.floors.insert("files".into(), 2);
        vault.take_list(&mut local, &list, 2).unwrap();
        // A list an older version wrote since (it names no floors, counters or member key)
        // takes nothing away except "every computer writes counters".
        let plain = Trusted {
            devices: vec![pair("d1", "key1")],
            n: 3,
            ..Default::default()
        };
        vault.take_list(&mut local, &plain, 2).unwrap();
        assert_eq!(local.floors.get("files"), Some(&2));
        assert_eq!(
            (local.member.as_deref(), local.member_pins),
            (Some("m1"), 3)
        );
        assert_eq!(local.list_generation, 2);
        assert!(!local.strict);
        vault.take_list(&mut local, &list, 2).unwrap();
        // The next call's client has them.
        let again = Vault::new("https://accounts.example", &dir);
        assert!(again.api.checks.strict);
        assert_eq!(again.api.checks.floors.get("files"), Some(&2));
        assert_eq!(again.member_anchor().unwrap(), (Some("m1".to_string()), 3));
        // What this computer still has to say in a list that doesn't say it.
        let upkeep = again.upkeep(&local, &plain);
        assert_eq!(upkeep.counted, vec!["d1".to_string()]);
        assert_eq!(
            upkeep.member.map(|m| (m.key, m.pins)),
            Some(("m1".into(), 3))
        );
        assert_eq!(again.upkeep(&local, &list), TrustChange::default());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_recovery_key_is_confirmed_by_its_last_group_or_all_of_it() {
        let key = "0123-4567-89AB-CDEF";
        assert!(recovery_confirmed(key, "cdef"));
        assert!(recovery_confirmed(key, " CDEF "));
        assert!(recovery_confirmed(key, "o123 4567 89ab cdef"));
        assert!(!recovery_confirmed(key, "89AB"));
        assert!(!recovery_confirmed(key, "DEF"));
        assert!(!recovery_confirmed(key, ""));
        assert!(!recovery_confirmed(key, "4567-89AB-CDEF"));
    }

    #[test]
    fn the_trusted_list_reads_what_it_wrote() {
        let text =
            json!({ "devices": [{ "id": "a", "publicKey": "k" }, { "bad": 1 }] }).to_string();
        let list = parse_trusted(Some(&text)).unwrap();
        assert_eq!(list.devices, vec![("a".to_string(), "k".to_string())]);
        assert_eq!((list.recovery.clone(), list.n), (None, 0));
        let pinned = Trusted {
            devices: vec![("a".into(), "k".into())],
            recovery: Some(("r".into(), "auth".into())),
            n: 7,
            ..Default::default()
        };
        assert_eq!(parse_trusted(Some(&trusted_text(&pinned))).unwrap(), pinned);
        // Nothing to read is "no list", which callers refuse to decide from.
        assert!(parse_trusted(None).is_none());
        assert!(parse_trusted(Some("not json")).is_none());
        assert!(parse_trusted(Some("{}")).is_none());
    }
}
