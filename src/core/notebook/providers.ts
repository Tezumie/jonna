// Who reads, writes and runs notebooks (D202, VS Code's notebook serializers and controllers):
// the IDE keeps one notebook editor; a *notebook type* (a file format, e.g. Jupyter's .ipynb)
// comes with a serializer, and *kernel sources* list and start the kernels that run its cells.
// The IDE registers its own format (Jupyter's .ipynb, D204); kernels come from extensions
// (the built-in Jupyter extension's Pythons, others'), registered through `ide.notebooks`.
// DOM-free and unit-tested.

import { Emitter, type Event } from "../events/index";
import { type Disposable, toDisposable } from "../lifecycle/index";
import { pathKey } from "../paths/index";
import type { ReadonlySignal } from "../reactive/index";
import type {
  CommMessage,
  KernelEvent,
  KernelInfo,
  KernelStatus,
  Notebook,
  Variable,
} from "./types";

/** Jupyter's notebook type (the IDE's own, D204) and the built-in Jupyter extension's kernel source (D203). */
export const JUPYTER_NOTEBOOK = "jupyter.notebook";
/** VS Code's Interactive Window's notebook type (the same name in VS Code and the IDE). */
export const INTERACTIVE_NOTEBOOK = "interactive";
export const JUPYTER_KERNELS = "bundled.jupyter/jupyter";
/** The extension that runs Jupyter notebooks (offered in the kernel picker when it's off). */
export const JUPYTER_EXTENSION = "bundled.jupyter";

/** Reads a notebook file's text into cells and writes it back. */
export interface NotebookSerializer {
  /** An empty text is a new notebook. Throws when the text isn't one. */
  deserialize(text: string): Notebook | Promise<Notebook>;
  serialize(notebook: Notebook): string | Promise<string>;
}

export interface NotebookType {
  /** "jupyter.notebook", "acme.query-book"… */
  id: string;
  label: string;
  /** Lower-case file extensions with the dot (".ipynb"). */
  extensions: readonly string[];
  serializer: NotebookSerializer;
  /** Who registered it ("builtin" or an extension's id). */
  owner: string;
  /**
   * Its files open in the notebook editor by default (false: offered in Reopen with…, and their
   * diffs stay text). An extension's type opts in with `"default": true`.
   */
  opensByDefault: boolean;
}

/** One way to run a notebook (a row of the kernel picker); kept per notebook, so plain JSON. */
export interface KernelOption {
  /** The kernel source that made it. */
  source: string;
  /** Unique within its source. */
  id: string;
  label: string;
  /** Where it comes from (an interpreter's path, a server…). */
  detail: string;
  /** Its cells' language ("python"). */
  language: string;
  /**
   * Every language it runs (VS Code's controller `supportedLanguages`): offered first when a
   * cell's language is changed. Default: `language` only.
   */
  languages?: readonly string[];
  /** The source's own data for starting it (JSON). */
  data?: unknown;
}

/** The cell a kernel runs (an extension's kernel may want its id, language or metadata). */
export interface ExecutingCell {
  id: string;
  index: number;
  /** The cell's own language (a cell can differ from the notebook's, D204). */
  language: string;
  metadata: Record<string, unknown>;
}

/**
 * A row of the kernel picker that isn't a kernel (VS Code's kernel source actions: "Existing
 * Jupyter server…", "Connect to a cluster…"): choosing it runs the source's action, which may
 * ask the user things and returns the kernel to use.
 */
export interface KernelSourceAction {
  id: string;
  label: string;
  detail?: string;
}

