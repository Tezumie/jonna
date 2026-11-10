// What an extension asks every provider of a document (VS Code's `vscode.execute…Provider`,
// core/extensions/providerQuery.ts): Monaco's own `_execute…` commands ask its language servers',
// its own services' and every extension's providers and merge their answers as VS Code's do;
// here they're turned into the IDE's 1-based shapes. A file that isn't open gets a read-only
// model first (peek.ts); a document of another scheme that isn't open has no answers.
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { ICommandService } from "monaco-editor/platform/commands/common/commands.js";
import type {
  ProviderQuery,
  QueryCodeAction,
  QueryCompletionItem,
  QueryFileEdit,
  QueryLocation,
  QueryRange,
  QuerySymbol,
  QueryTextEdit,
} from "../../../core/extensions/providerQuery";
import { COMPLETION_KINDS } from "../../../workbench/extensionFeatures";
import type { EngineHost } from "../engine";
import * as monaco from "./core";
import { ensureModels } from "./peek";

type Model = monaco.editor.ITextModel;

const range = (r: monaco.IRange): QueryRange => ({
  startLine: r.startLineNumber,
  startColumn: r.startColumn,
  endLine: r.endLineNumber,
  endColumn: r.endColumn,
});

const toIRange = (r: QueryRange): monaco.IRange => ({
  startLineNumber: r.startLine,
  startColumn: r.startColumn,
  endLineNumber: r.endLine,
  endColumn: r.endColumn,
});

const markdown = (v: unknown): string =>
  typeof v === "string"
    ? v
    : v && typeof v === "object" && typeof (v as { value?: unknown }).value === "string"
      ? (v as { value: string }).value
      : "";

/** The IDE's path of a Uri in an answer: a file's path (an untitled document's name), else the Uri. */
function pathOfUri(uri: monaco.Uri): string {
  if (uri.scheme !== "file") return uri.toString();
  return /^[\\/]?(untitled:.*)$/.exec(uri.fsPath)?.[1] ?? uri.fsPath;
}

const hasScheme = (path: string) =>
  /^[a-zA-Z][\w+.-]+:/.test(path) && !/^[a-zA-Z]:[\\/]/.test(path) && !path.startsWith("untitled:");

/** The document's model: the open one, or a read-only copy of a file of the folder. */
async function modelFor(host: EngineHost, path: string): Promise<Model | null> {
  const uri = monaco.Uri.file(path);
  const open = monaco.editor.getModel(uri);
  if (open && !open.isDisposed()) return open;
  if (hasScheme(path) || path.startsWith("untitled:")) return null;
  await ensureModels(host, [path]);
  return monaco.editor.getModel(uri);
}

/** Monaco's command service is untyped here (monaco-modules.d.ts): its answer, as `T`. */
async function exec<T>(id: string, ...args: unknown[]): Promise<T | undefined> {
  return (await StandaloneServices.get(ICommandService).executeCommand(id, ...args)) as
    | T
    | undefined;
}

const locations = (list: monaco.languages.LocationLink[] | undefined, links: boolean) =>
  (list ?? []).map(
    (l): QueryLocation => ({
      path: pathOfUri(l.uri),
      range: range(l.range),
      ...(links &&
        l.targetSelectionRange && { targetSelectionRange: range(l.targetSelectionRange) }),
      ...(links &&
        l.originSelectionRange && { originSelectionRange: range(l.originSelectionRange) }),
    }),
  );

const textEdits = (list: monaco.languages.TextEdit[] | undefined | null): QueryTextEdit[] =>
  (list ?? []).map((e) => ({ range: range(e.range), text: e.text }));

/** A WorkspaceEdit's text edits (file operations aren't part of an answer). */
function fileEdits(edit: monaco.languages.WorkspaceEdit | undefined): QueryFileEdit[] {
  const out: QueryFileEdit[] = [];
  for (const e of edit?.edits ?? []) {
    const t = e as Partial<monaco.languages.IWorkspaceTextEdit>;
    if (t.resource && t.textEdit)
      out.push({
        path: pathOfUri(t.resource),
        range: range(t.textEdit.range),
        text: t.textEdit.text,
      });
  }
  return out;
}

function symbols(list: readonly monaco.languages.DocumentSymbol[] | undefined): QuerySymbol[] {
  return (list ?? []).map((s) => ({
    name: s.name,
    detail: s.detail ?? "",
    kind: s.kind,
    ...(s.tags?.includes(monaco.languages.SymbolTag.Deprecated) && { deprecated: true }),
    range: range(s.range),
    selectionRange: range(s.selectionRange),
    children: symbols(s.children),
  }));
}

