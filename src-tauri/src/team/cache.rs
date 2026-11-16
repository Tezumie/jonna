//! What this computer keeps of a team's library: `<data>/team/<team>/` with the list as last
//! read (`library.json`), the text of every item (`items/`, so one can be looked at without
//! asking the service) and `active/`, a tree of only the items that are on here, each at the
//! name its kind has. The loaders (rules, skills, commands…) read `active/` and nothing else.
//! Beside `<data>/plugins`, not under `<data>/sync`: turning sync off doesn't take the team's
//! library away.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::{paths, Item, TeamRef, MAX_ITEM_BYTES, MAX_TOTAL_BYTES};
use crate::error::{Error, Result};
use crate::store::atomic_write;

/// The list as last read, and which texts are here.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Index {
    pub team: Option<TeamRef>,
    /// "on", or "lapsed" (the team's subscription ended: read, not changed).
    pub state: String,
    /// The profile's `libraryRev` when the list was read.
    pub rev: Option<u64>,
    pub items: Vec<Item>,
    /// Item id → the version whose text is in `items/`.
    pub cached: BTreeMap<String, u64>,
    /// When the list was last read from the service, in ms.
    pub fetched_at: u64,
}

/// What `apply` did.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    /// The `active/` folder.
    pub dir: String,
    /// Files in it now.
    pub files: usize,
    pub written: usize,
    pub removed: usize,
}

pub struct Cache {
    root: PathBuf,
}

/// `<data>/team`: every team's cache (one at a time, in practice).
pub fn teams_dir(data: &Path) -> PathBuf {
    data.join("team")
}

fn hex(text: &str) -> String {
    text.bytes().map(|b| format!("{b:02x}")).collect()
}

impl Cache {
    pub fn new(data: &Path, team_id: &str) -> Self {
        Self {
            root: teams_dir(data).join(paths::folder_name(team_id)),
        }
    }

    pub fn active_dir(&self) -> PathBuf {
        self.root.join("active")
    }

    fn index_file(&self) -> PathBuf {
        self.root.join("library.json")
    }

    /// An item's text file. Ids differ by case and some file systems don't: the name is the
    /// id's bytes in hex.
    fn text_file(&self, id: &str) -> PathBuf {
        self.root.join("items").join(format!("{}.txt", hex(id)))
    }

