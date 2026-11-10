//! Getting the server running on the remote, over the one transport connection (one sign-in):
//! a small sh script (`script`) prints the remote's `uname -sm`, then either starts the
//! installed server (`~/<serverDir>/<version>-<hash>/ide-server`, the hash of the binary this
//! app bundles, so a rebuilt one is never mistaken for an installed one) or asks for it, reads
//! exactly the bytes the app sends (`head -c`), makes it executable, moves it in place and starts
//! it. From the server's start on, the same pipe speaks the framed protocol.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

/// What the setup script's own lines start with (anything else, from a chatty shell profile,
/// is ignored).
const MARK: &str = "@@remote-setup";
const BINARY: &str = "ide-server";
/// A line of setup output is at most this long.
const MAX_LINE: usize = 64 * 1024;

/// The Linux builds the app bundles: `uname -m` names, then the Rust target they're built for.
pub const TARGETS: [(&str, &str); 2] = [
    ("x86_64", "x86_64-unknown-linux-musl"),
    ("aarch64", "aarch64-unknown-linux-musl"),
];

/// The server crate's version (`src-tauri/remote-server/Cargo.toml`): what `hello` and
/// `--version` say.
pub fn server_version() -> &'static str {
    static VERSION: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    VERSION.get_or_init(|| {
        crate_version(include_str!("../../remote-server/Cargo.toml")).unwrap_or_default()
    })
}

fn crate_version(manifest: &str) -> Option<String> {
    let mut in_package = false;
    for line in manifest.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_package = line == "[package]";
            continue;
        }
        if in_package {
            if let Some(rest) = line.strip_prefix("version") {
                let value = rest
                    .trim_start()
                    .strip_prefix('=')?
                    .trim()
                    .trim_matches('"');
                return safe_word(value).then(|| value.to_string());
            }
        }
    }
    None
}

/// The server's folder in the remote's home: product.json's `serverDataFolderName`
/// (".ide-server" style), so the server never names the product itself.
pub fn server_dir_name() -> &'static str {
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        serde_json::from_str::<serde_json::Value>(include_str!("../../../product.json"))
            .ok()
            .and_then(|v| v.get("serverDataFolderName")?.as_str().map(str::to_string))
            .filter(|n| safe_word(n))
            .unwrap_or_else(|| ".ide-server".into())
    })
}

