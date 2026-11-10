// What third-party extensions add to the editor and the menus (D176), kept here DOM-free so the
// extensions host can fill it before the editor engine has loaded, and the editor and the menus
// read it: language providers per language (hover, completion and those of extensionProviders.ts),
// decorations on lines of a file, and commands in context menus. Each entry belongs to an owner (the extension's id), so stopping an
// extension removes everything it added.
import type { Event } from "../core/events/index";
import { LogLevels } from "../core/extensions/logLevels";
import type { TerminalEnvChange } from "../core/extensions/rpcTerminals";
import type { Disposable } from "../core/lifecycle/index";
import { toDisposable } from "../core/lifecycle/index";
import { type Signal, signal } from "../core/reactive/index";
import type { IconName } from "../ui/Icon";
import type { NewTabTool } from "./dock/newTab";
import type { DecorationTypeStyle } from "./extensionDecorationTypes";
import { ExtensionHooks } from "./extensionHooks";
import type {
  CodeActionContext,
  CodeActionEntry,
  CodeLensEntry,
  ColorEntry,
  ColorPresentationEntry,
  ColorValue,
  DocumentContext,
  EvaluatableEntry,
  FoldingEntry,
  FormattingContext,
  FullRange,
  HierarchyCallEntry,
  HierarchyItemEntry,
  HighlightEntry,
  InlayHintEntry,
  InlineCompletionEntry,
  InlineValueEntry,
  LinkEntry,
  LinkedEditingEntry,
  ProviderFileEdit,
  ProviderLocation,
  ProviderTextEdit,
  RenameLocationEntry,
  SemanticTokensLegend,
  SignatureHelpEntry,
  SymbolEntry,
  WorkspaceSymbolEntry,
} from "./extensionProviders";
import {
  AuthProviderRegistry,
  type ContributedTerminal,
  DebugAdapterRegistry,
  DebugResolverRegistry,
  DebugTrackerRegistry,
  type FileSystemRegistry,
  fileSystems,
  OwnedList,
  SourceControlRegistry,
  TaskProviderRegistry,
  type WebviewPanelEntry,
} from "./extensionRegistries";
import { ExtensionTestRegistry } from "./extensionTests";
import { RestorablePanels } from "./webviewPanelRestore";

/** Where the request comes from (1-based). */
/** A hover with the range it's about (1-based lines and columns, the end column exclusive). */
export interface HoverAnswer {
  contents: string;
  range?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
}

/**
 * An extension's hover answer checked: Markdown text, or `{ contents, range }` with a sane range
 * (whole numbers, start before end); anything else is nothing.
 */
export function toHoverAnswer(raw: unknown): string | HoverAnswer | null {
  if (typeof raw === "string") return raw || null;
  if (!raw || typeof raw !== "object") return null;
  const { contents, range } = raw as { contents?: unknown; range?: unknown };
  if (typeof contents !== "string" || !contents) return null;
  const r = (range && typeof range === "object" ? range : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : 0);
  const startLine = n(r.startLine);
  const startColumn = n(r.startColumn);
  const endLine = n(r.endLine);
  const endColumn = n(r.endColumn);
  const ordered =
    startLine && startColumn && endLine && endColumn
      ? endLine > startLine || (endLine === startLine && endColumn >= startColumn)
      : false;
  return ordered
    ? { contents, range: { startLine, startColumn, endLine, endColumn } }
    : { contents };
}

export interface FeatureContext {
  path: string;
  languageId: string;
  line: number;
  column: number;
  /** The word at the position ("" between words). */
  word: string;
  /** The line's text before the position. */
  linePrefix: string;
  /** Completions: how they were asked for (VS Code's CompletionContext). */
  triggerKind?: "invoke" | "triggerCharacter" | "incomplete";
  triggerCharacter?: string;
}

/** VS Code's CompletionItemKind names. */
export const COMPLETION_KINDS = [
  "text",
  "method",
  "function",
  "constructor",
  "field",
  "variable",
  "class",
  "interface",
  "module",
  "property",
  "unit",
  "value",
  "enum",
  "keyword",
  "snippet",
  "color",
  "file",
  "reference",
  "folder",
  "enumMember",
  "constant",
  "struct",
  "event",
  "operator",
  "typeParameter",
  "user",
  "issue",
] as const;

export type CompletionKind = (typeof COMPLETION_KINDS)[number];

