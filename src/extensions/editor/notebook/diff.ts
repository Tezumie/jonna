// Notebook diffs (D189): two versions of an .ipynb compared cell by cell — what source control,
// local history and the agent's proposals show for notebooks instead of the raw JSON (which is
// all ids, outputs and metadata). Cells are paired by id when both versions keep ids, else by
// their text; each pair shows its source's line changes, and whether its outputs or metadata
// changed. `diffNotebooks` is DOM-free and unit-tested; `notebookDiffElement` draws the result.
import { diffLines, splitLines } from "../../../core/diff/index";
import { h, on } from "../../../core/dom/index";
import type { NbCell, Notebook } from "./model";

export type CellChange = "same" | "modified" | "added" | "removed";

export interface CellDiff {
  change: CellChange;
  before?: NbCell;
  after?: NbCell;
  source: boolean;
  outputs: boolean;
  metadata: boolean;
}

export interface NotebookDiff {
  cells: CellDiff[];
  /** The notebook's own metadata (kernel, language) changed. */
  metadata: boolean;
  counts: Record<CellChange, number>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Outputs compared without what changes on every run of the same code (counts, timings). */
const outputKey = (c: NbCell) => JSON.stringify(c.outputs.map(({ execution_count: _, ...o }) => o));

function pair(a: NbCell | undefined, b: NbCell | undefined): CellDiff {
  if (!a) return { change: "added", after: b, source: true, outputs: false, metadata: false };
  if (!b) return { change: "removed", before: a, source: true, outputs: false, metadata: false };
  const source = a.source !== b.source || a.kind !== b.kind;
  const outputs = a.kind === "code" && b.kind === "code" && outputKey(a) !== outputKey(b);
  const metadata = !same(a.metadata, b.metadata);
  return {
    change: source || outputs || metadata ? "modified" : "same",
    before: a,
    after: b,
    source,
    outputs,
    metadata,
  };
}

/** Cells of `before` and `after` paired up, in `after`'s order (removed cells where they were). */
export function diffNotebooks(before: Notebook, after: Notebook): NotebookDiff {
  const a = before.cells;
  const b = after.cells;
  const out: CellDiff[] = [];
  const ids = new Set(a.map((c) => c.id));
  const shared = b.filter((c) => ids.has(c.id)).length;
  if (b.length && shared >= Math.ceil(Math.min(a.length, b.length) / 2)) {
    // By id: a cell kept its id through edits (nbformat 4.5).
    const byId = new Map(a.map((c) => [c.id, c]));
    const used = new Set<string>();
    let ai = 0;
    for (const cell of b) {
      const match = byId.get(cell.id);
      if (match) {
        // Cells of `before` that came before this one and aren't in `after`: removed here.
        const at = a.indexOf(match);
        for (; ai < at; ai++) {
          const gone = a[ai];
          if (gone && !used.has(gone.id) && !b.some((x) => x.id === gone.id))
            out.push(pair(gone, undefined));
        }
        ai = Math.max(ai, at + 1);
        used.add(match.id);
        out.push(pair(match, cell));
      } else {
        // Removed cells right here come first (a replaced cell reads removed, then added).
        while (ai < a.length) {
          const gone = a[ai];
          if (!gone || used.has(gone.id) || b.some((x) => x.id === gone.id)) break;
          out.push(pair(gone, undefined));
          ai++;
        }
        out.push(pair(undefined, cell));
      }
    }
    for (; ai < a.length; ai++) {
      const gone = a[ai];
      if (gone && !used.has(gone.id) && !b.some((x) => x.id === gone.id))
        out.push(pair(gone, undefined));
    }
  } else {
    // By text: the cells as lines of a diff; a changed run pairs its cells up in order.
    const key = (c: NbCell) => `${c.kind}\u0000${c.source.replace(/\n/g, "\u0001")}\n`;
    const changes = diffLines(a.map(key), b.map(key));
    let ia = 0;
    let ib = 0;
    const emitSame = (untilA: number) => {
      while (ia < untilA) out.push(pair(a[ia++], b[ib++]));
    };
    for (const ch of changes) {
      emitSame(ch.originalStart);
      const removed = a.slice(ch.originalStart, ch.originalEnd);
      const added = b.slice(ch.modifiedStart, ch.modifiedEnd);
      const n = Math.max(removed.length, added.length);
      for (let i = 0; i < n; i++) {
        const x = removed[i];
        const y = added[i];
        // Paired as one changed cell only when they're the same kind.
        if (x && y && x.kind === y.kind) out.push(pair(x, y));
        else {
          if (x) out.push(pair(x, undefined));
          if (y) out.push(pair(undefined, y));
        }
      }
      ia = ch.originalEnd;
      ib = ch.modifiedEnd;
    }
    emitSame(a.length);
  }
  const counts: Record<CellChange, number> = { same: 0, modified: 0, added: 0, removed: 0 };
  for (const c of out) counts[c.change]++;
  return {
    cells: out,
    metadata: !same(before.metadata, after.metadata),
    counts,
  };
}

/** One line of a cell's source diff: "+", "-" or " " and its text. */
export function sourceLines(
  before: string,
  after: string,
): { sign: "+" | "-" | " "; text: string }[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const out: { sign: "+" | "-" | " "; text: string }[] = [];
  const strip = (l: string) => l.replace(/\r?\n$/, "");
  let ia = 0;
  for (const ch of diffLines(a, b)) {
    while (ia < ch.originalStart) out.push({ sign: " ", text: strip(a[ia++] ?? "") });
    for (let i = ch.originalStart; i < ch.originalEnd; i++)
      out.push({ sign: "-", text: strip(a[i] ?? "") });
    for (let i = ch.modifiedStart; i < ch.modifiedEnd; i++)
      out.push({ sign: "+", text: strip(b[i] ?? "") });
    ia = ch.originalEnd;
  }
  while (ia < a.length) out.push({ sign: " ", text: strip(a[ia++] ?? "") });
  return out;
}

const LABEL: Record<CellChange, string> = {
  same: "Unchanged",
  modified: "Changed",
  added: "Added",
  removed: "Removed",
};

const outputSummary = (c: NbCell | undefined) => {
  if (c?.kind !== "code") return "";
  const n = c.outputs.length;
  return n ? `${n} output${n === 1 ? "" : "s"}` : "no outputs";
};

/** The diff drawn: a summary, then each cell (unchanged ones folded until shown). */
export function notebookDiffElement(diff: NotebookDiff, labels: { before: string; after: string }) {
  let showSame = false;
  const list = h("div", { class: "nbd-cells" });
  const draw = () => {
    list.replaceChildren(
      ...diff.cells.flatMap((c, i) => {
        if (c.change === "same" && !showSame) {
          const prev = diff.cells[i - 1];
          // One fold line per run of unchanged cells.
          if (prev?.change === "same") return [];
          let n = 0;
          for (let j = i; j < diff.cells.length && diff.cells[j]?.change === "same"; j++) n++;
          return [h("div", { class: "nbd-fold" }, `${n} unchanged cell${n === 1 ? "" : "s"}`)];
        }
        return [cellElement(c)];
      }),
    );
  };
  const { counts } = diff;
  const parts = [
    counts.modified && `${counts.modified} changed`,
    counts.added && `${counts.added} added`,
    counts.removed && `${counts.removed} removed`,
  ].filter(Boolean);
  const toggle = h(
    "button",
    { class: "button button-ghost button-sm", type: "button" },
    "Show unchanged cells",
  );
  on(toggle, "click", () => {
    showSame = !showSame;
    toggle.textContent = showSame ? "Hide unchanged cells" : "Show unchanged cells";
    draw();
  });
  draw();
  return h(
    "div",
    { class: "nbd" },
    h(
      "div",
      { class: "nbd-summary" },
      h(
        "span",
        null,
        parts.length ? `Cells: ${parts.join(", ")}` : "No cell changes",
        diff.metadata ? " · notebook metadata changed" : "",
      ),
      h("span", { class: "nbd-sides" }, `${labels.before} ↔ ${labels.after}`),
      counts.same ? toggle : null,
    ),
    list,
  );
}

function cellElement(c: CellDiff): HTMLElement {
  const cell = c.after ?? c.before;
  const kind = cell?.kind ?? "code";
  const notes = [
    c.change === "modified" && !c.source ? "source unchanged" : "",
    c.outputs ? `outputs changed (${outputSummary(c.before)} → ${outputSummary(c.after)})` : "",
    c.metadata ? "metadata changed" : "",
    c.before && c.after && c.before.kind !== c.after.kind
      ? `${c.before.kind} → ${c.after.kind}`
      : "",
  ].filter(Boolean);
  const lines =
    c.change === "added"
      ? (c.after?.source ?? "").split("\n").map((text) => ({ sign: "+" as const, text }))
      : c.change === "removed"
        ? (c.before?.source ?? "").split("\n").map((text) => ({ sign: "-" as const, text }))
        : sourceLines(c.before?.source ?? "", c.after?.source ?? "");
  return h(
    "div",
    { class: `nbd-cell is-${c.change}` },
    h(
      "div",
      { class: "nbd-cell-head" },
      h(
        "span",
        { class: "nbd-kind" },
        kind === "code" ? "Code" : kind === "markdown" ? "Markdown" : "Raw",
      ),
      h("span", { class: `nbd-change is-${c.change}` }, LABEL[c.change]),
      notes.length ? h("span", { class: "nbd-notes" }, notes.join(" · ")) : null,
    ),
    h(
      "pre",
      { class: "nbd-source" },
      ...lines.map((l) =>
        h(
          "div",
          { class: `nbd-line${l.sign === "+" ? " is-add" : l.sign === "-" ? " is-del" : ""}` },
          h("span", { class: "nbd-sign", "aria-hidden": "true" }, l.sign),
          l.text || " ",
        ),
      ),
    ),
  );
}
