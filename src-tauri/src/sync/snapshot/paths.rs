//! Paths and links: which names a snapshot may write, the shape of a repository's own files
//! at the top of a folder, and how a restore finds a place without passing through a link.

use std::path::{Component, Path, PathBuf};

use crate::error::{Error, Result};

pub(super) fn sync_error(message: impl Into<String>) -> Error {
    Error::Sync("Sync", message.into())
}

pub(super) fn rel(path: &str) -> String {
    path.replace('\\', "/")
}

/// Whether one part of a synced path is a name some computer reads as something else: a
/// device's name on Windows, a name with a stream or a trailing dot or space, a repository's
/// own folder.
pub(in crate::sync) fn unsafe_name(text: &str) -> bool {
    // Windows drops trailing dots and spaces and reads short names and streams:
    // ".git.", ".git ", "GIT~1" and ".git::$INDEX_ALLOCATION" are all .git there.
    // No repository's own folder at any depth, either.
    let plain = text.trim_end_matches(['.', ' ']).to_ascii_lowercase();
    let stem = plain.split('.').next().unwrap_or("");
    let reserved = matches!(stem, "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.ends_with(|c: char| c.is_ascii_digit()));
    plain == ".git"
        || reserved
        || plain.starts_with("git~")
        || text.contains(':')
        || text.ends_with(['.', ' '])
}

/// A manifest's path as a place under `root`; refuses anything that climbs out or into `.git`.
pub(super) fn safe_join(root: &Path, relative: &str) -> Result<PathBuf> {
    let path = Path::new(relative);
    let mut out = root.to_path_buf();
    let mut first = true;
    for part in path.components() {
        match part {
            Component::Normal(name) => {
                let text = name.to_string_lossy();
                if unsafe_name(&text) {
                    return Err(sync_error(format!(
                        "a snapshot may not write there: {relative}"
                    )));
                }
                out.push(name);
            }
            _ => {
                return Err(sync_error(format!(
                    "a snapshot names a path outside the project: {relative}"
                )))
            }
        }
        first = false;
    }
    if first {
        return Err(sync_error("a snapshot names an empty path"));
    }
    Ok(out)
}

/// The files that make a folder a git repository of its own, without a `.git` in it (a
/// "bare" one): `HEAD` beside `objects` and `refs`, and the `config` git then reads and runs
/// programs from (`core.fsmonitor` on a `git status`), or its `hooks`. A snapshot never puts
/// that shape at the top of a project: git there would take the folder itself for its
/// repository. Names are compared without case (Windows and macOS read them so).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(super) struct RepositoryParts {
    head: bool,
    config: bool,
    objects: bool,
    refs: bool,
}

impl RepositoryParts {
    /// Which part `path` (a snapshot's, with `/`) is, when it is one: the file `HEAD` or
    /// `config` at the top, or anything under `objects/` or `refs/` there.
    pub(super) fn of(path: &str) -> Self {
        let mut parts = Self::default();
        let (top, inside) = match path.split_once('/') {
            Some((top, _)) => (top, true),
            None => (path, false),
        };
        match (top.to_ascii_lowercase().as_str(), inside) {
            ("head", false) => parts.head = true,
            ("config", false) => parts.config = true,
            ("objects", true) => parts.objects = true,
            ("refs", true) => parts.refs = true,
            _ => {}
        }
        parts
    }

    pub(super) fn named<'a>(paths: impl IntoIterator<Item = &'a str>) -> Self {
        paths
            .into_iter()
            .fold(Self::default(), |all, path| all.with(Self::of(path)))
    }

    /// The parts that are in `root` now.
    fn on_disk(root: &Path) -> Self {
        let file = |name: &str| root.join(name).is_file();
        let folder = |name: &str| root.join(name).is_dir();
        Self {
            head: file("HEAD"),
            config: file("config"),
            objects: folder("objects"),
            refs: folder("refs"),
        }
    }

    fn with(self, other: Self) -> Self {
        Self {
            head: self.head || other.head,
            config: self.config || other.config,
            objects: self.objects || other.objects,
            refs: self.refs || other.refs,
        }
    }

    pub(super) fn any(self) -> bool {
        self.head || self.config || self.objects || self.refs
    }

    /// Enough of them for git to take the folder for a repository, or to read its `config`
    /// once the rest is there.
    pub(super) fn is_repository(self) -> bool {
        self.head && (self.config || (self.objects && self.refs))
    }
}