/** Editor commands a completion may run after it's inserted (besides the extension's own). */
export const COMPLETION_EDITOR_COMMANDS = [
  "editor.action.triggerSuggest",
  "editor.action.triggerParameterHints",
] as const;

export interface CompletionEntry {
  label: string;
  /** Faint text after the label (a signature) and at the row's end (a module). */
  labelDetail?: string;
  labelDescription?: string;
  /** What's inserted (default: the label). Snippet syntax (`${1:name}`) with `snippet` or kind "snippet". */
  insertText?: string;
  snippet?: boolean;
  detail?: string;
  /** Markdown. */
  documentation?: string;
  kind?: CompletionKind;
  deprecated?: boolean;
  /**
   * D261: what it replaces (default: the word at the cursor), on the cursor's line; with
   * `replaceRange`, what's replaced on insert (VS Code's `inserting`).
   */
  range?: TextRange;
  /** What's replaced in replace mode (VS Code's `replacing`). */
  replaceRange?: TextRange;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  commitCharacters?: string[];
  /** Edits elsewhere made with it (an auto-import). */
  additionalTextEdits?: (TextRange & { text: string })[];
  /** Run after it's inserted (the extension's own, or COMPLETION_EDITOR_COMMANDS). */
  command?: { id: string; input?: unknown };
  /** Completed when selected (completion.resolve). */
  resolveId?: string;
}

/** A provider's answer: the items, and whether typing on should ask again (VS Code's). */
export interface CompletionResult {
  items: readonly CompletionEntry[];
  isIncomplete?: boolean;
}

/** An extension's terminal profile (D264): `open` starts its code if needed and makes the terminal. */
export interface ContributedTerminalProfileEntry {
  owner: string;
  id: string;
  title: string;
  icon?: string;
  open(): Promise<void>;
}

/** An extension's links in a terminal line (D264), each opened by its `activate`. */
export interface ContributedTerminalLinks {
  owner: string;
  provide(
    line: string,
    terminal: { name: string },
  ): Promise<{ startIndex: number; length: number; tooltip?: string; activate(): void }[]>;
}

/**
 * New terminals' extra variables from extensions' changes (D264), in the order the extensions
 * set them: a replacement is the value; an append or prepend goes after or before the variable's
 * value so far (`${env:NAME}`, the IDE's own value, when nothing set it before).
 */
export function terminalEnvVars(
  byExtension: ReadonlyMap<string, readonly TerminalEnvChange[]>,
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const changes of byExtension.values())
    for (const c of changes) {
      const name = c.variable;
      const before = vars[name] ?? `\${env:${name}}`;
      vars[name] =
        c.type === "append" ? before + c.value : c.type === "prepend" ? c.value + before : c.value;
    }
  return vars;
}

/**
 * A completion's own replace range as columns on the cursor's line (D261), or null when it can't
 * be used: Monaco needs one line that starts at or before the cursor and ends at or after it.
 */
export function completionColumns(
  range: TextRange | undefined,
  line: number,
  column: number,
): [start: number, end: number] | null {
  if (!range || range.startColumn === undefined) return null;
  const endLine = range.endLine ?? range.startLine;
  const end = range.endColumn ?? range.startColumn;
  if (range.startLine !== line || endLine !== line) return null;
  if (range.startColumn < 1 || range.startColumn > column || end < column) return null;
  return [range.startColumn, end];
}

