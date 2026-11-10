//! The usage log (D201): one JSON line per model request — when, which chat, provider and model,
//! tokens, cost — in app data (`agent/usage/<n>.jsonl`, one file per 10 days), so the Usage page
//! can show days, models and chats across restarts. It never leaves the computer.
//!
//! Appends are plain `O_APPEND` writes of whole lines (an atomic rewrite per request would copy
//! the file each time); a line cut short by a crash is skipped when read. Kept: 90 days and 20 MB
//! at most; older files are deleted when a new one starts and on every load.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;

use crate::error::{Error, Result};

const CHUNK_MS: u64 = 10 * 86_400_000;
const DAY_MS: u64 = 86_400_000;
pub const KEEP_MS: u64 = 90 * 86_400_000;
pub const MAX_BYTES: u64 = 20 * 1024 * 1024;
/// A record is a handful of fields; anything bigger isn't one.
const MAX_LINE: usize = 2048;

/// Windows share the process: one writer at a time keeps lines whole.
static WRITE: Mutex<()> = Mutex::new(());

pub fn dir(data: &Path) -> PathBuf {
    data.join("agent").join("usage")
}

fn chunk_of(t: u64) -> u64 {
    t / CHUNK_MS
}

/// The log's files, oldest first: (chunk number, path, size).
fn files(data: &Path) -> Vec<(u64, PathBuf, u64)> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir(data)) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(n) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.parse::<u64>().ok())
        else {
            continue;
        };
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push((n, path, size));
    }
    out.sort_by_key(|f| f.0);
    out
}

/// Deletes files older than 90 days, then the oldest ones while the log is over 20 MB (the
/// newest file always stays).
pub fn rotate(data: &Path, now: u64) {
    let oldest_kept = chunk_of(now.saturating_sub(KEEP_MS));
    let mut all = files(data);
    all.retain(|(n, path, _)| {
        if *n < oldest_kept {
            let _ = std::fs::remove_file(path);
            false
        } else {
            true
        }
    });
    let mut total: u64 = all.iter().map(|f| f.2).sum();
    for (_, path, size) in all.iter().take(all.len().saturating_sub(1)) {
        if total <= MAX_BYTES {
            break;
        }
        let _ = std::fs::remove_file(path);
        total -= size;
    }
}

/// A record as stored: a JSON object with a numeric `t` (ms since the epoch), on one line.
fn line_of(record: &Value) -> Result<(u64, String)> {
    let t = record
        .get("t")
        .and_then(Value::as_u64)
        .filter(|_| record.is_object())
        .ok_or_else(|| Error::Invalid("a usage record needs a numeric t".into()))?;
    let line = serde_json::to_string(record)?;
    if line.len() > MAX_LINE {
        return Err(Error::Invalid("usage record too large".into()));
    }
    Ok((t, line))
}

pub fn append(data: &Path, records: &[Value], now: u64) -> Result<()> {
    let _guard = WRITE
        .lock()
        .map_err(|_| Error::Invalid("usage log lock".into()))?;
    let folder = dir(data);
    std::fs::create_dir_all(&folder)?;
    let mut by_chunk: Vec<(u64, String)> = Vec::new();
    for r in records {
        // A bad record is skipped, not the batch; a time far in the future (a skewed clock or a
        // bad caller) would make a "newest" file that rotation never removes.
        let Ok((t, line)) = line_of(r) else {
            continue;
        };
        if t > now.saturating_add(DAY_MS) {
            continue;
        }
        let n = chunk_of(t);
        match by_chunk.iter_mut().find(|(c, _)| *c == n) {
            Some((_, text)) => {
                text.push_str(&line);
                text.push('\n');
            }
            None => by_chunk.push((n, format!("{line}\n"))),
        }
    }
    let mut started = false;
    for (n, text) in by_chunk {
        let path = folder.join(format!("{n}.jsonl"));
        started |= !path.exists();
        // A line cut short (a crash mid-write) would swallow the next record: end it first.
        let torn = ends_unterminated(&path);
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        if torn {
            f.write_all(b"\n")?;
        }
        f.write_all(text.as_bytes())?;
    }
    if started {
        rotate(data, now);
    }
    Ok(())
}

