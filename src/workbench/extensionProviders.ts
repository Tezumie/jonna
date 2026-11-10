// The language providers an extension can register beyond hover and completion (VS Code's
// `languages.register…Provider`): definition, references, formatting (document and range), code
// actions, rename, signature help, document symbols, code lens, inlay hints and semantic tokens.
// What the extension's worker answers is untrusted JSON: the functions here check and clamp it
// into the shapes the editor bridge uses (1-based lines and columns, as everywhere in the
// extension API), DOM-free and unit-tested. Paths go through the host's `resolve` (inside the
// open folder, or the item is dropped), and commands on code lenses and code actions must be the
// extension's own (a click runs them as the user).
import {
  COMPLETION_EDITOR_COMMANDS,
  COMPLETION_KINDS,
  type CompletionEntry,
  type CompletionResult,
  type TextRange,
} from "./extensionFeatures";

/** A whole document a provider is asked about. */
export interface DocumentContext {
  path: string;
  languageId: string;
  /** A notebook cell's document: the notebook, the cell's id and its text now. */
  cell?: { notebook: string; id: string; text: string };
}

/** A range with every field set (1-based; the end column is exclusive). */
export interface FullRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface FormattingContext extends DocumentContext {
  tabSize: number;
  insertSpaces: boolean;
  /** Range formatting only: the selection. */
  range?: FullRange;
}

/** A problem in the range a code action provider is asked about. */
export interface CodeActionProblem extends FullRange {
  message: string;
  severity: "error" | "warning" | "info" | "hint";
  source?: string;
  code?: string;
}

export interface CodeActionContext extends DocumentContext {
  range: FullRange;
  diagnostics: CodeActionProblem[];
  /** The kind asked for ("quickfix", "source.organizeImports"…), when the editor asks for one. */
  only?: string;
}

/** A place in a file. No columns: whole lines. */
export type ProviderLocation = TextRange & { path: string };

export type ProviderTextEdit = TextRange & { text: string };

export type ProviderFileEdit = ProviderTextEdit & { path: string };

/** One of the extension's commands, run (as the user) when the item is chosen. */
export interface ProviderCommand {
  id: string;
  input?: unknown;
}

export interface CodeActionEntry {
  title: string;
  /** "quickfix", "refactor", "source"… (VS Code's CodeActionKind values). */
  kind?: string;
  isPreferred?: boolean;
  edits?: ProviderFileEdit[];
  command?: ProviderCommand;
  /**
   * Set when the extension resolves its actions (VS Code's `resolveCodeAction`): the edits are
   * asked for with this id when the action is chosen, not when it's offered.
   */
  resolveId?: string;
}

/** Where a rename applies and the text the rename box starts with (VS Code's prepareRename). */
export interface RenameLocationEntry {
  range: TextRange;
  /** Default: the range's text. */
  placeholder?: string;
}

export interface SignatureParameter {
  /** The parameter's text in the signature's label, or its [start, end) offsets there. */
  label: string | [number, number];
  documentation?: string;
}

export interface SignatureEntry {
  label: string;
  documentation?: string;
  parameters: SignatureParameter[];
}

export interface SignatureHelpEntry {
  signatures: SignatureEntry[];
  activeSignature: number;
  activeParameter: number;
}

/** LSP's symbol kinds, in its order (LSP kind = index + 1; Monaco's SymbolKind = index). */
export const SYMBOL_KINDS = [
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
] as const;

export type SymbolKindName = (typeof SYMBOL_KINDS)[number];

export interface SymbolEntry {
  name: string;
  detail: string;
  kind: SymbolKindName;
  /** The whole symbol (a function with its body). */
  range: TextRange;
  /** Its name (default: the range's first line). */
  selectionRange: TextRange;
  children: SymbolEntry[];
}

export interface CodeLensEntry {
  range: TextRange;
  title: string;
  command?: ProviderCommand;
}

export interface InlayHintEntry {
  line: number;
  column: number;
  /** Its text, or parts (each may go somewhere, run a command, explain itself). */
  label: string | InlayHintPartEntry[];
  kind?: "type" | "parameter";
  tooltip?: string;
  paddingLeft?: boolean;
  paddingRight?: boolean;
  /** Made when the hint is double-clicked (VS Code's InlayHint.textEdits). */
  textEdits?: ProviderTextEdit[];
  /** Filled in (tooltip, parts' locations) when hovered: resolveInlayHint. */
  resolveId?: string;
}

export interface InlayHintPartEntry {
  value: string;
  tooltip?: string;
  location?: ProviderLocation;
  command?: ProviderCommand;
}

