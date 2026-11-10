//! Third-party extensions on disk (PLAN §9, D102). Installed extensions live in
//! `<appData>/extensions/<id>/`; "Load unpacked" adds a folder anywhere (development). The
//! registry (`<appData>/extensions/registry.json`, written by the frontend) holds the unpacked
//! folders, disabled ids and granted permissions. Files are only read from a known extension root,
//! by a relative path that can't climb out of it. Extension code itself never reaches this module:
//! it runs in a worker and talks to the IDE through an RPC the frontend checks.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::store::atomic_write;

pub mod download;
pub mod store;
pub mod vsix;

/// Manifest file names, in order: our own, then a VS Code extension's (declarative parts).
pub const MANIFESTS: &[&str] = &["extension.json", "package.json"];
/// Extensions shipped with the app, seeded once (`seed_bundled`): id → files.
type Bundled = (&'static str, &'static [(&'static str, &'static str)]);
const BUNDLED: &[Bundled] = &[
    (
        "bundled.todo-tree",
        &[
            (
                "extension.json",
                include_str!("../../bundled-extensions/todo-tree/extension.json"),
            ),
            (
                "main.js",
                include_str!("../../bundled-extensions/todo-tree/main.js"),
            ),
            (
                "README.md",
                include_str!("../../bundled-extensions/todo-tree/README.md"),
            ),
        ],
    ),
    (
        "bundled.canvas",
        &[
            (
                "extension.json",
                include_str!("../../bundled-extensions/canvas/extension.json"),
            ),
            (
                "main.js",
                include_str!("../../bundled-extensions/canvas/main.js"),
            ),
            (
                "viewer.html",
                include_str!("../../bundled-extensions/canvas/viewer.html"),
            ),
            (
                "viewer.js",
                include_str!("../../bundled-extensions/canvas/viewer.js"),
            ),
            (
                "viewer.css",
                include_str!("../../bundled-extensions/canvas/viewer.css"),
            ),
            (
                "markdown.js",
                include_str!("../../bundled-extensions/canvas/markdown.js"),
            ),
            (
                "menus.js",
                include_str!("../../bundled-extensions/canvas/menus.js"),
            ),
            (
                "geometry.js",
                include_str!("../../bundled-extensions/canvas/geometry.js"),
            ),
            (
                "export.js",
                include_str!("../../bundled-extensions/canvas/export.js"),
            ),
            (
                "cards.js",
                include_str!("../../bundled-extensions/canvas/cards.js"),
            ),
            (
                "README.md",
                include_str!("../../bundled-extensions/canvas/README.md"),
            ),
        ],
    ),
    // Jupyter kernels (D203; the .ipynb format is the IDE's own since D204), off until turned on.
    (
        "bundled.jupyter",
        &[
            (
                "extension.json",
                include_str!("../../bundled-extensions/jupyter/extension.json"),
            ),
            (
                "main.js",
                include_str!("../../bundled-extensions/jupyter/main.js"),
            ),
            (
                "kernel_host.py",
                include_str!("../../bundled-extensions/jupyter/kernel_host.py"),
            ),
            (
                "icon.svg",
                include_str!("../../bundled-extensions/jupyter/icon.svg"),
            ),
            (
                "README.md",
                include_str!("../../bundled-extensions/jupyter/README.md"),
            ),
        ],
    ),
    // Git tools (D208): the GitLens-style views that were built in (D204), on by default.
    (
        "bundled.gittools",
        &[
            (
                "extension.json",
                include_str!("../../bundled-extensions/gittools/extension.json"),
            ),
            (
                "main.js",
                include_str!("../../bundled-extensions/gittools/main.js"),
            ),
            (
                "icon.svg",
                include_str!("../../bundled-extensions/gittools/icon.svg"),
            ),
            (
                "README.md",
                include_str!("../../bundled-extensions/gittools/README.md"),
            ),
        ],
    ),
];
/// Bundled extensions seeded enabled, with the permissions their manifest asks for granted (D208:
/// what used to be built in stays on). The others are seeded disabled.
const ENABLED_BY_DEFAULT: &[&str] = &["bundled.gittools"];

