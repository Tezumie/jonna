// Monaco implementation of EditorEngine. Built as its own esbuild entry (assets/monaco.js + .css)
// and imported only after the shell has painted (PLAN §13: cold start → shell < 500 ms).
//
// Stack (decisions D16, D56): monaco-editor (core + language workers) + @shikijs/monaco + Shiki's JavaScript regex engine.
// Syntax colors come from Shiki's dark-plus / light-plus (DESIGN.md §15.2); every editor chrome
// color comes from the design tokens, merged on top (§15.1, theme.ts). No network requests.

import { textmateThemeToMonacoTheme } from "@shikijs/monaco";
import { IOutlineModelService } from "monaco-editor/editor/contrib/documentSymbols/browser/outlineModel.js";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import darkPlus from "shiki/themes/dark-plus.mjs";
import lightPlus from "shiki/themes/light-plus.mjs";
import { Emitter } from "../../../core/events/index";
import type { ProviderQuery } from "../../../core/extensions/providerQuery";
import { vscodeLanguageId } from "../../../core/extensions/vscode/languageIds";
import type { KeybindingRule, Platform } from "../../../core/keybindings/index";
import { type Disposable, DisposableStore } from "../../../core/lifecycle/index";
import type { LanguageClient } from "../../../core/lsp/client";
import { pathKey } from "../../../core/paths/index";
import { themeColors } from "../../../core/themes/vscodeColors";
import type { EditorDecoration, LanguageFeature } from "../../../workbench/extensionFeatures";
import type {
  ContributedGrammar,
  ContributedLanguage,
  ContributedSemanticTokenScopes,
  ContributedSnippet,
  DebugHoverSource,
  Diagnostic,
  DiagnosticSeverity,
  EditorEngine,
  EditorEngineModule,
  EditorOptions,
  EditorTheme,
  EngineDiffEditor,
  EngineDocument,
  EngineEditor,
  EngineHost,
  EngineKeybinding,
  InlineCompletionSource,
  JsonSchemaAssociation,
  LineEnding,
  NotebookLanguageSource,
  OutlineSymbol,
} from "../engine";
import { toLanguageConfiguration } from "../languageConfiguration";
import { firstLineOf, LANGUAGES, languageForPath } from "../languages";
import { MenuActionWidgetService } from "./actionMenu";
import { registerConflictLens } from "./conflictLens";
import { ContributedLanguages } from "./contributedLanguages";
import * as monaco from "./core";
import { registerDebugHover } from "./debugHover";
import { MonacoDiffEditor } from "./diff";
import { MonacoDocument } from "./document";
import { executeProviderQuery } from "./executeProviders";
import { ExtensionDecorations, registerExtensionFeatures } from "./extensionFeatures";
import { registerFallbackSymbols } from "./fallbackSymbols";
import { installFormatterChoice } from "./formatterChoice";
import { GrammarLoader } from "./grammarLoader";
import { isKeptClosed } from "./keptClosed";
import {
  applyEngineUserKeybindings,
  engineActions,
  engineChordCommand,
  engineHandlesKey,
  engineKeybindings,
  hasEngineCommand,
} from "./keybindings";
import { registerLanguageConfigurations } from "./languageConfig";
import {
  builtinTypeScriptOn,
  configureLanguageFeatures,
  setEmmet,
  setJsonSchemas,
} from "./languageFeatures";
import { attachLanguageClient, runCodeActionsOnSave } from "./lsp";
import { NotebookLanguageHub } from "./notebookLsp";
import { registerPathLinks } from "./pathLinkProvider";
import { disposePeekModels } from "./peek";
import { installSemanticStyling, setSemanticScopes } from "./semanticStyling";
import { TextMateTokens } from "./textmate";
import { TypeOverride } from "./typeOverride";
import { DEFAULT_EDITOR_OPTIONS, MonacoEditor } from "./widgets";
import { registerInlineCompletions } from "./zones";

/** Language worker per Monaco worker label (the editor worker for everything else). */
const WORKER_FOR_LABEL: Record<string, string> = {
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
  handlebars: "html",
  razor: "html",
  typescript: "ts",
  javascript: "ts",
};

/** How long the outline waits for every symbol provider before giving up on this read. */
const SYMBOLS_DEADLINE_MS = 8000;

const SYMBOL_KINDS = [
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enumMember",
  "struct",
  "event",
  "operator",
  "typeParameter",
];
function toSymbol(s: monaco.languages.DocumentSymbol): OutlineSymbol {
  return {
    name: s.name,
    kind: SYMBOL_KINDS[s.kind] ?? "symbol",
    line: s.range.startLineNumber,
    column: s.range.startColumn,
    endLine: s.range.endLineNumber,
    endColumn: s.range.endColumn,
    children: (s.children ?? []).map(toSymbol),
  };
}

