//! Reading a share: opening its keys, its snapshots and their files, and making a copy of one.
//! A reader's computer writes nothing to a share.

use std::path::{Path, PathBuf};

use super::keys::{open_wrap, split_share_id, valid_key, valid_record_id};
use super::pins::{Member, MemberState};
use super::plan;
use super::{
    failed, gone, read_info, snapshot_records, Info, Opened, OpenedCopy, Read, SharedFile,
    SharedFiles, SharedSnapshot, Shares, SNAP, STEP,
};
use crate::error::{Error, Result};
use crate::sync::snapshot::{self, FileText, Manifest, Summary};

impl Shares {
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
        let ring = open_wrap(&key, &pinned, id, generation, text).map_err(|_| wrong_keys())?;
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
        let manifest = snapshot::manifest(&opened.api, &opened.ring, &summary).await?;
        Ok((opened, summary, manifest))
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
    /// project's remote when the share names an ordinary one, then the snapshot restored on
    /// top (the vault's own restore, with its rules for paths). Nothing here marks the folder
    /// as trusted or runs anything from it; a reader's computer writes nothing to the share.
    /// The caller holds the one-snapshot-at-a-time guard.
    pub async fn open_copy(&self, id: &str, snap: &str, target: &Path) -> Result<OpenedCopy> {
        let (opened, summary, manifest) = self.manifest(id, snap).await?;
        empty_folder(target)?;
        let mut cloned = false;
        let mut note = None;
        if manifest.git.is_some() {
            let said = match read_info(&opened.api, &opened.ring).await {
                Ok(Read::Text { text, .. }) => serde_json::from_str::<Info>(&text)
                    .ok()
                    .and_then(|i| i.remote),
                _ => None,
            };
            let remote = said
                .or_else(|| manifest.git.as_ref().and_then(|g| g.remote.clone()))
                // As the sharer's computer would have written it, or not used at all.
                .filter(|url| plan::public_remote(url).as_deref() == Some(url.as_str()));
            if let Some(url) = remote {
                let parent = target.parent().unwrap_or(target).to_path_buf();
                let folder = target.to_string_lossy().to_string();
                let outcome = tokio::task::spawn_blocking(move || {
                    crate::git::run(
                        &parent,
                        &[
                            "clone",
                            "-q",
                            "--no-recurse-submodules",
                            "--",
                            &url,
                            &folder,
                        ],
                        None,
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
                            "The project's repository couldn't be cloned (no access to it from this computer?). The copy holds what the snapshot carries."
                                .to_string(),
                        );
                    }
                }
            }
        }
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