/** A running kernel for one notebook. */
export interface NotebookKernel {
  readonly option: KernelOption;
  readonly status: ReadonlySignal<KernelStatus>;
  readonly info: ReadonlySignal<KernelInfo | null>;
  /** The kernel asks for input (Python's input()). */
  readonly onInputRequest: Event<{ id: string; prompt: string; password: boolean }>;
  /** It ended unexpectedly; its last words. */
  readonly onExit: Event<string>;
  /** Widget messages (Jupyter comms). */
  readonly onComm: Event<CommMessage>;
  /** Outputs of no cell's request (a widget callback's), with their `parent`. */
  readonly onStrayOutput: Event<KernelEvent>;
  /** Starts it (once); resolves when it's ready. */
  start(): Promise<void>;
  /** Runs `code`; `onEvent` gets its outputs; resolves when it finished. */
  execute(
    code: string,
    onEvent: (e: KernelEvent) => void,
    cell?: ExecutingCell,
  ): Promise<{ status: string; count: number | null }>;
  /** Completions at `cursor` (a character offset in `code`). */
  complete(
    code: string,
    cursor: number,
  ): Promise<{ matches: string[]; start: number; end: number } | null>;
  /** Help for what's at `cursor` (plain text, may hold ANSI colors). */
  inspect(code: string, cursor: number): Promise<string>;
  /** Its variables, or null when it can't list them. */
  variables(): Promise<Variable[] | null>;
  sendComm(
    kind: "comm_msg" | "comm_close",
    commId: string,
    data: unknown,
    metadata?: unknown,
    buffers?: string[],
  ): Promise<boolean>;
  /** Answers an input request. */
  input(id: string, value: string): void;
  interrupt(): void;
  restart(): Promise<void>;
  shutdown(): Promise<void>;
  /**
   * A VS Code controller's kernel (D295, the notebookMessaging proposal): its notebooks' outputs
   * are drawn in one output page per notebook, where the extensions' preloads run; `post` takes
   * a preload's message for the controller (its onDidReceiveMessage). The controller's own
   * messages reach the page through NotebookProviders.postToKernelPages.
   */
  readonly messaging?: {
    post(message: unknown): void;
    /** Its controller's rendererScripts (VS Code's), run in the page before any renderer. */
    rendererScripts?(): Promise<{ id: string; code: string }[]>;
    /**
     * A local file the page asks for (VS Code's asWebviewUri addresses: widget modules Jupyter
     * copies into its folder): the controller's extension folder or the workspace's, else it
     * throws.
     */
    readResource?(path: string): Promise<Uint8Array>;
  };
}

/** A notebook's output page that takes a controller's messages (one per open notebook view). */
export interface KernelPage {
  /** The kernel source of the notebook's kernel now (null: none). */
  source(): string | null;
  /** The notebook file. */
  path(): string;
  /** Delivers a controller's message to the page's preloads; false when it can't. */
  post(message: unknown): boolean;
}

/** A script an extension loads into every output page of a notebook type (notebookPreload). */
export interface NotebookPreload {
  /** Unique: the extension's id and the script's path. */
  id: string;
  owner: string;
  /** The IDE's notebook type. */
  notebookType: string;
  /** The module's text (read when a page first needs it). */
  code(): Promise<string>;
  /** What its page may reach (the extension's network permission, as renderers'). */
  network(): "none" | "any" | readonly string[];
}

/** Gives the preloads of an extension (read from its package.json when first asked). */
export interface NotebookPreloadSource {
  owner: string;
  preloads(notebookType: string): Promise<NotebookPreload[]>;
}

export interface KernelContext {
  /** The open folder. */
  root: string;
  /** The notebook file. */
  path: string;
  notebookType: string;
}

export interface KernelSource {
  /** "bundled.jupyter/jupyter" (an extension's id, then its own), "acme.remote/x"… */
  id: string;
  label: string;
  /** The notebook types it runs (default: every one). */
  notebookTypes?: readonly string[];
  /** The kernels it can start for a notebook. */
  find(context: KernelContext): Promise<KernelOption[]>;
  /** A kernel for `option` (not started yet: the editor calls start()). */
  create(option: KernelOption, context: KernelContext & { cwd: string }): NotebookKernel;
  /** Rows of the kernel picker below the kernels (D204). */
  actions?: readonly KernelSourceAction[];
  /** Runs one of `actions`: the kernel to use, or null (the user cancelled). */
  runAction?(actionId: string, context: KernelContext): Promise<KernelOption | null>;
}

/** An item in a cell's status row (VS Code's cell status bar items). */
export interface CellStatusItem {
  text: string;
  tooltip?: string;
  /** A command run on click, with `{ path, cellId }`. */
  command?: string;
  alignment?: "left" | "right";
}

/** What a cell status provider is told about the cell. */
export interface CellStatusContext {
  path: string;
  notebookType: string;
  cell: {
    id: string;
    index: number;
    kind: string;
    language: string;
    source: string;
    metadata: Record<string, unknown>;
    executionCount: number | null;
    outputs: number;
  };
}

/** Items for cells' status rows (an extension's: "Databricks: cluster x", "Ran on GPU"…). */
export interface CellStatusProvider {
  /** Who registered it (an extension's id). */
  owner: string;
  /** The notebook types it's for (default: every one). */
  notebookTypes?: readonly string[];
  provide(context: CellStatusContext): Promise<CellStatusItem[]>;
}

/**
 * An output renderer (D204, VS Code's notebook renderers): an extension's script that draws
 * outputs of its mime types inside the sandboxed output frame, and can exchange messages with
 * the extension.
 */
