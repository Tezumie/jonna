// LSP ↔ Monaco conversions (positions, ranges, completion items, hovers, symbols, edits).
import type * as lsp from "../../../core/lsp/types";
import { uriToPath } from "../../../core/lsp/uri";
import * as monaco from "./core";

export function toPosition(p: monaco.IPosition): lsp.Position {
  return { line: p.lineNumber - 1, character: p.column - 1 };
}

export function toRange(r: lsp.Range): monaco.IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

export function fromRange(r: monaco.IRange): lsp.Range {
  return {
    start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
    end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
  };
}

/** A URI from a server as a Monaco file URI (our models use Uri.file). */
export function toUri(uri: string): monaco.Uri {
  const path = uriToPath(uri);
  return path ? monaco.Uri.file(path) : monaco.Uri.parse(uri);
}

const K = monaco.languages.CompletionItemKind;
const COMPLETION_KIND: Record<number, monaco.languages.CompletionItemKind> = {
  1: K.Text,
  2: K.Method,
  3: K.Function,
  4: K.Constructor,
  5: K.Field,
  6: K.Variable,
  7: K.Class,
  8: K.Interface,
  9: K.Module,
  10: K.Property,
  11: K.Unit,
  12: K.Value,
  13: K.Enum,
  14: K.Keyword,
  15: K.Snippet,
  16: K.Color,
  17: K.File,
  18: K.Reference,
  19: K.Folder,
  20: K.EnumMember,
  21: K.Constant,
  22: K.Struct,
  23: K.Event,
  24: K.Operator,
  25: K.TypeParameter,
};

export function toMarkdown(
  doc: string | lsp.MarkupContent | undefined,
): monaco.IMarkdownString | string | undefined {
  if (doc === undefined) return undefined;
  if (typeof doc === "string") return doc;
  return doc.kind === "markdown" ? { value: doc.value } : doc.value;
}

/** Our item keeps the LSP original for completionItem/resolve. */
export type MonacoCompletion = monaco.languages.CompletionItem & { lsp: lsp.CompletionItem };

export function toCompletion(
  item: lsp.CompletionItem,
  defaultRange: monaco.IRange,
): MonacoCompletion {
  const label = typeof item.label === "string" ? item.label : item.label.label;
  let range: monaco.languages.CompletionItem["range"] = defaultRange;
  let insertText = item.insertText ?? label;
  if (item.textEdit) {
    insertText = item.textEdit.newText;
    range =
      "range" in item.textEdit
        ? toRange(item.textEdit.range)
        : { insert: toRange(item.textEdit.insert), replace: toRange(item.textEdit.replace) };
  }
  return {
    label,
    kind: COMPLETION_KIND[item.kind ?? 1] ?? K.Text,
    detail: item.detail,
    documentation: toMarkdown(item.documentation),
    sortText: item.sortText,
    filterText: item.filterText,
    insertText,
    insertTextRules:
      item.insertTextFormat === 2
        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : undefined,
    range,
    additionalTextEdits: item.additionalTextEdits?.map(toTextEdit),
    commitCharacters: item.commitCharacters,
    preselect: item.preselect,
    tags:
      item.deprecated || item.tags?.includes(1)
        ? [monaco.languages.CompletionItemTag.Deprecated]
        : undefined,
    lsp: item,
  };
}

export function toTextEdit(e: lsp.TextEdit): monaco.languages.TextEdit {
  return { range: toRange(e.range), text: e.newText };
}

export function toHover(h: lsp.Hover | null): monaco.languages.Hover | null {
  if (!h?.contents) return null;
  const parts = Array.isArray(h.contents) ? h.contents : [h.contents];
  const contents = parts
    .map(
      (c): monaco.IMarkdownString =>
        typeof c === "string"
          ? { value: c }
          : "kind" in c
            ? { value: c.kind === "markdown" ? c.value : escapeMarkdown(c.value) }
            : { value: `\`\`\`${c.language}\n${c.value}\n\`\`\`` },
    )
    .filter((c) => c.value.trim() !== "");
  if (contents.length === 0) return null;
  return { contents, range: h.range ? toRange(h.range) : undefined };
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

export function toLocations(
  result: lsp.Location | lsp.Location[] | lsp.LocationLink[] | null,
): monaco.languages.LocationLink[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  return list.map((l) =>
    "targetUri" in l
      ? {
          uri: toUri(l.targetUri),
          range: toRange(l.targetRange),
          targetSelectionRange: toRange(l.targetSelectionRange),
          originSelectionRange: l.originSelectionRange
            ? toRange(l.originSelectionRange)
            : undefined,
        }
      : { uri: toUri(l.uri), range: toRange(l.range) },
  );
}

export function toSymbols(
  result: (lsp.DocumentSymbol | lsp.SymbolInformation)[] | null,
): monaco.languages.DocumentSymbol[] {
  if (!result) return [];
  const one = (s: lsp.DocumentSymbol): monaco.languages.DocumentSymbol => ({
    name: s.name,
    detail: s.detail ?? "",
    kind: (s.kind - 1) as monaco.languages.SymbolKind,
    tags: [],
    range: toRange(s.range),
    selectionRange: toRange(s.selectionRange),
    children: s.children?.map(one),
  });
  return result.map((s) =>
    "location" in s
      ? {
          name: s.name,
          detail: "",
          kind: (s.kind - 1) as monaco.languages.SymbolKind,
          tags: [],
          containerName: s.containerName,
          range: toRange(s.location.range),
          selectionRange: toRange(s.location.range),
        }
      : one(s),
  );
}

export function toWorkspaceEdit(edit: lsp.WorkspaceEdit | null): monaco.languages.WorkspaceEdit {
  const edits: monaco.languages.IWorkspaceTextEdit[] = [];
  const add = (uri: string, list: lsp.TextEdit[]) => {
    for (const e of list)
      edits.push({ resource: toUri(uri), textEdit: toTextEdit(e), versionId: undefined });
  };
  for (const [uri, list] of Object.entries(edit?.changes ?? {})) add(uri, list);
  for (const change of edit?.documentChanges ?? []) {
    if ("textDocument" in change) add(change.textDocument.uri, change.edits);
  }
  return { edits };
}

const SEVERITY: Record<number, monaco.MarkerSeverity> = {
  1: monaco.MarkerSeverity.Error,
  2: monaco.MarkerSeverity.Warning,
  3: monaco.MarkerSeverity.Info,
  4: monaco.MarkerSeverity.Hint,
};

export function toMarker(d: lsp.Diagnostic, source: string): monaco.editor.IMarkerData {
  return {
    ...toRange(d.range),
    severity: SEVERITY[d.severity ?? 1] ?? monaco.MarkerSeverity.Error,
    message: d.message,
    source: d.source ?? source,
    code: d.code === undefined ? undefined : String(d.code),
    tags: d.tags?.filter((t) => t === 1 || t === 2) as monaco.MarkerTag[] | undefined,
  };
}