export interface LanguageFeature {
  owner: string;
  /** Language ids ("typescript", "markdown"), or "*" for every file. */
  languages: readonly string[];
  /** Document schemes it answers for (default: files only; notebook cells: "notebook-cell"). */
  schemes?: readonly string[];
  /**
   * Its owner for editor.defaultFormatter (an extension's id; the built-in language servers'
   * own id): default `owner`.
   */
  formatterId?: string;
  /** Its owner's name, as the formatter picker shows it (an extension's display name). */
  ownerName?: string;
  /**
   * Every provider below may take an AbortSignal as its second argument: it aborts when the
   * editor no longer needs the answer (VS Code's CancellationToken).
   */
  /**
   * Markdown shown on hover, or null for nothing; with a range (VS Code's Hover.range), that range
   * is what the hover highlights instead of the word under the pointer.
   */
  hover?(context: FeatureContext, signal?: AbortSignal): Promise<string | HoverAnswer | null>;
  completion?: {
    triggerCharacters: readonly string[];
    provide(
      context: FeatureContext,
      signal?: AbortSignal,
    ): Promise<readonly CompletionEntry[] | CompletionResult>;
    /** The item filled in (documentation, detail, additional edits) when it's selected. */
    resolve?(
      context: { resolveId: string },
      signal?: AbortSignal,
    ): Promise<Partial<CompletionEntry> | null>;
  };
  // The other providers (extensionProviders.ts): answers already checked by the host.
  definition?(context: FeatureContext, signal?: AbortSignal): Promise<ProviderLocation[]>;
  references?(
    context: FeatureContext & { includeDeclaration: boolean },
    signal?: AbortSignal,
  ): Promise<ProviderLocation[]>;
  formatting?(context: FormattingContext, signal?: AbortSignal): Promise<ProviderTextEdit[]>;
  rangeFormatting?(
    context: FormattingContext & { range: FullRange },
    signal?: AbortSignal,
  ): Promise<ProviderTextEdit[]>;
  codeActions?(context: CodeActionContext, signal?: AbortSignal): Promise<CodeActionEntry[]>;
  /** The edits of an action offered with a `resolveId`, asked for when it's chosen. */
  resolveCodeAction?(
    context: DocumentContext & { resolveId: string },
    signal?: AbortSignal,
  ): Promise<ProviderFileEdit[]>;
  /** The editor is done with these offered actions: the extension can forget them. */
  releaseCodeActions?(resolveIds: readonly string[]): void;
  /** Rejects with the reason the symbol can't be renamed. */
  rename?(
    context: FeatureContext & { newName: string },
    signal?: AbortSignal,
  ): Promise<ProviderFileEdit[]>;
  /**
   * Before the rename box opens (VS Code's prepareRename): the range renamed and the text the box
   * starts with; null for the word at the position. Rejects with the reason (shown at the symbol).
   */
  prepareRename?(
    context: FeatureContext,
    signal?: AbortSignal,
  ): Promise<RenameLocationEntry | null>;
  signatureHelp?: {
    triggerCharacters: readonly string[];
    retriggerCharacters: readonly string[];
    provide(
      context: FeatureContext & { triggerCharacter?: string; isRetrigger?: boolean },
      signal?: AbortSignal,
    ): Promise<SignatureHelpEntry | null>;
  };
  documentSymbols?(context: DocumentContext, signal?: AbortSignal): Promise<SymbolEntry[]>;
  codeLens?(context: DocumentContext, signal?: AbortSignal): Promise<CodeLensEntry[]>;
  inlayHints?(
    context: DocumentContext & { range: FullRange },
    signal?: AbortSignal,
  ): Promise<InlayHintEntry[]>;
  /** A hint offered with a `resolveId`, filled in when it's hovered (VS Code's resolveInlayHint). */
  resolveInlayHint?(
    context: DocumentContext & { resolveId: string },
    signal?: AbortSignal,
  ): Promise<InlayHintEntry | null>;
  semanticTokens?: {
    legend: SemanticTokensLegend;
    /** Encoded (encodeSemanticTokens). */
    provide(context: DocumentContext, signal?: AbortSignal): Promise<number[]>;
    /** Fires when the extension says its tokens changed: the editor asks again. */
    onDidChange?: Event<void>;
  };
  /** Tokens of a range only (VS Code's DocumentRangeSemanticTokensProvider), encoded. */
  rangeSemanticTokens?: {
    legend: SemanticTokensLegend;
    provide(
      context: DocumentContext & { range: FullRange },
      signal?: AbortSignal,
    ): Promise<number[]>;
  };
  // D234: the rest of VS Code's common language providers.
  typeDefinition?(context: FeatureContext, signal?: AbortSignal): Promise<ProviderLocation[]>;
  implementation?(context: FeatureContext, signal?: AbortSignal): Promise<ProviderLocation[]>;
  declaration?(context: FeatureContext, signal?: AbortSignal): Promise<ProviderLocation[]>;
  documentHighlights?(context: FeatureContext, signal?: AbortSignal): Promise<HighlightEntry[]>;
  foldingRanges?(context: DocumentContext, signal?: AbortSignal): Promise<FoldingEntry[]>;
  documentLinks?(context: DocumentContext, signal?: AbortSignal): Promise<LinkEntry[]>;
  colors?: {
    provide(context: DocumentContext, signal?: AbortSignal): Promise<ColorEntry[]>;
    /** How a picked color is written; without it, as hex ("#rrggbb"). */
    presentations?(
      context: DocumentContext & { color: ColorValue; range: FullRange },
      signal?: AbortSignal,
    ): Promise<ColorPresentationEntry[]>;
  };
  onTypeFormatting?: {
    /** The first is VS Code's firstTriggerCharacter, the others its moreTriggerCharacter. */
    triggerCharacters: readonly string[];
    provide(
      context: FeatureContext & { ch: string; tabSize: number; insertSpaces: boolean },
      signal?: AbortSignal,
    ): Promise<ProviderTextEdit[]>;
  };
  inlineCompletions?(
    context: FeatureContext & { explicit: boolean },
    signal?: AbortSignal,
  ): Promise<InlineCompletionEntry[]>;
  /** Go to symbol in workspace (languages don't apply: asked with the query). */
  workspaceSymbols?(context: { query: string }): Promise<WorkspaceSymbolEntry[]>;
  // D255: the rest of VS Code's language providers.
  linkedEditingRanges?(
    context: FeatureContext,
    signal?: AbortSignal,
  ): Promise<LinkedEditingEntry | null>;
  /** For each position (1-based), the ranges from the innermost out (Expand selection). */
  selectionRanges?(
    context: DocumentContext & { positions: { line: number; column: number }[] },
    signal?: AbortSignal,
  ): Promise<TextRange[][]>;
  callHierarchy?: {
    prepare(context: FeatureContext): Promise<HierarchyItemEntry[]>;
    incoming(
      context: DocumentContext & { item: HierarchyItemEntry },
    ): Promise<HierarchyCallEntry[]>;
    outgoing(
      context: DocumentContext & { item: HierarchyItemEntry },
    ): Promise<HierarchyCallEntry[]>;
  };
  typeHierarchy?: {
    prepare(context: FeatureContext): Promise<HierarchyItemEntry[]>;
    supertypes(
      context: DocumentContext & { item: HierarchyItemEntry },
    ): Promise<HierarchyItemEntry[]>;
    subtypes(
      context: DocumentContext & { item: HierarchyItemEntry },
    ): Promise<HierarchyItemEntry[]>;
  };
  /** What the debugger evaluates under the pointer while paused (a value on hover). */
  evaluatableExpression?(
    context: FeatureContext,
    signal?: AbortSignal,
  ): Promise<EvaluatableEntry | null>;
  /**
   * What the debugger shows at the end of lines while paused (VS Code's InlineValuesProvider):
   * asked about the visible range and the stopped location.
   */
  inlineValues?(
    context: DocumentContext & { range: FullRange; frameId: number; stoppedLine: number },
    signal?: AbortSignal,
  ): Promise<InlineValueEntry[]>;
}

