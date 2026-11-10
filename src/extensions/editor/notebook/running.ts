// Running a notebook's cells (D188, D202): the kernel (made by a kernel source, started on the
// first run or picked in Select kernel), the run queue (cells wait for the ones before them; Run
// all stops at the first error), outputs streaming into cells, display updates, widgets' comm
// messages, input requests and the variables. The notebook view owns one runner.
import { DisposableStore } from "../../../core/lifecycle/index";
import {
  JUPYTER_NOTEBOOK,
  type KernelOption,
  type KernelSource,
  type NotebookKernel,
} from "../../../core/notebook/providers";
import type { Variable } from "../../../core/notebook/types";
import { dirname } from "../../../core/paths/index";
import { effect } from "../../../core/reactive/index";
import type { WorkbenchServices } from "../../../workbench/services";
import type { CellView } from "./cell";
import { applyOutput, type KernelEvent, type NbOutput } from "./model";
import { askInput } from "./panels";
import type { WidgetStore } from "./widgets";

/** What the runner needs from the notebook view. */
export interface RunnerHost {
  readonly services: WorkbenchServices;
  readonly widgets: WidgetStore;
  path(): string;
  notebookType(): string;
  cells(): CellView[];
  selected(): number;
  /** The notebook's metadata (its kernelspec names the kernel it wants). */
  metadata(): Record<string, unknown> | undefined;
  language(): string;
  rememberedKernel(path: string): KernelOption | undefined;
  rememberKernel(path: string, option: KernelOption): void;
  /** A command from an agent (or another non-user caller) is running. */
  quiet(): boolean;
  /** The kernel or its state changed (toolbar, state). */
  kernelChanged(): void;
  /** A cell ran (dirty: its outputs changed). */
  markDirty(): void;
  /** The kernel's language may differ: cells' syntax follows it. */
  languageChanged(): void;
  /** Cells ran: the variables panel refreshes when it's shown. */
  ranCells(): void;
  /** Running cells needs a kernel and none could be chosen by itself: the picker (D204). */
  pickKernel(): Promise<void>;
  /** A cell finished running (extensions hear of it: notebook.didRunCell). */
  ranCell(cell: CellView): void;
}

export class NotebookRunner {
  private readonly store = new DisposableStore();
  kernel: NotebookKernel | null = null;
  /** What made the kernel: a reloaded extension registers a new source under the same id. */
  private kernelSource: KernelSource | null = null;
  private readonly kernelStore = this.store.add(new DisposableStore());
  private runToken = 0;
  private running: Promise<unknown> = Promise.resolve();
  /** display_id → the outputs showing it (update_display_data replaces them). */
  private readonly displays = new Map<string, { cell: CellView; output: NbOutput }[]>();
  variables: Variable[] | null = null;

  constructor(private readonly host: RunnerHost) {}

  private get services(): WorkbenchServices {
    return this.host.services;
  }

  /** Starts (or switches to) a kernel. */
  async useKernel(option: KernelOption): Promise<void> {
    const path = this.host.path();
    // The notebook's own folder (any of a multi-root workspace's, D251); an untitled notebook
    // (an Interactive Window) runs in the first folder, as VS Code's do.
    const untitled = path.startsWith("untitled:");
    const root =
      this.services.workspace.folderOf(path)?.path ??
      (untitled ? (this.services.workspace.root.peek() ?? undefined) : undefined);
    if (!root)
      throw new Error(
        this.services.workspace.isMultiRoot()
          ? "Notebooks run inside the workspace's folders: add the folder that has this notebook."
          : "Notebooks run inside the open folder: open the folder that has this notebook.",
      );
    // The new one first: when it can't be made, the old one keeps running.
    const source = this.services.notebooks.source(option.source);
    if (!source)
      throw new Error(
        `${option.label} isn't available: what provides it (${option.source}) isn't running. Pick another kernel.`,
      );
    const session = source.create(option, {
      root,
      path,
      notebookType: this.host.notebookType(),
      cwd: untitled ? root : dirname(path),
    });
    // Started before the old one goes: when it can't start, the old kernel (and its state)
    // stays (D203 audit).
    try {
      await session.start();
    } catch (err) {
      void session.shutdown().catch(() => {});
      throw err;
    }
    // Cells waiting for the old kernel don't run on the new one.
    this.runToken++;
    const old = this.kernel;
    this.kernelStore.clear();
    this.kernel = null;
    if (old) await old.shutdown();
    this.kernel = session;
    this.kernelSource = source;
    this.host.rememberKernel(path, option);
    this.kernelStore.add(
      effect(() => {
        session.status.value;
        session.info.value;
        this.host.kernelChanged();
        return undefined;
      }),
    );
    this.kernelStore.add(session.onInputRequest((r) => this.askInput(r)));
    // Widgets (D189): the kernel's comm messages, and outputs Output widgets capture. Another
    // kernel's widgets are gone; the file's saved ones stay until the kernel sends its own.
    const widgets = this.host.widgets;
    if (!widgets.isSaved) widgets.reset();
    this.kernelStore.add(session.onComm((m) => widgets.handle(m)));
    this.kernelStore.add(
      session.onStrayOutput((e) => {
        const id = widgets.captureFor(e.parent as string | undefined);
        if (id) widgets.capture(id, e);
      }),
    );
    this.kernelStore.add(
      session.onExit((why) =>
        this.services.notifications.show(
          "error",
          `The kernel stopped${why ? `: ${why.split("\n").pop()}` : "."}`,
        ),
      ),
    );
    this.kernelStore.add({ dispose: () => void session.shutdown() });
    this.host.languageChanged();
  }

