// The editor engine boundary: the interface the IDE codes against (Monaco implements it in
// monaco/), the on-demand loader of the engine bundle, and the host the engine calls back into.

import type { LineMark } from "../../core/diff/index";
import type { Event } from "../../core/events/index";
import type { ProviderQuery } from "../../core/extensions/providerQuery";
import { fsIpc } from "../../core/ipc/fs";
import { clipboardIpc } from "../../core/ipc/system";
import type { KeybindingRule, Platform } from "../../core/keybindings/index";
import type { Disposable } from "../../core/lifecycle/index";
import type { LanguageClient } from "../../core/lsp/client";
import { showDialog } from "../../ui/Dialog";
import { showMenu } from "../../ui/Menu";
import type { BreakpointGlyph } from "../../workbench/debugMarks";
import type { EditorDecoration, LanguageFeature } from "../../workbench/extensionFeatures";
import type { GutterMark, LineAnnotation } from "../../workbench/gutterMarks";
import type { WorkbenchServices } from "../../workbench/services";
import { editorClipboard } from "./clipboardHistory";
import {
  analyzeFormatters,
  type FormatterOption,
  formatterRows,
  pickFormatterPlaceholder,
  sameFormatterId,
} from "./formatterChoice";
import { decodeFile } from "./service";

// The editor engine contract. `EditorService` (service.ts) owns documents, dirty state and saving;
// each editor tab (view.ts) owns one engine editor. Both talk only to these interfaces; Monaco is
// one implementation (monaco/entry.ts), loaded lazily. Documents are shared: two tabs on the same
// file (a split) edit one model.
export interface Position {
  line: number;
  column: number;
}

export interface SelectionRange {
  start: Position;
  end: Position;
}

export interface ActiveEditorState {
  cursor: Position;
  selections: SelectionRange[];
  visibleRange: { startLine: number; endLine: number };
  selectedText: string;
  /** The word at (or touching) the cursor, "" if none (D192: seeds the search view). */
  wordAtCursor?: string;
}

export interface SelectionStatus {
  cursor: Position;
  /** Cursors / selections (1 for a plain cursor). */
  selections: number;
  /** Characters inside all selections together. */
  characters: number;
}

export type LineEnding = "\n" | "\r\n";

export interface EngineDocument extends Disposable {
  readonly path: string;
  readonly languageId: string;
  readonly readOnly: boolean;
  /** Line ending the text uses (detected on load; new files are LF). Saving keeps it. */
  readonly eol: LineEnding;
  /** Changes every line ending (one undoable edit; D199). */
  setEol(eol: LineEnding): void;
  readonly lineCount: number;
  /** Indentation of this file (detected on open, or the editor.tabSize/insertSpaces settings). */
  indentation(): { insertSpaces: boolean; tabSize: number };
  setIndentation(options: { insertSpaces?: boolean; tabSize?: number }): void;
  getText(): string;
  /** Replaces the whole text as one undoable edit (save-time fixes like trimming whitespace). */
  replaceText(text: string): void;
  /**
   * The text as the language's formatter would leave it, without changing the document (null:
   * no formatter, or it failed). Format notebook collects every cell's this way and applies them
   * as one notebook undo step.
   */
  formattedText?(): Promise<string | null>;
  /** Monotonic id that returns to an earlier value on undo; compare to the saved id for "dirty". */
  readonly versionId: number;
  readonly onDidChangeContent: Event<void>;
  /** Quick-diff gutter bars (added / modified / deleted vs the git index), replacing earlier ones. */
  setLineMarks(marks: readonly LineMark[]): void;
  /**
   * The file was closed and this model is kept for undo (true), or it was opened again (false):
   * language servers see the file closed meanwhile (D218).
   */
  setKeptClosed?(kept: boolean): void;
}

