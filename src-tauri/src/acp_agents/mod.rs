//! External ACP agents from the ACP agent registry (D215). The registry file is fetched from its
//! CDN (cached in `<data>/acp-agents/registry.json`; the frontend falls back to that and then to
//! its bundled snapshot), icons likewise (`icons/<id>.svg`, checked again by the frontend). A
//! binary agent is downloaded for this platform into `<data>/acp-agents/<id>/<version>/`: the
//! download streams to a scratch folder beside it with progress and can be cancelled, its
//! SHA-256 is checked when the registry gives one, it is unpacked safely (`archive`), and only
//! then moved into place (older versions are removed). Only https addresses (test builds also
//! take http://127.0.0.1 and localhost, for the UI tests' local registry).

pub mod archive;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};

pub const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const MAX_REGISTRY_BYTES: usize = 8 * 1024 * 1024;
const MAX_ICON_BYTES: usize = 64 * 1024;
const ICON_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// The largest download (Cursor's and Antigravity's packages are a few hundred MB at most).
const MAX_DOWNLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// No bytes for this long: the download is given up.
const STALL: Duration = Duration::from_secs(60);

fn bad(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}

/// The registry's name for this machine's platform (`linux-x86_64`, `windows-aarch64`…).
pub fn platform() -> Option<&'static str> {
    Some(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-aarch64",
        ("macos", "x86_64") => "darwin-x86_64",
        ("linux", "aarch64") => "linux-aarch64",
        ("linux", "x86_64") => "linux-x86_64",
        ("windows", "aarch64") => "windows-aarch64",
        ("windows", "x86_64") => "windows-x86_64",
        _ => return None,
    })
}

pub fn root(data: &Path) -> PathBuf {
    data.join("acp-agents")
}

/// A registry id: a plain lowercase token (it names a folder).
pub fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(c))
        && !crate::extensions::vsix::windows_reserved(id)
}

fn valid_version(v: &str) -> bool {
    let b = v.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && b[0].is_ascii_alphanumeric()
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || b"._+-".contains(c))
        && !v.ends_with('.')
}

/// Test builds only: a local address (the UI tests serve a registry and an archive).
fn loopback(url: &reqwest::Url) -> bool {
    cfg!(debug_assertions)
        && url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
}

/// An address agents and their icons may come from: https to a public host (an IP literal must be
/// public), or a local one in test builds.
pub fn allowed(url: &reqwest::Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    loopback(url) || (url.scheme() == "https" && crate::ipc::remote_image::allowed(url))
}

pub(crate) fn parse_url(url: &str) -> Result<reqwest::Url> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|e| bad(format!("{url}: {e}")))?;
    if !allowed(&parsed) {
        return Err(bad(format!(
            "{url}: agents are only downloaded over https from public addresses"
        )));
    }
    Ok(parsed)
}

fn client(local: bool) -> reqwest::Client {
    static REMOTE: OnceLock<reqwest::Client> = OnceLock::new();
    static LOCAL: OnceLock<reqwest::Client> = OnceLock::new();
    let build = |local: bool| {
        let mut b = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .user_agent("acp-client")
            // GitHub's release links redirect to its download host; each hop is checked.
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 8 || !allowed(attempt.url()) {
                    attempt.stop()
                } else {
                    attempt.follow()
                }
            }));
        if local {
            b = b.no_proxy();
        }
        b.build().unwrap_or_default()
    };
    if local {
        LOCAL.get_or_init(|| build(true)).clone()
    } else {
        REMOTE.get_or_init(|| build(false)).clone()
    }
}

async fn fetch_small(url: &reqwest::Url, max: usize, timeout: Duration) -> Result<Vec<u8>> {
    let response = client(loopback(url))
        .get(url.clone())
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| bad(format!("{url}: {e}")))?;
    if !response.status().is_success() {
        return Err(bad(format!("{url}: {}", response.status())));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| bad(format!("{url}: {e}")))?;
        if bytes.len() + chunk.len() > max {
            return Err(bad(format!("{url}: larger than {} KB", max / 1024)));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// The registry file from `url` (default: the CDN's latest; another address only in test
/// builds), kept as the cached copy. Its text (the frontend parses and checks it).
pub async fn fetch_registry(data: &Path, url: Option<&str>) -> Result<String> {
    let url = match url {
        Some(u) if u != REGISTRY_URL && !cfg!(debug_assertions) => {
            return Err(bad("Only test builds read another registry."))
        }
        Some(u) => u,
        None => REGISTRY_URL,
    };
    let parsed = parse_url(url)?;
    let bytes = fetch_small(&parsed, MAX_REGISTRY_BYTES, Duration::from_secs(30)).await?;
    let text = String::from_utf8(bytes).map_err(|_| bad("The registry isn't UTF-8 text."))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| bad(format!("The registry isn't JSON: {e}")))?;
    if !value.get("agents").is_some_and(|a| a.is_array()) {
        return Err(bad("The file isn't an agent registry (no agents list)."));
    }
    let dir = root(data);
    fs::create_dir_all(&dir)?;
    crate::store::atomic_write(&dir.join("registry.json"), text.as_bytes())?;
    Ok(text)
}

