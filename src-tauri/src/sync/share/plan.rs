//! What the sharer's computer decides, as plain functions of what it holds and what the
//! service answered: which files never go into a share, how a remote's address is shown, what
//! to do about a share's keys, and whether keys kept from before can start a share.

use std::collections::BTreeSet;

use crate::sync::snapshot;

/// Why a key file is listed as left out.
pub const KEY_FILE: &str = "a key file";

/// Files that are left out of a share whatever the ignore files say, by their name (the last
/// part of the path, whatever its case; one rule looks at the folder too):
///
/// - environment files: `.env`, `.env.*` and `*.env` (but `.env.example`, `.env.sample` and
///   `.env.template` travel), `.envrc`, `.dev.vars`;
/// - keys and key stores by their ending: `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`,
///   `*.jks`, `*.ppk`, `*.kdbx`;
/// - SSH keys: `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `id_dsa*`;
/// - sign-ins of tools: `.npmrc`, `.yarnrc.yml`, `.netrc`, `.pypirc`, `.git-credentials`,
///   `.pgpass`, `.htpasswd`, `auth.json`, and `config.json` in a folder named `.docker`;
/// - cloud and cluster access: `*.tfvars` and `*.tfvars.json`, `terraform.tfstate` and
///   `terraform.tfstate.*`, `kubeconfig` and `*.kubeconfig`, `client_secret*.json`,
///   `service-account*.json`;
/// - `credentials`, `secret` or `secrets` with any ending or none.
pub fn key_file(path: &str) -> Option<&'static str> {
    let lower = path.replace('\\', "/").to_lowercase();
    let mut parts = lower.rsplit('/');
    let name = parts.next().unwrap_or("");
    let folder = parts.next().unwrap_or("");
    let env = name == ".env"
        || name == ".envrc"
        || name == ".dev.vars"
        || ((name.starts_with(".env.") || name.ends_with(".env"))
            && !matches!(name, ".env.example" | ".env.sample" | ".env.template"));
    let ending = [
        ".pem",
        ".key",
        ".p12",
        ".pfx",
        ".keystore",
        ".jks",
        ".ppk",
        ".kdbx",
        ".tfvars",
        ".tfvars.json",
        ".kubeconfig",
    ]
    .iter()
    .any(|e| name.ends_with(e));
    let ssh = ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"]
        .iter()
        .any(|s| name.starts_with(s));
    let config = matches!(
        name,
        ".npmrc"
            | ".yarnrc.yml"
            | ".netrc"
            | ".pypirc"
            | ".git-credentials"
            | ".pgpass"
            | ".htpasswd"
            | "auth.json"
            | "kubeconfig"
            | "terraform.tfstate"
    ) || name.starts_with("terraform.tfstate.")
        || (name == "config.json" && folder == ".docker");
    let json = name.ends_with(".json")
        && (name.starts_with("client_secret") || name.starts_with("service-account"));
    let named = ["credentials", "secrets", "secret"].iter().any(|stem| {
        name == *stem
            || name
                .strip_prefix(stem)
                .is_some_and(|rest| rest.starts_with('.'))
    });
    (env || ending || ssh || config || json || named).then_some(KEY_FILE)
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

/// Whether someone who was handed the keys at this generation is no longer in the team:
/// `handed` are the accounts the sharer's sealed record names as wrapped for, `members` the
/// team as the service lists it now. The keys are then renewed whatever the service says of
/// it (its own tidying after a member left may have failed, or not happened).
pub fn someone_left(handed: &[String], members: &BTreeSet<String>) -> bool {
    handed.iter().any(|uid| !members.contains(uid))
}

/// `held`: the generation of the keyring in the sealed record. `current`: the generation the
/// service has as current. `renewal_needed`: the service asks for new keys, or someone who
/// was handed these is gone (`someone_left`). `to`: the members who may have the keys
/// (`pins::recipients`). `wrapped`: who has a wrap at the current generation.
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

