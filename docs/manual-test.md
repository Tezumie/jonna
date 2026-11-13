# Manual test script

Run `npm install && npm run dev` (see README for per-OS prerequisites). Dev builds include
`Developer:` commands. `F1` or `Ctrl/Cmd+Shift+P` opens the palette; most checks can be run from there.
Section 9 is the Windows pass (Windows 10/11; please run it on real hardware).

## 1. Window and shell
- [ ] The window opens with the title bar (menu ☰, folder name, centered "Search commands" field with
      `Ctrl+Shift+P`, three layout toggles, and on Windows/Linux minimize / maximize / close), the activity
      bar, the Explorer sidebar and the dock: Welcome (main), a terminal (bottom), Agent (right).
- [ ] Flush by default: one shell color, 1px dividers, no gaps or rounded panels (DESIGN.md v2 §10).
      Neutral grays; blue appears only on focus rings, the active selection in a focused list, links,
      checkboxes and primary buttons. The active tab and the active activity-bar item are a lighter fill.
- [ ] Hover any icon button: after ~0.5 s a tooltip with its name and keybinding; moving to the next
      button shows the next tooltip immediately. Every clickable control shows the pointer cursor.
- [ ] Make the window narrow: the menu items (File … Help) fold into ☰ first, then the workspace name
      truncates, the command field shrinks to an icon, the layout toggles hide below ~720px. The window
      controls never leave the window.
- [ ] Drag the title bar to move the window; double-click it to maximize/restore. The maximize button
      shows a "restore" glyph while maximized. Close turns red on hover.
- [ ] `Ctrl/Cmd+B` hides/shows the sidebar. The title-bar toggles show filled icons when on.

## 2. Appearance and settings
- [ ] `Ctrl/Cmd+,` or the ⚙ at the bottom of the activity bar opens the Settings tab: User · Workspace
      switch (Workspace disabled without a folder), search (matches in bold), categories on the left.
- [ ] Change Workbench: Theme / Density / Panels: applies instantly — editor, terminal (text already on
      screen is recolored), menus, palette. The row gets a bar on the left and a reset button on hover.
- [ ] `{ }` (top right) opens `settings.json` for the scope in an editor tab. Edit it there (or in
      another program) and save: the UI follows within a second; comments in the file are kept when the
      settings tab changes a value. A typo (invalid JSON) keeps the last good values.
- [ ] Workspace settings (`<folder>/.jonna/settings.json`) win over user settings.
- [ ] `editor.stickyScroll.enabled`, `editor.fontSize`, `editor.wordWrap`, `terminal.fontSize`,
      `files.trimTrailingWhitespace`, `files.insertFinalNewline` take effect without a restart.
- [ ] Restart: theme and density are already applied at the first paint.
- [ ] The same as commands: `ui.setTheme`, `ui.setDensity`, `ui.setPanelStyle`, `settings.set`.

## 3. Dock
- [ ] Drag a tab (≥ 4px) → a flat copy follows the pointer, the source tab fades; over a group a single
      accent rectangle slides between zones: center (join the group), edges (split), outer 16px of the dock
      (full-height/width split); over a tab strip an insertion caret. Escape cancels.
- [ ] Drop a terminal at the bottom/right edge: the new group takes 35% / 30%; other views 50%.
- [ ] Drag a file from the explorer onto the dock → it opens as an editor in that zone (and nowhere else).
- [ ] Moving a tab keeps its state: editor cursor/undo, a running command in a terminal, and the
      iframe test view ("Developer: Open iframe test view": type in the box, move the tab — the text
      stays and "Loads: 1" does not change).
- [ ] Closing the last tab of a group removes it; siblings share the space. Closing the last editor
      shows Welcome in its place (logo, actions, recent folders).
- [ ] Open 80+ tabs in one group ("Developer: Check layout overflow" does it for you and reports
      pass/fail): the strip scrolls sideways (mouse wheel too), the active tab stays visible, "⋯" lists
      all tabs, the group buttons stay at the right, the window never gets wider.
- [ ] Double-click a tab strip (or the ⤢ button) maximizes the group; again restores.
- [ ] Splitters: hover shows a 2px accent line, drag resizes (groups never get below 160×80),
      double-click equalizes.
- [ ] Keys: `Ctrl/Cmd+\` split (editors and terminals are duplicated), `Ctrl/Cmd+K Ctrl/Cmd+←→↑↓`
      focus a neighbor group, `Ctrl/Cmd+Alt+←→↑↓` move the tab to a neighbor (or split),
      `Ctrl/Cmd+W` close the active tab of the focused group (any view type),
      `` Ctrl+` `` terminal (focus it / back to the last editor / open one at the bottom),
      `Ctrl/Cmd+J` hide ↔ restore the panel group at the same size, `Ctrl/Cmd+L` focus the agent,
      `Ctrl+PageDown/PageUp` next/previous tab.
- [ ] Title-bar bottom/right toggles hide and restore whatever groups sit at the bottom / on the right.
- [ ] "Reset layout" puts editors main, terminals bottom, agent right — keeping every tab.
- [ ] Restart: groups, sizes, tabs, active tabs and focus come back (terminals start a fresh shell
      in the same folder; read-only state dumps and the iframe test view are not restored).

## 4. Explorer
- [ ] Open a folder: `Ctrl+K Ctrl+O` (macOS `⌘O`), the "Open folder" button, or the folder name in the title bar.
- [ ] Folders expand on click; `.gitignore`d entries are dimmed; `.git` is hidden; natural order.
- [ ] Click a file: it opens in a *preview* tab (italic title) and the explorer keeps focus (the row is
      blue-tinted, ↑/↓ move). Click another file: it replaces the preview. Double-click, or type in the
      editor: the tab becomes normal. Click into the editor: the explorer row turns gray (inactive).
- [ ] Ctrl/Cmd+click and Shift+click select several rows; Delete removes them all after one confirmation.
- [ ] Ctrl/Cmd+X then Ctrl/Cmd+V on a folder moves files (cut rows are dimmed until then); Ctrl/Cmd+C,
      Ctrl/Cmd+V copies ("name copy.ext" when the name is taken). Dragging rows onto a folder moves them
      (the folder and its open children are highlighted while dragging).
- [ ] Switching editor tabs reveals and selects the file in the tree (`explorer.autoReveal`).
- [ ] Indent guides appear when the pointer is over the tree; file icons are tinted by type.
- [ ] Files created/deleted outside the IDE appear/disappear within ~0.5 s.
- [ ] Right-click → New file…, New folder…, Rename…, Delete (confirmation dialog in the IDE's style).
      Renaming an open file keeps its tabs (and unsaved edits).

## 5. Editor
- [ ] Click a file → opens in the focused editor group (Dark+ / Light+ syntax colors per theme).
- [ ] While Monaco loads on a cold start, the first lines show as plain text, then the editor swaps in.
- [ ] Two tabs on the same file (split) edit the same text. Dirty dot in the tab, `●` in the window title.
- [ ] `Ctrl/Cmd+S` saves; `Ctrl/Cmd+W` on the last tab of a dirty file asks Save / Don't save / Cancel.
- [ ] Status bar: `Ln x, Col y`, line endings (`LF`/`CRLF`), language. A CRLF file stays CRLF after an edit and save.
- [ ] A binary file shows a notice with a "Close tab" button.
- [ ] Right-click in the text: the IDE's menu (Change all occurrences, Cut, Copy, Paste, Command
      palette; language actions once M2 adds them). Escape closes it. `Ctrl/Cmd+F` find widget, hover and
      suggestions use the IDE's colors and rounded corners. Sticky scroll pins the enclosing scopes.

## 6. Terminal
- [ ] Interactive shell in the workspace folder; colors, Unicode, `vim`/`htop`/`less`, resize (`tput cols`).
- [ ] Flood `yes | head -n 2000000`: the UI stays responsive, `Ctrl+C` works.
- [ ] `` Ctrl+Shift+` `` opens another terminal tab next to the last one. Tab title: "pwsh · folder".
- [ ] Resize the terminal group many times, maximize/restore the window: the terminal never grows past
      its group, no scrollbar creeps in, and `tput cols`/`tput lines` match what you see.
- [ ] `printf '\a'` (bash) or `` "`a" `` (PowerShell): silent by default; with `terminal.bell` =
      `visual` the tab pulses, `sound` plays a short tone.

## 6b. Milestone 2: code intelligence, navigation, search
- [ ] Open a `.ts` file with a type error: red squiggle, hover shows the message; `Ctrl/Cmd+Space`
      completes; F12 / Shift+F12 / F2 work (right-click lists them). `.tsx`/`.jsx` too; imports of
      files that aren't open are not flagged. JSON, CSS and HTML files get validation and completion.
- [ ] `settings.json` and `keybindings.json` (open via the `{ }` buttons): completion of keys and
      values, wrong values underlined.
- [ ] `Ctrl/Cmd+Shift+M`: Problems tab, grouped by file; click jumps to the line. The status bar shows
      ⊗ errors ⚠ warnings and opens the tab.
- [ ] `Ctrl/Cmd+P`: type part of a name (fuzzy, "exp view"); recent files first; `name:42` opens at
      line 42; `:10` jumps in the current editor; `.gitignore`d files don't appear. New files show up
      within a second.
- [ ] `Ctrl/Cmd+Shift+F`: results stream in; toggles (Aa, whole word, .*), include/exclude globs
      (`src`, `*.ts`). Type a replacement: lines show old/new; "Replace all" asks first, then files
      change on disk and open editors update.
- [ ] Change an open, unmodified file outside the IDE: the editor reloads. With unsaved edits: a
      yellow banner offers Reload / Keep my changes. Delete it outside: "deleted on disk" banner.
- [ ] `Ctrl/Cmd+K Ctrl/Cmd+S`: Keyboard shortcuts tab; search; double-click a row, press keys, Enter:
      the new key works at once and appears as "User"; a key used twice shows ⚠.
- [ ] Terminals: each command gets a dot left of its prompt — gray while running, green when it
      succeeded, red when it failed; hovering shows the exit code and duration; the tab
      title follows `cd`; "Rename terminal…", `Ctrl+Shift+5` split. "Run command in terminal" from the
      palette returns the exit code and output (see the audit log).

## 6c. Milestone 3: git and language servers
- [ ] Open a folder that isn't a repository: Source control (`Ctrl+Shift+G`) shows "No repository" and
      "Initialize repository"; after it, every file is listed as `U` (untracked, green).
- [ ] Edit, create and delete files (in the IDE and from a terminal): within a second or two the view,
      the explorer (name colors, `M`/`A`/`D`/`U` badges, a dot on folders) and tabs update; a deleted
      file is struck through.
- [ ] Hover a row: open file, discard (asks; untracked files are deleted), stage `+`; section headers
      stage/unstage/discard everything. Click a row: a diff tab (preview) opens; edit on the right side,
      save, the diff updates.
- [ ] In an editor, change two separate places: two gutter bars (green added, blue modified, red
      triangle for deletions). Right-click a changed line → "Stage change": only that part is staged
      (the file is in both sections). "Revert change" undoes it (Ctrl+Z brings it back).
- [ ] In a staged diff tab, "Unstage change at cursor" and "Unstage file" work.
- [ ] Type a message, `Ctrl/Cmd+Enter` commits (nothing staged: all tracked changes). The status bar
      shows the branch with `*` when dirty; clicking it lists branches and "Create new branch…".
- [ ] With a remote: the sync item shows ↓/↑ counts or "Publish"; push / pull / fetch show a 2px
      progress line and a toast; a failing push (no network) shows git's message.
- [ ] Language servers: with Pyright, rust-analyzer, gopls or clangd on PATH, open a file of that
      language → the status bar shows the server; squiggles, hover, `Ctrl+Space` completion, F12 to
      another file (opens a tab), Shift+F12 peek, F2 rename across files (unopened files open as
      modified tabs), Shift+Alt+F format. "Show language server log" shows its output. Servers that
      aren't installed don't nag (`lsp.list` says "missing").
- [ ] `lsp.servers` in user settings adds a server (e.g. `{"lua": {"command": "lua-language-server",
      "languages": ["lua"]}}`) or turns a built-in off (`{"pyright": {"enabled": false}}`); servers restart.

## 6d. Milestone 4: agent, and workbench fixes
- [ ] With Ollama running and a model pulled (e.g. `ollama pull qwen3:8b`): open the agent panel
      (`Ctrl/Cmd+L` or the status bar) — the empty state names the model; the model pill lists every
      pulled model (local first, cloud models in a submenu) with size · parameters · quantization.
      `ollama pull` another model, reopen the menu: it is there. Stop Ollama → "Get Ollama".
- [ ] "Explain this project": the agent reads files (compact tool rows, expandable), answers in
      Markdown (code blocks with copy). Stop (■) mid-answer works.
- [ ] "Add a function … to src/x.ts": a diff card and the changes bar appear; the file on disk is
      unchanged until "Accept"; "Review" opens the diff tab — accept/reject per change and per file.
      Reject all restores everything. Auto-apply mode writes at once; "Restore checkpoint" undoes it.
- [ ] "Run the tests": an inline card asks (once / always / deny); output streams into the row;
      "always" adds the command to `agent.allowedCommands`.
- [ ] A model without tool support (e.g. `gemma3`) still reads and edits (text protocol).
- [ ] Sessions: a second tab via "New session"; close and reopen the app — transcripts come back;
      "Sessions…" lists them; delete one.
- [ ] `agent.mcpServers` with a real server (e.g. `{"fs": {"command": "npx", "args": ["-y",
      "@modelcontextprotocol/server-filesystem", "${workspaceFolder}"]}}`): its tools are used and
      writes ask first.
- [ ] External agents: model pill → External agents → Claude Code (needs Node and `claude /login`):
      it answers, its edits land in the changes bar, its permission requests are inline cards.
- [ ] An OpenAI-compatible provider ("Add model provider…", e.g. LM Studio at
      `http://127.0.0.1:1234/v1`) lists its models; "Set API key…" for a hosted one.
- [ ] Menus: File → hover Edit switches menus; submenus (Open recent, Preferences) open on hover,
      ←/→ work; a second click on the open title closes it.
- [ ] Focus a terminal in one group, click a tab in another group: the tab activates on the first
      click. Right-click a tab: close others / to the right / saved, copy path, reveal, split.
- [ ] Monaco right-click → Cut / Copy / Paste work (also between the IDE and other apps).
- [ ] Explorer: New file / folder and Rename edit inline (Escape cancels; a clashing name shows a
      message); dragging highlights the target folder; dropping files from the OS copies them in;
      File → Close folder. In a deep project scroll down: parent folders stick to the top (nested);
      clicking one jumps to it, clicking its chevron collapses it.
- [ ] Source control after `git init`: every file is listed under Changes; `+` on a row and on the
      header stages.

## 6e. After M4 (fixes round)
- [ ] Menus: File, Edit, Selection, View, Go, Git, Terminal, Help as in VS Code; items that need an
      editor are greyed without one; View → Appearance / Editor layout and Go → Switch editor
      submenus; Help → About.
- [ ] Explorer: the folder's own row (uppercase name) collapses the tree and holds new file / new
      folder / refresh / collapse on hover; right-click it for the folder menu.
- [ ] Agent panel while streaming: "Thinking…" shimmers smoothly, rows can be expanded mid-answer.
- [ ] Tabs: even insets, no line under the strip.

## 6f. Viewers, tab actions, chat actions
- [ ] Open a .png: image viewer (checkerboard, "W × H · size · zoom"); click zooms in, Alt+click
      out, Ctrl+wheel zooms at the pointer; toolbar: zoom out / in / fit ↔ 100%.
- [ ] Open README.md: the tab's "Open preview to the side" (book icon) or Ctrl/Cmd+K V opens a
      preview in a split; typing updates it; scrolling the editor scrolls it; code blocks are
      colored; local images show; `#anchor` links scroll; double-click a paragraph → its line.
      Ctrl/Cmd+Shift+V opens the preview in the same group. "Open source" goes back.
- [ ] logo.svg: the same preview actions draw it; edits redraw it.
- [ ] Right-click a tab → it doesn't switch; "Reopen editor with…" (palette) on an image → Text.
- [ ] Terminal toolbar: + new, eraser clears, trash kills. Settings / agent tabs have no split.
- [ ] Agent: the newest answer shows copy · retry · model; older ones on hover; your message: copy,
      edit (Enter sends, Escape cancels; later turns are replaced). "Jump to latest" never shows
      when nothing is below.
- [ ] Edit menu: Undo / Redo / Cut / Copy / Paste / Select all work on the editor.
- [ ] Search: ✕ on a file or line hides it; collapse all in the header.

## 6g. History, breadcrumbs, menus, provider retry
- [ ] Type in a file, save, close the tab, reopen it → Ctrl+Z undoes the typing; the tab is dirty
- [ ] Explorer: new file, rename, move (drag), delete → Ctrl+Z in the explorer undoes each in turn;
      Ctrl+Y / Ctrl+Shift+Z redoes; a deleted folder comes back with its contents
- [ ] Replace all in search, then Edit → Undo (no editor focused) → files are back; editing one of
      the files first makes undo leave that file alone and say so
- [ ] Accept an agent edit, then Edit → Undo in the explorer → the file is back
- [ ] Right-click a file → Open timeline → pick a version → diff opens; "Restore this version" works
- [ ] Breadcrumbs: folders › file › symbol at the cursor; clicking a folder lists it (folders
      navigate in place), clicking a symbol lists its siblings with a search box when long
- [ ] File status bar: ⊗/⚠ counts for this file only; clicking opens "Problems in this file";
      Diff opens changes; Ln/Col opens Go to line. Settings can turn both off
- [ ] Model menu with a provider that has many models (OpenRouter): searchable, scrolls
- [ ] Provider error (bad key, rate limit): short error, full text in the tooltip, Retry / Continue;
      a 429 / 503 retries by itself up to 3 times with a "Retrying…" line
- [ ] Ctrl+F in an editor: input matches the widget surface, buttons match IDE icon buttons,
      tooltips are the IDE's
- [ ] Closing the last editor keeps the editor area (Welcome); the next file opens there, not in
      the terminal's group

## 6h. Browser (M5)
- [ ] `npm run dev` in a Vite/Next app → Ctrl/Cmd+click the localhost address in the terminal →
      the page opens beside it; editing a component hot-reloads it in the tab
- [ ] Address bar: `localhost:5173`, `index.html`, `example.com` (opens its own window); back /
      forward / reload work; the tab title follows the page title
- [ ] Right-click an .html file → Open preview (or Ctrl/Cmd+Shift+V in it) → saving reloads it
- [ ] Console counts (⊗ / ⚠) show console errors, uncaught exceptions and 4xx/5xx requests;
      clicking them opens the console under the page; Clear empties it
- [ ] A link to another site in a preview opens in the system browser, not in the tab
- [ ] Agent with a browser tab open: "click Increment and tell me the count" uses browser_snapshot
      and browser_act (asks before acting), browser_console finds errors
- [ ] External window: closing it leaves the tab with "Open again"; closing the tab closes it

## 6i. DevTools, servers, terminal, VS Code files
- [ ] Ask the agent to "run the server" in a Node project: it starts in its own terminal tab and
      keeps running; the status bar shows localhost:PORT; the toast's "Open in browser" works
- [ ] `echo http://localhost:9999` in a terminal: no server toast (nothing listens there)
- [ ] Browser: F12 (also with focus inside the page) opens DevTools; Ctrl+Shift+C then click an
      element → selected in Elements with its rules and box model; hovering rows highlights the page
- [ ] Console: errors/warnings/info filters, `console.table`/`group`, objects expand, an element
      logged reveals in Elements; typing `document.title` + Enter shows the result; ↑ recalls
- [ ] Network: requests with status, type, size, time; a row shows headers, payload, preview,
      response; "Copy as cURL"; Disable cache; Preserve log survives a reload
- [ ] Sources lists scripts/styles; a workspace file opens in the editor from there
- [ ] Application: edit/delete localStorage keys and cookies
- [ ] Device mode: iPhone / iPad sizes, rotate, custom size
- [ ] HTML preview updates while typing (not only on save); a CSS edit applies without reload
- [ ] Terminal: select text + Ctrl+C copies (no ^C); Ctrl+C alone interrupts; Ctrl+V pastes;
      right-click menu; `src/x.ts:3` style paths open the file at the line; a command's output
      scrolled up shows the command pinned at the top; commands are colored
- [ ] A folder with `.vscode/settings.json` ("editor.tabSize": 2) uses it; the settings editor says
      so; "Import VS Code settings" finds your VS Code / Cursor settings
- [ ] Terminal → Run task… lists .vscode/tasks.json tasks and package.json scripts; Ctrl+Shift+B
      runs the build task
- [ ] files.autoSave "afterDelay" saves after a pause; editor.formatOnSave formats on Ctrl+S

## 6j. Group drag, group menu, title bar, screenshots, Go Live
- [ ] Grab a group's tab strip (empty area) and drag: the live group shrinks toward the pointer
      (same aspect, grabbed point under the cursor), its slot shows a dashed outline; drop on an
      edge splits, on another strip merges, Escape returns it; it glides into place
- [ ] A group with one tab: dragging the tab moves the whole group the same way; a browser page
      inside keeps running (no reload) and scales with the group
- [ ] Right-click a tab strip's empty area, and its ⋯: New tab ▸ (terminal, browser, agent…),
      Split ▸ up/down/left/right, New file…, Tabs ▸, Maximize, Close saved, Close group
- [ ] Title bar: the logo is left of File; narrowing the window first shrinks the search field,
      then the menus collapse into ☰; the layout toggles appear only on hover; close hover is red
- [ ] Explorer header: new file / new folder / collapse / ⋯ (refresh, reveal, terminal, close folder)
- [ ] Ctrl+F: the find widget is dark like the editor, not a bright panel
- [ ] Status bar: Go Live previews the open HTML file (or picks one); shows "Port: N"; click stops
- [ ] Bell: a warning/error toast bumps the count; the list shows them with their actions; do not
      disturb keeps info toasts out; Clear all
- [ ] Per-file bar: Spaces: N menu (tabs/spaces, size, convert), UTF-8, LF/CRLF
- [ ] Browser ⧉ button: the page moves to its own window (live reload still works); "Show in
      this tab" or closing the window brings it back
- [ ] Palette "Take screenshot of the IDE": saved under .jonna/screenshots and opened
- [ ] Agent (vision model): "take a screenshot of the page and tell me what's on it" — a
      thumbnail shows in the chat and the model describes the page

## 6k. Terminal and browser fixes (m6.1)
- [ ] Terminal: scroll up through a long output: the command's own line (prompt + colored command)
      sticks at the top on the terminal background; click it to jump back
- [ ] Overview ruler beside the scrollbar: a mark per command, red for failed ones and error lines
- [ ] `clear` empties the terminal; typing doesn't move the view
- [ ] Hovering a link shows a pointer and "Ctrl + click to open…"
- [ ] DevTools docked right: dragging the divider resizes smoothly; narrow tab: DevTools fits
- [ ] Status bar localhost item: opens the server, or shows its tab if one is open
- [ ] Open a menu, pop the page into a window, close the window: no menu left on screen

