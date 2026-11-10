// Language servers in notebook cells (D204), VS Code's concatenated document: each notebook's
// code cells are joined (core/notebook/concat.ts) and opened in the servers of their language as
// one file beside the notebook, so names from one cell are known in the next. Positions map both
// ways: diagnostics land in their cells (squiggles, and the Problems view with the cell), and
// hover, completion, signature help, definition, references, highlights and rename work in cells.
// The notebook view registers itself through `NotebookLanguageSource` (engine.ts).
import { Emitter } from "../../../core/events/index";
import type { LanguageClient } from "../../../core/lsp/client";
import { type CancelToken, cancelSource } from "../../../core/lsp/jsonrpc";
import type * as lsp from "../../../core/lsp/types";
import { pathToUri, uriToPath } from "../../../core/lsp/uri";
import {
  type CellDiagnostic,
  ConcatDocument,
  cellDiagnostics,
  concatPath,
  languageExtension,
} from "../../../core/notebook/concat";
import { pathKey } from "../../../core/paths/index";
import type { Diagnostic, DiagnosticSeverity, NotebookLanguageSource } from "../engine";
import * as monaco from "./core";
import type { MonacoDocument } from "./document";
import { setJoinedEditHandler } from "./lsp";
import {
  type MonacoCompletion,
  toCompletion,
  toHover,
  toMarkdown,
  toMarker,
  toRange,
  toTextEdit,
  toUri,
} from "./lspConvert";
import {
  applyCellEdits,
  CELL_EDITS_COMMAND,
  type CellAccess,
  type CellContext,
  type CellEdits,
  cellProviders,
  cellTextEdits,
} from "./notebookLspRich";

const CELL_ID = /\.cell-([A-Za-z0-9_-]+)\.[A-Za-z0-9]+$/;
/** How long after the last edit the joined document is sent again. */
const CHANGE_DELAY_MS = 150;
const PULL_DELAY_MS = 250;

const SEVERITY: Record<number, DiagnosticSeverity> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

interface Session {
  client: LanguageClient;
  source: NotebookLanguageSource;
  languageId: string;
  /** The joined document's path (a name no file has). */
  path: string;
  doc: ConcatDocument;
  pending: ReturnType<typeof setTimeout> | undefined;
  pullTimer: ReturnType<typeof setTimeout> | undefined;
  pullSeq: number;
  diagnostics: CellDiagnostic<lsp.Diagnostic>[];
}

/** A completion in a cell, with where it was asked (for the edits resolve brings). */
type CellCompletion = MonacoCompletion & { cell?: { s: Session; cellId: string } };

function tokenFor(t: monaco.CancellationToken): CancelToken {
  const source = cancelSource();
  t.onCancellationRequested(() => source.cancel());
  return source;
}

export class NotebookLanguageHub implements CellAccess {
  private readonly clients = new Map<LanguageClient, monaco.IDisposable[]>();
  private readonly notebooks = new Map<NotebookLanguageSource, { dispose(): void }>();
  private readonly sessions = new Map<string, Session>();
  private readonly changed = new Emitter<readonly string[]>();
  /** Notebook paths whose cell diagnostics changed. */
  readonly onDidChangeDiagnostics = this.changed.event;
  private readonly sent = new Emitter<void>();
  readonly onDidSend = this.sent.event;
  private readonly disposables: monaco.IDisposable[] = [];

  constructor() {
    // A cell's editor made after the diagnostics came gets its squiggles.
    this.disposables.push(
      monaco.editor.onDidCreateModel((model) => {
        if (model.uri.scheme !== "notebook-cell") return;
        for (const s of this.sessions.values()) if (this.owns(s, model)) this.applyMarkers(s);
      }),
    );
    // An auto-import completion's edit for another cell (D229).
    this.disposables.push(
      monaco.editor.registerCommand(CELL_EDITS_COMMAND, (_accessor, list: CellEdits) =>
        applyCellEdits(list),
      ),
    );
    // A server's own edit to a joined document (after a code action's command) goes to cells.
    this.disposables.push(setJoinedEditHandler((uri, edits) => this.applyJoinedEdits(uri, edits)));
    // Go to definition into another cell: the notebook shows that cell.
    this.disposables.push(
      monaco.editor.registerEditorOpener({
        openCodeEditor: (_source, resource, selection) => {
          if (resource.scheme !== "notebook-cell") return false;
          const id = CELL_ID.exec(resource.path)?.[1];
          const owner = [...this.notebooks.keys()].find((n) => this.isCellOf(n, resource));
          if (!id || !owner) return false;
          const at =
            selection && "startLineNumber" in selection
              ? { line: selection.startLineNumber, column: selection.startColumn }
              : selection
                ? { line: selection.lineNumber, column: selection.column }
                : { line: 1, column: 1 };
          owner.reveal(id, at.line, at.column);
          return true;
        },
      }),
    );
  }

