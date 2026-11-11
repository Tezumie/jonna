// What extensions get (WorkbenchServices), and the small shared services that live only to connect
// extensions without importing each other: file decorations (git colors and badges), quick diff
// (base texts for gutter bars and diffs) and running language clients. DOM-free.
import type { ContextKeyService } from "../core/context/index";
import type { Caller, Dispatcher, DispatcherEvents } from "../core/dispatcher/index";
import { Emitter, type Event, type EventBus } from "../core/events/index";
import type { LanguageServerContribution } from "../core/extensions/index";
import type { OperationHistory } from "../core/history/index";
import type { RunSpec } from "../core/ipc/process";
import type { Platform } from "../core/keybindings/index";
import type { LayoutModel } from "../core/layout/index";
import { type Disposable, toDisposable } from "../core/lifecycle/index";
import type { LanguageClient } from "../core/lsp/client";
import type { NotebookProviders } from "../core/notebook/providers";
import type { AuthorizeRequest, Decision } from "../core/permissions/index";
import { type ReadonlySignal, type Signal, signal } from "../core/reactive/index";
import type { StateTree } from "../core/state/index";
import type { IconName } from "../ui/Icon";
import type { Notifications } from "../ui/Notifications";
import type { QuickInput } from "../ui/QuickInput";
import type { AuxWindowService } from "./auxWindow";
import type { Contributions } from "./contributions";
import type { DebugMarks } from "./debugMarks";
import type { IframeLayer } from "./dock/iframeLayer";
import type { DockService } from "./dock/service";
import type { ExtensionFeatures } from "./extensionFeatures";
import type { GitAccess } from "./gitAccess";
import type { GutterMarks } from "./gutterMarks";
import type { KeyboardService } from "./keyboard";
import type { PersistenceService } from "./persistence";
import type { SettingsService } from "./settings";
import type { StatusBar } from "./statusbar";
import type { ThemeService } from "./theme";
import type { WorkspaceTrust } from "./trust";
import type { ViewRegistry } from "./views";
import type { WorkspaceService } from "./workspace";

// The services built-in extensions receive. Built-ins are privileged (in-process, PLAN §9.1);
// third-party extensions will get a narrower, permission-checked API in Milestone 6.
/** IDE-wide events. File events let views react to changes made through commands. */
/** A debug session as extensions are told of it (D255; VS Code's DebugSession's data). */
export interface DebugSessionEventInfo {
  id: string;
  name: string;
  type: string;
  /** Its configuration as resolved (what its adapter was given). */
  configuration?: Record<string, unknown>;
  /** The session it was started under. */
  parentSession?: string;
  /** The folder its configuration belongs to. */
  workspaceFolder?: string;
}

export interface IdeEvents extends DispatcherEvents {
  "files.didCreate": { path: string; kind: "file" | "dir" };
  "files.didRename": { from: string; to: string };
  "files.didDelete": { path: string };
  "files.didSave": { path: string };
  /** Contents changed on disk through a command (e.g. replace in files). */
  "files.didChange": { path: string };
  /** A text document was opened in the editor (language servers start on demand). */
  "documents.didOpen": { path: string; languageId: string };
  /**
   * The agent changed a file (on disk, or a staged proposal when `staged`): which chat, and the
   * 1-based line where the change starts (Follow the agent, D383).
   */
  "agent.didEdit": { session: string; path: string; line: number; staged: boolean };
  /** A text document's last editor closed (D256). */
  "documents.didClose": { path: string };
  /** Notebooks in the notebook editor (D204; extensions follow them with "fs.read"). */
  "notebook.didOpen": { path: string; notebookType: string };
  /** Its cells or their text changed (at most every 300 ms); notebook.read gives them. */
  "notebook.didChange": { path: string; notebookType: string; cells: number };
  "notebook.didSave": { path: string; notebookType: string };
  "notebook.didClose": { path: string; notebookType: string };
  /** A pull request was opened (D227: a chat whose agent opened it links it). */
  "github.didCreatePullRequest": {
    number: number | null;
    url: string | null;
    title: string;
    caller: Caller;
  };
  /** Debug sessions (D255; extensions follow them as ide.debug.onDid…). */
  "debug.didStartSession": DebugSessionEventInfo;
  "debug.didTerminateSession": DebugSessionEventInfo;
  "debug.didChangeActiveSession": DebugSessionEventInfo | null;
  "debug.didChangeBreakpoints": Record<string, never>;
  /** An event of the adapter's own (VS Code's onDidReceiveDebugSessionCustomEvent). */
  "debug.didReceiveCustomEvent": {
    session: DebugSessionEventInfo;
    event: string;
    body: Record<string, unknown>;
  };
  /** The focused thread or stack frame (VS Code's debug.activeStackItem); null: none. */
  "debug.didChangeActiveStackItem": {
    session: DebugSessionEventInfo;
    threadId: number;
    frameId?: number;
  } | null;
  /** A cell finished running. */
  "notebook.didRunCell": {
    path: string;
    notebookType: string;
    cellId: string;
    status: "ok" | "error";
    executionCount: number | null;
  };
}

