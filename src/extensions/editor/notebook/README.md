# editor/notebook

The notebook editor (D188) for every notebook type (D202): it reads, writes and runs notebooks
only through `services.notebooks` (`core/notebook/providers.ts`). Jupyter's `.ipynb` format is
built in (D204, `core/notebook/ipynb.ts`, like VS Code's built-in ipynb extension): notebooks open,
edit and save with no extension. Running them is a kernel source's job: the built-in Jupyter
extension's (`src-tauri/bundled-extensions/jupyter`: `main.js` finds the Pythons and starts
`kernel_host.py`, offering to install ipykernel; off until turned on, from the kernel picker too)
or another extension's through `ide.notebooks`.

- `model.ts`: a notebook in memory, DOM-free and tested (`notebook.test.ts`, which also tests the
  .ipynb format): cell edits, outputs merged as they arrive, a `# %%` script export, an output's
  plain text.
- `jupyter.ts`: the message when nothing runs Jupyter notebooks, and kernels remembered by earlier
  versions.
- `ansi.ts`: ANSI colors in outputs (the terminal palette's tokens), tested.
- `outputs.ts`: draws outputs (streams, errors, images, SVG, HTML through the Markdown
  allowlist, Markdown, LaTeX, JSON, text).
- `outputFrame.ts` (D189): outputs that run code (scripted HTML, JavaScript, Plotly, Bokeh,
  widgets) in a sandboxed frame — `src-tauri/notebook/output` served on its own local origin
  (`notebook_output_origin`), no same-origin. `outputGroups` puts Bokeh's element and its script
  in one frame; `preloadOf` passes Bokeh's set-up to later frames. D204: an extension's output
  renderer runs in such a frame (`RendererBinding`: its script, a content security policy for the
  network its extension was allowed, messages both ways); its frame has no popups, and
  `harden.js`'s `harden()` takes away WebRTC, DNS prefetching and frames of its own, so that
  network limit holds (the IDE page's `frame-src` stops it navigating away). The same origin
  serves the agent's inline widgets (D334, `widget.html` / `widget.js`: no network at all;
  `src/extensions/agent/view/widgetCard.ts`).
- `notebookPage.ts` (D295): a VS Code controller's notebook (its kernel has `messaging`) gets one
  output page, as VS Code's back-layer webview: `notebook.html` / `notebook.js` on the same
  origin, laid over the cell list (`.nb-page-frame`, after the cells; `view.ts` keeps it there:
  a moved frame reloads). It runs every extension's `notebookPreload` for the notebook's type
  first (their `postKernelMessage` / `onDidReceiveKernelMessage` are the controller's
  `onDidReceiveMessage` / `postMessage`), then draws each output an extension's renderer takes,
  Jupyter widgets included (`rendererFor(…, { widgets: true })`), over the slot its cell keeps
  (`.nb-page-slot`, as tall as the page reports). VS Code's renderer API there: `activate(ctx)`
  with `postMessage`, `onDidReceiveMessage`, `getRenderer`, `getState` / `setState`,
  `workspace.isTrusted`, `settings`; `renderOutputItem(item, element, signal)` with `json()`,
  `text()`, `data()`, `blob()`; `disposeOutputItem(id)`; a renderer's
  `vscode.fallbackToNextRenderer` falls back to the output's text. The frame's clip path is the
  slots' visible rectangles (`notebookPageModel.ts`, tested), so it takes the pointer there only.
  One page rather than shared frames: Jupyter's renderer reaches its preload's widget manager
  through `window`. The IDE's own kernels keep their frames and widgets (`widgets.ts`). Outputs
  that run code with no extension renderer (HTML with scripts, JavaScript, Plotly, Bokeh) are
  drawn by the page itself (`BUILTIN_RENDERER`, notebook.js), in its window as in VS Code. The
  controller's `rendererScripts` run after the preloads; the page loads VS Code's webview
  addresses (`https://file%2B.vscode-resource.vscode-cdn.net/…`, a controller's `asWebviewUri`:
  Jupyter's widget modules) by asking the IDE (`resource` → the kernel's `readResource`: its
  extension's folder or the workspace's) and makes blobs of them (`resourcePathOf`, tested).
- `notebookContext.ts`: VS Code's notebook context keys (`core/notebook/contextKeys.ts`) set by
  the focused notebook, else the active tab's, and cleared when it goes: extensions'
  keybindings and menus test them (Jupyter Keymap's A / B in command mode only:
  `notebookEditorFocused && !inputFocus`, where inputFocus is true in a cell's editor). Cell
  menus get the cell's own (`notebookCellType` markup / code, `notebookCellResource`…); the
  toolbar and cell buttons are drawn again when a key their extensions' `when` tests changes.
- `widgets.ts` (D189): `WidgetStore`, the kernel's widget (comm) state per notebook — replayed to
  each frame, updated live, Output widgets capturing outputs, saved in the notebook's metadata.
- `diff.ts` (D189): notebooks compared cell by cell (the diff view uses it for any notebook type,
  reading both sides with its serializer).
- `cell.ts`: a cell, with an embedded engine editor created as it nears the screen; its toolbar,
  status row (run time, extensions' items, the cell's language, clickable) and the insert bar.
- `cellChrome.ts` (D204): the cell toolbar's buttons (run above / run and below for code, edit or
  stop editing for Markdown, split, extensions' buttons, "…", delete), the "…" menu (VS Code's
  cell menu) and the "+ Code / + Markdown" bar between cells.
- `toolbar.ts` (D204): the notebook toolbar (with extensions' `notebook/toolbar` buttons) and
  the kernel button; `notebookWhen` (the `when` context: `notebookType`, `notebookCellType`,
  `notebookCellLanguage`).
- `running.ts` (D204, from view.ts): `NotebookRunner`, the kernel and the run queue (choosing a
  kernel by itself, else the picker), outputs streaming in, display updates, input, variables.
- `view.ts`: the `notebook` dock view (cells, undo for cell operations, going to a cell, join /
  copy down / language / metadata / line numbers, the notebook events).
- `notebookFile.ts` (m7.12, from view.ts): the notebook's file: its format (waited for at
  startup), reading and writing, the metadata a save adds (kernelspec, widgets), and changes on
  disk (taken as they are, or the "Load the file / Keep mine" banner over unsaved edits).
- `cellHost.ts` (m7.12, from view.ts): what every cell is given (`CellHost`: its document's
  name, keys, outputs, links, images) and its toolbar / "…" menu state; the cell clipboard.
- `outputHost.ts` (D204, from view.ts): what cells show besides their text: output frames and
  extensions' renderers, Markdown images and links, extensions' status row items; outputs are
  drawn again when the folder's trust, the theme or the renderers change.
- `kernelPicker.ts` (D204): `notebook.selectKernel` (kernels, kernel sources' actions,
  `notebook/kernelSource` commands, "Enable the Jupyter extension", "Browse extensions for
  kernels"), `notebook.enableJupyter`, `notebook.browseKernelExtensions`.
- `cellCommands.ts` (D204): join, copy down, line numbers, cell language, stop editing,
  metadata, and `notebook.toggleSource` (the notebook ↔ its file's text in the same tab).
- `keys.ts`: the command-mode and cell-editor keys (Jupyter's / VS Code's), and the key labels
  the cell toolbar and menu show. D209: Shift+Up / Down (Shift+K / J) extend the selection,
  Ctrl / Cmd+A selects every cell, and run, delete, move, copy, cut, clear and type keys act on
  every selected cell (`ON_SELECTION`: those commands get `cellIds`).
- `selectionCommands.ts` (D209, VS Code's multi-cell selection; the model is
  `core/notebook/selection.ts`, tested): `notebook.selectCells` (Shift+click a cell outside its
  editor: a range from the anchor; Ctrl / Cmd+click: add or remove one), `notebook.joinSelectedCells`,
  and the block move / type change the cell commands use with several cells. The cell toolbar
  sits in a zero-height sticky dock (`.nb-toolbar-dock`), so it stays at the top of a cell taller
  than the screen.
- `cellDrag.ts`: cells dragged by their gutter (VS Code's drag handle; a line shows the gap,
  the list scrolls near its edges, Escape cancels). Dragging one of several selected cells moves
  all of them, in order, as one block; a click on a selected cell's gutter without a drag selects
  it alone. The drop runs `notebook.moveCellsTo` (one undo step; the math is
  `core/notebook/selection.ts` `dropSelected` / `dropGapAt`, tested). Shift+click on a cell's
  left edge (the gutter) extends the cell selection, in edit mode too.
- `hotExit.ts`: hot exit for notebooks (`files.hotExit`, the text editors' limits and pending
  bookkeeping from `editor/hotExit.ts`): a dirty notebook's backup (the editor's model as JSON,
  `model.ts` `notebookBackupText`) is kept in the folder's state under `notebook.hotExit` and put
  back, unsaved and undoable, when the folder opens; closing the window asks only about notebooks
  without one (over 2 MB; the 10 MB total is counted apart from text files'). A notebook whose
  file is gone opens, written with its format, as an untitled editor.
- `findBar.ts` (D204): find and replace across cells (Ctrl+F, in a cell too): sources and
  optionally outputs (`core/notebook/find.ts`), highlights in cell editors (engine
  `highlightRanges`) and in rendered Markdown / outputs (CSS highlights), replace all as one undo
  step.
- `language.ts` (D204): the view as a `NotebookLanguageSource` for the engine
  (`monaco/notebookLsp.ts` joins the code cells of the notebook's language into one document per
  language server: diagnostics in cells and Problems with the cell, hover, completion, signature
  help, definition, references, highlights, rename), while `notebook.languageServer.enabled`.
  D229 (`monaco/notebookLspRich.ts`): code actions (an edit for another cell is made there),
  formatting (a range request for the cell, else the document's edits inside it), inlay hints
  and semantic tokens (the joined document's, sliced per cell: `cellSemanticTokens`; m7.12:
  given as deltas, and an edit asks the other cells again only when their tokens changed);
  m7.12: a server edit across cells is clipped to each cell's part
  (`ConcatDocument.splitEdit`, a whitespace-blind line diff places the cell boundaries); an
  auto-import completion's edit for another cell runs as its command; a server's
  workspace/applyEdit on the joined document goes to the cells (`setJoinedEditHandler`); a save
  is the joined document's didSave, with its text when the server asks
  (`LanguageClient.joinedDocuments`). IPython beyond magics (`x = !ls`, `t = %time f()`,
  `obj?`, `??obj`) is masked in place (`maskMagics`), its diagnostics dropped.
- `breadcrumbs.ts` (D229): the notebook's breadcrumbs above its toolbar (`breadcrumbs.enabled`):
  the file's folders and file, then the selected cell's place in the outline (headings, the code
  cell); chrome.ts's `Breadcrumbs` with `symbols()` / `line()` from the view.
- `navigation.ts` (D204): the find, go-to-cell and outline commands; the active notebook as the
  Outline view's target (headings and code cells, `core/notebook/outline.ts`).
- `index.ts`: the built-in .ipynb type, the view type, the commands, `ide://notebook`, and kernel
  completions and hovers in cells. Also VS Code's `interactive` type (the Interactive Window:
  an untitled notebook the `vscode` shim's `interactive.open` makes; untitled notebooks run in
  the first folder; VS Code's input box under it isn't there yet), and the cell locator
  extensions' diagnostics for a cell document use (shown in that cell and in Problems).
  `notebook.read` with `metadata` also gives `nbformat` / `nbformatMinor` and cells'
  `attachments` (VS Code's ipynb layout for extensions).

**Commands:** `notebook.runCell`, `runAll`, `runAbove`, `runBelow`, `interrupt`, `restart`,
`restartAndRunAll`, `selectKernel`, `insertCell`, `insertMarkdown`, `editCell`, `deleteCell`,
`moveCell`, `changeCellType`, `splitCell`, `clearOutputs`, `clearAllOutputs`, `toggleOutput`,
`undo`, `redo`, `copyCell`, `cutCell`, `pasteCell`, `save`, `toggleVariables`, `variables`,
`read`, `exportScript`, `new`; D204: `find` (Ctrl+F; `replace` for Ctrl+H), `findNext`,
`findPrevious`, `replace`, `replaceAll`, `closeFind`, `revealCell`, `outline`, `enableJupyter`,
`browseKernelExtensions`, `joinCells` (Ctrl+Alt+J, Shift: with the previous), `duplicateCell`
(Shift+Alt+Down / Up), `toggleLineNumbers` (L, Shift+L), `previewCell` (Esc), `changeCellLanguage`,
`setMetadata`, `toggleSource`; `moveCellsTo` (drag and drop); D229: `formatCell` (the cell "…"
menu; Shift+Alt+F in a cell's editor) and `format` (Shift+Alt+F in command mode; m7.12: every
cell's formatted text is asked first, then set as one notebook undo step).

**Settings:** `notebook.output.scrolling`, `notebook.output.cdn`, `notebook.languageServer.enabled`,
`notebook.lineNumbers` (D204) (the Jupyter extension has `jupyter.pythonPath`).

**Events (D204):** `notebook.didOpen`, `didChange`, `didSave`, `didClose`, `didRunCell` on
`services.events` (extensions follow them with "fs.read").

**Other kernels (D204):** a Jupyter kernelspec of any language is listed (IRkernel, IJulia…);
its language id is lower-cased (IRkernel says "R"), R and Julia cells are colored (`r`, `julia`
grammars), the kernelspec and `language_info` are saved, and a notebook whose language has no
kernel installed asks for one instead of running on Python.

**State:** `ide://notebook` (D209: `selection`, the selected cells' ids; `selected` is the
focused one).

**Tests:** `notebook.test.ts`, `core/notebook/providers.test.ts`, `core/notebook/cells.test.ts`,
`core/extensions/rpcNotebooks.test.ts`, `tests/scripts/notebook-m6-89.jsonc`,
`tests/scripts/m6-90.jsonc`, `tests/scripts/notebook-ext-m7-3.jsonc` (an extension's format,
kernel, renderer, status items, buttons, picker action and events), `tests/scripts/notebooks-m7-5.jsonc`
(D204: outline, find, Pyright in cells) and `tests/scripts/notebooks2-m7-5.jsonc` (D204: built-in
.ipynb, cell toolbar and insert bar, join / copy down / line numbers / language / metadata, the
source toggle, the kernel picker without kernels, enabling the Jupyter extension),
`tests/scripts/notebook-m7-12.jsonc` (m7.12: after the view.ts split: save and read back, the
cell menu, replace all undone in one step).
