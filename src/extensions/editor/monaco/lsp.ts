// Connects one language client to Monaco: document sync for its languages, diagnostics as markers,
// and providers for what the server advertises (completion, hover, signature help, definition,
// declaration, type definition, implementation, references, highlights, symbols, formatting,
// rename, and since D199 code actions, code lens, inlay hints, semantic tokens, folding, selection
// ranges and links; document colors since the hierarchy view). Edits the server sends (workspace/applyEdit) and edits to files that aren't
// open land in documents (opened, left unsaved for review), never straight on disk.
import type { LanguageClient } from "../../../core/lsp/client";
import { colorProviderLanguages, validColors, validPresentations } from "../../../core/lsp/colors";
import { type CancelToken, cancelSource } from "../../../core/lsp/jsonrpc";
import type * as lsp from "../../../core/lsp/types";
import { pathToUri, uriToPath } from "../../../core/lsp/uri";
import type { EngineHost } from "../engine";
import { LANGUAGE_SERVERS_FORMATTER } from "../formatterChoice";
import * as monaco from "./core";
import { serverProvidesSymbols } from "./fallbackSymbols";
import { formatterOwnedBy } from "./formatterChoice";
import { isKeptClosed, onDidChangeKeptClosed } from "./keptClosed";
import { builtinCompletions, replaceBuiltinTypeScript } from "./languageFeatures";
import {
  fromRange,
  type MonacoCompletion,
  toCompletion,
  toHover,
  toLocations,
  toMarkdown,
  toMarker,
  toPosition,
  toRange,
  toSymbols,
  toTextEdit,
  toWorkspaceEdit,
} from "./lspConvert";
import { addSemanticTokens, setFileMarkers, WorkspacePull } from "./lspPull";
import { ensureModels, isPeekOnly } from "./peek";

const CHANGE_DELAY_MS = 80;
/** After a change reaches a server, how long before its diagnostics are pulled (D200). */
const PULL_DELAY_MS = 250;

function tokenFor(t: monaco.CancellationToken): CancelToken {
  const source = cancelSource();
  t.onCancellationRequested(() => source.cancel());
  return source;
}

