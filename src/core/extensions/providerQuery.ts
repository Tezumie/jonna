// What an extension asks of every language provider the editor has (VS Code's
// `vscode.execute…Provider` commands): the query the worker sends (`ide.languages.execute`) and
// the answers the editor gives, from its language servers, its own language services and every
// extension's providers together, in the IDE's 1-based shapes (end columns exclusive). The host
// checks a query (`checkProviderQuery`) before the editor runs it. DOM-free and unit-tested.

/** Asked at a position of a document. */
export const POSITION_QUERIES = [
  "definition",
  "typeDefinition",
  "declaration",
  "implementation",
  "references",
  "hover",
  "documentHighlights",
  "signatureHelp",
  "completion",
  "prepareRename",
  "rename",
  "formatOnType",
] as const;

/** Asked about a whole document. */
export const DOCUMENT_QUERIES = [
  "documentSymbols",
  "foldingRanges",
  "links",
  "codeLens",
  "documentColors",
  "formatDocument",
] as const;

/** Asked about a range of a document. */
export const RANGE_QUERIES = ["codeActions", "formatRange", "inlayHints"] as const;

export type ProviderQueryKind =
  | (typeof POSITION_QUERIES)[number]
  | (typeof DOCUMENT_QUERIES)[number]
  | (typeof RANGE_QUERIES)[number]
  | "selectionRanges";

/** 1-based; the end column is exclusive. */
export interface QueryRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface QueryPosition {
  line: number;
  column: number;
}

export interface ProviderQuery {
  kind: ProviderQueryKind;
  /** The document: a path, an `untitled:` name, or a URI of an extension's file system. */
  path: string;
  /** Position queries. */
  line?: number;
  column?: number;
  /** Range queries. */
  range?: QueryRange;
  /** selectionRanges: a range around each. */
  positions?: QueryPosition[];
  /** completion, signatureHelp: what was typed. */
  triggerCharacter?: string;
  /** rename. */
  newName?: string;
  /** formatOnType: the character typed. */
  ch?: string;
  /** Formatting options (default: the document's). */
  tabSize?: number;
  insertSpaces?: boolean;
  /** codeActions: only actions of this kind ("quickfix", "source.organizeImports"…). */
  only?: string;
  /** completion, codeActions, codeLens, links: how many items are resolved (details, commands). */
  resolveCount?: number;
}

// ---- Answers ---------------------------------------------------------------------------------

/** A Location, or a LocationLink when the selection ranges are given. */
export interface QueryLocation {
  path: string;
  range: QueryRange;
  targetSelectionRange?: QueryRange;
  originSelectionRange?: QueryRange;
}

export interface QueryHover {
  /** Markdown, one entry per part. */
  contents: string[];
  range?: QueryRange;
}

/** VS Code's SymbolKind numbers (File 0 … TypeParameter 25). */
export interface QuerySymbol {
  name: string;
  detail: string;
  kind: number;
  deprecated?: boolean;
  range: QueryRange;
  selectionRange: QueryRange;
  children: QuerySymbol[];
}

export interface QueryHighlight {
  range: QueryRange;
  /** VS Code's DocumentHighlightKind (Text 0, Read 1, Write 2). */
  kind: number;
}

export interface QueryTextEdit {
  range: QueryRange;
  text: string;
}

export type QueryFileEdit = QueryTextEdit & { path: string };

/**
 * A command of an answer, for its title. Commands the editor registered for a provider (a
 * language server's, another extension's) can't run from an extension: only `title` and the id.
 */
export interface QueryCommand {
  id: string;
  title: string;
}

export interface QueryCodeAction {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  /** Why it can't be applied now. */
  disabled?: string;
  edits?: QueryFileEdit[];
  command?: QueryCommand;
}

export interface QueryCompletionItem {
  label: string;
  /** VS Code's label parts. */
  labelDetail?: string;
  labelDescription?: string;
  /** The IDE's kind names (VS Code's CompletionItemKind by name: "method", "enumMember"…). */
  kind: string;
  detail?: string;
  /** Markdown. */
  documentation?: string;
  insertText: string;
  /** `insertText` is a snippet (`$1`, `${2:name}`). */
  snippet?: boolean;
  filterText?: string;
  sortText?: string;
  preselect?: boolean;
  deprecated?: boolean;
  /** What's replaced; `insert` when inserting replaces less than accepting does. */
  range?: QueryRange;
  insertRange?: QueryRange;
  commitCharacters?: string[];
  additionalTextEdits?: QueryTextEdit[];
}

export interface QueryCompletionList {
  isIncomplete: boolean;
  items: QueryCompletionItem[];
}

export interface QuerySignatureHelp {
  signatures: {
    label: string;
    documentation?: string;
    parameters: { label: string | [number, number]; documentation?: string }[];
    activeParameter?: number;
  }[];
  activeSignature: number;
  activeParameter: number;
}

export interface QueryFoldingRange {
  /** 1-based lines. */
  start: number;
  end: number;
  kind?: "comment" | "imports" | "region";
}

export interface QueryLink {
  range: QueryRange;
  /** A URL or a file's URI as text. */
  target?: string;
  tooltip?: string;
}

