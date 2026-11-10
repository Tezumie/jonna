//! Helper reports waiting for their chat (D233): `agent/pending-reports/<helper>.json`, shared by
//! every window (each its own process). A report goes to whichever window has its chat open, and
//! exactly one takes it: claiming renames the file to a name of the claimer's own first, and a
//! rename of a file another window already moved fails, so only one claim returns the text.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::safe_id;
use crate::error::Result;
use crate::store::atomic_write;

/// Reports older than this are dropped by `list` (their chat never opened again).
const MAX_AGE_MS: u64 = 30 * 24 * 3600 * 1000;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingReport {
    /// The helper's id (its worktree chat), which names the file.
    pub id: String,
    /// The chat that started the helper and gets the report.
    pub chat: String,
    pub text: String,
    /// When it was put (ms since the epoch).
    pub at: u64,
}

/// What `list` returns: enough to decide whether to claim, without the text.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingEntry {
    pub id: String,
    pub chat: String,
    pub at: u64,
}

fn dir(data: &Path) -> PathBuf {
    data.join("agent").join("pending-reports")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

pub fn put(data: &Path, id: &str, chat: &str, text: &str) -> Result<()> {
    put_at(&dir(data), id, chat, text)
}

/// The same store in another folder (D359: messages between windows' chats use one of their own).
pub fn put_at(folder: &Path, id: &str, chat: &str, text: &str) -> Result<()> {
    let report = PendingReport {
        id: safe_id(id)?.to_string(),
        chat: safe_id(chat)?.to_string(),
        text: text.to_string(),
        at: now_ms(),
    };
    atomic_write(
        &folder.join(format!("{}.json", report.id)),
        serde_json::to_string(&report)?.as_bytes(),
    )
}

/// The reports waiting, oldest first. Unreadable or expired files are removed.
pub fn list(data: &Path) -> Result<Vec<PendingEntry>> {
    list_at(&dir(data))
}

/// `list` in another folder.
pub fn list_at(folder: &Path) -> Result<Vec<PendingEntry>> {
    let entries = match std::fs::read_dir(folder) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let now = now_ms();
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        // Only `<id>.json`: a claim in progress (`.claim-…`) or a temp file isn't one.
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // A read that fails (a sharing violation while another window renames it into place, an
        // antivirus scan) leaves the file for the next look (D233 audit): only one that reads but
        // doesn't parse is junk, and an old one expired.
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        match serde_json::from_str::<PendingReport>(&text) {
            Ok(r) if now.saturating_sub(r.at) <= MAX_AGE_MS => out.push(PendingEntry {
                id: r.id,
                chat: r.chat,
                at: r.at,
            }),
            _ => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    out.sort_by_key(|e| e.at);
    Ok(out)
}

/// Takes a report: its text, or None when it's gone (another window took it, or it never was).
pub fn claim(data: &Path, id: &str) -> Result<Option<String>> {
    claim_at(&dir(data), id)
}

/// `claim` in another folder.
pub fn claim_at(folder: &Path, id: &str) -> Result<Option<String>> {
    let id = safe_id(id)?;
    let from = folder.join(format!("{id}.json"));
    let to = folder.join(format!("{id}.claim-{}", std::process::id()));
    if let Err(e) = std::fs::rename(&from, &to) {
        return if e.kind() == std::io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(e.into())
        };
    }
    // Unreadable now: put back for a later claim rather than lose it.
    let text = match std::fs::read_to_string(&to) {
        Ok(t) => t,
        Err(e) => {
            let _ = std::fs::rename(&to, &from);
            return Err(e.into());
        }
    };
    let _ = std::fs::remove_file(&to);
    let report: PendingReport = serde_json::from_str(&text)?;
    Ok(Some(report.text))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder of its own under the system's temp folder, removed afterwards.
    struct Tmp(PathBuf);
    impl Tmp {
        fn new(name: &str) -> Self {
            let p = std::env::temp_dir().join(format!("ide-reports-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            Self(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn put_list_and_claim_once() {
        let tmp = Tmp::new("claim");
        put(tmp.path(), "h1", "chatA", "the report").unwrap();
        put(tmp.path(), "h2", "chatB", "another").unwrap();
        let listed = list(tmp.path()).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().any(|e| e.id == "h1" && e.chat == "chatA"));
        assert_eq!(
            claim(tmp.path(), "h1").unwrap().as_deref(),
            Some("the report")
        );
        // Exactly once: a second claim (another window) finds nothing.
        assert_eq!(claim(tmp.path(), "h1").unwrap(), None);
        assert_eq!(list(tmp.path()).unwrap().len(), 1);
    }

    #[test]
    fn bad_ids_and_junk() {
        let tmp = Tmp::new("junk");
        assert!(put(tmp.path(), "../x", "chat", "t").is_err());
        assert!(claim(tmp.path(), "a/b").is_err());
        std::fs::create_dir_all(dir(tmp.path())).unwrap();
        std::fs::write(dir(tmp.path()).join("junk.json"), "not json").unwrap();
        assert!(list(tmp.path()).unwrap().is_empty());
        assert!(!dir(tmp.path()).join("junk.json").exists());
        assert_eq!(list(&tmp.path().join("missing")).unwrap(), Vec::new());
    }
}
