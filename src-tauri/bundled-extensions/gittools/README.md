# Git tools

GitLens-style extras for Source control, as an extension that comes with the IDE (D208). It's on
by default; turn it off or uninstall it in Extensions, and its sections and commands go away.
Source control itself — changes, staging, commits, branches, the Graph, the cursor line's blame
in the status bar or at the line's end, file history and the Timeline, merge conflicts and the
merge editor, several repositories, worktrees, the stash commands, GitHub pull requests and
issues — is the IDE's own and doesn't need it.

- **Toggle file blame** (`git.toggleFileBlame`): who last changed each line and how long ago,
  before the lines, colored by age (`git.blame.heatmap`); the hover has the commit. It blames the
  editor's text, so unsaved lines are "Not committed yet", and again after a save, a pause in
  typing, a commit or a checkout. `ide://git/fileBlame`.
- **Line history** (`git.lineHistory`): every commit that changed the selected lines
  (`git log -L`), in a Source control section; a commit opens its change of the file, Show commit
  on hover.
- **Compare** (`git.compareBranches`, `git.compareSwap`): two branches, tags or commits → the
  files that differ (or only what one changed since it forked, `mergeBase`) → each file's diff.
  `ide://git/lens`.
- **Stashes** (`git.showStashes`): the selected repository's stashes; expand one to its files
  (each opens its change), Apply / Pop / Drop on hover. They run the IDE's `git.stash*` commands.
- **GitHub notifications** (`github.notifications`, `github.markNotificationRead`,
  `github.markAllNotificationsRead`, `github.openNotification`): through your own `gh` sign-in;
  unread ones in bold, a click opens it on GitHub and marks it read
  (`github.notifications.enabled`). `ide://github/notifications`.

The sections sit at the bottom of Source control; the activity bar's menu can give each its own
icon instead.

**Permissions:** git (read-only access through `ide.git`, and the IDE's `git.*` commands),
GitHub (notifications through your `gh`), read files (the editor's text for blame, diffs) and
change files (applying a stash).

It's built only on the extension API (docs/extensions.md: `ide.git`, `ide.github`,
`ide.editor.setLineAnnotations`, tree views with row buttons and a message, `sectionOf`), so a
git extension of your own can do the same. `exports.model` in `main.js` is unit-tested in
`src/extensions/git/gittools.test.ts`.
