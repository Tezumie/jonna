// The tree's parts that don't need the Tree class: keyboard navigation (treeKeys), selection
// (treeSelection) and sticky ancestor rows (treeSticky). Pure functions are unit-tested.
import { h, on } from "../core/dom/index";
import { type Disposable, DisposableStore, toDisposable } from "../core/lifecycle/index";

// Tree keyboard navigation (DESIGN.md §12.4), separate from Tree so the rules stay readable:
// ↑/↓/Home/End/PageUp/PageDown move (Shift extends the selection), →/← expand/collapse or go to
// the first child / the parent, Enter/Space toggle a folder or open a leaf.
export interface TreeKeyTarget<N> {
  readonly items: readonly N[];
  readonly active: number;
  readonly pageSize: number;
  isFolder(node: N): boolean;
  /** A row with children that Enter opens rather than toggles (a nest parent file, D201). */
  opensOnEnter?(node: N): boolean;
  isExpanded(node: N): boolean;
  /** The parent row, or null at the top level. */
  parent(node: N): N | null;
  toggle(node: N): void;
  select(node: N, range: boolean): void;
  open(node: N): void;
}

/** Handles `e` if it is a tree key; returns true when handled (caller prevents default). */
export function handleTreeKey<N>(e: KeyboardEvent, t: TreeKeyTarget<N>): boolean {
  const { items, active: index } = t;
  const node = items[index];
  const move = (to: number) => {
    const target = items[Math.max(0, Math.min(items.length - 1, to))];
    if (target !== undefined) t.select(target, e.shiftKey);
  };
  switch (e.key) {
    case "ArrowDown":
      move(index + 1);
      return true;
    case "ArrowUp":
      move(index < 0 ? 0 : index - 1);
      return true;
    case "Home":
      move(0);
      return true;
    case "End":
      move(items.length - 1);
      return true;
    case "PageDown":
      move(index + t.pageSize);
      return true;
    case "PageUp":
      move(index - t.pageSize);
      return true;
    case "ArrowRight":
      if (node !== undefined && t.isFolder(node)) {
        if (!t.isExpanded(node)) t.toggle(node);
        else move(index + 1);
      }
      return true;
    case "ArrowLeft": {
      if (node === undefined) return true;
      const parent = t.parent(node);
      if (t.isExpanded(node)) t.toggle(node);
      else if (parent !== null) move(items.indexOf(parent));
      return true;
    }
    case "Enter":
    case " ":
      if (node === undefined) return false;
      if (t.isFolder(node) && t.opensOnEnter?.(node) !== true) t.toggle(node);
      else t.open(node);
      return true;
    default:
      return false;
  }
}

// Selection for trees and lists (DESIGN.md §12.4): a set of selected ids, an anchor for
// Shift-ranges and the focused id (keyboard cursor). Click semantics follow the platform:
// plain click selects one, Ctrl/Cmd toggles, Shift extends from the anchor. DOM-free and tested.
export interface SelectModifiers {
  /** Ctrl on Windows/Linux, Cmd on macOS. */
  toggle?: boolean;
  range?: boolean;
}

export class TreeSelection {
  private ids = new Set<string>();
  private anchor: string | null = null;
  focused: string | null = null;

