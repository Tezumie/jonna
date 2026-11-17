//! Which of the user's synced files are on this computer as a sync download wrote them, not
//! yet accepted here by the person. Another computer of the account (or whoever holds its
//! keys) can write these files, so until they are accepted a skill or command among them
//! approves no tools and a keyboard shortcut that could run something isn't applied (the
//! front end reads this list for both). A file edited here afterwards has other content and
//! drops off the list by itself: what the person wrote is theirs.
//!
//! The record is this computer's own (`<data>/sync-incoming.json`, beside the sync folder and
//! never synced), and it outlives sync going off: what waited still waits when sync comes
//! back. No record (a first run after an update): nothing waits, so what is on disk already
//! counts as accepted.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::user_files::{content_hash, is_conflict_copy, Roots};
use crate::error::Result;
use crate::store::atomic_write;

/// The keyboard shortcuts' synced name: the one file whose earlier text is kept, so that only
/// the shortcuts a download added are held back.
const KEYBINDINGS: &str = "keybindings.json";

/// One read-change-write of the record at a time.
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Default, Serialize, Deserialize)]
struct Record {
    #[serde(default)]
    files: BTreeMap<String, Entry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    /// The content the download wrote.
    hash: String,
    /// The keyboard shortcuts as they were before the first download not accepted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    before: Option<String>,
    /// Whether the person was told.
    #[serde(default)]
    told: bool,
}

/// A file that waits, as the front end reads it.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IncomingFile {
    pub path: String,
    pub before: Option<String>,
    pub told: bool,
}

/// Whether a synced name is one to review: everything that steers the agent or can run
/// something. Snippets are text to insert, and a conflict copy is used by nothing.
pub fn reviewed(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    !path.starts_with("snippets/") && !is_conflict_copy(name)
}

pub struct Incoming {
    file: PathBuf,
}

impl Incoming {
    /// The record of the profile whose data folder is `data`.
    pub fn new(data: &std::path::Path) -> Self {
        Self {
            file: data.join("sync-incoming.json"),
        }
    }

    fn load(&self) -> Record {
        std::fs::read_to_string(&self.file)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    fn save(&self, record: &Record) -> Result<()> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        atomic_write(&self.file, serde_json::to_string_pretty(record)?.as_bytes())
    }

    /// A sync download is about to write `text` to `path`, where `before` is now (None: no
    /// file). Called before the write, so the file is never there unlisted.
    pub fn downloading(&self, path: &str, before: Option<&str>, text: &str) -> Result<()> {
        if !reviewed(path) {
            return Ok(());
        }
        let new = content_hash(text.as_bytes());
        let old = before.map(|b| content_hash(b.as_bytes()));
        // The same text as is here: nothing arrives.
        if old.as_deref() == Some(new.as_str()) {
            return Ok(());
        }
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut record = self.load();
        // What is here now is itself a download that still waits: the text before that one is
        // the last the person had, and what they were told stays told.
        let waiting = record
            .files
            .get(path)
            .filter(|entry| Some(entry.hash.as_str()) == old.as_deref())
            .cloned();
        let entry = match waiting {
            Some(entry) => Entry { hash: new, ..entry },
            None => Entry {
                hash: new,
                before: before.filter(|_| path == KEYBINDINGS).map(str::to_string),
                told: false,
            },
        };
        record.files.insert(path.to_string(), entry);
        self.save(&record)
    }

    /// A sync pass removed `path` here: nothing of it waits.
    pub fn removed(&self, path: &str) -> Result<()> {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut record = self.load();
        if record.files.remove(path).is_some() {
            self.save(&record)?;
        }
        Ok(())
    }

    /// The files that wait: still as the download wrote them. One that was edited here since,
    /// or is gone, is dropped from the record.
    pub fn list(&self, roots: &Roots) -> Vec<IncomingFile> {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut record = self.load();
        let before = record.files.len();
        record.files.retain(|path, entry| {
            roots
                .read(path)
                .ok()
                .flatten()
                .is_some_and(|text| content_hash(text.as_bytes()) == entry.hash)
        });
        if record.files.len() != before {
            // Not saved: the same files are dropped again at the next read.
            let _ = self.save(&record);
        }
        record
            .files
            .into_iter()
            .map(|(path, entry)| IncomingFile {
                path,
                before: entry.before,
                told: entry.told,
            })
            .collect()
    }

    /// The person accepted these files (None: all of them) on this computer.
    pub fn accept(&self, paths: Option<&[String]>) -> Result<()> {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut record = self.load();
        let before = record.files.len();
        match paths {
            Some(paths) => record.files.retain(|path, _| !paths.contains(path)),
            None => record.files.clear(),
        }
        if record.files.len() != before {
            self.save(&record)?;
        }
        Ok(())
    }

