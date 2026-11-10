// The RPC between an extension's worker and the IDE (PLAN §9.3, D102). The worker has no DOM and
// no IPC: everything it can do is a request the host checks (permissions) and answers. The host
// calls back into the worker for the extension's own command handlers, tree data, webview
// messages, event subscriptions, its processes' output and its state paths (D202).
// `createWorkerApi` builds the `ide` global from a transport; it is DOM-free and unit-tested with
// a fake host.

import type { LogLevelsMessage } from "./logLevels";
import {
  type AuthenticationApi,
  createAuthFsApis,
  type FileSystemsApi,
  type SecretsApi,
} from "./rpcAuthFs";
import { type ChatApi, createChatApis, type LanguageModelApi } from "./rpcChat";
import { type CommentsApi, createCommentsApi } from "./rpcComments";
import {
  createEditorExtras,
  createEnvExtras,
  createWorkspaceExtras,
  createWorkspaceState,
  type EditorExtrasApi,
  type EnvExtrasApi,
  type MementoApi,
  type WorkspaceExtrasApi,
} from "./rpcExtras";
import { createGitApi, type GitApi, type GitHubApi } from "./rpcGit";
import { createHookApis, type HookApis } from "./rpcHooks";
import {
  type CallToken,
  CallTokenSource,
  createLanguagesApi,
  type LanguagesApi,
  type ProviderContext,
} from "./rpcLanguages";
import { createNotebooksApi, type NotebooksApi } from "./rpcNotebooks";
import { createOutputChannel, type OutputChannel } from "./rpcOutput";
import { createQuickInputApi, type QuickInputApi } from "./rpcQuickInput";
import { createScmDebugApis, type DebugApi, type ScmApi } from "./rpcScmDebug";
import { createTerminalApis, type OnCall, type TasksApi, type TerminalsApi } from "./rpcTerminals";
import { createTestsApi, type TestsApi } from "./rpcTesting";
import { createWebviewPanelsApi, type WebviewPanelsApi } from "./rpcWebviewPanels";
import {
  createWorkspaceFolders,
  type WorkspaceFoldersApi,
  type WorkspaceSnapshot,
  withWorkspaceFolders,
} from "./rpcWorkspace";
import type { VscodeInit } from "./vscode/index";

// The language providers' types live with their API (rpcLanguages.ts).
export type {
  CallToken,
  CodeAction,
  CodeActionContext,
  CodeLens,
  CompletionItem,
  Diagnostic,
  DocumentContext,
  DocumentSymbol,
  FileEdit,
  FormattingContext,
  FullRange,
  InlayHint,
  Location,
  ProviderContext,
  SemanticToken,
  SignatureHelp,
  TextEdit,
} from "./rpcLanguages";

/** Worker → host: an API request. */
export interface RequestMessage {
  t: "req";
  id: number;
  method: string;
  params: unknown;
}

