// The notebook data the IDE's notebook editor works on (D188, D202), shared by the editor, the
// file formats (serializers) and the kernels, whoever provides them: the IDE itself or an
// extension. Cells and outputs follow Jupyter's nbformat 4, the format most notebook tools speak;
// a serializer for another file format maps to and from it. DOM-free.

export type CellKind = "code" | "markdown" | "raw";

/** An output as nbformat stores it (`text`/`data` strings joined). */
export interface NbOutput {
  output_type: "stream" | "display_data" | "execute_result" | "error" | string;
  name?: string;
  text?: string;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  [key: string]: unknown;
}

export interface NbCell {
  id: string;
  kind: CellKind;
  source: string;
  metadata: Record<string, unknown>;
  outputs: NbOutput[];
  executionCount: number | null;
  /** Fields the editor doesn't use (attachments…), written back as read. */
  extra: Record<string, unknown>;
}

export interface Notebook {
  cells: NbCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformatMinor: number;
  extra: Record<string, unknown>;
}

/**
 * What a kernel sends while it works (kernel_host.py's events, the same for every kernel):
 * `stream` (name stdout/stderr, text), `display` / `result` (data: a mime bundle, metadata,
 * transient.display_id; result has count), `update_display`, `error` (ename, evalue, traceback),
 * `clear` (wait), `input_request` (prompt, password). `parent` ties a widget callback's outputs to
 * the message that caused them.
 */
export interface KernelEvent {
  id?: string | null;
  type: string;
  name?: string;
  text?: string;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  transient?: { display_id?: string };
  count?: number | null;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  wait?: boolean;
  [key: string]: unknown;
}

/** A Jupyter widget (comm) message (D189). */
export interface CommMessage {
  kind: "comm_open" | "comm_msg" | "comm_close";
  content: {
    comm_id: string;
    target_name?: string;
    data?: { method?: string; state?: Record<string, unknown>; buffer_paths?: unknown[] };
    [key: string]: unknown;
  };
  metadata?: Record<string, unknown>;
  buffers?: string[];
}

export type KernelStatus = "stopped" | "starting" | "idle" | "busy" | "dead";

/** What a started kernel says about itself. */
export interface KernelInfo {
  /** "jupyter": a Jupyter kernel (widgets work, its kernelspec is saved in .ipynb files). */
  mode: "jupyter" | "python" | "other";
  /** A Jupyter kernelspec name, or the kernel's own id. */
  kernel: string;
  display: string;
  language: string;
  python?: string;
  executable?: string;
}

/** A variable in the kernel's namespace (the Variables panel). */
export interface Variable {
  name: string;
  type: string;
  value: string;
  size: string;
}
