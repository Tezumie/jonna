//! Everything that asks git: remotes, stashes, the bundles of commits a snapshot carries,
//! the staged patch, and taking a bundle into a repository.

use std::path::{Path, PathBuf};

use super::capture::{Capture, LeaveOut};
use super::manifest::{Bundle, GitState, MAX_BUNDLE_CHAIN};
use super::paths::{rel, sync_error};
use crate::error::{Error, Result};

/// Whether an address from a snapshot may become a git remote: an ordinary https, ssh or git
/// address. Not a local path, not a transport that runs a program, not an option.
pub(in crate::sync) fn safe_remote(url: &str) -> bool {
    let url = url.trim();
    if url.starts_with('-') || url.contains("::") || url.chars().any(char::is_control) {
        return false;
    }
    let scheme = ["https://", "http://", "ssh://", "git://"]
        .iter()
        .any(|s| url.starts_with(s));
    // The short SSH form: user@host:path.
    let short = !url.contains("://") && url.contains('@') && url.contains(':');
    (scheme || short) && crate::sync::project::normalize_remote(url).is_some()
}

pub(super) fn git(root: &Path, args: &[&str]) -> Result<String> {
    crate::git::run(root, args, None)
}

pub(super) fn is_git(root: &Path) -> bool {
    root.join(".git").exists() && git(root, &["rev-parse", "--is-inside-work-tree"]).is_ok()
}

/// The stashes, newest first: (commit, message).
pub(super) fn stashes(root: &Path) -> Vec<(String, String)> {
    git(root, &["stash", "list", "--format=%H %gs"])
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let (sha, message) = line.split_once(' ')?;
            Some((sha.to_string(), message.to_string()))
        })
        .collect()
}

/// The newest stash's commit, when there is a stash.
fn stash_tip(root: &Path) -> Option<String> {
    git(root, &["rev-parse", "-q", "--verify", "refs/stash"])
        .ok()
        .map(|sha| sha.trim().to_string())
        .filter(|sha| !sha.is_empty())
}

/// Puts exactly `paths` (changed, new or deleted files) into a stash, and nothing else: what
/// the project's `.syncignore` names is never in that list, and stays in the folder as it is.
/// The new stash's commit, or None when git had nothing to save (then there is no new stash,
/// and the newest one is still the user's own).
pub(super) fn stash_paths(
    root: &Path,
    paths: &[String],
    message: Option<&str>,
) -> Result<Option<String>> {
    // A folder that is a repository of its own is listed as `name/`: git can't stash it.
    let paths: Vec<&String> = paths.iter().filter(|p| !p.ends_with('/')).collect();
    if paths.is_empty() {
        return Ok(None);
    }
    let before = stash_tip(root);
    // The names go in on stdin, taken as they are written: a list of any length (a command
    // line has a limit, a short one on Windows), and no name read as a pattern.
    let mut list = Vec::new();
    for path in paths {
        list.extend_from_slice(path.as_bytes());
        list.push(0);
    }
    let mut args = vec![
        "--literal-pathspecs",
        "stash",
        "push",
        "--include-untracked",
        "-q",
    ];
    if let Some(message) = message {
        args.extend(["-m", message]);
    }
    args.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
    crate::git::run(root, &args, Some(&list))?;
    Ok(stash_tip(root).filter(|now| before.as_ref() != Some(now)))
}

fn ref_tips(root: &Path) -> Vec<String> {
    let mut tips: Vec<String> = git(
        root,
        &[
            "for-each-ref",
            "--format=%(objectname)",
            "refs/heads",
            "refs/tags",
            "refs/stash",
        ],
    )
    .unwrap_or_default()
    .lines()
    .map(str::to_string)
    .collect();
    // Only the newest stash is a ref; the older ones are named here so a bundle carries them.
    tips.extend(stashes(root).into_iter().map(|(sha, _)| sha));
    // A commit made with no branch (a detached HEAD, the middle of a rebase) has no ref either.
    if let Ok(head) = git(root, &["rev-parse", "-q", "--verify", "HEAD"]) {
        tips.push(head.trim().to_string());
    }
    tips.sort();
    tips.dedup();
    tips
}

pub(super) fn scratch_file(data: &Path, name: &str) -> Result<PathBuf> {
    let dir = data.join("sync").join("tmp");
    std::fs::create_dir_all(&dir)?;
    // A name of its own: two snapshots at once (two windows) never share a file.
    Ok(dir.join(format!("{name}-{}", crate::sync::crypto::new_id()?)))
}

/// Which commits a snapshot's bundles carry.
#[derive(Clone, Default)]
pub(super) struct Scope {
    /// Only what the commit checked out needs: no other branch, no tag, no stash (a share).
    pub(super) head_only: bool,
    /// What is left out because a remote has it, as git's option for it: `--remotes` (any
    /// remote's), `--remotes=<name>` (one remote's). None: nothing is left out, the bundles
    /// carry the whole history.
    pub(super) not_remotes: Option<String>,
    /// Files that must not travel inside commits either (`CreateOptions::leave_out`): with
    /// `head_only`, commits that add or change one refuse the capture.
    pub(super) leave_out: Option<LeaveOut>,
}

