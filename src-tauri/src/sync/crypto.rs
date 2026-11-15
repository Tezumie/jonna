//! Sync's cryptography (D435). Nothing here is invented: each piece is a well-known construction
//! from a maintained library.
//!
//! - **A device** has an X25519 key pair. The private half never leaves the computer.
//! - **The keyring** is the account's secret: one random 32-byte key per generation (a new
//!   generation is added when a device is removed) and a key for naming chunks. It is stored on
//!   the server only as a *sealed box* (libsodium's `crypto_box_seal`) to each device's public
//!   key, and to the recovery key's.
//! - **The recovery key** is one more X25519 private key, shown to the user once as text. Any
//!   device can wrap the keyring to its public half without knowing the private one.
//! - **Content** (records, chunks) is sealed with XChaCha20-Poly1305 under a key derived from a
//!   generation's key with HKDF-SHA256, with a random 24-byte nonce, bound to where it is
//!   stored (the associated data), so the server can't pass one item off as another.
//! - **A chunk's id** is HMAC-SHA256 of its content under the keyring's id key (first 16
//!   bytes): the same content has the same id, and the id says nothing about the content.

use std::io::{Read, Write};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use crypto_box::{PublicKey, SecretKey};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2_10::{Digest, Sha256};

use crate::error::{Error, Result};

const FORMAT: u8 = 1;
const NONCE_LEN: usize = 24;
/// What a sealed item starts with: the format, then the key generation.
const HEADER_LEN: usize = 1 + 4;
/// The most a sealed item may unpack to (a chunk is a few megabytes; this stops a "bomb").
const MAX_PLAIN: u64 = 64 * 1024 * 1024;

fn keys_error(message: &str) -> Error {
    Error::Sync("SyncKeys", message.to_string())
}

pub fn random<const N: usize>() -> Result<[u8; N]> {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).map_err(|e| keys_error(&format!("no randomness: {e}")))?;
    Ok(out)
}

pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn unb64(text: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(text.as_bytes())
        .map_err(|_| keys_error("a stored value isn't valid"))
}

/// A random id, 22 characters (a device, or anything else that needs a name).
pub fn new_id() -> Result<String> {
    Ok(b64(&random::<16>()?))
}

// ---------------------------------------------------------------- key pairs

/// An X25519 private key: a device's, or the recovery key.
#[derive(Clone)]
pub struct PrivateKey(SecretKey);

impl PrivateKey {
    pub fn generate() -> Result<Self> {
        Ok(Self(SecretKey::from(random::<32>()?)))
    }

    pub fn from_text(text: &str) -> Result<Self> {
        let bytes: [u8; 32] = unb64(text)?
            .try_into()
            .map_err(|_| keys_error("a stored key isn't valid"))?;
        Ok(Self(SecretKey::from(bytes)))
    }

    pub fn to_text(&self) -> String {
        b64(&self.0.to_bytes())
    }

    /// The public half, as it is sent to the server.
    pub fn public(&self) -> String {
        b64(self.0.public_key().as_bytes())
    }

    /// Answers the service's challenge: proof that this key's private half is held, without
    /// showing it. X25519 with the service's one-time public key gives a secret only the two
    /// share; the answer is HMAC-SHA256 of the challenge's nonce under it.
    pub fn prove(&self, their_public: &str, nonce: &str) -> Result<String> {
        let theirs: [u8; 32] = unb64(their_public)?
            .try_into()
            .map_err(|_| keys_error("the service's challenge isn't valid"))?;
        let shared =
            curve25519_dalek::montgomery::MontgomeryPoint(theirs).mul_clamped(self.0.to_bytes());
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(shared.as_bytes())
            .map_err(|_| keys_error("a key isn't valid"))?;
        mac.update(format!("sync-proof:{nonce}").as_bytes());
        Ok(b64(&mac.finalize().into_bytes()))
    }

    /// The recovery key's second half: a key for checking that a keyring wrapped to the
    /// recovery key was wrapped by one of the account's devices (which keep this in their
    /// sealed list), not made up by whoever stores it.
    pub fn auth_key(&self) -> Result<String> {
        let mut out = [0u8; 32];
        Hkdf::<Sha256>::new(None, &self.0.to_bytes())
            .expand(b"sync-recovery-auth", &mut out)
            .map_err(|_| keys_error("a key couldn't be derived"))?;
        Ok(b64(&out))
    }

