// More language-server features in notebook cells (D229), on the joined document of
// notebookLsp.ts as VS Code has them in cells: code actions (quick fixes, an auto-import into the
// cell at the top), formatting (Format cell, and so Format notebook; a range request for the
// cell, else the document's edits that fall inside it), inlay hints and semantic tokens. An edit
// for another cell is made in that cell. Each provider answers only for cells (files have
// lsp.ts's).
import { Emitter } from "../../../core/events/index";
import type { LanguageClient } from "../../../core/lsp/client";
import { type CancelToken, cancelSource } from "../../../core/lsp/jsonrpc";
import type * as lsp from "../../../core/lsp/types";
import { uriToPath } from "../../../core/lsp/uri";
import {
  type ConcatDocument,
  cellSemanticTokens,
  semanticTokensDiff,
} from "../../../core/notebook/concat";
import { pathKey } from "../../../core/paths/index";
import * as monaco from "./core";
import { toRange, toUri } from "./lspConvert";

/** One cell as the providers see it. */
export interface CellContext {
  /** The joined document's URI (what the server knows). */
  uri: string;
  doc: ConcatDocument;
  cellId: string;
  /** This cell's diagnostics as the server sent them (joined-document ranges). */
  diagnostics: lsp.Diagnostic[];
  /** A cell's model URI (its editor is made when it has none yet). */
  cellUri(cellId: string): monaco.Uri | null;
}

export interface CellAccess {
  /** The cell `model` is, flushed to the server first (null: not a cell of this client's). */
  context(client: LanguageClient, model: monaco.editor.ITextModel): CellContext | null;
  /** A notebook's joined text was sent again (another cell's tokens may have changed). */
  readonly onDidSend: (listener: () => void) => { dispose(): void };
}

/** A Monaco command that makes edits in other cells (an auto-import completion's). */
export const CELL_EDITS_COMMAND = "notebook.lsp.cellEdits";

/** Edits for other cells: `[cell model URI, edits]`. */
export type CellEdits = [string, { range: monaco.IRange; text: string }[]][];

/** Applies cell edits (the command's handler; each cell's own undo step). */
export function applyCellEdits(list: CellEdits): void {
  for (const [uri, edits] of list) {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (!model || model.isDisposed() || !edits.length) continue;
    model.pushEditOperations(
      [],
      edits.map((e) => ({ range: e.range, text: e.text })),
      () => null,
    );
  }
}

function tokenFor(t: monaco.CancellationToken): CancelToken {
  const source = cancelSource();
  t.onCancellationRequested(() => source.cancel());
  return source;
}

const isJoined = (c: CellContext, uri: string) =>
  pathKey(uriToPath(uri) ?? "") === pathKey(uriToPath(c.uri) ?? "");

/**
 * Text edits on the joined document, in their cells; one across cells is clipped to each cell's
 * part (`ConcatDocument.splitEdit`, m7.12).
 */
export function cellTextEdits(
  c: CellContext,
  edits: readonly lsp.TextEdit[],
): { uri: monaco.Uri; cellId: string; range: monaco.IRange; text: string }[] {
  const out: { uri: monaco.Uri; cellId: string; range: monaco.IRange; text: string }[] = [];
  for (const e of edits)
    for (const part of c.doc.splitEdit(e.range, e.newText)) {
      const uri = c.cellUri(part.cellId);
      if (uri) out.push({ uri, cellId: part.cellId, range: toRange(part.range), text: part.text });
    }
  return out;
}

/** A server's workspace edit as Monaco's: the joined document's parts in their cells. */
function toCellWorkspaceEdit(
  c: CellContext,
  edit: lsp.WorkspaceEdit,
): monaco.languages.WorkspaceEdit {
  const edits: monaco.languages.IWorkspaceTextEdit[] = [];
  const add = (uri: string, list: lsp.TextEdit[]) => {
    if (isJoined(c, uri)) {
      for (const e of cellTextEdits(c, list))
        edits.push({
          resource: e.uri,
          textEdit: { range: e.range, text: e.text },
          versionId: undefined,
        });
      return;
    }
    // A file that isn't open can't take an edit from here (as rename in cells).
    const resource = toUri(uri);
    if (!monaco.editor.getModel(resource)) return;
    for (const e of list)
      edits.push({
        resource,
        textEdit: { range: toRange(e.range), text: e.newText },
        versionId: undefined,
      });
  };
  for (const [uri, list] of Object.entries(edit.changes ?? {})) add(uri, list);
  for (const change of edit.documentChanges ?? [])
    if ("textDocument" in change) add(change.textDocument.uri, change.edits);
  return { edits };
}

