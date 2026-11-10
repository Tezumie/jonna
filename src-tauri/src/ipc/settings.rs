//! Settings and keybindings files (PLAN §12): where they live, and a dedicated watcher so edits made
//! outside the settings editor (or in another window) reload live. The files themselves are read and
//! written with the normal fs commands; [`resolve_path`] lets those reach the user config files.

use std::path::PathBuf;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::error::{Error, Result};
use crate::fs::validate_name;
use crate::store::simplify;
use crate::watch::WatchBatch;
use crate::AppState;

/// User-level files in the app config dir that the frontend may read and write (`AGENTS.md`:
/// the user's own rules for the agent, D200).
const USER_FILES: &[&str] = &["settings.json", "keybindings.json", "mcp.json", "AGENTS.md"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPaths {
    pub user_settings: String,
    pub user_keybindings: String,
    /// `<root>/<workspaceFolderName>/settings.json`, when a folder is open.
    pub workspace_settings: Option<String>,
    pub config_dir: String,
    /// A multi-root workspace's other folders' settings files, the same name in each folder
    /// (`<folder>/<workspaceFolderName>/settings.json`). Left out with a single folder.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub folder_settings: Vec<FolderSettings>,
}

/// One workspace folder's settings file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSettings {
    pub folder: String,
    pub path: String,
}

fn user_file(state: &AppState, name: &str) -> PathBuf {
    simplify(state.dirs.config.clone()).join(name)
}

/// Workspace paths, or one of the user config files (settings.json, keybindings.json), for
/// reading (also Claude Code's user files).
pub fn resolve_path(state: &AppState, path: &str) -> Result<PathBuf> {
    resolve(state, path, true)
}

/// The same for writing: Claude Code's files in `~/.claude` are read, never written (D200 review:
/// `atomic_write` would follow a symlinked CLAUDE.md to wherever it points).
pub fn resolve_write_path(state: &AppState, path: &str) -> Result<PathBuf> {
    resolve(state, path, false)
}

fn resolve(state: &AppState, path: &str, with_claude: bool) -> Result<PathBuf> {
    match state.workspace.resolve(path) {
        Ok(p) => Ok(p),
        Err(err) => {
            let requested = simplify(PathBuf::from(path));
            USER_FILES
                .iter()
                .map(|name| user_file(state, name))
                .find(|p| *p == requested)
                .or_else(|| user_snippet_path(&user_file(state, "snippets"), &requested))
                .or_else(|| user_memory_path(&user_file(state, "memory"), &requested))
                // The user's own subagents (D195): `<config>/agents/*.md`.
                .or_else(|| user_memory_path(&user_file(state, "agents"), &requested))
                // The user's own slash commands (D200): `<config>/commands/*.md`.
                .or_else(|| user_memory_path(&user_file(state, "commands"), &requested))
                // Plan mode's plan documents (D330): `<config>/plans/<chat id>.md`.
                .or_else(|| user_memory_path(&user_file(state, "plans"), &requested))
                // The user's own output styles (D356): `<config>/output-styles/*.md`.
                .or_else(|| user_memory_path(&user_file(state, "output-styles"), &requested))
                .or_else(|| {
                    if with_claude {
                        claude_user_path(state, &requested)
                    } else {
                        None
                    }
                })
                // Agent skills (D206): every user skills folder to read, the IDE's own to write.
                .or_else(|| {
                    if with_claude {
                        crate::ipc::skills::read_path(state, &requested)
                    } else {
                        crate::ipc::skills::write_path(state, &requested)
                    }
                })
                // Claude Code plugins (D358): the IDE's plugins folder, read (its own commands
                // write there).
                .or_else(|| {
                    if with_claude {
                        crate::ipc::plugins::read_path(state, &requested)
                    } else {
                        None
                    }
                })
                .ok_or(err)
        }
    }
}

/// The user snippets folder (`<config>/snippets`) or a snippet file directly in it
/// (`*.json` / `*.code-snippets`, a plain name, not a symlink): user snippets (D117) are read,
/// listed and created with the normal fs commands (D130: they were out of reach before).
fn user_snippet_path(dir: &std::path::Path, requested: &std::path::Path) -> Option<PathBuf> {
    if requested == dir {
        return Some(dir.to_path_buf());
    }
    let name = requested.file_name()?.to_str()?;
    let ok = requested.parent()? == dir
        && validate_name(name).is_ok()
        && (name.ends_with(".json") || name.ends_with(".code-snippets"))
        && !std::fs::symlink_metadata(requested).is_ok_and(|m| m.file_type().is_symlink());
    ok.then(|| requested.to_path_buf())
}

