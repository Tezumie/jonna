// VS Code's `vscode.execute…Provider` commands (and `vscode.prepareRename`): every provider the
// editor has for a document — its language servers', its own services', every extension's, this
// one's too — asked through the IDE (`ide.languages.execute`, providerQuery.ts) and answered as
// VS Code's classes. Workspace symbols come from the IDE's symbol search (language servers,
// extensions' providers, declarations in files). What the IDE can't ask (call and type
// hierarchies, semantic tokens, inline values, color presentations) answers what VS Code does
// when no provider answers; so does a query the IDE refuses (logged). Array answers are [] rather
// than VS Code's undefined for "none" (D261: extensions' `undefined.forEach` threw).
// DOM-free and unit-tested.

import type {
  ProviderQuery,
  ProviderQueryAnswers,
  ProviderQueryKind,
  QueryLocation,
  QueryRange,
  QuerySymbol,
  QueryTextEdit,
} from "../providerQuery";
import type { WorkerApi } from "../rpc";
import { fromPosition, fromRange, pathOf, uriOf } from "./convert";
import {
  CodeAction,
  CodeActionKind,
  CodeLens,
  Color,
  ColorInformation,
  CompletionItem,
  CompletionItemKind,
  CompletionItemTag,
  CompletionList,
  DocumentHighlight,
  DocumentLink,
  DocumentSymbol,
  FoldingRange,
  FoldingRangeKind,
  Hover,
  InlayHint,
  ParameterInformation,
  SelectionRange,
  SignatureHelp,
  SignatureInformation,
  SymbolInformation,
  SymbolKind,
  SymbolTag,
} from "./languageTypes";
import {
  Location,
  MarkdownString,
  Position,
  Range,
  SnippetString,
  TextEdit,
  Uri,
  WorkspaceEdit,
} from "./types";

/** A range of an answer as VS Code's (0-based). */
const toRange = (r: QueryRange): Range =>
  new Range(
    Math.max(0, r.startLine - 1),
    Math.max(0, r.startColumn - 1),
    Math.max(0, r.endLine - 1),
    Math.max(0, r.endColumn - 1),
  );

const textEdits = (list: readonly QueryTextEdit[]): TextEdit[] =>
  list.map((e) => new TextEdit(toRange(e.range), e.text));

/** VS Code's commands whose arguments are (uri, position, …) and their query kinds. */
const AT_POSITION: Readonly<Record<string, ProviderQueryKind>> = {
  "vscode.executeDefinitionProvider": "definition",
  "vscode.executeTypeDefinitionProvider": "typeDefinition",
  "vscode.executeDeclarationProvider": "declaration",
  "vscode.executeImplementationProvider": "implementation",
  "vscode.executeReferenceProvider": "references",
  "vscode.executeHoverProvider": "hover",
  "vscode.executeDocumentHighlights": "documentHighlights",
  "vscode.executeSignatureHelpProvider": "signatureHelp",
  "vscode.executeCompletionItemProvider": "completion",
  "vscode.prepareRename": "prepareRename",
  "vscode.executeDocumentRenameProvider": "rename",
  "vscode.executeFormatOnTypeProvider": "formatOnType",
};

/** (uri, …): the whole document. */
const WHOLE_DOCUMENT: Readonly<Record<string, ProviderQueryKind>> = {
  "vscode.executeDocumentSymbolProvider": "documentSymbols",
  "vscode.executeFoldingRangeProvider": "foldingRanges",
  "vscode.executeLinkProvider": "links",
  "vscode.executeCodeLensProvider": "codeLens",
  "vscode.executeDocumentColorProvider": "documentColors",
  "vscode.executeFormatDocumentProvider": "formatDocument",
};

/** (uri, range, …). */
const IN_RANGE: Readonly<Record<string, ProviderQueryKind>> = {
  "vscode.executeCodeActionProvider": "codeActions",
  "vscode.executeFormatRangeProvider": "formatRange",
  "vscode.executeInlayHintProvider": "inlayHints",
};

