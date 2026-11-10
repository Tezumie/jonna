//! Git commands. The repository is found from the workspace root (`git_open`); D204: the
//! repositories inside the workspace (nested, submodules) are found by `git_discover`, and every
//! command takes an optional `repo` (one of their roots; none: the workspace's). Paths in and out
//! are repo-relative with `/` (absolute paths inside the repo are accepted too). Every git call
//! runs on a blocking thread so a slow repository never stalls the async runtime.

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::error::{Error, Result};
use crate::git::askpass::{self, AskpassRequest};
use crate::git::github::{self, GhArgs};
use crate::git::ops::{self, Branch, ChangedFile, Commit, CommitDetail};
use crate::git::rebase::{self, RebaseStep};
use crate::git::service::{find_workspace_repos, rel_path, repo_of};
use crate::git::status::GitStatus;
use crate::git::worktree::{self, Worktree};
use crate::git::{lens, FoundRepo, RepoInfo};
use crate::AppState;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| Error::Git(format!("git task failed: {e}")))?
}

/// The root of the repository a command names (`repo`), or the workspace's.
fn root_of(state: &AppState, repo: &Option<String>) -> Result<std::path::PathBuf> {
    state.git.at(repo.as_deref()).map(|r| r.root)
}

fn rels(root: &std::path::Path, paths: &[String]) -> Result<Vec<String>> {
    paths.iter().map(|p| rel_path(root, p)).collect()
}

/// Finds the repository for the open workspace; null when it isn't in one.
#[tauri::command]
pub async fn git_open(state: State<'_, AppState>) -> Result<Option<RepoInfo>> {
    // Two quick rev-parse calls; fine to run inline.
    state.git.open(&state.workspace.root()?)
}

/// The repositories inside the workspace besides its own (D204): nested ones up to `maxDepth`
/// folders down (VS Code's git.repositoryScanMaxDepth) and, with `submodules`, the submodules.
#[tauri::command]
pub async fn git_discover(
    state: State<'_, AppState>,
    max_depth: u32,
    ignored: Vec<String>,
    submodules: bool,
) -> Result<Vec<FoundRepo>> {
    let root = state.workspace.root()?;
    // A multi-root workspace's other folders: each one's repository ("folder"), and the
    // nested ones and submodules inside it too.
    let others = state.workspace.folders();
    let primary = state.git.primary();
    let found = blocking(move || {
        Ok(find_workspace_repos(
            primary.as_ref(),
            &root,
            &others,
            max_depth,
            &ignored,
            submodules,
        ))
    })
    .await?;
    state.git.set_found(&found)?;
    Ok(found)
}

/// Creates a repository in a workspace folder (`folder`; none: the root) and opens it: the
/// root's becomes the workspace's repository, another folder's one of the found ones.
#[tauri::command]
pub async fn git_init(
    state: State<'_, AppState>,
    folder: Option<String>,
) -> Result<Option<RepoInfo>> {
    let root = state.workspace.root()?;
    let dir = match folder.filter(|f| !f.is_empty()) {
        None => root.clone(),
        Some(f) => {
            // `scope_root` for a local folder too: it refuses a network path before touching it
            // (a plain `canonicalize` made Windows connect and offer credentials, D161).
            let canonical = state.workspace.scope_root(&f)?;
            if !state.workspace.all_folders().contains(&canonical) {
                return Err(Error::OutsideScope(f));
            }
            canonical
        }
    };
    let at = dir.clone();
    blocking(move || ops::init(&at)).await?;
    if dir == root {
        return state.git.open(&root);
    }
    let made = blocking(move || Ok(repo_of(&dir))).await?;
    let Some(repo) = made else {
        return Ok(None);
    };
    state.git.add_found(&repo)?;
    Ok(Some(RepoInfo {
        root: repo.root.to_string_lossy().into_owned(),
        git_dir: repo.git_dir.to_string_lossy().into_owned(),
    }))
}

/// Debounced notifications when the git directory changes (HEAD, index, refs).
#[tauri::command]
pub async fn git_watch(
    state: State<'_, AppState>,
    repo: Option<String>,
    on_change: Channel<()>,
) -> Result<()> {
    state.git.watch(repo.as_deref(), on_change)
}

#[tauri::command]
pub async fn git_status(state: State<'_, AppState>, repo: Option<String>) -> Result<GitStatus> {
    let root = root_of(&state, &repo)?;
    blocking(move || ops::status(&root)).await
}