export function attachLanguageClient(
  client: LanguageClient,
  host: EngineHost,
  /** Paths that are a notebook's cells as one document: their problems go to the cells. */
  isNotebookDocument?: (path: string) => boolean,
): monaco.IDisposable {
  const disposables: monaco.IDisposable[] = [];
  const languages = [...client.options.languages];
  const owner = `lsp:${client.options.id}`;
  const timers = new Map<monaco.editor.ITextModel, ReturnType<typeof setTimeout>>();
  const pendingMarkers = new Map<string, lsp.Diagnostic[]>();
  // Each synced model's listeners: disposed with the attachment too, or every server restart
  // (a new attachment) would leave another set behind, still sending to the stopped client.
  const modelSubs = new Map<monaco.editor.ITextModel, monaco.IDisposable[]>();
  const caps = client.capabilities;
  // A closed file's model kept for undo is closed for the server too (D218).
  const handled = (model: monaco.editor.ITextModel) =>
    model.uri.scheme === "file" &&
    client.handles(model.getLanguageId()) &&
    !isPeekOnly(model) &&
    !isKeptClosed(model);

  // ---- Document sync ----
  // Pull diagnostics (D200): a server with diagnosticProvider is asked after each change it got.
  const pullTimers = new Map<monaco.editor.ITextModel, ReturnType<typeof setTimeout>>();
  // Workspace pull diagnostics (D204): every file's problems, shown for files that aren't open.
  const workspacePull = caps.diagnosticProvider?.workspaceDiagnostics
    ? new WorkspacePull(client)
    : null;
  if (workspacePull) disposables.push(workspacePull);
  // The latest request per model: an older answer arriving late doesn't overwrite a newer one.
  const pullSeq = new WeakMap<monaco.editor.ITextModel, number>();
  const pull = (model: monaco.editor.ITextModel) => {
    if (!caps.diagnosticProvider) return;
    clearTimeout(pullTimers.get(model));
    pullTimers.set(
      model,
      setTimeout(() => {
        pullTimers.delete(model);
        if (model.isDisposed() || client.state !== "running") return;
        const path = model.uri.fsPath;
        const seq = (pullSeq.get(model) ?? 0) + 1;
        pullSeq.set(model, seq);
        void client
          .request<{ kind: "full" | "unchanged"; items?: lsp.Diagnostic[] } | null>(
            "textDocument/diagnostic",
            {
              textDocument: { uri: pathToUri(path) },
              ...(caps.diagnosticProvider?.identifier && {
                identifier: caps.diagnosticProvider.identifier,
              }),
            },
          )
          .then((r) => {
            if (!r || r.kind !== "full" || model.isDisposed() || pullSeq.get(model) !== seq) return;
            const items = r.items ?? [];
            pendingMarkers.set(path, items);
            monaco.editor.setModelMarkers(
              model,
              owner,
              items.map((d) => toMarker(d, client.options.id)),
            );
          })
          .catch(() => {});
      }, PULL_DELAY_MS),
    );
  };
  const flush = (model: monaco.editor.ITextModel) => {
    const timer = timers.get(model);
    if (timer === undefined) return;
    clearTimeout(timer);
    timers.delete(model);
    client.didChange(model.uri.fsPath, model.getValue());
    pull(model);
    // Other files' problems may follow from this one's (interFileDependencies).
    workspacePull?.schedule();
  };
  // didSave (D218): the edit before the save goes first, and the saved text with it when the
  // server asks for it (save.includeText).
  const flushDocument = (path: string): string | undefined => {
    const model = monaco.editor.getModel(monaco.Uri.file(path));
    if (!model || !client.isOpen(model.uri.fsPath)) return undefined;
    flush(model);
    return model.getValue();
  };
  client.flushDocument = flushDocument;
  // A document the server lost (D380): opened there again with the editor's text, so requests
  // about it stop failing (completions, hovers, symbols all said "Unexpected resource").
  disposables.push(
    client.onDocumentLost((path) => {
      const model = monaco.editor.getModel(monaco.Uri.file(path));
      if (model && !model.isDisposed() && handled(model))
        client.didOpen(path, model.getLanguageId(), model.getValue());
    }),
  );
  disposables.push({
    dispose: () => {
      if (client.flushDocument === flushDocument) client.flushDocument = undefined;
    },
  });
  const open = (model: monaco.editor.ITextModel) => {
    const path = model.uri.fsPath;
    // Open for one request only (lsp/index.ts withDoc, from disk): the editor takes it over.
    if (!handled(model) || (client.isOpen(path) && !client.isOpenTemporarily(path))) return;
    client.didOpen(path, model.getLanguageId(), model.getValue());
    workspacePull?.openChanged(model.uri.fsPath, true);
    pull(model);
    const markers = pendingMarkers.get(model.uri.fsPath);
    if (markers)
      monaco.editor.setModelMarkers(
        model,
        owner,
        markers.map((d) => toMarker(d, client.options.id)),
      );
    const subs = [
      model.onDidChangeContent(() => {
        clearTimeout(timers.get(model));
        timers.set(
          model,
          setTimeout(() => flush(model), CHANGE_DELAY_MS),
        );
      }),
      model.onWillDispose(() => {
        clearTimeout(timers.get(model));
        timers.delete(model);
        client.didClose(model.uri.fsPath);
        if (workspacePull) {
          // Markers outlive their model: the workspace report takes the closed file over.
          monaco.editor.setModelMarkers(model, owner, []);
          workspacePull.openChanged(model.uri.fsPath, false);
        }
        for (const s of subs) s.dispose();
        modelSubs.delete(model);
      }),
    ];
    modelSubs.set(model, subs);
  };
  /** The model leaves this server (didClose); `clear`: its markers from this server go too. */
  const close = (model: monaco.editor.ITextModel, clear: boolean) => {
    if (!client.isOpen(model.uri.fsPath)) return;
    // An edit not yet sent goes first (the server's copy matches the file it closes).
    if (timers.has(model)) flush(model);
    clearTimeout(pullTimers.get(model));
    pullTimers.delete(model);
    client.didClose(model.uri.fsPath);
    if (clear) monaco.editor.setModelMarkers(model, owner, []);
    workspacePull?.openChanged(model.uri.fsPath, false);
    for (const s of modelSubs.get(model) ?? []) s.dispose();
    modelSubs.delete(model);
  };
  for (const model of monaco.editor.getModels()) open(model);
  disposables.push(monaco.editor.onDidCreateModel(open));
  // A model's language changed (Change language mode, files.associations, D201): it joins this
  // server, or leaves it.
  disposables.push(
    monaco.editor.onDidChangeModelLanguage(({ model }) => {
      if (handled(model)) open(model);
      else close(model, true);
    }),
  );
  // A file closed with its model kept for undo is closed for the server (VS Code disposes the
  // model): what the server reports for closed files (its workspace problems, a push after
  // didClose) is what Problems lists for it; it's opened again when the file is (D218).
  disposables.push(
    onDidChangeKeptClosed(({ model, kept }) => {
      if (!kept) open(model);
      // As when a model is disposed: the push markers stay (the server clears them if it
      // wants), unless the workspace report takes the closed file over.
      else close(model, !!workspacePull);
    }),
  );
  /** Files with this server's problems and no model (a push for a file that isn't open). */
  const fileMarkers = new Set<string>();
  disposables.push({
    dispose: () => {
      for (const model of monaco.editor.getModels()) {
        if (client.isOpen(model.uri.fsPath)) monaco.editor.setModelMarkers(model, owner, []);
      }
      for (const t of timers.values()) clearTimeout(t);
      for (const t of pullTimers.values()) clearTimeout(t);
      for (const subs of modelSubs.values()) for (const s of subs) s.dispose();
      modelSubs.clear();
    },
  });

  // ---- Diagnostics ----
  const diagSub = client.onDiagnostics(({ path, diagnostics }) => {
    if (diagnostics.length) pendingMarkers.set(path, diagnostics);
    else pendingMarkers.delete(path);
    const resource = monaco.Uri.file(path);
    const markers = diagnostics.map((d) => toMarker(d, client.options.id));
    const model = monaco.editor.getModel(resource);
    if (model) monaco.editor.setModelMarkers(model, owner, markers);
    else if (isNotebookDocument?.(path)) {
      // The notebook hub maps these to the cells (notebookLsp.ts); not a file of its own.
    } else {
      // A file that isn't open (rust-analyzer's cargo check, pyright's workspace mode): listed
      // in Problems all the same, as in VS Code.
      setFileMarkers(owner, resource, markers);
      if (markers.length) fileMarkers.add(path);
      else fileMarkers.delete(path);
    }
  });
  disposables.push({
    dispose: () => {
      diagSub.dispose();
      for (const path of fileMarkers) setFileMarkers(owner, monaco.Uri.file(path), []);
      fileMarkers.clear();
    },
  });

  /** textDocument + position params, after sending any pending change. */
  const at = (model: monaco.editor.ITextModel, position: monaco.IPosition) => {
    flush(model);
    return { textDocument: { uri: pathToUri(model.uri.fsPath) }, position: toPosition(position) };
  };
  const doc = (model: monaco.editor.ITextModel) => {
    flush(model);
    return { textDocument: { uri: pathToUri(model.uri.fsPath) } };
  };
  const ok = (model: monaco.editor.ITextModel) => handled(model) && client.state === "running";
  const quiet = <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

  // ---- Providers ----
  if (caps.completionProvider) {
    const resolve = caps.completionProvider.resolveProvider;
    disposables.push(
      monaco.languages.registerCompletionItemProvider(languages, {
        triggerCharacters: caps.completionProvider.triggerCharacters,
        provideCompletionItems: async (model, position, context, token) => {
          if (!ok(model)) return null;
          const word = model.getWordUntilPosition(position);
          const range = new monaco.Range(
            position.lineNumber,
            word.startColumn,
            position.lineNumber,
            word.endColumn,
          );
          let failed = false;
          const result = await client
            .request<lsp.CompletionList | lsp.CompletionItem[] | null>(
              "textDocument/completion",
              {
                ...at(model, position),
                context: {
                  triggerKind: context.triggerKind + 1,
                  ...(context.triggerCharacter
                    ? { triggerCharacter: context.triggerCharacter }
                    : {}),
                },
              },
              tokenFor(token),
            )
            .catch(() => {
              failed = true;
              return null;
            });
          // The TypeScript server failed this one (still loading, a lost document): the built-in
          // service answers instead of nothing (D380; it's silent while a server runs, D379).
          if (failed && languages.includes("typescript") && !token.isCancellationRequested)
            return builtinCompletions(model, position, context, token);
          if (!result) return null;
          const items = Array.isArray(result) ? result : result.items;
          return {
            suggestions: items.map((i) => toCompletion(i, range)),
            incomplete: !Array.isArray(result) && result.isIncomplete,
          };
        },
        resolveCompletionItem: resolve
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
              return {
                ...item,
                detail: r.detail ?? item.detail,
                documentation: toMarkdown(r.documentation) ?? item.documentation,
                additionalTextEdits:
                  r.additionalTextEdits?.map(toTextEdit) ?? item.additionalTextEdits,
              };
            }
          : undefined,
      }),
    );
  }
  if (caps.hoverProvider) {
    disposables.push(
      monaco.languages.registerHoverProvider(languages, {
        provideHover: async (model, position, token) =>
          ok(model)
            ? toHover(
                await quiet(
                  client.request<lsp.Hover | null>(
                    "textDocument/hover",
                    at(model, position),
                    tokenFor(token),
                  ),
                  null,
                ),
              )
            : null,
      }),
    );
  }
  if (caps.signatureHelpProvider) {
    disposables.push(
      monaco.languages.registerSignatureHelpProvider(languages, {
        signatureHelpTriggerCharacters: caps.signatureHelpProvider.triggerCharacters,
        signatureHelpRetriggerCharacters: caps.signatureHelpProvider.retriggerCharacters,
        provideSignatureHelp: async (model, position, token) => {
          if (!ok(model)) return null;
          const r = await quiet(
            client.request<lsp.SignatureHelp | null>(
              "textDocument/signatureHelp",
              at(model, position),
              tokenFor(token),
            ),
            null,
          );
          if (!r?.signatures.length) return null;
          return {
            value: {
              signatures: r.signatures.map((s) => ({
                label: s.label,
                documentation: toMarkdown(s.documentation),
                parameters: (s.parameters ?? []).map((p) => ({
                  label: p.label,
                  documentation: toMarkdown(p.documentation),
                })),
                activeParameter: s.activeParameter,
              })),
              activeSignature: r.activeSignature ?? 0,
              activeParameter: r.activeParameter ?? 0,
            },
            dispose: () => {},
          };
        },
      }),
    );
  }
  const locations =
    (method: string) =>
    async (
      model: monaco.editor.ITextModel,
      position: monaco.Position,
      token: monaco.CancellationToken,
    ) => {
      if (!ok(model)) return null;
      const links = toLocations(
        await quiet(
          client.request<lsp.Location[] | null>(method, at(model, position), tokenFor(token)),
          null,
        ),
      );
      await ensureModels(
        host,
        links.map((l) => l.uri.fsPath),
      );
      return links;
    };
  if (caps.definitionProvider)
    disposables.push(
      monaco.languages.registerDefinitionProvider(languages, {
        provideDefinition: locations("textDocument/definition"),
      }),
    );
  if (caps.typeDefinitionProvider)
    disposables.push(
      monaco.languages.registerTypeDefinitionProvider(languages, {
        provideTypeDefinition: locations("textDocument/typeDefinition"),
      }),
    );
  if (caps.implementationProvider)
    disposables.push(
      monaco.languages.registerImplementationProvider(languages, {
        provideImplementation: locations("textDocument/implementation"),
      }),
    );
  if (caps.referencesProvider) {
    disposables.push(
      monaco.languages.registerReferenceProvider(languages, {
        provideReferences: async (model, position, context, token) => {
          if (!ok(model)) return null;
          const r = await quiet(
            client.request<lsp.Location[] | null>(
              "textDocument/references",
              { ...at(model, position), context },
              tokenFor(token),
            ),
            null,
          );
          const list = toLocations(r);
          await ensureModels(
            host,
            list.map((l) => l.uri.fsPath),
          );
          return list;
        },
      }),
    );
  }
  if (caps.documentHighlightProvider) {
    disposables.push(
      monaco.languages.registerDocumentHighlightProvider(languages, {
        provideDocumentHighlights: async (model, position, token) => {
          if (!ok(model)) return null;
          const r = await quiet(
            client.request<{ range: lsp.Range; kind?: number }[] | null>(
              "textDocument/documentHighlight",
              at(model, position),
              tokenFor(token),
            ),
            null,
          );
          return (r ?? []).map((h) => ({
            range: toRange(h.range),
            kind: ((h.kind ?? 1) - 1) as monaco.languages.DocumentHighlightKind,
          }));
        },
      }),
    );
  }
  if (caps.documentSymbolProvider) {
    disposables.push(serverProvidesSymbols(languages));
    disposables.push(
      monaco.languages.registerDocumentSymbolProvider(languages, {
        displayName: client.options.id,
        provideDocumentSymbols: async (model, token) =>
          ok(model)
            ? toSymbols(
                await quiet(
                  client.request<lsp.DocumentSymbol[] | null>(
                    "textDocument/documentSymbol",
                    doc(model),
                    tokenFor(token),
                  ),
                  null,
                ),
              )
            : null,
      }),
    );
  }
  // Formatting picks one provider: files only, so a notebook cell gets its own (notebookLspRich.ts).
  const fileLanguages = languages.map((language) => ({ language, scheme: "file" }));
  // The language servers are one owner for editor.defaultFormatter (formatterChoice.ts).
  if (caps.documentFormattingProvider) {
    disposables.push(
      monaco.languages.registerDocumentFormattingEditProvider(fileLanguages, {
        ...formatterOwnedBy({}, LANGUAGE_SERVERS_FORMATTER),
        displayName: `Language servers (${client.options.id})`,
        provideDocumentFormattingEdits: async (model, options, token) => {
          if (!ok(model)) return null;
          const r = await client.request<lsp.TextEdit[] | null>(
            "textDocument/formatting",
            {
              ...doc(model),
              options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
            },
            tokenFor(token),
          );
          return (r ?? []).map(toTextEdit);
        },
      }),
    );
  }
  if (caps.documentRangeFormattingProvider) {
    disposables.push(
      monaco.languages.registerDocumentRangeFormattingEditProvider(fileLanguages, {
        ...formatterOwnedBy({}, LANGUAGE_SERVERS_FORMATTER),
        displayName: `Language servers (${client.options.id})`,
        provideDocumentRangeFormattingEdits: async (model, range, options, token) => {
          if (!ok(model)) return null;
          const r = await client.request<lsp.TextEdit[] | null>(
            "textDocument/rangeFormatting",
            {
              ...doc(model),
              range: fromRange(range),
              options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
            },
            tokenFor(token),
          );
          return (r ?? []).map(toTextEdit);
        },
      }),
    );
  }
  if (caps.renameProvider) {
    disposables.push(
      monaco.languages.registerRenameProvider(languages, {
        resolveRenameLocation:
          typeof caps.renameProvider === "object" && caps.renameProvider.prepareProvider
            ? async (model, position, token) => {
                // Not a file of this server (a notebook cell, D204): the next provider answers.
                if (!ok(model)) return null as never;
                const r = await client
                  .request<lsp.Range | { range: lsp.Range; placeholder: string } | null>(
                    "textDocument/prepareRename",
                    at(model, position),
                    tokenFor(token),
                  )
                  .catch(() => undefined);
                if (r === undefined) return null as never;
                if (!r)
                  return {
                    range: new monaco.Range(1, 1, 1, 1),
                    text: "",
                    rejectReason: "You can't rename this.",
                  };
                const range = "placeholder" in r ? r.range : r;
                const text =
                  "placeholder" in r ? r.placeholder : model.getValueInRange(toRange(range));
                return { range: toRange(range), text };
              }
            : undefined,
        provideRenameEdits: async (model, position, newName, token) => {
          if (!ok(model)) return null as never;
          const r = await client.request<lsp.WorkspaceEdit | null>(
            "textDocument/rename",
            { ...at(model, position), newName },
            tokenFor(token),
          );
          const edit = toWorkspaceEdit(r);
          // Edits land in documents; files that aren't open are opened (dirty) so nothing is lost.
          await host.openDocuments([
            ...new Set(
              edit.edits.map((e) => (e as monaco.languages.IWorkspaceTextEdit).resource.fsPath),
            ),
          ]);
          return edit;
        },
      }),
    );
  }
  addRichProviders(client, host, languages, disposables, {
    ok,
    at,
    doc,
    quiet,
    owner,
    pendingMarkers,
  });
  // A project-wide TypeScript server replaces Monaco's own (D199).
  if (languages.includes("typescript")) {
    disposables.push(replaceBuiltinTypeScript());
  }
  // editor.codeActionsOnSave (D200): run here, awaited, so the save writes the result.
  const runner = async (
    model: monaco.editor.ITextModel,
    kinds: readonly string[],
    deadline: number,
  ) => {
    if (!ok(model) || !caps.codeActionProvider) return;
    const offered =
      typeof caps.codeActionProvider === "object"
        ? caps.codeActionProvider.codeActionKinds
        : undefined;
    const resolvable =
      typeof caps.codeActionProvider === "object" && caps.codeActionProvider.resolveProvider;
    for (const kind of kinds) {
      if (
        offered &&
        !offered.some((k) => k === kind || kind.startsWith(`${k}.`) || k.startsWith(`${kind}.`))
      )
        continue;
      if (Date.now() > deadline) return;
      const last = model.getLineCount();
      // Edits for this text only: typing meanwhile, or the save going ahead (timed out), drops them.
      const version = model.getVersionId();
      const result = await quiet(
        client.request<(lsp.CodeAction | lsp.Command)[] | null>("textDocument/codeAction", {
          ...doc(model),
          range: {
            start: { line: 0, character: 0 },
            end: { line: last - 1, character: model.getLineMaxColumn(last) - 1 },
          },
          context: { diagnostics: [], only: [kind], triggerKind: 2 },
        }),
        null,
      );
      const action = (result ?? []).find(
        (a): a is lsp.CodeAction =>
          "title" in a &&
          typeof (a as lsp.CodeAction).kind === "string" &&
          ((a as lsp.CodeAction).kind === kind ||
            ((a as lsp.CodeAction).kind ?? "").startsWith(`${kind}.`)),
      );
      if (!action) continue;
      const full =
        !action.edit && resolvable
          ? await quiet(client.request<lsp.CodeAction>("codeAction/resolve", action), action)
          : action;
      if (!full.edit || model.isDisposed() || model.getVersionId() !== version) continue;
      if (Date.now() > deadline) return;
      await applyWorkspaceEdit(host, full.edit, client).catch(() => false);
    }
  };
  onSaveRunners.set(client, runner);
  disposables.push({ dispose: () => onSaveRunners.delete(client) });
  return { dispose: () => disposables.forEach((d) => void d.dispose()) };
}