/// The permissions a shipped manifest asks for.
fn manifest_permissions(files: &[(&str, &str)]) -> Vec<serde_json::Value> {
    files
        .iter()
        .find(|(name, _)| *name == "extension.json")
        .and_then(|(_, text)| serde_json::from_str::<serde_json::Value>(text).ok())
        .and_then(|m| m.get("permissions").and_then(|p| p.as_array()).cloned())
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.is_string())
        .collect()
}
const MAX_FILE: u64 = 20 * 1024 * 1024;
const MAX_WALK: usize = 2000;

/// A file of an extension folder (its page's Files tab).
#[derive(Serialize)]
pub struct ExtFile {
    pub path: String,
    pub size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtEntry {
    /// The folder holding the manifest.
    pub root: String,
    /// "extension.json" or "package.json" (a VS Code extension).
    pub manifest_file: String,
    /// Manifest text (parsed and validated by the frontend).
    pub manifest: String,
    /// Loaded with "Load unpacked" (development) rather than installed.
    pub dev: bool,
    /// Newest modification time of the folder's files (ms), for reload-on-change.
    pub mtime_ms: f64,
    /// A VS Code package's package.nls.json (its `%key%` strings' text, D256).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nls: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    #[serde(default)]
    pub dev: Vec<String>,
    #[serde(default, flatten)]
    pub rest: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone)]
pub struct ExtensionStore {
    dir: PathBuf,
}

