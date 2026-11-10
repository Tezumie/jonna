//! The OS keychain for secrets (D207): Windows Credential Manager, the macOS Keychain, the
//! Secret Service on Linux (GNOME Keyring, KWallet), through the `keyring` crate. One credential
//! per secret (secrets.rs names it after the profile and the secret id) under the service name product.json's `identifier`; a value too long for one
//! credential (Windows allows 2560 bytes of UTF-16, and OAuth tokens can be longer) is split
//! into parts. `os_vault` is None when no keychain answers (headless Linux, a locked or missing
//! Secret Service): the secrets file keeps the values then (secrets.rs).

use std::sync::OnceLock;

/// Where secret values can live outside the secrets file. Errors are messages (no secret in them).
pub trait Vault: Send + Sync {
    fn get(&self, id: &str) -> Result<Option<String>, String>;
    fn set(&self, id: &str, value: &str) -> Result<(), String>;
    fn delete(&self, id: &str) -> Result<(), String>;
}

/// A credential that holds the number of parts instead of the value.
const PARTS: &str = "\u{1}parts:";
/// UTF-16 code units per credential (Windows' limit is 1280; some room left).
const PART_UNITS: usize = 1200;

/// `value` cut into pieces of at most `units` UTF-16 code units, whole characters only.
pub fn split_parts(value: &str, units: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut part = String::new();
    let mut used = 0;
    for c in value.chars() {
        let n = c.len_utf16();
        if used + n > units && !part.is_empty() {
            out.push(std::mem::take(&mut part));
            used = 0;
        }
        part.push(c);
        used += n;
    }
    if !part.is_empty() || out.is_empty() {
        out.push(part);
    }
    out
}

/// The parts' count from a header credential (None: it holds the value itself).
pub fn parts_count(stored: &str) -> Option<usize> {
    stored.strip_prefix(PARTS)?.parse().ok()
}

/// product.json's `identifier`: the keychain's service name (no product name in the code).
fn service_name() -> &'static str {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        serde_json::from_str::<serde_json::Value>(include_str!("../../../product.json"))
            .ok()
            .and_then(|v| v.get("identifier")?.as_str().map(str::to_string))
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| "ide".into())
    })
}

struct OsVault {
    service: String,
}

impl OsVault {
    fn entry(&self, user: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, user).map_err(|e| e.to_string())
    }

    fn read(&self, user: &str) -> Result<Option<String>, String> {
        match self.entry(user)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn remove(&self, user: &str) -> Result<(), String> {
        match self.entry(user)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn remove_parts(&self, id: &str) -> Result<(), String> {
        if let Some(n) = self.read(id)?.as_deref().and_then(parts_count) {
            for i in 0..n {
                self.remove(&format!("{id}#{i}"))?;
            }
        }
        Ok(())
    }
}

impl Vault for OsVault {
    fn get(&self, id: &str) -> Result<Option<String>, String> {
        let Some(stored) = self.read(id)? else {
            return Ok(None);
        };
        let Some(n) = parts_count(&stored) else {
            return Ok(Some(stored));
        };
        let mut value = String::new();
        for i in 0..n {
            match self.read(&format!("{id}#{i}"))? {
                Some(part) => value.push_str(&part),
                None => return Ok(None), // a part went missing: as good as no value
            }
        }
        Ok(Some(value))
    }

    fn set(&self, id: &str, value: &str) -> Result<(), String> {
        self.remove_parts(id)?;
        let parts = split_parts(value, PART_UNITS);
        if parts.len() == 1 {
            return self
                .entry(id)?
                .set_password(value)
                .map_err(|e| e.to_string());
        }
        for (i, part) in parts.iter().enumerate() {
            self.entry(&format!("{id}#{i}"))?
                .set_password(part)
                .map_err(|e| e.to_string())?;
        }
        self.entry(id)?
            .set_password(&format!("{PARTS}{}", parts.len()))
            .map_err(|e| e.to_string())
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        self.remove_parts(id)?;
        self.remove(id)
    }
}

/// The OS keychain if it works here: tried once per run (write, read back, delete a probe).
/// `IDE_NO_KEYCHAIN=1` turns it off (the secrets file only).
pub fn os_vault() -> Option<&'static dyn Vault> {
    static VAULT: OnceLock<Option<OsVault>> = OnceLock::new();
    VAULT
        .get_or_init(|| {
            if std::env::var_os("IDE_NO_KEYCHAIN").is_some_and(|v| v == "1") {
                return None;
            }
            let vault = OsVault {
                service: service_name().to_string(),
            };
            let probe = "keychain-probe";
            let works = vault.set(probe, "ok").is_ok()
                && vault.get(probe).ok().flatten().as_deref() == Some("ok");
            let _ = vault.delete(probe);
            works.then_some(vault)
        })
        .as_ref()
        .map(|v| v as &dyn Vault)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_values_are_split_into_whole_characters() {
        assert_eq!(split_parts("", 4), [""]);
        assert_eq!(split_parts("abcdefghij", 4), ["abcd", "efgh", "ij"]);
        // An astral character takes two units and isn't cut in half.
        assert_eq!(split_parts("ab\u{1F600}c", 3), ["ab", "\u{1F600}c"]);
        let long = "x".repeat(5000);
        let parts = split_parts(&long, PART_UNITS);
        assert_eq!(parts.len(), 5);
        assert_eq!(parts.concat(), long);
        assert_eq!(parts_count(&format!("{PARTS}5")), Some(5));
        assert_eq!(parts_count("a value"), None);
    }
}
