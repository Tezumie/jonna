//! Worktree agents' setup and comparison (D204), run from the main window on a worktree of the
//! open repository (and only on one: the path must be one of `git worktree list`'s, not the main
//! one). Setup copies files git doesn't track (`.env`…) from the main folder and runs the
//! project's setup script there; comparing gives each worktree's changes against the commit it
//! started from (committed or not, new files included); "apply this one" brings those changes
//! into the main folder with `git apply --3way`, staged for review.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::error::{Error, Result};
use crate::git;

/// `path` if it's a linked worktree of the repository at `root` (canonical), else an error.
pub fn check(root: &Path, path: &str) -> Result<PathBuf> {
    // Not looked at when it's a network path and the repository isn't on one (D161).
    if crate::fs::is_unc(path) && !crate::fs::is_unc(&root.to_string_lossy()) {
        return Err(Error::Invalid(format!("no worktree folder {path}")));
    }
    let wanted = std::fs::canonicalize(path)
        .map_err(|_| Error::Invalid(format!("no worktree folder {path}")))?;
    let list = git::worktree::list(root)?;
    let found = list.iter().any(|w| {
        !w.main
            && std::fs::canonicalize(&w.path)
                .map(|p| p == wanted)
                .unwrap_or(false)
    });
    if !found {
        return Err(Error::Invalid(format!(
            "{path} isn't a worktree of this repository"
        )));
    }
    Ok(wanted)
}

/// A relative path with no `..`, root or drive (what may be copied).
fn plain_relative(rel: &str) -> Option<PathBuf> {
    let p = Path::new(rel);
    if rel.is_empty() || p.is_absolute() {
        return None;
    }
    p.components()
        .all(|c| matches!(c, Component::Normal(_)))
        .then(|| p.to_path_buf())
}

/// `*` and `?` in one path segment.
fn segment_matches(pattern: &str, name: &str) -> bool {
    fn go(p: &[char], n: &[char]) -> bool {
        match (p.first(), n.first()) {
            (None, None) => true,
            (Some('*'), _) => go(&p[1..], n) || (!n.is_empty() && go(p, &n[1..])),
            (Some('?'), Some(_)) => go(&p[1..], &n[1..]),
            (Some(a), Some(b)) => a == b && go(&p[1..], &n[1..]),
            _ => false,
        }
    }
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    go(&p, &n)
}

