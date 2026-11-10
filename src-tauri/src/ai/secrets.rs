//! Secrets (API keys for model providers, MCP inputs and OAuth tokens) indexed by
//! `<appData>/secrets.json` (owner-only on Unix). Kept out of settings files (which people share
//! and commit) and never returned to the webview: commands can set, clear and ask whether a key
//! exists. D207: the values live in the OS keychain when there is one (keychain.rs); the file
//! then holds a marker in their place, so it still lists what's stored. A value the keychain
//! refuses, or every value when no keychain answers (headless Linux), stays in the file as
//! before. Values already in the file move to the keychain on first use. Keychain accounts are
//! named after the profile too (`account`): one keychain serves every `--user-data-dir`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::keychain::Vault;
use crate::error::Result;
use crate::store::atomic_write_private;

/// What the file holds in place of a value that's in the keychain.
const IN_KEYCHAIN: &str = "\u{1}keychain";

fn load(path: &Path) -> BTreeMap<String, String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save(path: &Path, all: &BTreeMap<String, String>) -> Result<()> {
    atomic_write_private(path, serde_json::to_string_pretty(all)?.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// The keychain this run uses (none in unit tests: they pass their own).
fn vault() -> Option<&'static dyn Vault> {
    if cfg!(test) {
        None
    } else {
        super::keychain::os_vault()
    }
}

/// The keychain account of `id` for the secrets file at `path`. The keychain is one per OS user
/// while secrets files are one per profile (`--user-data-dir`, which UI test runs use): without
/// the profile in the name, a test run's (or a second profile's) key would overwrite or delete
/// the one the IDE keeps for the user.
pub fn account(path: &Path, id: &str) -> String {
    use sha2::{Digest, Sha256};
    let dir = path.parent().unwrap_or(path);
    let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let digest = Sha256::digest(dir.to_string_lossy().as_bytes());
    let scope: String = digest[..6].iter().map(|b| format!("{b:02x}")).collect();
    format!("{scope}:{id}")
}

/// A stored entry's value: itself, or the keychain's for a marker. A value kept under its bare
/// id (before accounts named the profile) is read from there and copied to its account.
fn resolve(vault: Option<&dyn Vault>, path: &Path, id: &str, stored: String) -> Option<String> {
    if stored != IN_KEYCHAIN {
        return Some(stored);
    }
    let vault = vault?;
    let name = account(path, id);
    if let Some(v) = vault.get(&name).ok().flatten() {
        return Some(v);
    }
    let legacy = vault.get(id).ok().flatten()?;
    let _ = vault.set(&name, &legacy);
    Some(legacy)
}

/// Moves the file's plain values into the keychain (once per file and run). A value the
/// keychain refuses stays where it is.
pub fn migrate_with(vault: Option<&dyn Vault>, path: &Path) -> Result<usize> {
    let Some(vault) = vault else {
        return Ok(0);
    };
    let _guard = write_guard(path);
    let mut all = load(path);
    let mut moved = 0;
    for (id, value) in all.iter_mut() {
        if value != IN_KEYCHAIN && vault.set(&account(path, id), value).is_ok() {
            *value = IN_KEYCHAIN.to_string();
            moved += 1;
        }
    }
    if moved > 0 {
        save(path, &all)?;
    }
    Ok(moved)
}

fn migrate_once(path: &Path) {
    static DONE: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());
    let Some(vault) = vault() else {
        return;
    };
    {
        let mut done = DONE.lock().unwrap_or_else(|e| e.into_inner());
        if done.iter().any(|p| p == path) {
            return;
        }
        done.push(path.to_path_buf());
    }
    let _ = migrate_with(Some(vault), path);
}

pub fn get(path: &Path, id: &str) -> Option<String> {
    migrate_once(path);
    get_with(vault(), path, id)
}

pub fn get_with(vault: Option<&dyn Vault>, path: &Path, id: &str) -> Option<String> {
    let stored = load(path).remove(id)?;
    resolve(vault, path, id, stored)
}

/// The secret-id prefix of an MCP server's inputs: `mcp.input.<name>::` with the name's
/// characters outside `[A-Za-z0-9_-]` as `_` (the frontend's `secretId` does the same).
pub fn mcp_prefix(server: &str) -> String {
    let clean: String = server
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("mcp.input.{clean}::")
}