/// The agent's user-level memory (D191: notes about the user that hold in every project), the
/// `<config>/memory` folder or a plain `.md` file directly in it.
fn user_memory_path(dir: &std::path::Path, requested: &std::path::Path) -> Option<PathBuf> {
    if requested == dir {
        return Some(dir.to_path_buf());
    }
    let name = requested.file_name()?.to_str()?;
    let ok = requested.parent()? == dir
        && validate_name(name).is_ok()
        && name.ends_with(".md")
        && !std::fs::symlink_metadata(requested).is_ok_and(|m| m.file_type().is_symlink());
    ok.then(|| requested.to_path_buf())
}

/// Claude Code's user files the agent reads (D200): `~/.claude/CLAUDE.md` (the user's rules) and
/// the prompt files directly in `~/.claude/commands` and `~/.claude/output-styles`. Nothing else
/// in `~/.claude`.
fn claude_user_path(state: &AppState, requested: &std::path::Path) -> Option<PathBuf> {
    let claude = simplify(state.dirs.home.clone()?).join(".claude");
    if requested == claude.join("CLAUDE.md") {
        return Some(requested.to_path_buf());
    }
    user_memory_path(&claude.join("commands"), requested)
        // Claude Code's own output styles (D356), read only.
        .or_else(|| user_memory_path(&claude.join("output-styles"), requested))
}

/// `folder_name` is `product.json → workspaceFolderName`, passed by the frontend.
/// Deletes one of the user's own prompt files the IDE may write (`<config>/commands/*.md`,
/// `agents/*.md`, `memory/*.md`, D205) or a file in the open folder: the same paths
/// `resolve_write_path` allows, files only.
#[tauri::command]
pub async fn user_file_delete(state: State<'_, AppState>, path: String) -> Result<()> {
    let resolved = resolve_write_path(&state, &path)?;
    let meta = std::fs::symlink_metadata(&resolved)?;
    if !meta.is_file() {
        return Err(crate::error::Error::Invalid(format!(
            "{path} isn't a file the IDE may delete"
        )));
    }
    std::fs::remove_file(&resolved)?;
    Ok(())
}

#[tauri::command]
pub async fn settings_paths(
    state: State<'_, AppState>,
    folder_name: String,
) -> Result<SettingsPaths> {
    validate_name(&folder_name)?;
    // `<folder>/<workspace folder>/settings.json`; a remote folder's with `/` (D252).
    let settings_file = |folder: &std::path::Path| match crate::remote::of_dir(folder) {
        Some(dir) => crate::remote::join(&crate::remote::join(&dir, &folder_name), "settings.json"),
        None => folder
            .join(&folder_name)
            .join("settings.json")
            .to_string_lossy()
            .into_owned(),
    };
    let workspace_settings = state.workspace.root().ok().map(|root| settings_file(&root));
    // Read, written and watched like the root's: each is inside its own workspace folder, so
    // `resolve_path` and `settings_watch_set_dirs` let it in.
    let folder_settings = state
        .workspace
        .folders()
        .into_iter()
        .map(|folder| FolderSettings {
            path: settings_file(&folder),
            folder: folder.to_string_lossy().into_owned(),
        })
        .collect();
    Ok(SettingsPaths {
        folder_settings,
        user_settings: user_file(&state, "settings.json")
            .to_string_lossy()
            .into_owned(),
        user_keybindings: user_file(&state, "keybindings.json")
            .to_string_lossy()
            .into_owned(),
        workspace_settings,
        config_dir: simplify(state.dirs.config.clone())
            .to_string_lossy()
            .into_owned(),
    })
}

#[tauri::command]
pub async fn settings_watch_start(
    state: State<'_, AppState>,
    on_batch: Channel<WatchBatch>,
) -> Result<()> {
    state.settings_watcher.start(on_batch)
}