/** Monaco's CompletionItemKind (its own order) by the IDE's name (VS Code's kinds). */
function completionKind(kind: monaco.languages.CompletionItemKind): string {
  const name = monaco.languages.CompletionItemKind[kind] ?? "";
  const camel = name.charAt(0).toLowerCase() + name.slice(1);
  return (COMPLETION_KINDS as readonly string[]).includes(camel)
    ? camel
    : camel === "customcolor"
      ? "color"
      : "text";
}

function completionItem(c: monaco.languages.CompletionItem): QueryCompletionItem {
  const label = typeof c.label === "string" ? { label: c.label } : c.label;
  const r = c.range as monaco.IRange | { insert: monaco.IRange; replace: monaco.IRange };
  const isSplit = "insert" in r;
  return {
    label: label.label,
    ...(label.detail && { labelDetail: label.detail }),
    ...(label.description && { labelDescription: label.description }),
    kind: completionKind(c.kind),
    ...(c.detail && { detail: c.detail }),
    ...(c.documentation && { documentation: markdown(c.documentation) }),
    insertText: c.insertText,
    ...(c.insertTextRules &&
      c.insertTextRules & monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet && {
        snippet: true,
      }),
    ...(c.filterText && { filterText: c.filterText }),
    ...(c.sortText && { sortText: c.sortText }),
    ...(c.preselect && { preselect: true }),
    ...(c.tags?.includes(monaco.languages.CompletionItemTag.Deprecated) && { deprecated: true }),
    range: range(isSplit ? r.replace : r),
    ...(isSplit && { insertRange: range(r.insert) }),
    ...(c.commitCharacters?.length && { commitCharacters: [...c.commitCharacters] }),
    ...(c.additionalTextEdits?.length && {
      additionalTextEdits: c.additionalTextEdits.map((e) => ({
        range: range(e.range),
        text: e.text ?? "",
      })),
    }),
  };
}

function codeAction(a: monaco.languages.CodeAction): QueryCodeAction {
  const edits = fileEdits(a.edit);
  return {
    title: a.title,
    ...(a.kind && { kind: a.kind }),
    ...(a.isPreferred && { isPreferred: true }),
    ...(a.disabled && { disabled: a.disabled }),
    ...(edits.length && { edits }),
    ...(a.command && { command: { id: a.command.id, title: a.command.title } }),
  };
}

const options = (model: Model, q: ProviderQuery) => {
  const own = model.getOptions();
  return { tabSize: q.tabSize ?? own.tabSize, insertSpaces: q.insertSpaces ?? own.insertSpaces };
};