    /// The person was told about everything that waits now.
    pub fn told(&self) -> Result<()> {
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut record = self.load();
        if record.files.values().all(|entry| entry.told) {
            return Ok(());
        }
        for entry in record.files.values_mut() {
            entry.told = true;
        }
        self.save(&record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn setup(name: &str) -> (Dir, Roots, Incoming) {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let dir =
            std::env::temp_dir().join(format!("sync-incoming-{name}-{}-{n}", std::process::id()));
        let roots = Roots {
            config: dir.join("config"),
            skills: Some(dir.join("home").join("skills")),
        };
        std::fs::create_dir_all(&roots.config).unwrap();
        let incoming = Incoming::new(&dir.join("data"));
        (Dir(dir), roots, incoming)
    }

    /// What `sync_user_file_write` does for a download.
    fn download(roots: &Roots, incoming: &Incoming, path: &str, text: &str) {
        let before = roots.read(path).unwrap();
        incoming.downloading(path, before.as_deref(), text).unwrap();
        roots.write(path, Some(text)).unwrap();
    }

    fn names(list: &[IncomingFile]) -> Vec<&str> {
        list.iter().map(|f| f.path.as_str()).collect()
    }

    #[test]
    fn what_is_on_disk_without_a_record_is_accepted() {
        let (_dir, roots, incoming) = setup("fresh");
        // An install from before this record existed: files are there, the record isn't.
        roots
            .write("skills/review/SKILL.md", Some("# Mine"))
            .unwrap();
        roots.write("keybindings.json", Some("[]")).unwrap();
        assert!(incoming.list(&roots).is_empty());
    }

    #[test]
    fn a_download_waits_until_accepted_and_a_local_edit_accepts() {
        let (_dir, roots, incoming) = setup("waits");
        download(&roots, &incoming, "skills/review/SKILL.md", "# Theirs");
        download(&roots, &incoming, "commands/ship.md", "ship");
        download(&roots, &incoming, "AGENTS.md", "rules");
        // Text to insert, and a copy nothing uses, aren't reviewed.
        download(&roots, &incoming, "snippets/go.json", "{}");
        download(&roots, &incoming, "commands/ship.conflict.md", "old");
        assert_eq!(
            names(&incoming.list(&roots)),
            ["AGENTS.md", "commands/ship.md", "skills/review/SKILL.md"]
        );
        // Accepted here: gone from the list, and it stays gone.
        incoming
            .accept(Some(&["commands/ship.md".to_string()]))
            .unwrap();
        assert_eq!(
            names(&incoming.list(&roots)),
            ["AGENTS.md", "skills/review/SKILL.md"]
        );
        // Edited on this computer: the person's own text now.
        roots
            .write("skills/review/SKILL.md", Some("# Theirs, and mine"))
            .unwrap();
        assert_eq!(names(&incoming.list(&roots)), ["AGENTS.md"]);
        // Putting the downloaded text back by hand doesn't make it wait again.
        roots
            .write("skills/review/SKILL.md", Some("# Theirs"))
            .unwrap();
        assert_eq!(names(&incoming.list(&roots)), ["AGENTS.md"]);
        incoming.accept(None).unwrap();
        assert!(incoming.list(&roots).is_empty());
    }

    #[test]
    fn the_same_text_arriving_is_nothing_new_and_a_removal_clears() {
        let (_dir, roots, incoming) = setup("same");
        roots.write("commands/ship.md", Some("ship")).unwrap();
        download(&roots, &incoming, "commands/ship.md", "ship");
        assert!(incoming.list(&roots).is_empty());
        download(&roots, &incoming, "commands/ship.md", "ship it");
        assert_eq!(names(&incoming.list(&roots)), ["commands/ship.md"]);
        // A pass removes the file here.
        incoming.removed("commands/ship.md").unwrap();
        roots.write("commands/ship.md", None).unwrap();
        assert!(incoming.list(&roots).is_empty());
        // A file of that name made here later is the person's.
        roots.write("commands/ship.md", Some("ship it")).unwrap();
        assert!(incoming.list(&roots).is_empty());
    }

    #[test]
    fn the_shortcuts_keep_the_text_from_before_the_first_download_not_accepted() {
        let (_dir, roots, incoming) = setup("keys");
        roots.write("keybindings.json", Some("[\"mine\"]")).unwrap();
        download(&roots, &incoming, "keybindings.json", "[\"first\"]");
        let list = incoming.list(&roots);
        assert_eq!(list[0].before.as_deref(), Some("[\"mine\"]"));
        assert!(!list[0].told);
        incoming.told().unwrap();
        // A second download over the first, still not accepted: what the person last had is
        // still "before", and they aren't told twice.
        download(&roots, &incoming, "keybindings.json", "[\"second\"]");
        let list = incoming.list(&roots);
        assert_eq!(list[0].before.as_deref(), Some("[\"mine\"]"));
        assert!(list[0].told);
        // Accepted, then another arrives: "before" is what was accepted, and it is new.
        incoming.accept(None).unwrap();
        download(&roots, &incoming, "keybindings.json", "[\"third\"]");
        let list = incoming.list(&roots);
        assert_eq!(list[0].before.as_deref(), Some("[\"second\"]"));
        assert!(!list[0].told);
        // No file before: nothing was here.
        let (_dir2, roots2, incoming2) = setup("keys-none");
        download(&roots2, &incoming2, "keybindings.json", "[]");
        assert_eq!(incoming2.list(&roots2)[0].before, None);
        // Other files keep no earlier text.
        roots2.write("commands/a.md", Some("old")).unwrap();
        download(&roots2, &incoming2, "commands/a.md", "new");
        let list = incoming2.list(&roots2);
        assert_eq!(list[0].path, "commands/a.md");
        assert_eq!(list[0].before, None);
    }

    #[test]
    fn a_damaged_record_reads_as_none() {
        let (_dir, roots, incoming) = setup("damaged");
        download(&roots, &incoming, "commands/ship.md", "ship");
        std::fs::write(&incoming.file, "{ not json").unwrap();
        assert!(incoming.list(&roots).is_empty());
        // And the next download is recorded again.
        download(&roots, &incoming, "commands/ship.md", "ship it");
        assert_eq!(names(&incoming.list(&roots)), ["commands/ship.md"]);
    }
}