/// Refuses to write `paths` into `root` when the folder would then have a repository's own
/// files at its top: by what the snapshot names, together with what is there already (so
/// the shape can't be put together a piece at a time).
pub(super) fn not_a_repository_of_its_own<'a>(
    root: &Path,
    paths: impl IntoIterator<Item = &'a str>,
) -> Result<()> {
    let named = RepositoryParts::named(paths);
    if named.any() && named.with(RepositoryParts::on_disk(root)).is_repository() {
        return Err(sync_error(
            "That snapshot would put a git repository's own files (HEAD, config, objects, refs) \
             at the top of the folder, where git would run what they name. Nothing was written.",
        ));
    }
    Ok(())
}

/// Whether what is at a path stands for another place: a symbolic link, and on Windows a
/// junction too (the standard library reads both as a link; a file kept in the cloud is none).
pub(super) fn is_link(meta: &std::fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

fn through_a_link(relative: &str) -> Error {
    sync_error(format!(
        "a snapshot's path leaves the project through a link: {relative}"
    ))
}

/// Whether `real` (a folder's resolved path) is `real_root` or under it, by names a snapshot
/// may name: a path that only resolves into a repository's own folder (through another
/// spelling of its name) is not.
pub(super) fn names_inside(real_root: &Path, real: &Path) -> bool {
    real.strip_prefix(real_root).is_ok_and(|rest| {
        rest.components().all(
            |part| matches!(part, Component::Normal(name) if !unsafe_name(&name.to_string_lossy())),
        )
    })
}

/// Whether a path of the project passes through a link before its last part: what is there
/// is then somewhere else, and is never read into a snapshot.
pub(super) fn passes_a_link(root: &Path, relative: &str) -> bool {
    let mut at = root.to_path_buf();
    let mut parts = Path::new(relative).components().peekable();
    while let Some(part) = parts.next() {
        at.push(part);
        if parts.peek().is_none() {
            break;
        }
        if std::fs::symlink_metadata(&at).is_ok_and(|meta| is_link(&meta)) {
            return true;
        }
    }
    false
}

/// The folder a snapshot is restored into, as every write, read and deletion of a restore
/// finds its place in it.
pub(super) struct Project<'a> {
    root: &'a Path,
    /// The folder resolved, once.
    real: PathBuf,
}

impl<'a> Project<'a> {
    pub(super) fn new(root: &'a Path) -> Result<Self> {
        Ok(Self {
            root,
            real: std::fs::canonicalize(root)?,
        })
    }

    /// A manifest's path as a place under the folder: by `safe_join`'s rules for names, and
    /// with no link anywhere on the way. A link that the snapshot's own commit checked out
    /// (`x -> .git`, `y -> /home/someone`) would otherwise take a write into the repository's
    /// settings or a deletion out of the folder. Each part that exists is looked at without
    /// following it; what exists is then resolved and must still be inside, under names a
    /// snapshot may name. The last part may be a link: the caller replaces or removes the link
    /// itself, never what it points at.
    pub(super) fn place(&self, relative: &str) -> Result<PathBuf> {
        let target = safe_join(self.root, relative)?;
        let rest = target
            .strip_prefix(self.root)
            .map_err(|_| through_a_link(relative))?;
        let mut at = self.root.to_path_buf();
        let mut deepest: Option<PathBuf> = None;
        let mut parts = rest.components().peekable();
        while let Some(part) = parts.next() {
            at.push(part);
            if parts.peek().is_none() {
                break;
            }
            match std::fs::symlink_metadata(&at) {
                Ok(meta) if is_link(&meta) => return Err(through_a_link(relative)),
                Ok(_) => deepest = Some(at.clone()),
                // Not there yet: nothing below it is either.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                Err(e) => return Err(e.into()),
            }
        }
        if let Some(folder) = deepest {
            if !names_inside(&self.real, &std::fs::canonicalize(folder)?) {
                return Err(through_a_link(relative));
            }
        }
        Ok(target)
    }

    /// `place`, and when a link is at the place itself, the link is removed (not what it
    /// points at): what is written there is then a file of the folder.
    pub(super) fn place_for_writing(&self, relative: &str) -> Result<PathBuf> {
        let target = self.place(relative)?;
        if std::fs::symlink_metadata(&target).is_ok_and(|meta| is_link(&meta)) {
            // (A link to a folder is removed as a folder on Windows.)
            if std::fs::remove_file(&target).is_err() {
                std::fs::remove_dir(&target)?;
            }
        }
        Ok(target)
    }
}