/** What the debugger shows after a line while paused (VS Code's InlineValue). */
export type InlineValueEntry =
  | { kind: "text"; range: TextRange; text: string }
  | { kind: "variable"; range: TextRange; name?: string; caseSensitive: boolean }
  | { kind: "expression"; range: TextRange; expression?: string };

export interface SemanticTokensLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

export interface SemanticTokenEntry {
  line: number;
  column: number;
  length: number;
  type: string;
  modifiers?: string[];
}

/** Limits, so one extension can't flood the editor. */
export const PROVIDER_LIMITS = {
  locations: 1000,
  edits: 5000,
  actions: 100,
  symbols: 5000,
  lenses: 500,
  hints: 5000,
  tokens: 200_000,
  signatures: 20,
  text: 100_000,
} as const;

/** Resolves an extension's path to a workspace path; throws for anything outside the folder. */
export type PathResolver = (path: unknown) => string;

const int = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined;

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" ? v.slice(0, max) : undefined;

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** A TextRange from the extension's fields (`startLine` required, ≥ 1), or null. */
export function toTextRange(raw: unknown): TextRange | null {
  const r = record(raw);
  const startLine = int(r.startLine ?? r.line);
  if (!startLine || startLine < 1) return null;
  const out: TextRange = { startLine };
  const startColumn = int(r.startColumn ?? r.column);
  if (startColumn !== undefined && startColumn >= 1) out.startColumn = startColumn;
  const endLine = int(r.endLine);
  if (endLine !== undefined && endLine >= startLine) out.endLine = endLine;
  const endColumn = int(r.endColumn);
  if (endColumn !== undefined && endColumn >= 1) out.endColumn = endColumn;
  return out;
}

/** Definitions and references: a location, a list, or nothing. */
export function normalizeLocations(raw: unknown, resolve: PathResolver): ProviderLocation[] {
  return list(raw)
    .slice(0, PROVIDER_LIMITS.locations)
    .flatMap((item) => {
      const range = toTextRange(item);
      if (!range) return [];
      try {
        return [{ ...range, path: resolve(record(item).path) }];
      } catch {
        return [];
      }
    });
}

/** Formatting: edits to the document asked about. */
export function normalizeTextEdits(raw: unknown): ProviderTextEdit[] {
  return list(raw)
    .slice(0, PROVIDER_LIMITS.edits)
    .flatMap((item) => {
      const range = toTextRange(item);
      const text = record(item).text;
      return range && typeof text === "string" ? [{ ...range, text }] : [];
    });
}

/** Edits across files (rename, code actions); an edit without a path is in `defaultPath`. */
export function normalizeFileEdits(
  raw: unknown,
  resolve: PathResolver,
  defaultPath: string,
): ProviderFileEdit[] {
  return list(raw)
    .slice(0, PROVIDER_LIMITS.edits)
    .flatMap((item) => {
      const r = record(item);
      const range = toTextRange(item);
      if (!range || typeof r.text !== "string") return [];
      try {
        return [{ ...range, text: r.text, path: r.path == null ? defaultPath : resolve(r.path) }];
      } catch {
        return [];
      }
    });
}

function toCommand(
  raw: unknown,
  input: unknown,
  ownCommand: (id: string) => boolean,
): ProviderCommand | undefined {
  if (typeof raw !== "string" || !ownCommand(raw)) return undefined;
  return { id: raw, ...(input !== undefined && { input }) };
}

export function normalizeCodeActions(
  raw: unknown,
  resolve: PathResolver,
  defaultPath: string,
  ownCommand: (id: string) => boolean,
): CodeActionEntry[] {
  return list(raw)
    .slice(0, PROVIDER_LIMITS.actions)
    .flatMap((item): CodeActionEntry[] => {
      const r = record(item);
      const title = str(r.title, 200);
      if (!title) return [];
      const edits =
        r.edits !== undefined ? normalizeFileEdits(r.edits, resolve, defaultPath) : undefined;
      const command = toCommand(r.command, r.input, ownCommand);
      const resolveId = str(r.resolveId, 100);
      // An action that does nothing isn't offered (one resolved later may get its edits then).
      if (!edits?.length && !command && !resolveId) return [];
      const kind = str(r.kind, 100);
      return [
        {
          title,
          ...(kind && /^[\w.-]+$/.test(kind) && { kind }),
          ...(r.isPreferred === true && { isPreferred: true }),
          ...(edits?.length && { edits }),
          ...(command && { command }),
          ...(resolveId && { resolveId }),
        },
      ];
    });
}

/** A resolved code action's edits (only `edits` is taken from it, as VS Code takes only `edit`). */
export function normalizeResolvedEdits(
  raw: unknown,
  resolve: PathResolver,
  defaultPath: string,
): ProviderFileEdit[] {
  const edits = record(raw).edits;
  return edits === undefined ? [] : normalizeFileEdits(edits, resolve, defaultPath);
}

