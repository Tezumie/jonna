//! Local indexes of documentation sites for the agent's @docs mentions (D204): one JSON file per
//! source in `<appData>/agent/docs/<name>.json`, written by the frontend's crawler
//! (core/agent/docsIndex.ts) and read back for searches. Local only.

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// A source's name: letters, digits, `-` and `_` (it's the file name).
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn path(data: &Path, name: &str) -> Result<PathBuf> {
    if !valid_name(name) {
        return Err(Error::Invalid(format!("not a docs source name: {name}")));
    }
    Ok(data.join("agent").join("docs").join(format!("{name}.json")))
}

/// Most a stored index may be (a few hundred pages of text).
const MAX_BYTES: usize = 32 * 1024 * 1024;

pub fn save(data: &Path, name: &str, json: &str) -> Result<()> {
    if json.len() > MAX_BYTES {
        return Err(Error::Invalid("the docs index is too large".into()));
    }
    let file = path(data, name)?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    crate::store::atomic_write(&file, json.as_bytes())
}

pub fn load(data: &Path, name: &str) -> Result<Option<String>> {
    match std::fs::read_to_string(path(data, name)?) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete(data: &Path, name: &str) -> Result<()> {
    match std::fs::remove_file(path(data, name)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexes_are_saved_loaded_and_deleted_by_a_safe_name() {
        let dir = std::env::temp_dir().join(format!("ide-docs-test-{}", std::process::id()));
        save(&dir, "next-js", "{\"version\":1}").unwrap();
        assert_eq!(
            load(&dir, "next-js").unwrap().as_deref(),
            Some("{\"version\":1}")
        );
        delete(&dir, "next-js").unwrap();
        assert_eq!(load(&dir, "next-js").unwrap(), None);
        delete(&dir, "next-js").unwrap();
        assert!(save(&dir, "../x", "{}").is_err());
        assert!(load(&dir, "a/b").is_err());
        assert!(!valid_name(""));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
