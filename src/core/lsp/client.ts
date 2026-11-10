// A language client over one server connection: the initialize handshake, full-text document sync
// (a change without a range replaces the text, which every server accepts), diagnostics, and the
// server requests a minimal client must answer. Feature requests go through `request()`; the
// editor maps them to its engine. DOM-free; tested with an in-memory server.
import { Emitter } from "../events/index";
import type { Disposable } from "../lifecycle/index";
import { type CancelToken, RpcConnection, type Transport } from "./jsonrpc";
import type { Diagnostic, ServerCapabilities, WorkDoneProgress } from "./types";
import { pathToUri, uriToPath } from "./uri";

export interface ClientOptions {
  /** Server id (settings key), for logs and marker owners. */
  id: string;
  /** The first workspace folder (`rootUri`, `rootPath`). */
  rootPath: string;
  /**
   * Every workspace folder (D251: a multi-root workspace), the first first; default: `rootPath`
   * alone. Changed later with `setWorkspaceFolders`.
   */
  folders?: readonly { path: string; name: string }[];
  /** Our language ids the server handles. */
  languages: readonly string[];
  initializationOptions?: unknown;
  /**
   * Answers workspace/configuration (`section` → value); `scope` is the item's `scopeUri` as a
   * path (a file or workspace folder, D251: a multi-root workspace's folders may differ).
   */
  configuration?: (section: string | undefined, scope?: string) => unknown;
  clientName: string;
}

export type ClientState = "starting" | "running" | "stopped" | "failed";

/** LSP language ids differ from ours for a few languages. */
const LSP_LANGUAGE: Record<string, string> = {
  tsx: "typescriptreact",
  jsx: "javascriptreact",
};

export function lspLanguageId(id: string): string {
  return LSP_LANGUAGE[id] ?? id;
}

const SYMBOL_KINDS = Array.from({ length: 26 }, (_, i) => i + 1);
/** The semantic token types and modifiers the client understands (LSP 3.17's standard sets). */
export const SEMANTIC_TOKEN_TYPES = [
  "namespace",
  "type",
  "class",
  "enum",
  "interface",
  "struct",
  "typeParameter",
  "parameter",
  "variable",
  "property",
  "enumMember",
  "event",
  "function",
  "method",
  "macro",
  "keyword",
  "modifier",
  "comment",
  "string",
  "number",
  "regexp",
  "operator",
  "decorator",
];
export const SEMANTIC_TOKEN_MODIFIERS = [
  "declaration",
  "definition",
  "readonly",
  "static",
  "deprecated",
  "abstract",
  "async",
  "modification",
  "documentation",
  "defaultLibrary",
];
const COMPLETION_KINDS = Array.from({ length: 25 }, (_, i) => i + 1);

/** A folder named as the server sees it: the last part of its path. */
function rootFolder(path: string): { path: string; name: string } {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return { path, name: parts[parts.length - 1] ?? "root" };
}

/**
 * The folders as servers are told them: with several (D251), as the workspace names them; one
 * folder is named as it always was (`rootFolder`: "C:" for a drive's root, the share for a UNC
 * share, "root" for /), whatever the workspace calls it.
 */
function serverFolders(
  folders: readonly { path: string; name: string }[],
): readonly { path: string; name: string }[] {
  const [only] = folders;
  return folders.length === 1 && only ? [rootFolder(only.path)] : folders;
}

/** The folders added and taken out between two lists (by URI); null when none. */
function folderDiff(
  before: readonly { path: string; name: string }[],
  after: readonly { path: string; name: string }[],
): { added: { path: string; name: string }[]; removed: { path: string; name: string }[] } | null {
  const key = (f: { path: string }) => pathToUri(f.path);
  const added = after.filter((f) => !before.some((b) => key(b) === key(f)));
  const removed = before.filter((b) => !after.some((f) => key(f) === key(b)));
  return added.length || removed.length ? { added, removed } : null;
}

/** What `setWorkspaceFolders` did: told the server, nothing to tell, or the server keeps its own. */
export type FolderChangeResult = "told" | "unchanged" | "kept";

/** One key per document: its URI (a Windows drive letter in either case is one file). */
const docKey = (path: string) => pathToUri(path);

