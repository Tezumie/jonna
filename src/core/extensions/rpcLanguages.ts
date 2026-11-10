// The worker side of `ide.languages` (D176, D229, D234): problems, and language providers in
// VS Code's shapes with 1-based ranges. Hovers and completions are their own call kinds; every
// other provider is a "provider" call to its id (its second calls, rename's prepare, a code
// action's resolve, a color's presentations, to `<id>.<part>`). The host checks every answer
// (workbench/extensionProviders.ts). DOM-free, unit-tested through createWorkerApi.
import type { ProviderQuery, ProviderQueryAnswers, ProviderQueryKind } from "./providerQuery";
import type { Disposable, TextRange } from "./rpc";
import type { OnCall, Request } from "./rpcTerminals";

export interface Diagnostic {
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  /** "hint": shown faintly in the editor (three dots), not in Problems (VS Code's Hint). */
  severity?: "error" | "warning" | "info" | "hint";
  code?: string;
  /** A web page about the code (VS Code's `code.target`): the code shows as its link. */
  codeTarget?: string;
  /** Who reports it ("pyright", "eslint"; default: the extension's name). */
  source?: string;
  /** "unnecessary": drawn faded (unused code); "deprecated": struck through. */
  tags?: ("unnecessary" | "deprecated")[];
  /** Other places that explain it (VS Code's relatedInformation). */
  relatedInformation?: (TextRange & { path: string; message: string })[];
}

/**
 * Whether the editor still wants a provider's answer (VS Code's CancellationToken): the user
 * typed on, moved away or the request was replaced. A provider may stop its work when it fires.
 */
export interface CallToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): Disposable;
}

/** The worker's side of a call the host can cancel (a "cancel" message). */
export class CallTokenSource {
  private cancelled = false;
  private listeners: (() => void)[] = [];
  readonly token: CallToken;

  constructor() {
    const self = this;
    this.token = {
      get isCancellationRequested() {
        return self.cancelled;
      },
      onCancellationRequested(listener: () => void): Disposable {
        if (self.cancelled) {
          listener();
          return { dispose() {} };
        }
        self.listeners.push(listener);
        return {
          dispose() {
            self.listeners = self.listeners.filter((l) => l !== listener);
          },
        };
      },
    };
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    const listeners = this.listeners;
    this.listeners = [];
    for (const l of listeners) {
      try {
        l();
      } catch {
        // A listener's failure doesn't keep the others from hearing it.
      }
    }
  }
}

/** What a hover or completion provider is asked about. */
export interface ProviderContext {
  path: string;
  languageId: string;
  line: number;
  column: number;
  word: string;
  linePrefix: string;
  /**
   * A notebook cell's document (VS Code's `vscode-notebook-cell:` documents): the notebook, the
   * cell's id and its text now (`path` is then the cell's own name in the editor).
   */
  cell?: CellOfNotebook;
}

/** How a completion provider was asked (VS Code's CompletionContext). */
export interface CompletionContext {
  /** "incomplete": typing on after an incomplete list (TriggerForIncompleteCompletions). */
  triggerKind?: "invoke" | "triggerCharacter" | "incomplete";
  triggerCharacter?: string;
}

/** The notebook cell a provider is asked about. */
export interface CellOfNotebook {
  notebook: string;
  id: string;
  text: string;
}

/** What a whole-document provider is asked about (symbols, code lens, semantic tokens). */
export interface DocumentContext {
  path: string;
  languageId: string;
  cell?: CellOfNotebook;
}

