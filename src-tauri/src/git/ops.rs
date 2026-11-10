//! Git operations. Paths are relative to the repository root (`/` separators, as git prints them).

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;

use super::status::{parse_status, GitStatus};
use super::{command, run};
use crate::error::{Error, Result};

pub fn status(repo: &Path) -> Result<GitStatus> {
    let out = run(
        repo,
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=all",
        ],
        None,
    )?;
    Ok(parse_status(&out))
}

/// File text at `HEAD` (`rev = "HEAD"`) or in the index (`rev = ""`), in working-tree form
/// (smudge filters and line-ending conversion applied, like a checkout). None if absent there.
pub fn show(repo: &Path, rev: &str, path: &str) -> Result<Option<String>> {
    let spec = format!("{rev}:{path}");
    match run(repo, &["cat-file", "--filters", &spec], None) {
        Ok(text) => Ok(Some(text)),
        Err(Error::Git(_)) => Ok(None), // not in that revision (new file, no commits yet…)
        Err(e) => Err(e),
    }
}

/// The default branch to compare with (D200): the remote's HEAD (origin/main), else a local
/// `main` or `master`. None when there's none, or HEAD is on it.
pub fn default_branch(repo: &Path) -> Option<String> {
    let from_remote = run(
        repo,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
        None,
    )
    .ok()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty());
    from_remote.or_else(|| {
        ["main", "master"].iter().find_map(|b| {
            run(
                repo,
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{b}"),
                ],
                None,
            )
            .ok()
            .map(|_| (*b).to_string())
        })
    })
}

