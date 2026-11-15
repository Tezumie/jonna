//! The user's own files that sync with the account (D435): keybindings, rules, snippets,
//! subagents, commands, output styles and skills. Each has a stable name (`snippets/x.json`,
//! `skills/review/SKILL.md`) that is the same on every computer, whatever folder it is in here.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use sha2_10::{Digest, Sha256};

use crate::error::{Error, Result};
use crate::store::atomic_write;

/// Text files only, and small: these are settings, not data.
const MAX_BYTES: u64 = 256 * 1024;
const MAX_FILES: usize = 2000;
const MAX_DEPTH: usize = 6;

/// Where the synced names live on this computer.
pub struct Roots {
    /// The app's config folder (settings.json's).
    pub config: PathBuf,
    /// The user's skills folder, when there is a home folder.
    pub skills: Option<PathBuf>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserFile {
    pub path: String,
    pub hash: String,
    pub mtime_ms: u64,
}

/// Single files in the config folder.
const FILES: &[&str] = &["keybindings.json", "AGENTS.md"];
/// Folders in the config folder, with the file endings that belong there.
const FOLDERS: &[(&str, &[&str])] = &[
    ("snippets", &[".json", ".code-snippets"]),
    ("agents", &[".md"]),
    ("commands", &[".md"]),
    ("output-styles", &[".md"]),
];

/// A file kept beside the one it lost to; never synced itself.
fn is_conflict_copy(name: &str) -> bool {
    name.contains(".conflict.") || name.ends_with(".conflict")
}

fn hash(bytes: &[u8]) -> String {
    super::crypto::b64(&Sha256::digest(bytes)[..16])
}

fn mtime(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}

impl Roots {
    /// The place a synced name stands for here; refused when it isn't one of the names that sync.
    fn resolve(&self, path: &str) -> Result<PathBuf> {
        let refused = || Error::Invalid(format!("not a synced file: {path}"));
        let parts: Vec<&str> = path.split('/').collect();
        if parts.len() > MAX_DEPTH
            || parts.iter().any(|p| {
                p.is_empty()
                    || !matches!(Path::new(p).components().next(), Some(Component::Normal(_)))
                    || Path::new(p).components().count() != 1
                    || p.contains('\\')
                    || p.contains(':')
            })
        {
            return Err(refused());
        }
        // A conflict copy (`name.conflict.ext`) lives where its file does.
        let name = parts.last().copied().unwrap_or("");
        let plain = name.replacen(".conflict", "", 1);
        match parts.as_slice() {
            [single] if FILES.contains(&plain.as_str()) => Ok(self.config.join(single)),
            [folder, file] if *folder != "skills" => {
                let (_, endings) = FOLDERS
                    .iter()
                    .find(|(f, _)| f == folder)
                    .ok_or_else(refused)?;
                if !endings.iter().any(|e| plain.ends_with(e)) {
                    return Err(refused());
                }
                Ok(self.config.join(folder).join(file))
            }
            ["skills", rest @ ..] if !rest.is_empty() => {
                let mut out = self.skills.clone().ok_or_else(refused)?;
                out.extend(rest);
                Ok(out)
            }
            _ => Err(refused()),
        }
    }

    fn note(&self, out: &mut Vec<UserFile>, name: String, file: &Path) {
        if out.len() >= MAX_FILES {
            return;
        }
        let Ok(meta) = std::fs::metadata(file) else {
            return;
        };
        if !meta.is_file() || meta.len() > MAX_BYTES {
            return;
        }
        let Ok(bytes) = std::fs::read(file) else {
            return;
        };
        // Text only: a record carries text.
        if std::str::from_utf8(&bytes).is_err() {
            return;
        }
        out.push(UserFile {
            path: name,
            hash: hash(&bytes),
            mtime_ms: mtime(&meta),
        });
    }

    fn walk(&self, out: &mut Vec<UserFile>, prefix: &str, dir: &Path, depth: usize) {
        if depth > MAX_DEPTH {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if name.starts_with('.') || is_conflict_copy(&name) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = format!("{prefix}/{name}");
            if kind.is_dir() {
                self.walk(out, &path, &entry.path(), depth + 1);
            } else if kind.is_file() {
                self.note(out, path, &entry.path());
            }
        }
    }

    /// Every file that syncs, with its content's hash.
    pub fn scan(&self) -> Vec<UserFile> {
        let mut out = Vec::new();
        for name in FILES {
            self.note(&mut out, (*name).to_string(), &self.config.join(name));
        }
        for (folder, endings) in FOLDERS {
            let Ok(entries) = std::fs::read_dir(self.config.join(folder)) else {
                continue;
            };
            let mut names: Vec<String> = entries
                .flatten()
                .filter_map(|e| e.file_name().to_str().map(str::to_string))
                .filter(|n| endings.iter().any(|e| n.ends_with(e)) && !is_conflict_copy(n))
                .collect();
            names.sort();
            for name in names {
                self.note(
                    &mut out,
                    format!("{folder}/{name}"),
                    &self.config.join(folder).join(&name),
                );
            }
        }
        if let Some(skills) = &self.skills {
            self.walk(&mut out, "skills", skills, 1);
        }
        out
    }