/** One visible editor (one per editor tab). */
export interface EngineEditor extends Disposable {
  /** Shows `doc` (restoring this editor's view state for it), or nothing. */
  setDocument(doc: EngineDocument | null): void;
  focus(): void;
  layout(): void;
  /** The top of the viewport as a fractional 0-based line (12.5 = halfway into line 13). */
  scrollLine(): number;
  /** Scrolls so fractional 0-based `line` is at the top (preview → editor scroll sync). */
  scrollToLine(line: number): void;
  /** Cursor/selection/scroll of the shown document. */
  activeState(): ActiveEditorState | null;
  /**
   * The primary cursor, the number of selections and the characters they cover, without copying
   * the selected text (the status bar asks on every cursor move).
   */
  selectionStatus(): SelectionStatus | null;
  /** Fires on cursor, selection and scroll changes. */
  readonly onDidChangeCursor: Event<void>;
  /** Fires when the editor gains focus. */
  readonly onDidFocus: Event<void>;
  /**
   * Right-click (or the context-menu key) in the text; client coordinates. The IDE shows its
   * menu. `gutterLine`: the click was in the breakpoint margin, on that line.
   */
  readonly onContextMenu: Event<{ x: number; y: number; gutterLine?: number }>;
  /**
   * Runs an engine action or command (e.g. "editor.action.rename", "cursorMove") with optional
   * arguments (a keybinding's `args`). False if it doesn't exist here.
   */
  runAction(id: string, args?: unknown): Promise<boolean>;
  /**
   * Tried first by "Format document" (Shift+Alt+F, the menu, format on save): the project's own
   * formatter (D140). Resolves true when it handled the file.
   */
  setFormatOverride(format: (() => Promise<boolean>) | null): void;
  /**
   * Asked first on Ctrl/Cmd+Z (redo: Ctrl+Y, Ctrl/Cmd+Shift+Z) in the text and Edit → Undo /
   * Redo: true when it handled the key (it undid or redid a whole workspace operation, or the
   * user cancelled) — D141. Must answer false
   * synchronously when it doesn't apply, so plain undo stays instant.
   */
  setUndoOverride(undo: ((how: "undo" | "redo") => boolean | Promise<boolean>) | null): void;
  // ---- Debugging (D143) ----
  /** Breakpoint dots in the glyph margin (replacing earlier ones). */
  setBreakpoints(marks: readonly BreakpointGlyph[]): void;
  /** Where the breakpoint dots are now (edits move them), in the order they were set. */
  breakpointLines(): number[];
  /** The line the debugger stopped at (arrow + highlight), or null. */
  setExecutionLine(line: number | null): void;
  /** A click in the glyph margin (left of the line numbers): its 1-based line. */
  readonly onGutterClick: Event<number>;
  /** A click on a line's change bar (quick diff, D201): the line. */
  /** A click on a change bar; `staged`: a dimmed one (the change is staged). */
  readonly onChangeBarClick: Event<{ line: number; staged: boolean }>;
  /** `owner`'s marks in the margin (bookmarks…), replacing its earlier ones. */
  setLineMarks(owner: string, marks: readonly GutterMark[]): void;
  /** Where `owner`'s marks are now (edits move them), in the order they were set. */
  lineMarkLines(owner: string): number[];
  /** Text before lines' code (the file blame, D204), replacing the earlier set; [] clears. */
  setLineAnnotations(items: readonly LineAnnotation[]): void;
  /** Moves the cursor to line:column (1-based) and scrolls it into view. */
  revealPosition(line: number, column: number): void;
  /** Selects a range (1-based, end exclusive like the engine) and scrolls it into view. */
  select(range: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  }): void;
  /** True if the action exists and its precondition holds (e.g. a definition provider exists). */
  actionSupported(id: string): boolean;
  /**
   * Formats only these lines (1-based) with the language's range formatter (format on save's
   * "modifications" mode, D279); false when there's no range formatter.
   */
  formatLines(ranges: readonly LineRange[]): Promise<boolean>;
  /**
   * The formatters that can format the shown document (`file`) or its selection, in the engine's
   * order: what "Format document with…" lists (VS Code's editor.action.formatDocument.multiple).
   */
  formatters(kind: "file" | "selection"): FormatterOption[];
  /**
   * Formats the document or the selection with the `index`th of `formatters(kind)`, whatever
   * editor.defaultFormatter or the project's formatter say. False when it can't (gone, read-only).
   */
  formatWith(kind: "file" | "selection", index: number): Promise<boolean>;

  /** Types `text` at every cursor (replacing selected text) as one undoable edit. */
  insertText(text: string): void;
  /**
   * Keeps the text read-only even when its document is writable (a session's "Set active editor
   * read-only", files.readonlyInclude); false: as the document allows.
   */
  setForcedReadOnly(readOnly: boolean): void;
  /** Covers secret values (editor.hideSecrets) except on the cursor's lines; false: none. */
  setSecretMask(on: boolean): void;

  // ---- Inline edits (D106) ----
  /** The lines the selection covers (the cursor's line when nothing is selected); 1-based. */
  selectedLines(): LineRange | null;
  /** Lines `range` as text (joined with "\n"). */
  linesText(range: LineRange): string;
  /** Replaces the lines of `range` with `text` as one undoable edit; returns the lines it now covers. */
  replaceLines(range: LineRange, text: string): LineRange;
  /** Puts `node` between lines, after `afterLine` (0: above the first), `heightPx` tall. */
  addZone(afterLine: number, node: HTMLElement, heightPx: number): EditorZone;
  /** A whole-line background (`className`) on the lines of `range`. */
  decorateLines(range: LineRange, className: string): Disposable;
  /** Faint text after the end of `line` (inline blame, D127); the cursor skips it. */
  annotateLine(line: number, text: string, className: string): Disposable;
  /** Keys pressed in the text, before the editor acts on them (`preventDefault` takes the key). */
  readonly onKeyDown: Event<EditorKeyEvent>;
  /** Line height in pixels (zones are sized in lines). */
  lineHeight(): number;
  /** A popup of its own is open (suggestions, find, hints) or it has several cursors. */
  hasOpenWidget(): boolean;
  /** Tab means something to the editor now (ghost text, a snippet's next field), D193. */
  tabTaken?(): boolean;
  /** `owner`'s highlighted ranges (find matches in a notebook cell, D204), replacing its earlier ones. */
  highlightRanges?(owner: string, ranges: readonly HighlightRange[]): void;
  /** Line numbers in an embedded editor (a notebook cell's "Show cell line numbers", D204). */
  setLineNumbers?(on: boolean): void;
  /** The height its text needs (an embedded editor is sized to it). */
  contentHeight(): number;
  /** Fires when `contentHeight` changes. */
  readonly onDidChangeContentHeight: Event<number>;
}