/// Watches the config dir plus workspace folders (the root, to see the workspace folder appear, and that folder;
/// the same in each other folder of a multi-root workspace: `resolve` lets in any of them).
#[tauri::command]
pub async fn settings_watch_set_dirs(state: State<'_, AppState>, dirs: Vec<String>) -> Result<()> {
    // A remote workspace's settings folders: the server watches them (D252).
    let _ = crate::ipc::fs::remote_watch(&state, "settings", &dirs, false).await;
    let config = simplify(state.dirs.config.clone());
    let resolved = dirs
        .iter()
        .filter(|d| !crate::remote::is_remote_path(d))
        .map(|d| {
            let p = simplify(PathBuf::from(d));
            if p == config {
                Ok(p)
            } else {
                state
                    .workspace
                    .resolve(d)
                    .map_err(|_| Error::OutsideScope(d.clone()))
            }
        })
        .collect::<Result<Vec<_>>>()?;
    state.settings_watcher.set_dirs(resolved)
}

#[derive(Debug, Serialize)]
pub struct EditorSettingsFile {
    /// "VS Code", "VS Code Insiders", "Cursor", "VSCodium".
    pub app: String,
    pub path: String,
    pub text: String,
}

/// User settings.json of VS Code-family editors installed on this machine (read-only, fixed
/// locations), for "Import VS Code settings".
#[tauri::command]
pub async fn settings_vscode_user(state: State<'_, AppState>) -> Result<Vec<EditorSettingsFile>> {
    let home = state.dirs.home()?;
    let base = if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
    } else if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
    };
    let mut found = Vec::new();
    for (app, folder) in [
        ("VS Code", "Code"),
        ("VS Code Insiders", "Code - Insiders"),
        ("Cursor", "Cursor"),
        ("VSCodium", "VSCodium"),
    ] {
        let path = base.join(folder).join("User").join("settings.json");
        if let Ok(text) = std::fs::read_to_string(&path) {
            found.push(EditorSettingsFile {
                app: app.to_string(),
                path: path.to_string_lossy().into_owned(),
                text,
            });
        }
    }
    Ok(found)
}

/// Everything "Import from VS Code" can bring over from one editor (D193): its user settings,
/// keybindings, MCP servers, snippets and the extensions it has installed. Read-only.
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EditorProfile {
    pub app: String,
    /// The editor's `User` folder.
    pub dir: String,
    pub settings: Option<String>,
    pub keybindings: Option<String>,
    pub mcp: Option<String>,
    /// `snippets/*.json` and `*.code-snippets`: (file name, text).
    pub snippets: Vec<(String, String)>,
    /// Installed extension ids (`publisher.name`).
    pub extensions: Vec<String>,
}

/// VS Code-family editors: name, its folder under the config dir, its extensions folder in home.
const EDITORS: [(&str, &str, &str); 5] = [
    ("VS Code", "Code", ".vscode"),
    ("VS Code Insiders", "Code - Insiders", ".vscode-insiders"),
    ("Cursor", "Cursor", ".cursor"),
    ("VSCodium", "VSCodium", ".vscode-oss"),
    ("Windsurf", "Windsurf", ".windsurf"),
];

const PROFILE_FILE_LIMIT: u64 = 2 * 1024 * 1024;

fn read_small(path: &std::path::Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > PROFILE_FILE_LIMIT {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// Reads one editor's `User` folder (and its extensions folder, when known).
pub fn read_editor_profile(
    app: &str,
    user: &std::path::Path,
    extensions: Option<&std::path::Path>,
) -> EditorProfile {
    let mut snippets = Vec::new();
    if let Ok(entries) = std::fs::read_dir(user.join("snippets")) {
        for entry in entries.flatten().take(200) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !(name.ends_with(".json") || name.ends_with(".code-snippets"))
                || validate_name(&name).is_err()
            {
                continue;
            }
            if let Some(text) = read_small(&entry.path()) {
                snippets.push((name, text));
            }
        }
    }
    snippets.sort();
    EditorProfile {
        app: app.to_string(),
        dir: user.to_string_lossy().into_owned(),
        settings: read_small(&user.join("settings.json")),
        keybindings: read_small(&user.join("keybindings.json")),
        mcp: read_small(&user.join("mcp.json")),
        snippets,
        extensions: extensions.map(installed_extensions).unwrap_or_default(),
    }
}

/// Extension ids from `extensions.json` (VS Code keeps the list there), else the folder names
/// (`publisher.name-1.2.3`, without the version).
pub fn installed_extensions(dir: &std::path::Path) -> Vec<String> {
    let mut ids: Vec<String> = read_small(&dir.join("extensions.json"))
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.as_array().cloned())
        .map(|list| {
            list.iter()
                .filter_map(|e| e.pointer("/identifier/id").and_then(|v| v.as_str()))
                .map(str::to_lowercase)
                .collect()
        })
        .unwrap_or_default();
    if ids.is_empty() {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if !entry.path().is_dir() || name.starts_with('.') {
                    continue;
                }
                // publisher.name-1.2.3(-platform): the id is the part before the version.
                let id = name
                    .split('-')
                    .take_while(|p| !p.starts_with(|c: char| c.is_ascii_digit()))
                    .collect::<Vec<_>>()
                    .join("-");
                if id.contains('.') {
                    ids.push(id);
                }
            }
        }
    }
    ids.sort();
    ids.dedup();
    ids
}

