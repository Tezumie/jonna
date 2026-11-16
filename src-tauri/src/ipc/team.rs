//! A team's library (src-tauri/src/team). `base` is the accounts server, as for the account
//! itself. The list and the texts come from the service; which items are on is the front end's
//! to say (`team_apply`), and the files the loaders read are written here, into `active/`.
//! One step at a time: two refreshes would write the same folder.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::error::{Error, Result};
use crate::store::simplify;
use crate::team::cache::{self, Applied, Cache, Index};
use crate::team::{self, Put};
use crate::AppState;

static STEP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn data_dir(state: &AppState) -> PathBuf {
    simplify(state.dirs.data.clone())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// A path inside a team's `active/` tree (`<data>/team/<team>/active/…`), for reading and
/// listing with the normal fs commands (called from `settings::resolve`). Only plain names,
/// no link on the way: a read can't leave the tree. Never for writing.
pub fn read_path(state: &AppState, requested: &Path) -> Option<PathBuf> {
    inside_active(&cache::teams_dir(&data_dir(state)), requested)
}

fn inside_active(teams: &Path, requested: &Path) -> Option<PathBuf> {
    let rest = requested.strip_prefix(teams).ok()?;
    let parts: Vec<Component> = rest.components().collect();
    if parts.len() < 2
        || parts.iter().any(|c| !matches!(c, Component::Normal(_)))
        || parts[1].as_os_str() != "active"
    {
        return None;
    }
    let mut at = teams.to_path_buf();
    for part in &parts {
        at.push(part);
        if std::fs::symlink_metadata(&at).is_ok_and(|m| m.file_type().is_symlink()) {
            return None;
        }
    }
    Some(requested.to_path_buf())
}

/// The library as the service lists it now, kept as this computer's list.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    #[serde(flatten)]
    index: Index,
    /// The `active/` folder the loaders read.
    dir: String,
}

fn library(cache: &Cache, index: Index) -> Library {
    Library {
        index,
        dir: cache.active_dir().to_string_lossy().into_owned(),
    }
}

/// Reads the library's list from the service and keeps it (`rev`: the profile's `libraryRev`
/// it was read at). Null when the account is in no team. No text is fetched.
#[tauri::command]
pub async fn team_library(
    state: State<'_, AppState>,
    base: String,
    rev: Option<u64>,
) -> Result<Option<Library>> {
    let _step = STEP.lock().await;
    let data = data_dir(&state);
    let Some(listing) = team::listing(&team::api(&base, &state.dirs.data)).await? else {
        return Ok(None);
    };
    let cache = Cache::new(&data, &listing.team.id);
    let index = cache.set_listing(listing.team, &listing.state, rev, listing.items, now_ms())?;
    Ok(Some(library(&cache, index)))
}

/// The list as this computer last kept it for `team` (empty when it never did): no network.
#[tauri::command]
pub async fn team_cache(state: State<'_, AppState>, team: String) -> Result<Library> {
    let _step = STEP.lock().await;
    let cache = Cache::new(&data_dir(&state), &team);
    let index = cache.index();
    Ok(library(&cache, index))
}

/// What a fetch got.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetched {
    pub fetched: Vec<String>,
    /// Items whose text couldn't be had (offline, gone meanwhile, too large): tried again later.
    pub failed: Vec<String>,
}

