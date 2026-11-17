//! The keys between the members of a team: a member's fingerprint, and a share's keyring boxed
//! from the sharer's member key to one member's ("a wrap"). Every construction is one
//! `crypto.rs` already has; nothing here talks to the service.

use sha2_10::{Digest, Sha256};

use crate::error::{Error, Result};
use crate::sync::crypto::{self, Keyring, PrivateKey};

/// What a fingerprint is hashed with, so it can't be mistaken for any other hash of a key.
const FINGERPRINT_DOMAIN: &[u8] = b"member-key-fingerprint-v2\0";
/// What a wrap's content starts with, so a box made for anything else is never taken for one.
const WRAP_DOMAIN: &[u8] = b"share-wrap-v2\0";
/// The service takes a wrap of at most this many characters.
pub const MAX_WRAP_CHARS: usize = 4096;

/// A fingerprint's digits, and how they are grouped.
const FINGERPRINT_DIGITS: usize = 30;
const FINGERPRINT_GROUP: usize = 5;
const TEN_TO_30: u128 = 1_000_000_000_000_000_000_000_000_000_000;

/// A public member key as the service hands it over: 32 bytes, in the one spelling they have.
pub fn valid_key(text: &str) -> bool {
    text.len() == 43 && crypto::unb64(text).is_ok_and(|bytes| bytes.len() == 32)
}