/**
 * A prepared rename: a range (`{ range, placeholder }` or the range's own fields, as VS Code takes
 * a Range or `{ range, placeholder }`), or null for "no answer" (the word at the position is used).
 */
export function normalizeRenameLocation(raw: unknown): RenameLocationEntry | null {
  if (raw == null) return null;
  const r = record(raw);
  const range = toTextRange(r.range ?? raw);
  if (!range) return null;
  const placeholder = str(r.placeholder, 500);
  return { range, ...(placeholder !== undefined && { placeholder }) };
}

export function normalizeSignatureHelp(raw: unknown): SignatureHelpEntry | null {
  const r = record(raw);
  const signatures = list(r.signatures)
    .slice(0, PROVIDER_LIMITS.signatures)
    .flatMap((s): SignatureEntry[] => {
      const sig = record(s);
      const label = str(sig.label, 2000);
      if (!label) return [];
      const documentation = str(sig.documentation, PROVIDER_LIMITS.text);
      const parameters = list(sig.parameters)
        .slice(0, 100)
        .flatMap((p): SignatureParameter[] => {
          const param = typeof p === "string" ? { label: p } : record(p);
          const doc = str(param.documentation, PROVIDER_LIMITS.text);
          const pl = param.label;
          let paramLabel: SignatureParameter["label"] | undefined;
          if (typeof pl === "string" && pl) paramLabel = pl.slice(0, 500);
          else if (Array.isArray(pl) && pl.length === 2) {
            const start = int(pl[0]);
            const end = int(pl[1]);
            if (start !== undefined && end !== undefined && 0 <= start && start <= end)
              paramLabel = [start, Math.min(end, label.length)];
          }
          return paramLabel === undefined
            ? []
            : [{ label: paramLabel, ...(doc && { documentation: doc }) }];
        });
      return [{ label, ...(documentation && { documentation }), parameters }];
    });
  if (!signatures.length) return null;
  const clamp = (v: unknown, max: number) => Math.min(Math.max(0, int(v) ?? 0), Math.max(0, max));
  const activeSignature = clamp(r.activeSignature, signatures.length - 1);
  return {
    signatures,
    activeSignature,
    activeParameter: clamp(r.activeParameter, 99),
  };
}

export function normalizeSymbols(raw: unknown): SymbolEntry[] {
  let budget: number = PROVIDER_LIMITS.symbols;
  const walk = (items: unknown, depth: number): SymbolEntry[] =>
    list(items).flatMap((item): SymbolEntry[] => {
      if (budget <= 0 || depth > 20) return [];
      const r = record(item);
      const name = str(r.name, 500);
      const range = toTextRange(r.range ?? item);
      if (!name || !range) return [];
      budget--;
      const kind = SYMBOL_KINDS.includes(r.kind as SymbolKindName)
        ? (r.kind as SymbolKindName)
        : "variable";
      return [
        {
          name,
          detail: str(r.detail, 500) ?? "",
          kind,
          range,
          selectionRange: toTextRange(r.selectionRange) ?? { startLine: range.startLine },
          children: walk(r.children, depth + 1),
        },
      ];
    });
  return walk(raw, 0);
}

export function normalizeCodeLenses(
  raw: unknown,
  ownCommand: (id: string) => boolean,
): CodeLensEntry[] {
  return list(raw)
    .slice(0, PROVIDER_LIMITS.lenses)
    .flatMap((item): CodeLensEntry[] => {
      const r = record(item);
      const range = toTextRange(r.range ?? item);
      const title = str(r.title, 200);
      if (!range || !title) return [];
      const command = toCommand(r.command, r.input, ownCommand);
      return [{ range, title, ...(command && { command }) }];
    });
}

/**
 * Inlay hints. Parts' locations may be anywhere a definition may (`resolve`: read-only places);
 * their commands must be the extension's own.
 */
export function normalizeInlayHints(
  raw: unknown,
  resolve: PathResolver = () => {
    throw new Error("no paths");
  },
  ownCommand: (id: string) => boolean = () => false,
): InlayHintEntry[] {
  return list(raw)
    .slice(0, PROVIDER_LIMITS.hints)
    .flatMap((item): InlayHintEntry[] => {
      const hint = normalizeInlayHint(item, resolve, ownCommand);
      return hint ? [hint] : [];
    });
}

