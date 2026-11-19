//! Reading a share: opening its keys, its snapshots and their files, and making a copy of one.
//! A reader's computer writes nothing to a share.

use std::path::{Path, PathBuf};

use super::keys::{open_wrap, split_share_id, valid_key, valid_record_id};
use super::pins::{Member, MemberState};
use super::plan::{self, Floor};
use super::{
    failed, gone, read_info, snapshot_records, CopyPlan, Info, Opened, OpenedCopy, Read,
    SharedFile, SharedFiles, SharedSnapshot, Shares, SNAP, STEP,
};
use crate::error::{Error, Result};
use crate::sync::project;
use crate::sync::snapshot::{self, FileText, Manifest, Summary};

/// A clone for a copy is stopped after this long (a server that never answers, a repository
/// without end): the copy is then made of what the snapshot carries.
const CLONE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// A teammate who asked this account to share a project (D455).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ask {
    pub uid: String,
    pub name: String,
    /// When, in ms.
    pub at: u64,
}

/// A teammate's share as the list shows it now: what `news` goes by.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shown {
    pub id: String,
    #[serde(default)]
    pub chats: bool,
}

/// Something new among the teammates' shares, for this computer.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct News {
    pub id: String,
    /// "project": a share this computer hasn't seen; "chats": its chats are shared now.
    pub kind: &'static str,
}

/// What this computer has seen of the teammates' shares (id to whether its chats were
/// shared), and the asks it has said (`<who asked>@<when>`).
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct SeenShares {
    base: String,
    uid: String,
    seen: std::collections::BTreeMap<String, bool>,
    #[serde(default)]
    asks: std::collections::BTreeSet<String>,
}

/// The asks in `shown` (who asked, when) this computer hasn't said yet, and what it keeps
/// from now on: only asks that still stand. An ask is said once a computer, also the first
/// time this computer looks (it is addressed to the person, not something that was there
/// all along); asked again after it lapsed or was dismissed, it is a new one.
fn new_asks(
    said: &std::collections::BTreeSet<String>,
    shown: &[(String, u64)],
) -> (Vec<String>, std::collections::BTreeSet<String>) {
    let mut fresh = Vec::new();
    let mut next = std::collections::BTreeSet::new();
    for (uid, at) in shown.iter().take(500) {
        if !super::keys::valid_uid(uid) {
            continue;
        }
        let key = format!("{uid}@{at}");
        if !said.contains(&key) && !fresh.contains(uid) {
            fresh.push(uid.clone());
        }
        next.insert(key);
    }
    (fresh, next)
}

/// What is new in `shown` against `seen` (None: nothing was ever kept here, so nothing is
/// news), and what is kept from now on: only what is shown (a share that went is forgotten,
/// and is news again if it comes back).
fn news_of(
    seen: Option<&std::collections::BTreeMap<String, bool>>,
    shown: &[Shown],
    max: usize,
) -> (Vec<News>, std::collections::BTreeMap<String, bool>) {
    let mut news = Vec::new();
    let mut next = std::collections::BTreeMap::new();
    for share in shown.iter().take(max) {
        if split_share_id(&share.id).is_none() {
            continue;
        }
        if let Some(seen) = seen {
            match seen.get(&share.id) {
                None => news.push(News {
                    id: share.id.clone(),
                    kind: "project",
                }),
                Some(false) if share.chats => news.push(News {
                    id: share.id.clone(),
                    kind: "chats",
                }),
                _ => {}
            }
        }
        next.insert(share.id.clone(), share.chats);
    }
    (news, next)
}