## 6l. Folder switch, browser toolbar (m6.2)
- [ ] Close folder, open another (or the same): the terminal takes input, Ctrl+` and New terminal work
- [ ] Browser: device size and own-window icons inside the address field; DevTools button shows
      red/yellow counts; reload clears the console and network (unless Preserve log)

## 6m. Auxiliary windows (m6.3)
- [ ] Browser tab: the window icon in the address field moves the whole tab (toolbar, page,
      DevTools) into its own window; the group shows "Open in its own window" (Show / Bring back)
- [ ] In that window: menus, tooltips, DevTools panels, F12, keyboard shortcuts work; the agent's
      browser tools and screenshots work
- [ ] Closing the window brings the tab back; closing the tab closes the window
- [ ] "Open only the page in a window" (⋯) still pops just the page out; Network isn't flooded

## 6n. Extensions and workspace trust (M6)
Use the example in `tests/fixtures/extensions/hello` (copy it somewhere first) and, for a VS Code
theme, any theme extension folder (e.g. an unzipped `.vsix`'s `extension/` folder).
- [ ] Extensions view (blocks icon, `Ctrl+Shift+X`): **Load unpacked…** the hello folder → the
      permission dialog lists "Read files in the open folder"; Allow → the row shows it, a
      "Hello tree" icon appears in the activity bar with Fruits/Greet rows (Fruits expands)
- [ ] Palette "Say hello" → nothing visible but no error; "Show Hello panel" opens a bottom tab
      with the page in the IDE's colors; "Ping the panel" updates the page text
- [ ] Edit `main.js` (e.g. change the greeting text) and save → the extension reloads by itself
- [ ] "Write notes" fails with a message about `fs.write`; the row's log button shows the denials
- [ ] A `.hello` file is highlighted (keywords hello/bye, # comments); typing `hi` offers the snippet
- [ ] Load a VS Code theme folder → **Preferences: Color theme…** lists it; picking it recolors
      the editor (syntax) and the accents; picking Dark/Light goes back
- [ ] Disable / enable / remove from the row buttons; remove of an unpacked one keeps the folder
- [ ] Workspace trust: open a folder with `.vscode/tasks.json`, run a task → "Trust the authors…"
      dialog; Stay restricted → the task doesn't run and the status bar shows "Restricted mode";
      clicking it lets you trust the folder, then the task runs. Reopening the folder remembers it

## 6o. Chat work groups, extension template, terminal after folder switch (m6.5)
- [ ] Ask the agent something that reads/edits files: one line under your message shimmers with
      what it's doing (dots + "Reading …"), then reads e.g. "Read 2 files, edited a file · 6s";
      clicking it shows thinking, notes and tool rows; the answer is below; diff cards stay visible
- [ ] Setting `agent.streamText` off: the answer appears at once when complete
- [ ] Extensions view → **Create extension…** → name `my-tool` → `main.js` opens, a "My tool"
      sidebar icon appears; edit the notify text, save → it reloads; ask the agent "make an
      extension that adds a command counting TODOs" → it uses extensions.create and edits files
- [ ] Windows: close the folder, open another → the restored terminal and new terminals start
      (no blank tab, no "still waiting" message)

## 6p. AI in the editor (m6.6)
- [ ] Off by default: Ctrl+I does nothing and the right-click menu has no "Edit with AI…" until
      `editor.inlineEdit.enabled` is on
- [ ] Select a few lines → Ctrl+I → a prompt bar appears above them; type "add comments", Enter
      → "Editing…" then the new lines are green, the old ones struck through above; Ctrl+Enter
      keeps them; repeat and Esc → the file is exactly as before (no unsaved dot)
- [ ] In review, type another instruction → the result is refined; Esc still restores the original
- [ ] Right-click in an editor → "Edit with AI…"
- [ ] Settings: `editor.inlineCompletions.enabled` on (and a small model in
      `editor.inlineCompletions.model`, e.g. ollama/qwen2.5-coder:1.5b) → typing pauses show gray
      ghost text; Tab accepts, typing on dismisses

## 6q. Extensions view, settings resets, agent checks (m6.7)
- [ ] Extensions view: filter box, Installed / Development sections, rows with an avatar and a gear
      on hover; right-click a row = the gear menu; clicking a row opens its page (Details,
      Features, Permissions, Log)
- [ ] Ask the agent to build an extension that needs a permission (e.g. reads files): when it
      adds the permission, the Allow dialog opens by itself (or the agent opens it); the row's
      "Allow…" badge opens it too
- [ ] Gear → "Remove from list" keeps the folder; "Uninstall (delete folder)…" deletes it (inside
      the open folder it goes to the IDE's trash)
- [ ] Right-click an extension's activity bar icon → Details / Disable / Uninstall; right-click
      any icon → Hide; right-click the empty bar → check icons back on, "Show all"
- [ ] Settings: change a few, Reset all (arrow icon) asks then resets the current tab's scope;
      hover a section title with changes → reset button; right-click a section in the left list
      or a title → reset section / all / show only changed; right-click a setting → copy ID / JSON
- [ ] Explorer: compact like VS Code (chevrons only, file icons in the chevron column, 8px steps,
      guides on hover right under the parent's chevron); `explorer.folderIcons` adds folder icons;
      the root row's tooltip is to the right
- [ ] Agent edits a .ts file and introduces an error → its tool row says "· 1 error" and the next
      step fixes it (no mention of errors the file already had)
- [ ] Switch to another app while the agent works → a notification when it's done or needs you

## 6r. Agent plan, compaction, context meter, @-mentions (m6.8)
- [ ] Ask for a multi-step task: a "Plan" card appears above the message box with steps (spinner
      on the current one, checks on done ones); when idle it collapses to the current step
- [ ] The % next to the send button grows with the conversation (hover: tokens of the context)
- [ ] Type `/compact` → "Summarized N earlier messages" (expand to read it); the next answer still
      knows the task. With a small `agent.contextLength` (e.g. 4096) a long task summarizes by itself
- [ ] Type `@` → picker: Problems, Terminal output, Selection, and files as you type; chips appear
      above the box; the agent's answer uses them

## 6s. Approval cards, memory, unloaded extensions (m6.9)
- [ ] Ask the agent to run a command: the card shows "Run a command", the command as code, an
      "Always allow" checkbox and Deny (Esc) / Allow (Enter). Tick the box and Allow: the next run
      of that command (e.g. `npm test`) doesn't ask. A `cd <your folder> && …` the model adds is
      gone from the card. While it works, a small spinner (not dots) leads the work row
- [ ] Tell the agent "remember that we use pnpm": `.jonna/memory/` gets a topic file with the note,
      date and session. In a new session, ask "how do we install deps?": it knows (the index is in
      its prompt; it may `recall` the topic)
- [ ] "Tidy up agent memory" (palette): a new session reads the memory and recent sessions and
      proposes changes to `.jonna/memory/*.md`; nothing changes until you accept (per file or all)
- [ ] Write `.jonna/extensions/x/extension.json` by hand with mistakes (`"name"`, no `displayName`):
      Extensions shows it under "Not loaded" with what's wrong; fix it and press Load

## 6t. Cleanup pass and VS Code gaps (m6.10)
- [ ] Ctrl+click a localhost link in the terminal: the page opens in the editor area (the biggest
      group), not squeezed beside the terminal
- [ ] Browser: the address field has "Open in system browser" (and "Open in its own window");
      the device-size button is in DevTools' header next to dock side / close (and in ⋯)
- [ ] Open a folder never opened before: its README preview shows. Badges in a README render as
      images in one row
- [ ] Ctrl+W then Ctrl+Shift+T brings the tab back; Ctrl+= / Ctrl+- zoom the whole window,
      Ctrl+Numpad0 resets
- [ ] Ctrl+F in a terminal: a find bar with "n of m"; Enter / Shift+Enter step, Esc closes
- [ ] `.jonna/commands/review.md` with "Review $ARGUMENTS": `/review src/a.ts` in the agent runs it.
      A `.cursorrules` file is followed. ⋯ → Export as Markdown opens the conversation
- [ ] Hover a short type ("any") in the editor: no scrollbar, the copy button sits inside

## 6u. Claude and prompt caching (m6.11)
- [ ] Agent ⋯ / model menu → Add a provider → Anthropic, paste a key: Claude models are listed
      (from the API); pick one. A first message, then a second: hover the % next to send — the
      second request shows most of its tokens "from the prompt cache" and the session's cached share
- [ ] A task with several tool calls: the thinking shows (summarized) and the turn finishes without
      a 400 error about thinking blocks; `agent.effort` low/high changes how long it thinks
- [ ] With `agent.cacheTtl` "1h", come back after 10 minutes: still mostly cached
- [ ] An older Anthropic entry in agent.providers with kind "openai" works the same (native API)
- [ ] Run `sleep 35` in a terminal and switch to another app: a notification when it ends
- [ ] Type "/" in an empty agent box: the command picker (/compact, your .jonna/commands); paste a
      screenshot: a thumbnail chip, sent with the message to a vision model
- [ ] Click the language in an editor's status bar: pick another language; colors change

## 6v. Compare, zen, Outline (m6.12)
- [ ] Type in a file without saving → File → Compare with saved: saved ↔ unsaved side by side;
      "Revert to saved" undoes it (Ctrl+Z brings it back)
- [ ] Explorer: right-click a file → Select for compare, another → Compare with …: a diff; swap
      sides from its toolbar. Duplicate makes "name copy.ext" (Undo removes it)
- [ ] Ctrl+K Z: only the editors remain; again: everything back where it was
- [ ] Outline (activity bar): the file's symbols; moving the cursor highlights the one it's in;
      the filter narrows it; clicking jumps there. A .ts file just opened fills in within seconds
- [ ] Select code → right-click → Copy as Markdown: paste shows `path:lines` and a fenced block
- [ ] Double-click a terminal's tab: rename it

## 6w. Editor menu, symbols (m6.13)
- [ ] Right-click in a .ts file: Go to definition, Go to implementations, Go to references, Peek ▸
      (definition, implementations, references), Go to symbol in editor, Rename, Format… — each
      works (Peek opens the inline peek view)
- [ ] With a language server (e.g. Python, Rust): Go to type definition appears too
- [ ] A .md file: breadcrumbs show the heading you're in; Outline lists the headings nested
- [ ] A .py / .rs / .go / .sh / .yml file without a language server: breadcrumbs and Outline show
      its classes/functions (keys for YAML); Ctrl+Shift+O lists them
- [ ] An agent turn that thinks: open the work group — the thought shows once, no second header

## 6x. Sidebar side, sticky rows, PowerShell chains (m6.14)
- [ ] Right-click the activity bar → Move sidebar right: activity bar + explorer on the right, the
      editors and agent on the left; resizing the sidebar works (drag its left edge); the title
      bar's sidebar toggle hides/shows it; tooltips of explorer rows open to the left. Move back
- [ ] Scroll a deep folder in the explorer with a pinned folder selected or hovered: the pinned rows
      stay solid (nothing shows through)
- [ ] Windows PowerShell 5.1 (no PowerShell 7 installed): `cd src && dir` and `npm test || echo
      failed` work in the terminal; with PowerShell 7 installed (even off PATH), the terminal
      title says pwsh
- [ ] Ask the agent to run `cd src && dir` on 5.1: it runs

## 6y. Terminal clear, peek colors, breadcrumbs (m6.15)
- [ ] Run a few commands, then type `clear` (bash/zsh) or `cls` (PowerShell): the terminal is
      empty with just the prompt, no leftover command decorations or sticky command; same as the
      Clear button
- [ ] Right-click a symbol → Peek → Peek definition: title bar, editor and result list use the
      editor's colors (no blue/light Monaco defaults)
- [ ] Open a folder and open a `.tsx` first: breadcrumbs show the function at the cursor after a
      moment; Go to definition works. Same for a `.jsx`, a `.css` (selectors), an `.html` (tags), a
      `.json` (keys) and a `.md` (headings)

## 6z. Agent dev servers, command approval, snippets, links (m6.16)
- [ ] Ask the agent to run the project (`npm run dev`) on Windows: it says it's running with the
      address, the page opens in a browser tab, and it doesn't start it again
- [ ] Composer pill → "Run commands automatically": `npm test` runs without a card (lightning icon
      on the pill); `rm`/`Remove-Item`/`git push` still ask. Switch back to "Ask before commands"
- [ ] Select text in an agent answer and a code block; Ctrl+C copies it
- [ ] Scroll up in a long chat → "Jump to latest" → it scrolls down and the button disappears
- [ ] Browser bar: picker shows a cursor-in-square icon, DevTools a `>_` icon, both centered;
      maximized window's restore icon has the back square at the top right
- [ ] Right-click an `.html` in the explorer: "Open preview" has the globe icon
- [ ] Preferences → Snippets → Project snippets: a commented template opens; add a snippet, save,
      type its prefix in a matching file: it's suggested
- [ ] Ctrl+click `src/main.ts:3` written in a .md or .txt file: opens main.ts at line 3

## 6aa. Terminal clear on Windows, viewers, progress (m6.17)
- [ ] PowerShell: run a few commands, type `cls`: empty terminal, no green dots or ruler marks left;
      the next command runs normally (no surprise clear after it)
- [ ] Clear button, then paste a command: it shows once; Enter runs it and the old lines don't
      come back
- [ ] Press Enter on an empty prompt, then Clear: same as above
- [ ] Open a `.pyc` (or any binary): hex view; another binary type: notice with "Open in hex viewer"
- [ ] Open an `.mp3` / `.mp4`: plays in the tab; switching tabs pauses it
- [ ] `.csv`: "Open preview" shows a table with a sticky header and row numbers, live as you type
- [ ] Paste or drag a big folder into the explorer, close the folder, push with git: a blue line
      at the top of the explorer / Source control (or a moving mark under its icon)

## 6ab. Tabs, toggles, agent activity, applied diffs, scrollbars (m6.18)
- [ ] Two editor groups: click × on a tab in the group that isn't focused: it closes
- [ ] Sidebar on the right: the title bar's rightmost toggle hides/shows the sidebar, the one
      before it the agent region, the first the bottom region
- [ ] Ask the agent to write a whole page: the header says "Writing index.html (…k characters)…"
      while it generates (cloud models), or a thought heading while thinking
- [ ] Auto-apply on, agent edits a file: "Open diff" on its card shows before ↔ after
- [ ] Open a dark page in the browser tab: the scrollbar is dark; a light page keeps its normal
      scrollbar; a page with its own scrollbar CSS keeps it

## 6ac. Clone, blame, conflicts, terminal looks, hot exit, viewers (m6.19)
- [ ] Git → Clone repository…: paste a GitHub URL, pick a folder: progress shows, then Open
- [ ] In a repository, move the cursor: the status bar shows "Name, N days ago"; edit a line:
      "Not committed yet"; click it for the commit
- [ ] A file with a merge conflict: lenses above `<<<<<<<`; each one resolves as named; Ctrl+Z
      undoes
- [ ] Terminal right-click → Change color… / Change icon…: the tab changes; restart keeps it
- [ ] Edit a file without saving, close the window: no prompt; reopen: the edits are back, unsaved
- [ ] Open a .ttf, an .ipynb with outputs and a .zip: each shows in its viewer
- [ ] PowerShell 5.1: `npm test || echo failed && echo next` prints "next" when tests pass;
      typing `if ($true) {` + Enter shows no running dot until the block is finished
- [ ] Two-line prompt (oh-my-posh / starship): Clear keeps both prompt lines
- [ ] Agent in "Run commands automatically": `bash -c "…"`, `/bin/rm x`, `git -C . push` ask

## 6ad. Product name, welcome, folder-less agent, chats, settings, TODO tree (m6.20)
- [ ] A project that had `.ide` opens with it renamed to `.jonna` (memory, commands, snippets kept)
- [ ] Welcome: four cards work with and without a folder; hovering a recent project shows ×,
      which removes it
- [ ] Status bar: the servers item sits on the right next to Go Live
- [ ] Clone `owner/repo` of a public repository while signed out of GitHub: it clones; a private
      one asks for sign-in through Git Credential Manager (Windows) or says what to do
- [ ] No folder open, ask the agent "make a snake game in python": the card suggests
      `snake-game-python` in `~/Projects`; Create and start opens it and the agent continues;
      "Just chat" answers without a folder
- [ ] Chats sidebar (bot icon): new chat, search, click to open, × to delete; a running chat spins
- [ ] Settings: left nav with icons; narrow the window: it becomes an icon rail; switches toggle
- [ ] Extensions view lists "TODO tree" disabled; enable + allow: the sidebar view lists TODOs,
      click jumps to the line, saving a file refreshes it; uninstall: it doesn't come back

## 6ae. Stash, compact folders, Apply, inputs (m6.21)
- [ ] Git → Clone repository…, blame in the status bar and the agent's "Create and start" all
      work (they failed with "not allowed" in m6.19–m6.20)
- [ ] Settings, welcome cards, agent cards: every text field is lighter than the card under it
      (dark theme) / white (light theme)
- [ ] The agent's activity-bar icon is the star; settings nav says "Language servers"
- [ ] A folder `a/b/c/file.txt`: the explorer shows `a/b/c` as one row; adding a file to `a`
      splits it again
- [ ] Git → Stash changes…: message prompt, the tree is clean; Pop stash…: picker, changes back
- [ ] Ask the agent for a code block with ```` ```js:src/x.js ````: Apply opens a diff of just
      that function; Insert types the block at the cursor

## 6af. Preview speed, reload spinner, logo (m6.22)
- [ ] A Vite + React app (`npm create vite@latest`, react template) in the browser tab: reload
      feels as quick as VS Code's Simple Browser; hot reload still works
- [ ] Reload: the arrow turns until the page has loaded
- [ ] Drag the browser tab to another group: the page keeps its state (a counter keeps its value)
- [ ] Narrow the sidebar with no folder open: the explorer's buttons wrap, nothing is cut off
- [ ] New logo in the title bar, welcome tab, taskbar and installer

## 6ag. Chat titles, rename / clear, Fix with agent (m6.23)
- [ ] New chat: after the first answer starts, the tab and the Chats list show a short title
      (not the first words of the message); no `<title>` text ever shows in the answer
- [ ] Chats: double-click renames; right-click → Rename / Delete / Clear chats…; trash button
      asks "This folder's" / "Delete all"
- [ ] Run a failing command (`npm run nope`): "Fix with agent" appears top right of the
      terminal; clicking it sends the command and output to the agent; the next command hides it

## 6ah. Agent column, chat pins (m6.24)
- [ ] Maximize the agent: header, messages and prompt line up in one centred column
- [ ] Chats: hover shows "…" (same menu as right-click): Pin puts the chat under "Pinned";
      the tooltip (to the right) says when and where
- [ ] Right-click the Chats icon in the activity bar → hide it while it's showing: the sidebar
      switches to Explorer

## 6ai. Untitled files, extension tabs, chats from other folders (m6.25)
- [ ] Ctrl+N: "Untitled-1"; type, Ctrl+S: the save dialog suggests the first line as the name;
      the tab becomes that file (colors for its language); with no folder open, its folder opens
- [ ] Close an untitled tab with text: "Save changes to Untitled-1?"; empty: closes quietly
- [ ] Extensions: clicking extensions in turn reuses one (italic) tab; the same one twice is one tab
- [ ] Chats sidebar with a folder open: its chats are under "This project" (newest first),
  before Today; other folders' chats are under the day groups with their folder's name.
- [ ] Model picker: the model button shows the provider's logo; the picker's rail has the star,
  your providers and installed agents; typing searches all of them; a star keeps a model in
  Favorites; a picked model shows under Recent; Escape and a click outside close it; in a narrow
  panel it still fits.
- [ ] Effort button: no brain icon; with Codex or Claude Code it lists the agent's reasoning
  levels. The permission button is last (Review / Accept edits / Auto). No chevrons or icons on
  these buttons except the provider's logo; the effort is dimmer than the model.
- [ ] Attach a .zip (Upload from computer…): one ZIP card with its file list and text files; ask
  the agent to extract it into the project.
- [ ] Codex with Review edits on: it asks before writing a file (an approval card), instead of
  showing the change only afterwards.
- [ ] The agent runs `terminal.runCommand` with a long timeout (an install): no "must be <=
  600000" error.
- [ ] Open a chat from another folder (under the day groups, with its folder name): the strip offers Open <folder> / Continue here
- [ ] Outline with no editor: the message sits near the top

## 6aj. Verify step, explore, inline blame, file history (m6.26)
- [ ] Auto-apply, a Vite/React project with a failing test: the agent edits, "Checked with npm
      test" fails, the agent fixes it, the check passes; in Review edits mode no check runs
- [ ] Ask "how does routing work in this project?": the agent uses explore (one row, a report),
      then answers
- [ ] Git → Toggle inline blame: faint "Name, age • subject" after the cursor's line
- [ ] Git → Show file history: commits of the file; picking one opens a diff with the file now
- [ ] Chats: the tooltip sits beside the list, two lines

## 6ak. Editor settings, brackets, scrollbars (m6.27)
- [ ] A .ts file: Ctrl+/ comments the line; brackets are colored by depth; typing ( adds )
- [ ] New profile: font 14, minimap on
- [ ] Scrollbars in lists, the settings page and the explorer are a bit wider than before;
      Settings → Workbench → Scrollbar size changes them live; the editor's and terminal's too
- [ ] Set a setting to its default value, then reset it: the blue bar and reset button go away
- [ ] Settings → Agent lists the inline edit / completion settings

## 6al. Code actions, problems, Outline section (m6.28)
- [ ] A .ts file with `foo();` (undefined): click the lightbulb (or Ctrl+.) → a menu with
      "Add missing function declaration 'foo'"; Enter applies it; Escape or a click elsewhere
      closes it and the window keeps responding
- [ ] Problems tab: hover a problem → copy button; right-click → Copy, Copy message, Fix with
      agent…; Ctrl+C on a selected problem; the pasted text is `path:line:col - error …: message`
- [ ] The per-file problems list under the editor has the same copy button and menu
- [ ] Right-click the Outline activity icon → Hide: an OUTLINE section appears at the bottom of
      the Explorer, collapsed; click it → expands with the symbols; drag the line above it to
      resize; right-click its header → Show in activity bar brings the icon back

## 6am. Web context, profiles, column selection, shortcuts (m6.29)
- [ ] Agent: type @ then `https://docs.rs/serde` → a globe chip; send "summarize this page" → the
      answer uses the page; ask the agent to read a URL itself → it asks before fetching
- [ ] Preferences → Export profile… saves a .json where you pick; change a setting; Import
      profile… asks, then the setting is back. A user snippet (Configure snippets → a language)
      can be created and is suggested
- [ ] Selection → Column selection mode: drag selects a rectangle; "Column selection" shows in
      the status bar (click turns it off); the menu item has a check while on
- [ ] Keyboard shortcuts: right-click a row → Show same keybindings; the keyboard button, then
      press Ctrl+S → the commands on Ctrl+S

## 6an. Agent attachments, Outline actions (m6.30)
- [ ] Agent: + → Upload from computer… → pick an image and a text file → two cards; × removes
- [ ] Drag a file from Windows Explorer onto the chat → a card (the explorer doesn't import it);
      drag a file from the IDE's explorer onto the chat → a card
- [ ] Paste a long text (15+ lines) → a "Pasted" card, not text in the box; paste a screenshot →
      an image card; send → the cards show above your message
- [ ] Narrow agent panel: the controls row stays on one line (icons for mode and reasoning)
- [ ] Reasoning pill → Always think / effort / Agent settings… opens Settings on Agent
- [ ] Outline: collapse all button; "…" → Sort by name; right-click a symbol → Select symbol
- [ ] Explorer: scroll inside a deep folder → the pinned folder rows line up with the rows under them

## 6ao. Syntax, themes, file icons (m6.31)
- [ ] Open a .ts file: colored at once; a `( [` inside a comment or string isn't bracket-colored
- [ ] Color theme… → Dracula Theme (or any Shiki theme): the IDE and the code follow; back to Dark
- [ ] Explorer shows Material icons (folders and files), tabs and breadcrumbs too; Preferences →
      File icon theme… → Minimal brings back the small glyphs; with folder icons on, files don't
      shift right
- [ ] Install a VS Code icon theme extension (e.g. vscode-icons unpacked) → it appears in File
      icon theme… and works
- [ ] Title bar has no folder name; maximize a group → the button shows inward arrows → restores
- [ ] Many tabs: hover the strip's scrollbar → arrow cursor, not the hand
- [ ] Sidebar closed, drag a file from the system over the window → the explorer opens

## 6ap. Quick access, documentation, About (m6.32)
- [ ] Ctrl+P → files; type `>` → commands (placeholder changes); delete it → files again
- [ ] Ctrl+Shift+P and F1 → the box opens with `>`; recently run commands come first
- [ ] Ctrl+Shift+O in a .ts file → `@` symbols; pick one → the cursor goes there
- [ ] Ctrl+T, type a function name from another file → it's listed with its path; Enter opens it
      at the declaration
- [ ] Ctrl+G → `:`; type `12` → Enter goes to line 12; `?` lists the prefixes
- [ ] Open three files; Ctrl+Tab → the previous file is selected; Tab again (Ctrl held) → the next;
      release Ctrl → it opens. Ctrl+Shift+Tab starts from the other end
- [ ] Help → Documentation → a tab with the guide; links that run commands work; narrow tab hides
      the page list
- [ ] Ask the agent "how do I switch models?" → it reads the guide (`help.readDocs`)
- [ ] Help → About → a dialog with version, OS and webview; Copy copies them
- [ ] Add OpenRouter as a provider → the model becomes `openrouter/free`
- [ ] Flush layout: no line above the status bar, but a line under the sidebar and editors
- [ ] Explorer with Outline below: the Outline header's buttons don't overlap the resize line

## 6aq. Tasks, preview toggle, badges, Manage menu (m6.33)
- [ ] A project with `.vscode/tasks.json` using `"problemMatcher": "$tsc"` (e.g. `tsc --noEmit`
      with an error): Run task → the terminal shows "Executing task", the error, the exit code;
      Problems lists it even though the file isn't open; opening the file shows the squiggle
- [ ] Run the same task again → it reuses the finished terminal tab; press a key in a finished
      task terminal → it closes
- [ ] A watch task (`$tsc-watch`) as `dependsOn` of another: the second starts after the first
      build; edit a file with an error → Problems updates after the rebuild
- [ ] A task with `${input:…}` asks; `"type": "process"` and `options.env` work (Windows too)
- [ ] While a task runs: status bar item → Show running tasks; Terminal → Restart / Terminate task
- [ ] Gear → Tasks → Open user tasks → a tasks.json you can add tasks to; they appear in Run task
- [ ] Open README.md → the eye button (or Ctrl+Shift+V) → the same tab shows the preview; Open
      source (or Ctrl+Shift+V) → back to the file. Ctrl+K V → preview beside; its Open source
      focuses the file on the left
- [ ] Type in a file without saving → a 1 on the Explorer icon; git changes → a number on Source
      control; push/pull with another view shown → the spinning badge on Source control
- [ ] Gear → the Manage menu (Themes → Color theme…, Layout density → Compact…)
- [ ] Settings → Workbench → Color theme is a dropdown (Built-in Dark, Dracula…); File icon theme
      is a dropdown (Material / Minimal); Explorer → Folder icons off → no folder icons with Material

## 6ar. Color theme, frame (m6.34)
- [ ] Settings → search "theme": one **Color theme** dropdown (Dark+, Light+, Shiki themes…), no
      separate Dark/Light setting; an old settings.json with `"workbench.theme": "light"` and an
      empty color theme comes up as Light+
- [ ] Slack Ochin: menus, quick access, inputs and title bar are light with readable text
- [ ] Dracula: dividers and inputs have subtle borders, not purple ones
- [ ] Explorer shows no folder icons until Explorer → Folder icons is on
- [ ] Flush layout: no line under the title bar over the activity bar; the sidebar + editors have
      rounded outer corners with a small gap on the right; hide the sidebar (Ctrl+B) → the editor
      area gets the left corners; sidebar on the right → mirrored

## 6as. Startup look (m6.35)
- [ ] Pick Dracula (or any non-built-in theme), quit, start again: the window opens in Dracula —
      no Dark+ frame first; the terminal restored with the folder uses the theme's colors

## 6at. Git workflow, floating sidebar, sidebar snap (m6.36)
- [ ] Source control → Commits: expand a commit → its files; click one → "parent ↔ commit" diff
- [ ] Commit button's arrow → Commit (amend) / Commit & push / Undo last commit
- [ ] The sparkle in the message box writes a message for staged changes (with a model set up)
- [ ] Merge a branch with a conflict → banner "Merging · 1 conflict"; resolve, stage → Continue
      commits the merge; or Abort goes back
- [ ] Create branch from…, Rename branch…, Delete branch… (unmerged → asks), Create tag…
- [ ] A new branch's first Push publishes it; diverged branches → Pull asks Rebase / Merge
- [ ] Right-click an untracked file → Add to .gitignore
- [ ] Floating panels: the explorer has the title bar's color; editor groups have a border
- [ ] Drag the sidebar's edge to the left past its minimum → it closes; drag back → it reopens

## 6au. Keys, editor theme colors, chat (m6.37)
- [ ] Windows: Ctrl+Shift+P opens the command box with `>` (in the editor, the terminal, anywhere);
      Ctrl+P, Ctrl+F, Ctrl+R / F5 do the IDE's things, not the browser's
- [ ] Pick Night Owl (or One Dark Pro) and restart: the editor's scrollbar uses the theme's color
      at once; switching themes changes it too
- [ ] Agent chat: your messages are on the right, narrower; more room under the last message

## 6av. Git graph, rebase, worktrees, GitHub, sign-in; search (m6.38)
- [ ] Source control: the message box is two lines tall, its sparkle sits left of the scrollbar
      when the text scrolls; the Commit button's split line is a soft divider
- [ ] Commits shows lanes: make a branch, commit on it, merge it → the branch line leaves and
      rejoins. The graph button on the Commits row shows every branch (and back); expanding a
      commit keeps the lines running past its files
- [ ] Right-click a commit → Interactive rebase from here…: the tab lists the commits oldest
      first; drag one, press `r` and type a message, `s` / `f` / `d` on others → Start rebase →
      confirm → the history matches. A conflict stops it with the banner's Continue / Abort
- [ ] Git → Create worktree… → new branch → the folder next to the repository → Open in a new
      window: a second window opens there. Git → Worktrees… lists both; Delete worktree… removes it
- [ ] With the GitHub CLI signed in (`gh auth login`): Git → Pull requests… lists them; open one
      (description, checks, comments; Checkout / Open on GitHub / Merge…). On a branch with a pull
      request the status bar shows `#n`. Create pull request… publishes the branch and makes one.
      Without gh: a clear message how to install it
- [ ] Linux/macOS without a credential helper: push to an HTTPS remote → the quick input asks
      for the username, then the password/token (dots); Escape cancels the push
- [ ] Search: the book icon in "files to include" searches only open editors; the filter icon in
      "files to exclude" turns exclude settings and .gitignore off; `search.exclude` in settings
      applies; smart case; the AB icon in the replace field keeps case. Right-click results: open to
      the side, replace one match, dismiss, copy (path / relative / all), reveal, find in folder,
      exclude folder, collapse / expand all

## 6aw. Inline problems, project formatter, accounts (m6.39)
- [ ] A TypeScript error shows its message after the line in red (warnings in yellow);
      `editor.inlineDiagnostics: off` hides them
- [ ] In a project with Prettier in node_modules (or Biome with biome.json, Ruff in
      pyproject.toml, a Cargo project): Shift+Alt+F formats with it, the cursor stays where it was;
      with `editor.formatOnSave` Ctrl+S does too. A syntax error shows "Couldn't format: …"
- [ ] Source control: nothing staged → the sparkle asks "Stage all and continue", then writes
      the message (also with a thinking model such as qwen3)
- [ ] The person icon above the gear: "Sign in to your … account" explains it's coming;
      "Sign in to GitHub…" opens a terminal with `gh auth login`; afterwards the menu lists your
      GitHub login. "Backup and sync settings…" exports / imports a profile
- [ ] Notifications, errors included, disappear on their own (hovering keeps them)
- [ ] The title bar box says Ctrl+P and opens quick open; the welcome page has no link row and
      recent projects are vertically centered when hovered

## 6ax. Undo you can trust (m6.40)
- [ ] Expand a project folder a few levels, delete it, Ctrl+Z in the explorer: every file is back
      and the same folders are open. Ctrl+Y deletes it again (asks first), Ctrl+Z restores
- [ ] Delete a file, create a new one with the same name, Ctrl+Z: a warning says it won't
      overwrite it; nothing changes. Delete the new one, Ctrl+Z again: the old one comes back.
      "Skip it" on the warning lets older steps be undone instead
- [ ] Windows: open a file of a folder in another program (e.g. a running dev server), delete the
      folder: an error says nothing was deleted (never a silent permanent delete)
- [ ] New file, then Ctrl+Z in the explorer: "Undo … This deletes 'x'?" (explorer.confirmUndo)
- [ ] Rename `util.ts` (imported by others) → "Update imports for 'util.ts'?" Yes: importers
      change; Ctrl+Z in the explorer reverts the imports and the name together. Always / Never
      remember the choice (editor.updateImportsOnFileMove)
- [ ] Replace all across files with one of them open; click into it, Ctrl+Z: "Undo … in all
      files?" → Undo in N files restores every file; "Undo this file" only that one. Ctrl+Y there
      offers to redo everywhere. Typing first, then Ctrl+Z: plain text undo, no question
- [ ] Two tabs with edits: Ctrl+Z only undoes in the tab you're in
- [ ] File → Restore deleted files…: lists what was deleted here (30 days); restoring puts it
      back, or beside as "name (restored)" when the name is taken
- [ ] Linux: with `readme.md` and `README.md` both present, renaming one to the other is refused

## 6ay. Stuck models, avatar, hidden files (m6.41)
- [ ] With a free OpenRouter model, ask something that makes it loop: within seconds of the
      repetition the turn stops with "The model got stuck repeating itself…"
- [ ] Signed in with `gh auth login`: the Accounts icon shows your GitHub picture; the menu opens
      instantly (no pause)
- [ ] Explorer ⋯ → Show hidden files: .git and other files.exclude entries appear dimmed;
      unticking hides them again

## 6az. Debugger, bookmarks, partial undo, chat (m6.42)
- [ ] A `.js` file with a function: click left of a line number → a red dot. F5 → the program
      runs in a "Debug: Run …" terminal and stops there (yellow line, arrow). Variables shows
      the locals. F10 steps, F11 steps in, Shift+F11 steps out, F5
      continues, Shift+F5 stops. The debug console evaluates `a + 1` in the selected frame.
- [ ] Right-click a breakpoint in the Breakpoints list → Edit condition… `i === 2`: it stops only
      then. Add a line above it: the dot moves with its line.
- [ ] `pip install debugpy`, then F5 in a `.py` file: same as above. Without debugpy, F5 says to
      install it.
- [ ] Gear in Run and debug → `.vscode/launch.json` is created; its configuration appears in the
      picker and runs.
- [ ] Ctrl+Alt+K on two lines (a ribbon in the margin), Ctrl+Alt+L / J jump between them,
      Ctrl+Alt+Shift+K lists them with their text.
- [ ] Replace all in two files, edit one, then focus the explorer and press Ctrl+Z: "notes.txt
      changed since…" → "Undo in 1 file" reverts the other one only.
- [ ] Send the agent a message over 8 lines: it folds with "Show more" / "Show less". Bold in
      answers looks lighter. The arrow cursor shows over a code block's scrollbar.
- [ ] The new logo appears in the title bar, welcome page, taskbar and installer.

## 6ba. Clean environment, agent on Windows (m6.43)
- [ ] Start the IDE with `npm run dev`; in its terminal `Get-ChildItem env:npm_*` lists nothing and
      `$env:PATH` has no `Desktop-IDE\node_modules\.bin`
- [ ] Ask the agent to "delete node_modules and list the first 5 files": its `rm -rf` / `| head`
      run as PowerShell commands and succeed
- [ ] A failed command with a long error: the chat doesn't scroll sideways
- [ ] Many editor tabs: the strip's scrollbar handle brightens under the pointer

## 6bb. Debugger like VS Code (m6.44)
- [ ] Right-click left of a line number → Add logpoint… `i is {i}`: running prints it in the
      debug console and doesn't stop. Add conditional breakpoint… and Edit hit count… (`3`)
      stop only then. Caught exceptions stops at a `throw` inside try/catch.
- [ ] Paused: hover a variable (or `obj.prop`) in the editor → its value. Watch → + `a + b`;
      it updates on each step. Double-click a variable → new value; the program uses it.
- [ ] Ctrl+F10 on a later line runs there. The floating toolbar sits over the top of the window;
      drag its grip; Settings → debug.toolBarLocation docked moves it into Run and debug.
- [ ] TypeScript: `npm i -D tsx`, launch.json with `"runtimeArgs": ["--import", "tsx"]` and
      `"program": "${file}"`: breakpoints in the .ts file stop at the right lines. Same with
      `tsc --sourceMap` output run from `dist/`.
- [ ] `node --inspect=9229 server.js` in a terminal, then a launch.json `"request": "attach"`
      configuration: breakpoints hit in the running server; Stop leaves the server running.
- [ ] In the debug console, evaluate an object: it expands.

## 6bc. Settings, editor metrics, DevTools (m6.45)
- [ ] Ctrl+, opens on All settings (scroll through everything; each section has its icon).
- [ ] A new editor wraps long lines; its lines look like VS Code's at 14 px (19 px apart on
      Windows). The terminal's text is 13 px.
- [ ] Browser DevTools: drag the divider between the DOM and Styles (and in Sources, Application,
      Network with a request open). In Styles: untick `color`, click a value and press ↑ on a
      number, click a color swatch, click a rule's `}` to add `border: 1px solid red`.
- [ ] Ctrl+F in Elements finds `button`; Sources → a file → find in it.
- [ ] Performance: load metrics (on Windows LCP / CLS too); Record, scroll the page, Stop → the
      frame-rate chart.
- [ ] Application: a page using IndexedDB shows its databases and stores.

## 6bd. Performance recording, small DevTools (m6.46)
- [ ] Performance → Reload and record: "Reloading…", then "Recording the page from its load"
      with seconds and fps; Stop → the timeline with FCP / DCL / L markers (on Windows also LCP,
      long tasks with their hatched part, memory). Hover the tracks: a line and a readout. Drag
      the overview to zoom (double-click: everything); drag across the tracks: the Summary
      follows the selection. Click a request bar: Network opens it.
- [ ] Record, click and scroll the page, Stop: on Windows the Interactions track shows the
      clicks.
- [ ] The load metric cards have a rating pill and a scale with a marker (no colored edge).
- [ ] Elements: click a collapsed "…": the element opens. The arrow and "…" show a pointer and
      hover.
- [ ] Make DevTools narrow (dock it to the side, or a small window): the tabs become icons (the
      selected one keeps its name), then scroll with the wheel. Console's levels become one
      menu. Network drops columns and stacks its details below the list, Application and
      Sources stack their panes. Nothing scrolls sideways.

## 6be. Graph and Publish to GitHub (m6.47)
- [ ] Open a folder that isn't a repository: Source control shows Initialize repository and
      Publish to GitHub. Publish (signed in with `gh auth login`): name, private / public. The
      repository appears on GitHub with your files and the branch tracks `origin`. Without gh
      sign-in: the dialog offers Sign in.
- [ ] The Graph:
  - [ ] The current branch is a blue badge with a target, `origin/main` beside it is a purple
        cloud, and tags and other branches are badges too.
  - [ ] Hover a commit: the card shows author, time and date, message, lines changed, the hash
        (copies) and Open on GitHub (opens the commit).
  - [ ] Auto / All switches branches; the target button selects HEAD; Show more commits adds 50.
- [ ] Commit something without pushing: the button says Sync changes 1↑; click it, then it's
      Commit again.

## 6bf. Testing view, audit fixes (m6.48)
- [ ] Open a project with Vitest or Jest tests (and one with pytest, cargo or go if you have them).
      The flask view lists them by framework and file. Run all: they turn green or red, a failed
      test shows its message, and the margin shows dots. Ctrl+; C runs the test at the cursor;
      fix a failure, then Ctrl+; E reruns the failed ones.
- [ ] Open the notifications list, close it, cause an error: the toast still pops up.
- [ ] Save, keep typing, wait: no "changed on disk" banner, autosave keeps working.
- [ ] Open a Windows-1252 file: read-only, with a banner saying it isn't UTF-8.
- [ ] Vite page with DevTools open, reload: Elements shows the new page.

## 6bg. Terminal pass (m6.49)
- [ ] Run `ls nope` (or `dir nope`): no chip appears. Point at that command's line: a small "Fix"
      shows at its right end, above the sticky line if it's pinned. Click the red dot: rerun,
      copy command, copy output, fix.
- [ ] Scroll a long output: the pinned line has the command's dot. Ctrl+Up / Ctrl+Down jump
      between commands. Ctrl+Alt+R runs a recent command.
- [ ] Ctrl+W deletes a word in bash/zsh (the tab stays open); Ctrl+L clears; Ctrl+C with a
      selection copies, without one it interrupts `npm run dev`.
- [ ] Paste three lines at a prompt that doesn't use bracketed paste (cmd.exe): asked first.
- [ ] Windows, `npm run dev` with Vite: drag the panel's sash, maximize and restore the window,
      collapse the panel and reopen it. The banner shows once, and no stale prompt is left below.
- [ ] Emoji and CJK at a PowerShell prompt: the cursor stays in place while editing.
- [ ] Drop a file from the system onto a terminal: its quoted path is typed.
- [ ] Make the window short: the activity bar's icons scroll; Accounts and Settings stay put.

## 6bh. Agent chat (m6.50)
- [ ] Ask for something that takes a few steps. Under your message, one line shimmers with what
      it's doing, with no spinner. Phrases change calmly, never "Thinking". When done, it says
      what it did.
- [ ] Click the line: a card of rows. Your first row is a headline or what it said, then tools
      ("Read …"), then "Thought process". Click a tool row for its output and the thinking behind it.
- [ ] Code blocks and command output are never darker than the chat.
- [ ] Send a long message: it folds with a fade and "Show more".
- [ ] While it works, type "also do X" and press Enter: your message shows, quieter, and the
      agent picks it up at its next step. Send another and click "Take back": it returns to the box.
- [ ] Press Stop with a message waiting: the message goes back to the box. "Stopped." has
      Continue.
- [ ] Send with no model available: your text and attachments are back in the box.
- [ ] `npm run dev` on Windows: no Rust warnings about `candidates` or `output_within`.

## 6bi. Fewer prompts (m6.51)
- [ ] `npm run dev` with its page open in the IDE's browser; Ctrl+C, run it again: no "server is
      running" toast, and the page comes back.
- [ ] A folder with a `runOn: folderOpen` dev task and last session's browser tab: no toast.
- [ ] Ask the agent to start the dev server while yours runs: it reuses yours (no :5174).
- [ ] Auto-apply and "run commands automatically" on: "set a breakpoint in src/main.tsx and
      start the debugger" asks nothing. Switch commands back to asking mid-chat: it asks again.
- [ ] Choose Auto-apply, restart the IDE, open a new chat: it's still Auto-apply.
- [ ] A folder without tests: no Testing icon; one with tests: it appears.
- [ ] A launch.json `chrome` configuration: a clear "not supported yet" message.

## 6bj. Changes card and plan (m6.52)
- [ ] Auto-apply, ask for something that writes many files: one "Changed N files +x −y" card,
      closed; open it: a row per file with counts, "new" on created ones; a row opens its diff.
- [ ] Review mode with one or two files: the card starts open with Accept / Reject per file and
      Accept all / Reject all in its header.
- [ ] A long multi-step task: the plan card ticks steps off as the agent goes.

## 6bk. Screenshots on the work line (m6.53)
- [ ] Ask the agent to check something visually: its screenshots appear as small thumbnails at
      the end of the work line while it works; click one: full size, ← / → between them, Esc closes.

## 6bl. Screenshot preview and saved images (m6.54)
- [ ] Rest the pointer on a work line thumbnail: a large preview with "Took screenshot · …" and "1 of N".
- [ ] Paste an image, let the agent take screenshots, restart the IDE, reopen the chat: the images
      and thumbnails are still there.

## 6bm. Attachments in the viewer (m6.56)
- [ ] Paste a long text and an image, attach a file from outside the folder: click each card in
      the box: text as a page, the image large, ← / → between them; a project file opens in the editor.
- [ ] Send, then click the sent cards: same, in the message's order; after a restart too.

## 6bn. Notes between steps, retry after restart (m6.57)
- [ ] A multi-step task: the agent's short notes show in the chat, each followed by its own
      collapsed "Ran 2 commands" line; only the latest one says "Working…".
- [ ] Paste an image, send, restart the IDE, click Retry: the agent gets the image again.
- [ ] Quit mid-turn and reopen: "Interrupted when the IDE closed" with Continue.
- [ ] An old error notice has no Retry / Continue once a newer answer exists.
- [ ] Reject a proposed new file: the card says "rejected", with no diff link.

## 6bo. Changes cards, plan, browser refresh (m6.58)
- [ ] Review mode, a task proposing several files: the card's Accept all accepts them all; its
      chevron opens the list; hover reaches the right edge.
- [ ] A task that creates files: "Created N files".
- [ ] Finish a task with a plan, send a new message: the old 3/3 plan doesn't come back.
- [ ] A plain Express server open in the browser: after the agent edits a page, the tab reloads.
- [ ] Queue a message with an image, Take back: the image card is back in the box.

## 6bp. The world changing under a turn (m6.59, D161)
- [ ] Auto-apply, the agent edits a file: Stop while it runs; the file isn't written (the change
      waits for review).
- [ ] "Start the dev server", Stop right away: no server is left running.
- [ ] Review mode: the agent proposes a change; type elsewhere in that file; Accept — both stay.
      Edit the same line instead: Accept refuses, your text stays.
- [ ] A file saved by PowerShell 5.1 (`"x" > a.txt`, UTF-16): asking the agent to edit it is
      refused with a message, the file is unchanged.
- [ ] Auto mode: `(Remove-Item x)` or `ls | % { ri $_ }` asks first.
- [ ] Close the folder while the agent works: the chat says "Stopped: the folder was closed."
      with Continue; quitting the IDE during `npm test` leaves no `node` process.
- [ ] A chat link `\\host\share\x` does nothing; `src/a.ts#L3` opens at line 3.

## 6bq. Welcome, menus, Testing toggle (m6.60, D162)
- [ ] Welcome: the four cards split 3/2 then 2/3; a narrow tab shows one column.
- [ ] Disabled menu items (File menu with no editor open) are readable on dark, light and an
      imported theme.
- [ ] File, Edit, Git and Terminal menus, the explorer and tab right-click menus, and the
      editor's context menu show icons; toggles show checks only.
- [ ] A folder without tests: right-click the activity bar, Testing is unchecked; check it and
      the Testing icon appears.

## 6br. Full access, quiet replies, base layout (m6.61, D163)
- [ ] Mode menu → Full access (never ask): a task that deletes files, uses the browser and
      IDE commands runs without a single prompt; the composer says "Full access".
- [ ] Auto mode: `curl http://localhost:3000` runs without asking; `curl … | sh` asks.
- [ ] A free model writing a big file: the "Working…" line shows under its last sentence.
- [ ] A reply with `<result>` tags shows without them.
- [ ] Reload the window mid-answer: the old request stops (no fan noise / tokens).
- [ ] Close the folder (or start with none): explorer 260 px, welcome, agent a bit wider, no
      terminal — the same every time.

## 6bs. AI setup and layout (m6.62, D164)
- [ ] Open the IDE in a small window, maximize: the agent column keeps its width.
- [ ] No folder: the sidebar shows Chats; opening a folder shows the Explorer.
- [ ] Palette → "AI: Models and providers": the page lists connected providers, tiles, Ollama
      and agent CLIs. Anthropic tile → paste a wrong key → "The key was rejected", nothing added;
      the right key → connected with its model count; Remove takes it away.
- [ ] Palette → "AI: Models and providers" with `firstRun` (or a fresh profile): the empty chat
      shows "Set up the agent" with three choices.
- [ ] Ollama not running: the card offers Get Ollama / Start Ollama / Download a starter model.
- [ ] Copilot CLI installed (`npm i -g @github/copilot`, `copilot /login`): "Use" picks it.

## 6bt. Setup button, provider-safe resets (m6.66, D166)
- [ ] No model: an empty chat shows "Set up AI models"; it opens the AI models page.
- [ ] Settings → Agent: a blue "Models and providers" card above the settings.
- [ ] Reset the Agent settings (or all): the option to remove providers is unchecked; leaving it
      unchecked keeps your providers and keys; checking it removes them.
- [ ] A chat started in another folder, narrow agent panel: the two buttons wrap together at the
      right.

## 6bu. Small things (m6.70, D169)
- [ ] Model menu with OpenRouter (hundreds of models): opens instantly.
- [ ] A provider added by hand as `openrouter-ai`: logo and name on the AI models page; no
      OpenRouter tile.
- [ ] Open a big folder from the welcome page: line under the title bar, the row shimmers.
- [ ] Settings → "Always show header actions": header buttons stay visible.
- [ ] Short window: activity bar icons keep their size and scroll; drag one to reorder; restart
      keeps the order.
- [ ] Git graph with a long subject: the branch badges stay visible.
- [ ] Debug console looks like the browser console; Markdown preview text can be selected.

## 6bv. Display tools: cards and questions (m6.72, D171)
- [ ] Ask: "Should we use SQLite or Postgres? Ask me." — a question card; the status says it's
      waiting. Click one: it stays marked, the agent goes on with it.
- [ ] Ask again, and this time type your own answer in the box instead: it's taken as the answer
      (shown as chosen), not queued.
- [ ] Ask for "the main files with a short note each, as cards": the cards open the files.

## 6bw. Diagrams and math (m6.73, D172)
- [ ] Ask the agent: "Draw a flowchart of how this project starts" and "a bar chart of the five
      biggest folders" — Mermaid diagrams in the chat, readable in the narrow panel (a wide
      flowchart turns vertical); the code button shows the source; copying the answer gives the
      Mermaid text.
- [ ] A Markdown file with ```mermaid blocks (flowchart, sequence, pie, gantt), `$a^2+b^2$` and a
      `$$` block: the preview (Ctrl+Shift+V) draws them; "$5 and $10" stays text; a broken
      diagram says which line.
- [ ] Toggle light / dark: diagrams recolor at once.

## 6bx. Edit with AI on Ctrl+K, per change (m6.73, D172)
- [ ] Off by default: Ctrl+K in the editor waits for a chord as before (Ctrl+K Ctrl+O opens a folder).
- [ ] Turn on `editor.inlineEdit.enabled`. Select a few lines → Ctrl+K → the prompt; type "add a
      comment above each function", Enter → each change shows its old lines struck through and
      Accept / Reject; reject one, accept another; Ctrl+Enter keeps the rest; Esc undoes all.
- [ ] Ctrl+K then Ctrl+S (with the prompt empty): the prompt closes and Keyboard shortcuts opens.
      Ctrl+K then "v": the prompt gets a "v".
- [ ] Source control: the commit box's AI button is there by default and writes a message only
      when pressed; `git.aiCommitMessage.enabled: false` hides it (D173).
- [ ] Terminal (PowerShell): `Expand-Archive` on a big zip — the yellow-on-cyan progress text is
      readable; `terminal.minimumContrastRatio: 1` shows the raw colors (D173).
- [ ] After pulling a release that adds a package, `npm run dev` installs it first instead of
      failing with "Could not resolve" (D173).

## 6cm. Notebooks (m6.89, D188)
- [ ] File → New Jupyter notebook: a notebook with one cell; the kernel button says Select kernel.
- [ ] Type `x = 21` then Shift+Enter: it runs (the first run picks a Python; trust asked once) and
      a new cell opens. `x * 2` + Ctrl+Enter shows 42 with [2].
- [ ] Kernel button: your venv's Jupyter kernel if ipykernel is installed, else "Python 3.x".
- [ ] `import matplotlib.pyplot as plt; plt.plot([1,3,2])`: a picture. A pandas DataFrame: a table.
- [ ] `input('name? ')`: a box under the cell; Enter answers it.
- [ ] `import time; [time.sleep(1) for _ in range(30)]`, then the stop button (or I I):
      KeyboardInterrupt. Restart (0 0): the variables panel empties.
- [ ] Esc then A / B / D D / M / Y / Z: cells added, deleted, retyped, undone. Alt+Up moves.
- [ ] Ctrl+S saves; open the .ipynb in Jupyter or VS Code: same cells and outputs.
- [ ] Ask the agent to "add a cell that plots y = x² and run it": it edits and runs the notebook.

## 6cl. Canvas, round four (m6.88, D187)
- [ ] A README card reads like the Markdown preview (headings, code colors, tables); switch the
      theme: it follows. Zoom out to 25%: text still shows.
- [ ] A long note card shows a scrollbar without clicking it; the wheel scrolls it, then pans.
- [ ] Add a link to a YouTube video: the player shows; select the card and play it. A site that
      refuses (github.com): menu → Show as a link.
- [ ] Select a note's card; drag a heading onto the board: a card narrowed to that heading. Drag a
      link: a link card. Select text and drag it: a text card.
- [ ] The toolbar's last button is a gear.

## 6ck. Explorer follows the canvas; round drag preview (m6.87, D186)
- [ ] Open app.ts, then a canvas: the explorer selects the .canvas file. Click another file in the
      explorer, then app.ts's tab: app.ts is selected again.
- [ ] Drag a group by its strip: the small preview has round corners, the editor inside too.

## 6cj. Extensions from GitHub, authors, New tab (m6.86, D185)
- [ ] Canvas's page: "Claude and Tezumie" with two pictures (Tezumie's from GitHub when online);
      the side panel lists both; clicking Tezumie opens the GitHub profile. Switch tabs: the header
      doesn't change width.
- [ ] Extensions ⋯ → Install from GitHub… → type an owner/name with an extension: it installs; its
      page says "From owner/name"; ⋯ → Update from repository says up to date.
- [ ] Browse official extensions…: says there's none yet.
- [ ] Ask the agent to create an extension: its extension.json lists the agent (and you, when
      signed in to GitHub).
- [ ] A group's ⋯ → New tab: AI models, Documentation, Debug console, Welcome (logo); search box.
- [ ] Open a canvas beside a browser page; drag the browser group by its strip over the canvas:
      the drop preview (rounded, outlined) and the lifted group show above the canvas.
- [ ] AI models page → Agent settings opens Settings on the Agent page. Hovering the setup card's
      brand row shows no tooltip. Manage menu: Profiles, Tasks, Layout density have icons.

## 6ci. Canvas like Obsidian's (m6.85, D184)
- [ ] Settings open; turn Canvas off and on: its settings disappear and come back at once.
- [ ] File cards: a .ts file shows colored code and its file icon; a .md file renders, and its
      menu's Narrow to heading shows one section; an image shows; a .canvas shows a summary.
- [ ] Alt-drag duplicates; Shift-drag keeps one axis; dragging near another card shows dashed
      guides and lines up (Space held: free). Resize from each edge; Shift keeps the shape.
- [ ] Select an arrow: drag an end onto another card (reconnects), off a card (removed). Arrow
      menu: Direction → Both ways; Follow to the other end.
- [ ] Select three cards → Align ▾ → Spread out horizontally; Align left; Same width.
- [ ] Group menu → Background → Set image…, Repeat. Board menu → Go to group.
- [ ] Text card → Convert to file…: a note appears beside the canvas; the card shows it.
- [ ] Explorer: right-click a folder → Add to canvas. Paste a screenshot: saved in attachments/.
- [ ] Toolbar: Export → PNG 2×, privacy on → a PNG beside the canvas, with bars for text.
- [ ] Lock: nothing can change; ? shows the shortcuts; Shift+2 zooms to the selection.

## 6ch. Bundled extensions update and restore (m6.83, D183)
- [ ] With an older Canvas installed, start this build: its page says 1.2.0 and the toolbar has
      Add image, find and the gear.
- [ ] Uninstall Canvas, then right-click the Extensions list → Restore bundled extensions: it's back, off.

## 6cg. Canvas, round two (m6.82, D183)
- [ ] Add a file… / Add an image…: a quick-open search; images show on their card (an SVG too).
- [ ] Right-click the board, a card, a file card, a group's name, an arrow: the canvas's own menu
      (never Inspect). Try colors, Bring to front, Fit to text, Reverse direction, Ungroup.
- [ ] Ctrl+F: matches outlined; Enter steps through them.
- [ ] Gear → settings: Arrow style elbow / straight redraws; Card width changes new cards.
- [ ] Canvases view +: asks a name; several canvases listed. Explorer folder → New canvas… makes
      one there.
- [ ] Open a canvas from the explorer (single click, italic tab), move a card: the tab turns
      normal and stays when you open another file.

## 6cf. Finding tools (m6.81, D182)
- [ ] View → Tools: the IDE's tools (Explorer… Keyboard shortcuts), then each extension's, with a
      line between extensions; typing filters the list.
- [ ] Turn on Canvas: a Canvases icon in the activity bar lists canvases (main first); + makes
      one; creating one elsewhere (agent, explorer) adds it.
- [ ] Extensions → Canvas: an **Open ▾** button with Canvases and Main canvas. TODO tree (one
      view) shows **Open TODO tree**. The row's ⋯ menu lists the same at the top.
- [ ] A group's ⋯ → New tab: Canvases and Main canvas after the IDE's own entries.

## 6ce. Canvas (m6.80, D181)
- [ ] Extensions view: Canvas is listed, turned off. Turn it on and allow its permissions.
- [ ] Palette → Canvas: Open: an empty board beside the editor with its hint and a toolbar.
      Double-click: a card, ready to type Markdown (a heading, a `- [ ]` task); Esc finishes.
      Tick the task on the card.
- [ ] Drag a card's right dot onto empty space: a new card, connected. Drag a dot onto another
      card: an arrow. Double-click the arrow: give it a label.
- [ ] Select two cards (drag a box), press Group: name it. Drag the group by its name: the cards
      move along. Color the selection from the top bar.
- [ ] Add a file… → README.md: its first lines; double-click opens it. Add a link… → a site;
      double-click opens it in the browser.
- [ ] Wheel pans, Ctrl+wheel zooms at the pointer, Space+drag pans, Shift+1 fits. Arrange lays
      the cards along the arrows.
- [ ] Ctrl+Z / Ctrl+Shift+Z; Ctrl+D; Ctrl+C then Ctrl+V; Delete. Close and reopen: everything
      is there (`.vscode`/`.jonna` `canvas/main.canvas`). Open the file in Obsidian if you have
      it: the same board.
- [ ] Ask the agent "draw the main parts of this project on the canvas and connect them": the
      canvas opens beside the editor and the new cards light up. Ctrl+Z takes its change back.
      Select a card and ask "expand the selected card": it reads the selection.
- [ ] Narrow the tab to ~400 px: the toolbar still fits. A light theme looks right.

## 6cd. Modes, voice and small fixes (m6.79, D180)
- [ ] Agent panel: the mode pill (Agent / Plan / Ask); Shift+Tab in the box cycles it, and the
      placeholder follows. Ask "what does this project do" in Ask: no edits are offered, and the
      message shows an "Ask" chip.
- [ ] Plan: it writes a plan without editing; a "Plan ready" line with **Build** follows; Build
      switches to Agent and does it.
- [ ] Empty box: a microphone in the send button's place. Type a letter: the arrow comes back.
      Attach a file only: the microphone stays, and Enter sends.
- [ ] With a Groq or OpenAI key: click the microphone and talk. The waveform moves with your voice
      and the timer counts. Enter → the words appear in the box. Say "…, submit": it sends. Esc
      cancels. Without a key: a notice says what to add.
- [ ] No model connected: "Set up AI models" shows a row of brand marks instead of a sentence.
- [ ] Model pill → a provider's cloud models: the submenu opens on the model in use, scrolled to it.
- [ ] Click any menu button (model, mode, +, a view's ⋯) twice: the second click closes it.
- [ ] Menu bar: open File, move to Edit and View: the menus switch with no fade or blink.
- [ ] Chats view: hovering a chat shows its project's folder.
- [ ] Run and debug: one gear (beside the configuration list); the title bar has no second one.
- [ ] Extensions: open an extension's details and scroll. The side panel stays in view (wide tab).
- [ ] Windows: open terminals and a language server, then end the IDE from Task Manager (or let
      `tauri dev` rebuild it). No shells, servers or "Console Window Host" entries are left over.
      Reload the window (Ctrl+R in dev): its terminals' shells end too.

## 6cc. Settings pages and agent control (m6.78, D179)
- [ ] Ctrl+,: search at the top left; groups separated by lines; Agent shows its sections under
      it (click one: the page jumps there); Keyboard shortcuts / Models and providers / Extensions
      have a small ↗ and open their own page. Narrow the tab: icon rail, search moves up.
- [ ] Change a setting: a small dot after its title (no blue bar); hover the section label:
      reset just that section. Row dividers stop short of the card's edges.
- [ ] Agent → Conversation: Text size large (the chat grows), Send with Ctrl+Enter (Enter makes a
      new line), Messages while it works: Interrupt (sending stops and restarts), Wrap code blocks.
- [ ] Full access on, ask "make the editor font bigger": it asks "Let the agent change the IDE";
      Always allow this chat → the next change doesn't ask; a new chat asks again.
- [ ] Ask it to open a few files; Ctrl+Shift+Alt+W closes them all. With "Close what it opened on
      Stop" on, Stop does the same.
- [ ] Deletion protection on, full access: "delete the build folder" asks.
- [ ] View → Toggle status bar hides and shows it (Settings → Appearance → Status bar too).

## 6cb. Deleting folders in use (m6.77, D178)
- [ ] In a project on another drive than the app's data (e.g. D:), open a terminal inside a folder
      (`cd` into it), then delete that folder in the explorer: it stays whole, and the message says
      it's in use and names the terminal. Close the terminal and delete again: it goes at once,
      and Undo brings it back.

## 6ca. Extensions that change the IDE (m6.76, D176, D177)
- [ ] Extensions view → Create extension…: a status bar item appears ("$(box)" + its name); its
      view's title has a ⚡ button that says hello and updates the status bar.
- [ ] Click an extension: README beside the side panel (version, source, location, links,
      marketplace note); Files tab previews files (Markdown rendered); Settings tab changes
      take effect; Changelog shows when the folder has CHANGELOG.md. Narrow the window: the
      page stacks and nothing scrolls sideways.
- [ ] A development extension: Install permanently — it moves to Installed and keeps working;
      in the explorer, right-click an extension folder in the workspace folder → Run as
      development extension / Install extension permanently.
- [ ] Ask the agent "add a status bar clock to the IDE": it reads extensions.guide, creates an
      extension and asks before loading it ("Change the IDE"), even in full access; "Always allow
      this chat" stops further asks in that chat only.
- [ ] Ask the agent to compare with the bundled TODO tree: it lists and reads its files (outside
      the folder) without an error, and can't change them.
- [ ] Open a project that has a `.vscode` folder and no `.jonna`: change a workspace setting;
      it lands in `.vscode/settings.json` with its comments kept; agent memory and screenshots go
      under `.vscode`. A project with neither: `.jonna` is created on the first save.

## 6bz. Commit messages, models per feature, repo map (m6.75, D174)
- [ ] Stage a few changes in different files; the AI button in the commit box: a summary line
      and "- " lines, no review of the diff; press it again and stop it at once: the box keeps
      what it had.
- [ ] AI models page → Models for each feature: pick a small model for Commit messages; the next
      message uses it (its name shows in the picker).
- [ ] The commit box's scrollbar (type a long message): the arrow cursor over it.
- [ ] Palette → "Show the agent's repository map": the project's main files and symbols; a new
      chat's first answer to "where is X handled?" goes straight to the right file.

## 6by. Search history and tree (m6.73, D172)
- [ ] Search "foo", Enter, then "bar", Enter; in the box press Up: "foo"; Down: "bar", Down again:
      what you'd typed. The include / exclude / replace boxes keep their own history.
- [ ] The tree button in Search's header: results grouped by folder (single-child folders as
      one row, counts on each); right-click a folder: find in it / exclude it. Reload the
      window: still a tree.

## 6cn. Model roles and subagents (m6.96, D195)
- [ ] Agent panel "…" → Configure agents…: the Agents page shows Main agent, Modes, Subagents
      (explore, plan, reviewer, general), External agents, AI features, joined by a tree line.
      Also reachable from Settings → Agent (second row) and the AI models page.
- [ ] Set the Plan model to another model; Plan mode: the answer's model label is that one, the
      chat's model pill is unchanged. Set a Build model; press Build: it runs on that.
- [ ] Ask the agent "use the reviewer subagent to review README.md": a Delegated row with its
      progress, then the agent quotes the report. Give the reviewer its own model on the page.
- [ ] "Review README.md in the background with the reviewer, and meanwhile tell me a joke": a
      notice "working in the background…", the joke, then the report arrives and is answered.
- [ ] New subagent… → name it → the file opens; save a description: it appears on the page.
      A `.claude/agents/x.md` file shows with the "Claude Code" badge.
- [ ] Turn on Review changes automatically; ask for an edit: the reviewer runs after the turn.
- [ ] A submenu that opens left (window at the right edge): its submenus open left too.

## 6co. Presets, browser debugging, search editors, the Timeline, Vim (m6.97, D196)
- [ ] Pick Copilot (or another external agent) in the chat's model menu, then open Configure
      agents…: Main agent shows it (with its model); a new chat starts with it.
- [ ] Agents page → Preset → Save as preset… "A"; change the main and plan models, save "B";
      the chat's model menu → Agent presets → A: everything (and the chat) switches back.
- [ ] A Vite or other dev server running; `.vscode/launch.json` with `"type": "chrome"` and its
      `url`; a breakpoint in a `.ts` file the page uses; F5: Chrome opens and stops there;
      hover values, the console's output in the debug console; closing Chrome ends the session.
      The same with `"type": "msedge"`.
- [ ] Search view → "Open in a search editor": results with context lines (− / +), click a line;
      save as `.code-search`, close, reopen it: it searches again.
- [ ] Explorer → Timeline: save a file twice, let the agent edit it, commit: all show, by day;
      click compares, right-click Restore.
- [ ] Settings → Vim mode on: `dd`, `u`, `:w` in a file; turn it off: plain typing again.
- [ ] Attach an image to the chat; click it: the viewer sits beside the chat and you can type;
      the download button on the card saves it into the folder.
- [ ] Header buttons in the sidebar and editor groups show without hovering (setting on by
      default).

## 7. Palette, dispatcher, audit, agent-readiness
- [ ] Palette: sentence-case titles with categories and keybinding chips, fuzzy highlight, recent first.
- [ ] `<appData>/logs/audit.jsonl` has a line for every action above (drag and drop = `layout.moveTab`).
- [ ] "Developer: Dump state tree": `ide://layout` lists groups (tabs with id/viewType/title/dirty,
      active tab, focused, size in px), `focusedGroupId`, `maximizedGroupId`, regions, sidebar.
- [ ] "Show startup timings" (Help, also in the Appearance menu): process start → shell visible →
      extensions active → folder restored → editor ready, in ms.

## 8. Offline
- [ ] Devtools (dev builds) → Network: only the app's own assets and `ipc://` calls.

## 9. Windows 10/11
Build: `npm install`, then `npm run dev` (or `npm run build` for the installer in
`src-tauri\target\release\bundle\nsis\`). Run once at 100% and once at 125% or 150% display scaling.
- [ ] **Installer:** the NSIS setup installs per-user without admin rights, adds a Start-menu entry,
      uninstalls cleanly from Settings → Apps. The installer, Start menu, taskbar and Alt+Tab show the
      cube logo, sharp at 100% and 150% (the `.ico` has 16/24/32/48/64/256).
- [ ] **Terminal (M1.6 fixes):** in PowerShell, resize the bottom group 20 times quickly, then maximize
      and restore the window → no growth, no horizontal/vertical scrollbar creeping, **no ding**.
      `$Host.UI.RawUI.WindowSize` matches the visible area. Press Backspace on an empty prompt: silent
      unless `terminal.bell` is `sound`.
- [ ] **Shell integration (PowerShell):** in a `pwsh` terminal run `Get-ChildItem`, `cd ..`, a
      failing command (`Get-Item nope`): dots appear (green/red, gray while running), the tab title follows the folder, no
      ding on errors or Backspace. Same in Windows PowerShell 5.1 if installed. `cmd.exe` starts
      without integration (no dots) and works normally.
- [ ] **Command-script tests:** `npm run test:ui` (after the debug build with
      `npx tauri build --debug --no-bundle -c src-tauri/tauri.test.conf.json`) prints `ok` lines for
      every script (core-flows, git, layout-overflow, lsp) and exits 0.
- [ ] **Git (M3):** with Git for Windows installed, the source control flows in 6c work, including a
      repository with `core.autocrlf=true`: staging one change of a CRLF file stages exactly that
      change (`git diff --cached` shows no line-ending noise). Push/pull to a GitHub HTTPS remote: the
      Git Credential Manager window appears when needed, no console window flashes. Without git on
      PATH, the view says "git is not installed or not on PATH".
- [ ] **Language servers (M3):** `npm i -g pyright` (an npm `.cmd` shim) → opening a `.py` file starts
      it (the shim runs through `cmd /C`, no console window); rust-analyzer from rustup works the same.
      `npm run test:ui` runs `lsp.jsonc` with Node as the mock server.
- [ ] **MCP + Claude Code:** follow docs/mcp.md: start the server, copy the command, run it in
      PowerShell, then in Claude Code ask it to "open README.md in the IDE and list the problems":
      tools run, a write (e.g. a setting) shows the IDE's permission dialog. `%APPDATA%\<identifier>\mcp.json`
      exists while the server runs and disappears when it stops.
- [ ] **Paths in search and quick open:** results show `src/…` with forward slashes; opening them
      works; a folder with spaces and non-ASCII characters works in both.
- [ ] **Small window:** drag the window to ~640×480 with 80 tabs open ("Developer: Check layout
      overflow" in a dev build): nothing is cut off at the right, the close button stays reachable.
- [ ] **Shell:** the terminal starts PowerShell 7 (`pwsh`) if installed, else Windows PowerShell, else
      `cmd.exe` (`$PSVersionTable` / `ver`). The prompt is in the workspace folder; `Get-ChildItem` colors,
      resizing the group reflows (`$Host.UI.RawUI.WindowSize`), `Ctrl+C` interrupts, `exit` shows
      "[Process exited…]".
- [ ] **Paths:** open a folder on another drive (`D:\…`), a folder with spaces and non-ASCII characters,
      and a network share (`\\server\share\…`). Explorer, editor tabs (tooltips show `\`), save, and
      `ide://editors` all work. Open `C:\Work\a.ts` via the explorer, then run
      "Open file" with `c:/work/A.TS` → the same tab is focused (no duplicate).
- [ ] **Long paths:** create a folder chain deeper than 260 characters in the workspace
      (`New-Item -ItemType Directory ("a"*50 + "\" + "b"*50 + …)`) → list, open, edit and save a file there.
- [ ] **Line endings:** open a CRLF file (most files from Windows tools), edit, save →
      `Format-Hex` shows `0D 0A` still; status bar says `CRLF`. A new file is `LF`.
- [ ] **Watcher:** create, delete and rename files from Explorer (the Windows file manager) inside
      expanded folders → the tree updates; renaming a folder updates its children.
- [ ] **Title bar:** drag moves the window, double-click maximizes, `Win+←/→` snaps, `Win+Z` shows snap
      layouts (hovering the maximize button does not — see D41). Close hover is red.
- [ ] **WebView2 keys:** `Ctrl+P` does not open a print dialog, `Ctrl+F` outside the editor does not open
      the browser find bar, `Ctrl+R` / `F5` do not reload, `Ctrl+Shift+I` does not open devtools in a
      release build, `Ctrl+J` / `Ctrl+H` / `Ctrl+U` do nothing browser-like. Right-click outside text
      fields shows no browser menu.
- [ ] **Scaling:** at 125%/150%: text is crisp in UI, editor and terminal (no blur after resizing or
      moving between monitors with different scaling); 1px dividers stay 1px-ish; icons are sharp.
- [ ] **Theme:** with Windows in light or dark mode the IDE keeps its own theme; scrollbars and form
      controls match the IDE theme (`color-scheme`).
- [ ] **Startup:** run "Show startup timings" after a cold start (first launch after boot) and after a
      warm start; please report both numbers (D40).
- [ ] **Line endings and encodings (D199):** click `CRLF` in the status bar → LF; save →
      `Format-Hex` shows `0A` only. Click `UTF-8` → Save with encoding → UTF-16 LE → the file starts
      `FF FE`. Reopen it → the status bar says UTF-16 LE.
- [ ] **Emmet (D199):** in an `.html` file type `ul>li*3` and Tab → three list items; in a `.css`
      file `m10` → `margin: 10px;`; in `.tsx` `div.card` → `<div className="card"></div>`.
- [ ] Review mode: ask the agent to edit a file; the change is in the file at once and tinted in
      the editor; Ctrl+Alt+N undoes it, Ctrl+Alt+Y keeps it; Alt+F5 jumps to the next change.
- [ ] Reject all after typing elsewhere in the same file: your typing stays, the agent's edit goes;
      after typing on the same lines: it refuses with "same lines".
- [ ] The editor title bar's check / x buttons keep or undo the whole file.
- [ ] Create `.env` and `.aiignore` (with `secret/`): the agent can't read them, find doesn't list
      them, @-mention refuses; `run_command cat .env` still works (documented).
- [ ] An OpenRouter or Anthropic chat shows a cost under each answer and beside the meter; set
      `agent.budget.perChat` low and check the 80 % notice and the question past 100 %.

## m7.1 (D200)

- [ ] **Explorer root (D200):** select a folder, click below the files (or the folder name at the
      top) → nothing selected; New file goes to the root. Right-click below the files → the root's
      menu; New folder lands at the root.
- [ ] **Explorer find (D200):** type a few letters in the tree → jumps to the match; Ctrl+Alt+F →
      the bar; matches underlined; the filter button hides the rest; Escape closes it.
- [ ] **Drag out (D200, Windows first):** drag a file from the Explorer onto the desktop or into
      File Explorer → it's copied there; into an email or chat → attached. Dragging inside the
      window (onto a tab or a folder) still works as before.
- [ ] **Section edge (D200):** Outline collapsed, Timeline open → drag the line above Outline up:
      Timeline grows, Outline stays collapsed.
- [ ] **Code actions on save (D200):** in a TS project with typescript-language-server, set
      `"editor.codeActionsOnSave": { "source.organizeImports": "explicit" }`, scramble the
      imports, Ctrl+S → sorted on disk.
- [ ] **Python venv (D200):** a project with `.venv` and a package installed there → no
      "unresolved import" for it; the status bar says Python (.venv).
- [ ] **Git (D200):** select one of two changed lines → Stage selected lines → only it is staged.
      `git.quickDiffBase: mergeBase` on a feature branch → change bars for the branch's commits.
- [ ] Restore: in a chat, ask for a change that edits a file, then a second message that edits
      another. Hover the first message → Restore checkpoint → confirm. Both files are back, both
      messages are gone, the first message's text is in the box, the review list is empty.
- [ ] Edit with undo: edit a message whose turn changed a file → Send → the dialog offers "Undo and
      send"; pick it: the file goes back before the new turn starts. "Keep changes" leaves it;
      Cancel keeps the editor open. Retry on the last answer asks the same.
- [ ] Rules: add `sub/AGENTS.md` and `.cursor/rules/ts.mdc` (`globs: *.ts`); ⋯ → Rules… lists them
      with "When the agent reads or edits…". Ask the agent to read a file in `sub/`: open the tool
      row's output: it ends with the rules block, only the first time.
- [ ] User rules: put a line in `<config>/AGENTS.md` (Preferences folder, next to settings.json);
      a new chat follows it (also with no folder open).
- [ ] CLAUDE.md with `@docs/conventions.md`: Rules… shows the import; the agent knows its content.
- [ ] Mentions: + → Git → A commit… pick one; send "what does this change do": the answer is about
      that commit. Same for @branch, Past chat…, Symbol… (type a function's name), Rules.
- [ ] Slash commands: a `.claude/commands/fix.md` with `argument-hint: [issue]` shows in the /
      picker as "/fix [issue]"; `$1` is filled; a line `!`git status`` asks in the chat (Allow →
      the output is in the message's context; Deny → "(not run…)"); with
      `allowed-tools: Bash(git status:*)` it doesn't ask. Also from `~/.claude/commands`.
- [ ] /clear opens a new chat in place of this one (the old one is in Chats); /model alone opens the
      picker; /review opens an Ask chat reviewing the uncommitted changes; /init proposes AGENTS.md
      for review (reject removes it).
- [ ] On Windows: a rules file with CRLF line ends and front matter is read; `~/.claude/commands`
      under `C:\Users\<name>` is found.
- [ ] **Web search off:** fresh settings, ask the agent "search the web for tauri channels": it
      answers that web search isn't set up and names **Agent: Set up web search**; no approval card.
- [ ] **Brave / Tavily / Exa:** run **Agent: Set up web search**, pick one, paste a real key into the
      hidden box. Ask the agent to search: an approval card, then results with titles and links.
      Check `secrets.json` in the app data folder holds `websearch.<provider>`, and the settings
      file doesn't. A wrong key: the tool says the provider refused it and to check the key.
- [ ] **SearXNG:** run one (`docker run -p 8080:8080 searxng/searxng`, json format enabled), set it
      up with `http://localhost:8080`. With the json format off: the error says to enable it.
- [ ] **@web search:** type `@`, then `web tauri channels` (spaces), pick "Search the web for…":
      a "Search: …" card; send; the answer uses the results.
- [ ] **Elicitation:** an MCP server that elicits (e.g. the test fixture
      `tests/fixtures/sample/tools/mock-mcp.mjs`, tool `ask`): the box shows "MCP server echo asks:
      What is your name?"; Answer…, type a name, pick a color. Repeat with Decline and with Escape:
      the tool result says declined / cancelled. On Windows, check the box isn't hidden behind the
      chat and Escape works.
- [ ] **list_changed:** a server that adds tools at runtime (the fixture's `grow`): **MCP servers…**
      shows the new counts; the next message can use the new tool.
- [ ] **Prompts:** type `/` in the message box: the server's prompts are listed with their
      arguments; run one with and without its required argument (asked in a box).
- [ ] **Resources:** type `@` and part of a resource name: pick it; the card shows its name; send.
- [ ] **Remote server elicitation:** a remote (http) server that elicits during a tool call: the
      question appears while the call is in flight (not after its timeout).
- [ ] **ACP resume:** chat with Claude Code (check that its adapter advertises `loadSession`; if it
      doesn't, this exercises the recap path instead), restart the IDE,
      open the chat, ask "what did I ask before?": it remembers. With an agent that can't load
      sessions, the same question works through the recap. Type `/` in a Claude Code chat: its
      own commands are listed.
- [ ] Search view, regex on: `function add\(.*\n.*return` in a TS project → a result on the
      function's line; open it; replace with something across lines and check the file. Try a CRLF
      file (Windows) with `\n`.
- [ ] Ctrl+P, type `%return` → matching lines; Enter opens the line. `view ` → groups (Side bar,
      Panel, Extensions); pick Explorer. `task ` → tasks; pick one, it runs. `debug ` with a
      launch.json → configurations. `term ` with two terminals → both, plus Create new terminal.
      `edt ` with two editor groups → "Group 1", "Group 2" lines. `@:` in a TS file → groups with
      counts on the right. `?` lists all prefixes.
- [ ] Ctrl+P, a file name, Ctrl+Enter → opens to the side; → at the end of the text → opens in the
      background with the box still open (Escape closes it). Same in `#`, `@`, `%` and `edt `.
- [ ] Settings: `@modified`, `@id:editor.fontSize`, `@ext:builtin.terminal`, `@ext:terminal`,
      `@tag:ai`, `@lang:markdown`, `@modified font`; the page title says what was found. A small window
      (search above the page) works the same.
- [ ] Help → Keyboard shortcuts reference: sections in columns, narrow the tab (one column); change a
      key in Keyboard shortcuts and see it update; Print… → the print preview shows only the sheet,
      light, on Windows (WebView2) and Linux (WebKitGTK); after printing or cancelling the IDE looks
      normal.
- [ ] Open a folder never opened before → the trust dialog after a moment; tick the parent folder and
      trust; open a sibling folder → no dialog, `ide://workspace/trust` shows `inheritedFrom`. Open
      another new folder and press Escape → no dialog until its first task (then asked once). With
      `security.workspace.trust.startupPrompt: never` → no dialog on open. A folder already trusted
      or restricted → no dialog.
- [ ] Download a theme `.vsix` from the VS Code marketplace (e.g. a color theme), Extensions ⋯ →
      Install from VSIX… → installed, the theme appears in the theme picker; a damaged or non-.vsix
      file → a clear error; the scratch folder under `<appData>/extensions/.downloads` is gone.
- [ ] In a folder with package.json scripts and no tasks.json: Terminal → Configure default build
      task… → pick `npm: build` → `.vscode/tasks.json` (or the IDE's folder) gets a `"type": "npm"`
      entry, opens; Ctrl+Shift+B runs it without asking. Pick another → the old one stays `"group":
      "build"`. With pnpm (pnpm-lock.yaml) → a shell task "pnpm: build".

## m7.2 (D201)

- [ ] **Change bars (D201):** edit a committed file → hover the bar beside the changed line:
      pointer; click → a diff tab opens at that line; click a bar further down → the same tab
      scrolls there.
- [ ] **Commit message (D201):** stage changes in several files → the sparkle → a first line naming
      the themes, then short bullets of concrete changes, not a list of file names.
- [ ] **Welcome page (D201):** recent folders: paths reach the right edge; hover a row → pin and ×
      appear and the path truncates with …; a pinned folder's pin always shows.
- [ ] **Attachment viewer (D201):** open an agent screenshot beside the chat → it fades in; the
      backdrop is lighter; the sash between chat and viewer is easy to drag; hover a thumbnail in
      the chat → its large preview shows above the viewer.
- [ ] **Settings / nesting (D201):** User settings.json: `"editor.tabSize": 2, "[python]": {
      "editor.tabSize": 8, "editor.rulers": [80] }`. Open a `.py` file with no indentation: Tab
      inserts 8 spaces, a ruler at 80, the status bar says "Spaces: 8". Open a `.ts` file: 2, no
      ruler. Split the two side by side and type in each: neither changes the other.
- [ ] **Settings / nesting (D201):** Change `[python].editor.tabSize` to 4 in the file and save: the
      open Python tab follows at once. Pick "Indent using tabs" in the status bar: it stays until
      the settings change again.
- [ ] **Settings / nesting (D201):** Workspace settings `"editor.tabSize": 6`: the `.ts` file gets
      6, the `.py` file keeps 8 (a user block beats a plain workspace value). Then workspace
      `"[python]": { "editor.tabSize": 3 }`: 3.
- [ ] **Settings / nesting (D201):** `"[markdown]": { "files.trimTrailingWhitespace": true }`:
      trailing spaces go on save in `.md` files only.
- [ ] **Settings / nesting (D201):** `"[typescript]": { "editor.formatOnSave": true }` with Prettier
      in the project: saving a `.ts` file formats it, a `.js` file not.
- [ ] **Settings / nesting (D201):** Settings editor, search `@lang:python`: the title says "for
      python files"; change Tab size to 5: settings.json gets `"[python]": { "editor.tabSize": 5 }`
      (comments elsewhere kept); the row's reset removes it, and the block when it was the last key.
- [ ] **Settings / nesting (D201):** Settings → Import from VS Code with a VS Code settings.json
      holding `"[python]": { "editor.tabSize": 4, "python.formatting.provider": "black" }`: after
      import the user file has `"[python]": { "editor.tabSize": 4 }`; the summary counts the other
      key as not applying.
- [ ] **Settings / nesting (D201):** `"files.associations": { "*.mdx": "markdown" }` with an `.mdx`
      file open: it turns Markdown at once (status bar, colors); a Markdown language server
      configured in `lsp.servers` starts for it. `"Dockerfile.*": "dockerfile"` → `Dockerfile.dev`
      is Dockerfile. Change language mode on a file, then edit `files.associations`: that file keeps
      the language you picked.
- [ ] **Settings / nesting (D201):** `explorer.fileNesting.enabled` on, with `a.ts`, `a.js`,
      `a.js.map`, `package.json`, `package-lock.json`: `a.js` and `a.js.map` show under `a.ts`, the
      lock under `package.json`, expanded. Click `a.ts`: it opens (no collapse); click its chevron:
      it folds. Enter on it opens it, → / ← expand and fold. Ctrl+Alt+F "map" finds the nested row.
      Rename `a.js` to `b.js`: it leaves the nest. Delete `a.ts`: `a.js` is listed at the top again.
      Drag `a.js.map` onto a folder: it moves. Turn nesting off: all files side by side, no
      leftovers.
- [ ] **Settings / nesting (D201):** With `.expand` off, nests start collapsed (with it on, they
      start expanded again after a restart, even ones you folded: only expanded rows are saved).
- [ ] **Settings / nesting (D201):** `"editor.quickSuggestions": false`: no suggestions pop up while
      typing in a `.ts` file (before this release, opening a file turned them back on); Markdown and
      plain text still have none.
- [ ] **Tasks (D201):** open a Rust project (or one with a Makefile in a subfolder): Run task… lists
      `cargo: build`… / `make: <target> - <folder>`; run `cargo: check` with an error in the code →
      the error is in Problems at the right file. Configure default build task → pick `cargo: build`
      → Ctrl+Shift+B runs it; `.vscode/tasks.json` has the entry.
- [ ] **Tasks (D201):** Tasks on **Windows**: a project with `node_modules/.bin/tsc.cmd` → `tsc:
      build - tsconfig.json` runs `.\node_modules\.bin\tsc.cmd -p tsconfig.json` in PowerShell; a
      Gradle project with `gradlew.bat` runs `.\gradlew.bat build`.
- [ ] **Continuous run (D201):** a Vitest or node:test project → eye on in the Testing view → save a
      source file → its test runs once (status bar spinner, then counts); save three files quickly →
      one run; save during a run → one more run after it; eye off during a run → the run stops.
- [ ] **Agent (D201):** ask it to start the dev server → the chat shows "1 background command
      running" with the command and its address; ask it what the server printed after loading a page
      → it reads only the new lines; Stop on the row ends the server (the port is free); delete the
      chat while a server runs → the port is free; quit the IDE while one runs → no node.exe left
      (Windows Task Manager).
- [ ] **Agent (D201):** Stop while "Ran npm run dev" is still waiting for the first output → the
      server doesn't keep running.
- [ ] **Usage (D201):** Chats side bar: under "Search chats" there are Agents, Settings and Usage
      buttons; each opens its page (Settings opens Settings → Agent). Narrow the side bar until only
      icons remain; the tooltips still say what they do.
- [ ] **Usage (D201):** Send a message with a hosted model that has a price (or set `agent.prices`),
      then open Usage: Today shows its cost, the day's bar is there, the model and "Chat" are
      listed, the chat is in Top chats, and This chat shows the same cost as the meter's tooltip.
- [ ] **Usage (D201):** Use Edit with AI or Generate commit message: a row for that feature appears
      under Features.
- [ ] **Usage (D201):** With an Anthropic or OpenAI key: after a message, Providers and limits shows
      requests / tokens left with a reset time. With OpenRouter: the key's credits and "Billed by
      OpenRouter: today …" (refresh button). Ollama says "not reported (runs locally)".
- [ ] **Usage (D201):** Type 0.5 in the budget field: `agent.budget.perChat` is 0.5 in Settings and
      a meter appears under This chat; clear the field: no budget.
- [ ] **Usage (D201):** Restart the IDE: the totals and days are still there. "Clear usage history"
      asks, then the page says "Nothing logged yet" while open chats keep their own cost.
- [ ] **Usage (D201):** Set `agent.usage.keepHistory` to false, send a message: nothing new is
      logged.
- [ ] **Usage (D201):** Make the window about 640 px wide: the tiles stack in one column and nothing
      overflows sideways; switch 7 / 30 / 90 days and Cost / Tokens.

## m7.3 (D202)

- [ ] **Chats view (D202):** toggle the Chats side bar → the search box isn't focused; type →
      nothing goes into it.
- [ ] **Room past the end (D202):** scroll the Explorer, Search results, Outline and Timeline to the
      bottom → a row of space under the last item; Settings → scroll to the end → the last setting
      can reach the middle.
- [ ] **Preview double-click (D202):** a Markdown file with a ```mermaid diagram → preview → click
      Zoom in quickly several times → it zooms, the source doesn't open; double-click a paragraph →
      the source opens at it.
- [ ] **Extension notebooks (D202):** Load unpacked `tests/fixtures/extensions/toybook`; a file
      `a.toynb` with `1 2 3` → opens as a notebook; Run → `6`; Variables shows `total`; save → the
      file keeps its format; disable the extension → running says the kernel isn't available.
- [ ] **Jupyter notebooks after D202:** an .ipynb opened before this release runs on the kernel it
      used before (remembered kernels converted); Select kernel lists the Pythons; a git diff of an
      .ipynb shows cells.
- [ ] **Extension API (D202):** Load `tests/fixtures/extensions/procs` (Load unpacked…), allow its permissions, trust the
  folder. Palette → "Procs: echo through a shipped script": returns ready/pong 7/exit code 3.
- [ ] **Extension API (D202):** Put the folder in restricted mode ("Manage workspace trust"): "Procs: lines from node -e"
  fails with "restricted mode"; a running "Procs: start a long-running process" ends.
- [ ] **Extension API (D202):** Untrusted (undecided) folder: the first spawn shows the trust dialog; "Stay restricted"
  makes it fail; nothing is left running.
- [ ] **Extension API (D202):** "Procs: greet" from the palette asks for `name`; an agent sees the `name`/`times` schema.
- [ ] **Extension API (D202):** Windows: a `.cmd` shim command (e.g. `npx`) starts; closing the folder kills the process
  tree (no stray node.exe in Task Manager); `ide.env.platform` is "windows" and
  `ide.extension.path` uses backslashes.
- [ ] **Extension API (D202):** The extension page's Permissions tab lists "It also reads these settings: terminal.fontSize,
  search.*".

## m7.4 (D203)

- [ ] **Staged bars (D203):** in a git repo change two lines of a file, `git add` it, change a third
      → the first two bars are dimmed, the third full; click a dimmed bar → the staged diff opens;
      click the full one → the working-tree diff.
- [ ] **Diff from a preview tab (D203):** single-click a changed file in the Explorer (italic tab) →
      click a change bar → the diff opens in its own tab and the italic tab is still there.
- [ ] **OpenRouter (D203):** Usage → Providers and limits → OpenRouter says "Key limit" with the
      note that it's the key's limit, not the account balance; the page's lead mentions checking the
      provider's dashboard.
- [ ] **Menus and headers (D203):** Agents page → Preset menu with a long preset → no sideways
      scroll bar, the models text ends with …; New subagent… is as tall as the Preset chip; AI
      models → Agent settings and Edit in settings.json match the Default model chip.
- [ ] **Jupyter extension (D203):** a fresh profile → an .ipynb opens as JSON; Extensions → Jupyter
      → turn on, allow → the file opens as a notebook; Select kernel lists the Pythons; run a cell,
      input(), a plot, an ipywidgets slider (with Jupyter installed); save → git diff shows only the
      cells you changed; turn it off → the tab says to turn it on. (changed in D204: it opens as a
      notebook; Select kernel offers to enable the extension)
- [ ] **Jupyter on Windows (D203):** a folder with `.venv` → its `Scripts\python.exe` is offered;
      without one, `py -3` is; interrupt (I I) stops a `while True` cell.
- [ ] **Remembered kernels (D203):** a notebook last run before this release runs on the same Python
      without asking.
- [ ] **Nest parent, folded (D203):** `explorer.fileNesting.enabled` on, `.expand` off; files
      `a.ts`, `a.js`, `a.js.map` → select `a.ts` → Delete → the dialog asks about 3 items and
      lists the three names → Delete → all three gone; Ctrl+Z → all three back.
- [ ] **Nest parent, drag and paste (D203):** drag the folded `a.ts` onto a folder → the three
      move (open `a.js` editor follows); Ctrl+X on it, Ctrl+V in another folder → the three move;
      Ctrl+C / Ctrl+V → three copies.
- [ ] **Nest parent, unfolded (D203):** unfold `a.ts` → Delete on `a.ts` → only `a.ts` goes (the
      nested files move up to the folder's list); right-click a folded parent → Delete → the three.
- [ ] **Nested Cursor rules (D203):** `web/.cursor/rules/style.mdc` with `alwaysApply: true` →
      Rules… lists it "When the agent reads or edits a file in web/"; ask the agent to read a file
      under `web/` → the rule is attached; a file outside `web/` → it isn't. A rule in
      `.github/instructions/frontend/x.instructions.md` with `applyTo: "**/*.tsx"` is listed too.