export interface NotebookRenderer {
  /** "acme.charts.renderer" (starts with its extension's id or prefix). */
  id: string;
  /** Its extension's id. */
  owner: string;
  displayName: string;
  mimeTypes: readonly string[];
  /** The script's text (read when an output first needs it). */
  code(): Promise<string>;
  /**
   * What its frame may reach: nothing ("none", the default: the extension wasn't allowed the
   * network), any https host ("any"), or these hosts ("example.com", "*.example.com").
   */
  network(): "none" | "any" | readonly string[];
  /** A message from one of its frames (the notebook's `path`) for the extension. */
  receive(message: unknown, path: string): void;
}

/**
 * Jupyter widget outputs: drawn by the IDE itself for its own kernels; by an extension's renderer
 * (Jupyter's) only in a VS Code controller's output page, where its preload holds the widgets.
 */
export const WIDGET_VIEW = "application/vnd.jupyter.widget-view+json";

/** The file name's lower-case ending a notebook type may claim: ".ipynb", or ".nb.py". */
const nameOf = (path: string): string => path.slice(path.search(/[^\\/]*$/)).toLowerCase();

export class NotebookProviders {
  private readonly types: NotebookType[] = [];
  private readonly sources: KernelSource[] = [];
  private readonly statusProviders: CellStatusProvider[] = [];
  private readonly renderers: NotebookRenderer[] = [];
  private readonly rendererPosts = new Emitter<{
    renderer: string;
    message: unknown;
    path?: string;
  }>();
  /** An extension's message for its renderer's frames (all of them, or one notebook's). */
  readonly onRendererMessage = this.rendererPosts.event;
  private readonly changed = new Emitter<void>();
  private readonly statusChanged = new Emitter<void>();
  /** A cell status provider came or went (cells ask again). */
  readonly onDidChangeStatusProviders = this.statusChanged.event;
  /** A type or a kernel source came or went. */
  readonly onDidChange = this.changed.event;

  registerType(type: NotebookType): Disposable {
    if (this.types.some((t) => t.id === type.id))
      throw new Error(`The notebook type ${type.id} is already registered.`);
    // One format per file extension: a later one can't take over another's files.
    const taken = type.extensions.find((e) => this.types.some((t) => t.extensions.includes(e)));
    if (taken)
      throw new Error(
        `${taken} files already belong to another notebook type (${type.id} left out).`,
      );
    this.types.push(type);
    this.changed.fire();
    return toDisposable(() => {
      const i = this.types.indexOf(type);
      if (i >= 0) this.types.splice(i, 1);
      this.changed.fire();
    });
  }

  registerKernelSource(source: KernelSource): Disposable {
    if (this.sources.some((s) => s.id === source.id))
      throw new Error(`The kernel source ${source.id} is already registered.`);
    this.sources.push(source);
    this.changed.fire();
    return toDisposable(() => {
      const i = this.sources.indexOf(source);
      if (i >= 0) this.sources.splice(i, 1);
      this.changed.fire();
    });
  }

  registerCellStatusProvider(provider: CellStatusProvider): Disposable {
    this.statusProviders.push(provider);
    this.statusChanged.fire();
    return toDisposable(() => {
      const i = this.statusProviders.indexOf(provider);
      if (i >= 0) this.statusProviders.splice(i, 1);
      this.statusChanged.fire();
    });
  }

  registerRenderer(renderer: NotebookRenderer): Disposable {
    if (this.renderers.some((r) => r.id === renderer.id))
      throw new Error(`The notebook renderer ${renderer.id} is already registered.`);
    this.renderers.push(renderer);
    this.changed.fire();
    return toDisposable(() => {
      const i = this.renderers.indexOf(renderer);
      if (i >= 0) this.renderers.splice(i, 1);
      this.changed.fire();
    });
  }

  allRenderers(): readonly NotebookRenderer[] {
    return this.renderers;
  }

  /**
   * The renderer for an output with these mime types (in the output's order: the first one a
   * renderer takes), or undefined. text/plain is never an extension's (it's every output's
   * fallback). Jupyter widgets are an extension's only with `widgets` (a VS Code controller's
   * notebook, whose output page runs the extension's preloads, D295); else the IDE draws them
   * (D189: their comms go through the IDE's own kernel).
   */
  rendererFor(
    mimes: readonly string[],
    options: { widgets?: boolean } = {},
  ): { renderer: NotebookRenderer; mime: string } | undefined {
    for (const mime of mimes) {
      if (mime === "text/plain" || (mime === WIDGET_VIEW && !options.widgets)) continue;
      const renderer = this.renderers.find((r) => r.mimeTypes.includes(mime));
      if (renderer) return { renderer, mime };
    }
    return undefined;
  }