/** Either side: the answer to a request or a call. */
export interface ReplyMessage {
  t: "res";
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** Host → worker: run one of the extension's callbacks. */
export interface CallMessage {
  t: "call";
  id: number;
  kind:
    | "command"
    | "tree"
    | "webview"
    | "event"
    | "settings"
    | "deactivate"
    // A hover / completion provider of the extension (D176): `target` is its id.
    | "hover"
    | "completion"
    // Its other language providers (definition, formatting, code lens…): `target` is the id,
    // `args` the context.
    | "provider"
    // The user cancelled one of its withProgress tasks: `target` is the task's id.
    | "progress"
    // The notebook editor asks the extension's serializers and kernels (D202): `target` is the
    // operation (rpcNotebooks.ts).
    | "notebook"
    // Output of one of its processes (D202): `target` is the process id, `args` a ProcessBatch.
    | "process"
    // One of its state paths is read (D202): `target` is the path, `args` { params }.
    | "state"
    // The workspace's folders changed (D251, rpcWorkspace.ts): `target` "snapshot" or "changed".
    | "workspace";
  target: string;
  args?: unknown;
  /** "command": who ran it ({ caller }, D202). */
  context?: unknown;
}

/** What a process wrote or did since the last batch, in order (D202). */
export type ProcessEvent =
  | { kind: "message"; body: string }
  | { kind: "stderr"; line: string }
  | { kind: "exit"; code: number | null; signal?: string };

export interface ProcessBatch {
  events: ProcessEvent[];
}

/** Host → worker: start. */
export interface InitMessage {
  t: "init";
  manifest: {
    id: string;
    version: string;
    displayName: string;
    /** The extension's folder (absolute), for a script it ships (D202). */
    path?: string;
    platform?: EnvPlatform;
    /** The IDE's name and the user's language, for `ide.env` (D234). */
    appName?: string;
    language?: string;
    /** The IDE's URL scheme (`ide.env.uriScheme`). */
    uriScheme?: string;
    /** The theme's kind as it starts (`ide.env.themeKind`; "theme.didChange" events after). */
    themeKind?: "light" | "dark";
    /** `ide.env.machineId` / `sessionId` (D255): random ids, the installation's and the window's. */
    machineId?: string;
    sessionId?: string;
    /** The workspace's folders when it starts (D251; only with "fs.read"). */
    workspace?: WorkspaceSnapshot;
  };
  /** The main file's absolute path (D255: the Node host loads it with `require`). */
  file?: string;
  /** A VS Code package (D256): the Node host gives it `require("vscode")`, the shim. */
  vscode?: VscodeInit;
  /** The extension's main file (CommonJS-style: `module.exports.activate(ide)` or top-level code). */
  code: string;
  filename: string;
}

/** Worker → host: console output and lifecycle. */
export interface LogMessage {
  t: "log";
  level: "log" | "info" | "warn" | "error";
  text: string;
}

export interface StatusMessage {
  t: "status";
  status: "active" | "failed";
  error?: string;
}

/**
 * Host → the shared Node host (D295): the installed and enabled VS Code packages, for
 * `vscode.extensions` (sent to the process, not to one extension).
 */
export interface ExtensionsListMessage {
  t: "extensions";
  list: { id: string; path: string; hasCode: boolean }[];
}

/** Host → the shared Node host: one extension stops there (its deactivate ran or is skipped). */
export interface UnloadMessage {
  t: "unload";
}

/** The shared Node host → host: an extension's `unload` is done. */
export interface UnloadedMessage {
  t: "unloaded";
  /**
   * Native addons (`.node` files) it loaded from its folder: Node can't unload them (Windows keeps
   * them locked), so the host process restarts before the folder may go.
   */
  native?: string[];
}

/**
 * Host → worker: the editor no longer needs the answer to call `id` (VS Code's cancellation: the
 * language provider's token fires).
 */
export interface CancelMessage {
  t: "cancel";
  id: number;
}

export type ToWorker =
  | InitMessage
  | ReplyMessage
  | CallMessage
  | ExtensionsListMessage
  | UnloadMessage
  | CancelMessage;
export type FromWorker =
  | RequestMessage
  | ReplyMessage
  | LogMessage
  | StatusMessage
  | UnloadedMessage;

/**
 * A message of the shared Node host (D295): every VS Code package runs in one process, each with
 * its own `vscode` shim and its own side of the RPC; `x` says whose (the extension's id). A
 * process of one extension's own (the IDE's format) leaves it out.
 */
export type Tagged<T> = T & { x?: string };

export interface Transport {
  post(message: FromWorker): void;
  onMessage(handler: (message: ToWorker) => void): void;
}

export interface Disposable {
  dispose(): void;
}

export interface TreeItem {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  /** An icon name from the IDE's icon set. */
  icon?: string;
  /**
   * An image of the extension instead (D258: VS Code's iconPath as a file): a path in its folder,
   * and another for dark themes.
   */
  iconPath?: string;
  iconPathDark?: string;
  /** Has children (shown with a chevron; asked for when expanded). */
  collapsible?: boolean;
  /** Runs when the row is clicked. */
  command?: { id: string; input?: unknown };
  /** Its label in bold (D208): unread, new, current. */
  strong?: boolean;
  /** Buttons shown on hover at the row's end (D208, at most 4), each running a command. */
  actions?: { icon: string; title: string; command: { id: string; input?: unknown } }[];
  /** Tested by `menus["view/item/context"]` `when` clauses as `viewItem` (VS Code's). */
  contextValue?: string;
  /** A checkbox before the label (VS Code's TreeItemCheckboxState: Unchecked 0, Checked 1). */
  checkboxState?: "checked" | "unchecked" | 0 | 1 | boolean;
}

/** A row's checkbox the user clicked (VS Code's onDidChangeCheckboxState). */
export interface TreeCheckboxChange {
  item: TreeItem;
  checked: boolean;
}

export interface TreeProvider {
  getChildren(parent?: TreeItem): TreeItem[] | Promise<TreeItem[]>;
  /**
   * Rows dragged onto a row of this view (or below the rows: `target` undefined). VS Code's
   * TreeDragAndDropController, within the view: `dragAndDropController.handleDrop` works too.
   */
  handleDrop?(target: TreeItem | undefined, sources: TreeItem[]): unknown;
  dragAndDropController?: {
    handleDrop(target: TreeItem | undefined, sources: TreeItem[]): unknown;
  };
  onDidChangeCheckboxState?(changes: TreeCheckboxChange[]): unknown;
}

export interface ActiveEditor {
  /** Absolute path of the file. */
  path: string;
  language: string;
  /** 1-based. */
  cursor: { line: number; column: number };
  selectedText: string;
  /** The first selection (the cursor's position when nothing is selected), 1-based (D208). */
  selection: { startLine: number; startColumn: number; endLine: number; endColumn: number };
}

/** Text before a line's code (D208): the blame gutter's "Author   3 d". */
export interface LineAnnotation {
  /** 1-based. */
  line: number;
  /** Plain text, at most 80 characters; give every line the same width so the code stays aligned. */
  text: string;
  /** How strongly it stands out: 0 (the accent color) to 4 (faint, the default). */
  tone?: number;
  /** Plain text shown on hover. */
  hover?: string;
}

export interface FindTextOptions {
  isRegex?: boolean;
  matchCase?: boolean;
  wholeWord?: boolean;
  include?: string[];
  exclude?: string[];
  maxResults?: number;
}

export interface FindTextResult {
  matches: { path: string; rel: string; line: number; text: string }[];
  truncated: boolean;
}

/** 1-based lines and columns (end column exclusive); no columns: whole lines. */
export interface TextRange {
  startLine: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

export interface StatusBarItemOptions {
  /** Unique within the extension; setting it again updates the item. */
  id: string;
  /** Text, with `$(icon-name)` for an icon of the IDE's set. */
  text: string;
  tooltip?: string;
  /** One of the extension's commands, run on click. */
  command?: string;
  input?: unknown;
  alignment?: "left" | "right";
  /** Higher: closer to the edge. */
  priority?: number;
  /** What the item is (VS Code's StatusBarItem.name), for screen readers. */
  name?: string;
  /**
   * Needs attention: a warning or error background (VS Code's statusBarItem.warningBackground /
   * errorBackground), or the text alone in that color.
   */
  tone?: "warning" | "error" | "warning-text" | "error-text";
}

export type EnvPlatform = "windows" | "macos" | "linux";

/** Where withProgress shows (VS Code's ProgressLocation.Notification / Window). */
export interface ProgressOptions {
  /** "notification" (default): a toast with the title, message and a Cancel button; "window": the status bar. */
  location?: "notification" | "window";
  title?: string;
  /** A Cancel button (notification only); the task sees it on its token. */
  cancellable?: boolean;
}

export interface Progress {
  /** `increment`: percent of the whole done since the last report (they add up to 100). */
  report(value: { message?: string; increment?: number }): void;
}

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): Disposable;
}

/** Passed to a command handler beside its input (D202). */
export interface CommandRunContext {
  caller: "user" | "agent" | "extension" | "other";
}

export interface SpawnOptions {
  command: string;
  args?: string[];
  /** Inside one of the workspace's folders (relative or absolute) or the extension's own folder. */
  cwd?: string;
  env?: Record<string, string>;
  /** "lines" (default): each stdout line is a string; "ndjson": parsed JSON per line. */
  framing?: "lines" | "ndjson";
}

/** A process the extension started (D202). */
export interface ProcessHandle {
  readonly id: string;
  /** A line of text ("lines"; a multi-line string is several lines), or a JSON value ("ndjson"). */
  send(data: string | object): Promise<void>;
  onMessage(listener: (message: unknown) => void): Disposable;
  onStderr(listener: (line: string) => void): Disposable;
  onExit(listener: (code: number | null, signal?: string) => void): Disposable;
  kill(): Promise<void>;
  /** Closes its input: it reads end-of-file (D203). */
  closeStdin(): Promise<void>;
  /** Ctrl+C (SIGINT, D203; on Windows a Ctrl+C on its console). Rejects when it can't be sent. */
  interrupt(): Promise<void>;
}

export interface DialogOptions {
  title: string;
  message: string;
  actions: { label: string; variant?: "primary" | "danger" }[];
  /** A cancel button's label (Escape cancels anyway): resolves undefined. */
  cancel?: string;
}

