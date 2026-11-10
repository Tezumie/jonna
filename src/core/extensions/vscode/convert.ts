// Between VS Code's shapes and the IDE's (D256): 0-based Positions and Ranges ↔ 1-based lines and
// columns (end column exclusive in both), Uris ↔ paths, Markdown, edits, locations, symbols and
// diagnostics. DOM-free and unit-tested.

import type { TextRange } from "../rpc";
import type * as Ide from "../rpcLanguages";
import {
  type Command,
  type CompletionItemKind,
  InlayHintKind,
  type MarkedString,
  SymbolKind,
  type CompletionItem as VsCompletionItem,
  type InlayHint as VsInlayHint,
} from "./languageTypes";
import {
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticTag,
  MarkdownString,
  Position,
  Range,
  SnippetString,
  type TextEdit,
  Uri,
  type WorkspaceEdit,
} from "./types";

/** The IDE's range shape (1-based; end column exclusive). */
export interface IdeRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface IdeTextRange {
  startLine: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

export function toPosition(line: number, column: number): Position {
  return new Position(Math.max(0, line - 1), Math.max(0, column - 1));
}

export function fromPosition(p: Position): { line: number; column: number } {
  return { line: p.line + 1, column: p.character + 1 };
}

/** The IDE's range as VS Code's; no columns means whole lines (through the end line's break). */
export function toRange(r: IdeTextRange): Range {
  const endLine = r.endLine ?? r.startLine;
  if (r.startColumn === undefined) return new Range(r.startLine - 1, 0, endLine, 0);
  return new Range(
    Math.max(0, r.startLine - 1),
    Math.max(0, r.startColumn - 1),
    Math.max(0, endLine - 1),
    Math.max(0, (r.endColumn ?? r.startColumn) - 1),
  );
}

export function fromRange(r: Range | Position): IdeRange {
  const range =
    r instanceof Range || Range.isRange(r) ? r : new Range(r as Position, r as Position);
  return {
    startLine: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

const SCHEME = /^[a-zA-Z][\w+.-]+:/;

/** A file's Uri for an IDE path (absolute), or a "<scheme>:/…" one for a provider's file. */
export function uriOf(path: string): Uri {
  return SCHEME.test(path) && !/^[a-zA-Z]:[\\/]/.test(path) ? Uri.parse(path) : Uri.file(path);
}

/** The IDE's path for a Uri: a file's path on disk, else the Uri as text. */
export function pathOf(uri: Uri | string): string {
  const u = typeof uri === "string" ? uriOf(uri) : uri;
  return u.scheme === "file" ? u.fsPath : u.toString(true);
}

/** Markdown text of VS Code's hover and documentation shapes. */
export function markdownOf(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(markdownOf).filter(Boolean).join("\n\n");
  if (v instanceof MarkdownString) return v.value;
  const o = v as { language?: unknown; value?: unknown };
  if (typeof o.value === "string")
    return typeof o.language === "string" ? `\`\`\`${o.language}\n${o.value}\n\`\`\`` : o.value;
  return "";
}

export function fromTextEdit(e: TextEdit): TextRange & { text: string } {
  return { ...fromRange(e.range), text: e.newText };
}

/** A WorkspaceEdit's text edits as the IDE's file edits (file operations aren't part of them). */
export function fromWorkspaceEditText(
  edit: WorkspaceEdit,
): (IdeRange & { text: string; path: string })[] {
  return edit
    .entries()
    .flatMap(([uri, edits]) =>
      edits.map((e) => ({ ...fromRange(e.range), text: e.newText, path: pathOf(uri) })),
    );
}

/** A Location or LocationLink as the IDE's location (the link's target selection when given). */
export function fromLocation(v: unknown): (IdeRange & { path: string }) | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as {
    uri?: Uri;
    range?: Range;
    targetUri?: Uri;
    targetRange?: Range;
    targetSelectionRange?: Range;
  };
  if (o.targetUri) {
    const range = o.targetSelectionRange ?? o.targetRange;
    return range ? { path: pathOf(o.targetUri), ...fromRange(range) } : undefined;
  }
  if (o.uri && o.range) return { path: pathOf(o.uri), ...fromRange(o.range) };
  return undefined;
}

export function fromLocations(v: unknown): (IdeRange & { path: string })[] {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return list.map(fromLocation).filter((l): l is IdeRange & { path: string } => !!l);
}

/** By DiagnosticSeverity (Error 0 … Hint 3): a Hint stays a hint (faint, not in Problems). */
const SEVERITY_NAMES = ["error", "warning", "info", "hint"] as const;

export function codeOf(code: Diagnostic["code"]): string | undefined {
  if (code === undefined || code === null) return undefined;
  if (typeof code === "object") return String(code.value);
  return String(code);
}

/** One of VS Code's Diagnostics as the IDE's problem (its source, tags and links kept). */
export function fromDiagnostic(d: Diagnostic): Ide.Diagnostic {
  const r = fromRange(d.range);
  const code = codeOf(d.code);
  const target =
    d.code && typeof d.code === "object" && d.code.target
      ? (d.code.target as Uri).toString(true)
      : undefined;
  const tags = (d.tags ?? []).flatMap((t): ("unnecessary" | "deprecated")[] =>
    t === DiagnosticTag.Unnecessary
      ? ["unnecessary"]
      : t === DiagnosticTag.Deprecated
        ? ["deprecated"]
        : [],
  );
  const related = (d.relatedInformation ?? []).flatMap((info) => {
    const where = info?.location;
    if (!where?.uri || !where.range) return [];
    return [{ ...fromRange(where.range), path: pathOf(where.uri), message: String(info.message) }];
  });
  return {
    line: r.startLine,
    column: r.startColumn,
    endLine: r.endLine,
    endColumn: r.endColumn,
    message: d.message,
    severity: SEVERITY_NAMES[d.severity] ?? "error",
    ...(code && { code }),
    ...(target && { codeTarget: target }),
    ...(d.source && { source: d.source }),
    ...(tags.length && { tags }),
    ...(related.length && { relatedInformation: related }),
  };
}

/** A problem the IDE passes to a code action provider, as VS Code's Diagnostic. */
export function toDiagnostic(
  d: IdeRange & { message: string; severity: string; source?: string; code?: string },
): Diagnostic {
  const severity =
    d.severity === "warning"
      ? DiagnosticSeverity.Warning
      : d.severity === "info"
        ? DiagnosticSeverity.Information
        : d.severity === "hint"
          ? DiagnosticSeverity.Hint
          : DiagnosticSeverity.Error;
  const out = new Diagnostic(toRange(d), d.message, severity);
  if (d.source) out.source = d.source;
  if (d.code) out.code = d.code;
  return out;
}

/** LSP's name of a symbol kind ("class", "enumMember"). */
export function symbolKindName(kind: SymbolKind | undefined): string {
  const name = SymbolKind[kind ?? SymbolKind.Variable] ?? "Variable";
  return name[0]?.toLowerCase() + name.slice(1);
}

type IdeCompletionKind = NonNullable<Ide.CompletionItem["kind"]>;

/** VS Code's CompletionItemKind, by value, as the IDE names it (the same kinds, one icon each). */
const COMPLETION_KIND_NAMES: readonly IdeCompletionKind[] = [
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
];

export function completionKindName(
  kind: CompletionItemKind | undefined,
): IdeCompletionKind | undefined {
  if (kind === undefined) return undefined;
  return COMPLETION_KIND_NAMES[kind] ?? "text";
}

/** The editor's own commands a completion may run after it's inserted (as VS Code runs them). */
const EDITOR_COMPLETION_COMMANDS = [
  "editor.action.triggerSuggest",
  "editor.action.triggerParameterHints",
];

/**
 * A completion item as the IDE's: its label (and label details), what it inserts (a snippet
 * flagged), its kind, documentation, insert and replace ranges, commit characters, edits
 * elsewhere and the command run after it (`commandOf`: the extension's own commands).
 */
export function fromCompletionItem(
  item: VsCompletionItem,
  commandOf: (c: Command) => CommandRef | undefined = () => undefined,
): Ide.CompletionItem {
  const label = typeof item.label === "string" ? item.label : item.label.label;
  const labelDetail = typeof item.label === "object" ? item.label.detail : undefined;
  const labelDescription = typeof item.label === "object" ? item.label.description : undefined;
  const raw = item.textEdit?.newText ?? item.insertText;
  const snippet = raw instanceof SnippetString || SnippetString.isSnippetString(raw);
  const insertText =
    raw === undefined ? undefined : snippet ? (raw as SnippetString).value : String(raw);
  const kind = completionKindName(item.kind);
  const documentation = markdownOf(item.documentation);
  // What it replaces (D261): its range, or an insert/replace pair, or its edit's.
  const r = item.textEdit?.range ?? item.range;
  const pair = r && !(r instanceof Range) && "inserting" in r ? r : undefined;
  const range = pair ? pair.inserting : (r as Range | undefined);
  const extra = (item.additionalTextEdits ?? [])
    .slice(0, 50)
    .map((e) => ({ ...fromRange(e.range), text: e.newText }));
  const commit = (item.commitCharacters ?? []).filter((c) => typeof c === "string" && c.length);
  const command = item.command
    ? EDITOR_COMPLETION_COMMANDS.includes(item.command.command)
      ? { command: item.command.command }
      : commandOf(item.command)
    : undefined;
  return {
    label,
    ...(labelDetail && { labelDetail }),
    ...(labelDescription && { labelDescription }),
    ...(insertText !== undefined && (insertText !== label || snippet) && { insertText }),
    ...(snippet && { snippet: true }),
    ...(item.detail && { detail: item.detail }),
    ...(documentation && { documentation }),
    ...(kind && { kind }),
    ...(item.tags?.includes(1) && { deprecated: true }),
    ...(range && { range: fromRange(range) }),
    ...(pair && { replaceRange: fromRange(pair.replacing) }),
    ...(typeof item.sortText === "string" && { sortText: item.sortText }),
    ...(typeof item.filterText === "string" && { filterText: item.filterText }),
    ...(item.preselect === true && { preselect: true }),
    ...(commit.length && { commitCharacters: commit }),
    ...(extra.length && { additionalTextEdits: extra }),
    ...(command && {
      command: command.command,
      ...(command.input !== undefined && { input: command.input }),
    }),
  };
}

/**
 * An inlay hint as the IDE's: label parts keep where they go (Ctrl+click), their command and
 * tooltip; edits made on double-click; `resolveId` when it's resolved later.
 */
export function fromInlayHint(
  h: VsInlayHint,
  commandOf: (c: Command) => CommandRef | undefined,
  resolveId?: string,
): Ide.InlayHint {
  const tooltip = markdownOf(h.tooltip);
  const label =
    typeof h.label === "string"
      ? h.label
      : (Array.isArray(h.label) ? h.label : []).map((p): Ide.InlayHintLabelPart => {
          const partTooltip = markdownOf(p.tooltip);
          const location = p.location ? fromLocation(p.location) : undefined;
          const command = p.command ? commandOf(p.command) : undefined;
          return {
            value: String(p.value ?? ""),
            ...(partTooltip && { tooltip: partTooltip }),
            ...(location && { location }),
            ...(command && {
              command: command.command,
              ...(command.input !== undefined && { input: command.input }),
            }),
          };
        });
  const edits = (h.textEdits ?? []).map(fromTextEdit);
  return {
    line: h.position.line + 1,
    column: h.position.character + 1,
    label,
    ...(h.kind === InlayHintKind.Type && { kind: "type" as const }),
    ...(h.kind === InlayHintKind.Parameter && { kind: "parameter" as const }),
    ...(tooltip && { tooltip }),
    ...(h.paddingLeft && { paddingLeft: true }),
    ...(h.paddingRight && { paddingRight: true }),
    ...(edits.length && { textEdits: edits }),
    ...(resolveId && { resolveId }),
  };
}

/** One of VS Code's InlineValues (text, a variable to look up, an expression) as the IDE's. */
export function fromInlineValue(v: unknown): Ide.InlineValue | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as {
    range?: Range;
    text?: unknown;
    variableName?: unknown;
    caseSensitiveLookup?: unknown;
    expression?: unknown;
  };
  if (!o.range || !Range.isRange(o.range)) return undefined;
  const range = fromRange(o.range);
  if (typeof o.text === "string") return { kind: "text", range, text: o.text };
  if ("caseSensitiveLookup" in o || "variableName" in o)
    return {
      kind: "variable",
      range,
      ...(typeof o.variableName === "string" && { name: o.variableName }),
      caseSensitive: o.caseSensitiveLookup !== false,
    };
  return {
    kind: "expression",
    range,
    ...(typeof o.expression === "string" && { expression: o.expression }),
  };
}

/** Markdown for a hover (VS Code's Hover contents). */
export function hoverText(contents: readonly (MarkdownString | MarkedString)[]): string {
  return contents.map(markdownOf).filter(Boolean).join("\n\n---\n\n");
}

/** A command's title, and how the IDE runs it (`ref` the shim's handle for its arguments). */
export interface CommandRef {
  command: string;
  input?: unknown;
}

export type CommandRefOf = (command: Command | undefined) => CommandRef | undefined;

/** Uris that came as JSON in arguments (a tree row's menu, a command's input) as Uris again. */
export function reviveArgument(v: unknown): unknown {
  if (v && typeof v === "object" && (v as { $mid?: unknown }).$mid === 1) return Uri.revive(v);
  return v;
}

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