/// The commit HEAD branched from the default branch (`git merge-base HEAD <default>`): what a
/// pull request's diff starts from (D200). None without a default branch.
pub fn merge_base(repo: &Path) -> Result<Option<String>> {
    let Some(branch) = default_branch(repo) else {
        return Ok(None);
    };
    match run(repo, &["merge-base", "HEAD", &branch], None) {
        Ok(hash) => Ok(Some(hash.trim().to_string()).filter(|h| !h.is_empty())),
        Err(Error::Git(_)) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Replaces the index entry of `path` with `text` (working-tree form; clean filters and
/// line-ending conversion apply as for `git add`). Keeps the entry's mode. This is how hunks are
/// staged and unstaged: the caller computes the new index text from a line diff.
pub fn write_index(repo: &Path, path: &str, text: &str) -> Result<()> {
    let oid = run(
        repo,
        &["hash-object", "-w", "--stdin", "--path", path],
        Some(text.as_bytes()),
    )?;
    let oid = oid.trim();
    let staged = run(repo, &["ls-files", "-s", "--", path], None)?;
    let mode = staged
        .split_whitespace()
        .next()
        .filter(|m| m.len() == 6)
        .unwrap_or("100644");
    let info = format!("{mode},{oid},{path}");
    run(repo, &["update-index", "--add", "--cacheinfo", &info], None).map(|_| ())
}

fn with_paths<'a>(mut args: Vec<&'a str>, paths: &'a [String]) -> Vec<&'a str> {
    args.push("--");
    args.extend(paths.iter().map(String::as_str));
    args
}

pub fn stage(repo: &Path, paths: &[String]) -> Result<()> {
    run(repo, &with_paths(vec!["add", "-A"], paths), None).map(|_| ())
}

fn has_head(repo: &Path) -> bool {
    run(repo, &["rev-parse", "--verify", "-q", "HEAD"], None).is_ok()
}

pub fn unstage(repo: &Path, paths: &[String]) -> Result<()> {
    let args = if has_head(repo) {
        with_paths(vec!["restore", "--staged"], paths)
    } else {
        with_paths(vec!["rm", "--cached", "-r", "-q"], paths)
    };
    run(repo, &args, None).map(|_| ())
}

/// Throws away working-tree changes: tracked files are restored, untracked ones deleted.
pub fn discard(repo: &Path, tracked: &[String], untracked: &[String]) -> Result<()> {
    if !tracked.is_empty() {
        run(
            repo,
            &with_paths(vec!["restore", "--worktree"], tracked),
            None,
        )?;
    }
    if !untracked.is_empty() {
        run(
            repo,
            &with_paths(vec!["clean", "-f", "-q"], untracked),
            None,
        )?;
    }
    Ok(())
}

/// Commits the index (or everything tracked with `all`); the message goes in on stdin.
/// How a commit is signed (D200): `sign` adds `-S` (git.enableCommitSigning; git's own
/// commit.gpgsign also works without it), `signoff` adds a Signed-off-by line (git.alwaysSignOff).
#[derive(Debug, Clone, Copy, Default)]
pub struct CommitSigning {
    pub sign: bool,
    pub signoff: bool,
}

pub fn commit(
    repo: &Path,
    message: &str,
    amend: bool,
    all: bool,
    signing: CommitSigning,
) -> Result<String> {
    let mut args = vec!["commit", "-F", "-"];
    if amend {
        args.push("--amend");
    }
    if all {
        args.push("-a");
    }
    if signing.sign {
        args.push("-S");
    }
    if signing.signoff {
        args.push("--signoff");
    }
    run(repo, &args, Some(message.as_bytes()))?;
    Ok(run(repo, &["rev-parse", "--short", "HEAD"], None)?
        .trim()
        .to_string())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub remote: bool,
    pub current: bool,
    pub upstream: Option<String>,
    pub commit: String,
    pub subject: String,
}

pub fn branches(repo: &Path) -> Result<Vec<Branch>> {
    let format =
        "%(refname)%00%(HEAD)%00%(upstream:short)%00%(objectname:short)%00%(contents:subject)";
    let out = run(
        repo,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            &format!("--format={format}"),
            "refs/heads",
            "refs/remotes",
        ],
        None,
    )?;
    Ok(out
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\0').collect();
            let refname = *f.first()?;
            let (name, remote) = if let Some(n) = refname.strip_prefix("refs/heads/") {
                (n, false)
            } else {
                (refname.strip_prefix("refs/remotes/")?, true)
            };
            if remote && name.ends_with("/HEAD") {
                return None;
            }
            Some(Branch {
                name: name.into(),
                remote,
                current: f.get(1) == Some(&"*"),
                upstream: f.get(2).filter(|u| !u.is_empty()).map(|u| (*u).into()),
                commit: f.get(3).copied().unwrap_or_default().into(),
                subject: f.get(4).copied().unwrap_or_default().into(),
            })
        })
        .collect())
}

/// Switches branch; `create` makes a new one; a remote branch ("origin/x") gets a tracking branch.
pub fn checkout(repo: &Path, name: &str, create: bool, remote: bool) -> Result<()> {
    let args: Vec<&str> = if create {
        vec!["switch", "-c", name]
    } else if remote {
        vec!["switch", "--track", name]
    } else {
        vec!["switch", name]
    };
    run(repo, &args, None).map(|_| ())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub author: String,
    pub email: String,
    /// Seconds since the epoch.
    pub time: i64,
    pub subject: String,
    /// Parent hashes (two or more for a merge).
    pub parents: Vec<String>,
    /// Branches and tags pointing here ("HEAD -> main", "origin/main", "tag: v1").
    pub refs: Vec<String>,
}

/// Commits newest first: of HEAD, or of `range` ("HEAD..@{u}" for incoming ones), optionally only
/// those touching `path`.
pub fn log(repo: &Path, limit: u32, path: Option<&str>) -> Result<Vec<Commit>> {
    log_range(repo, limit, None, path)
}

pub fn log_range(
    repo: &Path,
    limit: u32,
    range: Option<&str>,
    path: Option<&str>,
) -> Result<Vec<Commit>> {
    let mut args = Vec::new();
    if let Some(r) = range {
        args.push(r);
    }
    if let Some(p) = path {
        args.extend(["--", p]);
    }
    log_with(repo, limit, &args)
}