/// The VS Code-family editors on this machine, or the `User` folder the user picked (`dir`: a
/// portable install, a copied profile).
#[tauri::command]
pub async fn settings_editor_profiles(
    state: State<'_, AppState>,
    dir: Option<String>,
) -> Result<Vec<EditorProfile>> {
    let home = state.dirs.home()?;
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(dir) = dir.filter(|d| !d.is_empty()) {
            let path = PathBuf::from(&dir);
            if !path.is_dir() {
                return Err(crate::error::Error::Invalid(format!("not a folder: {dir}")));
            }
            // A portable install's `data/user-data/User`, or the User folder itself.
            let user = if path.join("User").is_dir() {
                path.join("User")
            } else {
                path.clone()
            };
            let ext = ["extensions", "../extensions", "../../extensions"]
                .iter()
                .map(|r| user.join(r))
                .find(|p| p.is_dir());
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Folder".into());
            return Ok(vec![read_editor_profile(&name, &user, ext.as_deref())]);
        }
        let base = if cfg!(target_os = "windows") {
            std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("AppData").join("Roaming"))
        } else if cfg!(target_os = "macos") {
            home.join("Library").join("Application Support")
        } else {
            std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".config"))
        };
        Ok(EDITORS
            .iter()
            .filter_map(|(app, folder, ext)| {
                let user = base.join(folder).join("User");
                user.is_dir().then(|| {
                    let ext_dir = home.join(ext).join("extensions");
                    read_editor_profile(app, &user, ext_dir.is_dir().then_some(ext_dir.as_path()))
                })
            })
            .collect())
    })
    .await
    .map_err(|e| crate::error::Error::Invalid(e.to_string()))?
}

/// MCP server lists other tools keep on this machine (D193, read when `agent.mcp.discovery` is
/// on): Claude Desktop's config, Claude Code's `~/.claude.json`, Cursor's `~/.cursor/mcp.json`
/// and VS Code-family editors' user `mcp.json`. (source label, text) pairs; read-only.
#[tauri::command]
pub async fn mcp_discover(state: State<'_, AppState>) -> Result<Vec<(String, String)>> {
    let home = state.dirs.home()?;
    let root = state.workspace.root().ok();
    tauri::async_runtime::spawn_blocking(move || {
        let config = if cfg!(target_os = "windows") {
            std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("AppData").join("Roaming"))
        } else if cfg!(target_os = "macos") {
            home.join("Library").join("Application Support")
        } else {
            std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".config"))
        };
        let mut places: Vec<(String, PathBuf)> = vec![
            (
                "Claude Desktop".into(),
                config.join("Claude").join("claude_desktop_config.json"),
            ),
            ("Cursor".into(), home.join(".cursor").join("mcp.json")),
        ];
        let mut found: Vec<(String, String)> = Vec::new();
        // Claude Code's ~/.claude.json holds much more (account, history): only its servers
        // leave Rust — the user-wide ones and this folder's.
        if let Some(servers) = claude_code_servers(&home.join(".claude.json"), root.as_deref()) {
            found.push(("Claude Code".into(), servers));
        }
        for (app, folder, _) in EDITORS {
            places.push((
                app.to_string(),
                config.join(folder).join("User").join("mcp.json"),
            ));
        }
        found.extend(
            places
                .into_iter()
                .filter_map(|(label, path)| read_small(&path).map(|text| (label, text))),
        );
        Ok(found)
    })
    .await
    .map_err(|e| crate::error::Error::Invalid(e.to_string()))?
}

