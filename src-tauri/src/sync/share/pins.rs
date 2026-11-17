//! Pins: each teammate's public member key as this account first saw it, and whether the
//! person behind it was verified. Whose key a key is, is decided here and never by what the
//! service says at the moment: a key that later differs is only noted, and used by nobody
//! until it is accepted by hand.
//!
//! All of it is plain data and decisions; reading and writing the sealed record is `mod.rs`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::keys::{fingerprint, same_fingerprint, valid_key, valid_uid};
use crate::error::{Error, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pin {
    /// The member's public key as first seen (or as accepted by hand since).
    pub key: String,
    /// When it was pinned, in ms.
    pub at: u64,
    #[serde(default)]
    pub verified: bool,
    /// Another key the service showed for this member later: waiting to be accepted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<String>,
}

/// The record `sys/team` of the account's own vault.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pins {
    #[serde(default)]
    pub v: u32,
    /// Goes up with every write, so an older record handed back is told from the newest.
    #[serde(default)]
    pub n: u64,
    /// By account id.
    #[serde(default)]
    pub members: BTreeMap<String, Pin>,
}

/// A member as the service lists them: who, the name to show, the key it has for them now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    pub uid: String,
    pub name: String,
    pub key: Option<String>,
}

/// Where a teammate stands, for this account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MemberState {
    /// The service has no key for them (they haven't opened the app with sync on yet).
    NoKey,
    /// Pinned, and nobody compared fingerprints yet.
    New,
    Verified,
    /// The service shows another key than the one pinned.
    Changed,
}

/// Why a member gets no keys of a share for now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Waiting {
    pub uid: String,
    pub name: String,
    /// "noKey", "keyChanged" or "notVerified".
    pub why: &'static str,
}

/// The keys this run pinned at first sight, by member: (key, when). Kept across the attempts
/// of one write, so what another computer pinned meanwhile is settled by `merge_first_sights`.
pub type FirstSights = BTreeMap<String, (String, u64)>;

/// The sealed record as it was read.
pub enum Remote {
    /// There is none.
    Absent,
    /// There is one and nothing opens it (altered, cut short), or it isn't a list of pins.
    Damaged,
    Read(Pins),
}

impl Pins {
    /// A record's text as pins; None when it isn't any. Entries that can't be pins are left out.
    pub fn parse(text: &str) -> Option<Pins> {
        let mut pins: Pins = serde_json::from_str(text).ok()?;
        pins.members.retain(|uid, pin| {
            valid_uid(uid) && valid_key(&pin.key) && pin.pending.as_deref().is_none_or(valid_key)
        });
        Some(pins)
    }

    pub fn text(&self) -> Result<String> {
        Ok(serde_json::to_string(&Pins {
            v: 1,
            ..self.clone()
        })?)
    }

    /// Where a member stands: from the pin, and the key the service shows for them now.
    pub fn state(&self, uid: &str, shown: Option<&str>) -> MemberState {
        match (self.members.get(uid), shown) {
            (_, None) | (None, _) => MemberState::NoKey,
            (Some(pin), Some(key)) if pin.key == key => {
                if pin.verified {
                    MemberState::Verified
                } else {
                    MemberState::New
                }
            }
            _ => MemberState::Changed,
        }
    }

    /// Takes in what the service shows now: a member seen for the first time is pinned; a key
    /// that differs from the pin is noted as pending. A pin is never replaced here. `me` has
    /// no pin (this account knows its own key). True when something changed.
    pub fn observe(
        &mut self,
        members: &[Member],
        me: &str,
        now: u64,
        first: &mut FirstSights,
    ) -> bool {
        let mut changed = false;
        for member in members {
            let Some(key) = member.key.as_deref().filter(|k| valid_key(k)) else {
                continue;
            };
            if member.uid == me || !valid_uid(&member.uid) {
                continue;
            }
            match self.members.get_mut(&member.uid) {
                None => {
                    self.members.insert(
                        member.uid.clone(),
                        Pin {
                            key: key.to_string(),
                            at: now,
                            verified: false,
                            pending: None,
                        },
                    );
                    first.insert(member.uid.clone(), (key.to_string(), now));
                    changed = true;
                }
                // The pinned key is shown (again): nothing is waiting any more.
                Some(pin) if pin.key == key => {
                    if pin.pending.take().is_some() {
                        changed = true;
                    }
                }
                Some(pin) => {
                    if pin.pending.as_deref() != Some(key) {
                        pin.pending = Some(key.to_string());
                        changed = true;
                    }
                }
            }
        }
        changed
    }