/// The option that leaves out what the remote `name` has. None for a name git would read as
/// a pattern: nothing is left out then.
fn only_remote(name: &str) -> Option<String> {
    (!name.is_empty() && !name.contains(['*', '?', '[', '\\'])).then(|| format!("--remotes={name}"))
}

/// What a snapshot's bundles leave out because a remote has it (`Scope::not_remotes`).
/// `remote`: the name of the project's remote (`origin`, else the first). `named`: the
/// snapshot says its address. Left out only when whoever restores can get it there: a remote
/// the snapshot doesn't name (a share drops a local or `file://` one) counts as none, and
/// the bundles then carry the whole history. A share leaves out what that one remote has,
/// not what any other has: its reader clones from that one.
pub(super) fn remotes_left_out(
    remote: Option<&str>,
    named: bool,
    head_only: bool,
    everything: bool,
) -> Option<String> {
    match remote {
        Some(name) if named && !everything => {
            if head_only {
                only_remote(name)
            } else {
                Some("--remotes".into())
            }
        }
        _ => None,
    }
}

/// What the next bundle is made of: the tips it is made for, what it names (`what`) and
/// what it leaves out (`not`), as git's revision arguments.
pub(super) struct BundleRange {
    pub(super) tips: Vec<String>,
    what: Vec<String>,
    not: Vec<String>,
}

impl BundleRange {
    /// As revision arguments: `what… [--not not…]`.
    pub(super) fn args(&self) -> Vec<String> {
        let mut args = self.what.clone();
        if !self.not.is_empty() {
            args.push("--not".into());
            args.extend(self.not.iter().cloned());
        }
        args
    }
}

pub(super) fn bundle_range(root: &Path, chain: &[Bundle], scope: &Scope) -> BundleRange {
    let known = |sha: &str| git(root, &["cat-file", "-e", &format!("{sha}^{{commit}}")]).is_ok();
    let (tips, what) = if scope.head_only {
        // Only the commit checked out: what other branches and stashes hold stays here.
        let head = git(root, &["rev-parse", "-q", "--verify", "HEAD"])
            .map(|sha| sha.trim().to_string())
            .unwrap_or_default();
        (vec![head], vec!["HEAD".to_string()])
    } else {
        // Every ref but the ones an earlier restore put here (they are another computer's),
        // and the commit checked out, which may have no ref.
        let mut what: Vec<String> = vec![
            "--exclude=refs/synced/*".into(),
            "--all".into(),
            "HEAD".into(),
        ];
        // Older stashes have no ref of their own: named by commit, they go into the pack too.
        what.extend(stashes(root).into_iter().map(|(sha, _)| sha));
        (ref_tips(root), what)
    };
    let mut not: Vec<String> = Vec::new();
    if let Some(remotes) = &scope.not_remotes {
        not.push(remotes.clone());
    }
    for bundle in chain {
        for tip in &bundle.tips {
            // Only commits can be excluded (a tag may point at something else).
            if known(tip) && !not.contains(tip) {
                not.push(tip.clone());
            }
        }
    }
    BundleRange { tips, what, not }
}