/** One generation request outside the agent panel (inline edit, completions; D106). */
export interface GenerateRequest {
  /** Which model setting applies: the inline edit's or the completions'. */
  /** Which feature asks; each has its own model setting (agent/languageModel.ts). */
  purpose: "edit" | "completion" | "commit" | "nextEdit" | "memory" | "aside";
  /** A model key that answers instead of the feature's own (a chat's model for /btw, D389). */
  model?: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Text as it streams in (the whole text so far). */
  onText?(text: string): void;
}

/** Text generation with the user's models; the agent extension provides it (D106). */
export interface LanguageModelService {
  /** The model that would answer ("provider/model"), or null when none is set up. */
  model(purpose: GenerateRequest["purpose"]): string | null;
  /** The generated text (rejects with a readable error; an abort resolves with what came so far). */
  generate(request: GenerateRequest): Promise<string>;
  /**
   * Fill-in-the-middle with the completion model (D204): the middle, or null when its provider
   * or model has no FIM endpoint (the caller then uses `generate`). Optional: tests' stand-ins.
   */
  fill?(request: FillRequest): Promise<string | null>;
  /** Whether the completion model would get a FIM request, and why its model was picked. */
  completionInfo?(): {
    model: string | null;
    fim: string | null;
    picked: "setting" | "suggested" | "default" | null;
  };
}

/** A fill-in-the-middle request (D204). */
export interface FillRequest {
  prompt: string;
  suffix: string;
  maxTokens: number;
  stop?: string[];
  signal?: AbortSignal;
}

/** A problem reported from outside the editor's language services (a task's problem matcher). */
export interface ExternalProblem {
  path: string;
  /** "hint": a faint mark in the editor only, not listed in Problems (VS Code's Hint). */
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  /** The matcher's source ("ts", "eslint"…). */
  source: string | undefined;
  code: string | undefined;
  /** 1-based. */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  /** An extension's: drawn faded (unused code) or struck through (VS Code's DiagnosticTag). */
  tags?: readonly ("unnecessary" | "deprecated")[];
  /** A web page about `code`. */
  codeTarget?: string;
  /** Other places that explain it (VS Code's relatedInformation). */
  related?: readonly {
    path: string;
    message: string;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
  }[];
  /** In a notebook (`path`), the cell it's in (lines are the cell's): an extension's for a cell. */
  cell?: { id: string; index: number };
}

/**
 * Problems from outside the language services, by owner (D134): each task's problem matcher
 * replaces its own set. The Problems view lists them with the editors' diagnostics, and open
 * files show them as squiggles. DOM-free.
 */
export class ProblemCollections {
  private readonly owners = new Map<string, readonly ExternalProblem[]>();
  /** Every owner's problems; changes when any set does. */
  readonly all: Signal<ReadonlyMap<string, readonly ExternalProblem[]>> = signal<
    ReadonlyMap<string, readonly ExternalProblem[]>
  >(new Map());