/// Commits for the graph, children before parents (`--date-order`): HEAD and its upstream, or
/// every branch, tag and remote branch with `all`.
pub fn log_graph(repo: &Path, limit: u32, all: bool) -> Result<Vec<Commit>> {
    let upstream = run(repo, &["rev-parse", "--verify", "-q", "@{u}"], None).is_ok();
    // VS Code's "Auto" (D220): the current branch, its upstream and the base branch (the
    // default branch the Graph colors orange), so a feature branch shows where it left main.
    let base = if all {
        None
    } else {
        default_branch(repo).filter(|b| !b.starts_with('-'))
    };
    let mut args = vec!["--date-order"];
    if all {
        args.push("--all");
    } else {
        args.push("HEAD");
        if upstream {
            args.push("@{u}");
        }
        if let Some(b) = base.as_deref() {
            args.push(b);
        }
    }
    log_with(repo, limit, &args)
}

pub(crate) fn log_with(repo: &Path, limit: u32, extra: &[&str]) -> Result<Vec<Commit>> {
    let n = limit.to_string();
    let mut args = vec![
        "log",
        "-n",
        &n,
        "--format=%H%x00%an%x00%ae%x00%at%x00%s%x00%P%x00%D%x1e",
    ];
    args.extend_from_slice(extra);
    let out = match run(repo, &args, None) {
        Ok(out) => out,
        Err(Error::Git(m)) if m.contains("does not have any commits") => String::new(),
        Err(e) => return Err(e),
    };
    Ok(out
        .split('\x1e')
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').split('\0').collect();
            Some(Commit {
                hash: (*f.first()?).into(),
                author: (*f.get(1)?).into(),
                email: (*f.get(2)?).into(),
                time: f.get(3)?.parse().ok()?,
                subject: (*f.get(4)?).into(),
                parents: f
                    .get(5)
                    .map(|p| p.split_whitespace().map(String::from).collect())
                    .unwrap_or_default(),
                refs: f
                    .get(6)
                    .map(|r| {
                        r.split(", ")
                            .map(str::trim)
                            .filter(|x| !x.is_empty())
                            .map(String::from)
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect())
}

/// A file a commit changed: its status letter (A, M, D, R, C, T) and paths.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub status: String,
    pub path: String,
    pub orig_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub hash: String,
    /// The first parent (what the diff is against); null for a root commit.
    pub parent: Option<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    /// The whole message.
    pub message: String,
    pub files: Vec<ChangedFile>,
    /// Lines added and removed (text files; binary ones count as files only).
    pub insertions: u64,
    pub deletions: u64,
}

/// `git diff-tree --shortstat` → (insertions, deletions). "3 files changed, 10 insertions(+),
/// 2 deletions(-)"; either part may be missing.
pub fn parse_shortstat(out: &str) -> (u64, u64) {
    let mut ins = 0;
    let mut del = 0;
    for part in out.split(',') {
        let part = part.trim();
        let n = part
            .split_whitespace()
            .next()
            .and_then(|n| n.parse::<u64>().ok())
            .unwrap_or(0);
        if part.contains("insertion") {
            ins = n;
        } else if part.contains("deletion") {
            del = n;
        }
    }
    (ins, del)
}

/// `git diff-tree --name-status -z` output → files (renames and copies carry both paths).
pub fn parse_name_status(out: &str) -> Vec<ChangedFile> {
    let mut parts = out.split('\0').filter(|p| !p.is_empty());
    let mut files = Vec::new();
    while let Some(code) = parts.next() {
        let letter = code.chars().next().unwrap_or('M');
        let Some(first) = parts.next() else { break };
        if letter == 'R' || letter == 'C' {
            let Some(second) = parts.next() else { break };
            files.push(ChangedFile {
                status: letter.to_string(),
                path: second.into(),
                orig_path: Some(first.into()),
            });
        } else {
            files.push(ChangedFile {
                status: letter.to_string(),
                path: first.into(),
                orig_path: None,
            });
        }
    }
    files
}

/// One commit: its message, first parent and the files it changed (against that parent).
pub fn commit_detail(repo: &Path, rev: &str) -> Result<CommitDetail> {
    let head = run(
        repo,
        &[
            "log",
            "-1",
            "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%B",
            rev,
            "--",
        ],
        None,
    )?;
    let f: Vec<&str> = head.splitn(6, '\0').collect();
    let hash = f.first().copied().unwrap_or_default().trim().to_string();
    if hash.is_empty() {
        return Err(Error::Git(format!("no commit {rev}")));
    }
    let parent = f
        .get(1)
        .and_then(|p| p.split_whitespace().next())
        .map(String::from);
    let names = match &parent {
        Some(p) => run(
            repo,
            &["diff-tree", "-r", "-M", "--name-status", "-z", p, &hash],
            None,
        )?,
        None => run(
            repo,
            &[
                "diff-tree",
                "-r",
                "--root",
                "--no-commit-id",
                "--name-status",
                "-z",
                &hash,
            ],
            None,
        )?,
    };
    // Line counts; a failure (an odd object) just leaves them at zero.
    let stat = match &parent {
        Some(p) => run(
            repo,
            &["diff-tree", "-r", "-M", "--shortstat", p, &hash],
            None,
        ),
        None => run(
            repo,
            &[
                "diff-tree",
                "-r",
                "--root",
                "--no-commit-id",
                "--shortstat",
                &hash,
            ],
            None,
        ),
    }
    .unwrap_or_default();
    let (insertions, deletions) = parse_shortstat(&stat);
    Ok(CommitDetail {
        insertions,
        deletions,
        hash,
        parent,
        author: f.get(2).copied().unwrap_or_default().into(),
        email: f.get(3).copied().unwrap_or_default().into(),
        time: f.get(4).and_then(|t| t.parse().ok()).unwrap_or(0),
        message: f.get(5).copied().unwrap_or_default().trim_end().into(),
        files: parse_name_status(&names),
    })
}

/// Repository operations with fixed argument lists (branch, merge, rebase, tag, remote, undo…).
/// `name` and `target` are user input: they're checked not to look like options.
pub fn repo_op(repo: &Path, op: &str, name: &str, target: &str) -> Result<String> {
    for v in [name, target] {
        if v.starts_with('-') {
            return Err(Error::Invalid(format!("not a valid name: {v}")));
        }
    }
    let need = |v: &str, what: &str| -> Result<()> {
        if v.trim().is_empty() {
            Err(Error::Invalid(format!("{what} is missing")))
        } else {
            Ok(())
        }
    };
    let args: Vec<&str> = match op {
        "deleteBranch" => {
            need(name, "the branch")?;
            vec!["branch", "-d", name]
        }
        "forceDeleteBranch" => {
            need(name, "the branch")?;
            vec!["branch", "-D", name]
        }
        "renameBranch" => {
            need(target, "the new name")?;
            if name.is_empty() {
                vec!["branch", "-m", target]
            } else {
                vec!["branch", "-m", name, target]
            }
        }
        "createBranchFrom" => {
            need(name, "the branch")?;
            need(target, "the start point")?;
            vec!["switch", "-c", name, target]
        }
        "merge" => {
            need(name, "the branch")?;
            vec!["merge", "--no-edit", name]
        }
        "mergeAbort" => vec!["merge", "--abort"],
        // Conflicts resolved and staged: the merge commit with git's prepared message.
        "mergeContinue" => vec!["commit", "--no-edit"],
        "rebase" => {
            need(name, "the branch")?;
            vec!["rebase", name]
        }
        "rebaseAbort" => vec!["rebase", "--abort"],
        "rebaseContinue" => vec!["rebase", "--continue"],
        "cherryPick" => {
            need(name, "the commit")?;
            vec!["cherry-pick", name]
        }
        "cherryPickAbort" => vec!["cherry-pick", "--abort"],
        "cherryPickContinue" => vec!["cherry-pick", "--continue"],
        "revertAbort" => vec!["revert", "--abort"],
        "revertContinue" => vec!["revert", "--continue"],
        "revertCommit" => {
            need(name, "the commit")?;
            vec!["revert", "--no-edit", name]
        }
        "tag" => {
            need(name, "the tag")?;
            if target.is_empty() {
                vec!["tag", name]
            } else {
                vec!["tag", "-a", name, "-m", target]
            }
        }
        "deleteTag" => {
            need(name, "the tag")?;
            vec!["tag", "-d", name]
        }
        "undoCommit" => vec!["reset", "--soft", "HEAD~1"],
        "addRemote" => {
            need(name, "the remote's name")?;
            need(target, "the remote's URL")?;
            vec!["remote", "add", name, target]
        }
        "removeRemote" => {
            need(name, "the remote")?;
            vec!["remote", "remove", name]
        }
        "checkoutDetached" => {
            need(name, "the commit")?;
            vec!["switch", "--detach", name]
        }
        _ => return Err(Error::Invalid(format!("unknown git operation {op}"))),
    };
    run(repo, &args, None)
}

/// Remote names (`git remote`).
pub fn remotes(repo: &Path) -> Result<Vec<String>> {
    Ok(run(repo, &["remote"], None)?
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect())
}

/// Each remote's fetch URL, as `git remote -v` lists them.
pub fn remote_urls(repo: &Path) -> Result<Vec<RemoteUrl>> {
    Ok(parse_remote_urls(&run(repo, &["remote", "-v"], None)?))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemoteUrl {
    pub name: String,
    pub url: String,
}

/// `origin\thttps://github.com/a/b.git (fetch)` lines → one entry per remote.
pub fn parse_remote_urls(out: &str) -> Vec<RemoteUrl> {
    let mut list: Vec<RemoteUrl> = Vec::new();
    for line in out.lines() {
        let mut parts = line.split_whitespace();
        let (Some(name), Some(url)) = (parts.next(), parts.next()) else {
            continue;
        };
        if parts.next() == Some("(push)") && list.iter().any(|r| r.name == name) {
            continue;
        }
        if !list.iter().any(|r| r.name == name) {
            list.push(RemoteUrl {
                name: name.into(),
                url: url.into(),
            });
        }
    }
    list
}

/// Tags, newest first.
pub fn tags(repo: &Path) -> Result<Vec<String>> {
    Ok(run(repo, &["tag", "--sort=-creatordate"], None)?
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect())
}

/// The staged diff (or, with `staged` false, the working tree's against the index), at most
/// `max` bytes; for writing commit messages.
pub fn diff_text(repo: &Path, staged: bool, max: usize) -> Result<String> {
    let mut args = vec!["diff", "--no-color", "--no-ext-diff"];
    if staged {
        args.push("--cached");
    }
    let mut out = run(repo, &args, None)?;
    if out.len() > max {
        let mut cut = max;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        out.push_str("\n… (diff truncated)\n");
    }
    Ok(out)
}

/// The diff of a revision range ("main...feature", "HEAD" for everything uncommitted), cut at
/// `max` bytes (D193: reviews and pull request descriptions). Ranges are refs, never options.
pub fn diff_range(repo: &Path, range: &str, max: usize) -> Result<String> {
    let range = range.trim();
    if range.is_empty()
        || range.starts_with('-')
        || range.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(Error::Invalid(format!("not a revision range: {range}")));
    }
    let mut out = run(
        repo,
        &["diff", "--no-color", "--no-ext-diff", range, "--"],
        None,
    )?;
    if out.len() > max {
        let mut cut = max;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        out.push_str("\n… (diff truncated)\n");
    }
    Ok(out)
}

/// What the repository is in the middle of: "merge", "rebase", "cherryPick", "revert" or none.
pub fn operation(git_dir: &Path) -> Option<&'static str> {
    // A remote window's git directory is asked there (D252).
    use crate::remote::{is_dir, is_file};
    if is_dir(&git_dir.join("rebase-merge")) || is_dir(&git_dir.join("rebase-apply")) {
        Some("rebase")
    } else if is_file(&git_dir.join("MERGE_HEAD")) {
        Some("merge")
    } else if is_file(&git_dir.join("CHERRY_PICK_HEAD")) {
        Some("cherryPick")
    } else if is_file(&git_dir.join("REVERT_HEAD")) {
        Some("revert")
    } else {
        None
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    /// 0 for stash@{0}.
    pub index: u32,
    /// "On main: message" / "WIP on main: abc123 subject".
    pub message: String,
    /// Seconds since the epoch.
    pub time: i64,
}

/// The stash list, newest first.
pub fn stash_list(repo: &Path) -> Result<Vec<Stash>> {
    let out = run(repo, &["stash", "list", "--format=%gd%x00%ct%x00%gs"], None)?;
    Ok(parse_stash_list(&out))
}

pub fn parse_stash_list(out: &str) -> Vec<Stash> {
    out.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\0').collect();
            let index = f
                .first()?
                .strip_prefix("stash@{")?
                .strip_suffix('}')?
                .parse()
                .ok()?;
            Some(Stash {
                index,
                time: f.get(1)?.parse().ok()?,
                message: (*f.get(2)?).into(),
            })
        })
        .collect()
}

#[derive(Debug, Clone, Copy, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StashOp {
    Push,
    Apply,
    Pop,
    Drop,
}

