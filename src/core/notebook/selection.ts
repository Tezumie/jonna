// Cell selection in a notebook (D209, VS Code's multi-cell selection), DOM-free and tested: the
// focused cell, the anchor a Shift+click or Shift+arrow extends from, and the selected cells
// (Ctrl / Cmd+click adds or removes one). Plus what "move", "join" and "paste" do with several.

export interface CellSelection {
  /** The cell with the keyboard focus (the toolbar and single-cell commands act on it). */
  readonly focus: number;
  /** Where a range selection starts (Shift+click / Shift+arrows extend from here). */
  readonly anchor: number;
  /** The selected cells, ascending, always including `focus`. */
  readonly selected: readonly number[];
}

const clamp = (i: number, count: number) => Math.max(0, Math.min(i, count - 1));

/** One cell selected. */
export function collapsed(i: number, count: number): CellSelection {
  const at = clamp(i, Math.max(1, count));
  return { focus: at, anchor: at, selected: [at] };
}

/** The cells from the anchor to `to` (Shift+click, Shift+Up / Down); the anchor stays. */
export function extendTo(sel: CellSelection, to: number, count: number): CellSelection {
  if (count <= 0) return collapsed(0, 1);
  const anchor = clamp(sel.anchor, count);
  const focus = clamp(to, count);
  const lo = Math.min(anchor, focus);
  const hi = Math.max(anchor, focus);
  return { focus, anchor, selected: Array.from({ length: hi - lo + 1 }, (_, k) => lo + k) };
}

/**
 * Ctrl / Cmd+click: adds the cell to the selection, or takes it out (the selection never ends up
 * empty: the last cell stays). The cell becomes the focus and the anchor.
 */
export function toggle(sel: CellSelection, i: number, count: number): CellSelection {
  if (count <= 0) return collapsed(0, 1);
  const at = clamp(i, count);
  const has = sel.selected.includes(at);
  if (has && sel.selected.length === 1) return sel;
  const selected = has
    ? sel.selected.filter((j) => j !== at)
    : [...sel.selected, at].sort((a, b) => a - b);
  const focus = has ? (selected.find((j) => j > at) ?? selected[selected.length - 1] ?? 0) : at;
  return { focus, anchor: focus, selected };
}

/** Every cell (Ctrl+A in command mode). */
export function selectAll(sel: CellSelection, count: number): CellSelection {
  if (count <= 0) return collapsed(0, 1);
  return {
    focus: clamp(sel.focus, count),
    anchor: 0,
    selected: Array.from({ length: count }, (_, k) => k),
  };
}

/** The selection kept to cells that exist (after cells were removed). */
export function clampSelection(sel: CellSelection, count: number): CellSelection {
  if (count <= 0) return collapsed(0, 1);
  const selected = [...new Set(sel.selected.filter((j) => j >= 0 && j < count))].sort(
    (a, b) => a - b,
  );
  const focus = clamp(sel.focus, count);
  if (!selected.includes(focus)) selected.push(focus);
  selected.sort((a, b) => a - b);
  return { focus, anchor: clamp(sel.anchor, count), selected };
}

/**
 * Moves the selected cells up (`delta: -1`) or down (`1`) by one, each past its unselected
 * neighbour (VS Code's Move cell up / down with several selected). Returns the new order as the
 * old indexes, and where the selected cells are now; null when a selected cell is already at the
 * edge it would move past (nothing moves, as in VS Code).
 */
export function moveSelected(
  count: number,
  selected: readonly number[],
  delta: -1 | 1,
): { order: number[]; selected: number[] } | null {
  const picked = [...new Set(selected)].filter((i) => i >= 0 && i < count).sort((a, b) => a - b);
  if (!picked.length) return null;
  if (delta < 0 && picked[0] === 0) return null;
  if (delta > 0 && picked[picked.length - 1] === count - 1) return null;
  const order = Array.from({ length: count }, (_, k) => k);
  const walk = delta < 0 ? picked : [...picked].reverse();
  for (const i of walk) {
    const pos = order.indexOf(i);
    const other = pos + delta;
    const swap = order[other];
    if (swap === undefined) continue;
    order[other] = i;
    order[pos] = swap;
  }
  return { order, selected: picked.map((i) => order.indexOf(i)).sort((a, b) => a - b) };
}

/**
 * What "Join selected cells" makes of them (VS Code's): the text of each, one newline between,
 * in the first cell. Cells of different kinds aren't joined (VS Code says so too).
 */
export function joinSelected(
  cells: readonly { kind: string; source: string }[],
  selected: readonly number[],
): { into: number; source: string; remove: number[] } | { error: string } {
  const picked = [...new Set(selected)]
    .filter((i) => i >= 0 && i < cells.length)
    .sort((a, b) => a - b);
  const first = picked[0];
  if (first === undefined || picked.length < 2)
    return { error: "Select two or more cells to join them." };
  const kind = cells[first]?.kind;
  if (!picked.every((i) => cells[i]?.kind === kind))
    return { error: "Cells of different kinds can't be joined." };
  return {
    into: first,
    source: picked.map((i) => cells[i]?.source ?? "").join("\n"),
    remove: picked.slice(1),
  };
}

/**
 * Drag and drop (VS Code's): the selected cells, in their order, go to the gap before cell
 * `before` (an old index; `count` = the end). Returns the new order as the old indexes and where
 * the moved cells are now; null when nothing would move (dropped onto or next to themselves as a
 * block already in place).
 */
export function dropSelected(
  count: number,
  selected: readonly number[],
  before: number,
): { order: number[]; selected: number[] } | null {
  const picked = [...new Set(selected)].filter((i) => i >= 0 && i < count).sort((a, b) => a - b);
  if (!picked.length) return null;
  const at = Math.max(0, Math.min(before, count));
  const moving = new Set(picked);
  const rest = Array.from({ length: count }, (_, k) => k).filter((k) => !moving.has(k));
  const insertAt = rest.filter((k) => k < at).length;
  const order = [...rest.slice(0, insertAt), ...picked, ...rest.slice(insertAt)];
  if (order.every((v, k) => v === k)) return null;
  return { order, selected: picked.map((_, k) => insertAt + k) };
}

/**
 * The gap a drag points at: before the first cell whose middle is below `y` (`mids`: each cell's
 * vertical middle, top to bottom; the end when none is).
 */
export function dropGapAt(mids: readonly number[], y: number): number {
  const i = mids.findIndex((m) => y < m);
  return i < 0 ? mids.length : i;
}
