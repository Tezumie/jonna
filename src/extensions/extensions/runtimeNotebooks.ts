// The host side of an extension's `ide.notebooks` (D202, D204): its notebook types (from
// `contributes.notebooks`, read and written by the serializer its worker registers), its kernel
// sources (with their picker actions), cell status items, and output renderers
// (`contributes.notebookRenderers`, drawn in the sandboxed output frame, with messages both ways).
// A kernel is the worker's object; `ExtensionKernel` is the editor's view of it, fed by the
// worker's requests.

import { Emitter } from "../../core/events/index";
import { fromNotebookData, toNotebookData } from "../../core/extensions/rpcNotebooks";
import type { ContributedNotebook, ContributedRenderer } from "../../core/extensions/thirdParty";
import { ideNotebookType } from "../../core/extensions/vscode/notebookEditors";
import { extIpc } from "../../core/ipc/extensions";
import { fsIpc } from "../../core/ipc/fs";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { type NotebookPreloadContribution, notebookPreloads } from "../../core/notebook/preloads";
import {
  type CellStatusItem,
  type ExecutingCell,
  JUPYTER_NOTEBOOK,
  type KernelContext,
  type KernelOption,
  type KernelSourceAction,
  type NotebookKernel,
} from "../../core/notebook/providers";
import type {
  CommMessage,
  KernelEvent,
  KernelInfo,
  KernelStatus,
  Notebook,
  Variable,
} from "../../core/notebook/types";
import { signal } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";
import type { ExtensionWorker } from "./workerHost";

const STATUSES: readonly KernelStatus[] = ["stopped", "starting", "idle", "busy", "dead"];
/** A notebook file the extension reads or writes: bigger ones aren't sent to the worker. */
const MAX_TEXT = 512 * 1024 * 1024;

export interface NotebookHostDeps {
  services: WorkbenchServices;
  extensionId: string;
  displayName: string;
  notebooks: readonly ContributedNotebook[];
  worker(): Promise<ExtensionWorker>;
  /** A problem shown on the extension's page. */
  warn(message: string): void;
  /** Throws unless the extension was allowed `permission`. */
  need(permission: string, what: string): void;
  /** Output renderers it declares (D204). */
  renderers: readonly ContributedRenderer[];
  /** The extension's folder (renderers' scripts are read from it). */
  root: string;
  /** Its granted permissions (a renderer's frame may reach the network it was allowed). */
  granted(): readonly string[];
  /** Its own command ids (a status item's command must be one). */
  commands: readonly string[];
}

/** A kernel option as the worker sent it: checked and capped (D202). */
function readOption(raw: unknown, source: string, fallbackDetail: string): KernelOption | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.label !== "string") return null;
  const languages = Array.isArray(o.languages)
    ? o.languages.filter((l): l is string => typeof l === "string").slice(0, 20)
    : undefined;
  return {
    source,
    id: o.id.slice(0, 200),
    label: o.label.slice(0, 120),
    detail: typeof o.detail === "string" ? o.detail.slice(0, 200) : fallbackDetail,
    language: typeof o.language === "string" ? o.language : "python",
    ...(languages?.length && { languages }),
    // Kept with the notebook's remembered kernel: small JSON only.
    ...(o.data !== undefined &&
      (JSON.stringify(o.data)?.length ?? 0) <= 16_384 && { data: o.data }),
  };
}

/** The network a renderer's frame may reach, from the extension's network permissions. */
export function rendererNetwork(granted: readonly string[]): "none" | "any" | string[] {
  if (granted.includes("network")) return "any";
  const hosts = granted
    .filter((g) => g.startsWith("network:"))
    .map((g) => g.slice("network:".length).toLowerCase())
    .filter((h) => /^(\*\.)?[a-z0-9.-]+(:\d+)?$/.test(h));
  return hosts.length ? hosts : "none";
}

export class ExtensionNotebooks implements Disposable {
  private readonly store = new DisposableStore();
  private readonly sources = new Map<string, Disposable>();
  private readonly serializers = new Set<string>();
  /** Waiting for the worker to register a type's serializer (it starts on first use). */
  private readonly serializerWaits = new Map<string, (() => void)[]>();
  private readonly kernels = new Map<string, ExtensionKernel>();
  private kernelSeq = 0;
  private readonly statusProviders = new Map<string, Disposable>();

