//! The agent's skills folders outside the workspace (D206): a skill is a folder with a SKILL.md
//! (and files it refers to) in `~/.claude/skills`, `~/.cursor/skills`, `~/.agents/skills` (read
//! only, like Claude Code's other files, D200) or the IDE's own `~/<dataFolderName>/skills` (read
//! and written: the Skills page creates and deletes skills there). The normal fs commands reach
//! them through [`read_path`] / [`write_path`] (called from `settings::resolve`).

use std::path::{Component, Path, PathBuf};

use tauri::ipc::Channel;
use tauri::State;

use crate::watch::WatchBatch;

use crate::error::{Error, Result};
use crate::store::simplify;
use crate::AppState;

/// product.json's `dataFolderName` (".ide" style): the IDE's own folder in the home folder.
fn data_folder_name() -> &'static str {
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        serde_json::from_str::<serde_json::Value>(include_str!("../../../product.json"))
            .ok()
            .and_then(|v| v.get("dataFolderName")?.as_str().map(str::to_string))
            .filter(|n| crate::fs::validate_name(n).is_ok())
            .unwrap_or_else(|| ".ide".into())
    })
}

/// `~/<dataFolderName>/skills`: the user's own skills, written by the Skills page.
pub fn user_skills_dir(state: &AppState) -> Option<PathBuf> {
    Some(
        simplify(state.dirs.home.clone()?)
            .join(data_folder_name())
            .join("skills"),
    )
}

/// The other tools' user skills folders (read only).
fn other_skills_dirs(state: &AppState) -> Vec<PathBuf> {
    let Some(home) = state.dirs.home.clone().map(simplify) else {
        return Vec::new();
    };
    [".claude", ".cursor", ".agents"]
        .iter()
        .map(|d| home.join(d).join("skills"))
        .collect()
}

/// `requested` inside the skills folder `dir` (the folder itself, a skill's folder, or anything
/// below one), `min_depth` components deep at least. Only plain names (no `..`); a skill's folder
/// may be a link (skill installers link them in), but nothing below it may be, so a read can't
/// leave the skill's folder.
pub fn inside_skills(dir: &Path, requested: &Path, min_depth: usize) -> Option<PathBuf> {
    let rest = requested.strip_prefix(dir).ok()?;
    let parts: Vec<Component> = rest.components().collect();
    if parts.len() < min_depth || parts.iter().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    let mut at = dir.to_path_buf();
    for (i, part) in parts.iter().enumerate() {
        at.push(part);
        if i >= 1 && std::fs::symlink_metadata(&at).is_ok_and(|m| m.file_type().is_symlink()) {
            return None;
        }
    }
    Some(requested.to_path_buf())
}

/// A path in any user skills folder, for reading and listing.
pub fn read_path(state: &AppState, requested: &Path) -> Option<PathBuf> {
    user_skills_dir(state)
        .into_iter()
        .chain(other_skills_dirs(state))
        .find_map(|dir| inside_skills(&dir, requested, 0))
}

/// A file in the IDE's own user skills folder (`<skill>/SKILL.md` or deeper), for writing.
pub fn write_path(state: &AppState, requested: &Path) -> Option<PathBuf> {
    inside_skills(&user_skills_dir(state)?, requested, 2)
}

/// Deletes one of the user's own skills (`~/<dataFolderName>/skills/<name>`, the folder and
/// everything in it; a linked one loses only the link). The frontend command asks first.
#[tauri::command]
pub async fn skills_delete_user(state: State<'_, AppState>, path: String) -> Result<()> {
    let dir = user_skills_dir(&state).ok_or_else(|| Error::Invalid("no home folder".into()))?;
    let requested = simplify(PathBuf::from(&path));
    let rest = requested
        .strip_prefix(&dir)
        .map_err(|_| Error::OutsideScope(path.clone()))?;
    let mut parts = rest.components();
    if !matches!(
        (parts.next(), parts.next()),
        (Some(Component::Normal(_)), None)
    ) {
        return Err(Error::OutsideScope(path));
    }
    let meta = std::fs::symlink_metadata(&requested)?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&requested)?;
    } else {
        // A linked skill folder on Windows (a junction) is removed as a folder link.
        crate::fs::remove_file_or_link(&requested, meta.file_type())?;
    }
    Ok(())
}

/// Starts the skills watcher (D221): changes in the skills folders arrive on `on_batch`.
#[tauri::command]
pub async fn skills_watch_start(
    state: State<'_, AppState>,
    on_batch: Channel<WatchBatch>,
) -> Result<()> {
    state.skills_watcher.start(on_batch)
}

/// Whether `dir` may be watched: one of the user skills folders itself. The open folder's skills
/// folders aren't watched this way: on Windows a watched folder is an open handle, and git or a
/// script deleting `.claude/skills` would find it "in use" (the workspace's own events cover them).
fn watchable(state: &AppState, dir: &str) -> Option<PathBuf> {
    let p = simplify(PathBuf::from(dir));
    user_skills_dir(state)
        .into_iter()
        .chain(other_skills_dirs(state))
        .any(|d| d == p)
        .then_some(p)
}

/// Replaces the watched user skills folders (each with what's inside); other folders, and ones
/// that don't exist, are left out (D221).
#[tauri::command]
pub async fn skills_watch_set_dirs(state: State<'_, AppState>, dirs: Vec<String>) -> Result<()> {
    let resolved = dirs
        .iter()
        .filter_map(|d| watchable(&state, d))
        .collect::<Vec<_>>();
    state.skills_watcher.set_dirs(resolved)
}

#[cfg(test)]
mod tests {
    use super::inside_skills;

    #[test]
    fn only_paths_inside_a_skills_folder() {
        let root = std::env::temp_dir().join(format!("ide-skills-{}", std::process::id()));
        let dir = root.join("skills");
        std::fs::create_dir_all(dir.join("a").join("ref")).unwrap();
        std::fs::write(dir.join("a").join("SKILL.md"), "x").unwrap();
        assert!(inside_skills(&dir, &dir, 0).is_some());
        assert!(inside_skills(&dir, &dir, 2).is_none());
        assert!(inside_skills(&dir, &dir.join("a").join("SKILL.md"), 2).is_some());
        assert!(inside_skills(&dir, &dir.join("a").join("ref").join("x.md"), 0).is_some());
        assert!(inside_skills(&dir, &dir.join("a").join("..").join("..").join("x"), 0).is_none());
        assert!(inside_skills(&dir, &root.join("other"), 0).is_none());
        #[cfg(unix)]
        {
            // A linked skill folder is fine; a link inside one isn't.
            let outside = root.join("outside");
            std::fs::create_dir_all(&outside).unwrap();
            std::fs::write(outside.join("secret"), "s").unwrap();
            std::os::unix::fs::symlink(&outside, dir.join("linked")).unwrap();
            std::os::unix::fs::symlink(&outside, dir.join("a").join("escape")).unwrap();
            assert!(inside_skills(&dir, &dir.join("linked").join("SKILL.md"), 0).is_some());
            assert!(inside_skills(&dir, &dir.join("a").join("escape").join("secret"), 0).is_none());
        }
        let _ = std::fs::remove_dir_all(root);
    }
}