/// `kept`: the kept keyring's generation, and whether the sealed record says no wrap was
/// ever made with it (`Own::handed` is written before a wrap leaves this computer, so "none"
/// is known, not guessed). A keyring kept with no share for it is used again only then: it
/// is a start under way (on another of the account's computers, or one cut short here) and
/// nobody else ever held it. Any other one is what an earlier share of the project left
/// behind, which people who since left may hold: never used again, however new it is.
pub fn start_plan(kept: Option<(u32, bool)>, exists: bool) -> StartPlan {
    match (kept, exists) {
        (Some(_), true) => StartPlan::Reuse,
        (None, true) => StartPlan::KeysLost,
        (Some((1, true)), false) => StartPlan::Reuse,
        (_, false) => StartPlan::Fresh,
    }
}

/// What a reader's computer remembers of a share's keys, by the share's id: the keyring it
/// last opened (when it was made, and a name only that keyring gives) and the highest
/// generation seen of it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Floor {
    /// When the keyring was made (from inside the wrap): which life of the share.
    pub made_at: u64,
    /// A name derived under the keyring's own naming key: the same for every generation of
    /// one keyring, another for any other keyring.
    pub tag: String,
    pub generation: u64,
}

/// Why keys that opened were still not taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stale {
    /// An older generation of the keyring this computer already saw a newer one of.
    Generation,
    /// Another keyring, made no later than the one this computer saw: an earlier life of
    /// the share (it was stopped and shared again since), handed over once more.
    Life,
}