/** What VS Code answers when there's nothing (no provider, or the IDE can't ask). */
const NOTHING: Readonly<Record<string, () => unknown>> = {
  "vscode.executeCompletionItemProvider": () => new CompletionList([], false),
  "vscode.executeSignatureHelpProvider": () => undefined,
  "vscode.prepareRename": () => undefined,
  "vscode.executeDocumentRenameProvider": () => undefined,
  "vscode.provideDocumentSemanticTokensLegend": () => undefined,
  "vscode.provideDocumentSemanticTokens": () => undefined,
  "vscode.provideDocumentRangeSemanticTokensLegend": () => undefined,
  "vscode.provideDocumentRangeSemanticTokens": () => undefined,
};

/** The IDE has nothing to ask for these (yet): what VS Code answers with no provider. */
const NOT_ASKED = new Set([
  "vscode.prepareCallHierarchy",
  "vscode.provideIncomingCalls",
  "vscode.provideOutgoingCalls",
  "vscode.prepareTypeHierarchy",
  "vscode.provideSupertypes",
  "vscode.provideSubtypes",
  "vscode.executeColorPresentationProvider",
  "vscode.executeInlineValueProvider",
  "vscode.executeLinkedEditingProvider",
  "vscode.executeDocumentDropEditProvider",
  "vscode.executeDocumentPasteEditProvider",
  ...Object.keys(NOTHING).filter((id) => id.startsWith("vscode.provide")),
]);

/** Whether `id` is one of the language commands this module answers. */
export function isExecuteCommand(id: string): boolean {
  return (
    id in AT_POSITION ||
    id in WHOLE_DOCUMENT ||
    id in IN_RANGE ||
    id === "vscode.executeWorkspaceSymbolProvider" ||
    id === "vscode.executeSelectionRangeProvider" ||
    NOT_ASKED.has(id)
  );
}

/** What `id` answers when there's nothing: [] for lists, as D261 settled. */
export function emptyAnswer(id: string): unknown {
  return (NOTHING[id] ?? (() => []))();
}

/** The query VS Code's arguments ask for, or undefined when they aren't what the command takes. */
export function queryOf(id: string, args: readonly unknown[]): ProviderQuery | undefined {
  const uri = Uri.revive(args[0]);
  if (!uri) return undefined;
  const path = pathOf(uri);
  const at = (v: unknown) => (Position.isPosition(v) ? fromPosition(v) : undefined);
  const count = (v: unknown) =>
    typeof v === "number" && Number.isInteger(v) && v >= 0
      ? { resolveCount: Math.min(v, 1000) }
      : {};
  const formatting = (v: unknown) => {
    const o = (v && typeof v === "object" ? v : {}) as {
      tabSize?: unknown;
      insertSpaces?: unknown;
    };
    return {
      ...(typeof o.tabSize === "number" &&
        Number.isInteger(o.tabSize) &&
        o.tabSize >= 1 &&
        o.tabSize <= 32 && { tabSize: o.tabSize }),
      ...(typeof o.insertSpaces === "boolean" && { insertSpaces: o.insertSpaces }),
    };
  };
  const positional = AT_POSITION[id];
  if (positional) {
    const p = at(args[1]);
    if (!p) return undefined;
    const q: ProviderQuery = { kind: positional, path, ...p };
    const third = args[2];
    if (
      (positional === "completion" || positional === "signatureHelp") &&
      typeof third === "string"
    )
      q.triggerCharacter = third;
    if (positional === "completion") Object.assign(q, count(args[3]));
    if (positional === "rename") {
      if (typeof third !== "string" || !third) return undefined;
      q.newName = third;
    }
    if (positional === "formatOnType") {
      if (typeof third !== "string" || !third) return undefined;
      q.ch = third;
      Object.assign(q, formatting(args[3]));
    }
    return q;
  }
  const whole = WHOLE_DOCUMENT[id];
  if (whole) {
    const q: ProviderQuery = { kind: whole, path };
    if (whole === "formatDocument") Object.assign(q, formatting(args[1]));
    if (whole === "links" || whole === "codeLens") Object.assign(q, count(args[1]));
    return q;
  }
  const ranged = IN_RANGE[id];
  if (ranged) {
    if (!Range.isRange(args[1])) return undefined;
    const q: ProviderQuery = { kind: ranged, path, range: fromRange(args[1]) };
    if (ranged === "formatRange") Object.assign(q, formatting(args[2]));
    if (ranged === "codeActions") {
      const kind = args[2];
      // A string or a CodeActionKind.
      const only = typeof kind === "string" ? kind : (kind as { value?: unknown } | null)?.value;
      if (typeof only === "string" && only) q.only = only;
      Object.assign(q, count(args[3]));
    }
    return q;
  }
  if (id === "vscode.executeSelectionRangeProvider") {
    const list = Array.isArray(args[1]) ? args[1] : [];
    const positions = list.map(at).filter((p): p is { line: number; column: number } => !!p);
    return { kind: "selectionRanges", path, positions };
  }
  return undefined;
}