/** One inlay hint, or null (also what resolveInlayHint answers). */
export function normalizeInlayHint(
  item: unknown,
  resolve: PathResolver,
  ownCommand: (id: string) => boolean,
): InlayHintEntry | null {
  const r = record(item);
  const line = int(r.line);
  const column = int(r.column);
  if (!line || line < 1 || !column || column < 1) return null;
  let label: string | InlayHintPartEntry[] | undefined;
  if (Array.isArray(r.label)) {
    const parts = r.label.slice(0, 50).flatMap((p): InlayHintPartEntry[] => {
      const part = record(p);
      const value = str(part.value, 200);
      if (!value) return [];
      const tooltip = str(part.tooltip, 2000);
      const location = part.location ? normalizeLocations(part.location, resolve)[0] : undefined;
      const command = toCommand(part.command, part.input, ownCommand);
      return [
        {
          value,
          ...(tooltip && { tooltip }),
          ...(location && { location }),
          ...(command && { command }),
        },
      ];
    });
    if (parts.length) label = parts;
  } else label = str(r.label, 200);
  if (!label) return null;
  const tooltip = str(r.tooltip, 2000);
  const textEdits = r.textEdits === undefined ? [] : normalizeTextEdits(r.textEdits).slice(0, 20);
  const resolveId = str(r.resolveId, 100);
  return {
    line,
    column,
    label,
    ...((r.kind === "type" || r.kind === "parameter") && { kind: r.kind }),
    ...(tooltip && { tooltip }),
    ...(r.paddingLeft === true && { paddingLeft: true }),
    ...(r.paddingRight === true && { paddingRight: true }),
    ...(textEdits.length && { textEdits }),
    ...(resolveId && { resolveId }),
  };
}

/** The debugger's inline values from an extension (VS Code's InlineValuesProvider). */
export function normalizeInlineValues(raw: unknown): InlineValueEntry[] {
  return list(raw)
    .slice(0, 1000)
    .flatMap((item): InlineValueEntry[] => {
      const r = record(item);
      const range = toTextRange(r.range ?? item);
      if (!range) return [];
      if (r.kind === "text") {
        const text = str(r.text, 500);
        return text ? [{ kind: "text", range, text }] : [];
      }
      if (r.kind === "variable") {
        const name = str(r.name, 200);
        return [
          {
            kind: "variable",
            range,
            ...(name && { name }),
            caseSensitive: r.caseSensitive !== false,
          },
        ];
      }
      if (r.kind === "expression") {
        const expression = str(r.expression, 1000);
        return [{ kind: "expression", range, ...(expression && { expression }) }];
      }
      return [];
    });
}

/** The legend from the registration: names only, no duplicates. */
export function normalizeLegend(raw: unknown): SemanticTokensLegend {
  const r = record(raw);
  const names = (v: unknown, max: number) =>
    [
      ...new Set(
        list(v).filter((n): n is string => typeof n === "string" && /^[\w.-]{1,60}$/.test(n)),
      ),
    ].slice(0, max);
  // Modifiers are a bit set in a 32-bit number.
  return { tokenTypes: names(r.tokenTypes, 256), tokenModifiers: names(r.tokenModifiers, 32) };
}

/**
 * The extension's tokens (1-based line and column, a type name from the legend) in the editor's
 * encoding (LSP's: five numbers per token, line and start relative to the previous one, 0-based).
 * Tokens of unknown types, overlapping or spanning lines aren't kept.
 */
export function encodeSemanticTokens(raw: unknown, legend: SemanticTokensLegend): number[] {
  const types = new Map(legend.tokenTypes.map((t, i) => [t, i]));
  const modifiers = new Map(legend.tokenModifiers.map((m, i) => [m, 1 << i]));
  const tokens = list(raw)
    .slice(0, PROVIDER_LIMITS.tokens)
    .flatMap((item) => {
      const r = record(item);
      const line = int(r.line);
      const column = int(r.column);
      const length = int(r.length);
      const type = typeof r.type === "string" ? types.get(r.type) : undefined;
      if (!line || line < 1 || !column || column < 1 || !length || length < 1) return [];
      if (type === undefined) return [];
      let bits = 0;
      for (const m of list(r.modifiers)) if (typeof m === "string") bits |= modifiers.get(m) ?? 0;
      return [{ line: line - 1, start: column - 1, length, type, bits }];
    })
    .sort((a, b) => a.line - b.line || a.start - b.start);
  const data: number[] = [];
  let prevLine = 0;
  let prevStart = 0;
  let prevEnd = -1;
  for (const t of tokens) {
    if (t.line === prevLine && t.start < prevEnd) continue;
    const deltaLine = t.line - prevLine;
    data.push(deltaLine, deltaLine ? t.start : t.start - prevStart, t.length, t.type, t.bits);
    prevLine = t.line;
    prevStart = t.start;
    prevEnd = t.start + t.length;
  }
  return data;
}