/// Whether keys just opened (`got`) may be taken, given what this computer remembers of the
/// share (`seen`). The same keyring: never an older generation than was seen. Another
/// keyring: only one made later (the share was stopped and made again; the floor starts
/// over). True when `got` is to be remembered in `seen`'s place.
pub fn check_floor(seen: Option<&Floor>, got: &Floor) -> Result<bool, Stale> {
    let Some(seen) = seen else {
        return Ok(true);
    };
    if seen.tag == got.tag && seen.made_at == got.made_at {
        if got.generation < seen.generation {
            return Err(Stale::Generation);
        }
        return Ok(got.generation > seen.generation);
    }
    if got.made_at > seen.made_at {
        return Ok(true);
    }
    Err(Stale::Life)
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
            // Environment files under other names.
            "prod.env",
            "config/staging.ENV",
            "example.env",
            ".envrc",
            "app/.envrc",
            ".dev.vars",
            "worker/.dev.vars",
            // Sign-ins of tools.
            ".git-credentials",
            "home/.git-credentials",
            ".pgpass",
            ".htpasswd",
            "site/.htpasswd",
            ".yarnrc.yml",
            "auth.json",
            "composer/auth.json",
            ".docker/config.json",
            "home/.docker/config.json",
            "home\\.Docker\\Config.json",
            // Keys and key stores.
            "putty/work.ppk",
            "passwords.kdbx",
            "id_dsa",
            "id_dsa.pub",
            // Cloud and cluster access.
            "prod.tfvars",
            "terraform.tfvars",
            "prod.auto.tfvars.json",
            "terraform.tfstate",
            "infra/terraform.tfstate",
            "terraform.tfstate.backup",
            "terraform.tfstate.d",
            "kubeconfig",
            "ops/kubeconfig",
            "staging.kubeconfig",
            "client_secret.json",
            "client_secret_1234-abc.apps.example.json",
            "service-account.json",
            "service-account-prod.json",
            "keys/Service-Account-Key.JSON",
            // "secret" as "secrets".
            "secret",
            "secret.yaml",
            "secret.yml",
            "k8s/secret.yml",
            "secrets.yml",
        ] {
            assert_eq!(key_file(path), Some(KEY_FILE), "{path}");
        }
        for path in [
            ".env.example",
            ".env.sample",
            ".env.template",
            "app/.env.example",
            // Names that only look like the ones above.
            "envrc",
            ".envrc.md",
            "environment.envy",
            "dev.vars",
            "git-credentials",
            "pgpass.md",
            "htpasswd",
            "yarnrc.yml",
            ".yarnrc",
            "oauth.json",
            "auth.json.md",
            "config.json",
            "docker/config.json",
            ".docker/daemon.json",
            ".docker/sub/config.json",
            "work.ppk.txt",
            "kdbx",
            "my_id_dsa",
            "tfvars",
            "variables.tf",
            "terraform.tfstate-notes",
            "state.tfstate.md",
            "kubeconfig.md",
            "kubeconfigs/readme.md",
            "client_secret.md",
            "client-secret.json",
            "my_client_secret.json",
            "service-account.md",
            "service_account.json",
            "secretary.txt",
            "secret-santa.yaml",
            "top-secret.yaml",
            "secret/readme.md",
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
        assert_eq!(start_plan(None, false), StartPlan::Fresh);
        // The service has the share: its keys are the ones kept, at any generation, handed
        // out or not.
        assert_eq!(start_plan(Some((1, true)), true), StartPlan::Reuse);
        assert_eq!(start_plan(Some((1, false)), true), StartPlan::Reuse);
        assert_eq!(start_plan(Some((4, false)), true), StartPlan::Reuse);
        assert_eq!(start_plan(None, true), StartPlan::KeysLost);
        // No share, and keys nobody was ever handed: a start under way, taken up.
        assert_eq!(start_plan(Some((1, true)), false), StartPlan::Reuse);
        // No share, and keys someone was handed (a share that was stopped a moment ago, a
        // member having left in between): an earlier share's, never used again, however new.
        assert_eq!(start_plan(Some((1, false)), false), StartPlan::Fresh);
        // Renewed keys were a share's too.
        assert_eq!(start_plan(Some((2, true)), false), StartPlan::Fresh);
        assert_eq!(start_plan(Some((2, false)), false), StartPlan::Fresh);
    }

    #[test]
    fn keys_are_renewed_when_someone_who_has_them_is_gone() {
        let members: BTreeSet<String> = uids(&["me", "a", "b"]).into_iter().collect();
        assert!(!someone_left(&uids(&["a", "b"]), &members));
        assert!(!someone_left(&[], &members));
        // "c" was handed the keys at this generation and is no longer in the team.
        assert!(someone_left(&uids(&["a", "c"]), &members));
        // The service says nothing of it (`rotationNeeded` false): renewed all the same.
        let to = uids(&["a", "b"]);
        let wrapped: BTreeSet<String> = to.iter().cloned().collect();
        let left = someone_left(&uids(&["a", "b", "c"]), &members);
        assert_eq!(
            keys_plan(2, 2, left, &to, &wrapped),
            KeysPlan::Renew { generation: 3 }
        );
        // Nobody gone, nothing asked: nothing to do.
        let left = someone_left(&uids(&["a", "b"]), &members);
        assert_eq!(keys_plan(2, 2, left, &to, &wrapped), KeysPlan::Nothing);
    }

    fn floor(made_at: u64, tag: &str, generation: u64) -> Floor {
        Floor {
            made_at,
            tag: tag.into(),
            generation,
        }
    }

    #[test]
    fn keys_older_than_the_ones_seen_are_not_taken() {
        // Nothing remembered: taken, and remembered.
        assert_eq!(check_floor(None, &floor(100, "A", 1)), Ok(true));
        let seen = floor(100, "A", 3);
        // The same keyring: the generation seen (nothing new to remember), or a newer one.
        assert_eq!(check_floor(Some(&seen), &floor(100, "A", 3)), Ok(false));
        assert_eq!(check_floor(Some(&seen), &floor(100, "A", 4)), Ok(true));
        // An older generation's wrap handed over again (from before someone left).
        assert_eq!(
            check_floor(Some(&seen), &floor(100, "A", 2)),
            Err(Stale::Generation)
        );
        assert_eq!(
            check_floor(Some(&seen), &floor(100, "A", 1)),
            Err(Stale::Generation)
        );
        // The share was stopped and made again: another keyring, made later. Taken, and the
        // floor starts over at its generation.
        assert_eq!(check_floor(Some(&seen), &floor(200, "B", 1)), Ok(true));
        // An earlier life's wrap handed over for the share as it is now.
        let now = floor(200, "B", 1);
        assert_eq!(
            check_floor(Some(&now), &floor(100, "A", 3)),
            Err(Stale::Life)
        );
        assert_eq!(
            check_floor(Some(&now), &floor(100, "A", 9)),
            Err(Stale::Life)
        );
        // Another keyring that says it was made at the same moment is no newer life.
        assert_eq!(
            check_floor(Some(&now), &floor(200, "C", 5)),
            Err(Stale::Life)
        );
    }
}
