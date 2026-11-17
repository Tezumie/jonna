//! The user's own files that sync with the account (D435): keybindings, rules, snippets,
//! subagents, commands, output styles and skills. Each has a stable name (`snippets/x.json`,
//! `skills/review/SKILL.md`) that is the same on every computer, whatever folder it is in here.

use std::collections::BTreeSet;
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

/// What a scan found.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    pub files: Vec<UserFile>,
    /// Names that are there but can't sync as they are (too large, not text, unreadable):
    /// neither sent nor taken to be deleted.
    pub kept: Vec<String>,
    /// False when a folder couldn't be listed or the scan was cut short: then nothing that
    /// is missing from `files` may be taken to be deleted.
    pub complete: bool,
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

/// Where a conflict copy's mark is in a name: `.conflict`, or `.conflict-2` and so on for a
/// later copy, before the ending or at the name's end.
fn conflict_mark(name: &str) -> Option<std::ops::Range<usize>> {
    const MARK: &str = ".conflict";
    let mut from = 0;
    while let Some(at) = name.get(from..).and_then(|rest| rest.find(MARK)) {
        let start = from + at;
        let mut end = start + MARK.len();
        if let Some(digits) = name.get(end..).and_then(|rest| rest.strip_prefix('-')) {
            let count = digits.bytes().take_while(u8::is_ascii_digit).count();
            if count > 0 {
                end += 1 + count;
            }
        }
        if end == name.len() || name.get(end..).is_some_and(|rest| rest.starts_with('.')) {
            return Some(start..end);
        }
        from = start + 1;
    }
    None
}

/// A file kept beside the one it lost to; never synced itself.
pub(super) fn is_conflict_copy(name: &str) -> bool {
    conflict_mark(name).is_some()
}

fn hash(bytes: &[u8]) -> String {
    super::crypto::b64(&Sha256::digest(bytes)[..16])
}

/// A file's content as the scans name it (for telling whether a file is still as it was).
pub(super) fn content_hash(bytes: &[u8]) -> String {
    hash(bytes)
}

/// Names that were refused here because, on this file system, they are another file's name
/// in other letter case (the place each stands for, and the name): listed as kept by the next
/// scans while that is still so, so they are neither asked for again nor taken to be deleted.
static OTHER_CASE: std::sync::Mutex<BTreeSet<(PathBuf, String)>> =
    std::sync::Mutex::new(BTreeSet::new());

