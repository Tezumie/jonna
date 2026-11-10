//! Unpacking an ACP agent's download (D215): `.zip` (the in-house reader of `extensions::vsix`),
//! `.tar.gz` / `.tgz` (tar + flate2), `.tar.bz2` / `.tbz2` (tar + bzip2) or a raw binary.
//! Every entry lands inside the destination: names with `..`, absolute paths, drives or Windows
//! device names are refused (zip slip), nothing is written through a symlink, and a symlink is
//! only created when its target is relative and stays inside the folder (else the archive is
//! refused). Hard links are copied from a file already unpacked; devices and FIFOs are skipped.
//! Sizes are capped so a crafted archive can't fill the disk. Modes keep only the executable bit.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::extensions::vsix::{self, safe_relative, windows_reserved};

/// The most an archive may unpack to, in all.
pub const MAX_UNPACKED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 200_000;
/// The largest zip read (it's read into memory; tarballs are streamed).
pub const MAX_ZIP_BYTES: u64 = 1024 * 1024 * 1024;

fn bad(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Zip,
    TarGz,
    TarBz2,
    Raw,
}

/// The archive's kind from its address's path (`…/kimi-1.52.0-x86_64.tar.gz`).
pub fn kind_of(path: &str) -> Result<Kind> {
    let p = path.to_ascii_lowercase();
    if p.ends_with(".zip") {
        Ok(Kind::Zip)
    } else if p.ends_with(".tar.gz") || p.ends_with(".tgz") {
        Ok(Kind::TarGz)
    } else if p.ends_with(".tar.bz2") || p.ends_with(".tbz2") {
        Ok(Kind::TarBz2)
    } else if [
        ".tar",
        ".xz",
        ".7z",
        ".rar",
        ".dmg",
        ".pkg",
        ".deb",
        ".rpm",
        ".msi",
        ".appimage",
    ]
    .iter()
    .any(|e| p.ends_with(e))
    {
        Err(bad(format!(
            "{path}: the IDE can't unpack this kind of download"
        )))
    } else {
        Ok(Kind::Raw)
    }
}

struct Budget {
    bytes: u64,
    entries: usize,
}

impl Budget {
    fn new() -> Self {
        Budget {
            bytes: MAX_UNPACKED_BYTES,
            entries: MAX_ENTRIES,
        }
    }
    fn entry(&mut self) -> Result<()> {
        if self.entries == 0 {
            return Err(bad(format!(
                "The archive has more than {MAX_ENTRIES} files."
            )));
        }
        self.entries -= 1;
        Ok(())
    }
}

/// `dest/rel`, with its parent folders created; refuses to go through a symlink or a file. An
/// existing symlink at `rel` itself is removed (never written through).
fn prepare(dest: &Path, rel: &Path) -> Result<PathBuf> {
    let parts: Vec<_> = rel.components().collect();
    let mut at = dest.to_path_buf();
    for (i, part) in parts.iter().enumerate() {
        at.push(part);
        let last = i + 1 == parts.len();
        match fs::symlink_metadata(&at) {
            Ok(m) if m.file_type().is_symlink() => {
                if last {
                    fs::remove_file(&at)?;
                } else {
                    return Err(bad(format!(
                        "{} would be written through a link.",
                        rel.display()
                    )));
                }
            }
            Ok(m) if !last && !m.is_dir() => {
                return Err(bad(format!(
                    "{} is inside a file of the archive.",
                    rel.display()
                )))
            }
            Ok(m) if last && m.is_dir() => {
                return Err(bad(format!(
                    "{} is both a folder and a file.",
                    rel.display()
                )))
            }
            Ok(_) => {}
            Err(_) if !last => fs::create_dir(&at)?,
            Err(_) => {}
        }
    }
    Ok(at)
}

fn ensure_dir(dest: &Path, rel: &Path) -> Result<()> {
    let mut at = dest.to_path_buf();
    for part in rel.components() {
        at.push(part);
        match fs::symlink_metadata(&at) {
            Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(bad(format!(
                    "{} is a folder and something else.",
                    rel.display()
                )))
            }
            Err(_) => fs::create_dir(&at)?,
        }
    }
    Ok(())
}

/// Only the executable bit is kept (no setuid, no world-writable files).
#[cfg(unix)]
pub fn set_mode(path: &Path, executable: bool) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(
        path,
        fs::Permissions::from_mode(if executable { 0o755 } else { 0o644 }),
    )?;
    Ok(())
}

