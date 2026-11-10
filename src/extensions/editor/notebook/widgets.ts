// Jupyter widgets' state on the IDE side (D189). The kernel's comm messages (through the kernel
// host) are kept per notebook, so every output frame showing a widget can be given the widgets'
// current state when it loads, and live messages are passed on to all of them. Output widgets
// capture outputs (their `msg_id` names the kernel message whose outputs they take), as Jupyter
// Lab does. Saved into the notebook's metadata (the widget-state format) so a notebook opened
// again still shows its widgets until it runs. DOM-free and unit-tested.
import { Emitter } from "../../../core/events/index";
import type { CommMessage } from "../../../core/notebook/types";
import { applyOutput, type KernelEvent, type NbOutput } from "./model";

/** A comm message as the frames get it (buffers base64). */
export type { CommMessage };

interface Comm {
  target: string;
  state: Record<string, unknown>;
  /** JSON path (joined with \u0000) → base64 bytes. */
  buffers: Map<string, { path: unknown[]; data: string }>;
  metadata: Record<string, unknown>;
  /** Output widgets: a pending clear_output(wait=True). */
  clear: { clearPending: boolean };
}

const pathKey = (path: unknown[]) => path.map(String).join("\u0000");

/** The saved widget-state format (application/vnd.jupyter.widget-state+json). */
export interface SavedWidgetState {
  version_major: number;
  version_minor: number;
  state: Record<
    string,
    {
      model_name: string;
      model_module: string;
      model_module_version: string;
      state: Record<string, unknown>;
      buffers?: { path: unknown[]; encoding: "base64"; data: string }[];
    }
  >;
}

export class WidgetStore {
  private readonly comms = new Map<string, Comm>();
  private readonly changed = new Emitter<{ message: CommMessage; from?: unknown }>();
  /**
   * Every message the frames should get (from the kernel, made up for Output widgets, or a
   * frame's own change: `from` is that frame, which already has it).
   */
  readonly onMessage = this.changed.event;
  /** Restored from the file: shown, but nothing answers them until the notebook runs. */
  private saved = false;

  get size(): number {
    return this.comms.size;
  }

  /** Whether `modelId` is a widget there is state for (live, or saved in the file). */
  has(modelId: string): boolean {
    return this.comms.has(modelId);
  }

  /** True while the state came from the file (no kernel behind it). */
  get isSaved(): boolean {
    return this.saved && this.comms.size > 0;
  }

  /** A comm message from the kernel (or, with `from`, a frame's change on its way to it). */
  handle(m: CommMessage, from?: unknown): void {
    const id = m.content.comm_id;
    if (!id) return;
    if (this.saved && from === undefined) {
      // The kernel is talking: the file's widgets are gone.
      this.comms.clear();
      this.saved = false;
    }
    if (m.kind === "comm_open") {
      const data = m.content.data ?? {};
      const comm: Comm = {
        target: String(m.content.target_name ?? ""),
        state: { ...(data.state ?? {}) },
        buffers: new Map(),
        metadata: m.metadata ?? {},
        clear: { clearPending: false },
      };
      this.setBuffers(comm, data.buffer_paths, m.buffers);
      this.comms.set(id, comm);
    } else if (m.kind === "comm_msg") {
      const comm = this.comms.get(id);
      const data = m.content.data ?? {};
      if (comm && (data.method === "update" || data.method === "echo_update") && data.state) {
        Object.assign(comm.state, data.state);
        for (const key of Object.keys(data.state))
          for (const [k, b] of comm.buffers) if (String(b.path[0]) === key) comm.buffers.delete(k);
        this.setBuffers(comm, data.buffer_paths, m.buffers);
      }
    } else this.comms.delete(id);
    this.changed.fire({ message: m, ...(from !== undefined && { from }) });
  }

