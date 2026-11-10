//! Integration tests against real temporary repositories (skipped when git isn't installed).

use std::fs;
use std::path::{Path, PathBuf};

use super::ops;
use super::run;
use super::service::rel_path;

fn repo(name: &str) -> Option<PathBuf> {
    let dir = std::env::temp_dir().join(format!("ide-git-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).ok()?;
    if ops::init(&dir).is_err() {
        eprintln!("git not available; skipping");
        return None;
    }
    for (k, v) in [
        ("user.name", "Test"),
        ("user.email", "test@example.com"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
    ] {
        run(&dir, &["config", k, v], None).ok()?;
    }
    run(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"], None).ok()?;
    Some(dir)
}

fn write(dir: &Path, name: &str, text: &str) {
    fs::write(dir.join(name), text).unwrap();
}

#[test]
fn status_stage_commit_cycle() {
    let Some(dir) = repo("cycle") else { return };
    write(&dir, "a.txt", "one\ntwo\nthree\n");
    let st = ops::status(&dir).unwrap();
    assert_eq!(st.files.len(), 1);
    assert_eq!(st.files[0].worktree, '?');
    // Unstage before the first commit uses `git rm --cached`.
    ops::stage(&dir, &["a.txt".into()]).unwrap();
    assert_eq!(ops::status(&dir).unwrap().files[0].index, 'A');
    ops::unstage(&dir, &["a.txt".into()]).unwrap();
    assert_eq!(ops::status(&dir).unwrap().files[0].worktree, '?');
    ops::stage(&dir, &["a.txt".into()]).unwrap();
    let hash = ops::commit(&dir, "first\n\nbody", false, false, Default::default()).unwrap();
    assert!(!hash.is_empty());
    let log = ops::log(&dir, 10, None).unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].subject, "first");
    assert!(ops::status(&dir).unwrap().files.is_empty());
    assert_eq!(
        ops::show(&dir, "HEAD", "a.txt").unwrap().as_deref(),
        Some("one\ntwo\nthree\n")
    );
    assert_eq!(ops::show(&dir, "HEAD", "missing.txt").unwrap(), None);
    // Amend keeps one commit.
    write(&dir, "a.txt", "one\n2\nthree\n");
    ops::commit(&dir, "first (amended)", true, true, Default::default()).unwrap();
    let log = ops::log(&dir, 10, None).unwrap();
    assert_eq!(log.len(), 1);
    assert_eq!(log[0].subject, "first (amended)");
}

#[test]
fn write_index_stages_partial_text_and_keeps_mode() {
    let Some(dir) = repo("index") else { return };
    write(&dir, "f.txt", "a\nb\nc\n");
    ops::stage(&dir, &["f.txt".into()]).unwrap();
    ops::commit(&dir, "base", false, false, Default::default()).unwrap();
    write(&dir, "f.txt", "A\nb\nc\nd\n");
    // Stage only the first change.
    ops::write_index(&dir, "f.txt", "A\nb\nc\n").unwrap();
    assert_eq!(
        ops::show(&dir, "", "f.txt").unwrap().as_deref(),
        Some("A\nb\nc\n")
    );
    let st = ops::status(&dir).unwrap();
    assert_eq!((st.files[0].index, st.files[0].worktree), ('M', 'M'));
    // Unstage it again by writing HEAD's text.
    ops::write_index(&dir, "f.txt", "a\nb\nc\n").unwrap();
    assert_eq!(ops::status(&dir).unwrap().files[0].index, '.');
    // A new file can be staged partially too.
    write(&dir, "new.txt", "x\ny\n");
    ops::write_index(&dir, "new.txt", "x\n").unwrap();
    assert_eq!(
        ops::show(&dir, "", "new.txt").unwrap().as_deref(),
        Some("x\n")
    );
    #[cfg(unix)]
    {
        run(&dir, &["update-index", "--chmod=+x", "f.txt"], None).unwrap();
        ops::write_index(&dir, "f.txt", "z\n").unwrap();
        let staged = run(&dir, &["ls-files", "-s", "--", "f.txt"], None).unwrap();
        assert!(staged.starts_with("100755"), "{staged}");
    }
}

#[test]
fn show_applies_line_ending_conversion() {
    let Some(dir) = repo("eol") else { return };
    run(&dir, &["config", "core.autocrlf", "true"], None).unwrap();
    write(&dir, "w.txt", "one\r\ntwo\r\n");
    ops::stage(&dir, &["w.txt".into()]).unwrap();
    ops::commit(&dir, "crlf", false, false, Default::default()).unwrap();
    // Stored as LF, shown as the checkout would write it (CRLF).
    let raw = run(&dir, &["show", "HEAD:w.txt"], None).unwrap();
    assert_eq!(raw, "one\ntwo\n");
    assert_eq!(
        ops::show(&dir, "HEAD", "w.txt").unwrap().as_deref(),
        Some("one\r\ntwo\r\n")
    );
    // Writing working-tree text back stores LF again.
    ops::write_index(&dir, "w.txt", "one\r\n2\r\n").unwrap();
    let staged = run(&dir, &["show", ":w.txt"], None).unwrap();
    assert_eq!(staged, "one\n2\n");
}

#[test]
fn discard_and_branches() {
    let Some(dir) = repo("branches") else { return };
    write(&dir, "a.txt", "a\n");
    ops::stage(&dir, &["a.txt".into()]).unwrap();
    ops::commit(&dir, "a", false, false, Default::default()).unwrap();
    write(&dir, "a.txt", "changed\n");
    write(&dir, "new.txt", "new\n");
    ops::discard(&dir, &["a.txt".into()], &["new.txt".into()]).unwrap();
    assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "a\n");
    assert!(!dir.join("new.txt").exists());
    ops::checkout(&dir, "feature", true, false).unwrap();
    let branches = ops::branches(&dir).unwrap();
    assert_eq!(branches.len(), 2);
    assert!(branches.iter().any(|b| b.name == "feature" && b.current));
    assert_eq!(
        ops::status(&dir).unwrap().branch.head.as_deref(),
        Some("feature")
    );
    ops::checkout(&dir, "main", false, false).unwrap();
    assert_eq!(
        ops::status(&dir).unwrap().branch.head.as_deref(),
        Some("main")
    );
    // A failing command surfaces git's message.
    let err = ops::checkout(&dir, "nope", false, false).unwrap_err();
    assert!(err.to_string().contains("nope"), "{err}");
}

#[test]
fn remote_push_and_fetch_stream_lines() {
    let Some(dir) = repo("remote") else { return };
    let bare = dir.with_extension("bare");
    let _ = fs::remove_dir_all(&bare);
    fs::create_dir_all(&bare).unwrap();
    if run(&bare, &["init", "-q", "--bare"], None).is_err() {
        return;
    }
    write(&dir, "a.txt", "a\n");
    ops::stage(&dir, &["a.txt".into()]).unwrap();
    ops::commit(&dir, "a", false, false, Default::default()).unwrap();
    let url = bare.to_string_lossy().into_owned();
    run(&dir, &["remote", "add", "origin", &url], None).unwrap();
    let mut lines = Vec::new();
    ops::remote_op(&dir, &["push", "--progress", "-u", "origin", "HEAD"], |l| {
        lines.push(l.to_string())
    })
    .unwrap();
    assert!(!lines.is_empty());
    let st = ops::status(&dir).unwrap();
    assert!(st.branch.upstream.is_some());
    assert_eq!((st.branch.ahead, st.branch.behind), (0, 0));
    ops::remote_op(&dir, &["fetch", "--progress"], |_| {}).unwrap();
    assert!(ops::remote_op(&dir, &["fetch", "nowhere"], |_| {}).is_err());
    let _ = fs::remove_dir_all(&bare);
}

/// stdout and stderr both well past a pipe buffer (64 KB): reading one to EOF before the other
/// used to deadlock.
#[cfg(unix)]
#[test]
fn remote_op_drains_both_pipes() {
    let Some(dir) = repo("bigout") else { return };
    let script = "!f() { i=0; while [ $i -lt 4000 ]; do \
        echo \"stdout line $i padding padding padding\"; \
        echo \"stderr line $i padding padding padding\" >&2; i=$((i+1)); done; }; f";
    let alias = format!("alias.noisy={script}");
    let mut count = 0usize;
    ops::remote_op(&dir, &["-c", &alias, "noisy"], |_| count += 1).unwrap();
    assert_eq!(count, 8000);
}

/// git exits before reading all of stdin: its error still comes back (no early `?` on the
/// broken pipe, and the child is reaped).
#[cfg(unix)]
#[test]
fn run_reports_git_error_when_stdin_is_not_read() {
    let Some(dir) = repo("stdin") else { return };
    let input = vec![b'x'; 1024 * 1024];
    let err = run(
        &dir,
        &["-c", "alias.boom=!echo nope >&2; exit 3", "boom"],
        Some(&input),
    )
    .unwrap_err();
    assert!(err.to_string().contains("nope"), "{err}");
}

#[test]
fn rel_paths_stay_inside() {
    let root = std::env::temp_dir().join("repo");
    let inside = root.join("src").join("a.ts");
    assert_eq!(
        rel_path(&root, &inside.to_string_lossy()).unwrap(),
        "src/a.ts"
    );
    assert_eq!(rel_path(&root, "src/a.ts").unwrap(), "src/a.ts");
    assert!(rel_path(&root, "../x").is_err());
    let outside = std::env::temp_dir().join("other").join("a.ts");
    assert!(rel_path(&root, &outside.to_string_lossy()).is_err());
}

#[test]
fn blame_porcelain_and_clone_names() {
    use super::ops::{clone_dir_name, parse_blame};
    let out = "1f2e3d4c5b6a7980112233445566778899aabbcc 3 3 1\nauthor Ada Lovelace\nauthor-mail <ada@example.com>\nauthor-time 1700000000\nauthor-tz +0000\nsummary Fix the parser\nfilename src/a.rs\n\tlet x = 1;\n";
    let b = parse_blame(out).unwrap();
    assert_eq!(b.author, "Ada Lovelace");
    assert_eq!(b.author_mail, "ada@example.com");
    assert_eq!(b.time, 1_700_000_000);
    assert_eq!(b.summary, "Fix the parser");
    assert!(b.committed);
    let zero = parse_blame(
        "0000000000000000000000000000000000000000 1 1 1\nauthor Not Committed Yet\n\tx\n",
    )
    .unwrap();
    assert!(!zero.committed);
    assert_eq!(
        clone_dir_name("https://github.com/user/repo.git").as_deref(),
        Some("repo")
    );
    assert_eq!(
        clone_dir_name("git@github.com:user/my-app").as_deref(),
        Some("my-app")
    );
    assert_eq!(
        clone_dir_name("https://example.com/x/"),
        Some("x".to_string())
    );
    assert_eq!(clone_dir_name(""), None);
}

#[test]
fn clone_rejects_option_like_urls() {
    let dir = std::env::temp_dir();
    assert!(super::ops::clone(&dir, "--upload-pack=evil", |_| {}).is_err());
}

#[test]
fn blame_and_clone_against_a_repo() {
    let Some(dir) = repo("blame") else { return };
    write(&dir, "a.txt", "one\ntwo\n");
    ops::stage(&dir, &["a.txt".into()]).unwrap();
    ops::commit(&dir, "add a", false, false, Default::default()).unwrap();
    let b = ops::blame_line(&dir, "a.txt", 2, None).unwrap();
    assert_eq!(b.author, "Test");
    assert_eq!(b.summary, "add a");
    assert!(b.committed);
    // Unsaved editor text: the changed line isn't committed yet.
    let dirty = ops::blame_line(&dir, "a.txt", 2, Some("one\nTWO\n")).unwrap();
    assert!(!dirty.committed);
    let parent = std::env::temp_dir().join(format!("ide-git-clone-{}", std::process::id()));
    let _ = fs::remove_dir_all(&parent);
    fs::create_dir_all(&parent).unwrap();
    let mut lines = 0;
    let dest = ops::clone(&parent, dir.to_str().unwrap(), |_| lines += 1).unwrap();
    assert!(dest.join("a.txt").exists());
    assert!(
        ops::clone(&parent, dir.to_str().unwrap(), |_| {}).is_err(),
        "already exists"
    );
    let _ = fs::remove_dir_all(&parent);
}

#[test]
fn stash_push_list_pop_drop() {
    let Some(dir) = repo("stash") else { return };
    write(&dir, "a.txt", "one\n");
    ops::stage(&dir, &["a.txt".into()]).unwrap();
    ops::commit(&dir, "first", false, false, Default::default()).unwrap();
    write(&dir, "a.txt", "two\n");
    write(&dir, "new.txt", "untracked\n");
    ops::stash(&dir, ops::StashOp::Push, 0, Some("wip one"), true).unwrap();
    assert!(ops::status(&dir).unwrap().files.is_empty());
    let list = ops::stash_list(&dir).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].index, 0);
    assert!(list[0].message.contains("wip one"));
    write(&dir, "a.txt", "three\n");
    ops::stash(&dir, ops::StashOp::Push, 0, None, false).unwrap();
    assert_eq!(ops::stash_list(&dir).unwrap().len(), 2);
    // stash@{1} is the first one: pop it back, with its untracked file.
    ops::stash(&dir, ops::StashOp::Pop, 1, None, false).unwrap();
    assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "two\n");
    assert!(dir.join("new.txt").exists());
    ops::stash(&dir, ops::StashOp::Drop, 0, None, false).unwrap();
    assert!(ops::stash_list(&dir).unwrap().is_empty());
}