/// Whether the file's last byte isn't a newline (an empty or missing file is fine).
fn ends_unterminated(path: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut last = [0u8; 1];
    f.seek(SeekFrom::End(-1)).is_ok() && f.read_exact(&mut last).is_ok() && last[0] != b'\n'
}

/// Records with `t >= since`, oldest first. Lines that don't parse are skipped.
pub fn load(data: &Path, since: u64, now: u64) -> Result<Vec<Value>> {
    {
        // Not while an append writes (rotation deletes files).
        let _guard = WRITE
            .lock()
            .map_err(|_| Error::Invalid("usage log lock".into()))?;
        rotate(data, now);
    }
    let first = chunk_of(since);
    let mut out = Vec::new();
    for (n, path, _) in files(data) {
        if n < first {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        for line in text.lines() {
            let Ok(v) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if v.get("t")
                .and_then(Value::as_u64)
                .is_some_and(|t| t >= since)
            {
                out.push(v);
            }
        }
    }
    out.sort_by_key(|v| v.get("t").and_then(Value::as_u64).unwrap_or(0));
    Ok(out)
}

/// Deletes the whole log. Returns how many files were removed.
pub fn clear(data: &Path) -> Result<usize> {
    let _guard = WRITE
        .lock()
        .map_err(|_| Error::Invalid("usage log lock".into()))?;
    let all = files(data);
    for (_, path, _) in &all {
        std::fs::remove_file(path)?;
    }
    Ok(all.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ide-usage-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn append_load_clear() {
        let d = temp("basic");
        let now = 2_000 * 86_400_000;
        append(
            &d,
            &[
                json!({ "t": now - 1000, "model": "a", "input": 10 }),
                json!({ "t": now - 20 * 86_400_000, "model": "b" }),
            ],
            now,
        )
        .unwrap();
        append(&d, &[json!({ "t": now, "model": "c" })], now).unwrap();
        // A torn last line is skipped.
        let newest = files(&d).last().unwrap().1.clone();
        std::fs::OpenOptions::new()
            .append(true)
            .open(&newest)
            .unwrap()
            .write_all(b"{\"t\": 12")
            .unwrap();
        let all = load(&d, 0, now).unwrap();
        let models: Vec<_> = all.iter().map(|v| v["model"].as_str().unwrap()).collect();
        assert_eq!(models, ["b", "a", "c"]);
        let recent = load(&d, now - 86_400_000, now).unwrap();
        assert_eq!(recent.len(), 2);
        // The next record after a torn line is whole.
        append(&d, &[json!({ "t": now, "model": "d" })], now).unwrap();
        assert_eq!(load(&d, now, now).unwrap().len(), 2);
        // Bad records are skipped one by one; the good one in the batch is kept.
        append(
            &d,
            &[
                json!({ "model": "no time" }),
                json!({ "t": now, "x": "y".repeat(3000) }),
                json!({ "t": now + 365 * 86_400_000, "model": "future" }),
                json!({ "t": now, "model": "e" }),
            ],
            now,
        )
        .unwrap();
        let last = load(&d, now, now).unwrap();
        assert_eq!(last.len(), 3);
        assert!(last.iter().all(|v| v["model"] != "future"));
        assert_eq!(clear(&d).unwrap(), 3);
        assert!(load(&d, 0, now).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn old_files_rotate_out() {
        let d = temp("rotate");
        let now = 3_000 * 86_400_000;
        append(
            &d,
            &[json!({ "t": now - 100 * 86_400_000 })],
            now - 100 * 86_400_000,
        )
        .unwrap();
        append(
            &d,
            &[json!({ "t": now - 5 * 86_400_000 })],
            now - 5 * 86_400_000,
        )
        .unwrap();
        assert_eq!(files(&d).len(), 2);
        let kept = load(&d, 0, now).unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(files(&d).len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }
}
