// A notebook in memory (D188), DOM-free and tested: the cell edits and output bookkeeping the
// editor and the agent's commands share. Reading and writing files is a notebook type's
// serializer (D202; Jupyter's .ipynb is built in, core/notebook/ipynb.ts, D204).

import { newCellId } from "../../../core/notebook/ipynb";
import type {
  CellKind,
  KernelEvent,
  NbCell,
  NbOutput,
  Notebook,
} from "../../../core/notebook/types";

export type { CellKind, KernelEvent, NbCell, NbOutput, Notebook };

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export function emptyNotebook(language = "python"): Notebook {
  return {
    cells: [newCell("code")],
    metadata: {
      kernelspec:
        language === "python"
          ? { display_name: "Python 3", language: "python", name: "python3" }
          : {},
      language_info: { name: language },
    },
    nbformat: 4,
    nbformatMinor: 5,
    extra: {},
  };
}

export function newCell(kind: CellKind, source = ""): NbCell {
  return {
    id: newCellId(),
    kind,
    source,
    metadata: {},
    outputs: [],
    executionCount: null,
    extra: {},
  };
}

/** The notebook's language (metadata), for its cells' syntax colors. */
export function notebookLanguage(nb: Notebook): string {
  const info = nb.metadata.language_info;
  const spec = nb.metadata.kernelspec;
  const name =
    (isObject(info) && typeof info.name === "string" && info.name) ||
    (isObject(spec) && typeof spec.language === "string" && spec.language) ||
    "python";
  return name.toLowerCase();
}

// ---- Outputs while a cell runs ------------------------------------------------------------------

/**
 * Applies one output event to a cell's outputs (in place): streams merge with the stream before
 * them, as Jupyter shows them; `clear` (wait: until the next output) empties them. Returns the
 * display id an output carries, so updates can find it.
 */
export function applyOutput(
  outputs: NbOutput[],
  e: KernelEvent,
  state: { clearPending: boolean },
): NbOutput | null {
  if (e.type === "clear") {
    if (e.wait) state.clearPending = true;
    else outputs.length = 0;
    return null;
  }
  if (state.clearPending && ["stream", "display", "result", "error"].includes(e.type)) {
    outputs.length = 0;
    state.clearPending = false;
  }
  if (e.type === "stream") {
    const last = outputs[outputs.length - 1];
    const name = e.name === "stderr" ? "stderr" : "stdout";
    if (last?.output_type === "stream" && last.name === name) {
      last.text = (last.text ?? "") + (e.text ?? "");
      return last;
    }
    const out: NbOutput = { output_type: "stream", name, text: e.text ?? "" };
    outputs.push(out);
    return out;
  }
  if (e.type === "display" || e.type === "result") {
    const out: NbOutput =
      e.type === "result"
        ? {
            output_type: "execute_result",
            data: e.data ?? {},
            metadata: e.metadata ?? {},
            execution_count: e.count ?? null,
          }
        : { output_type: "display_data", data: e.data ?? {}, metadata: e.metadata ?? {} };
    outputs.push(out);
    return out;
  }
  if (e.type === "error") {
    const out: NbOutput = {
      output_type: "error",
      ename: e.ename ?? "Error",
      evalue: e.evalue ?? "",
      traceback: Array.isArray(e.traceback) ? e.traceback : [],
    };
    outputs.push(out);
    return out;
  }
  return null;
}

// ---- Text views ---------------------------------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what it removes
const ANSI_ANY = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)/g;
export const stripAnsi = (s: string) => s.replace(ANSI_ANY, "");

