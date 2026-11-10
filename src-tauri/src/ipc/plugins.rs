//! Claude Code plugins (D358): the IDE's plugins folder, `<data>/plugins` (the app's data
//! folder, so a test run's profile has its own), holds
//! the marketplaces the user added (`marketplaces/<name>`: a clone, or a copy of a local folder),
//! the installed plugins (`cache/<marketplace>/<plugin>`: each its own copy, as in Claude Code)
//! and the record of both (`plugins.json`). The normal fs commands read in it through
//! [`read_path`] (called from `settings::resolve`); writing the record, copying a folder in,
//! cloning a repository in and removing a folder are the commands here. Nothing outside it is
//! written. D375: Claude Code's own plugins folder (`~/.claude/plugins`) is read too, so what
//! it installed is used in place, and its `enabledPlugins` (only that) comes from its settings;
//! an npm-sourced plugin is fetched with the user's npm (`npm pack`, no install scripts).

use std::path::{Component, Path, PathBuf};

use tauri::State;

use crate::error::{Error, Result};
use crate::store::simplify;
use crate::AppState;

/// Files copied into a marketplace or a plugin at most, and bytes (a plugin is a few files).
const MAX_FILES: usize = 20_000;
const MAX_BYTES: u64 = 512 * 1024 * 1024;

/// `<data>/plugins`.
pub fn plugins_dir(state: &AppState) -> Option<PathBuf> {
    Some(simplify(state.dirs.data.clone()).join("plugins"))
}

/// `requested` inside `dir` (only plain names, no link below the plugins folder itself).
fn inside(dir: &Path, requested: &Path, min_depth: usize) -> Option<PathBuf> {
    let rest = requested.strip_prefix(dir).ok()?;
    let parts: Vec<Component> = rest.components().collect();
    if parts.len() < min_depth || parts.iter().any(|c| !matches!(c, Component::Normal(_))) {
        return None;
    }
    let mut at = dir.to_path_buf();
    for part in &parts {
        at.push(part);
        if std::fs::symlink_metadata(&at).is_ok_and(|m| m.file_type().is_symlink()) {
            return None;
        }
    }
    Some(requested.to_path_buf())
}

/// Claude Code's folder: `CLAUDE_CONFIG_DIR` when set (as Claude Code reads it), else `~/.claude`.
fn claude_dir(state: &AppState) -> Option<PathBuf> {
    match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()) {
        Some(dir) => Some(simplify(PathBuf::from(dir))),
        None => Some(simplify(state.dirs.home.clone()?).join(".claude")),
    }
}

/// `~/.claude/plugins`: Claude Code's plugins (read only, D375).
fn claude_plugins_dir(state: &AppState) -> Option<PathBuf> {
    Some(claude_dir(state)?.join("plugins"))
}

/// A path in the plugins folder or Claude Code's, for reading and listing.
pub fn read_path(state: &AppState, requested: &Path) -> Option<PathBuf> {
    inside(&plugins_dir(state)?, requested, 0)
        .or_else(|| inside(&claude_plugins_dir(state)?, requested, 0))
}

/// Claude Code's plugins folder and its `enabledPlugins` (`{ "name@market": true }`) from its
/// `settings.json`, and nothing else of that file (it can hold keys and environment variables).
#[tauri::command]
pub async fn plugins_claude_info(state: State<'_, AppState>) -> Result<serde_json::Value> {
    let Some(dir) = claude_dir(&state) else {
        return Ok(serde_json::json!({ "dir": null, "enabled": null }));
    };
    let enabled = std::fs::read_to_string(dir.join("settings.json"))
        .ok()
        .and_then(|text| {
            serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}')).ok()
        })
        .and_then(|v| v.get("enabledPlugins").filter(|e| e.is_object()).cloned())
        .unwrap_or(serde_json::Value::Null);
    Ok(serde_json::json!({
        "dir": dir.join("plugins").to_string_lossy(),
        "enabled": enabled,
    }))
}