  /** The kernel to run on: the current one, the remembered one, or the best one found. */
  async ensureKernel(): Promise<NotebookKernel> {
    const { services } = this;
    // What provided the kernel went away or was replaced (its extension stopped or reloaded).
    if (this.kernel && services.notebooks.source(this.kernel.option.source) !== this.kernelSource) {
      this.kernelStore.clear();
      this.kernel = null;
      this.kernelSource = null;
      this.host.kernelChanged();
    }
    if (this.kernel && this.kernel.status.peek() !== "dead") return this.kernel;
    if (this.kernel) {
      // A dead kernel (the host may still be up): a fresh one.
      await this.kernel.restart();
      return this.kernel;
    }
    await services.trust.require("Running notebook cells");
    this.throwIfClosed();
    const remembered = this.host.rememberedKernel(this.host.path());
    // A remembered kernel whose source isn't there (its extension off): find another.
    if (remembered && services.notebooks.source(remembered.source)) {
      await this.useKernel(remembered);
      return this.picked();
    }
    const type = this.host.notebookType();
    const root =
      services.workspace.folderOf(this.host.path())?.path ??
      services.workspace.root.peek() ??
      dirname(this.host.path());
    const found = await services.notebooks.findKernels({
      root,
      path: this.host.path(),
      notebookType: type,
    });
    this.throwIfClosed();
    // Picked by itself only among kernels made for this notebook type (the Jupyter extension's
    // for Jupyter notebooks): one that runs every type (an extension's) is the user's choice,
    // never a default that gets the cells' code and input unasked. Nothing to pick from: the
    // picker, which offers to turn the Jupyter extension on or look for kernels (VS Code's).
    const made = found.filter((k) =>
      services.notebooks.source(k.source)?.notebookTypes?.includes(type),
    );
    // The kernel the file names (a Jupyter kernelspec), then one of its language.
    const wanted = this.host.metadata()?.kernelspec as { name?: string } | undefined;
    const named = (k: KernelOption) => (k.data as { kernel?: unknown } | undefined)?.kernel;
    const language = this.host.language();
    const sameLanguage = (k: KernelOption) => k.language.toLowerCase() === language;
    const option =
      made.find((k) => wanted?.name && named(k) === wanted.name) ??
      made.find((k) => named(k) && sameLanguage(k)) ??
      made.find(sameLanguage) ??
      // Another type's kernels (an extension's format) say their own language.
      (type === JUPYTER_NOTEBOOK ? undefined : made[0]);
    if (option) {
      await this.useKernel(option);
      return this.picked();
    }
    // An R or Julia notebook whose kernel isn't installed must not quietly run its cells on
    // Python (D204): the user picks, or is told what's missing.
    if (this.host.quiet()) throw new Error(this.noKernelMessage(found.length > 0, language));
    await this.host.pickKernel();
    return this.picked();
  }

  private picked(): NotebookKernel {
    if (!this.kernel) throw new Error("No kernel was picked.");
    return this.kernel;
  }

  /** Why no kernel was started by itself (an agent's run: it can't use the picker). */
  noKernelMessage(foundSome: boolean, language: string): string {
    const jupyter = this.host.notebookType() === JUPYTER_NOTEBOOK;
    if (!foundSome)
      return jupyter
        ? "Nothing can run this notebook yet: turn on the Jupyter extension (notebook.enableJupyter), or install an extension with kernels."
        : "Nothing can run this notebook: no kernel is available for it.";
    return jupyter
      ? `No ${language} kernel was found for this notebook (install its Jupyter kernel, e.g. IRkernel for R or IJulia for Julia), or pick one with notebook.selectKernel.`
      : "Pick a kernel for this notebook first (notebook.selectKernel).";
  }