/// The registry file fetched last time, if any.
pub fn cached_registry(data: &Path) -> Option<String> {
    let path = root(data).join("registry.json");
    if fs::metadata(&path).ok()?.len() > MAX_REGISTRY_BYTES as u64 {
        return None;
    }
    fs::read_to_string(path).ok()
}

/// An agent's icon (SVG text), cached for a week; the cached one when it can't be fetched.
pub async fn fetch_icon(data: &Path, id: &str, url: &str) -> Result<Option<String>> {
    if !valid_id(id) {
        return Err(bad(format!("{id} isn't an agent id")));
    }
    let dir = root(data).join("icons");
    let path = dir.join(format!("{id}.svg"));
    let cached = fs::read_to_string(&path).ok();
    let fresh = fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age < ICON_MAX_AGE);
    if cached.is_some() && fresh {
        return Ok(cached);
    }
    let fetched = async {
        let parsed = parse_url(url)?;
        let bytes = fetch_small(&parsed, MAX_ICON_BYTES, Duration::from_secs(15)).await?;
        let text = String::from_utf8(bytes).map_err(|_| bad("not text"))?;
        if !text.contains("<svg") {
            return Err(bad("not an SVG"));
        }
        Ok(text)
    }
    .await;
    match fetched {
        Ok(text) => {
            fs::create_dir_all(&dir)?;
            crate::store::atomic_write(&path, text.as_bytes())?;
            Ok(Some(text))
        }
        Err(_) if cached.is_some() => Ok(cached),
        Err(e) => Err(e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    pub id: String,
    pub version: String,
    pub archive: String,
    pub sha256: Option<String>,
    pub cmd: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// download, verify, unpack or done.
    pub phase: &'static str,
    pub received: u64,
    pub total: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    /// The agent's command, an absolute path.
    pub command: String,
    pub dir: String,
    /// The download matched the registry's SHA-256 (false: it gave none).
    pub verified: bool,
    pub bytes: u64,
}

fn installs() -> &'static Mutex<HashMap<String, CancellationToken>> {
    static INSTALLS: OnceLock<Mutex<HashMap<String, CancellationToken>>> = OnceLock::new();
    INSTALLS.get_or_init(Default::default)
}