/// Replaces `${secret:<id>}` in `text` with the stored value (D193: an MCP server's password
/// inputs reach its process or its headers without passing through the webview), and
/// `${env:NAME}` with that environment variable (empty when unset, as VS Code does). Only for an
/// MCP server (`server`), and only its own inputs (`mcp.input.<server>::…`): one server can't
/// read another's, and nothing else (a language server, an extension's process) gets either.
pub fn expand(path: &Path, text: &str, server: Option<&str>) -> Result<String> {
    migrate_once(path);
    expand_with(vault(), path, text, server)
}

pub fn expand_with(
    vault: Option<&dyn Vault>,
    path: &Path,
    text: &str,
    server: Option<&str>,
) -> Result<String> {
    let Some(server) = server else {
        return Ok(text.to_string());
    };
    let text = expand_env(text);
    const OPEN: &str = "${secret:";
    if !text.contains(OPEN) {
        return Ok(text);
    }
    let prefix = mcp_prefix(server);
    let text = text.as_str();
    let all = load(path);
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(OPEN) {
        out.push_str(&rest[..start]);
        let after = &rest[start + OPEN.len()..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            return Ok(out);
        };
        let id = &after[..end];
        if !id.starts_with(&prefix) {
            return Err(crate::error::Error::Invalid(format!(
                "{id} isn't one of MCP server {server}'s inputs"
            )));
        }
        let value = all
            .get(id)
            .cloned()
            .and_then(|stored| resolve(vault, path, id, stored))
            .ok_or_else(|| {
                crate::error::Error::Invalid(format!("no value stored for {}", &id[prefix.len()..]))
            })?;
        out.push_str(&value);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

fn expand_env(text: &str) -> String {
    const OPEN: &str = "${env:";
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(OPEN) {
        out.push_str(&rest[..start]);
        let after = &rest[start + OPEN.len()..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            return out;
        };
        out.push_str(&std::env::var(&after[..end]).unwrap_or_default());
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// Whether a value is stored: a marker counts only while the keychain still has the value (one
/// lost there is asked for again rather than failing later).
pub fn has(path: &Path, id: &str) -> bool {
    migrate_once(path);
    has_with(vault(), path, id)
}

pub fn has_with(vault: Option<&dyn Vault>, path: &Path, id: &str) -> bool {
    get_with(vault, path, id).is_some()
}

/// One load-change-write at a time: two keys saved at once both stay (D203 audit).
static WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The in-process lock and, across processes (two windows, D223), an exclusive lock on
/// `<secrets>.lock`: each change reads the file under it, so another window's key saved a
/// moment earlier stays. The lock file is never removed (removing it would let a third process
/// lock a new file while the second still holds the old one). No lock file (a read-only
/// folder): the in-process lock alone, as before.
struct WriteGuard {
    _inner: std::sync::MutexGuard<'static, ()>,
    _file: Option<std::fs::File>,
}

fn lock_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".lock");
    PathBuf::from(name)
}

fn write_guard(path: &Path) -> WriteGuard {
    let inner = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(lock_path(path))
        .ok()
        .filter(|f| f.lock().is_ok());
    WriteGuard {
        _inner: inner,
        _file: file,
    }
}

pub fn set(path: &Path, id: &str, value: Option<&str>) -> Result<()> {
    migrate_once(path);
    set_with(vault(), path, id, value)
}

pub fn set_with(
    vault: Option<&dyn Vault>,
    path: &Path,
    id: &str,
    value: Option<&str>,
) -> Result<()> {
    let _guard = write_guard(path);
    let mut all = load(path);
    let was_in_keychain = all.get(id).is_some_and(|v| v == IN_KEYCHAIN);
    let name = account(path, id);
    match value.filter(|v| !v.is_empty()) {
        Some(v) => {
            let stored = match vault {
                Some(k) if k.set(&name, v).is_ok() => IN_KEYCHAIN.to_string(),
                // No keychain, or it refused: the file keeps it (and an old copy goes).
                _ => {
                    if was_in_keychain {
                        if let Some(k) = vault {
                            let _ = k.delete(&name);
                        }
                    }
                    v.to_string()
                }
            };
            all.insert(id.to_string(), stored);
        }
        None => {
            if was_in_keychain {
                if let Some(k) = vault {
                    let _ = k.delete(&name);
                }
            }
            all.remove(id);
        }
    }
    save(path, &all)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_expanded_for_their_own_mcp_server_only() {
        let path = std::env::temp_dir().join(format!("ide-secrets-{}.json", std::process::id()));
        set(&path, "mcp.input.gh::token", Some("s3cret")).unwrap();
        set(&path, "mcp.input.other::token", Some("theirs")).unwrap();
        set(&path, "openai", Some("sk-x")).unwrap();
        let gh = Some("gh");
        assert_eq!(
            expand(&path, "Bearer ${secret:mcp.input.gh::token}!", gh).unwrap(),
            "Bearer s3cret!"
        );
        assert_eq!(expand(&path, "plain", gh).unwrap(), "plain");
        std::env::set_var("IDE_TEST_SECRET_ENV", "e");
        assert_eq!(
            expand(&path, "${env:IDE_TEST_SECRET_ENV}/${env:IDE_UNSET_X}", gh).unwrap(),
            "e/"
        );
        // Not an MCP server: nothing is filled in.
        assert_eq!(
            expand(&path, "${env:IDE_TEST_SECRET_ENV}", None).unwrap(),
            "${env:IDE_TEST_SECRET_ENV}"
        );
        assert!(expand(&path, "${secret:openai}", gh).is_err());
        assert!(expand(&path, "${secret:mcp.input.other::token}", gh).is_err());
        assert!(expand(&path, "${secret:mcp.input.gh::missing}", gh).is_err());
        assert_eq!(mcp_prefix("my server.x"), "mcp.input.my_server_x::");
        let _ = std::fs::remove_file(path);
    }

    /// A keychain in memory, or one that refuses everything (locked, missing).
    #[derive(Default)]
    struct MemoryVault {
        items: std::sync::Mutex<BTreeMap<String, String>>,
        refuse: bool,
    }

    impl Vault for MemoryVault {
        fn get(&self, id: &str) -> std::result::Result<Option<String>, String> {
            if self.refuse {
                return Err("locked".into());
            }
            Ok(self.items.lock().unwrap().get(id).cloned())
        }
        fn set(&self, id: &str, value: &str) -> std::result::Result<(), String> {
            if self.refuse {
                return Err("locked".into());
            }
            self.items.lock().unwrap().insert(id.into(), value.into());
            Ok(())
        }
        fn delete(&self, id: &str) -> std::result::Result<(), String> {
            self.items.lock().unwrap().remove(id);
            Ok(())
        }
    }

    fn temp(name: &str) -> PathBuf {
        let p =
            std::env::temp_dir().join(format!("ide-secrets-{name}-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn values_live_in_the_keychain_and_the_file_only_lists_them() {
        let path = temp("vault");
        let vault = MemoryVault::default();
        let v: Option<&dyn Vault> = Some(&vault);
        set_with(v, &path, "openai", Some("sk-1")).unwrap();
        assert!(!std::fs::read_to_string(&path).unwrap().contains("sk-1"));
        assert!(has_with(v, &path, "openai"));
        assert_eq!(get_with(v, &path, "openai").as_deref(), Some("sk-1"));
        // MCP inputs are filled in from the keychain too.
        set_with(v, &path, "mcp.input.gh::token", Some("s3cret")).unwrap();
        assert_eq!(
            expand_with(v, &path, "Bearer ${secret:mcp.input.gh::token}", Some("gh")).unwrap(),
            "Bearer s3cret"
        );
        set_with(v, &path, "openai", None).unwrap();
        assert!(!has_with(v, &path, "openai"));
        assert!(!vault
            .items
            .lock()
            .unwrap()
            .keys()
            .any(|k| k.ends_with(":openai")));
        // The keychain gone later (another session): the marker reads as no value, so the
        // input is asked for again.
        assert_eq!(get_with(None, &path, "mcp.input.gh::token"), None);
        assert!(!has_with(None, &path, "mcp.input.gh::token"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn without_a_keychain_the_file_keeps_the_values() {
        let path = temp("fallback");
        let refusing = MemoryVault {
            refuse: true,
            ..MemoryVault::default()
        };
        for v in [None, Some(&refusing as &dyn Vault)] {
            set_with(v, &path, "mcp.oauth.x", Some("{\"access_token\":\"t\"}")).unwrap();
            assert!(std::fs::read_to_string(&path)
                .unwrap()
                .contains("access_token"));
            assert_eq!(
                get_with(v, &path, "mcp.oauth.x").as_deref(),
                Some("{\"access_token\":\"t\"}")
            );
            assert_eq!(migrate_with(v, &path).unwrap(), 0);
        }
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn existing_values_move_to_the_keychain_on_first_use() {
        let path = temp("migrate");
        set_with(None, &path, "openai", Some("sk-old")).unwrap();
        set_with(None, &path, "mcp.oauth.gh", Some("tokens")).unwrap();
        let vault = MemoryVault::default();
        let v: Option<&dyn Vault> = Some(&vault);
        assert_eq!(migrate_with(v, &path).unwrap(), 2);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("sk-old") && !text.contains("tokens"));
        assert_eq!(get_with(v, &path, "openai").as_deref(), Some("sk-old"));
        assert_eq!(
            get_with(v, &path, "mcp.oauth.gh").as_deref(),
            Some("tokens")
        );
        // Twice is harmless.
        assert_eq!(migrate_with(v, &path).unwrap(), 0);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn writers_in_other_processes_dont_lose_each_others_keys() {
        let path = temp("lock");
        set_with(None, &path, "a", Some("1")).unwrap();
        // Another process holding the lock: this write waits for it, then reads its change.
        let held = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(lock_path(&path))
            .unwrap();
        held.lock().unwrap();
        let p = path.clone();
        let writer = std::thread::spawn(move || set_with(None, &p, "c", Some("3")).unwrap());
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(
            !writer.is_finished(),
            "the write waits for the other process"
        );
        let mut all = load(&path);
        all.insert("b".into(), "2".into());
        save(&path, &all).unwrap();
        held.unlock().unwrap();
        writer.join().unwrap();
        let all = load(&path);
        assert_eq!(all.get("a").map(String::as_str), Some("1"));
        assert_eq!(all.get("b").map(String::as_str), Some("2"));
        assert_eq!(all.get("c").map(String::as_str), Some("3"));
        let _ = std::fs::remove_file(lock_path(&path));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn profiles_keep_their_own_keys_in_one_keychain() {
        let dir = |n: &str| {
            let d = std::env::temp_dir()
                .join(format!("ide-secrets-profile-{n}-{}", std::process::id()));
            std::fs::create_dir_all(&d).unwrap();
            d.join("secrets.json")
        };
        let (a, b) = (dir("a"), dir("b"));
        let vault = MemoryVault::default();
        let v: Option<&dyn Vault> = Some(&vault);
        set_with(v, &a, "openai", Some("the user's")).unwrap();
        // A test run with its own --user-data-dir sets and clears the same id.
        set_with(v, &b, "openai", Some("the test's")).unwrap();
        set_with(v, &b, "openai", None).unwrap();
        assert_eq!(get_with(v, &a, "openai").as_deref(), Some("the user's"));
        assert_eq!(get_with(v, &b, "openai"), None);
        // A value an earlier build kept under the bare id is still found (and copied over).
        vault
            .items
            .lock()
            .unwrap()
            .insert("mcp.oauth.gh".into(), "old".into());
        let mut all = load(&a);
        all.insert("mcp.oauth.gh".into(), IN_KEYCHAIN.into());
        save(&a, &all).unwrap();
        assert_eq!(get_with(v, &a, "mcp.oauth.gh").as_deref(), Some("old"));
        assert_eq!(
            vault
                .items
                .lock()
                .unwrap()
                .get(&account(&a, "mcp.oauth.gh"))
                .map(String::as_str),
            Some("old")
        );
        for p in [a, b] {
            let _ = std::fs::remove_dir_all(p.parent().unwrap());
        }
    }
}
