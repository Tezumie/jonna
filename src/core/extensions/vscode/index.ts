// The `vscode` shim (D256, docs/vscode-extensions-plan.md phase 2): what a VS Code extension gets
// for `require("vscode")` in the Node host, translating VS Code's API onto the IDE's (`ide`, the
// worker API). It also makes the extension's ExtensionContext. What the shim doesn't offer is
// logged once per name (the extension's log, and `ide://ext/<id>/vscode` for agents), so the next
// thing to add is known. DOM-free and unit-tested against a fake `ide`.

import type { WorkerApi } from "../rpc";
import { createChat } from "./chat";
import { type DeclaredCommand, ShimCommands } from "./commands";
import { createComments } from "./comments";
import { decodeText, pathOf } from "./convert";
import { createDebug } from "./debug";
import { Documents, pathKey } from "./document";
import { createEditors } from "./editors";
import { type InstalledExtension, SharedExtensionRegistry } from "./extensionRegistry";
import { createExtensionsApi, createIpynbExtension } from "./extensionsApi";
import * as extraTypes from "./extraTypes";
import { createGitExtension } from "./git";
import { createLanguages, matchSelector } from "./languages";
import * as languageTypes from "./languageTypes";
import { createNotebooks } from "./notebooks";
import { EnvironmentVariableCollection } from "./terminalEnv";
import { createTesting } from "./testing";
import * as types from "./types";
import { createViews } from "./views";
import { createWebviews } from "./webviews";
import { createWindow } from "./window";
import { type ContentProviders, createWorkbench } from "./workbench";
import * as workbenchTypes from "./workbenchTypes";
import {
  COMMON_SETTINGS,
  createWorkspace,
  ShimConfiguration,
  type ShimFileSystem,
} from "./workspace";

export type { ShimFileSystem } from "./workspace";

/** What the IDE tells the Node host about a VS Code package (InitMessage.vscode). */
export interface VscodeInit {
  /** Its commands as the IDE has them (`vscodeId` when they differ). */
  commands: DeclaredCommand[];
  /** The hidden command code lenses, tree rows and status bar items run through. */
  shimCommand: string;
  /** Its settings' keys (read before it activates). */
  settings: string[];
  /**
   * The VS Code packages installed and enabled (D295, itself too): `extensions.getExtension` and
   * `all`. The shared host's list (ExtensionsListMessage) replaces it as it changes.
   */
  others?: InstalledExtension[];
  /** Loaded unpacked (a development copy): VS Code's ExtensionMode.Development. */
  dev?: boolean;
}

export interface ShimOptions {
  ide: WorkerApi;
  init: VscodeInit;
  /** Its package.json. */
  packageJSON: Record<string, unknown>;
  extensionPath: string;
  /** Folders for globalStorageUri / storageUri / logUri (created when first used). */
  globalStoragePath: string;
  workspaceStoragePath?: string;
  logPath: string;
  fs: ShimFileSystem;
  /** The user's shell (`env.shell`). */
  shell: string;
  log(level: "warn" | "info", text: string): void;
  /**
   * The shared host's VS Code packages (D295): other extensions' live exports. Without one (a
   * test, a host of its own) the shim keeps a registry of its own with what `init.others` lists.
   */
  registry?: SharedExtensionRegistry;
  /**
   * Asks the IDE to activate another extension (its dependencies, permissions and trust are
   * checked there); resolves once it has activated in this process.
   */
  activateExtension?(id: string): Promise<void>;
  /** Another extension's package.json, read when asked for (VS Code's `packageJSON` is sync). */
  readPackage?(extensionPath: string): Record<string, unknown> | undefined;
  /** `env.appRoot`: where the app is installed, or a stable folder of it. */
  appRoot?: string;
}

import { VSCODE_VERSION } from "./version";

const NOT_REPORTED = new Set([
  "then",
  "toJSON",
  "constructor",
  "prototype",
  "__esModule",
  "default",
  "$$typeof",
  "inspect",
  "asymmetricMatch",
  "nodeType",
]);

/** Members that aren't there are logged as unsupported (once), then read as undefined. */
function reporting<T extends object>(
  namespace: string,
  target: T,
  unsupported: (name: string) => void,
): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === "string" && !(prop in t) && !NOT_REPORTED.has(prop))
        unsupported(namespace ? `${namespace}.${prop}` : prop);
      return Reflect.get(t, prop, receiver);
    },
  });
}