/** Whether a feature registered for `languages` answers for `languageId`. */
export function featureMatches(feature: LanguageFeature, languageId: string): boolean {
  return feature.languages.includes("*") || feature.languages.includes(languageId);
}

/** How decorated text looks: theme colors, never the extension's own (it can't break a theme). */
export type DecorationStyle =
  | "highlight"
  | "underline"
  | "error"
  | "warning"
  | "info"
  | "faded"
  | "strong";

export const DECORATION_STYLES: readonly DecorationStyle[] = [
  "highlight",
  "underline",
  "error",
  "warning",
  "info",
  "faded",
  "strong",
];

export interface DecorationRange {
  /** 1-based; a range without columns covers whole lines. */
  startLine: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  /** Markdown shown when hovering the range. */
  hover?: string;
  /** A decoration type's text before / after this range instead of the type's (D234). */
  before?: string;
  after?: string;
}

export interface EditorDecoration {
  owner: string;
  /** The extension's name for this set (setting the same key again replaces it). */
  key: string;
  path: string;
  /** A theme style, or "custom": the extension's decoration type in `custom` (D234). */
  style: DecorationStyle | "custom";
  custom?: { id: number; style: DecorationTypeStyle };
  ranges: readonly DecorationRange[];
  /** Faint text after each range's last line ("3 references", "← changed"). */
  after?: string;
  /** Also marked in the accent color on the scrollbar and the minimap's left edge (D273). */
  mapped?: boolean;
}