#[test]
fn name_status_parses_renames() {
    let files = ops::parse_name_status("M\0a.txt\0R100\0old.txt\0new.txt\0A\0b c.txt\0");
    assert_eq!(files.len(), 3);
    assert_eq!(files[1].status, "R");
    assert_eq!(files[1].path, "new.txt");
    assert_eq!(files[1].orig_path.as_deref(), Some("old.txt"));
    assert_eq!(files[2].path, "b c.txt");
}

#[test]
fn commit_detail_branches_merge_tags_and_undo() {
    let Some(dir) = repo("ops") else { return };
    write(&dir, "a.txt", "one\n");
    ops::stage(&dir, &["a.txt".into()]).unwrap();
    ops::commit(&dir, "first", false, false, Default::default()).unwrap();
    // A root commit lists its files too.
    let root = ops::commit_detail(&dir, "HEAD").unwrap();
    assert_eq!(root.parent, None);
    assert_eq!(root.files[0].status, "A");

    ops::repo_op(&dir, "createBranchFrom", "feature", "main").unwrap();
    write(&dir, "b.txt", "two\n");
    ops::stage(&dir, &["b.txt".into()]).unwrap();
    ops::commit(
        &dir,
        "second\n\nwith a body",
        false,
        false,
        Default::default(),
    )
    .unwrap();
    let d = ops::commit_detail(&dir, "HEAD").unwrap();
    assert!(d.parent.is_some());
    assert_eq!(d.message, "second\n\nwith a body");
    assert_eq!(d.files.len(), 1);
    assert_eq!(d.files[0].path, "b.txt");
    let log = ops::log(&dir, 5, None).unwrap();
    assert_eq!(log[0].parents.len(), 1);
    assert!(log[0].refs.iter().any(|r| r.contains("feature")));

    ops::checkout(&dir, "main", false, false).unwrap();
    ops::repo_op(&dir, "merge", "feature", "").unwrap();
    assert!(dir.join("b.txt").exists());
    ops::repo_op(&dir, "tag", "v1", "").unwrap();
    assert_eq!(ops::tags(&dir).unwrap(), vec!["v1".to_string()]);
    ops::repo_op(&dir, "deleteBranch", "feature", "").unwrap();
    assert!(ops::repo_op(&dir, "deleteBranch", "--all", "").is_err());
    ops::repo_op(&dir, "undoCommit", "", "").unwrap();
    // The undone commit's change is staged again.
    assert_eq!(ops::status(&dir).unwrap().files[0].index, 'A');
    assert!(ops::diff_text(&dir, true, 10_000).unwrap().contains("+two"));
    assert_eq!(ops::operation(&dir.join(".git")), None);
    assert!(ops::remotes(&dir).unwrap().is_empty());
}