- [ ] **Ignored rules (D203):** add `web/.cursor/` to `.aiignore` → Rules… no longer lists the
      nested rule.
- [ ] **Subfolder commands (D203):** `.claude/commands/frontend/test.md` → type `/` → `frontend:test`
      is in the list with its description; `/frontend:test hello` runs it with `$ARGUMENTS`.
- [ ] **allowed-tools (D203):** a command with `allowed-tools: Bash(git status:*)` asking the agent
      to edit a file → it can read and run commands but has no edit tool for that answer; the next
      plain message can edit again. Ask / Plan mode still stay read-only with such a command.
- [ ] **Task detection depth (D203):** `packages/app/Makefile` with a `build:` target → Run task…
      lists `make: build - packages/app`; `task.autoDetectDepth` 1 → it's gone; 3 → a Makefile in
      `packages/app/tools/` shows; a Makefile under `node_modules/x/` never does. Windows: the task
      runs in `packages\app`.
- [ ] **(D203) Broken settings.json:** open user settings (JSON), delete a comma so it has a syntax error,
      save. Toggle word wrap (or any setting in the settings editor): a toast says the user
      settings.json has a syntax error on that line; the file is unchanged. Fix it: toggles work again.
- [ ] **(D203) Hot exit, big file:** with `files.hotExit` on, edit a file over 2 MB (and a small one) without
      saving, close the window: the dialog asks about the big file only. Cancel keeps the window open;
      Don't save closes it, and reopening the folder restores the small file's edits.