#[cfg(not(unix))]
pub fn set_mode(_path: &Path, _executable: bool) -> Result<()> {
    Ok(())
}

/// A symlink target that stays inside the folder: relative, only leading `..`s (each from a real
/// folder, since nothing is unpacked through a link), never above the folder itself.
pub fn safe_link_target(link: &Path, target: &str) -> Option<PathBuf> {
    if target.is_empty()
        || target.starts_with('/')
        || target.contains('\\')
        || target.contains(':')
        || target.contains('\0')
    {
        return None;
    }
    let depth = link.components().count().saturating_sub(1);
    let mut ups = 0;
    let mut descended = false;
    for part in target.split('/') {
        match part {
            "" | "." => {}
            ".." if descended => return None,
            ".." => ups += 1,
            p if windows_reserved(p) => return None,
            _ => descended = true,
        }
    }
    (ups <= depth && descended).then(|| PathBuf::from(target))
}

#[cfg(unix)]
fn make_link(dest: &Path, rel: &Path, target: &Path) -> Result<()> {
    let at = prepare(dest, rel)?;
    if at.exists() {
        fs::remove_file(&at)?;
    }
    std::os::unix::fs::symlink(target, &at)?;
    Ok(())
}

/// Windows: links need a privilege most users lack; the agents' Windows builds are zips of
/// plain files, so a link is skipped.
#[cfg(not(unix))]
fn make_link(_dest: &Path, _rel: &Path, _target: &Path) -> Result<()> {
    Ok(())
}

fn write_from(
    dest: &Path,
    rel: &Path,
    reader: &mut dyn Read,
    executable: bool,
    budget: &mut Budget,
) -> Result<()> {
    let path = prepare(dest, rel)?;
    let mut file = fs::File::create(&path)?;
    let written = io::copy(&mut reader.take(budget.bytes + 1), &mut file)?;
    if written > budget.bytes {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(bad("The archive unpacks to more than 4 GB."));
    }
    budget.bytes -= written;
    set_mode(&path, executable)
}

/// The name an entry unpacks to; None for the archive's own folder (`./`).
fn entry_path(name: &str) -> Result<Option<PathBuf>> {
    let trimmed = name.replace('\\', "/");
    if trimmed.trim_matches(|c| c == '.' || c == '/').is_empty() && !trimmed.contains("..") {
        return Ok(None);
    }
    safe_relative(&trimmed).map(Some).ok_or_else(|| {
        bad(format!(
            "{name} would be written outside the agent's folder."
        ))
    })
}

/// A zip's entries into `dest` (which exists).
pub fn unpack_zip(bytes: &[u8], dest: &Path) -> Result<usize> {
    let list = vsix::entries(bytes)?;
    let total: u64 = list.iter().map(|e| e.size).sum();
    if total > MAX_UNPACKED_BYTES {
        return Err(bad("The archive unpacks to more than 4 GB."));
    }
    let mut budget = Budget::new();
    let mut count = 0;
    for entry in &list {
        budget.entry()?;
        let Some(rel) = entry_path(&entry.name)? else {
            continue;
        };
        let mode = entry.unix_mode.unwrap_or(0o644);
        let data = vsix::read_entry(bytes, entry)?;
        if mode & 0o170_000 == 0o120_000 {
            let target = String::from_utf8_lossy(&data).into_owned();
            let Some(target) = safe_link_target(&rel, &target) else {
                return Err(bad(format!(
                    "{} links outside the agent's folder.",
                    entry.name
                )));
            };
            make_link(dest, &rel, &target)?;
            continue;
        }
        write_from(
            dest,
            &rel,
            &mut data.as_slice(),
            mode & 0o111 != 0,
            &mut budget,
        )?;
        count += 1;
    }
    Ok(count)
}

