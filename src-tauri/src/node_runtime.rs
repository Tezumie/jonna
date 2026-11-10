//! A pinned Node.js for extensions' code (D267, docs/vscode-extensions-plan.md): on a machine
//! without Node, the extension host can run on one downloaded from nodejs.org on first use
//! (asked first; about 30 MB, not bundled so the installer stays small). The version and each
//! platform's archive SHA-256 are pinned here (from nodejs.org's SHASUMS256.txt); the download
//! goes through the ACP agents' installer (`acp_agents::install_into`: streamed, checked against
//! the hash, unpacked safely) into `<data>/runtimes/node/<version>/`.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::acp_agents::{self, InstallRequest, Progress};
use crate::error::{Error, Result};

/// The pinned release (the current LTS line when chosen).
pub const VERSION: &str = "24.22.2";

/// This platform's archive and its SHA-256 (nodejs.org/dist/v<VERSION>/SHASUMS256.txt).
fn archive() -> Option<(&'static str, &'static str)> {
    Some(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => (
            "win-x64.zip",
            "ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2",
        ),
        ("windows", "aarch64") => (
            "win-arm64.zip",
            "f47968c213105077f64c6510f007632c0ca2574802a0b5067c327c49abe1c468",
        ),
        ("linux", "x86_64") => (
            "linux-x64.tar.gz",
            "361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9",
        ),
        ("linux", "aarch64") => (
            "linux-arm64.tar.gz",
            "95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2",
        ),
        ("macos", "x86_64") => (
            "darwin-x64.tar.gz",
            "d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52",
        ),
        ("macos", "aarch64") => (
            "darwin-arm64.tar.gz",
            "aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a",
        ),
        _ => return None,
    })
}

/// `win-x64.zip` → `node-v<VERSION>-win-x64`: the folder the archive unpacks to.
fn folder(archive: &str) -> String {
    let platform = archive.trim_end_matches(".zip").trim_end_matches(".tar.gz");
    format!("node-v{VERSION}-{platform}")
}

/// The program inside the unpacked folder, relative to the version's folder.
fn command(archive: &str) -> String {
    if archive.ends_with(".zip") {
        format!("{}/node.exe", folder(archive))
    } else {
        format!("{}/bin/node", folder(archive))
    }
}

fn base(data: &Path) -> PathBuf {
    data.join("runtimes")
}

/// What there is: the downloaded Node (if any), and what a download would get.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub version: &'static str,
    /// The downloaded program, when it's there.
    pub path: Option<String>,
    /// This platform has a pinned build.
    pub available: bool,
}

pub fn status(data: &Path) -> Status {
    let path = archive().and_then(|(a, _)| {
        // Joined part by part: one spelling of the path, whatever the platform's separator.
        let p = command(a)
            .split('/')
            .fold(base(data).join("node").join(VERSION), |p, part| {
                p.join(part)
            });
        p.is_file()
            .then(|| crate::store::simplify(p).to_string_lossy().into_owned())
    });
    Status {
        version: VERSION,
        path,
        available: archive().is_some(),
    }
}

/// Downloads the pinned Node (checked against its SHA-256); the program's absolute path.
pub async fn install(
    data: &Path,
    progress: impl Fn(Progress) + Send + Sync + 'static,
) -> Result<String> {
    let (archive, sha256) = archive().ok_or_else(|| {
        Error::Invalid(
            "There's no Node.js download for this platform: install Node.js 18 or newer.".into(),
        )
    })?;
    let installed = acp_agents::install_into(
        &base(data),
        InstallRequest {
            id: "node".into(),
            version: VERSION.into(),
            archive: format!("https://nodejs.org/dist/v{VERSION}/node-v{VERSION}-{archive}"),
            sha256: Some(sha256.into()),
            cmd: command(archive),
        },
        progress,
    )
    .await?;
    Ok(status(data).path.unwrap_or(installed.command))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_and_programs_by_archive() {
        assert_eq!(folder("win-x64.zip"), format!("node-v{VERSION}-win-x64"));
        assert_eq!(
            command("linux-arm64.tar.gz"),
            format!("node-v{VERSION}-linux-arm64/bin/node")
        );
        assert_eq!(
            command("win-arm64.zip"),
            format!("node-v{VERSION}-win-arm64/node.exe")
        );
        // Every pinned hash is a SHA-256.
        if let Some((_, sha)) = archive() {
            assert!(sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn nothing_downloaded_yet() {
        let dir = std::env::temp_dir().join(format!("node-runtime-test-{}", std::process::id()));
        let s = status(&dir);
        assert_eq!(s.version, VERSION);
        assert!(s.path.is_none());
    }
}
