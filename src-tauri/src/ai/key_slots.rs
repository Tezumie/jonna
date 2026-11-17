//! Where each kind of key lives in the secrets store. The store has one flat namespace that
//! also holds the sync device key, the account keyring, MCP sign-ins and extensions' own
//! secrets, so nothing may pick an entry by a name the page (or a settings file) supplies:
//!
//! - a model provider's key is `provider.<id>`, with the address it was saved for beside it, and
//!   is given only to that address (scheme, host and port);
//! - an MCP server's password input is `mcp.input.<server>::<input>[@<identity>]`;
//! - a web search key is `websearch.<brave|tavily|exa>`.
//!
//! Everything else in the store (`ext.<id>::<key>`, `mcp.oauth.<server>`, `notify.webhook`, the
//! sync keys) has its own fixed name in its own module and can't be reached from here.

use std::path::Path;

use super::secrets;
use crate::error::{Error, Result};

const PROVIDER_PREFIX: &str = "provider.";
/// The entry that says the one-time move of provider keys to `provider.<id>` has run.
const MOVED_MARK: &str = "provider.keys-moved";
/// Names other parts of the IDE keep in the store. A provider id is never one of these (its
/// key lives under `provider.` anyway; this also keeps the one-time move away from them).
const RESERVED_NAMES: &[&str] = &["sync-device-key", "sync-keyring", "notify.webhook"];
const RESERVED_PREFIXES: &[&str] = &[
    "provider.",
    "mcp.",
    "ext.",
    "websearch.",
    "notify.",
    "sync-",
    "sync.",
    "accounts.",
    "secrets.",
];
const WEB_SEARCH: &[&str] = &["brave", "tavily", "exa"];

/// A provider id: a letter or digit, then letters, digits, `_`, `-` and `.`, 64 at most, and
/// not a name (or the start of one) another part of the IDE keeps in the store.
pub fn valid_provider_id(id: &str) -> bool {
    let mut chars = id.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_alphanumeric());
    if !first_ok || id.len() > 64 {
        return false;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
        return false;
    }
    let lower = id.to_ascii_lowercase();
    !RESERVED_NAMES.contains(&lower.as_str())
        && !RESERVED_PREFIXES.iter().any(|p| lower.starts_with(p))
}

fn provider_slot(id: &str) -> Result<String> {
    if !valid_provider_id(id) {
        return Err(Error::Invalid(format!(
            "\"{}\" can't be a model provider's id: use letters, digits, - and _.",
            id.chars().take(64).collect::<String>()
        )));
    }
    Ok(format!("{PROVIDER_PREFIX}{id}"))
}

