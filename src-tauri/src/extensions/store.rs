//! The extension store (D254): Open VSX (open-vsx.org), the Eclipse Foundation's open registry of
//! VS Code extensions, which VSCodium and Cursor use too. Search and an extension's details come
//! back as Open VSX's own JSON (the frontend reads what it needs). An install downloads one
//! version's `.vsix` over https from Open VSX's hosts only, checks it against the SHA-256 Open
//! VSX publishes for that file, and leaves it in the downloads folder; the frontend installs it
//! like any `.vsix` (and the download goes). An extension's icon, README, changelog and
//! package.json come from the same hosts (`file`, size-capped per kind) for its page and the
//! view's rows. Nothing is fetched unless the user searches, installs, checks for updates,
//! opens a page, or has the Extensions view shown with recommendations on.

use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use sha2::{Digest, Sha256};

use super::ExtensionStore;
use crate::error::{Error, Result};

const API: &str = "https://open-vsx.org/api";
/// Search results and an extension's details are small JSON.
const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;
/// The vsix reader's own limit (vsix.rs).
const MAX_VSIX_BYTES: usize = 256 * 1024 * 1024;

fn bad(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}

/// Open VSX's API and the storage its files are served from; https only.
fn allowed(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|h| {
            h == "open-vsx.org"
                || h.ends_with(".open-vsx.org")
                // Where the API's file links redirect (the Eclipse Foundation's CDN), and the
                // storage older links named.
                || h == "openvsx.eclipsecontent.org"
                || h == "openvsxorg.blob.core.windows.net"
        })
}

fn client() -> reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .user_agent("ide-extension-store")
                .redirect(reqwest::redirect::Policy::custom(|attempt| {
                    if attempt.previous().len() >= 5 || !allowed(attempt.url()) {
                        attempt.stop()
                    } else {
                        attempt.follow()
                    }
                }))
                .build()
                .unwrap_or_default()
        })
        .clone()
}

async fn fetch(url: &reqwest::Url, max: usize, timeout: Duration) -> Result<Vec<u8>> {
    fetch_typed(url, max, timeout, |_| true).await
}

/// `fetch`, refusing an answer whose content type `accepts` says no to (before reading it).
async fn fetch_typed(
    url: &reqwest::Url,
    max: usize,
    timeout: Duration,
    accepts: impl Fn(&str) -> bool,
) -> Result<Vec<u8>> {
    if !allowed(url) {
        return Err(bad(format!("{url}: not an Open VSX address")));
    }
    let response = client()
        .get(url.clone())
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| bad(format!("Open VSX didn't answer: {e}")))?;
    if !response.status().is_success() {
        return Err(bad(format!("Open VSX answered {}", response.status())));
    }
    let kind = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !accepts(&kind) {
        return Err(bad(format!(
            "{url}: not the expected kind of file ({kind})"
        )));
    }
    if response.content_length().is_some_and(|n| n > max as u64) {
        return Err(bad(format!("Larger than {}", size_label(max))));
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| bad(format!("The download broke off: {e}")))?;
        if bytes.len() + chunk.len() > max {
            return Err(bad(format!("Larger than {}", size_label(max))));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// A namespace, name or version as Open VSX writes them: no slashes or dots that climb.
fn part(value: &str, what: &str) -> Result<String> {
    let v = value.trim();
    if v.is_empty()
        || v.len() > 128
        || v.starts_with('.')
        || !v
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+'))
    {
        return Err(bad(format!("Not an extension {what}: {value}")));
    }
    Ok(v.to_string())
}

fn api(path: &[&str]) -> Result<reqwest::Url> {
    let mut url = reqwest::Url::parse(API).map_err(|e| bad(e.to_string()))?;
    url.path_segments_mut()
        .map_err(|_| bad("bad API address"))?
        .extend(path);
    Ok(url)
}

async fn json(url: &reqwest::Url) -> Result<String> {
    let bytes = fetch(url, MAX_JSON_BYTES, Duration::from_secs(30)).await?;
    String::from_utf8(bytes).map_err(|_| bad("Open VSX's answer isn't UTF-8 text."))
}

/// Open VSX's search (`/api/-/search`): its JSON (`extensions`, `totalSize`, `offset`).
pub async fn search(
    query: &str,
    category: Option<&str>,
    offset: u32,
    size: u32,
    sort_by: Option<&str>,
) -> Result<String> {
    let mut url = api(&["-", "search"])?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("query", query.trim());
        q.append_pair("offset", &offset.to_string());
        q.append_pair("size", &size.clamp(1, 100).to_string());
        if let Some(c) = category.filter(|c| !c.trim().is_empty()) {
            q.append_pair("category", c.trim());
        }
        let sort = match sort_by {
            Some("downloadCount" | "averageRating" | "timestamp" | "relevance") => sort_by,
            _ => None,
        };
        if let Some(s) = sort {
            q.append_pair("sortBy", s);
            q.append_pair("sortOrder", "desc");
        }
    }
    json(&url).await
}