// ---- Answers as VS Code's classes ------------------------------------------------------------

function locations(list: readonly QueryLocation[], links: boolean): unknown[] {
  return list.map((l) => {
    const uri = uriOf(l.path);
    if (links && (l.targetSelectionRange || l.originSelectionRange))
      return {
        targetUri: uri,
        targetRange: toRange(l.range),
        targetSelectionRange: l.targetSelectionRange
          ? toRange(l.targetSelectionRange)
          : toRange(l.range),
        ...(l.originSelectionRange && { originSelectionRange: toRange(l.originSelectionRange) }),
      };
    return new Location(uri, toRange(l.range));
  });
}

/** VS Code's DocumentSymbol that is also a SymbolInformation (its `location`, `containerName`). */
function symbols(list: readonly QuerySymbol[], uri: Uri, container: string): DocumentSymbol[] {
  return list.map((s) => {
    const kind = (s.kind in SymbolKind ? s.kind : SymbolKind.Variable) as SymbolKind;
    const range = toRange(s.range);
    const symbol = new DocumentSymbol(s.name, s.detail, kind, range, toRange(s.selectionRange));
    if (s.deprecated) symbol.tags = [SymbolTag.Deprecated];
    Object.assign(symbol, { location: new Location(uri, range), containerName: container });
    symbol.children = symbols(s.children, uri, s.name);
    return symbol;
  });
}

const markdown = (text: string | undefined) =>
  text === undefined ? undefined : new MarkdownString(text);

const COMPLETION_KIND_BY_NAME = new Map(
  Object.entries(CompletionItemKind)
    .filter(([, v]) => typeof v === "number")
    .map(([name, v]) => [name.charAt(0).toLowerCase() + name.slice(1), v as CompletionItemKind]),
);

function completions(list: ProviderQueryAnswers["completion"]): CompletionList {
  const items = list.items.map((c) => {
    const label =
      c.labelDetail || c.labelDescription
        ? {
            label: c.label,
            ...(c.labelDetail && { detail: c.labelDetail }),
            ...(c.labelDescription && { description: c.labelDescription }),
          }
        : c.label;
    const item = new CompletionItem(label, COMPLETION_KIND_BY_NAME.get(c.kind));
    if (c.detail) item.detail = c.detail;
    if (c.documentation) item.documentation = new MarkdownString(c.documentation);
    item.insertText = c.snippet ? new SnippetString(c.insertText) : c.insertText;
    if (c.filterText) item.filterText = c.filterText;
    if (c.sortText) item.sortText = c.sortText;
    if (c.preselect) item.preselect = true;
    if (c.deprecated) item.tags = [CompletionItemTag.Deprecated];
    if (c.range)
      item.range = c.insertRange
        ? { inserting: toRange(c.insertRange), replacing: toRange(c.range) }
        : toRange(c.range);
    if (c.commitCharacters) item.commitCharacters = [...c.commitCharacters];
    if (c.additionalTextEdits) item.additionalTextEdits = textEdits(c.additionalTextEdits);
    return item;
  });
  return new CompletionList(items, list.isIncomplete);
}