/** A highlighted range (1-based, end column exclusive); `current`: the match being shown. */
export interface HighlightRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  current?: boolean;
  /** Its own class instead of the find-match look (the merge editor's changed words). */
  className?: string;
}

/**
 * A notebook whose code cells language servers see as one document (D204, VS Code's
 * concatenated document): the engine joins the cells, maps positions back to each cell's
 * document, and reports diagnostics per cell.
 */
export interface NotebookLanguageSource {
  /** The notebook file. */
  readonly path: string;
  /** The code cells' language ("python"). */
  languageId(): string;
  /** Every cell in order (only code cells are joined). */
  cells(): readonly { id: string; kind: "code" | "markdown" | "raw"; text: string }[];
  /** Cells were added, removed, moved, retyped or edited. */
  readonly onDidChange: Event<void>;
  /** A cell's document, created (with its editor) when it has none yet; null: no such cell. */
  documentFor(cellId: string): EngineDocument | null;
  /** Shows a position in a cell (go to definition into another cell). 1-based. */
  reveal(cellId: string, line: number, column: number): void;
}

/** Lines `startLine`..`endLine`, 1-based and inclusive. */
export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface EditorZone extends Disposable {
  setHeight(px: number): void;
  /** Moves it after another line (the lines above changed). */
  moveTo(afterLine: number): void;
}

export type { BreakpointGlyph };

export interface EditorKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault(): void;
}

/** Ghost-text completions at the cursor (D106). */
export interface InlineCompletionSource {
  /** Text to insert at the cursor, or null. Asked after typing pauses; `signal` aborts on the next key. */
  complete(request: {
    path: string;
    languageId: string;
    prefix: string;
    suffix: string;
    /** The cursor's line (1-based). */
    line?: number;
    signal: AbortSignal;
  }): Promise<string | null>;
  /** How long typing must pause before asking (default 350 ms). */
  delayMs?(): number;
  /**
   * A suggestion known without asking (D224: the rest of one the user is typing through, or one
   * asked at this spot before): shown at once, no pause, no request. Undefined: ask (`complete`);
   * null: known to have none. Not used when the suggestion is asked for explicitly.
   */
  cached?(request: { path: string; prefix: string; suffix: string }): string | null | undefined;
  /**
   * Whether `cached` has a suggestion to show here, without counting it (m7.12): after a delete,
   * undo or redo the editor asks again only then (no model request comes of it).
   */
  hasCached?(request: { path: string; prefix: string; suffix: string }): boolean;
}

