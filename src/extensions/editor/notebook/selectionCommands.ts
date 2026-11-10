// Several cells at once (D209, VS Code's multi-cell selection): selecting them (Shift+click,
// Ctrl / Cmd+click, Shift+Up / Down, Ctrl+A in command mode), joining the selected cells, and the
// operations the cell commands (index.ts) use when more than one cell is selected: moving them as
// a block, changing their type. Each is one undo step.
import {
  collapsed,
  dropSelected,
  extendTo,
  joinSelected,
  moveSelected,
  selectAll,
  toggle,
} from "../../../core/notebook/selection";
import { s } from "../../../core/schema/index";
import type { WorkbenchServices } from "../../../workbench/services";
import type { CellKind } from "./model";
import type { NotebookView } from "./view";

type Register = WorkbenchServices["dispatcher"]["register"];
type Target = (path?: string) => Promise<NotebookView>;

/** The `cellIds` input the cell commands take for several cells. */
export const cellIdsInput = s
  .array(s.string(), { maxItems: 10_000 })
  .describe("Several cells' ids (default: the selected cells, or `cellId` / `index`)")
  .optional();

/**
 * The cells a command acts on: `cellIds`, else `cellId` / `index`, else the selection (the focused
 * cell alone unless several are selected). Ascending.
 */
export function targetCells(
  view: NotebookView,
  input: { cellId?: string; index?: number; cellIds?: string[] },
): number[] {
  if (input.cellIds?.length) {
    const found = input.cellIds.map((id) => {
      const i = view.indexOf(id);
      if (i < 0) throw new Error(`No cell ${id} (ide://notebook lists them).`);
      return i;
    });
    return [...new Set(found)].sort((a, b) => a - b);
  }
  if (input.cellId !== undefined || input.index !== undefined) {
    const i = input.index ?? view.indexOf(input.cellId);
    if (i < 0 || i >= view.cells.length)
      throw new Error(`No cell ${input.cellId ?? input.index} (it has ${view.cells.length}).`);
    return [i];
  }
  return view.selectedIndexes();
}

/** Moves the cells by `by` places as a block (each step past an unselected neighbour). */
export function moveCells(view: NotebookView, indexes: number[], by: number): boolean {
  let picked = indexes;
  let order = view.cells.map((_, k) => k);
  let moved = false;
  for (let step = 0; step < Math.abs(by); step++) {
    const r = moveSelected(order.length, picked, by < 0 ? -1 : 1);
    if (!r) break;
    order = r.order.map((k) => order[k] ?? k);
    picked = r.selected;
    moved = true;
  }
  if (!moved) return false;
  view.snapshot();
  const focusCell = view.cells[view.selected];
  view.reorder(order);
  const focus = focusCell ? view.cells.indexOf(focusCell) : (picked[0] ?? 0);
  view.setSelection({ focus, anchor: picked[0] ?? focus, selected: picked });
  view.markDirty();
  return true;
}

/** Moves the cells as a block to the gap before cell `before` (drag and drop); one undo step. */
export function moveCellsTo(view: NotebookView, indexes: number[], before: number): boolean {
  const r = dropSelected(view.cells.length, indexes, before);
  if (!r) return false;
  view.snapshot();
  const focusCell = view.cells[view.selected];
  view.reorder(r.order);
  const focusAt = focusCell ? view.cells.indexOf(focusCell) : -1;
  const focus = r.selected.includes(focusAt) ? focusAt : (r.selected[0] ?? 0);
  view.setSelection({ focus, anchor: r.selected[0] ?? focus, selected: r.selected });
  view.markDirty();
  return true;
}

/** Makes the cells code, Markdown or raw (one undo step); they stay selected. */
export function setKinds(view: NotebookView, indexes: number[], kind: CellKind): void {
  const change = indexes.filter((i) => view.cells[i] && view.cells[i]?.cell.kind !== kind);
  if (!change.length) return;
  const sel = view.cellSelection;
  view.snapshot();
  for (const i of change) view.setKind(i, kind, false);
  view.setSelection(indexes.length > 1 ? { ...sel, selected: indexes } : sel);
}