/// `git stash push [-u] [-m message]`, or apply / pop / drop of `stash@{index}`.
pub fn stash(
    repo: &Path,
    op: StashOp,
    index: u32,
    message: Option<&str>,
    untracked: bool,
) -> Result<()> {
    let at = format!("stash@{{{index}}}");
    let mut args: Vec<&str> = match op {
        StashOp::Push => vec!["stash", "push"],
        StashOp::Apply => vec!["stash", "apply", "--index", &at],
        StashOp::Pop => vec!["stash", "pop", "--index", &at],
        StashOp::Drop => vec!["stash", "drop", &at],
    };
    if op == StashOp::Push {
        if untracked {
            args.push("--include-untracked");
        }
        if let Some(m) = message.filter(|m| !m.trim().is_empty()) {
            args.extend(["-m", m]);
        }
    }
    run(repo, &args, None).map(|_| ())
}

pub fn init(dir: &Path) -> Result<()> {
    run(dir, &["init", "-q"], None).map(|_| ())
}

/// fetch / pull / push with `--progress`; each output line (stderr and stdout, `\r` splits
/// progress updates) goes to `line`. Returns Ok on exit status 0.
pub fn remote_op<F: FnMut(&str)>(repo: &Path, args: &[&str], mut line: F) -> Result<()> {
    // Checked and settled like `run` (D407): `push -u` records the upstream it sets, so publishing
    // a branch doesn't pause the repository on the user's own action.
    let local = crate::remote::of_dir(repo).is_none() && crate::wsl::of_dir(repo).is_none();
    if local {
        super::guard::check(repo)?;
    }
    let result = remote_op_unchecked(repo, args, &mut line);
    if local {
        super::guard::settle(repo, args);
    }
    result
}