/** Scratch copies for checkText; hidden from the problems list. */
const CHECK_PREFIX = ".edit-check-";
const isCheckCopy = (path: string) =>
  path.slice(path.lastIndexOf("/") + 1).startsWith(CHECK_PREFIX);
const CHECKED_LANGUAGES = new Set([
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "json",
  "jsonc",
  "css",
  "scss",
  "less",
]);

const TS_FAMILY = new Set(["typescript", "javascript", "tsx", "jsx"]);

class MonacoEngine implements EditorEngine {
  private readonly store = new DisposableStore();
  private readonly editors = new Set<MonacoEditor | MonacoDiffEditor>();
  private readonly linkCopyDocs = new WeakSet<Document>();
  private readonly tokens: TextMateTokens;
  /** Each language's TextMate grammar: the editor's or an extension's (D102). */
  private readonly grammarLoader: GrammarLoader;
  private readonly contributedLanguages = new ContributedLanguages();
  private theme: EditorTheme;
  private copies = 0;
  private options: EditorOptions = DEFAULT_EDITOR_OPTIONS;
  private readonly markersChanged = this.store.add(new Emitter<readonly string[]>());
  /** Notebooks' cells as documents for the language servers (D204). */
  private readonly notebookHub = new NotebookLanguageHub();
  readonly onDidChangeDiagnostics = this.markersChanged.event;

  constructor(
    private readonly highlighter: HighlighterCore,
    theme: EditorTheme,
    private readonly host: EngineHost,
  ) {
    this.theme = theme;
    this.tokens = new TextMateTokens(highlighter);
    this.grammarLoader = new GrammarLoader(highlighter, this.tokens);
    this.defineAndSet();
    const sub = monaco.editor.onDidChangeMarkers((uris) =>
      this.markersChanged.fire(uris.filter((u) => u.scheme === "file").map((u) => u.fsPath)),
    );
    this.store.add({ dispose: () => sub.dispose() });
    // VS Code's editor keys in the IDE's context, from the editor with the text focus.
    const focusKeys = trackEditorTextFocus(host);
    this.store.add({ dispose: () => focusKeys.dispose() });
    // editor.defaultFormatter and the "multiple formatters" question (formatterChoice.ts).
    const formatterChoice = installFormatterChoice(host);
    this.store.add({ dispose: () => formatterChoice.dispose() });
    this.store.add({ dispose: () => this.notebookHub.dispose() });
    this.store.add(
      this.notebookHub.onDidChangeDiagnostics((paths) => this.markersChanged.fire(paths)),
    );
    // Files opened after a task reported problems in them get those squiggles too.
    const created = monaco.editor.onDidCreateModel((model) => {
      const key = externalKey(model);
      if (!key) return;
      for (const [owner, byPath] of this.external) {
        const list = byPath.get(key);
        if (list) monaco.editor.setModelMarkers(model, `${EXTERNAL}${owner}`, list.map(toMarker));
      }
    });
    this.store.add({ dispose: () => created.dispose() });
  }

  /** Owner → path → its problems (tasks' problem matchers). */
  private readonly external = new Map<string, Map<string, Diagnostic[]>>();

  setExternalDiagnostics(owner: string, list: readonly Diagnostic[]): void {
    const byPath = new Map<string, Diagnostic[]>();
    // Keyed like the rest of the IDE (Windows: case-insensitive; Monaco lowercases drives); a
    // notebook cell's (an extension's for a cell document) by its cell's editor.
    for (const d of list) {
      const key = d.cell ? pathKey(`${d.path}.cell-${d.cell.id}`) : pathKey(d.path);
      byPath.set(key, [...(byPath.get(key) ?? []), d]);
    }
    const before = this.external.get(owner);
    if (byPath.size) this.external.set(owner, byPath);
    else this.external.delete(owner);
    const keys = new Set([...(before?.keys() ?? []), ...byPath.keys()]);
    for (const model of monaco.editor.getModels()) {
      const key = externalKey(model);
      if (!key) continue;
      if (keys.has(key))
        monaco.editor.setModelMarkers(
          model,
          `${EXTERNAL}${owner}`,
          (byPath.get(key) ?? []).map(toMarker),
        );
    }
  }

