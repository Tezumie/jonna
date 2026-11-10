# extensions/editor

The `editor` dock view (`view.ts`): one Monaco editor per tab. `EditorService` owns documents —
one per file, shared by every tab showing it (a split edits the same model) — with dirty tracking
via Monaco's alternative version id, BOM and line-ending preservation, renames/deletes and paths
compared case-insensitively on Windows. `monaco/entry.ts` is the Monaco implementation of
`EditorEngine`, a separate bundle loaded after the shell paints (`engine.ts`); until it is ready a
tab shows the file's first lines as plain text. Grammars: Shiki's TextMate grammars on the
Oniguruma engine (WebAssembly; the JavaScript engine as fallback), one lazy chunk per language,
loaded while the file is read and the common ones while idle; `monaco/textmate.ts` hands their
encoded tokens to Monaco as VS Code does, with the theme's color map (D132). Extensions'
grammars (`monaco/grammarLoader.ts`, rules in `grammarRules.ts`) replace the editor's own for a
language (the last registered wins), injection grammars load before the grammars they target
(`injectTo`) — or join them in use, without a restart, when their extension comes later (and
leave when it goes) — and a grammar's includes of other scopes load first. A grammar's
`embeddedLanguages` and `tokenTypes` apply (VS Code's; the editor's own HTML, Markdown and PHP
grammars have VS Code's, `BUILTIN_SCOPE_RULES`): code in an embedded scope carries its
language, so comments, brackets and auto-closing pairs in a style tag are CSS's. Shiki compiles
grammars without them: `monaco/grammarInternals.ts` (tested against Shiki) makes a configured
copy and updates injection lists through vscode-textmate's own Grammar. Language detection
(`languages.ts`) follows VS Code: files.associations, a file name, the longest
`filenamePatterns` match, the longest extension, then `firstLine` (shebangs). An extension's
language-configuration.json merges over the editor's own (`monaco/contributedLanguages.ts`);
`semanticScopes.ts` maps semantic token types (and extensions' `semanticTokenScopes` /
`semanticTokenTypes` super types) to the theme's TextMate scopes. Theme: Shiki
dark-plus / light-plus (or any Shiki / VS Code color theme) + token colors (`theme.ts`, §15.1).

Settings (`settings.ts`): `editor.fontSize`, `tabSize`, `wordWrap`, `stickyScroll.enabled`,
`minimap.enabled`, `renderWhitespace` (each with a toggle command: `editor.toggleWordWrap`,
`toggleMinimap`, `toggleStickyScroll`, `toggleRenderWhitespace`, `toggleColumnSelection`), and `files.eol`, `files.trimTrailingWhitespace`,
`files.insertFinalNewline` (applied on save as one undoable edit, `settings.ts`). Right-click
shows the IDE menu with engine actions (`actions.ts`, D52). Tab icons are tinted by file type.

D140: `inlineDiagnostics.ts` writes problems after their line (`editor.inlineDiagnostics`);
`editor.formatDocument` and format on save try the project's formatter first (the view host's
`formatDocument`, Rust `format_project`, `editor.projectFormatters`, trusted folders only).

D279: `navigation.ts` — Go back / Go forward (`workbench.navigateBack` / `navigateForward`,
Alt+Left / Alt+Right, Ctrl+- / Ctrl+Shift+- on macOS, the mouse's back / forward buttons, the Go
menu, `workbench.clearNavigationHistory`) over `core/navigation`, recorded from the editors'
activity; the ← → buttons sit beside the title bar's search box or at the start of each tab strip
(`workbench.navigationControl.enabled` / `.location`); context keys `canNavigateBack`,
`canNavigateForward`, `navigationControlLocation`; state `ide://navigation`. Problems color file
names with their count in the explorer and on tabs (`problemCounts.ts`, tested;
`problems.decorations.enabled`). `editor.formatOnSaveMode` formats only the lines changed since
the git index (`EngineEditor.formatLines`, the range formatter); `editor.wrappingIndent`.

D143: `debugMarks.ts` draws breakpoints (glyph margin, `glyphMargin` on except in diff views)
and the debugger's stopped line from `services.debugMarks`, and reports margin clicks and moved
breakpoints; `gutterMarks.ts` does the same for other extensions' marks (bookmarks, right lane).