  set(owner: string, problems: readonly ExternalProblem[]): void {
    if (problems.length === 0 && !this.owners.has(owner)) return;
    if (problems.length) this.owners.set(owner, problems);
    else this.owners.delete(owner);
    this.all.value = new Map(this.owners);
  }

  get(owner: string): readonly ExternalProblem[] {
    return this.owners.get(owner) ?? [];
  }

  clear(owner: string): void {
    this.set(owner, []);
  }
}

/** A problem a language service found (1-based). */
export interface CodeProblem {
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning" | "info" | "hint";
}

/** Checks text before it is written (agent edits, D107); the editor extension provides it. */
export interface CodeCheckService {
  /**
   * Errors in `text` as the new content of `path` that the file doesn't already have, or null
   * when no checker covers the file (or it didn't answer in time).
   */
  newErrors(path: string, text: string, before: string | null): Promise<CodeProblem[] | null>;
}

export interface ExtensionGate {
  authorize(request: AuthorizeRequest & { extension: string }): Promise<Decision>;
  /**
   * Folders of the loaded extensions (installed ones live outside the open folder): the agent
   * may read them, never write (D176).
   */
  folders(): readonly { id: string; root: string }[];
  /** The ids of the extensions that are enabled (filled in by the extensions host). */
  readonly enabledIds: Signal<readonly string[]>;
}

export interface WorkbenchServices {
  readonly platform: Platform;
  readonly dispatcher: Dispatcher;
  readonly context: ContextKeyService;
  readonly state: StateTree;
  readonly events: EventBus<IdeEvents>;
  readonly layout: LayoutModel;
  readonly views: ViewRegistry;
  readonly statusBar: StatusBar;
  readonly quickInput: QuickInput;
  readonly notifications: Notifications;
  readonly keyboard: KeyboardService;
  readonly workspace: WorkspaceService;
  readonly persistence: PersistenceService;
  /** The dock: every tab (editors, terminals, agent…) and the split tree holding them. */
  readonly dock: DockService;
  readonly theme: ThemeService;
  /** Effective settings (defaults < user < workspace) and the settings.json files. */
  readonly settings: SettingsService;
  /** Whether the open folder's own files (tasks) may run programs (D103). */
  readonly trust: WorkspaceTrust;
  /** Checks proposed file contents (agent edits); filled in by the editor extension (D107). */
  readonly codeCheck: CodeCheckService;
  /** Text generation for editor features; filled in by the agent extension (D106). */
  readonly languageModel: LanguageModelService;
  /** Decides what third-party extensions may run; the extensions host fills it in (D102). */
  readonly extensionGate: ExtensionGate;
  /** Languages, grammars, snippets and color themes from installed extensions (D102). */
  readonly contributions: Contributions;
  /** Auxiliary windows: tabs moved into windows of their own (D101). */
  readonly auxWindows: AuxWindowService;
  /** Hosts iframes outside the dock so they survive moves (docs/dock.md §6). */
  readonly iframes: IframeLayer;
  /**
   * Starts a drag of files or folders onto the dock (explorer rows; `paths` when several are
   * selected): files open where they're dropped, a folder opens a folder browser (D190).
   */
  dragFile(down: PointerEvent, source: HTMLElement, path: string, paths?: string[]): void;
  /**
   * Starts a drag of things that open as tabs (D377: chats from the Chats list) onto the dock:
   * an open one's tab moves there, the others open there. `label` is what the ghost says.
   */
  dragViews(
    down: PointerEvent,
    source: HTMLElement,
    items: ({ tabId: string } | { viewType: string; state: unknown })[],
    label: string,
  ): void;
  /** Explorer files dropped on `element` go to `drop` instead of opening (the agent chat). */
  fileDropTarget(element: HTMLElement, drop: (path: string) => void): Disposable;
  /**
   * Dock tabs dropped on the middle of `element` go to `drop` when `accepts` takes them, instead
   * of moving into its group (a terminal tab dropped on a terminal joins it as a split).
   */
  tabDropTarget(
    element: HTMLElement,
    accepts: (tab: { tabId: string; viewType: string }) => boolean,
    drop: (tabId: string) => void,
  ): Disposable;
  /** Shown before the folder name in the window title (the editor sets the active file name). */
  readonly titleDetail: Signal<string | null>;
  /** Colors and badges for files (explorer rows, tabs). */
  readonly decorations: FileDecorationService;
  /** Base texts for gutter bars, diffs and hunk staging (git index / HEAD). */
  readonly quickDiff: QuickDiffService;
  /** Running language-server clients (the editor attaches them to its engine). */
  readonly languageClients: LanguageClientRegistry;
  /** Special viewers for file types (images, Markdown and SVG previews…) beside the text editor. */
  readonly viewers: ViewerRegistry;
  /** Notebook file formats and the kernels that run them (D202; the IDE's and extensions'). */
  readonly notebooks: NotebookProviders;
  /** The live text of open documents (unsaved edits included), for previews. */
  readonly documents: DocumentTexts;
  /** Workspace undo/redo: file operations, replace all, accepted agent edits (core/history). */
  readonly history: OperationHistory;
  /** Problems from tasks' problem matchers (D134), beside the language services'. */
  readonly problems: ProblemCollections;
  /** Hovers, completions, decorations and menu items third-party extensions add (D176). */
  readonly extensionFeatures: ExtensionFeatures;
  /** Runs tasks in terminal tabs; filled in by the terminal extension (D134). */
  readonly taskTerminals: TaskTerminalHost;
  /** Breakpoints and the stopped line, drawn by the editor (D143). */
  readonly debugMarks: DebugMarks;
  /** Other extensions' marks in editors' margins (bookmarks, D143). */
  readonly gutterMarks: GutterMarks;
  /** Read-only git for extensions' code (D208); the git extension provides it. */
  readonly gitAccess: GitAccess;
}