  createDocument(
    path: string,
    text: string,
    options: { readOnly?: boolean; eol?: LineEnding; scheme?: string } = {},
  ): EngineDocument {
    // VS Code's `firstLine` decides a name nothing else does (a shebang).
    const languageId = languageForPath(path, firstLineOf(text));
    const uri = options.scheme
      ? // A query keeps two copies of the same file (two diff tabs) apart.
        monaco.Uri.from({
          scheme: options.scheme,
          path: monaco.Uri.file(path).path,
          query: String(++this.copies),
        })
      : monaco.Uri.file(path);
    monaco.editor.getModel(uri)?.dispose();
    // Monaco keeps the text's line ending (CRLF stays CRLF); text without one gets the OS's
    // (CRLF on Windows) unless `eol` says.
    const model = monaco.editor.createModel(text, languageId, uri);
    if (options.eol && model.getLineCount() === 1) {
      model.setEOL(
        options.eol === "\r\n"
          ? monaco.editor.EndOfLineSequence.CRLF
          : monaco.editor.EndOfLineSequence.LF,
      );
    }
    void this.ensureGrammar(languageId);
    return new MonacoDocument(path, model, options.readOnly ?? false);
  }

  createEditor(container: HTMLElement, options?: { embedded?: boolean }): EngineEditor {
    // Link hovers copy the link, in every window an editor shows in (an auxiliary one too).
    const doc = container.ownerDocument;
    if (!this.linkCopyDocs.has(doc)) {
      this.linkCopyDocs.add(doc);
      this.store.add(trackLinkCopy(this.host, doc));
    }
    const editor: MonacoEditor = new MonacoEditor(
      container,
      this.themeName(),
      this.options,
      () => this.editors.delete(editor),
      this.host,
      options?.embedded === true,
      options?.embedded === true ? undefined : this.forLanguage,
    );
    this.editors.add(editor);
    return editor;
  }

  async colorize(code: string, languageId: string): Promise<string> {
    // Grammars load when a file of the language first opens; a code block may come first.
    await this.ensureGrammar(languageId);
    return monaco.editor.colorize(code, languageId, { tabSize: 4 });
  }

  languages(): { id: string; aliases: string[] }[] {
    return monaco.languages.getLanguages().map((l) => ({ id: l.id, aliases: l.aliases ?? [] }));
  }

  setLanguage(doc: EngineDocument, languageId: string): void {
    monaco.editor.setModelLanguage((doc as MonacoDocument).model, languageId);
    void this.ensureGrammar(languageId);
  }

  languageFor(tag: string): string | null {
    const t = tag.toLowerCase().replace(/^\./, "");
    if (!t) return null;
    for (const lang of monaco.languages.getLanguages()) {
      if (lang.id === t || lang.aliases?.some((a) => a.toLowerCase() === t)) return lang.id;
      if (lang.extensions?.some((e) => e.toLowerCase() === `.${t}`)) return lang.id;
    }
    return null;
  }

  createDiffEditor(container: HTMLElement, options?: { embedded?: boolean }): EngineDiffEditor {
    const editor: MonacoDiffEditor = new MonacoDiffEditor(
      container,
      this.themeName(),
      this.options,
      () => this.editors.delete(editor),
      options?.embedded === true,
    );
    this.editors.add(editor);
    return editor;
  }

  async applyTheme(theme: EditorTheme): Promise<void> {
    this.theme = theme;
    // An extension's color theme: load its JSON into Shiki under the theme's name first.
    if (theme.syntaxTheme && !this.highlighter.getLoadedThemes().includes(theme.syntax)) {
      try {
        const json = theme.syntaxTheme as Record<string, unknown>;
        await this.highlighter.loadTheme({
          ...json,
          name: theme.syntax,
          type: theme.kind,
        } as unknown as Parameters<HighlighterCore["loadTheme"]>[0]);
        this.defineAndSet();
        return;
      } catch (err) {
        console.error(`Couldn't load the color theme ${theme.syntax}`, err);
      }
    }
    this.defineAndSet();
  }

  setContributedLanguages(languages: readonly ContributedLanguage[]): void {
    this.contributedLanguages.set(languages);
  }

  setContributedGrammars(grammars: readonly ContributedGrammar[]): void {
    this.grammarLoader.set(grammars);
  }

  setSemanticTokenScopes(list: readonly ContributedSemanticTokenScopes[]): void {
    setSemanticScopes(list);
  }

  private snippetProviders: { dispose(): void }[] = [];

  private extensionLanguageConfigs: { dispose(): void }[] = [];