const FOLDING_KINDS = {
  comment: FoldingRangeKind.Comment,
  imports: FoldingRangeKind.Imports,
  region: FoldingRangeKind.Region,
} as const;

/** The IDE's answer to `query` as VS Code's command result. */
export function answerOf(query: ProviderQuery, raw: unknown): unknown {
  const uri = uriOf(query.path);
  switch (query.kind) {
    case "definition":
    case "typeDefinition":
    case "declaration":
    case "implementation":
      return locations((raw ?? []) as QueryLocation[], true);
    case "references":
      return locations((raw ?? []) as QueryLocation[], false);
    case "hover":
      return ((raw ?? []) as ProviderQueryAnswers["hover"]).map(
        (h) =>
          new Hover(
            h.contents.map((c) => new MarkdownString(c)),
            h.range ? toRange(h.range) : undefined,
          ),
      );
    case "documentHighlights":
      return ((raw ?? []) as ProviderQueryAnswers["documentHighlights"]).map(
        (h) => new DocumentHighlight(toRange(h.range), h.kind),
      );
    case "signatureHelp": {
      const r = raw as ProviderQueryAnswers["signatureHelp"];
      if (!r) return undefined;
      const help = new SignatureHelp();
      help.signatures = r.signatures.map((s) => {
        const info = new SignatureInformation(s.label, markdown(s.documentation));
        info.parameters = s.parameters.map(
          (p) => new ParameterInformation(p.label, markdown(p.documentation)),
        );
        if (s.activeParameter !== undefined) info.activeParameter = s.activeParameter;
        return info;
      });
      help.activeSignature = r.activeSignature;
      help.activeParameter = r.activeParameter;
      return help;
    }
    case "completion":
      return raw ? completions(raw as ProviderQueryAnswers["completion"]) : new CompletionList();
    case "prepareRename": {
      const r = raw as ProviderQueryAnswers["prepareRename"];
      if (!r) return undefined;
      if ("rejectReason" in r) throw new Error(r.rejectReason);
      return { range: toRange(r.range), placeholder: r.text };
    }
    case "rename": {
      const r = raw as ProviderQueryAnswers["rename"];
      if (!r) return undefined;
      if ("rejectReason" in r) throw new Error(r.rejectReason);
      const edit = new WorkspaceEdit();
      for (const e of r.edits) edit.replace(uriOf(e.path), toRange(e.range), e.text);
      return edit;
    }
    case "formatOnType":
    case "formatDocument":
    case "formatRange":
      return textEdits((raw ?? []) as QueryTextEdit[]);
    case "documentSymbols":
      return symbols((raw ?? []) as QuerySymbol[], uri, "");
    case "foldingRanges":
      return ((raw ?? []) as ProviderQueryAnswers["foldingRanges"]).map(
        (f) => new FoldingRange(f.start - 1, f.end - 1, f.kind ? FOLDING_KINDS[f.kind] : undefined),
      );
    case "links":
      return ((raw ?? []) as ProviderQueryAnswers["links"]).map((l) => {
        const link = new DocumentLink(toRange(l.range), l.target ? uriOf(l.target) : undefined);
        if (l.tooltip) link.tooltip = l.tooltip;
        return link;
      });
    case "codeLens":
      return ((raw ?? []) as ProviderQueryAnswers["codeLens"]).map(
        (l) =>
          new CodeLens(
            toRange(l.range),
            l.command ? { title: l.command.title, command: l.command.id } : undefined,
          ),
      );
    case "documentColors":
      return ((raw ?? []) as ProviderQueryAnswers["documentColors"]).map(
        ({ range, color: c }) =>
          new ColorInformation(toRange(range), new Color(c.red, c.green, c.blue, c.alpha)),
      );
    case "codeActions":
      return ((raw ?? []) as ProviderQueryAnswers["codeActions"]).map((a) => {
        const action = new CodeAction(a.title, a.kind ? new CodeActionKind(a.kind) : undefined);
        if (a.isPreferred) action.isPreferred = true;
        if (a.disabled) action.disabled = { reason: a.disabled };
        if (a.edits?.length) {
          action.edit = new WorkspaceEdit();
          for (const e of a.edits) action.edit.replace(uriOf(e.path), toRange(e.range), e.text);
        }
        if (a.command) action.command = { title: a.command.title, command: a.command.id };
        return action;
      });
    case "inlayHints":
      return ((raw ?? []) as ProviderQueryAnswers["inlayHints"]).map((h) => {
        const hint = new InlayHint(
          new Position(Math.max(0, h.line - 1), Math.max(0, h.column - 1)),
          h.label,
          h.kind,
        );
        if (h.tooltip) hint.tooltip = h.tooltip;
        if (h.paddingLeft) hint.paddingLeft = true;
        if (h.paddingRight) hint.paddingRight = true;
        return hint;
      });
    case "selectionRanges":
      return ((raw ?? []) as QueryRange[][]).flatMap((ranges) => {
        // Innermost first: each range's parent is the next one out.
        let node: SelectionRange | undefined;
        for (const r of [...ranges].reverse()) node = new SelectionRange(toRange(r), node);
        return node ? [node] : [];
      });
  }
}