/** A copy of a Memento's value: structured, or as JSON when it holds what can't be cloned. */
export function cloneForStorage(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as unknown;
  }
}

/** A Memento kept in one key of the IDE's storage, read once before the extension activates. */
class Memento {
  private data: Record<string, unknown> = {};
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Updates waiting for the next save (several in a row are saved once). */
  private waiting: (() => void)[] = [];

  constructor(
    private readonly store: {
      get(key: string): Promise<unknown>;
      set(key: string, value: unknown): Promise<void>;
    },
    private readonly key: string,
  ) {}

  async load(): Promise<void> {
    const v = await this.store.get(this.key).catch(() => undefined);
    this.data =
      v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
  }

  keys(): readonly string[] {
    return Object.keys(this.data);
  }

  get<T>(key: string, defaultValue?: T): T | undefined {
    return key in this.data ? (this.data[key] as T) : defaultValue;
  }

  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) delete this.data[key];
    else {
      // A value with a function in it can't be cloned: kept as JSON keeps it (what is saved), and
      // a value even JSON can't hold fails the promise (it threw out of `update` before).
      try {
        this.data[key] = cloneForStorage(value);
      } catch (err) {
        return Promise.reject(err);
      }
    }
    if (this.timer) clearTimeout(this.timer);
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        const done = this.waiting.splice(0);
        const settle = () => {
          for (const d of done) d();
        };
        void this.store.set(this.key, this.data).then(settle, settle);
      }, 50);
    });
  }

  setKeysForSync(_keys: readonly string[]): void {}
}

/** Uris inside data that crossed from another extension (they cross as JSON, `$mid` 1). */
export function reviveUris(v: unknown, depth = 0): unknown {
  if (!v || typeof v !== "object" || depth > 8) return v;
  if (Array.isArray(v)) return v.map((x) => reviveUris(x, depth + 1));
  const o = v as Record<string, unknown>;
  if (o.$mid === 1 && typeof o.scheme === "string") return types.Uri.revive(o);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = reviveUris(x, depth + 1);
  return out;
}

/** VS Code's l10n.t: "{0}" and "{name}" filled from the arguments. */
export function l10nFormat(
  message: string | { message: string; args?: unknown[] },
  ...rest: unknown[]
): string {
  const text = typeof message === "string" ? message : message.message;
  const args = typeof message === "string" ? rest : (message.args ?? []);
  const named =
    args.length === 1 && args[0] && typeof args[0] === "object"
      ? (args[0] as Record<string, unknown>)
      : undefined;
  return text.replace(/\{([^{}]+)\}/g, (all, key: string) => {
    const v = named ? named[key] : args[Number(key)];
    return v === undefined ? all : String(v);
  });
}

