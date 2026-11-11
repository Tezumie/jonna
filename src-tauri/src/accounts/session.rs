//! The saved account session (D414): `<data>/account.json` keeps the server and the profile; the
//! tokens live in the OS keychain (D207's vault, one credential per profile folder), or in that
//! file (owner-only) when no keychain answers. A session saved before D414 kept its tokens in the
//! file; they move to the keychain the first time they're read.
//!
//! `check` asks the server for the profile again (at startup, then now and then) and refreshes the
//! tokens when the access token has run out. Refresh tokens rotate: each works once, and the old
//! access token stops at once, so the new pair is saved before anything else and two checks never
//! run at the same time.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{Profile, TokenReply, CLIENT_ID};
use crate::ai::keychain::Vault;
use crate::error::{Error, Result};
use crate::store::atomic_write_private;

/// The keychain credential's id (scoped to the profile folder by `secrets::account`).
const VAULT_ID: &str = "account-tokens";
const NETWORK_TIMEOUT: Duration = Duration::from_secs(15);
/// One check (and so one refresh) at a time: a rotated refresh token works only once.
static CHECKING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    base: String,
    /// Empty when the tokens are in the keychain.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
    profile: Profile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Tokens {
    pub access: String,
    pub refresh: Option<String>,
}

pub fn session_file(data_dir: &Path) -> PathBuf {
    data_dir.join("account.json")
}

/// The keychain this run uses (none in unit tests: they pass their own).
pub fn vault() -> Option<&'static dyn Vault> {
    if cfg!(test) {
        None
    } else {
        crate::ai::keychain::os_vault()
    }
}

fn vault_key(file: &Path) -> String {
    crate::ai::secrets::account(file, VAULT_ID)
}

fn read_session(file: &Path) -> Option<Session> {
    let text = std::fs::read_to_string(file).ok()?;
    serde_json::from_str(&text).ok()
}

/// The session's tokens: from the file (moved to the keychain when there is one), else from the
/// keychain. None when they can't be read (a locked keychain): the session stays as it is.
fn tokens_of(file: &Path, session: &Session, vault: Option<&dyn Vault>) -> Option<Tokens> {
    if !session.access_token.is_empty() {
        let tokens = Tokens {
            access: session.access_token.clone(),
            refresh: session.refresh_token.clone(),
        };
        if vault.is_some() {
            let _ = store(file, vault, &session.base, &session.profile, &tokens);
        }
        return Some(tokens);
    }
    let json = vault?.get(&vault_key(file)).ok()??;
    serde_json::from_str(&json).ok()
}

/// Saves the session: the tokens in the keychain when it takes them, else in the file.
pub fn store(
    file: &Path,
    vault: Option<&dyn Vault>,
    base: &str,
    profile: &Profile,
    tokens: &Tokens,
) -> Result<()> {
    let json = serde_json::to_string(tokens).map_err(|e| Error::Invalid(e.to_string()))?;
    let in_vault = vault.is_some_and(|v| v.set(&vault_key(file), &json).is_ok());
    let session = Session {
        base: base.trim_end_matches('/').to_string(),
        access_token: if in_vault {
            String::new()
        } else {
            tokens.access.clone()
        },
        refresh_token: if in_vault {
            None
        } else {
            tokens.refresh.clone()
        },
        profile: profile.clone(),
    };
    let json = serde_json::to_vec_pretty(&session).map_err(|e| Error::Invalid(e.to_string()))?;
    atomic_write_private(file, &json)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn clear(file: &Path, vault: Option<&dyn Vault>) -> Result<()> {
    if let Some(v) = vault {
        let _ = v.delete(&vault_key(file));
    }
    match std::fs::remove_file(file) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// The signed-in profile as last saved (for `base`; a session from another server doesn't count).
pub fn profile(file: &Path, base: &str) -> Option<Profile> {
    let session = read_session(file)?;
    (session.base == base.trim_end_matches('/')).then_some(session.profile)
}

/// Forgets the session (and tells the server, best effort: either token ends it there).
pub async fn sign_out(file: &Path) -> Result<()> {
    let vault = vault();
    let _guard = CHECKING.lock().await;
    if let Some(session) = read_session(file) {
        if let Some(tokens) = tokens_of(file, &session, vault) {
            let token = tokens.refresh.unwrap_or(tokens.access);
            let _ = reqwest::Client::new()
                .post(format!("{}/oauth/revoke", session.base))
                .form(&[("token", token.as_str()), ("client_id", CLIENT_ID)])
                .timeout(Duration::from_secs(5))
                .send()
                .await;
        }
    }
    clear(file, vault)
}

/// The profile as the server has it now: re-read from `/api/me`, refreshing the tokens when the
/// access token has run out. None when the server ended the session (it's forgotten here too);
/// the saved profile when the server can't be reached (offline, a server error).
pub async fn check(file: &Path, base: &str) -> Result<Option<Profile>> {
    check_with(file, base, vault()).await
}

enum Me {
    Profile(Profile),
    Unauthorized,
    Unreachable,
}

async fn fetch_me(client: &reqwest::Client, base: &str, access: &str) -> Me {
    let Ok(reply) = client
        .get(format!("{base}/api/me"))
        .bearer_auth(access)
        .timeout(NETWORK_TIMEOUT)
        .send()
        .await
    else {
        return Me::Unreachable;
    };
    if reply.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Me::Unauthorized;
    }
    if !reply.status().is_success() {
        return Me::Unreachable;
    }
    match reply.json::<Profile>().await {
        Ok(p) => Me::Profile(p),
        Err(_) => Me::Unreachable,
    }
}

enum Refreshed {
    Tokens(Tokens),
    /// The server said no (400 `invalid_grant`, 401): sign in again.
    Refused,
    Unreachable,
}

async fn refresh_tokens(client: &reqwest::Client, base: &str, refresh: &str) -> Refreshed {
    let Ok(reply) = client
        .post(format!("{base}/oauth/token"))
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh),
            ("client_id", CLIENT_ID),
        ])
        .timeout(NETWORK_TIMEOUT)
        .send()
        .await
    else {
        return Refreshed::Unreachable;
    };
    let status = reply.status();
    if status == reqwest::StatusCode::BAD_REQUEST || status == reqwest::StatusCode::UNAUTHORIZED {
        return Refreshed::Refused;
    }
    if !status.is_success() {
        return Refreshed::Unreachable;
    }
    match reply.json::<TokenReply>().await {
        // A server that doesn't rotate keeps the refresh token it had.
        Ok(t) => Refreshed::Tokens(Tokens {
            access: t.access_token,
            refresh: t.refresh_token.or_else(|| Some(refresh.to_string())),
        }),
        Err(_) => Refreshed::Unreachable,
    }
}