/// Stops an install under way; whether there was one.
pub fn cancel(id: &str) -> bool {
    let token = installs().lock().ok().and_then(|m| m.get(id).cloned());
    token.map(|t| t.cancel()).is_some()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Whether the file's SHA-256 is `expected` (hex, any case).
pub fn sha256_matches(actual: &[u8], expected: &str) -> bool {
    hex(actual).eq_ignore_ascii_case(expected.trim())
}

/// Downloads `url` into `file`, hashing as it goes; the digest and size. Also the speech models'
/// download (D384).
pub(crate) async fn download(
    url: &reqwest::Url,
    file: &Path,
    cancel: &CancellationToken,
    progress: &(dyn Fn(Progress) + Send + Sync),
) -> Result<(Vec<u8>, u64)> {
    let request = client(loopback(url)).get(url.clone()).send();
    let response = tokio::select! {
        r = request => r.map_err(|e| bad(format!("{url}: {e}")))?,
        _ = cancel.cancelled() => return Err(Error::Cancelled),
    };
    if !response.status().is_success() {
        return Err(bad(format!("{url}: {}", response.status())));
    }
    let total = response.content_length();
    if total.is_some_and(|t| t > MAX_DOWNLOAD_BYTES) {
        return Err(bad("The download is larger than 2 GB."));
    }
    let mut out = tokio::fs::File::create(file).await?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut stream = response.bytes_stream();
    let mut told = Instant::now();
    progress(Progress {
        phase: "download",
        received,
        total,
    });
    loop {
        let next = tokio::select! {
            n = tokio::time::timeout(STALL, stream.next()) => n,
            _ = cancel.cancelled() => return Err(Error::Cancelled),
        };
        let chunk = match next {
            Err(_) => return Err(bad(format!("{url}: the download stalled"))),
            Ok(None) => break,
            Ok(Some(c)) => c.map_err(|e| bad(format!("{url}: {e}")))?,
        };
        received += chunk.len() as u64;
        if received > MAX_DOWNLOAD_BYTES {
            return Err(bad("The download is larger than 2 GB."));
        }
        hasher.update(&chunk);
        out.write_all(&chunk).await?;
        if told.elapsed() > Duration::from_millis(150) {
            told = Instant::now();
            progress(Progress {
                phase: "download",
                received,
                total,
            });
        }
    }
    out.flush().await?;
    out.sync_all().await?;
    if total.is_some_and(|t| t != received) {
        return Err(bad(format!("{url}: the download ended early")));
    }
    Ok((hasher.finalize().to_vec(), received))
}

/// Downloads, checks, unpacks and puts a binary agent in place (see the module docs).
pub async fn install(
    data: &Path,
    req: InstallRequest,
    progress: impl Fn(Progress) + Send + Sync + 'static,
) -> Result<Installed> {
    install_into(&root(data), req, progress).await
}

/// `install` into `<base>/<id>/<version>/`: also the pinned Node.js runtime's (D267).
pub async fn install_into(
    base: &Path,
    req: InstallRequest,
    progress: impl Fn(Progress) + Send + Sync + 'static,
) -> Result<Installed> {
    if !valid_id(&req.id) || !valid_version(&req.version) {
        return Err(bad("That isn't an agent id and version."));
    }
    let url = parse_url(&req.archive)?;
    let kind = archive::kind_of(url.path())?;
    let expected = req
        .sha256
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if expected
        .as_deref()
        .is_some_and(|s| s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(bad("The registry's SHA-256 isn't one."));
    }
    let raw_name = req
        .cmd
        .replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_string();
    let token = CancellationToken::new();
    {
        let mut map = installs().lock().map_err(|_| bad("busy"))?;
        if map.contains_key(&req.id) {
            return Err(bad(format!("{} is being installed already.", req.id)));
        }
        map.insert(req.id.clone(), token.clone());
    }
    let agent_dir = base.join(&req.id);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let scratch = agent_dir.join(format!(".partial-{stamp}"));
    let result = async {
        if fs::symlink_metadata(&agent_dir).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(bad("The agent's folder is a link."));
        }
        let files = scratch.join("files");
        fs::create_dir_all(&files)?;
        let download_file = scratch.join("download");
        let (digest, bytes) = download(&url, &download_file, &token, &progress).await?;
        progress(Progress {
            phase: "verify",
            received: bytes,
            total: Some(bytes),
        });
        if let Some(expected) = &expected {
            if !sha256_matches(&digest, expected) {
                return Err(bad(format!(
                    "The download's SHA-256 ({}) isn't the one the registry lists ({expected}): it was not installed.",
                    hex(&digest)
                )));
            }
        }
        progress(Progress {
            phase: "unpack",
            received: bytes,
            total: Some(bytes),
        });
        let (unpack_from, unpack_to, cmd) = (download_file.clone(), files.clone(), req.cmd.clone());
        tauri::async_runtime::spawn_blocking(move || -> Result<()> {
            archive::unpack(kind, &unpack_from, &unpack_to, &raw_name)?;
            archive::resolve_command(&unpack_to, &cmd)?;
            Ok(())
        })
        .await
        .map_err(|e| bad(e.to_string()))??;
        if token.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let target = agent_dir.join(&req.version);
        if target.exists() {
            crate::extensions::download::remove_tree(&target)?;
        }
        fs::rename(&files, &target)?;
        let command = archive::resolve_command(&target, &req.cmd)?;
        // Older versions go (one that's running on Windows stays until next time).
        if let Ok(entries) = fs::read_dir(&agent_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if name != std::ffi::OsStr::new(&req.version) && !name.to_string_lossy().starts_with(".partial-") {
                    let _ = crate::extensions::download::remove_tree(&entry.path());
                }
            }
        }
        progress(Progress {
            phase: "done",
            received: bytes,
            total: Some(bytes),
        });
        Ok(Installed {
            command: command.to_string_lossy().into_owned(),
            dir: target.to_string_lossy().into_owned(),
            verified: expected.is_some(),
            bytes,
        })
    }
    .await;
    let _ = crate::extensions::download::remove_tree(&scratch);
    if result.is_err() {
        // A first install that failed leaves no empty folder behind.
        let _ = fs::remove_dir(&agent_dir);
    }
    if let Ok(mut map) = installs().lock() {
        map.remove(&req.id);
    }
    result
}

