// Jupyter's .ipynb format (nbformat 4), built into the IDE (D204, as VS Code's built-in ipynb
// extension): any .ipynb opens, edits and saves as a notebook with no extension; running its
// cells is a kernel source's job (the built-in Jupyter extension's Pythons, or another's).
// Read and written so that what was read is kept: unknown top-level and cell fields, keys sorted,
// one-space indents, text as lists of lines — Jupyter's own writer, so diffs stay small.
// DOM-free and tested (notebook.test.ts).

import { isJsonMime, joinText, readOutput, setOwn } from "./nbformat";
import type { NbCell, NbOutput, Notebook } from "./types";

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Back to a list of lines, each keeping its "\n" (Jupyter's way of writing them). */
export function splitLines(text: string): string[] {
  return text ? text.split(/(?<=\n)/) : [];
}

let idCounter = 0;
/** A cell id (nbformat 4.5: letters, digits, - and _). */
export function newCellId(taken?: ReadonlySet<string>): string {
  for (;;) {
    const id = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}${(idCounter++).toString(36)}`;
    if (!taken?.has(id)) return id;
  }
}

/** A new notebook: one empty code cell, Python's kernelspec (Jupyter's default). */
export function emptyIpynb(): Notebook {
  return {
    cells: [
      {
        id: newCellId(),
        kind: "code",
        source: "",
        metadata: {},
        outputs: [],
        executionCount: null,
        extra: {},
      },
    ],
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" },
    },
    nbformat: 4,
    nbformatMinor: 5,
    extra: {},
  };
}

/**
 * Bare NaN / Infinity / -Infinity values (not JSON, but Python's json writes them) → null. Only
 * outside strings: a cell's source "print([1, NaN])" must stay as it is.
 */
export function nonFiniteToNull(text: string): string {
  let out = "";
  let from = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch !== "N" && ch !== "I" && ch !== "-") continue;
    const word = /^-?(?:NaN|Infinity)/.exec(text.slice(i, i + 9));
    if (word) {
      out += `${text.slice(from, i)}null`;
      i += word[0].length - 1;
      from = i + 1;
    }
  }
  return out + text.slice(from);
}

/** An .ipynb file's text → cells; an empty file is a new notebook. Throws when it isn't one. */
export function parseIpynb(text: string): Notebook {
  if (!text.trim()) return emptyIpynb();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    // Python's json writes NaN and Infinity (a DataFrame's values in an output): read as null.
    const lenient = nonFiniteToNull(text);
    if (lenient === text) throw err;
    raw = JSON.parse(lenient);
  }
  if (!isObject(raw) || !Array.isArray(raw.cells))
    throw new Error("This isn't a Jupyter notebook (it has no cells).");
  const { cells, metadata, nbformat, nbformat_minor, ...extra } = raw;
  if (typeof nbformat === "number" && nbformat < 4)
    throw new Error(`Notebook format ${nbformat} is too old: open and save it in Jupyter first.`);
  const taken = new Set<string>();
  const out: NbCell[] = [];
  for (const c of cells as unknown[]) {
    if (!isObject(c)) continue;
    const { id, cell_type, source, metadata: cellMeta, outputs, execution_count, ...rest } = c;
    const kind = cell_type === "markdown" ? "markdown" : cell_type === "raw" ? "raw" : "code";
    let cellId = typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : "";
    if (!cellId || taken.has(cellId)) cellId = newCellId(taken);
    taken.add(cellId);
    out.push({
      id: cellId,
      kind,
      source: joinText(source),
      metadata: isObject(cellMeta) ? cellMeta : {},
      outputs:
        kind === "code" && Array.isArray(outputs)
          ? outputs.map(readOutput).filter((o): o is NbOutput => o !== null)
          : [],
      executionCount: typeof execution_count === "number" ? execution_count : null,
      extra: rest,
    });
  }
  return {
    cells: out,
    metadata: isObject(metadata) ? metadata : {},
    nbformat: 4,
    nbformatMinor: typeof nbformat_minor === "number" ? nbformat_minor : 5,
    extra,
  };
}

function writeOutput(o: NbOutput): Record<string, unknown> {
  const out: Record<string, unknown> = { ...o };
  if (typeof o.text === "string") out.text = splitLines(o.text);
  if (isObject(o.data)) {
    const data: Record<string, unknown> = {};
    for (const [mime, value] of Object.entries(o.data))
      setOwn(
        data,
        mime,
        typeof value === "string" && !isJsonMime(mime) ? splitLines(value) : value,
      );
    out.data = data;
  }
  return out;
}

/** Keys sorted at every level, as Jupyter writes them (stable diffs). */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) setOwn(out, k, sortKeys(v[k]));
  return out;
}

/** Cells → nbformat 4 JSON, one-space indents, a newline at the end (Jupyter's own writer). */
export function serializeIpynb(nb: Notebook): string {
  // Notebooks of D203's extension kept the minor version among the extra fields.
  const {
    nbformat_minor: oldMinor,
    nbformat: _major,
    ...extra
  } = isObject(nb.extra) ? nb.extra : {};
  const minorRead =
    typeof oldMinor === "number"
      ? oldMinor
      : typeof nb.nbformatMinor === "number"
        ? nb.nbformatMinor
        : 5;
  // Cell ids need 4.5.
  const minor = Math.max(minorRead, 5);
  const json = {
    ...extra,
    cells: nb.cells.map((c) => {
      const base: Record<string, unknown> = {
        ...(isObject(c.extra) ? c.extra : {}),
        cell_type: c.kind,
        id: c.id,
        metadata: c.metadata || {},
        source: splitLines(c.source),
      };
      if (c.kind === "code") {
        base.execution_count = c.executionCount ?? null;
        base.outputs = (c.outputs || []).map(writeOutput);
      }
      return base;
    }),
    metadata: nb.metadata || {},
    nbformat: 4,
    nbformat_minor: minor,
  };
  return `${JSON.stringify(sortKeys(json), null, 1)}\n`;
}