impl ExtensionStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join("extensions"),
        }
    }

    fn registry_path(&self) -> PathBuf {
        self.dir.join("registry.json")
    }

    pub fn storage_path(&self, id: &str) -> Result<PathBuf> {
        check_id(id)?;
        Ok(self
            .dir
            .parent()
            .unwrap_or(&self.dir)
            .join("extension-storage")
            .join(format!("{id}.json")))
    }

    pub fn registry(&self) -> Registry {
        fs::read_to_string(self.registry_path())
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn registry_text(&self) -> String {
        fs::read_to_string(self.registry_path()).unwrap_or_else(|_| "{}".into())
    }

    pub fn save_registry(&self, json: &str) -> Result<()> {
        serde_json::from_str::<Registry>(json).map_err(|e| Error::Invalid(e.to_string()))?;
        atomic_write(&self.registry_path(), json.as_bytes())
    }

    /// Copies each bundled extension (bundled-extensions/, D121) into the installed ones the first
    /// time, disabled (those in ENABLED_BY_DEFAULT on, their permissions granted, D208). The
    /// registry's `bundled` list remembers what was seeded, so an uninstalled one stays
    /// uninstalled and an enabled (or disabled) one stays so.
    pub fn seed_bundled(&self) -> Result<()> {
        let mut registry: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&self.registry_text()).unwrap_or_default();
        let seeded: Vec<String> = registry
            .get("bundled")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let fresh: Vec<&Bundled> = BUNDLED
            .iter()
            .filter(|(id, _)| !seeded.iter().any(|s| s == id))
            .collect();
        // The user replaced these with their own changed copy (D189): left as they are.
        let customized: Vec<String> = registry
            .get("customized")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        // Seeded ones still installed are updated whenever the app ships different files for them
        // (D183: a changed extension with the same version number used to keep the old copy).
        // Installed copies are read-only to the user, so nothing of theirs is overwritten — except
        // a customized one, which is the user's (skipped).
        for (id, files) in BUNDLED
            .iter()
            .filter(|(id, _)| seeded.iter().any(|s| s == id) && !customized.iter().any(|c| c == id))
        {
            let target = self.dir.join(id);
            if !target.join("extension.json").exists() {
                continue; // uninstalled: stays so
            }
            let differs = files.iter().any(|(name, text)| {
                fs::read_to_string(target.join(name)).map_or(true, |installed| installed != *text)
            });
            if differs {
                for (name, text) in files.iter() {
                    atomic_write(&target.join(name), text.as_bytes())?;
                }
            }
        }
        if fresh.is_empty() {
            return Ok(());
        }
        for (id, files) in &fresh {
            let target = self.dir.join(id);
            if !target.exists() {
                for (name, text) in files.iter() {
                    atomic_write(&target.join(name), text.as_bytes())?;
                }
            }
        }
        let push =
            |registry: &mut serde_json::Map<String, serde_json::Value>, key: &str, id: &str| {
                let list = registry
                    .entry(key.to_string())
                    .or_insert_with(|| serde_json::Value::Array(Vec::new()));
                if let Some(a) = list.as_array_mut() {
                    if !a.iter().any(|v| v.as_str() == Some(id)) {
                        a.push(serde_json::Value::String(id.to_string()));
                    }
                }
            };
        for (id, files) in &fresh {
            push(&mut registry, "bundled", id);
            if !ENABLED_BY_DEFAULT.contains(id) {
                push(&mut registry, "disabled", id);
                continue;
            }
            // On, with what it asks for granted (the user can still turn it off or remove it).
            let granted = registry
                .entry("granted".to_string())
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            if let Some(map) = granted.as_object_mut() {
                map.entry(id.to_string())
                    .or_insert_with(|| serde_json::Value::Array(manifest_permissions(files)));
            }
        }
        let text =
            serde_json::to_string_pretty(&registry).map_err(|e| Error::Invalid(e.to_string()))?;
        atomic_write(&self.registry_path(), text.as_bytes())
    }

    /// Puts the IDE's own files of one bundled extension back (D189: "Use the IDE's version" for
    /// one the user replaced with a changed copy): the installed folder is replaced; the registry
    /// (enabled or not, permissions) is left as it is.
    pub fn reinstall_bundled(&self, id: &str) -> Result<()> {
        let (_, files) = BUNDLED
            .iter()
            .find(|(b, _)| *b == id)
            .ok_or_else(|| Error::Invalid(format!("{id} doesn't come with the IDE")))?;
        let target = self.dir.join(id);
        if target.exists() {
            fs::remove_dir_all(&target)?;
        }
        for (name, text) in files.iter() {
            atomic_write(&target.join(name), text.as_bytes())?;
        }
        Ok(())
    }

    /// Brings back the bundled extensions the user uninstalled (seeded again as on first start).
    /// Returns their ids.
    pub fn restore_bundled(&self) -> Result<Vec<String>> {
        let missing: Vec<String> = BUNDLED
            .iter()
            .filter(|(id, _)| !self.dir.join(id).join("extension.json").exists())
            .map(|(id, _)| id.to_string())
            .collect();
        if missing.is_empty() {
            return Ok(missing);
        }
        let mut registry: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&self.registry_text()).unwrap_or_default();
        if let Some(list) = registry.get_mut("bundled").and_then(|v| v.as_array_mut()) {
            list.retain(|v| !v.as_str().is_some_and(|id| missing.iter().any(|m| m == id)));
        }
        let text =
            serde_json::to_string_pretty(&registry).map_err(|e| Error::Invalid(e.to_string()))?;
        atomic_write(&self.registry_path(), text.as_bytes())?;
        self.seed_bundled()?;
        Ok(missing)
    }

    /// Installed and unpacked extensions with their manifests.
    pub fn list(&self) -> Vec<ExtEntry> {
        let mut out = Vec::new();
        if let Ok(entries) = fs::read_dir(&self.dir) {
            let mut dirs: Vec<PathBuf> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            dirs.sort();
            for dir in dirs {
                if let Some(entry) = read_entry(&dir, false) {
                    out.push(entry);
                }
            }
        }
        for dev in self.registry().dev {
            if let Some(entry) = read_entry(Path::new(&dev), true) {
                out.push(entry);
            }
        }
        out
    }

    /// `path` (canonical) when it is a folder inside one of the extension folders (installed or
    /// unpacked), the folder itself included: where a program an extension ships may run (D202).
    pub fn folder_within(&self, path: &Path) -> Option<PathBuf> {
        // A network path is refused before any IO (Windows would connect and offer credentials).
        let text = path.to_string_lossy();
        let network = text.starts_with("\\\\")
            || text.starts_with("//")
            || text.starts_with("\\/")
            || text.starts_with("/\\");
        if !path.is_absolute() || network {
            return None;
        }
        let real = fs::canonicalize(path).ok().filter(|p| p.is_dir())?;
        real.ancestors()
            .any(|a| self.known_root(a).is_ok())
            .then_some(real)
    }

    /// Whether `root` is one of the extension folders (installed or unpacked).
    fn known_root(&self, root: &Path) -> Result<PathBuf> {
        let root = fs::canonicalize(root).map_err(|_| {
            Error::Invalid(format!("{} is not an extension folder", root.display()))
        })?;
        let installed = fs::canonicalize(&self.dir).ok();
        // Not the IDE's own scratch folders beside them (.downloads, .removing, .<id>.installing).
        let is_installed = installed
            .as_ref()
            .is_some_and(|dir| root.parent() == Some(dir.as_path()))
            && !root
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with('.'));
        let is_dev = self
            .registry()
            .dev
            .iter()
            .any(|d| fs::canonicalize(d).map(|p| p == root).unwrap_or(false));
        if is_installed || is_dev {
            Ok(root)
        } else {
            Err(Error::Invalid(format!(
                "{} is not an extension folder",
                root.display()
            )))
        }
    }

    /// A file inside an extension folder (`rel` may not leave it).
    pub fn file_path(&self, root: &str, rel: &str) -> Result<PathBuf> {
        let root = self.known_root(Path::new(root))?;
        let rel_path = Path::new(rel);
        if rel_path.is_absolute()
            || rel_path
                .components()
                .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
        {
            return Err(Error::Invalid(format!(
                "{rel}: not a path inside the extension"
            )));
        }
        let path = root.join(rel_path);
        let real = fs::canonicalize(&path)?;
        if !real.starts_with(&root) {
            return Err(Error::Invalid(format!("{rel}: outside the extension")));
        }
        Ok(real)
    }

    pub fn read(&self, root: &str, rel: &str) -> Result<Vec<u8>> {
        let path = self.file_path(root, rel)?;
        if fs::metadata(&path)?.len() > MAX_FILE {
            return Err(Error::Invalid(format!("{rel} is too large")));
        }
        Ok(fs::read(path)?)
    }

    /// The files of an extension folder (relative, `/` separators, sorted), for its page's Files
    /// tab: no dot folders, node_modules or symlinks; at most MAX_WALK entries.
    pub fn files(&self, root: &str) -> Result<Vec<ExtFile>> {
        let root = self.known_root(Path::new(root))?;
        let mut out = Vec::new();
        let mut stack = vec![root.clone()];
        let mut seen = 0;
        while let Some(dir) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for e in entries.flatten() {
                seen += 1;
                if seen > MAX_WALK {
                    break;
                }
                let name = e.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || name == "node_modules" {
                    continue;
                }
                let Ok(kind) = e.file_type() else { continue };
                if kind.is_symlink() {
                    continue;
                }
                let path = e.path();
                if kind.is_dir() {
                    stack.push(path);
                } else if let Ok(rel) = path.strip_prefix(&root) {
                    let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                    let rel = rel
                        .components()
                        .map(|c| c.as_os_str().to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join("/");
                    out.push(ExtFile { path: rel, size });
                }
            }
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    /// The folder to serve for a webview panel (an extension root).
    pub fn root(&self, root: &str) -> Result<PathBuf> {
        self.known_root(Path::new(root))
    }

    /// Copies an extension folder into the installed extensions as `<id>`.
    pub fn install(&self, source: &Path, id: &str) -> Result<String> {
        check_id(id)?;
        if !MANIFESTS.iter().any(|m| source.join(m).is_file()) {
            return Err(Error::Invalid(format!(
                "{} has no extension.json or package.json",
                source.display()
            )));
        }
        let target = self.dir.join(id);
        let staging = self.dir.join(format!(".{id}.installing"));
        let _ = fs::remove_dir_all(&staging);
        copy_dir(source, &staging, &mut 0, runs_in_node(source))?;
        if target.exists() {
            // The old copy is moved aside in one step (an update): a file held open fails here,
            // clearly, instead of leaving a half-deleted extension (D185).
            let trash = self.dir.join(".removing");
            fs::create_dir_all(&trash)?;
            let stamp = std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default();
            let aside = trash.join(format!("{id}-{stamp}"));
            if let Err(e) = fs::rename(&target, &aside) {
                let _ = fs::remove_dir_all(&staging);
                return Err(Error::Invalid(format!(
                    "{id} is in use and couldn't be replaced ({e}). Close what uses it and try again."
                )));
            }
            let _ = fs::remove_dir_all(&aside);
        }
        fs::rename(&staging, &target)?;
        Ok(target.to_string_lossy().into_owned())
    }

    /// Deletes an unpacked extension's folder (the user chose "Uninstall"); only folders listed in
    /// the registry that still hold a manifest, never a drive root or the home folder.
    pub fn delete_unpacked(&self, root: &str) -> Result<()> {
        let path = fs::canonicalize(root)?;
        let listed = self
            .registry()
            .dev
            .iter()
            .any(|d| fs::canonicalize(d).map(|p| p == path).unwrap_or(false));
        let has_manifest = MANIFESTS.iter().any(|m| path.join(m).is_file());
        let home = dirs_home();
        if !listed || !has_manifest || path.parent().is_none() || Some(&path) == home.as_ref() {
            return Err(Error::Invalid(format!(
                "{} isn't an unpacked extension folder",
                path.display()
            )));
        }
        fs::remove_dir_all(path)?;
        Ok(())
    }

    pub fn uninstall(&self, id: &str) -> Result<()> {
        check_id(id)?;
        let target = self.dir.join(id);
        if !target.is_dir() {
            return Ok(());
        }
        // Moved aside first, in one step: the list (and the bundled seeding it runs) never sees
        // a half-deleted folder, and can't write files back into one while it's deleted.
        let trash = self.dir.join(".removing");
        // What an earlier uninstall couldn't delete goes now.
        let _ = fs::remove_dir_all(&trash);
        fs::create_dir_all(&trash)?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let aside = trash.join(format!("{id}-{stamp}"));
        fs::rename(&target, &aside)?;
        // Best effort: a file held open (Windows) is cleared on a later uninstall.
        let _ = fs::remove_dir_all(&aside);
        Ok(())
    }
}

/// A folder's manifest, read before it becomes an extension (install / load unpacked).
pub fn peek(dir: &Path) -> Result<ExtEntry> {
    read_entry(dir, false).ok_or_else(|| {
        Error::Invalid(format!(
            "{} has no extension.json or package.json",
            dir.display()
        ))
    })
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .and_then(|p| fs::canonicalize(p).ok())
}

/// "publisher.name" ids only (they become folder names).
pub fn check_id(id: &str) -> Result<()> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && id.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-' || c == '_'
        })
        && !id.starts_with('.')
        && !id.contains("..")
        // `con.tools` or `a.b.` would name a device or another folder on Windows.
        && !vsix::windows_reserved(id);
    if ok {
        Ok(())
    } else {
        Err(Error::Invalid(format!("invalid extension id {id:?}")))
    }
}