fn remote_op_unchecked<F: FnMut(&str)>(repo: &Path, args: &[&str], line: &mut F) -> Result<()> {
    let mut cmd = command(repo);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Error::GitMissing
        } else {
            Error::Io(e)
        }
    })?;
    // Both pipes are drained at once: reading one to EOF before the other deadlocks when git
    // fills the other pipe (a big `pull` diffstat on stdout while stderr is still open). stdout
    // lines are collected on a thread and reported after the progress lines.
    let stdout_reader = child.stdout.take().map(|out| {
        std::thread::spawn(move || {
            BufReader::new(out)
                .lines()
                .map_while(std::result::Result::ok)
                .filter(|l| !l.trim().is_empty())
                .collect::<Vec<String>>()
        })
    });
    let mut last = String::new();
    if let Some(err) = child.stderr.take() {
        let mut reader = BufReader::new(err);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            // Progress lines end with \r; read until \n but split on \r too.
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    for part in String::from_utf8_lossy(&buf).split(['\r', '\n']) {
                        if !part.trim().is_empty() {
                            line(part);
                            last = part.to_string();
                        }
                    }
                }
            }
        }
    }
    if let Some(reader) = stdout_reader {
        for l in reader.join().unwrap_or_default() {
            line(&l);
        }
    }
    let status = child.wait()?;
    if status.success() {
        Ok(())
    } else {
        Err(Error::Git(if last.is_empty() {
            format!("git {} failed", args.first().unwrap_or(&""))
        } else {
            last
        }))
    }
}