/** A document symbol (class, function, heading…) for breadcrumbs and the outline. 1-based. */
export interface OutlineSymbol {
  name: string;
  /** Lower-case kind: "class", "function", "method", "property", "variable", "string"… */
  kind: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  children: OutlineSymbol[];
}

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

export interface Diagnostic {
  path: string;
  severity: DiagnosticSeverity;
  message: string;
  /** e.g. "ts", "json", "css". */
  source: string | undefined;
  code: string | undefined;
  /** Set for problems from outside the language services (a task's problem matcher, D134). */
  external?: boolean;
  /** In a notebook (`path`), the cell it's in: its id and position (0-based); lines are the cell's (D204). */
  cell?: { id: string; index: number };
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  /** "unnecessary": drawn faded; "deprecated": struck through (VS Code's DiagnosticTag). */
  tags?: readonly ("unnecessary" | "deprecated")[];
  /** A web page about `code` (its link in the hover). */
  codeTarget?: string;
  /** Other places that explain it (VS Code's relatedInformation). */
  related?: readonly {
    path: string;
    message: string;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
  }[];
}

export interface JsonSchemaAssociation {
  /** Schema id (any unique URI). */
  uri: string;
  /** Absolute file paths the schema applies to. */
  files: readonly string[];
  /** Glob patterns over file URIs as well (an extension folder's extension.json, say). */
  patterns?: readonly string[];
  schema: unknown;
}

/** Editor settings (editor.* in settings.json), applied live to every editor. */
export interface EditorOptions {
  fontSize: number;
  tabSize: number;
  wordWrap: "off" | "on";
  stickyScroll: boolean;
  minimap: boolean;
  renderWhitespace: "none" | "boundary" | "selection" | "all";
  insertSpaces: boolean;
  /** CSS font-family; empty: the IDE's monospace font. */
  fontFamily: string;
  lineNumbers: "on" | "off" | "relative";
  rulers: number[];
  bracketPairColorization: boolean;
  /** Typing `>` after `<tag …` inserts `</tag>` in HTML-like files (D192; default on). */
  autoClosingTags?: boolean;
  /** Vim key bindings (D196; default off). */
  vimMode?: boolean;
  /** The breakpoint margin (default on; off for diff views and inline editors). */
  glyphMargin?: boolean;
  /** More engine options by path (advancedSettings.ts, D128), merged over the IDE's own. */
  advanced?: Record<string, unknown>;
  /** Diff views (diffEditor.*, D200). */
  diff?: DiffOptions;
}

/** VS Code's diffEditor.* settings that diff views follow (D200). */
export interface DiffOptions {
  /** Side by side (else inline); a narrow view goes inline anyway. */
  sideBySide: boolean;
  /** Leading and trailing whitespace changes don't count. */
  ignoreTrimWhitespace: boolean;
  /** Long unchanged stretches fold away. */
  hideUnchangedRegions: boolean;
}

/** Colors the engine needs, resolved from the design tokens (DESIGN.md §15.1). Hex strings. */
export interface EditorColors {
  [monacoColorId: string]: string;
}

export interface EditorTheme {
  kind: "dark" | "light";
  /** Syntax theme name, from `--syntax-theme` (Shiki "dark-plus" / "light-plus"). */
  syntax: string;
  colors: EditorColors;
  /** A color theme from an extension: its TextMate/VS Code JSON, loaded under `syntax`. */
  syntaxTheme?: unknown;
}

/** A language an extension contributes (D102; its grammars are ContributedGrammar's). */
export interface ContributedLanguage {
  id: string;
  extensions: readonly string[];
  filenames: readonly string[];
  aliases: readonly string[];
  filenamePatterns?: readonly string[];
  firstLine?: string;
  /**
   * language-configuration.json (D200), applied when the language is first used; for a language
   * the editor knows, merged over its own (VS Code's).
   */
  configuration?: () => Promise<unknown>;
}

/** A TextMate grammar an extension contributes: a language's, or an injection (`injectTo`). */
export interface ContributedGrammar {
  scopeName: string;
  language?: string;
  injectTo?: readonly string[];
  /** Scope → language id of code in it (VS Code's `embeddedLanguages`). */
  embeddedLanguages?: Readonly<Record<string, string>>;
  /** Scope → "string" | "comment" | "other" (VS Code's `tokenTypes`). */
  tokenTypes?: Readonly<Record<string, string>>;
  load(): Promise<unknown>;
}

