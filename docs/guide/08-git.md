# Source control

Git is built into the IDE. It runs the `git` on your PATH, so your config, hooks, aliases and
credential helper apply as they do in a terminal. This page covers cloning, the **Source
control** view, staging and committing, branches, syncing with a remote, the Graph, history and
blame, merge conflicts, interactive rebase, worktrees, several repositories in one folder and
GitHub.

## Before you start

- Install [Git](https://git-scm.com). On Windows, Git for Windows also brings Git Bash and Git
  Credential Manager, which remembers your sign-ins.
- For the GitHub features (publishing, pull requests, issues, notifications), install the
  [GitHub CLI](https://cli.github.com) and sign in (see [Sign in to GitHub](#sign-in-to-github)).
- Open the **Source control** view with Ctrl+Shift+G, the branch icon in the activity bar, or
  **View → Source control**. [Show source control](command:git.showView)

The **Git** menu in the title bar holds the everyday actions at the top (Commit, Stage all
changes, Unstage all changes, Discard all changes…, Pull, Push, Fetch, Sync) and the rest in
the **Branch**, **Stash**, **History** and **GitHub** submenus.

## Clone a repository

1. Run **Clone repository…** from the **Git** menu, the Welcome page or the Command Palette.
   [Clone a repository](command:git.clone)
2. Type the address: an `https://` or `git@…` URL, a local path, or just `owner/repo` for a
   GitHub repository (it becomes the `https` address, so a public repository needs no sign-in).
3. Pick the folder to clone into. A new subfolder is made there. The picker starts in
   `git.defaultCloneDirectory` when you set it, else in the last folder you used.
4. Progress shows in the status bar. When it's done, **Open** in the notification opens the
   clone.

## Initialize or publish a repository

A folder without a repository shows **No repository** in Source control, with two buttons:

- **Initialize repository** runs `git init`. In a workspace with several folders it asks which
  folder (the ones without a repository).
- **Publish to GitHub** asks for a name (the folder's by default) and private or public, then
  initializes git, adds `node_modules` to `.gitignore` if there is one, commits your files as the
  first commit, creates the repository on GitHub, adds it as `origin` and pushes. It uses the
  GitHub CLI; if you aren't signed in yet, it offers to sign in first.

A repository without a remote publishes the same way: the status bar's **Publish** item, the
**Publish to GitHub** button in Source control, or **Git: Publish to GitHub** in the Command
Palette. A branch that has no upstream on an existing remote shows **Publish branch** instead,
which pushes it and tracks it.

## The Source control view

From top to bottom, Source control shows:

- **Repositories**, when the folder holds more than one (see
  [Several repositories](#several-repositories)).
- The **commit box**: the message box, the **Commit** button and the arrow next to it.
- The changes, in up to three groups: **Merge changes** (conflicted files, during a merge,
  rebase or cherry-pick), **Staged changes** and **Changes** (unstaged and untracked files).
- The **Graph** section, the history of the branch (see [The Graph](#the-graph)).
- The sections of the bundled **Git tools** extension: **Stashes**, **Line history**,
  **Compare** and **GitHub notifications** (see [Git tools](#the-git-tools-extension)).

Drag the edge above a section to give it more or less room, and click its title to fold it. The
sizes and folds are kept per folder. Right-click the activity bar to give a Git tools section its
own icon.

Each file shows a status letter: M modified, A added, D deleted, R renamed, U untracked, and in
the conflict color ! (both modified), A (added) or D (deleted) for a conflict. The same colors
and letters mark the files in the Explorer and their editor tabs. The Source control icon in the
activity bar counts the pending changes.

Source control notices files you change outside the IDE (in a terminal, another editor, a build)
within about a second, through the folder's file watcher. **Refresh** in the view's title bar
reads the repository again.

### Status bar

| Item | What it shows | Click |
|---|---|---|
| Branch | The current branch, with `*` when there are uncommitted changes (a short hash and "(detached)" on a detached HEAD) | Checkout branch… |
| Sync | ↓ commits to pull and ↑ commits to push, **Publish** for a branch without an upstream, or the running operation | Sync (pull, then push) |
| Pull request | The current branch's GitHub pull request number, marked when its checks fail or are pending | Opens it |
| Blame | Who last changed the cursor's line, and when | Shows the commit in a notification, with **Copy hash** |

## Stage changes

Hover a file in the list for its buttons: **Open changes**, **Open file**, **Stage changes**
(+), **Unstage changes** (−) and **Discard changes**. Click the file itself to open its diff.
The group titles have the same actions for every file: **Stage all changes**, **Unstage all
changes**, **Discard all changes**, and **View all changes** / **View staged changes**, which
open every file's diff in one tab (see [Multi-file diff](#multi-file-diff)).

Right-click a file for more: **Reveal in explorer** and, for an untracked file, **Add to
.gitignore** (it adds the path to the repository's `.gitignore`).

> **Note:** Discarding throws away the working-tree changes of the file: a tracked file goes back
> to its staged or committed text, and an untracked file is deleted. The IDE asks first.

### Stage a single change or selected lines

You don't have to stage a whole file:

- **A single change:** right-click a changed line in the editor (the lines with a change bar in
  the gutter) and choose **Stage change** or **Revert change**. Unsaved edits count, and a revert
  is one undoable edit.
- **Selected lines:** select some lines and run **Stage selected lines** (Command Palette, or the
  same right-click menu). Only the changes on those lines are staged; a partly selected change
  stages just its selected new lines, as VS Code's "Stage selected ranges" does.
- **Unstage change** takes one change back out of the index.

## Commit

1. Stage the changes you want in the commit (or none: see below).
2. Type the message in the message box. The first line is the summary.
3. Press Ctrl+Enter in the message box, or click **Commit**.

With nothing staged, **Commit** commits every change to tracked files, as VS Code's smart commit
does. **Commit staged** never does that.

### Commit options

The arrow next to **Commit** has the other ways to commit:

| Item | What it does |
|---|---|
| Commit | Commits what is staged, or all tracked changes when nothing is |
| Commit staged | Commits only what is staged |
| Commit all | Stages all tracked changes, then commits |
| Commit (amend) | Rewrites the last commit with what is staged; the message box's text replaces its message (leave it empty to keep the old one) |
| Commit & push | Commits, then pushes |
| Commit & sync | Commits, then pulls and pushes |
| Undo last commit | `git reset --soft HEAD~1`: the commit's changes are staged again and its message goes back into the message box |
| Generate commit message | Writes the message with your model (see below) |

When there is nothing to commit, the button changes: **Publish branch** (or **Publish to
GitHub**) for a branch that isn't on a remote yet, and **Sync changes** with the counts of
commits to pull and to push when your branch is behind or ahead of its upstream.

### Generate a commit message

The sparkle button in the message box writes the message from your staged changes with your
model: a first line naming what the commit is about, then a short list of the concrete changes,
in the style of your recent commit messages. Press it again to stop. With nothing staged, it
offers to stage everything first (**Stage all and continue**). Edit the result before committing,
like any message you wrote.

It runs only when you press it. Choose its model on the **AI models** page or with
`git.aiCommitMessage.model` (empty: the agent's model), and turn the button off with
`git.aiCommitMessage.enabled`.

### Sign-off and signing

- `git.alwaysSignOff` adds a `Signed-off-by:` line to every commit (`git commit --signoff`).
- `git.enableCommitSigning` signs commits with your configured GPG or SSH key (`git commit -S`).
  Git's own `commit.gpgsign` setting works too, without it.

## Branches

- **Switch:** click the branch in the status bar, or run **Checkout branch…**. The list has your
  local branches and the remote ones (picking `origin/feature` creates a local branch that
  tracks it), most recently committed first.
- **Create:** **Create new branch…** at the top of the same list starts a branch from the current
  commit. **Create branch from…** starts it from another branch or commit.
- **Rename branch…** and **Delete branch…**. Deleting a branch that isn't merged asks first.
- **Merge branch…** merges another branch into the current one; **Rebase branch…** rebases the
  current branch onto another. If they stop on conflicts, see
  [Merge conflicts](#merge-conflicts).
- **Cherry-pick commit…**, **Revert commit…** and **Checkout commit (detached)…** pick a commit
  from the history (they are also in a commit's menu in the Graph).

## Sync with a remote

| Command | What it does |
|---|---|
| Fetch | `git fetch --prune`: updates the remote branches and the ahead / behind counts |
| Pull | Pulls the upstream, fast-forward only |
| Pull (rebase) | `git pull --rebase` |
| Pull (merge) | `git pull --no-rebase` |
| Push | Pushes the current branch; the first push of a new branch publishes it (sets its upstream) |
| Push (force with lease) | Replaces the remote branch with yours, refused if the remote has commits you haven't fetched; asks first |
| Push tags | Pushes all tags |
| Sync (pull, then push) | Pulls when behind, then pushes when ahead; publishes when there's no remote |

Push, pull and fetch are in the **Git** menu, the view's title bar and the Graph's header; the
status bar's sync item runs Sync. When your branch and its upstream have both moved on, Pull
asks how to reconcile them: **Rebase** or **Merge**.

### Autofetch

Turn on `git.autofetch` to fetch every `git.autofetchPeriod` seconds (180 by default, at least
30), so the behind count stays current. It's quiet, and every repository in the folder is
fetched, one after another. A repository whose fetch failed (a sign-in that didn't work, for
example) is skipped until you fetch, pull or push it yourself.

### Signing in to a remote

On Windows, Git Credential Manager (part of Git for Windows) usually answers git's sign-in
questions. When no credential helper answers, the IDE asks for the username and the password or
token, and for ssh key passphrases, in the command box (secrets are masked; Escape cancels).
Nothing is stored: set up a credential helper, or run `gh auth setup-git`, to remember them.

> **Tip:** GitHub asks for a personal access token, not your account password, when it asks for
> a password over `https`.

## Remotes and tags

- **Add remote…** (`origin` by default) and **Remove remote…**.
- **Create tag…** tags the current commit; give it a message for an annotated tag. **Delete
  tag…** deletes a local tag. **Push tags** pushes them all.

## Stashes

Stash your changes to get a clean working tree for a moment, then bring them back:

| Command | What it does |
|---|---|
| Stash changes… | Stashes your changes, with an optional message |
| Stash (include untracked)… | Also stashes untracked files |
| Pop stash… | Applies a stash and removes it |
| Apply stash… | Applies a stash and keeps it |
| Drop stash… | Deletes a stash |
| Show stash… | Lists a stash's files; each opens its change |

They are in **Git → Stash**. The **Stashes** section of Source control (from the Git tools
extension) lists the stashes: expand one to its files, and hover it for **Apply**, **Pop** and
**Drop**. **Stash changes…** in the section's header stashes your changes.

## The Graph

The **Graph** section lists the branch's history, newest first, with lines for branches and
merges, as VS Code's Source Control Graph does.

### Read the graph

- **Lines:** the current branch's line is blue down to where its upstream is, purple below. The
  branch you compare against (the remote's default branch, usually `origin/main`) is orange.
  Other branches take their own colors.
- **Badges:** local branches are blue (the current one in bold), remote branches purple with a
  cloud, tags yellow. A remote branch on the same commit as its local branch shows compactly
  beside it. In **All branches** mode each badge takes its line's color.
- **Hover a commit** for its card: author, when, the whole message, the files and lines changed,
  branches and tags, the hash (click to copy it), **Open on GitHub** (or GitLab, Bitbucket,
  Codeberg) and **Show changes**.
- **Expand a commit** to see its files; click one for that commit's change of it.
- The next 50 commits load when you scroll to the end (`git.graph.pageOnScroll`); **Show more
  commits in the graph** does it by hand.

The header's buttons (on hover):

| Button | What it does |
|---|---|
| **Auto** / **All** | The branch filter: the current branch with its upstream (Auto), or every branch, tag and remote branch (All, setting `git.graph.allBranches`) |
| Go to the current commit | Scrolls to HEAD |
| Fetch, Pull, Push | As in the Git menu |
| Refresh | Reads the history again |

Turn the lines off with `git.graph.enabled`.

### Incoming and outgoing changes

When you have commits to push, an **Outgoing changes** row (a dashed circle, with a count)
appears at the top. When there are commits to pull, an **Incoming changes** row appears above the
point where your branch and its upstream forked. Expand either to see the files those commits
change; click a file for its diff. **Open changes** on the row opens all of them in one tab, and
**Sync changes** pulls and pushes. **Show outgoing changes…** and **Show incoming changes…** in
the Command Palette do the same.

### Commit actions

Right-click a commit to:

- **Open changes** (all its files in one tab) or **Show commit…**
- **Copy commit hash** or **Copy commit message**
- **Open on GitHub** (or the site the remote is on)
- **Checkout (detached)** or **Create branch from commit…**
- **Cherry-pick** or **Revert commit**
- **Interactive rebase from here…**
- **Undo last commit** (on the last commit)

### Move the Graph

Drag the Graph's header onto the editor area, or right-click it and choose **Move to the dock**
(or run **Move view**), to give it a tab of its own. Drag the tab back onto the sidebar, use its
**Move back to the sidebar** button, or close it, to put it back. Where it is is kept per folder.

## View changes

### Change bars in the editor

The editor's gutter shows a bar beside lines added, modified or deleted. Click a bar to open the
diff at that line. **Go → Next change** (Alt+F3) and **Go → Previous change** (Shift+Alt+F3)
move between them.

`git.quickDiffBase` chooses what the bars compare with:

| Value | The bars show |
|---|---|
| `index` (default) | Unstaged changes, as VS Code |
| `head` | Every uncommitted change, staged or not |
| `mergeBase` | Everything since your branch left the default branch: what a pull request shows |

### Multi-file diff

**View all changes** (on the Changes group), **View staged changes** (on Staged changes), a
commit's **Open changes**, and the Graph's incoming and outgoing rows open one tab with a
collapsible diff per file, as VS Code's multi-diff editor. Working-tree files are editable in
place. Ctrl+Alt+PageDown and Ctrl+Alt+PageUp go to the next and previous file. An open Changes
or Staged changes tab follows the repository: it updates when the status changes, keeping your
place, folds and unsaved edits.

## History and blame

### Blame

- **Status bar:** the cursor line's last change (author and age) shows in the status bar; click
  it for the commit, with **Copy hash**. `git.blame.statusBarItem.enabled` turns it off. **Show
  who changed this line** does the same from the Command Palette.
- **Inline:** **Toggle inline blame** shows it as faint text at the end of the cursor's line
  instead (`git.blame.editorDecoration.enabled`, off by default).
- **The whole file:** **Toggle file blame** (from Git tools) shows who last changed every line
  and how long ago, beside the lines; newer changes are brighter (`git.blame.heatmap`). Hover an
  annotation for the commit. Unsaved lines read "Not committed yet".

### File history and the Timeline

**Show file history** (**Git → History**) lists the commits that changed the active editor's
file; pick one to compare that version with the file now. The **Timeline** section at the bottom
of the Explorer shows the same commits next to the file's local history.

### Line history

Select some lines and run **Show line history** (from Git tools): the **Line history** section
lists every commit that changed those lines (`git log -L`), newest first. Click a commit to open
its change of the file.

### Show a commit

**Show commit…** (or **Git → History → Show git log**) picks any recent commit and shows its
message and files; a file opens as a diff between the commit's parent and the commit.
[Show a commit](command:git.showCommit)

### Compare branches

**Compare branches…** (from Git tools) asks for two branches, tags or commits and lists the files
that differ in the **Compare** section; click one for its diff. **Swap sides** in the section's
header compares the other way round. [Compare branches](command:git.compareBranches)

## Merge conflicts

When a merge, rebase, pull, cherry-pick or revert stops on conflicts, Source control shows a
banner with the operation and the number of conflicts left, and the conflicted files under
**Merge changes**.

### Resolve in the file

Above each conflict in the editor, choose **Accept current change** (yours), **Accept incoming
change** (the branch you're bringing in), **Accept both changes**, or **Resolve in merge
editor**. Then stage the file.

### The merge editor

Click **Resolve in merge editor** on a conflicted file in Source control (or above a conflict in
the file). The merge editor shows **Incoming** and **Current** side by side and the **Result**
below.

- For each conflict choose **Accept incoming**, **Accept current**, **Accept both** or
  **Ignore**, or type in the Result yourself. **Accept all** in the Incoming or Current header
  takes that side for every conflict.
- "1 of 3 conflicts left" counts down; the arrows (**Previous conflict**, **Next conflict**)
  jump between them.
- **Show base** adds the common ancestor; the words each side changed are highlighted.
- Drag the bars between the panes to resize them (double-click to even them out). The sizes are
  kept for each file.
- **Reset** starts the result over.
- **Complete merge** saves the result and stages the file. With conflicts still unhandled, it
  asks first (the result keeps the base text there).

A file both branches added opens in the merge editor too: with no common base, the lines both
versions share are kept and every place where they differ is a conflict.

When one side deleted the file and the other changed it, the merge editor shows the changed
version with **Keep the file** and **Delete the file**; either choice is staged. Staging such a
file from Source control asks the same: **Keep our version** (or **Keep their version**) or
**Delete file**. A file both sides deleted, or one only one side added, is resolved by staging
it.

### Continue or abort

Once every conflict is staged, click **Continue** in the banner (or run **Continue merge /
rebase**). **Abort** (**Abort merge / rebase**) goes back to where you were before it started.

## Interactive rebase

Rewrite a series of commits (reorder, reword, squash, drop) in a tab instead of a text file:

1. Run **Interactive rebase…** (**Git → Branch**), or **Interactive rebase from here…** on a
   commit in the Graph. [Interactive rebase](command:git.rebaseInteractive)
2. Pick the base: **The n commits not pushed yet**, a commit from the history, or **All commits
   (from the first)**.
3. The tab lists the commits after the base, oldest first (the order git replays them). Choose an
   action for each:

   | Action | Key | What it does |
   |---|---|---|
   | pick | P | Keeps the commit |
   | reword | R | Keeps it with a new message (type it right there) |
   | edit | E | Stops after it so you can amend it |
   | squash | S | Folds it into the one above, combining the messages |
   | fixup | F | Folds it into the one above, keeping that one's message |
   | drop | D | Removes the commit |

4. Drag rows by their grip, or press Alt+Up / Alt+Down, to reorder them.
5. Click **Start rebase**.

If the rebase stops on a conflict or an **edit**, finish with **Continue** or **Abort** in Source
control. The old commits stay reachable in git's reflog.

## Worktrees

A worktree is another branch checked out in a folder of its own: work on a hotfix or review a
branch without stashing what you're doing.

1. Run **Create worktree…** (**Git → Branch**).
2. Choose **New branch…** (it starts from the current commit) or an existing branch.
3. Confirm the folder. It goes next to the repository, named after the branch, by default.
4. Choose **Open in a new window**, **Open in this window** or **Don't open**.

**Worktrees…** lists them; pick one to open it here or in a new window. **Delete worktree…**
removes one (its folder; the branch stays), and refuses one with uncommitted changes unless you
confirm. **Prune worktrees** forgets worktrees whose folders you deleted by hand.

## Several repositories

A folder that holds other repositories (a nested checkout, submodules), or a workspace with
several folders, lists them under **Repositories** at the top of Source control. Click one to see
its changes, branch and commit box; the one your open file belongs to is selected for you. The
status bar, blame, change bars, staging and file history always use the repository a file is in.

- `git.repositoryScanMaxDepth` sets how many folders deep to look (1 by default, 0 for none), and
  `git.repositoryScanIgnoredFolders` which folders never to look into (`node_modules`).
- `git.detectSubmodules` lists the repository's submodules (up to 10).
- Set `scm.repositories.selectionMode` to `multiple` to see every repository's changes in one
  list, each under its own row with its own commit box. A checkbox per repository in the
  Repositories list chooses which ones are shown.
- Commands such as **Merge branch…**, **Create worktree…** or **Pull requests…** ask which
  repository when you run them from the Command Palette and there are several. The buttons in the
  view act on their own repository.

## GitHub

The GitHub features use the [GitHub CLI](https://cli.github.com) (`gh`) and your own sign-in;
the IDE stores no GitHub token of its own.

### Sign in to GitHub

Run `gh auth login` in a terminal, or use the **Accounts** menu (the person icon above the gear)
→ GitHub, which runs it for you. **Check GitHub sign-in** shows whether `gh` is installed and
signed in. To let git use the same sign-in for `https` remotes, run `gh auth setup-git`.

### Pull requests

The commands are in **Git → GitHub**:

| Command | What it does |
|---|---|
| Pull requests… | Lists the repository's pull requests and opens the one you pick in a tab |
| Create pull request… | Publishes your branch if needed, asks for a title (the last commit's subject by default), then **Create pull request** or **Create draft pull request** |
| Checkout pull request… | Checks out a pull request's branch (`gh pr checkout`) |
| Issues… | Lists the open issues and opens the one you pick on GitHub |

A pull request's tab shows its description, checks and comments, with **Checkout**, **Files
changed**, **Open on GitHub**, **Merge…** (**Create a merge commit**, **Squash and merge** or
**Rebase and merge**) and **Refresh**. The status bar shows the current branch's pull request
(`github.statusBar.enabled`). [Pull requests](command:github.pullRequests)

### Review a pull request

**Files changed** in a pull request's tab lists its files and review threads: open a file's diff
(merge base to head), **Reply** to a thread, **Resolve** it, or go to its line. When the pull
request's branch is checked out, its review threads mark their lines in the editor's margin.

### Notifications

The **GitHub notifications** section (from Git tools) lists your notifications, unread ones in
bold. Click one to open it on GitHub and mark it read; **Mark all as read** is in the section's
header. `github.notifications.enabled` turns the section off.

## The Git tools extension

**Git tools** ships with the IDE and is on from the start, like the GitLens extension in VS
Code. It adds file blame, line history, Compare, the Stashes section and GitHub notifications.
Turn it off or uninstall it in [Extensions](18-extensions.md) if you don't want them. Source
control itself (changes, commits, branches, the Graph, the cursor line's blame, file history,
merge conflicts, worktrees, the stash commands, pull requests and issues) is the IDE's own and
doesn't need it.

It's built only on the extension API, so a git extension of your own can do the same.

## Settings

| Setting | Default | Description |
|---|---|---|
| `git.autofetch` | `false` | Fetch every `git.autofetchPeriod` seconds |
| `git.autofetchPeriod` | `180` | Seconds between automatic fetches (at least 30) |
| `git.quickDiffBase` | `index` | What the editor's change bars compare with: `index`, `head` or `mergeBase` |
| `git.enableCommitSigning` | `false` | Sign commits with your GPG or SSH key |
| `git.alwaysSignOff` | `false` | Add a Signed-off-by line to every commit |
| `git.defaultCloneDirectory` | `""` | Where Clone repository starts looking for a folder |
| `git.blame.statusBarItem.enabled` | `true` | The cursor line's blame in the status bar |
| `git.blame.editorDecoration.enabled` | `false` | The cursor line's blame at the end of the line |
| `git.blame.heatmap` | `true` | Color the file blame by age (Git tools) |
| `git.aiCommitMessage.enabled` | `true` | The Generate commit message button |
| `git.aiCommitMessage.model` | `""` | Its model, as `provider/model`; empty: the agent's |
| `git.graph.enabled` | `true` | Draw the Graph's branch lines |
| `git.graph.allBranches` | `false` | The Graph shows every branch, not only the current one and its upstream |
| `git.graph.pageOnScroll` | `true` | Load more commits when you scroll to the Graph's end |
| `git.repositoryScanMaxDepth` | `1` | How deep to look for nested repositories (0–8) |
| `git.repositoryScanIgnoredFolders` | `["node_modules"]` | Folders never searched for repositories |
| `git.detectSubmodules` | `true` | List submodules (up to 10) |
| `scm.repositories.selectionMode` | `single` | `multiple`: every repository's changes in one list |
| `github.statusBar.enabled` | `true` | The current branch's pull request in the status bar |
| `github.notifications.enabled` | `true` | The GitHub notifications section (Git tools) |

## Next steps

- [Editing](04-editing.md): diffs, compare with saved and the editor's other tools.
- [Terminal](10-terminal.md): run git yourself, with suggestions for subcommands and branches.
- [The agent](05-agent.md): the agent can review your changes and use the same git commands.
- [Extensions](18-extensions.md): turn Git tools off, or add others.

## Common questions

### Why doesn't Source control see my repository?

The IDE needs `git` on your PATH: run `git --version` in a terminal. A repository more than one
folder below the open folder needs a larger `git.repositoryScanMaxDepth`. **Refresh source
control** looks again.

### How do I see what git ran?

**View: Show output** and pick the **Git** channel. Set the log level to Trace (**Developer: Set
log level**) to see every git call.

### Can I write commit messages in the IDE from the command line?

Yes. Install the shell command (see [Getting started](01-getting-started.md)), then
`git config --global core.editor "<name> --wait"`, where `<name>` is the IDE's command.

### Pull says the branches have diverged. What do I pick?

**Rebase** puts your new commits on top of the upstream's (a straight history); **Merge** makes a
merge commit. Either way, conflicts stop it and show in Source control.