  setExtensionLanguageConfigurations(
    list: readonly { languageId: string; configuration: unknown }[],
  ): void {
    for (const d of this.extensionLanguageConfigs) d.dispose();
    // Monaco merges a language's registered configurations, the latest first per field.
    this.extensionLanguageConfigs = list.map((c) =>
      monaco.languages.setLanguageConfiguration(
        c.languageId,
        toLanguageConfiguration(c.configuration) as monaco.languages.LanguageConfiguration,
      ),
    );
  }

  setSnippets(snippets: readonly ContributedSnippet[]): void {
    for (const p of this.snippetProviders) p.dispose();
    this.snippetProviders = [];
    const byLanguage = new Map<string, ContributedSnippet[]>();
    for (const s of snippets) {
      const list = byLanguage.get(s.language) ?? [];
      list.push(s);
      byLanguage.set(s.language, list);
    }
    for (const [language, list] of byLanguage) {
      this.snippetProviders.push(
        monaco.languages.registerCompletionItemProvider(language, {
          provideCompletionItems: (model, position) => {
            const word = model.getWordUntilPosition(position);
            const range = new monaco.Range(
              position.lineNumber,
              word.startColumn,
              position.lineNumber,
              word.endColumn,
            );
            return {
              suggestions: list.map((s) => ({
                label: s.prefix,
                kind: monaco.languages.CompletionItemKind.Snippet,
                detail: s.name,
                documentation: s.description || s.body,
                insertText: s.body,
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                range,
              })),
            };
          },
        }),
      );
    }
  }

  diagnostics(): Diagnostic[] {
    return [
      ...monaco.editor
        .getModelMarkers({})
        .filter(
          (m) =>
            m.resource.scheme === "file" &&
            !isCheckCopy(m.resource.path) &&
            !builtinOnKeptClosed(m),
        )
        .map(toDiagnostic),
      // Notebooks' cells (D204): every cell's, its editor made or not.
      ...this.notebookHub.diagnostics(),
    ];
  }

  async checkText(path: string, text: string, timeoutMs: number): Promise<Diagnostic[] | null> {
    const languageId = languageForPath(path);
    // Built-in checkers (TS/JS, JSON, CSS, HTML); language servers only see real documents.
    if (!CHECKED_LANGUAGES.has(languageId)) return null;
    // With typescript-language-server running the built-in TS checker is off (D199): no answer
    // rather than a wait for markers that never come; the server's own problems show after the
    // write.
    if (TS_FAMILY.has(languageId) && !builtinTypeScriptOn()) return null;
    // A sibling file, so relative imports resolve exactly as in the real one.
    const real = monaco.Uri.file(path);
    const dir = real.path.slice(0, real.path.lastIndexOf("/") + 1);
    const name = real.path.slice(real.path.lastIndexOf("/") + 1);
    const uri = real.with({ path: `${dir}${CHECK_PREFIX}${++this.copies}.${name}` });
    const model = monaco.editor.createModel(text, languageId, uri);
    try {
      return await new Promise<Diagnostic[] | null>((resolve) => {
        let settled = false;
        let quiet = 0;
        const finish = (value: Diagnostic[] | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(quiet);
          sub.dispose();
          resolve(value);
        };
        const collect = () =>
          monaco.editor
            .getModelMarkers({ resource: uri })
            .map((m) => ({ ...toDiagnostic(m), path }));
        // Workers report syntax and semantic errors in separate passes: wait for a quiet moment.
        const sub = monaco.editor.onDidChangeMarkers((uris) => {
          if (!uris.some((u) => u.toString() === uri.toString())) return;
          clearTimeout(quiet);
          quiet = window.setTimeout(() => finish(collect()), 300);
        });
        const timer = window.setTimeout(() => finish(quiet ? collect() : null), timeoutMs);
      });
    } finally {
      model.dispose();
    }
  }

  executeProvider(query: ProviderQuery): Promise<unknown> {
    return executeProviderQuery(this.host, query);
  }