/// Whether `file` (somewhere under `base`) is there only under a name in other letter case:
/// a file system that doesn't tell `Review` from `review` finds it, and its folder lists no
/// such name. Writing it would write the other file; removing it would remove the other file.
fn other_case(base: &Path, file: &Path) -> bool {
    let Ok(rest) = file.strip_prefix(base) else {
        return false;
    };
    let mut at = base.to_path_buf();
    for part in rest.components() {
        let name = part.as_os_str();
        let next = at.join(name);
        // Nothing there under any spelling: a new name.
        if std::fs::symlink_metadata(&next).is_err() {
            return false;
        }
        let Ok(entries) = std::fs::read_dir(&at) else {
            return false;
        };
        if !entries.flatten().any(|e| e.file_name() == name) {
            return true;
        }
        at = next;
    }
    false
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
                    // A device's name on Windows, a trailing dot or space, a stream: a file
                    // of that name can't be written there as it is (the snapshots' own check).
                    || super::snapshot::unsafe_name(p)
            })
        {
            return Err(refused());
        }
        // A conflict copy (`name.conflict.ext`, `name.conflict-2.ext`) lives where its file does.
        let name = parts.last().copied().unwrap_or("");
        let plain = match conflict_mark(name) {
            Some(mark) => format!("{}{}", &name[..mark.start], &name[mark.end..]),
            None => name.to_string(),
        };
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

    /// The folder a resolved place is under: the skills folder or the config folder.
    fn base_of(&self, file: &Path) -> &Path {
        match &self.skills {
            Some(skills) if file.starts_with(skills) => skills,
            _ => &self.config,
        }
    }

    /// `resolve`, with whether the name is another file's in other letter case here; such a
    /// name is remembered, for the scans to list as kept.
    fn place(&self, path: &str) -> Result<(PathBuf, bool)> {
        let file = self.resolve(path)?;
        let clash = other_case(self.base_of(&file), &file);
        if clash {
            OTHER_CASE
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert((file.clone(), path.to_string()));
        }
        Ok((file, clash))
    }

    /// The names refused for their letter case that still can't be told apart here.
    fn kept_for_case(&self, out: &mut Scan) {
        let mut names = OTHER_CASE.lock().unwrap_or_else(|e| e.into_inner());
        let mine = |file: &Path| {
            file.starts_with(&self.config)
                || self.skills.as_ref().is_some_and(|s| file.starts_with(s))
        };
        names.retain(|(file, _)| !mine(file) || other_case(self.base_of(file), file));
        for (file, name) in names.iter() {
            if mine(file) && !out.kept.contains(name) {
                out.kept.push(name.clone());
            }
        }
    }

    fn note(&self, out: &mut Scan, name: String, file: &Path) {
        if out.files.len() >= MAX_FILES {
            out.complete = false;
            return;
        }
        let meta = match std::fs::metadata(file) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            // There, and not readable just now: kept as it is.
            Err(_) => {
                out.kept.push(name);
                return;
            }
        };
        if !meta.is_file() {
            return;
        }
        // Too large, or a name that can't be a synced file's (one no Windows computer could
        // write, say): there, and left alone on both sides.
        if meta.len() > MAX_BYTES || self.resolve(&name).is_err() {
            out.kept.push(name);
            return;
        }
        // Text only: a record carries text. Anything else stays where it is, on both sides.
        match std::fs::read(file) {
            Ok(bytes) if std::str::from_utf8(&bytes).is_ok() => out.files.push(UserFile {
                path: name,
                hash: hash(&bytes),
                mtime_ms: mtime(&meta),
            }),
            _ => out.kept.push(name),
        }
    }

    fn walk(&self, out: &mut Scan, prefix: &str, dir: &Path, depth: usize) {
        // As deep as a name may be (`resolve` takes `MAX_DEPTH` parts): deeper files stay local.
        if depth >= MAX_DEPTH {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            // A folder that can't be listed: what was in it isn't known to be gone.
            Err(_) => {
                out.complete = false;
                return;
            }
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
                out.complete = false;
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

    /// Every file that syncs, with its content's hash; what is there and can't sync as it is;
    /// and whether everything could be looked at.
    pub fn scan(&self) -> Scan {
        let mut out = Scan {
            files: Vec::new(),
            kept: Vec::new(),
            complete: true,
        };
        for name in FILES {
            self.note(&mut out, (*name).to_string(), &self.config.join(name));
        }
        for (folder, endings) in FOLDERS {
            let entries = match std::fs::read_dir(self.config.join(folder)) {
                Ok(entries) => entries,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    out.complete = false;
                    continue;
                }
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
        match &self.skills {
            Some(skills) => self.walk(&mut out, "skills", skills, 1),
            // No home folder to look in: the skills aren't known to be gone.
            None => out.complete = false,
        }
        self.kept_for_case(&mut out);
        out
    }

    pub fn read(&self, path: &str) -> Result<Option<String>> {
        let (file, clash) = self.place(path)?;
        // Another file's name in other letter case: this one isn't here.
        if clash {
            return Ok(None);
        }
        match std::fs::read_to_string(file) {
            Ok(text) => Ok(Some(text)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Writes a synced file (`text` None removes it). Returns its new entry.
    pub fn write(&self, path: &str, text: Option<&str>) -> Result<Option<UserFile>> {
        let (file, clash) = self.place(path)?;
        if clash {
            // Removing it would remove the other file; writing it would replace the other's
            // text. Neither: the two names can't both be here.
            return match text {
                None => Ok(None),
                Some(_) => Err(Error::Invalid(format!(
                    "another file here has this name in other letter case, so it isn't synced to this computer: {path}"
                ))),
            };
        }
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
            // Names a Windows computer can't write as they are.
            "snippets/nul.json",
            "skills/review/AUX.md",
            "skills/com1/SKILL.md",
            "skills/review./SKILL.md",
            "skills/review/notes.md ",
            "agents/x.md.",
        ] {
            assert!(roots.resolve(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_name_no_synced_file_may_have_is_kept_not_sent() {
        let (_dir, roots) = roots();
        roots
            .write("skills/review/SKILL.md", Some("# Review"))
            .unwrap();
        // Made outside the app. (Windows itself refuses such a name: then there is nothing
        // to keep.)
        let odd = roots.skills.as_ref().unwrap().join("review").join("aux.md");
        let made = std::fs::write(&odd, "x").is_ok() && odd.is_file();
        let scan = roots.scan();
        assert!(scan.complete);
        let names: Vec<&str> = scan.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(names, ["skills/review/SKILL.md"]);
        if made {
            assert_eq!(scan.kept, ["skills/review/aux.md"]);
        }
    }

    #[test]
    fn a_name_in_other_letter_case_is_kept_not_written_over() {
        let (_dir, roots) = roots();
        roots
            .write("skills/Review/SKILL.md", Some("first"))
            .unwrap();
        roots.write("snippets/Go.json", Some("{}")).unwrap();
        // Whether this file system tells the two apart.
        let folds = roots.skills.as_ref().unwrap().join("review").exists();
        let second = roots.write("skills/review/SKILL.md", Some("second"));
        let third = roots.write("snippets/go.json", Some("[]"));
        if !folds {
            // Both names fit here: both are files and both sync.
            assert!(second.is_ok() && third.is_ok());
            assert_eq!(roots.scan().files.len(), 4);
            assert!(roots.scan().kept.is_empty());
            return;
        }
        assert!(matches!(second, Err(Error::Invalid(_))));
        assert!(matches!(third, Err(Error::Invalid(_))));
        // The file that was here first is as it was, and the other name isn't here.
        assert_eq!(
            roots.read("skills/Review/SKILL.md").unwrap().as_deref(),
            Some("first")
        );
        assert_eq!(roots.read("skills/review/SKILL.md").unwrap(), None);
        // Listed as kept: not sent, not asked for again, and not taken to be deleted.
        let scan = roots.scan();
        let names: Vec<&str> = scan.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(names, ["snippets/Go.json", "skills/Review/SKILL.md"]);
        let mut kept = scan.kept.clone();
        kept.sort();
        assert_eq!(kept, ["skills/review/SKILL.md", "snippets/go.json"]);
        // Removing the name that isn't here leaves the other file alone.
        assert_eq!(roots.write("skills/review/SKILL.md", None).unwrap(), None);
        assert_eq!(
            roots.read("skills/Review/SKILL.md").unwrap().as_deref(),
            Some("first")
        );
        // Once the other file is gone the name is free again.
        roots.write("skills/Review/SKILL.md", None).unwrap();
        std::fs::remove_dir(roots.skills.as_ref().unwrap().join("Review")).unwrap();
        assert_eq!(roots.scan().kept, ["snippets/go.json"]);
        roots
            .write("skills/review/SKILL.md", Some("second"))
            .unwrap();
        assert_eq!(
            roots.read("skills/review/SKILL.md").unwrap().as_deref(),
            Some("second")
        );
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
        let scan = roots.scan();
        assert!(scan.complete);
        // Not text: there, and left alone on both sides.
        assert_eq!(scan.kept, ["skills/review/logo.png"]);
        let found = scan.files;
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
        assert_eq!(roots.scan().files.len(), 2);
        // The same text has the same hash wherever it is.
        let a = roots.write("agents/a.md", Some("same")).unwrap().unwrap();
        let b = roots.write("commands/b.md", Some("same")).unwrap().unwrap();
        assert_eq!(a.hash, b.hash);
    }

    #[test]
    fn a_later_conflict_copy_is_a_conflict_copy_too() {
        assert_eq!(conflict_mark("keybindings.conflict.json"), Some(11..20));
        assert_eq!(conflict_mark("keybindings.conflict-2.json"), Some(11..22));
        assert_eq!(conflict_mark("AGENTS.conflict-12.md"), Some(6..18));
        assert_eq!(conflict_mark("notes.conflict"), Some(5..14));
        assert_eq!(conflict_mark("notes.conflict-3"), Some(5..16));
        // Not marks: a word that only starts so, a dash with no number.
        assert_eq!(conflict_mark("my.conflicts.md"), None);
        assert_eq!(conflict_mark("a.conflict-.md"), None);
        assert_eq!(conflict_mark("a.conflict-x.md"), None);
        assert!(is_conflict_copy("go.conflict-2.json"));
        assert!(!is_conflict_copy("conflict.json"));
    }
}
