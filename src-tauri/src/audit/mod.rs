//! Append-only audit log of dispatched commands: `<appData>/logs/audit.jsonl`.
//! Rotates at 10 MB and keeps 5 old files (`audit.jsonl.1` … `audit.jsonl.5`), per PLAN §12.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::error::{Error, Result};

const MAX_BYTES: u64 = 10 * 1024 * 1024;
const KEEP: u32 = 5;

pub struct AuditLog {
    path: PathBuf,
    max_bytes: u64,
    lock: Mutex<()>,
}

impl AuditLog {
    pub fn new(logs_dir: &Path) -> Self {
        Self::with_limit(logs_dir, MAX_BYTES)
    }

    fn with_limit(logs_dir: &Path, max_bytes: u64) -> Self {
        Self {
            path: logs_dir.join("audit.jsonl"),
            max_bytes,
            lock: Mutex::new(()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Appends one entry. `line` must be a single JSON object (validated, newlines rejected).
    pub fn append(&self, line: &str) -> Result<()> {
        let value: serde_json::Value = serde_json::from_str(line)?;
        if !value.is_object() {
            return Err(Error::Invalid("audit entry must be a JSON object".into()));
        }
        // Re-serialize so the file is guaranteed to be one compact object per line.
        let compact = serde_json::to_string(&value)?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| Error::Invalid("lock poisoned".into()))?;
        if fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0) >= self.max_bytes {
            self.rotate()?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        file.write_all(compact.as_bytes())?;
        file.write_all(b"\n")?;
        Ok(())
    }

    fn rotate(&self) -> Result<()> {
        let numbered = |n: u32| PathBuf::from(format!("{}.{n}", self.path.display()));
        let _ = fs::remove_file(numbered(KEEP));
        for n in (1..KEEP).rev() {
            let from = numbered(n);
            if from.exists() {
                fs::rename(&from, numbered(n + 1))?;
            }
        }
        fs::rename(&self.path, numbered(1))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_and_rotates() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("ide-audit-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir)?;
        let log = AuditLog::with_limit(&dir, 64);
        assert!(log.append("[1]").is_err());
        assert!(log.append("not json").is_err());
        for i in 0..20 {
            log.append(&format!(
                "{{\"n\": {i}, \"pad\": \"xxxxxxxxxxxxxxxxxxxx\"}}"
            ))?;
        }
        assert!(log.path().exists());
        assert!(dir.join("audit.jsonl.1").exists());
        assert!(dir.join("audit.jsonl.5").exists());
        assert!(!dir.join("audit.jsonl.6").exists());
        let last = fs::read_to_string(log.path())?;
        assert!(last
            .lines()
            .all(|l| serde_json::from_str::<serde_json::Value>(l).is_ok()));
        Ok(())
    }
}
