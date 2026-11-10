// read_file's view of a Jupyter notebook (D310, after Claude Code's): each cell as
// `<cell id="…">` with its source and its text outputs (images and HTML named, not shown; each
// cell's outputs capped), paged by cells. And PDF page ranges ("1-5", "3") for read_file's
// `pages`. DOM-free.

/** Characters of a cell's outputs shown at most. */
export const CELL_OUTPUT_CHARS = 2000;
/** Characters of one read at most (the rest with offset, by cell). */
const NOTEBOOK_READ_CHARS = 48_000;

export interface NotebookCell {
  id: string;
  type: string;
  source: string;
  execution: number | null;
  outputs: string;
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");

const joined = (v: unknown): string =>
  Array.isArray(v)
    ? v.filter((x) => typeof x === "string").join("")
    : typeof v === "string"
      ? v
      : "";

/** One output as text: streams and plain text as they are, an error's traceback, media named. */
function outputText(o: unknown): string {
  if (!o || typeof o !== "object") return "";
  const out = o as Record<string, unknown>;
  if (out.output_type === "stream") return joined(out.text);
  if (out.output_type === "error") {
    const trace = joined(
      Array.isArray(out.traceback) ? (out.traceback as unknown[]).join("\n") : "",
    );
    return (trace || `${String(out.ename ?? "Error")}: ${String(out.evalue ?? "")}`).replace(
      ANSI,
      "",
    );
  }
  const data = (out.data && typeof out.data === "object" ? out.data : {}) as Record<
    string,
    unknown
  >;
  const parts: string[] = [];
  const types = Object.keys(data);
  for (const t of types.filter((t) => t.startsWith("image/")))
    parts.push(`[${t} output: an image, not shown here]`);
  if ("text/plain" in data) parts.push(joined(data["text/plain"]));
  else if ("text/markdown" in data) parts.push(joined(data["text/markdown"]));
  else if ("application/json" in data) parts.push(JSON.stringify(data["application/json"]));
  else if ("text/html" in data) parts.push("[text/html output, not shown here]");
  return parts.join("\n");
}

/** A notebook's cells, or why it can't be read as one. */
export function notebookCells(json: string): NotebookCell[] | { error: string } {
  let nb: unknown;
  try {
    nb = JSON.parse(json);
  } catch (err) {
    return { error: `it isn't valid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
  const cells = (nb as { cells?: unknown })?.cells;
  if (!Array.isArray(cells)) return { error: "it has no cells list (not a Jupyter notebook?)" };
  return cells.map((c, i) => {
    const cell = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
    const outputs = Array.isArray(cell.outputs)
      ? cell.outputs
          .map((o) => outputText(o).replace(/\n+$/, ""))
          .filter(Boolean)
          .join("\n")
      : "";
    return {
      // nbformat 4.5 cells have ids; older ones are named by their place.
      id: typeof cell.id === "string" && cell.id ? cell.id : `cell-${i + 1}`,
      type: typeof cell.cell_type === "string" ? cell.cell_type : "code",
      source: joined(cell.source),
      execution: typeof cell.execution_count === "number" ? cell.execution_count : null,
      outputs:
        outputs.length > CELL_OUTPUT_CHARS
          ? `${outputs.slice(0, CELL_OUTPUT_CHARS)}\n… [${outputs.length - CELL_OUTPUT_CHARS} more characters of output]`
          : outputs,
    };
  });
}

/** One cell as read_file shows it. */
export function cellText(cell: NotebookCell): string {
  const attrs = `id="${cell.id}" type="${cell.type}"${cell.execution !== null ? ` execution="${cell.execution}"` : ""}`;
  const output = cell.outputs ? `\n<output>\n${cell.outputs}\n</output>` : "";
  return `<cell ${attrs}>\n${cell.source}${output}\n</cell>`;
}

/**
 * The notebook as read_file returns it: cells from `offset` (1-based), `limit` of them at most,
 * cut at a cell once the read is long; a line saying where the rest starts.
 */
export function notebookRead(
  name: string,
  cells: readonly NotebookCell[],
  offset: number,
  limit: number,
): { text: string; shown: number } | { error: string } {
  const from = Math.max(1, offset);
  if (cells.length && from > cells.length)
    return { error: `${name} has ${cells.length} cells; offset ${from} is past its end.` };
  const out: string[] = [];
  let chars = 0;
  for (const cell of cells.slice(from - 1, from - 1 + Math.max(1, limit))) {
    const text = cellText(cell);
    if (out.length && chars + text.length > NOTEBOOK_READ_CHARS) break;
    out.push(text);
    chars += text.length + 1;
  }
  const next = from + out.length;
  const more =
    next <= cells.length
      ? `\n… ${cells.length - next + 1} more cells (offset ${next}; offset and limit count cells here)`
      : "";
  const head = `${name} (Jupyter notebook, ${cells.length} cells${from > 1 || more ? `; cells ${from}-${next - 1}` : ""})`;
  return { text: `${head}\n${out.join("\n") || "(no cells)"}${more}`, shown: out.length };
}

/** Pages read_file takes in one call. */
export const MAX_PDF_PAGES = 20;
/** A PDF longer than this is read 10 pages at a time unless `pages` says which. */
export const PDF_PAGES_UNASKED = 10;

/** The 1-based pages a `pages` argument names ("1-5", "3", "2,4-6"), checked against `total`. */
export function pageRange(spec: unknown, total: number): number[] | { error: string } {
  const text =
    typeof spec === "number" ? String(spec) : typeof spec === "string" ? spec.trim() : "";
  const bad = { error: `pages "${String(spec)}" isn't a page range like "1-5" or "3".` };
  if (!text) return bad;
  const pages = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)?\s*)?$/.exec(part);
    if (!m) return bad;
    const a = Number(m[1]);
    const b = m[2] !== undefined ? Number(m[2]) : part.includes("-") ? total : a;
    if (a < 1 || b < a) return bad;
    if (a > total)
      return {
        error: `the PDF has ${total} page${total === 1 ? "" : "s"}; page ${a} isn't there.`,
      };
    for (let p = a; p <= Math.min(b, total); p++) {
      pages.add(p);
      if (pages.size > MAX_PDF_PAGES)
        return {
          error: `pages "${text}" is more than ${MAX_PDF_PAGES} pages: read at most ${MAX_PDF_PAGES} per call.`,
        };
    }
  }
  return [...pages].sort((x, y) => x - y);
}

/** "1-3, 7" for pages [1, 2, 3, 7]. */
export function pagesLabel(pages: readonly number[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < pages.length) {
    let j = i;
    while (j + 1 < pages.length && (pages[j + 1] ?? 0) === (pages[j] ?? 0) + 1) j++;
    parts.push(i === j ? `${pages[i]}` : `${pages[i]}-${pages[j]}`);
    i = j + 1;
  }
  return parts.join(", ");
}
