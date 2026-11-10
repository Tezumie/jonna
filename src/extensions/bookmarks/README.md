# extensions/bookmarks

Bookmarks (D143), like the popular Bookmarks extension. `store.ts` (tested) keeps them — path,
line, optional label — sorted by file and line. They follow edits (the editor's decorations move
them, reported through `services.gutterMarks`) and renames, and are saved per workspace. The
editor draws them in the glyph margin's right lane (`editor/gutterMarks.ts`), so a line can show
a breakpoint and a bookmark side by side.

**Commands:** `bookmarks.toggle {path?, line?, label?}` (Ctrl/Cmd+Alt+K), `bookmarks.toggleLabeled`,
`bookmarks.next` (Ctrl/Cmd+Alt+L), `bookmarks.previous` (Ctrl/Cmd+Alt+J), `bookmarks.list`
(Ctrl/Cmd+Alt+Shift+K; for agents, the list with each line's text), `bookmarks.clear {path?}`,
`bookmarks.clearFile`. **State:** `ide://bookmarks`. **Tests:** `store.test.ts`,
`tests/scripts/features-m6-42.jsonc`.
