//! Agent storage in app data (never in the repository): session transcripts
//! (`agent/sessions/<id>.json`) and checkpoints — file contents before an agent's changes were
//! applied (`agent/checkpoints/<session>/<turn>.json`), for one-click restore.

pub mod docs;
pub mod render;
pub mod reports;
pub mod scratch;
pub mod session_index;
pub mod socket;
pub mod tree;
pub mod usage;
pub mod window_chats;
pub mod worktree;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};
use crate::store::atomic_write;

fn safe_id(id: &str) -> Result<&str> {
    if !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Ok(id)
    } else {
        Err(Error::Invalid(format!("bad id: {id}")))
    }
}

pub fn sessions_dir(data: &Path) -> PathBuf {
    data.join("agent").join("sessions")
}

#[cfg(test)]
pub fn save_session(data: &Path, id: &str, json: &str) -> Result<()> {
    save_session_if(data, id, json, None).map(|_| ())
}

/// A saved transcript's version (D221): its modified time (ns) and size, or None when there's
/// no file. Cheap (a stat), so a window can tell whether another one wrote the chat since.
pub fn session_version(data: &Path, id: &str) -> Result<Option<String>> {
    let path = sessions_dir(data).join(format!("{}.json", safe_id(id)?));
    match std::fs::metadata(&path) {
        Ok(meta) => {
            let nanos = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            Ok(Some(format!("{nanos}:{}", meta.len())))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// What a save did: the file's new version, or a conflict (nothing written).
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    pub version: Option<String>,
    pub conflict: bool,
}

/// Saves a transcript; with `expect`, only when the file is still at that version (D221: the
/// same chat open in two windows: the second writer is told instead of overwriting). A file
/// that's gone (deleted elsewhere) isn't a conflict.
pub fn save_session_if(
    data: &Path,
    id: &str,
    json: &str,
    expect: Option<&str>,
) -> Result<SaveOutcome> {
    serde_json::from_str::<Value>(json)?;
    if let Some(expected) = expect {
        if let Some(now) = session_version(data, id)? {
            if now != expected {
                return Ok(SaveOutcome {
                    version: Some(now),
                    conflict: true,
                });
            }
        }
    }
    let dir = sessions_dir(data);
    atomic_write(&dir.join(format!("{}.json", safe_id(id)?)), json.as_bytes())?;
    session_index::forget(&dir, id);
    Ok(SaveOutcome {
        version: session_version(data, id)?,
        conflict: false,
    })
}

pub fn load_session(data: &Path, id: &str) -> Result<Option<String>> {
    match std::fs::read_to_string(sessions_dir(data).join(format!("{}.json", safe_id(id)?))) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// A cheap change signal per saved chat (D222): its size and modification time ("len:nanos"),
/// None when it isn't saved (or the id is bad). Saves are atomic renames, so each one changes it.
/// The worktree overview reads a chat only when its stamp moved (other windows save them).
pub fn session_stamps(data: &Path, ids: &[String]) -> Vec<Option<String>> {
    let dir = sessions_dir(data);
    ids.iter()
        .map(|id| {
            let meta = std::fs::metadata(dir.join(format!("{}.json", safe_id(id).ok()?))).ok()?;
            let nanos = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            Some(format!("{}:{nanos}", meta.len()))
        })
        .collect()
}

pub fn delete_session(data: &Path, id: &str) -> Result<()> {
    let id = safe_id(id)?;
    let dir = sessions_dir(data);
    let _ = std::fs::remove_file(dir.join(format!("{id}.json")));
    session_index::forget(&dir, id);
    let _ = std::fs::remove_dir_all(data.join("agent").join("checkpoints").join(id));
    // Its images (D381).
    let _ = std::fs::remove_dir_all(media_dir(data, id));
    // Its private folder, when it ran with no folder open (D208).
    let _ = scratch::remove(data, id);
    Ok(())
}

/// A chat's images (D381): what models and tools made, kept whole beside the chat (the chat's
/// file keeps only small previews), so one can still be added to a project later.
fn media_dir(data: &Path, chat: &str) -> PathBuf {
    data.join("agent").join("media").join(chat)
}

/// Keeps an image's bytes (given as base64) under its chat.
pub fn media_put(data: &Path, chat: &str, image: &str, base64_data: &str) -> Result<()> {
    use base64::Engine;
    let (chat, image) = (safe_id(chat)?, safe_id(image)?);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.trim())
        .map_err(|e| Error::Invalid(format!("not base64: {e}")))?;
    let dir = media_dir(data, chat);
    std::fs::create_dir_all(&dir)?;
    atomic_write(&dir.join(format!("{image}.bin")), &bytes)
}

/// An image's bytes as base64, or None when the chat has no such image.
pub fn media_get(data: &Path, chat: &str, image: &str) -> Result<Option<String>> {
    use base64::Engine;
    let (chat, image) = (safe_id(chat)?, safe_id(image)?);
    match std::fs::read(media_dir(data, chat).join(format!("{image}.bin"))) {
        Ok(bytes) => Ok(Some(
            base64::engine::general_purpose::STANDARD.encode(bytes),
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    /// The session's `meta` object (title, updated, workspace…).
    pub meta: Value,
}

/// Every saved session's `meta`, newest first (by `meta.updated`). Only chats saved since the
/// last list are read (`session_index`).
pub fn list_sessions(data: &Path) -> Result<Vec<SessionSummary>> {
    let mut out = session_index::list(&sessions_dir(data));
    out.sort_by(|a, b| {
        let t = |s: &SessionSummary| s.meta.get("updated").and_then(Value::as_f64).unwrap_or(0.0);
        t(b).total_cmp(&t(a))
    });
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSnapshot {
    pub path: String,
    /// None: the file didn't exist (restoring deletes it).
    pub content: Option<String>,
}

fn checkpoint_file(data: &Path, session: &str, turn: u32) -> Result<PathBuf> {
    Ok(data
        .join("agent")
        .join("checkpoints")
        .join(safe_id(session)?)
        .join(format!("{turn}.json")))
}

/// Adds files to a checkpoint (a file already in it keeps its first, oldest snapshot).
pub fn checkpoint_add(
    data: &Path,
    session: &str,
    turn: u32,
    files: Vec<FileSnapshot>,
) -> Result<()> {
    let path = checkpoint_file(data, session, turn)?;
    let mut all = checkpoint_load(data, session, turn)?;
    for f in files {
        if !all.iter().any(|x| x.path == f.path) {
            all.push(f);
        }
    }
    atomic_write(&path, serde_json::to_string(&all)?.as_bytes())
}

pub fn checkpoint_load(data: &Path, session: &str, turn: u32) -> Result<Vec<FileSnapshot>> {
    match std::fs::read_to_string(checkpoint_file(data, session, turn)?) {
        Ok(t) => Ok(serde_json::from_str(&t)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chat_stamp_moves_when_it_is_saved_again() {
        let dir = std::env::temp_dir().join(format!("ide-agent-stamps-{}", std::process::id()));
        let ids = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(session_stamps(&dir, &ids(&["w1", "../x"])), [None, None]);
        save_session(&dir, "w1", r#"{"meta":{"status":"running"}}"#).unwrap();
        let first = session_stamps(&dir, &ids(&["w1"]));
        assert!(first[0].is_some());
        assert_eq!(
            session_stamps(&dir, &ids(&["w1"])),
            first,
            "unchanged: same stamp"
        );
        // A longer chat: the size alone moves it, whatever the clock's resolution.
        save_session(&dir, "w1", r#"{"meta":{"status":"idle","title":"done"}}"#).unwrap();
        assert_ne!(session_stamps(&dir, &ids(&["w1"])), first);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_save_from_a_stale_window_is_a_conflict() {
        let dir = std::env::temp_dir().join(format!("ide-agent-ver-{}", std::process::id()));
        assert_eq!(session_version(&dir, "c1").unwrap(), None);
        // No file yet: any expectation saves (nothing to overwrite).
        let first = save_session_if(&dir, "c1", r#"{"a":1}"#, Some("x")).unwrap();
        assert!(!first.conflict);
        let v1 = first.version.clone().unwrap();
        assert_eq!(
            session_version(&dir, "c1").unwrap().as_deref(),
            Some(v1.as_str())
        );
        // Window A saves on its version; window B still holds v1.
        std::thread::sleep(std::time::Duration::from_millis(20));
        let a = save_session_if(&dir, "c1", r#"{"a":22}"#, Some(&v1)).unwrap();
        assert!(!a.conflict);
        let b = save_session_if(&dir, "c1", r#"{"b":1}"#, Some(&v1)).unwrap();
        assert!(b.conflict);
        assert_eq!(
            load_session(&dir, "c1").unwrap().as_deref(),
            Some(r#"{"a":22}"#)
        );
        // Without an expectation (keep this window's version): written.
        assert!(
            !save_session_if(&dir, "c1", r#"{"b":1}"#, None)
                .unwrap()
                .conflict
        );
        assert_eq!(
            load_session(&dir, "c1").unwrap().as_deref(),
            Some(r#"{"b":1}"#)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sessions_and_checkpoints() {
        let dir = std::env::temp_dir().join(format!("ide-agent-{}", std::process::id()));
        save_session(
            &dir,
            "s1",
            r#"{"meta":{"title":"a","updated":1},"messages":[]}"#,
        )
        .unwrap();
        save_session(
            &dir,
            "s2",
            r#"{"meta":{"title":"b","updated":2},"messages":[]}"#,
        )
        .unwrap();
        let list = list_sessions(&dir).unwrap();
        assert_eq!(
            list.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(),
            ["s2", "s1"]
        );
        assert!(save_session(&dir, "../x", "{}").is_err());
        checkpoint_add(
            &dir,
            "s1",
            1,
            vec![FileSnapshot {
                path: "/w/a".into(),
                content: Some("old".into()),
            }],
        )
        .unwrap();
        checkpoint_add(
            &dir,
            "s1",
            1,
            vec![
                FileSnapshot {
                    path: "/w/a".into(),
                    content: Some("newer".into()),
                },
                FileSnapshot {
                    path: "/w/b".into(),
                    content: None,
                },
            ],
        )
        .unwrap();
        let cp = checkpoint_load(&dir, "s1", 1).unwrap();
        assert_eq!(cp.len(), 2);
        assert_eq!(cp[0].content.as_deref(), Some("old"));
        delete_session(&dir, "s1").unwrap();
        assert!(load_session(&dir, "s1").unwrap().is_none());
        assert!(checkpoint_load(&dir, "s1", 1).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