  constructor(private readonly deps: NotebookHostDeps) {}

  /**
   * Its `contributes.notebookPreload` scripts (D295), read from its package.json the first time a
   * controller's output page asks: the page runs them before any renderer.
   */
  private contributePreloads(): void {
    let listed: Promise<NotebookPreloadContribution[]> | null = null;
    const codes = new Map<string, Promise<string>>();
    const read = (entrypoint: string) => {
      let code = codes.get(entrypoint);
      if (!code) {
        code = extIpc.readText(this.deps.root, entrypoint);
        code.catch(() => codes.delete(entrypoint));
        codes.set(entrypoint, code);
      }
      return code;
    };
    this.store.add(
      this.deps.services.notebooks.registerPreloadSource({
        owner: this.deps.extensionId,
        preloads: async (notebookType) => {
          listed ??= extIpc
            .readText(this.deps.root, "package.json")
            .then((text) => notebookPreloads(JSON.parse(text)))
            .catch(() => []);
          return (await listed)
            .filter((p) => ideNotebookType(p.type) === notebookType)
            .map((p) => ({
              id: `${this.deps.extensionId}/${p.entrypoint}`,
              owner: this.deps.extensionId,
              notebookType,
              code: () => read(p.entrypoint),
              network: () => rendererNetwork(this.deps.granted()),
            }));
        },
      }),
    );
  }

  /** Registers the manifest's notebook types (the worker starts when one is opened). */
  contribute(): void {
    this.contributePreloads();
    for (const nb of this.deps.notebooks) {
      // Jupyter notebooks are the IDE's own format (D204): no extension takes them (their text
      // would go to it unasked; D203 audit). Extensions run them with a kernel source instead.
      // Any ending of .ipynb files counts (".x.ipynb" would win over ".ipynb", the longer one).
      if (nb.type === JUPYTER_NOTEBOOK || nb.extensions.some((e) => e.endsWith(".ipynb"))) {
        this.deps.warn(
          `${nb.type}: Jupyter notebooks (.ipynb) are built into the IDE; run them with a kernel source (notebookTypes: ["${JUPYTER_NOTEBOOK}"]) instead.`,
        );
        continue;
      }
      try {
        this.store.add(
          this.deps.services.notebooks.registerType({
            id: nb.type,
            label: nb.displayName,
            extensions: nb.extensions,
            owner: this.deps.extensionId,
            opensByDefault: nb.default,
            serializer: {
              deserialize: async (text) => {
                if (text.length > MAX_TEXT) throw new Error("The notebook is too large to open.");
                const w = await this.serializerReady(nb.type);
                return fromNotebookData(
                  await w.call("notebook", "deserialize", { type: nb.type, text }),
                );
              },
              serialize: async (notebook: Notebook) => {
                const w = await this.serializerReady(nb.type);
                const text = await w.call<unknown>("notebook", "serialize", {
                  type: nb.type,
                  notebook: toNotebookData(notebook),
                });
                if (typeof text !== "string")
                  throw new Error(`${this.deps.displayName} didn't write the notebook as text.`);
                return text;
              },
            },
          }),
        );
      } catch (err) {
        // Another extension (or the IDE) has that type or those files: this one's is left out.
        this.deps.warn(err instanceof Error ? err.message : String(err));
      }
    }
    for (const r of this.deps.renderers) {
      let code: Promise<string> | null = null;
      try {
        this.store.add(
          this.deps.services.notebooks.registerRenderer({
            id: r.id,
            owner: this.deps.extensionId,
            displayName: r.displayName,
            mimeTypes: r.mimeTypes,
            // Read once, when an output first needs it (a failed read is tried again).
            code: () => {
              code ??= extIpc.readText(this.deps.root, r.entrypoint).catch((err: unknown) => {
                code = null;
                throw err;
              });
              return code;
            },
            network: () => rendererNetwork(this.deps.granted()),
            // A frame's message reaches the worker (started if needed), never blocking the frame.
            receive: (message, path) => {
              void this.deps
                .worker()
                .then((w) =>
                  w.call(
                    "notebook",
                    "rendererMessage",
                    { renderer: r.id, message, path },
                    undefined,
                    5000,
                  ),
                )
                .catch(() => {});
            },
          }),
        );
      } catch (err) {
        this.deps.warn(err instanceof Error ? err.message : String(err));
      }
    }
  }