fn name_part(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 200
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// `mcp.input.<server>::<input>[@<identity>]`, each part letters, digits, `_` and `-`.
fn is_mcp_input(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("mcp.input.") else {
        return false;
    };
    let Some((server, input)) = rest.split_once("::") else {
        return false;
    };
    let (input, identity) = match input.split_once('@') {
        Some((input, identity)) => (input, Some(identity)),
        None => (input, None),
    };
    name_part(server) && name_part(input) && identity.is_none_or(name_part)
}

fn is_web_search(id: &str) -> bool {
    id.strip_prefix("websearch.")
        .is_some_and(|p| WEB_SEARCH.contains(&p))
}

/// What the page may name when it stores or asks about a key.
#[derive(Debug, PartialEq, Eq)]
pub enum Slot {
    /// A model provider's key (the entry's name; its value is bound to an address).
    Provider(String),
    /// An MCP input or a web search key (the entry's name; the value as typed).
    Plain(String),
}

/// The entry for what the page calls `id`: one of the three families above, or an error. Never
/// an entry of another family, whatever `id` says.
pub fn slot_for(id: &str) -> Result<Slot> {
    if is_mcp_input(id) || is_web_search(id) {
        return Ok(Slot::Plain(id.to_string()));
    }
    provider_slot(id).map(Slot::Provider)
}

/// The address a key is bound to: scheme, host and port (`https://api.example.com`), as the
/// URL standard writes an origin. None for anything that isn't an http(s) address.
pub fn origin(base_url: &str) -> Option<String> {
    let url = reqwest::Url::parse(base_url.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return None;
    }
    Some(url.origin().ascii_serialization())
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Bound {
    key: String,
    origin: String,
}

/// A provider's stored key, read for the address it is about to be sent to.
#[derive(Debug, PartialEq, Eq)]
pub enum Stored {
    None,
    Key(String),
    /// A key is stored, for this other address: it isn't sent.
    OtherAddress(String),
}

fn read(path: &Path, id: &str, base_url: &str) -> Result<Stored> {
    let slot = provider_slot(id)?;
    let Some(text) = secrets::get(path, &slot) else {
        return Ok(Stored::None);
    };
    // An entry that isn't a key with its address (damaged) counts as no key.
    let Ok(bound) = serde_json::from_str::<Bound>(&text) else {
        return Ok(Stored::None);
    };
    Ok(match origin(base_url) {
        Some(now) if now == bound.origin => Stored::Key(bound.key),
        _ => Stored::OtherAddress(bound.origin),
    })
}

/// The key to send to `base_url` as provider `id`: none stored, or an error when the id is no
/// provider id or the key was saved for another address (so it is never sent there).
pub fn provider_key(path: &Path, id: &str, base_url: &str) -> Result<Option<String>> {
    match read(path, id, base_url)? {
        Stored::None => Ok(None),
        Stored::Key(key) => Ok(Some(key)),
        Stored::OtherAddress(saved) => Err(Error::Invalid(format!(
            "The API key for {id} was saved for {saved}. Enter the key again to use it with {}.",
            origin(base_url).unwrap_or_else(|| "this address".into())
        ))),
    }
}

/// Stores (or with `None`, removes) what the page calls `id`. A provider's key needs the
/// address it is for.
pub fn set(path: &Path, id: &str, key: Option<&str>, base_url: Option<&str>) -> Result<()> {
    match slot_for(id)? {
        Slot::Plain(name) => secrets::set(path, &name, key),
        Slot::Provider(name) => match key.filter(|k| !k.is_empty()) {
            None => secrets::set(path, &name, None),
            Some(key) => {
                let origin = base_url.and_then(origin).ok_or_else(|| {
                    Error::Invalid("A provider's key is saved for its http(s) address.".into())
                })?;
                let bound = Bound {
                    key: key.to_string(),
                    origin,
                };
                secrets::set(path, &name, Some(&serde_json::to_string(&bound)?))
            }
        },
    }
}

/// Whether a value is stored for what the page calls `id`; for a provider, one that would be
/// sent to `base_url` (a key saved for another address counts as none: it is asked for again).
pub fn has(path: &Path, id: &str, base_url: Option<&str>) -> Result<bool> {
    Ok(match slot_for(id)? {
        Slot::Plain(name) => secrets::has(path, &name),
        Slot::Provider(_) => match base_url {
            Some(url) => matches!(read(path, id, url)?, Stored::Key(_)),
            None => false,
        },
    })
}

/// The one-time move of provider keys from their bare ids (how earlier builds kept them) to
/// `provider.<id>`, each bound to the address its provider has now. `providers` is (id,
/// address) as the settings and the built-in list name them at that moment. Runs once per
/// secrets file: afterwards a bare entry is never read as a provider's key again, so a provider
/// added later can't claim one. Never moves a reserved name or anything that isn't a provider
/// id, and never replaces a key already under `provider.<id>`.
pub fn move_provider_keys(path: &Path, providers: &[(String, String)]) -> Result<usize> {
    if secrets::listed(path, MOVED_MARK) {
        return Ok(0);
    }
    let mut moved = 0;
    for (id, base_url) in providers {
        let (Ok(slot), Some(origin)) = (provider_slot(id), origin(base_url)) else {
            continue;
        };
        if secrets::listed(path, &slot) {
            continue;
        }
        let Some(key) = secrets::get(path, id) else {
            continue;
        };
        let bound = Bound { key, origin };
        secrets::set(path, &slot, Some(&serde_json::to_string(&bound)?))?;
        secrets::set(path, id, None)?;
        moved += 1;
    }
    secrets::set(path, MOVED_MARK, Some("1"))?;
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ide-slots-{name}-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn provider_ids_are_plain_and_never_a_reserved_name() {
        for ok in ["openai", "my-llm", "LM_Studio", "a.b", "openai.check", "x1"] {
            assert!(valid_provider_id(ok), "{ok}");
        }
        for bad in [
            "",
            "sync-keyring",
            "sync-device-key",
            "SYNC-KEYRING",
            "sync-anything",
            "notify.webhook",
            "mcp.oauth.github",
            "mcp.input.gh::token",
            "ext.some.ext::token",
            "websearch.brave",
            "provider.openai",
            "a/b",
            "a b",
            "a::b",
            ".hidden",
            "-x",
            &"a".repeat(65),
        ] {
            assert!(!valid_provider_id(bad), "{bad}");
            assert!(provider_slot(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_page_reaches_only_its_three_families() {
        assert_eq!(
            slot_for("openai").unwrap(),
            Slot::Provider("provider.openai".into())
        );
        assert_eq!(
            slot_for("mcp.input.gh::token@0a1b2c3d4e5f").unwrap(),
            Slot::Plain("mcp.input.gh::token@0a1b2c3d4e5f".into())
        );
        assert_eq!(
            slot_for("websearch.exa").unwrap(),
            Slot::Plain("websearch.exa".into())
        );
        for bad in [
            "sync-keyring",
            "sync-device-key",
            "mcp.oauth.gh",
            "mcp.input.gh",
            "mcp.input.gh::",
            "mcp.input.::x",
            "mcp.input.gh::a b",
            "ext.x::y",
            "notify.webhook",
            "websearch.other",
            "provider.openai",
        ] {
            assert!(slot_for(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn an_origin_is_scheme_host_and_port() {
        assert_eq!(
            origin("https://API.OpenAI.com/v1/").as_deref(),
            Some("https://api.openai.com")
        );
        assert_eq!(
            origin("https://api.openai.com:443/x").as_deref(),
            Some("https://api.openai.com")
        );
        assert_eq!(
            origin("http://127.0.0.1:1234/v1").as_deref(),
            Some("http://127.0.0.1:1234")
        );
        assert_ne!(
            origin("http://api.openai.com"),
            origin("https://api.openai.com")
        );
        assert_eq!(origin("file:///etc/passwd"), None);
        assert_eq!(origin("not an address"), None);
    }

    #[test]
    fn a_provider_named_after_another_entry_gets_nothing_of_it() {
        let path = temp("names");
        secrets::set(&path, "sync-keyring", Some("the keyring")).unwrap();
        secrets::set(&path, "mcp.oauth.gh", Some("tokens")).unwrap();
        secrets::set(&path, "ext.a::b", Some("theirs")).unwrap();
        secrets::set(&path, "plain", Some("a bare entry")).unwrap();
        let evil = "https://evil.example/v1";
        for id in ["sync-keyring", "mcp.oauth.gh", "ext.a::b"] {
            assert!(provider_key(&path, id, evil).is_err(), "{id}");
            assert!(set(&path, id, Some("x"), Some(evil)).is_err(), "{id}");
            assert!(set(&path, id, None, None).is_err(), "{id}");
            assert!(has(&path, id, Some(evil)).is_err(), "{id}");
        }
        // A bare entry isn't a provider's key either.
        assert_eq!(provider_key(&path, "plain", evil).unwrap(), None);
        assert_eq!(
            secrets::get(&path, "sync-keyring").as_deref(),
            Some("the keyring")
        );
        assert_eq!(
            secrets::get(&path, "mcp.oauth.gh").as_deref(),
            Some("tokens")
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_key_goes_only_to_the_address_it_was_saved_for() {
        let path = temp("origin");
        set(
            &path,
            "openai",
            Some("sk-1"),
            Some("https://api.openai.com/v1"),
        )
        .unwrap();
        assert_eq!(
            provider_key(&path, "openai", "https://api.openai.com/v2")
                .unwrap()
                .as_deref(),
            Some("sk-1")
        );
        assert!(has(&path, "openai", Some("https://api.openai.com")).unwrap());
        // The provider's address changed in the settings: the key stays here.
        let error = provider_key(&path, "openai", "https://evil.example/v1").unwrap_err();
        assert!(error.to_string().contains("Enter the key again"), "{error}");
        assert!(!error.to_string().contains("sk-1"));
        assert!(!has(&path, "openai", Some("https://evil.example/v1")).unwrap());
        assert!(!has(&path, "openai", None).unwrap());
        // No address, no key saved.
        assert!(set(&path, "other", Some("sk-2"), None).is_err());
        assert!(set(&path, "other", Some("sk-2"), Some("ftp://x")).is_err());
        // Entered again for the new address, it is that address's key.
        set(&path, "openai", Some("sk-3"), Some("https://proxy.example")).unwrap();
        assert_eq!(
            provider_key(&path, "openai", "https://proxy.example/v1")
                .unwrap()
                .as_deref(),
            Some("sk-3")
        );
        assert!(provider_key(&path, "openai", "https://api.openai.com/v1").is_err());
        set(&path, "openai", None, None).unwrap();
        assert_eq!(
            provider_key(&path, "openai", "https://proxy.example").unwrap(),
            None
        );
        // MCP inputs and web search keys are stored as typed.
        set(&path, "websearch.brave", Some("b"), None).unwrap();
        assert!(has(&path, "websearch.brave", None).unwrap());
        assert_eq!(secrets::get(&path, "websearch.brave").as_deref(), Some("b"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn earlier_keys_move_once_and_reserved_names_stay() {
        let path = temp("move");
        secrets::set(&path, "openai", Some("sk-old")).unwrap();
        secrets::set(&path, "later", Some("sk-later")).unwrap();
        secrets::set(&path, "sync-keyring", Some("the keyring")).unwrap();
        secrets::set(&path, "mcp.oauth.gh", Some("tokens")).unwrap();
        let listed = |pairs: &[(&str, &str)]| -> Vec<(String, String)> {
            pairs
                .iter()
                .map(|(a, b)| (a.to_string(), b.to_string()))
                .collect()
        };
        let moved = move_provider_keys(
            &path,
            &listed(&[
                ("openai", "https://api.openai.com/v1"),
                ("sync-keyring", "https://evil.example"),
                ("mcp.oauth.gh", "https://evil.example"),
                ("absent", "https://x.example"),
                ("nowhere", "not an address"),
            ]),
        )
        .unwrap();
        assert_eq!(moved, 1);
        assert_eq!(
            provider_key(&path, "openai", "https://api.openai.com/v1")
                .unwrap()
                .as_deref(),
            Some("sk-old")
        );
        assert!(provider_key(&path, "openai", "https://evil.example").is_err());
        assert_eq!(secrets::get(&path, "openai"), None);
        assert_eq!(
            secrets::get(&path, "sync-keyring").as_deref(),
            Some("the keyring")
        );
        assert_eq!(
            secrets::get(&path, "mcp.oauth.gh").as_deref(),
            Some("tokens")
        );
        // A provider that turns up afterwards can't claim a bare entry.
        let again =
            move_provider_keys(&path, &listed(&[("later", "https://evil.example")])).unwrap();
        assert_eq!(again, 0);
        assert_eq!(
            provider_key(&path, "later", "https://evil.example").unwrap(),
            None
        );
        assert_eq!(secrets::get(&path, "later").as_deref(), Some("sk-later"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn the_move_leaves_a_key_already_in_place() {
        let path = temp("keep");
        set(
            &path,
            "openai",
            Some("sk-new"),
            Some("https://api.openai.com"),
        )
        .unwrap();
        secrets::set(&path, "openai", Some("sk-bare")).unwrap();
        let providers = vec![("openai".to_string(), "https://evil.example".to_string())];
        assert_eq!(move_provider_keys(&path, &providers).unwrap(), 0);
        assert_eq!(
            provider_key(&path, "openai", "https://api.openai.com")
                .unwrap()
                .as_deref(),
            Some("sk-new")
        );
        let _ = std::fs::remove_file(path);
    }
}