  /** A running client: its languages' providers for cells, and its notebooks. */
  addClient(client: LanguageClient): monaco.IDisposable {
    const subs = this.providers(client);
    const diag = client.onDiagnostics(({ path, diagnostics }) => {
      const s = this.sessions.get(this.key(client, path));
      if (s) this.setDiagnostics(s, diagnostics);
    });
    subs.push({ dispose: () => diag.dispose() });
    // A notebook's save is its joined document's: flushed first, with the text when asked (D229).
    const joined = (path: string) => {
      const out: { path: string; text: string }[] = [];
      for (const s of this.sessions.values())
        if (s.client === client && pathKey(s.source.path) === pathKey(path)) {
          this.flush(s);
          out.push({ path: s.path, text: s.doc.text });
        }
      return out;
    };
    client.joinedDocuments = joined;
    subs.push({
      dispose: () => {
        if (client.joinedDocuments === joined) client.joinedDocuments = undefined;
      },
    });
    this.clients.set(client, subs);
    this.sync();
    return {
      dispose: () => {
        for (const s of [...this.sessions.values()]) if (s.client === client) this.close(s);
        for (const d of this.clients.get(client) ?? []) d.dispose();
        this.clients.delete(client);
      },
    };
  }

  addNotebook(source: NotebookLanguageSource): { dispose(): void } {
    const sub = source.onDidChange(() => {
      // Its language may have changed (another kernel): other servers.
      this.sync();
      for (const s of this.sessions.values()) if (s.source === source) this.schedule(s);
    });
    this.notebooks.set(source, sub);
    this.sync();
    return {
      dispose: () => {
        for (const s of [...this.sessions.values()]) if (s.source === source) this.close(s);
        sub.dispose();
        this.notebooks.delete(source);
      },
    };
  }

  /** The notebooks' problems, by cell (Problems view; `path` is the notebook). */
  diagnostics(): Diagnostic[] {
    const out: Diagnostic[] = [];
    for (const s of this.sessions.values()) {
      const cells = s.source.cells();
      for (const d of s.diagnostics) {
        const index = cells.findIndex((c) => c.id === d.cellId);
        if (index < 0) continue;
        out.push({
          path: s.source.path,
          severity: SEVERITY[d.diagnostic.severity ?? 1] ?? "error",
          message: d.diagnostic.message,
          source: d.diagnostic.source ?? s.client.options.id,
          code: d.diagnostic.code === undefined ? undefined : String(d.diagnostic.code),
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          endLine: d.range.end.line + 1,
          endColumn: d.range.end.character + 1,
          cell: { id: d.cellId, index },
        });
      }
    }
    return out;
  }

  /** What's joined for whom (state for agents and tests). */
  sessionsInfo(): {
    notebook: string;
    server: string;
    path: string;
    cells: number;
    problems: number;
  }[] {
    return [...this.sessions.values()].map((s) => ({
      notebook: s.source.path,
      server: s.client.options.id,
      path: s.path,
      cells: s.doc.cellIds.length,
      problems: s.diagnostics.length,
    }));
  }

  dispose(): void {
    for (const s of [...this.sessions.values()]) this.close(s);
    for (const subs of this.clients.values()) for (const d of subs) d.dispose();
    this.clients.clear();
    for (const sub of this.notebooks.values()) sub.dispose();
    this.notebooks.clear();
    for (const d of this.disposables) d.dispose();
    this.changed.dispose();
    this.sent.dispose();
  }