/** Context menus an extension can add commands to. */
export type MenuLocation =
  | "explorer/context"
  | "editor/context"
  | "editor/title"
  | "view/title"
  | "menubar/view"
  /** A notebook's toolbar, a cell's toolbar / "…" menu, the kernel picker (D204). */
  | "notebook/toolbar"
  | "notebook/cell/title"
  | "notebook/kernelSource";

/**
 * Something an extension can open, listed under View → Extensions (D181): each of its views
 * (sidebar, panel, editor page), so a tool someone built is never hidden behind a command name.
 */
export interface ContributedOpener {
  owner: string;
  /** The extension's name (the submenu groups by it). */
  extension: string;
  title: string;
  icon?: string;
  command: string;
  input?: unknown;
  /** Offered while this holds (a view's `when`, D260). */
  when?: string;
  /** Where it opens ("side bar"), added to the title only when another offered one shares it. */
  where?: string;
}

export interface MenuContribution {
  owner: string;
  location: MenuLocation;
  command: string;
  title: string;
  /** An icon name from the IDE's icon set. */
  icon?: string;
  /** An image URL drawn instead of `icon` (an extension's own icon file), and for dark themes. */
  iconImage?: string;
  iconImageDark?: string;
  /**
   * A `when` clause: the IDE's context keys plus, in the explorer, `explorerResourceIsFolder`,
   * `resourceFilename`, `resourceExtname` (".ts") and `resourceLangId`; in the editor,
   * `resourceFilename`, `resourceExtname`, `resourceLangId`; on a view's title, `view`.
   */
  when?: string;
}

/**
 * An agent an extension brings (Agent Client Protocol over stdio, like the built-in Claude Code
 * and Codex entries): it shows in the model menu next to them (D176).
 */
export interface ContributedAgent {
  owner: string;
  name: string;
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  description?: string;
}

/** An MCP server an extension brings: its tools become the agent's (agent.mcpServers' format). */
export interface ContributedMcpServer {
  owner: string;
  name: string;
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}

/** A model provider an extension offers on the AI models page (the user connects it, with a key). */
export interface ContributedProvider {
  owner: string;
  id: string;
  name: string;
  /** OpenAI-compatible base URL, or Anthropic's. */
  baseUrl: string;
  kind?: "openai" | "anthropic";
  needsKey: boolean;
  /** Where to get a key (host and path, shown as a link). */
  keyHint?: string;
  blurb?: string;
  defaultModel?: string;
}

/** Limits, so one extension can't flood the editor. */
const MAX_DECORATION_RANGES = 5000;
const MAX_MENU_ITEMS = 50;

export class ExtensionFeatures {
  readonly languages: Signal<readonly LanguageFeature[]> = signal([]);
  readonly decorations: Signal<readonly EditorDecoration[]> = signal([]);
  readonly menus: Signal<readonly MenuContribution[]> = signal([]);
  readonly agents: Signal<readonly ContributedAgent[]> = signal([]);
  readonly mcpServers: Signal<readonly ContributedMcpServer[]> = signal([]);
  readonly providers: Signal<readonly ContributedProvider[]> = signal([]);
  readonly openers: Signal<readonly ContributedOpener[]> = signal([]);
  /** Extensions' terminal profiles, in the terminal's profile menu (D264). */
  readonly terminalProfiles = new OwnedList<ContributedTerminalProfileEntry>();
  /** Extensions' link providers for terminal lines (VS Code's TerminalLinkProvider, D264). */
  readonly terminalLinks = new OwnedList<ContributedTerminalLinks>();
  /** Extensions' changes to new terminals' environment, by extension id (D264). */
  readonly terminalEnv: Signal<ReadonlyMap<string, readonly TerminalEnvChange[]>> = signal(
    new Map(),
  );