  get selected(): ReadonlySet<string> {
    return this.ids;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** Applies a click (or keyboard move) on `id`; `order` is the visible row order. */
  select(id: string, order: readonly string[], mods: SelectModifiers = {}): void {
    if (mods.range && this.anchor !== null) {
      const from = order.indexOf(this.anchor);
      const to = order.indexOf(id);
      if (from >= 0 && to >= 0) {
        const [a, b] = from <= to ? [from, to] : [to, from];
        const range = order.slice(a, b + 1);
        this.ids = mods.toggle ? new Set([...this.ids, ...range]) : new Set(range);
        this.focused = id;
        return;
      }
    }
    if (mods.toggle) {
      if (this.ids.has(id)) this.ids.delete(id);
      else this.ids.add(id);
    } else {
      this.ids = new Set([id]);
    }
    this.anchor = id;
    this.focused = id;
  }

  /** Moves the keyboard focus without changing the selection (Ctrl+↑/↓). */
  focus(id: string | null): void {
    this.focused = id;
  }

  clear(): void {
    this.ids.clear();
    this.anchor = null;
  }

  /** Drops ids that no longer exist. */
  retain(exists: (id: string) => boolean): void {
    this.ids = new Set([...this.ids].filter(exists));
    if (this.anchor !== null && !exists(this.anchor)) this.anchor = null;
    if (this.focused !== null && !exists(this.focused)) this.focused = null;
  }
}

// Sticky folder rows for trees (like VS Code's tree sticky scroll): while you scroll through a
// folder's contents, the folder (and its expanded ancestors) stay pinned at the top; the deepest
// one is pushed up as its contents end. Clicking a sticky row scrolls back to that folder and
// selects it; clicking its chevron collapses it. `computeSticky` is DOM-free and tested.
export interface StickyRow {
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

export interface StickyPlacement {
  /** Row index in the flat list. */
  index: number;
  /** Top offset inside the viewport, px. */
  top: number;
}

/**
 * The flat list of visible rows, read one at a time (an array works): a tree doesn't build a copy
 * of every row for each scroll frame (D233: a Graph commit with 1000+ files expanded).
 */
export interface StickyRowList {
  readonly length: number;
  at(index: number): StickyRow | undefined;
}

/**
 * The rows to pin for a scroll position. `rows` is the flat list of visible rows. Reads only
 * the rows near the top of the view and the ancestors above them.
 */
export function computeSticky(
  rows: StickyRowList,
  scrollTop: number,
  rowHeight: number,
  maxRows: number,
): StickyPlacement[] {
  const out: StickyPlacement[] = [];
  for (let level = 0; level < maxRows; level++) {
    // The row hidden behind this sticky slot.
    const under = Math.floor(scrollTop / rowHeight) + level;
    if (under >= rows.length) break;
    // Its ancestor at depth `level` (walk back to the nearest row of that depth).
    let a = under;
    while (a >= 0 && (rows.at(a)?.depth ?? 0) > level) a--;
    const ancestor = a >= 0 ? rows.at(a) : undefined;
    if (
      a < 0 ||
      !ancestor ||
      ancestor.depth !== level ||
      !ancestor.hasChildren ||
      !ancestor.expanded
    )
      break;
    // Already fully visible below the slot: nothing to pin.
    if (a * rowHeight >= scrollTop + level * rowHeight) break;
    // Where the folder's contents end: the next row at its depth or shallower. Past the row
    // under the next slot it makes no difference (the row sits in its slot either way), so a
    // long folder isn't walked to its end each frame.
    const enough = Math.min(rows.length, Math.ceil(scrollTop / rowHeight) + level + 2);
    let end = a + 1;
    while (end < enough && (rows.at(end)?.depth ?? 0) > level) end++;
    if (end - 1 === a) break;
    const top = Math.min(level * rowHeight, end * rowHeight - scrollTop - rowHeight);
    out.push({ index: a, top });
    if (top < level * rowHeight) break; // being pushed out: nothing deeper sticks
  }
  return out;
}

export interface StickyHost {
  rows(): StickyRowList;
  scrollTop(): number;
  rowHeight(): number;
  viewportHeight(): number;
  render(index: number, row: HTMLElement): void;
  reveal(index: number, top: number): void;
  collapse(index: number): void;
  contextMenu(index: number, x: number, y: number): void;
}

/** The overlay element; call `update()` after every list render. */
export class StickyRows implements Disposable {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private placed: StickyPlacement[] = [];

  constructor(
    container: HTMLElement,
    private readonly host: StickyHost,
    private readonly maxRows = 5,
  ) {
    this.element = h("div", { class: "tree-sticky", "aria-hidden": "true" });
    container.prepend(this.element);
    this.store.add(toDisposable(() => this.element.remove()));
    this.store.add(
      on(this.element, "mousedown", (e) => {
        const row = eventClosest(e, ".tree-sticky-row");
        const at = row ? Number(row.dataset.slot) : -1;
        const p = this.placed[at];
        if (!p || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (eventClosest(e, ".icon-chevron-down")) this.host.collapse(p.index);
        else this.host.reveal(p.index, at);
      }),
    );
    this.store.add(
      on(this.element, "contextmenu", (e) => {
        const row = eventClosest(e, ".tree-sticky-row");
        const p = row ? this.placed[Number(row.dataset.slot)] : undefined;
        if (!p) return;
        e.preventDefault();
        e.stopPropagation();
        this.host.contextMenu(p.index, e.clientX, e.clientY);
      }),
    );
  }

  update(): void {
    const h_ = this.host.rowHeight();
    // Keep at most ~40% of the viewport for pinned rows.
    const max = Math.max(
      0,
      Math.min(this.maxRows, Math.floor((this.host.viewportHeight() * 0.4) / h_)),
    );
    this.placed = computeSticky(this.host.rows(), this.host.scrollTop(), h_, max);
    const els = Array.from(this.element.children) as HTMLElement[];
    while (els.length > this.placed.length) els.pop()?.remove();
    this.placed.forEach((p, slot) => {
      let row = els[slot];
      if (!row) {
        row = h("div", { class: "vlist-row tree-row tree-sticky-row" });
        this.element.appendChild(row);
      }
      row.dataset.slot = String(slot);
      row.style.transform = `translateY(${p.top}px)`;
      row.style.height = `${h_}px`;
      row.style.zIndex = String(this.maxRows - slot);
      this.host.render(p.index, row);
    });
    this.element.classList.toggle("has-rows", this.placed.length > 0);
  }

  dispose(): void {
    this.store.dispose();
  }
}

/**
 * The first element on the event's dispatch path matching `selector`. Unlike
 * `target.closest`, it still works when an earlier listener re-rendered (detached) the target.
 */
export function eventClosest(e: Event, selector: string): HTMLElement | null {
  for (const node of e.composedPath())
    if (node instanceof Element && node.matches(selector)) return node as HTMLElement;
  return null;
}