impl Shares {
    /// What is new among the teammates' shares shown now, for this computer; remembered, so
    /// each is said once (`news_of`).
    pub fn news(
        &self,
        shown: Vec<Shown>,
        asks: Vec<(String, u64)>,
    ) -> Result<(Vec<News>, Vec<String>)> {
        let file = self.vault.sync_file("share-seen.json");
        let kept = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<SeenShares>(&bytes).ok())
            .filter(|kept| kept.base == self.base && kept.uid == self.uid);
        let (news, seen) = news_of(kept.as_ref().map(|k| &k.seen), &shown, super::MAX_SHARES);
        let none = std::collections::BTreeSet::new();
        let (fresh, said) = new_asks(kept.as_ref().map_or(&none, |k| &k.asks), &asks);
        if kept.as_ref().map(|k| (&k.seen, &k.asks)) != Some((&seen, &said)) {
            if let Some(dir) = file.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let kept = SeenShares {
                base: self.base.clone(),
                uid: self.uid.clone(),
                seen,
                asks: said,
            };
            crate::store::atomic_write(&file, &serde_json::to_vec(&kept)?)?;
        }
        Ok((news, fresh))
    }

    /// Asks a teammate to share a project with this account: a note their app shows. It
    /// names no project (this account can't see what a teammate has) and carries no text.
    pub async fn ask(&self, uid: &str) -> Result<()> {
        if !super::keys::valid_uid(uid) || uid == self.uid {
            return Err(Error::Invalid("ask a teammate".into()));
        }
        let reply = self
            .team
            .post(&format!("shares/{uid}/ask"), &serde_json::json!({}))
            .await?;
        // A service from before asks answers as for a share that isn't there.
        if reply.status == 404 {
            return Err(failed(
                "ShareNeedsService",
                "Asking a teammate isn't available from this account's sync service yet.",
            ));
        }
        reply.into_ok()?;
        Ok(())
    }

    /// Who asked this account to share a project, newest first; names are cleaned, ids
    /// checked, and only current members of the team are listed.
    pub async fn asks(&self) -> Result<Vec<Ask>> {
        let members = self.team_members().await?;
        let reply = self.team.get("shares").await?;
        Ok(reply["asks"]
            .as_array()
            .into_iter()
            .flatten()
            .take(200)
            .filter_map(|ask| {
                let uid = ask["from"].as_str()?;
                // Whose name it is comes from the team's own list, not from the note.
                let member = members.iter().find(|m| m.uid == uid && uid != self.uid)?;
                Some(Ask {
                    uid: uid.to_string(),
                    name: member.name.clone(),
                    at: ask["at"].as_u64().unwrap_or(0),
                })
            })
            .collect())
    }

    /// Forgets a teammate's ask of this account.
    pub async fn clear_ask(&self, uid: &str) -> Result<()> {
        if !super::keys::valid_uid(uid) {
            return Err(Error::Invalid("that isn't a teammate".into()));
        }
        match self.team.delete(&format!("shares/{uid}/ask")).await {
            Ok(_) | Err(Error::Sync("ShareGone", _)) => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Opens a share: its client, and its keyring. For the sharer the keyring is the one in
    /// its own vault. For anyone else it is the wrap the service holds for this account,
    /// opened only as coming from the sharer's key as this account pinned it, and only when
    /// it names this share and the generation it was handed over as. `fresh`: not from this
    /// session's memory.
    pub async fn open(&self, id: &str, fresh: bool) -> Result<Opened> {
        let (owner, project) =
            split_share_id(id).ok_or_else(|| Error::Invalid("that isn't a share".into()))?;
        let api = self.share_api(id)?;
        if owner == self.uid {
            let _step = STEP.lock().await;
            let (_, ring) = self.own(project).await?.own.ok_or_else(|| {
                failed(
                    "ShareKeys",
                    "This share's keys aren't in this account any more. Stop sharing the project, then share it again.",
                )
            })?;
            return Ok(Opened {
                api,
                ring,
                cached: false,
            });
        }
        if let Some(ring) = (!fresh).then(|| self.held(id)).flatten() {
            return Ok(Opened {
                api,
                ring,
                cached: true,
            });
        }
        let _step = STEP.lock().await;
        let answer = api.get("keys").await.map_err(gone)?;
        // The share is its sharer's by its id: an answer naming another owner is refused.
        if answer["owner"]["uid"].as_str() != Some(owner) {
            return Err(wrong_keys());
        }
        let shown = answer["owner"]["memberKey"]
            .as_str()
            .filter(|k| valid_key(k))
            .map(str::to_string);
        let sharer = [Member {
            uid: owner.to_string(),
            name: String::new(),
            key: shown.clone(),
        }];
        let pins = self.observe(&sharer).await?;
        let pinned = match (pins.state(owner, shown.as_deref()), pins.members.get(owner)) {
            (MemberState::New | MemberState::Verified, Some(pin)) => pin.key.clone(),
            (MemberState::Changed, _) => {
                return Err(failed(
                    "ShareKeyChanged",
                    "The key of the member who shares this changed. Nothing of theirs is read until you accept the new key.",
                ));
            }
            _ => return Err(waiting()),
        };
        let wrap = &answer["wrap"];
        let (Some(text), Some(generation)) = (wrap["wrap"].as_str(), wrap["keyVersion"].as_u64())
        else {
            // No keys for this account yet. Its own key may never have been published.
            self.ensure_member_key(None).await?;
            return Err(waiting());
        };
        let Some(key) = self.member_key(false).await? else {
            self.ensure_member_key(None).await?;
            return Err(waiting());
        };
        let opened = open_wrap(&key, &pinned, id, generation, text).map_err(|_| wrong_keys())?;
        // The generation is whatever the service attached, so it has a floor here: never an
        // older generation than this computer saw of these keys, and never an earlier life
        // of the share (one stopped and made again under the same id) handed over again.
        self.check_floor(
            id,
            Floor {
                made_at: opened.made_at,
                tag: opened.ring.name_of("share-keyring")?,
                generation,
            },
        )?;
        let ring = opened.ring;
        self.hold(id, &ring, generation);
        Ok(Opened {
            api,
            ring,
            cached: false,
        })
    }

    /// A share's snapshots, newest first.
    pub async fn snapshots(&self, id: &str) -> Result<Vec<SharedSnapshot>> {
        let mut opened = self.open(id, false).await?;
        let (mut records, hidden) = snapshot_records(&opened.api, &opened.ring)
            .await
            .map_err(gone)?;
        // Some didn't open with the keys held from earlier: the share's keys moved on.
        if hidden > 0 && opened.cached {
            opened = self.open(id, true).await?;
            records = snapshot_records(&opened.api, &opened.ring)
                .await
                .map_err(gone)?
                .0;
        }
        let mut list: Vec<SharedSnapshot> = records
            .into_iter()
            .filter_map(|(id, record)| {
                let summary = serde_json::from_str::<Summary>(&record.text?).ok()?;
                Some(SharedSnapshot { id, summary })
            })
            .collect();
        list.sort_by(|a, b| b.id.cmp(&a.id));
        Ok(list)
    }

    /// A snapshot's record and its list of files.
    async fn manifest(&self, id: &str, snap: &str) -> Result<(Opened, Summary, Manifest)> {
        if !valid_record_id(snap) {
            return Err(Error::Invalid("that isn't a snapshot".into()));
        }
        let mut opened = self.open(id, false).await?;
        let mut summary = snapshot::summary(&opened.api, &opened.ring, SNAP, snap).await;
        if summary.is_err() && opened.cached {
            opened = self.open(id, true).await?;
            summary = snapshot::summary(&opened.api, &opened.ring, SNAP, snap).await;
        }
        let summary = summary.map_err(gone)?;
        // Read within what a snapshot holds (`snapshot::manifest`): the list is a
        // teammate's, and nothing in it is taken as given.
        let manifest = snapshot::manifest(&opened.api, &opened.ring, &summary).await?;
        Ok((opened, summary, manifest))
    }

    /// The address a copy of this share would be cloned from: what the share says of the
    /// project, else what the snapshot says, and only as the sharer's computer would have
    /// written it (an ordinary address, with no sign-in in it). None: nothing to clone from.
    async fn copy_remote(&self, opened: &Opened, manifest: &Manifest) -> Option<String> {
        manifest.git.as_ref()?;
        let said = match read_info(&opened.api, &opened.ring).await {
            Ok(Read::Text { text, .. }) => serde_json::from_str::<Info>(&text)
                .ok()
                .and_then(|i| i.remote),
            _ => None,
        };
        said.or_else(|| manifest.git.as_ref().and_then(|g| g.remote.clone()))
            .filter(|url| plan::public_remote(url).as_deref() == Some(url.as_str()))
    }

    /// What a copy of a share's snapshot would do first: the address it would clone from,
    /// for the person to see and agree to before anything reaches out to it. Nothing is
    /// written and nothing is asked of that address.
    pub async fn copy_plan(&self, id: &str, snap: &str) -> Result<CopyPlan> {
        let (opened, _, manifest) = self.manifest(id, snap).await?;
        snapshot::within_bytes(&manifest, snapshot::MAX_COPY_BYTES)?;
        Ok(CopyPlan {
            remote: self.copy_remote(&opened, &manifest).await,
        })
    }

    /// Whether the folder `root` is a clone of the repository a share is of: the share's
    /// remote and the folder's are the same address once both are normalised (as a project's
    /// identity is). False when either has none. A reader's own sync id for the project
    /// differs from the sharer's (each is made under the account's own keys), so this is how
    /// a reader's open folder is known to be the shared project.
    pub async fn matches_folder(&self, id: &str, root: &Path) -> Result<bool> {
        let opened = self.open(id, false).await?;
        let said = match read_info(&opened.api, &opened.ring).await.map_err(gone)? {
            Read::Text { text, .. } => serde_json::from_str::<Info>(&text)
                .ok()
                .and_then(|i| i.remote),
            _ => None,
        };
        let root = root.to_path_buf();
        let here = tokio::task::spawn_blocking(move || project::folder_remote(&root))
            .await
            .map_err(|e| failed("Sync", &e.to_string()))?;
        Ok(project::same_remote(said.as_deref(), here.as_deref()))
    }

    /// The files a snapshot of a share holds; with `root` (the reader's own copy of the
    /// project), each with how it stands against that folder. Nothing is written.
    pub async fn files(&self, id: &str, snap: &str, root: Option<PathBuf>) -> Result<SharedFiles> {
        let (opened, _, manifest) = self.manifest(id, snap).await?;
        let skipped: Vec<(String, String)> = manifest.skipped.iter().take(5_000).cloned().collect();
        let Some(root) = root else {
            return Ok(SharedFiles {
                files: snapshot::list(&manifest)
                    .into_iter()
                    .map(|f| SharedFile {
                        path: f.path,
                        size: f.size,
                        deleted: f.deleted,
                        state: None,
                    })
                    .collect(),
                truncated: 0,
                skipped,
            });
        };
        let ring = opened.ring;
        // Reading the folder's files takes a while in a large one: off the async threads.
        let compared = tokio::task::spawn_blocking(move || {
            snapshot::compare(&ring, &root, &manifest, snapshot::COMPARE_MAX)
        })
        .await
        .map_err(|e| failed("Sync", &e.to_string()))?;
        Ok(SharedFiles {
            files: compared
                .files
                .into_iter()
                .map(|f| SharedFile {
                    path: f.path,
                    size: f.size,
                    deleted: f.deleted,
                    state: Some(f.state),
                })
                .collect(),
            truncated: compared.truncated,
            skipped,
        })
    }

    /// One file of a share's snapshot as text, written nowhere.
    pub async fn file_text(&self, id: &str, snap: &str, path: &str) -> Result<Option<FileText>> {
        let (opened, _, manifest) = self.manifest(id, snap).await?;
        snapshot::read_text(&opened.api, &opened.ring, &manifest, path).await
    }

    /// A copy of a share's snapshot in `target`, which must be new or empty: cloned from the
    /// project's remote first when the person agreed to that (`clone_from`: the address they
    /// were shown, `copy_plan`), then the snapshot restored on top (the vault's own restore,
    /// with its rules for paths). Nothing here marks the folder as trusted or runs anything
    /// from it; a reader's computer writes nothing to the share.
    ///
    /// The address is one the sharer chose. It is cloned from only when it is still the one
    /// that was shown, with no prompt of any kind and for a bounded time
    /// (`git::run_unattended`), and without `one` (the one-snapshot-at-a-time guard) held:
    /// a server that never answers doesn't hold up this computer's own snapshots. The
    /// restore then asks nothing of that address either. `one` is taken for the restore.
    pub async fn open_copy(
        &self,
        id: &str,
        snap: &str,
        target: &Path,
        clone_from: Option<&str>,
        one: &tokio::sync::Mutex<()>,
    ) -> Result<OpenedCopy> {
        let (opened, summary, manifest) = self.manifest(id, snap).await?;
        // Refused before anything is written: more than a copy may bring.
        snapshot::within_bytes(&manifest, snapshot::MAX_COPY_BYTES)?;
        let remote = self.copy_remote(&opened, &manifest).await;
        if let Some(shown) = clone_from {
            if remote.as_deref() != Some(shown) {
                return Err(failed(
                    "ShareRemoteChanged",
                    "The address this project would be cloned from isn't the one that was shown any more. Open the copy again.",
                ));
            }
        }
        empty_folder(target)?;
        let mut cloned = false;
        let mut note = None;
        if let Some(url) = clone_from {
            let url = url.to_string();
            let parent = target.parent().unwrap_or(target).to_path_buf();
            let folder = target.to_string_lossy().to_string();
            let outcome = tokio::task::spawn_blocking(move || {
                crate::git::run_unattended(
                    &parent,
                    &[
                        "clone",
                        "-q",
                        "--no-recurse-submodules",
                        "--",
                        &url,
                        &folder,
                    ],
                    CLONE_DEADLINE,
                )
            })
            .await
            .map_err(|e| failed("Sync", &e.to_string()))?;
            match outcome {
                Ok(_) => cloned = true,
                Err(_) => {
                    // Whatever the clone left goes: the restore starts an empty repository
                    // and takes what the snapshot itself carries.
                    std::fs::remove_dir_all(target)?;
                    std::fs::create_dir_all(target)?;
                    note = Some(
                        "The project's repository couldn't be cloned (no access to it from this computer without signing in, or it took too long). The copy holds what the snapshot carries."
                            .to_string(),
                    );
                }
            }
        }
        let _one = one.lock().await;
        let restored = snapshot::restore(
            &opened.api,
            &opened.ring,
            &self.data,
            target,
            &manifest,
            snapshot::RestoreOptions {
                stash: false,
                as_restored: false,
                from: &summary.device_name,
                // Nothing more is asked of an address the sharer chose: what the clone
                // brought and what the snapshot carries is what the copy is made of.
                network: false,
            },
        )
        .await
        .map_err(gone)?;
        Ok(OpenedCopy {
            path: target.to_string_lossy().to_string(),
            cloned,
            note,
            restored,
        })
    }
}

fn waiting() -> Error {
    failed(
        "ShareWaiting",
        "This share's keys haven't reached this account yet. They come the next time the member who shares it has the app open.",
    )
}

fn wrong_keys() -> Error {
    failed(
        "ShareKeys",
        "This share's keys didn't come from the member who shares it, as this account knows that member's key. They were not taken.",
    )
}

/// `target` as the place for a copy: a folder that isn't there yet (made here), or an empty
/// one. Never a file, a link, or a folder with anything in it.
fn empty_folder(target: &Path) -> Result<()> {
    let refused = || {
        failed(
            "ShareTargetNotEmpty",
            "Choose a new or an empty folder for the copy.",
        )
    };
    if !target.is_absolute() || crate::remote::of_dir(target).is_some() {
        return Err(refused());
    }
    match std::fs::symlink_metadata(target) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(target)?;
            Ok(())
        }
        Err(e) => Err(e.into()),
        Ok(meta) if meta.is_dir() => {
            if std::fs::read_dir(target)?.next().is_some() {
                return Err(refused());
            }
            Ok(())
        }
        Ok(_) => Err(refused()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clone_for_a_copy_asks_nobody_and_gives_up_in_time() {
        let base = std::env::temp_dir().join(format!("share-clone-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        // No way to ask for a sign-in reaches the command: not the IDE's prompts, not the
        // user's askpass program, not a terminal, not a credential manager's window.
        let mut cmd = crate::git::command(&base);
        crate::git::askpass::deny_env(&mut cmd);
        let env = |name: &str| {
            cmd.get_envs()
                .find(|(key, _)| key.to_str() == Some(name))
                .map(|(_, value)| value.map(|v| v.to_string_lossy().to_string()))
        };
        assert_eq!(env("GIT_ASKPASS"), Some(None), "taken away");
        assert_eq!(env("SSH_ASKPASS"), Some(None), "taken away");
        assert_eq!(env("GIT_TERMINAL_PROMPT"), Some(Some("0".into())));
        assert_eq!(env("SSH_ASKPASS_REQUIRE"), Some(Some("never".into())));
        assert_eq!(env("GCM_INTERACTIVE"), Some(Some("never".into())));

        // A command that doesn't end is stopped when its time is up.
        let started = std::time::Instant::now();
        let hung = crate::git::run_unattended(
            &base,
            &["-c", "alias.wait=!sleep 20", "wait"],
            std::time::Duration::from_millis(1500),
        );
        assert!(
            matches!(&hung, Err(Error::Git(text)) if text.contains("took too long")),
            "{hung:?}"
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(15));

        // An address that is a path on this computer is never cloned from, whatever let it
        // through: the same clone works when it is the person's own command.
        let source = base.join("source");
        std::fs::create_dir_all(&source).unwrap();
        let git = |args: &[&str]| crate::git::run(&source, args, None).unwrap();
        git(&["init", "-q"]);
        git(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "first",
        ]);
        let path = source.to_string_lossy().replace('\\', "/");
        let url = format!(
            "file://{}{path}",
            if path.starts_with('/') { "" } else { "/" }
        );
        let minute = std::time::Duration::from_secs(60);
        let refused = crate::git::run_unattended(
            &base,
            &[
                "clone",
                "-q",
                "--no-recurse-submodules",
                "--",
                &url,
                "refused",
            ],
            minute,
        );
        assert!(refused.is_err(), "{refused:?}");
        assert!(!base.join("refused").join(".git").exists());
        crate::git::run(&base, &["clone", "-q", "--", &url, "allowed"], None).unwrap();
        assert!(base.join("allowed").join(".git").exists());
        // It still runs what needs no asking.
        let version = crate::git::run_unattended(&base, &["--version"], minute).unwrap();
        assert!(version.contains("git version"), "{version}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_ask_is_said_once_a_computer_and_again_only_when_it_is_a_new_one() {
        let none = std::collections::BTreeSet::new();
        let shown = vec![("ana".to_string(), 10u64), ("../x".to_string(), 1)];
        // Said the first time this computer looks, and remembered.
        let (fresh, said) = new_asks(&none, &shown);
        assert_eq!(fresh, ["ana"]);
        assert_eq!(said.len(), 1, "what isn't an account's id isn't kept");
        // The same ask after a restart: nothing.
        assert!(new_asks(&said, &shown).0.is_empty());
        // Asked again later (it lapsed, or was dismissed): a new one. One gone is forgotten.
        let (fresh, said) = new_asks(&said, &[("ana".to_string(), 99)]);
        assert_eq!(fresh, ["ana"]);
        let (fresh, said) = new_asks(&said, &[]);
        assert!(fresh.is_empty() && said.is_empty());
    }

    #[test]
    fn a_share_is_news_once_and_its_chats_once_more() {
        let shown = |list: &[(&str, bool)]| -> Vec<Shown> {
            list.iter()
                .map(|(id, chats)| Shown {
                    id: (*id).to_string(),
                    chats: *chats,
                })
                .collect()
        };
        let kinds = |news: &[News]| -> Vec<(String, &'static str)> {
            news.iter().map(|n| (n.id.clone(), n.kind)).collect()
        };
        // The first look says nothing, and remembers what it saw.
        let (news, seen) = news_of(None, &shown(&[("ana.p1", false), ("../x", true)]), 10);
        assert!(news.is_empty());
        assert_eq!(seen.len(), 1, "what isn't a share's id isn't kept");
        // A new share is news; the one seen isn't.
        let (news, seen) = news_of(
            Some(&seen),
            &shown(&[("ana.p1", false), ("ben.p2", true)]),
            10,
        );
        assert_eq!(kinds(&news), [("ben.p2".to_string(), "project")]);
        // Its chats shared later: news once.
        let (news, seen) = news_of(
            Some(&seen),
            &shown(&[("ana.p1", true), ("ben.p2", true)]),
            10,
        );
        assert_eq!(kinds(&news), [("ana.p1".to_string(), "chats")]);
        let (news, seen) = news_of(Some(&seen), &shown(&[("ana.p1", true)]), 10);
        assert!(news.is_empty());
        // One that went and came back is news again.
        let (news, _) = news_of(
            Some(&seen),
            &shown(&[("ana.p1", true), ("ben.p2", false)]),
            10,
        );
        assert_eq!(kinds(&news), [("ben.p2".to_string(), "project")]);
    }

    #[test]
    fn a_copy_goes_into_a_new_or_empty_folder_only() {
        let base = std::env::temp_dir().join(format!("share-copy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        // Not there yet: made.
        let new = base.join("new").join("copy");
        empty_folder(&new).unwrap();
        assert!(new.is_dir());
        // Empty: taken as it is.
        empty_folder(&new).unwrap();
        // With anything in it, or a file: refused.
        std::fs::write(new.join("x"), "x").unwrap();
        for bad in [new.clone(), new.join("x"), PathBuf::from("relative/copy")] {
            assert!(
                matches!(
                    empty_folder(&bad),
                    Err(Error::Sync("ShareTargetNotEmpty", _))
                ),
                "{}",
                bad.display()
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }
}