/** How a task's terminal is shown (tasks.json `presentation`). */
export interface TaskPresentation {
  /** Bring the terminal forward: always, only on problems ("silent"), never. */
  reveal: "always" | "silent" | "never";
  focus: boolean;
  /** Reuse a finished task's terminal ("shared"), this task's own ("dedicated") or a new one. */
  panel: "shared" | "dedicated" | "new";
  clear: boolean;
  /** Close the terminal when the task ends. */
  close: boolean;
}

export interface TaskExecution {
  terminalId: number;
  tabId: string;
  /** Output as it arrives (decoded text, escape sequences included); a new listener gets the output so far first. */
  readonly onOutput: Event<string>;
  /** Resolves with the exit code when the process ends. */
  readonly exited: Promise<number>;
  /** Ends the process (the terminal stays, with the exit notice). */
  kill(): void;
  /** Brings the terminal forward. */
  reveal(focus: boolean): void;
}

export interface TaskTerminalHost {
  run(task: {
    label: string;
    spec: RunSpec;
    cwd: string | undefined;
    presentation: TaskPresentation;
  }): Promise<TaskExecution>;
  /**
   * The shell a shell task's command line runs in when it names none (D209: the terminal's
   * automation profile, `terminal.automationProfile.<platform>`, else the default terminal
   * profile's shell); null: the IDE's default one. `folder` (the task's or launch's own workspace
   * folder in a multi-root workspace, D251; default: the first folder) in WSL
   * gives the Linux one (bash unless the linux automation profile says). Tasks and debug launches
   * quote their arguments for it.
   */
  automationShell?(folder?: string): string | null;
  /**
   * A task's terminal whose process was taken back after a window reload: the tasks extension
   * links it to its task again (exit, problem matchers, the running list). Ones taken back before
   * a listener subscribed are delivered to it first.
   */
  onDidReattach?: Event<{ label: string; execution: TaskExecution }>;
}

// Viewers: dock views that show a file some other way than as text — an image, a rendered
// Markdown or SVG preview. A viewer is either the default for its extensions (images open in it
// directly, like VS Code) or a preview opened from the text editor ("Open preview (to the side)").
// "Reopen with…" lists the text editor and every viewer for the file. DOM-free.
export interface ViewerContribution {
  id: string;
  /** "Image preview", "Markdown preview"… */
  label: string;
  /** Dock view type that shows it; its view state is `{ path }`. */
  viewType: string;
  /** Lower-case extensions with the dot: [".png", ".jpg"]. */
  extensions: readonly string[];
  /**
   * "default": files open in it; "preview": offered from the text editor; "option": only in
   * Reopen with… (a notebook format for files that are usually text, D204).
   */
  kind: "default" | "preview" | "option";
  /** Icon of "Open preview" actions (default: book-open). */
  icon?: IconName;
}

