//! Chats across windows (D359): each window (its own process) publishes its chats to
//! `agent/window-chats/<pid>.json`; list_chats reads the other live windows' files. Messages
//! for a chat in another window go through `agent/chat-mail/` (the reports store's format, D233:
//! taken exactly once, by the window that has the chat open).

use std::path::{Path, PathBuf};

use crate::error::Result;
use crate::store::atomic_write;

/// A record this old is a window that's gone (when the windows' registry can't say).
const STALE_MS: u64 = 3 * 60 * 1000;
/// A record whose window doesn't answer is removed once it's this old (a crash, a closed window).
const GONE_MS: u64 = 60 * 1000;

fn dir(data: &Path) -> PathBuf {
    data.join("agent").join("window-chats")
}

/// The mailbox of messages between windows' chats.
pub fn mail_dir(data: &Path) -> PathBuf {
    data.join("agent").join("chat-mail")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// Writes this window's record: `json` (an object) with its pid and the time put in.
pub fn publish(data: &Path, pid: u32, json: &str) -> Result<()> {
    let mut value: serde_json::Value = serde_json::from_str(json)?;
    let Some(obj) = value.as_object_mut() else {
        return Err(crate::error::Error::Invalid("not a JSON object".into()));
    };
    obj.insert("pid".into(), pid.into());
    obj.insert("at".into(), now_ms().into());
    atomic_write(
        &dir(data).join(format!("{pid}.json")),
        serde_json::to_string(&value)?.as_bytes(),
    )
}

/// Removes this window's record (it's closing).
pub fn remove(data: &Path, pid: u32) {
    let _ = std::fs::remove_file(dir(data).join(format!("{pid}.json")));
}

/// The other windows' records (their text). `live`: the pids that answer (None: go by age).
/// Records of windows that are gone are removed.
pub fn list(data: &Path, own: u32, live: Option<&[u32]>) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir(data)) else {
        return Vec::new();
    };
    let now = now_ms();
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(pid) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        if pid == own {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let at = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("at").and_then(|a| a.as_u64()))
            .unwrap_or(0);
        let age = now.saturating_sub(at);
        let alive = match live {
            Some(pids) => pids.contains(&pid),
            None => age <= STALE_MS,
        };
        if alive {
            out.push(text);
        } else if age > GONE_MS {
            let _ = std::fs::remove_file(&path);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publish_list_and_remove() {
        let data = std::env::temp_dir().join(format!("ide-window-chats-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        publish(&data, 11, r#"{"folder":"/a","chats":[]}"#).unwrap();
        publish(&data, 12, r#"{"folder":"/b","chats":[]}"#).unwrap();
        assert!(publish(&data, 13, "[1]").is_err());
        // By age (no registry): both recent; not our own.
        let listed = list(&data, 11, None);
        assert_eq!(listed.len(), 1);
        assert!(listed[0].contains("\"/b\"") && listed[0].contains("\"pid\":12"));
        // With the registry: only the live ones.
        assert!(list(&data, 11, Some(&[])).is_empty());
        assert_eq!(list(&data, 99, Some(&[11])).len(), 1);
        remove(&data, 12);
        assert!(list(&data, 11, None).is_empty());
        let _ = std::fs::remove_dir_all(&data);
    }
}