export function registerSelectionCommands(register: Register, target: Target): void {
  register({
    id: "notebook.selectCells",
    title: "Select cells",
    description:
      "Selects notebook cells (VS Code's multi-cell selection): `cellIds` (the first is focused), or one cell (`cellId` / `index`) — with `extend: range` from the anchor to it (Shift+click), `extend: toggle` added or taken out (Ctrl / Cmd+click); `by: 1 / -1` extends from the focused cell down / up (Shift+Down / Up); `all`: every cell (Ctrl+A). Commands like runCell, deleteCell, moveCell, copyCell, changeCellType then act on the selection. Returns the selected ids.",
    input: s.object({
      path: s.string().describe("The notebook (default: the active one)").optional(),
      cellId: s.string().describe("A cell's id").optional(),
      index: s.integer({ min: 0 }).describe("A cell's position, from 0").optional(),
      cellIds: s.array(s.string(), { maxItems: 10_000 }).optional(),
      extend: s.enum(["range", "toggle"]).optional(),
      by: s.integer({ min: -1000, max: 1000 }).optional(),
      move: s
        .integer({ min: -1000, max: 1000 })
        .describe("Moves the focus this many cells and selects that one alone (J / K)")
        .optional(),
      all: s.boolean().optional(),
    }),
    effects: [],
    agent: "discoverable",
    run: async (input) => {
      const view = await target(input.path);
      const count = view.cells.length;
      const sel = view.cellSelection;
      if (input.all) view.setSelection(selectAll(sel, count));
      else if (input.move !== undefined)
        view.select(Math.max(0, Math.min(count - 1, sel.focus + input.move)));
      else if (input.cellIds?.length) {
        const picked = targetCells(view, { cellIds: input.cellIds });
        const first = view.indexOf(input.cellIds[0]);
        view.setSelection({ focus: first, anchor: first, selected: picked });
      } else if (input.by !== undefined && input.cellId === undefined && input.index === undefined)
        view.setSelection(extendTo(sel, sel.focus + input.by, count));
      else {
        const [i = sel.focus] = targetCells(view, input);
        view.setSelection(
          input.extend === "range"
            ? extendTo(sel, i, count)
            : input.extend === "toggle"
              ? toggle(sel, i, count)
              : collapsed(i, count),
        );
      }
      const now = view.cellSelection;
      return {
        focus: view.cells[now.focus]?.cell.id ?? null,
        selected: now.selected.map((i) => view.cells[i]?.cell.id),
      };
    },
  });
  register({
    id: "notebook.moveCellsTo",
    title: "Move cells to",
    description:
      "Moves a cell (`cellId` / `index`), the selected cells or `cellIds` as one block, in their order, to the gap before the cell now at `before` (from 0; the cell count = the end): what dragging cells by their left edge does. They stay selected. One undo step. Returns whether anything moved and the cells' new positions.",
    input: s.object({
      path: s.string().describe("The notebook (default: the active one)").optional(),
      cellId: s.string().describe("A cell's id").optional(),
      index: s.integer({ min: 0 }).describe("A cell's position, from 0").optional(),
      cellIds: cellIdsInput,
      before: s
        .integer({ min: 0 })
        .describe(
          "The position (now, from 0) of the cell they go before; the cell count = the end",
        ),
    }),
    effects: ["write"],
    agent: "discoverable",
    run: async (input) => {
      const view = await target(input.path);
      const moved = moveCellsTo(view, targetCells(view, input), input.before);
      return { moved, selected: view.selectedIndexes() };
    },
  });
  register({
    id: "notebook.joinSelectedCells",
    title: "Join selected cells",
    description:
      "Joins the selected cells (or `cellIds`) into the first: their text, one newline between; the others go. They must be the same kind (VS Code's Join selected cells). One undo step.",
    input: s.object({
      path: s.string().describe("The notebook (default: the active one)").optional(),
      cellIds: cellIdsInput,
    }),
    effects: ["write"],
    agent: "discoverable",
    run: async (input) => {
      const view = await target(input.path);
      const picked = targetCells(view, input);
      const plan = joinSelected(
        view.cells.map((c) => ({ kind: c.cell.kind, source: c.cell.source })),
        picked,
      );
      if ("error" in plan) throw new Error(plan.error);
      const top = view.cells[plan.into];
      if (!top) throw new Error("No cell.");
      view.snapshot([top.cell.id]);
      top.setSource(plan.source);
      if (top.cell.kind === "code") {
        top.cell.outputs = [];
        top.cell.executionCount = null;
        top.setRunState("idle");
        top.renderOutputs();
      }
      view.deleteCells(plan.remove, false);
      view.select(plan.into, false);
      return { cellId: top.cell.id, joined: picked.length, cells: view.cells.length };
    },
  });
}