fn commit_file(dir: &Path, name: &str, text: &str, message: &str) -> String {
    write(dir, name, text);
    ops::stage(dir, &[name.into()]).unwrap();
    ops::commit(dir, message, false, false, Default::default()).unwrap();
    run(dir, &["rev-parse", "HEAD"], None)
        .unwrap()
        .trim()
        .to_string()
}

#[test]
fn interactive_rebase_reorders_rewords_squashes_and_drops() {
    let Some(dir) = repo("rebase") else { return };
    commit_file(&dir, "base.txt", "base\n", "base");
    let a = commit_file(&dir, "a.txt", "a\n", "add a");
    let b = commit_file(&dir, "b.txt", "b\n", "add b");
    let c = commit_file(&dir, "c.txt", "c\n", "add c");
    let d = commit_file(&dir, "d.txt", "d\n", "add d");
    let plan = super::rebase::plan(&dir, "HEAD~4").unwrap();
    assert_eq!(
        plan.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(),
        ["add a", "add b", "add c", "add d"]
    );
    let step = |action: &str, hash: &str, message: Option<&str>| super::rebase::RebaseStep {
        action: action.into(),
        hash: hash.into(),
        message: message.map(String::from),
    };
    super::rebase::interactive(
        &dir,
        &dir.join(".git"),
        "HEAD~4",
        &[
            step("pick", &c, None),
            step("reword", &a, Some("add a (reworded)")),
            step("fixup", &b, None),
            step("drop", &d, None),
        ],
    )
    .unwrap();
    let log = ops::log(&dir, 10, None).unwrap();
    let subjects: Vec<&str> = log.iter().map(|c| c.subject.as_str()).collect();
    assert_eq!(subjects, ["add a (reworded)", "add c", "base"]);
    assert!(dir.join("b.txt").exists(), "fixup keeps b's change");
    assert!(!dir.join("d.txt").exists(), "drop removes d");
    assert_eq!(ops::operation(&dir.join(".git")), None);
}