  private async serializerReady(type: string): Promise<ExtensionWorker> {
    const w = await this.deps.worker();
    if (this.serializers.has(type)) return w;
    // Activation may still be running: up to 10 s for registerSerializer.
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error(`${this.deps.displayName} didn't register a serializer for ${type}.`));
      }, 10_000);
      const list = this.serializerWaits.get(type) ?? [];
      list.push(() => {
        window.clearTimeout(timer);
        resolve();
      });
      this.serializerWaits.set(type, list);
    });
    return w;
  }

  /** Requests from the worker under `notebooks.*`, or UNHANDLED. */
  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    switch (method) {
      case "notebooks.registerSerializer": {
        const type = String(p.type);
        if (!this.deps.notebooks.some((n) => n.type === type))
          throw new Error(
            `${type} isn't one of the extension's notebook types (contributes.notebooks).`,
          );
        this.serializers.add(type);
        for (const done of this.serializerWaits.get(type) ?? []) done();
        this.serializerWaits.delete(type);
        return Promise.resolve(undefined);
      }
      case "notebooks.unregisterSerializer":
        this.serializers.delete(String(p.type));
        return Promise.resolve(undefined);
      case "notebooks.registerKernelSource":
        return Promise.resolve(this.registerSource(p));
      case "notebooks.unregisterKernelSource": {
        const id = this.sourceId(String(p.id));
        this.sources.get(id)?.dispose();
        this.sources.delete(id);
        return Promise.resolve(undefined);
      }
      case "notebooks.output":
        this.kernels.get(String(p.kernel))?.output(p.exec, p.event);
        return Promise.resolve(undefined);
      case "notebooks.input": {
        const k = this.kernels.get(String(p.kernel));
        if (!k) return Promise.reject(new Error("The kernel has stopped."));
        return k.askInput(String(p.prompt ?? ""), p.password === true);
      }
      case "notebooks.status":
        this.kernels.get(String(p.kernel))?.setStatus(p.status, p.info);
        return Promise.resolve(undefined);
      case "notebooks.comm":
        this.kernels.get(String(p.kernel))?.comm(p.message);
        return Promise.resolve(undefined);
      case "notebooks.exit":
        this.kernels.get(String(p.kernel))?.exited(String(p.reason ?? ""));
        return Promise.resolve(undefined);
      case "notebooks.registerStatusProvider":
        return Promise.resolve(this.registerStatusProvider(p));
      case "notebooks.unregisterStatusProvider": {
        const id = String(p.id);
        this.statusProviders.get(id)?.dispose();
        this.statusProviders.delete(id);
        return Promise.resolve(undefined);
      }
      case "notebooks.kernelPost": {
        // A controller's message for its notebooks' output pages (D295): its own sources only.
        const source = this.sourceId(String(p.source ?? ""));
        if (!this.sources.has(source)) return Promise.resolve(false);
        const message = JSON.parse(JSON.stringify(p.message ?? null)) as unknown;
        if (JSON.stringify(message).length > 64 * 1024 * 1024)
          throw new Error("The message is too large (64 MB at most).");
        return Promise.resolve(
          this.deps.services.notebooks.postToKernelPages(
            source,
            message,
            typeof p.path === "string" ? p.path : undefined,
          ),
        );
      }
      case "notebooks.rendererPost": {
        const renderer = String(p.renderer);
        if (!this.deps.renderers.some((r) => r.id === renderer))
          throw new Error(`${renderer} isn't one of the extension's notebook renderers.`);
        // The message crosses into the frame as JSON (structured clone of plain data).
        const message = JSON.parse(JSON.stringify(p.message ?? null)) as unknown;
        if (JSON.stringify(message).length > 8 * 1024 * 1024)
          throw new Error("The message is too large (8 MB at most).");
        this.deps.services.notebooks.postToRenderer(
          renderer,
          message,
          typeof p.path === "string" ? p.path : undefined,
        );
        return Promise.resolve(undefined);
      }
      default:
        return UNHANDLED;
    }
  }

  /** A source's id as the IDE knows it: the extension's id in front (no clash with others'). */
  private sourceId(id: string): string {
    return `${this.deps.extensionId}/${id}`;
  }

  /** Items for cells' status rows from the worker (D204): checked, capped, 2 s at most. */
  private registerStatusProvider(p: Record<string, unknown>): void {
    const id = String(p.id ?? "");
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error(`Bad status provider id "${id}".`);
    // It's told every cell's source and the notebook's path: reading files, so fs.read.
    this.deps.need("fs.read", "see notebook cells");
    const type = typeof p.notebookType === "string" ? p.notebookType : "*";
    this.statusProviders.get(id)?.dispose();
    const commands = new Set(this.deps.commands);
    this.statusProviders.set(
      id,
      this.deps.services.notebooks.registerCellStatusProvider({
        owner: this.deps.extensionId,
        ...(type !== "*" && { notebookTypes: [type] }),
        provide: async (context) => {
          const w = await this.deps.worker();
          const list = await w.call<unknown>(
            "notebook",
            "status",
            { provider: id, context },
            undefined,
            2000,
          );
          return (Array.isArray(list) ? list : []).slice(0, 4).flatMap((raw): CellStatusItem[] => {
            const o = (raw ?? {}) as Record<string, unknown>;
            if (typeof o.text !== "string" || !o.text.trim()) return [];
            return [
              {
                text: o.text.slice(0, 80),
                ...(typeof o.tooltip === "string" && { tooltip: o.tooltip.slice(0, 300) }),
                // Its own commands only (a status item can't run the IDE's).
                ...(typeof o.command === "string" &&
                  commands.has(o.command) && { command: o.command }),
                alignment: o.alignment === "right" ? "right" : "left",
              },
            ];
          });
        },
      }),
    );
  }

  private registerSource(p: Record<string, unknown>): void {
    const local = String(p.id ?? "");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(local)) throw new Error(`Bad kernel source id "${local}".`);
    const id = this.sourceId(local);
    this.sources.get(id)?.dispose();
    const types = Array.isArray(p.notebookTypes)
      ? p.notebookTypes.filter((t): t is string => typeof t === "string").slice(0, 20)
      : undefined;
    const label = String(p.label ?? local).slice(0, 60);
    const messaging = p.messaging === true;
    const actions = (Array.isArray(p.actions) ? p.actions : [])
      .slice(0, 10)
      .flatMap((raw): KernelSourceAction[] => {
        const a = (raw ?? {}) as Record<string, unknown>;
        if (typeof a.id !== "string" || typeof a.label !== "string") return [];
        return [
          {
            id: a.id.slice(0, 64),
            label: a.label.slice(0, 60),
            ...(typeof a.detail === "string" && { detail: a.detail.slice(0, 120) }),
          },
        ];
      });
    const registration = this.deps.services.notebooks.registerKernelSource({
      id,
      label,
      ...(types && { notebookTypes: types }),
      ...(actions.length && {
        actions,
        // An action asks the user things (a server's address…): no time limit but the user's.
        runAction: async (action, context) => {
          const w = await this.deps.worker();
          const r = await w.call<unknown>(
            "notebook",
            "action",
            { source: local, action, context },
            undefined,
            0,
          );
          return r ? readOption(r, id, label) : null;
        },
      }),
      find: async (context) => {
        const w = await this.deps.worker();
        const list = await w.call<unknown>("notebook", "find", { source: local, context });
        return (Array.isArray(list) ? list : [])
          .slice(0, 200)
          .flatMap((raw) => readOption(raw, id, label) ?? []);
      },
      create: (option, context) => {
        const kernelId = `k${++this.kernelSeq}`;
        return new ExtensionKernel(
          kernelId,
          local,
          option,
          context,
          this.deps,
          this.kernels,
          messaging,
        );
      },
    });
    this.sources.set(id, registration);
  }

  /** The worker crashed: its kernels are gone and a new worker registers its serializers again. */
  workerGone(): void {
    for (const k of [...this.kernels.values()])
      k.exited("The extension's code stopped unexpectedly.");
    this.serializers.clear();
    for (const s of this.statusProviders.values()) s.dispose();
    this.statusProviders.clear();
  }

  dispose(): void {
    for (const k of [...this.kernels.values()]) k.stoppedWithExtension();
    this.kernels.clear();
    for (const s of this.statusProviders.values()) s.dispose();
    this.statusProviders.clear();
    for (const s of this.sources.values()) s.dispose();
    this.sources.clear();
    this.serializerWaits.clear();
    this.store.dispose();
  }
}