  /** Whether `path` is a notebook's concatenated document for this client (not a real file). */
  isNotebookDocument(client: LanguageClient, path: string): boolean {
    return this.sessions.has(this.key(client, path));
  }

  // ---- Sessions ----

  private key(client: LanguageClient, path: string): string {
    return `${client.options.id}\u0000${pathKey(path)}`;
  }

  private codeCells(source: NotebookLanguageSource) {
    return source
      .cells()
      .filter((c) => c.kind === "code")
      .map((c) => ({ id: c.id, text: c.text }));
  }

  /** Opens a session for each running client of each notebook's language; closes the rest. */
  private sync(): void {
    const wanted = new Set<string>();
    for (const source of this.notebooks.keys()) {
      const languageId = source.languageId();
      for (const client of this.clients.keys()) {
        if (client.state !== "running" || !client.handles(languageId)) continue;
        const path = concatPath(source.path, languageExtension(languageId) ?? languageId);
        const key = this.key(client, path);
        wanted.add(key);
        const existing = this.sessions.get(key);
        if (existing && existing.source !== source) this.close(existing);
        if (!this.sessions.has(key)) this.open(client, source, languageId, path);
      }
    }
    for (const [key, s] of [...this.sessions])
      if (!wanted.has(key) || s.languageId !== s.source.languageId()) this.close(s);
  }

  private open(
    client: LanguageClient,
    source: NotebookLanguageSource,
    languageId: string,
    path: string,
  ): void {
    const doc = new ConcatDocument(this.codeCells(source), languageId);
    const s: Session = {
      client,
      source,
      languageId,
      path,
      doc,
      pending: undefined,
      pullTimer: undefined,
      pullSeq: 0,
      diagnostics: [],
    };
    this.sessions.set(this.key(client, path), s);
    client.didOpen(path, languageId, doc.text);
    this.pull(s);
  }

  private close(s: Session): void {
    clearTimeout(s.pending);
    clearTimeout(s.pullTimer);
    this.sessions.delete(this.key(s.client, s.path));
    try {
      if (s.client.isOpen(s.path)) s.client.didClose(s.path);
    } catch {
      // The server is going away (stopped, crashed): nothing to tell it.
    }
    const had = s.diagnostics.length > 0;
    s.diagnostics = [];
    this.applyMarkers(s);
    if (had) this.changed.fire([s.source.path]);
  }

  private schedule(s: Session): void {
    clearTimeout(s.pending);
    s.pending = setTimeout(() => this.flush(s), CHANGE_DELAY_MS);
  }

  /** Sends the joined text now if it changed (before a request, so positions agree). */
  private flush(s: Session): void {
    clearTimeout(s.pending);
    s.pending = undefined;
    if (!this.sessions.has(this.key(s.client, s.path)) || s.client.state !== "running") return;
    const doc = new ConcatDocument(this.codeCells(s.source), s.languageId);
    if (doc.text === s.doc.text) {
      s.doc = doc;
      return;
    }
    s.doc = doc;
    s.client.didChange(s.path, doc.text);
    this.pull(s);
    this.sent.fire();
  }

  /** Servers with pull diagnostics (D200) are asked after each change. */
  private pull(s: Session): void {
    if (!s.client.capabilities.diagnosticProvider) return;
    clearTimeout(s.pullTimer);
    s.pullTimer = setTimeout(() => {
      const seq = ++s.pullSeq;
      void s.client
        .request<{ kind: "full" | "unchanged"; items?: lsp.Diagnostic[] } | null>(
          "textDocument/diagnostic",
          { textDocument: { uri: pathToUri(s.path) } },
        )
        .then((r) => {
          if (r?.kind === "full" && seq === s.pullSeq) this.setDiagnostics(s, r.items ?? []);
        })
        .catch(() => {});
    }, PULL_DELAY_MS);
  }

  private setDiagnostics(s: Session, diagnostics: readonly lsp.Diagnostic[]): void {
    // Diagnostics are for the text the server has: the joined document as last sent.
    s.diagnostics = cellDiagnostics(s.doc, diagnostics, this.codeCells(s.source), s.languageId);
    this.applyMarkers(s);
    this.changed.fire([s.source.path]);
  }