/// Letters, digits, `-` and `_`, at most `max` of them: what an account's id, a project's id and
/// a snapshot's id are made of. Such a name can stand in an address or a file's name.
fn plain(text: &str, max: usize) -> bool {
    !text.is_empty()
        && text.len() <= max
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn valid_uid(text: &str) -> bool {
    plain(text, 128)
}

pub fn valid_project(text: &str) -> bool {
    plain(text, 64)
}

/// A record's id inside a share (a snapshot's): it goes into an address.
pub fn valid_record_id(text: &str) -> bool {
    plain(text, 80)
}

/// A share's id: the sharer's account and the project, with a dot between.
pub fn share_id(uid: &str, project: &str) -> String {
    format!("{uid}.{project}")
}

/// The sharer and the project a share's id names; None for anything that isn't such an id.
pub fn split_share_id(id: &str) -> Option<(&str, &str)> {
    let (uid, project) = id.split_once('.')?;
    (valid_uid(uid) && valid_project(project)).then_some((uid, project))
}

/// A member key's fingerprint: 30 decimal digits in six groups of five, which one person
/// reads out and the other compares with what their own app shows for that person. It is of
/// the key and of whose key it is (`uid`, the member's account id): a key someone made to
/// have a certain fingerprint has it for one member only, so a search for one costs the same
/// for every member it is aimed at, and thirty digits (about 100 bits) put it out of reach.
///
/// How the digits are made, so another implementation gives the same ones:
/// 1. `digest = SHA-256("member-key-fingerprint-v2\0" || the account id's bytes || the key's
///    32 bytes || one counter byte)`, the counter starting at 0. (An account id is letters,
///    digits, `-` and `_`, and the key and the counter have fixed lengths: the parts can't be
///    cut another way.)
/// 2. `n` = the digest's first 16 bytes as an unsigned big-endian number.
/// 3. When `n` is below the largest multiple of 10^30 that fits in 128 bits, the digits are
///    `n mod 10^30`, written with leading zeros. Each of the 10^30 values is then exactly as
///    likely as any other: taking the remainder of all 2^128 values would favour the low ones.
/// 4. Otherwise (less than once in 10^8 keys) the counter goes up by one and step 1 runs again.
pub fn fingerprint(uid: &str, public_key: &str) -> Result<String> {
    let invalid = || Error::Sync("ShareKeys", "That isn't a member's key.".into());
    if !valid_key(public_key) || !valid_uid(uid) {
        return Err(invalid());
    }
    let key = crypto::unb64(public_key)?;
    let limit = (u128::MAX / TEN_TO_30) * TEN_TO_30;
    for counter in 0..=u8::MAX {
        let mut hash = Sha256::new();
        hash.update(FINGERPRINT_DOMAIN);
        hash.update(uid.as_bytes());
        hash.update(&key);
        hash.update([counter]);
        let digest = hash.finalize();
        let mut first = [0u8; 16];
        first.copy_from_slice(&digest[..16]);
        let n = u128::from_be_bytes(first);
        if n < limit {
            let digits = format!("{:030}", n % TEN_TO_30);
            let groups: Vec<&str> = (0..FINGERPRINT_DIGITS / FINGERPRINT_GROUP)
                .map(|g| &digits[g * FINGERPRINT_GROUP..(g + 1) * FINGERPRINT_GROUP])
                .collect();
            return Ok(groups.join(" "));
        }
    }
    Err(invalid())
}

/// Whether two fingerprints are the same digits, however they were grouped.
pub fn same_fingerprint(a: &str, b: &str) -> bool {
    let digits = |s: &str| s.chars().filter(char::is_ascii_digit).collect::<String>();
    let (a, b) = (digits(a), digits(b));
    a.len() == FINGERPRINT_DIGITS && a == b
}

/// What a wrap holds before it is boxed:
///
/// ```text
/// "share-wrap-v2\0"                           14 bytes
/// the length of the share's id                2 bytes, big-endian
/// the share's id                              that many bytes (UTF-8)
/// the generation these keys are current at    4 bytes, big-endian
/// when this keyring was made, in ms           8 bytes, big-endian
/// the keyring                                 the rest (`Keyring::to_bytes`)
/// ```
///
/// The id and the generation are inside the box, so a wrap can't be passed off as another
/// share's or as another generation's. So is when the keyring was made (which life of the
/// share it belongs to: a share stopped and made again under the same id has a new keyring,
/// made later), so a reader can tell a share that was made again from an earlier life's wrap
/// handed over once more (`plan::check_floor`).
fn wrap_plain(share: &str, generation: u32, made_at: u64, keyring: &[u8]) -> Result<Vec<u8>> {
    let length =
        u16::try_from(share.len()).map_err(|_| Error::Invalid("that isn't a share".into()))?;
    let mut out = Vec::with_capacity(WRAP_DOMAIN.len() + 2 + share.len() + 12 + keyring.len());
    out.extend_from_slice(WRAP_DOMAIN);
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(share.as_bytes());
    out.extend_from_slice(&generation.to_be_bytes());
    out.extend_from_slice(&made_at.to_be_bytes());
    out.extend_from_slice(keyring);
    Ok(out)
}

/// A wrap that was opened: the keyring, and when it was made (which life of the share).
#[derive(Clone)]
pub struct Unwrapped {
    pub ring: Keyring,
    pub made_at: u64,
}

/// A share's keyring for one member: boxed (`crypto::box_to`, the authenticated box a device's
/// wrap uses) from the sharer's member key to that member's member key. Only that member opens
/// it, and only as coming from the sharer. `made_at`: when the keyring was made.
pub fn make_wrap(
    sharer: &PrivateKey,
    member_public: &str,
    share: &str,
    ring: &Keyring,
    made_at: u64,
) -> Result<String> {
    let plain = wrap_plain(share, ring.current(), made_at, &ring.to_bytes()?)?;
    let wrap = crypto::box_to(sharer, member_public, &plain)?;
    if wrap.len() > MAX_WRAP_CHARS {
        return Err(Error::Sync(
            "ShareKeys",
            "This share's keys were renewed too often to be handed on. Stop sharing the project, then share it again.".into(),
        ));
    }
    Ok(wrap)
}

/// Why a wrap wasn't taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// It doesn't open as coming from the sharer's key (someone else made it, or it was made
    /// for another member, or it was altered).
    Sender,
    /// It isn't a wrap at all, or its keys aren't valid.
    Format,
    /// It was made for another share.
    Share,
    /// It was made for another generation than the one asked for.
    Generation,
}