#[test]
fn worktrees_add_list_remove_and_graph_log() {
    let Some(dir) = repo("worktree") else { return };
    commit_file(&dir, "a.txt", "a\n", "first");
    let wt = dir.with_file_name(format!("{}-wt", dir.file_name().unwrap().to_string_lossy()));
    let _ = fs::remove_dir_all(&wt);
    let wt_path = wt.to_string_lossy().to_string();
    super::worktree::op(&dir, "add", &wt_path, "feature", "main").unwrap();
    let list = super::worktree::list(&dir).unwrap();
    assert_eq!(list.len(), 2);
    assert!(list[0].main);
    assert_eq!(list[1].branch.as_deref(), Some("feature"));
    assert!(super::worktree::op(&dir, "add", "--bad", "", "main").is_err());
    commit_file(&wt, "b.txt", "b\n", "on feature");
    // The graph log sees the other branch with `all`.
    assert_eq!(ops::log_graph(&dir, 10, false).unwrap().len(), 1);
    assert_eq!(ops::log_graph(&dir, 10, true).unwrap().len(), 2);
    super::worktree::op(&dir, "remove", &wt_path, "", "").unwrap();
    assert_eq!(super::worktree::list(&dir).unwrap().len(), 1);
}

#[test]
fn interactive_rebase_refuses_incomplete_lists_and_survives_an_edit_stop() {
    let Some(dir) = repo("rebase-edit") else {
        return;
    };
    commit_file(&dir, "base.txt", "base\n", "base");
    let a = commit_file(&dir, "a.txt", "a\n", "add a");
    let b = commit_file(&dir, "b.txt", "b\n", "add b\n\nwith a body");
    let step = |action: &str, hash: &str, message: Option<&str>| super::rebase::RebaseStep {
        action: action.into(),
        hash: hash.into(),
        message: message.map(String::from),
    };
    let git_dir = dir.join(".git");
    // Leaving b out would drop it: refused.
    assert!(
        super::rebase::interactive(&dir, &git_dir, "HEAD~2", &[step("pick", &a, None)]).is_err()
    );
    // An edit stop exits 0 but the rebase goes on; the reword after it still has its message.
    super::rebase::interactive(
        &dir,
        &git_dir,
        "HEAD~2",
        &[
            step("edit", &a, None),
            step("reword", &b, Some("add b (new)\n\nnew body")),
        ],
    )
    .unwrap();
    assert_eq!(ops::operation(&git_dir), Some("rebase"));
    // A second rebase while one is under way is refused, not reported as a stop.
    assert!(
        super::rebase::interactive(&dir, &git_dir, "HEAD~1", &[step("pick", &a, None)]).is_err()
    );
    ops::repo_op(&dir, "rebaseContinue", "", "").unwrap();
    assert_eq!(ops::operation(&git_dir), None);
    let d = ops::commit_detail(&dir, "HEAD").unwrap();
    assert_eq!(d.message, "add b (new)\n\nnew body");
}

