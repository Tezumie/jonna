// The worker side of `ide.notebooks` (D202, D204): an extension's notebook file formats
// (serializers), kernel sources (with their picker actions), cell status items and messages with
// its output renderers. The IDE's notebook editor calls into the worker ("notebook" calls) to
// read and write files, run cells, ask for status items and pass renderers' messages; the kernel
// streams its outputs back as requests. DOM-free and unit-tested with createWorkerApi's fake
// transport.

import { readOutput } from "../notebook/nbformat";
import type {
  CommMessage,
  KernelEvent,
  KernelInfo,
  KernelStatus,
  NbOutput,
  Notebook,
  Variable,
} from "../notebook/types";

/** A notebook as extensions see it: cells and metadata (the IDE fills in what's missing). */
export interface NotebookData {
  cells: {
    id?: string;
    kind: "code" | "markdown" | "raw";
    source: string;
    metadata?: Record<string, unknown>;
    outputs?: Record<string, unknown>[];
    executionCount?: number | null;
    /** The format's own fields the editor doesn't use, given back as they were (D203). */
    extra?: Record<string, unknown>;
  }[];
  metadata?: Record<string, unknown>;
  /** The format's own fields the editor doesn't use, given back as they were (D203). */
  extra?: Record<string, unknown>;
}

export interface NotebookSerializerApi {
  deserialize(text: string): NotebookData | Promise<NotebookData>;
  serialize(notebook: NotebookData): string | Promise<string>;
}

export interface KernelOptionApi {
  id: string;
  label: string;
  detail?: string;
  language?: string;
  /** Every language it runs (offered first in a cell's language picker, D204). */
  languages?: string[];
  data?: unknown;
}

/** The cell being run (D204). */
export interface ExecutingCellApi {
  id: string;
  index: number;
  language: string;
  metadata: Record<string, unknown>;
}

export interface KernelContextApi {
  root: string;
  path: string;
  notebookType: string;
  cwd?: string;
}

/** What a running cell gets: its outputs go out with `emit`; `input` asks the user. */
export interface CellExecution {
  /** The cell (D204): its id, position, language and metadata. */
  cell?: ExecutingCellApi;
  emit(event: KernelEvent): void;
  /** Clears the cell's outputs (`wait`: when the next output comes, for smooth updates). */
  clear(options?: { wait?: boolean }): void;
  input(prompt: string, options?: { password?: boolean }): Promise<string>;
}

/** Ways the kernel tells the IDE things outside a cell's run. */
export interface KernelHost {
  setStatus(status: KernelStatus): void;
  setInfo(info: Partial<KernelInfo>): void;
  /** Outputs of no cell (a widget callback's), with `parent` when they belong to one. */
  emit(event: KernelEvent): void;
  comm(message: CommMessage): void;
  /** The kernel ended by itself (crashed): `reason` is shown. */
  exited(reason?: string): void;
}

export interface KernelApi {
  execute(code: string, run: CellExecution): Promise<{ status?: string; count?: number | null }>;
  interrupt?(): void | Promise<void>;
  restart?(): void | Promise<void>;
  shutdown?(): void | Promise<void>;
  complete?(
    code: string,
    cursor: number,
  ):
    | { matches: string[]; start: number; end: number }
    | null
    | Promise<{ matches: string[]; start: number; end: number } | null>;
  inspect?(code: string, cursor: number): string | Promise<string>;
  variables?(): Variable[] | null | Promise<Variable[] | null>;
  comm?(
    kind: "comm_msg" | "comm_close",
    commId: string,
    data: unknown,
    metadata: unknown,
    buffers: string[],
  ): boolean | Promise<boolean>;
  /**
   * A message from the notebook's output page (a preload's postKernelMessage, D295): only for
   * sources registered with `messaging`.
   */
  message?(message: unknown): void;
  /**
   * Scripts (absolute paths in the extension's folder) its notebooks' output page loads before
   * any renderer: VS Code's controller `rendererScripts` (D295).
   */
  rendererScripts?: readonly string[];
}

/** A row of the kernel picker that isn't a kernel ("Existing Jupyter server…", D204). */
export interface KernelSourceActionApi {
  id: string;
  label: string;
  detail?: string;
  /** Asks what it needs (ide.ui.showInput…); the kernel to use, or nothing (cancelled). */
  run(
    context: KernelContextApi,
  ): KernelOptionApi | undefined | Promise<KernelOptionApi | undefined>;
}