export interface QuickPickEntry {
  label: string;
  description?: string;
  /** An icon of the IDE's set. */
  icon?: string;
  /** More about the item (shown as its tooltip). */
  detail?: string;
  /** Starts a group: a line above the item with this name (VS Code's separator items, D234). */
  separator?: string;
  /** Checked at first (with `canPickMany`). */
  picked?: boolean;
}

/** The `ide` global inside an extension worker (types: src/api/index.d.ts). */
export interface WorkerApi {
  extension: { id: string; version: string; path: string };
  env: { platform: EnvPlatform } & EnvExtrasApi;
  /** A small JSON store for the open folder or multi-root workspace (VS Code's workspaceState, D234). */
  workspaceState: MementoApi;
  /** Notebook file formats and kernels (D202). */
  notebooks: NotebooksApi;
  /** Read-only git ("git", D208). */
  git: GitApi;
  /** GitHub through the user's gh sign-in ("github", D208). */
  github: GitHubApi;
  /** Terminals it makes: a shell, or a pseudoterminal it serves (D233). */
  terminals: TerminalsApi;
  /** Task providers (D233): their tasks join Run task. */
  tasks: TasksApi;
  /** Source controls in the Source control view (D233). */
  scm: ScmApi;
  /** Debug adapters for its debug types (D233). */
  debug: DebugApi;
  /** Authentication providers and sessions (D233). */
  authentication: AuthenticationApi;
  /** Its own secrets in the OS keychain (D233). */
  secrets: SecretsApi;
  /** Test controllers whose tests join the Testing view (VS Code's `tests`). */
  tests: TestsApi;
  /** Comment threads in files (VS Code's comments API). */
  comments: CommentsApi;
  /** "@name" chat participants (VS Code's chat API). */
  chat: ChatApi;
  /** The user's language model ("extensions.languageModelAccess" and the user's consent). */
  lm: LanguageModelApi;
  commands: {
    register(
      id: string,
      handler: (input: unknown, context: CommandRunContext) => unknown,
    ): Disposable;
    execute<T = unknown>(id: string, input?: unknown): Promise<T>;
  };
  state: {
    get<T = unknown>(path: string): Promise<T>;
    /** Fills `path` (under ide://ext/<id>/) with what `getter` returns when it's read (2 s). */
    register(
      path: string,
      getter: (context: { params: Record<string, string> }) => unknown,
    ): Disposable;
  };
  events: { on(type: string, listener: (payload: unknown) => void): Disposable };
  /** Context keys for `when` clauses: only keys starting with "<extension id>.". */
  context: {
    set(key: string, value: string | number | boolean | null | undefined): Promise<void>;
  };
  /** Programs the extension runs ("shell" and a trusted folder). */
  process: { spawn(options: SpawnOptions): Promise<ProcessHandle> };
  workspace: {
    isTrusted(): Promise<boolean>;
    /** Asks the user to trust the folder when undecided; resolves whether it's trusted. */
    requireTrust(reason: string): Promise<boolean>;
    onDidChangeTrust(listener: (trusted: boolean) => void): Disposable;
    /** The first folder (the primary; see `folders()` / `workspaceFolders` for all, D251). */
    root(): Promise<string | null>;
    fs: {
      read(path: string): Promise<string>;
      /** A file's bytes as base64, for images and other binary files (8 MB at most, D183). */
      readBase64(path: string): Promise<string>;
      /** Writes bytes given as base64 (an image the page made or was pasted, D184). */
      writeBase64(path: string, data: string): Promise<void>;
      write(path: string, text: string): Promise<void>;
      stat(path: string): Promise<unknown>;
      list(path: string): Promise<{ name: string; path: string; kind: string }[]>;
    };
    findText(query: string, options?: FindTextOptions): Promise<FindTextResult>;
    /** Serves a URI scheme to the editor and the explorer (D233). */
    registerFileSystemProvider: FileSystemsApi["registerFileSystemProvider"];
  } & WorkspaceExtrasApi &
    WorkspaceFoldersApi &
    Pick<
      HookApis,
      "applyEdit" | "createWorkspaceEdit" | "onWillSaveTextDocument" | "onWillSaveNotebookDocument"
    >;
  /** The active text editor (needs "fs.read" to look, "fs.write" to type). */
  editor: {
    active(): Promise<ActiveEditor | null>;
    /** Types `text` at the cursor (replacing selected text), like the user typing it. */
    insert(text: string): Promise<void>;
    /** Opens a file in the editor (fs.read). */
    open(
      path: string,
      /** VS Code's showTextDocument options (D255): a selection, keeping focus, beside. */
      options?: {
        line?: number;
        column?: number;
        preview?: boolean;
        selection?: TextRange;
        preserveFocus?: boolean;
        toSide?: boolean;
      },
    ): Promise<void>;
    /** A file's text as the editor has it (unsaved edits included; default: the active one). */
    text(path?: string): Promise<string>;
    /** Replaces a range (fs.write): in the editor when open (undoable), else on disk. */
    replace(range: TextRange, text: string, path?: string): Promise<void>;
    /** Selects a range in the active editor. */
    select(range: TextRange): Promise<void>;
    /**
     * Decorates ranges of a file (default: the active one) with a theme style; the same `key`
     * again replaces them, no ranges clears them.
     */
    decorate(
      key: string,
      options: {
        path?: string;
        style: "highlight" | "underline" | "error" | "warning" | "info" | "faded" | "strong";
        ranges: (TextRange & { hover?: string })[];
        after?: string;
      },
    ): Promise<void>;
    clearDecorations(key?: string): Promise<void>;
    /** Text before each line of a file (D208, "fs.read"); null or [] removes it. */
    setLineAnnotations(path: string, annotations: LineAnnotation[] | null): Promise<void>;
  } & EditorExtrasApi &
    Pick<HookApis, "setOptions">;
  /** Problems and language providers (hovers, completions, definitions…) in files (D176). */
  languages: LanguagesApi;
  ui: {
    notify(
      message: string,
      options?: { kind?: "info" | "success" | "warning" | "error"; actions?: string[] },
    ): Promise<string | undefined>;
    showQuickPick<T extends QuickPickEntry>(
      items: T[],
      options?: {
        placeholder?: string;
        matchOnDescription?: boolean;
        canPickMany?: false;
        /** The row active at first (VS Code's activeItems). */
        activeIndex?: number;
      },
    ): Promise<T | undefined>;
    /** Several items (VS Code's canPickMany): the checked ones, or undefined when cancelled. */
    showQuickPick<T extends QuickPickEntry>(
      items: T[],
      options: { placeholder?: string; matchOnDescription?: boolean; canPickMany: true },
    ): Promise<T[] | undefined>;
    /**
     * A live quick pick or input box (VS Code's createQuickPick / createInputBox): properties
     * change while it's open, Enter is reported without closing it (rpcQuickInput.ts).
     */
    quickInput: QuickInputApi;
    /**
     * Closes editor tabs by their ids (from the "tabs.didChange" snapshots, VS Code's
     * tabGroups.close): true when all closed (a tab with unsaved changes may stay).
     */
    closeTabs(ids: string[], preserveFocus?: boolean): Promise<boolean>;
    /** Links to the IDE for this extension (`<scheme>://<extension id>/…`; VS Code's). */
    registerUriHandler: HookApis["registerUriHandler"];
    /** A modal question; resolves with the chosen action's label (undefined: cancelled). */
    showDialog(options: DialogOptions): Promise<string | undefined>;
    /**
     * Badges, colors and tooltips on files (D258, VS Code's registerFileDecorationProvider; needs
     * "fs.read"): asked per path as the Explorer shows it; `fireDidChange` asks again.
     */
    registerFileDecorationProvider(provider: {
      provideFileDecoration(
        path: string,
      ):
        | { badge?: string; tooltip?: string; color?: string }
        | null
        | undefined
        | Promise<{ badge?: string; tooltip?: string; color?: string } | null | undefined>;
    }): Disposable & { fireDidChange(paths?: string[]): void };
    /** The system's open dialog (D257): the picked paths, or undefined when cancelled. */
    showOpenDialog(options?: {
      title?: string;
      defaultPath?: string;
      folders?: boolean;
      many?: boolean;
      filters?: { name: string; extensions: string[] }[];
    }): Promise<string[] | undefined>;
    /** The system's save dialog (D257): the chosen path, or undefined when cancelled. */
    showSaveDialog(options?: { title?: string; defaultPath?: string }): Promise<string | undefined>;
    showInput(options?: {
      prompt?: string;
      value?: string;
      placeholder?: string;
      /** Masks what is typed (a token, D234). */
      password?: boolean;
      /** A validation problem shown at first (VS Code's InputBox.validationMessage). */
      error?: string;
    }): Promise<string | undefined>;
    registerTreeView(
      viewId: string,
      provider: TreeProvider,
    ): {
      refresh(): void;
      /** A line above the rows (D208): what's shown, or why nothing is; "" removes it. */
      setMessage(message: string): void;
      /** Rows' checkboxes the user clicked. */
      onDidChangeCheckboxState(listener: (changes: TreeCheckboxChange[]) => void): Disposable;
      /**
       * Shows a row (D258, VS Code's TreeView.reveal): `path` is its id and its parents' ids, top
       * first; they're expanded on the way. `select` (default true), `focus`, `expand` it.
       */
      reveal(
        path: string[],
        options?: { select?: boolean; focus?: boolean; expand?: boolean },
      ): Promise<void>;
      /** The user selected rows (D258). */
      onDidChangeSelection(listener: (items: TreeItem[]) => void): Disposable;
      /** A row was expanded or collapsed in the view (VS Code's onDidExpand/CollapseElement). */
      onDidChangeExpansion(listener: (item: TreeItem, expanded: boolean) => void): Disposable;
      /** A number on the view's activity bar icon (VS Code's TreeView.badge); 0 removes it. */
      setBadge(badge: { value: number; tooltip?: string } | undefined): void;
    } & Disposable;
    /**
     * One of its views' title and description (VS Code's TreeView / WebviewView `title` and
     * `description`), shown in the view's header; both undefined: its manifest title again.
     */
    setViewTitle(viewId: string, title: { title?: string; description?: string }): void;
    /**
     * Whether one of its views shows (VS Code's TreeView / WebviewView `visible`): `visible`
     * answers now, `listener` hears the changes until disposed.
     */
    watchView(
      viewId: string,
      listener: (visible: boolean) => void,
    ): { visible: Promise<boolean> } & Disposable;
    /**
     * Its own channel in the Output tab (VS Code's `window.createOutputChannel`); `log`: a log
     * channel, whose level the user picks ("Set log level…").
     */
    createOutputChannel(name: string, options?: { log?: boolean }): OutputChannel;
    /**
     * The log levels the user picked (VS Code's numbers): the default and its log channels' own,
     * by channel id; `listener` hears every change until disposed.
     */
    logLevels(listener: (levels: LogLevelsMessage) => void): Disposable;
    /** A page its code writes, in a dock tab (VS Code's `window.createWebviewPanel`). */
    createWebviewPanel: WebviewPanelsApi["createWebviewPanel"];
    /** Its panels of a view type come back after a restart (VS Code's serializer). */
    registerWebviewPanelSerializer: WebviewPanelsApi["registerWebviewPanelSerializer"];
    /**
     * Shows that `task` is under way (VS Code's `window.withProgress`) until it settles; resolves
     * or rejects as it does.
     */
    withProgress<T>(
      options: ProgressOptions,
      task: (progress: Progress, token: CancellationToken) => T | Promise<T>,
    ): Promise<T>;
    webview(viewId: string): {
      /** `instance`: one tab of a code-page viewer (D257); default every page of the view. */
      postMessage(message: unknown, instance?: number): Promise<void>;
      /**
       * The page of a view or viewer whose code writes it (`codePage`, D257: VS Code's webview
       * views and custom editors); `instance` is a viewer's tab.
       */
      setHtml(html: string, instance?: number): Promise<void>;
      /** A code-page viewer tab has unsaved changes (D258): the tab shows it, closing asks. */
      setDirty(dirty: boolean, instance: number): Promise<void>;
      onMessage(listener: (message: unknown) => void): Disposable;
      /**
       * Shows the view. `background`: its tab opens behind the active one, nothing takes the
       * focus (a side bar view: nothing opens; D269).
       */
      reveal(options?: { background?: boolean }): Promise<void>;
      /** Shows the view's tab in a window of its own (panel and editor views). */
      openInWindow(options?: { width?: number; height?: number }): Promise<void>;
    };
    /** An item in the status bar; `update` changes it, `dispose` removes it. */
    createStatusBarItem(options: StatusBarItemOptions): {
      update(options: Partial<Omit<StatusBarItemOptions, "id">>): Promise<void>;
    } & Disposable;
  };
  settings: {
    get<T = unknown>(key: string): Promise<T>;
    onChange(listener: (keys: string[]) => void): Disposable;
    /**
     * Writes a setting (VS Code's WorkspaceConfiguration.update): its own, or another a folder's
     * settings could set; "fs.write" (D234). `target` default "user".
     */
    update(key: string, value: unknown, target?: "user" | "workspace"): Promise<void>;
  };
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
  };
  net: {
    fetch(
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ): Promise<{
      status: number;
      ok: boolean;
      headers: Record<string, string>;
      text(): string;
      json(): unknown;
    }>;
  };
}