  /** Sets `owner`'s changes to new terminals' environment ([] clears them). */
  setTerminalEnv(owner: string, changes: readonly TerminalEnvChange[]): void {
    const next = new Map(this.terminalEnv.peek());
    if (changes.length) next.set(owner, [...changes]);
    else if (next.has(owner)) next.delete(owner);
    else return;
    this.terminalEnv.value = next;
  }
  // What extensions plug into the workbench's features (extensionRegistries.ts, D233).
  readonly terminals = new OwnedList<ContributedTerminal>();
  readonly tasks = new TaskProviderRegistry();
  readonly sourceControls = new SourceControlRegistry();
  readonly debugAdapters = new DebugAdapterRegistry();
  readonly authentication = new AuthProviderRegistry();
  readonly fileSystems: FileSystemRegistry = fileSystems;
  // Typing, will-save, URI handlers, comments and chat participants (extensionHooks.ts).
  readonly hooks = new ExtensionHooks();
  /** Test controllers (VS Code's `tests.createTestController`): the Testing view shows them. */
  readonly tests = new ExtensionTestRegistry();
  /** Webview panels extensions' code opened (`ide.ui.createWebviewPanel`). */
  readonly webviewPanels = new OwnedList<WebviewPanelEntry>();
  /** Panels of the folder's last session waiting for their extension (VS Code's serializers). */
  readonly restorablePanels = new RestorablePanels();
  /** Extensions' log channels (VS Code's `{ log: true }`): "Set log level…" lists them. */
  readonly logChannels = new OwnedList<{ owner: string; id: string; name: string }>();
  /** The log levels the user picked, the default and per channel (persisted globally). */
  readonly logLevels = new LogLevels();
  /** Debug adapter trackers extensions' code registered (D258). */
  readonly debugTrackers = new DebugTrackerRegistry();
  /** Extensions' activation on debug events and their configuration resolvers (any type). */
  readonly debugResolvers = new DebugResolverRegistry();
  /** Language configurations extensions' code set (D258; language-configuration.json's shape). */
  readonly languageConfigurations = new OwnedList<{
    owner: string;
    languageId: string;
    configuration: unknown;
  }>();

  /** Adds to one of the lists; disposing takes the items out again. */
  contribute<T>(list: Signal<readonly T[]>, items: readonly T[]): Disposable {
    if (!items.length) return toDisposable(() => {});
    list.value = [...list.peek(), ...items];
    return toDisposable(() => {
      list.value = list.peek().filter((x) => !items.includes(x));
    });
  }

  /** The first extension feature with `key` for `languageId` (hierarchies, the debugger's hover). */
  firstFor<K extends keyof LanguageFeature>(
    key: K,
    languageId: string,
  ): NonNullable<LanguageFeature[K]> | null {
    const f = this.languages.peek().find((x) => x[key] && featureMatches(x, languageId));
    return (f?.[key] ?? null) as NonNullable<LanguageFeature[K]> | null;
  }

  addLanguageFeature(feature: LanguageFeature): Disposable {
    this.languages.value = [...this.languages.peek(), feature];
    return toDisposable(() => {
      this.languages.value = this.languages.peek().filter((f) => f !== feature);
    });
  }

  /**
   * Every extension's workspace symbols for `query` (Go to symbol in workspace, D234): each gets
   * `ms` to answer; a slow or failing one adds nothing.
   */
  async workspaceSymbols(query: string, ms = 1500): Promise<WorkspaceSymbolEntry[]> {
    const asking = this.languages.peek().flatMap((f) => (f.workspaceSymbols ? [f] : []));
    const answers = await Promise.all(
      asking.map(
        (f) =>
          new Promise<WorkspaceSymbolEntry[]>((resolve) => {
            const timer = setTimeout(() => resolve([]), ms);
            f.workspaceSymbols?.({ query }).then(
              (list) => {
                clearTimeout(timer);
                resolve(list);
              },
              () => {
                clearTimeout(timer);
                resolve([]);
              },
            );
          }),
      ),
    );
    return answers.flat();
  }

  /** Replaces `owner`'s `key` set on `path` (no ranges: removes it). */
  setDecorations(decoration: EditorDecoration): void {
    const rest = this.decorations
      .peek()
      .filter(
        (d) =>
          !(d.owner === decoration.owner && d.key === decoration.key && d.path === decoration.path),
      );
    this.decorations.value = decoration.ranges.length
      ? [...rest, { ...decoration, ranges: decoration.ranges.slice(0, MAX_DECORATION_RANGES) }]
      : rest;
  }

  /** Everything `owner` decorated (or only its `key` sets). */
  clearDecorations(owner: string, key?: string): void {
    const kept = this.decorations
      .peek()
      .filter((d) => d.owner !== owner || (key !== undefined && d.key !== key));
    if (kept.length !== this.decorations.peek().length) this.decorations.value = kept;
  }