  async documentSymbols(doc: EngineDocument): Promise<OutlineSymbol[]> {
    const model = (doc as MonacoDocument).model;
    if (!model || model.isDisposed()) return [];
    // The outline service caches per model version and debounces like VS Code's breadcrumbs.
    const service = StandaloneServices.get(IOutlineModelService);
    // Bounded (D379): a provider that never answers (the built-in TS worker restarted under a
    // request when a project server took over) held the Outline, breadcrumbs and "@" forever.
    // Cancelled at the deadline, the stuck request leaves the cache and the next read asks again.
    // The race settles this read whatever the request does (a shared one may not reject).
    const cts = new monaco.CancellationTokenSource();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        cts.cancel();
        resolve(null);
      }, SYMBOLS_DEADLINE_MS);
    });
    const outline = await Promise.race([
      service.getOrCreate(model, cts.token).catch(() => null),
      deadline,
    ]).finally(() => {
      clearTimeout(timer);
      cts.dispose();
    });
    if (!outline) return [];
    // TypeScript's navigation tree also lists imports and anonymous callbacks ("<function>");
    // VS Code's outline and breadcrumbs leave both out, and so do we.
    const tsLike = /^(typescript|javascript|tsx|jsx)$/.test(model.getLanguageId());
    const keep = (s: monaco.languages.DocumentSymbol) =>
      !tsLike ||
      (s.name !== "<function>" &&
        s.name !== "<class>" &&
        !/^\s*import\b/.test(model.getLineContent(s.range.startLineNumber)));
    const map = (list: readonly monaco.languages.DocumentSymbol[]): OutlineSymbol[] =>
      list.filter(keep).map((s) => ({ ...toSymbol(s), children: map(s.children ?? []) }));
    return map(outline.getTopLevelSymbols() as monaco.languages.DocumentSymbol[]);
  }

  async codeActionsOnSave(doc: EngineDocument, kinds: readonly string[]): Promise<void> {
    if (doc instanceof MonacoDocument) await runCodeActionsOnSave(doc.model, kinds);
  }

  attachLanguageClient(client: LanguageClient): Disposable {
    const attached = attachLanguageClient(client, this.host, (path) =>
      this.notebookHub.isNotebookDocument(client, path),
    );
    // Its notebooks too (D204): the cells of its languages as one document.
    const cells = this.notebookHub.addClient(client);
    return {
      dispose: () => {
        cells.dispose();
        attached.dispose();
      },
    };
  }

  attachNotebook(source: NotebookLanguageSource): Disposable {
    return this.notebookHub.addNotebook(source);
  }

  setEmmet(languages: readonly string[]): void {
    setEmmet(languages);
  }

  setJsonSchemas(schemas: readonly JsonSchemaAssociation[]): void {
    setJsonSchemas(schemas);
  }

  /** A language's own editor settings (its `[lang]` blocks, D201); unset: the plain ones. */
  private forLanguage: ((languageId: string, path?: string) => EditorOptions) | undefined;

  setOptions(
    options: EditorOptions,
    forLanguage?: (languageId: string, path?: string) => EditorOptions,
  ): void {
    this.options = options;
    this.forLanguage = forLanguage;
    for (const editor of this.editors) editor.setOptions(options, forLanguage);
  }

  private inlineCompletions: { dispose(): void } | null = null;

  private debugHover: { dispose(): void } | null = null;

  setDebugHover(source: DebugHoverSource | null): void {
    this.debugHover?.dispose();
    this.debugHover = source ? registerDebugHover(source) : null;
  }

  private extensionFeatures: { dispose(): void } | null = null;
  private extensionDecorations: ExtensionDecorations | null = null;

  setExtensionFeatures(features: readonly LanguageFeature[]): void {
    this.extensionFeatures?.dispose();
    this.extensionFeatures = features.length
      ? registerExtensionFeatures(features, this.host)
      : null;
  }

  setExtensionDecorations(decorations: readonly EditorDecoration[]): void {
    this.extensionDecorations ??= new ExtensionDecorations();
    this.extensionDecorations.set(decorations);
  }

  private readonly typeOverride = new TypeOverride();

  setTypeHandler(handler: ((text: string) => void) | null): void {
    this.typeOverride.set(handler);
  }

  typeDefault(text: string): boolean {
    return this.typeOverride.typeDefault(text);
  }

  setInlineCompletions(source: InlineCompletionSource | null): void {
    this.inlineCompletions?.dispose();
    this.inlineCompletions = source ? registerInlineCompletions(source, () => 350) : null;
  }

  private themeName(): string {
    return this.highlighter.getLoadedThemes().includes(this.theme.syntax)
      ? this.theme.syntax
      : this.theme.kind === "light"
        ? "light-plus"
        : "dark-plus";
  }

  /**
   * Defines the Monaco theme (the syntax theme's editor colors under ours) and activates it, then
   * gives Monaco the syntax theme's color map for the TextMate tokens (textmate.ts).
   */
  private defineAndSet(): void {
    const name = this.themeName();
    // @shikijs/monaco types against monaco-editor-core; the shape is Monaco's theme data. Token
    // rules aren't needed: tokens carry their colors (the theme's color map).
    const base = textmateThemeToMonacoTheme(
      this.highlighter.getTheme(name),
    ) as unknown as monaco.editor.IStandaloneThemeData;
    // A color theme the user picked (Shiki's or an extension's): its own editor colors win
    // (scrollbar, widgets, selection… as in VS Code), ours fill what it doesn't set. The
    // built-in Dark+ / Light+: our tokens win (D138).
    monaco.editor.defineTheme(name, {
      ...base,
      rules: [],
      colors: this.theme.syntaxTheme
        ? { ...this.theme.colors, ...themeColors(this.theme.syntaxTheme) }
        : { ...base.colors, ...this.theme.colors },
    });
    monaco.editor.setTheme(name);
    this.tokens.applyTheme(name);
  }

  /** Starts loading a language's grammar ahead of its first file (a language id or a path). */
  warmLanguage(languageOrPath: string): Promise<void> {
    const id = this.grammarLoader.has(languageOrPath)
      ? languageOrPath
      : languageForPath(languageOrPath);
    return this.ensureGrammar(id);
  }

  /** Loads the grammar for `languageId` once, then rebinds Shiki tokenization. */
  private ensureGrammar(languageId: string): Promise<void> {
    return this.grammarLoader.ensure(languageId);
  }

  disposePreviewModels(): void {
    disposePeekModels();
  }

  private userKeybindings: Disposable | null = null;

  keybindings(): EngineKeybinding[] {
    return engineKeybindings();
  }

  hasCommand(id: string): boolean {
    return hasEngineCommand(id);
  }

  actions(): { id: string; title: string }[] {
    return engineActions();
  }

  handlesKey(e: KeyboardEvent): boolean {
    return engineHandlesKey(e);
  }

  chordCommand(
    first: KeyboardEvent,
    second: KeyboardEvent,
  ): { command: string; args: unknown } | null {
    return engineChordCommand(first, second);
  }

  setUserKeybindings(rules: readonly KeybindingRule[], platform: Platform): KeybindingRule[] {
    this.userKeybindings?.dispose();
    const { applied, skipped } = applyEngineUserKeybindings(rules, platform);
    this.userKeybindings = applied;
    return skipped;
  }

  dispose(): void {
    for (const editor of [...this.editors]) editor.dispose();
    this.extensionFeatures?.dispose();
    this.extensionFeatures = null;
    this.extensionDecorations?.dispose();
    this.extensionDecorations = null;
    this.typeOverride.dispose();
    disposePeekModels();
    this.userKeybindings?.dispose();
    this.store.dispose();
  }
}

