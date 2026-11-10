# Bundled extensions

Extensions that ship with the app but aren't part of it (D121): each folder here is an ordinary
third-party extension (`extension.json` + `main.js`, the worker API in `docs/extensions.md`).
On first start the backend copies each one into the installed extensions folder once
(`crate::extensions::ExtensionStore::seed_bundled`, files embedded with `include_str!`) and
marks it disabled, so there is always something in the Extensions view to turn on — except those
in `ENABLED_BY_DEFAULT` (Git tools, D208), seeded on with their permissions granted. The
registry's `bundled` list records what was seeded: uninstalling one keeps it uninstalled until
**Restore bundled extensions** (D183). An installed copy is rewritten whenever the shipped
files differ, so a change reaches users without a version bump.

- `todo-tree/` — TODO tree: every TODO / FIXME / HACK / XXX / BUG / NOTE comment in the folder,
  grouped by file, in a sidebar view (in the spirit of VS Code's "Todo Tree").
- `canvas/` — Canvas (D181): an infinite board of Markdown, file and link cards, groups and
  arrows, in `.canvas` files (JSON Canvas 1.0). It's a file viewer (`viewer.html`, `viewer.js`,
  `cards.js`, `geometry.js`, `menus.js`, `export.js`, `markdown.js`, `viewer.css`) plus commands the agent uses (`canvas.read`, `canvas.edit` with a
  list of ops, `canvas.focus`…). The model in `main.js` is unit-tested in
  `src/core/canvas/canvas.test.ts`.
- `jupyter/` — Jupyter kernels for notebooks (D203).
- `gittools/` — Git tools (D208), on by default: file blame, line history, compare, Stashes and
  GitHub notifications as Source control sections, on `ide.git` / `ide.github` /
  `ide.editor.setLineAnnotations`. It claims the `git` and `github` namespaces (`"namespaces"`, for
  the IDE's own extensions only) so the commands keep their ids. Model tested in
  `src/extensions/git/gittools.test.ts`.
