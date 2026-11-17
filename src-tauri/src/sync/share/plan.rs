//! What the sharer's computer decides, as plain functions of what it holds and what the
//! service answered: which files never go into a share, how a remote's address is shown, what
//! to do about a share's keys, and whether keys kept from before can start a share.

use std::collections::BTreeSet;

use crate::sync::snapshot;

/// Why a key file is listed as left out.
pub const KEY_FILE: &str = "a key file";

/// Files that are left out of a share whatever the ignore files say, by their name (the last
/// part of the path, whatever its case): `.env` and `.env.*` (but `.env.example`,
/// `.env.sample` and `.env.template` travel), `*.pem`, `*.key`, `*.p12`, `*.pfx`,
/// `*.keystore`, `*.jks`, `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `.npmrc`, `.netrc`,
/// `.pypirc`, and `credentials` or `secrets` with any ending or none.
pub fn key_file(path: &str) -> Option<&'static str> {
    let name = path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_lowercase();
    let env = name == ".env"
        || (name.starts_with(".env.")
            && !matches!(
                name.as_str(),
                ".env.example" | ".env.sample" | ".env.template"
            ));
    let ending = [".pem", ".key", ".p12", ".pfx", ".keystore", ".jks"]
        .iter()
        .any(|e| name.ends_with(e));
    let ssh = ["id_rsa", "id_ed25519", "id_ecdsa"]
        .iter()
        .any(|s| name.starts_with(s));
    let config = matches!(name.as_str(), ".npmrc" | ".netrc" | ".pypirc");
    let named = ["credentials", "secrets"].iter().any(|stem| {
        name == *stem
            || name
                .strip_prefix(stem)
                .is_some_and(|rest| rest.starts_with('.'))
    });
    (env || ending || ssh || config || named).then_some(KEY_FILE)
}

/// A remote's address as a share may show it to teammates: only an ordinary https, ssh or git
/// address (`snapshot::safe_remote`), and without a sign-in written into it (the name and
/// password or token of `https://name:token@host/…`; an ssh address keeps its user name,
/// which is part of the address, and loses a password). None: not shown at all.
pub fn public_remote(url: &str) -> Option<String> {
    let url = url.trim();
    if !snapshot::safe_remote(url) {
        return None;
    }
    let shown = match url.split_once("://") {
        Some((scheme, rest)) => {
            let (authority, path) = match rest.find('/') {
                Some(at) => rest.split_at(at),
                None => (rest, ""),
            };
            let authority = match authority.rsplit_once('@') {
                None => authority.to_string(),
                Some((user, host)) if scheme.eq_ignore_ascii_case("ssh") => {
                    let user = user.split(':').next().unwrap_or("");
                    if user.is_empty() {
                        host.to_string()
                    } else {
                        format!("{user}@{host}")
                    }
                }
                Some((_, host)) => host.to_string(),
            };
            format!("{scheme}://{authority}{path}")
        }
        // The short SSH form, `user@host:path`: nothing but the address is in it.
        None => url.to_string(),
    };
    snapshot::safe_remote(&shown).then_some(shown)
}

/// What to do about a share's keys.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeysPlan {
    /// Every member who can have the keys has them.
    Nothing,
    /// Members without a wrap at the current generation get one.
    Add { generation: u64, to: Vec<String> },
    /// Someone left: a generation is added to the keyring, the sealed record is saved, and
    /// only then are the next generation's wraps stored.
    Renew { generation: u64 },
    /// The record already holds the next generation (it was saved, and storing the wraps
    /// didn't happen or wasn't seen to): the wraps are stored for it, with no new key.
    Store { generation: u64 },
    /// The service is ahead of the record as it was read: read both again.
    ReadAgain,
    /// The record and the service can't be the same share's keys.
    Mismatch,
}

/// `held`: the generation of the keyring in the sealed record. `current`: the generation the
/// service has as current, and whether it asks for new keys. `to`: the members who may have
/// the keys (`pins::recipients`). `wrapped`: who has a wrap at the current generation.
pub fn keys_plan(
    held: u64,
    current: u64,
    renewal_needed: bool,
    to: &[String],
    wrapped: &BTreeSet<String>,
) -> KeysPlan {
    if held == current {
        if renewal_needed {
            return KeysPlan::Renew {
                generation: current + 1,
            };
        }
        let missing: Vec<String> = to
            .iter()
            .filter(|uid| !wrapped.contains(*uid))
            .cloned()
            .collect();
        if missing.is_empty() {
            return KeysPlan::Nothing;
        }
        return KeysPlan::Add {
            generation: current,
            to: missing,
        };
    }
    if held == current + 1 {
        return KeysPlan::Store { generation: held };
    }
    if held < current {
        return KeysPlan::ReadAgain;
    }
    KeysPlan::Mismatch
}

