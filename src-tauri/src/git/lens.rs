//! GitLens basics (D204): a whole file's blame, a line range's history (`git log -L`), the files
//! that differ between two refs (compare branches, a stash's changes) and resolving a ref to its
//! commit. Blame and log -L come back as git's own output; the frontend parses them
//! (`extensions/git/lens.ts`, tested).

use std::path::Path;

use super::ops::{parse_name_status, ChangedFile};
use super::run;
use crate::error::{Error, Result};

/// A ref, range end or stash name as an argument: never an option.
fn check_rev(rev: &str) -> Result<()> {
    if rev.trim().is_empty() || rev.starts_with('-') || rev.contains(['\0', '\n']) {
        return Err(Error::Invalid(format!("not a revision: {rev}")));
    }
    Ok(())
}

/// `git blame --porcelain` of the whole file; `contents`: the editor's text (unsaved edits).
pub fn blame_file(repo: &Path, rel: &str, contents: Option<&str>) -> Result<String> {
    let mut args = vec!["blame", "--porcelain"];
    if contents.is_some() {
        args.extend(["--contents", "-"]);
    }
    args.extend(["--", rel]);
    run(repo, &args, contents.map(str::as_bytes))
}

/// The commits that changed lines `start..=end` (1-based) of `rel`, newest first, each
/// followed by its diff of those lines: records start with \x1e, then
/// `hash \0 parents \0 author \0 email \0 time \0 subject` and a newline.
pub fn log_lines(repo: &Path, rel: &str, start: u32, end: u32, limit: u32) -> Result<String> {
    if start == 0 || end < start {
        return Err(Error::Invalid(format!("not a line range: {start}-{end}")));
    }
    let range = format!("-L{start},{end}:{rel}");
    let limit = format!("-n{}", limit.clamp(1, 200));
    run(
        repo,
        &[
            "log",
            &limit,
            "--format=%x1e%H%x00%P%x00%an%x00%ae%x00%at%x00%s",
            &range,
        ],
        None,
    )
}

/// Files that differ from `left` to `right` (both refs); with `merge_base`, from where they
/// forked (`left...right`, what a pull request shows).
pub fn diff_names(
    repo: &Path,
    left: &str,
    right: &str,
    merge_base: bool,
) -> Result<Vec<ChangedFile>> {
    check_rev(left)?;
    check_rev(right)?;
    let out = if merge_base {
        let range = format!("{left}...{right}");
        run(
            repo,
            &["diff", "--name-status", "-z", "-M", &range, "--"],
            None,
        )?
    } else {
        run(
            repo,
            &["diff", "--name-status", "-z", "-M", left, right, "--"],
            None,
        )?
    };
    Ok(parse_name_status(&out))
}

/// Where `left` and `right` forked (`git merge-base`), full hash.
pub fn merge_base_of(repo: &Path, left: &str, right: &str) -> Result<String> {
    check_rev(left)?;
    check_rev(right)?;
    let out = run(repo, &["merge-base", left, right], None)
        .map_err(|_| Error::Git(format!("{left} and {right} have no common commit.")))?;
    Ok(out.trim().to_string())
}

/// The commit `rev` names (a branch, tag, `stash@{0}`, `stash@{0}^1`…), full hash.
pub fn rev_parse(repo: &Path, rev: &str) -> Result<String> {
    check_rev(rev)?;
    let spec = format!("{rev}^{{commit}}");
    let out = run(repo, &["rev-parse", "--verify", "--quiet", &spec], None)
        .map_err(|_| Error::Git(format!("{rev} isn't a commit here.")))?;
    let hash = out.trim().to_string();
    if hash.is_empty() {
        return Err(Error::Git(format!("{rev} isn't a commit here.")));
    }
    Ok(hash)
}
