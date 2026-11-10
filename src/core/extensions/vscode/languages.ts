// The `vscode` shim's `languages` (D256): each of VS Code's provider registrations on the IDE's
// own (`ide.languages`), the document and position the provider gets from the IDE's 1-based
// context and its answer turned back into the IDE's shapes; diagnostic collections merged per
// file into the extension's problems. Providers get a real CancellationToken (the editor's
// cancellation, through the call's token), documents outside the folder, untitled ones and
// notebook cells (`vscode-notebook-cell:`) as VS Code's selectors score them, and completion
// items and inlay hints resolved later. DOM-free and unit-tested.

import type { WorkerApi } from "../rpc";
import type * as Lang from "../rpcLanguages";
import type { CallToken } from "../rpcLanguages";
import type { ShimCommands } from "./commands";
import {
  fromCompletionItem,
  fromDiagnostic,
  fromInlayHint,
  fromInlineValue,
  fromLocations,
  fromRange,
  fromTextEdit,
  fromWorkspaceEditText,
  hoverText,
  markdownOf,
  pathOf,
  symbolKindName,
  toDiagnostic,
  toPosition,
  toRange,
  uriOf,
} from "./convert";
import { type Documents, pathKey, ShimTextDocument } from "./document";
import { ideLanguageId, vscodeLanguageId } from "./languageIds";
import {
  CallHierarchyItem,
  CodeActionKind,
  CodeActionTriggerKind,
  type Command,
  type CompletionList,
  CompletionTriggerKind,
  type Hover,
  SignatureHelpTriggerKind,
  SymbolKind,
  TypeHierarchyItem,
  type Color as VsColor,
  type CompletionItem as VsCompletionItem,
  type InlayHint as VsInlayHint,
} from "./languageTypes";
import {
  type CancellationToken,
  CancellationTokenSource,
  type Diagnostic,
  Disposable,
  EventEmitter,
  NONE_TOKEN,
  Range,
  SnippetString,
  type TextEdit,
  type Uri,
  type WorkspaceEdit,
} from "./types";

type Filter = {
  language?: string;
  scheme?: string;
  /** A glob, or VS Code's RelativePattern (`base` / `baseUri` and a glob under it). */
  pattern?: string | { pattern: string; base?: string; baseUri?: Uri };
  notebookType?: string;
};
export type DocumentSelector = string | Filter | readonly (string | Filter)[];

/** The notebook a cell's document is in (VS Code's score() takes its Uri and type). */
export interface NotebookOfCell {
  uri: Uri;
  notebookType: string;
}