/**
 * A range as the editor wants it, given each line's length (`lineLength(n)`, without its line
 * break) and the line count: lines and columns clamped; no columns means whole lines (the first
 * line's start through the last line's end).
 */
export function resolveRange(
  range: TextRange,
  lineCount: number,
  lineLength: (line: number) => number,
): FullRange {
  const startLine = Math.min(Math.max(1, range.startLine), lineCount);
  const endLine = Math.min(Math.max(startLine, range.endLine ?? startLine), lineCount);
  const whole = range.startColumn === undefined && range.endColumn === undefined;
  const startColumn = whole
    ? 1
    : Math.min(Math.max(1, range.startColumn ?? 1), lineLength(startLine) + 1);
  const endColumn =
    whole || range.endColumn === undefined
      ? lineLength(endLine) + 1
      : Math.min(Math.max(1, range.endColumn), lineLength(endLine) + 1);
  return {
    startLine,
    startColumn,
    endLine,
    endColumn: endLine === startLine ? Math.max(startColumn, endColumn) : endColumn,
  };
}

/** The provider kinds an extension can register (`languages.register`'s `feature`). */
export const PROVIDER_FEATURES = [
  "definition",
  "references",
  "formatting",
  "rangeFormatting",
  "codeActions",
  "rename",
  "signatureHelp",
  "documentSymbols",
  "codeLens",
  "inlayHints",
  "semanticTokens",
  // D234: the rest of VS Code's common language providers.
  "typeDefinition",
  "implementation",
  "declaration",
  "documentHighlights",
  "foldingRanges",
  "documentLinks",
  "colors",
  "onTypeFormatting",
  "inlineCompletions",
  "workspaceSymbols",
  // D255: VS Code's linked editing, selection range, call and type hierarchy and evaluatable
  // expression providers.
  "linkedEditingRanges",
  "selectionRanges",
  "callHierarchy",
  "typeHierarchy",
  "evaluatableExpressions",
  // The debugger's inline values (VS Code's InlineValuesProvider).
  "inlineValues",
] as const;

export type ProviderFeature = (typeof PROVIDER_FEATURES)[number];

/**
 * Features whose answers change files by themselves (they need "fs.write"). Completions, inline
 * completions and color picks change text only when the user accepts them, as typing would.
 */
export const EDITING_FEATURES: readonly ProviderFeature[] = [
  "formatting",
  "rangeFormatting",
  "codeActions",
  "rename",
  "onTypeFormatting",
];

// ---- D234: highlights, folding, links, colors, inline completions, workspace symbols --------

/** VS Code's DocumentHighlight: the symbol's other uses in the file (read / write accesses). */
export interface HighlightEntry {
  range: TextRange;
  kind: "text" | "read" | "write";
}

/** VS Code's FoldingRange (1-based lines; the lines after the start one fold under it). */
export interface FoldingEntry {
  startLine: number;
  endLine: number;
  kind?: "comment" | "imports" | "region";
}

/** Where a document link goes: a web address (opened by the system) or a file of the folder. */
export type LinkTarget = { url: string } | { path: string; line?: number; column?: number };

export interface LinkEntry {
  range: TextRange;
  target: LinkTarget;
  tooltip?: string;
}