fn read_entry(dir: &Path, dev: bool) -> Option<ExtEntry> {
    let (file, text) = MANIFESTS
        .iter()
        .find_map(|m| fs::read_to_string(dir.join(m)).ok().map(|t| (*m, t)))?;
    Some(ExtEntry {
        root: dir.to_string_lossy().into_owned(),
        manifest_file: file.to_string(),
        manifest: text,
        dev,
        mtime_ms: newest_mtime(dir),
        nls: if file == "package.json" {
            fs::read_to_string(dir.join("package.nls.json")).ok()
        } else {
            None
        },
    })
}

/// Newest modification time of the files under `dir` (skips node_modules and dot folders).
fn newest_mtime(dir: &Path) -> f64 {
    let mut newest = 0f64;
    let mut stack = vec![dir.to_path_buf()];
    let mut seen = 0;
    while let Some(d) = stack.pop() {
        let Ok(entries) = fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            seen += 1;
            if seen > MAX_WALK {
                return newest;
            }
            let path = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else if let Ok(t) = e.metadata().and_then(|m| m.modified()) {
                if let Ok(d) = t.duration_since(UNIX_EPOCH) {
                    newest = newest.max(d.as_secs_f64() * 1000.0);
                }
            }
        }
    }
    newest
}

/// Whether an extension's code runs in Node (a VS Code package with `main`, or `"host": "node"`):
/// its `require`s need its node_modules (D261: a .vsix that doesn't bundle its dependencies).
fn runs_in_node(source: &Path) -> bool {
    let read = |name: &str| {
        fs::read_to_string(source.join(name))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
    };
    if let Some(m) = read("extension.json") {
        return m.get("host").and_then(|h| h.as_str()) == Some("node");
    }
    read("package.json").is_some_and(|p| p.get("main").and_then(|m| m.as_str()).is_some())
}