  private isCellOf(source: NotebookLanguageSource, uri: monaco.Uri): boolean {
    return pathKey(uri.fsPath).startsWith(`${pathKey(source.path)}.cell-`);
  }

  private owns(s: Session, model: monaco.editor.ITextModel): boolean {
    const id = CELL_ID.exec(model.uri.path)?.[1];
    return !!id && s.doc.has(id) && this.isCellOf(s.source, model.uri);
  }

  private applyMarkers(s: Session): void {
    const owner = `lsp:${s.client.options.id}:notebook`;
    const live = this.sessions.has(this.key(s.client, s.path));
    for (const model of monaco.editor.getModels()) {
      if (model.uri.scheme !== "notebook-cell" || !this.isCellOf(s.source, model.uri)) continue;
      const id = CELL_ID.exec(model.uri.path)?.[1];
      const list = live ? s.diagnostics.filter((d) => d.cellId === id) : [];
      monaco.editor.setModelMarkers(
        model,
        owner,
        list.map((d) => toMarker({ ...d.diagnostic, range: d.range }, s.client.options.id)),
      );
    }
  }

  // ---- Positions ----

  /** A cell for the providers of notebookLspRich.ts (CellAccess). */
  context(client: LanguageClient, model: monaco.editor.ITextModel): CellContext | null {
    const found = this.sessionFor(client, model);
    return found ? this.cellContext(found.s, found.cellId) : null;
  }

  private cellContext(s: Session, cellId: string): CellContext {
    return {
      uri: pathToUri(s.path),
      doc: s.doc,
      cellId,
      diagnostics: s.diagnostics.filter((d) => d.cellId === cellId).map((d) => d.diagnostic),
      cellUri: (id) => this.cellUri(s, id),
    };
  }

  /** Edits on the joined document: this cell's (in its terms) and other cells' (D229). */
  private splitEdits(
    s: Session,
    cellId: string,
    edits: readonly lsp.TextEdit[] | undefined,
  ): { here: lsp.TextEdit[]; elsewhere: CellEdits } {
    const here: lsp.TextEdit[] = [];
    const others = new Map<string, CellEdits[number]>();
    for (const e of cellTextEdits(this.cellContext(s, cellId), edits ?? [])) {
      if (e.cellId === cellId) {
        here.push({
          range: {
            start: { line: e.range.startLineNumber - 1, character: e.range.startColumn - 1 },
            end: { line: e.range.endLineNumber - 1, character: e.range.endColumn - 1 },
          },
          newText: e.text,
        });
        continue;
      }
      const key = e.uri.toString();
      const entry = others.get(key) ?? [key, []];
      entry[1].push({ range: e.range, text: e.text });
      others.set(key, entry);
    }
    return { here, elsewhere: [...others.values()] };
  }

  /** A server's edits to a joined document, made in its cells; false: not a notebook's. */
  private applyJoinedEdits(uri: string, edits: lsp.TextEdit[]): boolean {
    const path = uriToPath(uri);
    const s = path && [...this.sessions.values()].find((x) => pathKey(x.path) === pathKey(path));
    if (!s) return false;
    // No cell has the id "": every edit is another cell's.
    applyCellEdits(this.splitEdits(s, "", edits).elsewhere);
    return true;
  }

  private sessionFor(client: LanguageClient, model: monaco.editor.ITextModel) {
    if (model.uri.scheme !== "notebook-cell" || client.state !== "running") return null;
    const cellId = CELL_ID.exec(model.uri.path)?.[1];
    if (!cellId) return null;
    for (const s of this.sessions.values())
      if (s.client === client && this.owns(s, model)) {
        this.flush(s);
        return s.doc.has(cellId) ? { s, cellId } : null;
      }
    return null;
  }

  private at(s: Session, cellId: string, position: monaco.IPosition) {
    const p = s.doc.toConcat(cellId, position.lineNumber - 1, position.column - 1);
    return p ? { textDocument: { uri: pathToUri(s.path) }, position: p } : null;
  }