export class LanguageClient implements Disposable {
  readonly connection: RpcConnection;
  capabilities: ServerCapabilities = {};
  state: ClientState = "starting";
  /** By docKey: "C:\x" and "c:\x" (Monaco's fsPath) are one document, as their URI is. */
  private readonly versions = new Map<string, number>();
  /** Documents opened only for a request (openTemporarily). */
  private readonly temporary = new Set<string>();
  private readonly diagnosticsEmitter = new Emitter<{ path: string; diagnostics: Diagnostic[] }>();
  readonly onDiagnostics = this.diagnosticsEmitter.event;
  private readonly logEmitter = new Emitter<string>();
  /** window/logMessage and window/showMessage text. */
  readonly onLog = this.logEmitter.event;
  private readonly stateEmitter = new Emitter<ClientState>();
  readonly onDidChangeState = this.stateEmitter.event;
  /** Work in progress the server reported, by token. */
  readonly progress = new Map<string, { title: string; message: string; percentage?: number }>();
  private readonly progressEmitter = new Emitter<void>();
  readonly onProgress = this.progressEmitter.event;
  /** Partial results of a request in flight ($/progress with its partialResultToken), by token. */
  private readonly partials = new Map<string, (value: unknown) => void>();
  private nextPartial = 1;
  /**
   * A document the client counts as open that the server says it doesn't know (D380: its
   * didOpen was lost, e.g. sent while the process restarted): forgotten here, to be opened again.
   */
  private readonly lostEmitter = new Emitter<string>();
  readonly onDocumentLost = this.lostEmitter.event;
  private readonly refreshEmitter = new Emitter<"semanticTokens" | "diagnostics">();
  /** The server asked for semantic tokens or diagnostics to be fetched again (…/refresh, D204). */
  readonly onRefresh = this.refreshEmitter.event;
  /** Asks the user a server's question (window/showMessageRequest): the picked title or null. */
  ask?: (message: string, actions: string[], type: number) => Promise<string | null>;

  constructor(
    transport: Transport,
    readonly options: ClientOptions,
  ) {
    this.folders = options.folders?.length
      ? serverFolders(options.folders)
      : [rootFolder(options.rootPath)];
    this.connection = new RpcConnection(transport);
    const c = this.connection;
    c.onNotification("textDocument/publishDiagnostics", (p) => {
      const { uri, diagnostics } = p as { uri: string; diagnostics: Diagnostic[] };
      const path = uriToPath(uri);
      if (path) this.diagnosticsEmitter.fire({ path, diagnostics });
    });
    c.onNotification("window/logMessage", (p) =>
      this.logEmitter.fire((p as { message: string }).message),
    );
    c.onNotification("window/showMessage", (p) =>
      this.logEmitter.fire((p as { message: string }).message),
    );
    c.onRequest("workspace/configuration", (p) =>
      ((p as { items?: { section?: string; scopeUri?: string }[] }).items ?? []).map((item) => {
        if (!options.configuration) return null;
        const scope = item.scopeUri ? (uriToPath(item.scopeUri) ?? undefined) : undefined;
        return options.configuration(item.section, scope) ?? null;
      }),
    );
    c.onRequest("workspace/workspaceFolders", () => this.workspaceFolders());
    c.onRequest("client/registerCapability", () => null);
    c.onRequest("client/unregisterCapability", () => null);
    c.onRequest("window/workDoneProgress/create", () => null);
    // Work progress ("indexing…", D199): the latest message per token, for the status bar.
    c.onNotification("$/progress", (p) => {
      const { token, value } = p as { token: string | number; value: WorkDoneProgress };
      const key = String(token);
      // A partial result (workspace/diagnostic streams them, D204), not work progress.
      const partial = this.partials.get(key);
      if (partial) {
        partial(value);
        return;
      }
      if (value.kind === "end") this.progress.delete(key);
      else {
        const before = this.progress.get(key);
        this.progress.set(key, {
          title: value.title ?? before?.title ?? "",
          message: value.message ?? before?.message ?? "",
          ...(value.percentage !== undefined && { percentage: value.percentage }),
        });
      }
      this.progressEmitter.fire();
    });
    // A server's question with buttons (D199): asked through `ask` when set, else dismissed.
    c.onRequest("window/showMessageRequest", async (p) => {
      const q = p as { type: number; message: string; actions?: { title: string }[] };
      if (!this.ask || !q.actions?.length) return null;
      const picked = await this.ask(
        q.message,
        q.actions.map((a) => a.title),
        q.type,
      );
      return picked === null ? null : (q.actions.find((a) => a.title === picked) ?? null);
    });
    c.onRequest("workspace/semanticTokens/refresh", () => {
      this.refreshEmitter.fire("semanticTokens");
      return null;
    });
    c.onRequest("workspace/inlayHint/refresh", () => null);
    c.onRequest("workspace/diagnostic/refresh", () => {
      this.refreshEmitter.fire("diagnostics");
      return null;
    });
    c.onRequest("workspace/codeLens/refresh", () => null);
  }