/** A cell's outputs as plain text (for the agent, find, copying): images by their type. */
export function outputText(outputs: readonly NbOutput[], max = 4000): string {
  const parts: string[] = [];
  for (const o of outputs) {
    if (o.output_type === "stream") parts.push(stripAnsi(o.text ?? ""));
    else if (o.output_type === "error")
      parts.push(
        stripAnsi((o.traceback ?? []).join("\n")) || `${o.ename ?? "Error"}: ${o.evalue ?? ""}`,
      );
    else if (o.data) {
      const d = o.data;
      const plain = typeof d["text/plain"] === "string" ? (d["text/plain"] as string) : "";
      const images = Object.keys(d).filter((m) => m.startsWith("image/"));
      if (plain && !images.length) parts.push(stripAnsi(plain));
      else if (images.length) parts.push(`[${images[0]}]${plain ? ` ${plain}` : ""}`);
      else if (typeof d["text/markdown"] === "string") parts.push(d["text/markdown"] as string);
      else if (typeof d["text/html"] === "string")
        parts.push(
          `[text/html] ${(d["text/html"] as string).replace(/<[^>]+>/g, " ").slice(0, 400)}`,
        );
    }
  }
  // Parts end where they end (a stream keeps its own newline).
  const text = parts
    .reduce((all, p) => (all && !all.endsWith("\n") ? `${all}\n${p}` : all + p), "")
    .trim();
  return text.length > max
    ? `${text.slice(0, max)}\n… (${text.length - max} more characters)`
    : text;
}

/** The notebook as a Python script with VS Code's "# %%" cell markers. */
export function toScript(nb: Notebook): string {
  const lang = notebookLanguage(nb);
  const comment = lang === "python" || lang === "r" || lang === "julia" ? "#" : "//";
  return `${nb.cells
    .map((c) => {
      if (c.kind === "code") return `${comment} %%\n${c.source}`;
      const tag = c.kind === "markdown" ? "[markdown]" : "[raw]";
      return `${comment} %% ${tag}\n${c.source
        .split("\n")
        .map((l) => `${comment} ${l}`.trimEnd())
        .join("\n")}`;
    })
    .join("\n\n")}\n`;
}

/**
 * Text with carriage returns resolved as a terminal would (progress bars: "\r" goes back to the
 * line's start; what follows overwrites it).
 */
export function resolveCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      let out = "";
      for (const part of line.split("\r")) out = part + out.slice(part.length);
      return out;
    })
    .join("\n");
}

// ---- Hot exit backups ---------------------------------------------------------------------------

/**
 * An unsaved notebook as hot exit keeps it: the editor's own model as JSON, not the file's format,
 * so a backup is taken without the format's serializer (an extension's answers asynchronously).
 */
export function notebookBackupText(nb: Notebook): string {
  return JSON.stringify(nb);
}

const CELL_KINDS: readonly string[] = ["code", "markdown", "raw"];

/** A backup read back (null when it isn't one): unknown fields get their defaults. */
export function notebookFromBackup(text: string): Notebook | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(data) || !Array.isArray(data.cells)) return null;
  const cells: NbCell[] = [];
  for (const c of data.cells) {
    if (!isObject(c) || typeof c.source !== "string") return null;
    const kind = typeof c.kind === "string" && CELL_KINDS.includes(c.kind) ? c.kind : "code";
    cells.push({
      id: typeof c.id === "string" && c.id ? c.id : newCellId(),
      kind: kind as CellKind,
      source: c.source,
      metadata: isObject(c.metadata) ? c.metadata : {},
      outputs: Array.isArray(c.outputs)
        ? c.outputs.filter((o): o is NbOutput => isObject(o) && typeof o.output_type === "string")
        : [],
      executionCount: typeof c.executionCount === "number" ? c.executionCount : null,
      extra: isObject(c.extra) ? c.extra : {},
    });
  }
  return {
    cells,
    metadata: isObject(data.metadata) ? data.metadata : {},
    nbformat: typeof data.nbformat === "number" ? data.nbformat : 4,
    nbformatMinor: typeof data.nbformatMinor === "number" ? data.nbformatMinor : 5,
    extra: isObject(data.extra) ? data.extra : {},
  };
}