  addMenus(items: readonly MenuContribution[]): Disposable {
    const added = items.slice(0, MAX_MENU_ITEMS);
    if (!added.length) return toDisposable(() => {});
    this.menus.value = [...this.menus.peek(), ...added];
    return toDisposable(() => {
      this.menus.value = this.menus.peek().filter((m) => !added.includes(m));
    });
  }

  /**
   * What extensions can open, in order (all of them, or one extension's): their views, then the
   * commands they put in "menubar/view" whose `when` holds.
   */
  allOpeners(matches: (when: string | undefined) => boolean, owner?: string): ContributedOpener[] {
    const fromMenus = this.menuItems("menubar/view", matches).map((m) => ({
      owner: m.owner,
      extension: m.owner,
      title: m.title,
      ...(m.icon && { icon: m.icon }),
      command: m.command,
    }));
    const offered: ContributedOpener[] = [
      ...this.openers.peek().filter((o) => safeMatch(matches, o.when)),
      ...fromMenus,
    ];
    // Two of one extension offered under one name say where each opens (D262); one alone
    // keeps its name.
    const shared = (o: ContributedOpener) =>
      offered.filter((x) => x.owner === o.owner && x.title === o.title).length > 1;
    return offered
      .map((o) => (o.where && shared(o) ? { ...o, title: `${o.title} (${o.where})` } : o))
      .filter((o) => owner === undefined || o.owner === owner)
      .sort((a, b) => (a.owner === b.owner ? 0 : a.owner < b.owner ? -1 : 1));
  }

  /** The commands for `location` whose `when` holds (`matches` evaluates it). */
  menuItems(
    location: MenuLocation,
    matches: (when: string | undefined) => boolean,
  ): MenuContribution[] {
    return this.menus.peek().filter((m) => m.location === location && safeMatch(matches, m.when));
  }
}

/** A `when` clause an extension wrote badly hides its item instead of breaking the menu. */
function safeMatch(matches: (when: string | undefined) => boolean, when: string | undefined) {
  try {
    return matches(when);
  } catch {
    return false;
  }
}

/** The context keys of a file for menu `when` clauses (explorer and editor menus). */
export function resourceContext(
  path: string,
  isFolder: boolean,
  languageId?: string,
): Record<string, string | boolean> {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  return {
    explorerResourceIsFolder: isFolder,
    resourceFilename: name,
    resourceExtname: !isFolder && dot > 0 ? name.slice(dot).toLowerCase() : "",
    resourceLangId: languageId ?? "",
    resourcePath: path,
  };
}

/** A range in a text (1-based lines and columns; the end column is exclusive). */
export interface TextRange {
  startLine: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

/**
 * `text` with `range` replaced by `replacement` (D176: ide.editor.replace, editor.replaceRange).
 * No columns: whole lines (the start line through the end line, its line break kept). Lines and
 * columns past the end are clamped; "\r\n" texts count each line without its "\r".
 */
export function applyRangeEdit(text: string, range: TextRange, replacement: string): string {
  const lines = text.split("\n");
  const last = lines.length;
  const startLine = Math.min(Math.max(1, Math.floor(range.startLine)), last);
  const endLine = Math.min(Math.max(startLine, Math.floor(range.endLine ?? startLine)), last);
  const content = (n: number) => (lines[n - 1] ?? "").replace(/\r$/, "");
  const offsetOf = (line: number, column: number) => {
    let at = 0;
    for (let i = 1; i < line; i++) at += (lines[i - 1] ?? "").length + 1;
    return at + Math.min(Math.max(1, Math.floor(column)), content(line).length + 1) - 1;
  };
  const wholeLines = range.startColumn === undefined && range.endColumn === undefined;
  const start = offsetOf(startLine, wholeLines ? 1 : (range.startColumn ?? 1));
  const end = offsetOf(
    endLine,
    wholeLines || range.endColumn === undefined ? content(endLine).length + 1 : range.endColumn,
  );
  return text.slice(0, start) + replacement + text.slice(Math.max(start, end));
}

/** Extensions' tools as New tab lists them (D181). */
export function toolsOf(
  features: ExtensionFeatures,
  context: { matches(when: string | undefined): boolean },
): NewTabTool[] {
  return features
    .allOpeners((when) => context.matches(when))
    .map((o) => ({
      owner: o.owner,
      label: o.title,
      icon: (o.icon ?? "box") as IconName,
      command: o.command,
      ...(o.input !== undefined && { input: o.input }),
    }));
}