  /** The workspace folders as the server knows them (D251). */
  private folders: readonly { path: string; name: string }[];

  private workspaceFolders(): { uri: string; name: string }[] {
    return this.folders.map((f) => ({ uri: pathToUri(f.path), name: f.name }));
  }

  /** Whether the server takes `workspace/didChangeWorkspaceFolders` (its capabilities say so). */
  get takesFolderChanges(): boolean {
    const wf = this.capabilities.workspace?.workspaceFolders;
    return !!wf?.supported && !!wf.changeNotifications;
  }

  /**
   * The workspace's folders changed (D251: one added to or taken out of a multi-root
   * workspace): servers that support it are told (`workspace/didChangeWorkspaceFolders`), and
   * `workspace/workspaceFolders` answers with the new list. Others keep their first folder, as in
   * VS Code. A server still starting is told once it's initialized (`start`). "unchanged": no
   * folder was added or taken out (a rename only, or the same list).
   */
  setWorkspaceFolders(folders: readonly { path: string; name: string }[]): FolderChangeResult {
    const before = this.folders;
    if (folders.length) this.folders = serverFolders(folders);
    if (this.state === "starting") return folderDiff(before, this.folders) ? "kept" : "unchanged";
    return this.tellFolders(before, this.folders);
  }

  /**
   * Sends the folders added and taken out between two lists, when the server takes them
   * (`initialized`: it just was, though not "running" yet).
   */
  private tellFolders(
    before: readonly { path: string; name: string }[],
    after: readonly { path: string; name: string }[],
    initialized = false,
  ): FolderChangeResult {
    const diff = folderDiff(before, after);
    if (!diff) return "unchanged";
    if ((!initialized && this.state !== "running") || !this.takesFolderChanges) return "kept";
    this.connection.notify("workspace/didChangeWorkspaceFolders", {
      event: {
        added: diff.added.map((f) => ({ uri: pathToUri(f.path), name: f.name })),
        removed: diff.removed.map((f) => ({ uri: pathToUri(f.path), name: f.name })),
      },
    });
    return "told";
  }

  private setState(state: ClientState): void {
    this.state = state;
    this.stateEmitter.fire(state);
  }