    /// Opens the keyring wrapped to this recovery key, and checks it is the account's own.
    pub fn open_recovery(&self, sealed: &str) -> Result<Vec<u8>> {
        let wrong = || {
            Error::Sync(
                "SyncRecoveryKey",
                "That recovery key isn't this account's current one.".to_string(),
            )
        };
        let plain = self.open(sealed).map_err(|_| wrong())?;
        if plain.len() <= 32 {
            return Err(wrong());
        }
        let (bytes, tag) = plain.split_at(plain.len() - 32);
        let key = unb64(&self.auth_key()?)?;
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&key).map_err(|_| wrong())?;
        mac.update(bytes);
        // Constant time: the comparison is the library's.
        mac.verify_slice(tag).map_err(|_| wrong())?;
        Ok(bytes.to_vec())
    }

    /// Opens what was sealed to this key's public half.
    pub fn open(&self, sealed: &str) -> Result<Vec<u8>> {
        self.0
            .unseal(&unb64(sealed)?)
            .map_err(|_| keys_error("the keys couldn't be opened on this device"))
    }
}

/// Seals `plain` so only the holder of `public`'s private half can read it.
pub fn seal_to(public: &str, plain: &[u8]) -> Result<String> {
    let bytes: [u8; 32] = unb64(public)?
        .try_into()
        .map_err(|_| keys_error("a device's key isn't valid"))?;
    let mut rng = crypto_box::aead::OsRng;
    let sealed = PublicKey::from(bytes)
        .seal(&mut rng, plain)
        .map_err(|_| keys_error("the keys couldn't be wrapped"))?;
    Ok(b64(&sealed))
}

/// Wraps the keyring for the recovery key: sealed to its public half, with a tag under its
/// auth key, so the computer that later opens it knows one of the account's devices made it.
pub fn recovery_wrap(public: &str, auth: &str, keyring: &[u8]) -> Result<String> {
    let key = unb64(auth)?;
    let mut mac =
        <Hmac<Sha256> as Mac>::new_from_slice(&key).map_err(|_| keys_error("a key isn't valid"))?;
    mac.update(keyring);
    let mut plain = keyring.to_vec();
    plain.extend_from_slice(&mac.finalize().into_bytes());
    seal_to(public, &plain)
}

/// Six digits both computers show, so the person approving sees it is the same device (and
/// that nobody in between swapped its key). `nonce` is chosen by the approving computer after
/// it has fixed which key it would approve, so a key can't be picked to fit a code.
pub fn verification_code(public: &str, nonce: &str) -> String {
    let digest = Sha256::digest(format!("{public}:{nonce}").as_bytes());
    let n = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
    format!("{:03} {:03}", n / 1000, n % 1000)
}

// ---------------------------------------------------------------- the recovery key as text

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// The recovery key as the user keeps it: groups of four characters (Crockford's base 32: no
/// I, L, O or U), ending in a checksum so a mistyped key is told from a wrong one.
pub fn recovery_text(key: &PrivateKey) -> String {
    let mut bytes = key.0.to_bytes().to_vec();
    let check = Sha256::digest(&bytes);
    bytes.extend_from_slice(&check[..3]);
    // 35 bytes are 280 bits: exactly 56 characters.
    let mut out = String::new();
    let mut acc: u32 = 0;
    let mut bits = 0;
    let mut count = 0;
    for b in bytes {
        acc = (acc << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            if count > 0 && count % 4 == 0 {
                out.push('-');
            }
            out.push(ALPHABET[((acc >> bits) & 31) as usize] as char);
            count += 1;
        }
    }
    out
}

/// Reads a typed recovery key: case, spaces and dashes don't matter, and the letters people
/// confuse are taken as the digits they look like.
pub fn parse_recovery(text: &str) -> Result<PrivateKey> {
    let wrong = || {
        Error::Sync(
            "SyncRecoveryKey",
            "That isn't a recovery key. Check it for typos.".to_string(),
        )
    };
    let mut bytes = Vec::with_capacity(35);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in text.chars() {
        if c.is_whitespace() || c == '-' {
            continue;
        }
        let c = match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            other => other,
        };
        let value = ALPHABET
            .iter()
            .position(|&a| a as char == c)
            .ok_or_else(wrong)?;
        acc = (acc << 5) | value as u32;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            bytes.push(((acc >> bits) & 0xff) as u8);
        }
    }
    if bytes.len() != 35 {
        return Err(wrong());
    }
    let (key, check) = bytes.split_at(32);
    if Sha256::digest(key)[..3] != *check {
        return Err(wrong());
    }
    let key: [u8; 32] = key.try_into().map_err(|_| wrong())?;
    Ok(PrivateKey(SecretKey::from(key)))
}