/** Builds the worker's `ide` object and routes host messages to the extension's callbacks. */
export function createWorkerApi(
  transport: Transport,
  manifest: {
    id: string;
    version: string;
    path?: string;
    platform?: EnvPlatform;
    appName?: string;
    language?: string;
    uriScheme?: string;
    themeKind?: "light" | "dark";
    workspace?: unknown;
  },
): {
  api: WorkerApi;
  /** Runs the extension's deactivate callback (if any) when the host stops it. */
  onDeactivate(handler: () => unknown): void;
  /**
   * Other VS Code packages (D295): they share its process, so their exports are live objects;
   * the IDE activates one when asked (its dependencies, permissions and trust are checked there).
   */
  extensions: {
    /** Resolves once `id` has activated (in the shared host), rejects when it can't. */
    activate(id: string): Promise<void>;
  };
} {
  let nextId = 1;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  const commands = new Map<string, (input: unknown, context: CommandRunContext) => unknown>();
  const stateGetters = new Map<string, (c: { params: Record<string, string> }) => unknown>();
  const processes = new Map<string, ProcessRecord>();
  let processSeq = 0;
  const trees = new Map<string, TreeProvider>();
  const webviewListeners = new Map<string, Set<(m: unknown) => void>>();
  const eventListeners = new Map<string, (p: unknown) => void>();
  const settingsListeners = new Set<(keys: string[]) => void>();
  const hovers = new Map<string, (c: ProviderContext, token?: CallToken) => unknown>();
  const completions = new Map<string, (c: ProviderContext, token?: CallToken) => unknown>();
  const otherProviders = new Map<string, (c: never) => unknown>();
  /** withProgress tasks under way, by id: what the host's Cancel calls. */
  const progressTasks = new Map<string, () => void>();
  let progressSeq = 0;
  let deactivate: (() => unknown) | undefined;
  let notebooks: ReturnType<typeof createNotebooksApi> | undefined;

  const request = <T>(method: string, params: unknown = {}): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        transport.post({ t: "req", id, method, params });
      } catch (err) {
        // Params that can't be sent (a cycle, a BigInt): the request fails and isn't kept.
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

  /** Provider calls under way that the host may cancel, by the call's id. */
  const cancellable = new Map<number, CallTokenSource>();

  const failure = (id: number, err: unknown): ReplyMessage => ({
    t: "res",
    id,
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  });
  const reply = (id: number, run: () => unknown) => {
    Promise.resolve()
      .then(run)
      .then(
        (value) => {
          // An answer that can't be sent (a cycle, a BigInt) is an error, not no answer at all:
          // the host waited for ever and the rejection went unhandled.
          try {
            transport.post({ t: "res", id, ok: true, value });
          } catch (err) {
            const why = err instanceof Error ? err.message : String(err);
            transport.post(failure(id, `The answer couldn't be sent: ${why}`));
          }
        },
        (err: unknown) => transport.post(failure(id, err)),
      )
      .catch(() => {
        // The transport itself is gone: nothing to answer on.
      })
      .finally(() => cancellable.delete(id));
  };

  transport.onMessage((m) => {
    if (m.t === "cancel") {
      cancellable.get(m.id)?.cancel();
      return;
    }
    if (m.t === "res") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(m.error ?? "failed"));
    } else if (m.t === "call") {
      // A language provider's answer the editor may stop waiting for gets a token (CallToken).
      const source =
        m.kind === "hover" || m.kind === "completion" || m.kind === "provider"
          ? new CallTokenSource()
          : undefined;
      if (source) cancellable.set(m.id, source);
      const token = source?.token;
      reply(m.id, () => {
        switch (m.kind) {
          case "command": {
            const handler = commands.get(m.target);
            if (!handler) throw new Error(`The extension has no handler for ${m.target}.`);
            return handler(m.args, commandContext(m.context));
          }
          case "tree": {
            const provider = trees.get(m.target);
            if (!provider) return [];
            return provider.getChildren((m.args as { parent?: TreeItem } | undefined)?.parent);
          }
          case "webview":
            for (const l of webviewListeners.get(m.target) ?? []) l(m.args);
            return undefined;
          case "event":
            eventListeners.get(m.target)?.(m.args);
            return undefined;
          case "settings":
            for (const l of settingsListeners) l((m.args as string[]) ?? []);
            return undefined;
          case "deactivate":
            return deactivate?.();
          case "hover": {
            const provide = hovers.get(m.target);
            return provide ? provide(m.args as ProviderContext, token) : null;
          }
          case "completion": {
            const provide = completions.get(m.target);
            return provide ? provide(m.args as ProviderContext, token) : [];
          }
          case "progress":
            progressTasks.get(m.target)?.();
            return undefined;
          case "provider": {
            const provide = otherProviders.get(m.target);
            // JSON has no undefined: "nothing" is null.
            return provide
              ? Promise.resolve(
                  (provide as (c: never, t?: CallToken) => unknown)(m.args as never, token),
                ).then((r) => r ?? null)
              : null;
          }
          case "notebook":
            if (!notebooks) throw new Error("Not ready.");
            return notebooks.call(m.target, m.args);
          case "process":
            processes.get(m.target)?.receive(m.args as ProcessBatch);
            return undefined;
          case "workspace":
            workspaceFolders.receive(m.target, m.args);
            return undefined;
          case "state": {
            const getter = stateGetters.get(m.target);
            if (!getter) throw new Error(`${m.target} isn't registered.`);
            const params = (m.args as { params?: Record<string, string> } | undefined)?.params;
            return getter({ params: params ?? {} });
          }
        }
      });
    }
  });

  let subscription = 0;
  let decorationSeq = 0;
  notebooks = createNotebooksApi(request);
  const gitApis = createGitApi(request, (type, listener) => api.events.on(type, listener));
  // Language providers (rpcLanguages.ts), terminals, tasks, source control, debug adapters,
  // authentication, file systems (D233): their callbacks are "provider" calls.
  const onCall: OnCall = (key, handler) => {
    otherProviders.set(key, handler);
    return () => {
      if (otherProviders.get(key) === handler) otherProviders.delete(key);
    };
  };
  const terminalApis = createTerminalApis(request, onCall);
  const scmDebugApis = createScmDebugApis(request, onCall, (type, listener) =>
    api.events.on(type, listener),
  );
  const authFsApis = createAuthFsApis(request, onCall);
  const hookApis = createHookApis(request, onCall);
  const chatApis = createChatApis(request, onCall);
  const workspaceFolders = createWorkspaceFolders(request, manifest.workspace);
  // Run-time webview panels; their pages may load the workspace's files (VS Code's default
  // localResourceRoots).
  const webviewPanels = createWebviewPanelsApi(request, onCall, manifest.path ?? "", () =>
    (workspaceFolders.api.workspaceFolders ?? []).map((f) => f.path),
  );
  const spawn = async (options: SpawnOptions): Promise<ProcessHandle> => {
    const id = `p${++processSeq}`;
    const framing = options?.framing === "ndjson" ? "ndjson" : "lines";
    // Registered before the request: output can arrive before the answer does.
    const record = new ProcessRecord(id, framing, request);
    processes.set(id, record);
    record.onDone(() => processes.delete(id));
    try {
      await request("process.spawn", { ...options, id, framing });
    } catch (err) {
      processes.delete(id);
      throw err;
    }
    return record.handle;
  };

  const withProgress = async <T>(
    options: ProgressOptions,
    task: (progress: Progress, token: CancellationToken) => T | Promise<T>,
  ): Promise<T> => {
    const id = `g${++progressSeq}`;
    let cancelled = false;
    const listeners = new Set<() => void>();
    progressTasks.set(id, () => {
      if (cancelled) return;
      cancelled = true;
      for (const l of [...listeners]) l();
    });
    const token: CancellationToken = {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested(listener) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    };
    // Shown or not (too many at once), the task runs.
    void request("ui.progressStart", {
      id,
      location: options?.location === "window" ? "window" : "notification",
      title: String(options?.title ?? ""),
      cancellable: options?.cancellable === true,
    }).catch(() => {});
    try {
      return await task(
        {
          report: (value) =>
            void request("ui.progressReport", {
              id,
              ...(typeof value?.message === "string" && { message: value.message }),
              ...(typeof value?.increment === "number" && { increment: value.increment }),
            }).catch(() => {}),
        },
        token,
      );
    } finally {
      progressTasks.delete(id);
      listeners.clear();
      void request("ui.progressEnd", { id }).catch(() => {});
    }
  };

  const api: WorkerApi = {
    extension: { id: manifest.id, version: manifest.version, path: manifest.path ?? "" },
    env: {
      platform: manifest.platform ?? "linux",
      ...createEnvExtras(request, manifest),
    },
    workspaceState: createWorkspaceState(request),
    notebooks: notebooks.api,
    git: gitApis.git,
    github: gitApis.github,
    terminals: terminalApis.terminals,
    tasks: terminalApis.tasks,
    scm: scmDebugApis.scm,
    debug: scmDebugApis.debug,
    authentication: authFsApis.authentication,
    secrets: authFsApis.secrets,
    tests: createTestsApi(request, onCall),
    comments: createCommentsApi(request, onCall),
    chat: chatApis.chat,
    lm: chatApis.lm,
    commands: {
      register(id, handler) {
        commands.set(id, handler);
        void request("commands.register", { id }).catch(() => commands.delete(id));
        return {
          dispose: () => {
            commands.delete(id);
            void request("commands.unregister", { id }).catch(() => {});
          },
        };
      },
      execute: (id, input) => request("commands.execute", { id, input: input ?? {} }),
    },
    state: {
      get: (path) => request("state.get", { path }),
      register(path, getter) {
        stateGetters.set(path, getter);
        void request("state.register", { path }).catch((err: unknown) => {
          stateGetters.delete(path);
          console.error(err instanceof Error ? err.message : String(err));
        });
        return {
          dispose: () => {
            stateGetters.delete(path);
            void request("state.unregister", { path }).catch(() => {});
          },
        };
      },
    },
    context: {
      set: (key, value) => request("context.set", { key, value: value ?? null }),
    },
    process: { spawn },
    events: {
      on(type, listener) {
        const sub = `e${++subscription}`;
        eventListeners.set(sub, listener);
        void request("events.subscribe", { type, sub });
        return {
          dispose: () => {
            eventListeners.delete(sub);
            void request("events.unsubscribe", { sub }).catch(() => {});
          },
        };
      },
    },
    workspace: withWorkspaceFolders(
      {
        isTrusted: () => request("workspace.isTrusted"),
        requireTrust: (reason) =>
          request("workspace.requireTrust", { reason: String(reason ?? "") }),
        onDidChangeTrust: (listener) =>
          api.events.on("workspace.didChangeTrust", (p) =>
            listener((p as { trusted?: unknown } | null)?.trusted === true),
          ),
        root: () => request("workspace.root"),
        fs: {
          read: (path) => request("fs.read", { path }),
          readBase64: (path) => request("fs.readBase64", { path }),
          writeBase64: (path, data) => request("fs.writeBase64", { path, data }),
          write: (path, text) => request("fs.write", { path, text }),
          stat: (path) => request("fs.stat", { path }),
          list: (path) => request("fs.list", { path }),
        },
        findText: (query, options = {}) => request("fs.findText", { query, ...options }),
        registerFileSystemProvider: authFsApis.fileSystems.registerFileSystemProvider,
        ...createWorkspaceExtras(
          request,
          (type, listener) => api.events.on(type, listener),
          () => workspaceFolders.api.workspaceFolders ?? [],
        ),
        applyEdit: hookApis.applyEdit,
        createWorkspaceEdit: hookApis.createWorkspaceEdit,
        onWillSaveTextDocument: hookApis.onWillSaveTextDocument,
        onWillSaveNotebookDocument: hookApis.onWillSaveNotebookDocument,
      },
      workspaceFolders.api,
    ),
    editor: {
      active: () => request("editor.active"),
      insert: (text) => request("editor.insert", { text }),
      open: (path, options = {}) => request("editor.open", { path, ...options }),
      text: (path) => request("editor.text", path === undefined ? {} : { path }),
      replace: (range, text, path) =>
        request("editor.replace", { range, text, ...(path !== undefined && { path }) }),
      select: (range) => request("editor.select", { range }),
      decorate: (key, options) => request("editor.decorate", { key, ...options }),
      clearDecorations: (key) => request("editor.clearDecorations", key ? { key } : {}),
      setLineAnnotations: (path, annotations) =>
        request("editor.setLineAnnotations", { path, annotations: annotations ?? [] }),
      ...createEditorExtras(request, (type, listener) => api.events.on(type, listener)),
      setOptions: hookApis.setOptions,
    },
    languages: createLanguagesApi(request, onCall, hovers, completions),
    ui: {
      withProgress,
      // The host answers null for "nothing" (JSON has no undefined); the API says undefined.
      notify: (message, options = {}) =>
        request("ui.notify", { message, ...options }).then((r) => (r ?? undefined) as never),
      showQuickPick: (async (items: QuickPickEntry[], options: Record<string, unknown> = {}) => {
        // canPickMany (VS Code's): the host answers with the checked items' indexes.
        const answer = await request<number | number[] | null>("ui.showQuickPick", {
          items: items.map((i) => ({
            label: i.label,
            description: i.description,
            icon: i.icon,
            detail: i.detail,
            ...(typeof i.separator === "string" && { separator: i.separator }),
            ...(i.picked === true && { picked: true }),
          })),
          ...options,
        });
        if (answer === null || answer === undefined) return undefined;
        if (Array.isArray(answer))
          return answer.flatMap((n) => (items[n] === undefined ? [] : [items[n]]));
        return items[answer];
      }) as WorkerApi["ui"]["showQuickPick"],
      quickInput: createQuickInputApi(request, onCall),
      closeTabs: (ids, preserveFocus = false) =>
        request<boolean>("tabs.close", { ids: ids.map(String), preserveFocus }).then(
          (r) => r !== false,
        ),
      registerUriHandler: hookApis.registerUriHandler,
      showDialog: (options) =>
        request("ui.showDialog", options).then((r) => (r ?? undefined) as never),
      registerFileDecorationProvider(provider) {
        const id = `d${++decorationSeq}`;
        const off = onCall(`decorations.${id}`, async (args: { paths?: unknown }) => {
          const paths = Array.isArray(args?.paths) ? args.paths.map(String).slice(0, 200) : [];
          return Promise.all(
            paths.map(async (path) => ({
              path,
              decoration:
                (await Promise.resolve(provider.provideFileDecoration(path)).catch(() => null)) ??
                null,
            })),
          );
        });
        void request("decorations.register", { id }).catch((err: unknown) => {
          off();
          console.error(err instanceof Error ? err.message : String(err));
        });
        return {
          fireDidChange: (paths) =>
            void request("decorations.changed", {
              id,
              ...(paths && { paths: paths.map(String) }),
            }).catch(() => {}),
          dispose: () => {
            off();
            void request("decorations.unregister", { id }).catch(() => {});
          },
        };
      },
      showOpenDialog: (options = {}) =>
        request("ui.showOpenDialog", options).then((r) => (r ?? undefined) as never),
      showSaveDialog: (options = {}) =>
        request("ui.showSaveDialog", options).then((r) => (r ?? undefined) as never),
      showInput: (options = {}) =>
        request("ui.showInput", options).then((r) => (r ?? undefined) as never),
      createStatusBarItem(options) {
        let current = { ...options };
        void request("statusBar.set", current).catch(() => {});
        return {
          update: (changes) => {
            current = { ...current, ...changes, id: options.id };
            return request("statusBar.set", current);
          },
          dispose: () => void request("statusBar.remove", { id: options.id }).catch(() => {}),
        };
      },
      registerTreeView(viewId, provider) {
        trees.set(viewId, provider);
        const extras = treeExtras(viewId, provider, onCall);
        void request("tree.register", { viewId, ...(extras.dragAndDrop && { dragAndDrop: true }) });
        return {
          refresh: () => void request("tree.refresh", { viewId }).catch(() => {}),
          setMessage: (message) =>
            void request("tree.message", { viewId, message: String(message ?? "") }).catch(
              () => {},
            ),
          onDidChangeCheckboxState: extras.onDidChangeCheckboxState,
          onDidChangeSelection: extras.onDidChangeSelection,
          onDidChangeExpansion: extras.onDidChangeExpansion,
          setBadge: (badge) =>
            void request("tree.update", {
              viewId,
              badge: badge
                ? { value: Number(badge.value) || 0, tooltip: String(badge.tooltip ?? "") }
                : null,
            }).catch(() => {}),
          reveal: (path, options = {}) =>
            request("tree.reveal", { viewId, path: path.map(String), ...options }).then(() => {}),
          dispose: () => {
            trees.delete(viewId);
            extras.dispose();
          },
        };
      },
      setViewTitle(viewId, { title, description }) {
        void request("view.title", {
          viewId,
          ...(typeof title === "string" && { title }),
          ...(typeof description === "string" && { description }),
        }).catch(() => {});
      },
      watchView(viewId, listener) {
        const off = onCall(`view.${viewId}.visible`, (args: { visible?: unknown }) => {
          listener(args?.visible === true);
          return null;
        });
        const visible = request<boolean>("view.watch", { viewId }).then(
          (v) => v === true,
          () => true,
        );
        return {
          visible,
          dispose: () => {
            off();
            void request("view.watch", { viewId, watch: false }).catch(() => {});
          },
        };
      },
      createOutputChannel: (name, options) => createOutputChannel(request, name, options),
      logLevels(listener) {
        // Changes as the user picks them; the levels now, asked once.
        const off = onCall("logLevels", (levels: LogLevelsMessage) => {
          if (levels && typeof levels === "object") listener(levels);
          return null;
        });
        void request<LogLevelsMessage>("logLevels.get", {})
          .then((levels) => {
            if (levels && typeof levels === "object") listener(levels);
          })
          .catch(() => {});
        return { dispose: off };
      },
      createWebviewPanel: webviewPanels.createWebviewPanel,
      registerWebviewPanelSerializer: webviewPanels.registerWebviewPanelSerializer,
      webview(viewId) {
        return {
          postMessage: (message, instance) =>
            request("webview.post", {
              viewId,
              message,
              ...(instance !== undefined && { instance }),
            }),
          setHtml: (html, instance) =>
            request("webview.setHtml", {
              viewId,
              html,
              ...(instance !== undefined && { instance }),
            }),
          setDirty: (dirty, instance) =>
            request("webview.setDirty", { viewId, dirty, instance }).then(() => {}),
          reveal: (options) =>
            request("webview.reveal", { viewId, background: options?.background === true }),
          openInWindow: (options = {}) => request("webview.openInWindow", { viewId, ...options }),
          onMessage(listener) {
            let set = webviewListeners.get(viewId);
            if (!set) {
              set = new Set();
              webviewListeners.set(viewId, set);
            }
            set.add(listener);
            return { dispose: () => set?.delete(listener) };
          },
        };
      },
    },
    settings: {
      get: (key) => request("settings.get", { key }).then((r) => (r ?? undefined) as never),
      onChange(listener) {
        settingsListeners.add(listener);
        if (settingsListeners.size === 1) void request("settings.subscribe").catch(() => {});
        return { dispose: () => settingsListeners.delete(listener) };
      },
      // Through the settings command: the host's checks for extensions apply.
      update: (key, value, target = "user") =>
        request("commands.execute", {
          id: "settings.set",
          input: { key, value, scope: target === "workspace" ? "workspace" : "user" },
        }).then(() => undefined),
    },
    storage: {
      get: (key) => request("storage.get", { key }),
      set: (key, value) => request("storage.set", { key, value }),
    },
    net: {
      async fetch(url, init = {}) {
        const r = await request<{ status: number; headers: [string, string][]; body: string }>(
          "net.fetch",
          { url, ...init },
        );
        const headers = Object.fromEntries(r.headers.map(([k, v]) => [k.toLowerCase(), v]));
        return {
          status: r.status,
          ok: r.status >= 200 && r.status < 300,
          headers,
          text: () => r.body,
          json: () => JSON.parse(r.body) as unknown,
        };
      },
    },
  };
  return {
    api,
    onDeactivate: (handler) => {
      deactivate = handler;
    },
    extensions: {
      activate: (id) => request("extensions.activate", { id }).then(() => undefined),
    },
  };
}