const SEVERITY: Record<number, DiagnosticSeverity> = {
  [monaco.MarkerSeverity.Error]: "error",
  [monaco.MarkerSeverity.Warning]: "warning",
  [monaco.MarkerSeverity.Info]: "info",
  [monaco.MarkerSeverity.Hint]: "hint",
};

/** Marker owners of problems from outside the language services (D134). */
const EXTERNAL = "external:";

/**
 * The key a model's outside problems are kept under: a file's path, or a notebook cell editor's
 * (`<notebook>.cell-<id>.<ext>`) as `<notebook>.cell-<id>`; null for other models.
 */
function externalKey(model: monaco.editor.ITextModel): string | null {
  if (model.uri.scheme === "file") return pathKey(model.uri.fsPath);
  if (model.uri.scheme === "notebook-cell")
    return pathKey(model.uri.fsPath.replace(/\.[A-Za-z0-9]+$/, ""));
  return null;
}

/**
 * A built-in checker's marker (TS/JS, JSON, CSS, HTML workers) on a closed file whose model is
 * kept for undo: they keep checking the model, but a closed file's problems are what language
 * servers and tasks report for it (D218).
 */
function builtinOnKeptClosed(m: monaco.editor.IMarker): boolean {
  if (m.owner.startsWith("lsp:") || m.owner.startsWith(EXTERNAL)) return false;
  const model = monaco.editor.getModel(m.resource);
  return !!model && isKeptClosed(model);
}

const MARKER_SEVERITY: Record<DiagnosticSeverity, monaco.MarkerSeverity> = {
  error: monaco.MarkerSeverity.Error,
  warning: monaco.MarkerSeverity.Warning,
  info: monaco.MarkerSeverity.Info,
  hint: monaco.MarkerSeverity.Hint,
};