/// Deletes a downloaded agent (all its versions); whether there was one.
pub fn remove(data: &Path, id: &str) -> Result<bool> {
    if !valid_id(id) {
        return Err(bad(format!("{id} isn't an agent id")));
    }
    let dir = root(data).join(id);
    match fs::symlink_metadata(&dir) {
        Err(_) => Ok(false),
        Ok(m) if m.file_type().is_symlink() => {
            // A folder link on Windows is removed as one (`remove_file` is refused there).
            crate::fs::remove_file_or_link(&dir, m.file_type())?;
            Ok(true)
        }
        Ok(_) => {
            crate::extensions::download::remove_tree(&dir)
                .map_err(|e| bad(format!("{id} couldn't be removed (is it running?): {e}")))?;
            Ok(true)
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnDisk {
    pub id: String,
    pub versions: Vec<String>,
}

/// The agents downloaded here, with their versions.
pub fn on_disk(data: &Path) -> Vec<OnDisk> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(root(data)) else {
        return out;
    };
    for entry in entries.flatten() {
        let id = entry.file_name().to_string_lossy().into_owned();
        if !valid_id(&id) || !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let mut versions: Vec<String> = fs::read_dir(entry.path())
            .map(|v| {
                v.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|n| valid_version(n))
                    .collect()
            })
            .unwrap_or_default();
        versions.sort();
        out.push(OnDisk { id, versions });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn ids_versions_and_addresses() {
        assert!(valid_id("claude-acp"));
        assert!(valid_id("opencode-v2"));
        assert!(!valid_id("../x"));
        assert!(!valid_id("Upper"));
        assert!(!valid_id(".hidden"));
        assert!(!valid_id("con"));
        assert!(valid_version("2026.10.22"));
        assert!(valid_version("1.9.0-preview.1"));
        assert!(!valid_version("../1"));
        assert!(!valid_version("1/2"));
        let ok = |u: &str| allowed(&reqwest::Url::parse(u).unwrap());
        assert!(ok("https://github.com/a/b/releases/download/v1/x.tar.gz"));
        assert!(!ok("http://github.com/x"));
        assert!(!ok("https://127.0.0.1/x"));
        assert!(!ok("https://10.0.0.2/x"));
        assert!(!ok("https://user:pw@github.com/x"));
        assert!(!ok("file:///etc/passwd"));
        // Test builds (this one) take a local address for the UI tests.
        assert_eq!(ok("http://127.0.0.1:9000/x.zip"), cfg!(debug_assertions));
        assert!(platform().is_some());
    }

    #[test]
    fn sha256_comparison() {
        let digest = Sha256::digest(b"agent").to_vec();
        let hexed = hex(&digest);
        assert!(sha256_matches(&digest, &hexed));
        assert!(sha256_matches(&digest, &hexed.to_uppercase()));
        assert!(!sha256_matches(&digest, &"0".repeat(64)));
    }

    /// Serves `body` once per connection on a local port (a stand-in for a release download).
    fn serve(body: Vec<u8>) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut buf = [0u8; 4096];
                let _ = std::io::Read::read(&mut stream, &mut buf);
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(&body);
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ide-acp-install-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn installs_a_raw_binary_and_refuses_a_wrong_checksum() {
        let body = b"#!/bin/sh\necho agent\n".to_vec();
        let good = hex(&Sha256::digest(&body));
        let base = serve(body);
        let data = temp("raw");
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let request = |sha: Option<String>, version: &str| InstallRequest {
            id: "demo".into(),
            version: version.into(),
            archive: format!("{base}/demo-agent"),
            sha256: sha,
            cmd: "./demo-agent".into(),
        };
        // A wrong SHA-256: nothing is installed, no folder left behind.
        let wrong = rt.block_on(install(
            &data,
            request(Some("0".repeat(64)), "1.0.0"),
            |_| {},
        ));
        let message = wrong.err().map(|e| e.to_string()).unwrap_or_default();
        assert!(message.contains("SHA-256"), "{message}");
        assert!(!root(&data).join("demo").exists());
        // The right one: it's in place, executable, and reported verified.
        let done = rt
            .block_on(install(
                &data,
                request(Some(good.to_uppercase()), "1.0.0"),
                |_| {},
            ))
            .unwrap();
        assert!(done.verified);
        assert!(Path::new(&done.command).is_file());
        assert!(done.command.contains("1.0.0"));
        // Without one: installed, not verified; the older version is gone.
        let next = rt
            .block_on(install(&data, request(None, "1.1.0"), |_| {}))
            .unwrap();
        assert!(!next.verified);
        assert_eq!(
            on_disk(&data).first().map(|d| d.versions.clone()),
            Some(vec!["1.1.0".to_string()])
        );
        assert!(remove(&data, "demo").unwrap());
        assert!(on_disk(&data).is_empty());
        assert!(!remove(&data, "demo").unwrap());
        assert!(remove(&data, "../x").is_err());
        let _ = fs::remove_dir_all(&data);
    }
}
