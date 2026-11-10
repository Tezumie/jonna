//! Data for the terminal's command suggestions (VS Code's terminal IntelliSense): the programs on
//! PATH (listed once and kept, since reading every PATH folder on each keystroke would be slow)
//! and the entries of a folder (names only).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

/// Programs on PATH are listed again after this long (a new install shows up).
const PATH_TTL: Duration = Duration::from_secs(120);
const MAX_COMMANDS: usize = 20_000;
const MAX_ENTRIES: usize = 2_000;

/// Windows: these extensions make a file runnable; the name is shown without it.
const WINDOWS_RUNNABLE: &[&str] = &["exe", "cmd", "bat", "com", "ps1"];

struct PathCache {
    key: String,
    at: Instant,
    names: Vec<String>,
}

static CACHE: Mutex<Option<PathCache>> = Mutex::new(None);

/// A program name if `file` (in a PATH folder) can be run: Windows by extension, elsewhere by
/// the executable bit.
fn runnable_name(path: &Path, windows: bool, is_exec: &dyn Fn(&Path) -> bool) -> Option<String> {
    let file = path.file_name()?.to_string_lossy().into_owned();
    if windows {
        let (stem, ext) = file.rsplit_once('.')?;
        let ext = ext.to_ascii_lowercase();
        return WINDOWS_RUNNABLE
            .contains(&ext.as_str())
            .then(|| stem.to_string());
    }
    is_exec(path).then_some(file)
}

/// The program names in `dirs`, sorted and without repeats.
pub fn list_commands(
    dirs: &[PathBuf],
    windows: bool,
    read_dir: &dyn Fn(&Path) -> Vec<PathBuf>,
    is_exec: &dyn Fn(&Path) -> bool,
) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for dir in dirs {
        for path in read_dir(dir) {
            if let Some(name) = runnable_name(&path, windows, is_exec) {
                names.push(name);
            }
            if names.len() > MAX_COMMANDS * 2 {
                break;
            }
        }
    }
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    names.truncate(MAX_COMMANDS);
    names
}

fn read_dir_paths(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|it| it.filter_map(|e| e.ok().map(|e| e.path())).collect())
        .unwrap_or_default()
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// The programs on this process's PATH (cached for a while, per PATH value).
pub fn path_commands() -> Vec<String> {
    let key = std::env::var("PATH").unwrap_or_default();
    if let Ok(cache) = CACHE.lock() {
        if let Some(c) = cache.as_ref() {
            if c.key == key && c.at.elapsed() < PATH_TTL {
                return c.names.clone();
            }
        }
    }
    let names = list_commands(
        &super::profiles::path_dirs(),
        cfg!(windows),
        &read_dir_paths,
        &is_executable,
    );
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some(PathCache {
            key,
            at: Instant::now(),
            names: names.clone(),
        });
    }
    names
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryName {
    pub name: String,
    pub dir: bool,
}

/// The entries of `dir` (names; folders first, then files, each alphabetical), at most a couple
/// of thousand. Hidden entries only when `hidden` (the typed name starts with a dot).
pub fn list_dir(dir: &Path, hidden: bool) -> Vec<DirEntryName> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<DirEntryName> = Vec::new();
    for entry in read.flatten().take(MAX_ENTRIES * 4) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') && !hidden {
            continue;
        }
        // Follows symlinks: a link to a folder completes as a folder.
        let is_dir = entry.path().is_dir();
        out.push(DirEntryName { name, dir: is_dir });
    }
    out.sort_by(|a, b| {
        b.dir
            .cmp(&a.dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out.truncate(MAX_ENTRIES);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_programs_by_extension() {
        let dirs = vec![PathBuf::from("C:/bin"), PathBuf::from("C:/more")];
        let read = |d: &Path| -> Vec<PathBuf> {
            if d == Path::new("C:/bin") {
                vec![
                    d.join("node.exe"),
                    d.join("npm.cmd"),
                    d.join("readme.txt"),
                    d.join("Git.EXE"),
                ]
            } else {
                vec![d.join("node.exe"), d.join("build.bat")]
            }
        };
        let names = list_commands(&dirs, true, &read, &|_| false);
        assert_eq!(names, ["build", "Git", "node", "npm"]);
    }

    #[test]
    fn unix_programs_by_executable_bit() {
        let dirs = vec![PathBuf::from("/usr/bin")];
        let read = |d: &Path| vec![d.join("ls"), d.join("README"), d.join("git")];
        let exec = |p: &Path| p.file_name().is_some_and(|f| f != "README");
        assert_eq!(list_commands(&dirs, false, &read, &exec), ["git", "ls"]);
    }

    #[test]
    fn folders_first_hidden_on_request() -> std::io::Result<()> {
        let dir = std::env::temp_dir().join(format!("ide-suggest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src"))?;
        std::fs::write(dir.join("b.txt"), "")?;
        std::fs::write(dir.join("A.md"), "")?;
        std::fs::write(dir.join(".env"), "")?;
        let names: Vec<String> = list_dir(&dir, false).into_iter().map(|e| e.name).collect();
        assert_eq!(names, ["src", "A.md", "b.txt"]);
        assert!(list_dir(&dir, true).iter().any(|e| e.name == ".env"));
        assert!(list_dir(&dir.join("nope"), false).is_empty());
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }
}
