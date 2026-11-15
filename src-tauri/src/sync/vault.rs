//! This computer as one of the account's devices: its key pair, the account's keyring once a
//! device or the recovery key handed it over, and the steps that change who holds it.
//!
//! On disk: `<data>/sync/local.json` (which account, which device, where it stands) and two
//! secrets (the device's private key, the keyring), kept as provider keys are: in the OS
//! keychain when there is one.

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
/// server can't add one to it).
const TRUSTED: (&str, &str) = ("sys", "devices");

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
    /// The newest version of the sealed list of trusted devices this computer has seen: an
    /// older list handed back by the service is refused.
    trusted_n: u64,
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
    /// What both computers show while one approves the other: set once this computer has
    /// started checking the waiting one (`review`).
    pub code: Option<String>,
    pub current: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// "signedOut", "unavailable" (not open to this account), "off", "pending" (waiting to be
    /// approved) or "on".
    pub state: String,
    /// Why sync went off by itself: "reset" (everything synced was deleted from the account
    /// page) or "removed" (this device was removed from another).
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

/// Waiting devices this computer is checking: device id to the public key it saw and the
/// random part of the code it chose. Approval seals to that key, whatever the service says later.
static REVIEWS: Mutex<Vec<(String, String, String)>> = Mutex::new(Vec::new());

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
        let text = secrets::get(&self.secrets_file(), DEVICE_SECRET).ok_or_else(|| {
            Error::Sync(
                "SyncKeys",
                "This device's sync key is missing; turn sync on again.".into(),
            )
        })?;
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
        let server = match self.api.get("state").await {
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
        let devices = server["devices"].as_array().cloned().unwrap_or_default();
        let mine = devices
            .iter()
            .find(|d| d["id"].as_str() == Some(local.device_id.as_str()));

        if !local.device_id.is_empty() {
            if !exists || local.epoch != epoch {
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
        if let (false, Some(mine)) = (local.device_id.is_empty(), mine) {
            // A new sign-in is a new session: tell the server which device it is again.
            let mut mine = mine.clone();
            if server["self"].as_str() != Some(local.device_id.as_str()) {
                let key = self.device_key()?;
                let mut body = self.device_body(&local, &key.public());
                body["proof"] = self.proof(&key).await?;
                self.api.post("devices", &body).await?.into_ok()?;
                let again = self.api.get("state").await?;
                if let Some(d) = again["devices"].as_array().and_then(|l| {
                    l.iter()
                        .find(|d| d["id"].as_str() == Some(local.device_id.as_str()))
                }) {
                    mine = d.clone();
                }
            }
            state = "pending";
            if mine["status"].as_str() == Some("approved") {
                let version = mine["wrapKeyVersion"].as_u64().unwrap_or(0);
                if let Some(wrap) = mine["wrap"].as_str() {
                    if !local.joined || version != local.key_version {
                        let ring = Keyring::from_bytes(&self.device_key()?.open(wrap)?)?;
                        self.store_keyring(&ring)?;
                        local.joined = true;
                        local.key_version = version;
                        self.save_local(&local)?;
                    }
                }
                if local.joined {
                    state = "on";
                    if server["rotationNeeded"].as_bool().unwrap_or(false) {
                        // Best effort here: another device may be doing it, and the next check tries again.
                        let _ = self.rotate().await;
                    }
                }
            }
        }

        let reviews = REVIEWS.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let list = devices
            .iter()
            .map(|d| {
                let text = |name: &str| d[name].as_str().unwrap_or("").to_string();
                let current = !local.device_id.is_empty()
                    && d["id"].as_str() == Some(local.device_id.as_str());
                // This computer waiting: the code from the nonce an approving computer chose.
                // A waiting computer this one is checking: from the key and nonce it fixed.
                let code = if current {
                    d["codeNonce"]
                        .as_str()
                        .map(|nonce| crypto::verification_code(&text("publicKey"), nonce))
                } else {
                    reviews
                        .iter()
                        .find(|(id, _, _)| *id == text("id"))
                        .map(|(_, public, nonce)| crypto::verification_code(public, nonce))
                };
                DeviceInfo {
                    current,
                    code,
                    id: text("id"),
                    name: text("name"),
                    platform: text("platform"),
                    status: text("status"),
                    created_at: d["createdAt"].as_u64(),
                    last_seen_at: d["lastSeenAt"].as_u64(),
                }
            })
            .collect::<Vec<_>>();
        let code = list.iter().find(|d| d.current).and_then(|d| d.code.clone());
        Ok(Status {
            state: state.into(),
            notice,
            exists,
            device_id: (!local.device_id.is_empty()).then(|| local.device_id.clone()),
            device_name: (!local.device_id.is_empty()).then(|| local.device_name.clone()),
            code,
            devices: list,
            recovery_created_at: server["recovery"]["createdAt"].as_u64(),
            usage_bytes: server["usageBytes"].as_u64().unwrap_or(0),
            storage_limit: server["storageLimit"].as_u64().unwrap_or(0),
            epoch,
        })
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
        let uid = self
            .uid()
            .ok_or_else(|| Error::Sync("SyncSignedOut", "Sign in to sync.".into()))?;
        let mut local = Local {
            base: self.api.base().to_string(),
            uid,
            epoch: 0,
            device_id: crypto::new_id()?,
            device_name: prepared.name.clone(),
            joined: true,
            key_version: 1,
            trusted_n: 0,
        };
        let public = prepared.device.public();
        let bytes = prepared.ring.to_bytes()?;
        let mut body = self.device_body(&local, &public);
        body["proof"] = self.proof(&prepared.device).await?;
        body["wrap"] = json!(crypto::seal_to(&public, &bytes)?);
        body["recovery"] = json!({
            "publicKey": prepared.recovery.public(),
            "wrap": crypto::recovery_wrap(
                &prepared.recovery.public(),
                &prepared.recovery.auth_key()?,
                &bytes,
            )?,
        });
        let reply = self.api.post("setup", &body).await?.into_ok()?;
        local.epoch = reply["epoch"].as_u64().unwrap_or(1);
        // The keys are saved before the state that says they exist.
        secrets::set(
            &self.secrets_file(),
            DEVICE_SECRET,
            Some(&prepared.device.to_text()),
        )?;
        self.store_keyring(&prepared.ring)?;
        self.save_local(&local)?;
        self.trust(
            &prepared.ring,
            &[(local.device_id.clone(), public)],
            &[],
            Some((&prepared.recovery.public(), &prepared.recovery.auth_key()?)),
        )
        .await
    }

    // ------------------------------------------------------------ joining

    /// Registers this device with an account that already syncs, to wait for approval (or
    /// for the recovery key). The code to compare shows once an approving computer starts
    /// checking this one.
    pub async fn join(&self, name: &str) -> Result<()> {
        let uid = self
            .uid()
            .ok_or_else(|| Error::Sync("SyncSignedOut", "Sign in to sync.".into()))?;
        let server = self.api.get("state").await?;
        let mut local = self.local();
        let key = if local.device_id.is_empty() || local.uid != uid {
            let key = PrivateKey::generate()?;
            local = Local {
                base: self.api.base().to_string(),
                uid,
                epoch: server["epoch"].as_u64().unwrap_or(0),
                device_id: crypto::new_id()?,
                device_name: clean_name(name),
                joined: false,
                key_version: 0,
                trusted_n: 0,
            };
            secrets::set(&self.secrets_file(), DEVICE_SECRET, Some(&key.to_text()))?;
            self.save_local(&local)?;
            key
        } else {
            self.device_key()?
        };
        let mut body = self.device_body(&local, &key.public());
        body["proof"] = self.proof(&key).await?;
        self.api.post("devices", &body).await?.into_ok()?;
        Ok(())
    }

    /// Starts checking a waiting device: fixes the key this computer would approve, chooses
    /// the random part of the code and publishes it. Returns the code both computers now show.
    pub async fn review(&self, device_id: &str) -> Result<String> {
        self.keyring()?;
        let server = self.api.get("state").await?;
        let device = server["devices"]
            .as_array()
            .and_then(|l| {
                l.iter().find(|d| {
                    d["id"].as_str() == Some(device_id) && d["status"].as_str() == Some("pending")
                })
            })
            .ok_or_else(|| Error::Sync("Sync", "That device is no longer waiting.".into()))?;
        let public = device["publicKey"].as_str().unwrap_or("").to_string();
        let nonce = crypto::b64(&crypto::random::<16>()?);
        self.api
            .post(
                &format!("devices/{device_id}/code"),
                &json!({ "nonce": nonce, "publicKey": public }),
            )
            .await?
            .into_ok()?;
        let code = crypto::verification_code(&public, &nonce);
        let mut reviews = REVIEWS.lock().unwrap_or_else(|e| e.into_inner());
        reviews.retain(|(id, _, _)| id != device_id);
        reviews.push((device_id.to_string(), public, nonce));
        Ok(code)
    }

    /// Joins with the recovery key instead of another device's approval.
    pub async fn join_with_recovery(&self, name: &str, typed: &str) -> Result<()> {
        let recovery = crypto::parse_recovery(typed)?;
        self.join(name).await?;
        let mut local = self.local();
        let stored = self.api.get("recovery").await?;
        let wrap = stored["wrap"].as_str().unwrap_or("");
        // Opens only when one of the account's devices wrapped it: keys made up by whoever
        // stores the wrap carry no valid tag.
        let ring = Keyring::from_bytes(&recovery.open_recovery(wrap)?)?;
        let version = stored["keyVersion"].as_u64().unwrap_or(0);
        let public = self.device_key()?.public();
        let body = json!({
            "self": true,
            "wrap": crypto::seal_to(&public, &ring.to_bytes()?)?,
            "keyVersion": version,
            "proof": self.proof(&recovery).await?,
        });
        self.api.post("keyring", &body).await?.into_ok()?;
        self.store_keyring(&ring)?;
        local.joined = true;
        local.key_version = version;
        self.save_local(&local)?;
        // The account's sealed list must open with these keys and name this recovery key.
        let genuine = self
            .trusted(&ring)
            .await
            .is_ok_and(|t| t.recovery.is_some_and(|(pin, _)| pin == recovery.public()));
        if !genuine {
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
        self.trust(&ring, &[(local.device_id.clone(), public)], &[], None)
            .await
    }

    /// Hands the keys to a waiting device this computer checked (`review`): to the key it
    /// fixed then, which is the one the code the user compared was made from.
    pub async fn approve(&self, device_id: &str) -> Result<()> {
        let ring = self.keyring()?;
        let public = REVIEWS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .find(|(id, _, _)| id == device_id)
            .map(|(_, public, _)| public.clone())
            .ok_or_else(|| Error::Sync("Sync", "Check that device's code first.".into()))?;
        let server = self.api.get("state").await?;
        let body = json!({
            "wrap": crypto::seal_to(&public, &ring.to_bytes()?)?,
            "keyVersion": server["keyVersion"],
            "publicKey": public,
        });
        self.api
            .post(&format!("devices/{device_id}/approve"), &body)
            .await?
            .into_ok()?;
        REVIEWS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(id, _, _)| id != device_id);
        self.trust(&ring, &[(device_id.to_string(), public)], &[], None)
            .await
    }

    /// Removes a device from the account (this one: sync goes off here). The others get new
    /// keys, so what is synced from now on can't be read with the removed device's copy.
    pub async fn remove(&self, device_id: &str) -> Result<()> {
        let own = self.local().device_id == device_id;
        if let Ok(ring) = self.keyring() {
            // Out of the trusted list first, so a rotation never wraps keys for it again.
            let _ = self.trust(&ring, &[], &[device_id.to_string()], None).await;
        }
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
        let recovery = PrivateKey::generate()?;
        let server = self.api.get("state").await?;
        let body = json!({
            "publicKey": recovery.public(),
            "wrap": crypto::recovery_wrap(&recovery.public(), &recovery.auth_key()?, &ring.to_bytes()?)?,
            "keyVersion": server["keyVersion"],
        });
        self.api.put("recovery", &body).await?.into_ok()?;
        // The account's devices wrap to this key from now on, whatever the service lists.
        self.trust(
            &ring,
            &[],
            &[],
            Some((&recovery.public(), &recovery.auth_key()?)),
        )
        .await?;
        Ok(crypto::recovery_text(&recovery))
    }

    // ------------------------------------------------------------ the trusted list and new keys

    /// The sealed list as the account has it. Refused when it is missing, can't be opened,
    /// or is older than one this computer has seen: nothing is decided from such a list.
    async fn trusted(&self, ring: &Keyring) -> Result<Trusted> {
        let untrusted = || {
            Error::Sync(
                "SyncKeys",
                "The account's list of trusted devices couldn't be read; nothing was changed."
                    .into(),
            )
        };
        let record = records::get(&self.api, ring, TRUSTED.0, TRUSTED.1)
            .await?
            .filter(|r| !r.deleted && !r.unreadable)
            .ok_or_else(untrusted)?;
        let list = parse_trusted(record.text.as_deref()).ok_or_else(untrusted)?;
        if list.n < self.local().trusted_n {
            return Err(untrusted());
        }
        Ok(list)
    }

    /// Adds devices to (and removes ids from) the sealed list of devices this account's own
    /// devices approved; `pin` sets the recovery key they wrap to.
    async fn trust(
        &self,
        ring: &Keyring,
        add: &[(String, String)],
        remove: &[String],
        pin: Option<(&str, &str)>,
    ) -> Result<()> {
        let floor = self.local().trusted_n;
        let mut written = None;
        records::update(&self.api, ring, TRUSTED.0, TRUSTED.1, |now| {
            let before = parse_trusted(now).unwrap_or_default();
            let mut next = before.clone();
            next.devices
                .retain(|(id, _)| !remove.contains(id) && !add.iter().any(|(a, _)| a == id));
            next.devices.extend(add.iter().cloned());
            if let Some((public, auth)) = pin {
                next.recovery = Some((public.to_string(), auth.to_string()));
            }
            if next == before {
                return None;
            }
            next.n = before.n.max(floor) + 1;
            written = Some(next.n);
            Some(
                json!({
                    "devices": next.devices.iter().map(|(id, key)| json!({ "id": id, "publicKey": key })).collect::<Vec<_>>(),
                    "recovery": next.recovery.as_ref().map(|r| &r.0),
                    "recoveryAuth": next.recovery.as_ref().map(|r| &r.1),
                    "n": next.n,
                })
                .to_string(),
            )
        })
        .await?;
        if let Some(n) = written {
            let mut local = self.local();
            if n > local.trusted_n {
                local.trusted_n = n;
                self.save_local(&local)?;
            }
        }
        Ok(())
    }

    /// A new key generation, wrapped for every device the account's own devices approved and
    /// for the recovery key. A device the server lists as approved that isn't on that sealed
    /// list never gets the keys: it is taken off instead.
    async fn rotate(&self) -> Result<()> {
        let ring = self.keyring()?;
        let server = self.api.get("state").await?;
        if !server["rotationNeeded"].as_bool().unwrap_or(false) {
            return Ok(());
        }
        // Nothing is decided from a list that is missing, unreadable or old.
        let trusted = self.trusted(&ring).await?;
        let own = self.local().device_id;
        if !trusted.devices.iter().any(|(id, _)| *id == own) {
            return Err(Error::Sync(
                "SyncKeys",
                "This computer isn't on the account's list of trusted devices; nothing was changed.".into(),
            ));
        }
        // The recovery key the account's devices pinned, never one the service names.
        let (recovery, recovery_auth) = trusted.recovery.clone().ok_or_else(|| {
            Error::Sync(
                "SyncKeys",
                "This account's recovery key needs replacing: make a new recovery key.".into(),
            )
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
                wraps.insert(id.to_string(), json!(crypto::seal_to(public, &bytes)?));
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
        let mut local = self.local();
        local.key_version = reply["keyVersion"]
            .as_u64()
            .unwrap_or(local.key_version + 1);
        self.save_local(&local)
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
        assert_eq!((list.recovery, list.n), (None, 0));
        let pinned =
            json!({ "devices": [], "recovery": "r", "recoveryAuth": "a", "n": 7 }).to_string();
        let list = parse_trusted(Some(&pinned)).unwrap();
        assert_eq!(
            (list.recovery, list.n),
            (Some(("r".to_string(), "a".to_string())), 7)
        );
        // Nothing to read is "no list", which callers refuse to decide from.
        assert!(parse_trusted(None).is_none());
        assert!(parse_trusted(Some("not json")).is_none());
        assert!(parse_trusted(Some("{}")).is_none());
    }
}