export function createVscodeShim(o: ShimOptions) {
  const { ide } = o;
  const counts = new Map<string, number>();
  const unsupported = (name: string) => {
    const n = (counts.get(name) ?? 0) + 1;
    counts.set(name, n);
    if (n === 1) o.log("warn", `vscode.${name} isn't supported by the IDE yet.`);
  };
  // Its webview views' pages (D260), once the webviews part exists below.
  let webviewViews: () => unknown[] = () => [];
  try {
    ide.state.register(`ide://ext/${ide.extension.id}/vscode`, () => ({
      version: VSCODE_VERSION,
      unsupported: [...counts].map(([name, calls]) => ({ name, calls })),
      webviewViews: webviewViews(),
    }));
  } catch {
    // The state path is a convenience: the log still has them.
  }

  const docs = new Documents({
    text: (path) => ide.editor.text(path).catch(() => o.fs.readFile(path).then(decodeText)),
    save: async (path) => {
      const r = await ide.commands
        .execute<{ saved: string | null }>("editor.save", { path })
        .catch(() => null);
      return !!r?.saved;
    },
  });
  ide.events.on("documents.didOpen", (p) => {
    const { path, languageId } = p as { path: string; languageId: string };
    void docs.sync(path, languageId).catch(() => {});
  });
  // An edit in the editor makes the document dirty; the file changing on disk (a reload) doesn't.
  ide.events.on("documents.didChange", (p) => {
    const { path } = p as { path: string };
    if (docs.get(path)) void docs.sync(path, undefined, { dirty: true }).catch(() => {});
  });
  ide.events.on("files.didChange", (p) => {
    const { path } = p as { path: string };
    if (docs.get(path)) void docs.sync(path, undefined, { dirty: false }).catch(() => {});
  });
  ide.events.on("documents.didClose", (p) => docs.close((p as { path: string }).path));
  ide.events.on(
    "files.didSave",
    (p) => void docs.saved((p as { path: string }).path).catch(() => {}),
  );

  /** An event nothing fires (yet): listening works and returns a Disposable. */
  const neverFires = new types.EventEmitter<unknown>().event;
  const commands = new ShimCommands(ide, o.init.commands, o.init.shimCommand, unsupported);
  const configuration = new ShimConfiguration(ide);
  const contentProviders: ContentProviders = new Map();
  const workspace = createWorkspace(ide, docs, o.fs, configuration, contentProviders, unsupported);
  const editors = createEditors(ide, docs);
  // A notebook cell's document is the one its notebook gives extensions (VS Code's cells).
  const languages = createLanguages(ide, docs, commands, unsupported, (notebook, cellId) => {
    const nb = notebooks.workspace.notebookDocuments.find(
      (n) => pathKey(n.path) === pathKey(notebook),
    );
    const index = nb ? nb.ids.indexOf(cellId) : -1;
    const cell = nb && index >= 0 ? nb.getCells()[index] : undefined;
    return nb && cell
      ? {
          document: cell.document,
          notebook: { uri: nb.uri, notebookType: nb.notebookType },
          // The editor's text: the document changes in place, with its change event.
          sync: (text: string) => void nb.syncCellText(cellId, text),
        }
      : undefined;
  });
  const views = createViews(ide, commands, o.extensionPath, unsupported);
  const webviews = createWebviews(ide, docs, o.extensionPath, unsupported);
  webviewViews = webviews.report;
  commands.customTextUndo = webviews.undoRedo;
  // Set when the extension starts stopping (D386): its messages are logged, not shown.
  let stopping = false;
  const window = createWindow(ide, commands, ide.env.appName, unsupported, {
    active: () => stopping,
    log: (text) => o.log("info", text),
  });
  // The log levels are env's (env.logLevel), not a member of vscode.window.
  const { logLevel: _logLevel, ...windowApi } = window;
  const absolute = (path: string) =>
    absolutePath(path, ide.workspace.workspaceFolders ?? []) ?? path;
  commands.absolutePath = absolute;
  commands.warn = (text) => o.log("warn", text);
  const debug = createDebug(ide, {
    packageJSON: o.packageJSON,
    extensionPath: o.extensionPath,
    folders: () => workspace.workspaceFolders,
    absolute,
    unsupported,
  });
  const workbench = createWorkbench(ide, commands, contentProviders, o.fs.readFile, unsupported);
  const testing = createTesting(ide, unsupported);
  const comments = createComments(ide, docs, commands, o.packageJSON);
  const chat = createChat(ide, commands, o.packageJSON, unsupported, o.init.commands);
  // Cells' documents are among the open text documents, as in VS Code.
  const notebooks = createNotebooks(ide, commands, unsupported, docs.cells);
  const git = createGitExtension(ide, absolute, contentProviders, unsupported);
  // VS Code's language status items (D258): a status bar item while the active file matches.
  Object.assign(languages.api, {
    createLanguageStatusItem: (id: string, selector: Parameters<typeof matchSelector>[0]) => {
      const bar = window.createStatusBarItem(`lang.${id}`, types.StatusBarAlignment.Right, 100);
      const state = {
        text: "",
        detail: "",
        severity: 0,
        busy: false,
        command: undefined as unknown,
        name: undefined as string | undefined,
      };
      const update = () => {
        const doc = editors.activeTextEditor?.document;
        bar.text = `${state.busy ? "$(loading~spin) " : ""}${state.text}`;
        bar.tooltip = state.detail || state.name || undefined;
        bar.command = state.command as never;
        if (doc && matchSelector(selector, doc) > 0 && state.text) bar.show();
        else bar.hide();
      };
      const sub = editors.onDidChangeActiveTextEditor(update);
      const item = {
        id,
        selector,
        accessibilityInformation: undefined,
        dispose: () => {
          sub.dispose();
          bar.dispose();
        },
      };
      for (const key of Object.keys(state) as (keyof typeof state)[])
        Object.defineProperty(item, key, {
          enumerable: true,
          get: () => state[key],
          set: (v: never) => {
            state[key] = v;
            update();
          },
        });
      return item;
    },
  });
  const applyText = workspace.applyEdit;
  // The workspace's notebook parts and VS Code's older names for two registrations.
  Object.defineProperties(workspace, {
    ...Object.getOwnPropertyDescriptors(notebooks.workspace),
    registerTaskProvider: { value: workbench.tasks.registerTaskProvider, enumerable: true },
    // Port attributes (debugpy's: don't offer to forward its ports): the IDE forwards none.
    registerPortAttributesProvider: {
      value: () => new types.Disposable(() => {}),
      enumerable: true,
    },
    // NotebookEdits too (D265): the text edits first, then each notebook's cell edits.
    applyEdit: {
      enumerable: true,
      value: async (edit: types.WorkspaceEdit) => {
        const text = edit.operations().length ? await applyText(edit) : true;
        if (!text || !edit.notebookOps.length) return text;
        return notebooks.applyEdits(edit.notebookOps).catch((err: unknown) => {
          o.log(
            "warn",
            `NotebookEdit not applied: ${err instanceof Error ? err.message : String(err)}`,
          );
          return false;
        });
      },
    },
  });

  const pkg = o.packageJSON;
  const extensionUri = types.Uri.file(o.extensionPath);
  const selfId = `${String(pkg.publisher ?? "")}.${String(pkg.name ?? "")}`.toLowerCase();
  // Other VS Code packages (D295): in the shared host their exports are the live objects their
  // `activate` returned. A shim on its own (tests) keeps a registry of what `init.others` lists.
  const registry = o.registry ?? new SharedExtensionRegistry("");
  if (!o.registry) registry.setInstalled(o.init.others ?? []);
  registry.addRunning(selfId, o.extensionPath);
  const extensions = createExtensionsApi({
    selfId,
    selfPath: o.extensionPath,
    selfPackage: pkg,
    registry,
    readPackage: (path) => o.readPackage?.(path),
    activate: (id) =>
      o.activateExtension
        ? o.activateExtension(id)
        : Promise.reject(new Error(`Extension '${id}' can't be activated here.`)),
    builtIns: {
      // VS Code's built-in Git extension's API, on the IDE's git (D257), and its .ipynb support.
      "vscode.git": git,
      "vscode.ipynb": createIpynbExtension(),
    },
  });
  const extension = extensions.self;
  const env = {
    appName: ide.env.appName,
    // VS Code's install folder; extensions only build paths from it, so never empty.
    appRoot: o.appRoot || o.globalStoragePath,
    appHost: "desktop",
    language: ide.env.language,
    machineId: ide.env.machineId,
    sessionId: ide.env.sessionId,
    uriScheme: ide.env.uriScheme,
    shell: o.shell,
    uiKind: types.UIKind.Desktop,
    remoteName: undefined,
    isAppPortable: false,
    isNewAppInstall: false,
    isTelemetryEnabled: false,
    onDidChangeTelemetryEnabled: new types.EventEmitter<boolean>().event,
    onDidChangeShell: new types.EventEmitter<string>().event,
    // The default log level the user picked ("Set log level…").
    get logLevel(): types.LogLevel {
      return window.logLevel.value;
    },
    onDidChangeLogLevel: window.logLevel.onDidChange,
    clipboard: ide.env.clipboard,
    openExternal: (uri: types.Uri | string) =>
      ide.env.openExternal(typeof uri === "string" ? uri : uri.toString(true)),
    asExternalUri: (uri: types.Uri) => Promise.resolve(uri),
    createTelemetryLogger: () => ({
      isUsageEnabled: false,
      isErrorsEnabled: false,
      onDidChangeEnableStates: new types.EventEmitter<unknown>().event,
      logUsage() {},
      logError() {},
      dispose() {},
    }),
  };

  const event = <T>() => new types.EventEmitter<T>().event;

  const namespaces = {
    commands: {
      registerCommand: commands.registerCommand.bind(commands),
      registerTextEditorCommand: (
        id: string,
        callback: (...args: unknown[]) => unknown,
        thisArg?: unknown,
      ) =>
        commands.registerCommand(id, (...args) => {
          const editor = editors.activeTextEditor;
          if (!editor) return undefined;
          // The builder's edits apply when the callback returns (VS Code's TextEditorEdit).
          type Builder = Parameters<Parameters<typeof editor.edit>[0]>[0];
          const queued: ((b: Builder) => void)[] = [];
          const builder: Builder = {
            replace: (l, v) => queued.push((b) => b.replace(l, v)),
            insert: (l, v) => queued.push((b) => b.insert(l, v)),
            delete: (l) => queued.push((b) => b.delete(l)),
            setEndOfLine: (eol) => queued.push((b) => b.setEndOfLine(eol)),
          };
          const result = callback.call(thisArg, editor, builder, ...args);
          if (!queued.length) return result;
          return editor
            .edit((b) => {
              for (const q of queued) q(b);
            })
            .then(() => result);
        }),
      executeCommand: commands.executeCommand.bind(commands),
      getCommands: commands.getCommands.bind(commands),
    },
    window: {
      ...windowApi,
      get activeTextEditor() {
        return editors.activeTextEditor;
      },
      get visibleTextEditors() {
        return editors.visibleTextEditors;
      },
      // Live, unlike the rest of `windowApi` (copied when the namespace was made).
      get activeColorTheme() {
        return window.activeColorTheme;
      },
      onDidChangeActiveTextEditor: editors.onDidChangeActiveTextEditor,
      onDidChangeVisibleTextEditors: editors.onDidChangeVisibleTextEditors,
      onDidChangeTextEditorSelection: editors.onDidChangeTextEditorSelection,
      onDidChangeTextEditorVisibleRanges: editors.onDidChangeTextEditorVisibleRanges,
      onDidChangeTextEditorOptions: editors.onDidChangeTextEditorOptions,
      onDidChangeTextEditorViewColumn: editors.onDidChangeTextEditorViewColumn,
      showTextDocument: editors.showTextDocument,
      createTextEditorDecorationType: editors.createTextEditorDecorationType,
      createTreeView: views.createTreeView,
      registerTreeDataProvider: views.registerTreeDataProvider,
      createWebviewPanel: views.createWebviewPanel,
      registerWebviewViewProvider: webviews.registerWebviewViewProvider,
      registerCustomEditorProvider: webviews.registerCustomEditorProvider,
      registerWebviewPanelSerializer: views.registerWebviewPanelSerializer,
      get terminals() {
        return views.terminals;
      },
      get activeTerminal() {
        return views.activeTerminal;
      },
      createTerminal: views.createTerminal,
      // A terminal profile it declares (D264): picked in the IDE's profile menu, the provider's
      // options make the terminal (a shell, or its own pseudoterminal).
      registerTerminalProfileProvider: (
        id: string,
        provider: { provideTerminalProfile(token: unknown): unknown },
      ) => {
        const handle = ide.terminals.registerProfileProvider(id, {
          open: async () => {
            const profile = (await provider.provideTerminalProfile(types.NONE_TOKEN)) as
              | { options?: Parameters<typeof views.createTerminal>[0] }
              | undefined;
            if (!profile?.options) return;
            const terminal = views.createTerminal(profile.options) as { show?(): void };
            terminal.show?.();
          },
        });
        return new types.Disposable(() => handle.dispose());
      },
      onDidOpenTerminal: views.onDidOpenTerminal,
      onDidCloseTerminal: views.onDidCloseTerminal,
      // A shell's commands in its own terminals (VS Code's shell integration, terminals.ts);
      // terminal output (the terminalDataWriteEvent proposal) isn't reported to extensions.
      onDidChangeTerminalShellIntegration: views.onDidChangeTerminalShellIntegration,
      onDidStartTerminalShellExecution: views.onDidStartTerminalShellExecution,
      onDidEndTerminalShellExecution: views.onDidEndTerminalShellExecution,
      onDidWriteTerminalData: neverFires,
      onDidChangeActiveTerminal: views.onDidChangeActiveTerminal,
      onDidChangeTerminalState: views.onDidChangeTerminalState,
      // The notebook editor (D265).
      get activeNotebookEditor() {
        return notebooks.window.activeNotebookEditor;
      },
      get visibleNotebookEditors() {
        return notebooks.window.visibleNotebookEditors;
      },
      onDidChangeActiveNotebookEditor: notebooks.window.onDidChangeActiveNotebookEditor,
      onDidChangeVisibleNotebookEditors: notebooks.window.onDidChangeVisibleNotebookEditors,
      onDidChangeNotebookEditorSelection: notebooks.window.onDidChangeNotebookEditorSelection,
      onDidChangeNotebookEditorVisibleRanges:
        notebooks.window.onDidChangeNotebookEditorVisibleRanges,
      showNotebookDocument: notebooks.window.showNotebookDocument,
    },
    // With its notebook parts (defined onto it above).
    workspace: workspace as typeof workspace & typeof notebooks.workspace,
    languages: languages.api,
    env,
    // Every installed and enabled VS Code package, live (D295); one that isn't is undefined.
    extensions: extensions.api,
    l10n: { t: l10nFormat, bundle: undefined, uri: undefined },
    debug: debug.api,
    tasks: workbench.tasks,
    scm: workbench.scm,
    tests: testing,
    comments,
    authentication: workbench.authentication,
    notebooks: notebooks.notebooks,
    chat: chat.chat,
    lm: chat.lm,
  };

  // Members VS Code has that the IDE has nothing behind yet, added where a namespace lacks them:
  // registrations return a Disposable, events never fire, results are empty (as VS Code gives
  // when no provider or feature answers).
  const none = () => new types.Disposable(() => {});
  const fill = (target: object, members: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(members))
      if (!(key in target)) Object.defineProperty(target, key, { value, enumerable: true });
  };
  fill(namespaces.window, {
    withScmProgress: <R>(task: (progress: { report(v: number): void }) => PromiseLike<R>) =>
      task({ report() {} }),
    onDidExecuteTerminalCommand: neverFires,
  });
  fill(namespaces.workspace, {
    onWillSaveNotebookDocument: neverFires,
    registerTimelineProvider: none,
    registerWorkspaceTimelineProvider: none,
    // Text in files (UTF-8, a byte order mark dropped), as VS Code's default encoding.
    decode: (content: Uint8Array, options?: { encoding?: string }) => {
      const label = options?.encoding?.toLowerCase() === "utf8bom" ? "utf-8" : options?.encoding;
      let decoder: TextDecoder;
      try {
        decoder = new TextDecoder(label ?? "utf-8");
      } catch {
        decoder = new TextDecoder("utf-8");
      }
      return Promise.resolve(decoder.decode(content));
    },
    encode: (content: string, options?: { encoding?: string }) => {
      const bytes = new TextEncoder().encode(content);
      if (options?.encoding?.toLowerCase() !== "utf8bom") return Promise.resolve(bytes);
      const out = new Uint8Array(bytes.length + 3);
      out.set([0xef, 0xbb, 0xbf]);
      out.set(bytes, 3);
      return Promise.resolve(out);
    },
    // The document saved under a name the user picks: the new file's Uri, or undefined.
    saveAs: async (uri: types.Uri) => {
      const from = pathOf(uri);
      const to = await ide.ui.showSaveDialog({ defaultPath: from });
      if (!to) return undefined;
      const text = docs.get(from)?.getText() ?? decodeText(await o.fs.readFile(from));
      await o.fs.writeFile(to, new TextEncoder().encode(text));
      return types.Uri.file(to);
    },
  });
  fill(namespaces.languages, {
    // Drop/paste edits: the IDE doesn't ask providers for them yet (inline values: languages.ts).
    registerDocumentDropEditProvider: none,
    registerDocumentPasteEditProvider: none,
  });
  fill(namespaces.lm, {
    registerMcpServerDefinitionProvider: none,
    registerLanguageModelChatProvider: none,
  });
  fill(namespaces.debug, {
    // Proposed (debugVisualization, debugpy's).
    registerDebugVisualizationProvider: none,
    registerDebugVisualizationTreeProvider: none,
  });
  fill(namespaces.tests, {
    // Proposed (testObserver, Python's): no results recorded.
    testResults: [],
    onDidChangeTestResults: neverFires,
  });

  const reported = Object.fromEntries(
    Object.entries(namespaces).map(([name, ns]) => [name, reporting(name, ns, unsupported)]),
  ) as typeof namespaces;
  const vscode = reporting(
    "",
    {
      version: VSCODE_VERSION,
      ...types,
      ...languageTypes,
      ...workbenchTypes,
      ...extraTypes,
      // VS Code's CancellationToken.None (the type is only an interface here).
      CancellationToken: { None: types.NONE_TOKEN },
      ...reported,
    },
    unsupported,
  );

  // The extension's own context.
  const globalState = new Memento(ide.storage, "vscode.globalState");
  const workspaceState = new Memento(ide.workspaceState, "vscode.workspaceState");
  const onDidChangeSecrets = new types.EventEmitter<{ key: string }>();
  const subscriptions: { dispose(): unknown }[] = [];
  const context = {
    subscriptions,
    extensionPath: o.extensionPath,
    extensionUri,
    extension,
    // A development copy (loaded unpacked) runs as VS Code's extension development host does.
    extensionMode: o.init.dev ? types.ExtensionMode.Development : types.ExtensionMode.Production,
    asAbsolutePath: (relativePath: string) =>
      pathOf(types.Uri.joinPath(extensionUri, relativePath)),
    globalState,
    workspaceState,
    secrets: {
      get: (key: string) => ide.secrets.get(key),
      store: async (key: string, value: string) => {
        await ide.secrets.store(key, value);
        onDidChangeSecrets.fire({ key });
      },
      delete: async (key: string) => {
        await ide.secrets.delete(key);
        onDidChangeSecrets.fire({ key });
      },
      onDidChange: onDidChangeSecrets.event,
    },
    globalStorageUri: types.Uri.file(o.globalStoragePath),
    globalStoragePath: o.globalStoragePath,
    storageUri: o.workspaceStoragePath ? types.Uri.file(o.workspaceStoragePath) : undefined,
    storagePath: o.workspaceStoragePath,
    logUri: types.Uri.file(o.logPath),
    logPath: o.logPath,
    // New terminals' environment (D264).
    environmentVariableCollection: new EnvironmentVariableCollection((changes) => {
      void ide.terminals.setEnvironment(changes).catch((err: unknown) => {
        o.log(
          "warn",
          `Terminal environment not applied: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }),
    languageModelAccessInformation: { onDidChange: event<void>(), canSendRequest: () => undefined },
  };

  /** Reads what VS Code's synchronous API answers from, before the extension activates. */
  const ready = async (): Promise<void> => {
    await Promise.all([
      configuration.preload([...o.init.settings, ...COMMON_SETTINGS]),
      globalState.load(),
      workspaceState.load(),
      workspace.trustReady,
      openDocuments(),
      debug.ready(),
      notebooks.ready().catch(() => {}),
    ]);
    await editors.ready;
  };

  /** The editor's open files (ide://editors has them relative to their folder). */
  const openDocuments = async () => {
    const state = (await ide.state.get("ide://editors").catch(() => null)) as {
      documents?: { path: string; language: string; kind: string }[];
    } | null;
    const folders = ide.workspace.workspaceFolders ?? [];
    for (const d of state?.documents ?? []) {
      if (d.kind !== "text") continue;
      const path = absolutePath(d.path, folders);
      if (path) await docs.sync(path, d.language).catch(() => undefined);
    }
  };

  return {
    vscode,
    context,
    ready,
    setExports(value: unknown) {
      // Active from now on, its exports live for the other extensions of the process (D295).
      registry.setActive(selfId, value);
      // What VS Code does for a package after activation (a declared debugger's adapter).
      debug.afterActivate();
    },
    /** The extension is about to stop: from now on its messages aren't shown (D386). */
    beginStop() {
      stopping = true;
    },
    /** Runs at deactivation: the context's subscriptions, last first. */
    dispose() {
      stopping = true;
      extensions.dispose();
      for (const d of subscriptions.splice(0).reverse()) {
        try {
          d.dispose();
        } catch (err) {
          o.log("warn", `dispose failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
    unsupportedCalls: () => [...counts],
  };
}

/** An absolute path for ide://editors' relative one (a folder's name first with several folders). */
export function absolutePath(
  path: string,
  folders: readonly { path: string; name: string }[],
): string | undefined {
  if (/^([a-zA-Z]:[\\/]|\/|\\\\)/.test(path) || /^[a-zA-Z][\w+.-]+:/.test(path)) return path;
  const join = (root: string, rel: string) =>
    `${root.replace(/[\\/]+$/, "")}${root.includes("\\") ? "\\" : "/"}${rel.replace(/[\\/]/g, root.includes("\\") ? "\\" : "/")}`;
  if (folders.length > 1) {
    const [first, ...rest] = path.split(/[\\/]/);
    const folder = folders.find((f) => f.name === first);
    if (folder) return join(folder.path, rest.join("/"));
  }
  const root = folders[0]?.path;
  return root ? join(root, path) : undefined;
}