/// How a share starts, given the keyring already kept for the project (if any) and whether
/// the service has the share.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartPlan {
    /// A new keyring (replacing one kept from an earlier life of the share).
    Fresh,
    /// The keyring kept is the share's.
    Reuse,
    /// The service has the share and this account no longer has its keys.
    KeysLost,
}

/// A keyring kept and no share for it: for this long it is taken as a start under way (on
/// another of the account's computers, or one cut short here) and used; older, it is what an
/// earlier share of the project left behind, which people who since left may hold.
pub const START_GRACE_MS: u64 = 10 * 60 * 1000;

/// `kept`: the kept keyring's generation and when it was made.
pub fn start_plan(kept: Option<(u32, u64)>, exists: bool, now_ms: u64) -> StartPlan {
    match (kept, exists) {
        (Some(_), true) => StartPlan::Reuse,
        (None, true) => StartPlan::KeysLost,
        (Some((1, made)), false) if now_ms.abs_diff(made) <= START_GRACE_MS => StartPlan::Reuse,
        (_, false) => StartPlan::Fresh,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_files_are_left_out_by_name() {
        for path in [
            ".env",
            "app/.env",
            ".env.local",
            ".env.production",
            ".env.example.local",
            ".ENV",
            "server.pem",
            "certs/tls.key",
            "store.p12",
            "sign.pfx",
            "release.keystore",
            "android/app/upload.jks",
            "id_rsa",
            "id_rsa.pub",
            "keys/id_ed25519",
            "id_ed25519.pub",
            "id_ecdsa",
            "id_ecdsa-work",
            ".npmrc",
            "pkg/.npmrc",
            ".netrc",
            ".pypirc",
            "credentials",
            "credentials.json",
            ".aws/credentials",
            "secrets",
            "secrets.yaml",
            "config/secrets.enc.yml",
            "Secrets.TOML",
            "win\\path\\.env",
        ] {
            assert_eq!(key_file(path), Some(KEY_FILE), "{path}");
        }
        for path in [
            ".env.example",
            ".env.sample",
            ".env.template",
            "app/.env.example",
            ".envrc",
            "env",
            "env.ts",
            "docs/.environment.md",
            "pem",
            "key",
            "keys.md",
            "monkey.rs",
            "public.pem.txt",
            "keystore.md",
            "my_id_rsa",
            "npmrc",
            ".npmrc.md",
            "credentials-example",
            "secretsanta.txt",
            "my-secrets.txt",
            "credentials/readme.md",
            "secrets/notes.txt",
            ".env/readme.md",
            "src/main.rs",
            "",
        ] {
            assert_eq!(key_file(path), None, "{path}");
        }
    }

    #[test]
    fn a_remote_is_shown_without_a_sign_in() {
        let shown = |url: &str| public_remote(url);
        assert_eq!(
            shown("https://github.com/owner/repo.git").as_deref(),
            Some("https://github.com/owner/repo.git")
        );
        assert_eq!(
            shown("https://name:ghp_token@github.com/owner/repo.git").as_deref(),
            Some("https://github.com/owner/repo.git")
        );
        assert_eq!(
            shown("https://ghp_token@github.com/owner/repo").as_deref(),
            Some("https://github.com/owner/repo")
        );
        assert_eq!(
            shown("https://a:b@c:d@example.com:8443/x/y").as_deref(),
            Some("https://example.com:8443/x/y")
        );
        assert_eq!(
            shown(" git@github.com:owner/repo.git ").as_deref(),
            Some("git@github.com:owner/repo.git")
        );
        assert_eq!(
            shown("ssh://git:pass@example.com:22/owner/repo").as_deref(),
            Some("ssh://git@example.com:22/owner/repo")
        );
        assert_eq!(
            shown("ssh://example.com/owner/repo").as_deref(),
            Some("ssh://example.com/owner/repo")
        );
        assert_eq!(
            shown("git://example.com/owner/repo").as_deref(),
            Some("git://example.com/owner/repo")
        );
        // Not an ordinary address: not shown, so nobody's computer is sent there.
        for bad in [
            "",
            "C:\\repos\\thing",
            "/srv/git/thing.git",
            "../thing",
            "file:///srv/git/thing",
            "ext::sh -c 'x'",
            "--upload-pack=x",
            "https://",
            "https://user:pw@",
            "https://example.com/a\nb",
        ] {
            assert_eq!(shown(bad), None, "{bad}");
        }
    }

    fn uids(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn members_without_a_wrap_get_one() {
        let to = uids(&["a", "b", "c"]);
        let wrapped: BTreeSet<String> = uids(&["a"]).into_iter().collect();
        assert_eq!(
            keys_plan(1, 1, false, &to, &wrapped),
            KeysPlan::Add {
                generation: 1,
                to: uids(&["b", "c"])
            }
        );
        let all: BTreeSet<String> = to.iter().cloned().collect();
        assert_eq!(keys_plan(3, 3, false, &to, &all), KeysPlan::Nothing);
        assert_eq!(keys_plan(3, 3, false, &[], &all), KeysPlan::Nothing);
        // Someone who has a wrap and may no longer have the keys (their key changed) keeps the
        // old wrap until the keys are renewed; nothing new is made for them.
        assert_eq!(
            keys_plan(1, 1, false, &uids(&["a"]), &all),
            KeysPlan::Nothing
        );
    }

    #[test]
    fn new_keys_are_saved_before_they_are_handed_out_and_picked_up_again() {
        let to = uids(&["a"]);
        let none = BTreeSet::new();
        // Someone left: a new generation, whoever has wraps.
        assert_eq!(
            keys_plan(2, 2, true, &to, &none),
            KeysPlan::Renew { generation: 3 }
        );
        assert_eq!(
            keys_plan(2, 2, true, &[], &none),
            KeysPlan::Renew { generation: 3 },
            "with nobody left to hand them to as well"
        );
        // The record was saved and the wraps never stored (the app closed, the call failed):
        // the same keys are stored, no further generation is made.
        assert_eq!(
            keys_plan(3, 2, true, &to, &none),
            KeysPlan::Store { generation: 3 }
        );
        assert_eq!(
            keys_plan(3, 2, false, &to, &none),
            KeysPlan::Store { generation: 3 }
        );
        // Stored: nothing more.
        let all: BTreeSet<String> = to.iter().cloned().collect();
        assert_eq!(keys_plan(3, 3, false, &to, &all), KeysPlan::Nothing);
        // The service is ahead of what was read (another computer of the sharer's renewed
        // meanwhile, or the service answered a store with "a newer generation"): read again.
        assert_eq!(keys_plan(2, 3, false, &to, &none), KeysPlan::ReadAgain);
        assert_eq!(keys_plan(2, 4, true, &to, &none), KeysPlan::ReadAgain);
        // Keys two or more ahead of the service were never this share's.
        assert_eq!(keys_plan(4, 2, false, &to, &none), KeysPlan::Mismatch);
        assert_eq!(keys_plan(5, 1, true, &to, &none), KeysPlan::Mismatch);
    }

    #[test]
    fn a_share_starts_with_new_keys_unless_its_own_are_kept() {
        let now = 1_800_000_000_000u64;
        assert_eq!(start_plan(None, false, now), StartPlan::Fresh);
        // The service has the share: its keys are the ones kept, at any generation and age.
        assert_eq!(start_plan(Some((1, 5)), true, now), StartPlan::Reuse);
        assert_eq!(start_plan(Some((4, now)), true, now), StartPlan::Reuse);
        assert_eq!(start_plan(None, true, now), StartPlan::KeysLost);
        // No share, keys made a moment ago: a start under way.
        assert_eq!(
            start_plan(Some((1, now - 60_000)), false, now),
            StartPlan::Reuse
        );
        assert_eq!(
            start_plan(Some((1, now + 30_000)), false, now),
            StartPlan::Reuse
        );
        // No share, and keys from before: an earlier share's, never used again.
        assert_eq!(
            start_plan(Some((1, now - START_GRACE_MS - 1)), false, now),
            StartPlan::Fresh
        );
        assert_eq!(
            start_plan(Some((2, now - 1_000)), false, now),
            StartPlan::Fresh
        );
    }
}