/** Semantic token selectors → TextMate scopes from extensions (VS Code's semanticTokenScopes). */
export interface ContributedSemanticTokenScopes {
  language?: string;
  scopes: Readonly<Record<string, readonly string[]>>;
  superTypes?: Readonly<Record<string, string>>;
}

/** A snippet (VS Code's snippet format; body already joined with newlines). */
export interface ContributedSnippet {
  language: string;
  name: string;
  prefix: string;
  body: string;
  description: string;
}

export interface EditorEngine extends Disposable {
  /** Creates a document (text model) for `path`. Grammars load on demand. */
  /** Starts loading what a file of this path needs to show colored (its grammar), early. */
  warmLanguage?(path: string): Promise<void>;
  /** Drops models made only for previews of unopened files (peek views); the workspace closed. */
  disposePreviewModels?(): void;
  createDocument(
    path: string,
    text: string,
    options?: {
      readOnly?: boolean;
      eol?: LineEnding;
      /** A URI scheme other than "file" for extra copies (e.g. the git side of a diff). */
      scheme?: string;
    },
  ): EngineDocument;
  /**
   * Creates an editor inside `container`. `embedded`: a small editor inside a page (a notebook
   * cell, D188) — no minimap, margin or scrollbars of its own, as tall as its text.
   */
  createEditor(container: HTMLElement, options?: { embedded?: boolean }): EngineEditor;
  /**
   * A side-by-side diff inside `container`. `embedded`: one of several on a page (the multi-file
   * diff, D229) — unchanged regions folded, no vertical scrollbar of its own (the page scrolls),
   * as tall as its content (`contentHeight`).
   */
  createDiffEditor(container: HTMLElement, options?: { embedded?: boolean }): EngineDiffEditor;
  /**
   * Syntax-colored HTML for `code` in language `languageId` (spans with theme classes; the text is
   * escaped by the engine). Used for code blocks in Markdown previews.
   */
  colorize(code: string, languageId: string): Promise<string>;
  /** Language id for a fence tag or file extension ("ts" → "typescript"), or null if unknown. */
  languageFor(tag: string): string | null;
  /** Every known language (id and names). */
  languages(): { id: string; aliases: string[] }[];
  /** Switches a document's language (syntax colors load on demand). */
  setLanguage(doc: EngineDocument, languageId: string): void;
  /** Applies (or re-applies, on theme/accent change) the workbench theme to every editor. */
  applyTheme(theme: EditorTheme): Promise<void>;
  /** Languages from extensions (replaces the previous set). */
  setContributedLanguages(languages: readonly ContributedLanguage[]): void;
  /**
   * TextMate grammars from extensions (replaces the previous set): a language's replaces the
   * editor's own for it (the last one wins, as in VS Code); injections apply to the scopes they
   * name.
   */
  setContributedGrammars(grammars: readonly ContributedGrammar[]): void;
  /** Semantic token scopes from extensions (replaces the previous set). */
  setSemanticTokenScopes(list: readonly ContributedSemanticTokenScopes[]): void;
  /** Snippets from extensions (replaces the previous set). */
  setSnippets(snippets: readonly ContributedSnippet[]): void;
  /**
   * Language configurations extensions' code set (D258, VS Code's setLanguageConfiguration), in
   * language-configuration.json's shape: merged over what the language has.
   */
  setExtensionLanguageConfigurations(
    list: readonly { languageId: string; configuration: unknown }[],
  ): void;
  /** Diagnostics from the language services, for every open document. */
  diagnostics(): Diagnostic[];
  /** The document's symbols from the language providers (TS, CSS, JSON, LSP…); [] if none. */
  documentSymbols(doc: EngineDocument): Promise<OutlineSymbol[]>;
  /**
   * Every provider of a document asked at once, their answers merged (VS Code's
   * vscode.execute…Provider for extensions; core/extensions/providerQuery.ts has the shapes).
   */
  executeProvider?(query: ProviderQuery): Promise<unknown>;
  /** Fires with the paths whose diagnostics changed. */
  readonly onDidChangeDiagnostics: Event<readonly string[]>;
  /**
   * Problems from outside the language services (tasks' problem matchers, D134), shown as
   * squiggles in open files and files opened later; replaces `owner`'s previous set.
   */
  setExternalDiagnostics(owner: string, list: readonly Diagnostic[]): void;
  /** JSON schemas for files such as settings.json (validation, completion, hovers). */
  setJsonSchemas(schemas: readonly JsonSchemaAssociation[]): void;
  /** Emmet abbreviations in these languages (D199; empty: off). */
  setEmmet(languages: readonly string[]): void;
  /** Connects a running language client (providers, sync, diagnostics). */
  attachLanguageClient(client: LanguageClient): Disposable;
  /**
   * A notebook's code cells to the language clients of their language (D204): one joined
   * document per notebook, diagnostics in the cells and in `diagnostics()` (with `cell`), hover,
   * completion, definition, references, highlights and rename in the cells.
   */
  attachNotebook?(source: NotebookLanguageSource): Disposable;
  /**
   * editor.codeActionsOnSave (D200): runs these code action kinds from the document's language
   * servers and applies their edits, awaited (the save then writes the result).
   */
  codeActionsOnSave?(doc: EngineDocument, kinds: readonly string[]): Promise<void>;
  /** Applies editor settings to every editor, now and later; `forLanguage` gives a language's own (D201). */
  setOptions(
    options: EditorOptions,
    forLanguage?: (languageId: string, path?: string) => EditorOptions,
  ): void;
  /**
   * Errors the language services find in `text` as the content of `path` (agent edits, D107),
   * or null when no checker covers the language or it took longer than `timeoutMs`.
   */
  checkText(path: string, text: string, timeoutMs: number): Promise<Diagnostic[] | null>;
  /** Ghost-text completions for every language (null: off). */
  setInlineCompletions(source: InlineCompletionSource | null): void;
  /** Values on hover while the debugger is paused (null: off). */
  setDebugHover(source: DebugHoverSource | null): void;
  /** Third-party extensions' hover and completion providers, replacing the earlier set (D176). */
  setExtensionFeatures(features: readonly LanguageFeature[]): void;
  /** Third-party extensions' decorations, replacing the earlier set (D176). */
  setExtensionDecorations(decorations: readonly EditorDecoration[]): void;
  /** An extension's `type` override: typed text goes to `handler` (null: into the editor). */
  setTypeHandler?(handler: ((text: string) => void) | null): void;
  /** Types `text` as the focused editor would without the override (`default:type`). */
  typeDefault?(text: string): boolean;
  /** The engine's own default keybindings (Monaco's Ctrl+D, Alt+Up, Ctrl+/…; D204). */
  keybindings?(): EngineKeybinding[];
  /** Whether the engine has a command with this id (its keybindings.json rules go to it). */
  hasCommand?(id: string): boolean;
  /** The engine's editor actions (id, title), bound to a key or not. */
  actions?(): { id: string; title: string }[];
  /**
   * The user's keybindings.json rules for engine commands, replacing the earlier set; the engine
   * honours them (its own `when` contexts, "-command" removals). Returns rules it couldn't apply.
   */
  setUserKeybindings?(rules: readonly KeybindingRule[], platform: Platform): KeybindingRule[];
  /** Whether the focused editor has a binding for this key whose `when` holds now (D209). */
  handlesKey?(e: KeyboardEvent): boolean;
  /** The focused editor's command for a two-key chord whose `when` holds now, or null (D219). */
  chordCommand?(
    first: KeyboardEvent,
    second: KeyboardEvent,
  ): { command: string; args: unknown } | null;
}

