// The one virtualization primitive (PLAN §5): fixed-height rows, only visible rows in the DOM,
// row elements recycled while scrolling. Used by Tree, the palette, and future result lists.
import { h, on } from "../core/dom/index";
import { Emitter } from "../core/events/index";
import { type Disposable, DisposableStore, toDisposable } from "../core/lifecycle/index";

export interface VirtualListOptions<T> {
  rowHeight: number;
  /** Fills a (recycled) row element for `item`. Called again when the row is reused. */
  renderRow(item: T, row: HTMLElement, index: number): void;
  /** ARIA role of the list ("listbox", "tree") and of rows ("option", "treeitem"). */
  role: "listbox" | "tree";
  rowRole: "option" | "treeitem";
  ariaLabel: string;
  /** Extra rows rendered above/below the viewport. */
  overscan?: number;
  /**
   * Room below the last row (px), so it can scroll up off the bottom edge (VS Code's lists:
   * one row in the explorer). None while the list is empty.
   */
  paddingBottom?: number;
  /**
   * The element that keeps focus while the rows are browsed (a quick input's text box): the
   * active row is announced through its `aria-activedescendant` (default: the list itself).
   */
  activeDescendantHost?: HTMLElement;
}

export class VirtualList<T> implements Disposable {
  readonly element: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly rows = new Map<number, HTMLElement>();
  private readonly pool: HTMLElement[] = [];
  private data: readonly T[] = [];
  private activeIndex = -1;
  private frame = 0;
  private viewportHeight = 0;
  private readonly clicked = this.store.add(
    new Emitter<{ index: number; item: T; event: MouseEvent }>(),
  );
  /** Row clicks (mouse). Keyboard handling belongs to the owner (Tree, QuickInput). */
  readonly onDidClickRow = this.clicked.event;
  private readonly rendered = this.store.add(new Emitter<void>());
  /** After every render (scroll, items, resize): overlays such as sticky rows follow. */
  readonly onDidRender = this.rendered.event;
  private readonly idPrefix = `vl-${Math.random().toString(36).slice(2, 8)}`;

  constructor(
    host: HTMLElement,
    private readonly options: VirtualListOptions<T>,
  ) {
    this.spacer = h("div", { class: "vlist-spacer" });
    this.element = h(
      "div",
      { class: "vlist", role: options.role, "aria-label": options.ariaLabel, tabindex: 0 },
      this.spacer,
    );
    host.appendChild(this.element);
    this.store.add(toDisposable(() => this.element.remove()));
    this.store.add(on(this.element, "scroll", () => this.schedule(), { passive: true }));
    this.store.add(
      on(this.element, "mousedown", (event) => {
        const index = this.indexFromEvent(event);
        const item = index >= 0 ? this.data[index] : undefined;
        if (item === undefined) return;
        // Handle focus ourselves: the click handler may re-render the clicked row, and the
        // browser's default focus for a now-detached target would land on <body>.
        event.preventDefault();
        if (this.element.tabIndex >= 0) this.focus();
        this.clicked.fire({ index, item, event });
      }),
    );
    const observer = new ResizeObserver(() => {
      this.viewportHeight = this.element.clientHeight;
      this.schedule();
    });
    observer.observe(this.element);
    this.store.add(toDisposable(() => observer.disconnect()));
    this.store.add(toDisposable(() => cancelAnimationFrame(this.frame)));
  }

  get items(): readonly T[] {
    return this.data;
  }

  get active(): number {
    return this.activeIndex;
  }

  setItems(items: readonly T[]): void {
    this.data = items;
    const room = items.length ? (this.options.paddingBottom ?? 0) : 0;
    this.spacer.style.height = `${items.length * this.options.rowHeight + room}px`;
    if (this.activeIndex >= items.length) this.activeIndex = items.length - 1;
    this.renderNow(true);
  }

  /** Marks one row active (keyboard cursor) and scrolls it into view. */
  setActive(index: number): void {
    this.activeIndex = Math.max(-1, Math.min(index, this.data.length - 1));
    const host = this.options.activeDescendantHost ?? this.element;
    if (this.activeIndex >= 0) {
      host.setAttribute("aria-activedescendant", `${this.idPrefix}-${this.activeIndex}`);
      this.reveal(this.activeIndex);
    } else {
      host.removeAttribute("aria-activedescendant");
    }
    this.renderNow(true);
  }

  reveal(index: number): void {
    const top = index * this.options.rowHeight;
    const bottom = top + this.options.rowHeight;
    const height = this.element.clientHeight;
    if (height === 0) return; // not laid out yet; nothing sensible to scroll to
    if (top < this.element.scrollTop) this.element.scrollTop = top;
    else if (bottom > this.element.scrollTop + height) this.element.scrollTop = bottom - height;
  }

  /** Re-renders visible rows (call after items changed in place). */
  refresh(): void {
    this.renderNow(true);
  }

  /** Rows that fit in the viewport (for PageUp/PageDown). */
  get pageSize(): number {
    return Math.max(1, Math.floor(this.element.clientHeight / this.options.rowHeight));
  }

  focus(): void {
    this.element.focus({ preventScroll: true });
  }

  private indexFromEvent(event: MouseEvent): number {
    const row = (event.target as Element | null)?.closest?.(".vlist-row");
    if (!(row instanceof HTMLElement) || !this.element.contains(row)) return -1;
    return Number(row.dataset.index ?? -1);
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderNow(false);
    });
  }

  private renderNow(force: boolean): void {
    const { rowHeight, overscan = 6 } = this.options;
    const height = this.viewportHeight || this.element.clientHeight;
    const first = Math.max(0, Math.floor(this.element.scrollTop / rowHeight) - overscan);
    const last = Math.min(
      this.data.length - 1,
      Math.ceil((this.element.scrollTop + height) / rowHeight) + overscan,
    );

    for (const [index, row] of this.rows) {
      if (index < first || index > last) {
        this.rows.delete(index);
        row.remove();
        this.pool.push(row);
      }
    }
    for (let index = first; index <= last; index++) {
      const item = this.data[index] as T;
      let row = this.rows.get(index);
      const isNew = !row;
      if (!row) {
        row = this.pool.pop() ?? h("div", { class: "vlist-row", role: this.options.rowRole });
        this.rows.set(index, row);
        this.element.appendChild(row);
      }
      if (isNew || force) {
        row.dataset.index = String(index);
        row.id = `${this.idPrefix}-${index}`;
        row.style.transform = `translateY(${index * rowHeight}px)`;
        row.style.height = `${rowHeight}px`;
        row.classList.toggle("is-active", index === this.activeIndex);
        row.setAttribute("aria-selected", String(index === this.activeIndex));
        this.options.renderRow(item, row, index);
      }
    }
    this.rendered.fire();
  }

  get rowHeight(): number {
    return this.options.rowHeight;
  }

  get scrollTop(): number {
    return this.element.scrollTop;
  }

  /** Scrolls so row `index` sits `offset` px below the top of the viewport. */
  scrollRowTo(index: number, offset = 0): void {
    this.element.scrollTop = Math.max(0, index * this.options.rowHeight - offset);
  }

  dispose(): void {
    this.store.dispose();
  }
}
