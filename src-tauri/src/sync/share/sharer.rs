//! The sharer's side of a share: starting one, seeing to its keys, writing snapshots into it,
//! changing and stopping it. Only the sharer's computers write to a share.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::time::Duration;

use serde_json::json;

use super::keys::{make_wrap, share_id, split_share_id, valid_project};
use super::pins::recipients;
use super::plan::{self, keys_plan, someone_left, start_plan, KeysPlan, StartPlan, KEY_FILE};
use super::{
    clean, failed, gone, members_of, now_ms, read, read_info, share_gone, snapshot_records, write,
    Folder, Info, Last, Maintained, Own, OwnRead, Read, ShareInfo, Shares, Synced, INFO,
    KEEP_SNAPSHOTS, LAST_VERSION, OWN, OWN_VERSION, SNAP, STEP,
};
use crate::error::{Error, Result};
use crate::store::atomic_write;
use crate::sync::api::{unreadable, Api};
use crate::sync::crypto::{self, Keyring};
use crate::sync::snapshot::{self, Manifest};

impl Shares {
    /// The keyring of this account's share of `project`, from its own vault.
    pub(super) async fn own(&self, project: &str) -> Result<OwnRead> {
        match read(&self.vault.api, &self.ring, OWN, project).await? {
            Read::Absent { version } | Read::Damaged { version } => {
                Ok(OwnRead { own: None, version })
            }
            Read::Text { text, version } => {
                let own = serde_json::from_str::<Own>(&text).ok().and_then(|own| {
                    let bytes = crypto::unb64(&own.ring).ok()?;
                    let ring = Keyring::from_bytes(&bytes).ok()?;
                    (own.share == share_id(&self.uid, project)).then_some((own, ring))
                });
                Ok(OwnRead {
                    own,
                    version: Some(version),
                })
            }
        }
    }

    async fn save_own(&self, project: &str, own: &Own, expect: Option<u64>) -> Result<bool> {
        write(
            &self.vault.api,
            &self.ring,
            (OWN, project),
            expect,
            Some(&serde_json::to_string(own)?),
        )
        .await
    }

    /// Starts sharing `project` (or, when it is shared already, sets its name and whether its
    /// chats are shared), then sees to its keys.
    async fn start(
        &self,
        project: &str,
        name: &str,
        chats: bool,
        only_verified: bool,
    ) -> Result<Maintained> {
        let name = clean(name, 120);
        if !valid_project(project) || name.is_empty() {
            return Err(Error::Invalid("a share needs a project and a name".into()));
        }
        let id = share_id(&self.uid, project);
        let members = self.team_members().await?;
        let (key, published) = self.ensure_member_key(self.shown_for_me(&members)).await?;
        if !published {
            return Err(failed(
                "SyncLapsed",
                "The Sync subscription ended: nothing new can be shared.",
            ));
        }
        let pins = self.observe(&members).await?;
        let exists = self
            .listed(&pins, &members)
            .await?
            .iter()
            .any(|s| s.id == id);
        // Who the first keys would go to, with the share itself.
        let (to, _) = recipients(&pins, &members, &self.uid, only_verified);
        let intended: Vec<String> = to.iter().map(|(uid, _)| uid.clone()).collect();
        let mut ring = None;
        for _ in 0..4 {
            let now = now_ms();
            let read = self.own(project).await?;
            let kept = read
                .own
                .as_ref()
                .map(|(own, ring)| (ring.current(), own.never_handed()));
            match (start_plan(kept, exists), read.own) {
                (StartPlan::KeysLost, _) => {
                    return Err(failed(
                        "ShareKeys",
                        "This project is shared, but its keys aren't in this account any more. Stop sharing it, then share it again.",
                    ));
                }
                (StartPlan::Reuse, Some((mut own, held))) => {
                    let mut changed = own.name != name || own.chats != chats;
                    own.name = name.clone();
                    own.chats = chats;
                    // A start taken up again (no share yet, keys nobody holds): who the keys
                    // are about to be handed to is written down before any wrap is made.
                    if !exists {
                        changed |= note_handed(&mut own, &intended);
                    }
                    if changed && !self.save_own(project, &own, read.version).await? {
                        continue;
                    }
                    ring = Some((held, own.created_at));
                    break;
                }
                (_, earlier) => {
                    let fresh = Keyring::generate()?;
                    // Made later than any keyring this share had before, whatever the clock
                    // says: a reader tells a share made again by that (`plan::check_floor`).
                    let created_at =
                        earlier.map_or(now, |(own, _)| now.max(own.created_at.saturating_add(1)));
                    let own = Own {
                        v: OWN_VERSION,
                        share: id.clone(),
                        ring: crypto::b64(&fresh.to_bytes()?),
                        created_at,
                        name: name.clone(),
                        chats,
                        // Written with the keyring, before any wrap of it is made.
                        handed: intended.clone(),
                    };
                    // Kept before the service hears of the share: its keys are never only there.
                    if self.save_own(project, &own, read.version).await? {
                        ring = Some((fresh, created_at));
                        break;
                    }
                }
            }
        }
        let (ring, made_at) =
            ring.ok_or_else(|| failed("Sync", "The share's keys kept changing; try again."))?;
        // The first keys go with the share. (On a share that exists the service looks at none:
        // `maintain` hands them over.)
        let mut wraps = serde_json::Map::new();
        if !exists && ring.current() == 1 {
            for (uid, pinned) in to {
                wraps.insert(uid, json!(make_wrap(&key, &pinned, &id, &ring, made_at)?));
            }
        }
        let mut body = json!({ "name": name, "chats": chats, "wraps": wraps });
        let mut reply = self.team.put(&format!("shares/{project}"), &body).await?;
        if reply.status == 409 && reply.error() == "no_member_key" {
            // A member's key went away in between: the share starts, and they wait.
            body["wraps"] = json!({});
            reply = self.team.put(&format!("shares/{project}"), &body).await?;
        }
        reply.into_ok()?;
        // (Empty when the retry above sent none.)
        let sent = body["wraps"].as_object().map_or(0, serde_json::Map::len);
        let mut kept = self.maintain(project, only_verified).await?;
        // The members who got the keys with the share itself count as handed over just now.
        kept.wraps_added += sent;
        Ok(kept)
    }