export class ViewerRegistry {
  private readonly list: ViewerContribution[] = [];

  register(viewer: ViewerContribution): Disposable {
    this.list.push(viewer);
    return toDisposable(() => {
      const i = this.list.indexOf(viewer);
      if (i >= 0) this.list.splice(i, 1);
    });
  }

  /** Every viewer for `path` (by the end of its name: ".png", or ".nb.py" for a notebook type). */
  for(path: string): ViewerContribution[] {
    const name = path.slice(path.search(/[^\\/]*$/)).toLowerCase();
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot) : "";
    return this.list.filter((v) =>
      v.extensions.some(
        (e) => e === ext || (e.length > ext.length && name.endsWith(e) && name.length > e.length),
      ),
    );
  }

  defaultFor(path: string): ViewerContribution | undefined {
    return this.for(path).find((v) => v.kind === "default");
  }

  previewFor(path: string): ViewerContribution | undefined {
    return this.for(path).find((v) => v.kind === "preview");
  }

  get(id: string): ViewerContribution | undefined {
    return this.list.find((v) => v.id === id);
  }

  /** The viewer whose tabs are of dock view type `viewType`. */
  byViewType(viewType: string): ViewerContribution | undefined {
    return this.list.find((v) => v.viewType === viewType);
  }
}

/** Open documents' current text, published by the editor (unsaved edits included). DOM-free. */
export class DocumentTexts {
  private readonly changed = new Emitter<string>();
  /** Fires with a path whose open document's text changed (typing, reload, close). */
  readonly onDidChange: Event<string> = this.changed.event;
  private provider: ((path: string) => string | null) | undefined;

  /** The editor registers how to read an open document's text. */
  setProvider(provider: (path: string) => string | null): Disposable {
    this.provider = provider;
    return toDisposable(() => {
      if (this.provider === provider) this.provider = undefined;
    });
  }

  /** The open document's text, or null when `path` isn't open (read the file instead). */
  text(path: string): string | null {
    return this.provider?.(path) ?? null;
  }

  fire(path: string): void {
    this.changed.fire(path);
  }

  private readonly scrolled = new Emitter<{ path: string; line: number; cursor: number }>();
  /**
   * An editor showing `path` scrolled or moved its cursor: `line` is the fractional top line,
   * `cursor` the cursor's line (both 0-based).
   */
  readonly onDidScroll: Event<{ path: string; line: number; cursor: number }> = this.scrolled.event;

  fireScroll(path: string, line: number, cursor: number): void {
    this.scrolled.fire({ path, line, cursor });
  }

  private readonly annotations = new Emitter<{ path: string; line: number; text: string } | null>();
  /** One faint note after a line of `path` (inline blame), or null to clear it (D127). */
  readonly onDidAnnotate: Event<{ path: string; line: number; text: string } | null> =
    this.annotations.event;

  annotate(note: { path: string; line: number; text: string } | null): void {
    this.annotations.fire(note);
  }

  private readonly scrollRequests = new Emitter<{ path: string; line: number }>();
  /** A preview asks the editors of `path` to scroll to fractional line `line` (0-based). */
  readonly onDidRequestScroll: Event<{ path: string; line: number }> = this.scrollRequests.event;

  requestScroll(path: string, line: number): void {
    this.scrollRequests.fire({ path, line });
  }

  private highlighter: ((code: string, lang: string) => Promise<string | null>) | undefined;

  /** The editor registers its engine's colorizer (HTML spans, text escaped by the engine). */
  setHighlighter(fn: (code: string, lang: string) => Promise<string | null>): Disposable {
    this.highlighter = fn;
    return toDisposable(() => {
      if (this.highlighter === fn) this.highlighter = undefined;
    });
  }