/// Who last changed a line (`git blame --porcelain`), for the status bar's blame (D120).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    /// Full hash; all zeros for a line not committed yet.
    pub hash: String,
    pub author: String,
    pub author_mail: String,
    /// Seconds since the Unix epoch.
    pub time: i64,
    pub summary: String,
    pub committed: bool,
}

/// Blame of 1-based `line` of `rel`; `contents` is the editor's text (unsaved edits included),
/// fed as `--contents -` so the line numbers match what's shown.
pub fn blame_line(repo: &Path, rel: &str, line: u32, contents: Option<&str>) -> Result<BlameLine> {
    let range = format!("{line},{line}");
    let mut args = vec!["blame", "--porcelain", "-L", &range];
    if contents.is_some() {
        args.extend(["--contents", "-"]);
    }
    args.extend(["--", rel]);
    let out = run(repo, &args, contents.map(str::as_bytes))?;
    parse_blame(&out).ok_or_else(|| Error::Git("no blame for this line".into()))
}

pub fn parse_blame(porcelain: &str) -> Option<BlameLine> {
    let mut lines = porcelain.lines();
    let hash = lines.next()?.split_whitespace().next()?.to_string();
    let mut b = BlameLine {
        committed: !hash.chars().all(|c| c == '0'),
        hash,
        author: String::new(),
        author_mail: String::new(),
        time: 0,
        summary: String::new(),
    };
    for l in lines {
        if l.starts_with('\t') {
            break;
        }
        let (key, value) = l.split_once(' ').unwrap_or((l, ""));
        match key {
            "author" => b.author = value.to_string(),
            "author-mail" => b.author_mail = value.trim_matches(['<', '>']).to_string(),
            "author-time" => b.time = value.parse().unwrap_or(0),
            "summary" => b.summary = value.to_string(),
            _ => {}
        }
    }
    Some(b)
}

/// The folder name `git clone <url>` makes: the last path part without `.git`.
pub fn clone_dir_name(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches(['/', '\\']);
    let last = trimmed.rsplit(['/', '\\', ':']).next()?;
    let name = last.strip_suffix(".git").unwrap_or(last);
    (!name.is_empty() && name != "." && name != "..").then(|| name.to_string())
}

/// `git clone --progress -- <url> <dir>` into `parent`; progress lines go to `line`. Returns the
/// new folder. The URL can't start with `-` (it would be read as an option).
pub fn clone<F: FnMut(&str)>(parent: &Path, url: &str, line: F) -> Result<PathBuf> {
    let url = url.trim();
    if url.is_empty() || url.starts_with('-') {
        return Err(Error::Invalid("That isn't a repository URL.".into()));
    }
    let name =
        clone_dir_name(url).ok_or_else(|| Error::Invalid("That isn't a repository URL.".into()))?;
    let dest = parent.join(&name);
    if dest.exists() {
        return Err(Error::Git(format!(
            "{} already exists in that folder.",
            name
        )));
    }
    remote_op(parent, &["clone", "--progress", "--", url, &name], line)?;
    Ok(dest)
}