/// `{"mcpServers": {…}}` from Claude Code's config: its top-level servers and those of the
/// project at `root`. Read without the small-file cap (the file keeps history), up to 64 MB.
fn claude_code_servers(path: &std::path::Path, root: Option<&std::path::Path>) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > 64 * 1024 * 1024 {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let mut servers = serde_json::Map::new();
    if let Some(top) = v.get("mcpServers").and_then(|s| s.as_object()) {
        servers.extend(top.clone());
    }
    if let (Some(root), Some(projects)) = (root, v.get("projects").and_then(|p| p.as_object())) {
        let want = crate::store::simplify(root.to_path_buf());
        for (key, project) in projects {
            if crate::store::simplify(PathBuf::from(key)) == want {
                if let Some(own) = project.get("mcpServers").and_then(|s| s.as_object()) {
                    servers.extend(own.clone());
                }
            }
        }
    }
    (!servers.is_empty()).then(|| serde_json::json!({ "mcpServers": servers }).to_string())
}

#[cfg(test)]
mod editor_profile_tests {
    use super::{installed_extensions, read_editor_profile};

    #[test]
    fn a_user_folder_and_its_extensions_are_read() {
        let root = std::env::temp_dir().join(format!("ide-profile-{}", std::process::id()));
        let user = root.join("User");
        std::fs::create_dir_all(user.join("snippets")).unwrap();
        std::fs::write(user.join("settings.json"), "{\"editor.fontSize\": 15}").unwrap();
        std::fs::write(user.join("snippets").join("ts.json"), "{}").unwrap();
        std::fs::write(user.join("snippets").join("notes.txt"), "x").unwrap();
        let ext = root.join("extensions");
        for d in [
            "esbenp.prettier-vscode-11.0.0",
            "ms-python.python-2025.1.0-win32-x64",
            "my.cool-ext-1.0.0",
            ".obsolete",
        ] {
            std::fs::create_dir_all(ext.join(d)).unwrap();
        }
        let p = read_editor_profile("VS Code", &user, Some(&ext));
        assert_eq!(p.settings.as_deref(), Some("{\"editor.fontSize\": 15}"));
        assert_eq!(p.snippets.len(), 1);
        assert_eq!(
            p.extensions,
            ["esbenp.prettier-vscode", "ms-python.python", "my.cool-ext"]
        );
        std::fs::write(
            ext.join("extensions.json"),
            r#"[{"identifier":{"id":"GitHub.Copilot"},"version":"1"}]"#,
        )
        .unwrap();
        assert_eq!(installed_extensions(&ext), ["github.copilot"]);
        let _ = std::fs::remove_dir_all(root);
    }
}

#[cfg(test)]
mod settings_paths_tests {
    use super::{FolderSettings, SettingsPaths};

    #[test]
    fn other_folders_settings_are_listed_only_when_there_are_some() {
        let mut paths = SettingsPaths {
            user_settings: "u".into(),
            user_keybindings: "k".into(),
            workspace_settings: Some("w".into()),
            config_dir: "c".into(),
            folder_settings: Vec::new(),
        };
        let single = serde_json::to_string(&paths).unwrap_or_default();
        assert_eq!(
            single,
            r#"{"userSettings":"u","userKeybindings":"k","workspaceSettings":"w","configDir":"c"}"#
        );
        paths.folder_settings.push(FolderSettings {
            folder: "/b".into(),
            path: "/b/.settings/settings.json".into(),
        });
        let multi = serde_json::to_string(&paths).unwrap_or_default();
        assert!(multi
            .contains(r#""folderSettings":[{"folder":"/b","path":"/b/.settings/settings.json"}]"#));
    }
}

#[cfg(test)]
mod snippet_path_tests {
    use super::user_snippet_path;
    use std::path::Path;

    #[test]
    fn only_snippet_files_directly_in_the_folder() {
        let dir = Path::new("/cfg/snippets");
        assert!(user_snippet_path(dir, Path::new("/cfg/snippets")).is_some());
        assert!(user_snippet_path(dir, Path::new("/cfg/snippets/ts.json")).is_some());
        assert!(user_snippet_path(dir, Path::new("/cfg/snippets/a.code-snippets")).is_some());
        assert!(user_snippet_path(dir, Path::new("/cfg/snippets/x.sh")).is_none());
        assert!(user_snippet_path(dir, Path::new("/cfg/snippets/sub/a.json")).is_none());
        assert!(user_snippet_path(dir, Path::new("/cfg/snippets/../settings.json")).is_none());
        assert!(user_snippet_path(dir, Path::new("/cfg/other.json")).is_none());
    }
}

/// Most bytes of a profile file read back (settings, keybindings and snippets are small).
const MAX_PROFILE_BYTES: u64 = 8 * 1024 * 1024;

/// Debug builds (UI tests) may name the file; release builds always ask with the system dialog,
/// so the frontend can't read or write arbitrary paths through these commands.
fn test_path(path: Option<String>) -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        path.map(PathBuf::from)
    } else {
        None
    }
}

