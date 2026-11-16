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
    })
    .to_string()
}

impl Vault {
    pub fn new(base: &str, data: &Path) -> Self {
        Self {
            api: Api::new(base, data),
            data: data.to_path_buf(),
        }
    }

    fn local_file(&self) -> PathBuf {
        self.data.join("sync").join("local.json")
    }

    fn secrets_file(&self) -> PathBuf {
        self.data.join("secrets.json")
    }

    fn local(&self) -> Local {
        std::fs::read_to_string(self.local_file())
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
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

    /// A file under this profile's sync folder (caches; removed when sync goes off here).
    pub fn sync_file(&self, name: &str) -> PathBuf {
        self.data.join("sync").join(name)
    }

    fn uid(&self) -> Option<String> {
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

    /// Proof for the service that `key`'s private half is held here (its challenge, answered).
    async fn proof(&self, key: &PrivateKey) -> Result<Value> {
        let challenge = self
            .api
            .post("challenge", &json!({ "publicKey": key.public() }))
            .await?
            .into_ok()?;
        let answer = key.prove(
            challenge["publicKey"].as_str().unwrap_or(""),
            challenge["nonce"].as_str().unwrap_or(""),
        )?;
        Ok(json!({ "id": challenge["id"], "proof": answer }))
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
        if !local.uid.is_empty() && (local.uid != uid || local.base != self.api.base()) {
            self.forget()?;
            local = Local::default();
        }
        let exists = server["exists"].as_bool().unwrap_or(false);
        let epoch = server["epoch"].as_u64().unwrap_or(0);
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
                self.forget()?;
                local = Local::default();
                notice = Some("reset".to_string());
            } else if mine.is_none() {
                self.forget()?;
                local = Local::default();
                notice = Some("removed".to_string());
            }
        }

        let mut state = "off";
        let mut own_code = None;
        if !local.device_id.is_empty() {
            let key = self.device_key()?;
            // A new sign-in is a new session: tell the server which device it is again.
            if server["self"].as_str() != Some(local.device_id.as_str()) {
                let mut body = self.device_body(&local, &key.public());
                body["proof"] = self.proof(&key).await?;
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
            } else {
                own_code = self.pairing(&mut local, &key, &mine).await?;
            }
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
        let owed = std::mem::take(&mut local.pending_trust);
        for change in owed {
            if self.write_trust(local, ring, &change).await.is_err() {
                local.pending_trust.push(change);
            }
        }
        if let Some((public, wrap)) = local.pending_recovery.clone() {
            let body =
                json!({ "publicKey": public, "wrap": wrap, "keyVersion": local.key_version });
            if self.api.put("recovery", &body).await.is_ok_and(|r| r.ok()) {
                local.pending_recovery = None;
            }
        }
        let _ = self.save_local(local);
        let _ = self.trusted(local, ring).await;
        if server["rotationNeeded"].as_bool().unwrap_or(false) {
            let _ = self.rotate().await;
        }
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
                add: vec![(device_id, public.clone())],
                remove: vec![],
                pin: Some(pin.clone()),
                create: true,
            }],
            ..Default::default()
        };
        let bytes = prepared.ring.to_bytes()?;
        let mut body = self.device_body(&local, &public);
        body["proof"] = self.proof(&prepared.device).await?;
        // Boxed from this device to itself: what it takes back, should the reply be lost.
        body["wrap"] = json!(crypto::box_to(&prepared.device, &public, &bytes)?);
        body["recovery"] = json!({
            "publicKey": pin.0,
            "wrap": crypto::recovery_wrap(&pin.0, &pin.1, &bytes)?,
        });
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
        body["proof"] = self.proof(&key).await?;
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
        body["proof"] = self.proof(&key).await?;
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
        let ring =
            Keyring::from_bytes(&recovery.open_recovery(stored["wrap"].as_str().unwrap_or(""))?)?;
        let version = stored["keyVersion"].as_u64().unwrap_or(0);
        let public = key.public();
        let body = json!({
            "self": true,
            "wrap": crypto::box_to(&key, &public, &ring.to_bytes()?)?,
            "keyVersion": version,
            "proof": self.proof(&recovery).await?,
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
                let _ = self
                    .api
                    .delete(&format!("devices/{}", local.device_id))
                    .await;
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
        }
        REVIEWS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|r| r.device != device_id);
        self.api.delete(&format!("devices/{device_id}")).await?;
        if own {
            self.forget()?;
        } else {
            let _ = self.rotate().await;
        }
        Ok(())
    }

    /// A new recovery key; the old one stops working. Returns the text to show.
    pub async fn new_recovery_key(&self) -> Result<String> {
        let ring = self.keyring()?;
        let mut local = self.local();
        let recovery = PrivateKey::generate()?;
        let pin = (recovery.public(), recovery.auth_key()?);
        let wrap = crypto::recovery_wrap(&pin.0, &pin.1, &ring.to_bytes()?)?;
        // The account's devices name it first; the service gets its wrap next, and again at
        // the next check should that not arrive. Either way the key shown is the one that works.
        let change = TrustChange {
            pin: Some(pin.clone()),
            ..Default::default()
        };
        self.write_trust(&mut local, &ring, &change).await?;
        local.pending_recovery = Some((pin.0.clone(), wrap.clone()));
        self.save_local(&local)?;
        let body = json!({ "publicKey": pin.0, "wrap": wrap, "keyVersion": local.key_version });
        if self.api.put("recovery", &body).await.is_ok_and(|r| r.ok()) {
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
        if list.n < local.trusted_n {
            return Err(untrusted());
        }
        if list.n != local.trusted_n || list.devices != local.trusted {
            local.trusted_n = list.n;
            local.trusted = list.devices.clone();
            self.save_local(local)?;
        }
        Ok(list)
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
            let mut next = before.clone();
            next.devices.retain(|(id, _)| {
                !change.remove.contains(id) && !change.add.iter().any(|(a, _)| a == id)
            });
            next.devices.extend(change.add.iter().cloned());
            if let Some(pin) = &change.pin {
                next.recovery = Some(pin.clone());
            }
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
                local.trusted_n = list.n;
                local.trusted = list.devices;
                self.save_local(local)?;
            }
        }
        Ok(())
    }

    /// A new key generation, boxed from this device for every device on the account's sealed
    /// list and wrapped for the recovery key that list names. A device the service lists as
    /// approved that isn't on the list never gets the keys: it is taken off instead.
    async fn rotate(&self) -> Result<()> {
        let ring = self.keyring()?;
        let mut local = self.local();
        let key = self.device_key()?;
        let server = self.server_state().await?;
        if !server["rotationNeeded"].as_bool().unwrap_or(false) {
            return Ok(());
        }
        // Nothing is decided from a list that is missing, unreadable or old.
        let trusted = self.trusted(&mut local, &ring).await?;
        if !trusted.devices.iter().any(|(id, _)| *id == local.device_id) {
            return Err(keys_error(
                "This computer isn't on the account's list of trusted devices; nothing was changed.",
            ));
        }
        // The recovery key the account's devices pinned, never one the service names.
        let (recovery, recovery_auth) = trusted.recovery.clone().ok_or_else(|| {
            keys_error("This account's recovery key needs replacing: make a new recovery key.")
        })?;
        let next = ring.rotated()?;
        let bytes = next.to_bytes()?;
        let mut wraps = serde_json::Map::new();
        for d in server["devices"].as_array().into_iter().flatten() {
            if d["status"].as_str() != Some("approved") {
                continue;
            }
            let id = d["id"].as_str().unwrap_or("");
            let public = d["publicKey"].as_str().unwrap_or("");
            if trusted.devices.iter().any(|(t, k)| t == id && k == public) {
                wraps.insert(id.to_string(), json!(crypto::box_to(&key, public, &bytes)?));
            } else {
                // Listed as approved by the service, approved by none of the account's devices.
                self.api.delete(&format!("devices/{id}")).await?;
            }
        }
        let body = json!({
            "expectKeyVersion": server["keyVersion"],
            "wraps": wraps,
            "recoveryWrap": crypto::recovery_wrap(&recovery, &recovery_auth, &bytes)?,
            "recoveryPublicKey": recovery,
        });
        let reply = self.api.post("keyring", &body).await?.into_ok()?;
        self.store_keyring(&next)?;
        local.key_version = reply["keyVersion"]
            .as_u64()
            .unwrap_or(local.key_version + 1);
        self.save_local(&local)?;
        // The list again, sealed with the new keys and one higher: what the removed device
        // holds can no longer make a list the others would take.
        let floor = local.trusted_n;
        let _ = records::update(&self.api, &next, TRUSTED.0, TRUSTED.1, |now| {
            let mut list = parse_trusted(now)?;
            list.n = list.n.max(floor) + 1;
            Some(trusted_text(&list))
        })
        .await;
        let _ = self.trusted(&mut local, &next).await;
        Ok(())
    }
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
    })
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
        };
        assert_eq!(parse_trusted(Some(&trusted_text(&pinned))).unwrap(), pinned);
        // Nothing to read is "no list", which callers refuse to decide from.
        assert!(parse_trusted(None).is_none());
        assert!(parse_trusted(Some("not json")).is_none());
        assert!(parse_trusted(Some("{}")).is_none());
    }
}