/** quickOpen.findSymbols' kind names ("class", "enumMember") as VS Code's SymbolKind. */
function symbolKind(name: unknown): SymbolKind {
  if (typeof name !== "string" || !name) return SymbolKind.Variable;
  const key = name.charAt(0).toUpperCase() + name.slice(1);
  const v = (SymbolKind as unknown as Record<string, unknown>)[key];
  return typeof v === "number" ? (v as SymbolKind) : SymbolKind.Variable;
}

/** The IDE's workspace symbol search, as VS Code's SymbolInformation list. */
async function workspaceSymbols(
  ide: WorkerApi,
  query: unknown,
  absolute: (path: string) => string,
): Promise<SymbolInformation[]> {
  if (typeof query !== "string" || !query.trim()) return [];
  const r = await ide.commands.execute<{ symbols?: unknown }>("quickOpen.findSymbols", {
    query: query.slice(0, 200),
    limit: 200,
  });
  const list = Array.isArray(r?.symbols) ? r.symbols : [];
  const out: SymbolInformation[] = [];
  for (const raw of list) {
    const s = (raw ?? {}) as Record<string, unknown>;
    if (typeof s.name !== "string" || typeof s.path !== "string") continue;
    const line = typeof s.line === "number" ? Math.max(0, s.line - 1) : 0;
    const column = typeof s.column === "number" ? Math.max(0, s.column - 1) : 0;
    const at = new Position(line, column);
    out.push(
      new SymbolInformation(
        s.name,
        symbolKind(s.kind),
        typeof s.container === "string" ? s.container : "",
        new Location(uriOf(absolute(s.path)), new Range(at, at)),
      ),
    );
  }
  return out;
}

/**
 * Runs one of VS Code's language commands (`isExecuteCommand`). A query the IDE refuses or can't
 * answer (no permission, a file outside the folder) is logged with `log` and answers nothing.
 */
export async function runExecuteCommand(
  ide: WorkerApi,
  id: string,
  args: readonly unknown[],
  options: { absolute: (path: string) => string; log: (text: string) => void },
): Promise<unknown> {
  const failed = (err: unknown) => {
    options.log(`${id}: ${err instanceof Error ? err.message : String(err)}`);
    return emptyAnswer(id);
  };
  if (id === "vscode.executeWorkspaceSymbolProvider")
    return workspaceSymbols(ide, args[0], options.absolute).catch(failed);
  if (NOT_ASKED.has(id)) return emptyAnswer(id);
  const query = queryOf(id, args);
  if (!query) return emptyAnswer(id);
  let raw: unknown;
  try {
    raw = await ide.languages.execute(query);
  } catch (err) {
    return failed(err);
  }
  // A rename the providers refuse rejects, as in VS Code.
  return answerOf(query, raw);
}