- [ ] **(D203) No folder:** with no folder open, New text file, type something, close the window: it asks
      Save / Don't save / Cancel.
- [ ] **(D203) Autosave and untitled:** set `files.autoSave` to `afterDelay`, New text file, type: no Save as
      dialog appears; a normal file still saves after the delay.
- [ ] **(D203) Keys under a dialog:** make an untitled editor dirty, close its tab so Save / Don't save /
      Cancel shows. Click the dialog's message text, then press Ctrl+Shift+P: no command palette. Press
      Tab: the first button is focused; Esc closes the dialog (the editor stays).
- [ ] **(D203) Git folder switch:** open a repository with many changes, immediately switch to another
      repository: the Source control view shows only the second one's changes.
- [ ] **(D203) Screen reader, explorer:** with a screen reader (NVDA / Narrator), expand and collapse folders
      and scroll the explorer: each row is read by its own name, never another file's path.
- [ ] **(D203) Hot-exit restore:** leave unsaved edits in two files, close the window, delete one of the files
      on disk, reopen the folder: the other file has its edits; the deleted one's text opens as an
      untitled editor with a "Couldn't reopen" toast. Close the window right after reopening (before
      the restore toast): reopening again still restores the edits.

## m7.5 (D204)

### Workbench

- [ ] **Chats side bar (D204):** the search box is on top, then New chat, Usage, Configure agents
      and Agent settings as plain rows (a background only on hover); More expands to Manage
      providers, MCP servers, Agent memory and Tidy up memory; each opens its page.
- [ ] **Title bar search (D204):** the search box in the title bar has the bar's own color with a
      border (no darker well), in dark and light themes.
- [ ] **Status bar editor info (D204):** open a file → the main status bar shows Ln/Col,
      Spaces: N, UTF-8, LF and the language; click Spaces → indent with tabs / size / convert;
      click the encoding, EOL and language → their pickers. `workbench.statusBar.editorInfo` off →
      they go; a non-text tab shows none of them.
- [ ] **Extension logos (D204):** Extensions view and an extension's page → a logo shows as it is,
      without a tinted tile behind it; extensions without a logo or icon keep their initials on a
      tinted tile.
- [ ] **Welcome unpin (D204):** the welcome page's pinned folders show the unpin button only on
      hover (and keyboard focus).

### Alpha support: reports, logs, extensions off, updates