/// Saves a settings profile (D130) where the user picks: returns the path, or None if cancelled.
#[tauri::command]
pub async fn profile_save(
    app: tauri::AppHandle,
    file_name: String,
    json: String,
    path: Option<String>,
) -> Result<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let target = match test_path(path) {
        Some(p) => Some(p),
        None => {
            let picked = tauri::async_runtime::spawn_blocking(move || {
                app.dialog()
                    .file()
                    .set_title("Export profile")
                    .set_file_name(file_name)
                    .add_filter("Profile", &["json"])
                    .blocking_save_file()
            })
            .await
            .map_err(|e| Error::Invalid(e.to_string()))?;
            match picked {
                Some(p) => Some(
                    p.into_path()
                        .map_err(|e| Error::Invalid(format!("not a file path: {e}")))?,
                ),
                None => None,
            }
        }
    };
    let Some(target) = target else {
        return Ok(None);
    };
    crate::store::atomic_write(&target, json.as_bytes())?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

/// Saves a chat attachment (an image or a text the user attached, D211) where the user picks in
/// the system dialog: the bytes are the raw body, `x-name` the suggested file name. The path comes
/// only from the dialog (or, in debug builds, `x-test-path` for UI tests), never from the page.
/// Returns the path, or None if cancelled.
#[tauri::command]
pub async fn attachment_save(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(crate::ipc::fs::percent_decode)
            .transpose()
    };
    let name: String = header("x-name")?
        .unwrap_or_else(|| "attachment".into())
        .chars()
        .filter(|c| {
            !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') && !c.is_control()
        })
        .collect();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(Error::Invalid("expected a raw byte body".into()));
    };
    let bytes = bytes.clone();
    let target = match test_path(header("x-test-path")?) {
        Some(p) => Some(p),
        None => {
            let picked = tauri::async_runtime::spawn_blocking(move || {
                app.dialog()
                    .file()
                    .set_title("Save attachment")
                    .set_file_name(if name.trim().is_empty() {
                        "attachment".into()
                    } else {
                        name
                    })
                    .blocking_save_file()
            })
            .await
            .map_err(|e| Error::Invalid(e.to_string()))?;
            match picked {
                Some(p) => Some(
                    p.into_path()
                        .map_err(|e| Error::Invalid(format!("not a file path: {e}")))?,
                ),
                None => None,
            }
        }
    };
    let Some(target) = target else {
        return Ok(None);
    };
    crate::store::atomic_write(&target, &bytes)?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

/// Reads a settings profile the user picks: `{ path, text }`, or None if cancelled.
#[tauri::command]
pub async fn profile_open(
    app: tauri::AppHandle,
    path: Option<String>,
) -> Result<Option<(String, String)>> {
    use tauri_plugin_dialog::DialogExt;
    let source = match test_path(path) {
        Some(p) => Some(p),
        None => {
            let picked = tauri::async_runtime::spawn_blocking(move || {
                app.dialog()
                    .file()
                    .set_title("Import profile")
                    .add_filter("Profile", &["json"])
                    .blocking_pick_file()
            })
            .await
            .map_err(|e| Error::Invalid(e.to_string()))?;
            match picked {
                Some(p) => Some(
                    p.into_path()
                        .map_err(|e| Error::Invalid(format!("not a file path: {e}")))?,
                ),
                None => None,
            }
        }
    };
    let Some(source) = source else {
        return Ok(None);
    };
    if std::fs::metadata(&source)?.len() > MAX_PROFILE_BYTES {
        return Err(Error::Invalid(
            "that file is too large to be a profile".into(),
        ));
    }
    let text = std::fs::read_to_string(&source)?;
    Ok(Some((source.to_string_lossy().into_owned(), text)))
}