  private askInput(r: { id: string; prompt: string; password: boolean }): void {
    const cells = this.host.cells();
    const cell = cells.find((c) => c.runState === "running") ?? cells[this.host.selected()];
    if (cell) askInput(cell, r, (value) => this.kernel?.input(r.id, value));
  }

  /** Runs cells in order; stops at the first error (as Jupyter's Run all does). */
  async runCells(list: CellView[]): Promise<{ ran: number; failed: CellView | null }> {
    const code = list.filter((c) => c.cell.kind === "code" && c.cell.source.trim());
    for (const c of list) if (c.cell.kind === "markdown") c.setEditingMarkdown(false);
    if (!code.length) return { ran: 0, failed: null };
    const token = this.runToken;
    for (const c of code) c.setRunState("queued");
    const job = this.running.then(async () => {
      let ran = 0;
      let failed: CellView | null = null;
      let kernel: NotebookKernel;
      try {
        kernel = await this.ensureKernel();
      } catch (err) {
        for (const c of code) c.setRunState("idle");
        throw err;
      }
      for (const c of code) {
        if (token !== this.runToken || failed) {
          c.setRunState("idle");
          continue;
        }
        let ok: boolean;
        try {
          ok = await this.execute(kernel, c);
        } catch (err) {
          // The kernel couldn't run it (it can't start again, an extension's kernel failed): this
          // cell and the ones waiting don't stay "running" / "queued".
          for (const q of code)
            if (q.runState === "running" || q.runState === "queued") q.setRunState("idle");
          throw err;
        }
        ran++;
        if (!ok) failed = c;
      }
      this.host.ranCells();
      return { ran, failed };
    });
    this.running = job.catch(() => {});
    return job;
  }

  private async execute(kernel: NotebookKernel, c: CellView): Promise<boolean> {
    c.cell.outputs = [];
    c.cell.executionCount = null;
    for (const [id, list] of this.displays)
      this.displays.set(
        id,
        list.filter((d) => d.cell !== c),
      );
    c.renderOutputs();
    c.setRunState("running");
    const started = performance.now();
    const state = { clearPending: false };
    let frame = 0;
    const draw = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        c.renderOutputs();
      });
    };
    const widgets = this.host.widgets;
    const result = await kernel.execute(
      c.cell.source,
      (e: KernelEvent) => {
        if (e.type === "update_display") {
          const id = e.transient?.display_id;
          for (const d of (id && this.displays.get(id)) || []) {
            d.output.data = e.data ?? {};
            d.output.metadata = e.metadata ?? {};
            d.cell.renderOutputs();
          }
          return;
        }
        if (e.type === "input_request") return;
        // Inside `with output_widget:` the outputs are the widget's, not the cell's.
        const capture = widgets.captureFor(e.parent as string | undefined);
        if (capture) {
          widgets.capture(capture, e);
          return;
        }
        const out = applyOutput(c.cell.outputs, e, state);
        const id = e.transient?.display_id;
        if (out && id)
          this.displays.set(id, [...(this.displays.get(id) ?? []), { cell: c, output: out }]);
        draw();
      },
      // Which cell runs (an extension's kernel may want its id, language or metadata, D204).
      {
        id: c.cell.id,
        index: this.host.cells().indexOf(c),
        language: c.language(),
        metadata: c.cell.metadata,
      },
    );
    cancelAnimationFrame(frame);
    c.inputRow.hidden = true;
    c.cell.executionCount = result.count;
    c.renderOutputs();
    c.setRunState(result.status === "ok" ? "ok" : "error", performance.now() - started);
    this.host.markDirty();
    this.host.ranCell(c);
    return result.status === "ok";
  }

  interrupt(): void {
    this.runToken++;
    this.kernel?.interrupt();
    for (const c of this.host.cells()) if (c.runState === "queued") c.setRunState("idle");
  }

  async restart(): Promise<void> {
    this.runToken++;
    this.host.widgets.reset();
    for (const c of this.host.cells())
      if (c.runState === "queued" || c.runState === "running") c.setRunState("idle");
    if (this.kernel) await this.kernel.restart();
    this.variables = null;
  }

  async refreshVariables(): Promise<void> {
    this.variables = this.kernel ? await this.kernel.variables() : null;
  }

  /**
   * The notebook closed while a run waited (for trust, for kernels to be found): it must not
   * start a kernel or ask for one by its path (that opened it again).
   */
  private throwIfClosed(): void {
    if (this.store.isDisposed) throw new Error("The notebook was closed.");
  }

  dispose(): void {
    // Cells queued behind a kernel don't run once it's closed.
    this.runToken++;
    this.store.dispose();
  }
}