/// VS Code's name for the platform the IDE runs on ("win32-x64"), as Open VSX files builds of
/// an extension made for one platform (D260: some ship a program per platform).
fn target_platform() -> Option<&'static str> {
    let os = if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return None;
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "arm") {
        "armhf"
    } else {
        return None;
    };
    Some(match (os, arch) {
        ("win32", "x64") => "win32-x64",
        ("win32", "arm64") => "win32-arm64",
        ("darwin", "x64") => "darwin-x64",
        ("darwin", "arm64") => "darwin-arm64",
        ("linux", "x64") => "linux-x64",
        ("linux", "arm64") => "linux-arm64",
        ("linux", "armhf") => "linux-armhf",
        _ => return None,
    })
}

/// One extension's details (`/api/{namespace}/{name}[/{version}]`): its JSON. This platform's
/// build first (`/api/{namespace}/{name}/{platform}[/{version}]`), else the one for all (D260).
pub async fn details(namespace: &str, name: &str, version: Option<&str>) -> Result<String> {
    let ns = part(namespace, "namespace")?;
    let n = part(name, "name")?;
    let v = version.map(|v| part(v, "version")).transpose()?;
    if let Some(platform) = target_platform() {
        let url = match &v {
            Some(v) => api(&[&ns, &n, platform, v])?,
            None => api(&[&ns, &n, platform])?,
        };
        if let Ok(text) = json(&url).await {
            let found = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .is_some_and(|value| {
                    value.get("error").is_none() && value.get("version").is_some()
                });
            if found {
                return Ok(text);
            }
        }
    }
    let url = match &v {
        Some(v) => api(&[&ns, &n, v])?,
        None => api(&[&ns, &n])?,
    };
    json(&url).await
}

/// "512 KB", "2 MB".
fn size_label(bytes: usize) -> String {
    if bytes >= 1024 * 1024 {
        format!("{} MB", bytes / (1024 * 1024))
    } else {
        format!("{} KB", bytes / 1024)
    }
}

/// What a file of an extension on Open VSX is fetched as (its page in the Extensions view):
/// an icon, an image of its README, or a text (README, changelog, package.json).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileKind {
    Icon,
    Image,
    Text,
}

impl FileKind {
    pub fn parse(kind: &str) -> Result<Self> {
        match kind {
            "icon" => Ok(Self::Icon),
            "image" => Ok(Self::Image),
            "text" => Ok(Self::Text),
            _ => Err(bad(format!("Not a kind of store file: {kind}"))),
        }
    }

    fn max_bytes(self) -> usize {
        match self {
            Self::Icon => 512 * 1024,
            Self::Image => 5 * 1024 * 1024,
            Self::Text => 2 * 1024 * 1024,
        }
    }

    /// The answer's content type fits: images are image/* (storage may say octet-stream; the
    /// page reads the type from the bytes and shows nothing that isn't a picture); a text is
    /// anything but a picture, media or a web page.
    fn accepts(self, content_type: &str) -> bool {
        let t = content_type.trim();
        match self {
            Self::Icon | Self::Image => {
                t.is_empty() || t.starts_with("image/") || t.starts_with("application/octet-stream")
            }
            Self::Text => !["image/", "audio/", "video/", "font/", "text/html"]
                .iter()
                .any(|p| t.starts_with(p)),
        }
    }
}

/// A file of an extension on Open VSX (an icon, a README image, its README, changelog or
/// package.json): only from Open VSX's hosts (redirects too), size-capped per kind.
pub async fn file(url: &str, kind: FileKind) -> Result<Vec<u8>> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|e| bad(format!("{url}: {e}")))?;
    let bytes = fetch_typed(&parsed, kind.max_bytes(), Duration::from_secs(30), |t| {
        kind.accepts(t)
    })
    .await?;
    if kind == FileKind::Text && bytes.iter().take(8000).any(|b| *b == 0) {
        return Err(bad(format!("{url}: not a text file")));
    }
    Ok(bytes)
}

fn file_url(details: &serde_json::Value, key: &str) -> Result<reqwest::Url> {
    let raw = details
        .get("files")
        .and_then(|f| f.get(key))
        .and_then(|u| u.as_str())
        .ok_or_else(|| bad(format!("Open VSX lists no {key} file for it.")))?;
    let url = reqwest::Url::parse(raw).map_err(|e| bad(format!("{raw}: {e}")))?;
    if !allowed(&url) {
        return Err(bad(format!("{raw}: not an Open VSX address")));
    }
    Ok(url)
}