  renderer(id: string): NotebookRenderer | undefined {
    return this.renderers.find((r) => r.id === id);
  }

  // ---- Open notebooks' cells (extensions' diagnostics for a cell's document) ----

  private cellLocator: ((path: string, cellId: string) => number | undefined) | null = null;

  /** The notebook editor tells where an open notebook's cell is (one locator: the editor's). */
  registerCellLocator(locate: (path: string, cellId: string) => number | undefined): Disposable {
    this.cellLocator = locate;
    return toDisposable(() => {
      if (this.cellLocator === locate) this.cellLocator = null;
    });
  }

  /** The position of cell `cellId` in the open notebook `path`, or undefined (not open). */
  cellIndex(path: string, cellId: string): number | undefined {
    return this.cellLocator?.(path, cellId);
  }

  // ---- Controllers' output pages (D295, VS Code's notebookMessaging) ----

  private readonly kernelPages = new Set<KernelPage>();
  private readonly preloadSources: NotebookPreloadSource[] = [];

  registerKernelPage(page: KernelPage): Disposable {
    this.kernelPages.add(page);
    return toDisposable(() => this.kernelPages.delete(page));
  }

  /**
   * A controller's message (VS Code's NotebookController.postMessage) to the pages of the
   * notebooks whose kernel came from `source` (`path`: that notebook's only). True when a page
   * took it.
   */
  postToKernelPages(source: string, message: unknown, path?: string): boolean {
    let delivered = false;
    for (const page of this.kernelPages) {
      if (page.source() !== source) continue;
      if (path && pathKey(page.path()) !== pathKey(path)) continue;
      if (page.post(message)) delivered = true;
    }
    return delivered;
  }

  registerPreloadSource(source: NotebookPreloadSource): Disposable {
    this.preloadSources.push(source);
    return toDisposable(() => {
      const i = this.preloadSources.indexOf(source);
      if (i >= 0) this.preloadSources.splice(i, 1);
    });
  }

  /** Every extension's preloads for `notebookType`, in the extensions' order (a failing one: none). */
  async preloadsFor(notebookType: string): Promise<NotebookPreload[]> {
    const lists = await Promise.all(
      this.preloadSources.map((s) => s.preloads(notebookType).catch(() => [] as NotebookPreload[])),
    );
    return lists.flat();
  }

  /** The extension's message to its renderer's frames (`path`: one notebook's only). */
  postToRenderer(renderer: string, message: unknown, path?: string): void {
    this.rendererPosts.fire({ renderer, message, ...(path && { path }) });
  }

  /** Every provider's items for a cell (a failing one gives none), left ones first. */
  async cellStatusItems(context: CellStatusContext): Promise<CellStatusItem[]> {
    const lists = await Promise.all(
      this.statusProviders
        .filter((p) => !p.notebookTypes || p.notebookTypes.includes(context.notebookType))
        .map((p) => p.provide(context).catch(() => [] as CellStatusItem[])),
    );
    return lists.flat();
  }

  allTypes(): readonly NotebookType[] {
    return this.types;
  }

  type(id: string): NotebookType | undefined {
    return this.types.find((t) => t.id === id);
  }

  /**
   * The notebook type of a file, by the end of its name: the longest match wins, so a type
   * for ".nb.py" files takes them while ".py" ones stay others' (D204).
   */
  typeFor(path: string): NotebookType | undefined {
    const name = nameOf(path);
    let best: { type: NotebookType; length: number } | undefined;
    for (const t of this.types)
      for (const e of t.extensions)
        if (name.endsWith(e) && name.length > e.length && (!best || e.length > best.length))
          best = { type: t, length: e.length };
    return best?.type;
  }

  /** The kernel sources that run notebooks of `typeId`: those made for it first, then general ones. */
  sourcesFor(typeId: string): KernelSource[] {
    const own = this.sources.filter((s) => s.notebookTypes?.includes(typeId));
    const general = this.sources.filter((s) => !s.notebookTypes);
    return [...own, ...general];
  }

  source(id: string): KernelSource | undefined {
    return this.sources.find((s) => s.id === id);
  }

  /** Every kernel the sources for this notebook offer, source by source (a failing one is skipped). */
  async findKernels(context: KernelContext): Promise<KernelOption[]> {
    const lists = await Promise.all(
      this.sourcesFor(context.notebookType).map((s) =>
        s.find(context).then(
          (list) =>
            list
              .filter((o) => o && typeof o.id === "string" && typeof o.label === "string")
              .map((o) => ({ ...o, source: s.id })),
          () => [] as KernelOption[],
        ),
      ),
    );
    return lists.flat();
  }
}