    /// Sees to a share's keys: members without them get them, and when someone left (or a key
    /// was replaced) the keys are renewed. Safe to run again at any point: the keyring is
    /// saved in the account's vault before the service hears of a new generation, and what
    /// the service has decides what is still to do (`plan::keys_plan`).
    async fn maintain(&self, project: &str, only_verified: bool) -> Result<Maintained> {
        let id = share_id(&self.uid, project);
        let api = self.share_api(&id)?;
        let key = self.own_key().await?;
        let mut added = 0;
        let mut renewed = false;
        for attempt in 0..6 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
            let read = self.own(project).await?;
            let Some((own, ring)) = read.own else {
                return Err(failed(
                    "ShareNotShared",
                    "This project isn't shared from this account.",
                ));
            };
            let answer = api.get("keys").await.map_err(gone)?;
            if answer["owner"]["uid"].as_str() != Some(self.uid.as_str())
                || !answer["members"].is_array()
            {
                return Err(failed(
                    "ShareNotSharer",
                    "Only the member who shared it can do that.",
                ));
            }
            let current = answer["keyVersion"].as_u64().ok_or_else(unreadable)?;
            let members = members_of(&answer["members"]);
            // The service must have this account's key as it is: wraps are boxed from it.
            if self.shown_for_me(&members) != Some(key.public().as_str()) {
                self.publish(&key).await?;
                continue;
            }
            let pins = self.observe(&members).await?;
            let (to, waiting) = recipients(&pins, &members, &self.uid, only_verified);
            let wrapped: BTreeSet<String> = answer["members"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|m| m["hasWrap"].as_bool() == Some(true))
                .filter_map(|m| m["uid"].as_str().map(str::to_string))
                .collect();
            let uids: Vec<String> = to.iter().map(|(uid, _)| uid.clone()).collect();
            let name = own.name.clone();
            let made_at = own.created_at;
            let done = |ring: Keyring, added, renewed, waiting| Maintained {
                ring,
                name: name.clone(),
                wraps_added: added,
                renewed,
                waiting,
            };
            // Someone who was handed these keys is gone from the team: new keys, whether or
            // not the service asks for them (its own tidying may not have happened).
            let listed: BTreeSet<String> = members.iter().map(|m| m.uid.clone()).collect();
            let left = someone_left(&own.handed, &listed);
            let plan = keys_plan(
                u64::from(ring.current()),
                current,
                answer["rotationNeeded"].as_bool() == Some(true) || left,
                &uids,
                &wrapped,
            );
            // (The last: the record already names the receivers, written with new keys.)
            let (ring, generation, receivers, noted) = match plan {
                KeysPlan::Nothing => return Ok(done(ring, added, renewed, waiting)),
                KeysPlan::ReadAgain => continue,
                KeysPlan::Mismatch => {
                    return Err(failed(
                        "ShareKeys",
                        "This share's keys here aren't the ones the service has. Stop sharing the project, then share it again.",
                    ));
                }
                KeysPlan::Add {
                    generation,
                    to: missing,
                } => (ring, generation, missing, false),
                KeysPlan::Store { generation } => (ring, generation, uids, false),
                KeysPlan::Renew { generation } => {
                    let next = ring.rotated()?;
                    let renewed = Own {
                        // (From here on the record says who holds the keys it has.)
                        v: OWN_VERSION,
                        ring: crypto::b64(&next.to_bytes()?),
                        // Who the new generation is for: written with it, before any wrap.
                        handed: uids.clone(),
                        ..own.clone()
                    };
                    // Saved first. If another of the account's computers saved one meanwhile,
                    // that one is read and stored instead: never two keyrings for one share.
                    if !self.save_own(project, &renewed, read.version).await? {
                        continue;
                    }
                    (next, generation, uids, true)
                }
            };
            let renewing = generation > current;
            // Who is about to be handed the keys is written down before a wrap is made (a
            // renewal wrote it with the new keys): the record then always names everyone who
            // may hold them.
            if !noted {
                let mut next = own.clone();
                if note_handed(&mut next, &receivers)
                    && !self.save_own(project, &next, read.version).await?
                {
                    continue;
                }
            }
            let mut wraps = serde_json::Map::new();
            for (uid, pinned) in to.iter().filter(|(uid, _)| receivers.contains(uid)) {
                wraps.insert(
                    uid.clone(),
                    json!(make_wrap(&key, pinned, &id, &ring, made_at)?),
                );
            }
            let count = wraps.len();
            let body = json!({ "keyVersion": generation, "wraps": wraps });
            let reply = api.post("keys", &body).await?;
            // The keys moved on meanwhile, or a member's key went away: look again.
            if reply.status == 409 && matches!(reply.error(), "conflict" | "no_member_key") {
                continue;
            }
            let stored = reply.into_ok().map_err(gone)?;
            added += stored["stored"].as_array().map_or(count, Vec::len);
            renewed |= renewing;
            return Ok(done(ring, added, renewed, waiting));
        }
        Err(failed("Sync", "The share's keys kept changing; try again."))
    }

    fn last_file(&self, project: &str) -> PathBuf {
        self.vault
            .sync_file("shares")
            .join(format!("{project}.json"))
    }

    /// Writes what the share says of the project, when it isn't what is there.
    async fn write_info(&self, api: &Api, ring: &Keyring, info: &Info) -> Result<()> {
        for _ in 0..3 {
            let version = match read(api, ring, INFO.0, INFO.1).await? {
                Read::Text { text, version } => {
                    if serde_json::from_str::<Info>(&text).is_ok_and(|now| now == *info) {
                        return Ok(());
                    }
                    Some(version)
                }
                Read::Absent { version } | Read::Damaged { version } => version,
            };
            if write(
                api,
                ring,
                INFO,
                version,
                Some(&serde_json::to_string(info)?),
            )
            .await?
            {
                return Ok(());
            }
        }
        Ok(())
    }

    /// Starts sharing a project (or changes a share's name and chats switch), and, with a
    /// folder, takes its first snapshot.
    pub async fn start_and_sync(
        &self,
        project: &str,
        name: &str,
        chats: bool,
        only_verified: bool,
        capture: Option<Folder<'_>>,
    ) -> Result<Synced> {
        let kept = {
            let _step = STEP.lock().await;
            self.start(project, name, chats, only_verified).await?
        };
        self.capture(project, kept, capture).await
    }

    /// Sees to a share's keys, then writes a snapshot of the folder into it when the folder
    /// changed since the last one. The caller holds the one-snapshot-at-a-time guard.
    pub async fn sync(
        &self,
        project: &str,
        only_verified: bool,
        capture: Folder<'_>,
    ) -> Result<Synced> {
        if !valid_project(project) {
            return Err(Error::Invalid("that isn't a project".into()));
        }
        let kept = {
            let _step = STEP.lock().await;
            self.maintain(project, only_verified).await?
        };
        self.capture(project, kept, Some(capture)).await
    }

    async fn capture(
        &self,
        project: &str,
        kept: Maintained,
        capture: Option<Folder<'_>>,
    ) -> Result<Synced> {
        let id = share_id(&self.uid, project);
        let mut out = Synced {
            id: id.clone(),
            snapshot: None,
            key_files: 0,
            wraps_added: kept.wraps_added,
            renewed: kept.renewed,
            waiting: kept.waiting,
        };
        let Some(capture) = capture else {
            return Ok(out);
        };
        let ring = &kept.ring;
        let api = self.share_api(&id)?;
        let root_text = capture.root.to_string_lossy().to_string();
        let tag = ring.name_of("share-cache")?;
        let cache = self.last_file(project);
        let last: Option<Last> = std::fs::read(&cache)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .filter(|l: &Last| l.v == LAST_VERSION && l.root == root_text && l.tag == tag);
        let left_out = |manifest: &Manifest| {
            manifest
                .skipped
                .iter()
                .filter(|(_, why)| why == KEY_FILE)
                .count()
        };
        let picture = snapshot::fingerprint(capture.root)?;
        if let Some(same) = last.as_ref().filter(|l| l.fingerprint == picture) {
            out.key_files = left_out(&same.manifest);
            return Ok(out);
        }
        let options = || snapshot::CreateOptions {
            collection: SNAP,
            device: capture.device,
            device_name: capture.device_name,
            everything: false,
            before: last.as_ref().map(|l| &l.manifest),
            now_ms: now_ms(),
            leave_out: Some(plan::key_file),
            remote_as: Some(plan::public_remote),
            // Only what the commit checked out needs: no other branch, no stash, and no key
            // file inside a commit that wasn't pushed (`ShareKeyFilesInHistory`).
            head_only: true,
        };
        let created = match snapshot::create(&api, ring, &self.data, capture.root, options()).await
        {
            // No room: the share's older snapshots go first, then once more.
            Err(Error::Sync("SyncFull", _)) => {
                self.prune(&api, ring, 1).await?;
                snapshot::create(&api, ring, &self.data, capture.root, options()).await
            }
            other => other,
        }
        .map_err(gone)?;
        let manifest = snapshot::manifest(&api, ring, &created.summary).await?;
        out.key_files = left_out(&manifest);
        out.snapshot = Some(created.id.clone());
        let info = Info {
            v: 1,
            name: kept.name.clone(),
            computer: clean(capture.device_name, 80),
            git: manifest.git.is_some(),
            // Written by the capture through `plan::public_remote`: an ordinary address only.
            remote: manifest.git.as_ref().and_then(|g| g.remote.clone()),
        };
        self.write_info(&api, ring, &info).await?;
        // Kept for the next time; losing it only costs reading the files again.
        if let Some(dir) = cache.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let last = Last {
            v: LAST_VERSION,
            root: root_text,
            fingerprint: created.summary.fingerprint.clone(),
            tag,
            manifest,
        };
        if let Ok(bytes) = serde_json::to_vec(&last) {
            let _ = atomic_write(&cache, &bytes);
        }
        // Older snapshots go; a failure here is tried again with the next snapshot.
        let _ = self.prune(&api, ring, KEEP_SNAPSHOTS).await;
        Ok(out)
    }

    /// Deletes all but a share's newest `keep` snapshots, then has the service remove the
    /// content nothing refers to any more (as for a vault). How many went.
    async fn prune(&self, api: &Api, ring: &Keyring, keep: usize) -> Result<usize> {
        let (records, _) = snapshot_records(api, ring).await?;
        let mut removed = 0;
        for id in ids_to_prune(records.keys().map(String::as_str), keep) {
            let Some(record) = records.get(&id) else {
                continue;
            };
            if write(api, ring, (SNAP, id.as_str()), Some(record.version), None).await? {
                removed += 1;
            }
        }
        if removed > 0 {
            // At most once a minute on the service's side: one that is refused runs later.
            let _ = api.post("gc", &json!({})).await;
        }
        Ok(removed)
    }

    /// Changes a share's name and whether its chats are shared.
    pub async fn update(&self, project: &str, name: &str, chats: bool) -> Result<ShareInfo> {
        let _step = STEP.lock().await;
        let name = clean(name, 120);
        if !valid_project(project) || name.is_empty() {
            return Err(Error::Invalid("a share needs a project and a name".into()));
        }
        let id = share_id(&self.uid, project);
        let members = self.team_members().await?;
        let pins = self.observe(&members).await?;
        // Asked first: writing to a share that isn't there would make one, without keys.
        if !self
            .listed(&pins, &members)
            .await?
            .iter()
            .any(|s| s.id == id)
        {
            return Err(share_gone());
        }
        let body = json!({ "name": name, "chats": chats });
        let reply = self
            .team
            .put(&format!("shares/{project}"), &body)
            .await?
            .into_ok()?;
        let info = self
            .share_info(&reply, &pins, &members)
            .ok_or_else(unreadable)?;
        for _ in 0..3 {
            let read = self.own(project).await?;
            let Some((mut own, ring)) = read.own else {
                break;
            };
            own.name = name.clone();
            own.chats = chats;
            if self.save_own(project, &own, read.version).await? {
                // What readers see of the project follows; the next snapshot writes it anyway.
                let api = self.share_api(&id)?;
                if let Ok(Read::Text { text, .. }) = read_info(&api, &ring).await {
                    if let Ok(mut said) = serde_json::from_str::<Info>(&text) {
                        said.name = name.clone();
                        let _ = self.write_info(&api, &ring, &said).await;
                    }
                }
                break;
            }
        }
        Ok(info)
    }

    /// Stops a share: the service deletes it and everything in it; this account's copy of its
    /// keys goes too. (The team's owner may stop anyone's.)
    pub async fn stop(&self, id: &str) -> Result<()> {
        let _step = STEP.lock().await;
        let (owner, project) =
            split_share_id(id).ok_or_else(|| Error::Invalid("that isn't a share".into()))?;
        match self.team.delete(&format!("shares/{id}")).await {
            // Gone already: what is kept of it here still goes.
            Ok(_) | Err(Error::Sync("ShareGone", _)) => {}
            Err(e) => return Err(e),
        }
        self.forget(id, None);
        if owner != self.uid {
            return Ok(());
        }
        let _ = std::fs::remove_file(self.last_file(project));
        for _ in 0..3 {
            let version = match read(&self.vault.api, &self.ring, OWN, project).await? {
                Read::Absent { .. } => return Ok(()),
                Read::Damaged { version } => version,
                Read::Text { version, .. } => Some(version),
            };
            if write(&self.vault.api, &self.ring, (OWN, project), version, None).await? {
                return Ok(());
            }
        }
        Ok(())
    }
}

