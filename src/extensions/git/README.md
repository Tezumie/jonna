# extensions/git

Source control through the user's `git` CLI (Rust: `src-tauri/src/git`, D65–D67).

- `controller.ts` — finds the repository when a folder opens, watches its git dir, refreshes status
  (coalesced) after saves/file events/focus and on a 5 s poll while focused; provides file
  decorations and the quick-diff base texts (index / HEAD).
- `model.ts` — status grouped as the view shows it (merge, staged, changes) and decorations for
  files and their folders (DESIGN.md §3.5). DOM-free, tested.
- `hunks.ts` — stage / unstage / revert the change under a line (line diff + `git_write_index`, D66).
- `view.ts` — the source control sidebar view: message box, Commit, sections with hover actions.
- `commands.ts` — every action as a command.

**Commands:** `git.showView` (Ctrl+Shift+G), `git.status` (core tool), `git.refresh`, `git.init`,
`git.stage`, `git.unstage`, `git.discard` (confirms), `git.stageChange`, `git.unstageChange`,
`git.revertChange`, `git.commit` (Ctrl/Cmd+Enter in the message box), `git.checkout` (picker,
create branch), `git.branches`, `git.log`, `git.fetch`, `git.pull` (ff-only), `git.push`,
`git.sync`. The diff tab is the editor's (`editor.openDiff`). `git.trustSettings` (D392): the
IDE's git pauses for a repository whose git settings changed after an agent's sandboxed command
ran there (`src-tauri/src/git/guard.rs`); the view says why and offers it; a person only.
**Status bar:** branch (`*` when dirty; opens the picker), sync (↓behind ↑ahead, Publish).
**State:** `ide://git/status`, `ide://git/problem` (why there's none, `paused`).

Stash (`stash.ts`, D122): `git.stash`, `git.stashIncludeUntracked`, `git.stashList`, `git.stashPop`,
`git.stashApply`, `git.stashDrop`.

Clone and blame (`cloneBlame.ts`, D120): `git.clone` (URL + parent folder, progress, open; D121:
`owner/repo` → GitHub https so public repositories need no sign-in, error hints, and
`git.defaultCloneDirectory`) and the
status bar's blame of the cursor line (`git.blameLine`, setting `git.blame.statusBarItem.enabled`).
`git.toggleInlineBlame` shows it as faint text at the end of the line instead
(`git.blame.editorDecoration.enabled`, off by default).

File history (`fileHistory.ts`, D127): `git.fileHistory` lists the commits that changed a file
(the active editor's by default) and opens one ↔ the file now in a diff tab. The Timeline under
the Explorer shows the same commits next to local history (`extensions/history`, D196).

Workflow (`workflow.ts`, D137): `git.showCommit` (message + files; a file opens as parent ↔ commit,
the diff tab's `head` side), `git.openCommitFile`, commit variants (`git.commitStaged`,
`git.commitAll`, `git.commitAmend`, `git.commitAndPush`, `git.commitAndSync`),
`git.undoLastCommit`, branches (`git.createBranchFrom`, `git.renameBranch`, `git.deleteBranch`,
`git.merge`, `git.rebase`), an operation in progress (`git.continueOperation`,
`git.abortOperation`; the view's banner), `git.cherryPick`, `git.revertCommit`,
`git.checkoutCommit`, tags (`git.createTag`, `git.deleteTag`, `git.pushTags`), remotes
(`git.addRemote`, `git.removeRemote`), `git.ignore`, `git.generateCommitMessage` (the user's
model, from the staged diff, only when pressed; `git.aiCommitMessage.enabled`, on by default,
D173; `commitMessage.ts` builds the request and turns a review-like reply into a message (a themes line and up to 12 bullets, the diff
shared out per file with its hunk contexts, D201), the
button stops it (`git.cancelCommitMessage`), its own model `git.aiCommitMessage.model`, D174), `git.pullRebase` / `git.pullMerge` (Pull offers them when the
branches diverged), `git.pushForce` (with lease, confirms). Rust: `ops::repo_op` (fixed argument
lists), `commit_detail`, `log_range`, `diff_text`, `operation`; `git_repo_state` (remotes, tags,
operation) refreshes with the status. The view's **Graph** section (D148) lists incoming and
recent commits (outgoing marked) and expands them to their files.

Graph and publish (D148):
- `refs.ts` (tested): refs → VS Code's badges (current branch, branches, remotes — compact beside
  their local twin — tags), a remote URL → its web page and a commit's URL there, initials and a
  color per author, repository names for publishing.
- `graphHover.ts`: the badges and the commit hover card (`ui/HoverCard`): author, date, message,
  files and lines changed (`CommitDetail.insertions` / `deletions`), refs, hash, Open on GitHub.
- The Graph row: branch filter (Auto / All), `git.revealHeadInGraph`, fetch, pull, push, show
  commit, refresh; `git.graphShowMore` pages 50 more.
- The primary button runs `git.sync` as Publish branch / Sync changes when nothing is pending.
- `publish.ts` — `git.publish`: init, a first commit (node_modules ignored first), `gh repo create
  --source=. --remote=origin --push` (Rust `github.rs` op `repoCreate`, name checked); with a
  remote already it pushes the branch. `git.sync` publishes when there's no remote. The empty
  state offers it next to Initialize. UI tests use `tests/fixtures/fake-gh` (`"fakeGh": true`).

Graph, rebase, worktrees, GitHub, sign-in (D139):
- `graph.ts` — commit graph lanes from the parents (DOM-free, tested); `graphSvg.ts` draws one SVG per
  Graph row from `git_graph` (HEAD + upstream, or `--all` with `git.graph.allBranches`;
  `git.toggleGraphAllBranches`, setting `git.graph.enabled`).
- `rebase.ts` — `git.rebaseInteractive` and its `gitRebase` tab (pick / reword / edit / squash /
  fixup / drop, reorder); Rust `git/rebase.rs` runs the list as written.
- `worktrees.ts` — `git.worktrees`, `git.createWorktree`, `git.deleteWorktree`,
  `git.pruneWorktrees`; opening in a new window uses `workbench.newWindow`'s `app_new_window`.
- `github.ts` — `github.pullRequests`, `github.openPullRequest` (the `githubPullRequest` tab),
  `github.checkoutPullRequest`, `github.createPullRequest`, `github.mergePullRequest`,
  `github.issues`, `github.authStatus`; the status bar's pull request item
  (`github.statusBar.enabled`). Through the `gh` CLI (Rust `git/github.rs`).
- `askpass.ts` — answers git's / ssh's sign-in prompts in the quick input (Rust `git/askpass.rs`).

The Graph header's less-used actions are under its "…" (D193). `git_diff_range` gives a range's
diff for reviews (`agent.reviewChanges`).

D204 (m7.5):
- **Several repositories** (`repositories.ts`, `repoPaths.ts` tested): `GitRepositories` holds the
  workspace's `GitController` plus one per repository found inside the folder (Rust
  `git_discover`: nested folders with their own `.git` down to `git.repositoryScanMaxDepth`
  (default 1, `git.repositoryScanIgnoredFolders`), submodules from `git submodule status`
  (`git.detectSubmodules`, at most 10)). A path belongs to the deepest repository containing it
  (decorations, change bars, staging, blame, file history route by it). One is *selected* (it
  follows the active editor's file, or a click in the view's Repositories list,
  `git.selectRepository`); `repos.current` is a `GitRepo` whose signals follow the selection, so
  the view, status bar and the modules that act on "the repository" use it. Every Rust git command
  takes `repo` (a root `git_discover` found, else refused); TS `createGitIpc(root)` /
  `createGithubIpc(root)`. Commands in `commands.ts` and `stash.ts` take `repository` (root,
  relative path or folder name); `git.repositories` lists them; `ide://git/repositories`.
- **Multi-root workspaces (D251):** `git_discover` also returns each other folder's repository
  (kind `folder`) and the nested ones and submodules inside every folder, so they're listed and
  routed like nested repositories; discovery reruns on `workspace.onDidChangeFolders` (a removed
  folder's repositories go). A folder's repository is named by the folder (`repositoryFolderName`);
  paths in pickers, `ide://git/repositories` (plus `folder`), `ide://git/status`, file history and
  the lens go through `workspace.relative` / `workspace.resolve` (the folder's name first);
  `repository` may be a workspace folder's name (`matchRepository`). `git.init {folder?}` creates a
  repository in a workspace folder: with several, the one without (the active editor's, else
  picked; `foldersWithoutRepository`). `git.publish` still publishes the first folder only.
- **Merge editor stage texts:** the `gitStage:<n>` content source (`fileHistory.ts`) is `git show
  :n:path` (1 base, 2 ours, 3 theirs) for the editor's merge editor (`editor/mergeView.ts`,
  `git.openMergeEditor`); a conflicted row has "Resolve in merge editor".
- **GitLens basics:** moved into the bundled Git tools extension in D208 (below). `git.stashShow`
  (a stash's files, stash^1 ↔ stash) stays here with the other stash commands. Rust `git/lens.rs`.
- **GitHub review** (`githubReview.ts`, the user's `gh`): `github.pullRequestFiles {number?,
  repository?}` (a `githubPullRequestFiles` tab that remembers its repository and refreshes from it: files, review threads with Reply / Resolve / Go to line),
  `github.openPullRequestFile` (merge base ↔ head, the `ghpr:<sha>` content source: local
  commit, else `gh api …/contents`), `github.replyToReviewThread`, `github.resolveReviewThread`,
  `github.addReviewComment`, review marks in the margin of the checked-out PR branch's files
  (`gutterMarks` owner `github.review`); `ide://github/review`. (Notifications moved to Git tools
  in D208.)

D208 (m7.6.1): the GitLens-style features are the bundled **Git tools** extension
(`src-tauri/bundled-extensions/gittools`, on by default, can be turned off or uninstalled) —
`git.toggleFileBlame`, `git.lineHistory`, `git.compareBranches`, `git.compareSwap`,
`git.showStashes`, the Stashes / Line history / Compare / GitHub notifications sections,
`github.notifications`, `github.markNotificationRead`, `github.markAllNotificationsRead`,
`github.openNotification`, the settings `git.blame.heatmap` and `github.notifications.enabled`,
`ide://git/lens`, `ide://git/fileBlame`, `ide://github/notifications`. What it builds on lives here:
- `access.ts` — provides `services.gitAccess` (`workbench/gitAccess.ts`): the repositories, blame
  (parsed by `lens.ts`), `git log -L` (parsed), the files between refs, rev-parse, merge-base,
  refs, stashes, a file at a revision, a change signal per repository, and `gh` notifications —
  all routed like the git commands. The extensions host serves it as `ide.git` / `ide.github`
  (`extensions/runtimeGit.ts`, "git" / "github" permissions).
- `lens.ts` (tested) keeps the porcelain and log parsers and the review threads; the annotation
  layout (author, age, heat) is the extension's (`exports.model`, `gittools.test.ts`).

D200: `autofetch.ts` (`git.autofetch`, `git.autofetchPeriod`; every repository, one after another
since D207; quiet, a repository whose fetch failed is skipped until a fetch, pull or push of yours); `git.stageSelectedRanges {path?, from?, to?}` (`hunks.ts` `stageLines`, the lines'
changes only, `core/diff` `applySelectedLines`); `git.quickDiffBase` (`index`, `head`,
`mergeBase`: the change bars against `git merge-base HEAD <default branch>`, Rust
`git_merge_base`, cached per state of the refs); `git.enableCommitSigning` / `git.alwaysSignOff`
(`-S` / `--signoff` on commit).

The Graph as its own section (D210):
- `graphCommands.ts` registers `scm.graph`, a view that's always a section of `scm.view`
  (`sectionOnly`, `sectionOrder` 0: below Changes, above the Git tools extension's sections; open,
  300 px by default; size and collapsed state kept per workspace like every section; resized with
  its sash or `view.resizeSection`). Header buttons: the branch filter (`git.graphFilter`, a menu
  of Auto / All), `git.revealHeadInGraph`, `git.fetch`, `git.pull`, `git.push`, `git.refresh`;
  `git.graphShowMore`. State: `ide://git/graph` (shown, filter, commits listed, the sync rows'
  counts).
- `graphView.ts` — the section's tree (moved out of `view.ts`): commits with lanes, refs, hover
  cards and menus; VS Code's **Outgoing changes** row just above HEAD (commits to push, dashed
  node) and **Incoming changes** row just above where the branch and its upstream forked
  (commits to pull), each with its count, expanding to the files they change together.
  `git.showOutgoingChanges` / `git.showIncomingChanges` list the commits and files (`path`:
  open that file's diff from the fork; from the palette, pick one).
- `graph.ts` (tested): VS Code's lane colors (`labelColor`: the current branch's ref "ref" and its
  upstream "remote" color the lane from that commit down; other lanes keep their color or take
  the next of five) and `withSyncChanges` (the two synthetic rows). `graphSvg.ts` draws a row.
  Tokens: `--scm-graph-ref`, `--scm-graph-remote`, `--scm-graph-tag`, `--scm-graph-lane-0…4`
  (dark and light; VS Code themes' `scmGraph.*` map onto them). Ref chips by kind: local blue,
  remote purple (filled, with the current branch), tags yellow.

D220 (m7.7):
- **Status from the file watcher:** the file index's watcher (Rust `index`, `index_watch`) sends
  each batch of files changed on disk (`.git` left out) to `GitRepositories`, which routes them
  (`repoPaths.ts` `repositoriesTouched`) to the repositories they're in; each reads `git status`
  once they've been quiet for 1 s (`GitController.changedOnDisk`). The poll is a fallback: a
  minute while watched, 5 s without a watcher (`statusPollMs`). `ide://git/status` `watched`.
  The listener is registered one call at a time (D280: two in flight left Rust with a muted one).
- **Autofetch** restarts only when `git.autofetch` / `git.autofetchPeriod` change
  (`restartsAutofetch`).
- **"multiple" mode** (`scm.repositories.selectionMode`, VS Code's; default "single"): every
  repository's changes in the one tree, each under a row of its own (a click selects it: the
  message box commits there); group actions pass their repository.
- **`repository` on the remaining commands** (`workflow.ts`, `rebase.ts`, `worktrees.ts`,
  `github.ts`): without it, the user picks one when there are several (`repos.choose`, VS Code's
  "Choose a repository", the selected first); agents get the selected one. The views pass their
  repository, so their buttons never ask. The rebase and pull request tabs keep theirs.
  `git.sync` takes `repository` too. Review commands (`githubReview.ts`) called with only a
  number use the repository of the pull request under review, else the selected one.
- **Graph:** the base branch (`RepoState.baseBranch`: origin's HEAD, else main / master) is in
  the Auto listing and colored orange (`--scm-graph-base`, lane "base"); in All branches mode ref
  chips take their lane's color (`refChipColor`); the filter button shows "Auto" / "All"
  (`ViewAction.label`).

D229 (m7.8):
- **Conflict kinds** (`model.ts`, tested): a conflicted file carries git's unmerged state
  (`conflict`: bothModified, bothAdded, bothDeleted, addedByUs, addedByThem, deletedByUs,
  deletedByThem) and VS Code's letter (! / A / D, all in the conflict color; tooltip "Conflict:
  deleted by us"). "Resolve in merge editor" only where it resolves something (two versions, or
  delete / modify); both deleted and added-by-one-side (git's rename / rename) are resolved by
  staging. `git.stage` of a delete / modify conflict asks Keep our / their version or Delete file
  (VS Code's); other callers pass `deletion: "keep" | "delete"` (deleted to the app trash, then
  staged). `ide://git/status` and `git.status` list `conflict`.
- **"multiple" mode** (`commitForm.ts`, `repoPaths.ts` `shownRepositories`): a commit box per shown
  repository (VS Code's input per repository; focusing one selects its repository, so
  Ctrl/Cmd+Enter commits there), and the Repositories list stays with a checkbox per repository
  choosing which ones the tree and the boxes show (`git.toggleRepositoryShown {repository,
  shown?}`, kept with the folder's state, one always shown; `ide://git/repositories` `shown`).
  `commitForm.ts` is the commit box (banner, message, Commit and its menu) for both modes.
- **Multi-file diffs** (`changesTab.ts`, tested; the tab is the editor's `multiDiff`):
  `git.viewChanges` / `git.viewStagedChanges` (the Changes / Staged changes rows' "View all
  changes"), `git.openCommitChanges {commit}` (a Graph commit's Open changes), and
  `git.showIncomingChanges` / `git.showOutgoingChanges` `{all: true}` (the Graph's Incoming /
  Outgoing rows' Open changes).
- **The Graph's speed (D233):** a commit's files come from one `git diff --name-status` against
  its first parent (`commitFilesQuery`), not its detail, which also diffs every file's content for
  the line counts (a 504-file commit: 0.52–0.68 s before, 0.09 s now); details and file lists are
  cached per commit (`PromiseCache`, 200 each, tested), so the hover card no longer runs git
  each time. Rows are virtualized (`ui/Tree`); the sticky rows read only the rows near the top
  instead of copying every row per frame. The list pages 50 commits at a time, the next page
  when its end scrolls into view (`git.graph.pageOnScroll`, VS Code's), up to 10,000 commits. The
  Graph is movable (`movable`): `view.moveView` puts it in a dock tab.
- **The changes tabs follow the status** (`multiDiffFollow.ts`, tested): an open Changes /
  Staged changes tab is listed again when the repository's status changes (300 ms debounce),
  through `editor.openMultiDiff {…, background: true}` (D233), which updates it without
  activating it and keeps the file at the top of the view, folds, unsaved edits and the focus.
  Next / previous file are the editor's (`editor.multiDiff.nextFile` / `previousFile`).