/** Each attached client's code-actions-on-save runner (D200). */
const onSaveRunners = new Map<
  LanguageClient,
  (model: monaco.editor.ITextModel, kinds: readonly string[], deadline: number) => Promise<void>
>();

/**
 * Runs `kinds` ("source.organizeImports", "source.fixAll") from every language server of the
 * model's language, one after another, applying each edit before the next (D200).
 */
export async function runCodeActionsOnSave(
  model: monaco.editor.ITextModel,
  kinds: readonly string[],
  timeoutMs = 3000,
): Promise<void> {
  // Past the deadline nothing more is applied: the save has gone ahead without it.
  const deadline = Date.now() + timeoutMs;
  for (const [client, run] of onSaveRunners)
    if (client.handles(model.getLanguageId())) await run(model, kinds, deadline);
}

/**
 * Edits to a notebook's joined document (D229): the notebook binding applies them to the cells
 * and says it did (true), so they don't go to a file of that name.
 */
type JoinedEditHandler = (uri: string, edits: lsp.TextEdit[]) => boolean;
let joinedEditHandler: JoinedEditHandler | null = null;

export function setJoinedEditHandler(handler: JoinedEditHandler): monaco.IDisposable {
  joinedEditHandler = handler;
  return {
    dispose: () => {
      if (joinedEditHandler === handler) joinedEditHandler = null;
    },
  };
}