    /// Settles what this run pinned at first sight with what the record holds now (another of
    /// the account's computers wrote meanwhile). The same key: the earlier time. Different
    /// keys for one member: the one pinned earlier is the pin and the other is pending, so a
    /// pin never changes without being seen. True when something changed.
    pub fn merge_first_sights(&mut self, first: &FirstSights) -> bool {
        let mut changed = false;
        for (uid, (key, at)) in first {
            match self.members.get_mut(uid) {
                None => {
                    self.members.insert(
                        uid.clone(),
                        Pin {
                            key: key.clone(),
                            at: *at,
                            verified: false,
                            pending: None,
                        },
                    );
                    changed = true;
                }
                Some(pin) if pin.key == *key => {
                    if *at < pin.at {
                        pin.at = *at;
                        changed = true;
                    }
                }
                Some(pin) if *at < pin.at => {
                    let theirs = std::mem::replace(
                        pin,
                        Pin {
                            key: key.clone(),
                            at: *at,
                            verified: false,
                            pending: None,
                        },
                    );
                    pin.pending = Some(theirs.key);
                    changed = true;
                }
                Some(pin) => {
                    if pin.pending.as_deref() != Some(key.as_str()) {
                        pin.pending = Some(key.clone());
                        changed = true;
                    }
                }
            }
        }
        changed
    }

    /// Marks a member verified (their fingerprint was compared) or not. `shown` is the
    /// fingerprint the person looked at: it must be the pinned key's, and no other key may be
    /// waiting. True when something changed.
    pub fn set_verified(&mut self, uid: &str, shown: &str, verified: bool) -> Result<bool> {
        let pin = self.members.get_mut(uid).ok_or_else(unknown_member)?;
        if verified {
            if pin.pending.is_some() {
                return Err(Error::Sync(
                    "ShareKeyChanged",
                    "This member's key changed. Accept the new key first, then compare its fingerprint.".into(),
                ));
            }
            if !same_fingerprint(&fingerprint(&pin.key)?, shown) {
                return Err(not_the_fingerprint());
            }
        }
        if pin.verified == verified {
            return Ok(false);
        }
        pin.verified = verified;
        Ok(true)
    }

    /// Accepts the key the service showed after the pinned one: it becomes the pin, not
    /// verified. `shown` is the new key's fingerprint as the person saw it.
    pub fn accept_changed_key(&mut self, uid: &str, shown: &str, now: u64) -> Result<()> {
        let pin = self.members.get_mut(uid).ok_or_else(unknown_member)?;
        let Some(next) = pin.pending.clone() else {
            return Err(Error::Sync(
                "Share",
                "This member's key didn't change.".into(),
            ));
        };
        if !same_fingerprint(&fingerprint(&next)?, shown) {
            return Err(not_the_fingerprint());
        }
        *pin = Pin {
            key: next,
            at: now,
            verified: false,
            pending: None,
        };
        Ok(())
    }
}

fn unknown_member() -> Error {
    Error::Sync("Share", "That member has no key yet.".into())
}

fn not_the_fingerprint() -> Error {
    Error::Sync(
        "ShareKeyChanged",
        "That isn't the fingerprint of this member's key as it is now. Look at the list again."
            .into(),
    )
}