/** The notebook editor's handle on a kernel that lives in an extension's worker. */
class ExtensionKernel implements NotebookKernel {
  private readonly statusSignal = signal<KernelStatus>("stopped");
  readonly status = this.statusSignal;
  private readonly infoSignal = signal<KernelInfo | null>(null);
  readonly info = this.infoSignal;
  private readonly inputs = new Emitter<{ id: string; prompt: string; password: boolean }>();
  readonly onInputRequest = this.inputs.event;
  private readonly exits = new Emitter<string>();
  readonly onExit = this.exits.event;
  private readonly comms = new Emitter<CommMessage>();
  readonly onComm = this.comms.event;
  private readonly strays = new Emitter<KernelEvent>();
  readonly onStrayOutput = this.strays.event;
  private started: Promise<void> | null = null;
  /** Running cells: their outputs, and how to end them when the kernel goes. */
  private readonly runs = new Map<
    string,
    {
      onEvent: (e: KernelEvent) => void;
      end: (r: { status: string; count: number | null }) => void;
    }
  >();
  private readonly waitingInput = new Map<string, (value: string) => void>();
  private seq = 0;

  constructor(
    private readonly id: string,
    private readonly source: string,
    readonly option: KernelOption,
    private readonly context: KernelContext & { cwd: string },
    private readonly deps: NotebookHostDeps,
    /** The live kernels by id (the worker's messages find them there while started). */
    private readonly live: Map<string, ExtensionKernel>,
    /** A VS Code controller's: its notebooks' output page talks with it (D295). */
    withMessaging = false,
  ) {
    if (withMessaging)
      this.messaging = {
        post: (message) => this.postFromPage(message),
        rendererScripts: () => this.readRendererScripts(),
        readResource: (path) => this.readResource(path),
      };
  }

