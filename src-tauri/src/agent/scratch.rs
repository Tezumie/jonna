//! A chat's private folder (D208): an external agent (Codex, Claude Code…) needs a working
//! directory, so a chat with no folder open runs it in `agent/scratch/<session>` in app data.
//! Its file requests are confined to that folder: nothing else in app data (settings, keys, other
//! chats) and nothing on the rest of the disk is reachable through it.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};
use crate::fs::resolve_under;
use crate::store::{atomic_write, simplify};

/// The biggest file the agent reads from its folder (the workspace's agent reads stop there too).
const READ_MAX: u64 = 4 * 1024 * 1024;

pub fn base(data: &Path) -> PathBuf {
    data.join("agent").join("scratch")
}

/// The chat's folder, made if needed (canonical).
pub fn dir(data: &Path, session: &str) -> Result<PathBuf> {
    let dir = base(data).join(super::safe_id(session)?);
    fs::create_dir_all(&dir)?;
    Ok(simplify(fs::canonicalize(dir)?))
}

/// `path` (canonical) when it is a chat's folder or a folder inside one: where an agent's
/// process and commands may run with no folder open.
pub fn within(data: &Path, path: &Path) -> Option<PathBuf> {
    let base = simplify(fs::canonicalize(base(data)).ok()?);
    // Every `exec_run` / `lsp_start` cwd is asked here first: a network path is refused before
    // `canonicalize` touches it (Windows would connect and offer the user's credentials, D161).
    let text = path.to_string_lossy();
    if !path.is_absolute()
        || (crate::fs::is_unc(&text) && !crate::fs::is_unc(&base.to_string_lossy()))
    {
        return None;
    }
    let real = simplify(fs::canonicalize(path).ok()?);
    (real.is_dir() && real.starts_with(&base) && real != base).then_some(real)
}

/// `path` inside the chat folder `root` (which must be one), canonical.
fn resolve(data: &Path, root: &str, path: &str) -> Result<PathBuf> {
    let root = within(data, Path::new(root)).ok_or_else(|| Error::OutsideScope(root.into()))?;
    let resolved = resolve_under(&root, path)?;
    if resolved == root {
        return Err(Error::Invalid(format!("not a file: {path}")));
    }
    Ok(resolved)
}

pub fn read(data: &Path, root: &str, path: &str) -> Result<String> {
    let file = resolve(data, root, path)?;
    if fs::metadata(&file)?.len() > READ_MAX {
        return Err(Error::Invalid(format!("too big to read: {path}")));
    }
    Ok(String::from_utf8_lossy(&fs::read(file)?).into_owned())
}

pub fn write(data: &Path, root: &str, path: &str, content: &str) -> Result<()> {
    let file = resolve(data, root, path)?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    atomic_write(&file, content.as_bytes())
}

/// Removes the chat's folder (the chat was deleted).
pub fn remove(data: &Path, session: &str) -> Result<()> {
    let _ = fs::remove_dir_all(base(data).join(super::safe_id(session)?));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ide-scratch-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn confines_reads_and_writes_to_the_chat_folder() -> Result<()> {
        let d = data("confine");
        let root = dir(&d, "s1")?;
        let other = dir(&d, "s2")?;
        let r = root.to_string_lossy().into_owned();
        let inside = root.join("notes").join("a.txt");
        write(&d, &r, &inside.to_string_lossy(), "hi")?;
        assert_eq!(read(&d, &r, &inside.to_string_lossy())?, "hi");
        // Another chat's folder, app data itself and the root folder are out of reach.
        fs::write(other.join("b.txt"), "x")?;
        assert!(read(&d, &r, &other.join("b.txt").to_string_lossy()).is_err());
        fs::write(d.join("secrets.json"), "{}")?;
        assert!(read(&d, &r, &d.join("secrets.json").to_string_lossy()).is_err());
        let up = format!("{}/../s2/b.txt", r);
        assert!(read(&d, &r, &up).is_err());
        assert!(write(&d, &r, &up, "no").is_err());
        assert!(read(&d, &r, "relative.txt").is_err());
        // A root that isn't a chat folder is refused.
        let d_text = d.to_string_lossy().into_owned();
        assert!(read(&d, &d_text, &d.join("secrets.json").to_string_lossy()).is_err());
        assert!(within(&d, &base(&d)).is_none());
        assert!(within(&d, &root).is_some());
        assert!(within(&d, &d).is_none());
        // Network and relative paths are refused without being looked at.
        assert!(within(&d, Path::new(r"\\ide-test-no-such-host\share\x")).is_none());
        assert!(within(&d, Path::new("agent/scratch/s1")).is_none());
        remove(&d, "s1")?;
        assert!(!root.exists());
        assert!(dir(&d, "../x").is_err());
        let _ = fs::remove_dir_all(&d);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_folder_is_refused() -> Result<()> {
        let d = data("link");
        let root = dir(&d, "s1")?;
        fs::write(d.join("secret.txt"), "x")?;
        std::os::unix::fs::symlink(&d, root.join("out"))?;
        let r = root.to_string_lossy().into_owned();
        assert!(read(
            &d,
            &r,
            &root.join("out").join("secret.txt").to_string_lossy()
        )
        .is_err());
        assert!(within(&d, &root.join("out")).is_none());
        let _ = fs::remove_dir_all(&d);
        Ok(())
    }
}