/** `edit` without the parts the notebook binding applied to cells. */
function withoutJoinedEdits(edit: lsp.WorkspaceEdit): lsp.WorkspaceEdit {
  const handle = joinedEditHandler;
  if (!handle) return edit;
  return {
    ...(edit.changes && {
      changes: Object.fromEntries(
        Object.entries(edit.changes).filter(([uri, list]) => !handle(uri, list)),
      ),
    }),
    ...(edit.documentChanges && {
      documentChanges: edit.documentChanges.filter(
        (c) => !("textDocument" in c) || !handle(c.textDocument.uri, c.edits),
      ),
    }),
  };
}

/** Applies a workspace edit to documents (files that aren't open are opened first). */
export async function applyWorkspaceEdit(
  host: EngineHost,
  edit: lsp.WorkspaceEdit | null | undefined,
  client?: LanguageClient,
): Promise<boolean> {
  // An edit made for an older version of a document would land on the wrong text: refuse it.
  if (client)
    for (const change of edit?.documentChanges ?? []) {
      if (!("textDocument" in change)) continue;
      const version = (change.textDocument as { version?: number | null }).version;
      const path = uriToPath(change.textDocument.uri);
      if (version == null || !path || !client.isOpen(path)) continue;
      if (client.versionOf(path) !== version) return false;
    }
  const converted = toWorkspaceEdit(edit ? withoutJoinedEdits(edit) : null);
  const byFile = new Map<string, monaco.languages.IWorkspaceTextEdit[]>();
  for (const e of converted.edits as monaco.languages.IWorkspaceTextEdit[]) {
    const list = byFile.get(e.resource.fsPath) ?? [];
    list.push(e);
    byFile.set(e.resource.fsPath, list);
  }
  if (!byFile.size) return !(edit?.documentChanges ?? []).some((c) => "kind" in c);
  await host.openDocuments([...byFile.keys()]);
  // All or nothing: every document is found before any is changed.
  const models = new Map<string, monaco.editor.ITextModel>();
  for (const path of byFile.keys()) {
    const model = monaco.editor.getModel(monaco.Uri.file(path));
    if (!model) return false;
    models.set(path, model);
  }
  for (const [path, list] of byFile) {
    const model = models.get(path);
    if (!model) return false;
    model.pushEditOperations(
      [],
      list.map((e) => ({ range: e.textEdit.range, text: e.textEdit.text })),
      () => null,
    );
  }
  return true;
}

