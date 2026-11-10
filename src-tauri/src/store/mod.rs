//! Atomic file writes and the app's data directories.
//!
//! Every file the IDE writes (user files, state, settings) goes through [`atomic_write`]:
//! temp file in the same directory -> fsync -> rename, so a crash never leaves a half-written file.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime};

use crate::error::{Error, Result};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Writes `bytes` to `path` atomically. Follows a symlink at `path` (writes its target) and keeps
/// the existing file's permissions, so editing an executable script doesn't drop its `+x` bit.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    write_atomically(path, bytes, false)
}

/// `atomic_write` for a file only its owner may read (keys, tokens): on Unix the temporary file
/// is created 0600, so the secret is never in a file others can read, not even for a moment
/// (D203 audit).
pub fn atomic_write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    write_atomically(path, bytes, true)
}

#[cfg_attr(not(unix), allow(unused_variables))]
fn write_atomically(path: &Path, bytes: &[u8], private: bool) -> Result<()> {
    let target = match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => fs::canonicalize(path)?,
        _ => path.to_path_buf(),
    };
    let dir = target
        .parent()
        .ok_or_else(|| Error::Invalid(format!("no parent directory: {}", target.display())))?;
    fs::create_dir_all(dir)?;
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(
        ".{name}.tmp-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));

    let result = (|| -> Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        if private {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        if !private {
            if let Ok(meta) = fs::metadata(&target) {
                fs::set_permissions(&tmp, meta.permissions())?;
            }
        }
        drop(file);
        fs::rename(&tmp, &target)?;
        sync_dir(dir);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Makes the rename durable on Unix. Best effort: not all filesystems support fsync on directories.
fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

/// Removes the verbatim prefix Windows `canonicalize` adds (`\\?\C:\x` → `C:\x`,
/// `\\?\UNC\server\share` → `\\server\share`), so paths shown to the user and compared against
/// the workspace root look like normal paths. Long paths still work: Rust's std re-adds the prefix
/// internally when a path exceeds MAX_PATH.
pub fn simplify(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(simple) = simplify_verbatim(&path.to_string_lossy()) {
            return PathBuf::from(simple);
        }
    }
    path
}

/// The string rule behind `simplify`, platform-independent so it is tested everywhere.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn simplify_verbatim(s: &str) -> Option<String> {
    let rest = s.strip_prefix(r"\\?\")?;
    if let Some(unc) = rest.strip_prefix(r"UNC\") {
        return Some(format!(r"\\{unc}"));
    }
    let bytes = rest.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Some(rest.to_string());
    }
    None
}

/// The app's own directories. Their location comes from the bundle identifier in `product.json`.
#[derive(Debug, Clone)]
pub struct AppDirs {
    pub data: PathBuf,
    pub config: PathBuf,
    pub logs: PathBuf,
    pub home: Option<PathBuf>,
}

impl AppDirs {
    /// `override_dir` (`--user-data-dir`, used by test runs) puts data and config under one folder.
    pub fn resolve<R: Runtime>(app: &AppHandle<R>, override_dir: Option<&Path>) -> Result<Self> {
        let paths = app.path();
        let (data, config) = match override_dir {
            Some(dir) => (dir.join("data"), dir.join("config")),
            None => (paths.app_data_dir()?, paths.app_config_dir()?),
        };
        let logs = data.join("logs");
        for dir in [&data, &config, &logs] {
            fs::create_dir_all(dir)?;
        }
        let home = paths.home_dir().ok();
        Ok(Self {
            data,
            config,
            logs,
            home,
        })
    }

    /// Fallback working directory for terminals opened without a workspace.
    pub fn home(&self) -> Result<PathBuf> {
        self.home
            .clone()
            .ok_or_else(|| Error::Invalid("no home directory".into()))
    }

    /// `<appData>/state.json`: global UI state (e.g. last opened folder).
    pub fn global_state_file(&self) -> PathBuf {
        self.data.join("state.json")
    }

    /// `<appData>/workspaces/<sha256(canonical root)>/state.json`: per-workspace layout, tabs, view state.
    pub fn workspace_state_file(&self, root: &Path) -> PathBuf {
        let canonical = fs::canonicalize(root)
            .map(simplify)
            .unwrap_or_else(|_| root.to_path_buf());
        let digest = Sha256::digest(canonical.to_string_lossy().as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        self.data.join("workspaces").join(hex).join("state.json")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_prefixes_are_simplified() {
        assert_eq!(
            simplify_verbatim(r"\\?\C:\work\a.ts").as_deref(),
            Some(r"C:\work\a.ts")
        );
        assert_eq!(
            simplify_verbatim(r"\\?\UNC\server\share\dir").as_deref(),
            Some(r"\\server\share\dir")
        );
        // Device paths and non-verbatim paths are left alone.
        assert_eq!(simplify_verbatim(r"\\?\Volume{abc}\x"), None);
        assert_eq!(simplify_verbatim(r"C:\work"), None);
        assert_eq!(simplify_verbatim("/home/me"), None);
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ide-store-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir)
            .map(|_| dir)
            .unwrap_or_else(|e| panic!("{e}"))
    }

    #[test]
    fn atomic_write_creates_and_replaces() -> Result<()> {
        let dir = temp_dir("replace");
        let file = dir.join("a.txt");
        atomic_write(&file, b"one")?;
        atomic_write(&file, b"two")?;
        assert_eq!(fs::read(&file)?, b"two");
        // No temp files left behind.
        assert_eq!(fs::read_dir(&dir)?.count(), 1);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_keeps_permissions_and_symlinks() -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("perm");
        let file = dir.join("run.sh");
        fs::write(&file, "x")?;
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755))?;
        let link = dir.join("link.sh");
        std::os::unix::fs::symlink(&file, &link)?;
        atomic_write(&link, b"y")?;
        assert!(fs::symlink_metadata(&link)?.file_type().is_symlink());
        assert_eq!(fs::read(&file)?, b"y");
        assert_eq!(fs::metadata(&file)?.permissions().mode() & 0o777, 0o755);
        Ok(())
    }
}