/// Letters, digits and `._-`, not starting with `-`: safe in the setup script without quoting.
fn safe_word(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Where the bundled server for `target` is: next to the app's resources when installed, next
/// to the program, or (development builds) in `src-tauri/resources/server/`.
pub fn bundled(resource_dir: Option<&Path>, target: &str) -> Option<PathBuf> {
    let rel = Path::new("server").join(target).join(BINARY);
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = resource_dir {
        candidates.push(dir.join(&rel));
        candidates.push(dir.join("resources").join(&rel));
    }
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(Path::to_path_buf))
    {
        candidates.push(dir.join(&rel));
        candidates.push(dir.join("resources").join(&rel));
    }
    if cfg!(debug_assertions) {
        candidates.push(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join(&rel),
        );
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// The first 12 hex digits of the file's SHA-256, kept per path while its size and time stay.
pub fn short_hash(path: &Path) -> Result<String> {
    type Key = (PathBuf, u64, Option<std::time::SystemTime>);
    static CACHE: Mutex<Option<HashMap<Key, String>>> = Mutex::new(None);
    let meta = std::fs::metadata(path)?;
    let key: Key = (path.to_path_buf(), meta.len(), meta.modified().ok());
    if let Some(hit) = CACHE
        .lock()
        .ok()
        .and_then(|c| c.as_ref().and_then(|m| m.get(&key).cloned()))
    {
        return Ok(hit);
    }
    let bytes = std::fs::read(path)?;
    let digest = Sha256::digest(&bytes);
    let hex: String = digest.iter().take(6).map(|b| format!("{b:02x}")).collect();
    if let Ok(mut cache) = CACHE.lock() {
        cache
            .get_or_insert_with(HashMap::new)
            .insert(key, hex.clone());
    }
    Ok(hex)
}

/// The bundled builds: (uname -m name, its file, its short hash); one that isn't bundled has
/// none (a remote of that kind is told so).
pub fn bundled_builds(
    resource_dir: Option<&Path>,
) -> Vec<(&'static str, Option<(PathBuf, String)>)> {
    TARGETS
        .iter()
        .map(|(arch, target)| {
            let found =
                bundled(resource_dir, target).and_then(|p| short_hash(&p).ok().map(|h| (p, h)));
            (*arch, found)
        })
        .collect()
}

/// The setup script, for `sh -c` on the remote. No single quotes, backslashes or `!` in it (it
/// travels inside single quotes through the user's login shell, csh and fish included).
pub fn script(dir: &str, version: &str, hashes: &[(&str, Option<&str>)]) -> String {
    let hash = |arch: &str| {
        hashes
            .iter()
            .find(|(a, _)| *a == arch)
            .and_then(|(_, h)| *h)
            .filter(|h| safe_word(h))
            .unwrap_or("none")
            .to_string()
    };
    let (x86, arm) = (hash("x86_64"), hash("aarch64"));
    [
        format!("M={MARK}"),
        "echo \"$M uname $(uname -sm)\"".into(),
        "case \"$(uname -s)\" in Linux) ;; *) echo \"$M unsupported\"; exit 3;; esac".into(),
        format!(
            "case \"$(uname -m)\" in x86_64|amd64) H={x86};; aarch64|arm64) H={arm};; *) echo \"$M unsupported\"; exit 3;; esac"
        ),
        format!("D=\"$HOME/{dir}/{version}-$H\""),
        format!("S=\"$D/{BINARY}\""),
        format!(
            "if [ -x \"$S\" ] && [ \"$(\"$S\" --version 2>/dev/null)\" = \"{version}\" ]; then echo \"$M ready\"; exec \"$S\" --stdio; fi"
        ),
        "echo \"$M upload\"".into(),
        "read n || exit 4".into(),
        "mkdir -p \"$D\" && head -c \"$n\" > \"$S.$$\" && [ $(wc -c < \"$S.$$\") -eq \"$n\" ] && chmod 755 \"$S.$$\" && mv -f \"$S.$$\" \"$S\" || { rm -f \"$S.$$\"; echo \"$M failed\"; exit 4; }".into(),
        "echo \"$M ready\"".into(),
        "exec \"$S\" --stdio".into(),
    ]
    .join("; ")
}

/// What the remote said about itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Uname {
    pub os: String,
    pub arch: String,
}

/// Follows the setup script on the transport's output until the server runs. `binary` gives
/// the server build for a `uname -m` (its bytes) when the remote asks for it; `progress` hears
/// each step. Returns the remote's `uname -sm`.
pub fn handshake(
    reader: &mut impl BufRead,
    writer: &mut impl Write,
    binary: &dyn Fn(&str) -> Result<Vec<u8>>,
    progress: &dyn Fn(&str),
) -> Result<Uname> {
    let mut uname: Option<Uname> = None;
    loop {
        let Some(line) = read_line(reader)? else {
            return Err(Error::Exec(
                "the remote ended the connection before the server started".into(),
            ));
        };
        let Some(rest) = line.strip_prefix(MARK).map(str::trim) else {
            continue;
        };
        let (word, tail) = rest.split_once(' ').unwrap_or((rest, ""));
        match word {
            "uname" => {
                let mut parts = tail.split_whitespace();
                uname = Some(Uname {
                    os: parts.next().unwrap_or("").to_string(),
                    arch: parts.next().unwrap_or("").to_string(),
                });
            }
            "ready" => {
                return uname.ok_or_else(|| Error::Exec("the remote didn't say what it is".into()))
            }
            "unsupported" => {
                let u = uname.unwrap_or(Uname {
                    os: "?".into(),
                    arch: "?".into(),
                });
                return Err(Error::Exec(format!(
                    "The remote runs {} on {}: only Linux on x86_64 or arm64 is supported.",
                    u.os, u.arch
                )));
            }
            "upload" => {
                let arch = uname.as_ref().map(|u| u.arch.clone()).unwrap_or_default();
                let bytes = binary(normalize_arch(&arch))?;
                progress(&format!(
                    "Installing the server ({:.1} MB)…",
                    bytes.len() as f64 / 1024.0 / 1024.0
                ));
                writer.write_all(format!("{}\n", bytes.len()).as_bytes())?;
                writer.write_all(&bytes)?;
                writer.flush()?;
                progress("Starting the server…");
            }
            "failed" => {
                return Err(Error::Exec(
                    "Installing the server on the remote failed (is the home folder writable, with space left?).".into(),
                ))
            }
            _ => {}
        }
    }
}

/// `amd64` / `arm64` as the build names call them.
pub fn normalize_arch(arch: &str) -> &str {
    match arch {
        "amd64" => "x86_64",
        "arm64" => "aarch64",
        other => other,
    }
}

fn read_line(reader: &mut impl BufRead) -> Result<Option<String>> {
    let mut buf = Vec::new();
    let n = std::io::Read::take(&mut *reader, MAX_LINE as u64).read_until(b'\n', &mut buf)?;
    if n == 0 {
        return Ok(None);
    }
    Ok(Some(
        String::from_utf8_lossy(&buf)
            .trim_end_matches(['\r', '\n'])
            .to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_and_names_come_from_the_manifests() {
        assert_eq!(
            crate_version(
                "[package]\nname = \"x\"\nversion = \"1.2.3\"\n[dependencies]\nversion = \"9\""
            ),
            Some("1.2.3".into())
        );
        assert_eq!(crate_version("[dependencies]\nversion = \"9\""), None);
        assert!(!server_version().is_empty());
        assert!(safe_word(server_dir_name()));
        assert!(!safe_word("a b") && !safe_word("-x") && !safe_word("a'b") && !safe_word(""));
    }

    #[test]
    fn the_script_is_safe_inside_single_quotes() {
        let s = script(
            ".srv",
            "0.1.0",
            &[("x86_64", Some("abcdef012345")), ("aarch64", None)],
        );
        assert!(!s.contains('\'') && !s.contains('\\') && !s.contains('!') && !s.contains('\n'));
        assert!(s.contains("x86_64|amd64) H=abcdef012345;;"));
        assert!(s.contains("aarch64|arm64) H=none;;"));
        assert!(s.contains("D=\"$HOME/.srv/0.1.0-$H\""));
        // A hash that isn't a plain word never reaches the script.
        let odd = script(".srv", "0.1.0", &[("x86_64", Some("$(rm -rf ~)"))]);
        assert!(odd.contains("H=none"));
    }

    #[test]
    fn the_handshake_starts_an_installed_server() {
        let out = b"Welcome from .bashrc\n@@remote-setup uname Linux x86_64\n@@remote-setup ready\n\0\0\0\x02{}";
        let mut reader = std::io::BufReader::new(&out[..]);
        let mut sent = Vec::new();
        let u = handshake(&mut reader, &mut sent, &|_| panic!("no upload"), &|_| {}).unwrap();
        assert_eq!(u.arch, "x86_64");
        assert!(sent.is_empty());
        // What follows "ready" is the protocol, still in the reader.
        let mut rest = Vec::new();
        std::io::Read::read_to_end(&mut reader, &mut rest).unwrap();
        assert_eq!(rest, b"\0\0\0\x02{}");
    }

    #[test]
    fn the_handshake_uploads_the_build_the_remote_asks_for() {
        let out =
            b"@@remote-setup uname Linux arm64\n@@remote-setup upload\n@@remote-setup ready\n";
        let mut reader = std::io::BufReader::new(&out[..]);
        let mut sent = Vec::new();
        let steps = std::cell::RefCell::new(Vec::new());
        handshake(
            &mut reader,
            &mut sent,
            &|arch| {
                assert_eq!(arch, "aarch64");
                Ok(b"ELF".to_vec())
            },
            &|m| steps.borrow_mut().push(m.to_string()),
        )
        .unwrap();
        assert_eq!(sent, b"3\nELF");
        assert_eq!(steps.borrow().len(), 2);
        let bad = b"@@remote-setup uname Darwin arm64\n@@remote-setup unsupported\n";
        let err = handshake(
            &mut std::io::BufReader::new(&bad[..]),
            &mut Vec::new(),
            &|_| Ok(vec![]),
            &|_| {},
        )
        .unwrap_err();
        assert!(err.to_string().contains("Darwin"));
        let cut = b"@@remote-setup uname Linux x86_64\n";
        assert!(handshake(
            &mut std::io::BufReader::new(&cut[..]),
            &mut Vec::new(),
            &|_| Ok(vec![]),
            &|_| {}
        )
        .is_err());
    }
}