    pub fn read(&self, path: &str) -> Result<Option<String>> {
        match std::fs::read_to_string(self.resolve(path)?) {
            Ok(text) => Ok(Some(text)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Writes a synced file (`text` None removes it). Returns its new entry.
    pub fn write(&self, path: &str, text: Option<&str>) -> Result<Option<UserFile>> {
        let file = self.resolve(path)?;
        let Some(text) = text else {
            return match std::fs::remove_file(&file) {
                Ok(()) => Ok(None),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.into()),
            };
        };
        if text.len() as u64 > MAX_BYTES {
            return Err(Error::Invalid(format!("too large to sync: {path}")));
        }
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        atomic_write(&file, text.as_bytes())?;
        Ok(Some(UserFile {
            path: path.to_string(),
            hash: hash(text.as_bytes()),
            mtime_ms: std::fs::metadata(&file).map(|m| mtime(&m)).unwrap_or(0),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots() -> (tempdir::Dir, Roots) {
        let dir = tempdir::Dir::new();
        let roots = Roots {
            config: dir.path().join("config"),
            skills: Some(dir.path().join("home").join("skills")),
        };
        std::fs::create_dir_all(&roots.config).unwrap();
        (dir, roots)
    }

    /// A folder under the system's temp folder, removed when dropped.
    mod tempdir {
        pub struct Dir(std::path::PathBuf);
        impl Dir {
            pub fn new() -> Self {
                let n = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_nanos());
                let path = std::env::temp_dir()
                    .join(format!("sync-user-files-{}-{n}", std::process::id()));
                std::fs::create_dir_all(&path).unwrap();
                Self(path)
            }
            pub fn path(&self) -> &std::path::Path {
                &self.0
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn only_the_names_that_sync_resolve() {
        let (_dir, roots) = roots();
        for ok in [
            "keybindings.json",
            "AGENTS.md",
            "snippets/go.json",
            "snippets/all.code-snippets",
            "agents/reviewer.md",
            "commands/ship.md",
            "output-styles/terse.md",
            "skills/review/SKILL.md",
            "skills/review/scripts/run.py",
            "keybindings.conflict.json",
        ] {
            assert!(roots.resolve(ok).is_ok(), "{ok}");
        }
        for bad in [
            "settings.json",
            "mcp.json",
            "secrets.json",
            "../settings.json",
            "snippets/../settings.json",
            "snippets/x.exe",
            "agents/x.json",
            "skills",
            "skills/",
            "skills/../../x",
            "/etc/passwd",
            "C:/x",
            "snippets\\x.json",
            "",
            "memory/a.md",
            "skills/a/b/c/d/e/f/g.md",
        ] {
            assert!(roots.resolve(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn write_scan_read_and_remove() {
        let (_dir, roots) = roots();
        roots.write("keybindings.json", Some("[]")).unwrap();
        roots.write("snippets/go.json", Some("{}")).unwrap();
        let written = roots
            .write("skills/review/SKILL.md", Some("# Review"))
            .unwrap()
            .unwrap();
        // Not synced: another ending, a conflict copy, a hidden file, something that isn't text.
        std::fs::write(roots.config.join("snippets").join("notes.txt"), "x").unwrap();
        std::fs::write(roots.config.join("snippets").join("go.conflict.json"), "{}").unwrap();
        std::fs::write(
            roots
                .skills
                .as_ref()
                .unwrap()
                .join("review")
                .join(".DS_Store"),
            "x",
        )
        .unwrap();
        std::fs::write(
            roots
                .skills
                .as_ref()
                .unwrap()
                .join("review")
                .join("logo.png"),
            [0xff, 0xfe, 0x00],
        )
        .unwrap();
        let found = roots.scan();
        let names: Vec<&str> = found.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            names,
            [
                "keybindings.json",
                "snippets/go.json",
                "skills/review/SKILL.md"
            ]
        );
        assert_eq!(found[2].hash, written.hash);
        assert_eq!(
            roots.read("skills/review/SKILL.md").unwrap().as_deref(),
            Some("# Review")
        );
        assert_eq!(roots.read("agents/none.md").unwrap(), None);
        assert_eq!(roots.write("snippets/go.json", None).unwrap(), None);
        assert_eq!(
            roots.write("snippets/go.json", None).unwrap(),
            None,
            "removing twice is fine"
        );
        assert_eq!(roots.scan().len(), 2);
        // The same text has the same hash wherever it is.
        let a = roots.write("agents/a.md", Some("same")).unwrap().unwrap();
        let b = roots.write("commands/b.md", Some("same")).unwrap().unwrap();
        assert_eq!(a.hash, b.hash);
    }
}