- [ ] **Report a problem (D204):** Help → Report a problem…: the tab shows Title, What happened,
      the parts (System, Recent errors, Session log, State: ide://…, Screenshot unticked) and the full
      report. Expand State: ide://editors: paths start with `~`, no file text. Untick a part: it
      leaves the report below. Copy report: the clipboard has the same text.
- [ ] **Report: save as zip (D204):** Save as zip…, pick a folder: Explorer/Finder opens the zip
      with report.md and one file per ticked part; tick the screenshot first and screenshot.png is
      in it.
- [ ] **Report: issue link (D204):** with product.json `issuesUrl` set to a test repository's
      issues page, Open issue in browser opens GitHub's new-issue form filled in; with a long log
      (many errors), the note says the full report is on the clipboard and pasting it works.
- [ ] **Session logs (D204):** Help → Open logs folder: the file manager shows `sessions` with
      this run's `session-….log` selected; it starts with "Started <version> on windows x86_64".
      Restart the IDE 11 times: only 10 files are kept.
- [ ] **Extensions off (D204):** Help → Restart with extensions off: the IDE restarts, the status
      bar says "Extensions off", a notification offers Restart normally, the Extensions view shows
      every extension disabled and Jupyter notebooks have no kernel. Click the status bar item: the
      IDE restarts with extensions running. Start from a terminal with `--disable-extensions`: same,
      and Restart normally starts with them on.
- [ ] **What's new (D204):** Help → Release notes opens What's new with m7.5 first. Change
      `<data>/last-version` to `0.0.1` and restart: What's new opens by itself after the folder is
      restored; with `update.showReleaseNotes` off it doesn't.
- [ ] **Update channel (D204):** Settings → Update channel: Beta; Help → About shows "Update
      channel: beta"; Help → Check for updates… on a build without a beta endpoint says it checked
      stable.

### Editor, encodings, language servers, shortcuts

- [ ] **Shift JIS file (D204):** create a Shift JIS file (e.g. `printf '\x93\xfa\x96\x7b\x8c\xea\n' > ja.txt`),
      turn on `files.autoGuessEncoding`, open it: it reads 日本語, the status bar says Japanese (Shift
      JIS) and it's editable. Type, save, `xxd ja.txt`: Shift JIS bytes. Type 😀 and save: refused,
      naming it.
- [ ] **Reopen with encoding (D204):** open a Windows-1252 or Big5 file without guessing: the
      picker's first entry is the guessed encoding ("guessed from content").
- [ ] **Monaco keys in shortcuts (D204):** Ctrl+K Ctrl+S, search `"ctrl+d"`: "Add selection to next
      find match" (Editor). Change it to Ctrl+Alt+D: in a file, Ctrl+Alt+D adds the next match, Ctrl+D
      no longer does. Right-click → Change when expression → `editorReadonly`: Ctrl+Alt+D does nothing in
      a normal file. Reset: Ctrl+D is back. keybindings.json kept its comments throughout.
- [ ] **Monaco chords (D204):** Ctrl+K Ctrl+X trims trailing spaces, Ctrl+K Ctrl+C comments the line, Ctrl+K Ctrl+U uncomments, Ctrl+K
      Ctrl+0 folds all (no "not a command" message).
- [ ] **Semantic colors (D204):** with rust-analyzer or Pyright running, parameters, read-only
      variables and types get their theme colors; turning `editor.semanticHighlighting.enabled` off goes
      back to syntax colors only.
- [ ] **Workspace diagnostics (D204):** Pyright with `python.analysis.diagnosticMode` = workspace
      (Language server settings): Problems lists errors of files that aren't open; fix one from an
      open file and its entry updates.
- [ ] **Server settings (D204):** Language server settings → Pyright → typeCheckingMode strict: the
      running server reports the stricter problems without restarting (its log shows no new start).

### Notebooks and ghost-text suggestions

- [ ] **Notebook language server (D204):** a Python notebook, Pyright installed → `print(x)` in a
      cell with `x` defined in an earlier one: no error; `print(nope)`: squiggle in that cell and
      "[Cell N, Ln 1, …]" in Problems; click it → the notebook scrolls to that cell's line; hover
      `x` → its type; F12 on `x` → the earlier cell; F2 renames it in every cell.
- [ ] **Notebook magics (D204):** `%matplotlib inline`, `!pip list` and a `%%bash` cell show no
      errors; the cell's last line `df` isn't "expression value is unused".
- [ ] **Find across cells (D204):** Ctrl+F in command mode and in a cell → the bar; a word in
      Markdown and code cells → "1 of N", Enter cycles, Markdown cells open on their match; outputs
      toggle finds text in outputs; Ctrl+H → Replace all → Ctrl+Z (command mode) brings every cell
      back; Esc closes it and clears the highlights.
- [ ] **Notebook outline (D204):** Outline view on a notebook with `#` / `##` headings → nested
      headings with the code cells under them; selecting cells moves the highlight; clicking a code
      cell puts the cursor in it.
- [ ] **R / Julia kernels (D204, needs R + IRkernel or Julia + IJulia):** the kernel picker lists
      them; cells are colored as R / Julia; a cell runs; completions after `pa` in R; save → the
      file's kernelspec says the R kernel; reopen → the same kernel starts.
- [ ] **FIM suggestions (D204):** Ollama with `qwen2.5-coder:1.5b-base`, suggestions on, model
      setting empty → `ide://editor/inlineCompletions` picks it ("suggested", fim "ollama"); typing in
      the middle of a function body → one-line ghost text that fits what follows; at a line's end
      after `{` → several lines; Ctrl+Right takes a word; Tab the rest.
- [ ] **Chat fallback (D204):** `llama3` as the model (no insert template) → suggestions still
      come (chat prompt), the state's last mode is "chat".
- [ ] **Codestral / DeepSeek FIM (D204, needs a key):** a Mistral provider at
      `https://codestral.mistral.ai/v1` with `codestral-latest` → suggestions; same for DeepSeek
      (`https://api.deepseek.com`, `deepseek-chat`).

### Notebooks

- [ ] **Notebooks out of the box (D204):** with the Jupyter extension off (a fresh profile), open
      an .ipynb from someone else: it opens as a notebook with its outputs; edit a Markdown cell
      (double-click), add a code cell with **+ Code** between cells, save: the file is still
      valid nbformat (open it in Jupyter or check `git diff`: only your change).
- [ ] **Select kernel without Jupyter (D204):** in that notebook click Select kernel: "Type to
      choose a kernel source" with **Enable the Jupyter extension** and **Browse extensions for
      kernels…**. Enable → allow its permissions → the Pythons are listed; pick one, run a cell.
      Run a cell first instead (Shift+Enter): the same picker opens.
- [ ] **ipykernel offer (D204):** pick a Python without ipykernel (a fresh `python -m venv .venv`):
      cells run, a notification offers "Install ipykernel"; Install → a terminal runs pip; when it
      finishes, "Restart kernel" → `%timeit 1+1` works. On Windows, with a Python in a folder whose
      path has spaces.
- [ ] **Cell toolbar and menu (D204):** hover a code cell: run above / run and below / split / … /
      delete at its top right; a Markdown cell shows edit (✓ while editing). **…** → Join with
      next cell, Copy cell down, Change cell to → Markdown, Show cell line numbers, Collapse cell
      output: each works; Z (or Ctrl+Z in command mode) undoes the join, the copy and the type
      change. Keys: Ctrl+Alt+J, Shift+Alt+Down, L, Shift+L.
- [ ] **Cell language (D204):** click "Python" under a code cell → pick SQL: the cell is colored
      as SQL and saved with `metadata.vscode.languageId`; pick Markdown: it becomes a Markdown
      cell. Reopen the notebook in VS Code: the same.
- [ ] **Show source (D204):** the notebook's `{ }` title button shows the JSON in the same tab;
      "Show as notebook" goes back; with unsaved cell edits it asks to save first.
- [ ] **Notebook extension API (D204):** load `tests/fixtures/extensions/toybook`, allow it, open a
      `.toynb`: a "#" button in the toolbar, "N chars" under code cells, "Shout this cell" in a
      code cell's … menu; a cell `stars 3` draws ★★★ and "the extension saw 3 stars" under it;
      Select kernel → "Connect to a toy server…" → the kernel is "Toy server".

### Git

- [ ] **Merge editor (D204):** make a conflict (two branches change the same line, merge) →
      Source control's conflicted row → Resolve in merge editor: Incoming / Current / Result, "1 of 1
      conflict left"; Accept incoming in the result → "The conflict is handled"; type in the result,
      Accept both on another conflict → only that conflict changes; Show base; Complete merge → the
      file is saved without markers and staged; the merge commits.
- [ ] **Merge editor, small window (D204):** narrow the tab under 560 px → the input panes stack;
      the zones' links stay clickable; scrolling one pane scrolls the others.
- [ ] **Merge editor from the lens (D204):** open a conflicted file → "Resolve in merge editor"
      above a conflict opens the same tab; closing it with unsaved changes asks.
- [ ] **Nested repository (D204):** a folder with a repository inside (`git init inner`, a
      commit) → Source control lists both; click inner → its changes, branch and commit box; open a
      file of inner → inner is selected, the status bar shows its branch; commit in each.
- [ ] **Submodule (D204):** a repository with a submodule → the submodule is listed (kind
      submodule, box icon) with its own changes.
- [ ] **File blame (D204):** Toggle file blame → each line has "Author   age", newest brightest;
      hover the annotation → commit details; type a line → after a pause it's "Not committed yet";
      toggle off.
- [ ] **Line history (D204):** select a few lines → Show line history → the Line history section
      lists the commits; click one → its diff.
- [ ] **Compare (D204):** Compare branches… → pick main and a feature branch → files listed →
      click → diff; Swap sides.
- [ ] **Stashes (D204):** stash twice → the Stashes section lists both; expand → files → diff;
      Apply / Pop / Drop from the row.
- [ ] **PR review (D204, real gh):** a pull request with review comments → Files changed → open a
      file's diff (merge base ↔ head); Reply (quick input) and Resolve; check the branch out → the
      margin marks show the threads on hover.
- [ ] **GitHub notifications (D204, real gh):** the section lists unread ones; click → opens on
      GitHub and marks read; Mark all as read.

### Terminal

- [ ] **Profiles on Windows (D204):** the ▾ beside + in the terminal panel lists PowerShell (if 7 is
      installed), Windows PowerShell, Git Bash, Command Prompt and each WSL distribution as
      "Ubuntu (WSL)". Each starts; Git Bash shows the dots (shell integration), its tab title says
      "bash · folder", `cd /c/Windows` then `ide://terminals` shows `cwd: C:\Windows`; dropping a file
      with a space in its path types `'/c/…/my file.txt'`.
- [ ] **Default profile (D204):** ▾ → Select default profile → Git Bash; Ctrl+Shift+\` opens Git Bash;
      restart the IDE: the restored Git Bash tab is Git Bash again. Set it back to empty.
- [ ] **Profiles in settings (D204):** add `"terminal.profiles.windows": { "Command Prompt": null,
      "Dev": { "path": "pwsh", "args": ["-NoLogo", "-NoProfile"], "env": { "DEV": "1" }, "color":
      "terminal.ansiGreen" } }`: Command Prompt is gone from ▾, "Dev" opens with a green tab icon,
      `$env:DEV` is 1, dots appear (integration kept with -NoProfile).
- [ ] **Restored output (D204):** run a few commands with colored output (`git status`, `ls`),
      close the IDE, open it: the terminal shows them dim, then "──── Restored session · …",
      then a new prompt that works. Windows: the old lines are just above the new prompt (scroll up
      a little); no lines drawn twice or over each other, also after resizing the panel.
- [ ] **Suggestions (D204):** in PowerShell type `Get-Ch` → Get-ChildItem shows; Tab completes it.
      Type `git ch` → checkout / cherry-pick; Escape closes. `cd src\` → folders of src. In Git
      Bash `cat READ` → README.md; ↑/↓ then Enter accepts; `ls` + Enter (without moving) just runs.
- [ ] **WebGL (D204):** `ide://terminals` shows `renderer: "webgl"`; scroll a large output quickly —
      smooth. `terminal.gpuAcceleration: "off"` → `renderer: "dom"`, still drawn right.

### Debugger

- [ ] **Compound (D204):** launch.json with a Node server and a Chrome client in a compound with
      `stopAll`; start it from the picker: two sessions in the call stack, both hit breakpoints,
      clicking a session focuses it (toolbar picker follows); Stop on one stops both.
- [ ] **Child processes and workers (D204):** debug a script that `fork()`s a child and starts a
      Worker; breakpoints in both stop; their sessions sit under the parent; stopping the parent ends
      them.
- [ ] **JavaScript debug terminal (D204):** open it, run `npm run dev` (Vite or Express) and
      `npx jest` in a project: breakpoints in server code and tests hit; npm itself isn't a session.
      Windows: in PowerShell and cmd; a path with spaces in the user folder.
- [ ] **Function breakpoint (D204):** "+" in Breakpoints, a function name in a module loaded
      later (`require` inside a function): it stops there; a name that doesn't exist shows hollow.
- [ ] **Exception widget (D204):** uncaught exceptions on, a Node script that throws: the zone
      under the line shows type, message, stack; close hides it; Python with debugpy: the adapter's
      filters show in Breakpoints, "Raised exceptions" with a condition (`ValueError`) stops only on
      those.
- [ ] **Data breakpoint (D204):** C with lldb-dap or GDB: right-click a variable → Break on value
      change; continue stops when it changes.
- [ ] **Threads (D204):** a C or Python program with two threads: both in the call stack, pause
      one, step it, continue it while the other stays stopped.
- [ ] **Process picker (D204):** "Attach to Node process…" (or `"processId":
      "${command:pickProcess}"`) on a Node server started without --inspect: it attaches (9229).
      Windows: the list shows node.exe processes with their command lines.
- [ ] **serverReadyAction (D204):** Express on 3000 with `debugWithChrome`: Chrome opens on
      http://localhost:3000 with breakpoints in the page; stopping the server keeps or closes it per
      `killOnServerStop`.
- [ ] **Go and .NET (D204):** without dlv: the error offers Install (go install); with it, a Go
      package stops at a breakpoint. netcoredbg on PATH: a .NET console app stops at a breakpoint.
- [ ] **Browser pane on Windows (D204):** set `debug.browserPane.debuggingPort` to 9333, restart,
      open a Vite app in the pane, "Debug the browser pane": a breakpoint in a component hits; the
      IDE's own UI isn't the target; terminals don't see WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS.
- [ ] **Disassembly / loaded scripts (D204):** lldb-dap on a C program: Open disassembly view
      shows instructions with `=>` at the current one; Loaded scripts lists the modules.

### Testing

- [ ] **Run with coverage (D204):** in a node:test project, hover a test file in Testing → the
      shield → the Test coverage tab opens with the files and percentages; open the source file
      → green / red bars in the margin; "Show inline coverage" in the tab hides them.
- [ ] **Coverage, Vitest without the provider (D204):** run with coverage in a Vitest project
      without `@vitest/coverage-v8` → the tab says to install it.
- [ ] **Coverage, pytest (D204):** `pip install pytest-cov`, run a pytest project with coverage →
      Python files listed; branches in the tooltip.
- [ ] **Mocha (D204):** a project with `mocha` and `.mocharc.yml` `spec: test/**/*.spec.js` →
      the specs show under Mocha; run one test (hover → ▶) → only it runs.
- [ ] **Playwright (D204):** `npm init playwright@latest` sample → Playwright group with
      chromium / firefox / webkit; run one test in firefox only.
- [ ] **unittest (D204):** a folder with `tests/__init__.py` and a `unittest.TestCase` →
      unittest group; a failing `assertEqual` → hover its message → Compare expected with
      actual opens a diff.
- [ ] **Expected / actual (D204):** a Jest `expect({a:1}).toEqual({a:2})` failure → Compare →
      the diff shows the two objects.
- [ ] **Test results (D204):** run several times → the history icon → runs newest first; hover
      an old run → Run again.
- [ ] **Debug test (D204):** set a breakpoint in code a Jest test calls → hover the test → the
      bug → it stops there; same for a pytest test with debugpy installed.
- [ ] **Explorer percentages (D204):** turn on `testing.showCoverageInExplorer`, run with
      coverage → percentages as badges in the explorer.

### Agent and MCP

- [ ] **Rules page (D204):** ⋯ → Rules…; New rule (Cursor, scope Matching files, `*.ts`) creates
      `.cursor/rules/<name>.mdc` with `globs`; Edit → scope Always rewrites `alwaysApply: true`; the
      switch turns it off (gone from a new chat's prompt); Delete asks and removes the file.
- [ ] **Rules for subagents (D204):** a `.cursor/rules/review.mdc` with `subagents: reviewer` and
      nothing else: a new chat's prompt doesn't list it; `delegate` to reviewer follows it.
- [ ] **MCP OAuth (D204):** install Sentry or Linear from the gallery; send a message: the server
      waits for a sign-in (notification with Sign in); Sign in opens the browser, the page says Signed
      in, the server starts with its tools; restart the IDE: no sign-in again; Sign out → asks again.
- [ ] **MCP sampling (D204):** a server that samples (e.g. `@modelcontextprotocol/server-everything`'s
      sampleLLM): the quick input shows the prompt; Allow once → the tool gets the model's text;
      Deny → the tool reports a refusal; MCP servers page → Sampling: allow → no question.
- [ ] **MCP gallery (D204):** offline, the gallery shows; Install Playwright for this folder writes
      `.vscode/mcp.json` or `<IDE folder>/mcp.json`; the next message starts it without the folder
      approval card.
- [ ] **Worktree setup and PORT (D204, Windows):** `agent.worktree.setupScript` = `npm ci` in a Node
      project with `.env`: New agent in a worktree copies `.env`, runs npm ci (the overview says
      Setting up, then Working); in the new window's terminal `echo $env:PORT` shows 3010, the next
      worktree 3020.
- [ ] **Best of N (D204):** ⋯ → Best of N…, pick two models: two windows start; the Compare page
      shows each one's changes; Apply this one brings the changes in staged.
- [ ] **Auto-approve (D204):** add `**/.env` → Ask under Reading files; ask the agent to read `.env`:
      a card asks even with full access; add `git status` → Allow: the agent runs it without a card in
      Ask mode.
- [ ] **@docs (D204):** Docs page → add `https://docs.python.org/3/tutorial/`: it reads up to 60
      pages with a pause, Ready with a page count; `@docs:python` + "how do list comprehensions work"
      answers from the tutorial.
- [ ] **Claude Code /ide (D204, Windows):** turn on the integration; `%USERPROFILE%\.claude\ide`
      has `<port>.lock`; in a terminal opened afterwards, `claude` connects by itself (`/ide` shows the
      IDE); select code: Claude Code sees it; ask it to edit a file: a diff opens, Accept writes it,
      Reject leaves it; turn it off: the lock file is gone.

## m7.5.2 (D205)

- [ ] Settings → Agent shows one Customize card; it opens the Customize tab at Models. The chips
      switch sections; typing "subagents" in its search leaves the Agents chip.
- [ ] Manage providers, Configure agents and MCP servers in the Chats panel, and Settings' sidebar
      links (Models and providers, Agents, Rules), each open the same Customize tab at their section.
- [ ] Customize → MCP servers: the built-in row first (click lists the tools), your servers as
      rows with a state dot; ⋯ on a row offers sign in / sampling / restart / remove; New MCP
      server offers Custom server… and the popular ones.
- [ ] Customize → MCP servers: Remove on a server takes its row away at once. Clicking a row
      opens its Configure dialog: the source switch turns it off ("Off" in the list), tool
      switches and Turn all off hide tools from the agent ("N tools enabled" drops), Reload restarts it.
- [ ] Customize → Commands: + New in Workspace asks a name, writes <IDE folder>/commands/<name>.md
      and opens it; /name works in chat; ⋯ → Delete removes it.
- [ ] Customize → Agents: your own subagent's card has a trash button; it asks, then the card is gone.

## m7.5.3 (D206)

- [ ] **Skills page (D206):** Customize → Skills shows User and Workspace groups with + New at the
      right of each header; + New in Workspace, type "Release Notes": `release-notes/SKILL.md`
      opens from the template in the workspace folder's skills, and the row appears at once.
- [ ] **Skills from other tools (D206):** a skill in `~/.claude/skills/<name>/SKILL.md` (or
      `~/.cursor/skills`, `.claude/skills` in the folder) is listed with its folder as a tag; one
      without a description is under Not loaded with the reason. On Windows, check
      `%USERPROFILE%\.claude\skills` and a skill folder that is a link (`mklink /J`).
- [ ] **Skills in a chat (D206):** in a new chat, ask for something a skill's description
      matches: the agent calls use_skill, then reads the files it lists; `/name some text` runs it
      with the text as its arguments.
- [ ] **Skill actions (D206):** a row's ⋯ (shown on hover): Open, Turn off (the row dims; a new
      chat doesn't list it), Turn on, Reveal in file manager (Explorer selects SKILL.md on
      Windows), Delete (asks; the folder goes and the row with it). Editing SKILL.md and saving
      updates the row's description.

## m7.6 (D207)

### Editor and keyboard shortcuts
- [ ] **Selection count (D207):** select a word, Ctrl+D twice: the status bar reads "3 selections
      (N characters selected)"; one selection reads "Ln x, Col y (N selected)"; moving the cursor
      in a 50 MB file stays smooth.
- [ ] **Chord args (D207):** keybindings.json `{ "key": "ctrl+k ctrl+j", "command": "cursorMove",
      "args": { "to": "up", "by": "line", "value": 2 } }`; in an editor, Ctrl+K Ctrl+J moves the
      cursor up two lines.
- [ ] **Shortcut titles (D207):** Keyboard shortcuts, search "cursor": rows read "Cursor down",
      "Cursor to line start with selection"…, not bare ids.

### Terminal
- [ ] **Suggestions per terminal (D207):** type `ech` in terminal A (list opens), click terminal
      B, press Up: B's shell history comes up (A's list doesn't move).
- [ ] **zsh records (D207):** in a zsh terminal run `printf abc`: the command's output in
      `ide://terminals/<id>/commands` (or the agent's run) is "abc", without `%`; the inverse `%`
      still shows on screen; a custom `PROMPT_EOL_MARK` in .zshrc is kept.
- [ ] **JavaScript debug terminal in ▾ (D207):** Terminal's + ▾ lists "JavaScript debug
      terminal"; choosing it opens one; `node -e "debugger"` in it attaches.

### Git
- [ ] **Merge editor polish (D207):** a conflict where both sides changed one number: the number
      is highlighted in Incoming and Current; drag the line between Incoming and Current; Accept
      all in each header; narrow window: panes stack, no sash.
- [ ] **Autofetch everywhere (D207):** a folder with a nested repository whose remote got a new
      commit, the outer repository selected, `git.autofetch` on: within the period the nested
      repository shows 1 behind in Source control's repository list.
- [ ] **PR files refresh (D207):** two repositories with pull requests; open #N files from
      repository A, select B, press Refresh in the tab: it still shows A's #N.
- [ ] **Commit message from an agent (D207):** Customize → Models → Commit messages → pick GitHub
      Copilot (or Claude Code) under Agents; Generate commit message in Source control writes a
      message (a few seconds).

### Debugger
- [ ] **Compound restart (D207):** a compound of one configuration with `stopAll`: start, Restart
      (Ctrl+Shift+F5): `ide://debug` still shows `stopAll: true` on the session.
- [ ] **Program paths user-only (D207):** `debug.gdbPath` in `.vscode/settings.json` is ignored
      (and not offered by completion there); in user settings it's used.
- [ ] **Presentation (D207):** launch.json with groups / order / hidden: the Run and debug list
      is ordered like VS Code's with separators; hidden ones are missing but `debug.start { name }`
      starts them.

### Agent: commands, rules, auto-approve, worktrees
- [ ] **Command pre-approval (D207):** in your commands folder (Customize → Commands → + New,
      user) write `allowed-tools: Bash(git status:*)` and a body asking to run `git status`; /name
      runs it without a question. The same file in `.claude/commands` asks.
- [ ] **disallowed-tools (D207):** a command with `disallowed-tools: Bash(git push:*)` asking to
      push: the push is refused without a question and the agent says so.
- [ ] **Subagent rules (D207):** `web/AGENTS.md` with a distinctive line; ask the agent to
      delegate "read web/x.ts and quote the folder's rules" to general: the report quotes it.
- [ ] **Always on a protected file (D207):** Auto-approve → Reading files → `**/.env*` Ask; ask
      the agent to read `.env`; tick Always allow, Allow: a note says it was saved, the page lists
      `/.env` Allow, `src/.env` still asks. find_files "env" doesn't list `.env.local`.
- [ ] **Always on a site (D207):** turn on browser protection, let the agent click in a page:
      Always allow → the domain is saved, the next click doesn't ask.
- [ ] **Worktree PORT in setup (D207):** setup script `echo $PORT > port.txt`; a new worktree
      agent's folder has its port in port.txt.
- [ ] **Worktree window closed (D207):** start a worktree agent on a long task, close its window
      mid-turn: the overview shows Stopped within a few seconds.
- [ ] **Apply conflicts (D207):** change in this folder the same lines a worktree agent changed,
      Apply this one: a warning with Resolve conflicts opens the merge editor; the row shows
      "1 conflict" until it's resolved and staged.

### MCP client
- [ ] **Keychain (D207):** on Windows, sign in to a remote MCP server (or set a provider key) →
      Credential Manager → Windows Credentials lists entries under the IDE's identifier
      (`dev.placeholder.ide`); `%APPDATA%\…\secrets.json` holds only a marker for them. Restart:
      the key still works. On macOS: Keychain Access shows them; on Linux with GNOME Keyring:
      Seahorse shows them; on a headless Linux the values stay in secrets.json.
- [ ] **Keychain migration (D207):** with an old secrets.json holding plain keys, start the IDE
      and use the agent → the file now has markers and the keys still work.
- [ ] **Scope step-up (D207):** a remote MCP server whose tool answers 403
      `insufficient_scope` (e.g. GitHub's remote server with a narrow token) → the IDE asks to
      sign in again, the browser asks for the extra scope, and the call goes through.
- [ ] **Sampling review (D207):** an MCP server that samples (sampling "Ask") → Allow once →
      the answer opens in a dialog; edit it and Send → the server gets your text; Reject → the
      server hears "user rejected"; Escape rejects too.
- [ ] **Sampling with an image (D207):** a server that sends an image in sampling → with a
      vision model (Claude, GPT-4o, llava) it's described; with a text-only model the server
      hears why it was refused.
- [ ] **Registry search (D207):** New MCP server → Search the MCP registry… → type "github" →
      results come from the registry; pick one → a confirmation shows what it runs; Install →
      it's in mcp.json with its inputs. Offline (or `agent.mcp.registryUrl` empty) → the
      built-in list with a note.
- [ ] **Remote notifications (D207):** a remote server that adds a tool or updates a
      subscribed resource while idle → the change shows without sending a message; stop the
      server (or close the folder) → its GET request ends (the server's log).

### Claude Code /ide
- [ ] **executeCode (D207):** with a Jupyter notebook open and Claude Code connected (/ide),
      ask Claude Code to run `1+1` in the notebook → the IDE asks; Run it → a new cell at the
      end runs and Claude Code gets `2`; Don't run → Claude Code is told no.
- [ ] **Send selection to Claude Code (D207):** select lines 3–5 → command palette → Send
      selection to Claude Code → Claude Code's prompt gets `@file#L3-5`.
- [ ] **Diagnostics ranges (D207):** Claude Code's getDiagnostics on a file with an error
      → the range covers the whole squiggle (start and end).

### @docs
- [ ] **@docs sitemap and JavaScript pages (D207):** add docs for a site with a sitemap (e.g.
      https://docs.python.org/3/library/ with a small maxPages) → pages not linked from the
      start page appear; a single-page-app site → its row says "N need JavaScript (not read)".
- [ ] **@docs refresh (D207):** set `agent.docs.refreshDays` to 1, wait a day (or edit the
      source's index date) and start the IDE → a minute later the source reads again.

### Customize and Settings
- [ ] Customize tabs (D207): the open one has a background, hover only changes the text color.
- [ ] Settings → Agent sidebar (D207): Customize ↗ under MCP server; Settings → MCP server:
      "Configure MCP servers" opens Customize at MCP servers.

### Audit (D207)
- [ ] A restricted folder (Manage workspace trust → restricted), mode Automatic: ask the agent to
      run `npm test`; the card asks and says the folder isn't trusted. Trust it: it runs.
- [ ] A CRLF file on Windows: ask the agent to rewrite it with write_file; the diff shows only the
      lines it changed.
- [ ] Edit a file in the editor after the agent read it, then ask for a full rewrite: it reads the
      file again before writing.
- [ ] Customize: type "zzz" in the search box: "No section matches".
- [ ] Restricted mode: Manage workspace trust → restricted: Source control says git is off and
      no language server starts; trust the folder: both come back.
- [ ] Edit a file in another program while it's open with unsaved changes in the IDE, then save:
      the "changed on disk" banner shows instead of overwriting.

## m7.6.1 (D208)

### Git tools
- [ ] **Git tools on by default (D208):** fresh profile → Extensions lists "Git tools" (active,
  with its icon); Source control has Stashes, Line history, Compare, GitHub notifications sections
  at the bottom.
- [ ] **Git tools off (D208):** disable it → the four sections, Toggle file blame and Show line
  history leave the palette; the status-bar blame, file history, Git menu → Stash… still work.
  Enable it → they come back.
- [ ] **File blame via the extension (D208):** Toggle file blame on a committed file → author and
  age before each line, newer lines brighter, hover shows the commit; type → "Not committed yet"
  after a pause; commit → updates.
- [ ] **Stashes section (D208):** stash a change → it appears; expand → its files (click: diff);
  hover → Apply / Pop / Drop work (Drop asks).
- [ ] **Notifications via gh (D208):** signed in with gh → unread ones in bold; click opens GitHub
  and un-bolds it; Mark all as read.

### External agents
- [ ] **External agent with no folder (D208):** close the folder, new chat, pick Codex (or Claude
  Code), send "what's 2+2" → Just chat → it answers (no "Open a folder first."). Ask it to write
  `hello.txt` → it does, in the chat's own folder (`%APPDATA%\<id>\agent\scratch\<chat>`); ask it
  to read `C:\Windows\win.ini` through the IDE → refused (its own shell may still read it).
- [ ] **IDE agent with no folder (D208):** close the folder, pick a model, ask "read README.md" →
  the read fails saying no folder is open, the chat goes on.
- [ ] **Codex usage (D208):** a few Codex turns → Usage page: "Codex (external agent)" with tokens
  per turn, cost "—"; Claude Code turns show tokens and a cost; Copilot turns show "N turns ·
  tokens not reported".
- [ ] **Guardian (D208):** Codex with Guardian approvals on (`approvals_reviewer =
  "guardian_subagent"`), ask it to run `npm run check` → one row `npm run check` with "PowerShell"
  and "Guardian: approved · low risk" tags; expand → the rationale; hover → no JSON.
- [ ] **Codex's own edits under review (D208):** in a git folder ask Codex to change two files and
  add one → after the turn the changes card lists the three; open a diff, undo the new file (it's
  deleted), keep the others; restore the turn's checkpoint puts them back.
- [ ] A tooltip with a long path or command wraps inside its box.

## m7.6.2 (D209)

### Terminal, debugger, command line, windows
- [ ] **Split terminals (D209):** in a terminal press Ctrl+Shift+5: a second shell beside it in
  the same tab (same folder); the tab reads "a, b"; drag the sash, double-click it (equal);
  Alt+Left / Alt+Right move the focus (and still reach the shell in an unsplit terminal); move
  the panel to the side: the panes stack; kill one: the other stays; "Unsplit": the shell keeps
  its history in a new tab; reload: the split tab comes back split with both outputs restored.
- [ ] **Folder profiles (D209):** a folder's `.vscode/settings.json` with
  `terminal.integrated.profiles.<platform>`: listed in + ▾ only after trusting the folder;
  Restricted mode hides it again.
- [ ] **Automation profile (D209):** `terminal.automationProfile.<platform>` = Git Bash (Windows)
  or zsh: a shell task's terminal runs in it; a task argument with spaces stays one argument; a
  Node launch with `"console": "integratedTerminal"` runs.
- [ ] **Debug console per session (D209):** start a compound of two Node programs: the picker
  above the console lists both; evaluating `1+1` in one doesn't show in the other; a forked
  child's evaluation shows in its parent's console; "Clear console" clears one only.
- [ ] **Command line (D209):** Install shell command in PATH (read the dialog's steps), open a
  new terminal: `<name> file.ts:10:3` opens there in the running window; `<name> --diff a b`;
  `git -c core.editor="<name> --wait" commit` blocks until the message tab closes; with no window
  running, `<name> --wait x.txt` starts one; Uninstall removes the shim and the PATH entry.
- [ ] **Window for a folder (D209):** with folder A open, Open recent → A from another window: the
  first window comes to the front, no second window; `<name> A` from a terminal does the same.
- [ ] **Restore windows (D209):** open folders A and B in two windows, quit both (last one last):
  starting the IDE reopens A and B; `window.restoreWindows: "one"` reopens only the last;
  `"none"` an empty window.

### Notebooks, shortcuts, testing, logs, merge editor
- [ ] **Notebook multi-select (D209):** in a notebook with five cells, Shift+click the fourth
  cell's margin after selecting the first: four cells have the selected background. Alt+Down
  moves them together; Ctrl+Z puts them back. Ctrl+click one off; press M: the rest turn
  Markdown. Shift+Down / Shift+Up grow and shrink the selection; Ctrl+A selects all; C then V
  pastes copies of all. The … menu offers Join selected cells (refuses a mix of code and Markdown)
  and Run selected cells (runs them in order, stops at an error).
- [ ] **Sticky cell toolbar (D209):** a cell with 200 lines, selected, scrolled half way: its
  toolbar stays at the top of the notebook; scrolled past its end, the toolbar leaves with it.
- [ ] **When clause in the row (D209):** Keyboard shortcuts → a row's menu → Change when
  expression: the When cell becomes a box with the clause selected; type, Enter: saved in
  keybindings.json; Escape leaves it as it was.
- [ ] **Shared keys (D209):** in an editor, type until the suggestion list opens and press
  Ctrl+PageDown: the list pages; close it and press Ctrl+PageDown: the next tab. F1 in an editor
  opens the IDE's command palette, Ctrl+G its go to line. The shortcuts editor shows an ⓘ (not ⚠)
  on Ctrl+PageDown and no conflict on Ctrl+Z.
- [ ] **Test results kept (D209):** run a project's tests with coverage, reload the window and
  restart the IDE: the Test results tab lists the runs, the test view shows the statuses, the
  coverage tab and margin are back. Testing: Keep results off: they go on reload.
- [ ] **A test's output (D209):** Go, pytest and node:test projects with a test that prints and
  one that fails: select each in the Test results tab: its own output shows on the right (below in
  a narrow tab).
- [ ] **Output channels (D209):** View → Show output: the channel picker lists Window, Extension
  host, Git, Tasks, Agent and each language server that ran; Git shows git calls as Source control
  refreshes; run a task: Tasks shows its start and exit code; ask the agent to read a file: Agent
  shows the command. Set log level → Debug: Window shows each command; → Error: only errors. Help →
  Open logs folder: a `session-…` folder beside the session's log holds `exthost.log`, `git.log`,
  `lsp.<server>.log`.
- [ ] **Merge editor (D209):** drag the bar above the result up and down; reload: the tab keeps
  its sizes. Accept incoming: the changed words are highlighted in the result. Make a conflict
  where `main` changes a file `feature` deletes, merge, Resolve in merge editor: the changed file
  shows with Keep the file / Delete the file; Delete: the file is gone and the deletion staged.

### Browser
- [ ] **Another port (D209):** a page on `localhost:5173` with a link to
  `http://127.0.0.1:8787/account`: click it → the same tab shows the account page (address bar
  `http://127.0.0.1:8787/account`), Back returns to 5173, Forward again; nothing opens outside the
  IDE.
- [ ] **Forms and redirects (D209):** a login form on 5173 posting to another port, and a server
  redirect (302) from one port to the other: both land in the same tab; Back from the redirected
  page goes to the page before it (no bounce).
- [ ] **New tabs and popups (D209):** `target=_blank` link, Ctrl/Cmd+click and middle-click: a new
  browser tab beside the current one. A button calling `window.open(url)`: a new tab; a sign-in
  popup that does `window.opener.postMessage(...)` and `window.close()`: the opener gets the
  message, the popup tab closes, `popup.closed` becomes true.
- [ ] **Other sites (D209):** a link to `https://example.com`: the tab's own window shows it;
  Back in the tab (when the site has no earlier page) returns to the local page. With
  `"browser.externalLinks": "system"` it opens in the system browser instead.
- [ ] **OAuth (D209):** a real provider (e.g. a GitHub OAuth app with callback
  `http://localhost:5173/callback`): the provider opens in the tab's window, the callback comes
  back into the tab's frame and the window closes; the app is signed in.
- [ ] **Cookies (D209):** sign in to a local app whose session cookie has no SameSite /
  SameSite=Lax: reload — still signed in.
- [ ] **Embedded iframe (D209):** an iframe in the page with a link to another site: the iframe
  navigates by itself.

### Git tools
- [ ] **Stash changes… (D209):** with changes, the Stashes header's archive button asks for a
  message (Enter for none, Escape cancels): the stash appears in the section.
- [ ] **Sync changes (D209):** a branch 1 behind and 2 ahead of its upstream: the button reads
  "Sync changes 1↓ 2↑" with arrow icons; the tooltip says pull 1 and push 2.

## m7.6.3 (D210)

- [ ] **HTML in the preview (D210):** a README with `# <img src="https://q5js.org/q5js_logo.avif" height="64"> <img src="https://q5js.org/q5js_brand.avif" height="64">` shows two images in the heading, not the tags as text; `<p align="center"><img src="logo.png" width="100"></p>` is centered; `<details><summary>` opens and closes; `<a href="javascript:alert(1)">x</a>` is plain text; `<img onerror=…>` and `<script>` do nothing.
- [ ] **Picture follows the theme (D210):** `<picture><source media="(prefers-color-scheme: dark)" srcset="dark.png"><img src="light.png"></picture>` shows dark.png in a dark theme, light.png after switching to a light one and editing the file.
- [ ] **No sticky headings (D210):** scrolling a long preview, headings scroll away with their text; nothing stays stuck at the top.
- [ ] **Find in the preview (D210):** click in a preview, Ctrl+F: the bar opens at the top right with the cursor in it; typing highlights all matches, "1 of N" counts; Enter / Shift+Enter move (wrapping), the current match is brighter and scrolled to; Aa / ab / .* toggles change the count; Escape closes and clears the highlights. Ctrl+F in the source editor still opens the editor's find; in a notebook the notebook's.
- [ ] **Graph section (D210):** Source control shows Changes, then **Graph** (open), then the Git
      tools sections. Drag the line above Graph up and down: Changes and Graph share the height;
      reload the window: the size is kept; fold Graph, reload: still folded. Turn off Git tools
      (Extensions): Graph is the only section below Changes. The activity bar never shows a Graph
      icon, and its right-click list doesn't name it.
- [ ] **Outgoing / incoming changes (D210):** commit once without pushing: **Outgoing changes 1**
      with a dashed circle sits above your commit; expand it, click the file: a diff from the
      upstream's commit. Push from another clone and Fetch: **Incoming changes 1** appears above
      where the branches forked, the purple line running into it. Sync changes: both rows go.
- [ ] **Graph colors (D210):** with 2 commits not pushed, their line and dots are blue down to the
      commit with `origin/…`, purple from there on; the `main` chip is filled blue, the remote's
      purple, a tag yellow. Light theme: the same, readable. All branches: other branches get
      their own colors.
- [ ] **Badges past 99 (D210):** create 1 234 new files: the Source control badge reads 1234 and
      fits its icon; over 9 999 it reads 9999+.
- [ ] **Remote images refused (D210):** `![x](https://127.0.0.1/a.png)` and `![x](http://example.com/a.png)` show their alt text; a badge from img.shields.io shows.

## m7.6.4 (D211)

- [ ] **External agent reads the terminal (D211):** run `echo hello-from-terminal` in a terminal, pick Codex (or Claude Code) as the chat's model and ask "what does my terminal show?": it answers with the line (through the IDE's tools; a read doesn't ask). Ask it to open a file in the editor: the IDE asks first. Settings → `agent.externalAgents.ideTools` off, new chat: it can't.
- [ ] **Terminal output for any program (D211):** start a dev server (`npm run dev`), then ask the built-in agent what the server printed: it reads it (terminal.readOutput).
- [ ] **Explorer right-click (D211):** focus the editor, then right-click a file in the explorer without left-clicking first: the file's menu (Open to the side, Rename…), not the folder's. Right-click below the last row: the root menu.

## m7.6.5 (D214)

- [ ] **Earlier attachments (D214):** send an image to a vision model, restart the IDE, reopen the chat and ask "what was in the image I sent?": the agent calls chat_attachments and describes it (from the preview).
- [ ] **Download and add to project (D214):** hover a sent attachment: Download… opens the save dialog and the notification's Show in folder opens Explorer; Add to project… writes it into the folder. Open an image in the viewer: the same two buttons are in its bar.
- [ ] **Viewer spacing (D214):** open a sent image with two or more images in the message: the arrows sit over the image's edges, and the resize edge between the chat and the editor still drags.
- [ ] **20 attachments (D214):** attach 20 files to one message: all are accepted; the 21st is refused with a message.
- [ ] **View more providers (D212):** AI models page → Add a provider → View more shows 13 more
  tiles with logos (readable in light and dark themes, Hugging Face's logo dark on yellow); View
  fewer hides them. Connect Mistral or DeepSeek with a real key: models list.
- [ ] **Name suggestions (D212):** Other server → type "groqai": Groq is suggested with its logo;
  click it → the Groq key form. Type "togeth", ArrowDown, Enter → Together AI's form, its tile
  shown under View more. "My office box" suggests nothing.
- [ ] **Own image (D212):** Other server → Choose image… → pick a PNG under 256 KB: the preview
  shows it; connect: the row shows it after restart too; a 1 MB file or a .txt renamed .png is
  refused with a message. Remove the provider → add it again: letter badge.
- [ ] **Azure / Z.ai addresses (D212):** Azure OpenAI asks for `https://<res>.openai.azure.com/openai/v1`
  and lists models; Z.ai lists models (no `/v4/v1`).
- [ ] **Risky folder caution (D213):** Open folder → your Downloads folder: the dialog says why,
  Open in restricted mode is the default; the folder opens restricted (status bar), its
  AGENTS.md isn't on the Rules page ("aren't loaded automatically"). Cancel keeps the old folder.
  Repeat with the home folder, the Desktop, `C:\` / a USB drive's root, and a folder inside
  Downloads (title "… is in your Downloads folder").
- [ ] **Downloads moved (D213, Windows):** Move Downloads to another drive (Properties →
  Location) and restart: opening the new location warns.
- [ ] **Agent and Downloads (D213):** With the home folder open, ask the agent to read
  `Downloads/x.txt`: it asks "Let the agent work in your Downloads folder?" even with full
  access; Deny → it says so and stops; Allow → it reads, and later reads there don't ask in that
  chat. Ask it to append to `~/.bashrc` or write `.claude/settings.json`: it asks every time.
- [ ] **External agent in Downloads (D213):** Choose Codex or Claude Code with Downloads open:
  it asks before starting there.

## m7.6.6 (D215)

- [ ] **ACP registry gallery (D215):** Customize → Models: the cards under "Use an agent you
  already have" show icons, versions and licenses in the dark and the light theme; the search box
  filters; Details shows repository, website, license (opens the browser), authors; the status
  line says "updated just now" (or the cached / built-in list when offline).
- [ ] **Install a binary agent (D215):** Install Kimi CLI (or goose, OpenCode): the dialog names
  github.com, MIT and "checked against the registry's SHA-256"; the card shows the download's
  progress (Cancel stops it); then "Installed … · checksum verified" and a row with Use / Remove;
  pick it in the model menu and chat (it asks you to sign in to its service as its docs say).
- [ ] **Not checksum-verified (D215):** Install Cursor: the dialog and card say "not
  checksum-verified"; it runs (`cursor-agent acp`) after `cursor-agent login`.
- [ ] **npx / uvx agents (D215):** Install Qwen Code (npx): no download, it starts through npx;
  without Node.js the card says "Needs Node.js" and Install says how to get it.
- [ ] **On PATH (D215):** with `opencode` (or `kimi`, `goose`) installed yourself, its card says
  "Found … on your PATH" and Install uses it without downloading.
- [ ] **The agent asks (D215):** ask the IDE's agent "install the goose agent": a card in the chat
  asks even with full access; Deny → nothing installed.
- [ ] **Remove (D215):** Remove deletes `<data>/acp-agents/<id>`; the model menu no longer lists
  it; a chat that used it says the agent isn't there.
- [ ] **Presets unchanged (D215):** the Claude Code, Codex, Gemini CLI and Copilot rows work as
  before; their gallery cards say "Built in"; old chats on `acp/Claude Code` still resume.

## m7.6.7 (D216)

- [ ] **Tidier Models page (D216):** Customize → Models: provider tiles have no tags and are all the same height (also after View more); under "Use an agent you already have", no search box or registry cards until View more agents; View fewer hides them again. There's no "Models for each feature" section.
- [ ] **Feature models elsewhere (D216):** Customize → Agents → AI features → the commit messages model lists Claude Code, Codex… under the models; Settings → AI in the editor → Commit messages → Model is a dropdown with the same choices; Edit with AI's dropdown has no external agents.


## m7.7 (D217–D226)

- [ ] **Hide a terminal (D217):** on Windows, open a PowerShell terminal, run
  `ping -t 127.0.0.1`, click the × at the end of the terminal toolbar: the tab goes; ▾ →
  Hidden terminals (1) → the terminal: the tab comes back where it was with the ping still
  counting. Repeat with a split tab (both panes come back, same sizes). Ask the agent to read
  the hidden terminal's output: it gets the ping lines.
- [ ] **Kill a hidden terminal (D217):** hide a terminal running `npm run dev`; ask the agent
  to kill that terminal (`terminal.kill { id }`): the server stops and it's gone from the ▾
  menu; closing the folder ends any hidden ones (Task Manager: no stray
  `powershell.exe` / `OpenConsole.exe`).
- [ ] **Terminal split icon (D217):** the terminal toolbar's split button, its context menu's
  "Split terminal" and the ▾ menu's show a terminal with a pane on the right, not the editor's
  two-column icon; sharp at 100 % and 150 % scaling, in light and dark themes.

- [ ] **Running command's dot and sticky line (D217):** on Windows in PowerShell, run
  `npm run dev` in a project whose server prints a few screens: the dot sits beside the
  `PS …> npm run dev` line (not on the blank row under it); scroll up a little and back to the
  bottom: the sticky line at the top shows the whole `PS …> npm run dev` line with the running
  dot, and stays while the server keeps printing; Ctrl+C: the dot turns red/green on the same row.
- [ ] **Timed workspace pulls (D218):** with pyright in `diagnosticMode: workspace` (or any server
  with workspace diagnostics), break a closed file from a terminal (`echo 'x: int = "a"' >> m.py`):
  its problem shows in Problems within a few seconds without opening it.
- [ ] **didSave with text (D218):** with a server that asks for `includeText` (e.g. the mock
  `tools/mock-lsp.mjs --d204 --m77` of the sample folder), type and save at once: the server's log
  shows the saved text after the last change.
- [ ] **Closed files' problems (D218):** with pyright in workspace mode, open a Python file with an
  error, close its tab: the error stays in Problems (the server reports it for the closed file);
  reopen it, edit: the problem follows the edits. With `openFilesOnly`, the problem goes on close.
  A TypeScript file with the built-in checker: its problems go on close.
- [ ] **UTF-8 rewrite (D218):** open a Windows-1252 file (read-only, banner); from a terminal
  rewrite it as UTF-8 (`iconv -f cp1252 -t utf-8 a.txt > b && mv b a.txt`, or PowerShell
  `Get-Content a.txt -Encoding Default | Set-Content a.txt -Encoding utf8`): the banner goes, the
  status bar says UTF-8, typing and saving work.
- [ ] **Markdown inside HTML (D218):** a README with `<details><summary>More</summary>`, a blank
  line, a list and `**bold**`, then `</details>`: the preview shows them rendered inside the
  collapsible; `<table><tr><td>a</td></tr>stray</table>` shows "stray" above the table.
- [ ] **Language server settings (D218):** Language server settings → taplo / zls /
  bash-language-server show controls; changing one writes `lsp.servers.<name>.settings`.
- [ ] **Shared two-key chord (D219):** with an extension that binds Ctrl+K Ctrl+C to a command of its own, Ctrl+K Ctrl+C in a text editor comments the line (Monaco's), and in the explorer it runs the extension's command.
- [ ] **Removal with when (D219):** in keybindings.json, `{ "key": "ctrl+k ctrl+x", "command": "-editor.action.trimTrailingWhitespace", "when": "somethingElse" }` leaves Ctrl+K Ctrl+X working; with `"when": "editorTextFocus && !editorReadonly"` it's gone (the shortcuts editor no longer lists it).
- [ ] **Ctrl+K chord edit (D219):** with real keys, Ctrl+K Ctrl+X in a line with trailing spaces trims them.
- [ ] **Add / add in the merge editor (D219):** merge two branches that both added `x.txt` with partly the same lines: Resolve in merge editor shows one conflict per difference, the shared lines are in the result, and the base pane says there's none.
- [ ] **Merge editor base words and sizes (D219):** Show base highlights the changed words. Drag the sash above the result, close the tab, reopen it for the same file: the sizes come back.
- [ ] **Final newline (D219):** the incoming branch adds a final newline the current one lacks, and both change line 1. After accepting current, the result ends with the newline.
- [ ] **Status from the watcher (D220):** in a repository, change a file from a terminal outside
  the IDE (or another editor): it appears in Source control within about 2 s, without focusing
  the window; a `git checkout` of another branch updates the view once.
- [ ] **Multiple repositories (D220):** with a nested repository, set
  `scm.repositories.selectionMode` to "multiple": both repositories' changes are listed under
  their own rows; click the nested one's row, type a message and Commit: it commits there;
  Stage all on a group stages only that repository.
- [ ] **Choose a repository (D220):** with two repositories, run Merge branch…, Create worktree…,
  Interactive rebase… and Pull requests… from the palette: each asks for the repository first
  (the selected one on top); the Graph's menu items and the pull request tab's buttons don't ask.
- [ ] **Graph base color (D220):** on a feature branch of a clone (origin's HEAD set), the Graph
  shows `origin/main` orange (chip and lane); All branches colors other branches' chips in their
  lanes' colors; the filter button reads Auto / All.
- [ ] **Skills offered by file (D221):** a skill with `paths: "*.ts"` in `.claude/skills` and one
  in `packages/web/.claude/skills`: a new chat's "what skills do you have?" doesn't list them; ask
  the agent to read a `.ts` file / a file in `packages/web`: the read's result offers each once.
- [ ] **A user skill pre-approves (D221):** `~/.claude/skills/check/SKILL.md` with
  `allowed-tools: Bash(npm test)`: `/check` runs `npm test` without a question; the same file in
  the project's `.claude/skills` asks.
- [ ] **Forked skill (D221):** a skill with `context: fork`: `/name args` shows a use_skill row
  with the subagent's steps; only its report is in the chat.
- [ ] **Skills folder watched (D221):** with the Skills page open, create, edit and delete a skill
  in `~/.claude/skills` from Explorer / Finder / a terminal: the page follows within a second.
  On Windows, delete a skill folder there while the IDE runs: it isn't "in use".
- [ ] **Protected selection (D221):** add `secret.txt` as Ask under Auto-approve → reads, select
  text in it, ask the agent what's selected: it asks first; Deny keeps the text from it.
- [ ] **Freshness after a restart (D221):** the agent reads a file; edit it yourself; restart the
  IDE; in the same chat ask the agent to rewrite the file with write_file: refused ("changed since
  you last read it").
- [ ] **Two windows (D221):** open the same chat in two windows (Chats → open in the second
  window's Chats list), send a message in one, then in the other: the second shows "This chat was
  changed in another window" with Keep this version / Reload the other; each does what it says.
- [ ] **Worktree window after a restart (D222):** start two worktree agents, close the main
  window and start it again, close one agent's window. The overview shows that one as Stopped
  (if it was mid-turn) and the other as Working or Done.
- [ ] **Overview cost (D222):** with three worktree agents working, the overview stays live
  (state changes within about 2 s), and the main window's CPU stays low while they're idle.
- [ ] **executeCode images (D222):** with Claude Code connected through /ide and a notebook open,
  ask it to plot something with matplotlib. The new cell shows the plot, and Claude Code says
  what it sees in the image.
- [ ] **Send selection from the editor (D222):** with the integration on and Claude Code
  connected, select lines, right-click, choose **Send selection to Claude Code**, then press
  Ctrl+K Alt+K. Claude Code's prompt gets `@file#Lx-y` both times. With the integration off, the
  menu entry is gone and the key does nothing.
- [ ] **Against a live Claude Code (D204/D207/D222):** still unverified here; run through
  /ide, the selection, diffs, getDiagnostics, executeCode and at_mentioned once.
- [ ] **Stdio-only agent gets the IDE's tools (D223):** add an external agent that takes only stdio MCP servers (or the mock with `MOCK_ACP_STDIO_MCP=1`), ask it to read the terminal: it does; `ide://agent/ideTools` says `stdio`; Task Manager / `ps` shows `--mcp-stdio-proxy http://127.0.0.1:…/mcp` and no token on the command line.
- [ ] **Proxy on Windows (D223):** in an installed build under `C:\Program Files\…`, a stdio-only agent (Gemini CLI if it lacks HTTP) starts the IDE's exe as its MCP server: no window flashes, no console opens, the tools list arrives; closing the chat ends the proxy process.
- [ ] **Step-by-step changes (D223):** with Claude Code or Codex, ask for edits to two files in steps: each step's card shows its file while the turn is still running; Accept/Reject works before the turn ends.
- [ ] **Own edits during a turn (D223):** while an external agent works, edit and save a file it doesn't touch: after the turn it isn't in the changed files; the "Changed files" step names it as compared from your save.
- [ ] **Ignored file edit (D223):** an agent edits a git-ignored existing file (`.env.local`): it shows as an edit with only the changed lines, not as a new file.
- [ ] **Per-model usage (D223):** a Claude Code turn that runs a subagent: the Usage page lists both models, the turn counts as one request.
- [ ] **Keys by server (D223):** a folder's `.vscode/mcp.json` with a server named like one of yours but another URL asks for its key; your own server keeps its stored key.
- [ ] **pickString input (D223):** an mcp.json `pickString` input asks with a list (default first); the value is used.
- [ ] **Registry refusal (D223):** a registry search for a server whose package uses `--privileged` doesn't list it (`agent.searchMcpRegistry` → `refused`); one with `-p 8080:80` says "opens port 8080:80" in the install question.
- [ ] **Sampling stops with its server (D223):** while a sampling question is open, stop the server (MCP servers → restart): the question closes.
- [ ] **Sampling audio (D223):** with Groq or OpenAI connected, a server's sampling request with audio is answered from the transcript.
- [ ] **Claude Code disconnect (D223):** Claude Code proposes a diff, then quit Claude Code: the diff tab closes, the file isn't changed, a notification says so.
- [ ] **Two windows saving keys (D223):** set an API key in two windows at about the same time: both are kept.
- [ ] **--help probe with spaces (D223):** an agent with `modelFlag` whose command is a path with spaces lists its models in the model menu.
- [ ] **Ghost-text cache (D224):** with `editor.inlineCompletions.enabled` and a local code model,
  wait for a suggestion, then type its first characters: the rest stays shown at once, and
  `ide://editor/inlineCompletions` `requests` doesn't grow (`cache.hits` does). Type something
  else: a new suggestion after the pause. Backspace: the first one again, no request.
- [ ] **Import context (D224):** in a TS file importing `{ add } from "./util"` (util.ts not open),
  start a call to `add(`: `last.snippets` lists `src/util.ts` with kind `import`; the suggestion
  uses `add`'s parameters. Same with a Python `from .models import User`.
- [ ] **Next-edit cache (D224):** with `editor.nextEdit.enabled`, rename a parameter, wait for the
  suggestion, Esc, undo and redo the rename: the same suggestion appears with no new request
  (`ide://editor/nextEdit` `requests` unchanged, `cache.hits` up).
- [ ] **Explorer multi-select (D226):** in a project, click a file, then Ctrl+click two more and Shift+click another: all stay selected; right-click a file's *name*: its menu (Open to the side…), not the root's; right-click each part of a compact `a/b/c` row: that folder's menu. No thick focus outline left on the item.
- [ ] **Agent writes show at once (D226):** ask the agent to create `new/dir/file.txt`, then Reject all: the explorer shows the folder and file at once and drops them at once.
- [ ] **Changes card keeps the scroll (D226):** in a long chat, open a "Created N files" card: the chat stays where it was.
- [ ] **Providers tab (D226):** Customize shows Providers (not Models); the page tab says Model providers.

## m7.7, D227 second part

Agent:
- [ ] **Codex asks first:** with Review edits on, ask Codex to change a file: an approval card comes before the write (it runs in `read-only` mode). Set Auto (full access): it writes without asking.
- [ ] **Hooks:** set `agent.hooks` to a `PreToolUse` hook on `Bash` running a script that exits 2 for `rm`: ask the agent to delete a file with a command: the call is blocked and the agent says why. In a trusted folder with `.claude/settings.json` hooks: the first tool call asks to run them; Allow once asks again in a new chat only; Stop during a slow hook ends it at once.
- [ ] **Exit codes on Windows:** ask the agent to run `node -e "process.exit(3)"`: the row says exit 3, not 1.
- [ ] **Custom chat modes:** Agent menu → Create chat mode… → "Reviewer": the file opens; the mode is in the menu and Shift+Tab. In it, ask which tools it has: read and edit tools only. Delete the file and send a message: a notice says it's gone and the message goes in Agent mode.
- [ ] **Codebase index:** `ollama pull nomic-embed-text`, set `agent.codebaseIndex.model` to `ollama/nomic-embed-text` and turn it on: `ide://agent/codebaseIndex` goes indexing → ready. Ask the agent "where is X done?": it uses codebase_search. Add a secret file to `.aiignore`: it's not in the results. Save a file: only that file is embedded again.
- [ ] **Pull request from a chat:** in a repository with a GitHub remote and `gh` signed in, after a change, "…" → Open pull request: the agent commits on a branch and opens the PR; a card in the chat links it, and the menu item now opens it.
- [ ] **Read-only paths:** ask the agent to edit `.vscode/settings.json`: refused, no question. Ask for `.git./hooks/pre-commit`: refused too.
- [ ] **Model picker:** prices on rows (OpenRouter); star two models, then Ctrl+1 / Ctrl+2 in the picker pick them; ↑/↓ in the search box move one row; ↑/↓ on the rail switch tabs.
- [ ] **New presets:** Add a provider → View more lists SambaNova, DeepInfra, Vercel AI Gateway… with logos; Jan shows a letter.
- [ ] **Zip bomb:** attach a zip whose entry claims a small size but inflates to gigabytes: the card lists it, nothing hangs.

Smaller gaps:
- [ ] **Logs:** Developer: Set log level → Git → Trace: the Git channel shows `> git status …` lines, home as `~`. Output filter `init, !status`, Esc clears; wrap toggle. Reload the window: the Git lines aren't listed twice.
- [ ] **Command line:** from PowerShell, `<cli> notes-new.md` (doesn't exist): an unsaved editor named notes-new.md; Ctrl+S writes it there without a dialog. Create the file meanwhile from outside, then save: asked before replacing. `<cli> --diff C:\a.txt C:\b.txt` with no window open: the diff opens.
- [ ] **Makefile targets:** with make installed, a trusted folder whose Makefile makes `run-a` / `run-b` with `$(foreach …$(eval …))`: Run task lists both. Untrusted: only the text's targets.
- [ ] **Terminal:** `echo ~/x.txt` (it exists), Ctrl+click: it opens (also on Windows with `~\x.txt`). `terminal.splitDirection` vertical / horizontal / auto with a split terminal. Automation profile `"env": { "FOO": null }`: a task's `echo $env:FOO` prints nothing.
- [ ] **Notebooks:** edit a cell, close the window, reopen: the notebook is back unsaved, Ctrl+Z goes back to the file. Drag a cell by its gutter; select three and drag one: all three move, one Ctrl+Z undoes it.
- [ ] **Debug console:** two configurations keep their own Up history (also after a restart). A Node config with `"console": "internalConsole"`: `console.log` shows in the debug console; `process.stdout.write("Loading…")` then `" done"` stay one line.
- [ ] **Extensions:** load `tests/fixtures/extensions/tasklist` unpacked: its Tasks view's rows have right-click menus and an inline check button; "Write to the task log" opens the Output tab on Task log.
- [ ] **MCP:** a server sending `serverInfo.icons` shows its icon on the MCP page; the registry search shows icons without waiting long; an optional boolean flag with no value isn't passed.

## m7.7, D228 (Windows)
- [ ] **Run command at once:** open a new PowerShell terminal and ask the agent to run `echo hi` in it right away: the result is `hi` with exit 0, not the integration line.
- [ ] **Task exit code:** a task running `node -e "process.exit(2)"` in PowerShell: Tasks shows exit 2.
- [ ] **UTF-8 redirect:** ask the agent to run `echo hello >> notes.txt` (Windows PowerShell 5.1): notes.txt stays readable text; git shows a one-line diff.
- [ ] **Notebook line endings:** in a new notebook cell type two lines and save: the .ipynb's source has `\n`, not `\r\n`.
- [ ] **External agent mode:** with Review edits on, set Claude Code's own `defaultMode` to bypassPermissions and send a message: it asks before its first edit; if it can't be switched, the message isn't sent and the chat says why.
- [ ] **Read-only short names:** ask the agent to write `GIT~1/hooks/pre-commit`: refused without a question.
- [ ] **Model picker:** open it, press Ctrl+PageDown: its tabs change, not the dock's; close the chat tab with Ctrl+W while it's open: it goes.

## m7.8 (D229)

Install a release build (the jump list belongs to the installed app's taskbar button).

1. **Jump list:** open two folders, pin the IDE to the taskbar, right-click its button: "Recent
   folders" lists both with folder icons, and "New window" is under Tasks. Click a folder that's
   open in a window: that window comes to the front. Click one that isn't: a new window opens on
   it. Remove one from the list (right-click it → Remove from this list), then open File → Open
   recent: it's gone there too. Windows started from the list group under the pinned button.
2. **Windows reopen where they were:** with two folders in two windows, move and size each
   differently, quit, start the IDE: each window comes back at its own place.
3. **Command line:** in PowerShell, `& "<install>\<exe>" --version` prints the version, `--help`
   the options.
4. **Hidden terminal:** run `ls` in a terminal, click × (Hide terminal), press Ctrl+`: the same
   terminal comes back with `ls`'s output, no new one.
5. **Join terminals:** two terminal tabs, right-click one → Join terminals…, pick the other: one
   tab, two panes, both shells still alive.
6. **Suggestions:** in PowerShell type the start of an alias (`gc`): it's listed as an alias and
   the details line shows what it runs. Same in Git Bash with an alias from `.bashrc`.
7. **`.cmd` quoting:** a process task running `x.cmd` (which echoes `%1`) with args
   `["a & echo PWNED", "%PATH%"]` prints both literally, never PWNED on its own line.
8. **Multi-file diff:** change three files, Source control → View all changes: one tab, a diff per
   file, editable; fold one, Open file from its header.
9. **Debugger:** a Node launch with `"console": "internalConsole"` that writes to stdout and
   stderr: both in the Debug console, stderr colored. A C/C++ or Rust session paused: Open
   disassembly, click the margin for an instruction breakpoint, F10 with the view focused steps one
   instruction.
10. **Extension bisect:** Help → Start extension bisect, answer Good / Bad until it names one;
    the IDE offers to disable it.
11. **Notebook cells:** in a Python notebook with a language server, Shift+Alt+F in command mode
    formats the notebook; a quick fix in a cell applies; `x = !ls` isn't underlined.
12. **Extension rename:** with the studio test extension installed
    (`tests/fixtures/extensions/studio`), run "Studio: register the other language providers", put the
    cursor on `studio` in a `providers.txt` and press F2, type `stage`, Enter: every `studio` in
    the file becomes `stage` (the UI script can't show Monaco's rename box in a window without
    the focus).

## m7.9 (D230)

1. **Ctrl+`:** with a terminal open and focused, Ctrl+` hides the bottom region; again, it comes
   back with the same shell; with focus in the editor, Ctrl+` only focuses the terminal.
2. **Agents row:** the Chats sidebar shows faces under the search box. + opens the agent editor:
   pick a template (Test writer), Shuffle the face a few times, pick a color, rename it, Create
   agent. Its face joins the row; a click starts a chat with it (its face in the chat's header and
   on the chat's row). Send something: the face looks around and a ring turns while it works.
   Ask for something needing approval: the face gets a dot and the chat moves under "Needs you".
3. **Editing:** open the agent from Customize → Agents (cards). Change its role and instructions:
   "Saved" appears, the file (Open file) has the change, no save button needed. Delete it.
4. **Model setup:** on the Agents page, apply a preset, change a model: the chip reads
   "<name> · changed" with Update / Revert; never "Unsaved".
5. **AI features:** the sparkle in the status bar lists the five features with on/off; turning
   one on there turns it on in Settings → AI in the editor.

## m7.10 (D231)

1. **Details panel:** widen the chat tab: the panel shows on the right (Environment, Context,
   Changes, Background, Plan). Narrow it: the panel goes; the header's panel button shows it as a
   sheet, Esc closes it. Fold a card, restart: still folded. Send a message: Context fills.
2. **Group chat:** right-click a face in the agents row → Start a group chat with… → pick two.
   Type `@`, pick one, send: that agent answers with its face and name above. Ask one to hand
   over ("ask @Forge to …"): the other answers next. Stop during a round ends it.
3. **Handoffs:** add to an agent file
   `handoffs:` / `  - label: Review it` / `    agent: reviewer` / `    prompt: Review the change`;
   after its reply a "Review it" button continues the chat with the reviewer.
4. **Helper in a worktree** (a git folder): give an agent `isolation: worktree`, ask the main
   agent to hand it a task; approve: a new window opens on `agent/<name>-…`, the parent chat's
   Background card follows it; when it's done the report arrives with Review changes / Merge.

## m7.11 (D232)

1. **Call hierarchy:** in a TypeScript project with typescript-language-server installed, put the
   cursor on a function and press Shift+Alt+H. "Call hierarchy" opens at the bottom with its
   callers. Open a caller's chevron, then click a row: the call site opens. The toolbar switch
   shows outgoing calls.
2. **Type hierarchy:** right-click a class and choose Show type hierarchy. Use a server that
   supports it (rust-analyzer, clangd, jdtls). The switch shows supertypes.
3. **Colors:** in a .css file each swatch shows once; clicking one opens the picker.
4. **Multi-file diff:** open View all changes with two changed files, then change a third in a
   terminal. Within a second it's listed, with folds and scroll kept. Ctrl+Alt+PageDown / PageUp
   move between files.
5. **Test colors:** run a failing Jest or Vitest test. Its output shows red and green, with no
   `[31m`.
6. **Debug prompt:** run a Node program that prints `Name? ` without a newline, with
   `internalConsole`. The prompt shows at once, and a later write continues the same row.
7. **Terminal drag:** open two terminal tabs and drag one onto the middle of the other. They
   become one split tab, with both shells still running. Near the edge, the dock splits instead.
8. **Skill model:** make a skill with `model: <another model>` and ask the agent to use it. A line
   says the skill uses that model for the rest of the turn.
9. **Helper limits:**
   - In Ask mode (or with an agent limited to reading), ask for an isolated helper: it's refused.
   - With a "Can edit files" agent delegating `isolated`, the helper's window can't run commands.
10. **Group member removed:** in a group chat with an agent, delete that agent's file, then mention
    it. A line says it isn't available, and another member answers.
11. **Message during a round:** while a member answers, send "@Other please check X". It waits,
    then Other answers it.
12. **External agent in a group:** pick Claude Code (or Codex) as the model of a group chat and
    mention a member. Its reply shows that member's face, and an `@Name` in it hands the turn
    over.
13. **Extension providers:** load `tests/fixtures/extensions/studio` unpacked and run "Studio:
    register the other language providers". Then:
    - Ctrl+. on `todo` resolves its edit only when you pick it.
    - F2 on `studio` opens the rename box prefilled.
    - F2 between `#` and a space says "Studio renames words only.".

## m7.12 (D233)

1. **Terminal reload:** start `ping -t 127.0.0.1` in one terminal, type `echo hi` in a second, and hide a third. Run Developer: Reload window.
   - The same processes keep running. `ide://terminals` shows `reattached: true`.
   - The hidden terminal is still under Hidden terminals.
   - Quit and reopen: you get new shells under dim output, and the hidden one comes back hidden.
2. **Quoted cmd task:** a shell task with `cmd.exe` as its shell and `echo "two words"` prints `"two words"`. Kill the IDE in Task Manager: its shells and language servers end too.
3. **Embedded site** (Windows): turn `browser.embedSites` on and open `https://example.com`.
   - The site shows in the tab and follows sashes, resizing and maximize.
   - Menus and dialogs hide it.
   - Moving the tab to another window and back keeps it.
   - With the setting off, check that drag-and-drop from Explorer, window resize and `workbench.screenshot` still work.
4. **Downloads:** download a file from a preview. The status shows `↓ n%`, and the Downloads tab opens, reveals and cancels it.
5. **Graph:**
   - Expand a commit with hundreds of files: it opens in about 0.1 s.
   - Right-click the Graph header → Move to the dock. Drag the tab back to the sidebar.
6. **Coverage:** run pytest-cov with coverage. The floating toolbar shows the %, "All tests ▾" picks one test, and Covered by lists tests.
7. **Ghost text:** with a suggestion showing, type something different, press Esc, then Backspace back: the suggestion returns with no new request. Try the same with Ctrl+Backspace, and with Tab followed by Ctrl+Z.
8. **Hierarchy:** right-click a row → Show call hierarchy of this item. Edit the file: "Results may be outdated" appears. Click Refresh.
9. **Notebook:** Format notebook, then press Z once: every cell comes back.
10. **Agents:**
    - In a chat with the main agent, type `@`: the list shows your agents ("joins the chat").
    - Send `@Rev what do you think?`: Rev joins and answers.
    - Ask the main agent to bring Forge in: it calls `agent.inviteAgent`.
    - A new agent is saved under "Every project".
    - The Builder template is first.
11. **Details panel:** folding a card is instant even in a long chat, and there's no border beside it.
12. **Maximized group:** maximize the chat group and open a file. It opens in the maximized group. Ctrl+Tab or the terminal key to a tab in another group restores the layout.
13. **Empty window:** Close folder, Ctrl+N, type, close the window, restart: the untitled text is back.
14. **Command line:** `<cli> C:\tmp\newdir\sub\a.txt` creates the folders on save. Plain `<cli>` in PowerShell returns at once.
15. **Extension providers:** load `tests/fixtures/extensions/providers` and run "Providers: register everything". Check `memfs:/hello.txt`, the Echo terminal, the `memo: greet` task, the Memo changes section, "Memo: Launch" and sign-in (see D233).
16. **macOS / Linux** (on those machines): the Dock menu, the `/usr/local/bin` link, and the `.deb` launcher's New window action.

## m7.13 (D234)

1. **Group chat:** in a group chat with Rev, send `@Rev what do you think?`.
   - While Rev works, Rev's face in the chats bar is busy and the main agent's is not.
   - Rev's reply has no "[Agent]" in it.
2. **Main agent:** on Customize › Agents, type a name in the Main agent card and press Enter.
   Click its face and pick another one.
   - The chats bar, the chat header and group chats use the new name and face.
   - `@<new name>` in a group chat reaches it.
   - An empty name goes back to "Agent".
3. **Tabs:** open a group chat, a chat with Rev and a chat with the main agent. Each tab shows its
   agents' faces, and a working chat's face moves.
4. **Extension file systems:** load `tests/fixtures/extensions/providers` unpacked and grant it,
   then run "Providers: register everything" and open `memfs:/hello.txt`.
   - "Providers: change hello.txt elsewhere" reloads it, or shows "changed on disk" if you've
     edited it.
   - The Explorer's "Memory files" section has New file / New folder, and rows have Rename and
     Delete (Delete asks).
   - Restart with the tab open: it loads once the extension is up.
5. **Accounts:** run "Providers: sign in". The Accounts menu lists the account, with Sign out.
6. **API extras:** load `tests/fixtures/extensions/apiextras`, grant it, run "API extras: register
   everything", create `sample.extras` with `tests/fixtures/setup/extensions-m7-13.cjs` and open it.
   - Lines 1–3 fold, line 4 is a link and line 6 has a color swatch.
   - "Decorate TODO lines" draws italic lines with "← to do", a ruler mark and a gutter bar, in
     both themes.
   - Typing `gree` on line 10 shows ghost text.
   - Ctrl+T finds "extrasSymbol".

## m7.14 (D235)

1. **A member on its own model:** choose Codex (or another external agent) as the chat model. On
   Customize › Agents, set Rev's model to one of the IDE's models (OpenRouter, Ollama). In a group
   chat with the main agent and Rev, send `@Rev what do you think?`.
   - Rev's reply footer names Rev's model, not Codex.
   - Then send `@Agent do you agree with Rev?`: the main agent knows what Rev said.
2. **Faces after adding an agent:** with a group chat open, add a new agent on the Agents page.
   The chat's header and tab keep each member's own face.
3. **New chat ▾:** click the ▾ beside + in the Chats view's header. Your agents are listed with
   their faces; pick one and a chat with it opens. In a group chat, the header's ▾ has "Group chat
   with …", which opens a new chat with the same agents. Move the Chats view to the dock: the ▾
   still opens the menu.

## m7.15 (D237, D238): channels, direct messages and threads

1. **Sidebar:** the agent's view shows Inbox, Channels (`#general`), Tasks and Direct messages:
   the main agent (the IDE's name), Builder, Reviewer and Tester, with faces. The rows line up
   with the search box.
2. **Talk in a channel:** click `#general`; its conversation opens in the middle. Type
   `@Builder add a hello function`: Builder answers there, in the channel.
3. **A direct message:** click Reviewer and ask something. Type `@Tester what do you think?`:
   Tester joins the conversation.
4. **Reply in thread:** hover a message in `#general`, click Reply in thread. The thread opens
   on the right with that message on top; ask something there. The message in `#general` shows
   "1 reply"; click it to come back to the thread.
5. **Unread:** while an agent answers in `#general`, open another channel. `#general` turns bold
   until you open it again.
6. **Memory:** right-click `#general`, Channel memory…, Add a note `We use tabs`. Ask the
   channel how it indents: the agent knows.
7. **Tasks:** + beside Tasks, `Add a dark mode toggle`. A `#task-…` channel opens with the task
   as its first message and the team working. Right-click it, Close task: it leaves the list.
8. **Inbox:** the Inbox lists what needs you and what's working; the board button shows columns.
9. **One tab each:** opening another channel replaces the middle tab; another thread replaces the
   right one. Ctrl+click opens a tab of its own.

## m7.15 (D239): start free with OpenCode

1. With no provider set up (or Ollama off), open a new chat: under Set up AI models there's
   **Start free with OpenCode**.
2. Click it: a terminal runs `npm install -g @opencode/cli` (only if OpenCode 2 is missing), then the
   chat uses OpenCode. Ask something: a free model answers with no key.
3. The AI models page lists OpenCode under "Use an agent you already have", once (not again under
   View more agents). Its Sign in runs `opencode2 auth login`.

## m7.15 (D240–D243): greeting, the team's files, models per agent, messages mid-turn

1. **Greeting:** a new chat shows one line ("What are we building today?"); signed in to the IDE
   account, some lines use your first name. With no model, the setup buttons sit under it.
2. **Empty chats follow the main agent:** with Builder's direct messages opened but empty, click
   Start free with OpenCode in Jonna's chat; Builder's chat now shows OpenCode too.
3. **The team are your files:** your agents folder has `builder.md`, `reviewer.md`, `tester.md`.
   Delete Tester on the Agents page and restart: it stays gone. Open the editor: **Agents ›
   Builder** at the top goes back to the Agents page.
4. **An agent's own model:** set Builder to an IDE model (OpenRouter) and the chat to Claude Code.
   In Builder's direct messages the pill shows Builder's model and the reply's footer names it.
   Pick another model there: the Agents page shows it for Builder.
5. **Group models:** in `#general` the pill says Models: each agent with its model; pick one.
6. **Open to the side:** right-click `#general` → Open to the side: it opens in a new group
   beside the chats.
7. **Messages mid-turn:** in `#general`, ask `@Builder look around the repo`; while it works, send
   `stop, just say hi`. Builder reads it at its next step and stops. Send `@Reviewer check this`
   while Builder works: the note says Reviewer answers when this turn ends.
8. **Start free without Node.js** (a machine without it): the card says to install Node.js and
   opens its download page instead of running npm.

## m7.18 (D251): several folders in one window
Two folders, each a git repository: `web` and `api` (give `api` a `.vscode/settings.json` with
`"editor.tabSize": 7`, a `.vscode/tasks.json` with a task "build", a `.vscode/launch.json`).
1. Open `web`, open two files, **File → Add folder to workspace…** → `api`. The window becomes
   "Untitled (Workspace)" without reloading; both tabs stay; the explorer shows **web** and **api**
   as top rows.
2. Ctrl+P finds `api` files as "api/…"; Ctrl+Shift+F finds text in both, grouped by folder; the
   include box takes `api/**`; right-click `api/src` → Find in folder searches only there.
3. Open an `api` file: its tab size is 7 (its folder's settings), a `web` file's isn't;
   breadcrumbs start with "api". Settings editor → Folder tab → api shows the 7.
4. Source control lists both repositories ("api" labelled). Run task… lists "build (api)"; its
   `${workspaceFolder}` is `api`. F5 lists "Launch (api)".
5. Terminal ▾ → New terminal in folder… → api starts there.
6. Ask the agent to read a file in `api` and to list the workspace: it can; put a `.aiignore` in
   `api` hiding `secret.txt`: the agent can't read it. Add hooks in `api/.claude/settings.json`:
   the agent asks before they run.
7. **File → Save workspace as…** → `both.code-workspace` beside them: the title says
   "both (Workspace)"; the file lists `web` and `api` relatively. Close the window, reopen from
   **Open recent** ("both (Workspace)"): both folders, the same tabs.
8. Right-click **api** → Rename in workspace… "Backend": the row, the paths ("Backend/…") and the
   file's `name` follow. Remove folder from workspace: its tabs close (an unsaved one asks), its
   repository and tasks go; the folder is still on disk.
9. Remove **web** (the first folder) with `api` back in: the workspace reopens on `api`.
10. Trust: add an untrusted folder to a trusted workspace: tasks ask for trust again.
11. Move `api` away and reopen the workspace: it opens with `web` and lists `api` as missing
    (`ide://workspace` `missing`); Remove folder takes it out of the file.
12. `<cli> both.code-workspace` opens it; `<cli> --add C:\other` adds `other` to the last window.
13. VS Code opens `both.code-workspace` with the same folders and settings.

## m7.17 (D249): agents and modes, an agent on an external agent, the Channels view
1. In a chat, click the first pill under the box: **Agent** lists the main agent and yours with
   faces, **Mode** lists Agent, Plan and Ask. Pick Builder, then Plan: the pill reads
   "Builder · Plan" and Shift+Tab goes on to Ask, then Agent.
2. Ask Builder in Plan mode for a change: it plans without editing; **Build** carries it out as
   Builder. Pick Planner (it starts in Plan): its plan's **Build** hands it to Builder.
3. Pick Chat: it starts in Ask. Open Chat's page on the Agents page: **Starts in** shows Ask;
   pick Agent and open a new chat with it.
4. Set Chat's model to Claude Code (or another external agent you have) on its card: the list
   has them. Message Chat in a chat on an OpenRouter model: Claude Code answers as Chat.
5. Channels view: no "+ Add channel", "+ New task channel" or "+ Add agent" rows, no bell, nothing
   under Recent; the ⋯ beside the clock lists Agents, Usage and the rest.
6. Agents page: Planner's card beside the "New agent" card is as tall as the others.

## m7.16 (D246): helpers without a window (headless)

1. **A helper here:** in a git folder, ask the agent to delegate a task to General with
   isolated (or to an agent with `isolation: worktree`), and approve. No window opens; a toast
   says it works in this window, with **Open its chat**. The chat shows "Started in
   `<repo>.agent-…`"; its file edits, searches and commands land in that folder, not yours
   (`git status` in your folder stays clean). Its `run_command` sees its own `PORT`.
2. **Report and merge:** when it's done the parent chat gets its report; the toast's Review
   changes opens the compare page and Merge brings its changes in (staged).
3. **Stop and questions:** while it works, stop it from the chat's details (Background card):
   its chat stops at once and the line says it was stopped. With Ask before commands, its
   command question makes a toast "waiting for you in its chat" whose Open its chat shows it.
4. **IDE commands refused:** a helper asking `call_command git.commit` gets an error naming its
   worktree; it commits with run_command instead.
5. **Window mode:** Settings → Agent → Helpers in windows of their own: a new helper opens a
   window as before.
6. **Restart while one works:** quit the IDE mid-task and start again: the helper ends as
   stopped and its report (what it had) arrives; continuing its chat still works in its
   worktree.

## m7.16 (D245): the team, @all, follow-ups, agents from a description, Recent
1. **Team:** a fresh profile's #general has the main agent, Planner, Builder and Chat. On a
   profile that had Reviewer and Tester, they stay, and Planner and Chat are added once (to
   #general too if you never changed its members).
2. **Members menu:** the "4 agents" pill's menu shows each agent's face.
3. **@all:** in #general, "@all what would you change in this file?": the first answers with its
   tools, "… are answering too…" shows, and the others' answers appear after it (each with its
   face). Stop stops them too. Settings → Agent → "mentioned agents answer together", then
   "@Planner @Chat …": both answer, not one after another.
4. **Follow-up:** ask the agent to delegate a long task in the background; on the subagent's row in
   the chat's details press the speech-bubble button, type a correction: its report reflects it.
5. **Agent file keys:** an agent with `tools: Read, mcp__<server>` and `disallowedTools:
   mcp__<server>__<tool>` gets that server's tools but that one; `permissionMode: acceptEdits`
   keeps its edits without the review bar.
6. **Describe it…:** Agents → New agent → Describe it…, "reviews SQL migrations for locks": the
   form fills (name, role, description, instructions, Read only); Create agent works.
7. **Recent:** the Channels sidebar lists conversations by time with their age; with another
   folder's chats, they follow this folder's; with no folder open, all by time. One from another
   folder shows "Started in …" with Open / Continue here.
8. **Focus:** click into the Search, Channels and Extensions fields and a settings field: an accent
   border, no thick ring; Tab to a button: the ring shows.

## m7.18 (D252, the app side): remote development over SSH
Needs a Linux machine (x86_64 or arm64) reachable with `ssh` from a terminal, and a build with
the servers bundled (`node scripts/build-server.mjs` before building). `remote-wsl-m7-18.jsonc`
covers the same flow with WSL's Ubuntu; these steps are what only a real SSH host shows.
1. **Key sign-in, first time:** a host in `~/.ssh/config` with a key in the agent. Remote →
   Connect to host…: the picker lists the config's hosts (no `*` patterns) with user, hostname
   and port. Pick it: the status item shows "SSH: host · Connecting…", then "Installing the server
   (2.7 MB)…" once, then the new window opens the folder picker's home. On the host,
   `ls ~/<serverDataFolderName>` (product.json) shows `<version>-<12 hex>/ide-server`.
2. **Second time:** connect again (another window): no "Installing", it starts at once.
3. **Password sign-in:** a host with `PasswordAuthentication yes` and no key: the quick input asks
   "me@host's password" masked; a wrong one asks again (ssh asks 3 times), Escape fails the
   connect with ssh's "Permission denied" in the message. Remote → Show the remote connection's
   log: ssh's lines are there, the password isn't.
4. **Passphrase:** a key with a passphrase, not in the agent: the quick input asks for it, masked.
5. **New host key:** remove the host from `~/.ssh/known_hosts` (or use a new one): a pick
   "Trust this host and connect" / "Don't connect" with the key's fingerprint. Trust: it connects
   and `known_hosts` has it; Don't connect: the connect fails with "Host key verification failed".
6. **Ports in the authority:** `remote.connect { host: "me@1.2.3.4:2222" }` connects on port 2222
   (`-p 2222`). `remote.connect { host: "-oProxyCommand=calc" }` is refused before ssh runs.
7. **Work there:** open a folder with a git repository. The explorer lists it (ignored files
   dimmed); open, edit and save a file (`cat` it on the host); create, rename, move, copy and
   delete in the explorer (delete undoes with Ctrl+Z: the item comes back from
   `~/<serverDataFolderName>/trash`); quick open (Ctrl+P) finds files; search finds text and Replace all
   changes it; edit a file on the host (`echo x >> f`): the open editor reloads, the explorer
   shows a new file; Source control shows changes, stage, commit, push (git's own credential
   helper on the host; no IDE prompt); a commit made in a terminal there updates the view within
   ~2 s.
8. **Terminal:** a new terminal is the remote's login shell in the folder ("ssh · host"); `vim`
   draws, resizing the panel resizes it (`stty size`), Ctrl+C stops `sleep 100`, `exit` ends it.
9. **Tasks and the agent:** a tasks.json task runs there; the agent's run_command runs there
   (`uname -a` says Linux); a language server the project configures (e.g. a Python one installed
   on the host) starts there and gives completions.
10. **Ports:** `python3 -m http.server 8000` in the terminal; Remote → Forward a port… lists 8000
    with "python3"; forward it; open http://localhost:8000 in the browser: the listing shows. Stop
    forwarding: the page no longer loads.
11. **Connection lost:** on the host, `pkill -f ide-server` (or take the network down): within
    ~15–60 s the status item says "disconnected" and a notification offers Reconnect; Reconnect
    connects again and reopens the folder.
12. **Reload and restore:** Developer: Reload window in a remote window: it connects again without
    asking (the connection stays). Quit with a remote window open, start again: the window comes
    back on `ssh://host/path` (window.restoreWindows) and connects.
13. **Command line:** `<cli> --remote ssh:host /home/me/app` (and `<cli> ssh://host/home/me/app`)
    opens a remote window on that folder.
14. **Windows ssh:** with only Git for Windows' ssh on PATH (no `C:\Windows\System32\OpenSSH`),
    password prompts still reach the IDE; the log says which ssh ran.

## m7.19 (D253): calls together, schedules, wake-ups, images and PDFs, channel fixes

1. With a real model, ask "read package.json, README.md and tsconfig.json and tell me the
   scripts": the three reads appear in one step, running together; the answer uses all three.
2. Ask "look into how X works and how Y works, in parallel": two delegate rows run at once, each
   report comes back; Stop during it stops both.
3. "Remind me in 2 minutes to check the build": no question asked; the chat's details list it
   under Background (Run now, Cancel); two minutes later a quiet line with a clock appears and the
   agent answers. "Every weekday at 9am, sum up yesterday's commits": the agent asks first; it
   shows in **…** → Scheduled messages in the Channels view.
4. "Run the tests in the background and tell me when they finish": the agent goes on; when they
   end a terminal line appears with how they ended, and the agent reacts.
5. Put a screenshot (PNG) and a PDF in the folder; ask about each: a vision model describes the
   picture; the PDF's text comes back with page markers.
6. Customize → MCP servers: the built-in row counts about 30 tools and about 500 IDE commands (not 12 and 409 as before); its
   page says how many are usable right now.
7. A group chat: hand from one agent to another, then make the second one's request fail (stop
   the model's server): Continue goes to the second agent, not the first.
8. A thread's quoted message at the top: click it: the channel opens on that message, lit for a
   moment. Leave a chat with a replies row open for a few minutes: "2 min ago" moves on.
9. A fresh profile (no saved chats): an empty chat never greets with "Welcome back".

## m7.20 (D254): terminal speed, the store, the agent when you're away, focus

1. In a terminal (Git Bash or PowerShell), run a command that prints 200,000 lines (for example
   `node -e "for(let i=0;i<2e5;i++)console.log('line '+i)"`): it ends in a few seconds and the
   terminal shows the last lines at once; Ctrl+Up goes back to where its output starts.
2. Extensions view: type "dracula": after a moment an Open VSX section lists it with downloads and
   a rating; Install asks for its permissions and installs it; the color theme picker offers it.
   `@category:Themes` lists the most used themes. ⋯ → Update extensions from the store says
   there's nothing newer.
3. Start a long agent turn and switch to another app: when it finishes the taskbar button
   flashes and a notification with Show waits in the IDE. The same when it asks a question.
4. Builder's direct messages and #general: ask Builder something in both quickly: the second
   says it waits for Builder, and starts when the first ends.
5. Tab into the explorer before clicking anything in it: the list shows a focus ring.
6. A folder without git: Source control shows the "No repository" page whole, without a Graph
   section; after Initialize repository the Graph appears. The Welcome page doesn't list the
   folder that's open under Recent projects.
7. A small window (about 860×560): the chat's bottom row keeps "Agent" and the access mode whole.

## D255: VS Code extension API phase 1

1. Ask the agent "add a status bar item that shows the word count": it loads the build-extension
   skill, creates the extension, validates it, tries its command and only then says it works.
   Customize → Skills lists build-extension as built in; Customize copies it to your skills folder.
2. An extension with `"host": "node"` and the `node` permission (tests/fixtures/extensions/nodehost):
   load it unpacked in a trusted folder and allow it; Node host: what it runs on returns Node's
   version; its log shows "node host started". Without Node on PATH it says to install Node.js.
3. Open a link like `<scheme>://acme.hello/x` from Windows' Run box (an installed build): the IDE
   comes to the front and the extension's URI handler gets it.
4. An extension with a coverage profile: Run with coverage on its row shows coverage in the gutter
   and the coverage view.

## D256: VS Code extensions' code (the `vscode` shim)

1. Load `tests/fixtures/extensions/vscodehello` unpacked in a trusted folder: it shows as
   "VS Code hello" (from package.nls.json) without asking anything until you allow it; allow
   it. The palette has "Hello: Show what it sees"; running it shows its result in the log and
   puts a warning on README.md's first line ("Hello from VS Code's API").
2. Install a theme from the store that also has code (Material Icon Theme): its icons work
   right away; the dialog says its code runs in Node with full access. Cancel: the icons stay.
3. Install a small VS Code extension with commands from Open VSX (e.g. "Change Case"), allow it,
   select a word and run one of its commands from the palette: the text changes. Its log lists
   any VS Code API it called that isn't there yet; `ide://ext/<id>/vscode` lists them too.
4. A VS Code extension with a tree view in the Explorer: its view shows as an Explorer section.

## D257: the rest of VS Code's API, and the store's pages

1. Extensions view, type `prettier`: real icons on the Open VSX rows. Click a row (not Install):
   a page like VS Code's (icon, verified publisher, downloads, stars, Install; Details with the
   README and a side panel, Features, Changelog). Narrow it: the side panel goes under the README.
2. A folder with `.vscode/extensions.json` (`{ "recommendations": ["golang.Go"] }`) and some `.py`
   files: a Recommended section under Installed (Go first, then Python); × hides one.
3. Load `tests/fixtures/extensions/vscodehello` unpacked and allow it: a "Hello" activity bar
   icon shows its webview view (a page its code wrote); "Open a .hello file" opens
   greeting.hello in its custom editor; Run task lists "hello: say hi"; Testing shows "Hello
   tests" (run: one passes, one fails); Source control has a "Hello changes" section.
4. Install a VS Code extension with settings (e.g. GitLens): Settings has one page for it, its
   configuration titles as sections.

## D258: the last of VS Code's API, extension actions, the Extensions view's sections, themes

1. Extensions view: the search box stays while Installed scrolls; with nothing typed,
   Recommended is a section below (collapse it, drag its edge); type `theme`: Open VSX's
   results are a section of their own with its own scrollbar.
2. Night Owl (or any VS Code theme): its ⚙ menu and page have Set color theme, Disable ▾ (Disable
   (workspace)), Uninstall ▾ (Install specific version…), Auto update, Copy link, Download VSIX….
   Set color theme: the menus, tooltips and scrollbars take the theme's colors. Its page's README
   shows its images (badges, screenshots).
3. `tests/fixtures/extensions/vscodehello`: an "H" badge on README.md in the Explorer; its "Hello
   tree" section has its own icons and "Reveal a row of its tree" selects a/1; the agent can call
   its Echo tool; Disable (workspace) turns it off in this folder only.
4. A VS Code extension with an editable custom editor (e.g. a hex editor): an edit puts the dot on
   the tab, Ctrl+S saves, Ctrl+Z undoes; closing with changes asks first.

## D259: installing asks first

1. Install a VS Code extension with code from Open VSX (e.g. "Change Case"): the dialog says what
   it asks for before anything is installed. Cancel: it doesn't appear under Installed.
2. Install it again and choose "Install without its code": it's installed, its page offers
   "Allow its code…". Install another and choose "Allow and install": it runs.
3. A theme without code (Dracula) installs with no dialog.

## D260: Claude Code for VS Code

1. Extensions view: search `claude code`, install Anthropic's Claude Code (allow its code). One
   activity bar icon, Claude's logo (drawn in the icon color); it shows its sessions / sign-in.
2. Open ▾ on its page: Claude Code opens as a tab on the right, beside the agent, with the logo
   on the tab. No "Claude Code couldn't find the Windows build" message (the win32-x64 build was
   installed). Both pages use the theme's colors; switch to a light theme: they follow, never a
   white sheet.
3. The Explorer has no `_claude_…` sections.

## D261: extension audit fixes

1. A VS Code extension running in Node (ESLint, Python, Claude Code): open an untrusted folder
   in the same window (or Manage workspace trust → restricted): its code stops (its log says
   so on next use); trusting the folder again and using it starts it, after asking.
2. Install a VS Code extension that doesn't bundle its dependencies (it ships `node_modules`):
   it activates (no "Cannot find module").
3. Uninstall or update a running Node extension on Windows: no "in use" error.
4. Close Node.js out of PATH, start the IDE, install Node, then run the extension's command:
   it starts without restarting the IDE.
5. A task an extension provides with spaces in its program path runs in PowerShell; one with
   `a && b` runs in Windows PowerShell 5.1.
6. In a small window (640×480) in the light theme: the Extensions view, an extension's page and
   a VS Code extension's webview view hold up (no overflow, no white or black sheet).

## D262: title buttons, recently used commands, the quick access field

1. A VS Code extension whose command has an icon file in `editor/title` (Claude Code's Open):
   open a file: its button on the title bar shows that icon, in the icon color.
2. Ctrl+Shift+P, run "Preferences: Color theme", Esc. Ctrl+Shift+P and type `t`: it's first,
   "recently used"; after a restart too. The field has the box's background.
3. An extension with two views of one name both offered: Open ▾ says where each opens; with
   one, the button reads "Open <name>".

## D264: what VS Code extensions add to the terminal, and the audit's leftovers

1. Claude Code for VS Code installed: open a new terminal and run `echo $CLAUDE_CODE_SSE_PORT`
   (PowerShell: `$env:CLAUDE_CODE_SSE_PORT`): a port; `claude` started there finds the IDE. Its
   log no longer says `environmentVariableCollection isn't supported`.
2. `tests/fixtures/extensions/vscodehello` loaded: the terminal's ＋ ▾ lists "Hello shell", which
   opens a terminal of that name; `echo HELLO-42` in a new terminal, Ctrl+click it, then run
   "Hello: last followed terminal link": "ticket 42".
3. Windows: an extension whose Node process crashes (Task Manager → end node.exe) leaves nothing
   it started running (its language server, its CLI).
4. `git init` a subfolder in the terminal: Source control lists it within a few seconds.

## D265: extensions using each other, the notebook editor API, update notices, webview hosts

1. `tests/fixtures/extensions/vscodeapi` and `vscodehello` loaded (the API one first), both
   allowed: run "Hello: use another extension's API": found, version 2.0, sum 5, a greeting,
   counter 11, 12, events 1, 2 (none after it disposed its listener).
2. A notebook open and active: run "Hello: edit the active notebook": a "# From VS Code's API"
   Markdown cell appears at the top, and the notebook's metadata has `hello` (Notebook: Read
   notebook with metadata).
3. A VS Code extension installed from Open VSX in an older version (Install specific version…),
   Auto update off: restart, wait a minute: a notice offers Update / Show, and the Extensions icon
   shows 1. Update clears both. `extensions.autoCheckUpdates` off: no notice.
4. Without Node.js on PATH, installing an extension with code: the question says Node.js wasn't
   found.
5. An extension page that sets a cookie (`document.cookie`) and a dev server preview on another
   port: the preview doesn't get the extension's cookie (the page is on `localhost`, the preview
   on `127.0.0.1`: Toggle developer tools on the frame shows its address).

## D266: dev containers

With Docker Desktop running:
1. Open a folder with `.devcontainer/devcontainer.json` (`{ "image":
   "mcr.microsoft.com/devcontainers/base:ubuntu", "postCreateCommand": "echo hi > /tmp/created" }`):
   a notice offers Reopen in container. Reopen: the status bar shows the steps (Show the dev
   containers log has docker's output), then "Dev container: …"; the explorer shows the folder
   under `/workspaces/<name>`, a terminal is a shell in the container (`cat /tmp/created`: hi),
   git, search and tasks work there.
2. Remote menu → Reopen folder locally: the local folder again. Reopen in container: the same
   container, quickly (no new one in `docker ps -a`).
3. Change the configuration (add `"containerEnv": { "X": "1" }`), Rebuild container: a new
   container, `echo $X` prints 1.
4. A `"build": { "dockerfile": "Dockerfile" }` configuration builds its image first.
5. `docker run -d --name scratch ubuntu sleep infinity`, then Attach to running container…:
   scratch is listed; pick a folder there.
6. With `"features"` and no devcontainers CLI: the error says to install it
   (`npm install -g @devcontainers/cli`); with it installed, the feature is in the container.

## D267: the last of VS Code extensions

1. An extension installed from Open VSX whose newest version is a few hours old: Check for
   extension updates offers the version before it (or nothing); with
   `extensions.updateDelayHours` 0, the newest.
2. Without Node.js on PATH (rename it for the test), a VS Code extension with code starting: the
   question offers to download Node.js; Download shows its progress in the status bar, then the
   extension starts. Not now: the extension fails saying how to install Node, and isn't asked
   again until a restart. Extensions: Download Node.js for extensions works on its own.
3. `tests/fixtures/extensions/vscodehello` loaded: "Hello: open an untitled notebook" opens
   Untitled-1.ipynb with one cell and its output ("answer 42"). Ctrl+S asks where to save it; the
   tab then shows the file's name. Closing an unsaved one asks; Save then Cancel in the dialog
   keeps it open.
4. Notebook: New untitled notebook (command palette): an empty untitled notebook.
5. A product icon theme from Open VSX (e.g. Fluent Icons): Preferences: Product icon theme…
   picks it; the activity bar, tab and view actions change; Default brings the IDE's icons back.
   A file icon theme drawn with a font (Seti) shows its glyphs too (fonts load as data: URLs).

## D268: Graph badges, the folder card, extensions in an empty window

1. Source control → Graph on a repository with a branch, a tag and a remote branch: every badge
   is a filled pill (blue, yellow, purple), also icon-only in a narrow side bar.
2. Close the folder, send the agent a message: the "Where should this project live?" card has
   Name and Location with their labels above, a grey folder icon, and the folder it will make
   under the location.
3. Claude Code for VS Code installed, no folder open (restart with no folder): its activity bar
   icon is there and its chat works. Open a folder you haven't trusted: it stops until you trust
   the folder, then starts again when used.

## D269: the layout stays, Claude Dark

1. Claude Code for VS Code installed, restart with no folder: the side bar stays on Channels and
   the right region on the agent's New session, with Claude Code's tab beside it (not active);
   Claude Code's icon is in the activity bar. Its side bar page has one background color, header
   and body alike.
4. Restart with Claude Dark picked: a code file shows its colors at once (not Dark+).
5. A chat on Claude Code (ACP) right after a start: the model pill says the model at once.
2. Color theme… → Claude Dark: near-black gray surfaces like the Claude app, clay orange
   accent (buttons, focus), and code colored as the Claude app's viewer colors it (purple
   keywords, blue functions, orange types and parameters, green strings, cyan numbers).
3. Help menu: no Toggle full screen.
6. Command palette: `>t`, `>th` … `>theme`: Preferences: Color theme… is first; `>icon`: File
   icon theme before commands that only have the letters scattered.

## D270: agents show their model's logo, Delete in the side bar, Customize's breadcrumb

1. Channels side bar, Direct messages: Planner, Builder and Chat show the logo of the model they
   use (the default model's, or the one picked for them); the main agent keeps its face.
2. Edit Builder → Model icon / Character: Character shows the face, and the side bar, the chat's
   header and its replies' headers change at once; Model icon brings the logo back. Pick
   Codex (or another external agent) as Builder's model: the logo becomes Codex's everywhere.
3. Change the default model (a different provider): agents on the default follow.
4. Agents page → the main agent's face → Model icon: it shows the logo; Character goes back.
5. Right-click a Recent chat → Delete: asks, then the chat is gone. Right-click a channel →
   Delete channel: asks, then the channel and its conversations are gone.
6. Customize: "Agent settings › Customize" at the top; Agent settings opens Settings at Agent.
   Providers, Rules and Auto-approve have no Agent settings button.

## D271: memory, Claude Dark by default, a held Escape, closing the folder

1. Tell the agent "don't commit without asking me": it asks to save that to your memory at once;
   a new chat follows it. Say "actually, commit small fixes yourself": it replaces the note
   rather than adding a second one (Agent memory → the user's notes).
2. A new profile starts in Claude Dark.
3. In a Git Bash terminal press Escape, then ask the agent to run `cd . && echo ok`: it prints
   ok (not "d: command not found").
4. With Claude Code for VS Code running, File → Close folder: it keeps running (not Failed), and
   its icon stays in the activity bar.
5. New chats on Claude Code (Chat model `acp/…`): Planner (Same as the chat) shows Claude Code's
   logo, not Ollama's; the agent editor's big logo has no circle behind it.

## D272: Jonna, Plato and Gabby; Reset to defaults

1. A new profile: Direct messages lists Jonna (Agent), Gabby (Ask) and Plato (Plan), each with
   the logo of the model it uses; #general has the three.
2. Agents page → Your agents → Reset to defaults: it warns that your agents go to the trash and
   the defaults' changes are lost; Reset: only Plato and Gabby remain, as first written.

## D273: Auto applies edits; a new project keeps its extensions; each agent's effort and access

1. With Review edits, ask the agent to change a file: the bar above the message box ("1 file
   changed · Review · Reject all · Accept all") has rounded top corners.
2. Pick Auto, then open a folder you haven't used: a new chat's edits apply at once (no Accept /
   Reject), and the pill says Auto.
3. With Claude Code for VS Code installed and no folder open, send a message and pick Create
   and start: no trust question, and Claude Code's icon stays in the activity bar.
4. Open a folder you haven't decided about, then trust it (Manage workspace trust): Claude
   Code's icon comes back without using it.
5. In a group chat the pills read Effort and Access: each lists the chat's agents; set Plato to
   High and Accept edits, and the list shows it; Its default / Same as the chat put it back.
6. Leave an agent edit under review, close the folder (or quit), open it again: the edit's
   inline Accept / Reject and the review bar are back, even with the chat's tab closed.
7. Open a folder in a second window and close it there; click back into the first window: its
   welcome page lists the folder under Recent.
8. Claude Dark: hovering an activity bar icon is dimmer than the active one.
9. Scroll up in a chat while the agent works: Jump to latest shows pulsing dots.
10. With git changes in a file, the minimap's left edge shows green / blue / red marks; an agent
    edit under review shows an accent mark on the scrollbar and minimap.

## D274: Claude Dark's dimmed text; @mentions; @channel

1. Claude Dark: the message box's placeholder, the side bar's role tags (Agent, Ask, Plan) and
   Recent's times are dimmer than the text beside them.
2. In a group chat, send "@Plato what do you think, @channel?": both stand out in your message
   (@channel in a warm tint); hovering @Plato names it and its role. An agent's "@Jonna, please…"
   handoff is colored the same; `@Jonna` in a code span isn't.
3. Type "@" in #general: the list offers @channel; in a group chat that isn't a channel it offers
   @everyone ("@ch" still offers @channel).

## D275: a quicker settings page; the side bar's color; Reset all

1. Open Settings (All settings): it shows at once; scroll to the end, rows keep coming; type in
   its search and open a dropdown: no stall.
2. Quick access (Ctrl+P), then click the status bar or an editor's margin: it closes.
3. Appearance → Floating panels: the side bar has the panels' color and border, like the
   editors. "Distinct side bar color" gives it the theme's side bar color, in flush too.
4. Change a setting and an agent setting (the agent's model), then Reset all: the dialog offers
   "Also reset the agent's settings"; unchecked, the agent's model stays.
5. Chats side bar: names are bright, icons dim until hovered; Channels, Tasks… highlight on
   hover like a chat.
6. In a group chat with an agent from before agent files had details, "@Builder" (any case) is
   colored.
7. With Claude Code installed, File → Close folder: its activity bar icon stays.

## D276: a second accent

1. Claude Dark: select a file in the explorer: a blue tint and outline (buttons and fields stay
   clay). Hover the line between the side bar and the editor: a blue line. Drag a tab over an
   editor: the drop preview is blue. The agent page's Customize card has a blue tint.
2. Dark+ and an imported theme (Night Owl): the same places use the theme's accent; a primary
   button's hover is a shade of it, not the built-in blue.

## D278: floating gaps; tab styles; long Markdown previews

1. Floating panels, default density: the gaps between the side bar, the editors, the bottom panel
   and the agent are as narrow as compact's (4px); comfortable's are 6px. The window's edge keeps
   its gap.
2. Appearance → Classic tabs: square tabs with a hairline between them, the active one in the
   editor's color with the accent along its top (dimmer in another group). Connected tabs: the
   active tab rises from the editor with rounded top corners and curved feet, on a lighter strip
   (darker in a light theme). Rounded tabs: as before.
3. A 10 000-line Markdown file (`node tests/fixtures/setup/big-md.cjs big.md`): Open preview to
   the side opens in about a second and the code blocks color without stalling; scrolling either
   side and moving the cursor stay smooth.

## D279: back / forward; tab options; more settings

1. Open two files, jump around in one (Ctrl+G 200), then Alt+Left: back to the earlier place,
   then the other file; Alt+Right forward. The mouse's side buttons do the same. The ← → beside the
   search box grey out at either end. Settings → "Back and forward buttons: location" → tab strip:
   the arrows move to the start of each tab strip.
2. Right-click a tab → Pin: it moves first with a pin; Close others leaves it; clicking the pin
   unpins. "Pinned tabs on a separate row": pinned tabs get their own row.
3. "Tab close button location" left, "Tab close button" off; "Limit open tabs" with 3: opening a
   fourth file closes the least recently used. Close the active tab: the one you used before it
   shows, not its neighbor.
4. A TypeScript file with an error: its tab and explorer row are red with "1".
5. "Tab placement" left / right: editor groups list their tabs on that side; the terminal and the
   agent keep theirs on top. Drag a tab within the list.
6. "Follow the system's light or dark mode" on: switch Windows between light and dark (Settings →
   Personalization → Colors): the theme follows the two preferred themes.
7. "Format on save: mode" → modifications in a git repository with a TypeScript file: only the
   changed lines are formatted. Markdown preview font size 18: the preview grows.
8. Debugging Node: right-click the margin on line 2 → Add triggered breakpoint… → pick the
   breakpoint on line 6: a dashed ring until line 6 is hit, then a red dot that stops. While
   paused, `name = value` follows the lines above the stop; Call stack → right-click a frame →
   Restart frame goes back to its start. A Python file with debugpy: right-click a line with two
   calls → Step into target lists both. Run and debug → Loaded scripts: its chevron sits before
   the title.

## D280: the debug view in a short window; compounds

1. Debug a Node program in a short window (about 560 px tall), open Loaded scripts: every section
   stays, Breakpoints at the bottom; Loaded scripts scrolls inside. A long exception text scrolls
   past four lines.
2. A compound of two Node programs where one forks a child and starts a worker, with a function
   breakpoint set, in a fresh profile: both start, the child stops at its breakpoint, the program
   doesn't crash when the function breakpoint is hit.
3. Delete a file from a terminal in a git folder: Source control drops it within a couple of seconds.

## D281: dropping files from the system

1. Drag a file from Windows Explorer (outside the open folder) onto an editor group: it opens
   there (not a preview). Onto a second group: it opens in that one. Onto the status bar or the
   title bar: it opens in the focused group.
2. Onto the terminal: its path is typed (unchanged). Onto the agent's chat: attached (unchanged).
   Onto a folder in the explorer: copied there (unchanged).
3. A folder onto the window with no folder open: it opens. With one open: "Add to workspace" /
   "Open folder".

## D282: borders, theme names, dropdowns

1. Monokai, with "Side bar color: the theme's": the explorer's border is the same color as the
   editor's and the agent panel's, flush and floating.
2. Settings → Color theme: Dark+, Light+ and Shiki's themes end in "(built in)". Install an
   extension with a theme of a bundled name (Night Owl): it is listed once and applies the
   extension's colors.
3. Any dropdown (Settings, the debug view's configuration, a dialog): it opens the IDE's menu under
   the field, as wide, the chosen value checked. The color theme list has a search box; typing and
   Enter picks. Near the bottom of a short window, a long list opens above, shortened, never over
   the field. Alt+↓, F4, Space and Enter open it from the keyboard; Escape gives focus back.

## D283: guide, tables, menus

1. Help → Documentation: 21 pages on the left; links between pages and to commands work; tables are
   rounded cards with a light border.
2. A Markdown preview with a wide table: the card scrolls sideways inside its border.
3. Right-click a channel, an agent and a recent chat in the Channels side bar: every item has an
   icon. Right-click in a TypeScript file: Go to references has one.
4. `workbench.editor.pinnedTabsOnSeparateRow` on, pin a tab: the line under the pinned row runs
   under the group's buttons too.
5. Settings in a short window, narrow (the icon rail) and wide: the list's scrollbar sits against
   the divider, not in the middle of the gap.
6. Git → Branch → Create branch from… asks for the start point and a name.

## D284: extension updates, search, Go Live

1. With an extension that has a newer version (Claude Code for VS Code after a release): its row
   under Updates has **Update**, its page **Update to x.y.z**, its gear menu the same; Update
   installs it.
2. Search `publisher:"Microsoft"`, `publisher:"Anthropic"`, `@category:Themes @sort:rating`,
   `@disabled`: results match; the filter button lists the filters.
3. An installed extension from Open VSX: its page shows the verified mark, downloads and stars;
   the stars open its reviews in the browser; its publisher's name searches for its extensions.
4. Install Live Server: its status item shows its own icons (not a dot), and our Go Live leaves the
   status bar; disable Live Server: ours comes back.
5. Go Live, then open the preview's address in Chrome: saving the HTML or CSS reloads it.
6. Claude Dark, a CSS file with `--accent: #0e6b64;` and `color: var(--accent)`: the custom
   properties are colored like property names.

## D285: extensions beside another IDE version

1. With Claude Code for VS Code installed, keep a window of the installed build open, start a dev
   build (`npm run dev`) or install an update, then close and open a folder in the first window:
   Claude Code's activity bar icon and status item stay; nothing says "Node ended".
2. Open a folder you haven't decided to trust, trust it right away: extensions that start with
   the IDE are running again (their icons and status items are back).

## D286: agents only

1. Customize → Agents: the main agent's card has one model; no "Built-in helpers"; its name opens
   the agent editor with face, name and model only.
2. In the editor, Model icon: no faces or colors; Character: they're back.
3. The composer's first pill lists agents (no Mode section); Shift+Tab: Plato, Gabby, the main
   agent. Plan with Plato, press Build: the main agent carries it out.
4. Ask the agent to run a dev server: View output under the step shows its output live; after it
   ends the list above the message box says "finished" for five minutes.
5. Settings → Agent: Explore model and Review model are there; Plan model and Build model say
   they're advanced.

## D287: the Agents page as one grid

1. Customize → Agents: one grid: the main agent's card first (Main, its model), Gabby and Plato,
   Explore and Review (Built in, a switch and a model each), New agent. No Model setup chip, no
   "Models and providers" link.
2. Click the main agent's card: its editor. Click Explore's name: nothing; its ⋯ → Duplicate makes
   an editable copy.
3. The chat's model picker: no Presets button.

## D288: agents and subagents

1. Customize → Agents: only agents (main, Plato, Gabby, yours); "Let agents hand work to each
   other" and a Subagents link under them.
2. The link (or the main agent's card): its page ends with Subagents: Explore, Plan, Review,
   General purpose, each with a model and a switch. Pick a fast model for Explore; ask a broad
   question about the code: the explore step runs on it.
3. New subagent → name and description: `.claude/agents/<name>.md` opens; it's in the list
   (Project). Ask the agent to use it: "Ran <name>: …" with its report.
4. Customize on Review: `.claude/agents/reviewer.md` opens; edit its instructions; the automatic
   review (Review changes automatically) follows them. Delete the file: Review is built in again.
5. In a chat with the main agent, ask it to get Plato's plan: Plato joins and answers next; ask
   Plato to hand back: the main agent answers.
6. Open Gabby in the editor: Subagents is there too. Switch Plan off: Gabby's file gets
   `subagents: …` without plan; in a chat with Gabby, asking for a plan subagent says it isn't
   available, while the main agent can still run Plan.
7. The editor's Mode field reads Agent / Plan / Ask.
7a. Click Plato's model chip: the chat's picker, titled for Plato, "Same as the chat" first.
   Pick Claude Code · Sonnet: the chip reads "Claude Code · Sonnet …". The main agent on Claude
   Code · Opus: in a chat, switch to Plato: the pill says Sonnet; ask something; switch back: Opus. A subagent's chip and
   Edit with AI's offer no external agents. Type "free": results sit under OpenRouter, OpenCode…
7b. Settings → Agent: no Plan model or Build model; Default model, Backup model and each AI
   feature's model are buttons that open the chat's picker. Customize → Agents: External agents
   rows have no model; set Jonna to Claude Code · Opus on its card, restart: the chat is on Opus.
7c. Customize → Agents: AI features above External agents, five rows. Turn Edit with AI on: Ctrl+K
   works in the editor; pick its model there and Ctrl+K uses it.
8. Narrow the window: the subagent rows wrap, nothing is cut off.

## VS Code extensions as in VS Code (D295–D297)

Install from the Extensions view: ms-python.python, ms-toolsai.jupyter (its pack comes too),
meta.pyrefly, anthropic.claude-code.

1. Task Manager: one node.exe holds every VS Code extension (plus one per IDE-format Node one).
2. Open a .py file: Pyright is off while Pyrefly or Python serves Python (one notice), hovers come
   at once, F12 on os.path.join opens typeshed/site-packages, an unused import is faded.
3. Open an .ipynb, Select kernel: Jupyter's rows fill in while the picker is open, Refresh keeps it
   open, Back goes back. Pick a Python: cells run; Run by line steps; an ipywidgets IntSlider draws
   and drags; Plotly draws. Command mode: A, B, D D, Z act on cells; typing "a" in a cell types.
4. F5 on a .py with a .venv and a .env (FOO=bar): debugpy stops at a breakpoint and prints bar.
   Disable debugpy: the built-in debugger runs the .venv's Python with the bundled debugpy.
5. Claude Code: its diff tab opens and closes with its accept/reject; restart the IDE: its panel
   comes back with its state.
6. Two Python formatters (Black, Ruff): Format document asks which is the default; Format document
   with… lists both.
7. Set log level…: pick a channel and Trace; trace lines appear and the level survives a restart.
8. Disable ms-python.python: a dialog names Jupyter (Disable all / Only this one / Cancel).
9. Kill the shared node.exe: the extensions come back (a fourth kill within 5 minutes stops).
10. Import from VS Code: the extensions list says which install from Open VSX, which are
    installed, which aren't on Open VSX; Import installs them, then their settings and shortcuts.

## Agent tools like Claude Code's (D300–D325)

The agent's plan card (D300): ask for a task with several steps; the plan shows under its latest
message, steps tick off as it works, and a message sent before it finishes labels the card "Plan
from before your last message".

### The turn: wrap-up box, chapters, task cards, plan first, notify

1. Open a folder that's a git repository, start a chat with a capable model (Claude, GPT).
2. Ask: "Add a function `double(x)` to a new file `math.js`, then tell me." The agent keeps a
   plan, edits, and before its closing message calls `wrap_up`. If it asks something (commit,
   review), a box under the answer shows the recap, the question and buttons; the first is
   highlighted. Click a reply button: it's sent as your message and the box goes. Click an app
   action (Review changes, Keep all, Commit…) on another run: it opens the diffs, keeps the
   changes, or opens Source Control with a written message.
3. While a box with a question is shown, the chat's card in the Inbox shows the recap's first
   sentence; hovering the chat in the Chats list shows it too, and the row has the "Needs you"
   badge if the agent said it's blocked.
4. Reload the window (or close and reopen the chat): the box is still there; send a message: it's
   gone. Retry or rewind past the turn: it goes with it.
5. Chapters: in the same chat ask for something unrelated ("now look at the README and summarize
   it"). The agent may mark a chapter: a divider above your message, and a bookmark button in the
   chat's header. Click it: the chapters are listed (hover one for its summary); pick one: the
   chat scrolls there and lights the divider. Run "Go to chapter" (`agent.showChapter`) from the
   command line with `{ "chapter": "1" }`: same.
6. Proposed tasks: ask "Fix the typo in README and tell me if you see anything else worth doing
   separately." A "New task" card may appear: hover the brief for all of it; **Start in a new
   chat** opens a chat whose first message is the brief, and the card says "Started in a new
   chat" with **Open chat**. On another card, **Dismiss** removes it.
7. Plan first: ask for a broad change ("refactor the project to use ES modules"). The agent may
   show "Plan first?": **Switch to Plan** turns the chat's mode to Plan, the agent only reads and
   ends with a plan and **Build**; **Keep going** lets it carry on.
8. Notify: ask "run the tests and notify me when they're done", then switch to another window
   before it finishes: the taskbar button flashes and a notification with **Show** waits in the
   IDE. Asked while you watch, the step says "Not sent: the user is at the window".
9. UI tests (after a build with dev commands): `node scripts/ui-test.mjs <binary> m7-46`, `m7-47`,
   `m7-48`.

### Files and search

1. Open a folder with a few `.ts` and `.md` files and start a chat (any tool-calling model).
2. Ask: "search for `import` with 2 lines of context in src". The result shows `path:12: …`
   matching lines and `path-11- …` context lines with `--` between groups. Ask for "count mode":
   `path:N` lines and a total. The search view's own query is unchanged.
3. Ask: "list every TypeScript file with find_files using **/*.ts": paths, the most recently
   saved first.
4. In a new chat, ask the agent to change a line in a file without telling it to read it: its
   first edit_file comes back "you haven't read … Call read_file …", then it reads and edits.
5. After that, change the same file yourself in the editor and save, then send "what changed?":
   the agent's message carries "<file> changed since you last read it" with your lines as `-`/`+`.
6. Ask the agent to run `node -e "for(let i=1;i<=3000;i++)console.log('row',i)"`: the result ends
   with "kept as out1"; ask it to read lines 1500-1510 of it: process_output returns them.
7. Put a Jupyter notebook in the folder and ask the agent to read it: cells with `<cell id=…>`
   and their outputs. Ask it to read pages 2-3 of a long PDF: only those pages.
8. UI scripts: `node scripts/ui-test.mjs <binary> agent-search-m7-50` and
   `… agent-read-guard-m7-51`.

### Asking, review findings, extension cards, typed memory

1. Ask questions: in a chat, send "Ask me two questions with ask_user: which auth method (OAuth
   with a code preview, or Password with a form mockup as preview) and which parts to do (Tests,
   Docs, Lint; several allowed)". The card shows two chips (Auth method, Parts). Hover or focus
   the options of the first: the preview beside them changes. Press **2**: the Password option is
   picked and the card moves to Parts. Pick Tests and Lint, type "CI" in Other, press **Submit
   answers**. The agent's reply should name Password and Tests, Lint, CI.
2. Narrow the chat to about 360px wide and ask again: the preview sits under the options, nothing
   scrolls sideways.
3. Old form: send "Use ask_user with the question 'Which?' and options A and B": one card,
   one click answers, as before. Typing a message instead of clicking also answers.
4. Findings: make an uncommitted change with a bug (e.g. an off-by-one in a loop), run `/review`.
   The review chat shows a findings card; click a row: the file opens at the line. Click **Fix**:
   the chat switches to Agent mode, the agent fixes it and re-reports with a "Fixed" badge.
5. Extension: open a folder with a `.prisma` (or `.tf`) file and no extension for it, ask the agent
   to work on it: it may show an install card (icon, publisher, verified mark). **Install** asks
   for its permissions and the button turns to **Installed**. Ask about something else that would
   need another extension: it doesn't suggest a second time unless you mention extensions.
6. Memory: tell the agent "don't mock the database in integration tests, we got burned by a
   broken migration" and check `<IDE folder>/memory/`: a `[feedback]` note with **Why:** and
   **How to apply:**. Run **Tidy up agent memory**: the proposal keeps the tag. Older notes
   without a tag still show in the index and in `recall`.

### Browser

1. `node tests/fixtures/mock-devserver.mjs` (port 11998), then in the IDE open
   `http://localhost:11998/agent-lab.html` in a browser tab and a chat with a vision model.
2. Ask: "Find the drop zone on the page." — a `browser_snapshot` row with `find "drop…"`; the
   result lists `text "Drop here" [ref=…]`.
3. Ask: "Take a screenshot, then click the Count clicks button by its position, double-click it,
   right-click it, type hello into the field and press Backspace twice, drag Drag me onto Drop
   here, and scroll the small box — in one batch." — one `browser_batch` row (its text shows the
   action summaries); the page's last line reads `clicks=3 double=yes menu=yes … dropped=yes`, the
   field shows `hel`, the box is scrolled. With the default permission mode the first action asks;
   Always allows localhost for the rest.
4. Ask: "Zoom into the top-left corner of the page at half scale." — the screenshot's text gives the
   coordinate frame and says the zoom's coordinates still refer to it.
5. Ask: "What is document.title, and after await fetch('/about') what's its status?" — a
   `browser_eval` row; results like `string: "Agent lab"` and `number: 200`. On a non-local site
   (e.g. a site opened in the tab with browser.embedSites) the same question asks first, with the
   code; Always stops it asking for that site in this chat.
6. Ask: "Show the page in dark mode." — the page turns dark (`browser_inspect resize colorScheme
   dark`); reload: it stays dark; "back to normal" (`auto`) restores it.
7. Ask: "Open /about in a new tab, list the tabs, then close it." — the new tab opens and is marked
   current in the list, then closes.
8. Ask: "Read me the page's main text." — `browser_snapshot text`: the main element's text.
9. UI test: `node scripts/ui-test.mjs <binary> browser-agent-m7-58`.

### Deferred tools and the web

1. Settings → `agent.deferTools` = always. Add an MCP server with a few tools (Customize → MCP, or
   the gallery's "Everything"/"Filesystem" server). Open a new chat and ask "which tools do you
   have?": the MCP tools aren't in the list, `tool_search` is.
2. Ask the agent to use one of the server's tools ("list the files in this folder with the
   filesystem server"). It calls `tool_search` (row "Loaded tools …"), then the tool, which runs.
   `get_state ide://agent/session` (or the command palette's state viewer) shows `loadedTools`.
3. Ask again in the same chat: no new tool_search. Rewind the chat to before the first message
   (Edit on it, send): the tool is deferred again (`deferredTools`).
4. Same with a model without native tool calls (one that uses the text protocol): the search and
   the call work the same way.
5. `agent.deferTools` = never: the MCP tools come with full definitions and no tool_search.
6. With web search set up (Tavily or Exa if you have a key, else SearXNG): ask "search docs.rs only
   for serde derive" — the call has `allowed_domains`, every result is on docs.rs, and the answer
   ends with a Sources: list. Ask for an extended search: the row says "extended" and the result
   has the top pages' text.
7. Ask "what's the latest version on https://www.rust-lang.org? use web_fetch with a prompt": the
   row's result is a short answer with the address, not the page. Set `agent.webFetch.model` to a
   cheaper model and repeat; the Usage page lists a "subagent" entry for that model.
8. Set `agent.webFetch.model` to a model that fails (a provider without a key): the result is the
   page's text, capped, with the note.
9. UI script (after the build): `node scripts/ui-test.mjs <binary> agent-deferred-m7-62`, and
   `agent-m7-5` (it moved to agent.deferTools).

### Monitors, pull requests, forks, other chats

Start the IDE on a folder that's a git repository with the GitHub CLI signed in and a model set
up.

1. **Monitor.** In a chat: "Start a monitor on `node -e "setInterval(()=>console.log('ERROR ' +
   Date.now()), 3000)"` described as 'errors', then wait." Approve the command. Every 3 s a quiet
   line "Monitor bgN (errors): 1 new line" appears and the agent answers it. The list above the
   message box shows "monitor: errors" with Stop; the details panel's Background card shows it
   with a radio-tower icon. Press Stop: no more messages, no end message.
2. Ask for a monitor with `timeout_ms` 10000 on a command that never prints: after 10 s one
   message says it expired with 0 events.
3. Ask for a monitor on `node -e "setInterval(()=>console.log('x'),20)"`: within seconds it's
   stopped with "too many events".
4. On Windows, ask for a monitor on a log file: the agent uses `Get-Content … -Wait -Tail 0`
   (PowerShell); appending a line to the file brings a message.
5. **Pull request.** With a pull request open for the current branch: "Watch this pull request."
   The details panel's Background card shows "#N title" with Check now and Stop watching.
   Push a commit that fails CI: within a minute or two of the check failing, a quiet line
   "Pull request #N (…): 1 check failed" appears and the agent starts on it. Leave a review
   comment on GitHub: the next message has its text. Press Check now to look at once. Merge the
   pull request: one message says it's merged, the row goes.
6. Close and reopen the folder while watching: the row comes back and nothing old is re-sent.
7. **Fork.** After some conversation: "Fork yourself to check whether the function we discussed
   has tests; carry on with the docs meanwhile." A "Subagent fork is working in the background…"
   notice shows; its report arrives as a message and refers to what was discussed without being
   told.
8. **Chats.** Open two chats in the folder, say something in the second. In the first: "List my
   other chats and ask the second one to summarize what it did; tell me when it's done." A
   permission card asks to message that chat (once). In the second chat a "Message from chat …"
   block shows the text and its agent answers; the first chat then gets "Chat … is idle now" with
   the answer's first lines. Ask again: no second permission card. In Ask mode, the agent doesn't
   have message_chat.

## Agent tools like Claude Code's, second round (D326–D344)

### Background tasks and WebSocket monitors

1. Build and open a folder; set a model. In a chat, ask: "Start a background subagent to look at
   the README, and run `npm run dev` in the background." (or any server command).
2. Under the conversation, a chip reads "2 background tasks" / "2 running". Click it: the
   Background tasks view opens to the right of the chat with Running (2).
3. Click the command row's chevron: `$ npm run dev` and its output, updating every second.
   Open output opens the existing output tab.
4. On the subagent row, click "N tasks": its tool calls; click one to see its arguments/command
   and output. Click the subagent's title: its transcript (brief, Model, its work groups; open
   one to see the rows). Back returns to the list.
5. Click Stop on the subagent, then on the command: both move to Finished (N) as Stopped; the
   chip says "2 stopped". Open the finished subagent's title: its transcript still shows.
6. Click the trash button: Finished empties and the chip disappears.
7. Make the window narrow (about 760 px wide): titles ellipsize, times and Stop stay visible.
8. WebSocket monitor: run a local server that pushes messages (for example
   `node -e "require('http').createServer().on('upgrade',(q,s)=>{const k=require('crypto').createHash('sha1').update(q.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+k+'\r\n\r\n');setInterval(()=>s.write(Buffer.from([0x81,5,...Buffer.from('hello')])),3000)}).listen(8099)"`),
   then ask the agent: "Monitor ws://127.0.0.1:8099 and tell me what arrives." With
   agent.runCommands on Ask, a card shows the address first. Each "hello" comes back as a
   message; Stop on its row in the view (or kill_process) ends it. Stop the server: the agent
   gets "its WebSocket closed without a close code".

### Hand-offs, plan documents, chat search, loops, the guide

1. Hand-off (D329): in Agent mode ask for a multi-step change ("add a CONTRIBUTING.md and link it
   from the README"); while it works, send "unrelated: what does package.json's test script
   do?". The agent should write a bold title line, call hand_off_task, and answer your question.
   A "Moved to a new chat" card shows; **Open chat** opens a chat titled after the task, whose
   first message is the remaining plan with a "Handed off from chat …" chip, and which carries
   on with the work.
2. Plan document (D330): switch a chat to Plan, ask for a plan. The turn ends with a card (the
   plan's title, its steps); click the title to read it. **Open to edit** opens
   `…/plans/<chat id>.md` next to your settings.json; add a step and save: the card says
   "edited". **Build**: the agent's message shows your edited plan and it builds that version.
   Again in Plan mode: edit the file, **Keep planning**, type "make step 2 smaller": the
   revised plan keeps your edit.
3. Chat search (D331): in one chat mention something distinctive ("we chose zebra-crossing
   names"); in another, ask "what did we decide about the names in another chat?". The agent
   calls search_chats and cites the chat and message. Palette → **Search chats…** → type
   "zebra" → pick the hit: that chat opens with the message highlighted.
4. Loop (D332): type `/loop check whether README.md mentions tests`. The strip above the box
   shows "Loop · self-paced · next check in …"; hover for the agent's reason. Wait a minute or
   two (or run `agent.runScheduleNow` with the id from `ide://agent/loops`): checks where nothing
   changed fold into "N quiet checks". **Stop** ends it ("Loop ended: you stopped it."). Try
   `/loop 2m say the time` too (the strip says "every 2 min").
5. Guide (D333): ask "how do I turn on the codebase index in this IDE?". The agent delegates to
   **guide**, which searches the guide and answers citing the page (e.g. 05-agent.md); in an
   installed build too (the guide is bundled).

### Inline widgets and the ask card

1. Use a model that calls tools well (or the mock: `node tests/fixtures/mock-ollama.mjs`, set
   `agent.ollama.url` to `http://127.0.0.1:11999`, model `ollama/mock-coder:1b`).
2. In a new chat send `pkgI widgets` (the mock) or ask a real model "draw a bar chart of
   these numbers as a widget: 3, 5, 8, then a widget with a button that asks you to explain
   the biggest one". Expect a "Read the widget guide" row, then two cards drawn in the chat's
   colors with no box around them: a bar chart (SVG) and a button. While they load the card shows
   its loading line.
3. Switch the theme (light ↔ dark): both widgets follow at once, without reloading.
4. Click the button in the HTML widget: a message appears as yours with a "From Pkgi counter"
   chip, and the agent answers it. Click it again twice quickly: only one more message goes.
5. Hover a card: **Open in a tab** opens it full size in the editor area (again: the same tab),
   **Copy code** puts its code on the clipboard, **Save as file…** saves `pkgi_chart.svg` (opens
   in a browser on its own) or `pkgi_counter.html` (a whole page in the theme's colors).
6. Make the chat narrow (a small window): the chart scales down to the column width.
7. Ask a real model for a widget that fetches a web page or loads a script from a CDN: it shows,
   but the request fails (the page's console says the policy refused it). Reload the window: the
   chat's widgets draw again from the saved chat.
8. Send `pkgI ask skip` (mock) or ask a real model to ask you a question: the card shows rows
   with radios and a last "Other" row; the footer says Ctrl+Enter submits. Press **Skip**: the
   card shows "Skipped", and the agent says it decided itself.
9. Send `pkgI ask two`: press 2 (picks Blue, moves to Sizes, which has checkboxes), press
   **Skip** (the Sizes tab shows a dash, Submit turns on), then Ctrl+Enter: the reply reads
   `color=Blue sizes=(skipped)`.
10. The older cards still work: `Please show the rich blocks` (D171) and `pkgC ask` (D312).

### The command sandbox and the chat in a worktree

Sandbox (Windows):
1. Open a folder with a `package.json` (any project), Settings → Agent → **Command sandbox** is
   `auto`. Run **Get state** `ide://agent/sandbox` (or ask the agent): mechanism `low-integrity`.
2. Ask the agent: "run `node -e "require('fs').writeFileSync('inside.txt','x')"`". The step's
   summary ends with "· sandboxed" and `inside.txt` exists. (The first command in a big folder can
   take a few seconds: the folder is being marked.) Run `icacls .` in a terminal: the folder shows
   `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`.
3. Ask: "write a file next to this folder with node: `../outside.txt`". It fails with EPERM; the
   agent should retry with sandbox: false, and a red-edged card says "Outside the sandbox, with
   your full rights" — even in **Auto** mode. Deny: nothing is written. Allow: `../outside.txt`
   exists.
4. Ask it to run `npm install -g cowsay` (or `pip install --user x`): blocked in the sandbox, the
   agent says why and asks to run outside.
5. Settings → **Command sandbox** `off`: step 3 writes without asking about the sandbox.
6. `git commit` from the agent works in the folder (and from a worktree, step below).
macOS / Linux: repeat 1–3 (Linux needs `bwrap` installed; without it the card says "Not
sandboxed: Linux without bubblewrap…").

Worktree:
1. In a git repository with a commit, ask the agent "work on this in a worktree called demo".
   It calls enter_worktree; the header shows a `agent/demo` chip; a folder `<repo>.agent-demo`
   appears next to the repository.
2. Ask it to create `demo.txt` and commit it. The open folder has no `demo.txt`;
   `git log agent/demo` has the commit.
3. Click the chip → **Review its changes** (the compare page shows demo.txt) → **Merge into this
   folder** (asks, then the change arrives staged).
4. Ask "leave the worktree but keep it": the chip goes, the chat works in the folder again; the
   branch is listed under **Agent worktrees**.
5. Enter again ("go back into the demo worktree", or by path), make an uncommitted change, ask it
   to leave and remove the worktree: a card asks first ("It has 1 uncommitted change…"). Allow:
   folder and branch are gone.
6. Reload the window while in a worktree: the chat comes back with the chip and keeps working there.

### Workflow scripts

Setup: a folder open and trusted; a model set up (a real one, or the mock: `node
tests/fixtures/mock-ollama.mjs` and `agent.ollama.url` = `http://127.0.0.1:11999`).

1. With the mock, send `pkgK run a workflow`. A permission card asks **Run a workflow**: "PkgK demo:
   two scouts, then a judge", phases "Scout → Judge", the limits, and the script. Click **Allow**.
2. The agent answers "PkgK workflow started: yes". A card under the conversation shows
   **Workflow pkgk-demo**, its phases Scout (scout alpha, scout beta) and Judge (judge), each
   checked, and "3 of 3 agents · … tokens". The conversation gets a quiet line "Workflow wf1
   (pkgk-demo) finished …" and the agent answers "PkgK result: pick=alpha, cached=0".
3. Send `pkgK resume the workflow`, allow it: the scouts show "cached", only the judge runs, and
   the answer is "PkgK result: pick=alpha, cached=2". Only this run's card shows now.
4. Run `get_state ide://agent/workflows` (or the command palette's **List workflow runs**): both
   runs, with agents, usage and result.
5. With a real model, ask: "Run a workflow: three agents each summarize one of src/core,
   src/ui and src/workbench in two sentences, then one agent merges the summaries." Allow it.
   While it runs, the card shows spinners and waiting rings, tokens grow, and **Stop** stops it
   (the card says Stopped; no message follows). Run it again and let it finish: the merged
   summary comes back to the agent.
6. Set `agent.workflows.maxAgents` to 2 and ask for the same workflow: it fails at the third
   agent, and the agent is told so. Set `agent.workflows.timeoutMinutes` to 1 with a slow model:
   the run stops after a minute and the agent is told.
7. Tick **Always allow** (workflows in this chat) and **Allow** once: the next workflow in that chat isn't asked
   about. Turn `agent.workflows.enabled` off: the agent no longer has run_workflow.
8. Ask the agent to run a workflow whose meta uses a variable (`name: NAME`): it gets "Bad meta:
   "NAME" in meta: it must be a pure literal" and nothing runs; one using `Date.now()` fails with
   the reason.

### Browser uploads, recordings and your own browser

1. Upload (D339): run `node tests/fixtures/mock-devserver.mjs` (port 11998) or any page with a file
   input. In the folder, create `upload-me.txt` (`hello upload`). Open
   `http://localhost:11998/upload.html` in a browser tab. In a chat: "Upload upload-me.txt into the
   Photo input". Allow the browser action: the page shows `upload-me.txt 13 text/plain` under the
   input. Ask "Take a screenshot and drop it on the drop zone": under the zone,
   `shotN.png … image/png`. Ask it to upload `../something.txt`: refused (outside the workspace).
2. Recording (D340): on the same page ask "Start a recording, click Count twice, then stop the
   recording". A card appears in the chat with the animated GIF (rings where it clicked, captions),
   frames, length and size. Save to project… asks for a name (`recording-….gif`) and writes it;
   Download… opens the save dialog. Switch to another editor tab during a recording: the browser
   tab is not brought forward (frames resume when it's visible again).
3. Your own browser (D341, Windows with Chrome or Edge installed): Command palette → "Browser: Open
   your own browser for the agent…" (or `browser.launchExternal`). Chrome opens with a fresh profile
   (in the folder's IDE folder). In a chat: "Use my browser: go to example.com and tell me the
   heading" — the agent lists tabs (`external … [your Chrome (port 9222)]`), takes a snapshot and
   answers. Clicking and typing work there; links and Ctrl+R behave as usual in Chrome. Ask for a
   screenshot: it shows Chrome's page. "Browser: Disconnect from your own browser" lets go.
   Alternatively start Chrome yourself with `--remote-debugging-port=9333
   --user-data-dir=<a temp folder>` and run `browser.connectExternal {"port": "9333"}`.

### Skill and MCP server suggestions

Setup: a model that uses tools (or the mock: `node tests/fixtures/mock-ollama.mjs`, then
`agent.ollama.url` = `http://127.0.0.1:11999`), a folder open and trusted.

Skills (D342)
1. Ask the agent: "Every release I write notes from the commits the same way. Can a skill do
   that?" Expect a card with release-notes (Skill catalog) and **Add**; the answer doesn't
   describe the skills.
2. Click **Add**. The button says Added; Customize → Skills lists release-notes under User;
   `~/<data folder>/skills/release-notes/SKILL.md` exists.
3. Customize → Skills → turn off a skill of yours; ask for something it covers. The card shows it
   with "Turned off" and **Turn on**; clicking turns it on (the Skills page agrees).
4. In a new chat, get one card, then say "ok, go on" and ask for another suggestion: the agent is
   told it already suggested (no second card).
5. Palette: **Add an agent skill from the catalog…** lists the skills not added yet.
6. Delete release-notes from the Skills page to clean up.

MCP servers (D343)
1. Ask: "I need the agent to read my GitHub issues." Expect a card with up to three servers,
   GitHub (Remote, Popular servers) among them with a password field for its token, and
   registry servers marked "MCP registry (not reviewed)", each with what it runs.
2. Type a token into the field, click **Add**, pick This folder. `.vscode/mcp.json` (or the
   folder's mcp.json) gets the server with `${input:github-token}`, not the token; the button says
   Added; the next message starts the server without asking for the token.
3. Add one leaving the field empty: its first start asks for the key in a hidden box.
4. Settings: `agent.mcp.registryUrl` = "" (off), ask again: only popular servers, and the agent
   is told the registry wasn't searched.
5. Add a server that fails (`agent.addMcpServer` with `command: node`, `args: ["missing.mjs"]`),
   send a message, then ask "how are my MCP servers?". The mcp_status card shows it Failed (in the
   error color) with its error and **Reconnect**; clicking it shows "Reconnecting…", then
   "Reconnected: Failed". **Manage** opens the MCP servers page.
6. Narrow the chat to ~320 px: the cards' buttons wrap under the text; fields fit the width.

## Agent tools like Claude Code's, third round (D346–D361)

### Real browser input and DevTools for your own browser

**D346, built-in tab (Windows):**
1. Start a dev server or run `node tests/fixtures/mock-devserver.mjs`, open
   `http://localhost:11998/trusted.html` in a browser tab.
2. Command palette → run `browser.click` with `{"selector":"#hit"}` (or ask the agent "click the
   Press me button"). The page shows `clicks: true`; the result has `"input": "trusted"`.
3. Ask the agent to type "Hello" into the field and press Enter. The page shows
   `keys: H=true e=true …` and `inputs: true …`. Your chat box keeps its focus afterwards.
4. Open a menu of the IDE (right-click the editor) over the page area and ask for a click there:
   the IDE's menu is never clicked; the result says it was synthesized because the IDE covers the
   page.
5. Settings → `browser.trustedInput` off; click again: `clicks: … false`, the chat row reads
   "click (synthesized)". Turn it back on.
6. On macOS / Linux: the same steps give `false` and "(synthesized)" rows (expected).

**D346, your own browser:** run "Open your own browser for the agent…" (Chrome), open the
trusted lab there (`browser.navigate`), repeat steps 2–3: `true` everywhere. Drag test: on a page
with a `draggable="true"` element and a drop zone, `browser_act left_click_drag` drops it (the
page's drop handler runs).

**D347:** with your own browser connected and selected (`browser_act select_tab external`):
1. Ask the agent for `browser_inspect network`, then `request` on one id: headers and the
   response body.
2. `browser_inspect styles` of a button: rules show `file.css:LINE`; a stylesheet from a CDN
   shows its rules too.
3. `browser_inspect storage` on a site you're signed in to: HttpOnly cookies listed with
   `httpOnly: true`.
4. `browser_inspect highlight` a ref: Chrome's own blue overlay with the size tooltip.
5. `browser_inspect resize preset mobile colorScheme dark`: the page lays out at 375×812 in dark;
   `preset desktop colorScheme auto` puts it back.
6. Open a page with a broken image: `browser_console` lists "Failed to load resource" and the
   image under failed requests.

### Sandbox network and read limits, per-project allowances

Windows (where it's verified). Use a throwaway folder: turning the sandbox on marks it low (D336).

1. Settings: **Command sandbox** `auto`. Palette → open `ide://agent/sandbox` with the agent's
   `get_state` or check the settings page: `network` is `proxy`, `limitsReads` true.
2. Make `C:\Users\<you>\pkgo-test\key.txt` with some text, and set **Sandbox: hidden from
   commands** to `["~/pkgo-test"]` (keeps your real `~/.ssh` out of the test).
3. Ask the agent: "run `Get-Content ~/pkgo-test/key.txt`". The command runs sandboxed and fails
   with access denied; the step says "sandboxed". In a normal terminal, `type
   %USERPROFILE%\pkgo-test\key.txt` still prints it. `icacls %USERPROFILE%\pkgo-test` shows
   `Mandatory Label\Medium Mandatory Level:(OI)(CI)(NW,NR)`.
4. Ask: "run `curl.exe -sS https://example.com/`". It fails ("CONNECT tunnel failed, response
   403"); the result names example.com and the agent shows a card "Sandboxed commands in this
   project — Connect to: example.com" with **Allow**. (If it doesn't, ask it to suggest allowing
   the host.) Before allowing, look at a run's permission card (set **Run mode** to ask): its line
   lists the hidden secrets and the network limit.
5. Click **Allow**: it turns to "Allowed"; settings show `agent.sandbox.projects` with this folder
   and `example.com`. Ask to run the curl again: it now gets the page.
6. Palette → **Let sandboxed commands read my secrets again**: a notice says one path; `icacls`
   no longer shows `NR`. Set the denyRead setting back (reset), turn the sandbox off, delete the
   test folder.
7. Small window: the card's button goes under the text and nothing overflows.

macOS / Linux (written, not run here): with the sandbox on, `cat ~/.ssh/config` fails;
`curl https://example.com` fails (macOS: the filter's 403; Linux without allowed hosts: no
network) and the card appears; after Allow, macOS reaches it (Linux: shared network, curl through
the proxy).

### Workflow agents that edit, PR auto-merge

D351 (needs a git repository with a commit, and a model that edits):
1. Open the agent in a git repository. Ask: "Run a workflow where one agent, with isolation
   'worktree', adds a line to notes.txt, and another only reads README.md".
2. The permission card says "Agents that may edit, each in a git worktree of its own (at most 3)"
   and names the editing agent. Allow once.
3. The workflow card shows the agents; under the editing one, its branch (agent/general-…) and
   "editing in its worktree", then "1 file changed (+1 −0)" with **Review** and **Merge**.
4. Your folder's notes.txt is unchanged. **Review** opens the compare page; **Merge** asks, then
   brings the change in. The agent's message after the run names the branch and its changes.
5. Switch the chat to Ask mode and ask again: the tool refuses (this chat can't change files).

D352 (needs `gh` signed in and a pull request with CI):
1. Ask the agent to watch the pull request, then "turn on auto-merge with squash when it's ready".
2. A card asks "Auto-merge #N"; allow. The details panel's pull request row says "· auto-merge",
   its merge button reads "Turn auto-merge off"; `ide://agent/prWatches` shows `autoMerge.by`
   (github when the repository allows auto-merge, else ide) and what it waits for.
3. When the checks pass (and it's approved if required), it's merged: by GitHub, or by the IDE,
   which posts "merged by auto-merge (squash)" in the chat; the watch ends.
4. Ask again for another pull request: the card shows again (once per pull request). Press the
   row's merge button with auto-merge on: it turns off (and GitHub's too).

UI tests: `node scripts/ui-test.mjs <binary> agent-workflow-edit-m7-93` and
`agent-automerge-m7-94` (fake GitHub CLI).

### Desktop control and recording the IDE

Desktop control (Windows):
1. Settings → Agent → Context and tools: Computer use is off. Ask the agent "which tools do you
   have": no `computer`. Turn it on and ask again: `computer` is listed.
2. Open Notepad. Ask: "Use the computer tool: take a screenshot, then click in Notepad and type
   hello". A card "Allow your screen?" appears with an "Allow for this chat" checkbox; tick it and
   Allow. The banner "Controlling your computer. Press Esc or Stop to end." appears at the top of
   the screen and the status bar shows "Controlling your computer — Stop". The screenshot in the
   chat does not show the banner. A card "Allow notepad?" appears for the click; Allow. "hello" is
   typed into Notepad. `ide://agent/computerUse` (get_state) lists both grants.
3. Ask it to type "hi" in a Windows Terminal or PowerShell window: refused ("a terminal or IDE:
   left-click and scroll only…"). Ask it to click in Chrome or Edge: refused (look only).
4. Ask it to open Task Manager or Settings and click something: it asks every time, with no
   "for this chat" checkbox.
5. Mid-task, press Esc (in any app): the turn stops and the banner disappears. Again with the
   banner's Stop button, and with the status bar item.
6. Ask it to type 4111 1111 1111 1111: refused without asking.
7. With two monitors: "screenshot of monitor 1" shows only that one; a click on it lands where
   the screenshot shows.

IDE recording:
1. Command palette → "Record the IDE as a GIF". The status bar shows "Recording 0:00", counting.
   Click around (explorer, a tab), then click the status bar item: a notification says "Recorded
   the IDE: …" with Save to project… and Download…; save it and open it: the clicks have a ring and
   "Clicked …" captions.
2. Ask the agent: "record the IDE while you list the folder, then stop" (it calls screenshot with
   record: start / stop): the chat shows an "IDE recording" card with Save and Download.

### Streaming widgets, output styles, the status line

1. Widget streaming (needs an Anthropic or OpenAI-compatible model): ask "draw an HTML bar chart of
   ten made-up months with a script that animates the bars". The card appears with its loading
   line, the bars appear one by one as they're written, and the frame doesn't flash when the call
   completes; then the script runs (the animation). `ide://agent/widgets` shows the widget with
   `streamed: true`, `loads: 1`. With an Ollama model the widget appears at the end, as before.
2. Output styles: type `/output-style`, pick Explanatory; ask "add a function that reverses a
   string in a new file": the reply has ★ Insight blocks. The details panel shows "Explanatory
   style". `/output-style learning`, ask for a small feature: the agent leaves a TODO(human) and
   asks you to write it. Create `<config>/output-styles/terse.md` with `---\nname: Terse\n---\nAnswer
   in one short sentence.`, `/output-style terse`: replies are one sentence. Delete the file:
   `ide://agent/outputStyles` says `missing: true` and Default is used. `/output-style default`.
3. Status line: save `~/statusline.mjs` that reads stdin JSON and prints
   `` `\x1b[32m${j.model.display_name}\x1b[0m ${j.workspace.current_dir} $${j.cost.total_cost_usd}` ``;
   set `"agent.statusLine": { "type": "command", "command": "node ~/statusline.mjs" }` (on Windows
   the full path). The status bar shows the green model name and the folder beside the model item;
   it updates as the chat goes on. Restrict the folder (Workspace trust): the line goes. Set it to
   `{}`: gone. Narrow the window: the status bar still fits.

UI tests: `tests/scripts/agent-widget-stream-m7-97.jsonc` (Anthropic mock route streaming the
arguments in pieces), `agent-output-style-m7-98.jsonc`, `agent-statusline-m7-99.jsonc`
(`tests/fixtures/setup/pkgr-statusline.mjs`, `pkgr-style.mjs`); mock triggers start with `pkgr `.

### Plugins, agents across windows, phone notifications

Plugins (D358):
1. Customize → Plugins → **Add marketplace** → `anthropics/claude-code`. It's cloned; its plugins
   are listed under "claude-code-plugins".
2. **Install** `commit-commands`: the dialog lists `/commit-commands:commit`… Install. The row shows
   under Installed with "N commands".
3. In a chat type `/commit-commands:` — the commands are in the list; run one on a repo with
   changes.
4. Install `security-guidance` (it has a hook): the dialog has "Run its hooks" with the command
   (`python3 …/hooks/security_reminder_hook.py`). Leave it unticked: ⋯ on its row says "Let its
   hooks run". Tick it there, edit a file with the agent: the hook runs (needs python3).
5. Type `/plugin disable commit-commands`: its commands go from `/`. `/plugin enable …` brings them
   back. ⋯ → Uninstall removes it. ⋯ on the marketplace → Remove.
6. Add a local folder marketplace: `/plugin marketplace add C:\path\to\folder` (one with
   `.claude-plugin/marketplace.json`).

Chats across windows (D359):
1. Open two folders in two windows (File → New window). In window B start a chat and say hello.
2. In window A ask the agent: "list my chats, then message the chat in the other window: say hi
   back, and tell me when it's done" (notify_when_idle).
3. A asks to message that chat (the card says it's in another window); allow. Within a few seconds
   window B's chat shows "Message from chat … (window A's folder)" and its agent answers.
4. When B's chat is idle, A's chat gets "Chat … in window … is idle now" with the answer.
5. Close window B: within a minute A's list_chats no longer shows its chats.

Notifications to the phone (D360):
1. Install the ntfy app on the phone, subscribe to a hard-to-guess topic.
2. Run **Send agent notifications to my phone**, paste `https://ntfy.sh/<topic>`, pick ntfy.
   Settings show `agent.notify.webhook` with `secret: true` and the host only.
3. **Send a test notification to my phone**: it arrives.
4. Ask the agent for a long task and to notify you when it needs you; switch to another app. The
   taskbar flashes and the phone gets the line.
5. Try Discord: a channel's Integrations → Webhooks → copy URL; the same steps, kind Discord.

Send now, Open VSX programs and chat logos (D362–D364):
1. Open a Python folder with ms-python.python installed from Open VSX: one info notice says the
   Environments extension couldn't start pet.exe, with "Don't show again"; no red error. Click it
   and reload: it doesn't come back.
2. Ask the agent to run `sleep 60` and, while it runs, send "never mind, say hi". The waiting
   message shows **Send now** and **Take back**. Send now: the command ends at once and the agent
   answers "hi" in the same turn.
3. In a chat with Claude Code (ACP), send a second message while it works, then Send now: the turn
   ends with "Stopped: you sent a message." and your message goes right after.
4. Chats list: a chat made on one provider's model keeps that logo after you change the default
   model in the composer.

External agents and browser errors, OpenRouter limits (D365, D366):
1. Open a page with a script error in the IDE's browser (a Vite app that throws on load). In an
   OpenCode (or Claude Code) chat, ask "check the errors, the page is open". It reads them with
   browser_console instead of fetching the HTML.
2. In a chat with the IDE's own agent, the same question: it reads the tab's console too.
3. An OpenRouter key with a low credit limit and a Claude model: a message shows "can only pay for
   … output tokens on this key — asking again with that limit" and then the answer.

Servers in Background tasks (D367): ask the agent to start a Vite or FastAPI dev server in the
background. Once it prints its address, the chip under the chat shows a server icon (no spinner)
and "1 server running"; the Background tasks row has a server icon. A build still running keeps
the spinner.

Welcome and TypeScript (D368, D369):
1. Open a folder with only a chat tab and Welcome: close Welcome; it stays closed. Open a file: it
   opens in a new area on the left, not in the chat's group. Close every tab: Welcome comes back.
2. With TypeScript 7 installed globally (`npm i -g typescript@7`), open a .ts file in a folder
   without its own TypeScript: a warning offers Repair; after it, the server runs (hover works).

Image viewer and chat scroll (D370):
1. Open a screenshot from a chat with the chat docked right: the dimmed area fades out toward the
   chat (no hard edge or border), and the caption pill's corners match the buttons beside it.
   Move the chat to the left of the editors and open it again: the fade is on the left.
2. Scroll a long chat up, click another tab in its group (Background tasks), then the chat again:
   it's where you left it.

Hooks, plugins, desktop control, chats (D371–D378):
1. Set an `agent.hooks` SessionStart hook that prints something, then send a first message: the
   agent knows what it printed. Run `/clear`: a SessionEnd hook runs.
2. With Claude Code plugins installed, open Customize → Plugins. They're listed under "From Claude
   Code" and work without installing; installing one again is refused.
3. Desktop control: allow an app with "Remember in every chat"; a new chat doesn't ask about it.
   Ask the agent to copy text into Notepad through the clipboard.
4. Chats list: Ctrl+click two chats, Shift+click a third, then right-click → Delete 3 chats. Drag a
   chat onto the editor area's right edge: it opens there.
5. Settings → All settings: the Color theme dropdown opens at once, and typing filters it.
6. A status line script that prints an OSC 8 link: that piece is underlined and opens on click.

Speed and VS Code settings (D379):
1. Search this repository for a common word (`const`): results fill in without the window
   stalling, and the count settles.
2. A `.vscode/settings.json` with `"files.exclude": { "**/dist": true }`: `.git` stays hidden.
3. Open the Outline and move the cursor between functions: the symbol it's in is highlighted.
4. Ctrl+K Ctrl+T opens the theme picker; Ctrl+Shift+U opens Output; Ctrl+K M changes the language.

Images in the chat (D381):
1. With OpenRouter set up, pick an image model (`google/gemini-2.5-flash-image`) as the chat's
   model and ask for a picture: it shows large under the reply, with rounded corners. Hover it:
   its id (img1) top left, Add to project bottom left, Download bottom right. Click it: the
   viewer opens beside the chat, its fade toward the chat narrow.
   While generate_image works: "Creating image" over a shimmering field of dots.
   A reply with a long link wraps it; the chat never scrolls sideways.
2. Back on a coding model, ask "make an icon of a rocket and save it as assets/rocket.png": the
   agent calls generate_image, the picture shows under the work line, and the file is in the
   project. Ask "save img1 as assets/rocket.jpg": a JPEG is written.
3. Restart the IDE and open the chat: the images are there; Add to project writes the full-size
   image, not the preview.
4. Run `npm run dev`: the taskbar shows the orange logo; the installed app keeps the normal one.
5. Expand a widget the agent drew to a tab: it's centred vertically.

## D382 — The code font is the OS's default
1. On Windows, open a file and a terminal: both use Consolas (as VS Code), even with Windows
   Terminal installed (which shares Cascadia Code). On macOS: Menlo.
2. Set `editor.fontFamily` to `Cascadia Code`: the editor switches; clear it and it's Consolas
   again. `terminal.fontFamily` does the same for the terminal.

## D383 — Status bar items, Follow the agent, shorter dialogs
1. Right-click the status bar: its items by name, left side then right side, with checks; then
   Hide status bar. Uncheck Encoding: it goes, and stays gone after a restart. Right-click an
   item: the menu starts with Hide "<item>". Show all brings everything back.
2. Settings → Agent → Applying changes → Follow the agent on. Ask the agent to change a file:
   the file opens in a preview tab at the change while focus stays in the chat. Type in an
   editor while it works: the editor isn't pulled away. Turn it off: edits open nothing.
3. Customize → MCP → the built-in server: the dialog is at most about 600 px tall and its tool
   list scrolls.
4. Open a terminal, rename it, `cd` somewhere, run a command, quit the IDE and start it again:
   the terminal is back with its name, folder and last output.

## D384 — Dictation on this computer; the mic apart from Send
1. With no Groq / OpenAI key: the empty composer shows only the mic, at the end. Type a word:
   Send appears to the mic's left. Clear it: Send goes.
2. Click the mic: **Set up dictation** (Download (60 MB), Use an API key, Not now; Win + H on
   Windows). Download: a progress notification with Cancel, then "Dictation is ready".
3. Click the mic and say a sentence; ✓ (or Enter): the words appear in about two seconds. Say
   something in another language: it's written in that language. Silence gives nothing.
4. Type a few words, then dictate: the speech is added after them; Send sends both.
5. While the agent works: Stop shows left of the mic; dictating still works.
6. Settings → Agent → Voice → Speech model on this computer: small. Remove the speech model
   (palette): the next mic click offers the download again.

## D386 — No messages from a stopping extension
1. With Live Server (ritwickdey) installed and no server running, restart the extension host
   (Developer: Restart extension host) or switch folders: no "Server is not already running".

## D387 — F11 full screen
1. Press F11: the window fills the screen, no gap at the bottom, no window buttons; F11 again
   restores it. Do it from a maximized window too: it comes back maximized. View → Appearance →
   Full screen shows F11.
2. Debug a program and pause at a breakpoint: F11 steps into, the window stays as it is.

## D388 — Extensions' hidden terminals
1. With the Python extension installed, open a Python project: no "Python" terminal tabs appear
   (Terminal → Show hidden terminal may list its probes). Close any old "Python" tabs, restart:
   they don't come back.

## D389 — Slash commands, inline lists, flat logos
1. In a chat type `/`: the commands show over the box, as wide as it. Type `co`: the list narrows;
   ↑/↓ move, Esc closes it. `/new` finds `/clear`. Tab on `/btw` fills in `/btw `; Enter on
   `/context` runs it (a note with how full the chat is).
2. `/btw what did you just change?` while the agent works: a "Side question" card answers from
   the chat; the agent goes on; × closes the card; the agent's next answer doesn't mention it.
3. After the agent edits a file, `/undo` puts it back; in a new chat `/undo` says there's nothing.
4. Type `@read`: README.md and the context mentions show over the box; Enter adds the file.
5. An agent whose face is its model's logo (Claude, OpenAI, Ollama): in the chat tab, the chat
   list, the agent pill and the agent menu the logo stands alone, no colored square behind it;
   the model picker still has them.

## D390 — Tools on demand, dimmer logos, menu-height rows
1. Open a new chat and say hello: the Context panel's "Built-in tools" is a few thousand tokens
   lower than before. Ask the agent to schedule a message or generate an image: it loads the tool
   (a "Loaded tools" row) or calls it directly, and it works.
2. Model logos in the chat tabs, the chat list, the agent pill and the model picker are the dim
   icon gray, with no square behind them; colored logos (Claude Code) keep their color.
3. The "/" and "@" lists' rows are as tall as a context menu's.

## D391 — The full audit
1. Drag a splitter while a tab closes on its own (an agent opening or closing one): the window
   stays clickable. In a short window, dialogs scroll and splitters don't jump.
2. While a long reply streams, scroll up: the chat stays where you put it.
3. Turn file nesting off, delete `package.json`: only it goes. In compacted folders a/b/c, create
   `a/x.txt` from a terminal: it shows.
4. Open a UTF-16 file, edit and save, then Timeline → Restore an older version: it's still UTF-16.
5. Make a junction (`mklink /J linked src`), Delete permanently: the link goes, `src` stays.
6. Customize → Auto-approve: add `git push` as Ask; in Auto, the agent's `git.exe push`,
   `git  push` and `GIT push` all ask.
7. Double-click a keybinding to record, click an editor, type: the text goes into the editor.
8. A VS Code extension that calls `vscode.executeDocumentSymbolProvider` on a TS file gets the
   symbols; switching to a light theme changes `activeColorTheme.kind`.

## D392 — The sandbox keeps git's settings
1. Windows: with agent.sandbox on, let the agent run any command in a git folder, then run
   `git config --local x.y 1` in a terminal. Source control says git is paused for the
   repository, naming `.git/config`, with Trust git settings; choosing it asks first, then the
   changes show again. Asking the agent to trust them is refused.
2. macOS or Linux: with the sandbox on, the agent's `git config x.y 1` or
   `echo > .git/hooks/pre-commit` fails (read-only); `git commit` still works.

## D393 — Read-only files, hidden secrets, paste from history
1. Open a file and click the lock in the status bar: typing says "Cannot edit in read-only
   editor" and the lock is closed; click again and it's editable. Set `files.readonlyInclude`
   to `{ "**/*.md": true }`: Markdown files open read-only; "Set active editor writeable in
   session" makes one editable until "Reset active editor read-only in session".
2. Turn on `editor.hideSecrets` and open a `.env` file: values are gray bars, the line with
   the cursor shows its value, keys and comments stay readable. Copy a covered value: the real
   text is copied.
3. Copy two different lines, then Ctrl+K Ctrl+V: both are listed newest first, the selected one
   shows below the cursor, Enter pastes it. Copy something in another program: it's at the top.
4. Restrict the folder (Manage workspace trust): Restricted mode is the leftmost status bar item.

## D401–D403 — Agent tabs, sign in and out, OpenCode V2, approval cards, an agent's own changes
1. Send a message to the agent: its tab's title shimmers until the answer is done.
2. Customize → Providers: an installed Claude Code row has ⋯ with Sign in and Sign out, each
   running in a terminal. OpenCode V2 is listed (Install when it's missing); the old OpenCode
   isn't. Customize's chips read Auto and MCP.
3. Customize → Rules: clicking a rule opens its file; its ⋯ has When it applies….
4. Ask Claude Code to run a command with Ask before commands on: the approval card has the chat's
   background, a grey icon, Deny (secondary) and Allow (primary).
5. While Claude Code answers a question without editing, save a change to another file in the
   folder from the editor of another program: the turn doesn't list it as the agent's, and a
   note names it.

## D409 — The chat details panel, Usage and Customize menus
1. Send a message, open the chat's details: Context shows "… until auto-compact" and Compact
   session; with Claude Code as the agent, Compact session sends /compact.
2. Click the branch row: the branch picker opens.
3. Hover a card's header: a grip shows at its right; drag it above another card. Open another
   chat: the order is the same.
4. In the Chats view, right-click Customize: Open, then every tab; each opens Customize there.
   Right-click Usage: Open.

## D411 — Change bars in files with stray carriage returns
1. Open `docs/decisions.md` (it has `\r\r\r\n` endings) with no changes: no change bars.
2. Change one line: one bar, on that line. Right-click it, Revert change: only that line goes
   back.

## D412 — A restored tab's file selected in the explorer
1. Open a file, close the IDE, open it again: the file's row is selected in the explorer.
2. File > Close folder, then open the same folder: the same.

## D413 — Describe it chip, popular extensions, editor menu icons
1. Agents > New agent: Describe it…'s icon is small and centred on its label.
2. Extensions view with no folder open: Popular lists Path IntelliSense, not Material Icon Theme.
3. Right-click in a formatted file: Format document with… has an icon. Right-click a breakpoint
   in the gutter: Disable breakpoint has one.

## D414 — The IDE account
1. Accounts menu > Sign in: the browser opens jonna.dev's sign-in page. Sign in with Google: the
   menu shows your name, email and Plan: free, and your picture is on the Accounts icon.
2. Close and reopen the IDE: still signed in. Offline: still signed in.
3. Sign out: the menu offers Sign in again.
4. Until jonna.dev's certificate is live, set `"accounts.serverUrl": "https://jonna-dev.web.app"`
   to test against the same service.

## D415 — A channel's conversation keeps its name
1. Run "Open channel…" > #general and send a message: the tab and the Chats row still say
   #general after the answer.

## D416 — Caches bounded by size
1. Search chats (agent.searchChats) twice in a folder with many chats: both find the same hits.
2. Ask the agent with @docs:<a large source> twice: the second answer still cites the docs.
3. A chat answer with a Mermaid diagram and a formula: both draw, and scroll back without
   flicker.

## D419 — External agents as their chat's agent, the agents' guide, custom editors
1. A chat with Claude Code (or Codex): ask it to "set a breakpoint on line 3 of <a file> with the
   IDE's debugger". The question appears as a card in the chat, not a dialog over the window.
   With the chat on full access it isn't asked.
2. In the same chat: "what does help_agentGuide say about extensions?" It answers from the guide
   (three formats, how to load and install).
3. Ask it to load an extension folder outside the project (`extensions.loadUnpacked`): "Change
   the IDE" is asked in the chat, then the extension's permissions; it shows under Development.
   Ask it to install that folder (`extensions.installFromFolder`): it shows under Installed.
   Change a file in the folder, raise its version, ask it to install again: the installed
   version changes.
4. `claude mcp add` from a terminal (the MCP server on): its calls still ask in a dialog, and
   `extensions.installFromFolder` answers "Only the user or the agent can install extensions."
5. A VS Code extension with a custom text editor (the three.js game editor, loaded unpacked):
   open a `*.scene.json`. Its Play / Build / JSON buttons are in the tab's toolbar; Ctrl+Alt+P
   toggles play. "Open scene as JSON" opens the text editor beside it, not a second scene editor.
   Move an object, press the page's Undo, then Redo: the object goes back and forth. With two
   scenes open, Play starts the one whose tab you are in.
6. Give that extension a `schemas/scene.schema.json` (`contributes.jsonValidation`): in the JSON
   text of a scene, a wrong property is underlined and completion offers the schema's.

## D420 — Fewer questions, handles above pages, viewer tabs that come back
1. A chat with Claude Code: ask it to reload an extension. One card ("Change the IDE"), not a
   card from Claude Code about `ide_run_command` first. Choose Allow for this chat: the next
   extension command in that chat isn't asked.
2. Open a file in an extension's viewer (the game editor's scene) beside the sidebar or another
   group. Hover the handle between them: the 2px line shows on both sides of it, and the handle
   can be grabbed from the page's side.
3. The game editor's page uses the IDE's colors, radii and text sizes; switch to a light theme:
   it follows.
4. With a scene open in the game editor, close the IDE and open the folder again: the scene's
   tab is back once the extension has loaded. Close the tab, restart: it stays closed.

## D421 — Large files, Error Lens, updates that fit, a double-clicked tab
1. Open a text file of 300,000 lines or more (a model's `tokenizer.json`): it shows at once and
   the window keeps answering (it froze for minutes).
2. Install Error Lens from the store: its page shows no "Activating failed". In a TypeScript file
   write `const n: number = "x";`: the message shows at the end of the line.
3. Right after installing it, its page offers no update to a version that needs a newer VS Code
   than the IDE follows (3.26.0 stays; 3.30.0 needs 1.107).
4. Single-click a file in the explorer (an italic tab), then double-click the tab: the title
   turns upright and the next single-clicked file opens in a tab of its own.

## D422 — Forking a chat
1. In a chat with two or more replies, hover an earlier reply: its actions have a fork icon
   ("Start a new chat from this point. This one stays as is."). Click it: a menu opens at the
   button, "Fork with <this agent>" first, then the other agents under "Fork and hand to".
2. Choose the first entry: a new chat "… (fork)" opens with the conversation up to that reply;
   the original still has everything. In the Chats list the fork sits under the original, joined
   by an elbow line.
3. Fork the fork (right-click it in the list, Fork): it sits one level deeper.
4. Fork a reply and pick another agent: the fork says "Handed to <agent>" and that agent answers
   the next message; the original chat still has its own agent.
5. Delete the original: its forks stay, at the top level.
6. A narrow sidebar: a fork three levels deep still shows its title.

## D423 — A double-clicked preview tab, VS Code 1.146
1. Single-click a file in the explorer (its tab's title is italic), then double-click that tab
   with the mouse: the title turns upright. Single-click another file: it opens in a tab of its
   own. The same for the extension store's page tab.
2. Double-click a terminal's tab: it still asks for a new name.
3. Install Error Lens from the store: it installs its newest version (3.30.0 or later) and
   activates.

## D424 — Small cleanups
1. Chats list: hover a folder's name. The tooltip (its path) shows beside the sidebar; the + at
   the row's end stays visible and clickable, with its own "New chat" tooltip.
2. A chat with Claude Code or Codex, in a fresh window: pick another of its models. The model
   pill shows the picked name with a spinner until the agent has taken it, then the name alone.
   The same for its reasoning level.
3. With no folder open, a chat's details panel: Environment has a "No folder" row; clicking it
   shows the folder picker.
4. With a folder open: right-click the folder row, Add folder…, pick another. It shows under the
   first, and the explorer lists both. Ask the agent to read a file in the added folder: it
   does. Right-click the added row, Remove from workspace: it goes.
5. Settings, search "default layout": three cards (Default, Agent, Code), Default selected. Pick
   Agent, then File → Close folder (or restart with no folder): the Chats list and a chat fill
   the window, no welcome tab. Pick Code and close a folder again: the welcome tab alone, no
   sidebar; open a folder never opened before: the explorer shows, no agent column.
6. Open a folder never opened before (Default layout): the explorer, its README, the agent on
   the right, and no terminal. Ctrl+` opens one at the bottom.