  async start(processId: number | null = null): Promise<ServerCapabilities> {
    // What initialize tells the server: folders changed while it starts are sent after it.
    const announced = this.folders;
    try {
      const result = await this.connection.request<{ capabilities: ServerCapabilities }>(
        "initialize",
        {
          processId,
          clientInfo: { name: this.options.clientName },
          rootUri: pathToUri(this.options.rootPath),
          rootPath: this.options.rootPath,
          workspaceFolders: this.workspaceFolders(),
          initializationOptions: this.options.initializationOptions ?? null,
          capabilities: {
            general: { positionEncodings: ["utf-16"] },
            workspace: {
              configuration: true,
              workspaceFolders: true,
              // Edits the server sends (a code action's command, a rename's follow-up): D199.
              applyEdit: true,
              workspaceEdit: { documentChanges: true },
              executeCommand: {},
              didChangeWatchedFiles: { dynamicRegistration: false },
              symbol: { symbolKind: { valueSet: SYMBOL_KINDS } },
              semanticTokens: { refreshSupport: true },
              diagnostics: { refreshSupport: true },
              inlayHint: { refreshSupport: false },
              codeLens: { refreshSupport: false },
            },
            textDocument: {
              synchronization: { didSave: true, dynamicRegistration: false },
              publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] } },
              completion: {
                completionItem: {
                  snippetSupport: true,
                  documentationFormat: ["markdown", "plaintext"],
                  deprecatedSupport: true,
                  labelDetailsSupport: true,
                  resolveSupport: {
                    properties: ["documentation", "detail", "additionalTextEdits"],
                  },
                  insertReplaceSupport: true,
                },
                completionItemKind: { valueSet: COMPLETION_KINDS },
                contextSupport: true,
              },
              hover: { contentFormat: ["markdown", "plaintext"] },
              signatureHelp: {
                signatureInformation: {
                  documentationFormat: ["markdown", "plaintext"],
                  parameterInformation: { labelOffsetSupport: true },
                },
              },
              definition: { linkSupport: true },
              typeDefinition: { linkSupport: true },
              implementation: { linkSupport: true },
              references: {},
              documentHighlight: {},
              documentSymbol: {
                hierarchicalDocumentSymbolSupport: true,
                symbolKind: { valueSet: SYMBOL_KINDS },
              },
              formatting: {},
              rangeFormatting: {},
              rename: { prepareSupport: true },
              declaration: { linkSupport: true },
              codeAction: {
                codeActionLiteralSupport: {
                  codeActionKind: {
                    valueSet: [
                      "",
                      "quickfix",
                      "refactor",
                      "refactor.extract",
                      "refactor.inline",
                      "refactor.rewrite",
                      "source",
                      "source.organizeImports",
                      "source.fixAll",
                    ],
                  },
                },
                isPreferredSupport: true,
                disabledSupport: true,
                dataSupport: true,
                resolveSupport: { properties: ["edit"] },
              },
              codeLens: {},
              inlayHint: { resolveSupport: { properties: [] } },
              semanticTokens: {
                requests: { full: { delta: true }, range: true },
                tokenTypes: SEMANTIC_TOKEN_TYPES,
                tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
                formats: ["relative"],
                overlappingTokenSupport: false,
                multilineTokenSupport: false,
              },
              foldingRange: { lineFoldingOnly: true },
              selectionRange: {},
              documentLink: { tooltipSupport: true },
              diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
              linkedEditingRange: {},
              // The hierarchy view and lsp.callHierarchy / lsp.typeHierarchy; document colors.
              callHierarchy: { dynamicRegistration: false },
              typeHierarchy: { dynamicRegistration: false },
              colorProvider: { dynamicRegistration: false },
            },
            window: { workDoneProgress: true, showMessage: { messageActionItem: {} } },
          },
        },
        { timeoutMs: 60000 },
      );
      this.capabilities = result?.capabilities ?? {};
      this.connection.notify("initialized", {});
      // Before "running" is announced: a listener changing the folders then sends its own diff.
      this.tellFolders(announced, this.folders, true);
      this.setState("running");
      return this.capabilities;
    } catch (err) {
      this.setState("failed");
      throw err;
    }
  }

  /** Whether the server wants didSave, and with the saved text (`save.includeText`, D218). */
  private get syncOptions(): { change: number; save: boolean; includeText: boolean } {
    const sync = this.capabilities.textDocumentSync;
    if (typeof sync === "number") return { change: sync, save: false, includeText: false };
    const save = sync?.save;
    return {
      change: sync?.change ?? 1,
      save: !!save,
      includeText: typeof save === "object" && save !== null && save.includeText === true,
    };
  }

  /**
   * Set by the editor binding: sends a document's pending (debounced) change now and returns its
   * text, so didSave follows the last didChange and carries what was saved. Undefined for a
   * document the binding doesn't sync.
   */
  flushDocument?: (path: string) => string | undefined;

  /**
   * Set by the notebook binding (D229): the documents the server has open for a saved file that
   * it doesn't see itself (a notebook's code cells joined into one document), each flushed and
   * with its text. A save of that file is a save of these.
   */
  joinedDocuments?: (path: string) => { path: string; text: string }[];

  handles(languageId: string): boolean {
    return this.options.languages.includes(languageId);
  }

  didOpen(path: string, languageId: string, text: string): void {
    if (this.state !== "running") return;
    // Opened for one request from the file on disk (openTemporarily) while an editor opens it
    // for real: the server swaps the disk text for the editor's, and the request's end no
    // longer closes it under the editor (its edits never reached the server).
    if (this.temporary.delete(docKey(path)) && this.versions.has(docKey(path))) {
      this.versions.delete(docKey(path));
      this.connection.notify("textDocument/didClose", { textDocument: { uri: pathToUri(path) } });
    }
    this.versions.set(docKey(path), 1);
    this.connection.notify("textDocument/didOpen", {
      textDocument: {
        uri: pathToUri(path),
        languageId: lspLanguageId(languageId),
        version: 1,
        text,
      },
    });
  }

  didChange(path: string, text: string): void {
    if (this.state !== "running" || this.syncOptions.change === 0) return;
    const version = (this.versions.get(docKey(path)) ?? 1) + 1;
    this.versions.set(docKey(path), version);
    this.connection.notify("textDocument/didChange", {
      textDocument: { uri: pathToUri(path), version },
      contentChanges: [{ text }],
    });
  }

  /** `text`: the saved text, when the caller has it (the editor binding's own wins). */
  didSave(path: string, text?: string): void {
    const sync = this.syncOptions;
    if (this.state !== "running" || !sync.save) return;
    const joined = this.joinedDocuments?.(path);
    if (joined?.length) {
      for (const d of joined)
        this.connection.notify("textDocument/didSave", {
          textDocument: { uri: pathToUri(d.path) },
          ...(sync.includeText && { text: d.text }),
        });
      return;
    }
    // The edits before the save reach the server first, whether or not it wants the text.
    const current = this.flushDocument?.(path) ?? text;
    this.connection.notify("textDocument/didSave", {
      textDocument: { uri: pathToUri(path) },
      ...(sync.includeText && current !== undefined && { text: current }),
    });
  }

  /** Files that changed on disk (workspace/didChangeWatchedFiles; 1 created, 2 changed, 3 deleted). */
  didChangeWatchedFiles(changes: { path: string; type: 1 | 2 | 3 }[]): void {
    if (this.state !== "running" || !changes.length) return;
    this.connection.notify("workspace/didChangeWatchedFiles", {
      changes: changes.map((c) => ({ uri: pathToUri(c.path), type: c.type })),
    });
  }

  /** Settings changed: the server asks again (workspace/configuration) for what it needs. */
  didChangeConfiguration(settings: unknown = null): void {
    if (this.state !== "running") return;
    this.connection.notify("workspace/didChangeConfiguration", { settings });
  }

  didClose(path: string): void {
    this.temporary.delete(docKey(path));
    if (this.state !== "running" || !this.versions.has(docKey(path))) return;
    this.versions.delete(docKey(path));
    this.connection.notify("textDocument/didClose", { textDocument: { uri: pathToUri(path) } });
  }

  isOpen(path: string): boolean {
    return this.versions.has(docKey(path));
  }

  /**
   * Opens a file that isn't open for one request (its text from disk), and returns what closes
   * it again: nothing when it was open already, or when an editor opened it meanwhile (didOpen
   * takes it over).
   */
  openTemporarily(path: string, languageId: string, text: string): () => void {
    if (this.versions.has(docKey(path))) return () => {};
    this.didOpen(path, languageId, text);
    if (!this.versions.has(docKey(path))) return () => {};
    this.temporary.add(docKey(path));
    return () => {
      if (this.temporary.delete(docKey(path))) this.didClose(path);
    };
  }

  /** Open only for a request (openTemporarily): an editor's didOpen still takes it over. */
  isOpenTemporarily(path: string): boolean {
    return this.temporary.has(docKey(path));
  }

  /** The version last sent for an open document (workspace edits name the one they were made for). */
  versionOf(path: string): number | undefined {
    return this.versions.get(docKey(path));
  }

  request<T>(method: string, params: unknown, token?: CancelToken): Promise<T> {
    return this.connection
      .request<T>(method, params, { token, timeoutMs: 30000 })
      .catch((err: unknown) => {
        this.noticeLost(params, err);
        throw err;
      });
  }

  /** typescript-language-server's "Unexpected resource": the document isn't open there (D380). */
  private noticeLost(params: unknown, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (!/unexpected resource/i.test(message)) return;
    const uri = (params as { textDocument?: { uri?: unknown } } | null)?.textDocument?.uri;
    if (typeof uri !== "string") return;
    const path = uriToPath(uri);
    if (!path || !this.versions.delete(docKey(path))) return;
    this.temporary.delete(docKey(path));
    this.lostEmitter.fire(path);
  }

  /**
   * A request whose answer may also come in parts (`partialResultToken`, streamed as $/progress):
   * each part goes to `onPartial`, then the final answer resolves. `timeoutMs` 0 waits as long
   * as it takes (workspace/diagnostic may be held open by the server until something changes).
   */
  requestWithPartialResults<T>(
    method: string,
    params: Record<string, unknown>,
    onPartial: (value: unknown) => void,
    options: { token?: CancelToken; timeoutMs?: number } = {},
  ): Promise<T> {
    const partialResultToken = `partial-${this.nextPartial++}`;
    this.partials.set(partialResultToken, onPartial);
    return this.connection
      .request<T>(
        method,
        { ...params, partialResultToken },
        { token: options.token, timeoutMs: options.timeoutMs ?? 0 },
      )
      .finally(() => this.partials.delete(partialResultToken));
  }

  /** shutdown + exit (politely), then the host kills the process. */
  async stop(): Promise<void> {
    if (this.state === "running") {
      await this.connection.request("shutdown", undefined, { timeoutMs: 3000 }).catch(() => {});
      this.connection.notify("exit");
    }
    this.connection.close("The language server stopped.");
    this.setState("stopped");
  }

  /** The process exited on its own. */
  exited(): void {
    this.connection.close("The language server exited.");
    if (this.state !== "stopped") this.setState("failed");
  }

  dispose(): void {
    this.connection.dispose();
    this.diagnosticsEmitter.dispose();
    this.logEmitter.dispose();
    this.stateEmitter.dispose();
    this.refreshEmitter.dispose();
    this.progressEmitter.dispose();
    this.lostEmitter.dispose();
    this.partials.clear();
  }
}