    /// The list as last saved; empty when there is none, or it can't be read.
    pub fn index(&self) -> Index {
        std::fs::read(self.index_file())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn save(&self, index: &Index) -> Result<()> {
        atomic_write(&self.index_file(), &serde_json::to_vec(index)?)
    }

    /// An item's text, when it is here.
    pub fn text(&self, id: &str) -> Result<Option<String>> {
        if !paths::valid_id(id) {
            return Err(Error::Invalid(format!("not an item of the library: {id}")));
        }
        match std::fs::read_to_string(self.text_file(id)) {
            Ok(text) => Ok(Some(text)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Bytes of text kept, without the items in `except`.
    fn kept_bytes(&self, index: &Index, except: &str) -> u64 {
        index
            .cached
            .keys()
            .filter(|id| id.as_str() != except)
            .filter_map(|id| std::fs::metadata(self.text_file(id)).ok())
            .map(|m| m.len())
            .sum()
    }

    /// Replaces the list with what the service says now. Texts of items that left it, or whose
    /// kind or name changed, go; the others stay until a newer version is stored.
    pub fn set_listing(
        &self,
        team: TeamRef,
        state: &str,
        rev: Option<u64>,
        items: Vec<Item>,
        now_ms: u64,
    ) -> Result<Index> {
        let mut index = self.index();
        let before: BTreeMap<String, (String, String)> = index
            .items
            .iter()
            .map(|i| (i.id.clone(), (i.kind.clone(), i.path.clone())))
            .collect();
        let listed: BTreeMap<&str, &Item> = items.iter().map(|i| (i.id.as_str(), i)).collect();
        let stale: Vec<String> = index
            .cached
            .keys()
            .filter(|id| match (listed.get(id.as_str()), before.get(*id)) {
                (Some(item), Some((kind, path))) => item.kind != *kind || item.path != *path,
                _ => true,
            })
            .cloned()
            .collect();
        for id in stale {
            let _ = std::fs::remove_file(self.text_file(&id));
            index.cached.remove(&id);
        }
        index.team = Some(team);
        index.state = state.to_string();
        index.rev = rev;
        index.items = items;
        index.fetched_at = now_ms;
        self.save(&index)?;
        Ok(index)
    }

    /// Keeps a listed item's text. Refused when it is not in the list, too large, or the cache
    /// would pass the library's size.
    pub fn store_text(&self, id: &str, version: u64, text: &str) -> Result<()> {
        let mut index = self.index();
        if !index.items.iter().any(|i| i.id == id) {
            return Err(Error::Invalid(format!("not an item of the library: {id}")));
        }
        let size = text.len() as u64;
        if size > MAX_ITEM_BYTES {
            return Err(Error::Invalid(format!("too large for the library: {id}")));
        }
        if self.kept_bytes(&index, id) + size > MAX_TOTAL_BYTES {
            return Err(Error::Invalid(
                "The team's library is larger than a library may be.".into(),
            ));
        }
        atomic_write(&self.text_file(id), text.as_bytes())?;
        index.cached.insert(id.to_string(), version);
        self.save(&index)
    }

    /// Makes `active/` hold exactly the items in `active` whose text is here, each at its
    /// kind's name: changed files written, the rest removed. A name that doesn't pass
    /// `paths::check` is never written.
    pub fn apply(&self, active: &[String]) -> Result<Applied> {
        let index = self.index();
        let on: BTreeSet<&str> = active.iter().map(String::as_str).collect();
        let dir = self.active_dir();
        let mut wanted: BTreeMap<PathBuf, String> = BTreeMap::new();
        for item in &index.items {
            if !on.contains(item.id.as_str()) || !index.cached.contains_key(&item.id) {
                continue;
            }
            let Some(parts) = paths::check(&item.kind, &item.path) else {
                continue;
            };
            let Some(text) = self.text(&item.id)? else {
                continue;
            };
            let mut rel = PathBuf::new();
            rel.extend(parts);
            wanted.insert(rel, text);
        }
        let mut removed = 0;
        prune(&dir, Path::new(""), &wanted, &mut removed)?;
        let mut written = 0;
        for (rel, text) in &wanted {
            let file = dir.join(rel);
            if std::fs::read(&file).is_ok_and(|had| had == text.as_bytes()) {
                continue;
            }
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent)?;
            }
            atomic_write(&file, text.as_bytes())?;
            written += 1;
        }
        Ok(Applied {
            dir: dir.to_string_lossy().into_owned(),
            files: wanted.len(),
            written,
            removed,
        })
    }
}

/// Removes from `dir/rel` what `wanted` doesn't name: files, links (never followed), and
/// folders left empty.
fn prune(
    dir: &Path,
    rel: &Path,
    wanted: &BTreeMap<PathBuf, String>,
    removed: &mut usize,
) -> Result<bool> {
    let here = dir.join(rel);
    let entries = match std::fs::read_dir(&here) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(e) => return Err(e.into()),
    };
    let mut empty = true;
    for entry in entries {
        let entry = entry?;
        let kind = entry.file_type()?;
        let child = rel.join(entry.file_name());
        if kind.is_dir() {
            // A folder where a file is wanted goes too.
            if !wanted.contains_key(&child) && !prune(dir, &child, wanted, removed)? {
                empty = false;
                continue;
            }
            std::fs::remove_dir_all(entry.path())?;
        } else if wanted.contains_key(&child) && kind.is_file() {
            empty = false;
        } else {
            crate::fs::remove_file_or_link(&entry.path(), kind)?;
            *removed += 1;
        }
    }
    Ok(empty)
}

/// Removes every team's cache but `keep`'s (a team id; None: all of them): the account left
/// that team, signed out, or is in another one. Returns how many went.
pub fn clear_others(data: &Path, keep: Option<&str>) -> Result<usize> {
    let keep = keep.map(paths::folder_name);
    let entries = match std::fs::read_dir(teams_dir(data)) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    let mut gone = 0;
    for entry in entries {
        let entry = entry?;
        if keep.as_deref().is_some_and(|k| entry.file_name() == k) {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_dir() {
            std::fs::remove_dir_all(entry.path())?;
        } else {
            crate::fs::remove_file_or_link(&entry.path(), kind)?;
        }
        gone += 1;
    }
    Ok(gone)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder under the system's temp folder, removed when dropped.
    struct Dir(PathBuf);
    impl Dir {
        fn new(name: &str) -> Self {
            let n = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            let path =
                std::env::temp_dir().join(format!("ide-team-{name}-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn item(id: &str, kind: &str, path: &str, version: u64) -> Item {
        Item {
            id: id.into(),
            kind: kind.into(),
            path: path.into(),
            is_default: true,
            version,
            size: 0,
            by: String::new(),
            updated_at: None,
        }
    }

    fn team() -> TeamRef {
        TeamRef {
            id: "t1".into(),
            name: "Studio".into(),
        }
    }

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn writes_replaces_and_removes_what_is_no_longer_active() {
        let dir = Dir::new("apply");
        let cache = Cache::new(&dir.0, "t1");
        let items = vec![
            item("r", "rules", "AGENTS.md", 1),
            item("s1", "skills", "skills/review/SKILL.md", 1),
            item("s2", "skills", "skills/review/scripts/run.py", 1),
            item("c", "commands", "commands/ship.md", 1),
        ];
        cache
            .set_listing(team(), "on", Some(3), items.clone(), 10)
            .unwrap();
        for (id, text) in [
            ("r", "rules"),
            ("s1", "# Review"),
            ("s2", "print()"),
            ("c", "ship"),
        ] {
            cache.store_text(id, 1, text).unwrap();
        }
        let active = cache.active_dir();
        let done = cache.apply(&ids(&["r", "s1", "s2", "c"])).unwrap();
        assert_eq!((done.files, done.written, done.removed), (4, 4, 0));
        assert_eq!(
            std::fs::read_to_string(active.join("AGENTS.md")).unwrap(),
            "rules"
        );
        assert_eq!(
            std::fs::read_to_string(active.join("skills/review/scripts/run.py")).unwrap(),
            "print()"
        );
        // Nothing changed: nothing is written again.
        let again = cache.apply(&ids(&["r", "s1", "s2", "c"])).unwrap();
        assert_eq!((again.written, again.removed), (0, 0));
        // A newer text replaces the file; an item turned off goes, with its empty folders.
        cache.store_text("r", 2, "newer rules").unwrap();
        let next = cache.apply(&ids(&["r", "c"])).unwrap();
        assert_eq!((next.files, next.written, next.removed), (2, 1, 2));
        assert_eq!(
            std::fs::read_to_string(active.join("AGENTS.md")).unwrap(),
            "newer rules"
        );
        assert!(!active.join("skills").exists());
        assert!(active.join("commands/ship.md").is_file());
        // A file nobody listed doesn't stay in the tree the loaders read.
        std::fs::write(active.join("commands/planted.md"), "x").unwrap();
        assert_eq!(cache.apply(&ids(&["r", "c"])).unwrap().removed, 1);
        assert!(!active.join("commands/planted.md").exists());
        // The text of an item that is off is still here, for a preview.
        assert_eq!(cache.text("s1").unwrap().as_deref(), Some("# Review"));
        assert_eq!(cache.index().cached.get("r"), Some(&2));
    }

    #[test]
    fn a_list_drops_the_texts_of_items_that_left_it() {
        let dir = Dir::new("list");
        let cache = Cache::new(&dir.0, "t1");
        cache
            .set_listing(
                team(),
                "on",
                Some(1),
                vec![
                    item("a", "commands", "commands/a.md", 1),
                    item("b", "commands", "commands/b.md", 1),
                ],
                1,
            )
            .unwrap();
        cache.store_text("a", 1, "a").unwrap();
        cache.store_text("b", 1, "b").unwrap();
        // `a` left; `b` is another file now under the same id: its old text isn't that file's.
        let index = cache
            .set_listing(
                team(),
                "lapsed",
                Some(2),
                vec![item("b", "agents", "agents/b.md", 2)],
                2,
            )
            .unwrap();
        assert!(index.cached.is_empty());
        assert_eq!(index.state, "lapsed");
        assert_eq!(cache.text("a").unwrap(), None);
        assert_eq!(cache.text("b").unwrap(), None);
        cache.apply(&ids(&["a", "b"])).unwrap();
        assert!(!cache.active_dir().join("commands").exists());
        // Not in the list: not stored.
        assert!(cache.store_text("a", 1, "a").is_err());
    }

    #[test]
    fn a_name_that_would_leave_the_cache_is_never_written() {
        let dir = Dir::new("escape");
        let cache = Cache::new(&dir.0, "t1");
        // As if a damaged or planted library.json named them.
        let bad = vec![
            item("e1", "skills", "skills/../../escaped.md", 1),
            item("e2", "commands", "commands/NUL.md", 1),
            item("e3", "hooks", "hooks.json", 1),
            item("ok", "commands", "commands/fine.md", 1),
        ];
        cache.set_listing(team(), "on", None, bad, 1).unwrap();
        for id in ["e1", "e2", "e3", "ok"] {
            cache.store_text(id, 1, "x").unwrap();
        }
        let done = cache.apply(&ids(&["e1", "e2", "e3", "ok"])).unwrap();
        assert_eq!(done.files, 1);
        assert!(!teams_dir(&dir.0).join("escaped.md").exists());
        assert!(!dir.0.join("escaped.md").exists());
        assert!(cache.text("../x").is_err());
    }

    #[test]
    fn sizes_are_capped() {
        let dir = Dir::new("caps");
        let cache = Cache::new(&dir.0, "t1");
        cache
            .set_listing(
                team(),
                "on",
                None,
                vec![item("a", "commands", "commands/a.md", 1)],
                1,
            )
            .unwrap();
        let big = "x".repeat(MAX_ITEM_BYTES as usize + 1);
        assert!(cache.store_text("a", 1, &big).is_err());
        assert_eq!(cache.text("a").unwrap(), None);
    }

    #[test]
    fn clearing_removes_other_teams_or_all() {
        let dir = Dir::new("clear");
        for id in ["t1", "t2"] {
            let cache = Cache::new(&dir.0, id);
            cache
                .set_listing(
                    team(),
                    "on",
                    None,
                    vec![item("a", "rules", "AGENTS.md", 1)],
                    1,
                )
                .unwrap();
            cache.store_text("a", 1, "x").unwrap();
            cache.apply(&ids(&["a"])).unwrap();
        }
        assert_eq!(clear_others(&dir.0, Some("t2")).unwrap(), 1);
        assert!(!Cache::new(&dir.0, "t1").active_dir().exists());
        assert!(Cache::new(&dir.0, "t2")
            .active_dir()
            .join("AGENTS.md")
            .is_file());
        assert_eq!(clear_others(&dir.0, None).unwrap(), 1);
        assert!(Cache::new(&dir.0, "t2").index().items.is_empty());
        assert_eq!(clear_others(&dir.0, None).unwrap(), 0);
    }
}
