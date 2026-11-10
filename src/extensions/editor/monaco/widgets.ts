// Monaco implementations of EngineDocument and EngineEditor (one per editor tab), plus the
// editor settings → Monaco options mapping. Used by the engine in entry.ts.

import { ILanguageFeaturesService } from "monaco-editor/editor/common/services/languageFeatures.js";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { ICommandService } from "monaco-editor/platform/commands/common/commands.js";
import { Emitter } from "../../../core/events/index";
import { DisposableStore } from "../../../core/lifecycle/index";
import type { GutterMark, LineAnnotation } from "../../../workbench/gutterMarks";
import { closingTagFor, TAG_LANGUAGES } from "../closeTags";
import type {
  ActiveEditorState,
  BreakpointGlyph,
  EditorKeyEvent,
  EditorOptions,
  EditorZone,
  EngineDocument,
  EngineEditor,
  EngineHost,
  HighlightRange,
  LineRange,
  SelectionStatus,
} from "../engine";
import type { FormatterOption } from "../formatterChoice";
import { coveredRanges, type SecretRange, secretRanges } from "../secretValues";
import * as monaco from "./core";
import { MonacoDocument } from "./document";
import { formatSilently, formattersFor, formatWithChosen } from "./formatterChoice";
import { hasEngineCommand } from "./keybindings";
import { addZone, decorateLines, replaceLines } from "./zones";

/** The IDE's code font (`--font-mono`: the OS's default, as VS Code, D382). Monaco needs the
 *  family as a string to measure it, so it's read from the token rather than `var()`. */
export function monoFont(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace"
  );
}

/** Navigation commands (not editor actions in Monaco) and the provider each one needs. */
const PROVIDER_COMMANDS: Record<
  string,
  "definitionProvider" | "typeDefinitionProvider" | "implementationProvider" | "referenceProvider"
> = {
  "editor.action.revealDefinition": "definitionProvider",
  "editor.action.peekDefinition": "definitionProvider",
  "editor.action.revealDefinitionAside": "definitionProvider",
  "editor.action.goToTypeDefinition": "typeDefinitionProvider",
  "editor.action.peekTypeDefinition": "typeDefinitionProvider",
  "editor.action.goToImplementation": "implementationProvider",
  "editor.action.peekImplementation": "implementationProvider",
  "editor.action.goToReferences": "referenceProvider",
  "editor.action.referenceSearch.trigger": "referenceProvider",
};

const CUT = "editor.action.clipboardCutAction";
const COPY = "editor.action.clipboardCopyAction";
const PASTE = "editor.action.clipboardPasteAction";
const CHANGE_ALL = "editor.action.changeAll";
const FORMAT_DOCUMENT = "editor.action.formatDocument";
/** Longer files aren't searched for secret values (editor.hideSecrets). */
const SECRET_FILE_MAX_CHARS = 1_000_000;

/** monaco-vim's Vim object, the part used here. */
interface VimApi {
  defineEx(name: string, prefix: string, run: (cm: { editor?: unknown }) => void): void;
}
let vimCommandsDefined = false;
/** Monaco editor → its MonacoEditor, for Vim's : commands. */
const vimOwners = new WeakMap<monaco.editor.IStandaloneCodeEditor, MonacoEditor>();