const overlaps = (a: lsp.Range, b: lsp.Range) =>
  !(
    a.end.line < b.start.line ||
    (a.end.line === b.start.line && a.end.character < b.start.character) ||
    b.end.line < a.start.line ||
    (b.end.line === a.start.line && b.end.character < a.start.character)
  );

let commandSeq = 0;

/** A cell editor's semantic tokens as last given (m7.12). */
interface GivenTokens {
  /** The cell model's version when they were asked. */
  version: number;
  data: number[];
  resultId: string;
}

const sameNumbers = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const tokenEdits = (before: readonly number[], after: readonly number[]) =>
  semanticTokensDiff(before, after).map((e) => ({
    start: e.start,
    deleteCount: e.deleteCount,
    data: new Uint32Array(e.data),
  }));

/** The providers for `client`'s languages in cells. */
export function cellProviders(client: LanguageClient, access: CellAccess): monaco.IDisposable[] {
  const caps = client.capabilities;
  // Only cells: formatting picks one provider, and files have lsp.ts's.
  const selector = client.options.languages.map((language) => ({
    language,
    scheme: "notebook-cell",
  }));
  const out: monaco.IDisposable[] = [];
  const quiet = <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);
  const toJoined = (c: CellContext, r: monaco.IRange): lsp.Range | null => {
    const start = c.doc.toConcat(c.cellId, r.startLineNumber - 1, r.startColumn - 1);
    const end = c.doc.toConcat(c.cellId, r.endLineNumber - 1, r.endColumn - 1);
    return start && end ? { start, end } : null;
  };
  const textDocument = (c: CellContext) => ({ textDocument: { uri: c.uri } });

  // ---- Code actions ----
  const serverCommands = new Set(caps.executeCommandProvider?.commands ?? []);
  const runCommand = `lsp.${client.options.id}.cells.run.${++commandSeq}`;
  out.push(
    monaco.editor.registerCommand(runCommand, (_accessor, cmd: lsp.Command) => {
      if (!serverCommands.has(cmd.command)) return;
      // Edits it makes come back as workspace/applyEdit, which lsp.ts routes to the cells.
      void client
        .request("workspace/executeCommand", { command: cmd.command, arguments: cmd.arguments })
        .catch(() => {});
    }),
  );
  const toCommand = (cmd: lsp.Command | undefined): monaco.languages.Command | undefined =>
    cmd ? { id: runCommand, title: cmd.title, arguments: [cmd] } : undefined;
  const codeActions = caps.codeActionProvider;
  if (codeActions) {
    type Kept = monaco.languages.CodeAction & { lsp?: lsp.CodeAction; cell?: CellContext };
    const toAction = (c: CellContext, a: lsp.CodeAction | lsp.Command): Kept => {
      if ("command" in a && typeof a.command === "string")
        return { title: a.title, command: toCommand(a as lsp.Command) };
      const action = a as lsp.CodeAction;
      return {
        title: action.title,
        ...(action.kind && { kind: action.kind }),
        ...(action.isPreferred && { isPreferred: true }),
        ...(action.disabled && { disabled: action.disabled.reason }),
        ...(action.edit && { edit: toCellWorkspaceEdit(c, action.edit) }),
        ...(action.command && { command: toCommand(action.command) }),
        lsp: action,
        cell: c,
      };
    };
    const resolve = typeof codeActions === "object" && codeActions.resolveProvider;
    out.push(
      monaco.languages.registerCodeActionProvider(
        selector,
        {
          provideCodeActions: async (model, range, context, token) => {
            const c = access.context(client, model);
            const joined = c && toJoined(c, range);
            if (!c || !joined) return null;
            const result = await quiet(
              client.request<(lsp.CodeAction | lsp.Command)[] | null>(
                "textDocument/codeAction",
                {
                  ...textDocument(c),
                  range: joined,
                  context: {
                    diagnostics: c.diagnostics.filter((d) => overlaps(d.range, joined)),
                    ...(context.only && { only: [context.only] }),
                    triggerKind: context.trigger === 1 ? 1 : 2,
                  },
                },
                tokenFor(token),
              ),
              null,
            );
            return { actions: (result ?? []).map((a) => toAction(c, a)), dispose: () => {} };
          },
          resolveCodeAction: resolve
            ? async (action, token) => {
                const kept = action as Kept;
                if (!kept.lsp || kept.lsp.edit || !kept.cell) return action;
                const r = await quiet(
                  client.request<lsp.CodeAction>("codeAction/resolve", kept.lsp, tokenFor(token)),
                  null,
                );
                return r ? toAction(kept.cell, r) : action;
              }
            : undefined,
        },
        typeof codeActions === "object" && codeActions.codeActionKinds
          ? { providedCodeActionKinds: codeActions.codeActionKinds }
          : undefined,
      ),
    );
  }

  // ---- Formatting ----
  const inCell = (c: CellContext, edits: lsp.TextEdit[] | null): monaco.languages.TextEdit[] =>
    cellTextEdits(c, edits ?? [])
      .filter((e) => e.cellId === c.cellId)
      .map((e) => ({ range: e.range, text: e.text }));
  const formatRange = async (
    c: CellContext,
    range: lsp.Range,
    options: monaco.languages.FormattingOptions,
    token: monaco.CancellationToken,
  ) => {
    const formatting = { tabSize: options.tabSize, insertSpaces: options.insertSpaces };
    // A range request formats the cell alone; else the whole document's edits inside the cell.
    const r = caps.documentRangeFormattingProvider
      ? await client.request<lsp.TextEdit[] | null>(
          "textDocument/rangeFormatting",
          { ...textDocument(c), range, options: formatting },
          tokenFor(token),
        )
      : await client.request<lsp.TextEdit[] | null>(
          "textDocument/formatting",
          { ...textDocument(c), options: formatting },
          tokenFor(token),
        );
    return inCell(c, r);
  };
  if (caps.documentFormattingProvider || caps.documentRangeFormattingProvider)
    out.push(
      monaco.languages.registerDocumentFormattingEditProvider(selector, {
        displayName: client.options.id,
        provideDocumentFormattingEdits: async (model, options, token) => {
          const c = access.context(client, model);
          const range = c?.doc.cellRange(c.cellId);
          return c && range ? formatRange(c, range, options, token) : null;
        },
      }),
    );
  if (caps.documentRangeFormattingProvider)
    out.push(
      monaco.languages.registerDocumentRangeFormattingEditProvider(selector, {
        displayName: client.options.id,
        provideDocumentRangeFormattingEdits: async (model, range, options, token) => {
          const c = access.context(client, model);
          const joined = c && toJoined(c, range);
          return c && joined ? formatRange(c, joined, options, token) : null;
        },
      }),
    );

  // ---- Inlay hints ----
  if (caps.inlayHintProvider)
    out.push(
      monaco.languages.registerInlayHintsProvider(selector, {
        provideInlayHints: async (model, range, token) => {
          const c = access.context(client, model);
          const joined = c && toJoined(c, range);
          if (!c || !joined) return null;
          const r = await quiet(
            client.request<lsp.InlayHint[] | null>(
              "textDocument/inlayHint",
              { ...textDocument(c), range: joined },
              tokenFor(token),
            ),
            null,
          );
          const hints: monaco.languages.InlayHint[] = [];
          for (const hint of r ?? []) {
            const at = c.doc.fromConcat(hint.position.line, hint.position.character);
            if (at?.cellId !== c.cellId) continue;
            hints.push({
              position: { lineNumber: at.line + 1, column: at.character + 1 },
              label:
                typeof hint.label === "string"
                  ? hint.label
                  : hint.label.map((part) => part.value).join(""),
              ...(hint.kind && { kind: hint.kind as monaco.languages.InlayHintKind }),
              ...(hint.paddingLeft && { paddingLeft: true }),
              ...(hint.paddingRight && { paddingRight: true }),
            });
          }
          return { hints, dispose: () => {} };
        },
      }),
    );

  // ---- Semantic tokens ----
  const semantic = caps.semanticTokensProvider;
  if (semantic?.full || semantic?.range) {
    const changed = new Emitter<void>();
    // Every cell asks for the same joined document's tokens: one request per text sent.
    const recent = new Map<string, { text: string; data: Promise<number[] | null> }>();
    // What each cell's editor was given last (by cell model URI), for deltas and for telling
    // whether an edit elsewhere changed this cell's tokens (m7.12).
    const given = new Map<string, GivenTokens>();
    let resultSeq = 0;
    const refresh = client.onRefresh((kind) => {
      if (kind !== "semanticTokens") return;
      // The server says its tokens are stale: the same text is asked again.
      recent.clear();
      changed.fire();
    });
    // A cell's own edit asks for its tokens again (Monaco follows its model's changes). Another
    // cell's edit may change this one's tokens too (a name defined there): after the joined
    // text is sent, the cells whose text didn't change are compared with what they were given,
    // and only when one differs are the cells asked again (unchanged ones then get an empty
    // delta). Before, every send asked every cell again.
    let check: ReturnType<typeof setTimeout> | undefined;
    const compareOthers = async () => {
      check = undefined;
      let stale = false;
      for (const [key, kept] of given) {
        const model = monaco.editor.getModel(monaco.Uri.parse(key));
        if (!model || model.isDisposed()) {
          given.delete(key);
          continue;
        }
        if (model.getVersionId() !== kept.version) continue;
        const c = access.context(client, model);
        if (!c) continue;
        const data = await joinedTokens(c);
        if (!data) continue;
        if (!sameNumbers(cellSemanticTokens(c.doc, c.cellId, data), kept.data)) {
          stale = true;
          break;
        }
      }
      if (stale) changed.fire();
    };
    const sent = access.onDidSend(() => {
      clearTimeout(check);
      check = setTimeout(() => void compareOthers().catch(() => {}), 250);
    });
    out.push({
      dispose: () => {
        clearTimeout(check);
        refresh.dispose();
        sent.dispose();
        changed.dispose();
        given.clear();
      },
    });
    const joinedTokens = (c: CellContext): Promise<number[] | null> => {
      const kept = recent.get(c.uri);
      if (kept && kept.text === c.doc.text) return kept.data;
      const data = semantic.full
        ? client
            .request<{ data: number[] } | null>("textDocument/semanticTokens/full", textDocument(c))
            .then((r) => r?.data ?? null)
        : client
            .request<{ data: number[] } | null>("textDocument/semanticTokens/range", {
              ...textDocument(c),
              range: c.doc.cellRange(c.cellId) ?? undefined,
            })
            .then((r) => r?.data ?? null);
      const settled = data.catch(() => null);
      // A range answer is for one cell only: not shared.
      if (semantic.full) recent.set(c.uri, { text: c.doc.text, data: settled });
      return settled;
    };
    out.push({ dispose: () => recent.clear() });
    out.push(
      monaco.languages.registerDocumentSemanticTokensProvider(selector, {
        getLegend: () => semantic.legend,
        onDidChange: (listener) => changed.event(listener),
        provideDocumentSemanticTokens: async (model, lastResultId) => {
          const c = access.context(client, model);
          if (!c) return null;
          const version = model.getVersionId();
          const data = await joinedTokens(c);
          const key = model.uri.toString();
          if (!data) {
            given.delete(key);
            return null;
          }
          const tokens = cellSemanticTokens(c.doc, c.cellId, data);
          const before = given.get(key);
          const resultId = String(++resultSeq);
          given.set(key, { version, data: tokens, resultId });
          // What the editor has is ours: only the difference goes (often nothing).
          if (before && lastResultId === before.resultId)
            return { resultId, edits: tokenEdits(before.data, tokens) };
          return { resultId, data: new Uint32Array(tokens) };
        },
        releaseDocumentSemanticTokens: () => {},
      }),
    );
  }
  return out;
}