/** A tree's drops and checkbox clicks: "provider" calls `tree.<view id>.drop` / `.checkbox`. */
function treeExtras(viewId: string, provider: TreeProvider, onCall: OnCall) {
  const drop = provider.dragAndDropController ?? (provider.handleDrop ? provider : undefined);
  const listeners = new Set<(changes: TreeCheckboxChange[]) => void>();
  const selection = new Set<(items: TreeItem[]) => void>();
  const expansion = new Set<(item: TreeItem, expanded: boolean) => void>();
  const offs = [
    onCall(`tree.${viewId}.expanded`, (args: { item?: TreeItem; expanded?: unknown }) => {
      if (args?.item && typeof args.item === "object")
        for (const l of [...expansion]) l(args.item, args.expanded === true);
      return null;
    }),
    onCall(`tree.${viewId}.selection`, (args: { items?: TreeItem[] }) => {
      const items = Array.isArray(args?.items) ? args.items : [];
      for (const l of [...selection]) l(items);
      return null;
    }),
    onCall(`tree.${viewId}.checkbox`, (args: { changes?: TreeCheckboxChange[] }) => {
      const changes = Array.isArray(args?.changes) ? args.changes : [];
      provider.onDidChangeCheckboxState?.(changes);
      for (const l of [...listeners]) l(changes);
      return null;
    }),
    onCall(
      `tree.${viewId}.drop`,
      async (args: { target?: TreeItem | null; sources?: TreeItem[] }) => {
        await drop?.handleDrop?.(
          args?.target ?? undefined,
          Array.isArray(args?.sources) ? args.sources : [],
        );
        return null;
      },
    ),
  ];
  return {
    dragAndDrop: !!drop,
    onDidChangeCheckboxState: (listener: (changes: TreeCheckboxChange[]) => void): Disposable => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    onDidChangeSelection: (listener: (items: TreeItem[]) => void): Disposable => {
      selection.add(listener);
      return { dispose: () => selection.delete(listener) };
    },
    onDidChangeExpansion: (listener: (item: TreeItem, expanded: boolean) => void): Disposable => {
      expansion.add(listener);
      return { dispose: () => expansion.delete(listener) };
    },
    dispose: () => {
      for (const off of offs) off();
      listeners.clear();
      selection.clear();
      expansion.clear();
    },
  };
}