/** Plain text shown as-is in a Markdown hover. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, "\\$&").replace(/\n/g, "  \n");
}

export class MonacoEditor implements EngineEditor {
  private readonly store = new DisposableStore();
  private readonly cursorChanged = this.store.add(new Emitter<void>());
  private readonly focused = this.store.add(new Emitter<void>());
  private readonly contextMenu = this.store.add(
    new Emitter<{ x: number; y: number; gutterLine?: number }>(),
  );
  readonly onDidChangeCursor = this.cursorChanged.event;
  readonly onDidFocus = this.focused.event;
  readonly onContextMenu = this.contextMenu.event;
  private readonly keyDown = this.store.add(new Emitter<EditorKeyEvent>());
  private readonly gutterClick = this.store.add(new Emitter<number>());
  readonly onGutterClick = this.gutterClick.event;
  private readonly changeBarClick = this.store.add(
    new Emitter<{ line: number; staged: boolean }>(),
  );
  readonly onChangeBarClick = this.changeBarClick.event;
  private breakpointMarks: monaco.editor.IEditorDecorationsCollection | null = null;
  private executionMark: monaco.editor.IEditorDecorationsCollection | null = null;
  private hoverMark: monaco.editor.IEditorDecorationsCollection | null = null;
  readonly onKeyDown = this.keyDown.event;
  private readonly heightChanged = this.store.add(new Emitter<number>());
  readonly onDidChangeContentHeight = this.heightChanged.event;
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private shown: MonacoDocument | null = null;
  /** View state per document this editor has shown (a tab only ever shows one, but renames swap it). */
  private readonly viewStates = new WeakMap<
    MonacoDocument,
    monaco.editor.ICodeEditorViewState | null
  >();

  /** editor.autoClosingTags (D192). */
  private closeTags = true;
  /** The plain editor settings, and the settings for a language (its `[lang]` blocks, D201). */
  private options: EditorOptions;
  private forLanguage: ((languageId: string, path?: string) => EditorOptions) | undefined;
  /** Vim mode (editor.vimMode, D196): monaco-vim's adapter and its status line, while on. */
  private vim: { dispose(): void } | null = null;
  private vimStatus: HTMLElement | null = null;
  private vimWanted = false;
  private readonly container: HTMLElement;
  /** Read-only whatever the document allows (a session toggle, files.readonlyInclude). */
  private forcedReadOnly = false;
  /** editor.hideSecrets for the shown file: its secret spans, covered off the cursor's lines. */
  private secretMask: monaco.editor.IEditorDecorationsCollection | null = null;
  private secretSpans: SecretRange[] = [];
  private secretSpansFor: { model: monaco.editor.ITextModel; version: number } | null = null;

  constructor(
    container: HTMLElement,
    themeName: string,
    options: EditorOptions,
    onDispose: () => void,
    private readonly clipboard: Pick<
      EngineHost,
      "readClipboard" | "writeClipboard" | "run" | "copied"
    >,
    private readonly embedded = false,
    forLanguage?: (languageId: string, path?: string) => EditorOptions,
  ) {
    this.container = container;
    this.options = options;
    this.forLanguage = forLanguage;
    this.editor = monaco.editor.create(container, {
      model: null,
      theme: themeName,
      // Layout follows the container (followSize below) and the dock's onResize.
      automaticLayout: false,
      fontFamily: monoFont(),
      fontLigatures: false,
      padding: { top: 8 },
      cursorStyle: "line",
      cursorWidth: 2,
      cursorSmoothCaretAnimation: "off",
      renderLineHighlight: "line",

      bracketPairColorization: { enabled: false },
      overviewRulerBorder: false,
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
      // The IDE's own menu (DESIGN.md §12.7) replaces Monaco's; see onContextMenu.
      contextmenu: false,
      ...this.withEmbedded(monacoOptions(options)),
    });
    this.closeTags = options.autoClosingTags !== false;
    this.setVim(options.vimMode === true);
    this.store.add(this.editor.onDidChangeModelContent((e) => this.maybeCloseTag(e)));
    // Change language mode, files.associations: the new language's settings.
    this.store.add(this.editor.onDidChangeModelLanguage(() => this.applyOptions()));
    this.store.add(
      this.editor.onDidContentSizeChange((e) => {
        if (e.contentHeightChanged) this.heightChanged.fire(e.contentHeight);
      }),
    );
    // Keys this editor answers itself: Ctrl/Cmd+Z / Ctrl+Y / Ctrl/Cmd+Shift+Z ask the undo
    // override first (whole workspace operations, D141); Shift+Alt+F lets the project's
    // formatter go first (D140). Monaco's addCommand is global (the newest editor would answer
    // for all) and can't be removed, so these are actions limited to this editor by a context
    // key only its own scope has, and disposed with it.
    const scope = `ideEditor${++editorSeq}`;
    this.editor.createContextKey(scope, true);
    const textFocus = `${scope} && editorTextFocus && !editorReadonly`;
    const key = (id: string, keybindings: number[], run: () => void, when = textFocus) =>
      this.store.add(
        this.editor.addAction({
          id: `ide.${id}`,
          label: id,
          keybindings,
          keybindingContext: when,
          run,
        }),
      );
    const { KeyMod, KeyCode } = monaco;
    key("undo", [KeyMod.CtrlCmd | KeyCode.KeyZ], () => this.undo());
    key(
      "redo",
      [
        KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ,
        ...(/Mac/.test(navigator.platform) ? [] : [KeyMod.CtrlCmd | KeyCode.KeyY]),
      ],
      () => this.undo("redo"),
    );
    key(
      "formatDocument",
      [KeyMod.Shift | KeyMod.Alt | KeyCode.KeyF],
      () => void this.runAction(FORMAT_DOCUMENT),
      `${scope} && editorTextFocus`,
    );
    // Breakpoints: a click in the glyph margin toggles one; hovering shows where it would go.
    this.store.add(
      this.editor.onMouseDown((e) => {
        if (
          e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN &&
          e.target.position
        )
          this.gutterClick.fire(e.target.position.lineNumber);
        // A change bar (quick diff): open the change (D201, VS Code's click on the bar).
        if (
          e.event.leftButton &&
          e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS &&
          e.target.position
        ) {
          const line = e.target.position.lineNumber;
          const bars = (this.editor.getLineDecorations(line) ?? [])
            .map((d) => d.options.linesDecorationsClassName ?? "")
            .filter((c) => c.includes("quick-diff"));
          if (bars.length)
            this.changeBarClick.fire({
              line,
              // Only a staged bar there: its change is in the index (HEAD ↔ index diff).
              staged: bars.every((c) => c.includes("is-staged")),
            });
        }
      }),
    );
    this.store.add(
      this.editor.onMouseMove((e) => {
        const line =
          e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN
            ? (e.target.position?.lineNumber ?? null)
            : null;
        const decorations =
          line === null
            ? []
            : [
                {
                  range: new monaco.Range(line, 1, line, 1),
                  options: { glyphMarginClassName: "debug-bp-hint" },
                },
              ];
        if (this.hoverMark) this.hoverMark.set(decorations);
        else this.hoverMark = this.editor.createDecorationsCollection(decorations);
      }),
    );
    this.store.add(this.editor.onMouseLeave(() => this.hoverMark?.clear()));
    // Copies from the keyboard (Ctrl+C / Ctrl+X, the browser's own copy) for Paste from
    // history: captured before the engine's handler, so a cut's text is still there to read.
    const onCopy = () => {
      if (!this.editor.hasTextFocus()) return;
      const text = this.copiedText()?.text;
      if (text) this.clipboard.copied?.(text, !!this.secretMask);
    };
    container.addEventListener("copy", onCopy, true);
    container.addEventListener("cut", onCopy, true);
    this.store.add({
      dispose: () => {
        container.removeEventListener("copy", onCopy, true);
        container.removeEventListener("cut", onCopy, true);
      },
    });
    const subs = [
      this.editor.onDidChangeCursorSelection(() => {
        this.cursorChanged.fire();
        if (this.secretMask) this.updateSecretMask();
      }),
      this.editor.onDidChangeModelContent(() => {
        if (this.secretMask) this.updateSecretMask();
      }),
      this.editor.onDidScrollChange(() => this.cursorChanged.fire()),
      this.editor.onDidFocusEditorText(() => this.focused.fire()),
      this.editor.onKeyDown((e) => {
        const b = e.browserEvent;
        this.keyDown.fire({
          key: b.key,
          ctrlKey: b.ctrlKey,
          metaKey: b.metaKey,
          shiftKey: b.shiftKey,
          altKey: b.altKey,
          preventDefault: () => {
            e.preventDefault();
            e.stopPropagation();
          },
        });
      }),
      this.editor.onContextMenu((e) => {
        const ev = e.event.browserEvent;
        e.event.preventDefault();
        const gutter =
          e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN
            ? e.target.position?.lineNumber
            : undefined;
        this.contextMenu.fire({
          x: ev.clientX,
          y: ev.clientY,
          ...(gutter !== undefined ? { gutterLine: gutter } : {}),
        });
      }),
    ];
    this.store.add(followSize(container, () => this.editor.layout()));
    this.store.add({
      dispose: () => {
        for (const sub of subs) sub.dispose();
        this.setVim(false);
        this.editor.dispose();
        onDispose();
      },
    });
  }

  setDocument(doc: EngineDocument | null): void {
    if (this.shown) this.viewStates.set(this.shown, this.editor.saveViewState());
    const next = doc instanceof MonacoDocument ? doc : null;
    this.shown = next;
    this.editor.updateOptions({ readOnly: (next?.readOnly ?? false) || this.forcedReadOnly });
    this.editor.setModel(next?.model ?? null);
    this.applyOptions();
    this.updateSecretMask();
    const state = next ? this.viewStates.get(next) : null;
    if (state) this.editor.restoreViewState(state);
  }

  focus(): void {
    this.editor.focus();
  }

  revealPosition(line: number, column: number): void {
    const position = { lineNumber: line, column };
    this.editor.setPosition(position);
    this.editor.revealPositionInCenterIfOutsideViewport(position);
  }

  select(r: { startLine: number; startColumn: number; endLine: number; endColumn: number }): void {
    const raw = new monaco.Range(r.startLine, r.startColumn, r.endLine, r.endColumn);
    // Columns past the end of a line mean "to its end".
    const range = this.editor.getModel()?.validateRange(raw) ?? raw;
    this.editor.setSelection(range);
    this.editor.revealRangeInCenterIfOutsideViewport(range);
  }

  async formatLines(ranges: readonly { startLine: number; endLine: number }[]): Promise<boolean> {
    const model = this.editor.getModel();
    const action = this.editor.getAction("editor.action.formatSelection");
    if (!model || ranges.length === 0 || !action?.isSupported()) return false;
    // The range formatter formats every selection: select the ranges, format, put the cursor back.
    const before = this.editor.getSelections();
    this.editor.setSelections(
      ranges.map((r) => {
        const end = Math.min(r.endLine, model.getLineCount());
        return new monaco.Selection(r.startLine, 1, end, model.getLineMaxColumn(end));
      }),
    );
    try {
      // Only a save formats changed lines: a choice of formatter is asked with a notice.
      await formatSilently(() => action.run());
    } finally {
      if (before) this.editor.setSelections(before);
    }
    return true;
  }

  formatters(kind: "file" | "selection"): FormatterOption[] {
    const model = this.editor.getModel();
    return model ? formattersFor(model, kind) : [];
  }

  async formatWith(kind: "file" | "selection", index: number): Promise<boolean> {
    const model = this.editor.getModel();
    // The engine's action, not runAction: the project's formatter (formatOverride) is skipped.
    const action = this.editor.getAction(
      kind === "file" ? FORMAT_DOCUMENT : "editor.action.formatSelection",
    );
    if (!model || !action?.isSupported() || !formattersFor(model, kind)[index]) return false;
    this.editor.focus();
    await formatWithChosen(model, index, () => action.run());
    return true;
  }

  setOptions(
    options: EditorOptions,
    forLanguage?: (languageId: string, path?: string) => EditorOptions,
  ): void {
    this.options = options;
    // Embedded editors (the chat's code boxes, inline inputs) keep the plain settings.
    this.forLanguage = this.embedded ? undefined : forLanguage;
    this.applyOptions();
  }

  /**
   * The settings for the shown document's language (D201). Indentation is a model option in
   * Monaco, and `updateOptions` would set it for every model: the editor gets the plain tab size,
   * the model its language's (applyIndentation).
   */
  private applyOptions(): void {
    const plain = this.options;
    const language = this.shown?.languageId;
    // The file's own folder's settings too, in a multi-root workspace (D251).
    const own = language && this.forLanguage ? this.forLanguage(language, this.shown?.path) : plain;
    this.closeTags = own.autoClosingTags !== false;
    this.setVim(plain.vimMode === true);
    // Prose files don't pop up word suggestions while typing (VS Code's defaults for them),
    // unless their language's settings say otherwise.
    const prose =
      ["markdown", "plaintext"].includes(language ?? "") &&
      own.advanced?.quickSuggestions === plain.advanced?.quickSuggestions;
    this.editor.updateOptions({
      ...this.withEmbedded(
        monacoOptions({ ...own, tabSize: plain.tabSize, insertSpaces: plain.insertSpaces }),
      ),
      ...(prose && { quickSuggestions: false }),
    });
    if (this.shown) applyIndentation(this.shown.model, plain, own);
  }

  /**
   * Vim key bindings (D196, off by default): monaco-vim, loaded the first time it's turned on. Its
   * mode and `:` commands show in a line at the bottom of the editor. Not in embedded editors
   * (the chat's code boxes, inline inputs).
   */
  private setVim(on: boolean): void {
    const want = on && !this.embedded;
    if (want === this.vimWanted) return;
    this.vimWanted = want;
    if (!want) {
      this.vim?.dispose();
      this.vim = null;
      this.vimStatus?.remove();
      this.vimStatus = null;
      return;
    }
    void import("monaco-vim")
      .then(({ initVimMode, VimMode }) => {
        if (!this.vimWanted || this.vim) return;
        // :w, :q and :wq go to the IDE's commands (the editor in focus answers them).
        if (!vimCommandsDefined) {
          vimCommandsDefined = true;
          const vim = (VimMode as unknown as { Vim: VimApi }).Vim;
          const host = this.clipboard;
          // The file of the editor the command was typed in (not whichever tab is active later).
          const pathOf = (cm: { editor?: unknown }) =>
            vimOwners.get(cm.editor as monaco.editor.IStandaloneCodeEditor)?.shown?.path;
          const save = (cm: { editor?: unknown }) => host.run("editor.save", { path: pathOf(cm) });
          const close = (cm: { editor?: unknown }) =>
            host.run("editor.closeTab", { path: pathOf(cm) });
          vim.defineEx("write", "w", (cm) => void save(cm));
          vim.defineEx("quit", "q", (cm) => void close(cm));
          // Closed once the save finished (closing first would ask about unsaved changes).
          const saveClose = async (cm: { editor?: unknown }) => {
            await save(cm);
            await close(cm);
          };
          vim.defineEx("wq", "wq", (cm) => void saveClose(cm));
          vim.defineEx("xit", "x", (cm) => void saveClose(cm));
        }
        const status = document.createElement("div");
        status.className = "vim-status";
        this.container.append(status);
        this.vimStatus = status;
        // monaco-vim types Monaco through its own import of it; it's the same editor.
        vimOwners.set(this.editor, this);
        this.vim = initVimMode(this.editor as never, status);
      })
      .catch(() => {
        this.vimWanted = false;
      });
  }

  /** Typing `>` that ends an opening tag inserts the closing tag after the cursor (D192). */
  private maybeCloseTag(e: monaco.editor.IModelContentChangedEvent): void {
    if (!this.closeTags || e.isUndoing || e.isRedoing || e.isFlush || e.changes.length !== 1)
      return;
    const change = e.changes[0];
    const model = this.editor.getModel();
    if (!change || change.text !== ">" || !model || !TAG_LANGUAGES.has(model.getLanguageId()))
      return;
    const selections = this.editor.getSelections() ?? [];
    if (selections.length !== 1 || !selections[0]?.isEmpty()) return;
    const { startLineNumber: line, startColumn: column } = change.range;
    const text = model.getLineContent(line);
    const close = closingTagFor(text.slice(0, column), text.slice(column), model.getLanguageId());
    if (!close) return;
    const version = model.getVersionId();
    // After the typing edit settles (Monaco is still inside it here).
    queueMicrotask(() => {
      if (model.isDisposed() || model.getVersionId() !== version) return;
      const at = new monaco.Range(line, column + 1, line, column + 1);
      this.editor.executeEdits(
        "ide.closeTag",
        [{ range: at, text: close }],
        [new monaco.Selection(line, column + 1, line, column + 1)],
      );
    });
  }

  /** A notebook cell's "Show cell line numbers" (D204): embedded editors have none otherwise. */
  private embeddedLineNumbers = false;

  setLineNumbers(on: boolean): void {
    if (this.embeddedLineNumbers === on) return;
    this.embeddedLineNumbers = on;
    this.applyOptions();
  }

  /** An embedded editor (a notebook cell) keeps its compact look whatever the settings say. */
  private withEmbedded<T extends monaco.editor.IEditorOptions>(o: T): T {
    if (!this.embedded) return o;
    return {
      ...o,
      minimap: { enabled: false },
      glyphMargin: false,
      folding: false,
      stickyScroll: { enabled: false },
      scrollBeyondLastLine: false,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      overviewRulerBorder: false,
      lineNumbers: this.embeddedLineNumbers ? "on" : "off",
      lineDecorationsWidth: 10,
      lineNumbersMinChars: 3,
      renderLineHighlight: "none",
      padding: { top: 8, bottom: 8 },
      scrollbar: {
        vertical: "hidden",
        horizontal: "auto",
        alwaysConsumeMouseWheel: false,
        handleMouseWheel: true,
        horizontalScrollbarSize: 8,
        useShadows: false,
      },
      wordWrap: o.wordWrap,
    };
  }

  contentHeight(): number {
    return this.editor.getContentHeight();
  }

  hasOpenWidget(): boolean {
    if ((this.editor.getSelections()?.length ?? 0) > 1) return true;
    const dom = this.editor.getDomNode();
    return !!dom?.querySelector(
      ".suggest-widget.visible, .find-widget.visible, .parameter-hints-widget.visible, .rename-box",
    );
  }

  /** Tab means something to the editor now: ghost text to accept, a snippet's next field. */
  tabTaken(): boolean {
    const keys = (
      this.editor as unknown as {
        _contextKeyService?: { getContextKeyValue(key: string): unknown };
      }
    )._contextKeyService;
    if (keys?.getContextKeyValue("inSnippetMode") === true) return true;
    if (keys?.getContextKeyValue("inlineSuggestionVisible") === true) return true;
    return !!this.editor.getDomNode()?.querySelector(".ghost-text, .ghost-text-decoration");
  }

  actionSupported(id: string): boolean {
    const readOnly = this.editor.getOption(monaco.editor.EditorOption.readOnly);
    if (id === COPY) return true;
    if (id === FORMAT_DOCUMENT && this.formatOverride && !readOnly) return true;
    if (id === CUT || id === CHANGE_ALL) return !readOnly;
    if (id === PASTE) return !readOnly;
    if (CORE_COMMANDS.has(id)) return id === "editor.action.selectAll" || !readOnly;
    const provider = PROVIDER_COMMANDS[id];
    if (provider) {
      const model = this.editor.getModel();
      return !!model && StandaloneServices.get(ILanguageFeaturesService)[provider].has(model);
    }
    const action = this.editor.getAction(id);
    if (action) return action.isSupported();
    // A plain editor command checks its own preconditions when it runs.
    return hasEngineCommand(id);
  }

  setBreakpoints(marks: readonly BreakpointGlyph[]): void {
    const decorations = marks.map((m) => ({
      range: new monaco.Range(m.line, 1, m.line, 1),
      options: {
        glyphMarginClassName: `debug-bp is-${m.state}${m.conditional ? " is-conditional" : ""}${m.log ? " is-log" : ""}`,
        glyphMarginHoverMessage: {
          value: `${m.log ? "Logpoint" : m.conditional ? "Conditional breakpoint" : "Breakpoint"}${m.state === "disabled" ? " (disabled)" : m.state === "unverified" ? " (not placed)" : m.state === "pending" ? " (waiting for its trigger)" : ""}`,
        },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    }));
    if (this.breakpointMarks) this.breakpointMarks.set(decorations);
    else this.breakpointMarks = this.editor.createDecorationsCollection(decorations);
  }

  private readonly lineMarks = new Map<string, monaco.editor.IEditorDecorationsCollection>();

  setLineMarks(owner: string, marks: readonly GutterMark[]): void {
    const stickiness = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;
    const decorations: monaco.editor.IModelDeltaDecoration[] = marks.map((m) => ({
      range: new monaco.Range(m.line, 1, m.line, 1),
      options: {
        glyphMarginClassName: m.className,
        glyphMargin: { position: monaco.editor.GlyphMarginLane.Right },
        ...(m.hover ? { glyphMarginHoverMessage: { value: m.hover } } : {}),
        stickiness,
      },
    }));
    // Marks at a column in the line (a branch not taken, D233): drawn before that character.
    for (const m of marks)
      for (const c of m.columns ?? [])
        decorations.push({
          range: new monaco.Range(m.line, c.column, m.line, c.column),
          options: {
            beforeContentClassName: c.className,
            ...(c.hover ? { hoverMessage: { value: c.hover } } : {}),
            stickiness,
          },
        });
    const existing = this.lineMarks.get(owner);
    if (existing) existing.set(decorations);
    else this.lineMarks.set(owner, this.editor.createDecorationsCollection(decorations));
  }

  private readonly highlights = new Map<string, monaco.editor.IEditorDecorationsCollection>();

  highlightRanges(owner: string, ranges: readonly HighlightRange[]): void {
    // Monaco's own find-match classes: the theme's find colors, as in its find widget.
    const decorations = ranges.map((r) => ({
      range: new monaco.Range(r.startLine, r.startColumn, r.endLine, r.endColumn),
      options: {
        className: r.className ?? (r.current ? "currentFindMatch" : "findMatch"),
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        overviewRuler: null,
      },
    }));
    const existing = this.highlights.get(owner);
    if (existing) existing.set(decorations);
    else if (decorations.length)
      this.highlights.set(owner, this.editor.createDecorationsCollection(decorations));
  }

  lineMarkLines(owner: string): number[] {
    return (this.lineMarks.get(owner)?.getRanges() ?? []).map((r) => r.startLineNumber);
  }

  private annotations: monaco.editor.IEditorDecorationsCollection | null = null;

  setLineAnnotations(items: readonly LineAnnotation[]): void {
    const model = this.editor.getModel();
    const count = model?.getLineCount() ?? 0;
    // The text goes before column 1 (the cursor skips it); the hover sits on the line's first
    // character, which is where the pointer lands over the injected text.
    const decorations = items
      .filter((a) => a.line >= 1 && a.line <= count)
      .flatMap((a) => [
        {
          range: new monaco.Range(a.line, 1, a.line, 1),
          options: {
            showIfCollapsed: true,
            before: {
              content: a.text,
              inlineClassName: a.className,
              cursorStops: monaco.editor.InjectedTextCursorStops.None,
            },
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        },
        ...(a.hover
          ? [
              {
                range: new monaco.Range(a.line, 1, a.line, 2),
                options: { hoverMessage: { value: escapeMarkdown(a.hover) } },
              },
            ]
          : []),
      ]);
    if (this.annotations) this.annotations.set(decorations);
    else if (decorations.length)
      this.annotations = this.editor.createDecorationsCollection(decorations);
  }

  breakpointLines(): number[] {
    return (this.breakpointMarks?.getRanges() ?? []).map((r) => r.startLineNumber);
  }

  setExecutionLine(line: number | null): void {
    const decorations =
      line === null
        ? []
        : [
            {
              range: new monaco.Range(line, 1, line, 1),
              options: {
                isWholeLine: true,
                className: "debug-current-line",
                glyphMarginClassName: "debug-current-arrow",
              },
            },
          ];
    if (this.executionMark) this.executionMark.set(decorations);
    else this.executionMark = this.editor.createDecorationsCollection(decorations);
    if (line !== null) this.editor.revealLineInCenterIfOutsideViewport(line);
  }

  private formatOverride: (() => Promise<boolean>) | null = null;
  private undoOverride: ((how: "undo" | "redo") => boolean | Promise<boolean>) | null = null;

  setUndoOverride(undo: ((how: "undo" | "redo") => boolean | Promise<boolean>) | null): void {
    this.undoOverride = undo;
  }

  /** Undo / redo: the override's say first (a workspace operation), else the text's. */
  private undo(how: "undo" | "redo" = "undo"): void {
    const handled = this.undoOverride?.(how) ?? false;
    if (handled === false) this.editor.trigger("keyboard", how, null);
    else if (handled !== true)
      void handled.then((done) => {
        if (!done) this.editor.trigger("keyboard", how, null);
      });
  }

  setFormatOverride(format: (() => Promise<boolean>) | null): void {
    this.formatOverride = format;
  }

  async runAction(id: string, args?: unknown): Promise<boolean> {
    // A save's formatting (`{ silent: true }`): a choice of formatter is asked with a notice,
    // not a dialog (VS Code's FormattingMode.Silent, formatterChoice.ts).
    if (id === FORMAT_DOCUMENT && (args as { silent?: unknown } | undefined)?.silent === true)
      return formatSilently(() => this.runAction(id));
    this.editor.focus();
    // A read-only editor isn't formatted (D407): the project's formatter writes the model
    // directly, past Monaco's own read-only guard.
    if (id === FORMAT_DOCUMENT && this.editor.getOption(monaco.editor.EditorOption.readOnly))
      return false;
    if (id === FORMAT_DOCUMENT && this.formatOverride) {
      if (await this.formatOverride()) return true;
      const action = this.editor.getAction(id);
      if (!action?.isSupported()) return false;
      await action.run(args);
      return true;
    }
    // Clipboard actions are commands, not editor actions, in Monaco (getAction returns null), and
    // the browser clipboard needs a fresh user gesture, which a menu click no longer is by the time
    // the command runs: go through the system clipboard instead.
    if (id === CUT || id === COPY) return this.copy(id === CUT);
    if (id === PASTE) {
      const text = await this.clipboard.readClipboard();
      if (text) this.editor.trigger("menu", "paste", { text });
      return true;
    }
    if (id === "undo" || id === "redo") {
      this.undo(id);
      return true;
    }
    // Undo, redo and select all are core commands (no action object): trigger them by id.
    if (CORE_COMMANDS.has(id)) {
      this.editor.trigger("menu", id, null);
      return true;
    }
    // Go to / peek definition, type definition, implementations, references: registered as
    // commands (Action2), not editor actions — run them as commands on this (focused) editor.
    if (PROVIDER_COMMANDS[id]) {
      if (!this.actionSupported(id)) return false;
      await StandaloneServices.get(ICommandService).executeCommand(id, args);
      return true;
    }
    const action = this.editor.getAction(id);
    if (action) {
      await action.run(args);
      return true;
    }
    // Editor commands without an action object (cursorDown, deleteLeft…; a keybinding's `args`
    // like cursorMove's { to, by }): triggered on this editor.
    if (!hasEngineCommand(id)) return false;
    this.editor.trigger("keyboard", id, args ?? null);
    return true;
  }

  /** Copies the selections (or, with nothing selected, the cursor lines, like the keyboard). */
  private async copy(cut: boolean): Promise<boolean> {
    const copied = this.copiedText();
    if (!copied) return false;
    const { text, ranges } = copied;
    await this.clipboard.writeClipboard(text);
    this.clipboard.copied?.(text, !!this.secretMask);
    if (cut) {
      this.editor.pushUndoStop();
      this.editor.executeEdits(
        "cut",
        ranges.map((range) => ({ range, text: "" })),
      );
      this.editor.pushUndoStop();
    }
    return true;
  }

  /** What a copy takes: the selections, or the cursor lines when nothing is selected. */
  private copiedText(): { text: string; ranges: monaco.Range[] } | null {
    const model = this.editor.getModel();
    const selections = this.editor.getSelections();
    if (!model || !selections?.length) return null;
    const eol = model.getEOL();
    const empty = selections.every((s) => s.isEmpty());
    const ranges = empty
      ? selections.map((s) => {
          const last = model.getLineCount();
          return s.positionLineNumber < last
            ? new monaco.Range(s.positionLineNumber, 1, s.positionLineNumber + 1, 1)
            : new monaco.Range(
                s.positionLineNumber,
                1,
                s.positionLineNumber,
                model.getLineMaxColumn(s.positionLineNumber),
              );
        })
      : selections.filter((s) => !s.isEmpty());
    const text = ranges
      .map((r) => model.getValueInRange(r))
      .join(empty ? "" : eol)
      .concat(empty && !ranges.some((r) => r.endColumn === 1) ? eol : "");
    return { text, ranges };
  }

  setForcedReadOnly(readOnly: boolean): void {
    if (this.forcedReadOnly === readOnly) return;
    this.forcedReadOnly = readOnly;
    this.editor.updateOptions({ readOnly: (this.shown?.readOnly ?? false) || readOnly });
  }

  setSecretMask(on: boolean): void {
    if (on === !!this.secretMask) return;
    if (on) this.secretMask = this.editor.createDecorationsCollection();
    else {
      this.secretMask?.clear();
      this.secretMask = null;
      this.secretSpansFor = null;
    }
    this.updateSecretMask();
  }

  /** Covers the secret spans except on the lines a cursor or selection is on. */
  private updateSecretMask(): void {
    const mask = this.secretMask;
    const model = this.editor.getModel();
    if (!mask) return;
    if (!model) {
      mask.clear();
      return;
    }
    const version = model.getVersionId();
    if (this.secretSpansFor?.model !== model || this.secretSpansFor.version !== version) {
      // Secret files are small; a huge one isn't parsed on every keystroke.
      this.secretSpans =
        model.getValueLength() <= SECRET_FILE_MAX_CHARS ? secretRanges(model.getValue()) : [];
      this.secretSpansFor = { model, version };
    }
    const revealed = (this.editor.getSelections() ?? []).map((s) => ({
      startLine: s.startLineNumber,
      endLine: s.endLineNumber,
    }));
    mask.set(
      coveredRanges(this.secretSpans, revealed).map((r) => ({
        range: new monaco.Range(r.line, r.startColumn, r.line, r.endColumn),
        options: { inlineClassName: "editor-secret", stickiness: 1 },
      })),
    );
  }

  layout(): void {
    this.editor.layout();
  }

  insertText(text: string): void {
    const selections = this.editor.getSelections();
    if (!selections?.length || !this.editor.getModel()) return;
    this.editor.pushUndoStop();
    this.editor.executeEdits(
      "insert",
      selections.map((range) => ({ range, text, forceMoveMarkers: true })),
    );
    this.editor.pushUndoStop();
  }

  selectedLines(): LineRange | null {
    const s = this.editor.getSelection();
    if (!s) return null;
    // A selection ending at column 1 of a line doesn't include that line.
    const end =
      s.endColumn === 1 && s.endLineNumber > s.startLineNumber
        ? s.endLineNumber - 1
        : s.endLineNumber;
    return { startLine: s.startLineNumber, endLine: end };
  }

  linesText(range: LineRange): string {
    const model = this.editor.getModel();
    if (!model) return "";
    const end = Math.min(range.endLine, model.getLineCount());
    return model.getValueInRange(
      new monaco.Range(range.startLine, 1, end, model.getLineMaxColumn(end)),
      monaco.editor.EndOfLinePreference.LF,
    );
  }

  replaceLines(range: LineRange, text: string): LineRange {
    return replaceLines(this.editor, range, text);
  }

  addZone(afterLine: number, node: HTMLElement, heightPx: number): EditorZone {
    return addZone(this.editor, afterLine, node, heightPx);
  }

  decorateLines(range: LineRange, className: string): { dispose(): void } {
    return decorateLines(this.editor, range, className);
  }

  annotateLine(line: number, text: string, className: string): { dispose(): void } {
    const model = this.editor.getModel();
    if (!model || line < 1 || line > model.getLineCount()) return { dispose: () => {} };
    const end = model.getLineMaxColumn(line);
    const collection = this.editor.createDecorationsCollection([
      {
        range: new monaco.Range(line, end, line, end),
        options: {
          showIfCollapsed: true,
          after: {
            content: text,
            inlineClassName: className,
            cursorStops: monaco.editor.InjectedTextCursorStops.None,
          },
        },
      },
    ]);
    return { dispose: () => collection.clear() };
  }

  lineHeight(): number {
    return this.editor.getOption(monaco.editor.EditorOption.lineHeight);
  }

  scrollLine(): number {
    const start = this.topLine() ?? 1;
    const top = this.editor.getTopForLineNumber(start);
    const height = Math.max(1, this.editor.getTopForLineNumber(start + 1) - top);
    return start - 1 + Math.min(1, Math.max(0, (this.editor.getScrollTop() - top) / height));
  }

  scrollToLine(line: number): void {
    const whole = Math.max(0, Math.floor(line));
    const top = this.editor.getTopForLineNumber(whole + 1);
    const next = this.editor.getTopForLineNumber(whole + 2);
    this.editor.setScrollTop(top + (line - whole) * Math.max(0, next - top));
  }

  /** The first line at the top of the viewport (wrapped lines included), by binary search. */
  private topLine(): number | undefined {
    const count = this.editor.getModel()?.getLineCount();
    if (!count) return undefined;
    const top = this.editor.getScrollTop();
    let lo = 1;
    let hi = count;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.editor.getTopForLineNumber(mid) <= top + 1) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  selectionStatus(): SelectionStatus | null {
    const model = this.editor.getModel();
    if (!model) return null;
    const selections = this.editor.getSelections() ?? [];
    const position = this.editor.getPosition();
    let characters = 0;
    // From the model's offsets: no copy of the selected text.
    for (const s of selections) if (!s.isEmpty()) characters += model.getCharacterCountInRange(s);
    return {
      cursor: { line: position?.lineNumber ?? 1, column: position?.column ?? 1 },
      selections: Math.max(1, selections.length),
      characters,
    };
  }

  activeState(): ActiveEditorState | null {
    const model = this.editor.getModel();
    if (!model) return null;
    const selections = this.editor.getSelections() ?? [];
    const position = this.editor.getPosition();
    const ranges = this.editor.getVisibleRanges();
    const selectedText = selections
      .map((s) => model.getValueInRange(s))
      .filter((t) => t.length > 0)
      .join("\n");
    return {
      cursor: { line: position?.lineNumber ?? 1, column: position?.column ?? 1 },
      selections: selections.map((s) => ({
        start: { line: s.selectionStartLineNumber, column: s.selectionStartColumn },
        end: { line: s.positionLineNumber, column: s.positionColumn },
      })),
      visibleRange: {
        // From the vertical scroll position: visible ranges skip lines scrolled out sideways.
        startLine: this.topLine() ?? ranges[0]?.startLineNumber ?? 1,
        endLine: ranges[ranges.length - 1]?.endLineNumber ?? 1,
      },
      selectedText,
      wordAtCursor: (position && model.getWordAtPosition(position)?.word) || "",
    };
  }

  dispose(): void {
    this.store.dispose();
  }
}

/** Per model: the plain and language indentation last applied to it (applyIndentation). */
const appliedIndentation = new WeakMap<monaco.editor.ITextModel, string>();

/**
 * A language's editor.tabSize / editor.insertSpaces for its model (D201), the way Monaco applies
 * the plain ones: the defaults where the file's own indentation can't be detected. Only when they
 * change, so a tab size picked in the status bar stays until the settings change.
 */
function applyIndentation(
  model: monaco.editor.ITextModel,
  plain: EditorOptions,
  own: EditorOptions,
): void {
  const key = `${plain.tabSize}/${plain.insertSpaces}|${own.tabSize}/${own.insertSpaces}`;
  const before = appliedIndentation.get(model);
  if (before === key) return;
  appliedIndentation.set(model, key);
  // Monaco gave a new model the plain values already.
  const same = own.tabSize === plain.tabSize && own.insertSpaces === plain.insertSpaces;
  if (before === undefined && same) return;
  model.detectIndentation(own.insertSpaces, own.tabSize);
}

export function monacoOptions(
  o: EditorOptions,
): monaco.editor.IEditorOptions & { tabSize: number; insertSpaces: boolean } {
  const base: Record<string, unknown> = {
    fontSize: o.fontSize,
    // Monaco's (VS Code's) line height unless editor.lineHeight sets one: 0 is 1.35 × the font
    // size on Windows and Linux, 1.5 on macOS (and back to it when the setting is cleared).
    lineHeight: 0,
    tabSize: o.tabSize,
    wordWrap: o.wordWrap,
    stickyScroll: { enabled: o.stickyScroll, maxLineCount: 5 },
    minimap: { enabled: o.minimap },
    renderWhitespace: o.renderWhitespace,
    insertSpaces: o.insertSpaces,
    fontFamily: o.fontFamily || monoFont(),
    lineNumbers: o.lineNumbers,
    // Breakpoints live in the glyph margin, as in VS Code (D143).
    glyphMargin: o.glyphMargin ?? true,
    rulers: o.rulers,
    bracketPairColorization: { enabled: o.bracketPairColorization },
    scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12, useShadows: false },
  };
  // The advanced settings (D128) go over these, one level deep (stickyScroll, minimap, scrollbar…).
  for (const [key, value] of Object.entries(o.advanced ?? {})) {
    const prev = base[key];
    base[key] =
      value && typeof value === "object" && prev && typeof prev === "object"
        ? { ...prev, ...value }
        : value;
  }
  return base as unknown as monaco.editor.IEditorOptions & {
    tabSize: number;
    insertSpaces: boolean;
  };
}

export const DEFAULT_EDITOR_OPTIONS: EditorOptions = {
  fontSize: 14,
  tabSize: 4,
  wordWrap: "off",
  stickyScroll: true,
  minimap: true,
  renderWhitespace: "selection",
  insertSpaces: true,
  fontFamily: "",
  lineNumbers: "on",
  rulers: [],
  bracketPairColorization: true,
};

/**
 * Re-lays out an editor whenever its container's size changes (a neighbouring group closed, a
 * panel toggled) — one layout per frame, none while hidden. The dock's onResize alone missed
 * cases where the size settled after its own observer had fired.
 */
export function followSize(container: HTMLElement, layout: () => void): { dispose(): void } {
  let frame = 0;
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (container.offsetWidth > 0 && container.offsetHeight > 0) layout();
    });
  });
  observer.observe(container);
  return {
    dispose: () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    },
  };
}

/** Engine commands that aren't editor actions (getAction returns null for them). */
/** Numbers editors for their own keybinding scope (see the constructor). */
let editorSeq = 0;
const CORE_COMMANDS = new Set(["undo", "redo", "editor.action.selectAll"]);