/// An npm package name with an optional exact version or tag (`@scope/name@1.2.0`): plain characters
/// only (no spaces, `<`, `>` or `^`), so neither npm nor cmd reads it as an option or operator.
fn valid_npm_spec(spec: &str) -> bool {
    !spec.is_empty()
        && !spec.starts_with('-')
        && spec.len() <= 214
        && spec
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "@/._-~*+=".contains(c))
        && !spec.contains("..")
        // `owner/repo` is a GitHub fetch to npm: only a scope (`@scope/name`) may have a slash.
        && match spec.find('/') {
            None => true,
            Some(i) => spec.starts_with('@') && !spec[i + 1..].contains('/'),
        }
}

/// Fetches an npm-sourced plugin (D375) with the user's npm: `npm pack` (no install scripts run)
/// into a staging folder, unpacked with `tar`, its `package` folder put at `dest`.
#[tauri::command]
pub async fn plugins_npm(
    state: State<'_, AppState>,
    spec: String,
    registry: Option<String>,
    dest: String,
) -> Result<String> {
    let dest = destination(&state, &dest)?;
    let spec = spec.trim().to_string();
    if !valid_npm_spec(&spec) {
        return Err(Error::Invalid(format!("{spec} isn't an npm package name.")));
    }
    if let Some(r) = registry.as_deref() {
        if !(r.starts_with("https://") || r.starts_with("http://"))
            || r.chars()
                .any(|c| c.is_whitespace() || "\"'`&|;<>^%".contains(c))
        {
            return Err(Error::Invalid(format!("{r} isn't a registry URL.")));
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        let parent = dest
            .parent()
            .ok_or_else(|| Error::Invalid("no parent folder".into()))?
            .to_path_buf();
        std::fs::create_dir_all(&parent)?;
        let work = PathBuf::from(format!("{}-npm", staging(&dest).to_string_lossy()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work)?;
        let result = npm_pack(&work, &spec, registry.as_deref())
            .and_then(|tgz| untar(&work, &tgz))
            .and_then(|_| copy_folder(&work.join("package"), None, &dest));
        let _ = std::fs::remove_dir_all(&work);
        result.map(|_| dest.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| Error::Invalid(format!("npm failed: {e}")))?
}

/// A command without a console window (npm is `npm.cmd` on Windows: through cmd).
fn quiet(program: &str, args: &[&str], cwd: &Path) -> std::process::Command {
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("cmd");
        c.arg("/C").arg(program).args(args);
        c.creation_flags(0x0800_0000);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = std::process::Command::new(program);
        c.args(args);
        c
    };
    cmd.current_dir(cwd).stdin(std::process::Stdio::null());
    cmd
}

fn run_quiet(mut cmd: std::process::Command, what: &str) -> Result<String> {
    let out = cmd
        .output()
        .map_err(|e| Error::Invalid(format!("{what} couldn't start: {e}")))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let last = err
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("");
        return Err(Error::Invalid(format!("{what} failed: {last}")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `npm pack <spec>` in `work`: the tarball's file name.
fn npm_pack(work: &Path, spec: &str, registry: Option<&str>) -> Result<PathBuf> {
    let mut args = vec!["pack", spec, "--ignore-scripts", "--silent"];
    let reg;
    if let Some(r) = registry {
        reg = format!("--registry={r}");
        args.push(&reg);
    }
    let out = run_quiet(quiet("npm", &args, work), "npm pack")?;
    let name = out
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| l.ends_with(".tgz"))
        .ok_or_else(|| Error::Invalid("npm pack didn't make a package.".into()))?;
    Ok(work.join(name))
}

/// Unpacks a package tarball in `work` (it holds a `package` folder).
fn untar(work: &Path, tgz: &Path) -> Result<()> {
    // Its name only (it's in `work`): Git's GNU tar reads `C:\...` as a remote host `C`.
    let file = tgz
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    run_quiet(quiet("tar", &["-xzf", &file], work), "tar").map(|_| ())
}

/// Writes the record of marketplaces and installed plugins (`plugins.json`).
#[tauri::command]
pub async fn plugins_save_record(state: State<'_, AppState>, text: String) -> Result<()> {
    let root = plugins_dir(&state).ok_or_else(|| Error::Invalid("no data folder".into()))?;
    std::fs::create_dir_all(&root)?;
    crate::store::atomic_write(&root.join("plugins.json"), text.as_bytes())
}

/// A destination for `copy` / `clone` / `remove`: two levels or more inside the plugins folder
/// (`marketplaces/<name>`, `cache/<marketplace>/<plugin>`), never the folder or its top level.
fn destination(state: &AppState, path: &str) -> Result<PathBuf> {
    let root = plugins_dir(state).ok_or_else(|| Error::Invalid("no data folder".into()))?;
    let requested = simplify(PathBuf::from(path));
    inside(&root, &requested, 2).ok_or(Error::OutsideScope(path.to_string()))
}

/// Copies the folder `from` to `to` (which mustn't exist): files and folders, no links, no
/// `.git`, within the limits.
fn copy_tree(from: &Path, to: &Path, files: &mut usize, bytes: &mut u64) -> Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        let kind = entry.file_type()?;
        if kind.is_symlink() || name == ".git" {
            continue;
        }
        let target = to.join(&name);
        if kind.is_dir() {
            copy_tree(&entry.path(), &target, files, bytes)?;
        } else if kind.is_file() {
            *files += 1;
            *bytes += entry.metadata()?.len();
            if *files > MAX_FILES || *bytes > MAX_BYTES {
                return Err(Error::Invalid(
                    "That folder is too big for a plugin or a marketplace.".into(),
                ));
            }
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Puts the finished folder `staged` at `dest`, replacing what was there.
fn put_in_place(staged: &Path, dest: &Path) -> Result<()> {
    if dest.exists() {
        std::fs::remove_dir_all(dest)?;
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(staged, dest)?;
    Ok(())
}

/// A folder of its own next to `dest` for work in progress.
fn staging(dest: &Path) -> PathBuf {
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    dest.with_file_name(format!(".{name}.staging-{}", std::process::id()))
}

/// Copies `from` (`sub`: a folder in it) to `dest`, replacing it.
fn copy_folder(from: &Path, sub: Option<&str>, dest: &Path) -> Result<()> {
    let source = match sub {
        Some(s) if !s.is_empty() => {
            let rel = PathBuf::from(s);
            if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
                return Err(Error::Invalid(format!("{s} isn't a folder inside it.")));
            }
            from.join(rel)
        }
        _ => from.to_path_buf(),
    };
    if !source.is_dir() {
        return Err(Error::Invalid(format!(
            "{} isn't a folder.",
            source.display()
        )));
    }
    let staged = staging(dest);
    let _ = std::fs::remove_dir_all(&staged);
    let (mut files, mut bytes) = (0, 0);
    if let Err(e) = copy_tree(&source, &staged, &mut files, &mut bytes) {
        let _ = std::fs::remove_dir_all(&staged);
        return Err(e);
    }
    put_in_place(&staged, dest)
}

/// Copies a folder (a local marketplace, or a plugin from one; `sub` a folder inside it) into the
/// plugins folder at `dest`, replacing what was there. The source is the user's choice (the
/// frontend asks); links and `.git` are left out.
#[tauri::command]
pub async fn plugins_copy(
    state: State<'_, AppState>,
    source: String,
    sub: Option<String>,
    dest: String,
) -> Result<String> {
    let dest = destination(&state, &dest)?;
    let source = simplify(PathBuf::from(source));
    tauri::async_runtime::spawn_blocking(move || {
        copy_folder(&source, sub.as_deref(), &dest).map(|_| dest.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| Error::Invalid(format!("copy failed: {e}")))?
}

/// Clones `url` (at `git_ref`, shallow) with the user's git and puts it, or its folder `sub`,
/// at `dest` in the plugins folder, replacing what was there.
#[tauri::command]
pub async fn plugins_clone(
    state: State<'_, AppState>,
    url: String,
    git_ref: Option<String>,
    sub: Option<String>,
    dest: String,
) -> Result<String> {
    let dest = destination(&state, &dest)?;
    let url = url.trim().to_string();
    if url.is_empty() || url.starts_with('-') {
        return Err(Error::Invalid("That isn't a repository URL.".into()));
    }
    if git_ref.as_deref().is_some_and(|r| r.starts_with('-')) {
        return Err(Error::Invalid("That isn't a branch or tag.".into()));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let parent = dest
            .parent()
            .ok_or_else(|| Error::Invalid("no parent folder".into()))?
            .to_path_buf();
        std::fs::create_dir_all(&parent)?;
        let clone = PathBuf::from(format!("{}-clone", staging(&dest).to_string_lossy()));
        let _ = std::fs::remove_dir_all(&clone);
        let clone_name = clone
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut args = vec!["clone", "--depth", "1"];
        if let Some(r) = git_ref.as_deref() {
            args.extend(["--branch", r]);
        }
        args.extend(["--", url.as_str(), clone_name.as_str()]);
        let cloned = crate::git::ops::remote_op(&parent, &args, |_| {});
        let result = cloned.and_then(|_| match sub.as_deref() {
            Some(s) if !s.is_empty() => copy_folder(&clone, Some(s), &dest),
            _ => {
                // The whole repository: its .git goes (it isn't updated in place).
                let _ = std::fs::remove_dir_all(clone.join(".git"));
                put_in_place(&clone, &dest)
            }
        });
        let _ = std::fs::remove_dir_all(&clone);
        result.map(|_| dest.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| Error::Invalid(format!("clone failed: {e}")))?
}

/// Removes a marketplace's or a plugin's folder from the plugins folder.
#[tauri::command]
pub async fn plugins_remove(state: State<'_, AppState>, path: String) -> Result<()> {
    let dest = destination(&state, &path)?;
    if dest.exists() {
        std::fs::remove_dir_all(&dest)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("ide-plugins-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        p
    }

    #[test]
    fn npm_specs_are_names_not_options() {
        assert!(valid_npm_spec("@acme/fmt-plugin@1.2.0"));
        assert!(!valid_npm_spec("x@>1 <2"));
        assert!(valid_npm_spec("fmt-plugin"));
        assert!(!valid_npm_spec("--registry=evil"));
        assert!(!valid_npm_spec("fmt & calc"));
        assert!(!valid_npm_spec("../x"));
        assert!(!valid_npm_spec("owner/repo"));
    }

    #[test]
    fn copies_a_folder_or_a_part_of_it_and_replaces() {
        let base = tmp("copy");
        let src = base.join("src");
        std::fs::create_dir_all(src.join("plugins/fmt/commands")).unwrap();
        std::fs::create_dir_all(src.join(".git")).unwrap();
        std::fs::write(src.join(".git/HEAD"), "x").unwrap();
        std::fs::write(src.join("plugins/fmt/commands/fmt.md"), "# fmt").unwrap();
        let dest = base.join("out/cache/m/fmt");
        copy_folder(&src, Some("plugins/fmt"), &dest).unwrap();
        assert!(dest.join("commands/fmt.md").is_file());
        // Again, from the whole folder: replaced, without .git.
        copy_folder(&src, None, &dest).unwrap();
        assert!(dest.join("plugins/fmt/commands/fmt.md").is_file());
        assert!(!dest.join("commands").exists());
        assert!(!dest.join(".git").exists());
        assert!(copy_folder(&src, Some("../x"), &dest).is_err());
        assert!(copy_folder(&src, Some("missing"), &dest).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn only_deep_inside_the_plugins_folder() {
        let root = PathBuf::from("/home/a/.ide/plugins");
        assert!(inside(&root, &root.join("plugins.json"), 1).is_some());
        assert!(inside(&root, &root, 1).is_none());
        assert!(inside(&root, &root.join("cache"), 2).is_none());
        assert!(inside(&root, &root.join("cache/m/p"), 2).is_some());
        assert!(inside(&root, &PathBuf::from("/home/a/.ide/skills"), 0).is_none());
    }
}