/// Opens a wrap the service handed over for the share `share` at `generation`: only as coming
/// from `sharer_public` (the sharer's key as this account pinned it, never as the service names
/// it now), and only when the share and the generation inside are the ones asked for.
pub fn open_wrap(
    member: &PrivateKey,
    sharer_public: &str,
    share: &str,
    generation: u64,
    wrap: &str,
) -> std::result::Result<Unwrapped, Refused> {
    if wrap.len() > MAX_WRAP_CHARS {
        return Err(Refused::Format);
    }
    let plain = member
        .open_from(sharer_public, wrap)
        .map_err(|_| Refused::Sender)?;
    let rest = plain.strip_prefix(WRAP_DOMAIN).ok_or(Refused::Format)?;
    let (length, rest) = rest.split_first_chunk::<2>().ok_or(Refused::Format)?;
    let length = usize::from(u16::from_be_bytes(*length));
    if rest.len() < length + 12 {
        return Err(Refused::Format);
    }
    let (named, rest) = rest.split_at(length);
    if named != share.as_bytes() {
        return Err(Refused::Share);
    }
    let (inside, rest) = rest.split_first_chunk::<4>().ok_or(Refused::Format)?;
    let inside = u32::from_be_bytes(*inside);
    if u64::from(inside) != generation {
        return Err(Refused::Generation);
    }
    let (made_at, keyring) = rest.split_first_chunk::<8>().ok_or(Refused::Format)?;
    let ring = Keyring::from_bytes(keyring).map_err(|_| Refused::Format)?;
    // The keys themselves must be at the generation the wrap says.
    if ring.current() != inside {
        return Err(Refused::Generation);
    }
    Ok(Unwrapped {
        ring,
        made_at: u64::from_be_bytes(*made_at),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn people() -> (PrivateKey, PrivateKey, PrivateKey) {
        (
            PrivateKey::generate().unwrap(),
            PrivateKey::generate().unwrap(),
            PrivateKey::generate().unwrap(),
        )
    }

    #[test]
    fn a_wrap_opens_for_its_member_from_its_sharer() {
        let (sharer, member, _) = people();
        let ring = Keyring::generate().unwrap();
        let wrap = make_wrap(&sharer, &member.public(), "u1.p1", &ring, 77).unwrap();
        let back = open_wrap(&member, &sharer.public(), "u1.p1", 1, &wrap).unwrap();
        assert_eq!(
            back.made_at, 77,
            "which life of the share the keys belong to"
        );
        let back = back.ring;
        assert_eq!(back.to_bytes().unwrap(), ring.to_bytes().unwrap());
        // What the opened keys seal, the sharer's open.
        let sealed = back.seal("records", "snap/1", b"hello").unwrap();
        assert_eq!(ring.open("records", "snap/1", &sealed).unwrap(), b"hello");
        // After new keys: the generation asked for is the one inside.
        let next = ring.rotated().unwrap();
        let wrap = make_wrap(&sharer, &member.public(), "u1.p1", &next, 77).unwrap();
        let back = open_wrap(&member, &sharer.public(), "u1.p1", 2, &wrap).unwrap();
        assert!(back.ring.extends(&ring));
    }

    #[test]
    fn a_wrap_from_anyone_else_is_refused() {
        let (sharer, member, stranger) = people();
        let ring = Keyring::generate().unwrap();
        let wrap = make_wrap(&sharer, &member.public(), "u1.p1", &ring, 77).unwrap();
        // Opened as coming from another key (the service naming a key of its own as the sharer's).
        assert_eq!(
            open_wrap(&member, &stranger.public(), "u1.p1", 1, &wrap).err(),
            Some(Refused::Sender)
        );
        // Made by someone else for this member, with the right words inside.
        let forged = make_wrap(&stranger, &member.public(), "u1.p1", &ring, 77).unwrap();
        assert_eq!(
            open_wrap(&member, &sharer.public(), "u1.p1", 1, &forged).err(),
            Some(Refused::Sender)
        );
        // Another member's wrap.
        assert_eq!(
            open_wrap(&stranger, &sharer.public(), "u1.p1", 1, &wrap).err(),
            Some(Refused::Sender)
        );
        // Sealed to the member without a sender (what whoever stores it could make).
        let sealed = crypto::seal_to(&member.public(), &ring.to_bytes().unwrap()).unwrap();
        assert_eq!(
            open_wrap(&member, &sharer.public(), "u1.p1", 1, &sealed).err(),
            Some(Refused::Sender)
        );
        // Altered on the way.
        let mut bytes = crypto::unb64(&wrap).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        assert_eq!(
            open_wrap(&member, &sharer.public(), "u1.p1", 1, &crypto::b64(&bytes)).err(),
            Some(Refused::Sender)
        );
        assert_eq!(
            open_wrap(&member, &sharer.public(), "u1.p1", 1, "").err(),
            Some(Refused::Sender)
        );
    }

    #[test]
    fn a_wrap_for_another_share_or_generation_is_refused() {
        let (sharer, member, _) = people();
        let ring = Keyring::generate().unwrap();
        let wrap = make_wrap(&sharer, &member.public(), "u1.p1", &ring, 77).unwrap();
        // The same sharer's other share, handed over in this one's place.
        assert_eq!(
            open_wrap(&member, &sharer.public(), "u1.p2", 1, &wrap).err(),
            Some(Refused::Share)
        );
        assert_eq!(
            open_wrap(&member, &sharer.public(), "u1.p", 1, &wrap).err(),
            Some(Refused::Share)
        );
        // An older generation's wrap handed over as the current one, and the other way round.
        assert_eq!(
            open_wrap(&member, &sharer.public(), "u1.p1", 2, &wrap).err(),
            Some(Refused::Generation)
        );
        let next = ring.rotated().unwrap();
        let newer = make_wrap(&sharer, &member.public(), "u1.p1", &next, 77).unwrap();
        assert_eq!(
            open_wrap(&member, &sharer.public(), "u1.p1", 1, &newer).err(),
            Some(Refused::Generation)
        );
        // A generation written on the outside that the keys inside aren't at.
        let lying = crypto::box_to(
            &sharer,
            &member.public(),
            &wrap_plain("u1.p1", 3, 77, &ring.to_bytes().unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(
            open_wrap(&member, &sharer.public(), "u1.p1", 3, &lying).err(),
            Some(Refused::Generation)
        );
    }

    #[test]
    fn a_box_that_isnt_a_wrap_is_refused() {
        let (sharer, member, _) = people();
        let ring = Keyring::generate().unwrap();
        // A device's wrap (the bare keyring, boxed) is not a share's.
        let bare = crypto::box_to(&sharer, &member.public(), &ring.to_bytes().unwrap()).unwrap();
        assert_eq!(
            open_wrap(&member, &sharer.public(), "u1.p1", 1, &bare).err(),
            Some(Refused::Format)
        );
        let when = 77u64.to_be_bytes();
        // The layout before this one (no "when the keyring was made"), under its own first
        // words and under this one's: neither is taken.
        let old = [
            &b"share-wrap-v1\0"[..],
            &[0, 5],
            b"u1.p1",
            &[0, 0, 0, 1],
            &ring.to_bytes().unwrap(),
        ]
        .concat();
        let old_as_new = [
            WRAP_DOMAIN,
            &[0, 5],
            b"u1.p1",
            &[0, 0, 0, 1],
            &ring.to_bytes().unwrap(),
        ]
        .concat();
        for plain in [
            WRAP_DOMAIN.to_vec(),
            [WRAP_DOMAIN, &[0, 200], b"u1.p1"].concat(),
            [WRAP_DOMAIN, &[0, 5], b"u1.p1", &[0, 0, 0, 1]].concat(),
            [WRAP_DOMAIN, &[0, 5], b"u1.p1", &[0, 0, 0, 1], &when[..4]].concat(),
            [
                WRAP_DOMAIN,
                &[0, 5],
                b"u1.p1",
                &[0, 0, 0, 1],
                &when,
                b"not keys",
            ]
            .concat(),
            old,
            old_as_new,
        ] {
            let boxed = crypto::box_to(&sharer, &member.public(), &plain).unwrap();
            assert_eq!(
                open_wrap(&member, &sharer.public(), "u1.p1", 1, &boxed).err(),
                Some(Refused::Format)
            );
        }
    }

    #[test]
    fn the_layout_of_a_wrap_is_fixed() {
        let plain = wrap_plain("u1.p1", 7, 0x0102_0304_0506_0708, b"KEYS").unwrap();
        assert_eq!(
            plain,
            b"share-wrap-v2\0\x00\x05u1.p1\x00\x00\x00\x07\x01\x02\x03\x04\x05\x06\x07\x08KEYS"
                .to_vec()
        );
    }

    #[test]
    fn a_wrap_fits_the_service_until_many_renewals() {
        let (sharer, member, _) = people();
        // The longest id a share can have.
        let share = share_id(&"u".repeat(128), &"p".repeat(64));
        let mut ring = Keyring::generate().unwrap();
        let first = make_wrap(&sharer, &member.public(), &share, &ring, 77).unwrap();
        assert!(first.len() < 800, "{}", first.len());
        // Each renewal adds a key: thirty of them still fit, with room to spare.
        for _ in 0..30 {
            ring = ring.rotated().unwrap();
        }
        let later = make_wrap(&sharer, &member.public(), &share, &ring, 77).unwrap();
        assert!(later.len() <= MAX_WRAP_CHARS, "{}", later.len());
        // Far more don't, and that is said here, before the service is asked.
        for _ in 0..40 {
            ring = ring.rotated().unwrap();
        }
        assert!(matches!(
            make_wrap(&sharer, &member.public(), &share, &ring, 77),
            Err(Error::Sync("ShareKeys", _))
        ));
    }

    #[test]
    fn a_fingerprint_is_thirty_digits_of_the_member_and_the_key() {
        // Fixed keys (bytes 0..=31; thirty-two 0xff), and their fingerprints as another
        // implementation of the derivation in `fingerprint`'s comment gives them.
        let key = crypto::b64(&(0u8..32).collect::<Vec<u8>>());
        assert_eq!(
            fingerprint("u1", &key).unwrap(),
            "55011 59507 81969 49111 81065 89990"
        );
        let other = crypto::b64(&[0xffu8; 32]);
        assert_eq!(
            fingerprint("uid_2", &other).unwrap(),
            "60454 23974 14191 20200 89615 33975"
        );
        // The same key under another member is another fingerprint: a key made to match one
        // member's matches nobody else's.
        assert_eq!(
            fingerprint("u2", &key).unwrap(),
            "01708 52327 90064 64328 24167 33874"
        );
        let print = fingerprint("u1", &PrivateKey::generate().unwrap().public()).unwrap();
        assert_eq!(print.len(), 35);
        assert_eq!(print.split(' ').count(), 6);
        assert!(print.split(' ').all(|g| g.len() == 5));
        assert!(print.chars().all(|c| c.is_ascii_digit() || c == ' '));
        assert!(fingerprint("u1", "short").is_err());
        assert!(fingerprint("u1", "").is_err());
        // Whose key it is must be an account's id.
        assert!(fingerprint("", &key).is_err());
        assert!(fingerprint("u/1", &key).is_err());
        // Compared as digits, however they were typed.
        assert!(same_fingerprint(
            "01234 56789 01234 56789 01234 56789",
            "012345678901234567890123456789"
        ));
        assert!(!same_fingerprint(
            "01234 56789 01234 56789 01234 56789",
            "01234 56789 01234 56789 01234 56780"
        ));
        // The twenty digits a fingerprint had before are no fingerprint.
        assert!(!same_fingerprint(
            "0123 4567 8901 2345 6789",
            "01234567890123456789"
        ));
        assert!(!same_fingerprint("", ""));
    }

    #[test]
    fn ids_are_plain_names() {
        assert_eq!(share_id("u1", "p-1"), "u1.p-1");
        assert_eq!(split_share_id("u1.p-1"), Some(("u1", "p-1")));
        for bad in [
            "",
            "u1",
            "u1.",
            ".p",
            "a.b.c",
            "u1/x.p",
            "u1.p/keys",
            "u 1.p",
            "u1.p?",
        ] {
            assert_eq!(split_share_id(bad), None, "{bad}");
        }
        assert!(valid_project(&"p".repeat(64)) && !valid_project(&"p".repeat(65)));
        assert!(valid_record_id("1800000000000-abc123"));
        assert!(!valid_record_id("../keys") && !valid_record_id("a/b") && !valid_record_id(""));
        assert!(valid_key(&PrivateKey::generate().unwrap().public()));
        assert!(!valid_key("AAAA") && !valid_key(&"A".repeat(44)) && !valid_key(&"!".repeat(43)));
    }
}