/** A small glob ("**", "*", "?", "{a,b}") as a RegExp over "/"-separated paths. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] ?? "";
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 2 : 1;
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else if (ch === "{") out += "(?:";
    else if (ch === "}") out += ")";
    else if (ch === ",") out += "|";
    else out += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

/** Whether a filter's glob matches `uri` (a RelativePattern only under its base). */
function patternMatches(pattern: NonNullable<Filter["pattern"]>, uri: Uri): boolean {
  const path = (uri.scheme === "file" ? uri.fsPath : uri.path).replace(/\\/g, "/");
  let glob = typeof pattern === "string" ? pattern : pattern.pattern;
  if (typeof pattern === "object") {
    const base = pattern.base ?? (pattern.baseUri ? pathOf(pattern.baseUri) : undefined);
    if (base !== undefined) {
      const root = base.replace(/\\/g, "/").replace(/\/+$/, "");
      if (!path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return false;
      return globToRegExp(glob).test(path.slice(root.length + 1));
    }
  }
  if (glob === path) return true;
  const re = globToRegExp(glob);
  // As VS Code's glob on the whole path; a bare "*.py" also matches the file's name.
  glob = `**/${glob}`;
  return re.test(path) || re.test(path.split("/").pop() ?? "") || globToRegExp(glob).test(path);
}

/**
 * VS Code's languages.match (its score()): how well `selector` matches `doc` (0: not at all;
 * 10 exact, 5 a "*"). A filter's scheme, language, notebookType and pattern must all hold; a
 * notebookType filter matches only a notebook cell's document, whose notebook Uri then stands
 * for the document's in `scheme` and `pattern`. An empty filter matches nothing.
 */
export function matchSelector(
  selector: DocumentSelector,
  doc: { languageId: string; uri: Uri },
  notebook?: NotebookOfCell,
): number {
  if (Array.isArray(selector)) {
    let best = 0;
    for (const s of selector as readonly (string | Filter)[]) {
      const value = matchSelector(s, doc, notebook);
      if (value === 10) return 10;
      best = Math.max(best, value);
    }
    return best;
  }
  if (typeof selector === "string")
    return selector === "*" ? 5 : selector === doc.languageId ? 10 : 0;
  if (!selector || typeof selector !== "object") return 0;
  const s = selector as Filter;
  const uri = s.notebookType && notebook ? notebook.uri : doc.uri;
  let score = 0;
  if (s.scheme) {
    if (s.scheme === uri.scheme) score = 10;
    else if (s.scheme === "*") score = 5;
    else return 0;
  }
  if (s.language) {
    if (s.language === doc.languageId) score = 10;
    else if (s.language === "*") score = Math.max(score, 5);
    else return 0;
  }
  if (s.notebookType) {
    if (s.notebookType === notebook?.notebookType) score = 10;
    else if (s.notebookType === "*" && notebook) score = Math.max(score, 5);
    else return 0;
  }
  if (s.pattern) {
    if (patternMatches(s.pattern, uri)) score = 10;
    else return 0;
  }
  return score;
}

/** The IDE's language list for a selector ("*" when a filter names none). */
export function languagesOf(selector: DocumentSelector): string[] {
  const list = Array.isArray(selector) ? selector : [selector as string | Filter];
  const out = new Set<string>();
  for (const s of list) {
    const language = typeof s === "string" ? s : s.language;
    if (!language || language === "*") return ["*"];
    // Registered on the editor's language ("typescriptreact" is its "tsx"); a notebook filter's
    // language is its cells'.
    out.add(ideLanguageId(language));
  }
  return out.size ? [...out] : ["*"];
}

const DIAGNOSTICS_DEBOUNCE_MS = 0;

/** Every diagnostic collection of the extension, merged per file into its problems. */
class DiagnosticsHub {
  readonly collections = new Set<ShimDiagnosticCollection>();
  readonly onDidChange = new EventEmitter<{ uris: readonly Uri[] }>();
  private pending = new Map<string, Uri>();
  private scheduled = false;

  constructor(private readonly ide: WorkerApi) {}

  changed(uris: readonly Uri[]): void {
    for (const uri of uris) this.pending.set(pathKey(pathOf(uri)), uri);
    if (this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => this.flush(), DIAGNOSTICS_DEBOUNCE_MS);
  }

  private flush(): void {
    this.scheduled = false;
    const uris = [...this.pending.values()];
    this.pending.clear();
    for (const uri of uris) {
      const all = this.diagnosticsOf(uri);
      const path = pathOf(uri);
      const sent = all.length
        ? this.ide.languages.setDiagnostics(path, all.map(fromDiagnostic))
        : this.ide.languages.clearDiagnostics(path);
      void sent.catch(() => {});
    }
    if (uris.length) this.onDidChange.fire({ uris });
  }

  diagnosticsOf(uri: Uri): Diagnostic[] {
    return [...this.collections].flatMap((c) => c.get(uri) ?? []);
  }

  all(): [Uri, Diagnostic[]][] {
    const map = new Map<string, [Uri, Diagnostic[]]>();
    for (const c of this.collections)
      c.forEach((uri, diags) => {
        const key = pathKey(pathOf(uri));
        const entry = map.get(key) ?? [uri, []];
        entry[1].push(...diags);
        map.set(key, entry);
      });
    return [...map.values()];
  }
}

export class ShimDiagnosticCollection {
  private readonly entries = new Map<string, { uri: Uri; diagnostics: readonly Diagnostic[] }>();

  constructor(
    readonly name: string,
    private readonly hub: DiagnosticsHub,
  ) {
    hub.collections.add(this);
  }

  set(
    uriOrEntries: Uri | readonly [Uri, readonly Diagnostic[] | undefined][],
    diagnostics?: readonly Diagnostic[] | undefined,
  ): void {
    if (Array.isArray(uriOrEntries)) {
      const merged = new Map<string, { uri: Uri; diagnostics: Diagnostic[] | undefined }>();
      for (const [uri, diags] of uriOrEntries as readonly [
        Uri,
        readonly Diagnostic[] | undefined,
      ][]) {
        const key = pathKey(pathOf(uri));
        const entry = merged.get(key);
        // An undefined entry clears what came before it for that file (VS Code's).
        if (!diags) merged.set(key, { uri, diagnostics: undefined });
        else if (entry?.diagnostics) entry.diagnostics.push(...diags);
        else merged.set(key, { uri, diagnostics: [...diags] });
      }
      for (const { uri, diagnostics: d } of merged.values()) this.setOne(uri, d);
      this.hub.changed([...merged.values()].map((e) => e.uri));
      return;
    }
    this.setOne(uriOrEntries as Uri, diagnostics);
    this.hub.changed([uriOrEntries as Uri]);
  }

  private setOne(uri: Uri, diagnostics: readonly Diagnostic[] | undefined): void {
    const key = pathKey(pathOf(uri));
    if (!diagnostics?.length) this.entries.delete(key);
    else this.entries.set(key, { uri, diagnostics: [...diagnostics] });
  }

  delete(uri: Uri): void {
    this.setOne(uri, undefined);
    this.hub.changed([uri]);
  }

  clear(): void {
    const uris = [...this.entries.values()].map((e) => e.uri);
    this.entries.clear();
    this.hub.changed(uris);
  }

  forEach(
    callback: (uri: Uri, diagnostics: readonly Diagnostic[], collection: this) => unknown,
  ): void {
    for (const e of [...this.entries.values()]) callback(e.uri, e.diagnostics, this);
  }

  get(uri: Uri): readonly Diagnostic[] | undefined {
    return this.entries.get(pathKey(pathOf(uri)))?.diagnostics;
  }

  has(uri: Uri): boolean {
    return this.entries.has(pathKey(pathOf(uri)));
  }

  dispose(): void {
    this.clear();
    this.hub.collections.delete(this);
  }

  *[Symbol.iterator](): IterableIterator<[Uri, readonly Diagnostic[]]> {
    for (const e of this.entries.values()) yield [e.uri, e.diagnostics];
  }
}

const MAX_RESOLVED = 100;
const MAX_HIERARCHY_ITEMS = 2000;

/** An extension's provider object: its methods are looked up by name. */
type Provider = object;

const has = (provider: Provider, method: string) =>
  typeof (provider as Record<string, unknown>)[method] === "function";

/** A notebook cell's document as extensions know it (`vscode-notebook-cell:`), and its notebook. */
export type CellDocumentOf = (
  notebook: string,
  cellId: string,
) =>
  | {
      document: ShimTextDocument;
      notebook: NotebookOfCell;
      /** Brings the document to the editor's text (a change event, as VS Code's). */
      sync?(text: string): void;
    }
  | undefined;

/** Completion items and inlay hints kept to resolve (by the id the editor gives back), at most. */
const MAX_KEPT_TO_RESOLVE = 5000;

/** A bounded store of the extension's objects the editor may ask to resolve later. */
class KeptForResolve<T> {
  private readonly kept = new Map<string, T>();
  private seq = 0;

  constructor(private readonly prefix: string) {}

  keep(item: T): string {
    const id = `${this.prefix}${++this.seq}`;
    this.kept.set(id, item);
    for (const oldest of this.kept.keys()) {
      if (this.kept.size <= MAX_KEPT_TO_RESOLVE) break;
      this.kept.delete(oldest);
    }
    return id;
  }

  get(id: unknown): T | undefined {
    return this.kept.get(String(id));
  }
}

/** VS Code's CancellationToken for the IDE's CallToken (none: a token that never fires). */
export function cancellationOf(token: CallToken | undefined): CancellationToken {
  if (!token) return NONE_TOKEN;
  const source = new CancellationTokenSource();
  if (token.isCancellationRequested) source.cancel();
  else token.onCancellationRequested(() => source.cancel());
  return source.token;
}

export function createLanguages(
  ide: WorkerApi,
  docs: Documents,
  commands: ShimCommands,
  unsupported: (name: string) => unknown,
  cellDocument: CellDocumentOf = () => undefined,
) {
  const hub = new DiagnosticsHub(ide);
  const L = ide.languages;
  const disposable = (d: { dispose(): void }) => new Disposable(() => d.dispose());
  const call = <T>(
    provider: Provider,
    method: string,
    ...args: unknown[]
  ): Promise<T | undefined> => {
    const fn = (provider as Record<string, unknown>)[method];
    return Promise.resolve(
      typeof fn === "function"
        ? ((fn as (...a: unknown[]) => T).apply(provider, args) as T)
        : undefined,
    );
  };

  /** Cells of notebooks the extension doesn't know yet: a document of their own each. */
  const looseCells = new Map<string, ShimTextDocument>();
  /** A notebook cell's document with the editor's text now, and its notebook when known. */
  const cellFor = (
    cell: Lang.CellOfNotebook,
    languageId: string,
  ): { document: ShimTextDocument; notebook?: NotebookOfCell } => {
    const known = cellDocument(cell.notebook, cell.id);
    const key = `${pathKey(cell.notebook)}#${cell.id}`;
    let document = known?.document ?? looseCells.get(key);
    const language = vscodeLanguageId(languageId);
    if (!document || document.languageId !== language) {
      document = new ShimTextDocument(
        `vscode-notebook-cell:${cell.notebook}#${cell.id}`,
        language,
        cell.text,
      );
      if (!known) {
        looseCells.set(key, document);
        // A few hundred cells at most: the oldest go first.
        if (looseCells.size > 500) looseCells.delete(looseCells.keys().next().value ?? "");
      }
    }
    // The editor's text is the truth for positions (the notebook's update may come after); the
    // notebook's own cell document tells its listeners.
    if (known?.sync && document === known.document) known.sync(cell.text);
    else if (document.setText(cell.text)) document.version++;
    return { document, ...(known && { notebook: known.notebook }) };
  };

  /** The notebook of a cell's document (`vscode-notebook-cell:<notebook>#<cell>`), if known. */
  const notebookOfDocument = (d: { uri: Uri }): NotebookOfCell | undefined =>
    d.uri.scheme === "vscode-notebook-cell"
      ? cellDocument(d.uri.with({ scheme: "file", fragment: "" }).fsPath, d.uri.fragment)?.notebook
      : undefined;

  /** The document a provider is asked about, when the selector matches it. */
  const documentFor = async (
    selector: DocumentSelector,
    ctx: { path: string; languageId: string; cell?: Lang.CellOfNotebook },
  ): Promise<ShimTextDocument | undefined> => {
    if (ctx.cell) {
      const { document, notebook } = cellFor(ctx.cell, ctx.languageId);
      return matchSelector(selector, document, notebook) > 0 ? document : undefined;
    }
    const doc = await docs.sync(ctx.path, ctx.languageId);
    return doc && matchSelector(selector, doc) > 0 ? doc : undefined;
  };
  const at = async (selector: DocumentSelector, ctx: Lang.ProviderContext) => {
    const doc = await documentFor(selector, ctx);
    return doc ? { doc, pos: doc.validatePosition(toPosition(ctx.line, ctx.column)) } : undefined;
  };
  const ref = (c: Command | undefined) => {
    const r = commands.ref(c);
    return r ? { command: r.command, ...(r.input !== undefined && { input: r.input }) } : {};
  };
  const locationsProvider =
    (selector: DocumentSelector, provider: Provider, method: string) =>
    async (ctx: Lang.ProviderContext, token?: CallToken) => {
      const a = await at(selector, ctx);
      if (!a) return null;
      return fromLocations(await call(provider, method, a.doc, a.pos, cancellationOf(token)));
    };
  const textEdits = (edits: unknown) =>
    Array.isArray(edits) ? (edits as TextEdit[]).map(fromTextEdit) : null;

  // Call and type hierarchy items: the shim keeps the provider's item; the IDE carries a handle.
  const hierarchyItems = new Map<number, CallHierarchyItem>();
  let nextItem = 1;
  const fromItem = (item: CallHierarchyItem): Lang.HierarchyItem => {
    const id = nextItem++;
    hierarchyItems.set(id, item);
    if (hierarchyItems.size > MAX_HIERARCHY_ITEMS) {
      const oldest = hierarchyItems.keys().next().value;
      if (oldest !== undefined) hierarchyItems.delete(oldest);
    }
    return {
      name: item.name,
      kind: symbolKindName(item.kind),
      ...(item.detail && { detail: item.detail }),
      path: pathOf(item.uri),
      range: fromRange(item.range),
      selectionRange: fromRange(item.selectionRange),
      data: { shimItem: id },
    };
  };
  const toItem = (item: Lang.HierarchyItem, Kind: typeof CallHierarchyItem): CallHierarchyItem => {
    const id = (item.data as { shimItem?: number } | undefined)?.shimItem;
    const kept = id !== undefined ? hierarchyItems.get(id) : undefined;
    if (kept) return kept;
    const kind = Object.entries(SymbolKind).find(
      ([k]) => symbolKindName(SymbolKind[k as keyof typeof SymbolKind]) === item.kind,
    )?.[1];
    return new Kind(
      typeof kind === "number" ? kind : SymbolKind.Function,
      item.name,
      item.detail ?? "",
      uriOf(item.path),
      toRange(item.range),
      toRange(item.selectionRange ?? item.range),
    );
  };
  const items = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []) as CallHierarchyItem[];

  return {
    hub,
    api: {
      match: (selector: DocumentSelector, document: { languageId: string; uri: Uri }) =>
        matchSelector(selector, document, notebookOfDocument(document)),
      /** Every language the editor knows (its own and extensions'), by VS Code's ids. */
      getLanguages: async () => {
        const known = await L.getLanguages().catch(() => [] as string[]);
        return [
          ...new Set([...known.map(vscodeLanguageId), ...docs.all().map((d) => d.languageId)]),
        ];
      },
      /** D258: the IDE's Change language mode (an open file), then the document as reopened. */
      setTextDocumentLanguage: async (document: ShimTextDocument, languageId: string) => {
        const path = pathOf(document.uri);
        await ide.commands.execute("editor.setLanguage", {
          path,
          language: ideLanguageId(languageId),
        });
        return (await docs.sync(path, languageId)) ?? document;
      },
      createDiagnosticCollection: (name?: string) => new ShimDiagnosticCollection(name ?? "", hub),
      getDiagnostics: (uri?: Uri) => (uri ? hub.diagnosticsOf(uri) : hub.all()),
      onDidChangeDiagnostics: hub.onDidChange.event,
      /** D258: RegExps go as `{ pattern, flags }` (language-configuration.json's shape). */
      setLanguageConfiguration: (languageId: string, configuration: Record<string, unknown>) =>
        disposable(
          L.setLanguageConfiguration(
            languageId,
            plainConfiguration(configuration) as Record<string, unknown>,
          ),
        ),
      createLanguageStatusItem: (id: string) => {
        unsupported("languages.createLanguageStatusItem");
        return { id, text: "", detail: "", severity: 0, busy: false, selector: [], dispose() {} };
      },

      registerHoverProvider: (selector: DocumentSelector, provider: Provider) =>
        disposable(
          L.registerHoverProvider(languagesOf(selector), async (ctx, token?: CallToken) => {
            const a = await at(selector, ctx);
            if (!a) return null;
            const hover = await call<Hover>(
              provider,
              "provideHover",
              a.doc,
              a.pos,
              cancellationOf(token),
            );
            const contents = hover ? hoverText(hover.contents) : "";
            if (!contents) return null;
            // Its range (VS Code's Hover.range) is what the editor highlights.
            return hover?.range ? { contents, range: fromRange(hover.range) } : contents;
          }),
        ),

      registerCompletionItemProvider: (
        selector: DocumentSelector,
        provider: Provider,
        ...triggerCharacters: string[]
      ) => {
        // VS Code's resolveCompletionItem: items kept by id until the editor selects one.
        const kept = new KeptForResolve<VsCompletionItem>("c");
        const resolving = has(provider, "resolveCompletionItem");
        const convert = (item: VsCompletionItem): Lang.CompletionItem => {
          const out = fromCompletionItem(item, (c) => commands.ref(c));
          return resolving ? { ...out, resolveId: kept.keep(item) } : out;
        };
        return disposable(
          L.registerCompletionProvider(
            languagesOf(selector),
            async (ctx, token?: CallToken) => {
              const a = await at(selector, ctx);
              if (!a) return [];
              const c = ctx as Lang.ProviderContext & Lang.CompletionContext;
              const trigger =
                c.triggerCharacter ??
                (c.triggerKind === undefined
                  ? triggerCharacters.find((ch) => ctx.linePrefix.endsWith(ch))
                  : undefined);
              const result = await call<unknown>(
                provider,
                "provideCompletionItems",
                a.doc,
                a.pos,
                cancellationOf(token),
                {
                  triggerKind:
                    c.triggerKind === "incomplete"
                      ? CompletionTriggerKind.TriggerForIncompleteCompletions
                      : trigger
                        ? CompletionTriggerKind.TriggerCharacter
                        : CompletionTriggerKind.Invoke,
                  triggerCharacter: trigger,
                },
              );
              if (Array.isArray(result)) return (result as VsCompletionItem[]).map(convert);
              if (!result || typeof result !== "object") return [];
              // A CompletionList: `isIncomplete` asks again as the user types.
              const list = result as CompletionList;
              return {
                items: (Array.isArray(list.items) ? list.items : []).map(convert),
                ...(list.isIncomplete && { isIncomplete: true }),
              };
            },
            {
              ...(triggerCharacters.length && { triggerCharacters }),
              ...(resolving && {
                resolve: async ({ resolveId }: { resolveId: string }, token?: CallToken) => {
                  const item = kept.get(resolveId);
                  if (!item) return null;
                  // VS Code's resolve fills in the item it's given (or returns another one).
                  const resolved =
                    (await call<VsCompletionItem>(
                      provider,
                      "resolveCompletionItem",
                      item,
                      cancellationOf(token),
                    )) ?? item;
                  const out = fromCompletionItem(resolved, (cmd) => commands.ref(cmd));
                  return {
                    ...(out.detail && { detail: out.detail }),
                    ...(out.documentation && { documentation: out.documentation }),
                    ...(out.additionalTextEdits && {
                      additionalTextEdits: out.additionalTextEdits,
                    }),
                    ...(out.command && { command: out.command, input: out.input }),
                  };
                },
              }),
            },
          ),
        );
      },

      registerDefinitionProvider: (selector: DocumentSelector, provider: Provider) =>
        disposable(
          L.registerDefinitionProvider(
            languagesOf(selector),
            locationsProvider(selector, provider, "provideDefinition"),
          ),
        ),
      registerTypeDefinitionProvider: (selector: DocumentSelector, provider: Provider) =>
        disposable(
          L.registerTypeDefinitionProvider(
            languagesOf(selector),
            locationsProvider(selector, provider, "provideTypeDefinition"),
          ),
        ),
      registerImplementationProvider: (selector: DocumentSelector, provider: Provider) =>
        disposable(
          L.registerImplementationProvider(
            languagesOf(selector),
            locationsProvider(selector, provider, "provideImplementation"),
          ),
        ),
      registerDeclarationProvider: (selector: DocumentSelector, provider: Provider) =>
        disposable(
          L.registerDeclarationProvider(
            languagesOf(selector),
            locationsProvider(selector, provider, "provideDeclaration"),
          ),
        ),

      registerReferenceProvider: (selector: DocumentSelector, provider: Provider) =>
        disposable(
          L.registerReferenceProvider(languagesOf(selector), async (ctx, token?: CallToken) => {
            const a = await at(selector, ctx);
            if (!a) return null;
            return fromLocations(
              await call(
                provider,
                "provideReferences",
                a.doc,
                a.pos,
                { includeDeclaration: ctx.includeDeclaration },
                cancellationOf(token),
              ),
            );
          }),
        ),

      registerDocumentFormattingEditProvider: (selector: DocumentSelector, provider: Provider) =>
        disposable(
          L.registerDocumentFormattingProvider(
            languagesOf(selector),
            async (ctx, token?: CallToken) => {
              const doc = await documentFor(selector, ctx);
              if (!doc) return null;
              const options = { tabSize: ctx.tabSize, insertSpaces: ctx.insertSpaces };
              return textEdits(
                await call(
                  provider,
                  "provideDocumentFormattingEdits",
                  doc,
                  options,
                  cancellationOf(token),
                ),
              );
            },
          ),
        ),
      registerDocumentRangeFormattingEditProvider: (
        selector: DocumentSelector,
        provider: Provider,
      ) =>
        disposable(
          L.registerRangeFormattingProvider(
            languagesOf(selector),
            async (ctx, token?: CallToken) => {
              const doc = await documentFor(selector, ctx);
              if (!doc) return null;
              const options = { tabSize: ctx.tabSize, insertSpaces: ctx.insertSpaces };
              return textEdits(
                await call(
                  provider,
                  "provideDocumentRangeFormattingEdits",
                  doc,
                  doc.validateRange(toRange(ctx.range)),
                  options,
                  cancellationOf(token),
                ),
              );
            },
          ),
        ),
      registerOnTypeFormattingEditProvider: (
        selector: DocumentSelector,
        provider: Provider,
        firstTriggerCharacter: string,
        ...more: string[]
      ) =>
        disposable(
          L.registerOnTypeFormattingProvider(
            languagesOf(selector),
            async (ctx, token?: CallToken) => {
              const a = await at(selector, ctx);
              if (!a) return null;
              const options = { tabSize: ctx.tabSize, insertSpaces: ctx.insertSpaces };
              return textEdits(
                await call(
                  provider,
                  "provideOnTypeFormattingEdits",
                  a.doc,
                  a.pos,
                  ctx.ch,
                  options,
                  cancellationOf(token),
                ),
              );
            },
            [firstTriggerCharacter, ...more],
          ),
        ),

      registerCodeActionsProvider: (selector: DocumentSelector, provider: Provider) => {
        const original = new WeakMap<Lang.CodeAction, unknown>();
        const convert = (a: unknown): Lang.CodeAction | null => {
          const x = a as {
            title: string;
            command?: Command | string;
            kind?: CodeActionKind;
            isPreferred?: boolean;
            edit?: WorkspaceEdit;
            disabled?: unknown;
            arguments?: unknown[];
          };
          if (!x?.title || x.disabled) return null;
          // A Command instead of a CodeAction.
          if (typeof x.command === "string")
            return {
              title: x.title,
              ...ref({ title: x.title, command: x.command, arguments: x.arguments ?? [] }),
            };
          const out: Lang.CodeAction = {
            title: x.title,
            ...(x.kind?.value && { kind: x.kind.value }),
            ...(x.isPreferred && { isPreferred: true }),
            ...(x.edit && { edits: fromWorkspaceEditText(x.edit) }),
            ...ref(x.command as Command | undefined),
          };
          original.set(out, a);
          return out;
        };
        const resolve = has(provider, "resolveCodeAction")
          ? async (action: Lang.CodeAction, token?: CallToken) => {
              const vs = original.get(action);
              if (!vs) return action;
              const resolved = ((await call(
                provider,
                "resolveCodeAction",
                vs,
                cancellationOf(token),
              )) ?? vs) as { edit?: WorkspaceEdit };
              return resolved.edit
                ? { ...action, edits: fromWorkspaceEditText(resolved.edit) }
                : action;
            }
          : undefined;
        return disposable(
          L.registerCodeActionProvider(
            languagesOf(selector),
            async (ctx, token?: CallToken) => {
              const doc = await documentFor(selector, ctx);
              if (!doc) return null;
              const result = await call<unknown[]>(
                provider,
                "provideCodeActions",
                doc,
                doc.validateRange(toRange(ctx.range)),
                {
                  // Its own Diagnostic objects where they're the same problem, as VS Code gives
                  // them (D261: quick fixes matching `data`, `source` or the object found none).
                  diagnostics: ctx.diagnostics.map((d) => {
                    const own = hub.diagnosticsOf(doc.uri).find((o) => {
                      const p = fromDiagnostic(o);
                      return (
                        p.line === d.startLine &&
                        p.column === d.startColumn &&
                        p.endLine === d.endLine &&
                        p.endColumn === d.endColumn &&
                        p.message === d.message
                      );
                    });
                    return own ?? toDiagnostic(d);
                  }),
                  only: ctx.only ? new CodeActionKind(ctx.only) : undefined,
                  triggerKind: CodeActionTriggerKind.Invoke,
                },
                cancellationOf(token),
              );
              return (result ?? []).map(convert).filter((x): x is Lang.CodeAction => !!x);
            },
            resolve ? { resolve } : undefined,
          ),
        );
      },

      registerRenameProvider: (selector: DocumentSelector, provider: Provider) =>
        disposable(
          L.registerRenameProvider(
            languagesOf(selector),
            async (ctx, token?: CallToken) => {
              const a = await at(selector, ctx);
              if (!a) return null;
              const edit = await call<WorkspaceEdit>(
                provider,
                "provideRenameEdits",
                a.doc,
                a.pos,
                ctx.newName,
                cancellationOf(token),
              );
              return edit ? fromWorkspaceEditText(edit) : null;
            },
            has(provider, "prepareRename")
              ? {
                  prepare: async (ctx, token?: CallToken) => {
                    const a = await at(selector, ctx);
                    if (!a) return null;
                    const r = await call<Range | { range: Range; placeholder: string }>(
                      provider,
                      "prepareRename",
                      a.doc,
                      a.pos,
                      cancellationOf(token),
                    );
                    if (!r) return null;
                    if (r instanceof Range || Range.isRange(r)) return fromRange(r);
                    return { range: fromRange(r.range), placeholder: r.placeholder };
                  },
                }
              : undefined,
          ),
        ),

      registerSignatureHelpProvider: (
        selector: DocumentSelector,
        provider: Provider,
        first?: string | { triggerCharacters?: string[]; retriggerCharacters?: string[] },
        ...more: string[]
      ) => {
        const triggerCharacters =
          typeof first === "object"
            ? (first.triggerCharacters ?? [])
            : first
              ? [first, ...more]
              : more;
        const retriggerCharacters =
          typeof first === "object" ? (first.retriggerCharacters ?? []) : [];
        return disposable(
          L.registerSignatureHelpProvider(
            languagesOf(selector),
            async (ctx, token?: CallToken) => {
              const a = await at(selector, ctx);
              if (!a) return null;
              const help = await call<{
                signatures: {
                  label: string;
                  documentation?: unknown;
                  parameters?: { label: string | [number, number]; documentation?: unknown }[];
                }[];
                activeSignature?: number;
                activeParameter?: number;
              }>(provider, "provideSignatureHelp", a.doc, a.pos, cancellationOf(token), {
                triggerKind: ctx.triggerCharacter
                  ? SignatureHelpTriggerKind.TriggerCharacter
                  : SignatureHelpTriggerKind.Invoke,
                triggerCharacter: ctx.triggerCharacter,
                isRetrigger: false,
                activeSignatureHelp: undefined,
              });
              if (!help?.signatures?.length) return null;
              return {
                signatures: help.signatures.map((s) => ({
                  label: s.label,
                  ...(s.documentation !== undefined && {
                    documentation: markdownOf(s.documentation),
                  }),
                  parameters: (s.parameters ?? []).map((p) => ({
                    label: p.label,
                    ...(p.documentation !== undefined && {
                      documentation: markdownOf(p.documentation),
                    }),
                  })),
                })),
                activeSignature: help.activeSignature ?? 0,
                activeParameter: help.activeParameter ?? 0,
              };
            },
            { triggerCharacters, retriggerCharacters },
          ),
        );
      },

      registerDocumentSymbolProvider: (selector: DocumentSelector, provider: Provider) =>
        disposable(
          L.registerDocumentSymbolProvider(
            languagesOf(selector),
            async (ctx, token?: CallToken) => {
              const doc = await documentFor(selector, ctx);
              if (!doc) return null;
              const result = await call<unknown[]>(
                provider,
                "provideDocumentSymbols",
                doc,
                cancellationOf(token),
              );
              const symbol = (s: unknown): Lang.DocumentSymbol => {
                const x = s as {
                  name: string;
                  detail?: string;
                  kind: SymbolKind;
                  range?: Range;
                  selectionRange?: Range;
                  location?: { range: Range };
                  children?: unknown[];
                };
                const range = x.range ?? x.location?.range ?? new Range(0, 0, 0, 0);
                return {
                  name: x.name,
                  ...(x.detail && { detail: x.detail }),
                  kind: symbolKindName(x.kind),
                  ...fromRange(range),
                  selectionRange: fromRange(x.selectionRange ?? range),
                  ...(x.children?.length && { children: x.children.map(symbol) }),
                };
              };
              return (result ?? []).map(symbol);
            },
          ),
        ),

      registerWorkspaceSymbolProvider: (provider: Provider) =>
        disposable(
          L.registerWorkspaceSymbolProvider(async ({ query }, token?: CallToken) => {
            const result = await call<
              {
                name: string;
                kind: SymbolKind;
                containerName?: string;
                location: { uri: Uri; range?: Range };
              }[]
            >(provider, "provideWorkspaceSymbols", query, cancellationOf(token));
            return (result ?? []).map((s) => ({
              name: s.name,
              kind: symbolKindName(s.kind),
              path: pathOf(s.location.uri),
              ...(s.containerName && { container: s.containerName }),
              ...fromRange(s.location.range ?? new Range(0, 0, 0, 0)),
            }));
          }),
        ),

      registerCodeLensProvider: (selector: DocumentSelector, provider: Provider) =>
        disposable(
          L.registerCodeLensProvider(languagesOf(selector), async (ctx, token?: CallToken) => {
            const doc = await documentFor(selector, ctx);
            if (!doc) return null;
            const lenses =
              (await call<{ range: Range; command?: Command }[]>(
                provider,
                "provideCodeLenses",
                doc,
                cancellationOf(token),
              )) ?? [];
            const out: Lang.CodeLens[] = [];
            for (const [i, lens] of lenses.entries()) {
              let resolved = lens;
              if (!resolved.command && i < MAX_RESOLVED && has(provider, "resolveCodeLens"))
                resolved =
                  (await call<typeof lens>(
                    provider,
                    "resolveCodeLens",
                    lens,
                    cancellationOf(token),
                  )) ?? lens;
              if (!resolved.command?.title) continue;
              out.push({
                ...fromRange(resolved.range),
                title: resolved.command.title,
                ...ref(resolved.command),
              });
            }
            return out;
          }),
        ),

      registerInlayHintsProvider: (selector: DocumentSelector, provider: Provider) => {
        // VS Code's resolveInlayHint: hints kept by id until the editor hovers one.
        const kept = new KeptForResolve<VsInlayHint>("h");
        const resolving = has(provider, "resolveInlayHint");
        const convert = (h: VsInlayHint, resolveId?: string): Lang.InlayHint =>
          fromInlayHint(h, (c) => commands.ref(c), resolveId);
        return disposable(
          L.registerInlayHintsProvider(
            languagesOf(selector),
            async (ctx, token?: CallToken) => {
              const doc = await documentFor(selector, ctx);
              if (!doc) return null;
              const hints = await call<VsInlayHint[]>(
                provider,
                "provideInlayHints",
                doc,
                // Within the text the shim has, as VS Code gives it (the editor's may be newer).
                doc.validateRange(toRange(ctx.range)),
                cancellationOf(token),
              );
              return (hints ?? []).map((h) => convert(h, resolving ? kept.keep(h) : undefined));
            },
            resolving
              ? {
                  resolve: async ({ resolveId }: { resolveId: string }, token?: CallToken) => {
                    const hint = kept.get(resolveId);
                    if (!hint) return null;
                    const resolved =
                      (await call<VsInlayHint>(
                        provider,
                        "resolveInlayHint",
                        hint,
                        cancellationOf(token),
                      )) ?? hint;
                    return convert(resolved);
                  },
                }
              : undefined,
          ),
        );
      },

      registerDocumentSemanticTokensProvider: (
        selector: DocumentSelector,
        provider: Provider & { onDidChangeSemanticTokens?: (l: () => void) => Disposable },
        legend: { tokenTypes: string[]; tokenModifiers: string[] },
      ) =>
        disposable(
          L.registerSemanticTokensProvider(
            languagesOf(selector),
            async (ctx, token?: CallToken) => {
              const doc = await documentFor(selector, ctx);
              if (!doc) return null;
              const tokens = await call<{ data: ArrayLike<number> }>(
                provider,
                "provideDocumentSemanticTokens",
                doc,
                cancellationOf(token),
              );
              return tokens ? decodeSemanticTokens(tokens.data, legend) : null;
            },
            legend,
            provider.onDidChangeSemanticTokens
              ? {
                  onDidChange: (l) =>
                    provider.onDidChangeSemanticTokens?.(l) ?? new Disposable(() => {}),
                }
              : undefined,
          ),
        ),
      // A real range provider (VS Code asks it about the visible range, while the full tokens
      // of a document provider come), not a second whole-document one.
      registerDocumentRangeSemanticTokensProvider: (
        selector: DocumentSelector,
        provider: Provider,
        legend: { tokenTypes: string[]; tokenModifiers: string[] },
      ) =>
        disposable(
          L.registerSemanticTokensProvider(
            languagesOf(selector),
            async (ctx: Lang.DocumentContext & { range?: Lang.FullRange }, token?: CallToken) => {
              const doc = await documentFor(selector, ctx);
              if (!doc) return null;
              const range = ctx.range ? toRange(ctx.range) : new Range(0, 0, doc.lineCount, 0);
              const tokens = await call<{ data: ArrayLike<number> }>(
                provider,
                "provideDocumentRangeSemanticTokens",
                doc,
                doc.validateRange(range),
                cancellationOf(token),
              );
              return tokens ? decodeSemanticTokens(tokens.data, legend) : null;
            },
            legend,
            { range: true },
          ),
        ),

      registerDocumentHighlightProvider: (selector: DocumentSelector, provider: Provider) =>
        disposable(
          L.registerDocumentHighlightProvider(
            languagesOf(selector),
            async (ctx, token?: CallToken) => {
              const a = await at(selector, ctx);
              if (!a) return null;
              const result = await call<{ range: Range; kind?: number }[]>(
                provider,
                "provideDocumentHighlights",
                a.doc,
                a.pos,
                cancellationOf(token),
              );
              return (result ?? []).map((h) => ({
                ...fromRange(h.range),
                kind:
                  h.kind === 1
                    ? ("read" as const)
                    : h.kind === 2
                      ? ("write" as const)
                      : ("text" as const),
              }));
            },
          ),
        ),

      registerFoldingRangeProvider: (selector: DocumentSelector, provider: Provider) =>
        disposable(
          L.registerFoldingRangeProvider(languagesOf(selector), async (ctx, token?: CallToken) => {
            const doc = await documentFor(selector, ctx);
            if (!doc) return null;
            const result = await call<{ start: number; end: number; kind?: number }[]>(
              provider,
              "provideFoldingRanges",
              doc,
              {},
              cancellationOf(token),
            );
            const kinds = [undefined, "comment", "imports", "region"] as const;
            return (result ?? []).map((f) => {
              const kind = kinds[f.kind ?? 0];
              return { startLine: f.start + 1, endLine: f.end + 1, ...(kind && { kind }) };
            });
          }),
        ),

      registerDocumentLinkProvider: (selector: DocumentSelector, provider: Provider) =>
        disposable(
          L.registerDocumentLinkProvider(languagesOf(selector), async (ctx, token?: CallToken) => {
            const doc = await documentFor(selector, ctx);
            if (!doc) return null;
            const links =
              (await call<{ range: Range; target?: Uri; tooltip?: string }[]>(
                provider,
                "provideDocumentLinks",
                doc,
                cancellationOf(token),
              )) ?? [];
            const out: Lang.DocumentLink[] = [];
            for (const [i, link] of links.entries()) {
              let resolved = link;
              if (!resolved.target && i < MAX_RESOLVED && has(provider, "resolveDocumentLink"))
                resolved =
                  (await call<typeof link>(
                    provider,
                    "resolveDocumentLink",
                    link,
                    cancellationOf(token),
                  )) ?? link;
              const target = resolved.target;
              if (!target) continue;
              const web = ["http", "https", "mailto"].includes(target.scheme);
              // "#L12,3": a line (and column) of the file.
              const at = /^L?(\d+)(?:,(\d+))?$/.exec(target.fragment);
              out.push({
                ...fromRange(resolved.range),
                target: web ? target.toString(true) : pathOf(target.with({ fragment: "" })),
                ...(!web && at?.[1] && { line: Number(at[1]) }),
                ...(!web && at?.[2] && { column: Number(at[2]) }),
                ...(resolved.tooltip && { tooltip: resolved.tooltip }),
              });
            }
            return out;
          }),
        ),

      registerColorProvider: (selector: DocumentSelector, provider: Provider) =>
        disposable(
          L.registerColorProvider(
            languagesOf(selector),
            async (ctx, token?: CallToken) => {
              const doc = await documentFor(selector, ctx);
              if (!doc) return null;
              const result = await call<{ range: Range; color: VsColor }[]>(
                provider,
                "provideDocumentColors",
                doc,
                cancellationOf(token),
              );
              return (result ?? []).map((c) => ({
                ...fromRange(c.range),
                color: {
                  red: c.color.red,
                  green: c.color.green,
                  blue: c.color.blue,
                  alpha: c.color.alpha,
                },
              }));
            },
            {
              presentations: async (ctx, token?: CallToken) => {
                const doc = await documentFor(selector, ctx);
                if (!doc) return null;
                const result = await call<{ label: string; textEdit?: TextEdit }[]>(
                  provider,
                  "provideColorPresentations",
                  ctx.color,
                  { document: doc, range: doc.validateRange(toRange(ctx.range)) },
                  cancellationOf(token),
                );
                return (result ?? []).map((p) => ({
                  label: p.label,
                  ...(p.textEdit && { edit: fromTextEdit(p.textEdit) }),
                }));
              },
            },
          ),
        ),

      registerInlineCompletionItemProvider: (selector: DocumentSelector, provider: Provider) =>
        disposable(
          L.registerInlineCompletionProvider(
            languagesOf(selector),
            async (ctx, token?: CallToken) => {
              const a = await at(selector, ctx);
              if (!a) return null;
              const result = await call<unknown>(
                provider,
                "provideInlineCompletionItems",
                a.doc,
                a.pos,
                {
                  triggerKind: ctx.explicit ? 0 : 1,
                  selectedCompletionInfo: undefined,
                },
                cancellationOf(token),
              );
              const list = (
                Array.isArray(result)
                  ? result
                  : ((result as { items?: unknown[] } | undefined)?.items ?? [])
              ) as {
                insertText: string | SnippetString;
                range?: Range;
                command?: Command;
              }[];
              return list.map((item) => ({
                insertText:
                  item.insertText instanceof SnippetString
                    ? item.insertText.value
                    : String(item.insertText),
                ...(item.range && { range: fromRange(item.range) }),
                ...ref(item.command),
              }));
            },
          ),
        ),

      registerLinkedEditingRangeProvider: (selector: DocumentSelector, provider: Provider) =>
        disposable(
          L.registerLinkedEditingRangeProvider(
            languagesOf(selector),
            async (ctx, token?: CallToken) => {
              const a = await at(selector, ctx);
              if (!a) return null;
              const result = await call<{ ranges: Range[]; wordPattern?: RegExp }>(
                provider,
                "provideLinkedEditingRanges",
                a.doc,
                a.pos,
                cancellationOf(token),
              );
              if (!result) return null;
              return {
                ranges: result.ranges.map(fromRange),
                ...(result.wordPattern && { wordPattern: result.wordPattern.source }),
              };
            },
          ),
        ),

      registerSelectionRangeProvider: (selector: DocumentSelector, provider: Provider) =>
        disposable(
          L.registerSelectionRangeProvider(
            languagesOf(selector),
            async (ctx, token?: CallToken) => {
              const doc = await documentFor(selector, ctx);
              if (!doc) return null;
              const positions = ctx.positions.map((p) => toPosition(p.line, p.column));
              type Sel = { range: Range; parent?: Sel };
              const result = await call<Sel[]>(
                provider,
                "provideSelectionRanges",
                doc,
                positions,
                cancellationOf(token),
              );
              const convert = (s: Sel, depth = 0): Lang.SelectionRange => ({
                range: fromRange(s.range),
                ...(s.parent && depth < 50 && { parent: convert(s.parent, depth + 1) }),
              });
              return (result ?? []).map((s) => convert(s));
            },
          ),
        ),

      registerCallHierarchyProvider: (selector: DocumentSelector, provider: Provider) =>
        disposable(
          L.registerCallHierarchyProvider(languagesOf(selector), {
            prepareCallHierarchy: async (ctx, token?: CallToken) => {
              const a = await at(selector, ctx);
              if (!a) return null;
              return items(
                await call(provider, "prepareCallHierarchy", a.doc, a.pos, cancellationOf(token)),
              ).map(fromItem);
            },
            provideCallHierarchyIncomingCalls: async (ctx, token?: CallToken) => {
              const calls = await call<{ from: CallHierarchyItem; fromRanges: Range[] }[]>(
                provider,
                "provideCallHierarchyIncomingCalls",
                toItem(ctx.item, CallHierarchyItem),
                cancellationOf(token),
              );
              return (calls ?? []).map((c) => ({
                from: fromItem(c.from),
                fromRanges: c.fromRanges.map(fromRange),
              }));
            },
            provideCallHierarchyOutgoingCalls: async (ctx, token?: CallToken) => {
              const calls = await call<{ to: CallHierarchyItem; fromRanges: Range[] }[]>(
                provider,
                "provideCallHierarchyOutgoingCalls",
                toItem(ctx.item, CallHierarchyItem),
                cancellationOf(token),
              );
              return (calls ?? []).map((c) => ({
                to: fromItem(c.to),
                fromRanges: c.fromRanges.map(fromRange),
              }));
            },
          }),
        ),

      registerTypeHierarchyProvider: (selector: DocumentSelector, provider: Provider) =>
        disposable(
          L.registerTypeHierarchyProvider(languagesOf(selector), {
            prepareTypeHierarchy: async (ctx, token?: CallToken) => {
              const a = await at(selector, ctx);
              if (!a) return null;
              return items(
                await call(provider, "prepareTypeHierarchy", a.doc, a.pos, cancellationOf(token)),
              ).map(fromItem);
            },
            provideTypeHierarchySupertypes: async (ctx, token?: CallToken) =>
              items(
                await call(
                  provider,
                  "provideTypeHierarchySupertypes",
                  toItem(ctx.item, TypeHierarchyItem),
                  cancellationOf(token),
                ),
              ).map(fromItem),
            provideTypeHierarchySubtypes: async (ctx, token?: CallToken) =>
              items(
                await call(
                  provider,
                  "provideTypeHierarchySubtypes",
                  toItem(ctx.item, TypeHierarchyItem),
                  cancellationOf(token),
                ),
              ).map(fromItem),
          }),
        ),

      registerEvaluatableExpressionProvider: (selector: DocumentSelector, provider: Provider) =>
        disposable(
          L.registerEvaluatableExpressionProvider(
            languagesOf(selector),
            async (ctx, token?: CallToken) => {
              const a = await at(selector, ctx);
              if (!a) return null;
              const e = await call<{ range: Range; expression?: string }>(
                provider,
                "provideEvaluatableExpression",
                a.doc,
                a.pos,
                cancellationOf(token),
              );
              return e
                ? { range: fromRange(e.range), ...(e.expression && { expression: e.expression }) }
                : null;
            },
          ),
        ),

      // The debugger's inline values while paused (VS Code's InlineValuesProvider).
      registerInlineValuesProvider: (selector: DocumentSelector, provider: Provider) =>
        disposable(
          L.registerInlineValuesProvider(languagesOf(selector), async (ctx, token?: CallToken) => {
            const doc = await documentFor(selector, ctx);
            if (!doc) return null;
            const stopped = Math.max(0, ctx.stoppedLine - 1);
            const values = await call<unknown[]>(
              provider,
              "provideInlineValues",
              doc,
              doc.validateRange(toRange(ctx.range)),
              { frameId: ctx.frameId, stoppedLocation: new Range(stopped, 0, stopped, 0) },
              cancellationOf(token),
            );
            return (Array.isArray(values) ? values : []).flatMap((v) => {
              const value = fromInlineValue(v);
              return value ? [value] : [];
            });
          }),
        ),
    },
  };
}