/// The pins to go on from, given the sealed record as read and what this computer kept of
/// the last one it read or wrote (`kept`). The record is sealed with the account's keys, so
/// whoever stores it can't write one, only withhold it or hand back an older one: then what
/// this computer kept is used and written back. Otherwise the record is the truth, and what
/// this computer kept only fills in members the record doesn't name. The second value says
/// the result differs from the record and should be written.
pub fn reconcile(remote: Remote, kept: Option<&Pins>) -> (Pins, bool) {
    let kept = kept.filter(|k| !k.members.is_empty());
    match (remote, kept) {
        (Remote::Read(read), Some(kept)) if kept.n > read.n => (kept.clone(), true),
        (Remote::Read(mut read), Some(kept)) => {
            let mut added = false;
            for (uid, pin) in &kept.members {
                if !read.members.contains_key(uid) {
                    read.members.insert(uid.clone(), pin.clone());
                    added = true;
                }
            }
            (read, added)
        }
        (Remote::Read(read), None) => (read, false),
        (Remote::Absent | Remote::Damaged, Some(kept)) => (kept.clone(), true),
        (Remote::Absent | Remote::Damaged, None) => (Pins::default(), false),
    }
}

/// Who gets a share's keys: the members whose pinned key is the one the service shows (so
/// they can open what is boxed to it), each with that pinned key; with `only_verified`, only
/// those who were verified. Everyone else, and why. The sharer itself is in neither list (it
/// has the keyring in its own vault).
pub fn recipients(
    pins: &Pins,
    members: &[Member],
    me: &str,
    only_verified: bool,
) -> (Vec<(String, String)>, Vec<Waiting>) {
    let mut to = Vec::new();
    let mut waiting = Vec::new();
    for member in members {
        if member.uid == me {
            continue;
        }
        let wait = |why: &'static str| Waiting {
            uid: member.uid.clone(),
            name: member.name.clone(),
            why,
        };
        let pinned = pins.members.get(&member.uid).map(|pin| pin.key.clone());
        match (pins.state(&member.uid, member.key.as_deref()), pinned) {
            (MemberState::Verified, Some(key)) => to.push((member.uid.clone(), key)),
            (MemberState::New, Some(key)) if !only_verified => to.push((member.uid.clone(), key)),
            (MemberState::New, _) => waiting.push(wait("notVerified")),
            (MemberState::Changed, _) => waiting.push(wait("keyChanged")),
            _ => waiting.push(wait("noKey")),
        }
    }
    (to, waiting)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::crypto::PrivateKey;

    fn key() -> String {
        PrivateKey::generate().unwrap().public()
    }

    fn member(uid: &str, key: Option<&str>) -> Member {
        Member {
            uid: uid.into(),
            name: uid.to_uppercase(),
            key: key.map(str::to_string),
        }
    }

    #[test]
    fn a_member_is_pinned_at_first_sight() {
        let (a, b) = (key(), key());
        let mut pins = Pins::default();
        let mut first = FirstSights::new();
        let members = [
            member("me", Some(&key())),
            member("a", Some(&a)),
            member("b", Some(&b)),
            member("c", None),
            member("d", Some("not a key")),
        ];
        assert!(pins.observe(&members, "me", 100, &mut first));
        assert_eq!(
            pins.members.keys().collect::<Vec<_>>(),
            ["a", "b"],
            "not this account, nor a member without a key"
        );
        assert_eq!(pins.members["a"].key, a);
        assert_eq!(
            (pins.members["a"].at, pins.members["a"].verified),
            (100, false)
        );
        assert_eq!(first.len(), 2);
        assert_eq!(pins.state("a", Some(&a)), MemberState::New);
        assert_eq!(pins.state("c", None), MemberState::NoKey);
        assert_eq!(pins.state("stranger", Some(&a)), MemberState::NoKey);
        // Seen again: nothing changes.
        let mut again = FirstSights::new();
        assert!(!pins.observe(&members, "me", 200, &mut again));
        assert!(again.is_empty());
        assert_eq!(pins.members["a"].at, 100);
    }

    #[test]
    fn a_changed_key_is_never_used_until_accepted() {
        let (old, new, me) = (key(), key(), "me");
        let mut pins = Pins::default();
        let mut first = FirstSights::new();
        pins.observe(&[member("a", Some(&old))], me, 100, &mut first);
        pins.set_verified("a", &fingerprint(&old).unwrap(), true)
            .unwrap();
        // The service shows another key for the same member.
        let shown = [member("a", Some(&new))];
        assert!(pins.observe(&shown, me, 200, &mut first));
        assert_eq!(pins.members["a"].key, old, "the pin stays");
        assert_eq!(pins.members["a"].pending.as_deref(), Some(new.as_str()));
        assert!(pins.members["a"].verified, "of the pinned key");
        assert_eq!(pins.state("a", Some(&new)), MemberState::Changed);
        let (to, waiting) = recipients(&pins, &shown, me, false);
        assert!(to.is_empty(), "nothing is boxed for either key");
        assert_eq!(waiting[0].why, "keyChanged");
        // The new key can't be verified before it was accepted, nor accepted under the old
        // key's fingerprint (what the person looked at must be what is accepted).
        assert!(matches!(
            pins.set_verified("a", &fingerprint(&new).unwrap(), true),
            Err(Error::Sync("ShareKeyChanged", _))
        ));
        assert!(pins
            .accept_changed_key("a", &fingerprint(&old).unwrap(), 300)
            .is_err());
        assert_eq!(pins.members["a"].key, old);
        pins.accept_changed_key("a", &fingerprint(&new).unwrap(), 300)
            .unwrap();
        assert_eq!(
            pins.members["a"],
            Pin {
                key: new.clone(),
                at: 300,
                verified: false,
                pending: None
            }
        );
        assert_eq!(pins.state("a", Some(&new)), MemberState::New);
        assert_eq!(
            recipients(&pins, &shown, me, false).0,
            [("a".to_string(), new.clone())]
        );
        // Nothing left to accept.
        assert!(pins
            .accept_changed_key("a", &fingerprint(&new).unwrap(), 400)
            .is_err());
        assert!(pins.accept_changed_key("nobody", "", 400).is_err());
    }

    #[test]
    fn a_key_shown_again_after_another_clears_what_was_waiting() {
        let (old, other) = (key(), key());
        let mut pins = Pins::default();
        let mut first = FirstSights::new();
        pins.observe(&[member("a", Some(&old))], "me", 1, &mut first);
        pins.observe(&[member("a", Some(&other))], "me", 2, &mut first);
        assert!(pins.members["a"].pending.is_some());
        assert!(pins.observe(&[member("a", Some(&old))], "me", 3, &mut first));
        assert_eq!(pins.members["a"].pending, None);
        assert_eq!(pins.state("a", Some(&old)), MemberState::New);
        // No key shown at all: the pin stays, and nothing is boxed meanwhile.
        assert!(!pins.observe(&[member("a", None)], "me", 4, &mut first));
        assert_eq!(pins.members["a"].key, old);
        assert_eq!(pins.state("a", None), MemberState::NoKey);
    }

    #[test]
    fn verified_is_of_the_fingerprint_that_was_looked_at() {
        let (a, b) = (key(), key());
        let mut pins = Pins::default();
        let mut first = FirstSights::new();
        pins.observe(&[member("a", Some(&a))], "me", 1, &mut first);
        assert!(matches!(
            pins.set_verified("a", &fingerprint(&b).unwrap(), true),
            Err(Error::Sync("ShareKeyChanged", _))
        ));
        assert!(!pins.members["a"].verified);
        assert!(pins
            .set_verified("a", &fingerprint(&a).unwrap().replace(' ', ""), true)
            .unwrap());
        assert_eq!(pins.state("a", Some(&a)), MemberState::Verified);
        assert!(!pins
            .set_verified("a", &fingerprint(&a).unwrap(), true)
            .unwrap());
        // Taking it back needs no fingerprint.
        assert!(pins.set_verified("a", "", false).unwrap());
        assert_eq!(pins.state("a", Some(&a)), MemberState::New);
        assert!(pins.set_verified("nobody", "", false).is_err());
    }

    #[test]
    fn two_computers_that_pinned_different_keys_keep_the_earlier() {
        let (k1, k2) = (key(), key());
        // This run saw k1 at 100. Meanwhile another computer wrote k2, pinned at 150.
        let first: FirstSights = [("a".to_string(), (k1.clone(), 100))].into();
        let mut record = Pins::default();
        record.members.insert(
            "a".into(),
            Pin {
                key: k2.clone(),
                at: 150,
                verified: true,
                pending: None,
            },
        );
        let mut pins = record.clone();
        assert!(pins.merge_first_sights(&first));
        assert_eq!(pins.members["a"].key, k1, "the earlier one is the pin");
        assert_eq!(pins.members["a"].pending.as_deref(), Some(k2.as_str()));
        assert!(!pins.members["a"].verified, "verified was of the other key");
        // The other computer's was the earlier: it stays, and this run's key waits.
        let later: FirstSights = [("a".to_string(), (k1.clone(), 200))].into();
        let mut pins = record.clone();
        assert!(pins.merge_first_sights(&later));
        assert_eq!(pins.members["a"].key, k2);
        assert!(pins.members["a"].verified);
        assert_eq!(pins.members["a"].pending.as_deref(), Some(k1.as_str()));
        assert!(!pins.merge_first_sights(&later), "settled once");
        // The same key on both: one pin, the earlier time, and what the record says of it.
        let same: FirstSights = [("a".to_string(), (k2.clone(), 120))].into();
        let mut pins = record.clone();
        assert!(pins.merge_first_sights(&same));
        assert_eq!(
            (pins.members["a"].at, pins.members["a"].verified),
            (120, true)
        );
        // Only this run saw the member: pinned.
        let mut pins = Pins::default();
        assert!(pins.merge_first_sights(&first));
        assert_eq!(pins.members["a"].key, k1);
    }

    #[test]
    fn an_accepted_key_is_not_undone_by_a_run_that_started_before_it() {
        // This run read the record with k1 pinned (so k1 is no first sight of its own), then
        // another computer accepted k2. Writing again starts from the record as it is now.
        let (k1, k2) = (key(), key());
        let mut record = Pins::default();
        record.members.insert(
            "a".into(),
            Pin {
                key: k2.clone(),
                at: 500,
                verified: false,
                pending: None,
            },
        );
        let mut first = FirstSights::new();
        let mut pins = record.clone();
        pins.merge_first_sights(&first);
        assert!(!pins.observe(&[member("a", Some(&k2))], "me", 600, &mut first));
        assert_eq!(pins, record);
        // And what this computer kept from before (k1) doesn't come back over the record.
        let mut kept = Pins {
            n: 3,
            ..Default::default()
        };
        kept.members.insert(
            "a".into(),
            Pin {
                key: k1,
                at: 100,
                verified: true,
                pending: None,
            },
        );
        let newer = Pins {
            n: 4,
            ..record.clone()
        };
        let (pins, write) = reconcile(Remote::Read(newer.clone()), Some(&kept));
        assert_eq!((pins, write), (newer, false));
    }

    #[test]
    fn a_record_withheld_or_rolled_back_doesnt_lose_the_pins() {
        let k = key();
        let mut kept = Pins {
            n: 5,
            ..Default::default()
        };
        kept.members.insert(
            "a".into(),
            Pin {
                key: k.clone(),
                at: 1,
                verified: true,
                pending: None,
            },
        );
        // "There is no such record", or one nothing opens: what this computer kept goes on.
        for remote in [Remote::Absent, Remote::Damaged] {
            let (pins, write) = reconcile(remote, Some(&kept));
            assert_eq!(pins, kept);
            assert!(write, "written back");
        }
        // An older record handed back (it lacks the pin, or has it unverified).
        let older = Pins {
            n: 4,
            ..Default::default()
        };
        let (pins, write) = reconcile(Remote::Read(older), Some(&kept));
        assert_eq!((pins, write), (kept.clone(), true));
        // The record is as new: it is the truth, and a member only this computer knows is added.
        let mut record = Pins {
            n: 5,
            ..Default::default()
        };
        record.members.insert(
            "b".into(),
            Pin {
                key: key(),
                at: 2,
                verified: false,
                pending: None,
            },
        );
        let (pins, write) = reconcile(Remote::Read(record), Some(&kept));
        assert!(write && pins.members.contains_key("a") && pins.members.contains_key("b"));
        // Nothing kept and nothing there: an empty list, nothing to write.
        assert_eq!(reconcile(Remote::Absent, None), (Pins::default(), false));
        assert_eq!(
            reconcile(Remote::Damaged, Some(&Pins::default())),
            (Pins::default(), false)
        );
    }

    #[test]
    fn who_gets_a_shares_keys() {
        let keys: Vec<String> = (0..5).map(|_| key()).collect();
        let me = "me";
        let mut pins = Pins::default();
        let mut first = FirstSights::new();
        // new, verified, changed (pinned keys[2], shown keys[4]), nokey.
        pins.observe(
            &[
                member("new", Some(&keys[0])),
                member("ver", Some(&keys[1])),
                member("chg", Some(&keys[2])),
            ],
            me,
            1,
            &mut first,
        );
        pins.set_verified("ver", &fingerprint(&keys[1]).unwrap(), true)
            .unwrap();
        pins.set_verified("chg", &fingerprint(&keys[2]).unwrap(), true)
            .unwrap();
        let members = [
            member(me, Some(&keys[3])),
            member("new", Some(&keys[0])),
            member("ver", Some(&keys[1])),
            member("chg", Some(&keys[4])),
            member("none", None),
            member("gone", None),
        ];
        let (to, waiting) = recipients(&pins, &members, me, false);
        assert_eq!(
            to,
            [
                ("new".to_string(), keys[0].clone()),
                ("ver".to_string(), keys[1].clone())
            ]
        );
        let why: Vec<(&str, &str)> = waiting.iter().map(|w| (w.uid.as_str(), w.why)).collect();
        assert_eq!(
            why,
            [("chg", "keyChanged"), ("none", "noKey"), ("gone", "noKey")],
            "a verified member whose key changed gets nothing either"
        );
        // Only verified members.
        let (to, waiting) = recipients(&pins, &members, me, true);
        assert_eq!(to, [("ver".to_string(), keys[1].clone())]);
        assert_eq!(waiting[0].uid, "new");
        assert_eq!(waiting[0].why, "notVerified");
        assert_eq!(waiting[0].name, "NEW");
        // A member the service shows a key for that was never pinned here gets nothing: the
        // key boxed to is always a pinned one.
        let (to, waiting) = recipients(&Pins::default(), &members[1..2], me, false);
        assert!(to.is_empty());
        assert_eq!(waiting[0].why, "noKey");
    }

    #[test]
    fn the_record_reads_what_it_wrote_and_drops_what_isnt_a_pin() {
        let k = key();
        let mut pins = Pins {
            n: 7,
            ..Default::default()
        };
        pins.members.insert(
            "a".into(),
            Pin {
                key: k.clone(),
                at: 9,
                verified: true,
                pending: Some(key()),
            },
        );
        let back = Pins::parse(&pins.text().unwrap()).unwrap();
        assert_eq!(back.members, pins.members);
        assert_eq!((back.n, back.v), (7, 1));
        let odd = serde_json::json!({ "n": 2, "members": {
            "a": { "key": k, "at": 1 },
            "b/c": { "key": k, "at": 1 },
            "d": { "key": "short", "at": 1 },
            "e": { "key": k, "at": 1, "pending": "short" },
        }});
        let read = Pins::parse(&odd.to_string()).unwrap();
        assert_eq!(read.members.keys().collect::<Vec<_>>(), ["a"]);
        assert!(!read.members["a"].verified);
        assert!(Pins::parse("not json").is_none());
        assert_eq!(Pins::parse("{}").unwrap(), Pins::default());
    }
}