impl ExtensionStore {
    /// Downloads one version's `.vsix` (the latest without `version`) and checks its SHA-256;
    /// the file in the downloads folder, and the version it is.
    pub async fn download_from_store(
        &self,
        namespace: &str,
        name: &str,
        version: Option<&str>,
    ) -> Result<(PathBuf, String)> {
        let text = details(namespace, name, version).await?;
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| bad(format!("Open VSX's answer: {e}")))?;
        if let Some(error) = value.get("error").and_then(|e| e.as_str()) {
            return Err(bad(error.to_string()));
        }
        let got = value
            .get("version")
            .and_then(|v| v.as_str())
            .map(|v| part(v, "version"))
            .transpose()?
            .ok_or_else(|| bad("Open VSX's answer has no version."))?;
        let vsix = file_url(&value, "download")?;
        let sha = file_url(&value, "sha256")?;
        let expected = String::from_utf8(fetch(&sha, 4096, Duration::from_secs(30)).await?)
            .map_err(|_| bad("The checksum file isn't text."))?;
        let expected = expected.split_whitespace().next().unwrap_or("").to_string();
        if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(bad("Open VSX's checksum for it isn't a SHA-256."));
        }
        let bytes = fetch(&vsix, MAX_VSIX_BYTES, Duration::from_secs(600)).await?;
        let actual: String = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if !actual.eq_ignore_ascii_case(&expected) {
            return Err(bad(
                "The download doesn't match Open VSX's checksum; nothing was installed.",
            ));
        }
        let dir = self.downloads();
        fs::create_dir_all(&dir)?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let file = dir.join(format!(
            "store-{}.{}-{}-{stamp}.vsix",
            part(namespace, "namespace")?,
            part(name, "name")?,
            got
        ));
        crate::store::atomic_write(&file, &bytes)?;
        Ok((file, got))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_open_vsx_over_https() {
        let ok = |u: &str| allowed(&reqwest::Url::parse(u).unwrap());
        assert!(ok("https://open-vsx.org/api/-/search"));
        assert!(ok(
            "https://openvsxorg.blob.core.windows.net/resources/a/b/1.0.0/a.b-1.0.0.vsix"
        ));
        assert!(ok(
            "https://openvsx.eclipsecontent.org/dracula-theme/theme-dracula/2.25.1/x.vsix"
        ));
        assert!(!ok("https://eclipsecontent.org.evil.example/x.vsix"));
        assert!(!ok("http://open-vsx.org/api"));
        assert!(!ok("https://open-vsx.org.evil.example/x"));
        assert!(!ok("https://user@open-vsx.org/api"));
        assert!(!ok("https://example.com/a.vsix"));
    }

    #[test]
    fn store_files_are_checked_by_kind() {
        assert_eq!(FileKind::parse("icon").unwrap(), FileKind::Icon);
        assert!(FileKind::parse("vsix").is_err());
        assert!(FileKind::Icon.accepts("image/png"));
        assert!(FileKind::Image.accepts("application/octet-stream"));
        assert!(FileKind::Icon.accepts(""));
        assert!(!FileKind::Icon.accepts("text/html; charset=utf-8"));
        assert!(FileKind::Text.accepts("application/octet-stream"));
        assert!(FileKind::Text.accepts("text/markdown"));
        assert!(!FileKind::Text.accepts("text/html"));
        assert!(!FileKind::Text.accepts("image/png"));
        assert!(FileKind::Icon.max_bytes() <= 512 * 1024);
        assert_eq!(size_label(512 * 1024), "512 KB");
        assert_eq!(size_label(2 * 1024 * 1024), "2 MB");
    }

    #[test]
    fn this_platform_has_a_vs_code_name() {
        let platform = target_platform();
        if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
            assert_eq!(platform, Some("win32-x64"));
        }
        if let Some(p) = platform {
            assert!(part(p, "platform").is_ok());
        }
    }

    #[test]
    fn names_that_climb_are_refused() {
        assert!(part("dracula-theme", "namespace").is_ok());
        assert!(part("1.2.3-beta+4", "version").is_ok());
        assert!(part("..", "name").is_err());
        assert!(part("a/b", "name").is_err());
        assert!(part("", "name").is_err());
        let url = api(&["ns", "name", "1.0.0"]).unwrap();
        assert_eq!(url.as_str(), "https://open-vsx.org/api/ns/name/1.0.0");
    }
}