interface Helpers {
  ok(model: monaco.editor.ITextModel): boolean;
  at(
    model: monaco.editor.ITextModel,
    position: monaco.IPosition,
  ): { textDocument: { uri: string }; position: lsp.Position };
  doc(model: monaco.editor.ITextModel): { textDocument: { uri: string } };
  quiet<T>(p: Promise<T>, fallback: T): Promise<T>;
  owner: string;
  pendingMarkers: Map<string, lsp.Diagnostic[]>;
}

let commandSeq = 0;

/** Code actions, code lens, inlay hints, semantic tokens, folding, selections, links (D199). */
function addRichProviders(
  client: LanguageClient,
  host: EngineHost,
  languages: string[],
  disposables: monaco.IDisposable[],
  h: Helpers,
): void {
  const caps = client.capabilities;
  const serverCommands = new Set(caps.executeCommandProvider?.commands ?? []);
  // A Monaco command that runs one of the server's commands (code actions' and lenses').
  const runCommand = `lsp.${client.options.id}.run.${++commandSeq}`;
  disposables.push(
    monaco.editor.registerCommand(runCommand, (_accessor, cmd: lsp.Command) => {
      if (!serverCommands.has(cmd.command)) {
        host.run("lsp.showLog", { server: client.options.id }).catch(() => {});
        return;
      }
      void client
        .request("workspace/executeCommand", { command: cmd.command, arguments: cmd.arguments })
        .catch(() => {});
    }),
  );
  const toCommand = (cmd: lsp.Command | undefined): monaco.languages.Command | undefined =>
    cmd ? { id: runCommand, title: cmd.title, arguments: [cmd] } : undefined;

  // The server's own edits (after a command, an organize imports…).
  client.connection.onRequest("workspace/applyEdit", async (p) => {
    const { edit } = p as { edit: lsp.WorkspaceEdit };
    return { applied: await applyWorkspaceEdit(host, edit, client).catch(() => false) };
  });

  const codeActions = caps.codeActionProvider;
  if (codeActions) {
    const resolve = typeof codeActions === "object" && codeActions.resolveProvider;
    const toAction = async (
      a: lsp.CodeAction | lsp.Command,
    ): Promise<monaco.languages.CodeAction> => {
      if ("command" in a && typeof a.command === "string")
        return { title: a.title, command: toCommand(a as lsp.Command) };
      const action = a as lsp.CodeAction;
      const files = toWorkspaceEdit(action.edit ?? null).edits.map(
        (e) => (e as monaco.languages.IWorkspaceTextEdit).resource.fsPath,
      );
      // Edits in files that aren't open: their documents are opened so the edit lands.
      if (files.length) await ensureModels(host, files);
      return {
        title: action.title,
        ...(action.kind && { kind: action.kind }),
        ...(action.isPreferred && { isPreferred: true }),
        ...(action.disabled && { disabled: action.disabled.reason }),
        ...(action.edit && { edit: toWorkspaceEdit(action.edit) }),
        ...(action.command && { command: toCommand(action.command) }),
        // Kept for resolving the edit when it's chosen.
        lsp: action,
      } as monaco.languages.CodeAction;
    };
    disposables.push(
      monaco.languages.registerCodeActionProvider(
        languages,
        {
          provideCodeActions: async (model, range, context, token) => {
            if (!h.ok(model)) return null;
            const diagnostics = (h.pendingMarkers.get(model.uri.fsPath) ?? []).filter((d) => {
              const r = toRange(d.range);
              return monaco.Range.areIntersectingOrTouching(r, range);
            });
            const result = await h.quiet(
              client.request<(lsp.CodeAction | lsp.Command)[] | null>(
                "textDocument/codeAction",
                {
                  ...h.doc(model),
                  range: fromRange(range),
                  context: {
                    diagnostics,
                    ...(context.only && { only: [context.only] }),
                    triggerKind: context.trigger === 1 ? 1 : 2,
                  },
                },
                tokenFor(token),
              ),
              null,
            );
            const actions = await Promise.all((result ?? []).map(toAction));
            return { actions, dispose: () => {} };
          },
          resolveCodeAction: resolve
            ? async (action, token) => {
                const original = (action as monaco.languages.CodeAction & { lsp?: lsp.CodeAction })
                  .lsp;
                if (!original || original.edit) return action;
                const r = await h.quiet(
                  client.request<lsp.CodeAction>("codeAction/resolve", original, tokenFor(token)),
                  null,
                );
                return r ? toAction(r) : action;
              }
            : undefined,
        },
        typeof codeActions === "object" && codeActions.codeActionKinds
          ? { providedCodeActionKinds: codeActions.codeActionKinds }
          : undefined,
      ),
    );
  }

  if (caps.codeLensProvider) {
    const resolve = caps.codeLensProvider.resolveProvider;
    disposables.push(
      monaco.languages.registerCodeLensProvider(languages, {
        provideCodeLenses: async (model, token) => {
          if (!h.ok(model)) return null;
          const r = await h.quiet(
            client.request<lsp.CodeLens[] | null>(
              "textDocument/codeLens",
              h.doc(model),
              tokenFor(token),
            ),
            null,
          );
          return {
            lenses: (r ?? []).map((l) => ({
              range: toRange(l.range),
              command: toCommand(l.command),
              lsp: l,
            })) as monaco.languages.CodeLens[],
            dispose: () => {},
          };
        },
        resolveCodeLens: resolve
          ? async (_model, lens, token) => {
              const original = (lens as monaco.languages.CodeLens & { lsp?: lsp.CodeLens }).lsp;
              if (!original || original.command) return lens;
              const r = await h.quiet(
                client.request<lsp.CodeLens>("codeLens/resolve", original, tokenFor(token)),
                null,
              );
              return r ? { ...lens, command: toCommand(r.command) } : lens;
            }
          : undefined,
      }),
    );
  }

  if (caps.inlayHintProvider) {
    disposables.push(
      monaco.languages.registerInlayHintsProvider(languages, {
        provideInlayHints: async (model, range, token) => {
          if (!h.ok(model)) return null;
          const r = await h.quiet(
            client.request<lsp.InlayHint[] | null>(
              "textDocument/inlayHint",
              { ...h.doc(model), range: fromRange(range) },
              tokenFor(token),
            ),
            null,
          );
          return {
            hints: (r ?? []).map((hint) => ({
              position: { lineNumber: hint.position.line + 1, column: hint.position.character + 1 },
              label:
                typeof hint.label === "string"
                  ? hint.label
                  : hint.label.map((part) => part.value).join(""),
              ...(hint.kind && { kind: hint.kind as monaco.languages.InlayHintKind }),
              ...(hint.paddingLeft && { paddingLeft: true }),
              ...(hint.paddingRight && { paddingRight: true }),
            })),
            dispose: () => {},
          };
        },
      }),
    );
  }

  // Semantic tokens: full with deltas, and ranges (D204).
  addSemanticTokens(client, languages, disposables, { ok: h.ok, doc: h.doc, token: tokenFor });

  if (caps.foldingRangeProvider) {
    disposables.push(
      monaco.languages.registerFoldingRangeProvider(languages, {
        provideFoldingRanges: async (model, _context, token) => {
          if (!h.ok(model)) return null;
          const r = await h.quiet(
            client.request<lsp.FoldingRange[] | null>(
              "textDocument/foldingRange",
              h.doc(model),
              tokenFor(token),
            ),
            null,
          );
          return (r ?? []).map((f) => ({
            start: f.startLine + 1,
            end: f.endLine + 1,
            ...(f.kind && { kind: new monaco.languages.FoldingRangeKind(f.kind) }),
          }));
        },
      }),
    );
  }

  if (caps.selectionRangeProvider) {
    disposables.push(
      monaco.languages.registerSelectionRangeProvider(languages, {
        provideSelectionRanges: async (model, positions, token) => {
          if (!h.ok(model)) return null;
          const r = await h.quiet(
            client.request<lsp.SelectionRange[] | null>(
              "textDocument/selectionRange",
              { ...h.doc(model), positions: positions.map(toPosition) },
              tokenFor(token),
            ),
            null,
          );
          return (r ?? []).map((sel) => {
            const out: monaco.languages.SelectionRange[] = [];
            for (let at: lsp.SelectionRange | undefined = sel; at; at = at.parent)
              out.push({ range: toRange(at.range) });
            return out;
          });
        },
      }),
    );
  }

  if (caps.declarationProvider) {
    disposables.push(
      monaco.languages.registerDeclarationProvider(languages, {
        provideDeclaration: async (model, position, token) => {
          if (!h.ok(model)) return null;
          const links = toLocations(
            await h.quiet(
              client.request<lsp.Location[] | null>(
                "textDocument/declaration",
                h.at(model, position),
                tokenFor(token),
              ),
              null,
            ),
          );
          await ensureModels(
            host,
            links.map((l) => l.uri.fsPath),
          );
          return links;
        },
      }),
    );
  }

  // Linked editing (D200): renaming an HTML tag renames its partner (editor.linkedEditing).
  if (caps.linkedEditingRangeProvider) {
    disposables.push(
      monaco.languages.registerLinkedEditingRangeProvider(languages, {
        provideLinkedEditingRanges: async (model, position, token) => {
          if (!h.ok(model)) return null;
          const r = await h.quiet(
            client.request<{ ranges: lsp.Range[]; wordPattern?: string } | null>(
              "textDocument/linkedEditingRange",
              h.at(model, position),
              tokenFor(token),
            ),
            null,
          );
          if (!r?.ranges?.length) return null;
          let wordPattern: RegExp | undefined;
          try {
            wordPattern = r.wordPattern ? new RegExp(r.wordPattern) : undefined;
          } catch {
            wordPattern = undefined;
          }
          return { ranges: r.ranges.map(toRange), ...(wordPattern && { wordPattern }) };
        },
      }),
    );
  }

  if (caps.documentLinkProvider) {
    disposables.push(
      monaco.languages.registerLinkProvider(languages, {
        provideLinks: async (model, token) => {
          if (!h.ok(model)) return null;
          const r = await h.quiet(
            client.request<lsp.DocumentLink[] | null>(
              "textDocument/documentLink",
              h.doc(model),
              tokenFor(token),
            ),
            null,
          );
          return {
            links: (r ?? []).map((l) => ({
              range: toRange(l.range),
              ...(l.target && { url: l.target }),
              ...(l.tooltip && { tooltip: l.tooltip }),
            })),
          };
        },
      }),
    );
  }

  // Document colors: the engine draws the swatches and the picker. Not where its own CSS and
  // JSON services already color (each swatch would show twice).
  const colorLanguages = colorProviderLanguages(languages);
  if (caps.colorProvider && colorLanguages.length) {
    disposables.push(
      monaco.languages.registerColorProvider(colorLanguages, {
        provideDocumentColors: async (model, token) => {
          if (!h.ok(model)) return [];
          const r = await h.quiet(
            client.request<unknown>("textDocument/documentColor", h.doc(model), tokenFor(token)),
            null,
          );
          return validColors(r).map((c) => ({ range: toRange(c.range), color: c.color }));
        },
        provideColorPresentations: async (model, info, token) => {
          if (!h.ok(model)) return [];
          const r = await h.quiet(
            client.request<unknown>(
              "textDocument/colorPresentation",
              { ...h.doc(model), color: info.color, range: fromRange(info.range) },
              tokenFor(token),
            ),
            null,
          );
          return validPresentations(r).map((p) => ({
            label: p.label,
            ...(p.textEdit && { textEdit: toTextEdit(p.textEdit) }),
            ...(p.additionalTextEdits && {
              additionalTextEdits: p.additionalTextEdits.map(toTextEdit),
            }),
          }));
        },
      }),
    );
  }
}