  readonly messaging?: NotebookKernel["messaging"];

  /** Its controller's rendererScripts (absolute paths the worker said when it started). */
  private rendererScriptPaths: readonly string[] = [];

  /** The path inside the extension's folder, relative ("dist/x.js"), or null when it's outside. */
  private extensionRelative(path: string): string | null {
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
    const root = norm(this.deps.root);
    const p = norm(path);
    if (!root || !p.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null;
    const rel = p.slice(root.length + 1);
    return rel.split("/").includes("..") ? null : rel;
  }

  private async readRendererScripts(): Promise<{ id: string; code: string }[]> {
    const out: { id: string; code: string }[] = [];
    for (const path of this.rendererScriptPaths) {
      const rel = this.extensionRelative(path);
      if (!rel) continue;
      const code = await extIpc.readText(this.deps.root, rel).catch(() => null);
      if (code !== null) out.push({ id: `${this.deps.extensionId}/${rel}`, code });
    }
    return out;
  }

  /** A file the page asks for: the extension's own, or the workspace's (VS Code's defaults). */
  private async readResource(path: string): Promise<Uint8Array> {
    const rel = this.extensionRelative(path);
    if (rel) return extIpc.read(this.deps.root, rel);
    if (this.deps.services.workspace.contains(path)) return fsIpc.read(path);
    throw new Error(`${path} isn't a file the notebook's page may load.`);
  }

  /**
   * A preload's message for the controller (VS Code's onDidReceiveMessage): after the kernel has
   * started (one starting holds it until then), in the order they came.
   */
  private postFromPage(message: unknown): void {
    const started = this.started;
    if (!started) return;
    void started
      .then(() => this.worker())
      .then((w) =>
        w.call("notebook", "kernelMessage", { kernel: this.id, message }, undefined, 30_000),
      )
      .catch(() => {});
  }

  private worker(): Promise<ExtensionWorker> {
    return this.deps.worker();
  }

  start(): Promise<void> {
    this.started ??= (async () => {
      this.statusSignal.value = "starting";
      this.live.set(this.id, this);
      const w = await this.worker();
      const started = await w.call<unknown>(
        "notebook",
        "start",
        {
          source: this.source,
          kernel: this.id,
          option: {
            id: this.option.id,
            label: this.option.label,
            detail: this.option.detail,
            language: this.option.language,
            ...(this.option.data !== undefined && { data: this.option.data }),
          },
          context: this.context,
        },
        undefined,
        120_000,
      );
      const scripts = (started as { rendererScripts?: unknown } | null)?.rendererScripts;
      if (Array.isArray(scripts))
        this.rendererScriptPaths = scripts
          .filter((s): s is string => typeof s === "string")
          .slice(0, 20);
      this.infoSignal.value ??= {
        mode: "other",
        kernel: this.option.id,
        display: this.option.label,
        language: this.option.language,
      };
      if (this.statusSignal.peek() === "starting") this.statusSignal.value = "idle";
    })().catch((err: unknown) => {
      this.started = null;
      this.live.delete(this.id);
      this.statusSignal.value = "dead";
      throw err;
    });
    return this.started;
  }

  async execute(
    code: string,
    onEvent: (e: KernelEvent) => void,
    cell?: ExecutingCell,
  ): Promise<{ status: string; count: number | null }> {
    await this.start();
    const exec = `x${++this.seq}`;
    // Ended by the worker's answer, or by the kernel going (shutdown, exit, the extension
    // stopping): the notebook's run queue never waits on a kernel that's gone.
    let end: (r: { status: string; count: number | null }) => void = () => {};
    const ended = new Promise<{ status: string; count: number | null }>((resolve) => {
      end = resolve;
    });
    this.runs.set(exec, { onEvent, end });
    const busyBefore = this.statusSignal.peek();
    if (busyBefore === "idle") this.statusSignal.value = "busy";
    try {
      const w = await this.worker();
      // A cell runs as long as it runs: no time limit (Interrupt and Restart are there).
      const answer = w
        .call<{ status?: string; count?: number | null }>(
          "notebook",
          "execute",
          { kernel: this.id, exec, code, ...(cell && { cell }) },
          undefined,
          0,
        )
        .then((r) => ({ status: r?.status ?? "ok", count: r?.count ?? null }));
      return await Promise.race([answer, ended]);
    } catch (err) {
      onEvent({
        type: "error",
        ename: "KernelError",
        evalue: err instanceof Error ? err.message : String(err),
        traceback: [],
      });
      return { status: "error", count: null };
    } finally {
      this.runs.delete(exec);
      if (this.statusSignal.peek() === "busy") this.statusSignal.value = "idle";
    }
  }

  output(exec: unknown, event: unknown): void {
    if (!event || typeof event !== "object" || typeof (event as KernelEvent).type !== "string")
      return;
    const e = event as KernelEvent;
    const run = typeof exec === "string" ? this.runs.get(exec) : undefined;
    if (run) run.onEvent(e);
    else this.strays.fire(e);
  }

  askInput(prompt: string, password: boolean): Promise<string> {
    const id = `i${++this.seq}`;
    return new Promise<string>((resolve) => {
      this.waitingInput.set(id, resolve);
      this.inputs.fire({ id, prompt: prompt.slice(0, 500), password });
    });
  }

  input(id: string, value: string): void {
    this.waitingInput.get(id)?.(value);
    this.waitingInput.delete(id);
  }

  setStatus(status: unknown, info: unknown): void {
    if (STATUSES.includes(status as KernelStatus)) this.statusSignal.value = status as KernelStatus;
    if (info && typeof info === "object") {
      const i = info as Partial<KernelInfo>;
      this.infoSignal.value = {
        // "jupyter": a Jupyter kernel (widgets are live, its kernelspec is saved in .ipynb).
        mode: i.mode === "jupyter" ? "jupyter" : "other",
        kernel: typeof i.kernel === "string" ? i.kernel : this.option.id,
        display: typeof i.display === "string" ? i.display.slice(0, 120) : this.option.label,
        language: typeof i.language === "string" ? i.language : this.option.language,
      };
    }
  }

  comm(message: unknown): void {
    const m = message as CommMessage | undefined;
    if (m && typeof m === "object" && typeof m.content?.comm_id === "string") this.comms.fire(m);
  }

  exited(reason: string): void {
    this.started = null;
    this.live.delete(this.id);
    this.statusSignal.value = "dead";
    this.endRuns(reason);
    this.exits.fire(reason.slice(0, 2000));
  }

  /** The extension stopped (disabled, uninstalled, crashed): the kernel is gone. */
  stoppedWithExtension(): void {
    this.started = null;
    this.live.delete(this.id);
    this.statusSignal.value = "dead";
    this.endRuns(`${this.deps.displayName} stopped.`);
  }

  private endRuns(reason: string): void {
    for (const [, resolve] of this.waitingInput) resolve("");
    this.waitingInput.clear();
    for (const run of this.runs.values()) {
      run.onEvent({
        type: "error",
        ename: "KernelDied",
        evalue: reason || "The kernel stopped.",
        traceback: [],
      });
      run.end({ status: "error", count: null });
    }
    this.runs.clear();
  }

  private async ask<T>(
    op: string,
    extra: Record<string, unknown>,
    fallback: T,
    ms = 5000,
  ): Promise<T> {
    const s = this.statusSignal.peek();
    if (!this.started || s === "dead" || s === "stopped") return fallback;
    try {
      const w = await this.worker();
      const r = await w.call<T>("notebook", op, { kernel: this.id, ...extra }, undefined, ms);
      return r ?? fallback;
    } catch {
      return fallback;
    }
  }

  complete(code: string, cursor: number) {
    return this.ask<{ matches: string[]; start: number; end: number } | null>(
      "complete",
      { code, cursor },
      null,
      3000,
    ).then((r) =>
      r && Array.isArray(r.matches)
        ? {
            matches: r.matches.filter((m) => typeof m === "string").slice(0, 500),
            start: Number(r.start) || 0,
            end: Number(r.end) || 0,
          }
        : null,
    );
  }

  async inspect(code: string, cursor: number): Promise<string> {
    const r = await this.ask<unknown>("inspect", { code, cursor }, "", 3000);
    return typeof r === "string" ? r.slice(0, 50_000) : "";
  }

  async variables(): Promise<Variable[] | null> {
    const r = await this.ask<unknown>("variables", {}, null, 8000);
    if (!Array.isArray(r)) return null;
    return r.slice(0, 1000).map((v) => {
      const x = (v ?? {}) as Record<string, unknown>;
      return {
        name: String(x.name ?? ""),
        type: String(x.type ?? ""),
        value: String(x.value ?? "").slice(0, 500),
        size: String(x.size ?? ""),
      };
    });
  }

  sendComm(
    kind: "comm_msg" | "comm_close",
    commId: string,
    data: unknown,
    metadata?: unknown,
    buffers?: string[],
  ): Promise<boolean> {
    return this.ask<boolean>(
      "comm",
      { kind, commId, data, metadata: metadata ?? {}, buffers: buffers ?? [] },
      false,
      30_000,
    ).then((r) => r === true);
  }

  interrupt(): void {
    void this.ask("interrupt", {}, null);
  }

  async restart(): Promise<void> {
    if (this.started && this.statusSignal.peek() !== "dead") {
      const own = await this.ask<boolean | null>("restart", {}, null, 90_000);
      if (own === true) return;
    }
    // No restart of its own (or it's dead): a fresh one.
    await this.shutdown();
    await this.start();
  }

  async shutdown(): Promise<void> {
    const wasStarted = this.started;
    this.started = null;
    this.endRuns("The kernel was shut down.");
    if (wasStarted)
      await this.worker()
        .then((w) => w.call("notebook", "shutdown", { kernel: this.id }, undefined, 5000))
        .catch(() => {});
    this.statusSignal.value = "stopped";
    this.live.delete(this.id);
  }
}