#[test]
fn shortstat_and_remote_urls_parse() {
    assert_eq!(
        ops::parse_shortstat(" 3 files changed, 10 insertions(+), 2 deletions(-)\n"),
        (10, 2)
    );
    assert_eq!(
        ops::parse_shortstat(" 1 file changed, 1 deletion(-)"),
        (0, 1)
    );
    assert_eq!(ops::parse_shortstat(""), (0, 0));
    let urls = ops::parse_remote_urls(
        "origin\thttps://github.com/a/b.git (fetch)\norigin\tgit@github.com:a/b.git (push)\nup\t/tmp/x (fetch)\n",
    );
    assert_eq!(urls.len(), 2);
    assert_eq!(urls[0].url, "https://github.com/a/b.git");
    assert_eq!(urls[1].name, "up");
}

#[test]
fn commit_detail_counts_lines() {
    let Some(dir) = repo("detail-lines") else {
        return;
    };
    write(&dir, "a.txt", "one\ntwo\nthree\n");
    run(&dir, &["add", "."], None).unwrap();
    run(&dir, &["commit", "-qm", "first"], None).unwrap();
    write(&dir, "a.txt", "one\nTWO\n");
    run(&dir, &["commit", "-qam", "second"], None).unwrap();
    let first = ops::commit_detail(&dir, "HEAD~1").unwrap();
    assert_eq!((first.insertions, first.deletions), (3, 0));
    let second = ops::commit_detail(&dir, "HEAD").unwrap();
    assert_eq!((second.insertions, second.deletions), (1, 2));
}

