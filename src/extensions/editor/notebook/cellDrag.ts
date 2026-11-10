// Dragging cells by their left edge (the gutter: VS Code's drag handle). Dragging one of several
// selected cells moves all of them, in their order, as one block (VS Code's multi-cell drag); a
// cell that isn't selected moves alone. The drop runs `notebook.moveCellsTo` (one undo step), so
// the drag is the same command keys and agents use. Escape cancels. The gap math is
// `core/notebook/selection.ts` (`dropGapAt`, `dropSelected`), tested.
import { h, on } from "../../../core/dom/index";
import { DisposableStore } from "../../../core/lifecycle/index";
import { dropGapAt } from "../../../core/notebook/selection";
import type { CellView } from "./cell";

/** How far the pointer moves (px) before a press on the gutter becomes a drag. */
const THRESHOLD = 4;
/** Near the list's top or bottom edge (px), a drag scrolls it. */
const SCROLL_EDGE = 32;
const SCROLL_STEP = 16;

export interface CellDragDeps {
  cells(): readonly CellView[];
  /** The selected cells' indexes, ascending. */
  selected(): readonly number[];
  run(command: string, input: Record<string, unknown>): void;
}

interface Drag {
  pointerId: number;
  startY: number;
  from: number;
  /** Set once the pointer passed THRESHOLD. */
  moving: CellView[] | null;
  gap: number;
  /** The window listeners and the drop line, for this drag only. */
  store: DisposableStore;
}

export class CellDrag {
  private readonly store = new DisposableStore();
  private drag: Drag | null = null;
  private readonly line = h("div", { class: "nb-drop-line", hidden: true });

  constructor(
    private readonly list: HTMLElement,
    private readonly deps: CellDragDeps,
  ) {
    this.store.add(on(list, "pointerdown", (e) => this.onDown(e)));
    this.store.add({ dispose: () => this.end(false) });
  }

  /** The drag handle: a cell's gutter, not its run button. */
  static isHandle(target: Element): boolean {
    return !!target.closest(".nb-gutter") && !target.closest("button");
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || this.drag) return;
    const target = e.target as Element;
    if (!CellDrag.isHandle(target)) return;
    const el = target.closest<HTMLElement>(".nb-cell");
    const from = this.deps.cells().findIndex((c) => c.element === el);
    if (from < 0) return;
    const store = new DisposableStore();
    const drag: Drag = {
      pointerId: e.pointerId,
      startY: e.clientY,
      from,
      moving: null,
      gap: from,
      store,
    };
    this.drag = drag;
    store.add(
      on(window, "pointermove", (m) => {
        if (m.pointerId !== drag.pointerId) return;
        if (!drag.moving) {
          if (Math.abs(m.clientY - drag.startY) < THRESHOLD) return;
          this.start(drag);
        }
        this.track(drag, m.clientY);
      }),
    );
    store.add(
      on(window, "pointerup", (u) => {
        if (u.pointerId === drag.pointerId) this.end(true);
      }),
    );
    store.add(
      on(window, "pointercancel", (u) => {
        if (u.pointerId === drag.pointerId) this.end(false);
      }),
    );
    store.add(
      on(
        window,
        "keydown",
        (k) => {
          if (k.key !== "Escape" || !drag.moving) return;
          k.preventDefault();
          k.stopPropagation();
          this.end(false);
        },
        { capture: true },
      ),
    );
  }

  private start(drag: Drag): void {
    const cells = this.deps.cells();
    const selected = this.deps.selected();
    const indexes = selected.length > 1 && selected.includes(drag.from) ? selected : [drag.from];
    drag.moving = indexes.flatMap((i) => cells[i] ?? []);
    for (const c of drag.moving) c.element.classList.add("is-dragging");
    this.list.classList.add("is-dragging-cells");
    // Text the press began selecting while it wasn't a drag yet.
    window.getSelection()?.removeAllRanges();
    this.list.append(this.line);
    drag.store.add({ dispose: () => this.line.remove() });
  }

  private track(drag: Drag, y: number): void {
    const box = this.list.getBoundingClientRect();
    if (y < box.top + SCROLL_EDGE) this.list.scrollTop -= SCROLL_STEP;
    else if (y > box.bottom - SCROLL_EDGE) this.list.scrollTop += SCROLL_STEP;
    const rects = this.deps.cells().map((c) => c.element.getBoundingClientRect());
    drag.gap = dropGapAt(
      rects.map((r) => r.top + r.height / 2),
      y,
    );
    const below = rects[drag.gap];
    const above = rects[drag.gap - 1];
    // In the gap between two cells (their margin), else just above the first / below the last.
    const at =
      below && above
        ? (above.bottom + below.top) / 2
        : below
          ? below.top - 2
          : (above?.bottom ?? 0) + 2;
    this.line.style.top = `${at - box.top + this.list.scrollTop}px`;
    this.line.hidden = false;
  }

  private end(drop: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    drag.store.dispose();
    this.line.hidden = true;
    this.list.classList.remove("is-dragging-cells");
    const cells = this.deps.cells();
    if (!drag.moving) {
      // A click on a selected cell's gutter among several: that cell alone (the press kept the
      // selection so a drag could take all of it).
      const selected = this.deps.selected();
      const id = cells[drag.from]?.cell.id;
      if (drop && id && selected.length > 1 && selected.includes(drag.from))
        this.deps.run("notebook.selectCells", { cellId: id });
      return;
    }
    for (const c of drag.moving) c.element.classList.remove("is-dragging");
    if (!drop) return;
    const cellIds = drag.moving.filter((c) => cells.includes(c)).map((c) => c.cell.id);
    if (cellIds.length) this.deps.run("notebook.moveCellsTo", { cellIds, before: drag.gap });
  }

  dispose(): void {
    this.store.dispose();
  }
}