export interface QueryInlayHint {
  line: number;
  column: number;
  label: string;
  /** VS Code's InlayHintKind (Type 1, Parameter 2). */
  kind?: number;
  tooltip?: string;
  paddingLeft?: boolean;
  paddingRight?: boolean;
}

export interface QueryCodeLens {
  range: QueryRange;
  command?: QueryCommand;
}

export interface QueryColor {
  range: QueryRange;
  /** 0–1 each. */
  color: { red: number; green: number; blue: number; alpha: number };
}

/** prepareRename: the range renamed and the text the box starts with, or why it can't be. */
export type QueryRenameLocation = { range: QueryRange; text: string } | { rejectReason: string };

/** rename: the edits, or why it can't be. */
export type QueryRenameEdits = { edits: QueryFileEdit[] } | { rejectReason: string };

/** Each kind's answer. */
export interface ProviderQueryAnswers {
  definition: QueryLocation[];
  typeDefinition: QueryLocation[];
  declaration: QueryLocation[];
  implementation: QueryLocation[];
  references: QueryLocation[];
  hover: QueryHover[];
  documentHighlights: QueryHighlight[];
  signatureHelp: QuerySignatureHelp | null;
  completion: QueryCompletionList;
  prepareRename: QueryRenameLocation | null;
  rename: QueryRenameEdits | null;
  formatOnType: QueryTextEdit[];
  documentSymbols: QuerySymbol[];
  foldingRanges: QueryFoldingRange[];
  links: QueryLink[];
  codeLens: QueryCodeLens[];
  documentColors: QueryColor[];
  formatDocument: QueryTextEdit[];
  codeActions: QueryCodeAction[];
  formatRange: QueryTextEdit[];
  inlayHints: QueryInlayHint[];
  /** For each position, its ranges from the innermost out. */
  selectionRanges: QueryRange[][];
}

// ---- Checking a query ------------------------------------------------------------------------

const MAX_POSITIONS = 1000;
const MAX_LINE = 10_000_000;

const isKind = (v: unknown): v is ProviderQueryKind =>
  typeof v === "string" &&
  ((POSITION_QUERIES as readonly string[]).includes(v) ||
    (DOCUMENT_QUERIES as readonly string[]).includes(v) ||
    (RANGE_QUERIES as readonly string[]).includes(v) ||
    v === "selectionRanges");

function whole(v: unknown, what: string, min = 1, max = MAX_LINE): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    throw new Error(`${what} must be a whole number from ${min} to ${max}.`);
  return v;
}

function text(v: unknown, what: string, max: number): string {
  if (typeof v !== "string" || v.length > max)
    throw new Error(`${what} must be text (${max} characters at most).`);
  return v;
}

function position(v: unknown): QueryPosition {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return { line: whole(o.line, "line"), column: whole(o.column, "column") };
}

function range(v: unknown): QueryRange {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const r = {
    startLine: whole(o.startLine, "range.startLine"),
    startColumn: whole(o.startColumn, "range.startColumn"),
    endLine: whole(o.endLine, "range.endLine"),
    endColumn: whole(o.endColumn, "range.endColumn"),
  };
  if (r.endLine < r.startLine || (r.endLine === r.startLine && r.endColumn < r.startColumn))
    throw new Error("The range ends before it starts.");
  return r;
}

/** A query from an extension, checked (what it doesn't need is dropped); throws when it's wrong. */
export function checkProviderQuery(raw: unknown): ProviderQuery {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (!isKind(o.kind)) throw new Error(`Unknown provider query: ${String(o.kind)}.`);
  const kind = o.kind;
  const path = text(o.path, "path", 4096);
  if (!path) throw new Error("A provider query needs the document's path.");
  const out: ProviderQuery = { kind, path };
  if ((POSITION_QUERIES as readonly string[]).includes(kind)) {
    const at = position(o);
    out.line = at.line;
    out.column = at.column;
  }
  if ((RANGE_QUERIES as readonly string[]).includes(kind)) out.range = range(o.range);
  if (kind === "selectionRanges") {
    if (!Array.isArray(o.positions) || o.positions.length > MAX_POSITIONS)
      throw new Error(`positions must be a list (${MAX_POSITIONS} at most).`);
    out.positions = o.positions.map(position);
  }
  if ((kind === "completion" || kind === "signatureHelp") && o.triggerCharacter)
    out.triggerCharacter = text(o.triggerCharacter, "triggerCharacter", 8);
  if (kind === "rename") {
    out.newName = text(o.newName, "newName", 1000);
    if (!out.newName) throw new Error("rename needs the new name.");
  }
  if (kind === "formatOnType") {
    out.ch = text(o.ch, "ch", 8);
    if (!out.ch) throw new Error("formatOnType needs the character typed.");
  }
  if (kind === "formatDocument" || kind === "formatRange" || kind === "formatOnType") {
    if (o.tabSize !== undefined) out.tabSize = whole(o.tabSize, "tabSize", 1, 32);
    if (typeof o.insertSpaces === "boolean") out.insertSpaces = o.insertSpaces;
  }
  if (kind === "codeActions" && o.only !== undefined && o.only !== "")
    out.only = text(o.only, "only", 200);
  if (o.resolveCount !== undefined)
    out.resolveCount = whole(o.resolveCount, "resolveCount", 0, 1000);
  return out;
}
