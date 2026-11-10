//! Worktrees (D139): `git worktree list --porcelain` parsed, and add / remove / prune with fixed
//! argument lists (user values are checked not to look like options).

use std::path::Path;

use serde::Serialize;

use super::run;
use crate::error::{Error, Result};

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    /// The checked-out commit (empty for a bare repository).
    pub head: String,
    /// The branch's short name, or None when detached or bare.
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
    pub locked: bool,
    /// Its folder is gone: `prune` would remove the entry.
    pub prunable: bool,
    /// The repository's main worktree (listed first by git).
    pub main: bool,
}

/// `git worktree list --porcelain` → worktrees (blank-line separated records).
pub fn parse_worktrees(out: &str) -> Vec<Worktree> {
    let mut list = Vec::new();
    for record in out.split("\n\n") {
        let mut w = Worktree::default();
        for line in record.lines() {
            let (key, value) = line.split_once(' ').unwrap_or((line, ""));
            match key {
                "worktree" => w.path = value.to_string(),
                "HEAD" => w.head = value.to_string(),
                "branch" => {
                    w.branch = Some(value.trim_start_matches("refs/heads/").to_string());
                }
                "bare" => w.bare = true,
                "detached" => w.detached = true,
                "locked" => w.locked = true,
                "prunable" => w.prunable = true,
                _ => {}
            }
        }
        if !w.path.is_empty() {
            if cfg!(windows) {
                w.path = w.path.replace('/', "\\");
            }
            w.main = list.is_empty();
            list.push(w);
        }
    }
    list
}

pub fn list(repo: &Path) -> Result<Vec<Worktree>> {
    Ok(parse_worktrees(&run(
        repo,
        &["worktree", "list", "--porcelain"],
        None,
    )?))
}

/// `op`: "add" (a new `branch` from `base`, or `base` checked out when `branch` is empty),
/// "remove", "forceRemove", "prune", "lock", "unlock".
pub fn op(repo: &Path, op: &str, path: &str, branch: &str, base: &str) -> Result<String> {
    for v in [path, branch, base] {
        if v.starts_with('-') {
            return Err(Error::Invalid(format!("not a valid value: {v}")));
        }
    }
    let need = |v: &str, what: &str| -> Result<()> {
        if v.trim().is_empty() {
            Err(Error::Invalid(format!("{what} is missing")))
        } else {
            Ok(())
        }
    };
    let mut args = vec!["worktree"];
    match op {
        "add" => {
            need(path, "the folder")?;
            args.push("add");
            if branch.is_empty() {
                need(base, "the branch or commit")?;
                args.extend([path, base]);
            } else {
                args.extend(["-b", branch, path]);
                if !base.is_empty() {
                    args.push(base);
                }
            }
        }
        "remove" | "forceRemove" | "lock" | "unlock" => {
            need(path, "the worktree")?;
            args.push(if op == "lock" {
                "lock"
            } else if op == "unlock" {
                "unlock"
            } else {
                "remove"
            });
            if op == "forceRemove" {
                // Twice: also a locked worktree.
                args.extend(["--force", "--force"]);
            }
            args.push(path);
        }
        "prune" => args.push("prune"),
        _ => return Err(Error::Invalid(format!("unknown worktree operation {op}"))),
    }
    run(repo, &args, None)
}