function commandContext(raw: unknown): CommandRunContext {
  const caller = (raw as { caller?: unknown } | undefined)?.caller;
  return {
    caller: caller === "user" || caller === "agent" || caller === "extension" ? caller : "other",
  };
}

/** Events kept for a listener that isn't there yet (output before `onMessage` was called). */
const MAX_BUFFERED = 1000;

/** The worker's side of one process: its listeners, and what came before they were added. */
class ProcessRecord {
  private readonly messages = new Set<(m: unknown) => void>();
  private readonly stderr = new Set<(line: string) => void>();
  private readonly exits = new Set<(code: number | null, signal?: string) => void>();
  private readonly early: { messages: unknown[]; stderr: string[] } = { messages: [], stderr: [] };
  private exit: { code: number | null; signal?: string } | null = null;
  private done: (() => void) | null = null;
  readonly handle: ProcessHandle;

  constructor(
    readonly id: string,
    private readonly framing: "lines" | "ndjson",
    request: <T>(method: string, params?: unknown) => Promise<T>,
  ) {
    const listen = <L>(set: Set<L>, listener: L, flush: () => void): Disposable => {
      set.add(listener);
      // What came before goes to the first listener, once the caller's code has run.
      queueMicrotask(flush);
      return { dispose: () => set.delete(listener) };
    };
    this.handle = {
      id,
      send: (data) => {
        if (this.exit) return Promise.reject(new Error(`Process ${id} has exited.`));
        return request("process.send", { id, data });
      },
      onMessage: (l) =>
        listen(this.messages, l, () => this.flush(this.early.messages, this.messages)),
      onStderr: (l) => listen(this.stderr, l, () => this.flush(this.early.stderr, this.stderr)),
      onExit: (l) =>
        listen(this.exits, l, () => {
          if (this.exit) l(this.exit.code, this.exit.signal);
        }),
      kill: () => request("process.kill", { id }),
      closeStdin: () => request("process.closeStdin", { id }),
      interrupt: () => request("process.interrupt", { id }),
    };
  }