function toMarker(d: Diagnostic): monaco.editor.IMarkerData {
  const tags = (d.tags ?? []).map((t) =>
    t === "unnecessary" ? monaco.MarkerTag.Unnecessary : monaco.MarkerTag.Deprecated,
  );
  return {
    severity: MARKER_SEVERITY[d.severity],
    message: d.message,
    ...(d.source && { source: d.source }),
    // A code with a page shows as its link in the hover (VS Code's `code.target`).
    ...(d.code &&
      (d.codeTarget
        ? { code: { value: d.code, target: monaco.Uri.parse(d.codeTarget) } }
        : { code: d.code })),
    ...(tags.length && { tags }),
    ...(d.related?.length && {
      relatedInformation: d.related.map((r) => ({
        resource: monaco.Uri.file(r.path),
        message: r.message,
        startLineNumber: r.line,
        startColumn: r.column,
        endLineNumber: r.endLine,
        endColumn: r.endColumn,
      })),
    }),
    startLineNumber: d.line,
    startColumn: d.column,
    endLineNumber: d.endLine,
    endColumn: d.endColumn,
  };
}

function toDiagnostic(m: monaco.editor.IMarker): Diagnostic {
  const code = typeof m.code === "object" ? m.code.value : m.code;
  return {
    ...(m.owner.startsWith(EXTERNAL) && { external: true }),
    path: m.resource.fsPath,
    severity: SEVERITY[m.severity] ?? "info",
    message: m.message,
    source: m.source || m.owner,
    code: code || undefined,
    line: m.startLineNumber,
    column: m.startColumn,
    endLine: m.endLineNumber,
    endColumn: m.endColumn,
  };
}

async function createEngine(theme: EditorTheme, host: EngineHost): Promise<EditorEngine> {
  // Monaco's workers are separate bundled files next to index.html (build.mjs `workers` entries).
  Reflect.set(globalThis, "MonacoEnvironment", {
    getWorker: (_moduleId: string, label: string) => {
      const file = WORKER_FOR_LABEL[label] ?? "editor";
      return new Worker(`./workers/${file}.worker.js`, { name: label });
    },
  });
  // Before anything asks Monaco for a service: overrides only apply on its first initialization.
  StandaloneServices.initialize({ actionWidgetService: new MenuActionWidgetService(host) });
  for (const lang of LANGUAGES) {
    monaco.languages.register({ id: lang.id, extensions: [...lang.extensions] });
  }
  registerLanguageConfigurations(LANGUAGES.map((l) => l.id));
  // Language servers' semantic tokens colored through TextMate scopes (D204).
  installSemanticStyling();
  configureLanguageFeatures();
  registerFallbackSymbols();
  registerPathLinks(host);
  registerConflictLens(host);
  // Go to definition (and friends) in another file opens it in an IDE editor tab.
  monaco.editor.registerEditorOpener({
    openCodeEditor: (_source, resource, selection) => {
      if (resource.scheme !== "file") return false;
      const at =
        selection && "startLineNumber" in selection
          ? { line: selection.startLineNumber, column: selection.startColumn }
          : selection
            ? { line: selection.lineNumber, column: selection.column }
            : { line: 1, column: 1 };
      host.openFile(resource.fsPath, at.line, at.column);
      return true;
    },
  });
  // Ctrl+click on a web link in the text or a hover opens it (D190: Monaco's own opener tried
  // window.open, which the app doesn't allow).
  // (Engine-wide, for the app's lifetime, like the editor opener above.)
  monaco.editor.registerLinkOpener({
    open: (resource) => {
      if (!/^(https?|mailto)$/.test(resource.scheme)) return false;
      host.run("ui.openLink", { url: resource.toString(true) });
      return true;
    },
  });
  const highlighter = await createHighlighterCore({
    themes: [darkPlus, lightPlus],
    langs: [],
    engine: await regexEngine(),
  });
  const engine = new MonacoEngine(highlighter, theme, host);
  // A picked color theme's syntax colors (Shiki's, an extension's, Claude Dark) are loaded into
  // the highlighter by applyTheme; the constructor only set the built-in ones, so a start with
  // such a theme drew Dark+ syntax until the theme was switched again (D269).
  if (theme.syntaxTheme) await engine.applyTheme(theme);
  // The common grammars load while the IDE is idle, so the first file of each colors at once.
  const warm = ["typescript", "javascript", "tsx", "json", "jsonc", "css", "html", "markdown"];
  const next = () => {
    const lang = warm.shift();
    if (!lang) return;
    void engine.warmLanguage(lang).finally(() => idle(next));
  };
  idle(next);
  return engine;
}