/// The user accepts the repository's git settings as they are now, after they changed while
/// an agent's sandboxed commands ran there (D392): the IDE's git runs in it again.
#[tauri::command]
pub async fn git_trust_settings(state: State<'_, AppState>, repo: Option<String>) -> Result<()> {
    // A paused repository may not have opened (or been found): the workspace's folder, or the
    // folder named, inside the workspace.
    let root = match (root_of(&state, &repo), &repo) {
        (Ok(root), _) => root,
        (Err(_), None) => state.workspace.root()?,
        (Err(_), Some(path)) => state.workspace.resolve(path)?,
    };
    blocking(move || crate::git::guard::trust(&root)).await
}

/// File text at `HEAD` (`rev: "HEAD"`), in the index (`rev: ""`), at a commit (`rev`: its hash,
/// 7–40 hex digits; file history, D127) or a conflict's stage (`:1` base, `:2` ours, `:3`
/// theirs; the merge editor, D204); null if absent there.
#[tauri::command]
pub async fn git_show(
    state: State<'_, AppState>,
    repo: Option<String>,
    rev: String,
    path: String,
) -> Result<Option<String>> {
    let is_hash = (7..=40).contains(&rev.len()) && rev.bytes().all(|b| b.is_ascii_hexdigit());
    let is_stage = matches!(rev.as_str(), ":1" | ":2" | ":3");
    if !(rev.is_empty() || rev == "HEAD" || is_hash || is_stage) {
        return Err(Error::Invalid(format!("unsupported revision: {rev}")));
    }
    let root = root_of(&state, &repo)?;
    let rel = rel_path(&root, &path)?;
    blocking(move || ops::show(&root, &rev, &rel)).await
}

/// The merge base of HEAD and the default branch (D200: diffs against what a pull request
/// shows); null without a default branch.
#[tauri::command]
pub async fn git_merge_base(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<Option<String>> {
    let root = root_of(&state, &repo)?;
    blocking(move || ops::merge_base(&root)).await
}

/// Sets the index text of `path` (stages or unstages part of a file).
#[tauri::command]
pub async fn git_write_index(
    state: State<'_, AppState>,
    repo: Option<String>,
    path: String,
    text: String,
) -> Result<()> {
    let root = root_of(&state, &repo)?;
    let rel = rel_path(&root, &path)?;
    blocking(move || ops::write_index(&root, &rel, &text)).await
}

#[tauri::command]
pub async fn git_stage(
    state: State<'_, AppState>,
    repo: Option<String>,
    paths: Vec<String>,
) -> Result<()> {
    let root = root_of(&state, &repo)?;
    let paths = rels(&root, &paths)?;
    blocking(move || ops::stage(&root, &paths)).await
}

#[tauri::command]
pub async fn git_unstage(
    state: State<'_, AppState>,
    repo: Option<String>,
    paths: Vec<String>,
) -> Result<()> {
    let root = root_of(&state, &repo)?;
    let paths = rels(&root, &paths)?;
    blocking(move || ops::unstage(&root, &paths)).await
}

/// Discards working-tree changes; `untracked` files are deleted.
#[tauri::command]
pub async fn git_discard(
    state: State<'_, AppState>,
    repo: Option<String>,
    tracked: Vec<String>,
    untracked: Vec<String>,
) -> Result<()> {
    let root = root_of(&state, &repo)?;
    let tracked = rels(&root, &tracked)?;
    let untracked = rels(&root, &untracked)?;
    blocking(move || ops::discard(&root, &tracked, &untracked)).await
}

/// Commits; returns the new short hash.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn git_commit(
    state: State<'_, AppState>,
    repo: Option<String>,
    message: String,
    amend: bool,
    all: bool,
    sign: Option<bool>,
    signoff: Option<bool>,
) -> Result<String> {
    if message.trim().is_empty() {
        return Err(Error::Invalid("The commit message is empty.".into()));
    }
    let root = root_of(&state, &repo)?;
    let signing = ops::CommitSigning {
        sign: sign.unwrap_or(false),
        signoff: signoff.unwrap_or(false),
    };
    blocking(move || ops::commit(&root, &message, amend, all, signing)).await
}

#[tauri::command]
pub async fn git_branches(state: State<'_, AppState>, repo: Option<String>) -> Result<Vec<Branch>> {
    let root = root_of(&state, &repo)?;
    blocking(move || ops::branches(&root)).await
}