/** A color, each part 0..1 (VS Code's Color). */
export interface ColorValue {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

export interface ColorEntry {
  range: TextRange;
  color: ColorValue;
}

/** How a picked color is written (VS Code's ColorPresentation): `label`, or `edit` instead. */
export interface ColorPresentationEntry {
  label: string;
  edit?: ProviderTextEdit;
}

/** Ghost text (VS Code's InlineCompletionItem); `range` default: the cursor's position. */
export interface InlineCompletionEntry {
  insertText: string;
  range?: TextRange;
  /** One of the extension's own commands, run when it's accepted. */
  command?: ProviderCommand;
}

/** A symbol anywhere in the folder (Go to symbol in workspace, Ctrl+T). */
export interface WorkspaceSymbolEntry {
  name: string;
  kind: SymbolKindName;
  path: string;
  line: number;
  column: number;
  container?: string;
}

export function normalizeHighlights(raw: unknown): HighlightEntry[] {
  return list(raw)
    .slice(0, PROVIDER_LIMITS.locations)
    .flatMap((item): HighlightEntry[] => {
      const r = record(item);
      const range = toTextRange(r.range ?? item);
      if (!range) return [];
      const kind = r.kind === "read" || r.kind === "write" ? r.kind : "text";
      return [{ range, kind }];
    });
}

export function normalizeFoldingRanges(raw: unknown): FoldingEntry[] {
  return list(raw)
    .slice(0, PROVIDER_LIMITS.symbols)
    .flatMap((item): FoldingEntry[] => {
      const r = record(item);
      const startLine = int(r.startLine ?? r.start);
      const endLine = int(r.endLine ?? r.end);
      // A fold hides the lines below its first: a single line folds nothing.
      if (!startLine || startLine < 1 || !endLine || endLine <= startLine) return [];
      const kind =
        r.kind === "comment" || r.kind === "imports" || r.kind === "region" ? r.kind : undefined;
      return [{ startLine, endLine, ...(kind && { kind }) }];
    });
}

/** Web addresses a link may open (never `javascript:`, `file:` or `command:` links). */
const WEB_LINK = /^(https?:\/\/\S+|mailto:\S+)$/i;

export function normalizeDocumentLinks(raw: unknown, resolve: PathResolver): LinkEntry[] {
  return list(raw)
    .slice(0, PROVIDER_LIMITS.hints)
    .flatMap((item): LinkEntry[] => {
      const r = record(item);
      const range = toTextRange(r.range ?? item);
      if (!range) return [];
      const tooltip = str(r.tooltip, 300);
      const extra = tooltip ? { tooltip } : {};
      const target = r.target ?? r.url;
      if (typeof target === "string" && WEB_LINK.test(target) && target.length <= 2000)
        return [{ range, target: { url: target }, ...extra }];
      const path = typeof target === "string" ? target : r.path;
      if (typeof path !== "string" || !path) return [];
      try {
        const line = int(r.line);
        const column = int(r.column);
        return [
          {
            range,
            target: {
              path: resolve(path),
              ...(line !== undefined && line >= 1 && { line }),
              ...(column !== undefined && column >= 1 && { column }),
            },
            ...extra,
          },
        ];
      } catch {
        return [];
      }
    });
}

const unit = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;

/** A color from the extension: { red, green, blue, alpha } (0..1), or null. */
export function toColor(raw: unknown): ColorValue | null {
  const c = record(raw);
  if (typeof c.red !== "number" || typeof c.green !== "number" || typeof c.blue !== "number")
    return null;
  return {
    red: unit(c.red, 0),
    green: unit(c.green, 0),
    blue: unit(c.blue, 0),
    alpha: unit(c.alpha, 1),
  };
}

export function normalizeColors(raw: unknown): ColorEntry[] {
  return list(raw)
    .slice(0, PROVIDER_LIMITS.hints)
    .flatMap((item): ColorEntry[] => {
      const r = record(item);
      const range = toTextRange(r.range ?? item);
      const color = toColor(r.color);
      return range && color ? [{ range, color }] : [];
    });
}

export function normalizeColorPresentations(raw: unknown): ColorPresentationEntry[] {
  return list(raw)
    .slice(0, 20)
    .flatMap((item): ColorPresentationEntry[] => {
      const r = typeof item === "string" ? { label: item } : record(item);
      const label = str(r.label, 200);
      if (!label) return [];
      const edit = r.edit !== undefined ? normalizeTextEdits(r.edit)[0] : undefined;
      return [{ label, ...(edit && { edit }) }];
    });
}

/** Hex digits, "rrggbb" or "rrggbbaa" when not opaque: the picker's default presentation. */
export function colorHexDigits(color: ColorValue): string {
  const part = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  return `${part(color.red)}${part(color.green)}${part(color.blue)}${color.alpha < 1 ? part(color.alpha) : ""}`;
}

export function normalizeInlineCompletions(
  raw: unknown,
  ownCommand: (id: string) => boolean,
): InlineCompletionEntry[] {
  // VS Code's provider answers a list or { items }.
  const items = Array.isArray(raw) ? raw : record(raw).items;
  return list(items)
    .slice(0, 20)
    .flatMap((item): InlineCompletionEntry[] => {
      const r = typeof item === "string" ? { insertText: item } : record(item);
      const insertText = str(r.insertText ?? r.text, PROVIDER_LIMITS.text);
      if (!insertText) return [];
      const range = r.range !== undefined ? toTextRange(r.range) : null;
      const command = toCommand(r.command, r.input, ownCommand);
      return [{ insertText, ...(range && { range }), ...(command && { command }) }];
    });
}

export function normalizeWorkspaceSymbols(
  raw: unknown,
  resolve: PathResolver,
): WorkspaceSymbolEntry[] {
  return list(raw)
    .slice(0, PROVIDER_LIMITS.locations)
    .flatMap((item): WorkspaceSymbolEntry[] => {
      const r = record(item);
      const name = str(r.name, 500);
      const range = toTextRange(r.range ?? item);
      if (!name || !range) return [];
      try {
        const kind = SYMBOL_KINDS.includes(r.kind as SymbolKindName)
          ? (r.kind as SymbolKindName)
          : "variable";
        const container = str(r.container ?? r.containerName, 200);
        return [
          {
            name,
            kind,
            path: resolve(r.path),
            line: range.startLine,
            column: range.startColumn ?? 1,
            ...(container && { container }),
          },
        ];
      } catch {
        return [];
      }
    });
}

// ---- D255: linked editing, selection ranges, call and type hierarchies, evaluatable expressions

/** VS Code's LinkedEditingRanges: ranges edited together (an HTML tag's name at both ends). */
export interface LinkedEditingEntry {
  ranges: TextRange[];
  /** A regular expression (source) for what may be typed in them. */
  wordPattern?: string;
}

export function normalizeLinkedEditing(raw: unknown): LinkedEditingEntry | null {
  const r = record(raw);
  const ranges = list(Array.isArray(raw) ? raw : r.ranges)
    .slice(0, 100)
    .flatMap((item) => {
      const range = toTextRange(item);
      return range ? [range] : [];
    });
  if (ranges.length < 2) return null;
  const pattern = str(r.wordPattern, 500);
  if (pattern) {
    try {
      new RegExp(pattern);
    } catch {
      return { ranges };
    }
  }
  return { ranges, ...(pattern && { wordPattern: pattern }) };
}

/**
 * Selection ranges (VS Code's SelectionRangeProvider, Expand selection): for each position asked
 * about, the ranges from the innermost out. An answer may be VS Code's `{ range, parent }` chain
 * or a list of ranges.
 */
export function normalizeSelectionRanges(raw: unknown, positions: number): TextRange[][] {
  return list(raw)
    .slice(0, positions)
    .map((item) => {
      const chain: TextRange[] = [];
      if (Array.isArray(item)) {
        for (const r of item.slice(0, 50)) {
          const range = toTextRange(r);
          if (range) chain.push(range);
        }
        return chain;
      }
      let at: unknown = item;
      while (at && chain.length < 50) {
        const r = record(at);
        const range = toTextRange(r.range ?? at);
        if (!range) break;
        chain.push(range);
        at = r.parent;
      }
      return chain;
    });
}

/** An item of a call or type hierarchy (VS Code's CallHierarchyItem / TypeHierarchyItem). */
export interface HierarchyItemEntry {
  name: string;
  kind: SymbolKindName;
  detail?: string;
  path: string;
  range: TextRange;
  /** Where its name is (default: the range). */
  selectionRange: TextRange;
  /** The extension's own data for the item, given back when it's asked about the item. */
  data?: unknown;
}

/** A call into or out of an item, and where in the caller the calls are. */
export interface HierarchyCallEntry {
  item: HierarchyItemEntry;
  fromRanges: TextRange[];
}

const jsonSafe = (v: unknown): unknown => {
  try {
    const text = JSON.stringify(v);
    return text === undefined || text.length > 10_000 ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
};

export function normalizeHierarchyItems(raw: unknown, resolve: PathResolver): HierarchyItemEntry[] {
  return list(raw)
    .slice(0, PROVIDER_LIMITS.symbols)
    .flatMap((item): HierarchyItemEntry[] => {
      const r = record(item);
      const name = str(r.name, 500);
      const range = toTextRange(r.range ?? item);
      if (!name || !range) return [];
      let path: string;
      try {
        path = resolve(r.path);
      } catch {
        return [];
      }
      const kind = SYMBOL_KINDS.includes(r.kind as SymbolKindName)
        ? (r.kind as SymbolKindName)
        : "function";
      const detail = str(r.detail, 500);
      const data = r.data === undefined ? undefined : jsonSafe(r.data);
      return [
        {
          name,
          kind,
          path,
          range,
          selectionRange: toTextRange(r.selectionRange) ?? range,
          ...(detail && { detail }),
          ...(data !== undefined && { data }),
        },
      ];
    });
}

/** Incoming (`from`) or outgoing (`to`) calls. */
export function normalizeHierarchyCalls(
  raw: unknown,
  resolve: PathResolver,
  key: "from" | "to",
): HierarchyCallEntry[] {
  return list(raw)
    .slice(0, PROVIDER_LIMITS.locations)
    .flatMap((call): HierarchyCallEntry[] => {
      const r = record(call);
      const [item] = normalizeHierarchyItems(r[key], resolve);
      if (!item) return [];
      const fromRanges = list(r.fromRanges)
        .slice(0, 100)
        .flatMap((x) => {
          const range = toTextRange(x);
          return range ? [range] : [];
        });
      return [{ item, fromRanges }];
    });
}

/** VS Code's EvaluatableExpression: what the debugger shows the value of under the pointer. */
export interface EvaluatableEntry {
  range: TextRange;
  /** What's evaluated (default: the text in the range). */
  expression?: string;
}

export function normalizeEvaluatable(raw: unknown): EvaluatableEntry | null {
  if (raw == null) return null;
  const r = record(raw);
  const range = toTextRange(r.range ?? raw);
  if (!range) return null;
  const expression = str(r.expression, 1000);
  return { range, ...(expression && { expression }) };
}

/**
 * The notebook and cell of a cell's editor document (`<notebook>.cell-<id>.<ext>`, the notebook
 * editor's name for it), or null for any other path.
 */
export function cellOfPath(path: string): { notebook: string; id: string } | null {
  const m = /^(.+)\.cell-([A-Za-z0-9_-]+)\.[A-Za-z0-9]+$/.exec(path);
  return m?.[1] && m[2] ? { notebook: m[1], id: m[2] } : null;
}

/**
 * Completions an extension answers with, at most this many: VS Code has no limit (its list
 * filters what's typed); this only bounds a runaway answer.
 */
export const MAX_COMPLETIONS = 10_000;

const COMPLETION_KIND_SET: ReadonlySet<string> = new Set(COMPLETION_KINDS);

/**
 * One completion item (also what resolveCompletionItem answers, `partial`: no label needed).
 * Commands must be the extension's own, or the editor's triggerSuggest / triggerParameterHints.
 */
export function normalizeCompletionItem(
  raw: unknown,
  ownCommand: (id: string) => boolean,
  partial = false,
): Partial<CompletionEntry> | null {
  const r = record(raw);
  const label = str(r.label, 1000);
  if (!label && !partial) return null;
  const text = (k: string, max: number) => str(r[k], max);
  const range = r.range === undefined ? null : toTextRange(r.range);
  const replaceRange = r.replaceRange === undefined ? null : toTextRange(r.replaceRange);
  const commit = list(r.commitCharacters)
    .filter((c): c is string => typeof c === "string" && c.length === 1)
    .slice(0, 20);
  const extra =
    r.additionalTextEdits === undefined ? [] : normalizeTextEdits(r.additionalTextEdits);
  const commandId = typeof r.command === "string" ? r.command : undefined;
  const command =
    commandId &&
    ((COMPLETION_EDITOR_COMMANDS as readonly string[]).includes(commandId) || ownCommand(commandId))
      ? { id: commandId, ...(r.input !== undefined && { input: r.input }) }
      : undefined;
  const insertText = text("insertText", PROVIDER_LIMITS.text);
  const detail = text("detail", 1000);
  const documentation = text("documentation", PROVIDER_LIMITS.text);
  const sortText = text("sortText", 1000);
  const filterText = text("filterText", 1000);
  const resolveId = text("resolveId", 100);
  const labelDetail = text("labelDetail", 1000);
  const labelDescription = text("labelDescription", 1000);
  return {
    ...(label && { label }),
    ...(labelDetail && { labelDetail }),
    ...(labelDescription && { labelDescription }),
    ...(insertText !== undefined && { insertText }),
    ...(r.snippet === true && { snippet: true }),
    ...(detail && { detail }),
    ...(documentation && { documentation }),
    ...(typeof r.kind === "string" &&
      COMPLETION_KIND_SET.has(r.kind) && {
        kind: r.kind as CompletionEntry["kind"],
      }),
    ...(r.deprecated === true && { deprecated: true }),
    ...(range && { range }),
    ...(replaceRange && { replaceRange }),
    ...(sortText !== undefined && { sortText }),
    ...(filterText !== undefined && { filterText }),
    ...(r.preselect === true && { preselect: true }),
    ...(commit.length && { commitCharacters: commit }),
    ...(extra.length && { additionalTextEdits: extra.slice(0, 50) }),
    ...(command && { command }),
    ...(resolveId && { resolveId }),
  };
}

/** A completion provider's answer: a list of items, or `{ items, isIncomplete }`. */
export function normalizeCompletions(
  raw: unknown,
  ownCommand: (id: string) => boolean,
): CompletionResult {
  const r = record(raw);
  const items = Array.isArray(raw) ? raw : Array.isArray(r.items) ? r.items : [];
  return {
    items: items.slice(0, MAX_COMPLETIONS).flatMap((i) => {
      const item = normalizeCompletionItem(i, ownCommand);
      return item?.label ? [item as CompletionEntry] : [];
    }),
    ...(!Array.isArray(raw) && r.isIncomplete === true && { isIncomplete: true }),
  };
}