async fn check_with(file: &Path, base: &str, vault: Option<&dyn Vault>) -> Result<Option<Profile>> {
    let _guard = CHECKING.lock().await;
    let Some(session) = read_session(file) else {
        return Ok(None);
    };
    if session.base != base.trim_end_matches('/') {
        return Ok(None);
    }
    let Some(mut tokens) = tokens_of(file, &session, vault) else {
        return Ok(Some(session.profile));
    };
    let client = reqwest::Client::new();
    match fetch_me(&client, &session.base, &tokens.access).await {
        Me::Profile(p) => {
            store(file, vault, &session.base, &p, &tokens)?;
            return Ok(Some(p));
        }
        Me::Unreachable => return Ok(Some(session.profile)),
        Me::Unauthorized => {}
    }
    let Some(refresh) = tokens.refresh.clone() else {
        clear(file, vault)?;
        return Ok(None);
    };
    match refresh_tokens(&client, &session.base, &refresh).await {
        Refreshed::Tokens(t) => tokens = t,
        Refreshed::Refused => {
            clear(file, vault)?;
            return Ok(None);
        }
        Refreshed::Unreachable => return Ok(Some(session.profile)),
    }
    // The old pair stopped working when this one was issued: saved before anything can fail.
    store(file, vault, &session.base, &session.profile, &tokens)?;
    match fetch_me(&client, &session.base, &tokens.access).await {
        Me::Profile(p) => {
            store(file, vault, &session.base, &p, &tokens)?;
            Ok(Some(p))
        }
        Me::Unreachable => Ok(Some(session.profile)),
        Me::Unauthorized => {
            clear(file, vault)?;
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct MemoryVault {
        items: Mutex<BTreeMap<String, String>>,
    }

    impl Vault for MemoryVault {
        fn get(&self, id: &str) -> std::result::Result<Option<String>, String> {
            Ok(self.items.lock().unwrap().get(id).cloned())
        }
        fn set(&self, id: &str, value: &str) -> std::result::Result<(), String> {
            self.items.lock().unwrap().insert(id.into(), value.into());
            Ok(())
        }
        fn delete(&self, id: &str) -> std::result::Result<(), String> {
            self.items.lock().unwrap().remove(id);
            Ok(())
        }
    }

    fn temp_file(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ide-account-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("account.json")
    }

    fn ada(name: &str) -> Profile {
        Profile {
            id: "u1".into(),
            name: name.into(),
            email: None,
            avatar_url: None,
            plan: Some("free".into()),
        }
    }

    fn pair(access: &str, refresh: &str) -> Tokens {
        Tokens {
            access: access.into(),
            refresh: Some(refresh.into()),
        }
    }

    /// A tiny accounts server: each request (method, path, bearer) gets `route`'s (status, body).
    fn serve(
        route: impl Fn(&str, &str, &str) -> (u16, String) + Send + 'static,
    ) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                let _ = reader.read_line(&mut line);
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap_or("").to_string();
                let path = parts.next().unwrap_or("").to_string();
                let (mut bearer, mut length) = (String::new(), 0usize);
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 || header == "\r\n" {
                        break;
                    }
                    let lower = header.to_ascii_lowercase();
                    if let Some(v) = lower.strip_prefix("content-length:") {
                        length = v.trim().parse().unwrap_or(0);
                    }
                    if lower.starts_with("authorization:") {
                        bearer = header.trim().rsplit(' ').next().unwrap_or("").to_string();
                    }
                }
                let mut body = vec![0u8; length];
                let _ = reader.read_exact(&mut body);
                let body = String::from_utf8_lossy(&body).into_owned();
                log.lock()
                    .unwrap()
                    .push(format!("{method} {path} {bearer}{body}"));
                let (status, reply) = route(&method, &path, &bearer);
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                        reply.len()
                    )
                    .as_bytes(),
                );
            }
        });
        (base, seen)
    }

    #[test]
    fn tokens_saved_before_the_keychain_move_into_it() {
        let file = temp_file("migrate");
        let vault = MemoryVault::default();
        // A pre-D414 session: the tokens in the file.
        store(
            &file,
            None,
            "https://a.example",
            &ada("Ada"),
            &pair("a1", "r1"),
        )
        .unwrap();
        assert!(std::fs::read_to_string(&file).unwrap().contains("a1"));
        let session = read_session(&file).unwrap();
        assert_eq!(
            tokens_of(&file, &session, Some(&vault)),
            Some(pair("a1", "r1"))
        );
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(!text.contains("a1") && !text.contains("r1"), "{text}");
        let session = read_session(&file).unwrap();
        assert_eq!(
            tokens_of(&file, &session, Some(&vault)),
            Some(pair("a1", "r1"))
        );
        assert_eq!(
            profile(&file, "https://a.example/").map(|p| p.name),
            Some("Ada".into())
        );
        clear(&file, Some(&vault)).unwrap();
        assert!(vault.items.lock().unwrap().is_empty());
        assert!(!file.exists());
    }

    #[test]
    fn an_expired_access_token_is_refreshed_and_the_new_pair_kept() {
        tauri::async_runtime::block_on(async {
            let (base, seen) = serve(|method, path, bearer| match (method, path, bearer) {
                ("GET", "/api/me", "a2") => (
                    200,
                    r#"{"id":"u1","name":"Ada L","email":null,"avatarUrl":null,"plan":"pro"}"#
                        .into(),
                ),
                ("GET", "/api/me", _) => (401, r#"{"error":"invalid_token"}"#.into()),
                ("POST", "/oauth/token", _) => (
                    200,
                    r#"{"access_token":"a2","refresh_token":"r2","expires_in":7776000}"#.into(),
                ),
                _ => (404, "{}".into()),
            });
            let file = temp_file("refresh");
            let vault = MemoryVault::default();
            store(&file, Some(&vault), &base, &ada("Ada"), &pair("a1", "r1")).unwrap();
            let p = check_with(&file, &base, Some(&vault))
                .await
                .unwrap()
                .unwrap();
            assert_eq!((p.name.as_str(), p.plan.as_deref()), ("Ada L", Some("pro")));
            let session = read_session(&file).unwrap();
            assert_eq!(session.profile.name, "Ada L");
            assert_eq!(
                tokens_of(&file, &session, Some(&vault)),
                Some(pair("a2", "r2"))
            );
            let seen = seen.lock().unwrap().clone();
            assert!(seen[1].contains("grant_type=refresh_token"), "{seen:?}");
            assert!(seen[1].contains("refresh_token=r1"), "{seen:?}");
        });
    }

    #[test]
    fn a_refused_refresh_signs_out_and_an_unreachable_server_keeps_the_profile() {
        tauri::async_runtime::block_on(async {
            let (base, _) = serve(|_, path, _| match path {
                "/api/me" => (401, r#"{"error":"invalid_token"}"#.into()),
                _ => (400, r#"{"error":"invalid_grant"}"#.into()),
            });
            let file = temp_file("refused");
            let vault = MemoryVault::default();
            store(&file, Some(&vault), &base, &ada("Ada"), &pair("a1", "r1")).unwrap();
            assert_eq!(check_with(&file, &base, Some(&vault)).await.unwrap(), None);
            assert!(!file.exists());
            assert!(vault.items.lock().unwrap().is_empty());

            // Nothing listens on port 9: offline keeps the saved profile.
            let offline = "http://127.0.0.1:9";
            store(&file, Some(&vault), offline, &ada("Ada"), &pair("a1", "r1")).unwrap();
            let p = check_with(&file, offline, Some(&vault)).await.unwrap();
            assert_eq!(p.map(|p| p.name), Some("Ada".into()));
            // Another server's session doesn't count.
            assert_eq!(check_with(&file, &base, Some(&vault)).await.unwrap(), None);
            assert!(file.exists());
        });
    }
}