/// The files `patterns` name under `root` (a `*` only in the last segment): relative paths.
pub fn expand(root: &Path, patterns: &[String]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for pattern in patterns {
        let pattern = pattern.replace('\\', "/");
        let Some(rel) = plain_relative(pattern.trim_matches('/')) else {
            continue;
        };
        let name = rel
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        let parent = rel.parent().map(Path::to_path_buf).unwrap_or_default();
        if parent.to_string_lossy().contains(['*', '?']) {
            continue;
        }
        if name.contains(['*', '?']) {
            let Ok(entries) = std::fs::read_dir(root.join(&parent)) else {
                continue;
            };
            for entry in entries.flatten() {
                let file = entry.file_name().to_string_lossy().to_string();
                if segment_matches(&name, &file) {
                    out.push(parent.join(file));
                }
            }
        } else {
            out.push(rel);
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Copies the files `patterns` name from `root` into `worktree` (regular files only; one already
/// there is kept). The relative paths copied.
pub fn copy_files(root: &Path, worktree: &Path, patterns: &[String]) -> Result<Vec<String>> {
    let mut copied = Vec::new();
    let root = std::fs::canonicalize(root)?;
    let worktree = std::fs::canonicalize(worktree)?;
    for rel in expand(&root, patterns) {
        let from = root.join(&rel);
        let to = worktree.join(&rel);
        let Ok(meta) = std::fs::symlink_metadata(&from) else {
            continue;
        };
        // A regular file really inside the main folder (no symlinked folder on the way).
        if !meta.is_file() || !std::fs::canonicalize(&from).is_ok_and(|f| f.starts_with(&root)) {
            continue;
        }
        // Anything already there is kept, a dangling symlink too (copying would write through it).
        if std::fs::symlink_metadata(&to).is_ok() {
            continue;
        }
        // The folders on the way in the worktree: real folders only (a symlinked one, tracked
        // in the repository, would lead the copy out of it); missing ones are made.
        if !real_folders_to(&worktree, rel.parent().unwrap_or(Path::new("")))? {
            continue;
        }
        std::fs::copy(&from, &to)?;
        copied.push(rel.to_string_lossy().replace('\\', "/"));
    }
    Ok(copied)
}

/// Makes the folders of `rel` under `base` one at a time; false when one there is a symlink or
/// not a folder.
fn real_folders_to(base: &Path, rel: &Path) -> Result<bool> {
    let mut at = base.to_path_buf();
    for part in rel.components() {
        at.push(part);
        match std::fs::symlink_metadata(&at) {
            Ok(m) if m.is_dir() => {}
            Ok(_) => return Ok(false),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => std::fs::create_dir(&at)?,
            Err(e) => return Err(e.into()),
        }
    }
    Ok(true)
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// None for a binary file.
    pub added: Option<u64>,
    pub removed: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDiff {
    pub files: Vec<FileChange>,
    pub text: String,
    pub truncated: bool,
}

/// `git diff --numstat` lines → changes.
pub fn parse_numstat(out: &str) -> Vec<FileChange> {
    out.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let added = parts.next()?;
            let removed = parts.next()?;
            let path = parts.next()?.to_string();
            Some(FileChange {
                path,
                added: added.parse().ok(),
                removed: removed.parse().ok(),
            })
        })
        .collect()
}

/// New files git doesn't track yet count as changes (intent-to-add: only the index learns
/// their names, nothing is staged).
fn include_new_files(worktree: &Path) {
    let _ = git::run(
        worktree,
        &["add", "--intent-to-add", "--all", "--", "."],
        None,
    );
}

/// The worktree's changes against `base` (a commit), committed or not, new files included.
pub fn diff(worktree: &Path, base: &str, max: usize) -> Result<WorktreeDiff> {
    if base.starts_with('-') {
        return Err(Error::Invalid(format!("not a commit: {base}")));
    }
    include_new_files(worktree);
    let numstat = git::run(worktree, &["diff", "--numstat", base, "--"], None)?;
    let mut text = git::run(worktree, &["diff", base, "--"], None)?;
    let truncated = text.len() > max;
    if truncated {
        let mut cut = max;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
    }
    Ok(WorktreeDiff {
        files: parse_numstat(&numstat),
        text,
        truncated,
    })
}

/// Brings the worktree's changes against `base` into `root` (git apply --3way: a change that
/// doesn't apply cleanly is merged, with conflict markers where it can't be). The files it
/// touched.
/// What "apply this one" did: the files it brought in, and those left with conflicts (D207).
#[derive(Serialize, Debug, Default)]
pub struct Applied {
    pub files: Vec<String>,
    /// Files `git apply --3way` couldn't merge cleanly: conflict markers in them and the three
    /// versions in the index, for the merge editor.
    pub conflicts: Vec<String>,
}

pub fn apply(root: &Path, worktree: &Path, base: &str) -> Result<Applied> {
    if base.starts_with('-') {
        return Err(Error::Invalid(format!("not a commit: {base}")));
    }
    include_new_files(worktree);
    let patch = git::run(worktree, &["diff", "--binary", base, "--"], None)?;
    if patch.trim().is_empty() {
        return Ok(Applied::default());
    }
    let files: Vec<String> = parse_numstat(&git::run(
        worktree,
        &["diff", "--numstat", base, "--"],
        None,
    )?)
    .into_iter()
    .map(|f| f.path)
    .collect();
    let unmerged = || -> Vec<String> {
        git::run(root, &["diff", "--name-only", "--diff-filter=U"], None)
            .map(|out| {
                out.lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    // Conflicts left from before (an earlier apply) aren't this one's.
    let before = unmerged();
    let applied = git::run(
        root,
        &["apply", "--3way", "--whitespace=nowarn"],
        Some(patch.as_bytes()),
    );
    // With conflicts git exits non-zero but has applied the rest, the conflicted files marked
    // and unmerged in the index: that's a result, not a failure.
    let after = unmerged();
    let conflicts: Vec<String> = files
        .iter()
        .filter(|f| after.contains(f) && !before.contains(f))
        .cloned()
        .collect();
    match applied {
        Ok(_) => Ok(Applied { files, conflicts }),
        Err(_) if !conflicts.is_empty() => Ok(Applied { files, conflicts }),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_and_relative_paths() {
        assert!(plain_relative("../x").is_none());
        assert!(plain_relative("/etc/passwd").is_none());
        assert!(plain_relative("a/./b").is_some());
        assert!(segment_matches("*.local.json", "app.local.json"));
        assert!(segment_matches(".env*", ".env"));
        assert!(!segment_matches("*.json", "a.jsonc"));
        assert!(segment_matches("?.txt", "a.txt"));
        assert_eq!(
            parse_numstat("3\t1\tsrc/a.ts\n-\t-\tlogo.png\n"),
            vec![
                FileChange {
                    path: "src/a.ts".into(),
                    added: Some(3),
                    removed: Some(1)
                },
                FileChange {
                    path: "logo.png".into(),
                    added: None,
                    removed: None
                },
            ]
        );
    }

    #[test]
    fn files_are_copied_into_a_worktree_and_its_changes_compared_and_applied() {
        if std::process::Command::new("git")
            .env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR)
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let base = std::env::temp_dir().join(format!("ide-wt-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("main");
        std::fs::create_dir_all(&root).unwrap();
        let g = |dir: &Path, args: &[&str]| git::run(dir, args, None).unwrap();
        g(&root, &["init", "-q", "-b", "main"]);
        g(&root, &["config", "user.email", "t@example.com"]);
        g(&root, &["config", "user.name", "T"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        std::fs::write(root.join(".gitignore"), ".env\n*.local.json\n").unwrap();
        g(&root, &["add", "."]);
        g(&root, &["commit", "-q", "-m", "init"]);
        std::fs::write(root.join(".env"), "PORT=1\n").unwrap();
        std::fs::write(root.join("x.local.json"), "{}").unwrap();
        let head = g(&root, &["rev-parse", "HEAD"]).trim().to_string();
        let wt = base.join("wt");
        g(
            &root,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "agent/x",
                wt.to_str().unwrap(),
            ],
        );
        let wt = check(&root, wt.to_str().unwrap()).unwrap();
        assert!(check(&root, root.to_str().unwrap()).is_err());
        let copied = copy_files(
            &root,
            &wt,
            &[
                ".env".into(),
                "*.local.json".into(),
                "../evil".into(),
                "nope".into(),
            ],
        )
        .unwrap();
        assert_eq!(copied, vec![".env", "x.local.json"]);
        assert_eq!(
            std::fs::read_to_string(wt.join(".env")).unwrap(),
            "PORT=1\n"
        );
        // A dangling symlink or a symlinked folder in the worktree isn't written through.
        #[cfg(unix)]
        {
            let outside = base.join("outside");
            std::fs::create_dir_all(&outside).unwrap();
            std::fs::write(root.join(".secret"), "s").unwrap();
            std::os::unix::fs::symlink(outside.join("planted"), wt.join(".secret")).unwrap();
            std::fs::create_dir_all(root.join("conf")).unwrap();
            std::fs::write(root.join("conf/a.local.json"), "{}").unwrap();
            std::os::unix::fs::symlink(&outside, wt.join("conf")).unwrap();
            let copied =
                copy_files(&root, &wt, &[".secret".into(), "conf/a.local.json".into()]).unwrap();
            assert!(copied.is_empty(), "{copied:?}");
            assert!(!outside.join("planted").exists());
            assert!(!outside.join("a.local.json").exists());
            // Nor read through a symlinked folder of the main one.
            std::fs::write(outside.join("leak.json"), "x").unwrap();
            std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
            let copied = copy_files(&root, &wt, &["linked/leak.json".into()]).unwrap();
            assert!(copied.is_empty(), "{copied:?}");
            assert!(!wt.join("linked").exists());
            std::fs::remove_file(root.join("linked")).unwrap();
            std::fs::remove_file(wt.join(".secret")).unwrap();
            std::fs::remove_file(wt.join("conf")).unwrap();
        }
        // The agent's work: one file changed, one new, uncommitted.
        std::fs::write(wt.join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(wt.join("b.txt"), "new\n").unwrap();
        let d = diff(&wt, &head, 100_000).unwrap();
        let paths: Vec<&str> = d.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["a.txt", "b.txt"]);
        assert!(d.text.contains("+two"));
        let applied = apply(&root, &wt, &head).unwrap();
        assert_eq!(applied.files, vec!["a.txt", "b.txt"]);
        assert!(applied.conflicts.is_empty());
        // The user's git may write CRLF (core.autocrlf): the lines are what's compared.
        let text = |p: &str| {
            std::fs::read_to_string(root.join(p))
                .unwrap()
                .replace("\r\n", "\n")
        };
        assert_eq!(text("a.txt"), "one\ntwo\n");
        assert_eq!(text("b.txt"), "new\n");
        assert!(diff(&wt, "--output=x", 10).is_err());
        // The main folder changed the same line meanwhile (D207): the apply reports a conflict
        // (marked, unmerged in the index for the merge editor) instead of failing.
        g(&root, &["reset", "-q", "--hard", &head]);
        let _ = std::fs::remove_file(root.join("b.txt"));
        std::fs::write(root.join("a.txt"), "uno\n").unwrap();
        g(&root, &["commit", "-q", "-am", "main side"]);
        std::fs::write(wt.join("a.txt"), "eins\n").unwrap();
        let applied = apply(&root, &wt, &head).unwrap();
        assert_eq!(applied.conflicts, vec!["a.txt"]);
        let text = std::fs::read_to_string(root.join("a.txt")).unwrap();
        assert!(text.contains("<<<<<<<") && text.contains("eins"), "{text}");
        let _ = std::fs::remove_dir_all(&base);
    }
}
