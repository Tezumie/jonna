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
    /// What both computers show while one approves the other.
    pub code: String,
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

pub struct Vault {
    pub api: Api,
    data: PathBuf,
}

fn default_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|n| !n.trim().is_empty())
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
                let public = self.device_key()?.public();
                self.api
                    .post("devices", &self.device_body(&local, &public))
                    .await?
                    .into_ok()?;
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

        let list = devices
            .iter()
            .map(|d| {
                let text = |name: &str| d[name].as_str().unwrap_or("").to_string();
                DeviceInfo {
                    current: !local.device_id.is_empty()
                        && d["id"].as_str() == Some(local.device_id.as_str()),
                    code: crypto::verification_code(&text("publicKey")),
                    id: text("id"),
                    name: text("name"),
                    platform: text("platform"),
                    status: text("status"),
                    created_at: d["createdAt"].as_u64(),
                    last_seen_at: d["lastSeenAt"].as_u64(),
                }
            })
            .collect::<Vec<_>>();
        let code = list.iter().find(|d| d.current).map(|d| d.code.clone());
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
        };
        let public = prepared.device.public();
        let bytes = prepared.ring.to_bytes()?;
        let mut body = self.device_body(&local, &public);
        body["wrap"] = json!(crypto::seal_to(&public, &bytes)?);
        body["recovery"] = json!({
            "publicKey": prepared.recovery.public(),
            "wrap": crypto::seal_to(&prepared.recovery.public(), &bytes)?,
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
        self.trust(&prepared.ring, &[(local.device_id.clone(), public)], &[])
            .await
    }

    // ------------------------------------------------------------ joining

    /// Registers this device with an account that already syncs, to wait for approval (or
    /// for the recovery key). Returns the code to compare.
    pub async fn join(&self, name: &str) -> Result<String> {
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
            };
            secrets::set(&self.secrets_file(), DEVICE_SECRET, Some(&key.to_text()))?;
            self.save_local(&local)?;
            key
        } else {
            self.device_key()?
        };
        let public = key.public();
        self.api
            .post("devices", &self.device_body(&local, &public))
            .await?
            .into_ok()?;
        Ok(crypto::verification_code(&public))
    }

    /// Joins with the recovery key instead of another device's approval.
    pub async fn join_with_recovery(&self, name: &str, typed: &str) -> Result<()> {
        let recovery = crypto::parse_recovery(typed)?;
        self.join(name).await?;
        let mut local = self.local();
        let stored = self.api.get("recovery").await?;
        let wrap = stored["wrap"].as_str().unwrap_or("");
        let ring = recovery.open(wrap).map_err(|_| {
            Error::Sync(
                "SyncRecoveryKey",
                "That recovery key isn't this account's current one.".into(),
            )
        })?;
        let ring = Keyring::from_bytes(&ring)?;
        let version = stored["keyVersion"].as_u64().unwrap_or(0);
        let public = self.device_key()?.public();
        let body = json!({
            "self": true,
            "wrap": crypto::seal_to(&public, &ring.to_bytes()?)?,
            "keyVersion": version,
        });
        self.api.post("keyring", &body).await?.into_ok()?;
        self.store_keyring(&ring)?;
        local.joined = true;
        local.key_version = version;
        self.save_local(&local)?;
        self.trust(&ring, &[(local.device_id.clone(), public)], &[])
            .await
    }

    /// Hands the keys to a waiting device. The caller showed its code and the user agreed.
    pub async fn approve(&self, device_id: &str) -> Result<()> {
        let ring = self.keyring()?;
        let server = self.api.get("state").await?;
        let device = server["devices"]
            .as_array()
            .and_then(|l| l.iter().find(|d| d["id"].as_str() == Some(device_id)))
            .ok_or_else(|| Error::Sync("Sync", "That device is no longer waiting.".into()))?;
        let public = device["publicKey"].as_str().unwrap_or("").to_string();
        let body = json!({
            "wrap": crypto::seal_to(&public, &ring.to_bytes()?)?,
            "keyVersion": server["keyVersion"],
            "publicKey": public,
        });
        self.api
            .post(&format!("devices/{device_id}/approve"), &body)
            .await?
            .into_ok()?;
        self.trust(&ring, &[(device_id.to_string(), public)], &[])
            .await
    }

    /// Removes a device from the account (this one: sync goes off here). The others get new
    /// keys, so what is synced from now on can't be read with the removed device's copy.
    pub async fn remove(&self, device_id: &str) -> Result<()> {
        let own = self.local().device_id == device_id;
        if let Ok(ring) = self.keyring() {
            // Out of the trusted list first, so a rotation never wraps keys for it again.
            let _ = self.trust(&ring, &[], &[device_id.to_string()]).await;
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
            "wrap": crypto::seal_to(&recovery.public(), &ring.to_bytes()?)?,
            "keyVersion": server["keyVersion"],
        });
        self.api.put("recovery", &body).await?.into_ok()?;
        Ok(crypto::recovery_text(&recovery))
    }

    // ------------------------------------------------------------ the trusted list and new keys

    async fn trusted(&self, ring: &Keyring) -> Result<Vec<(String, String)>> {
        let record = records::get(&self.api, ring, TRUSTED.0, TRUSTED.1).await?;
        Ok(parse_trusted(
            record.as_ref().and_then(|r| r.text.as_deref()),
        ))
    }

    /// Adds devices to (and removes ids from) the sealed list of devices this account's own
    /// devices approved.
    async fn trust(
        &self,
        ring: &Keyring,
        add: &[(String, String)],
        remove: &[String],
    ) -> Result<()> {
        records::update(&self.api, ring, TRUSTED.0, TRUSTED.1, |now| {
            let mut list = parse_trusted(now);
            let before = list.clone();
            list.retain(|(id, _)| !remove.contains(id) && !add.iter().any(|(a, _)| a == id));
            list.extend(add.iter().cloned());
            (list != before).then(|| {
                json!({ "devices": list.iter().map(|(id, key)| json!({ "id": id, "publicKey": key })).collect::<Vec<_>>() })
                    .to_string()
            })
        })
        .await
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
        let trusted = self.trusted(&ring).await?;
        let next = ring.rotated()?;
        let bytes = next.to_bytes()?;
        let mut wraps = serde_json::Map::new();
        for d in server["devices"].as_array().into_iter().flatten() {
            if d["status"].as_str() != Some("approved") {
                continue;
            }
            let id = d["id"].as_str().unwrap_or("");
            let public = d["publicKey"].as_str().unwrap_or("");
            if trusted.iter().any(|(t, k)| t == id && k == public) {
                wraps.insert(id.to_string(), json!(crypto::seal_to(public, &bytes)?));
            } else {
                self.api.delete(&format!("devices/{id}")).await?;
            }
        }
        let recovery = server["recovery"]["publicKey"].as_str().unwrap_or("");
        let body = json!({
            "expectKeyVersion": server["keyVersion"],
            "wraps": wraps,
            "recoveryWrap": crypto::seal_to(recovery, &bytes)?,
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

fn parse_trusted(text: Option<&str>) -> Vec<(String, String)> {
    let Some(v) = text.and_then(|t| serde_json::from_str::<Value>(t).ok()) else {
        return Vec::new();
    };
    v["devices"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| {
            Some((
                d["id"].as_str()?.to_string(),
                d["publicKey"].as_str()?.to_string(),
            ))
        })
        .collect()
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
        assert_eq!(
            parse_trusted(Some(&text)),
            vec![("a".to_string(), "k".to_string())]
        );
        assert!(parse_trusted(None).is_empty());
        assert!(parse_trusted(Some("not json")).is_empty());
    }
}