  /** A cell's model URI (its editor is made when it has none yet). */
  private cellUri(s: Session, cellId: string): monaco.Uri | null {
    const doc = s.source.documentFor(cellId) as MonacoDocument | null;
    return doc?.model && !doc.model.isDisposed() ? doc.model.uri : null;
  }

  /** A server location → the cell's (or a file's) URI and range. */
  private place(
    s: Session,
    uri: string,
    range: lsp.Range,
  ): { uri: monaco.Uri; range: monaco.IRange } | null {
    if (pathKey(uriToPath(uri) ?? "") !== pathKey(s.path))
      return { uri: toUri(uri), range: toRange(range) };
    const mapped = s.doc.rangeFromConcat(range);
    if (!mapped) return null;
    const cell = this.cellUri(s, mapped.cellId);
    return cell ? { uri: cell, range: toRange(mapped.range) } : null;
  }

  /** A range in the joined document, if it's inside `cellId` (else null). */
  private inCell(s: Session, cellId: string, range: lsp.Range): monaco.IRange | null {
    const mapped = s.doc.rangeFromConcat(range);
    return mapped && mapped.cellId === cellId ? toRange(mapped.range) : null;
  }

  private providers(client: LanguageClient): monaco.IDisposable[] {
    const languages = [...client.options.languages];
    const caps = client.capabilities;
    const out: monaco.IDisposable[] = [];
    const quiet = <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);
    if (caps.completionProvider) {
      out.push(
        monaco.languages.registerCompletionItemProvider(languages, {
          triggerCharacters: caps.completionProvider.triggerCharacters,
          provideCompletionItems: async (model, position, context, token) => {
            const found = this.sessionFor(client, model);
            const params = found && this.at(found.s, found.cellId, position);
            if (!found || !params) return null;
            const word = model.getWordUntilPosition(position);
            const range = new monaco.Range(
              position.lineNumber,
              word.startColumn,
              position.lineNumber,
              word.endColumn,
            );
            const result = await quiet(
              client.request<lsp.CompletionList | lsp.CompletionItem[] | null>(
                "textDocument/completion",
                {
                  ...params,
                  context: {
                    triggerKind: context.triggerKind + 1,
                    ...(context.triggerCharacter && { triggerCharacter: context.triggerCharacter }),
                  },
                },
                tokenFor(token),
              ),
              null,
            );
            if (!result) return null;
            const items = Array.isArray(result) ? result : result.items;
            const { s, cellId } = found;
            const local = (r: lsp.Range) => {
              const m = s.doc.rangeFromConcat(r);
              return m && m.cellId === cellId ? m.range : null;
            };
            return {
              suggestions: items.map((item) => {
                // Edits in the joined document's terms → the cell's; an edit in another cell
                // (an auto-import at the top) can't be applied from here and is left out.
                let textEdit = item.textEdit;
                if (textEdit) {
                  if ("range" in textEdit) {
                    const r = local(textEdit.range);
                    textEdit = r ? { ...textEdit, range: r } : undefined;
                  } else {
                    const ins = local(textEdit.insert);
                    const rep = local(textEdit.replace);
                    textEdit = ins && rep ? { ...textEdit, insert: ins, replace: rep } : undefined;
                  }
                }
                const extra = this.splitEdits(s, cellId, item.additionalTextEdits);
                const converted: CellCompletion = toCompletion(
                  {
                    ...item,
                    ...(textEdit ? { textEdit } : { textEdit: undefined }),
                    ...(item.textEdit && !textEdit && { insertText: item.textEdit.newText }),
                    additionalTextEdits: extra.here,
                  },
                  range,
                );
                // Edits in another cell (an auto-import in the first one) are made there (D229).
                if (extra.elsewhere.length)
                  converted.command = {
                    id: CELL_EDITS_COMMAND,
                    title: "",
                    arguments: [extra.elsewhere],
                  };
                converted.cell = { s, cellId };
                return converted;
              }),
              incomplete: !Array.isArray(result) && result.isIncomplete,
            };
          },
          resolveCompletionItem: caps.completionProvider.resolveProvider
            ? async (item, token) => {
                const original = (item as MonacoCompletion).lsp;
                if (!original) return item;
                const r = await quiet(
                  client.request<lsp.CompletionItem>(
                    "completionItem/resolve",
                    original,
                    tokenFor(token),
                  ),
                  null,
                );
                if (!r) return item;
                // Pyright gives an auto-import's edits on resolve: this cell's, and the others'.
                const cell = (item as CellCompletion).cell;
                const extra =
                  cell && r.additionalTextEdits?.length && !original.additionalTextEdits?.length
                    ? this.splitEdits(cell.s, cell.cellId, r.additionalTextEdits)
                    : null;
                return {
                  ...item,
                  detail: r.detail ?? item.detail,
                  documentation: toMarkdown(r.documentation) ?? item.documentation,
                  ...(extra && { additionalTextEdits: extra.here.map(toTextEdit) }),
                  ...(extra?.elsewhere.length && {
                    command: { id: CELL_EDITS_COMMAND, title: "", arguments: [extra.elsewhere] },
                  }),
                };
              }
            : undefined,
        }),
      );
    }
    if (caps.hoverProvider)
      out.push(
        monaco.languages.registerHoverProvider(languages, {
          provideHover: async (model, position, token) => {
            const found = this.sessionFor(client, model);
            const params = found && this.at(found.s, found.cellId, position);
            if (!found || !params) return null;
            const h = await quiet(
              client.request<lsp.Hover | null>("textDocument/hover", params, tokenFor(token)),
              null,
            );
            const hover = toHover(h ? { ...h, range: undefined } : null);
            if (!hover) return null;
            const range = h?.range ? this.inCell(found.s, found.cellId, h.range) : null;
            return range ? { ...hover, range } : hover;
          },
        }),
      );
    if (caps.signatureHelpProvider)
      out.push(
        monaco.languages.registerSignatureHelpProvider(languages, {
          signatureHelpTriggerCharacters: caps.signatureHelpProvider.triggerCharacters,
          signatureHelpRetriggerCharacters: caps.signatureHelpProvider.retriggerCharacters,
          provideSignatureHelp: async (model, position, token) => {
            const found = this.sessionFor(client, model);
            const params = found && this.at(found.s, found.cellId, position);
            if (!found || !params) return null;
            const r = await quiet(
              client.request<lsp.SignatureHelp | null>(
                "textDocument/signatureHelp",
                params,
                tokenFor(token),
              ),
              null,
            );
            if (!r?.signatures.length) return null;
            return {
              value: {
                signatures: r.signatures.map((sig) => ({
                  label: sig.label,
                  documentation: toMarkdown(sig.documentation),
                  parameters: (sig.parameters ?? []).map((p) => ({
                    label: p.label,
                    documentation: toMarkdown(p.documentation),
                  })),
                  activeParameter: sig.activeParameter,
                })),
                activeSignature: r.activeSignature ?? 0,
                activeParameter: r.activeParameter ?? 0,
              },
              dispose: () => {},
            };
          },
        }),
      );
    const locations =
      (method: string) =>
      async (
        model: monaco.editor.ITextModel,
        position: monaco.Position,
        token: monaco.CancellationToken,
      ) => {
        const found = this.sessionFor(client, model);
        const params = found && this.at(found.s, found.cellId, position);
        if (!found || !params) return null;
        const r = await quiet(
          client.request<lsp.Location | lsp.Location[] | lsp.LocationLink[] | null>(
            method,
            method === "textDocument/references"
              ? { ...params, context: { includeDeclaration: true } }
              : params,
            tokenFor(token),
          ),
          null,
        );
        const list = !r ? [] : Array.isArray(r) ? r : [r];
        const out: monaco.languages.Location[] = [];
        for (const l of list) {
          const placed =
            "targetUri" in l
              ? this.place(found.s, l.targetUri, l.targetSelectionRange ?? l.targetRange)
              : this.place(found.s, l.uri, l.range);
          if (placed) out.push(placed);
        }
        return out;
      };
    if (caps.definitionProvider)
      out.push(
        monaco.languages.registerDefinitionProvider(languages, {
          provideDefinition: locations("textDocument/definition"),
        }),
      );
    if (caps.typeDefinitionProvider)
      out.push(
        monaco.languages.registerTypeDefinitionProvider(languages, {
          provideTypeDefinition: locations("textDocument/typeDefinition"),
        }),
      );
    if (caps.referencesProvider)
      out.push(
        monaco.languages.registerReferenceProvider(languages, {
          provideReferences: (model, position, _context, token) =>
            locations("textDocument/references")(model, position, token),
        }),
      );
    if (caps.documentHighlightProvider)
      out.push(
        monaco.languages.registerDocumentHighlightProvider(languages, {
          provideDocumentHighlights: async (model, position, token) => {
            const found = this.sessionFor(client, model);
            const params = found && this.at(found.s, found.cellId, position);
            if (!found || !params) return null;
            const r = await quiet(
              client.request<{ range: lsp.Range; kind?: number }[] | null>(
                "textDocument/documentHighlight",
                params,
                tokenFor(token),
              ),
              null,
            );
            return (r ?? []).flatMap((hl) => {
              const range = this.inCell(found.s, found.cellId, hl.range);
              return range ? [{ range, kind: hl.kind ? hl.kind - 1 : undefined }] : [];
            });
          },
        }),
      );
    if (caps.renameProvider)
      out.push(
        monaco.languages.registerRenameProvider(languages, {
          resolveRenameLocation: async (model, position, token) => {
            const found = this.sessionFor(client, model);
            const params = found && this.at(found.s, found.cellId, position);
            // Not a cell of ours: the next provider answers.
            if (!found || !params) return null as never;
            const prepare =
              typeof caps.renameProvider === "object" && caps.renameProvider.prepareProvider;
            if (!prepare) {
              const word = model.getWordAtPosition(position);
              if (!word)
                return {
                  range: new monaco.Range(1, 1, 1, 1),
                  text: "",
                  rejectReason: "You can't rename this.",
                };
              return {
                range: new monaco.Range(
                  position.lineNumber,
                  word.startColumn,
                  position.lineNumber,
                  word.endColumn,
                ),
                text: word.word,
              };
            }
            const r = await client
              .request<lsp.Range | { range: lsp.Range; placeholder: string } | null>(
                "textDocument/prepareRename",
                params,
                tokenFor(token),
              )
              .catch(() => null);
            const lspRange = r && ("placeholder" in r ? r.range : r);
            const range = lspRange ? this.inCell(found.s, found.cellId, lspRange) : null;
            if (!r || !range)
              return {
                range: new monaco.Range(1, 1, 1, 1),
                text: "",
                rejectReason: "You can't rename this.",
              };
            return {
              range,
              text: "placeholder" in r ? r.placeholder : model.getValueInRange(range),
            };
          },
          provideRenameEdits: async (model, position, newName, token) => {
            const found = this.sessionFor(client, model);
            const params = found && this.at(found.s, found.cellId, position);
            if (!found || !params) return null as never;
            const r = await client.request<lsp.WorkspaceEdit | null>(
              "textDocument/rename",
              { ...params, newName },
              tokenFor(token),
            );
            const edits: monaco.languages.IWorkspaceTextEdit[] = [];
            const add = (uri: string, list: lsp.TextEdit[]) => {
              for (const e of list) {
                const placed = this.place(found.s, uri, e.range);
                // A file that isn't open can't take an edit from here (the cells and open files
                // are renamed; VS Code opens the others, which a notebook rename rarely needs).
                if (placed && (placed.uri.scheme !== "file" || monaco.editor.getModel(placed.uri)))
                  edits.push({
                    resource: placed.uri,
                    textEdit: { range: placed.range, text: e.newText },
                    versionId: undefined,
                  });
              }
            };
            for (const [uri, list] of Object.entries(r?.changes ?? {})) add(uri, list);
            for (const change of r?.documentChanges ?? [])
              if ("textDocument" in change) add(change.textDocument.uri, change.edits);
            return { edits };
          },
        }),
      );
    // Code actions, formatting, inlay hints, semantic tokens (D229).
    out.push(...cellProviders(client, this));
    return out;
  }
}
