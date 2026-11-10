# User interface

The IDE's window is laid out like VS Code's: a title bar, the activity bar and side bar on the
left, a large area for editors and panels, and a status bar. One difference: every editor and
panel, the terminal and the agent included, is a tab in the same *dock*, so you can put anything
next to anything. This page covers each part of the window, how to arrange tabs and groups, the
tab options, and the Explorer, Outline, Timeline, bookmarks, the file viewers, Problems, Output
and notifications.

## The parts of the window

| Part | Where | What it holds |
|---|---|---|
| Title bar | Top | Menus, the folder's name, the search box, Go back / Go forward, layout toggles |
| Activity bar | Far left | An icon for each side bar view, accounts and the Manage menu |
| Side bar | Left | The view you picked: Explorer, Search, Source control… |
| Dock | The rest | Editor groups and panels, all as tabs |
| Status bar | Bottom | Branch, problems, running tasks, the editor's position and format, notifications |

### Title bar

- **Menus:** **File**, **Edit**, **Selection**, **View**, **Go**, **Git**, **Terminal** and
  **Help**. Once one is open, pointing at another title opens it, and Left / Right move between
  them. In a narrow window the menus fold into ☰.
- **Search files and commands** opens [quick access](02-quick-access.md) (Ctrl+P).
- **← →** go back and forward through the places the cursor was: see
  [Go back and go forward](#go-back-and-go-forward).
- **Layout toggles** (right side): show or hide the side bar, the bottom panel and the right side
  (the agent's column).
- On Windows and Linux, the window's own minimize, maximize and close buttons.

### Activity bar

One icon per side bar view: **Explorer** (Ctrl+Shift+E), **Search** (Ctrl+Shift+F), **Source
control** (Ctrl+Shift+G), **Run and debug** (Ctrl+Shift+D), **Testing** (once tests are found),
**Extensions** (Ctrl+Shift+X) and **Channels** (the agent's chats). Click the active icon to hide
the side bar.

- **Badges:** a number counts unsaved files (Explorer) or changes (Source control); a spinning
  mark means work is running in a view you can't see.
- **Reorder:** drag an icon (`workbench.activityBar.order`).
- **Hide or show:** right-click the activity bar and tick the views you want
  (`workbench.activityBar.hidden`). A hidden view that belongs under another stays there as a
  collapsed section: **Outline** and **Timeline** sit at the bottom of the Explorer this way by
  default. Right-click the activity bar to give them icons of their own.
- **Accounts** (the person icon above the gear): **Sign in** opens your browser to sign in to
  your IDE account (Google, GitHub or email); your name, plan and picture show here after.
  **Sign in to GitHub…** runs `gh auth login` (the
  GitHub CLI) in a terminal, which pull requests and issues use; **Backup and sync settings…**
  exports or imports your settings, keyboard shortcuts and snippets. Extensions that sign in to a
  service list their accounts here too, with **Sign out**.
- **Manage** (the gear): the command palette, profiles, settings, extensions, keyboard
  shortcuts, snippets, tasks, and the **Themes** and **Layout density** submenus.

### Side bar

The view you picked on the activity bar. **Ctrl+B** shows or hides it; drag its edge to resize
it.

- **Left or right:** **View: Move sidebar to the other side**, or **View → Appearance → Move
  sidebar right** (`workbench.sideBar.location`). The activity bar moves with it.
- **Sections:** a view's sections (the Explorer's Outline and Timeline, Source control's Graph)
  collapse with a click on their title; drag the line above a collapsed one to make the open one
  taller.
- **Move a view to the dock:** a view that can move (Source control's Graph) has **Move to the
  dock** in its header menu; drag its title onto the dock, or run **View: Move view**. Its tab's
  **Move back to the sidebar** (or dragging the tab onto the side bar) brings it back.
- **Header buttons** show all the time; turn off `workbench.view.alwaysShowHeaderActions` to see
  them only when you point at the view.
- **Scrolling past the end:** lists in the side bar (Explorer, Search, Outline, Timeline…) leave
  a little room under their last item, and settings pages let the last setting scroll up to about
  the middle of the window.

### Status bar

Left: the remote connection, **Restricted mode** when the folder isn't trusted (next to the
remote connection, where VS Code shows it), git branch and sync, problems (errors and warnings;
click for Problems), and a running task or debug session. Right: for the active editor its line
and column, selections, indentation, encoding, line endings, a lock (click it to make the file
read-only or editable) and language; the language server's state; the agent's model; and the notifications bell. Click
an item to act on it: switch branch, change the indentation, reopen with another encoding, pick
the language.

- **View: Toggle status bar** hides it (`workbench.statusBar.visible`).
- **Right-click the status bar** to hide or show single items: each one is listed by name with a
  check (right-click an item to start with Hide "that item"). They stay hidden in every folder
  (`workbench.statusBar.hidden`); **Show all** brings them back.
- `workbench.statusBar.editorInfo` hides the editor's items.

## The dock: editor groups and panels

Everything besides the side bar lives in the dock: tabs in **groups**, groups side by side or
stacked. There is no fixed bottom panel or right panel: "terminal at the bottom, agent on the
right" is only how it starts. A new window has the editors in the middle, a terminal at the
bottom (once a folder is open) and the agent on the right, about 380 pixels wide; the agent's
column keeps its width when you resize the window.

The arrangement is saved with each folder and comes back when you reopen it.
**View → Editor layout → Reset layout** goes back to the starting arrangement.
[Reset layout](command:layout.reset)

### Work with tabs

- **Preview tabs:** a file opened with a single click shows in italics and is replaced by the next
  one; double-click it, edit it, or choose **Keep open** in its menu to keep it
  (`workbench.editor.enablePreview`).
- **Close:** the tab's ×, the middle mouse button, or Ctrl+W. Closing a file with unsaved changes
  asks first.
- **Reopen:** Ctrl+Shift+T reopens the last tab you closed (files, previews, diffs, pages).
- **Switch:** click, Ctrl+PageDown / Ctrl+PageUp for the next or previous tab in the group,
  Ctrl+Tab for the most recently used.
- **New tab…:** the group's ⋯ menu (or right-click the empty part of a tab strip) opens a file,
  terminal, browser, agent or any view in that group.

Right-click a tab for its menu: **Close**, **Close others**, **Close to the right**, **Close
saved**, **Close all**; for files **Copy path**, **Copy relative path**, **Reopen editor with…**,
**Add file to chat**, **Reveal in file manager**, **Reveal in explorer view** and **Open
changes**; then **Keep open**, **Pin** / **Unpin**, **Split right**, **Split down**, **Maximize
group** and, for tabs that can, **Move into new window**.

### Split the editor

- **Ctrl+\\** splits the active group to the right. An editor or a terminal is duplicated into
  the new group; other tabs move there.
- **View → Editor layout → Split right / Split down**, or the same items in a tab's menu.
- The group's ⋯ menu splits four ways (up, down, left, right).
- Drag a tab to the edge of a group.

A file open in two groups is one document: edit it in either.

### Move tabs and groups

Drag a tab and drop it:

- **on a tab strip**, to put it there (a caret shows where);
- **in the middle of a group**, to add it to that group;
- **near a group's edge**, to split that group on that side;
- **near the edge of the whole dock**, to place it along that whole side.

A highlight shows where it will land; Escape cancels. To move a **whole group**, drag the empty
part of its tab strip (or its only tab) and drop it the same way.

From the keyboard:

| Keys | What it does |
|---|---|
| Ctrl+K Ctrl+Left / Right / Up / Down | Focus the group on that side |
| Ctrl+Alt+Left / Right / Up / Down | Move the active tab to the group on that side |

You can also drag files from the Explorer onto the dock: they open where you drop them (several
selected files open together), and a folder opens as a folder browser tab, where clicking a file
opens it in that group.

### Resize, maximize and equalize

- Drag the line between two groups to resize them. Double-click it to make its neighbors equal.
- **Maximize group:** double-click a group's tab strip, or **Maximize group** in its menu: it
  fills the dock until you do it again.
- **View → Editor layout → Equalize group sizes** makes every group the same size.
- **Close group** closes a group and its tabs. When the last editor closes, the Welcome page takes
  its place.

### Panels

The terminal, Problems, Output, the debug console and other tools are tabs like the editors, at
the bottom by default.

| Keys | What it does |
|---|---|
| Ctrl+J | Hide or show the group with the panel you used last (a terminal if there's none) |
| Ctrl+\` | Show the terminal |
| Ctrl+Shift+M | Show Problems |
| Ctrl+L | Focus the agent |

The title bar's toggles hide and restore whatever sits at the bottom and on the right, at the
same size. **View → Tools** lists every tool, the IDE's and extensions', to open as a tab.

## Tab options

These follow VS Code's settings of the same names (Settings → Appearance).

### Pin tabs

Pin a tab (**Pin** in its menu, or Ctrl+K Shift+Enter) to keep it at the start of its group with a
pin icon. **Close others**, **Close to the right**, **Close saved**, **Close all** and the tab
limit leave pinned tabs open. Click the pin, or press Ctrl+K Shift+Enter again, to unpin it.
Turn on `workbench.editor.pinnedTabsOnSeparateRow` to show pinned tabs on a row of their own.

### Limit the number of open tabs

Turn on `workbench.editor.limit.enabled` and set `workbench.editor.limit.value` (10 by default):
opening one tab too many closes the least recently used one. Pinned tabs and tabs with unsaved
changes stay. `workbench.editor.limit.perEditorGroup` counts each group on its own;
`workbench.editor.limit.excludeDirty` leaves unsaved tabs out of the count.

### Tabs on the side

`workbench.editor.tabPlacement` puts an editor group's tabs in a list on its left or right, one tab
per row, instead of above it. Panels (the terminal, the agent) keep their tabs on top. You can
drag tabs within the list as in a strip.

### Close buttons, colors and badges

- `workbench.editor.tabActionLocation` puts the close button on the left of the title.
- `workbench.editor.tabActionCloseVisibility` off hides it: close with the middle mouse button,
  Ctrl+W or the tab's menu.
- Tab titles take the file's git color and problem color, with a badge after the title: the
  number of problems and the git letter ("2, M"). `workbench.editor.decorations.colors` and
  `.badges` turn each off; `problems.decorations.enabled` turns the problem colors off here and in
  the Explorer.
- When you close the active tab, the tab you used before it shows
  (`workbench.editor.focusRecentEditorAfterClose`); off, its neighbor does.

| Setting | Default | Description |
|---|---|---|
| `workbench.editor.enablePreview` | `true` | Single-click opens a preview tab that the next one replaces |
| `workbench.editor.pinnedTabsOnSeparateRow` | `false` | Pinned tabs on their own row |
| `workbench.editor.limit.enabled` | `false` | Close the least recently used tabs past the limit |
| `workbench.editor.limit.value` | `10` | How many tabs stay open |
| `workbench.editor.limit.perEditorGroup` | `false` | Count each group's tabs on their own |
| `workbench.editor.limit.excludeDirty` | `false` | Tabs with unsaved changes don't count |
| `workbench.editor.tabPlacement` | `top` | `top`, `left` or `right` of the group |
| `workbench.editor.tabActionLocation` | `right` | Which side of the title the close button is on |
| `workbench.editor.tabActionCloseVisibility` | `true` | Show a close button on tabs |
| `workbench.editor.decorations.colors` | `true` | Color tab titles by git status and problems |
| `workbench.editor.decorations.badges` | `true` | Show the problem count and git letter after the title |
| `workbench.editor.focusRecentEditorAfterClose` | `true` | After closing, show the most recently used tab |

## Panel style, tab style and density

**Preferences: Appearance…** (also under the gear, and **File → Preferences → Appearance…**)
switches these in one menu:

- **Panel style** (`workbench.panels`): **flush**, one surface with thin dividers (the default),
  or **floating**, each panel a card with gaps between them.
- **Tab style** (`workbench.tabStyle`): **rounded** tabs inside the strip (the default);
  **classic** square tabs side by side, with the accent along the active tab's top; or
  **connected**, where the active tab joins the editor under it, on a strip of another shade.
- **Density** (`workbench.density`): compact, default or comfortable row, tab and control
  heights.
- **Side bar color** (`workbench.sideBarColor`): the panels' color, or the theme's own side bar
  color.
- Dark or light theme.

| Setting | Default | Description |
|---|---|---|
| `workbench.panels` | `flush` | `flush` or `floating` panels |
| `workbench.tabStyle` | `rounded` | `rounded`, `classic` or `connected` |
| `workbench.density` | `default` | `compact`, `default` or `comfortable` |
| `workbench.sideBarColor` | `matching` | `matching` the panels, or `distinct` |
| `workbench.scrollbarSize` | `10` | Width of scrollbars outside the editor and terminal, in pixels |

Color, file icon and product icon themes are on
[Settings, themes and profiles](16-settings-themes.md).

## Go back and go forward

The IDE remembers the places your cursor was, across files, like a browser's history:

| Keys | What it does |
|---|---|
| Alt+Left (Ctrl+- on macOS) | **Go back** to the previous place |
| Alt+Right (Ctrl+Shift+- on macOS) | **Go forward** again |

The mouse's back and forward buttons, the ← → in the title bar and **Go → Back / Forward** do the
same. A jump to another file, or 10 or more lines away, is a new place; smaller moves update the
current one. The last 50 places are kept. In a terminal, Alt+Left and Alt+Right stay the shell's.
**Go: Clear editor history** forgets them.

| Setting | Default | Description |
|---|---|---|
| `workbench.navigationControl.enabled` | `true` | Show the Go back and Go forward buttons |
| `workbench.navigationControl.location` | `titleBar` | Beside the title bar's search box, or `tabBar`: at the start of each group's tab strip |

## Focus on the code

- **Zen mode** (Ctrl+K Z, **View: Toggle zen mode**, **View → Appearance → Zen mode**): only the
  editors stay; the side bar, activity bar, status bar, panels and the agent go away. Do it again
  and they come back as they were. [Toggle zen mode](command:layout.toggleZenMode)
- **Centered layout** (**View: Toggle centered layout**, `workbench.editor.centeredLayout`): text
  editors keep a readable width in the middle of a wide group.
- **Full screen** (F11; Ctrl+Cmd+F on macOS): **Window: Toggle full screen**, or **View →
  Appearance → Full screen**. While debugging is paused, F11 is Step Into, as in VS Code.

### Zoom

| Keys | What it does |
|---|---|
| Ctrl+= (or Ctrl+Shift+=) | **Zoom in**: the whole window 20 % bigger |
| Ctrl+- | **Zoom out** |
| Ctrl+Numpad 0 | **Reset zoom** to 100 % |

The level is kept in `window.zoomLevel` (0 is 100 %). To change only the editor's text, use
`editor.fontSize` (see [Editing](04-editing.md)).

## Tabs in a window of their own

Some tabs can move into a separate window, handy on a second screen: the browser preview, a
folder browser tab, and extensions' pages and viewers. Right-click the tab and choose **Move into
new window**. The tab stays in its group as a placeholder that shows where it went; commands and
the agent reach it as before.

- **Move back into the main window** (the tab's menu), or closing that window, brings it back.
- **View: Move all tabs back into the main window** brings them all back.
- Closing the tab closes its window.

For a second full window on another folder, use **File → New window** (Ctrl+Shift+N).

## Open files by dropping them

Drag files from your file manager onto the window:

- **onto an editor group:** they open there, from any folder, inside the open one or not (onto
  the status bar or title bar: in the focused group);
- **onto a folder in the Explorer:** they're copied into that folder;
- **onto the terminal:** their paths are typed;
- **onto the agent's chat:** they're attached to your message.

A dropped **folder** opens as the workspace when no folder is open. With one open, you choose
**Add to workspace** or **Open folder**.

## Explorer

The Explorer (Ctrl+Shift+E) shows the open folder's files. A single click opens a file in a
preview tab; double-click or Enter opens it for good. The active editor's file is selected as you
switch tabs (`explorer.autoReveal`). Files your `.gitignore` leaves out are dimmed.

### Create, rename and delete

- **New file…** and **New folder…** (the header's buttons, the right-click menu) go where the
  selection is, and you type the name in the tree. To create at the folder's root, click the
  empty space below the files or the folder's name at the top, or press Escape, to select nothing
  first.
- **Rename** with F2; a name that can't be used is flagged as you type.
- **Delete** (Delete key) moves files to the IDE's own trash; the confirmation lists what goes.
  **File → Restore deleted files…** brings back anything deleted from this folder in the last 30
  days. [Restore deleted files](command:explorer.restoreDeleted)
- **Undo** (Ctrl+Z in the Explorer) undoes the last file operation: create, rename, move, copy or
  delete; Ctrl+Y redoes it. Undo never overwrites a file that changed since; it says so instead.
  `explorer.confirmUndo` decides when it asks first.
- **Renaming or moving a JavaScript or TypeScript file** offers to update the imports that point
  at it (`editor.updateImportsOnFileMove`: `prompt`, `always`, `never`); undo reverts both.

### Copy, move and drag

- **Cut, Copy, Paste** (Ctrl+X, Ctrl+C, Ctrl+V with the Explorer focused), and **Duplicate**.
- **Paste text or a picture** copied in another app: it becomes a new file, named in the tree.
- **Drag rows onto a folder** to move them (the folder lights up while you drag).
- **Drag rows out of the window** into another app (a file manager, an email, a chat) to copy them
  there.
- **Drop files from your file manager** onto a folder to copy them in.

### Find and navigate

- Type in the tree to jump to the next name starting with those letters.
- **Ctrl+Alt+F** opens a find bar for the visible rows: matches are highlighted, or with the
  filter button they're the only rows shown; Enter goes to the next one.
- Folders you're scrolling through stay pinned at the top; click one to jump to it and collapse
  it.
- The header's **Collapse folders** closes every folder; **Refresh** reloads the tree.

### Right-click menu

Following VS Code's order: **Open to the side**, **Open with…**, **Open preview**, **Reveal in
file manager**, **Open in integrated terminal**, **Find in folder…**, **Select for compare** /
**Compare with…**, **Open timeline**, **Add file to chat**, **Cut**, **Copy**, **Paste**,
**Duplicate**, **Copy path**, **Copy relative path**, **Rename…** and **Delete**.

### How files are shown

- **Compact folders:** a chain of folders that each hold one folder shows as one row
  (`src/main/java`). `explorer.compactFolders` turns it off.
- **Folder icons:** off by default; `explorer.folderIcons` shows them next to the chevrons.
- **Hidden files:** `files.exclude` hides `.git`, `.DS_Store` and the like. **Show hidden files**
  in the header's ⋯ menu (`explorer.showExcludedFiles`) lists them dimmed; they stay out of search
  and quick open.
- **Colors:** files and folders take their git status color and their problem color, with a count.

### File nesting

Turn on `explorer.fileNesting.enabled` to list related files under one file: the compiled `a.js`
and its source map under `a.ts`, the lock files under `package.json`. Click the file to open it;
its chevron shows or hides what's nested. When the nested files are folded away, the file stands
for all of them: deleting, cutting, copying or dragging it takes them along (the delete
confirmation says how many). Unfold it to act on the file alone.

`explorer.fileNesting.patterns` says what goes under what. Each key is a file name (with at most
one `*`); its value lists the names nested under it, separated by commas. In the value,
`${capture}` is what the key's `*` matched, `${basename}` the file's name without its extension,
`${extname}` its extension and `${dirname}` its folder's name:

```json
"explorer.fileNesting.enabled": true,
"explorer.fileNesting.patterns": {
  "*.ts": "${capture}.js",
  "*.tsx": "${capture}.test.tsx, ${capture}.module.css",
  "package.json": "package-lock.json, yarn.lock, pnpm-lock.yaml"
}
```

| Setting | Default | Description |
|---|---|---|
| `explorer.autoReveal` | `true` | Select the active editor's file |
| `explorer.compactFolders` | `true` | Show chains of single folders as one row |
| `explorer.folderIcons` | `false` | Show folder icons |
| `explorer.showExcludedFiles` | `false` | List what `files.exclude` hides, dimmed |
| `explorer.confirmUndo` | `default` | Ask before an undo that deletes files; `verbose` always; `light` never |
| `explorer.fileNesting.enabled` | `false` | Nest related files under one file |
| `explorer.fileNesting.expand` | `true` | Files with nested files start expanded |
| `explorer.fileNesting.patterns` | VS Code's | Which files nest under which |
| `editor.updateImportsOnFileMove` | `prompt` | Update imports when a JS/TS file moves |
| `files.exclude` | `.git`, `.svn`, `.hg`, `.DS_Store`, `Thumbs.db` | What the Explorer hides |

## Outline

The **Outline** (a section at the bottom of the Explorer) lists the active file's symbols:
classes, functions, methods, a Markdown file's headings. Click one to go there.

- It follows the cursor, highlighting the symbol you're in (`outline.followCursor`).
- Its ⋯ menu sorts by position, name or kind (`outline.sortOrder`), and collapses or expands all.
- Right-click a symbol to go to it, select it, or copy its name or path.

**View: Show outline** shows it; **Go: Go to symbol in editor…** (Ctrl+Shift+O) does the same
from the keyboard.

## Timeline

The **Timeline** (a section at the bottom of the Explorer) lists the active file's history: every
save, agent edit and outside change the IDE kept (its local history), and the git commits that
changed it, grouped by day.

- Click an entry to compare it with the file now.
- Right-click to **Restore this version** or **Copy commit hash**.
- **File: Open timeline** picks a version from a list instead.

## Bookmarks

Mark lines to come back to, in any file:

| Command | Keys | What it does |
|---|---|---|
| **Bookmarks: Toggle bookmark** | Ctrl+Alt+K | Marks or unmarks the cursor's line |
| **Bookmarks: Toggle labeled bookmark…** | | The same, with a name |
| **Bookmarks: Next bookmark** | Ctrl+Alt+L | Goes to the next one, in any file |
| **Bookmarks: Previous bookmark** | Ctrl+Alt+J | Goes to the previous one |
| **Bookmarks: List bookmarks…** | Ctrl+Alt+Shift+K | Lists them all to pick one |
| **Bookmarks: Clear bookmarks in this file** | | |
| **Bookmarks: Clear bookmarks** | | Every bookmark in the folder |

A bookmark shows in the editor's margin, beside any breakpoint, follows its line as you edit and
the file when you rename it, and is kept with the folder.

## Viewers

Files that aren't text open in viewers:

| Files | Viewer |
|---|---|
| `.png` `.jpg` `.jpeg` `.gif` `.webp` `.bmp` `.ico` `.avif` | **Image**: fits the tab until you zoom; click to zoom in, Alt+click to zoom out, Ctrl+wheel to zoom around the pointer; size and zoom shown |
| `.mp3` `.wav` `.ogg` `.m4a` `.flac`, `.mp4` `.webm` `.mov` | **Media**: your system's player |
| `.ttf` `.otf` `.woff` `.woff2` | **Font**: its name, a sample at several sizes and its characters |
| `.zip` `.jar` `.war` `.vsix` `.whl` `.nupkg` `.epub` `.apk` | **Archive**: the files inside, with sizes and dates |
| `.exe` `.dll` `.wasm` `.class` `.pyc` and other binaries | **Hex**: offset, bytes and text, for files up to 50 MB |
| `.csv` `.tsv` | **Table**, from the editor: **Toggle preview** (Ctrl+Shift+V) or **Open preview to the side** (Ctrl+K V); the first 5000 rows, updated as you type |

- **Reopen editor with…** (a tab's menu, or the palette) shows any file in the text editor or any
  viewer, for example a file as hex.
- A file that looks binary opens with a notice offering the hex viewer.
- Markdown and SVG previews and Jupyter notebooks are on [Editing](04-editing.md) and
  [Notebooks](15-notebooks.md).

## Problems

**Problems** (Ctrl+Shift+M, or click the error and warning counts in the status bar) lists the
errors and warnings in your files, grouped by file: from the language services and language
servers in open files, from servers that check the whole project, and from tasks' problem
matchers in any file.

- Click a problem to go to it.
- **Filter** by text or by file pattern (`**/*.ts`).
- Right-click for **Copy**, **Copy message**, **Copy problems in this file**, **Copy all
  problems**, **Fix with agent** and **Fix all in this file with agent**.
- **F8** / **Shift+F8** go to the next and previous problem from the editor.
- Files with problems are colored in the Explorer and on their tabs, with a count
  (`problems.decorations.enabled`).

[Show problems](command:problems.show)

## Output

**View: Show output** opens the **Output** tab: logs of what the IDE does, by channel.

- **Channels:** Window (the IDE itself), Extension host, Git (every git command the IDE ran, and
  how long it took), Tasks, Agent (commands agents and MCP clients ran) and one for each language
  server.
- **Filter:** shows only lines with one of its comma-separated words and none starting with `!`
  (`error, !timeout`); Escape clears it.
- The header also has the channel's log level, word wrap, clear, and a button to open the logs
  folder.

[Show output](command:output.show). Log levels and the log files are covered in
[Troubleshooting](21-troubleshooting.md#logs-and-the-output-panel).

## Notifications

Messages from the IDE and extensions show as pop-ups at the bottom right, and stay in the list
behind the **bell** in the status bar (a dot and a count when some are unread).

- Click the bell (**Notifications: Show notifications**) to see the last notifications, with
  their buttons.
- **Do not disturb** (in that list, or **Notifications: Toggle do not disturb**): only errors pop
  up; the rest goes to the list.
- **Clear all notifications** empties it.

## Commands

| Command | Keys | What it does |
|---|---|---|
| **View: Toggle sidebar** | Ctrl+B | Shows or hides the side bar |
| **View: Toggle panel** | Ctrl+J | Hides or shows the bottom panel's group |
| **View: Focus agent** | Ctrl+L | Focuses the agent, opening it if needed |
| **View: Split group** | Ctrl+\\ | Splits the active group |
| **View: Close tab** | Ctrl+W | Closes the active tab |
| **View: Reopen closed tab** | Ctrl+Shift+T | Reopens the last closed tab |
| **View: Next tab** / **Previous tab** | Ctrl+PageDown / Ctrl+PageUp | Moves through the group's tabs |
| **View: Pin tab** / **Unpin tab** | Ctrl+K Shift+Enter | Pins or unpins the active tab |
| **View: Close other tabs** | | Closes the group's other tabs |
| **View: Close all tabs** | | Closes every unpinned tab |
| **View: Toggle maximize group** | | Lets the group fill the dock |
| **View: Equalize group sizes** | | Makes groups the same size |
| **View: Reset layout** | | Back to the starting arrangement |
| **View: Toggle zen mode** | Ctrl+K Z | Only the editors |
| **View: Toggle centered layout** | | Text editors at a readable width |
| **View: Toggle status bar** | | Shows or hides the status bar |
| **View: Move sidebar to the other side** | | Side bar left or right |
| **View: Move tab into new window** | | The tab in a window of its own |
| **Go: Go back** / **Go forward** | Alt+Left / Alt+Right | Steps through where the cursor was |
| **Window: Zoom in** / **Zoom out** / **Reset zoom** | Ctrl+= / Ctrl+- / Ctrl+Numpad 0 | Zooms the whole window |
| **Window: Toggle full screen** | F11 | The whole window, without its frame |
| **View: Show explorer** | Ctrl+Shift+E | |
| **Explorer: Find in explorer** | Ctrl+Alt+F | Find bar over the tree |
| **View: Show problems** | Ctrl+Shift+M | |
| **View: Show output** | | |
| **Preferences: Appearance…** | | Panel style, tab style, density, theme |

## Common questions

### How do I get the terminal back on the bottom after moving it?

Drag its tab to the bottom edge of the dock, or run **View: Reset layout** to go back to the
starting arrangement.

### Can an editor go in its own window?

Not yet: the browser, folder browser tabs and extensions' pages can. Open a second window with
**File → New window** instead.

### Where did the Outline go?

It's a section at the bottom of the Explorer. Right-click the activity bar to give it an icon of
its own.

## Next steps

- [Quick access](02-quick-access.md): open files and run commands from the keyboard.
- [Editing](04-editing.md): the editor itself.
- [Settings, themes and profiles](16-settings-themes.md): themes and every other setting.
- [Workspaces and trust](20-workspaces.md): several folders in one window, several windows.