#[tauri::command]
pub async fn git_checkout(
    state: State<'_, AppState>,
    repo: Option<String>,
    name: String,
    create: bool,
    remote: bool,
) -> Result<()> {
    if name.starts_with('-') || name.trim().is_empty() {
        return Err(Error::Invalid(format!("not a branch name: {name}")));
    }
    let root = root_of(&state, &repo)?;
    blocking(move || ops::checkout(&root, &name, create, remote)).await
}

#[tauri::command]
pub async fn git_log(
    state: State<'_, AppState>,
    repo: Option<String>,
    limit: u32,
    path: Option<String>,
) -> Result<Vec<Commit>> {
    let root = root_of(&state, &repo)?;
    let rel = path.map(|p| rel_path(&root, &p)).transpose()?;
    blocking(move || ops::log(&root, limit.clamp(1, 10_000), rel.as_deref())).await
}

/// Commits for the graph (HEAD and its upstream, or every ref with `all`), children first.
#[tauri::command]
pub async fn git_graph(
    state: State<'_, AppState>,
    repo: Option<String>,
    limit: u32,
    all: bool,
) -> Result<Vec<Commit>> {
    let root = root_of(&state, &repo)?;
    // Pages of 50 grow the limit as the list scrolls (D233): thousands of commits.
    blocking(move || ops::log_graph(&root, limit.clamp(1, 10_000), all)).await
}

/// Commits of `range` ("HEAD..@{u}": incoming), newest first; empty when the range has no
/// meaning (no upstream).
#[tauri::command]
pub async fn git_log_range(
    state: State<'_, AppState>,
    repo: Option<String>,
    range: String,
    limit: u32,
) -> Result<Vec<Commit>> {
    if range.starts_with('-') {
        return Err(Error::Invalid(format!("not a range: {range}")));
    }
    let root = root_of(&state, &repo)?;
    blocking(move || {
        Ok(ops::log_range(&root, limit.clamp(1, 1000), Some(&range), None).unwrap_or_default())
    })
    .await
}

/// One commit's message, parent and changed files.
#[tauri::command]
pub async fn git_commit_detail(
    state: State<'_, AppState>,
    repo: Option<String>,
    rev: String,
) -> Result<CommitDetail> {
    if rev.starts_with('-') || rev.trim().is_empty() {
        return Err(Error::Invalid(format!("not a commit: {rev}")));
    }
    let root = root_of(&state, &repo)?;
    blocking(move || ops::commit_detail(&root, &rev)).await
}

/// Branch / merge / rebase / tag / remote / undo operations (`ops::repo_op`); returns git's output.
#[tauri::command]
pub async fn git_repo_op(
    state: State<'_, AppState>,
    repo: Option<String>,
    op: String,
    name: String,
    target: String,
) -> Result<String> {
    let root = root_of(&state, &repo)?;
    blocking(move || ops::repo_op(&root, &op, &name, &target)).await
}

/// Remotes, tags and the operation in progress (merge, rebase, cherry-pick, revert).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
    pub remotes: Vec<String>,
    /// Their URLs (links to the hosting site: a commit on GitHub…).
    pub remote_urls: Vec<ops::RemoteUrl>,
    pub tags: Vec<String>,
    pub operation: Option<&'static str>,
    /// The branch the current one is compared with (D200's default branch: origin's HEAD, else
    /// main / master); the Graph colors it as VS Code's base ref (D220).
    pub base_branch: Option<String>,
}

#[tauri::command]
pub async fn git_repo_state(state: State<'_, AppState>, repo: Option<String>) -> Result<RepoState> {
    let at = state.git.at(repo.as_deref())?;
    blocking(move || {
        Ok(RepoState {
            remotes: ops::remotes(&at.root)?,
            remote_urls: ops::remote_urls(&at.root).unwrap_or_default(),
            tags: ops::tags(&at.root).unwrap_or_default(),
            operation: ops::operation(&at.git_dir),
            base_branch: ops::default_branch(&at.root),
        })
    })
    .await
}

/// The staged (or working-tree) diff, cut at `max` bytes (commit messages).
#[tauri::command]
pub async fn git_diff(
    state: State<'_, AppState>,
    repo: Option<String>,
    staged: bool,
    max: u32,
) -> Result<String> {
    let root = root_of(&state, &repo)?;
    blocking(move || ops::diff_text(&root, staged, max as usize)).await
}