**Commands:** `editor.openFile` (`preview` for single-click opens), `editor.save` (Ctrl/Cmd+S),
`editor.saveAs`, `editor.saveAll`, `editor.closeTab`, `editor.closeAll`, `editor.focusTab`,
`editor.openReadOnly`, `editor.runAction`, `terminal.runSelectedText` (the selection, or the
line, in the most recent terminal). Tabs persist with the dock.

For extension pages (D184, D187): `editor.renderFile` (a file's first lines colored as the editor
colors them, and its icon, as self-contained markup; `renderFile.ts`) and `editor.renderMarkdown`
(Markdown as the preview draws it, with its stylesheet; `renderMarkdown.ts`).

Language services (D56): `monaco/core.ts` (editor + contributions), `monaco/languageFeatures.ts`
(TS/JS, JSON, CSS, HTML workers; tsx/jsx/jsonc), `jsonSchemas.ts` (settings.json, keybindings.json).
`problems.ts` / `problemsView.ts`: the `problems` tab and status-bar counts (D59).
`problemActions.ts`: problem text, the row context menu, the agent prompt (`problems.copy`,
`problems.fixWithAgent`, D129). `monaco/actionMenu.ts`: Monaco's code action list as the IDE's
menu (D129).
`formatterChoice.ts` (tested) + `monaco/formatterChoice.ts`: VS Code's `editor.defaultFormatter`
(per language; an extension's id, `builtin.language-servers` or `builtin.editor`) through Monaco's
FormattingConflicts selector — Format document, Format selection and format on save. Several
owners and none configured: "There are multiple formatters for '<language>' files…" (a dialog, or
a notice on a save), then a picker that saves the choice in `"[language]"` user settings. The
IDE's own formatters count as one owner. `formatWith.ts`: `editor.formatDocumentWith` /
`editor.formatSelectionWith` (VS Code's `editor.action.formatDocument.multiple` and
`formatSelection.multiple`; editor context menu): a picker of every formatter for the file, the
default marked, then "Configure default formatter…" (saves it and formats with it); agents pass
`formatter` (the owner id). They bypass `editor.defaultFormatter` and the project's formatter
(the selector returns the forced pick, `formatWithChosen`). Markers keep extensions' tags (faded, struck through),
code links and related places (`monaco/entry.ts` `toMarker`).
`monaco/providerContext.ts`: what an extension provider is asked about (untitled documents, notebook
cells with their text) and Monaco's cancellation as an AbortSignal.
`outlineView.ts`: the Outline sidebar view and `ide://editors/active/outline` (D113); hidden
from the activity bar, it becomes a section at the bottom of the Explorer (D129). Sort order, follow
cursor, collapse / expand all, a symbol's menu (D131: `outline.*`, `editor.select`).
`symbols.ts` (+ `monaco/fallbackSymbols.ts`): symbols for languages without a language service —
Markdown headings and declarations by line (D114).

`diskSync.ts`: reload from disk / "changed on disk" banner (D61): `editor.reloadFromDisk`,
`editor.keepLocalChanges`. The IDE's own saves echo back through the watcher; disk text equal to
what was last loaded or written is not an external change. A save re-reads the file first and
refuses to overwrite text it hasn't seen (the watcher was late, or can't watch a network drive):
the banner shows, and Keep my changes takes the disk text as the known one so the next save
writes. Saves of one document are queued (an auto save and Ctrl+S can't land out of order), and
the version saved is the one encoded, so typing during a save stays unsaved. `diskText.ts` (DOM-free, tested):
decoding (BOM, binary, invalid UTF-8, a UTF-16 BOM). A file that isn't valid UTF-8 opens read-only
with a banner and a "Reopen with encoding…" button; rewritten as UTF-8 elsewhere, it's read as
UTF-8 and becomes writable (D218: `diskText.ts` `utf8Again`, `EditorService.becameUtf8`, from the
watcher and `editor.reloadFromDisk`). `encodings.ts` (DOM-free, tested; D199): the
encodings offered, decoding with `TextDecoder`, encoding back (UTF-8 with or without BOM, UTF-16
LE / BE with BOM, single-byte code pages from tables built from the decoder; the multi-byte East
Asian ones through the Rust encoder, `encodingIpc.encode` / encoding_rs, D204).
Every WHATWG encoding is listed and can be saved (D204). `files.autoGuessEncoding` asks Rust's chardetng (`encodingIpc.guess`) about text that isn't
UTF-8 (`diskText.ts` `wantsGuess`, `DecodeOptions.guessed`); Reopen with encoding lists the
guess first. `fileFormat.ts`: `editor.changeEol`, `editor.selectEncoding`,
`editor.reopenWithEncoding`, `editor.saveWithEncoding`, behind the status bar's EOL and encoding
items. Emmet (`emmet.enabled`, `emmet.excludeLanguages`) comes from emmet-monaco-es, loaded on
first use (`monaco/languageFeatures.ts` `setEmmet`).

AI in the editor (`ai/`, D106, D172; off unless `editor.inlineEdit.enabled` /
`editor.inlineCompletions.enabled`): `editor.inlineEdit` (Ctrl/Cmd+K like Cursor, also in the
right-click menu; Ctrl+K chords with a modifier still work, see core/keybindings) opens a prompt
above the selected lines; the model's rewrite is shown change by change (`ai/hunks.ts`, tested):
each hunk's new lines highlighted, its old ones struck through above with Accept / Reject
(`editor.inlineEdit.acceptHunk` / `.rejectHunk`), and `editor.inlineEdit.accept` (Ctrl/Cmd+Enter)
keeps the rest, `editor.inlineEdit.reject` (Esc) undoes it all.
Ghost-text suggestions while typing with `editor.inlineCompletions.enabled` (Tab accepts). Models:
`editor.inlineEdit.model`, `editor.inlineCompletions.model` (empty: the agent's), generated through
`services.languageModel`. `ai/prompts.ts` builds prompts and cleans replies (tested).

Also: `editor.gotoLine` (Ctrl+G), `problems.show` (Ctrl/Cmd+Shift+M), `problems.list`,
`problems.copy`, `problems.fixWithAgent`.

Merge conflicts (`conflicts.ts`, `conflictCommands.ts`, `monaco/conflictLens.ts`, D120): lenses
and tints on `<<<<<<<` blocks, `editor.resolveConflict`. D204: the 3-way merge editor
(`mergeView.ts`, the `mergeEditor` tab; its descriptor, commands and state in `mergeCommands.ts`;
model `core/diff/merge.ts`): Incoming / Current (/ Base)
panes over the Result, which is the file's own document; per-conflict Accept incoming / current /
both / Ignore zones, scroll sync, counts; commands `git.openMergeEditor` (also a lens on every
conflict), `git.mergeEditor.accept` / `acceptAll` / `nextConflict` / `previousConflict` /
`toggleBase` / `reset`, `git.completeMerge` (save + `git.stage`); `ide://git/mergeEditors`.
D209: a sash between the inputs and the result; the panes' sizes kept with the tab
(`mergeLayout.ts`, tested; `git.mergeEditor.setLayout {split?, weights?}`); word highlights in the
result too (`MergeModel.resultLinesOf`); a delete / modify conflict opens with the changed side
and Keep the file / Delete the file (`mergeDeleted.ts`, `git.mergeEditor.resolveDeleted`).
D219: word highlights in the base (each side's changed words, in its color); a file both sides
added (no stage 1) opens split into one conflict per difference, common lines kept
(`computeMergeChanges`; `bothAdded` in the summary); the final newline merges three-way (one only
the incoming side added is kept); each file's last sizes open its next merge tab
(`MergeLayoutMemory`, workspace state key `editor.mergeLayouts`, 100 files).
D207: "Accept all" in the Incoming / Current headers (`git.mergeEditor.acceptAll`), draggable
sashes between the input panes (`inputShares` in the summary; double-click: equal widths), and
the words each side changed inside its changed lines (`core/diff/words.ts`, drawn with
`EngineEditor.highlightRanges` and a class of its own).
Stage texts come from the git extension's `gitStage:<n>` content source. Text before lines
(`EngineEditor.setLineAnnotations`, from `services.gutterMarks.annotate`) draws the file blame.
Hot exit (`hotExit.ts`, `files.hotExit`):
unsaved edits kept with the folder's state when the window closes. Closing still asks about what
has no backup (over the size limits, or no folder open); backups not applied yet stay saved, and one
that can't be applied opens as an untitled editor (D203).

Snippets (`userSnippets.ts`, D117): VS Code-format files in the user folder (`snippets/<language>.json`,
`*.code-snippets`), `.vscode/*.code-snippets` and `<workspace folder>/snippets/`, reloaded on save, joined with
extension snippets; `editor.configureSnippets` (Preferences → Snippets), state `ide://snippets`.
File paths in any text are Ctrl+click links when the file exists (`pathLinks.ts`,
`monaco/pathLinkProvider.ts`): `src/a.ts:12:5`, `"./logo.png"`, `C:\w\a.ts(3,7)`.

**State:** `ide://editors` (documents + tabs), `ide://editors/active`, `ide://diagnostics`.

Git integration (D66, D67): `quickDiff.ts` draws gutter bars (added / modified / deleted vs the git
index) from `services.quickDiff`, registers open documents as the text source for hunk staging and
adds "Stage change" / "Revert change" to the menu on changed lines. A click on a bar opens the diff tab at that line
(`editor.openDiff {path, line}`, D201). `diffView.ts` is the `diff` tab
(Monaco diff editor; working tree, staged, saved ↔ unsaved, another file, local history or an
agent's proposal) with `editor.openDiff`, `editor.compareWithSaved`, `editor.compareFiles` (D113).

The multi-file diff (D229, VS Code's multi-diff editor): `multiDiffView.ts` is the `multiDiff` tab,
one scrollable page with a collapsible diff per file (sticky headers with Open changes / Open
file). Each file's diff editor is an *embedded* one (`EngineDiffEditor` from
`createDiffEditor(host, { embedded: true })`: unchanged regions folded, no vertical scrollbar, as
tall as `contentHeight()`); it's created when the file comes within 800 px of the view
(IntersectionObserver) and let go when it's far (its height kept, unless it holds unsaved edits or
the caret). Working-tree files show the shared document (editable), staged ones HEAD ↔ index,
ranges two content sources. `multiDiff.ts` (tested): the state, each file's kind, placeholder
heights, whether a list changed, the scroll anchor and next / previous file. Commands:
`editor.openMultiDiff {title, files, source?, refresh?, background?}` (the same `source` reuses
the tab; Refresh runs `refresh`; `background` only updates an open tab of that source, without
activating it, D233: source control's changes tabs follow the status that way),
`editor.multiDiff.collapseAll` / `expandAll`, `editor.multiDiff.nextFile` / `previousFile`
`{tabId?}` (Ctrl+Alt+PageDown / PageUp while one is active, context key `activeMultiDiff`: the file
after or before the focused one, else the top of the view, its header focused). A new list keeps
the file at the top of the view, folds, unsaved edits and the focus. State:
`ide://editor/multiDiffs`. *Limits:* in an auxiliary window the lazy creation follows the main
window's observer.

Editor chrome (`chrome.ts`, D85): breadcrumbs above each editor (folders › file › symbols at the
cursor, from `EditorEngine.documentSymbols`; each segment opens a searchable menu of its siblings)
and a per-file status bar below it (this file's errors/warnings with a "Problems in this file"
list, Diff, Ln/Col, language). Settings `breadcrumbs.enabled`, `editor.fileStatusBar.enabled`. The main status bar also shows
the active editor's Ln/Col, indentation (`editor.selectIndentation`), encoding, EOL and language,
like VS Code (`state.ts`, setting `workbench.statusBar.editorInfo`, D204). The selection count
comes from `EngineEditor.selectionStatus()` (offsets, no copy of the text) and counts several
cursors as VS Code does ("3 selections (40 characters selected)", `selectionLabel.ts`, D207).
`editor.runAction {action, args?}` also runs Monaco commands without an action object (cursorMove,
deleteLeft…) with their arguments: a chord's second key passes its rule's `args` through it.

Closed files keep their engine model (the 20 newest, under 2 MB each) so text undo survives close
and reopen (D86). Since D218 such a model is closed for language servers (`setKeptClosed`,
`monaco/keptClosed.ts`): Problems lists what servers report for the closed file, and the engine's
`diagnostics()` leaves out the built-in checkers' markers on it.
`editor.openDiff` also compares a local-history version with the file (`version`).

More settings (D95): `files.autoSave` (afterDelay / onFocusChange / onWindowChange, with
`files.autoSaveDelay`; never untitled editors, D203; an auto save leaves the cursors' lines
untrimmed and runs no code actions on afterDelay, as VS Code), `editor.formatOnSave`, `editor.insertSpaces`, `editor.fontFamily`,
`editor.lineNumbers`, `editor.rulers`, `editor.bracketPairColorization.enabled`; `files.exclude`
hides files in the explorer.

Untitled files (`untitled.ts`, `untitledCommands.ts`, D126): `workspace.newUntitledFile` (Ctrl/Cmd+N),
`editor.saveUntitled`; `EditorService.createUntitled` / `adopt`. `workspace.newUntitledFile { path }`
(the user's only; the command line's file that doesn't exist yet): `untitled:<absolute path>`,
named after the file, saved there without asking (`untitledTarget`).

Remembered positions (`positions.ts`, D190): each file's scroll position and cursor, per
workspace (the 500 most recent, `editor.positions` in the workspace state), restored when the file
opens in a new tab; a line asked for wins. Files from outside the open folder open when the user
opens them (`fsIpc.allowFile`, that file only).

Auto-closed tags (D192): `closeTags.ts` decides whether a typed `>` ends an opening tag; the Monaco
editor inserts the closing tag after the cursor (`editor.autoClosingTags`). The active editor's
state includes `wordAtCursor`, which seeds Find in files with `search.seedWithNearestWord`.

Next-edit suggestions (D193): `ai/nextEdit.ts` (off unless `editor.nextEdit.enabled`) asks its
model after a change and a pause; `ai/nextEditPrompt.ts` builds the prompt and parses
the reply (tested). Tab goes to the suggestion, Tab applies it, Esc dismisses it
(`editor.nextEdit.suggest`, `editor.nextEdit.accept`, `editor.nextEdit.dismiss`). Model:
`editor.nextEdit.model` (empty: the chat's default model).

Suggestions as you type (D106, D204): `ai/completions.ts` (off unless
`editor.inlineCompletions.enabled`) is the engine's `InlineCompletionSource`: fill-in-the-middle
through `languageModel.fill` (the agent's service picks the endpoint: `core/agent/completionModels.ts`,
Rust `ai/fim.rs`) with the chat prompt as fallback; `ai/fim.ts` builds both prompts inside the
token budget and shapes the reply (one line mid-line, `maxLines` at a line's end; FIM tokens cut);
`ai/context.ts` ranks snippets of other open files (Jaccard over line windows) and recent edits
(`RecentEdits`, kept only while on). Settings: `editor.inlineCompletions.model` (empty: a small
local code model when installed, else the agent's), `.fim` (auto/always/never), `.maxTokens`,
`.maxLines`, `.contextTokens`, `.context`, `.debounceMs`. Commands: `editor.inlineSuggest.trigger`
(Alt+\), `.accept` (Tab), `.acceptWord` (Ctrl+Right), `.acceptLine`, `.hide`. State:
`ide://editor/inlineCompletions` (model, why it was picked, FIM endpoint, limits, last request).
Tested: `ai/fim.test.ts`, `tests/scripts/ghost-m7-5.jsonc`.

D224: `ai/cache.ts` — `LruMap` and `GhostTextCache` (suggestions by file, model, the prefix's
last 1000 characters and the suffix's first 400; typing through a suggestion gets its rest from
the engine's `InlineCompletionSource.cached` with no pause and no request; Alt+\ always asks).
Next-edit suggestions keep predictions in an `LruMap` keyed by the exact prompt
(`editor.nextEdit.suggest` asks anew); state `ide://editor/nextEdit`. `ai/imports.ts` —
`parseImports` / `resolveImport` / `importSnippetText` / `ImportGraph`: local imports (TS / JS,
Python, Rust `mod`, C `#include "…"`) resolved to the folder's files (read through `fsIpc`,
open editors' text first, cached until a file event), their declarations of the imported names as
`kind: "import"` snippets in `rankSnippets`. `ai/tokens.ts` — `tokenizerProfile(model)` and
`estimateTokens` / `charsPerToken` (a pre-tokenizer-shaped estimate per tokenizer family; the
prompt budget uses the measured ratio). D229: a bracket or quote the editor closed after the
cursor no longer asks again (the cached rest, one line, without its own closers); imports follow
the root tsconfig.json / jsconfig.json `paths` (`tsconfigAliases`, `aliasBases`), a package's
typings (`node_modules/<pkg>` `types`, index.d.ts, `@types/…`) and re-exports (`export * from`,
barrels) up to three files deep. Tested: `ai/cache.test.ts`, `ai/imports.test.ts`,
`ai/tokens.test.ts`, `tests/scripts/ghost-text-m7-7.jsonc`.

m7.12: **coming back to a spot shows its suggestion.** Monaco asks its providers again only after
typing, pasting, and Backspace / Delete run as commands in an editor with the text focus, or on
any edit while a suggestion session is active. Ctrl+Backspace, cut, undo / redo, or a delete
after the suggestion was dismissed (Esc, an arrow, a click, accepting) left the cached one unshown.
`monaco/zones.ts` now watches every editor's edits: after a pure deletion, undo or redo, when
`InlineCompletionSource.hasCached` (`GhostTextCache.peek`, uncounted) has a suggestion for the
cursor's spot, it calls the inline-completions controller's `trigger()` (not explicit, so the
provider answers from the cache, with no pause and no model request). The decision is
`editMayReturnToSuggestion` (`ai/cache.ts`, tested). **Import context from the language server:**
when a running server has the file open and offers definitions, `completions.ts` gives
`ImportGraph.snippets` a `DefinitionLookup`. Each imported name is asked about with
`textDocument/definition`: in its import statement (`importSites`), or where the file uses
`ns.member`. The lookup has a 700 ms limit, cancels on the next key and caches answers per
position for 30 s or until a file changes. The declarations at the lines it answers
(`declarationsAt`) become the snippets, so path aliases, re-exports, packages and Python's
site-packages resolve as the server sees them. Names it doesn't place (no answer, a timeout, the
file itself) go through the regex resolution as before. `ide://editor/inlineCompletions` `last`
has `importsVia` (`server` / `regex`).

Vim mode (D196): `editor.vimMode` (off by default) or `editor.toggleVimMode` turns on monaco-vim
in each editor (`monaco/widgets.ts` `setVim`, loaded on first use; not in embedded editors). Its
status line sits at the bottom left of the editor (`.vim-status`); `:w`, `:q`, `:wq` and `:x` run
`editor.save` and `editor.closeTab`. `build.mjs` resolves monaco-vim to its ES module and its
`monaco-editor/esm/vs/…` imports to the same Monaco files the IDE uses.

D200: `files.encoding` / `files.autoGuessEncoding` (`diskText.ts` `DecodeOptions`, `guessUtf16`);
`editor.codeActionsOnSave` (`settings.ts` `codeActionsOnSave`; run through the language servers
and awaited, `monaco/lsp.ts` `runCodeActionsOnSave`); `diffSettings.ts` (`diffEditor.*`, the
toggles in each diff toolbar's ⋯ menu); `languageConfiguration.ts` (extensions'
`language-configuration.json` → the editor's language configuration, tested); pull diagnostics
and linked editing from language servers (`monaco/lsp.ts`).

D201: settings per language. `settings.ts` `editorSettings(settings, language)` reads through
`SettingsService.peekForLanguage` (the `"[python]": {…}` blocks win); `EditorService` asks with the
document's language for save transforms, `files.encoding` and new files' line ending, and gives
the engine `setOptions(plain, forLanguage)`. `MonacoEditor.applyOptions` uses the shown model's
language (again on Change language mode); tab size and spaces go on the model
(`applyIndentation`, `detectIndentation` with the language's defaults) because Monaco's editor
option sets them for every model. `editor.formatOnSave` and `editor.codeActionsOnSave` are read per
document. `files.associations` (`languages.ts` `associatedLanguage`, tested): a pattern with a `/`
against the path, else the name, ignoring case; checked before the built-in and contributed
languages, so syntax, settings, language servers (by language) and icons follow it. Changing it
re-detects open files whose language came from detection (`documents.didOpen` again, so the
server starts); `monaco/lsp.ts` opens or closes a model in a server when its language changes.
`ide://editors/active` has `indentation`.

D204: `monaco/lspPull.ts` (semantic tokens with deltas and ranges, workspace pull diagnostics as
markers of their own owner on files not open), `monaco/semanticStyling.ts` (semantic token types
colored through TextMate scopes, `editor.semanticHighlighting.enabled`), `monaco/keybindings.ts` +
`engineKeybindings.ts` (Monaco's default keys listed in the shortcuts editor; the user's rules for its
commands applied as Monaco user rules), multi-byte encodings written by Rust (`encodeText`).

Document colors from language servers: `monaco/lsp.ts` registers `textDocument/documentColor` /
`colorPresentation` with the engine's color provider (swatches and picker) for a server's languages
other than css, scss, less, json and jsonc, which Monaco's own CSS and JSON services already color
(`core/lsp/colors.ts`).

Extensions' editor hooks (`extensionHooks.ts`, `monaco/typeOverride.ts`; registry
`workbench/extensionHooks.ts`): an extension that overrides the `type` command (Vim keymaps) gets
what's typed in every full editor (Monaco's "type" command, re-registered while it owns typing;
when its handler fails the editor types the text); `hooks.typeDefault` (the owner's
`default:type`: the editor's own typing; `editor.typeDefault {text}` is the user's command for it); its cursor style
(`ide.editor.setOptions`) over `editor.cursorStyle` (`withExtensionCursor`); and its
`onWillSaveTextDocument` edits, applied to the document before codeActionsOnSave and formatting
(1.5 s each, `runWillSave`). The notebook editor awaits `onWillSaveNotebookDocument` listeners
before it serializes (`notebook/view.ts` `save`).

**Multi-root workspaces** (D251): a file in any folder is a workspace file (no "outside file"
scope widening for it; agents' and extensions' editor actions, Save as, text commands and
rendered files accept it). Per-file options (tab size, word wrap, rulers, format on save, code
actions on save, auto save, encoding, eol, trim whitespace…) come from the file's folder:
`editorSettings(settings, language, path)` → `peekForLanguageAt`, and the engine's per-language
options callback gets the shown document's path. Breadcrumbs start with the folder's name; paths
in `ide://editors`, `ide://diagnostics`, `ide://editor/multiDiffs` are `workspace.relative`
(folder name first). Every folder's settings.json (its `.vscode` one too) gets the workspace
settings schema; `.code-workspace` files are JSONC with their own schema
(`workspaceFileSchema.ts`). Snippets are read from every folder; `editor.configureSnippets
{folder}` creates project snippets in the active file's folder (else asks). `folderChoice.ts`
(DOM-free part tested) is the shared "which folder" rule. Tabs of a folder taken out of the
workspace close (dirty ones ask): `registerCloseRemovedFolders` (workbench/followRenames.ts).

D393: `fileRules.ts` (`EditorFileRules`, given to the views as `fileRules`) decides what applies
to a file beyond its document: read-only by `files.readonlyInclude` / `files.readonlyExclude` /
`files.readonlyFromPermissions` or the session's override (`readOnlyFiles.ts`, tested; the view
calls `EngineEditor.setForcedReadOnly`, `EditorView.readOnly` is the answer for commands), and
secret values covered with `editor.hideSecrets` in `editor.secretFiles` (`secretValues.ts`,
tested; `EngineEditor.setSecretMask`, uncovered on the cursor's lines). `fileRuleCommands.ts`:
`editor.setReadOnlyInSession`, `editor.setWritableInSession`, `editor.toggleReadOnlyInSession`,
`editor.resetReadOnlyInSession` (VS Code's `workbench.action.files.*ReadonlyInSession`), the
status bar's lock (`editor.readOnly`), `editor.pasteFromHistory` (Ctrl+K Ctrl+V; the entry
selected is previewed in a zone below the cursor) and `editor.clearClipboardHistory`.
`clipboardHistory.ts` (tested): the last 30 copies and cuts in any editor (`EngineHost.copied`,
from the keyboard's copy and cut events and the menu's), in memory only. `ide://editors/active`
has `readOnly`.