/** A default keybinding of the engine (D204): `key` in keybindings.json form for this OS. */
export interface EngineKeybinding {
  command: string;
  key: string;
  when?: string;
  /** The rule's arguments (Monaco's `commandArgs`). */
  args?: unknown;
  /** The action's title, when it has one. */
  title?: string;
}

/** Evaluates a hovered expression for the debugger; null shows nothing. */
export type DebugHoverSource = (q: { path: string; expression: string }) => Promise<{
  value: string;
  /** An object's first properties. */
  children?: { name: string; value: string }[];
  /** It has more than those. */
  more?: boolean;
} | null>;

/** What the engine needs from the IDE (opening files from go-to-definition, peek previews). */
export interface EngineHost {
  /** Opens `path` in an editor tab at line:column (1-based). */
  openFile(path: string, line: number, column: number): void;
  /** A file's text (for peek previews of files that aren't open); null if unreadable. */
  readFile(path: string): Promise<string | null>;
  /** The system clipboard (menu Cut/Copy/Paste must not depend on browser gesture rules). */
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  /**
   * Text copied or cut in an editor (Paste from history keeps it); `secret`: from a file whose
   * values are hidden (editor.hideSecrets), so the list doesn't show it (D407).
   */
  copied?(text: string, secret?: boolean): void;
  /** Opens files as documents (rename edits to files that aren't open). */
  openDocuments(paths: readonly string[]): Promise<void>;
  /** Whether a file exists (paths in text become links only then). */
  fileExists(path: string): Promise<boolean>;
  /**
   * The open folder, or null; with `path`, the workspace folder holding it (D251: a multi-root
   * workspace's, else the first folder).
   */
  root(path?: string): string | null;
  /** Runs an IDE command (code lens actions go through the dispatcher); resolves when it's done. */
  run(command: string, input: unknown): Promise<unknown>;
  /** Shows the IDE's menu at a window point (the code action list); `onClose` runs once. */
  showMenu(
    at: { x: number; y: number },
    items: readonly EngineMenuItem[],
    onClose: () => void,
  ): Disposable;
  /**
   * Which of the formatters formats `path` (VS Code's editor.defaultFormatter): the configured
   * one, the only one, or the user's pick, saved for the language (asked with a dialog, or a
   * notice when `silent`, a save). Undefined: nothing is formatted.
   */
  /**
   * VS Code's editor context keys for the editor that has the text focus (`editorTextFocus`,
   * `editorHasSelection`, `editorHasMultipleSelections`, `editorReadonly`, `editorLangId` in
   * VS Code's language ids): extensions' and imported keybindings test them.
   */
  setContext?(keys: Readonly<Record<string, string | boolean>>): void;
  chooseFormatter?(q: {
    path: string;
    languageId: string;
    languageName: string;
    formatters: readonly FormatterOption[];
    kind: "file" | "selection";
    silent: boolean;
  }): Promise<number | undefined>;
}