#[tauri::command]
pub async fn git_diff_range(
    state: State<'_, AppState>,
    repo: Option<String>,
    range: String,
    max: u32,
) -> Result<String> {
    let root = root_of(&state, &repo)?;
    blocking(move || ops::diff_range(&root, &range, max as usize)).await
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteOp {
    Fetch,
    Pull,
    PullRebase,
    PullMerge,
    PushForce,
    PushTags,
    Push,
}

/// fetch / pull / push; git's progress lines stream to `on_line`. Push sets the upstream when the
/// branch has none (`-u origin HEAD`).
#[tauri::command]
pub async fn git_remote(
    state: State<'_, AppState>,
    repo: Option<String>,
    op: RemoteOp,
    on_line: Channel<String>,
) -> Result<()> {
    let root = root_of(&state, &repo)?;
    blocking(move || {
        let has_upstream = ops::status(&root)?.branch.upstream.is_some();
        // Publishing a branch: to "origin", else the only remote.
        let remotes = ops::remotes(&root)?;
        let remote = if remotes.iter().any(|r| r == "origin") {
            "origin".to_string()
        } else {
            remotes.first().cloned().unwrap_or_default()
        };
        let needs_remote = matches!(op, RemoteOp::Push | RemoteOp::PushForce) && !has_upstream;
        if needs_remote && remote.is_empty() {
            return Err(Error::Git(
                "This repository has no remote. Add one with Git: Add remote….".into(),
            ));
        }
        let args: Vec<&str> = match op {
            RemoteOp::Fetch => vec!["fetch", "--progress", "--prune"],
            RemoteOp::Pull => vec!["pull", "--progress", "--ff-only"],
            RemoteOp::PullRebase => vec!["pull", "--progress", "--rebase"],
            RemoteOp::PullMerge => vec!["pull", "--progress", "--no-rebase", "--no-edit"],
            RemoteOp::Push if has_upstream => vec!["push", "--progress"],
            RemoteOp::Push => vec!["push", "--progress", "-u", &remote, "HEAD"],
            RemoteOp::PushForce if has_upstream => vec!["push", "--progress", "--force-with-lease"],
            RemoteOp::PushForce => {
                vec![
                    "push",
                    "--progress",
                    "--force-with-lease",
                    "-u",
                    &remote,
                    "HEAD",
                ]
            }
            RemoteOp::PushTags => vec!["push", "--progress", "--tags"],
        };
        ops::remote_op(&root, &args, |line| {
            let _ = on_line.send(line.to_string());
        })
    })
    .await
}

#[tauri::command]
pub async fn git_stash_list(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<Vec<ops::Stash>> {
    let root = root_of(&state, &repo)?;
    blocking(move || ops::stash_list(&root)).await
}

/// Stash push (with `message`, `untracked`), or apply / pop / drop of entry `index`.
#[tauri::command]
pub async fn git_stash(
    state: State<'_, AppState>,
    repo: Option<String>,
    op: ops::StashOp,
    index: Option<u32>,
    message: Option<String>,
    untracked: Option<bool>,
) -> Result<()> {
    let root = root_of(&state, &repo)?;
    blocking(move || {
        ops::stash(
            &root,
            op,
            index.unwrap_or(0),
            message.as_deref(),
            untracked.unwrap_or(false),
        )
    })
    .await
}

/// Who last changed `line` (1-based) of `path`; `contents` is the editor's unsaved text, if any.
#[tauri::command]
pub async fn git_blame(
    state: State<'_, AppState>,
    repo: Option<String>,
    path: String,
    line: u32,
    contents: Option<String>,
) -> Result<ops::BlameLine> {
    let root = root_of(&state, &repo)?;
    let rel = rel_path(&root, &path)?;
    blocking(move || ops::blame_line(&root, &rel, line.max(1), contents.as_deref())).await
}

/// The whole file's `git blame --porcelain` (the blame gutter, D204); `contents`: unsaved text.
#[tauri::command]
pub async fn git_blame_file(
    state: State<'_, AppState>,
    repo: Option<String>,
    path: String,
    contents: Option<String>,
) -> Result<String> {
    let root = root_of(&state, &repo)?;
    let rel = rel_path(&root, &path)?;
    blocking(move || lens::blame_file(&root, &rel, contents.as_deref())).await
}

/// `git log -L start,end:path`: the commits that changed those lines, with their diffs (D204).
#[tauri::command]
pub async fn git_log_lines(
    state: State<'_, AppState>,
    repo: Option<String>,
    path: String,
    start: u32,
    end: u32,
    limit: u32,
) -> Result<String> {
    let root = root_of(&state, &repo)?;
    let rel = rel_path(&root, &path)?;
    blocking(move || lens::log_lines(&root, &rel, start, end, limit)).await
}

/// The files that differ between two refs (`mergeBase`: since they forked), D204.
#[tauri::command]
pub async fn git_diff_names(
    state: State<'_, AppState>,
    repo: Option<String>,
    left: String,
    right: String,
    merge_base: Option<bool>,
) -> Result<Vec<ChangedFile>> {
    let root = root_of(&state, &repo)?;
    blocking(move || lens::diff_names(&root, &left, &right, merge_base.unwrap_or(false))).await
}

/// Where two refs forked (`git merge-base`), full hash (compare branches, D204).
#[tauri::command]
pub async fn git_merge_base_of(
    state: State<'_, AppState>,
    repo: Option<String>,
    left: String,
    right: String,
) -> Result<String> {
    let root = root_of(&state, &repo)?;
    blocking(move || lens::merge_base_of(&root, &left, &right)).await
}

/// The commit a ref names (branch, tag, `stash@{0}^1`…), full hash.
#[tauri::command]
pub async fn git_rev_parse(
    state: State<'_, AppState>,
    repo: Option<String>,
    rev: String,
) -> Result<String> {
    let root = root_of(&state, &repo)?;
    blocking(move || lens::rev_parse(&root, &rev)).await
}

/// `git clone` of `url` into a new folder inside `parent` (a folder the user picked); progress
/// lines stream to `on_line`. Returns the new folder's path.
#[tauri::command]
pub async fn git_clone(url: String, parent: String, on_line: Channel<String>) -> Result<String> {
    let parent = std::path::PathBuf::from(parent);
    if !parent.is_dir() {
        return Err(Error::Invalid(
            "Pick an existing folder to clone into.".into(),
        ));
    }
    blocking(move || {
        ops::clone(&parent, &url, |line| {
            let _ = on_line.send(line.to_string());
        })
        .map(|p| p.to_string_lossy().into_owned())
    })
    .await
}

/// Worktrees of the repository (the main one first).
#[tauri::command]
pub async fn git_worktrees(
    state: State<'_, AppState>,
    repo: Option<String>,
) -> Result<Vec<Worktree>> {
    let root = root_of(&state, &repo)?;
    blocking(move || worktree::list(&root)).await
}

/// add / remove / forceRemove / prune / lock / unlock a worktree (see git/worktree.rs).
#[tauri::command]
pub async fn git_worktree_op(
    state: State<'_, AppState>,
    repo: Option<String>,
    op: String,
    path: String,
    branch: String,
    base: String,
) -> Result<String> {
    let root = root_of(&state, &repo)?;
    blocking(move || worktree::op(&root, &op, &path, &branch, &base)).await
}

/// Commits a rebase onto `base` would replay, oldest first ("root": all of them).
#[tauri::command]
pub async fn git_rebase_plan(
    state: State<'_, AppState>,
    repo: Option<String>,
    base: String,
) -> Result<Vec<Commit>> {
    let root = root_of(&state, &repo)?;
    blocking(move || rebase::plan(&root, &base)).await
}

/// Runs an interactive rebase onto `base` with `steps` as the todo list (oldest first).
#[tauri::command]
pub async fn git_rebase_interactive(
    state: State<'_, AppState>,
    repo: Option<String>,
    base: String,
    steps: Vec<RebaseStep>,
) -> Result<String> {
    let at = state.git.at(repo.as_deref())?;
    blocking(move || rebase::interactive(&at.root, &at.git_dir, &base, &steps)).await
}

/// The frontend answers git's and ssh's sign-in prompts from now on (git/askpass.rs).
#[tauri::command]
pub fn git_askpass_listen(on_request: Channel<AskpassRequest>) -> Result<()> {
    askpass::listen(on_request)
}

/// The answer to a sign-in prompt (null: cancelled).
#[tauri::command]
pub fn git_askpass_reply(id: u64, value: Option<String>) {
    askpass::reply(id, value);
}

/// A GitHub operation through the `gh` CLI (git/github.rs); its output (JSON for lists/views).
#[tauri::command]
pub async fn github_cli(
    state: State<'_, AppState>,
    repo: Option<String>,
    op: String,
    args: GhArgs,
) -> Result<String> {
    // Repository operations run in it; `authStatus` and `notifications` work anywhere.
    let root = match root_of(&state, &repo) {
        Ok(root) => root,
        Err(_) if github::runs_anywhere(&op) => state
            .workspace
            .root()
            .unwrap_or_else(|_| std::env::temp_dir()),
        Err(e) => return Err(e),
    };
    blocking(move || github::run(&root, &op, &args)).await
}