  private setBuffers(comm: Comm, paths: unknown[] | undefined, buffers: string[] | undefined) {
    if (!Array.isArray(paths) || !buffers) return;
    paths.forEach((p, i) => {
      const data = buffers[i];
      if (Array.isArray(p) && typeof data === "string")
        comm.buffers.set(pathKey(p), { path: p, data });
    });
  }

  /** comm_open messages carrying each widget's current state (for a frame that just loaded). */
  snapshot(): CommMessage[] {
    return [...this.comms].map(([id, c]) => {
      const buffers = [...c.buffers.values()];
      return {
        kind: "comm_open",
        content: {
          comm_id: id,
          target_name: c.target,
          data: { state: c.state, buffer_paths: buffers.map((b) => b.path) },
        },
        metadata: { version: "2.1.0", ...c.metadata },
        buffers: buffers.map((b) => b.data),
      };
    });
  }

  /** The Output widget capturing the outputs of kernel message `parent`, if one is. */
  captureFor(parent: string | null | undefined): string | undefined {
    if (!parent) return undefined;
    for (const [id, c] of this.comms)
      if (c.state._model_name === "OutputModel" && c.state.msg_id === parent) return id;
    return undefined;
  }

  /** Adds an output event to an Output widget (as Jupyter Lab does) and tells the frames. */
  capture(commId: string, e: KernelEvent): void {
    const comm = this.comms.get(commId);
    if (!comm) return;
    const outputs = Array.isArray(comm.state.outputs)
      ? [...(comm.state.outputs as NbOutput[]).map((o) => ({ ...o }))]
      : [];
    applyOutput(outputs, e, comm.clear);
    comm.state.outputs = outputs;
    this.changed.fire({
      message: {
        kind: "comm_msg",
        content: {
          comm_id: commId,
          data: { method: "update", state: { outputs }, buffer_paths: [] },
        },
      },
    });
  }

  /** Everything forgotten (the kernel restarted or stopped). */
  reset(): void {
    this.comms.clear();
    this.saved = false;
  }

  /** The widgets in the saved format (null: none). */
  toSaved(): SavedWidgetState | null {
    const state: SavedWidgetState["state"] = {};
    for (const [id, c] of this.comms) {
      if (c.target !== "jupyter.widget") continue;
      const s = c.state;
      state[id] = {
        model_name: String(s._model_name ?? ""),
        model_module: String(s._model_module ?? ""),
        model_module_version: String(s._model_module_version ?? ""),
        state: s,
        ...(c.buffers.size && {
          buffers: [...c.buffers.values()].map((b) => ({
            path: b.path,
            encoding: "base64" as const,
            data: b.data,
          })),
        }),
      };
    }
    return Object.keys(state).length ? { version_major: 2, version_minor: 0, state } : null;
  }

  /** Widgets saved in a notebook's metadata, shown until the notebook runs. */
  restore(saved: unknown): void {
    if (this.comms.size || !saved || typeof saved !== "object") return;
    const all = (saved as { state?: unknown }).state;
    if (!all || typeof all !== "object") return;
    for (const [id, raw] of Object.entries(all as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const w = raw as SavedWidgetState["state"][string];
      const comm: Comm = {
        target: "jupyter.widget",
        state: {
          _model_name: w.model_name,
          _model_module: w.model_module,
          _model_module_version: w.model_module_version,
          ...(w.state ?? {}),
        },
        buffers: new Map(),
        metadata: {},
        clear: { clearPending: false },
      };
      // The file's own data: a null entry mustn't throw (the whole notebook wouldn't open).
      for (const b of Array.isArray(w.buffers) ? w.buffers : [])
        if (b && Array.isArray(b.path) && typeof b.data === "string")
          comm.buffers.set(pathKey(b.path), { path: b.path, data: b.data });
      this.comms.set(id, comm);
    }
    this.saved = this.comms.size > 0;
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/** The key notebooks keep saved widget state under (in metadata.widgets). */
export const WIDGET_STATE_MIME = "application/vnd.jupyter.widget-state+json";