/** A language configuration with its RegExps as `{ pattern, flags }` (JSON can carry them). */
export function plainConfiguration(v: unknown, depth = 0): unknown {
  if (v instanceof RegExp) return { pattern: v.source, flags: v.flags.replace("g", "") };
  if (depth > 6 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => plainConfiguration(x, depth + 1));
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).map(([k, x]) => [
      k,
      plainConfiguration(x, depth + 1),
    ]),
  );
}

/** VS Code's relative semantic token encoding (5 numbers a token) as the IDE's tokens (1-based). */
export function decodeSemanticTokens(
  data: ArrayLike<number>,
  legend: { tokenTypes: readonly string[]; tokenModifiers?: readonly string[] },
): Lang.SemanticToken[] {
  const out: Lang.SemanticToken[] = [];
  let line = 0;
  let char = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i] ?? 0;
    const deltaChar = data[i + 1] ?? 0;
    line += deltaLine;
    char = deltaLine ? deltaChar : char + deltaChar;
    const type = legend.tokenTypes[data[i + 3] ?? -1];
    if (!type) continue;
    const bits = data[i + 4] ?? 0;
    const modifiers = (legend.tokenModifiers ?? []).filter((_, b) => bits & (1 << b));
    out.push({
      line: line + 1,
      column: char + 1,
      length: data[i + 2] ?? 0,
      type,
      ...(modifiers.length && { modifiers }),
    });
  }
  return out;
}
