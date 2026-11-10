//! Interactive rebase without an editor (D139): the IDE builds the whole todo list (order and
//! pick / reword / edit / squash / fixup / drop per commit) and git takes it as written.
//!
//! git opens `$GIT_SEQUENCE_EDITOR <todo file>` through its shell, so the editor is
//! `cp "$IDE_REBASE_TODO"` — the prepared list copied over git's (Git for Windows ships the same
//! shell, so this works there too). A reworded commit is picked and then amended by an `exec`
//! line reading its new message from a file in the git directory (`git rev-parse --git-path`
//! finds it from any worktree, also after a stop and `rebase --continue`). Squash keeps git's
//! combined message, since `GIT_EDITOR=true` accepts it as is.

use std::path::Path;

use serde::Deserialize;

use super::{command, run};
use crate::error::{Error, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStep {
    /// pick, reword, edit, squash, fixup or drop.
    pub action: String,
    pub hash: String,
    /// The new message, for reword.
    pub message: Option<String>,
}

const MESSAGE_DIR: &str = "ide-rebase";
/// The most commits the rebase editor lists (git's own list could be longer: refused, not cut).
const PLAN_LIMIT: u32 = 2000;

/// The todo list git will run, plus the reword messages to write (file name → text).
pub fn todo(steps: &[RebaseStep]) -> Result<(String, Vec<(String, String)>)> {
    if steps.is_empty() {
        return Err(Error::Invalid("nothing to rebase".into()));
    }
    let mut lines = Vec::new();
    let mut messages = Vec::new();
    for (i, step) in steps.iter().enumerate() {
        if !(7..=64).contains(&step.hash.len()) || !step.hash.chars().all(|c| c.is_ascii_hexdigit())
        {
            return Err(Error::Invalid(format!("not a commit: {}", step.hash)));
        }
        let first_kept = steps[..i].iter().any(|s| s.action != "drop");
        match step.action.as_str() {
            "pick" | "edit" | "drop" => lines.push(format!("{} {}", step.action, step.hash)),
            "squash" | "fixup" if !first_kept => {
                return Err(Error::Invalid(format!(
                    "{} needs a commit before it to fold into",
                    step.action
                )))
            }
            "squash" | "fixup" => lines.push(format!("{} {}", step.action, step.hash)),
            "reword" => {
                let message = step.message.as_deref().unwrap_or("").trim();
                if message.is_empty() {
                    return Err(Error::Invalid(format!(
                        "reword {} needs a message",
                        &step.hash[..7]
                    )));
                }
                let file = format!("msg-{i}");
                lines.push(format!("pick {}", step.hash));
                lines.push(format!(
                    "exec git commit --amend --only --quiet -F \"$(git rev-parse --git-path {MESSAGE_DIR}/{file})\""
                ));
                messages.push((file, format!("{message}\n")));
            }
            other => return Err(Error::Invalid(format!("unknown rebase action {other}"))),
        }
    }
    Ok((lines.join("\n") + "\n", messages))
}

/// Starts `git rebase -i <base>` (or `--root`) with `steps` as the todo list. A stop (conflict,
/// edit) leaves the rebase in progress for Continue / Abort.
pub fn interactive(
    repo: &Path,
    git_dir: &Path,
    base: &str,
    steps: &[RebaseStep],
) -> Result<String> {
    if base.starts_with('-') || base.trim().is_empty() {
        return Err(Error::Invalid(format!("not a base: {base}")));
    }
    // The todo list and messages are files git reads from its own directory (D252: on the
    // remote, which this writes locally).
    if crate::remote::of_dir(repo).is_some() {
        return Err(crate::ipc::fs::not_in_remote_window(
            "An interactive rebase",
        ));
    }
    // Never touch (or misreport) a rebase that is already under way.
    if let Some(op) = super::ops::operation(git_dir) {
        return Err(Error::Git(format!(
            "A {op} is in progress: continue or abort it first."
        )));
    }
    let (list, messages) = todo(steps)?;
    // The list must cover exactly the commits git would replay now: anything left out would be
    // dropped silently (and the branch may have moved since the plan was shown).
    let fresh = plan(repo, base)?;
    let listed = |hash: &str| steps.iter().filter(|st| hash.starts_with(&st.hash)).count();
    if fresh.len() != steps.len() || fresh.iter().any(|c| listed(&c.hash) != 1) {
        return Err(Error::Invalid(
            "The commits changed since the rebase was planned (or the list is incomplete): open it again."
                .into(),
        ));
    }
    let dir = git_dir.join(MESSAGE_DIR);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    for (file, text) in &messages {
        std::fs::write(dir.join(file), text)?;
    }
    let todo_path = dir.join("todo");
    std::fs::write(&todo_path, list)?;
    let mut cmd = command(repo);
    cmd.env("GIT_SEQUENCE_EDITOR", "cp \"$IDE_REBASE_TODO\"")
        .env("IDE_REBASE_TODO", &todo_path)
        // A commit missing from the list is an error, not a silent drop.
        .args([
            "-c",
            "rebase.missingCommitsCheck=error",
            "rebase",
            "-i",
            "--autostash",
            "--no-autosquash",
        ]);
    if base == "root" {
        cmd.arg("--root");
    } else {
        cmd.arg(base);
    }
    let out = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if super::ops::operation(git_dir) == Some("rebase") {
        // Stopped (a conflict, or an `edit` — which exits 0): the rebase goes on from the IDE's
        // banner, and later reword lines still need their message files.
        Ok(text)
    } else if out.status.success() {
        let _ = std::fs::remove_dir_all(&dir);
        Ok(text)
    } else {
        let _ = std::fs::remove_dir_all(&dir);
        Err(Error::Git(text.trim().to_string()))
    }
}

/// Commits a rebase onto `base` would replay, oldest first (merges are dropped, as git does).
pub fn plan(repo: &Path, base: &str) -> Result<Vec<super::ops::Commit>> {
    if base.starts_with('-') || base.trim().is_empty() {
        return Err(Error::Invalid(format!("not a base: {base}")));
    }
    let range = if base == "root" {
        "HEAD".to_string()
    } else {
        format!("{base}..HEAD")
    };
    let _ = run(repo, &["rev-parse", "--verify", "-q", "HEAD"], None)?;
    let commits = super::ops::log_with(
        repo,
        PLAN_LIMIT + 1,
        &["--no-merges", "--topo-order", &range],
    )?;
    if commits.len() > PLAN_LIMIT as usize {
        return Err(Error::Invalid(format!(
            "More than {PLAN_LIMIT} commits to replay: pick a later base."
        )));
    }
    let mut commits = commits;
    commits.reverse();
    Ok(commits)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(action: &str, hash: &str, message: Option<&str>) -> RebaseStep {
        RebaseStep {
            action: action.into(),
            hash: hash.into(),
            message: message.map(String::from),
        }
    }

    #[test]
    fn todo_lists_actions_and_rewords_by_exec() {
        let (list, messages) = todo(&[
            step("pick", "aaaaaaa", None),
            step("reword", "bbbbbbb", Some("New subject")),
            step("fixup", "ccccccc", None),
            step("drop", "ddddddd", None),
        ])
        .unwrap();
        let lines: Vec<&str> = list.lines().collect();
        assert_eq!(lines[0], "pick aaaaaaa");
        assert_eq!(lines[1], "pick bbbbbbb");
        assert!(lines[2].starts_with("exec git commit --amend --only"));
        assert!(lines[2].contains("ide-rebase/msg-1"));
        assert_eq!(lines[3], "fixup ccccccc");
        assert_eq!(lines[4], "drop ddddddd");
        assert_eq!(
            messages,
            vec![("msg-1".to_string(), "New subject\n".to_string())]
        );
    }

    #[test]
    fn todo_refuses_bad_input() {
        assert!(todo(&[step("squash", "aaaaaaa", None)]).is_err());
        assert!(todo(&[step("pick", "-x", None)]).is_err());
        assert!(todo(&[step("exec", "aaaaaaa", None)]).is_err());
        assert!(todo(&[step("reword", "aaaaaaa", Some("  "))]).is_err());
        assert!(todo(&[]).is_err());
    }
}