  /** Syntax-colored HTML for a code block, or null (no engine yet, unknown language). */
  highlight(code: string, lang: string): Promise<string | null> {
    return this.highlighter ? this.highlighter(code, lang) : Promise.resolve(null);
  }
}

// File decorations: color, letter badge and tooltip for a path, shown in the explorer and on editor
// tabs (DESIGN.md §3.5, §10). Providers (git now, problems later) answer synchronously from their
// own caches and call `changed()` when they have something new; views re-render on `revision`.
// DOM-free.
export interface FileDecoration {
  /** A color token, e.g. "--diff-modified-fg". */
  color?: string;
  /** One or two characters on the right of the row/tab, e.g. "M". */
  badge?: string;
  tooltip?: string;
  /** Deleted files are struck through. */
  strike?: boolean;
  /** Ignored files are dimmed. */
  faded?: boolean;
  /**
   * Above 0, this decoration's color wins whatever the order, and its badge goes first, joined
   * with the others' ("2, M": problems before git, as VS Code, D279).
   */
  priority?: number;
}

export interface FileDecorationProvider {
  /** `path` is absolute; `kind` lets providers decorate folders containing changes. */
  decorate(path: string, kind: "file" | "dir"): FileDecoration | undefined;
}

export class FileDecorationService {
  private readonly providers: FileDecorationProvider[] = [];
  private readonly rev = signal(0);
  /** Bumped whenever any provider's decorations changed. Read it to re-render reactively. */
  readonly revision: ReadonlySignal<number> = this.rev;

  register(provider: FileDecorationProvider): Disposable {
    this.providers.push(provider);
    this.changed();
    return toDisposable(() => {
      const i = this.providers.indexOf(provider);
      if (i >= 0) this.providers.splice(i, 1);
      this.changed();
    });
  }

  private pending = 0;

  /**
   * At most once a frame (D379): a language server publishes per file, often per keystroke, and
   * each bump re-rendered every tab strip with a layout read per group.
   */
  changed(): void {
    if (typeof requestAnimationFrame !== "function") {
      this.rev.value = this.rev.peek() + 1;
      return;
    }
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = 0;
      this.rev.value = this.rev.peek() + 1;
    });
  }

  /**
   * Later providers win per field, except that a higher `priority` keeps its color and puts its
   * badge first; tooltips are joined.
   */
  get(path: string, kind: "file" | "dir" = "file"): FileDecoration | undefined {
    let merged: FileDecoration | undefined;
    for (const p of this.providers) {
      const d = p.decorate(path, kind);
      if (!d) continue;
      const tooltip = [merged?.tooltip, d.tooltip].filter(Boolean).join(" · ") || undefined;
      const high = Math.max(merged?.priority ?? 0, d.priority ?? 0);
      if (!merged || high === 0) {
        merged = { ...merged, ...d, tooltip };
        continue;
      }
      const [first, second] =
        (d.priority ?? 0) >= (merged.priority ?? 0) ? [d, merged] : [merged, d];
      const badge = [first.badge, second.badge].filter(Boolean).join(", ") || undefined;
      merged = {
        ...merged,
        ...d,
        color: first.color ?? second.color,
        badge,
        tooltip,
        priority: high,
      };
    }
    return merged;
  }
}

// Quick diff: what a file is compared against (the git index or HEAD), for the editor's gutter
// bars, the diff tab and hunk staging. The git extension provides base texts; the editor provides
// buffer texts (unsaved edits count) and applies reverts to open documents so they can be undone.
// DOM-free.
/** What change bars compare with (D200: git.quickDiffBase): the index, HEAD, or the merge base. */
export type QuickDiffBase = "index" | "head" | "mergeBase";

export interface QuickDiffProvider {
  /** The base text for `path` (absolute), or null when the file has none (untracked, no repo). */
  original(path: string, base: QuickDiffBase): Promise<string | null>;
}

