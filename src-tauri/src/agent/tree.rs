//! The folder's files with their size and modified time (D233), for an external agent's turn
//! without git: listed when the turn starts and again when it ends, so a file the agent changed
//! that no step named is still found. Bounded: `.gitignore` is honored (also outside a git
//! repository: build output stays out, as VS Code leaves it out of its changes), dependency and
//! build folders are skipped, and at most `max` files are listed.

use std::path::Path;

use ignore::WalkBuilder;
use serde::Serialize;

/// Folders never listed (dependencies, build output, caches), whatever `.gitignore` says.
const SKIPPED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    "vendor",
    ".gradle",
    ".idea",
];

/// The most files listed, whatever the caller asks.
pub const MAX_FILES: usize = 50_000;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    /// Relative to the folder, with `/`.
    pub path: String,
    pub size: u64,
    /// Modified time in ms since the epoch (0 when unknown).
    pub mtime_ms: u64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TreeStats {
    pub files: Vec<FileStat>,
    /// More files than `max`: the rest weren't listed.
    pub truncated: bool,
}

pub fn stats(root: &Path, max: usize) -> TreeStats {
    let max = max.clamp(1, MAX_FILES);
    let mut files = Vec::new();
    let mut truncated = false;
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(false)
        .require_git(false)
        .follow_links(false)
        .filter_entry(|e| {
            !(e.file_type().is_some_and(|t| t.is_dir())
                && e.file_name()
                    .to_str()
                    .is_some_and(|n| SKIPPED_DIRS.contains(&n)))
        })
        .build();
    for entry in walker.flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if files.len() >= max {
            truncated = true;
            break;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else {
            continue;
        };
        let Ok(meta) = entry.metadata() else { continue };
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis() as u64);
        files.push(FileStat {
            path: rel.to_string_lossy().replace('\\', "/"),
            size: meta.len(),
            mtime_ms,
        });
    }
    TreeStats { files, truncated }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_files_without_ignored_or_dependency_folders() {
        let root = std::env::temp_dir().join(format!("ide-tree-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::create_dir_all(root.join("gen")).unwrap();
        std::fs::write(root.join("src/a.ts"), "abc").unwrap();
        std::fs::write(root.join("node_modules/x/i.js"), "x").unwrap();
        std::fs::write(root.join("gen/out.js"), "x").unwrap();
        std::fs::write(root.join(".gitignore"), "gen/\n").unwrap();
        let out = stats(&root, 100);
        let mut paths: Vec<_> = out.files.iter().map(|f| f.path.as_str()).collect();
        paths.sort_unstable();
        assert_eq!(paths, [".gitignore", "src/a.ts"]);
        assert!(!out.truncated);
        let a = out.files.iter().find(|f| f.path == "src/a.ts").unwrap();
        assert_eq!(a.size, 3);
        assert!(a.mtime_ms > 0);
        let capped = stats(&root, 1);
        assert_eq!(capped.files.len(), 1);
        assert!(capped.truncated);
        let _ = std::fs::remove_dir_all(&root);
    }
}