/** A row of an engine menu (a subset of the IDE's MenuItem). */
export interface EngineMenuItem {
  label: string;
  keybinding?: string;
  disabled?: boolean;
  separatorBefore?: boolean;
  run(): void;
}

/** A side-by-side diff (one per diff tab). The modified side may be an editable shared document. */
export interface EngineDiffEditor extends Disposable {
  setDocuments(original: EngineDocument | null, modified: EngineDocument | null): void;
  focus(): void;
  layout(): void;
  /** The cursor line on the modified side, or null. */
  modifiedLine(): number | null;
  /** Moves to the next/previous change. */
  goToChange(direction: "next" | "previous"): void;
  /** Scrolls the modified side to `line` (centered) and puts the cursor there (D201). */
  revealModifiedLine(line: number): void;
  /** Number of changed regions (once computed). */
  changeCount(): number;
  /** Fires when the diff was (re)computed. */
  readonly onDidUpdateDiff: Event<void>;
  /** The height its content needs, in pixels (the taller side; an embedded diff's own height). */
  contentHeight(): number;
  /** Fires when `contentHeight` changes (a region unfolded, the text changed). */
  readonly onDidChangeContentHeight: Event<void>;
  readonly onDidFocus: Event<void>;
  readonly onContextMenu: Event<{ x: number; y: number }>;
}

/** Loaded by `loadEditorEngine()`; the module is a separate esbuild entry (assets/monaco.js). */
export interface EditorEngineModule {
  createEngine(theme: EditorTheme, host: EngineHost): Promise<EditorEngine>;
}

// Loads the Monaco engine bundle (assets/monaco.js + monaco.css, a separate esbuild entry) on
// demand, once. Kept out of the startup path so the shell paints first (PLAN §13).
let pending: Promise<EditorEngine> | undefined;