#[test]
fn diff_ranges_are_revisions_not_options() {
    let Some(dir) = repo("range") else { return };
    write(&dir, "a.txt", "one\n");
    ops::stage(&dir, &["a.txt".into()]).unwrap();
    ops::commit(&dir, "first", false, false, Default::default()).unwrap();
    write(&dir, "a.txt", "one\ntwo\n");
    let diff = ops::diff_range(&dir, "HEAD", 10_000).unwrap();
    assert!(diff.contains("+two"));
    assert!(ops::diff_range(&dir, "--output=/tmp/x", 100).is_err());
    assert!(ops::diff_range(&dir, "HEAD main", 100).is_err());
    assert!(ops::diff_range(&dir, "", 100).is_err());
    let cut = ops::diff_range(&dir, "HEAD", 10).unwrap();
    assert!(cut.contains("(diff truncated)"));
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn commit_signoff_adds_the_trailer() {
    let Some(dir) = repo("signoff") else { return };
    write(&dir, "s.txt", "s");
    ops::stage(&dir, &["s.txt".into()]).unwrap();
    let signing = ops::CommitSigning {
        sign: false,
        signoff: true,
    };
    ops::commit(&dir, "signed", false, false, signing).unwrap();
    let body = run(&dir, &["log", "-1", "--format=%B"], None).unwrap();
    assert!(
        body.contains("Signed-off-by: Test <test@example.com>"),
        "{body}"
    );
}

#[test]
fn merge_base_with_the_default_branch() {
    let Some(dir) = repo("mergebase") else { return };
    write(&dir, "m.txt", "1\n");
    ops::stage(&dir, &["m.txt".into()]).unwrap();
    let base = ops::commit(&dir, "base", false, false, Default::default()).unwrap();
    run(&dir, &["checkout", "-b", "feature"], None).unwrap();
    write(&dir, "m.txt", "2\n");
    ops::stage(&dir, &["m.txt".into()]).unwrap();
    ops::commit(&dir, "feature", false, false, Default::default()).unwrap();
    assert_eq!(ops::default_branch(&dir).as_deref(), Some("main"));
    let mb = ops::merge_base(&dir).unwrap().unwrap();
    assert!(mb.starts_with(&base), "{mb} vs {base}");
}

/// D204: a conflict's index stages, a line range's history, refs compared, nested repositories.
#[test]
fn merge_stages_line_history_compare_and_nested_repos() {
    use super::lens;
    let Some(dir) = repo("lens") else { return };
    write(&dir, "f.txt", "a\nb\nc\n");
    ops::stage(&dir, &["f.txt".into()]).unwrap();
    ops::commit(&dir, "base", false, false, Default::default()).unwrap();
    run(&dir, &["checkout", "-q", "-b", "other"], None).unwrap();
    write(&dir, "f.txt", "a\nTHEIRS\nc\n");
    ops::commit(&dir, "theirs", false, true, Default::default()).unwrap();
    run(&dir, &["checkout", "-q", "main"], None).unwrap();
    write(&dir, "f.txt", "a\nOURS\nc\n");
    ops::commit(&dir, "ours", false, true, Default::default()).unwrap();

    // Compare: the file differs between the branches; their merge base is "base".
    let files = lens::diff_names(&dir, "main", "other", false).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "f.txt");
    let main = lens::rev_parse(&dir, "main").unwrap();
    assert_eq!(main.len(), 40);
    let mb = lens::merge_base_of(&dir, "main", "other").unwrap();
    assert_eq!(
        ops::show(&dir, &mb, "f.txt").unwrap().as_deref(),
        Some("a\nb\nc\n")
    );
    assert!(lens::rev_parse(&dir, "--all").is_err());
    assert!(lens::rev_parse(&dir, "nope").is_err());

    // Line history: two commits changed line 2.
    let log = lens::log_lines(&dir, "f.txt", 2, 2, 10).unwrap();
    assert_eq!(log.matches('\u{1e}').count(), 2);
    assert!(log.contains("+OURS"));
    assert!(lens::log_lines(&dir, "f.txt", 3, 2, 10).is_err());

    // The merge conflicts: stages 1, 2 and 3 are base, ours and theirs.
    assert!(run(&dir, &["merge", "other"], None).is_err());
    assert_eq!(
        ops::show(&dir, ":1", "f.txt").unwrap().as_deref(),
        Some("a\nb\nc\n")
    );
    assert_eq!(
        ops::show(&dir, ":2", "f.txt").unwrap().as_deref(),
        Some("a\nOURS\nc\n")
    );
    assert_eq!(
        ops::show(&dir, ":3", "f.txt").unwrap().as_deref(),
        Some("a\nTHEIRS\nc\n")
    );
    let blame = lens::blame_file(&dir, "f.txt", Some("a\nOURS\nc\n")).unwrap();
    assert!(blame.contains("summary ours"));
    run(&dir, &["merge", "--abort"], None).unwrap();

    // A nested repository one folder down is found (and the workspace's own is not listed).
    let nested = dir.join("libs");
    fs::create_dir_all(&nested).unwrap();
    ops::init(&nested).unwrap();
    let primary = super::service::Repo {
        root: dir.clone(),
        git_dir: dir.join(".git"),
    };
    let found = super::service::find_repos(Some(&primary), &dir, 1, &[], true);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].kind, "nested");
    assert!(found[0].root.ends_with("libs"));
    assert!(super::service::find_repos(Some(&primary), &dir, 0, &[], true).is_empty());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn every_workspace_folder_brings_its_repositories() {
    let Some(main) = repo("ws-main") else { return };
    let Some(other) = repo("ws-other") else {
        return;
    };
    // The other folder's own repository, and one nested in it.
    let inner = other.join("inner");
    fs::create_dir_all(&inner).unwrap();
    ops::init(&inner).unwrap();
    // A folder inside the primary's repository brings nothing new.
    let sub = main.join("pkg");
    fs::create_dir_all(&sub).unwrap();
    let primary = super::service::repo_of(&main).unwrap();
    let others = vec![other.clone(), sub.clone()];
    let found = super::service::find_workspace_repos(Some(&primary), &main, &others, 1, &[], true);
    let kinds: Vec<(&str, String)> = found
        .iter()
        .map(|f| {
            let name = Path::new(&f.root)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            (f.kind, name)
        })
        .collect();
    let other_name = other.file_name().unwrap().to_string_lossy().into_owned();
    assert_eq!(
        kinds,
        vec![("folder", other_name), ("nested", "inner".to_string())],
        "{found:?}"
    );
    // Commands may name a found folder's repository; unknown paths stay refused.
    let service = super::GitService::default();
    service.open(&main).unwrap();
    service.set_found(&found).unwrap();
    assert!(service.at(Some(&found[0].root)).is_ok());
    assert!(service
        .at(Some(&std::env::temp_dir().to_string_lossy()))
        .is_err());
    // A repository made in a folder later (git init) is let in at once.
    let late = super::service::repo_of(&inner).unwrap();
    service.set_found(&[]).unwrap();
    assert!(service.at(Some(&late.root.to_string_lossy())).is_err());
    service.add_found(&late).unwrap();
    assert!(service.at(Some(&late.root.to_string_lossy())).is_ok());
    // One folder: the same as before multi-root.
    let alone = super::service::find_workspace_repos(Some(&primary), &main, &[], 1, &[], true);
    assert!(alone.is_empty(), "{alone:?}");
    let _ = fs::remove_dir_all(&main);
    let _ = fs::remove_dir_all(&other);
}

