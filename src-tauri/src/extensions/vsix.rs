//! Installing from a `.vsix` file (VS Code's extension package, a ZIP archive): it is unpacked
//! into a scratch folder beside the installed extensions, like a repository download (D185), and
//! the frontend installs the extension folder in it (`extension/`) through `install`, then
//! discards the folder. Only stored and deflated entries are read (what `vsce` writes); names
//! that would land outside the folder, encrypted entries and Zip64 archives are refused, and the
//! sizes are capped so a crafted archive can't fill the disk.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::download::remove_tree;
use super::ExtensionStore;
use crate::error::{Error, Result};

/// The largest archive read (VS Code's biggest extensions are around 100 MB).
const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
/// The most it may unpack to, in all.
const MAX_UNPACKED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 50_000;

fn bad(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}

fn u16_at(bytes: &[u8], at: usize) -> Result<u16> {
    bytes
        .get(at..at + 2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .ok_or_else(|| bad("The archive is damaged (it ends too soon)."))
}

fn u32_at(bytes: &[u8], at: usize) -> Result<u32> {
    bytes
        .get(at..at + 4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .ok_or_else(|| bad("The archive is damaged (it ends too soon)."))
}

/// One file of the archive, from its central directory entry.
pub(crate) struct Entry {
    pub(crate) name: String,
    method: u16,
    crc: u32,
    compressed: u64,
    pub(crate) size: u64,
    local_header: usize,
    /// The Unix mode bits when a Unix tool wrote the archive (ACP agents' zips, D215: the
    /// executable bit, and symlinks, which aren't unpacked as links).
    pub(crate) unix_mode: Option<u32>,
}

/// The central directory's entries (directories left out).
pub(crate) fn entries(bytes: &[u8]) -> Result<Vec<Entry>> {
    // End of central directory: the last signature within 64 KB + 22 bytes of the end.
    let lowest = bytes.len().saturating_sub(65_557);
    let eocd = (lowest..bytes.len().saturating_sub(21))
        .rev()
        .find(|&i| bytes[i..i + 4] == [0x50, 0x4b, 0x05, 0x06])
        .ok_or_else(|| bad("This isn't a .vsix file (no ZIP directory found)."))?;
    let count = u16_at(bytes, eocd + 10)? as usize;
    let mut offset = u32_at(bytes, eocd + 16)? as usize;
    if count == 0xffff || offset == 0xffff_ffff {
        return Err(bad("Zip64 archives aren't supported."));
    }
    if count > MAX_ENTRIES {
        return Err(bad(format!(
            "The archive has more than {MAX_ENTRIES} files."
        )));
    }
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        if u32_at(bytes, offset)? != 0x0201_4b50 {
            return Err(bad("The archive is damaged (bad directory entry)."));
        }
        let made_by = u16_at(bytes, offset + 4)?;
        let external = u32_at(bytes, offset + 38)?;
        let flags = u16_at(bytes, offset + 8)?;
        let method = u16_at(bytes, offset + 10)?;
        let crc = u32_at(bytes, offset + 16)?;
        let compressed = u32_at(bytes, offset + 20)?;
        let size = u32_at(bytes, offset + 24)?;
        let name_len = u16_at(bytes, offset + 28)? as usize;
        let extra_len = u16_at(bytes, offset + 30)? as usize;
        let comment_len = u16_at(bytes, offset + 32)? as usize;
        let local_header = u32_at(bytes, offset + 42)?;
        let raw = bytes
            .get(offset + 46..offset + 46 + name_len)
            .ok_or_else(|| bad("The archive is damaged (a name runs past its end)."))?;
        // Bit 11 says UTF-8; older tools wrote CP437, which is ASCII for the usual names.
        let name = String::from_utf8_lossy(raw).into_owned();
        offset += 46 + name_len + extra_len + comment_len;
        if name.ends_with('/') {
            continue;
        }
        if flags & 1 == 1 {
            return Err(bad(format!("{name} is encrypted.")));
        }
        if compressed == 0xffff_ffff || size == 0xffff_ffff || local_header == 0xffff_ffff {
            return Err(bad("Zip64 archives aren't supported."));
        }
        out.push(Entry {
            name,
            method,
            crc,
            compressed: compressed as u64,
            size: size as u64,
            local_header: local_header as usize,
            unix_mode: (made_by >> 8 == 3).then_some(external >> 16),
        });
    }
    Ok(out)
}

/// The relative path an entry unpacks to, or None for a name that would leave the folder
/// (absolute, `..`, a drive, NUL).
pub fn safe_relative(name: &str) -> Option<PathBuf> {
    let name = name.replace('\\', "/");
    if name.contains('\0') || name.starts_with('/') || name.contains(':') {
        return None;
    }
    let mut out = PathBuf::new();
    for part in Path::new(&name).components() {
        match part {
            Component::Normal(p) if windows_reserved(&p.to_string_lossy()) => return None,
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// A Windows device name (CON, NUL, COM1, LPT1…, with any extension) or a name ending in a dot or
/// space: writing one opens a device or a different file on Windows, so it's refused everywhere.
pub(crate) fn windows_reserved(part: &str) -> bool {
    if part.ends_with('.') || part.ends_with(' ') {
        return true;
    }
    let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || ((stem.starts_with("COM") || stem.starts_with("LPT"))
        && stem.len() == 4
        && stem.as_bytes()[3].is_ascii_digit())
}

/// One entry's bytes, checked against its size and CRC.
pub(crate) fn read_entry(bytes: &[u8], entry: &Entry) -> Result<Vec<u8>> {
    let at = entry.local_header;
    if u32_at(bytes, at)? != 0x0403_4b50 {
        return Err(bad(format!(
            "{} is damaged (bad local header).",
            entry.name
        )));
    }
    let start = at + 30 + u16_at(bytes, at + 26)? as usize + u16_at(bytes, at + 28)? as usize;
    let data = bytes
        .get(start..start + entry.compressed as usize)
        .ok_or_else(|| bad(format!("{} runs past the end of the archive.", entry.name)))?;
    let out = match entry.method {
        0 => data.to_vec(),
        8 => {
            // Not the declared size up front: a tiny entry claiming 1 GB would allocate it
            // (deflate expands at most ~1032×).
            let cap = entry.size.min(entry.compressed.saturating_mul(1032));
            let mut out = Vec::with_capacity(cap.min(64 * 1024 * 1024) as usize);
            // One byte more than promised: an entry that inflates to more is refused.
            flate2::read::DeflateDecoder::new(data)
                .take(entry.size + 1)
                .read_to_end(&mut out)
                .map_err(|e| bad(format!("{} can't be unpacked: {e}", entry.name)))?;
            out
        }
        other => {
            return Err(bad(format!(
                "{} uses a compression method the IDE can't read ({other}).",
                entry.name
            )))
        }
    };
    if out.len() as u64 != entry.size {
        return Err(bad(format!(
            "{} isn't the size the archive says.",
            entry.name
        )));
    }
    let mut crc = flate2::Crc::new();
    crc.update(&out);
    if crc.sum() != entry.crc {
        return Err(bad(format!("{} is damaged (checksum).", entry.name)));
    }
    Ok(out)
}

/// Unpacks a ZIP archive's bytes into `dest` (which must exist).
pub fn unpack(bytes: &[u8], dest: &Path) -> Result<usize> {
    let list = entries(bytes)?;
    let total: u64 = list.iter().map(|e| e.size).sum();
    if total > MAX_UNPACKED_BYTES {
        return Err(bad("The archive unpacks to more than 1 GB."));
    }
    let mut written = 0;
    for entry in &list {
        let Some(rel) = safe_relative(&entry.name) else {
            // Outside the folder, or a name Windows can't hold (`aux.js`, a trailing dot, `:`).
            return Err(bad(format!(
                "{} isn't a safe file name inside an extension (outside its folder, or a name Windows reserves).",
                entry.name
            )));
        };
        let data = read_entry(bytes, entry)?;
        let target = dest.join(rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&target, data)?;
        written += 1;
    }
    Ok(written)
}

impl ExtensionStore {
    /// Unpacks a `.vsix` (or `.zip`) into a new scratch folder under the downloads; returns it.
    /// `discard_download` deletes it.
    pub fn unpack_vsix(&self, file: &Path) -> Result<PathBuf> {
        let lower = file.to_string_lossy().to_ascii_lowercase();
        if !(lower.ends_with(".vsix") || lower.ends_with(".zip")) {
            return Err(bad("Choose a .vsix file."));
        }
        let size = fs::metadata(file)?.len();
        if size > MAX_ARCHIVE_BYTES {
            return Err(bad("The file is larger than 256 MB."));
        }
        let bytes = fs::read(file)?;
        let parent = self.downloads();
        fs::create_dir_all(&parent)?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let dest = parent.join(format!("vsix-{stamp}"));
        fs::create_dir_all(&dest)?;
        if let Err(e) = unpack(&bytes, &dest) {
            let _ = remove_tree(&dest);
            return Err(e);
        }
        Ok(dest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A small ZIP writer for the tests: (name, data, deflate?).
    fn zip(files: &[(&str, &[u8], bool)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, data, deflate) in files {
            let mut crc = flate2::Crc::new();
            crc.update(data);
            let body = if *deflate {
                let mut e =
                    flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                e.write_all(data).unwrap();
                e.finish().unwrap()
            } else {
                data.to_vec()
            };
            let method: u16 = if *deflate { 8 } else { 0 };
            let offset = out.len() as u32;
            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&[20, 0, 0, 0]);
            out.extend_from_slice(&method.to_le_bytes());
            out.extend_from_slice(&[0; 4]);
            out.extend_from_slice(&crc.sum().to_le_bytes());
            out.extend_from_slice(&(body.len() as u32).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&[0, 0]);
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&body);
            central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            central.extend_from_slice(&[20, 0, 20, 0, 0, 0]);
            central.extend_from_slice(&method.to_le_bytes());
            central.extend_from_slice(&[0; 4]);
            central.extend_from_slice(&crc.sum().to_le_bytes());
            central.extend_from_slice(&(body.len() as u32).to_le_bytes());
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&[0; 12]);
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let dir_offset = out.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&dir_offset.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ide-vsix-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn unpacks_stored_and_deflated_entries() {
        let dir = temp("ok");
        let manifest =
            br#"{"name":"x","publisher":"p","engines":{"vscode":"^1.80.0"},"contributes":{}}"#;
        let archive = zip(&[
            ("extension.vsixmanifest", b"<xml/>", false),
            ("extension/package.json", manifest, true),
            ("extension/themes/dark.json", &[b'a'; 5000], true),
        ]);
        assert_eq!(unpack(&archive, &dir).unwrap(), 3);
        assert_eq!(
            fs::read(dir.join("extension/package.json")).unwrap(),
            manifest.to_vec()
        );
        assert_eq!(
            fs::read(dir.join("extension/themes/dark.json"))
                .unwrap()
                .len(),
            5000
        );
        assert_eq!(
            super::super::download::find_manifests(&dir),
            vec!["extension".to_string()]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unpacks_the_gui_tests_vsix() {
        // tests/fixtures/extensions/dawn-theme.vsix, written by another ZIP writer (Node's zlib).
        let file = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/extensions/dawn-theme.vsix");
        let dir = temp("fixture");
        assert_eq!(unpack(&fs::read(file).unwrap(), &dir).unwrap(), 3);
        assert!(fs::read_to_string(dir.join("extension/package.json"))
            .unwrap()
            .contains("dawn-theme"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_names_outside_and_damage() {
        assert!(safe_relative("../evil").is_none());
        assert!(safe_relative("a/../../evil").is_none());
        assert!(safe_relative("/etc/passwd").is_none());
        assert!(safe_relative("C:\\x").is_none());
        assert!(safe_relative("..\\x").is_none());
        assert_eq!(safe_relative("./a/b"), Some(PathBuf::from("a/b")));
        // Windows devices and trailing dots (D200 review).
        assert!(safe_relative("extension/CON").is_none());
        assert!(safe_relative("extension/com1.txt").is_none());
        assert!(safe_relative("extension/a.").is_none());
        assert!(safe_relative("extension/console.js").is_some());
        assert!(safe_relative("extension/COM10").is_some());
        let dir = temp("bad");
        assert!(unpack(&zip(&[("../evil.txt", b"x", false)]), &dir).is_err());
        assert!(!dir.join("../evil.txt").exists());
        assert!(unpack(b"not a zip at all, not even close", &dir).is_err());
        let mut damaged = zip(&[("a.txt", b"hello", false)]);
        // Flip a byte of the data: the checksum catches it.
        damaged[30 + 5] ^= 0xff;
        assert!(unpack(&damaged, &dir).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