/// The files `leave` names among those the commits of `range` add or change: what a bundle
/// of that range would carry of them. (A deletion carries nothing of the file.)
pub(super) fn left_out_in_commits(
    root: &Path,
    range: &BundleRange,
    leave: LeaveOut,
) -> Result<Vec<String>> {
    let mut args: Vec<String> = [
        "log",
        "--format=",
        "--name-only",
        "-z",
        "--no-renames",
        // A merge is compared with each of its parents: what only the merge itself brought in
        // is listed too.
        "-m",
        "--diff-filter=d",
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();
    args.extend(range.args());
    // (No paths may follow: a revision is never read as one.)
    args.push("--".into());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = git(root, &refs)?;
    let mut found: Vec<String> = out
        .split(['\0', '\n'])
        .map(rel)
        .filter(|path| !path.is_empty() && leave(path).is_some())
        .collect();
    found.sort();
    found.dedup();
    Ok(found)
}

/// The refusal of a share's capture whose unpushed commits hold key files.
pub(super) fn key_files_in_history(files: &[String]) -> Error {
    let shown: Vec<&str> = files.iter().take(10).map(String::as_str).collect();
    let more = match files.len() - shown.len() {
        0 => String::new(),
        n => format!(" and {n} more"),
    };
    Error::Sync(
        "ShareKeyFilesInHistory",
        format!(
            "These key files are in commits that haven't been pushed, so they would be shared: {}{more}. Push or remove them, then share again.",
            shown.join(", ")
        ),
    )
}

/// The bundles a snapshot needs: the ones before (while their commits are still here) and a
/// new one for what the refs reach now that those, and the remotes, don't have.
pub(super) async fn bundles(
    capture: &mut Capture<'_>,
    data: &Path,
    before: Option<&GitState>,
    scope: &Scope,
) -> Result<Vec<Bundle>> {
    let root = capture.root;
    let mut chain: Vec<Bundle> = before.map(|g| g.bundles.clone()).unwrap_or_default();
    // A commit an earlier bundle relied on that is gone (history rewritten and collected), or a
    // chain grown long: start again with one complete bundle.
    let known = |sha: &str| git(root, &["cat-file", "-e", &format!("{sha}^{{commit}}")]).is_ok();
    let intact = chain
        .iter()
        .flat_map(|b| b.tips.iter())
        .all(|t| known(t) || git(root, &["cat-file", "-e", t]).is_ok());
    // A share carries only what the commit checked out builds on: a bundle made while another
    // line of commits was checked out isn't part of that.
    let beside = scope.head_only
        && chain
            .iter()
            .flat_map(|b| b.tips.iter())
            .any(|tip| git(root, &["merge-base", "--is-ancestor", tip, "HEAD"]).is_err());
    if !intact || beside || chain.len() >= MAX_BUNDLE_CHAIN {
        chain.clear();
    }
    let range = bundle_range(root, &chain, scope);
    let tips = range.tips.clone();
    if chain.last().is_some_and(|b| b.tips == tips) {
        for b in &chain {
            capture.uploader.keep(&b.file);
        }
        return Ok(chain);
    }
    let revisions = range.args();
    // Asked first, in a way that doesn't depend on git's language: is there anything the
    // remotes and the earlier bundles lack?
    let mut probe: Vec<&str> = vec!["rev-list", "--max-count=1"];
    probe.extend(revisions.iter().map(String::as_str));
    if git(root, &probe).is_ok_and(|out| out.trim().is_empty()) {
        for b in &chain {
            capture.uploader.keep(&b.file);
        }
        return Ok(chain);
    }
    // A share: the commits about to travel are looked through first. A key file committed
    // and not pushed would go out inside them, whatever is left out of the files.
    if let (true, Some(leave)) = (scope.head_only, scope.leave_out) {
        let found = left_out_in_commits(root, &range, leave)?;
        if !found.is_empty() {
            return Err(key_files_in_history(&found));
        }
    }
    let file = scratch_file(data, "bundle")?;
    let mut args: Vec<String> = vec![
        "bundle".into(),
        "create".into(),
        file.to_string_lossy().to_string(),
    ];
    args.extend(revisions);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let made = git(root, &refs);
    let result = match made {
        Ok(_) => {
            let path = file.clone();
            let bytes = tokio::task::spawn_blocking(move || std::fs::read(path))
                .await
                .map_err(|e| sync_error(e.to_string()))??;
            let stored = capture.uploader.add(&bytes).await?;
            chain.push(Bundle { file: stored, tips });
            Ok(())
        }
        // Nothing the remotes and earlier bundles lack: no new bundle.
        Err(Error::Git(message)) if message.contains("empty bundle") => Ok(()),
        Err(e) => Err(e),
    };
    let _ = std::fs::remove_file(&file);
    result?;
    for b in &chain {
        capture.uploader.keep(&b.file);
    }
    Ok(chain)
}

/// What is staged, as a patch against the commit, without the files `leave_out` names: a key
/// file that was staged must not travel inside the patch either.
pub(super) fn staged_patch(root: &Path, leave_out: Option<LeaveOut>) -> Result<String> {
    let mut args: Vec<String> = [
        "diff",
        "--cached",
        "--binary",
        "--full-index",
        "--no-renames",
    ]
    .iter()
    .map(|a| a.to_string())
    .collect();
    if let Some(leave) = leave_out {
        let names = git(
            root,
            &["diff", "--cached", "--name-only", "-z", "--no-renames"],
        )?;
        let out: Vec<String> = names
            .split('\0')
            .filter(|p| !p.is_empty() && leave(&rel(p)).is_some())
            // From the top of the repository, taken as written (never as a pattern).
            .map(|p| format!(":(top,exclude,literal){p}"))
            .collect();
        if !out.is_empty() {
            args.push("--".into());
            args.push(":(top)".into());
            args.extend(out);
        }
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    git(root, &refs)
}

/// Takes a bundle's commits into the repository: its objects, then its refs under a
/// namespace of their own (nothing of this computer's refs is moved by it).
pub(super) fn take_bundle(root: &Path, file: &Path) -> Result<()> {
    let file = file.to_string_lossy();
    // The objects first, whatever the bundle's refs are called: a bundle made for a share
    // names only `HEAD`, which the fetch below (of `refs/*`) wouldn't ask for.
    git(root, &["bundle", "unbundle", &file])?;
    git(
        root,
        &["fetch", "-q", "--no-tags", &file, "+refs/*:refs/synced/*"],
    )?;
    Ok(())
}