export function loadEditorEngine(
  theme: () => EditorTheme,
  host: EngineHost,
): Promise<EditorEngine> {
  pending ??= (async () => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = new URL("./assets/monaco.css", document.baseURI).href;
    document.head.appendChild(css);
    // A runtime URL (not a bare specifier) so esbuild keeps this as a separate entry.
    const url = new URL("./assets/monaco.js", document.baseURI).href;
    const mod = (await import(url)) as { default: EditorEngineModule };
    const first = theme();
    const engine = await mod.default.createEngine(first, host);
    // A theme change while the engine was loading (the first paint's cached theme replaced by
    // the settings' one) found no engine to re-theme: apply the current one if it differs, or
    // the editor keeps the old theme inside the new chrome.
    const now = theme();
    if (JSON.stringify(now) !== JSON.stringify(first)) await engine.applyTheme(now);
    return engine;
  })();
  return pending;
}

// The engine's view of the IDE (EngineHost): open files through commands, read files for peek
// previews.
export function engineHost(services: WorkbenchServices): EngineHost {
  const run = (command: string, input: unknown) => services.dispatcher.execute(command, input);
  return {
    openFile: (path, line, column) =>
      void run("editor.openFile", { path, line, column }).catch(() => {}),
    readFile: async (path) => {
      try {
        const { text, binary } = decodeFile(await fsIpc.read(path));
        return binary ? null : text;
      } catch {
        return null;
      }
    },
    readClipboard: () => clipboardIpc.readText(),
    writeClipboard: (text) => clipboardIpc.writeText(text),
    copied: (text, secret) => editorClipboard.add(text, Date.now(), secret),
    openDocuments: async (paths) => {
      for (const path of paths)
        await run("editor.openFile", { path, preserveFocus: true }).catch(() => {});
    },
    fileExists: (path) =>
      fsIpc
        .stat(path)
        .then((st) => st.kind === "file")
        .catch(() => false),
    root: (path) =>
      (path ? services.workspace.folderOf(path)?.path : undefined) ??
      services.workspace.root.peek(),
    run: (command, input) => run(command, input).catch(() => null),
    showMenu: (at, items, onClose) =>
      showMenu(at, items, { label: "Code actions", focusFirst: true, onClose }),
    chooseFormatter: (q) => chooseFormatter(services, q),
    setContext: (keys) => {
      for (const [key, value] of Object.entries(keys)) services.context.set(key, value);
    },
  };
}

/**
 * Asks which formatter is the language's default and saves it as editor.defaultFormatter for the
 * language in the user's settings (VS Code's _pickAndPersistDefaultFormatter): its index, or
 * undefined when the user cancelled.
 */
export async function pickDefaultFormatter(
  services: WorkbenchServices,
  q: { languageId: string; languageName: string; formatters: readonly FormatterOption[] },
): Promise<number | undefined> {
  const pick = await services.quickInput.pick(formatterRows(q.formatters), {
    placeholder: pickFormatterPlaceholder(q.languageName),
  });
  const index = pick ? Number(pick.id) : -1;
  const chosen = q.formatters[index];
  if (!chosen) return undefined;
  // For the language, in the user's settings (VS Code's updateValue with the language).
  await services.settings
    .updateForLanguage(q.languageId, "editor.defaultFormatter", chosen.id)
    .catch(() => {});
  return index;
}

/** VS Code's DefaultFormatter (formatterChoice.ts): the configured, only, or picked formatter. */
async function chooseFormatter(
  services: WorkbenchServices,
  q: Parameters<NonNullable<EngineHost["chooseFormatter"]>>[0],
): Promise<number | undefined> {
  const { settings } = services;
  const configured =
    settings.peekForLanguageAt<string | null>("editor.defaultFormatter", q.languageId, q.path) ||
    undefined;
  const enabled = services.extensionGate.enabledIds.peek();
  const analysis = analyzeFormatters(q.formatters, configured, q.languageName, q.kind, (id) =>
    enabled.find((e) => sameFormatterId(e, id)),
  );
  if ("index" in analysis) return analysis.index;
  const pickAndSave = () => pickDefaultFormatter(services, q);
  if (q.silent) {
    // A save goes on unformatted; the notice offers the choice (VS Code's silent prompt).
    services.notifications.show("info", analysis.message, {
      actions: [{ label: "Configure…", run: () => void pickAndSave() }],
    });
    return undefined;
  }
  const configure = await showDialog({
    title: "Configure default formatter",
    message: analysis.message,
    actions: [
      { label: "Cancel", value: false },
      { label: "Configure…", value: true, variant: "primary" },
    ],
    cancelValue: false,
  });
  return configure ? pickAndSave() : undefined;
}