/// A tarball's entries into `dest` (which exists).
pub fn unpack_tar(reader: impl Read, dest: &Path) -> Result<usize> {
    let mut archive = tar::Archive::new(reader);
    let mut budget = Budget::new();
    let mut count = 0;
    let damaged = |e: io::Error| bad(format!("The archive is damaged: {e}"));
    for entry in archive.entries().map_err(damaged)? {
        let mut entry = entry.map_err(damaged)?;
        budget.entry()?;
        let name = String::from_utf8_lossy(&entry.path_bytes()).into_owned();
        let Some(rel) = entry_path(&name)? else {
            continue;
        };
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            ensure_dir(dest, &rel)?;
        } else if kind.is_file() || kind.is_contiguous() {
            let executable = entry
                .header()
                .mode()
                .map(|m| m & 0o111 != 0)
                .unwrap_or(false);
            write_from(dest, &rel, &mut entry, executable, &mut budget)?;
            count += 1;
        } else if kind.is_symlink() {
            let target = entry
                .link_name_bytes()
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .unwrap_or_default();
            let Some(target) = safe_link_target(&rel, &target) else {
                return Err(bad(format!("{name} links outside the agent's folder.")));
            };
            make_link(dest, &rel, &target)?;
        } else if kind.is_hard_link() {
            let source = entry
                .link_name_bytes()
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .unwrap_or_default();
            let Some(source) = entry_path(&source)? else {
                return Err(bad(format!("{name} is a link to nothing.")));
            };
            let from = dest.join(&source);
            match fs::symlink_metadata(&from) {
                Ok(m) if m.is_file() => {
                    let mut file = fs::File::open(&from)?;
                    let executable = is_executable(&m);
                    write_from(dest, &rel, &mut file, executable, &mut budget)?;
                    count += 1;
                }
                _ => return Err(bad(format!("{name} links to a file it doesn't have."))),
            }
        }
        // Devices, FIFOs and other entry kinds aren't unpacked.
    }
    Ok(count)
}

#[cfg(unix)]
fn is_executable(m: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    m.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_m: &fs::Metadata) -> bool {
    false
}

/// Unpacks the downloaded `file` (of `kind`) into `dest` (which exists); a raw binary is copied
/// in as `raw_name` (the command's file name).
pub fn unpack(kind: Kind, file: &Path, dest: &Path, raw_name: &str) -> Result<usize> {
    match kind {
        Kind::Zip => {
            if fs::metadata(file)?.len() > MAX_ZIP_BYTES {
                return Err(bad("The zip is larger than 1 GB."));
            }
            unpack_zip(&fs::read(file)?, dest)
        }
        Kind::TarGz => unpack_tar(
            flate2::read::GzDecoder::new(io::BufReader::new(fs::File::open(file)?)),
            dest,
        ),
        Kind::TarBz2 => unpack_tar(
            bzip2::read::BzDecoder::new(io::BufReader::new(fs::File::open(file)?)),
            dest,
        ),
        Kind::Raw => {
            let Some(rel) = entry_path(raw_name)? else {
                return Err(bad("The agent's command has no file name."));
            };
            let mut budget = Budget::new();
            write_from(dest, &rel, &mut fs::File::open(file)?, true, &mut budget)?;
            Ok(1)
        }
    }
}