  onDone(done: () => void): void {
    this.done = done;
  }

  receive(batch: ProcessBatch | undefined): void {
    for (const e of batch?.events ?? []) {
      if (e.kind === "message")
        this.deliver(this.parse(e.body), this.early.messages, this.messages);
      else if (e.kind === "stderr") this.deliver(e.line, this.early.stderr, this.stderr);
      else this.exited(e.code, e.signal);
    }
  }

  private parse(body: string): unknown {
    if (this.framing !== "ndjson") return body;
    try {
      return JSON.parse(body) as unknown;
    } catch {
      // Not JSON (a library printing to stdout): it arrives as the line's text.
      return body;
    }
  }

  private deliver<V>(value: V, early: V[], listeners: Set<(v: V) => void>): void {
    if (!listeners.size) {
      if (early.length < MAX_BUFFERED) early.push(value);
      return;
    }
    for (const l of listeners) l(value);
  }

  private flush<V>(early: V[], listeners: Set<(v: V) => void>): void {
    for (const v of early.splice(0)) for (const l of listeners) l(v);
  }

  private exited(code: number | null, signal?: string): void {
    if (this.exit) return;
    this.exit = { code, ...(signal !== undefined && { signal }) };
    for (const l of this.exits) l(code, signal);
    this.done?.();
  }
}