fn copy_dir(from: &Path, to: &Path, count: &mut usize, with_modules: bool) -> Result<()> {
    fs::create_dir_all(to)?;
    // Dependencies have many small files: room for them when they're kept.
    let max = if with_modules { 100_000 } else { 20_000 };
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        *count += 1;
        if *count > max {
            return Err(Error::Invalid(
                "the extension folder has too many files".into(),
            ));
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str == ".git" || (name_str == "node_modules" && !with_modules) {
            continue;
        }
        let kind = entry.file_type()?;
        let target = to.join(&name);
        if kind.is_dir() {
            copy_dir(&entry.path(), &target, count, with_modules)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ide-ext-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn node_extensions_keep_their_node_modules() {
        let data = temp("data-modules");
        let store = ExtensionStore::new(&data);
        // A VS Code package whose code requires its dependencies (D261).
        let vscode = temp("source-vscode");
        fs::write(
            vscode.join("package.json"),
            r#"{"name":"x","main":"./out/a.js"}"#,
        )
        .unwrap();
        fs::create_dir_all(vscode.join("node_modules").join("dep")).unwrap();
        fs::write(
            vscode.join("node_modules").join("dep").join("index.js"),
            "1",
        )
        .unwrap();
        store.install(&vscode, "acme.vscode-dep").unwrap();
        assert!(data
            .join("extensions")
            .join("acme.vscode-dep")
            .join("node_modules")
            .join("dep")
            .join("index.js")
            .is_file());
        // A web worker extension is bundled: its node_modules (dev tools) stay behind.
        let web = temp("source-web");
        fs::write(web.join("extension.json"), r#"{"id":"acme.web"}"#).unwrap();
        fs::create_dir_all(web.join("node_modules")).unwrap();
        fs::write(web.join("node_modules").join("x.js"), "1").unwrap();
        store.install(&web, "acme.web").unwrap();
        assert!(!data
            .join("extensions")
            .join("acme.web")
            .join("node_modules")
            .exists());
        for d in [data, vscode, web] {
            let _ = fs::remove_dir_all(d);
        }
    }

    #[test]
    fn install_list_read_and_scope() {
        let data = temp("data");
        let source = temp("source");
        fs::write(source.join("extension.json"), r#"{"id":"acme.hello"}"#).unwrap();
        fs::create_dir_all(source.join("lib")).unwrap();
        fs::write(source.join("lib/main.js"), "ide.ui.notify('hi')").unwrap();
        let store = ExtensionStore::new(&data);
        let root = store.install(&source, "acme.hello").unwrap();
        let list = store.list();
        assert_eq!(list.len(), 1);
        assert!(list[0].manifest.contains("acme.hello"));
        assert!(!list[0].dev);
        assert_eq!(
            store.read(&root, "lib/main.js").unwrap(),
            b"ide.ui.notify('hi')"
        );
        assert!(store.read(&root, "../registry.json").is_err());
        assert!(store.read(&root, "/etc/passwd").is_err());
        // A folder that isn't an extension can't be read from.
        assert!(store.read(source.to_str().unwrap(), "lib/main.js").is_err());
        // Its files, for the page's Files tab (only known folders).
        let files = store.files(&root).unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["extension.json", "lib/main.js"]);
        assert!(store.files(source.to_str().unwrap()).is_err());
        // Where its programs may run (D202): its folder and folders in it, nothing else.
        assert!(store.folder_within(Path::new(&root)).is_some());
        assert!(store.folder_within(&Path::new(&root).join("lib")).is_some());
        assert!(store
            .folder_within(&Path::new(&root).join("lib/main.js"))
            .is_none());
        assert!(store.folder_within(&data.join("extensions")).is_none());
        assert!(store.folder_within(&source).is_none());
        assert!(store.folder_within(Path::new("lib")).is_none());
        store.uninstall("acme.hello").unwrap();
        assert!(store.list().is_empty());
    }

    #[test]
    fn bundled_extensions_are_seeded_once_and_disabled() {
        let data = temp("data-bundled");
        let store = ExtensionStore::new(&data);
        store.seed_bundled().unwrap();
        let list = store.list();
        assert!(list
            .iter()
            .any(|e| e.manifest.contains("bundled.todo-tree")));
        let reg: serde_json::Value = serde_json::from_str(&store.registry_text()).unwrap();
        assert_eq!(reg["disabled"][0], "bundled.todo-tree");
        assert_eq!(reg["disabled"][1], "bundled.canvas");
        assert_eq!(reg["bundled"][0], "bundled.todo-tree");
        // Git tools (D208) is on, with its permissions granted.
        assert_eq!(reg["bundled"].as_array().unwrap().len(), 4);
        assert_eq!(reg["disabled"].as_array().unwrap().len(), 3);
        assert!(!reg["disabled"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d == "bundled.gittools"));
        assert!(reg["granted"]["bundled.gittools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p == "git"));
        // An older installed copy is replaced by the shipped one.
        let manifest = data.join("extensions/bundled.todo-tree/extension.json");
        fs::write(&manifest, r#"{"id":"bundled.todo-tree","version":"0.0.1"}"#).unwrap();
        store.seed_bundled().unwrap();
        assert!(fs::read_to_string(&manifest).unwrap().contains("TODO tree"));
        // Uninstalled stays uninstalled; the user's registry entries survive.
        store.uninstall("bundled.todo-tree").unwrap();
        store
            .save_registry(r#"{"dev":[],"disabled":[],"bundled":["bundled.todo-tree"]}"#)
            .unwrap();
        store.seed_bundled().unwrap();
        // The canvas (D181) wasn't seeded before, so it comes; the TODO tree doesn't.
        // (Restoring brings the TODO tree back: checked below.)
        let ids: Vec<String> = store.list().iter().map(|e| e.manifest.clone()).collect();
        // (and the Jupyter extension, D203, and Git tools, D208)
        assert_eq!(ids.len(), 3);
        assert!(ids.iter().any(|m| m.contains("bundled.canvas")));
        assert!(ids.iter().any(|m| m.contains("bundled.jupyter")));
        assert!(ids.iter().any(|m| m.contains("bundled.gittools")));
        // A shipped change with the same version still reaches the installed copy (D183).
        let viewer = data.join("extensions/bundled.canvas/viewer.js");
        fs::write(&viewer, "old").unwrap();
        store.seed_bundled().unwrap();
        assert_ne!(fs::read_to_string(&viewer).unwrap(), "old");
        // A customized one (the user replaced it with their changed copy, D189) is left alone.
        let mut reg: serde_json::Value = serde_json::from_str(&store.registry_text()).unwrap();
        reg["customized"] = serde_json::json!(["bundled.canvas"]);
        store.save_registry(&reg.to_string()).unwrap();
        fs::write(&viewer, "mine").unwrap();
        store.seed_bundled().unwrap();
        assert_eq!(fs::read_to_string(&viewer).unwrap(), "mine");
        reg["customized"] = serde_json::json!([]);
        store.save_registry(&reg.to_string()).unwrap();
        // Restoring brings back what was uninstalled, disabled.
        assert_eq!(store.restore_bundled().unwrap(), vec!["bundled.todo-tree"]);
        assert_eq!(store.list().len(), 4);
        assert!(store.restore_bundled().unwrap().is_empty());
    }

    #[test]
    fn unpacked_folders_come_from_the_registry() {
        let data = temp("data2");
        let dev = temp("dev");
        fs::write(dev.join("package.json"), r#"{"name":"theme"}"#).unwrap();
        let store = ExtensionStore::new(&data);
        store
            .save_registry(&format!(
                r#"{{"dev":[{:?}],"disabled":[]}}"#,
                dev.to_string_lossy()
            ))
            .unwrap();
        let list = store.list();
        assert_eq!(list.len(), 1);
        assert!(list[0].dev);
        assert_eq!(list[0].manifest_file, "package.json");
        assert!(store.read(dev.to_str().unwrap(), "package.json").is_ok());
        assert!(store.registry_text().contains("disabled"));
        // Only listed folders can be deleted.
        let other = temp("other");
        fs::write(other.join("package.json"), "{}").unwrap();
        assert!(store.delete_unpacked(other.to_str().unwrap()).is_err());
        store.delete_unpacked(dev.to_str().unwrap()).unwrap();
        assert!(!dev.exists());
    }

    #[test]
    fn ids_are_folder_safe() {
        assert!(check_id("acme.todo-highlighter").is_ok());
        assert!(check_id("../x").is_err());
        assert!(check_id("Acme.X").is_err());
        assert!(check_id(".hidden").is_err());
        assert!(check_id("con.tools").is_err());
        assert!(check_id("acme.x.").is_err());
        assert!(check_id("acme.console").is_ok());
    }
}