// ---------------------------------------------------------------- the keyring

#[derive(Clone, Serialize, Deserialize)]
struct Generation {
    generation: u32,
    key: String,
}

/// The account's keys. New content is sealed under the newest generation; older content stays
/// readable with the generation it names.
#[derive(Clone, Serialize, Deserialize)]
pub struct Keyring {
    /// Names chunks; the same for the vault's whole life, so unchanged content keeps its id.
    id_key: String,
    generations: Vec<Generation>,
}

impl Keyring {
    pub fn generate() -> Result<Self> {
        Ok(Self {
            id_key: b64(&random::<32>()?),
            generations: vec![Generation {
                generation: 1,
                key: b64(&random::<32>()?),
            }],
        })
    }

    /// The same keyring with one more generation (after a device was removed).
    pub fn rotated(&self) -> Result<Self> {
        let mut next = self.clone();
        next.generations.push(Generation {
            generation: self.current() + 1,
            key: b64(&random::<32>()?),
        });
        Ok(next)
    }

    pub fn current(&self) -> u32 {
        self.generations
            .iter()
            .map(|g| g.generation)
            .max()
            .unwrap_or(0)
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        Ok(serde_json::to_vec(self)?)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        let ring: Self =
            serde_json::from_slice(bytes).map_err(|_| keys_error("the keys aren't valid"))?;
        if ring.generations.is_empty() {
            return Err(keys_error("the keys aren't valid"));
        }
        Ok(ring)
    }

    /// The key content of `purpose` is sealed with, in a generation.
    fn content_key(&self, generation: u32, purpose: &str) -> Result<[u8; 32]> {
        let g = self
            .generations
            .iter()
            .find(|g| g.generation == generation)
            .ok_or_else(|| keys_error("this was saved with keys this device doesn't have yet"))?;
        let ikm = unb64(&g.key)?;
        let mut out = [0u8; 32];
        Hkdf::<Sha256>::new(None, &ikm)
            .expand(purpose.as_bytes(), &mut out)
            .map_err(|_| keys_error("a key couldn't be derived"))?;
        Ok(out)
    }

    /// Seals `plain` for storing at `place` (a record's or a chunk's name).
    pub fn seal(&self, purpose: &str, place: &str, plain: &[u8]) -> Result<Vec<u8>> {
        let generation = self.current();
        let key = self.content_key(generation, purpose)?;
        let nonce = random::<NONCE_LEN>()?;
        let packed = pack(plain)?;
        let sealed = XChaCha20Poly1305::new((&key).into())
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &packed,
                    aad: place.as_bytes(),
                },
            )
            .map_err(|_| keys_error("sealing failed"))?;
        let mut out = Vec::with_capacity(HEADER_LEN + NONCE_LEN + sealed.len());
        out.push(FORMAT);
        out.extend_from_slice(&generation.to_be_bytes());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&sealed);
        Ok(out)
    }

    /// Opens what `seal` made for the same purpose and place.
    pub fn open(&self, purpose: &str, place: &str, sealed: &[u8]) -> Result<Vec<u8>> {
        if sealed.len() < HEADER_LEN + NONCE_LEN || sealed[0] != FORMAT {
            return Err(keys_error(
                "a synced item isn't in a format this version reads",
            ));
        }
        let generation = u32::from_be_bytes([sealed[1], sealed[2], sealed[3], sealed[4]]);
        let key = self.content_key(generation, purpose)?;
        let (nonce, body) = sealed[HEADER_LEN..].split_at(NONCE_LEN);
        let packed = XChaCha20Poly1305::new((&key).into())
            .decrypt(
                XNonce::from_slice(nonce),
                Payload {
                    msg: body,
                    aad: place.as_bytes(),
                },
            )
            .map_err(|_| {
                keys_error("a synced item couldn't be opened (wrong keys, or it was altered)")
            })?;
        unpack(&packed)
    }

    /// The id of a chunk with this content.
    pub fn chunk_id(&self, plain: &[u8]) -> Result<String> {
        let key = unb64(&self.id_key)?;
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&key)
            .map_err(|_| keys_error("a key isn't valid"))?;
        mac.update(plain);
        Ok(b64(&mac.finalize().into_bytes()[..16]))
    }

    /// A stable name derived from `text` under the id key (a project's id from its remote).
    pub fn name_of(&self, text: &str) -> Result<String> {
        self.chunk_id(format!("name\0{text}").as_bytes())
    }
}