/// Adds `uids` to the members the record names as handed its keys. True when it changed.
fn note_handed(own: &mut Own, uids: &[String]) -> bool {
    let mut changed = false;
    for uid in uids {
        if !own.handed.contains(uid) {
            own.handed.push(uid.clone());
            changed = true;
        }
    }
    changed
}

/// The snapshots that go when only the newest `keep` stay. Ids start with the time they were
/// taken at, so the newest sort last.
fn ids_to_prune<'a>(ids: impl Iterator<Item = &'a str>, keep: usize) -> Vec<String> {
    let mut all: Vec<&str> = ids.collect();
    all.sort_unstable();
    let extra = all.len().saturating_sub(keep);
    all.into_iter().take(extra).map(str::to_string).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_newest_snapshots_stay() {
        let ids: Vec<String> = (0..13)
            .map(|n| format!("{:013}-abc123", 1000 + n))
            .collect();
        let gone = ids_to_prune(ids.iter().rev().map(String::as_str), 10);
        assert_eq!(
            gone,
            ids[..3].to_vec(),
            "the oldest three, whatever the order"
        );
        assert!(ids_to_prune(ids.iter().take(10).map(String::as_str), 10).is_empty());
        assert!(ids_to_prune(std::iter::empty(), 10).is_empty());
        // When there is no room: all but the newest.
        assert_eq!(ids_to_prune(ids.iter().map(String::as_str), 1).len(), 12);
    }
}