/**
 * Oniguruma (WebAssembly, a lazy chunk): the regex engine TextMate grammars are written for and
 * VS Code uses, so every grammar behaves as there (D132). Shiki's JavaScript engine translates the
 * patterns and some translations differ per webview (WebKit kept `//` comments open past the end
 * of the line); it stays as the fallback if WebAssembly can't start.
 */
async function regexEngine() {
  try {
    return await createOnigurumaEngine(import("shiki/wasm"));
  } catch (err) {
    console.warn("Oniguruma unavailable, using the JavaScript regex engine", err);
    return createJavaScriptRegexEngine({ forgiving: true });
  }
}

/** requestIdleCallback where there is one (WebKit has none), else a short timeout. */
function idle(run: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: object) => number })
    .requestIdleCallback;
  if (ric) ric(run, { timeout: 2000 });
  else setTimeout(run, 200);
}

const module: EditorEngineModule = { createEngine };
export default module;

/**
 * The hover over a link ("Follow link (ctrl + click)") has Monaco's copy button, which copied
 * that sentence: it copies the link instead (D190). The link is the one the pointer was last on.
 */
/**
 * `editorTextFocus`, `editorHasSelection`, `editorHasMultipleSelections`, `editorReadonly` and
 * `editorLangId` (VS Code's language ids, as extensions' `when` clauses name them) follow the
 * editor that has the text focus; `editorTextFocus` goes false when none has it. Monaco keeps
 * its own copies for its own keys; these are the IDE's, for the keybindings of extensions.
 */
function trackEditorTextFocus(host: EngineHost): { dispose(): void } {
  if (!host.setContext) return { dispose() {} };
  const set = host.setContext;
  let focused: monaco.editor.ICodeEditor | null = null;
  const report = (editor: monaco.editor.ICodeEditor) => {
    if (focused !== editor) return;
    const selections = editor.getSelections() ?? [];
    const model = editor.getModel();
    set({
      editorTextFocus: true,
      editorHasSelection: selections.some((s) => !s.isEmpty()),
      editorHasMultipleSelections: selections.length > 1,
      editorReadonly: editor.getOption(monaco.editor.EditorOption.readOnly) === true,
      editorLangId: model ? vscodeLanguageId(model.getLanguageId()) : "",
    });
  };
  const perEditor = new Map<monaco.editor.ICodeEditor, monaco.IDisposable[]>();
  const watch = (editor: monaco.editor.ICodeEditor) => {
    if (perEditor.has(editor)) return;
    perEditor.set(editor, [
      editor.onDidFocusEditorText(() => {
        focused = editor;
        report(editor);
      }),
      editor.onDidBlurEditorText(() => {
        if (focused !== editor) return;
        focused = null;
        set({
          editorTextFocus: false,
          editorHasSelection: false,
          editorHasMultipleSelections: false,
        });
      }),
      editor.onDidChangeCursorSelection(() => report(editor)),
      editor.onDidChangeModel(() => report(editor)),
      editor.onDidChangeModelLanguage(() => report(editor)),
      editor.onDidDispose(() => {
        for (const d of perEditor.get(editor) ?? []) d.dispose();
        perEditor.delete(editor);
        if (focused === editor) {
          focused = null;
          set({ editorTextFocus: false });
        }
      }),
    ]);
  };
  for (const editor of monaco.editor.getEditors()) watch(editor);
  const created = monaco.editor.onDidCreateEditor(watch);
  return {
    dispose: () => {
      created.dispose();
      for (const list of perEditor.values()) for (const d of list) d.dispose();
      perEditor.clear();
    },
  };
}

function trackLinkCopy(host: EngineHost, doc: Document): { dispose(): void } {
  let lastLink = "";
  const onMove = (e: MouseEvent) => {
    const el =
      e.target instanceof Element
        ? e.target.closest(".detected-link, .detected-link-active")
        : null;
    if (el?.textContent) lastLink = el.textContent.trim();
  };
  const onClick = (e: MouseEvent) => {
    const button =
      e.target instanceof Element ? e.target.closest(".monaco-hover .hover-copy-button") : null;
    if (!button || !lastLink) return;
    const row = button.closest(".hover-row");
    if (!/Follow link|Open link|ctrl \+ click|cmd \+ click/i.test(row?.textContent ?? "")) return;
    e.preventDefault();
    e.stopPropagation();
    void host.writeClipboard(lastLink);
  };
  doc.addEventListener("mousemove", onMove, { passive: true, capture: true });
  doc.addEventListener("click", onClick, true);
  return {
    dispose: () => {
      doc.removeEventListener("mousemove", onMove, { capture: true });
      doc.removeEventListener("click", onClick, true);
    },
  };
}