/// Deflates when that makes it smaller; the first byte says which.
fn pack(plain: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = flate2::write::DeflateEncoder::new(vec![1u8], flate2::Compression::fast());
    encoder.write_all(plain)?;
    let deflated = encoder.finish()?;
    if deflated.len() < plain.len() {
        return Ok(deflated);
    }
    let mut out = Vec::with_capacity(plain.len() + 1);
    out.push(0);
    out.extend_from_slice(plain);
    Ok(out)
}

fn unpack(packed: &[u8]) -> Result<Vec<u8>> {
    match packed.split_first() {
        Some((0, rest)) => Ok(rest.to_vec()),
        Some((1, rest)) => {
            let mut out = Vec::new();
            flate2::read::DeflateDecoder::new(rest)
                .take(MAX_PLAIN + 1)
                .read_to_end(&mut out)?;
            if out.len() as u64 > MAX_PLAIN {
                return Err(keys_error("a synced item is larger than allowed"));
            }
            Ok(out)
        }
        _ => Err(keys_error(
            "a synced item isn't in a format this version reads",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_keyring_sealed_to_a_device_opens_only_there() {
        let device = PrivateKey::generate().unwrap();
        let other = PrivateKey::generate().unwrap();
        let ring = Keyring::generate().unwrap();
        let wrap = seal_to(&device.public(), &ring.to_bytes().unwrap()).unwrap();
        let back = Keyring::from_bytes(&device.open(&wrap).unwrap()).unwrap();
        assert_eq!(back.current(), 1);
        assert_eq!(back.to_bytes().unwrap(), ring.to_bytes().unwrap());
        assert!(other.open(&wrap).is_err());
        // A device key survives being stored as text.
        let again = PrivateKey::from_text(&device.to_text()).unwrap();
        assert!(again.open(&wrap).is_ok());
    }

    #[test]
    fn content_round_trips_and_is_bound_to_its_place() {
        let ring = Keyring::generate().unwrap();
        let text = "{\"editor.fontSize\": 14}".repeat(50);
        let sealed = ring
            .seal("records", "settings/user", text.as_bytes())
            .unwrap();
        assert!(sealed.len() < text.len(), "repetitive text is deflated");
        assert_eq!(
            ring.open("records", "settings/user", &sealed).unwrap(),
            text.as_bytes()
        );
        assert!(
            ring.open("records", "settings/other", &sealed).is_err(),
            "moved to another name"
        );
        assert!(
            ring.open("chunks", "settings/user", &sealed).is_err(),
            "another purpose"
        );
        let mut altered = sealed.clone();
        *altered.last_mut().unwrap() ^= 1;
        assert!(ring.open("records", "settings/user", &altered).is_err());
        assert!(Keyring::generate()
            .unwrap()
            .open("records", "settings/user", &sealed)
            .is_err());
        // Two seals of the same content differ (a fresh nonce each time).
        assert_ne!(
            sealed,
            ring.seal("records", "settings/user", text.as_bytes())
                .unwrap()
        );
        // Content that doesn't deflate is stored as it is.
        let noise = random::<64>().unwrap();
        let sealed = ring.seal("chunks", "x", &noise).unwrap();
        assert_eq!(ring.open("chunks", "x", &sealed).unwrap(), noise);
        assert_eq!(
            ring.open("chunks", "x", &ring.seal("chunks", "x", b"").unwrap())
                .unwrap(),
            b""
        );
    }

    #[test]
    fn a_new_generation_reads_the_old_and_the_old_ring_cant_read_the_new() {
        let old = Keyring::generate().unwrap();
        let before = old.seal("records", "a", b"before").unwrap();
        let new = old.rotated().unwrap();
        assert_eq!(new.current(), 2);
        assert_eq!(new.open("records", "a", &before).unwrap(), b"before");
        let after = new.seal("records", "a", b"after").unwrap();
        assert!(
            old.open("records", "a", &after).is_err(),
            "a removed device's keys"
        );
        // Chunk ids don't move with a rotation, so nothing uploads twice.
        assert_eq!(
            old.chunk_id(b"same").unwrap(),
            new.chunk_id(b"same").unwrap()
        );
    }

    #[test]
    fn chunk_ids_are_stable_and_keyed() {
        let ring = Keyring::generate().unwrap();
        let id = ring.chunk_id(b"hello").unwrap();
        assert_eq!(id.len(), 22);
        assert_eq!(id, ring.chunk_id(b"hello").unwrap());
        assert_ne!(id, ring.chunk_id(b"hello!").unwrap());
        assert_ne!(id, Keyring::generate().unwrap().chunk_id(b"hello").unwrap());
        assert_ne!(ring.name_of("hello").unwrap(), id);
    }

    #[test]
    fn the_recovery_key_survives_being_typed() {
        let key = PrivateKey::generate().unwrap();
        let text = recovery_text(&key);
        assert_eq!(text.len(), 56 + 13);
        assert!(text.split('-').all(|g| g.len() == 4));
        let ring = Keyring::generate().unwrap();
        let wrap = seal_to(&key.public(), &ring.to_bytes().unwrap()).unwrap();
        let typed = text
            .to_lowercase()
            .replace('-', " ")
            .replace('0', "o")
            .replace('1', "l");
        assert!(parse_recovery(&typed).unwrap().open(&wrap).is_ok());
        // One wrong character is caught by the checksum, not by failing to open.
        let mut chars: Vec<char> = text.chars().collect();
        chars[0] = if chars[0] == 'A' { 'B' } else { 'A' };
        let wrong: String = chars.into_iter().collect();
        assert!(matches!(
            parse_recovery(&wrong),
            Err(Error::Sync("SyncRecoveryKey", _))
        ));
        assert!(parse_recovery("ABCD-EFGH").is_err());
        assert!(parse_recovery("").is_err());
    }

    #[test]
    fn a_recovery_wrap_opens_only_when_a_device_made_it() {
        let recovery = PrivateKey::generate().unwrap();
        let ring = Keyring::generate().unwrap().to_bytes().unwrap();
        let wrap = recovery_wrap(&recovery.public(), &recovery.auth_key().unwrap(), &ring).unwrap();
        assert_eq!(recovery.open_recovery(&wrap).unwrap(), ring);
        // Whoever stores it can seal anything to the public key, but can't make the tag.
        let forged = seal_to(
            &recovery.public(),
            &Keyring::generate().unwrap().to_bytes().unwrap(),
        )
        .unwrap();
        assert!(matches!(
            recovery.open_recovery(&forged),
            Err(Error::Sync("SyncRecoveryKey", _))
        ));
        let other = PrivateKey::generate().unwrap();
        let wrong_tag =
            recovery_wrap(&recovery.public(), &other.auth_key().unwrap(), &ring).unwrap();
        assert!(recovery.open_recovery(&wrong_tag).is_err());
        assert!(other.open_recovery(&wrap).is_err());
    }

    #[test]
    fn a_proof_is_what_the_other_side_computes() {
        // Two key pairs agree on the secret, so each can check the other's answer.
        let device = PrivateKey::generate().unwrap();
        let service = PrivateKey::generate().unwrap();
        let from_device = device.prove(&service.public(), "nonce").unwrap();
        let from_service = service.prove(&device.public(), "nonce").unwrap();
        assert_eq!(from_device, from_service);
        assert_ne!(
            from_device,
            device.prove(&service.public(), "other").unwrap()
        );
        let stranger = PrivateKey::generate().unwrap();
        assert_ne!(
            from_device,
            stranger.prove(&service.public(), "nonce").unwrap()
        );
    }

    #[test]
    fn the_verification_code_is_six_digits() {
        let key = PrivateKey::generate().unwrap();
        let code = verification_code(&key.public(), "n1");
        assert_eq!(code.len(), 7);
        assert_eq!(code, verification_code(&key.public(), "n1"));
        assert_ne!(
            code,
            verification_code(&key.public(), "another nonce, another code")
        );
        assert!(code.chars().all(|c| c.is_ascii_digit() || c == ' '));
    }
}