/** An item in a cell's status row (D204). */
export interface CellStatusItemApi {
  text: string;
  tooltip?: string;
  /** One of the extension's commands, run with { path, cellId }. */
  command?: string;
  alignment?: "left" | "right";
}

export interface CellStatusContextApi {
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

/** Messages with the extension's output renderer in the notebook's output frames (D204). */
export interface RendererMessagingApi {
  /** To every frame showing one of this renderer's outputs (or the notebook `path`'s only). */
  postMessage(message: unknown, options?: { path?: string }): Promise<void>;
  onDidReceiveMessage(listener: (event: { message: unknown; path: string }) => void): {
    dispose(): void;
  };
}

export interface KernelSourceApi {
  id: string;
  label: string;
  /** Notebook types it runs (default: every one, the IDE's Jupyter notebooks too). */
  notebookTypes?: string[];
  /** Rows of the kernel picker below the kernels (VS Code's kernel source actions, D204). */
  actions?: KernelSourceActionApi[];
  /**
   * Its kernels talk with their notebooks' output page (VS Code's controller messaging, D295):
   * the page runs extensions' preloads and renderers for every output, Jupyter widgets too.
   */
  messaging?: boolean;
  find(context: KernelContextApi): KernelOptionApi[] | Promise<KernelOptionApi[]>;
  start(
    option: KernelOptionApi,
    context: KernelContextApi,
    host: KernelHost,
  ): KernelApi | Promise<KernelApi>;
}

export interface NotebooksApi {
  /** Reads and writes a notebook type from `contributes.notebooks`. */
  registerSerializer(type: string, serializer: NotebookSerializerApi): { dispose(): void };
  /** Kernels that run cells (of its notebook types, or every notebook). */
  registerKernelSource(source: KernelSourceApi): { dispose(): void };
  /** Items in cells' status rows (`notebookType` "*": every notebook), D204. */
  registerCellStatusBarItemProvider(
    notebookType: string,
    provide: (
      context: CellStatusContextApi,
    ) => CellStatusItemApi[] | undefined | Promise<CellStatusItemApi[] | undefined>,
  ): { dispose(): void };
  /** Messages with one of its `contributes.notebookRenderers` (D204). */
  createRendererMessaging(rendererId: string): RendererMessagingApi;
  /**
   * A message for the output pages of the notebooks running a kernel of source `source` (one of
   * its own, registered with `messaging`; `path`: one notebook's): its preloads'
   * onDidReceiveKernelMessage. True when a page took it.
   */
  postKernelMessage(source: string, message: unknown, path?: string): Promise<boolean>;
}

type Request = <T>(method: string, params?: unknown) => Promise<T>;

export function createNotebooksApi(request: Request): {
  api: NotebooksApi;
  /** Answers a host "notebook" call. */
  call(op: string, args: unknown): unknown;
} {
  const serializers = new Map<string, NotebookSerializerApi>();
  const sources = new Map<string, KernelSourceApi>();
  const statusProviders = new Map<string, (c: CellStatusContextApi) => unknown>();
  const rendererListeners = new Map<
    string,
    Set<(event: { message: unknown; path: string }) => void>
  >();
  let statusSeq = 0;
  const kernels = new Map<string, KernelApi>();
  /** Kernels starting now; shut down before they were ready: stopped once they are. */
  const starting = new Set<string>();
  const cancelled = new Set<string>();
  const a = (args: unknown) => (args ?? {}) as Record<string, unknown>;
  const kernel = (id: unknown): KernelApi => {
    const k = kernels.get(String(id));
    if (!k) throw new Error(`No kernel ${String(id)}.`);
    return k;
  };

  const call = (op: string, args: unknown): unknown => {
    const p = a(args);
    switch (op) {
      case "deserialize": {
        const s = serializers.get(String(p.type));
        if (!s) throw new Error(`No serializer for ${String(p.type)}.`);
        return s.deserialize(String(p.text ?? ""));
      }
      case "serialize": {
        const s = serializers.get(String(p.type));
        if (!s) throw new Error(`No serializer for ${String(p.type)}.`);
        return s.serialize(p.notebook as NotebookData);
      }
      case "find": {
        const s = sources.get(String(p.source));
        return s ? s.find(p.context as KernelContextApi) : [];
      }
      case "action": {
        const action = sources.get(String(p.source))?.actions?.find((x) => x.id === p.action);
        if (!action) throw new Error(`No kernel source action ${String(p.action)}.`);
        return Promise.resolve(action.run(p.context as KernelContextApi)).then((o) => o ?? null);
      }
      case "status": {
        const provide = statusProviders.get(String(p.provider));
        return provide
          ? Promise.resolve(provide(p.context as CellStatusContextApi)).then((r) =>
              Array.isArray(r) ? r : [],
            )
          : [];
      }
      case "rendererMessage": {
        for (const l of rendererListeners.get(String(p.renderer)) ?? [])
          l({ message: p.message, path: String(p.path ?? "") });
        return undefined;
      }
      case "start": {
        const s = sources.get(String(p.source));
        if (!s) throw new Error(`No kernel source ${String(p.source)}.`);
        const id = String(p.kernel);
        const host: KernelHost = {
          setStatus: (status) => void request("notebooks.status", { kernel: id, status }),
          setInfo: (info) => void request("notebooks.status", { kernel: id, info }),
          emit: (event) => void request("notebooks.output", { kernel: id, event }),
          comm: (message) => void request("notebooks.comm", { kernel: id, message }),
          exited: (reason) => {
            kernels.delete(id);
            void request("notebooks.exit", { kernel: id, reason: reason ?? "" });
          },
        };
        starting.add(id);
        return Promise.resolve(
          s.start(p.option as KernelOptionApi, p.context as KernelContextApi, host),
        ).then(
          (k) => {
            starting.delete(id);
            if (cancelled.delete(id)) {
              void Promise.resolve(k.shutdown?.()).catch(() => {});
              return false;
            }
            kernels.set(id, k);
            // Its page's scripts (VS Code's rendererScripts) go with the answer.
            const scripts = (k.rendererScripts ?? []).filter((s) => typeof s === "string");
            return scripts.length ? { rendererScripts: scripts.slice(0, 20) } : true;
          },
          (err: unknown) => {
            starting.delete(id);
            cancelled.delete(id);
            throw err;
          },
        );
      }
      case "execute": {
        const id = String(p.kernel);
        const exec = String(p.exec);
        const cell = p.cell as ExecutingCellApi | undefined;
        const emit = (event: KernelEvent) =>
          void request("notebooks.output", { kernel: id, exec, event });
        const run: CellExecution = {
          ...(cell && typeof cell === "object" && { cell }),
          emit,
          clear: (options = {}) => emit({ type: "clear", wait: options.wait === true }),
          input: (prompt, options = {}) =>
            request<string>("notebooks.input", {
              kernel: id,
              exec,
              prompt,
              password: options.password === true,
            }),
        };
        return Promise.resolve(kernel(id).execute(String(p.code ?? ""), run)).then((r) => ({
          status: r?.status === "error" || r?.status === "aborted" ? r.status : "ok",
          count: typeof r?.count === "number" ? r.count : null,
        }));
      }
      case "interrupt":
        return kernel(p.kernel).interrupt?.();
      case "restart": {
        // Without a restart of its own, the IDE shuts it down and starts it again.
        const k = kernel(p.kernel);
        if (!k.restart) return false;
        return Promise.resolve(k.restart()).then(() => true);
      }
      case "shutdown": {
        if (starting.has(String(p.kernel))) cancelled.add(String(p.kernel));
        const k = kernels.get(String(p.kernel));
        kernels.delete(String(p.kernel));
        return k?.shutdown?.();
      }
      case "complete":
        return kernel(p.kernel).complete?.(String(p.code ?? ""), Number(p.cursor) || 0) ?? null;
      case "inspect":
        return kernel(p.kernel).inspect?.(String(p.code ?? ""), Number(p.cursor) || 0) ?? "";
      case "variables":
        return kernel(p.kernel).variables?.() ?? null;
      case "kernelMessage":
        kernels.get(String(p.kernel))?.message?.(p.message);
        return undefined;
      case "comm":
        return (
          kernel(p.kernel).comm?.(
            p.kind === "comm_close" ? "comm_close" : "comm_msg",
            String(p.commId),
            p.data,
            p.metadata ?? {},
            Array.isArray(p.buffers) ? (p.buffers as string[]) : [],
          ) ?? false
        );
      default:
        throw new Error(`Unknown notebook call ${op}.`);
    }
  };

  const api: NotebooksApi = {
    registerSerializer(type, serializer) {
      serializers.set(type, serializer);
      void request("notebooks.registerSerializer", { type }).catch(() => serializers.delete(type));
      return {
        dispose: () => {
          serializers.delete(type);
          void request("notebooks.unregisterSerializer", { type }).catch(() => {});
        },
      };
    },
    registerKernelSource(source) {
      sources.set(source.id, source);
      void request("notebooks.registerKernelSource", {
        id: source.id,
        label: source.label,
        ...(source.notebookTypes && { notebookTypes: source.notebookTypes }),
        ...(source.messaging && { messaging: true }),
        ...(source.actions?.length && {
          actions: source.actions.map((a) => ({
            id: a.id,
            label: a.label,
            ...(a.detail && { detail: a.detail }),
          })),
        }),
      }).catch(() => sources.delete(source.id));
      return {
        dispose: () => {
          sources.delete(source.id);
          void request("notebooks.unregisterKernelSource", { id: source.id }).catch(() => {});
        },
      };
    },
    registerCellStatusBarItemProvider(notebookType, provide) {
      const id = `s${++statusSeq}`;
      statusProviders.set(id, provide);
      void request("notebooks.registerStatusProvider", { id, notebookType }).catch(() =>
        statusProviders.delete(id),
      );
      return {
        dispose: () => {
          statusProviders.delete(id);
          void request("notebooks.unregisterStatusProvider", { id }).catch(() => {});
        },
      };
    },
    postKernelMessage: (source, message, path) =>
      request<boolean>("notebooks.kernelPost", {
        source,
        message,
        ...(path && { path }),
      }).then((r) => r === true),
    createRendererMessaging(rendererId) {
      return {
        postMessage: (message, options = {}) =>
          request("notebooks.rendererPost", {
            renderer: rendererId,
            message,
            ...(options.path && { path: options.path }),
          }),
        onDidReceiveMessage(listener) {
          const set = rendererListeners.get(rendererId) ?? new Set();
          set.add(listener);
          rendererListeners.set(rendererId, set);
          return { dispose: () => set.delete(listener) };
        },
      };
    },
  };
  return { api, call };
}

/** The IDE's notebook from an extension's NotebookData (missing fields filled in). */
export function fromNotebookData(data: unknown): Notebook {
  const d = (data ?? {}) as Partial<NotebookData>;
  if (!Array.isArray(d.cells)) throw new Error("The extension's notebook has no cells.");
  const isObj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const taken = new Set<string>();
  let n = 0;
  return {
    // No caps here: a notebook's cells and outputs are the user's data (a cap would drop some
    // on the next save; D203 audit).
    cells: d.cells.map((c) => {
      let id = typeof c?.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(c.id) ? c.id : "";
      while (!id || taken.has(id)) id = `cell-${++n}`;
      taken.add(id);
      const kind = c?.kind === "markdown" || c?.kind === "raw" ? c.kind : "code";
      return {
        id,
        kind,
        source: typeof c?.source === "string" ? c.source : "",
        metadata: isObj(c?.metadata) ? c.metadata : {},
        // nbformat's shape as files have it (text as lists of lines) is joined like a file's.
        outputs:
          kind === "code" && Array.isArray(c?.outputs)
            ? c.outputs.map(readOutput).filter((o): o is NbOutput => o !== null)
            : [],
        executionCount: typeof c?.executionCount === "number" ? c.executionCount : null,
        extra: isObj(c?.extra) ? c.extra : {},
      };
    }),
    metadata: isObj(d.metadata) ? d.metadata : {},
    nbformat: 4,
    nbformatMinor: 5,
    extra: isObj(d.extra) ? d.extra : {},
  };
}

/** What an extension's serializer gets: the cells without the IDE's own bookkeeping. */
export function toNotebookData(nb: Notebook): NotebookData {
  return {
    cells: nb.cells.map((c) => ({
      id: c.id,
      kind: c.kind,
      source: c.source,
      metadata: c.metadata,
      outputs: c.outputs,
      executionCount: c.executionCount,
      extra: c.extra,
    })),
    metadata: nb.metadata,
    extra: nb.extra,
  };
}