/** The editor's answer to `q` (the host checked it), in providerQuery.ts's shapes. */
export async function executeProviderQuery(host: EngineHost, q: ProviderQuery): Promise<unknown> {
  const model = await modelFor(host, q.path);
  const uri = model?.uri;
  const at = { lineNumber: q.line ?? 1, column: q.column ?? 1 };
  switch (q.kind) {
    case "definition":
    case "typeDefinition":
    case "declaration":
    case "implementation": {
      if (!uri) return [];
      const id = `_execute${q.kind.charAt(0).toUpperCase()}${q.kind.slice(1)}Provider`;
      return locations(await exec<monaco.languages.LocationLink[]>(id, uri, at), true);
    }
    case "references":
      return uri
        ? locations(
            await exec<monaco.languages.LocationLink[]>("_executeReferenceProvider", uri, at),
            false,
          )
        : [];
    case "hover": {
      if (!uri) return [];
      const list = await exec<monaco.languages.Hover[]>("_executeHoverProvider", uri, at);
      return (list ?? []).map((h) => ({
        contents: h.contents.map(markdown),
        ...(h.range && { range: range(h.range) }),
      }));
    }
    case "documentHighlights": {
      if (!uri) return [];
      const list = await exec<monaco.languages.DocumentHighlight[]>(
        "_executeDocumentHighlights",
        uri,
        at,
      );
      return (list ?? []).map((h) => ({ range: range(h.range), kind: h.kind ?? 0 }));
    }
    case "signatureHelp": {
      if (!uri) return null;
      const help = await exec<monaco.languages.SignatureHelp>(
        "_executeSignatureHelpProvider",
        uri,
        at,
        q.triggerCharacter,
      );
      if (!help) return null;
      return {
        signatures: help.signatures.map((s) => ({
          label: s.label,
          ...(s.documentation && { documentation: markdown(s.documentation) }),
          parameters: s.parameters.map((p) => ({
            label: p.label,
            ...(p.documentation && { documentation: markdown(p.documentation) }),
          })),
          ...(s.activeParameter !== undefined && { activeParameter: s.activeParameter }),
        })),
        activeSignature: help.activeSignature,
        activeParameter: help.activeParameter,
      };
    }
    case "completion": {
      if (!uri) return { isIncomplete: false, items: [] };
      const list = await exec<{
        incomplete: boolean;
        suggestions: monaco.languages.CompletionItem[];
      }>("_executeCompletionItemProvider", uri, at, q.triggerCharacter, q.resolveCount ?? 0);
      return {
        isIncomplete: !!list?.incomplete,
        items: (list?.suggestions ?? []).map(completionItem),
      };
    }
    case "prepareRename": {
      if (!uri) return null;
      try {
        const loc = await exec<monaco.languages.RenameLocation>("_executePrepareRename", uri, at);
        return loc ? { range: range(loc.range), text: loc.text } : null;
      } catch (err) {
        return { rejectReason: err instanceof Error ? err.message : String(err) };
      }
    }
    case "rename": {
      if (!uri) return null;
      const edit = await exec<monaco.languages.WorkspaceEdit & { rejectReason?: string }>(
        "_executeDocumentRenameProvider",
        uri,
        at,
        q.newName,
      );
      if (!edit) return null;
      return edit.rejectReason ? { rejectReason: edit.rejectReason } : { edits: fileEdits(edit) };
    }
    case "formatOnType":
      return model
        ? textEdits(
            await exec("_executeFormatOnTypeProvider", model.uri, at, q.ch, options(model, q)),
          )
        : [];
    case "formatDocument":
      return model
        ? textEdits(await exec("_executeFormatDocumentProvider", model.uri, options(model, q)))
        : [];
    case "formatRange":
      return model && q.range
        ? textEdits(
            await exec(
              "_executeFormatRangeProvider",
              model.uri,
              toIRange(q.range),
              options(model, q),
            ),
          )
        : [];
    case "documentSymbols":
      return uri
        ? symbols(
            await exec<monaco.languages.DocumentSymbol[]>("_executeDocumentSymbolProvider", uri),
          )
        : [];
    case "foldingRanges": {
      if (!uri) return [];
      const list = await exec<{ start: number; end: number; kind?: { value: string } }[]>(
        "_executeFoldingRangeProvider",
        uri,
      );
      return (list ?? []).map((f) => ({
        start: f.start,
        end: f.end,
        ...(f.kind?.value === "comment" || f.kind?.value === "imports" || f.kind?.value === "region"
          ? { kind: f.kind.value }
          : {}),
      }));
    }
    case "links": {
      if (!uri) return [];
      const list = await exec<monaco.languages.ILink[]>(
        "_executeLinkProvider",
        uri,
        q.resolveCount ?? 0,
      );
      return (list ?? []).map((l) => ({
        range: range(l.range),
        ...(l.url && { target: l.url.toString() }),
        ...(l.tooltip && { tooltip: l.tooltip }),
      }));
    }
    case "codeLens": {
      if (!uri) return [];
      const list = await exec<monaco.languages.CodeLens[]>(
        "_executeCodeLensProvider",
        uri,
        q.resolveCount,
      );
      return (list ?? []).map((l) => ({
        range: range(l.range),
        ...(l.command && { command: { id: l.command.id, title: l.command.title } }),
      }));
    }
    case "documentColors": {
      if (!uri) return [];
      const list = await exec<{ range: monaco.IRange; color: [number, number, number, number] }[]>(
        "_executeDocumentColorProvider",
        uri,
      );
      return (list ?? []).map(({ range: r, color: [red, green, blue, alpha] }) => ({
        range: range(r),
        color: { red, green, blue, alpha },
      }));
    }
    case "codeActions": {
      if (!model || !q.range) return [];
      const list = await exec<monaco.languages.CodeAction[]>(
        "_executeCodeActionProvider",
        model.uri,
        model.validateRange(toIRange(q.range)),
        q.only,
        q.resolveCount ?? 0,
      );
      return (list ?? []).map(codeAction);
    }
    case "inlayHints": {
      if (!uri || !q.range) return [];
      const list = await exec<monaco.languages.InlayHint[]>(
        "_executeInlayHintProvider",
        uri,
        toIRange(q.range),
      );
      return (list ?? []).map((h) => ({
        line: h.position.lineNumber,
        column: h.position.column,
        label: typeof h.label === "string" ? h.label : h.label.map((p) => p.label).join(""),
        ...(h.kind && { kind: h.kind }),
        ...(h.tooltip && { tooltip: markdown(h.tooltip) }),
        ...(h.paddingLeft && { paddingLeft: true }),
        ...(h.paddingRight && { paddingRight: true }),
      }));
    }
    case "selectionRanges": {
      if (!uri) return [];
      const list = await exec<monaco.IRange[][]>(
        "_executeSelectionRangeProvider",
        uri,
        (q.positions ?? []).map((p) => ({ lineNumber: p.line, column: p.column })),
      );
      return (list ?? []).map((ranges) => ranges.map(range));
    }
  }
}