#[test]
fn local_git_turns_long_paths_on_only_on_windows() {
    let dir = std::env::temp_dir();
    let args: Vec<String> = super::command(&dir)
        .get_args()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let at = args
        .windows(2)
        .position(|w| w[0] == "-c" && w[1] == "core.longpaths=true");
    if cfg!(windows) {
        // Before anything else, so it's in force for whatever subcommand follows.
        assert_eq!(at, Some(0), "{args:?}");
    } else {
        assert_eq!(at, None, "{args:?}");
    }
}

/// A file deeper than Windows' 260-character limit is staged and committed (git alone would
/// answer "Filename too long" without `core.longpaths`).
#[cfg(windows)]
#[test]
fn files_past_the_windows_path_limit_are_committed() {
    let Some(dir) = repo("longpaths") else { return };
    let mut deep = dir.clone();
    while deep.as_os_str().len() < 300 {
        deep.push("a-rather-long-folder-name-for-the-test");
    }
    // std writes long paths itself (it adds the `\?\` prefix when needed).
    fs::create_dir_all(&deep).unwrap();
    fs::write(deep.join("deep.txt"), "x\n").unwrap();
    run(&dir, &["add", "."], None).unwrap();
    run(&dir, &["commit", "-q", "-m", "deep"], None).unwrap();
    let files = run(&dir, &["ls-files"], None).unwrap();
    assert!(files.trim_end().ends_with("deep.txt"), "{files}");
    let _ = fs::remove_dir_all(&dir);
}