/// Downloads the text of the listed items `ids` into the cache.
#[tauri::command]
pub async fn team_fetch(
    state: State<'_, AppState>,
    base: String,
    team: String,
    ids: Vec<String>,
) -> Result<Fetched> {
    let _step = STEP.lock().await;
    let cache = Cache::new(&data_dir(&state), &team);
    let api = team::api(&base, &state.dirs.data);
    let listed = cache.index().items;
    let mut out = Fetched {
        fetched: Vec::new(),
        failed: Vec::new(),
    };
    for id in ids.into_iter().take(team::MAX_ITEMS) {
        if !listed.iter().any(|i| i.id == id) {
            continue;
        }
        match team::item_text(&api, &id).await {
            Ok((version, text)) => match cache.store_text(&id, version, &text) {
                Ok(()) => out.fetched.push(id),
                Err(_) => out.failed.push(id),
            },
            // Not reachable or signed out: the rest would fail the same way.
            Err(Error::Sync(code, text))
                if code.ends_with("Offline") || code.ends_with("SignedOut") =>
            {
                if out.fetched.is_empty() {
                    return Err(Error::Sync(code, text));
                }
                out.failed.push(id);
                break;
            }
            Err(_) => out.failed.push(id),
        }
    }
    Ok(out)
}

/// Makes `active/` hold exactly the items `active` (ids) whose text is here.
#[tauri::command]
pub async fn team_apply(
    state: State<'_, AppState>,
    team: String,
    active: Vec<String>,
) -> Result<Applied> {
    let _step = STEP.lock().await;
    Cache::new(&data_dir(&state), &team).apply(&active)
}

/// Removes every team's cache but `keep`'s (null: all): the account left the team, signed out,
/// or is in another one. How many went.
#[tauri::command]
pub async fn team_clear(state: State<'_, AppState>, keep: Option<String>) -> Result<usize> {
    let _step = STEP.lock().await;
    cache::clear_others(&data_dir(&state), keep.as_deref())
}

/// An item's text from the cache (null when it isn't here yet).
#[tauri::command]
pub async fn team_item_text(
    state: State<'_, AppState>,
    team: String,
    id: String,
) -> Result<Option<String>> {
    Cache::new(&data_dir(&state), &team).text(&id)
}

/// Publishes an item over the version it was made from (`expect`; null: it must be new).
/// A newer version published meanwhile comes back as a conflict; nothing is overwritten.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn team_put(
    state: State<'_, AppState>,
    base: String,
    id: String,
    kind: String,
    path: String,
    text: String,
    is_default: bool,
    expect: Option<u64>,
) -> Result<Put> {
    team::put(
        &team::api(&base, &state.dirs.data),
        &id,
        &kind,
        &path,
        &text,
        is_default,
        expect,
    )
    .await
}

/// Takes an item out of the library (publishers).
#[tauri::command]
pub async fn team_delete(state: State<'_, AppState>, base: String, id: String) -> Result<bool> {
    team::delete(&team::api(&base, &state.dirs.data), &id).await
}

#[cfg(test)]
mod tests {
    use super::inside_active;

    #[test]
    fn only_an_active_tree_can_be_read() {
        let teams = std::env::temp_dir().join(format!("ide-team-read-{}", std::process::id()));
        let active = teams.join("t1").join("active");
        std::fs::create_dir_all(active.join("commands")).unwrap();
        std::fs::write(active.join("commands").join("a.md"), "x").unwrap();
        assert!(inside_active(&teams, &active).is_some());
        assert!(inside_active(&teams, &active.join("commands").join("a.md")).is_some());
        // The texts kept for previews and the list aren't the front end's files.
        assert!(inside_active(&teams, &teams.join("t1").join("items")).is_none());
        assert!(inside_active(&teams, &teams.join("t1").join("library.json")).is_none());
        assert!(inside_active(&teams, &teams).is_none());
        assert!(inside_active(&teams, &teams.join("t1")).is_none());
        assert!(inside_active(&teams, &active.join("..").join("items")).is_none());
        assert!(inside_active(&teams, &teams.join("..").join("sync")).is_none());
        #[cfg(unix)]
        {
            let outside = teams.join("outside");
            std::fs::create_dir_all(&outside).unwrap();
            std::os::unix::fs::symlink(&outside, active.join("escape")).unwrap();
            assert!(inside_active(&teams, &active.join("escape").join("secret")).is_none());
        }
        let _ = std::fs::remove_dir_all(teams);
    }
}
