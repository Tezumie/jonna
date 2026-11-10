# extensions/history

Workspace undo/redo and local history (D86).

- **Workspace undo/redo** (`services.history`, `core/history`): explorer create, rename, move,
  copy, delete and import, replace all, accepted agent edits. `workspace.undo` / `workspace.redo`
  (Ctrl/Cmd+Z, Ctrl+Y / Cmd+Shift+Z with the sidebar focused, not in a text field); `edit.undo` /
  `edit.redo` (Edit menu) undo text in the focused editor, else the workspace. Undo refuses to
  overwrite a file that changed since and says so.
- **Local history** (Rust `history`): `history.list` (a file's versions, newest first),
  `history.show` ("Open timeline": pick a version → diff version ↔ file with Restore),
  `history.restore` (through the open editor when there is one, then saved).

Safeguards (D141): operations check before they change anything and reverse partial work;
failed steps stay on the stack (the warning's "Skip it" drops one); undoing or redoing a step
that deletes files asks first (`explorer.confirmUndo`); the trash never deletes for good;
Ctrl+Z in an editor right after a multi-file operation offers "Undo in N files"
(editor `workspaceUndo`).

**State:** `ide://history` (undo and redo stacks with labels, kinds, times and paths).
**Tests:** `core/history/history.test.ts`, `tests/scripts/history.jsonc`.

**Timeline (D196):** `timeline.ts` — the `timeline.view` sidebar view, hidden from the activity
bar by default so it's a collapsed section under the Explorer, with the active
file's local-history versions and its git commits, merged and grouped by day
(`core/history/timeline.ts`, tested); click compares with the file now, right-click restores a
version or copies a commit's hash. It refreshes on saves, outside changes and git commands.
Commands: `timeline.show`, `timeline.refresh`. State: `ide://timeline`. `labels.ts` has the
version labels both use.