/** A range with every field set (1-based; end column exclusive). */
export interface FullRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** An item of a call or type hierarchy (VS Code's CallHierarchyItem / TypeHierarchyItem, 1-based). */
export interface HierarchyItem {
  name: string;
  /** A symbol kind ("function", "method", "class"…). */
  kind?: string;
  detail?: string;
  path: string;
  range: TextRange;
  /** Where its name is (default: the range). */
  selectionRange?: TextRange;
  /** Yours: given back when you're asked about the item. */
  data?: unknown;
}

/** A call into (`from`) or out of (`to`) an item, and the call sites in the caller. */
export interface HierarchyCall {
  from?: HierarchyItem;
  to?: HierarchyItem;
  fromRanges: TextRange[];
}

/** VS Code's SelectionRange: a range and the one around it. */
export interface SelectionRange {
  range: TextRange;
  parent?: SelectionRange;
}

export interface FormattingContext extends DocumentContext {
  tabSize: number;
  insertSpaces: boolean;
}

export interface CodeActionContext extends DocumentContext {
  range: FullRange;
  /** The problems (any source's) in the range. */
  diagnostics: (FullRange & {
    message: string;
    severity: "error" | "warning" | "info" | "hint";
    source?: string;
    code?: string;
  })[];
  /** The kind asked for ("quickfix", "source.organizeImports"…), if any. */
  only?: string;
}

/** A place in a file (in the open folder; relative or absolute). */
export type Location = TextRange & { path: string };

export type TextEdit = TextRange & { text: string };

/** An edit in any file of the folder (default: the one asked about). */
export type FileEdit = TextEdit & { path?: string };

export interface CodeAction {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  edits?: FileEdit[];
  /** One of the extension's own commands, run when chosen (after the edits). */
  command?: string;
  input?: unknown;
}

export interface SignatureHelp {
  signatures: {
    label: string;
    documentation?: string;
    parameters?: (string | { label: string | [number, number]; documentation?: string })[];
  }[];
  activeSignature?: number;
  activeParameter?: number;
}

export interface DocumentSymbol extends TextRange {
  name: string;
  detail?: string;
  /** LSP's names: "class", "function", "method", "variable", "constant", "enumMember"… */
  kind: string;
  selectionRange?: TextRange;
  children?: DocumentSymbol[];
}

/** Where a rename applies: a range (its own fields, or `range`) and the box's starting text. */
export type RenameLocation = (TextRange | { range: TextRange }) & { placeholder?: string };

export interface CodeLens extends TextRange {
  title: string;
  /** One of the extension's own commands, run on click. */
  command?: string;
  input?: unknown;
}

export interface InlayHint {
  line: number;
  column: number;
  /** Its text, or parts that each may go somewhere (Ctrl+click), run a command or explain. */
  label: string | InlayHintLabelPart[];
  kind?: "type" | "parameter";
  tooltip?: string;
  paddingLeft?: boolean;
  paddingRight?: boolean;
  /** Edits made when the hint is double-clicked (VS Code's textEdits: "insert this type"). */
  textEdits?: TextEdit[];
  /** Yours: with `resolve` registered, the hint is completed (tooltip…) when hovered. */
  resolveId?: string;
}

export interface InlayHintLabelPart {
  value: string;
  tooltip?: string;
  /** Where Ctrl+click on the part goes (a type's definition). */
  location?: Location;
  /** One of the extension's own commands, run on click. */
  command?: string;
  input?: unknown;
}

/**
 * What the debugger shows after a line while paused (VS Code's InlineValue): text as it is, a
 * variable looked up in the stopped frame's scopes (default name: the range's text), or an
 * expression evaluated there (default: the range's text).
 */
export type InlineValue =
  | { kind: "text"; range: TextRange; text: string }
  | { kind: "variable"; range: TextRange; name?: string; caseSensitive?: boolean }
  | { kind: "expression"; range: TextRange; expression?: string };

export interface SemanticToken {
  line: number;
  column: number;
  length: number;
  /** One of the legend's tokenTypes. */
  type: string;
  modifiers?: string[];
}

export type Answer<T> = T | null | undefined | Promise<T | null | undefined>;

/** A hover's Markdown and the range it's about (1-based, end column exclusive). */
export interface HoverWithRange {
  contents: string;
  range?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
}

/**
 * Offered code actions a resolving provider keeps for the editor (it releases each list when done;
 * this bounds what a list the editor never saw, an answer after its time limit, leaves behind).
 */
const MAX_KEPT_ACTIONS = 500;

/** VS Code's CompletionItemKind names (its icon in the list). */
export type CompletionKind =
  | "text"
  | "method"
  | "function"
  | "constructor"
  | "field"
  | "variable"
  | "class"
  | "interface"
  | "module"
  | "property"
  | "unit"
  | "value"
  | "enum"
  | "keyword"
  | "snippet"
  | "color"
  | "file"
  | "reference"
  | "folder"
  | "enumMember"
  | "constant"
  | "struct"
  | "event"
  | "operator"
  | "typeParameter"
  | "user"
  | "issue";

export interface CompletionItem {
  label: string;
  /** Faint text right after the label (a signature) and at the row's end (a module): VS Code's CompletionItemLabel. */
  labelDetail?: string;
  labelDescription?: string;
  insertText?: string;
  /** `insertText` is a snippet (`${1:name}`; also implied by kind "snippet"). */
  snippet?: boolean;
  detail?: string;
  documentation?: string;
  kind?: CompletionKind;
  /** Drawn struck through (VS Code's CompletionItemTag.Deprecated). */
  deprecated?: boolean;
  /**
   * D261: what it replaces (default: the word at the cursor), 1-based, on the cursor's line. With
   * `replaceRange` it's what's replaced on insert, `replaceRange` what's replaced on replace
   * (VS Code's { inserting, replacing }; editor.suggest.insertMode picks).
   */
  range?: TextRange;
  replaceRange?: TextRange;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  /** Typing one of these accepts the item first (VS Code's commitCharacters). */
  commitCharacters?: string[];
  /** Edits elsewhere made with it (an auto-import), 1-based. */
  additionalTextEdits?: (TextRange & { text: string })[];
  /**
   * Run after it's inserted: one of the extension's own commands, or the editor's
   * "editor.action.triggerSuggest" / "editor.action.triggerParameterHints".
   */
  command?: string;
  input?: unknown;
  /** Yours: with `resolve` registered, the item is completed (documentation…) when selected. */
  resolveId?: string;
}

/**
 * Completions with `isIncomplete`: typing on asks the provider again instead of filtering this
 * list (VS Code's CompletionList).
 */
export interface CompletionList {
  items: CompletionItem[];
  isIncomplete?: boolean;
}

// ---- D234 ----

/** VS Code's DocumentHighlight: other uses of the symbol at the cursor. */
export interface DocumentHighlight extends TextRange {
  kind?: "text" | "read" | "write";
}

/** VS Code's FoldingRange (1-based lines). */
export interface FoldingRange {
  startLine: number;
  endLine: number;
  kind?: "comment" | "imports" | "region";
}

/**
 * VS Code's DocumentLink: `target` is a web address (https, http, mailto) or a file of the
 * folder (relative or absolute; `line` / `column` to go to).
 */
export interface DocumentLink extends TextRange {
  target: string;
  line?: number;
  column?: number;
  tooltip?: string;
}

/** Each part 0..1. */
export interface Color {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

export interface ColorInformation extends TextRange {
  color: Color;
}

/** How a picked color is written: `label` replaces the range, or `edit` says what changes. */
export interface ColorPresentation {
  label: string;
  edit?: TextEdit;
}

/** Ghost text (VS Code's InlineCompletionItem); `range` default: the cursor. */
export interface InlineCompletionItem {
  insertText: string;
  range?: TextRange;
  /** One of the extension's own commands, run when it's accepted. */
  command?: string;
  input?: unknown;
}

/** A symbol anywhere in the folder (VS Code's SymbolInformation). */
export interface WorkspaceSymbol extends TextRange {
  name: string;
  kind?: string;
  path: string;
  container?: string;
}

/**
 * `ide.languages`: problems and language providers in files (D176, D229, D234). Every provider
 * gets a CallToken as its second argument: it fires when the editor no longer needs the answer.
 */
export interface LanguagesApi {
  /** Replaces the extension's problems for `path` (they show in Problems and as squiggles). */
  setDiagnostics(path: string, items: Diagnostic[]): Promise<void>;
  clearDiagnostics(path?: string): Promise<void>;
  /** Every language the editor knows (its own and extensions'), by id. */
  getLanguages(): Promise<string[]>;
  /**
   * Asks every provider the editor has for a document (its language servers, its own language
   * services, every extension's, this one's too) and merges their answers, as VS Code's
   * `vscode.execute…Provider` commands do ("fs.read"; providerQuery.ts has the shapes).
   */
  execute<K extends ProviderQueryKind>(
    query: ProviderQuery & { kind: K },
  ): Promise<ProviderQueryAnswers[K]>;
  /**
   * A language's comments, brackets, word pattern, indentation and Enter rules (D258, VS Code's
   * setLanguageConfiguration), in language-configuration.json's shape (patterns as strings or
   * `{ pattern, flags }`); merged over the language's own until disposed.
   */
  setLanguageConfiguration(languageId: string, configuration: Record<string, unknown>): Disposable;
  /**
   * Markdown, or `{ contents, range }`: the range (1-based, end column exclusive) is what the
   * editor highlights, instead of the word under the pointer (VS Code's Hover.range).
   */
  registerHoverProvider(
    languages: string | string[],
    provide: (context: ProviderContext) => Answer<string | HoverWithRange>,
  ): Disposable;
  /**
   * Suggestions; a CompletionList with `isIncomplete` is asked again as the user types. With
   * `resolve`, items carrying a `resolveId` are completed when selected (documentation, detail,
   * additionalTextEdits: VS Code's resolveCompletionItem).
   */
  registerCompletionProvider(
    languages: string | string[],
    provide: (
      context: ProviderContext,
    ) => CompletionItem[] | CompletionList | Promise<CompletionItem[] | CompletionList>,
    options?: {
      triggerCharacters?: string[];
      resolve?: (item: { resolveId: string }) => Answer<Partial<CompletionItem>>;
    },
  ): Disposable;
  /** Go to definition (F12, Ctrl+click, peek). */
  registerDefinitionProvider(
    languages: string | string[],
    provide: (context: ProviderContext) => Answer<Location | Location[]>,
  ): Disposable;
  /** Find all references (Shift+F12). */
  registerReferenceProvider(
    languages: string | string[],
    provide: (context: ProviderContext & { includeDeclaration: boolean }) => Answer<Location[]>,
  ): Disposable;
  /** Format document ("fs.write"). */
  registerDocumentFormattingProvider(
    languages: string | string[],
    provide: (context: FormattingContext) => Answer<TextEdit[]>,
  ): Disposable;
  /** Format selection ("fs.write"). */
  registerRangeFormattingProvider(
    languages: string | string[],
    provide: (context: FormattingContext & { range: FullRange }) => Answer<TextEdit[]>,
  ): Disposable;
  /**
   * Quick fixes and refactorings (the light bulb, Ctrl+.; "fs.write"). With `resolve` (VS Code's
   * resolveCodeAction), actions may come without `edits`: `resolve` gets the chosen one and
   * fills in its `edits` (or returns the action with them); nothing else of it changes.
   */
  registerCodeActionProvider(
    languages: string | string[],
    provide: (context: CodeActionContext) => Answer<CodeAction[]>,
    options?: { resolve?: (action: CodeAction) => Answer<CodeAction> },
  ): Disposable;
  /**
   * Rename symbol (F2; "fs.write"). Throw to refuse, with the reason as the message. `prepare`
   * (VS Code's prepareRename) runs before the rename box opens: the range renamed (it must
   * contain the position) and the text the box starts with, null for the word there, or throw
   * to refuse (the message shows at the symbol).
   */
  registerRenameProvider(
    languages: string | string[],
    provide: (context: ProviderContext & { newName: string }) => Answer<FileEdit[]>,
    options?: { prepare?: (context: ProviderContext) => Answer<RenameLocation> },
  ): Disposable;
  registerSignatureHelpProvider(
    languages: string | string[],
    provide: (context: ProviderContext & { triggerCharacter?: string }) => Answer<SignatureHelp>,
    options?: { triggerCharacters?: string[]; retriggerCharacters?: string[] },
  ): Disposable;
  /** The Outline, breadcrumbs and Go to symbol in editor. */
  registerDocumentSymbolProvider(
    languages: string | string[],
    provide: (context: DocumentContext) => Answer<DocumentSymbol[]>,
  ): Disposable;
  registerCodeLensProvider(
    languages: string | string[],
    provide: (context: DocumentContext) => Answer<CodeLens[]>,
  ): Disposable;
  /** With `resolve`, hints carrying a `resolveId` are completed when hovered (VS Code's). */
  registerInlayHintsProvider(
    languages: string | string[],
    provide: (context: DocumentContext & { range: FullRange }) => Answer<InlayHint[]>,
    options?: { resolve?: (hint: { resolveId: string }) => Answer<Partial<InlayHint>> },
  ): Disposable;
  /**
   * Colors by meaning; `legend.tokenTypes` are VS Code's standard names ("function"…). The
   * editor asks again after `refresh()` or when `options.onDidChange` fires (VS Code's
   * onDidChangeSemanticTokens). With `range: true` the provider is asked about the visible
   * range only (`context.range`; VS Code's DocumentRangeSemanticTokensProvider).
   */
  registerSemanticTokensProvider(
    languages: string | string[],
    provide: (context: DocumentContext & { range?: FullRange }) => Answer<SemanticToken[]>,
    legend: { tokenTypes: string[]; tokenModifiers?: string[] },
    options?: { onDidChange?: (listener: () => void) => Disposable; range?: boolean },
  ): Disposable & { refresh(): void };
  // D234: the rest of VS Code's common language providers.
  /** Go to type definition. */
  registerTypeDefinitionProvider(
    languages: string | string[],
    provide: (context: ProviderContext) => Answer<Location | Location[]>,
  ): Disposable;
  /** Go to implementations (Ctrl+F12). */
  registerImplementationProvider(
    languages: string | string[],
    provide: (context: ProviderContext) => Answer<Location | Location[]>,
  ): Disposable;
  /** Go to declaration. */
  registerDeclarationProvider(
    languages: string | string[],
    provide: (context: ProviderContext) => Answer<Location | Location[]>,
  ): Disposable;
  /** The symbol's other uses in the file, highlighted while the cursor is on it. */
  registerDocumentHighlightProvider(
    languages: string | string[],
    provide: (context: ProviderContext) => Answer<DocumentHighlight[]>,
  ): Disposable;
  registerFoldingRangeProvider(
    languages: string | string[],
    provide: (context: DocumentContext) => Answer<FoldingRange[]>,
  ): Disposable;
  /** Ctrl+click links: web addresses (opened by the system) or files of the folder. */
  registerDocumentLinkProvider(
    languages: string | string[],
    provide: (context: DocumentContext) => Answer<DocumentLink[]>,
  ): Disposable;
  /**
   * Color swatches and the color picker. Without `presentations` a picked color is written as
   * hex ("#rrggbb", "#rrggbbaa").
   */
  registerColorProvider(
    languages: string | string[],
    provide: (context: DocumentContext) => Answer<ColorInformation[]>,
    options?: {
      presentations?: (
        context: DocumentContext & { color: Color; range: FullRange },
      ) => Answer<(ColorPresentation | string)[]>;
    },
  ): Disposable;
  /** Edits as the user types one of `triggerCharacters` ("fs.write"; editor.formatOnType). */
  registerOnTypeFormattingProvider(
    languages: string | string[],
    provide: (
      context: ProviderContext & { ch: string; tabSize: number; insertSpaces: boolean },
    ) => Answer<TextEdit[]>,
    triggerCharacters: string[],
  ): Disposable;
  /**
   * Ghost text at the cursor (Tab accepts it), VS Code's InlineCompletionItemProvider. Asked as
   * the user types (`explicit` false) or when they ask for a suggestion; 5 s at most.
   */
  registerInlineCompletionProvider(
    languages: string | string[],
    provide: (
      context: ProviderContext & { explicit: boolean },
    ) => Answer<(InlineCompletionItem | string)[] | { items: (InlineCompletionItem | string)[] }>,
  ): Disposable;
  /** Go to symbol in workspace (Ctrl+T, "#" in quick open); files of the folder only. */
  registerWorkspaceSymbolProvider(
    provide: (context: { query: string }) => Answer<WorkspaceSymbol[]>,
  ): Disposable;
  /**
   * Ranges edited together as the user types in one (an HTML tag's name at both ends), VS Code's
   * LinkedEditingRangeProvider; `wordPattern` (a RegExp source) limits what may be typed.
   */
  registerLinkedEditingRangeProvider(
    languages: string | string[],
    provide: (
      context: ProviderContext,
    ) => Answer<TextRange[] | { ranges: TextRange[]; wordPattern?: string }>,
  ): Disposable;
  /** Expand / shrink selection (Shift+Alt+Right): for each position, the range around it, out. */
  registerSelectionRangeProvider(
    languages: string | string[],
    provide: (
      context: DocumentContext & { positions: { line: number; column: number }[] },
    ) => Answer<(SelectionRange | TextRange[])[]>,
  ): Disposable;
  /** Show call hierarchy (Shift+Alt+H): who calls the function at a position, and what it calls. */
  registerCallHierarchyProvider(
    languages: string | string[],
    provider: {
      prepareCallHierarchy(context: ProviderContext): Answer<HierarchyItem | HierarchyItem[]>;
      provideCallHierarchyIncomingCalls(
        context: DocumentContext & { item: HierarchyItem },
      ): Answer<HierarchyCall[]>;
      provideCallHierarchyOutgoingCalls(
        context: DocumentContext & { item: HierarchyItem },
      ): Answer<HierarchyCall[]>;
    },
  ): Disposable;
  /** Show type hierarchy: a type's supertypes and subtypes. */
  registerTypeHierarchyProvider(
    languages: string | string[],
    provider: {
      prepareTypeHierarchy(context: ProviderContext): Answer<HierarchyItem | HierarchyItem[]>;
      provideTypeHierarchySupertypes(
        context: DocumentContext & { item: HierarchyItem },
      ): Answer<HierarchyItem[]>;
      provideTypeHierarchySubtypes(
        context: DocumentContext & { item: HierarchyItem },
      ): Answer<HierarchyItem[]>;
    },
  ): Disposable;
  /**
   * What the debugger shows the value of under the pointer while paused (VS Code's
   * EvaluatableExpressionProvider): a range, and the expression when it isn't the range's text.
   */
  registerEvaluatableExpressionProvider(
    languages: string | string[],
    provide: (context: ProviderContext) => Answer<{ range: TextRange; expression?: string } | null>,
  ): Disposable;
  /**
   * The values the debugger shows at the end of lines while paused (VS Code's
   * InlineValuesProvider): asked about `range` (up to the stopped line) of the stopped file.
   */
  registerInlineValuesProvider(
    languages: string | string[],
    provide: (
      context: DocumentContext & { range: FullRange; frameId: number; stoppedLine: number },
    ) => Answer<InlineValue[]>,
  ): Disposable;
}

/**
 * Builds `ide.languages`. `hovers` and `completions` are what the "hover" and "completion" calls
 * run (rpc.ts routes them); the other providers register through `onCall`.
 */
export function createLanguagesApi(
  request: Request,
  onCall: OnCall,
  hovers: Map<string, (c: ProviderContext, token?: CallToken) => unknown>,
  completions: Map<string, (c: ProviderContext, token?: CallToken) => unknown>,
): LanguagesApi {
  let providerId = 0;
  const list = (languages: string | string[]) =>
    typeof languages === "string" ? [languages] : [...languages];
  // The provider callbacks by key ("provider" calls), each with what takes it out again.
  const removers = new Map<string, () => void>();
  const otherProviders = {
    set: (key: string, handler: (c: never) => unknown) => {
      removers.get(key)?.();
      removers.set(key, onCall(key, handler));
    },
    delete: (key: string) => {
      removers.get(key)?.();
      removers.delete(key);
    },
  };

  /**
   * definition, references, formatting…: the host checks what each answers. `parts` are the
   * provider's second calls (rename's prepare, a code action's resolve), called as `<id>.<part>`.
   */
  const registerFeature = (
    feature: string,
    languages: string | string[],
    provide: (c: never) => unknown,
    options: Record<string, unknown> = {},
    parts: Record<string, (c: never) => unknown> = {},
  ): Disposable & { id: string } => {
    const id = `${feature}${++providerId}`;
    const keys = [id, ...Object.keys(parts).map((part) => `${id}.${part}`)];
    otherProviders.set(id, provide);
    for (const [part, call] of Object.entries(parts)) otherProviders.set(`${id}.${part}`, call);
    const forget = () => {
      for (const key of keys) otherProviders.delete(key);
    };
    void request("languages.register", {
      ...options,
      id,
      languages: list(languages),
      feature,
    }).catch((err: unknown) => {
      forget();
      console.error(err instanceof Error ? err.message : String(err));
    });
    return {
      id,
      dispose: () => {
        forget();
        void request("languages.unregister", { id }).catch(() => {});
      },
    };
  };

  /**
   * Code actions resolved when chosen (VS Code's resolveCodeAction): each offered action is kept
   * under an id until the editor releases it (or, at most MAX_KEPT_ACTIONS, the oldest goes).
   */
  const registerResolvingCodeActions = (
    languages: string | string[],
    provide: (context: CodeActionContext) => Answer<CodeAction[]>,
    resolve: (action: CodeAction) => Answer<CodeAction>,
  ): Disposable => {
    const kept = new Map<string, CodeAction>();
    let seq = 0;
    const keep = (action: CodeAction): string => {
      const resolveId = `a${++seq}`;
      kept.set(resolveId, action);
      for (const oldest of kept.keys()) {
        if (kept.size <= MAX_KEPT_ACTIONS) break;
        kept.delete(oldest);
      }
      return resolveId;
    };
    const handle = registerFeature(
      "codeActions",
      languages,
      async (context: CodeActionContext) => {
        const answer = await provide(context);
        if (answer == null) return null;
        const actions: unknown[] = Array.isArray(answer) ? answer : [answer];
        // A copy crosses (with its id); the extension's own object is what resolve gets.
        return actions.map((a) =>
          a && typeof a === "object" ? { ...a, resolveId: keep(a as CodeAction) } : a,
        );
      },
      { resolve: true },
      {
        resolve: async (args: { resolveId?: unknown }, token?: CallToken) => {
          const action = kept.get(String(args?.resolveId));
          if (!action) return null;
          // VS Code's resolve fills in the action it's given (or returns another one).
          return (
            (await (resolve as (a: CodeAction, t?: CallToken) => Answer<CodeAction>)(
              action,
              token,
            )) ?? action
          );
        },
        release: (args: { resolveIds?: unknown }) => {
          for (const id of Array.isArray(args?.resolveIds) ? args.resolveIds : [])
            kept.delete(String(id));
          return null;
        },
      },
    );
    return {
      dispose: () => {
        kept.clear();
        handle.dispose();
      },
    };
  };

  const api: LanguagesApi = {
    setDiagnostics: (path, items) => request("languages.setDiagnostics", { path, items }),
    clearDiagnostics: (path) =>
      request("languages.clearDiagnostics", path === undefined ? {} : { path }),
    getLanguages: () => request<string[]>("languages.list"),
    execute: (query) => request("languages.execute", query),
    setLanguageConfiguration(languageId, configuration) {
      const key = `lc${++providerId}`;
      void request("languages.setConfiguration", { key, languageId, configuration }).catch(
        () => {},
      );
      return {
        dispose: () => void request("languages.unsetConfiguration", { key }).catch(() => {}),
      };
    },
    registerHoverProvider(languages, provide) {
      const id = `hover${++providerId}`;
      hovers.set(id, provide as (c: ProviderContext) => unknown);
      void request("languages.register", { id, languages: list(languages), hover: true }).catch(
        () => hovers.delete(id),
      );
      return {
        dispose: () => {
          hovers.delete(id);
          void request("languages.unregister", { id }).catch(() => {});
        },
      };
    },
    registerCompletionProvider(languages, provide, options = {}) {
      const id = `completion${++providerId}`;
      completions.set(id, provide as (c: ProviderContext) => unknown);
      // VS Code's resolveCompletionItem: a "provider" call `<id>.resolve` with the item's id.
      const resolve = typeof options.resolve === "function" ? options.resolve : undefined;
      if (resolve) otherProviders.set(`${id}.resolve`, resolve as (c: never) => unknown);
      const forget = () => {
        completions.delete(id);
        if (resolve) otherProviders.delete(`${id}.resolve`);
      };
      void request("languages.register", {
        id,
        languages: list(languages),
        completion: true,
        triggerCharacters: options.triggerCharacters ?? [],
        ...(resolve && { resolve: true }),
      }).catch(forget);
      return {
        dispose: () => {
          forget();
          void request("languages.unregister", { id }).catch(() => {});
        },
      };
    },
    registerDefinitionProvider: (languages, provide) =>
      registerFeature("definition", languages, provide),
    registerReferenceProvider: (languages, provide) =>
      registerFeature("references", languages, provide),
    registerDocumentFormattingProvider: (languages, provide) =>
      registerFeature("formatting", languages, provide),
    registerRangeFormattingProvider: (languages, provide) =>
      registerFeature("rangeFormatting", languages, provide),
    registerCodeActionProvider: (languages, provide, options = {}) =>
      typeof options.resolve === "function"
        ? registerResolvingCodeActions(languages, provide, options.resolve)
        : registerFeature("codeActions", languages, provide),
    registerRenameProvider: (languages, provide, options = {}) => {
      const prepare = options.prepare;
      return typeof prepare === "function"
        ? registerFeature("rename", languages, provide, { prepare: true }, { prepare })
        : registerFeature("rename", languages, provide);
    },
    registerSignatureHelpProvider: (languages, provide, options = {}) =>
      registerFeature("signatureHelp", languages, provide, {
        triggerCharacters: options.triggerCharacters ?? [],
        retriggerCharacters: options.retriggerCharacters ?? [],
      }),
    registerDocumentSymbolProvider: (languages, provide) =>
      registerFeature("documentSymbols", languages, provide),
    registerCodeLensProvider: (languages, provide) =>
      registerFeature("codeLens", languages, provide),
    registerInlayHintsProvider: (languages, provide, options = {}) => {
      const resolve = options.resolve;
      return typeof resolve === "function"
        ? registerFeature("inlayHints", languages, provide, { resolve: true }, { resolve })
        : registerFeature("inlayHints", languages, provide);
    },
    registerSemanticTokensProvider: (languages, provide, legend, options = {}) => {
      const handle = registerFeature("semanticTokens", languages, provide, {
        legend: {
          tokenTypes: legend?.tokenTypes ?? [],
          tokenModifiers: legend?.tokenModifiers ?? [],
        },
        ...(options.range === true && { range: true }),
      });
      let disposed = false;
      const refresh = () => {
        if (!disposed) void request("languages.refresh", { id: handle.id }).catch(() => {});
      };
      // VS Code's onDidChangeSemanticTokens: an event the provider fires.
      const subscription =
        typeof options.onDidChange === "function" ? options.onDidChange(() => refresh()) : null;
      return {
        refresh,
        dispose: () => {
          disposed = true;
          subscription?.dispose();
          handle.dispose();
        },
      };
    },
    registerTypeDefinitionProvider: (languages, provide) =>
      registerFeature("typeDefinition", languages, provide),
    registerImplementationProvider: (languages, provide) =>
      registerFeature("implementation", languages, provide),
    registerDeclarationProvider: (languages, provide) =>
      registerFeature("declaration", languages, provide),
    registerDocumentHighlightProvider: (languages, provide) =>
      registerFeature("documentHighlights", languages, provide),
    registerFoldingRangeProvider: (languages, provide) =>
      registerFeature("foldingRanges", languages, provide),
    registerDocumentLinkProvider: (languages, provide) =>
      registerFeature("documentLinks", languages, provide),
    registerColorProvider: (languages, provide, options = {}) => {
      const presentations = options.presentations;
      return typeof presentations === "function"
        ? registerFeature("colors", languages, provide, { presentations: true }, { presentations })
        : registerFeature("colors", languages, provide);
    },
    registerOnTypeFormattingProvider: (languages, provide, triggerCharacters) =>
      registerFeature("onTypeFormatting", languages, provide, {
        triggerCharacters: Array.isArray(triggerCharacters) ? triggerCharacters : [],
      }),
    registerInlineCompletionProvider: (languages, provide) =>
      registerFeature("inlineCompletions", languages, provide),
    registerWorkspaceSymbolProvider: (provide) =>
      registerFeature("workspaceSymbols", ["*"], provide),
    registerLinkedEditingRangeProvider: (languages, provide) =>
      registerFeature("linkedEditingRanges", languages, provide),
    registerSelectionRangeProvider: (languages, provide) =>
      registerFeature("selectionRanges", languages, provide),
    registerCallHierarchyProvider: (languages, provider) =>
      registerFeature(
        "callHierarchy",
        languages,
        (c: ProviderContext) => provider.prepareCallHierarchy(c),
        {},
        {
          incoming: (c: DocumentContext & { item: HierarchyItem }) =>
            provider.provideCallHierarchyIncomingCalls(c),
          outgoing: (c: DocumentContext & { item: HierarchyItem }) =>
            provider.provideCallHierarchyOutgoingCalls(c),
        },
      ),
    registerTypeHierarchyProvider: (languages, provider) =>
      registerFeature(
        "typeHierarchy",
        languages,
        (c: ProviderContext) => provider.prepareTypeHierarchy(c),
        {},
        {
          supertypes: (c: DocumentContext & { item: HierarchyItem }) =>
            provider.provideTypeHierarchySupertypes(c),
          subtypes: (c: DocumentContext & { item: HierarchyItem }) =>
            provider.provideTypeHierarchySubtypes(c),
        },
      ),
    registerEvaluatableExpressionProvider: (languages, provide) =>
      registerFeature("evaluatableExpressions", languages, provide),
    registerInlineValuesProvider: (languages, provide) =>
      registerFeature("inlineValues", languages, provide),
  };
  return api;
}
