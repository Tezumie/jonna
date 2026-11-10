# TODO tree

A bundled example extension: every `TODO`, `FIXME`, `HACK`, `XXX`, `BUG` and `NOTE` comment in
the open folder, grouped by file (or by tag), in a sidebar view. Click one to jump to its line.

- View: `todoTree.view` in the sidebar.
- Commands: **TODO tree: Refresh** (`todoTree.refresh`), **TODO tree: List all**
  (`todoTree.list`, returns the items, handy for agents), **TODO tree: Go to a TODO…**
  (`todoTree.goTo`, a quick pick).
- Settings: `todoTree.tags`, `todoTree.exclude`, `todoTree.groupByTag`.
- Permission: `fs.read` (to search the folder).

It is an ordinary extension (see `extension.json` and `main.js`), so it doubles as a sample of
the extension API: a tree view, commands, settings, events and `ide.workspace.findText`.
