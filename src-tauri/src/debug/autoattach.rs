//! Auto-attach registration (D204): where Node processes started by a debugged program or in a
//! JavaScript debug terminal say "debug me". `bootloader.js` (loaded through NODE_OPTIONS) writes
//! `<pid>.json` with its inspector address into a registration folder; the IDE polls it with
//! `take`, which also refreshes the folder's `alive` file (a bootloader seeing a stale one doesn't
//! wait for an IDE that went away). Folders live under `<data>/debug-attach/<id>`; ids are random
//! hex, so the frontend can't name any other folder.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::error::{Error, Result};
use crate::store::atomic_write;

const BOOTLOADER: &str = include_str!("bootloader.js");
/// Registrations bigger than this aren't ours.
const MAX_REGISTRATION: u64 = 64 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    /// The registration folder's id (for `take` and `dispose`).
    pub id: String,
    /// The folder itself (IDE_DEBUG_ATTACH for the bootloader).
    pub dir: String,
    /// The bootloader's path (NODE_OPTIONS=--require …).
    pub bootloader: String,
}

fn base(data: &Path) -> PathBuf {
    data.join("debug-attach")
}

/// A registration folder from its id (hex only: no path can be smuggled in).
fn folder(data: &Path, id: &str) -> Result<PathBuf> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(Error::Invalid(format!("not a registration id: {id}")));
    }
    Ok(base(data).join(id))
}

fn touch(path: &Path) -> Result<()> {
    std::fs::write(path, b"")?;
    Ok(())
}

/// Writes the bootloader (when it changed) and makes a fresh registration folder. Folders left
/// behind by an earlier run (no `take` for an hour) are removed on the way.
pub fn prepare(data: &Path) -> Result<Prepared> {
    let base = base(data);
    std::fs::create_dir_all(&base)?;
    let boot = base.join("bootloader.js");
    let current = |boot: &Path| std::fs::read_to_string(boot).ok().as_deref() == Some(BOOTLOADER);
    // A compound's sessions start together: each one's write goes through its own temporary
    // file, and one that lost the race (the other renamed first, or Node has the file open)
    // is fine when the file now holds this bootloader. One shared temporary name failed the
    // second session ("cannot find the file specified"), and stopAll ended the first (D280).
    // On Windows a file being replaced can't be read or replaced for a moment: a few tries.
    let mut attempts = 0;
    while !current(&boot) {
        match atomic_write(&boot, BOOTLOADER.as_bytes()) {
            Ok(()) => break,
            Err(_) if attempts < 10 => {
                attempts += 1;
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(err) => return Err(err),
        }
    }
    remove_stale(&base, Duration::from_secs(3600));
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(|e| Error::Invalid(format!("no randomness: {e}")))?;
    let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let dir = base.join(&id);
    std::fs::create_dir_all(&dir)?;
    touch(&dir.join("alive"))?;
    Ok(Prepared {
        id,
        dir: dir.to_string_lossy().into_owned(),
        bootloader: boot.to_string_lossy().into_owned(),
    })
}

fn remove_stale(base: &Path, age: Duration) {
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // A folder another session is making right now has no `alive` file yet: its own time
        // counts then. Removing it (a compound's sessions prepare together) left that session's
        // child processes with no folder to register in: they ran without the debugger (D280).
        let modified = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        // A time after `now` (made since this cleanup started) is fresh too.
        let fresh = modified(&path.join("alive"))
            .or_else(|| modified(&path))
            .is_some_and(|t| now.duration_since(t).map_or(true, |d| d < age));
        if !fresh {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// The registrations written since the last call (each file's JSON text), removed as they're
/// read; keeps the folder alive.
pub fn take(data: &Path, id: &str) -> Result<Vec<String>> {
    let dir = folder(data, id)?;
    if !dir.is_dir() {
        return Err(Error::Invalid("the registration folder is gone".into()));
    }
    touch(&dir.join("alive"))?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let small = entry
            .metadata()
            .map(|m| m.len() <= MAX_REGISTRATION)
            .unwrap_or(false);
        if small {
            if let Ok(text) = std::fs::read_to_string(&path) {
                out.push(text);
            }
        }
        let _ = std::fs::remove_file(&path);
    }
    Ok(out)
}

/// Removes a registration folder (its bootloaders stop waiting for the IDE).
pub fn dispose(data: &Path, id: &str) -> Result<()> {
    let dir = folder(data, id)?;
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registrations_are_taken_once() {
        let tmp = std::env::temp_dir().join(format!("ide-attach-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let p = prepare(&tmp).unwrap();
        assert!(Path::new(&p.bootloader).is_file());
        assert!(Path::new(&p.dir).join("alive").is_file());
        std::fs::write(Path::new(&p.dir).join("42.json"), "{\"pid\":42}").unwrap();
        std::fs::write(Path::new(&p.dir).join("43.json.tmp"), "{").unwrap();
        assert_eq!(take(&tmp, &p.id).unwrap(), vec!["{\"pid\":42}".to_string()]);
        assert!(take(&tmp, &p.id).unwrap().is_empty());
        dispose(&tmp, &p.id).unwrap();
        assert!(!Path::new(&p.dir).exists());
        assert!(take(&tmp, &p.id).is_err());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn sessions_starting_together_all_get_a_folder() {
        // A compound's sessions prepare at once on a fresh profile (no bootloader yet).
        let tmp = std::env::temp_dir().join(format!("ide-attach-race-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let data = tmp.clone();
                std::thread::spawn(move || prepare(&data))
            })
            .collect();
        let prepared: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        for p in prepared {
            let p = p.unwrap();
            assert_eq!(std::fs::read_to_string(&p.bootloader).unwrap(), BOOTLOADER);
            // No session's cleanup removed another's new folder.
            assert!(Path::new(&p.dir).join("alive").is_file());
        }
        // A folder being made (no `alive` yet) isn't stale.
        let making = base(&tmp).join("00aa");
        std::fs::create_dir_all(&making).unwrap();
        remove_stale(&base(&tmp), Duration::from_secs(3600));
        assert!(making.is_dir());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn ids_are_hex_only() {
        let data = Path::new("/data");
        assert!(folder(data, "../x").is_err());
        assert!(folder(data, "").is_err());
        assert!(folder(data, "ab/cd").is_err());
        assert_eq!(
            folder(data, "00ff").unwrap(),
            Path::new("/data/debug-attach/00ff")
        );
    }
}