/// The agent's command inside `dir`: the registry's `cmd` (`./dist\\agent.cmd`), a file that
/// resolves inside `dir` (a link out of it is refused), made executable. Its absolute path.
pub fn resolve_command(dir: &Path, cmd: &str) -> Result<PathBuf> {
    let rel = entry_path(cmd)?.ok_or_else(|| bad("The agent's command has no file name."))?;
    let path = dir.join(rel);
    let real = fs::canonicalize(&path)
        .map_err(|_| bad(format!("The download has no {cmd} (the agent's command).")))?;
    let root = fs::canonicalize(dir)?;
    if !real.starts_with(&root) || !real.is_file() {
        return Err(bad(format!(
            "{cmd} isn't a program inside the agent's folder."
        )));
    }
    #[cfg(unix)]
    set_mode(&real, true)?;
    Ok(crate::store::simplify(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ide-acp-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A tarball with (name, kind, data-or-link-target, mode).
    fn tarball(entries: &[(&str, tar::EntryType, &[u8], u32)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (name, kind, data, mode) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(*kind);
            header.set_mode(*mode);
            // Names are set raw: `set_path` refuses `..`, which is what the tests need.
            let bytes = name.as_bytes();
            header.as_old_mut().name[..bytes.len()].copy_from_slice(bytes);
            if kind.is_symlink() || kind.is_hard_link() {
                header.set_size(0);
                let target = &mut header.as_old_mut().linkname;
                target[..data.len()].copy_from_slice(data);
                header.set_cksum();
                builder.append(&header, io::empty()).unwrap();
            } else {
                header.set_size(data.len() as u64);
                header.set_cksum();
                builder.append(&header, *data).unwrap();
            }
        }
        builder.into_inner().unwrap()
    }

    fn gz(bytes: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        e.write_all(bytes).unwrap();
        e.finish().unwrap()
    }

    #[test]
    fn kinds_from_the_address() {
        assert_eq!(kind_of("/a/kimi.tar.gz").unwrap(), Kind::TarGz);
        assert_eq!(kind_of("/a/x.TGZ").unwrap(), Kind::TarGz);
        assert_eq!(kind_of("/a/goose.tar.bz2").unwrap(), Kind::TarBz2);
        assert_eq!(kind_of("/a/k.zip").unwrap(), Kind::Zip);
        assert_eq!(kind_of("/a/sigit-linux-amd64").unwrap(), Kind::Raw);
        assert_eq!(kind_of("/a/sigit.exe").unwrap(), Kind::Raw);
        assert!(kind_of("/a/x.dmg").is_err());
        assert!(kind_of("/a/x.tar.xz").is_err());
    }

    #[test]
    fn unpacks_a_tarball_with_modes_and_inside_links() {
        let dir = temp("tar-ok");
        let tar = tarball(&[
            ("pkg/", tar::EntryType::Directory, b"", 0o755),
            (
                "pkg/bin/agent",
                tar::EntryType::Regular,
                b"#!/bin/sh\necho hi\n",
                0o4755,
            ),
            ("pkg/README", tar::EntryType::Regular, b"read me", 0o666),
            ("pkg/bin/alias", tar::EntryType::Symlink, b"agent", 0o777),
            ("pkg/up", tar::EntryType::Symlink, b"../pkg/README", 0o777),
            ("pkg/copy", tar::EntryType::Link, b"pkg/README", 0o644),
        ]);
        let packed = gz(&tar);
        let file = dir
            .join("..")
            .join(format!("ide-acp-tgz-{}.tar.gz", std::process::id()));
        fs::write(&file, &packed).unwrap();
        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();
        assert_eq!(unpack(Kind::TarGz, &file, &out, "").unwrap(), 3);
        let _ = fs::remove_file(&file);
        let dir = out;
        assert_eq!(fs::read(dir.join("pkg/copy")).unwrap(), b"read me");
        let cmd = resolve_command(&dir, "./pkg/bin/agent").unwrap();
        assert!(cmd.ends_with("pkg/bin/agent"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &str| fs::metadata(dir.join(p)).unwrap().permissions().mode() & 0o7777;
            assert_eq!(mode("pkg/bin/agent"), 0o755, "setuid dropped");
            assert_eq!(mode("pkg/README"), 0o644, "not world-writable");
            assert_eq!(
                fs::read_link(dir.join("pkg/bin/alias")).unwrap(),
                PathBuf::from("agent")
            );
            assert!(resolve_command(&dir, "pkg/bin/alias").is_ok());
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_zip_slip_and_escaping_links() {
        let dir = temp("slip");
        let outside = dir
            .parent()
            .unwrap()
            .join(format!("ide-acp-evil-{}", std::process::id()));
        let _ = fs::remove_file(&outside);
        let name = format!("../{}", outside.file_name().unwrap().to_string_lossy());
        for tar in [
            tarball(&[(&name, tar::EntryType::Regular, b"x", 0o644)]),
            tarball(&[("/etc/evil", tar::EntryType::Regular, b"x", 0o644)]),
            tarball(&[("a/../../evil", tar::EntryType::Regular, b"x", 0o644)]),
            // A link out, then a file written through it.
            tarball(&[
                ("out", tar::EntryType::Symlink, b"..", 0o777),
                ("out/evil", tar::EntryType::Regular, b"x", 0o644),
            ]),
            tarball(&[("abs", tar::EntryType::Symlink, b"/etc/passwd", 0o777)]),
            tarball(&[("a/b", tar::EntryType::Symlink, b"x/../../..", 0o777)]),
            tarball(&[("hard", tar::EntryType::Link, b"../../etc/passwd", 0o644)]),
        ] {
            let target = temp("slip-one");
            assert!(unpack_tar(tar.as_slice(), &target).is_err());
            let _ = fs::remove_dir_all(&target);
        }
        assert!(!outside.exists());
        // A link inside, then a file through it, is refused too (never written through links).
        let tar = tarball(&[
            ("real/", tar::EntryType::Directory, b"", 0o755),
            ("alias", tar::EntryType::Symlink, b"real", 0o777),
            ("alias/file", tar::EntryType::Regular, b"x", 0o644),
        ]);
        let target = temp("through");
        // Symlinks can't be made without privileges on Windows: checked on Unix only.
        #[cfg(unix)]
        assert!(unpack_tar(tar.as_slice(), &target).is_err());
        #[cfg(not(unix))]
        let _ = tar;
        let _ = fs::remove_dir_all(&target);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A stored (uncompressed) zip with Unix modes: (name, data, mode).
    fn zip(files: &[(&str, &[u8], u32)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, data, mode) in files {
            let mut crc = flate2::Crc::new();
            crc.update(data);
            let offset = out.len() as u32;
            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            out.extend_from_slice(&crc.sum().to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&[0, 0]);
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(data);
            central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            // Made by Unix (3), version 2.0.
            central.extend_from_slice(&[20, 3, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            central.extend_from_slice(&crc.sum().to_le_bytes());
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&[0; 8]);
            central.extend_from_slice(&(mode << 16).to_le_bytes());
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

    #[test]
    fn zips_keep_the_executable_bit_and_refuse_slips() {
        let dir = temp("zip-ok");
        let archive = zip(&[
            ("dist/kimi", b"#!/bin/sh\n", 0o100_755),
            ("dist/notes.txt", b"n", 0o100_644),
            ("dist/alias", b"kimi", 0o120_777),
        ]);
        assert_eq!(unpack_zip(&archive, &dir).unwrap(), 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &str| fs::metadata(dir.join(p)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode("dist/kimi"), 0o755);
            assert_eq!(mode("dist/notes.txt"), 0o644);
            assert!(fs::symlink_metadata(dir.join("dist/alias"))
                .unwrap()
                .file_type()
                .is_symlink());
        }
        for bad in [
            zip(&[("../evil", b"x", 0o100_644)]),
            zip(&[("..\\evil", b"x", 0o100_644)]),
            zip(&[("C:/evil", b"x", 0o100_644)]),
            zip(&[("dist/CON", b"x", 0o100_644)]),
            zip(&[("out", b"/etc", 0o120_777)]),
            zip(&[("out", b"..", 0o120_777), ("out/evil", b"x", 0o100_644)]),
        ] {
            let target = temp("zip-bad");
            assert!(unpack_zip(&bad, &target).is_err());
            let _ = fs::remove_dir_all(&target);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn link_targets() {
        let at = |l: &str, t: &str| safe_link_target(Path::new(l), t).is_some();
        assert!(at("bin/node", "../lib/node"));
        assert!(at("node", "lib/node"));
        assert!(!at("node", "../x"));
        assert!(!at("a/b", "../../x"));
        assert!(!at("a/b", "x/../../y"));
        assert!(!at("a", "/etc/passwd"));
        assert!(!at("a", "C:\\x"));
        assert!(!at("a", ".."));
    }

    #[test]
    fn raw_binary_and_missing_command() {
        let dir = temp("raw");
        let file = dir.join("download");
        fs::write(&file, b"\x7fELF").unwrap();
        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();
        assert_eq!(
            unpack(Kind::Raw, &file, &out, "./sigit-linux-amd64").unwrap(),
            1
        );
        assert!(resolve_command(&out, "./sigit-linux-amd64").is_ok());
        assert!(resolve_command(&out, "./other").is_err());
        assert!(resolve_command(&out, "../download").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unpacks_a_bzip2_tarball() {
        let dir = temp("bz2");
        let tar = tarball(&[("goose", tar::EntryType::Regular, b"#!/bin/sh\n", 0o755)]);
        let mut e = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::fast());
        e.write_all(&tar).unwrap();
        let file = dir.join("goose.tar.bz2");
        fs::write(&file, e.finish().unwrap()).unwrap();
        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();
        assert_eq!(unpack(Kind::TarBz2, &file, &out, "").unwrap(), 1);
        assert!(resolve_command(&out, "./goose").is_ok());
        let _ = fs::remove_dir_all(&dir);
    }
}