/** Open documents (registered by the editor). */
export interface DocumentTextSource {
  /** The buffer text if `path` is open, else null. */
  read(path: string): string | null;
  /** Replaces an open document's text as one undoable edit; false if it isn't open. */
  write(path: string, text: string): Promise<boolean>;
  /** The open document's encoding id ("utf8", "windows1252"…), else null (D199). */
  encoding?(path: string): string | null;
}

export class QuickDiffService implements Disposable {
  private provider: QuickDiffProvider | null = null;
  /** Asked when the provider has no base text (extensions' source controls, D233). */
  private readonly fallbacks = new Set<(path: string) => Promise<string | null>>();
  private documents: DocumentTextSource | null = null;
  private readonly emitter = new Emitter<void>();
  private readonly contents = new Map<
    string,
    (path: string, scheme: string) => Promise<string | null>
  >();
  /** Base texts may have changed (index or HEAD moved); recompute gutters and diffs. */
  readonly onDidChange: Event<void> = this.emitter.event;

  setProvider(provider: QuickDiffProvider): Disposable {
    this.provider = provider;
    this.emitter.fire();
    return toDisposable(() => {
      if (this.provider === provider) this.provider = null;
      this.emitter.fire();
    });
  }

  setDocuments(source: DocumentTextSource): Disposable {
    this.documents = source;
    return toDisposable(() => {
      if (this.documents === source) this.documents = null;
    });
  }

  /**
   * Extra diff sources by scheme, e.g. "agent:<session>" → the agent's proposed text. A scheme
   * ending in ":" ("git:") answers every "git:<anything>" not registered exactly.
   */
  registerContent(
    scheme: string,
    read: (path: string, scheme: string) => Promise<string | null>,
  ): Disposable {
    this.contents.set(scheme, read);
    return toDisposable(() => {
      if (this.contents.get(scheme) === read) this.contents.delete(scheme);
    });
  }

  content(scheme: string, path: string): Promise<string | null> {
    const read =
      this.contents.get(scheme) ?? this.contents.get(scheme.slice(0, scheme.indexOf(":") + 1));
    return read?.(path, scheme) ?? Promise.resolve(null);
  }

  get hasProvider(): boolean {
    return this.provider !== null;
  }

  changed(): void {
    this.emitter.fire();
  }

  /** A base text source for files the provider has none for (extensions' source controls). */
  addFallback(read: (path: string) => Promise<string | null>): Disposable {
    this.fallbacks.add(read);
    return toDisposable(() => this.fallbacks.delete(read));
  }

  async original(path: string, base: QuickDiffBase = "index"): Promise<string | null> {
    const text = this.provider ? await this.provider.original(path, base) : null;
    if (text !== null || !this.fallbacks.size) return text;
    for (const read of this.fallbacks) {
      const other = await read(path).catch(() => null);
      if (other !== null) return other;
    }
    return null;
  }

  /** Buffer text of an open document, or null (callers then read the file). */
  bufferText(path: string): string | null {
    return this.documents?.read(path) ?? null;
  }

  /** An open document's encoding id, or null when it isn't open. */
  bufferEncoding(path: string): string | null {
    return this.documents?.encoding?.(path) ?? null;
  }

  writeBuffer(path: string, text: string): Promise<boolean> {
    return this.documents ? this.documents.write(path, text) : Promise.resolve(false);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

// Running language clients, published by the language-server extension and attached to the editor
// engine by the editor extension (neither imports the other). DOM-free.
export class LanguageClientRegistry {
  private readonly list = signal<readonly LanguageClient[]>([]);
  readonly clients: ReadonlySignal<readonly LanguageClient[]> = this.list;
  /** Servers contributed by extensions' manifests (set at startup, before activation). */
  contributed: Record<string, LanguageServerContribution & { extension: string }> = {};
  /** Servers from Claude Code plugins the user let start them (D375), by name. */
  readonly plugins = signal<Record<string, LanguageServerContribution & { extension: string }>>({});

  /** Publishes a started client; dispose to withdraw it (before stopping it). */
  add(client: LanguageClient): Disposable {
    this.list.value = [...this.list.peek(), client];
    return toDisposable(() => {
      this.list.value = this.list.peek().filter((c) => c !== client);
    });
  }
}
