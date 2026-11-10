// Lazy, virtualized tree over VirtualList. Children load on first expand; only expanded nodes are
// flattened into rows. Keyboard: ↑/↓ move, →/← expand/collapse (or move to child/parent),
// Enter/Space open, Home/End/PageUp/PageDown jump, Shift extends the selection. Selection is a set
// (Ctrl/Cmd+click, Shift+click); the focused row is the keyboard cursor (DESIGN.md §12.4).
// Single click on a leaf opens a preview, double-click or Enter opens it for good.
import { on } from "../core/dom/index";
import { Emitter } from "../core/events/index";
import { type Disposable, DisposableStore } from "../core/lifecycle/index";
import { findMatches, nextMatch, TypeAhead, typeAheadIndex } from "./treeFind";
import { eventClosest, handleTreeKey, StickyRows, TreeSelection } from "./treeParts";
import { VirtualList } from "./VirtualList";

export interface TreeDataSource<T> {
  id(item: T): string;
  hasChildren(item: T): boolean;
  children(item: T): Promise<T[]>;
  /** The row's text, for type-ahead and find (D200); without it neither works. */
  label?(item: T): string;
  /**
   * An item with children that opens like a leaf (a file with nested files, D201): a click opens
   * it and only its chevron (an element with `data-tree-twistie`) toggles; Enter opens it. Its
   * children are read again whenever its parent's are (they come from the parent's listing).
   */
  opensWithChildren?(item: T): boolean;
  /** Whether an item shows expanded the first time it's listed (default collapsed). */
  startsExpanded?(item: T): boolean;
}

export interface TreeRowRenderer<T> {
  /** Fills `row` (cleared by the caller is NOT done; replace its children). */
  render(
    item: T,
    row: HTMLElement,
    info: { depth: number; expanded: boolean; loading: boolean },
  ): void;
}

interface Node<T> {
  item: T;
  depth: number;
  parent: Node<T> | null;
  children: Node<T>[] | null; // null = not loaded
  expanded: boolean;
  loading: boolean;
  /** Its last listing failed (a folder deleted meanwhile): listed again when it reappears. */
  failed?: boolean;
  /** It's a parent of its own listing (a nest parent) since it was last updated. */
  becameParent?: boolean;
}

export { eventClosest };

export class Tree<T> implements Disposable {
  private readonly store = new DisposableStore();
  private readonly list: VirtualList<Node<T>>;
  /** Invisible root (the workspace folder); its children are the top-level rows. */
  private root: Node<T> | null = null;
  /**
   * The rows a setRoot still loading was asked to expand: a newer setRoot that takes over expands
   * them too (they may have been handed over once, like a section's new groups, D233).
   */
  private expandAsked: readonly string[] = [];
  private readonly nodes = new Map<string, Node<T>>();
  private readonly sel = new TreeSelection();
  private readonly opened = this.store.add(
    new Emitter<{ item: T; preserveFocus: boolean; preview: boolean }>(),
  );
  private readonly expansionChanged = this.store.add(new Emitter<void>());
  private readonly contextMenu = this.store.add(
    new Emitter<{ item: T | null; x: number; y: number }>(),
  );
  private readonly selectionChanged = this.store.add(new Emitter<T | null>());
  private lastClick = { id: "", time: 0 };
  private readonly typeAhead = new TypeAhead();
  /** The find widget's query and mode (D200): matching rows are highlighted, or the only ones. */
  private find: { query: string; filter: boolean } | null = null;
  /**
   * Leaves open on release, not press, so dragging a row (e.g. a file onto the dock) doesn't also
   * open it where it was. Moving more than a few pixels cancels the open.
   */
  private openOnRelease(item: T, down: MouseEvent): void {
    const pending = new DisposableStore();
    this.store.add(pending);
    const done = () => this.store.delete(pending);
    pending.add(
      on(window, "mousemove", (e) => {
        if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) >= 4) done();
      }),
    );
    pending.add(
      on(window, "mouseup", () => {
        done();
        this.opened.fire({ item, preserveFocus: true, preview: true });
      }),
    );
  }

  /** Leaf activated: single click (preview, preserveFocus), double-click or Enter. */
  readonly onDidOpen = this.opened.event;
  readonly onDidChangeExpansion = this.expansionChanged.event;
  readonly onContextMenu = this.contextMenu.event;
  readonly onDidChangeSelection = this.selectionChanged.event;

  constructor(
    host: HTMLElement,
    private readonly source: TreeDataSource<T>,
    private readonly renderer: TreeRowRenderer<T>,
    options: {
      rowHeight: number;
      ariaLabel: string;
      sticky?: boolean;
      /** Room past the last row (px); one row by default, like VS Code's trees. */
      paddingBottom?: number;
    },
  ) {
    this.list = this.store.add(
      new VirtualList<Node<T>>(host, {
        rowHeight: options.rowHeight,
        paddingBottom: options.paddingBottom ?? options.rowHeight,
        role: "tree",
        rowRole: "treeitem",
        ariaLabel: options.ariaLabel,
        renderRow: (node, row) => this.renderRow(node, row),
      }),
    );
    this.store.add(
      this.list.onDidClickRow(({ item: node, event }) => {
        if (event.button !== 0) return;
        const toggle = event.ctrlKey || event.metaKey;
        this.select(node, { toggle, range: event.shiftKey });
        if (toggle || event.shiftKey) return;
        const id = this.source.id(node.item);
        const double = this.lastClick.id === id && event.timeStamp - this.lastClick.time < 500;
        this.lastClick = { id, time: event.timeStamp };
        if (this.opensLikeLeaf(node.item)) {
          const twistie = (event.target as Element | null)?.closest?.("[data-tree-twistie]");
          if (twistie) void this.toggle(node);
          else if (double)
            this.opened.fire({ item: node.item, preserveFocus: false, preview: false });
          else this.openOnRelease(node.item, event);
        } else if (this.source.hasChildren(node.item)) {
          if (!double) void this.toggle(node);
        } else if (double) {
          this.opened.fire({ item: node.item, preserveFocus: false, preview: false });
        } else {
          this.openOnRelease(node.item, event);
        }
      }),
    );
    this.store.add(on(this.list.element, "keydown", (e) => this.onKey(e)));
    if (options.sticky) {
      const list = this.list;
      const sticky = this.store.add(
        new StickyRows(list.element, {
          // Read row by row: no copy of every row per scroll frame (D233).
          rows: () => {
            const items = list.items;
            return {
              length: items.length,
              at: (i) => {
                const n = items[i];
                return n
                  ? {
                      depth: n.depth,
                      hasChildren: this.source.hasChildren(n.item),
                      expanded: n.expanded,
                    }
                  : undefined;
              },
            };
          },
          scrollTop: () => list.scrollTop,
          rowHeight: () => list.rowHeight,
          viewportHeight: () => list.element.clientHeight,
          render: (index, row) => {
            const node = list.items[index];
            if (node) this.renderRow(node, row);
          },
          reveal: (index, slot) => {
            const node = list.items[index];
            if (!node) return;
            list.scrollRowTo(index, slot * list.rowHeight);
            this.select(node);
            list.focus();
          },
          collapse: (index) => {
            const node = list.items[index];
            if (!node) return;
            void this.toggle(node).then(() => {
              const at = list.items.indexOf(node);
              if (at >= 0 && at * list.rowHeight < list.scrollTop)
                list.scrollRowTo(at, node.depth * list.rowHeight);
            });
          },
          contextMenu: (index, x, y) => {
            const node = list.items[index];
            if (!node) return;
            if (!this.sel.has(this.source.id(node.item))) this.select(node);
            this.contextMenu.fire({ item: node.item, x, y });
          },
        }),
      );
      this.store.add(list.onDidRender(() => sticky.update()));
    }
    this.store.add(
      on(this.list.element, "contextmenu", (e) => {
        e.preventDefault();
        // The event's path, not target.closest: the mousedown before it may have re-rendered the
        // row, leaving the target detached (a right-click on a name gave the root's menu, D226).
        const row = eventClosest(e, ".vlist-row");
        // The row's own index, else the row geometrically under the pointer: anything else that
        // caught the click (an overlay, a row between renders) must not turn a right-click on a
        // file into the root's menu (D211). Below the last row stays "no item".
        const own = row instanceof HTMLElement ? Number(row.dataset.index) : Number.NaN;
        const index = Number.isInteger(own) && this.list.items[own] ? own : this.indexAt(e.clientY);
        const node = this.list.items[index];
        // Right-click inside the selection keeps it (acts on all); elsewhere selects that row.
        if (node && !this.sel.has(this.source.id(node.item))) this.select(node);
        // Below the rows: nothing is selected, so the menu acts on the root (VS Code).
        if (!node) this.clearSelection();
        this.contextMenu.fire({ item: node?.item ?? null, x: e.clientX, y: e.clientY });
      }),
    );
    // A click on empty space below the rows clears the selection (VS Code), so New file and New
    // folder go to the root again. Not on the scrollbar.
    this.store.add(
      on(this.list.element, "mousedown", (e) => {
        // By the event's path: the list's own mousedown handler runs first and may re-render the
        // clicked row, detaching the target (Ctrl+click cleared the selection, D226).
        if (e.button !== 0 || eventClosest(e, ".vlist-row, .tree-sticky-row")) return;
        const el = this.list.element;
        const box = el.getBoundingClientRect();
        if (e.clientX - box.left >= el.clientWidth) return;
        this.clearSelection();
      }),
    );
  }

  get element(): HTMLElement {
    return this.list.element;
  }

  /** The row at a viewport y (by geometry), or -1 below the last row or above the list. */
  private indexAt(clientY: number): number {
    const box = this.list.element.getBoundingClientRect();
    const y = clientY - box.top + this.list.scrollTop;
    if (y < 0) return -1;
    const index = Math.floor(y / this.list.rowHeight);
    return index < this.list.items.length ? index : -1;
  }

  private opensLikeLeaf(item: T): boolean {
    return this.source.hasChildren(item) && this.source.opensWithChildren?.(item) === true;
  }

  /** Sets the (invisible) root and loads its children. Pass null to clear. */
  async setRoot(item: T | null, expandedIds: readonly string[] = []): Promise<void> {
    this.nodes.clear();
    this.sel.clear();
    this.sel.focus(null);
    const root = item === null ? null : this.createNode(item, null);
    this.root = root;
    const asked = [...new Set([...this.expandAsked, ...expandedIds])];
    this.expandAsked = asked;
    if (root) {
      root.expanded = true;
      await this.loadChildren(root);
      // Restore expansion level by level (D379): the folders found so far load together, then
      // the ones they brought in; one at a time was a round trip per folder.
      let pending = [...asked];
      while (pending.length) {
        // A newer setRoot (a folder switch, the next debug stop) took over: it expands and renders.
        if (this.root !== root) return;
        const ready = pending.filter((id) => this.nodes.has(id));
        if (!ready.length) break;
        pending = pending.filter((id) => !this.nodes.has(id));
        const load = ready
          .map((id) => this.nodes.get(id))
          .filter((n): n is Node<T> => !!n && this.source.hasChildren(n.item) && !n.expanded);
        for (const n of load) n.expanded = true;
        await Promise.all(load.map((n) => this.loadChildren(n)));
      }
      if (this.root !== root) return;
    }
    this.expandAsked = [];
    this.render();
    this.expansionChanged.fire();
  }

  /** The primary selected item: the focused row if selected, else any selected one. */
  get selection(): T | null {
    const focused = this.sel.focused;
    const id = focused && this.sel.has(focused) ? focused : ([...this.sel.selected][0] ?? null);
    return id ? (this.nodes.get(id)?.item ?? null) : null;
  }

  /** Every selected item, in row order. */
  selectedItems(): T[] {
    return this.list.items.filter((n) => this.sel.has(this.source.id(n.item))).map((n) => n.item);
  }

  /** Re-renders visible rows (decorations such as "cut" changed). */
  rerender(): void {
    this.list.refresh();
  }

  /** The item whose row contains `el`, if any (drag and drop). */
  itemAt(el: Element | null): T | undefined {
    const row = el?.closest?.(".vlist-row");
    const index = row instanceof HTMLElement ? Number(row.dataset.index) : -1;
    return this.list.items[index]?.item;
  }

  /**
   * The item whose row is at client point (x, y), by geometry — works while a drag sets
   * `pointer-events: none` everywhere (elementFromPoint can't see the rows then). Null: inside
   * the tree but below the last row; undefined: outside the tree.
   */
  itemAtPoint(x: number, y: number): T | null | undefined {
    const box = this.list.element.getBoundingClientRect();
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) return undefined;
    const index = Math.floor((y - box.top + this.list.scrollTop) / this.list.rowHeight);
    return this.list.items[index]?.item ?? null;
  }

  isExpanded(id: string): boolean {
    return this.nodes.get(id)?.expanded ?? false;
  }

  /** Ids of expanded nodes whose ancestors are all expanded (what's visible). */
  expandedIds(): string[] {
    const ids: string[] = [];
    const visit = (nodes: Node<T>[]) => {
      for (const n of nodes) {
        if (n.expanded) {
          ids.push(this.source.id(n.item));
          if (n.children) visit(n.children);
        }
      }
    };
    visit(this.root?.children ?? []);
    return ids;
  }

  /** Whether the item with `id` is loaded (its parent's listing includes it). */
  has(id: string): boolean {
    return this.nodes.has(id);
  }

  async expand(id: string): Promise<void> {
    const node = this.nodes.get(id);
    if (node && this.source.hasChildren(node.item) && !node.expanded) await this.toggle(node);
  }

  /**
   * Expands several at once with one render (streamed search results: one render per file was
   * quadratic in the number of results).
   */
  async expandMany(ids: readonly string[]): Promise<void> {
    const nodes = ids
      .map((id) => this.nodes.get(id))
      .filter((n): n is Node<T> => !!n && this.source.hasChildren(n.item) && !n.expanded);
    if (!nodes.length) return;
    for (const n of nodes) n.expanded = true;
    await Promise.all(nodes.filter((n) => n.children === null).map((n) => this.loadChildren(n)));
    this.render();
    this.expansionChanged.fire();
  }

  collapseAll(): void {
    for (const node of this.nodes.values()) if (node !== this.root) node.expanded = false;
    this.render();
    this.expansionChanged.fire();
  }

  /**
   * Reloads the children of `id` (or of every loaded node when omitted), keeping expansion of
   * descendants that still exist.
   */
  async refresh(id?: string | ((item: T) => boolean)): Promise<void> {
    // A predicate reloads only the loaded nodes it takes (a search's folders while results
    // stream in, not every file's matches again).
    const targets =
      typeof id === "string"
        ? [this.nodes.get(id)].filter((n): n is Node<T> => !!n)
        : typeof id === "function"
          ? [...this.nodes.values()].filter((n) => n === this.root || id(n.item))
          : [...this.nodes.values()];
    await Promise.all(targets.filter((n) => n.children !== null).map((n) => this.loadChildren(n)));
    this.render();
  }

  /** Reloads several nodes' children together, then renders once (D379). */
  async refreshMany(ids: Iterable<string>): Promise<void> {
    const targets = [...new Set(ids)]
      .map((id) => this.nodes.get(id))
      .filter((n): n is Node<T> => !!n && n.children !== null);
    await Promise.all(targets.map((n) => this.loadChildren(n)));
    this.render();
  }

  /** Selects nothing. */
  clearSelection(): void {
    if (!this.sel.selected.size) return;
    this.sel.clear();
    this.list.setActive(-1);
    this.render();
    this.selectionChanged.fire(null);
  }

  /** Selects the item with `id` if it is loaded, and scrolls to it. */
  reveal(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    if (!(this.sel.selected.size === 1 && this.sel.has(id))) this.select(node);
    const index = this.list.items.indexOf(node);
    if (index >= 0) this.list.reveal(index);
  }

  focus(): void {
    this.list.focus();
    if (this.list.active < 0 && this.list.items.length > 0) this.list.setActive(0);
  }

  private createNode(item: T, parent: Node<T> | null): Node<T> {
    const id = this.source.id(item);
    const previous = this.nodes.get(id);
    // Keep the node object: a parallel refresh may be loading its children right now, and a copy
    // would keep the stale list (rows missing until the next refresh).
    if (previous) {
      previous.item = item;
      previous.parent = parent;
      previous.depth = parent ? parent.depth + 1 : -1;
      // A row that just became a parent of its own listing (nesting turned on, D201) starts
      // expanded like a new one would; one that stopped being one forgets it.
      const parentNow = this.source.opensWithChildren?.(item) === true;
      if (parentNow && !previous.becameParent && previous.children === null)
        previous.expanded = parent !== null && this.source.startsExpanded?.(item) === true;
      previous.becameParent = parentNow;
      return previous;
    }
    const node: Node<T> = {
      item,
      depth: parent ? parent.depth + 1 : -1,
      parent,
      children: null,
      expanded: parent !== null && this.source.startsExpanded?.(item) === true,
      loading: false,
      becameParent: this.source.opensWithChildren?.(item) === true,
    };
    this.nodes.set(id, node);
    return node;
  }

  private async loadChildren(node: Node<T>): Promise<void> {
    node.loading = true;
    try {
      const items = await this.source.children(node.item);
      // The tree was given a new root meanwhile: this listing is of the old one. Taking it in
      // would put the old items into the new tree's nodes (same ids: an outline's, a debug
      // scope's) and leave the old folder's nodes in the map.
      if (!this.attached(node)) return;
      const oldIds = new Set((node.children ?? []).map((c) => this.source.id(c.item)));
      node.children = items.map((item) => this.createNode(item, node));
      node.failed = false;
      // Forget nodes that disappeared (and their subtrees); not one that moved under another
      // parent meanwhile (a nested file whose nest parent went away is listed in the folder).
      const newIds = new Set(items.map((i) => this.source.id(i)));
      for (const oldId of oldIds)
        if (!newIds.has(oldId) && this.nodes.get(oldId)?.parent === node) this.forget(oldId);
      // Children that come from this listing (nested files) follow it, and show at once when
      // they start expanded; one that has none any more drops the old ones.
      for (const c of node.children)
        if (
          this.source.opensWithChildren &&
          c.children !== null &&
          !this.source.hasChildren(c.item)
        ) {
          for (const child of c.children)
            if (child.parent === c) this.forget(this.source.id(child.item));
          c.children = null;
          c.expanded = false;
        }
      await Promise.all(
        node.children
          .filter(
            (c) =>
              !c.loading &&
              this.source.opensWithChildren?.(c.item) === true &&
              (c.children !== null || c.expanded),
          )
          .map((c) => this.loadChildren(c)),
      );
      // A child that couldn't be listed (it was gone for a moment — deleted, then restored by
      // undo) is listed again now that it's back, instead of staying empty.
      await Promise.all(
        node.children
          .filter((c) => c.failed && c.expanded && !c.loading)
          .map((c) => this.loadChildren(c)),
      );
    } catch (err) {
      console.warn("Tree: failed to load children", err);
      node.children = [];
      node.failed = true;
    } finally {
      node.loading = false;
    }
  }

  /** Whether `node` is in the current tree (its ancestors lead to the current root). */
  private attached(node: Node<T>): boolean {
    let at = node;
    // Bounded: a source that lists an ancestor's id under itself mustn't hang the walk.
    for (let steps = 0; at.parent && steps <= this.nodes.size; steps++) at = at.parent;
    return at === this.root;
  }

  private forget(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    this.nodes.delete(id);
    for (const child of node.children ?? [])
      if (child.parent === node) this.forget(this.source.id(child.item));
    this.sel.retain((x) => x !== id);
  }

  private async toggle(node: Node<T>): Promise<void> {
    node.expanded = !node.expanded;
    if (node.expanded && node.children === null) {
      this.render();
      await this.loadChildren(node);
    }
    this.render();
    this.expansionChanged.fire();
  }

  private select(node: Node<T>, mods: { toggle?: boolean; range?: boolean } = {}): void {
    const order = this.list.items.map((n) => this.source.id(n.item));
    this.sel.select(this.source.id(node.item), order, mods);
    this.list.setActive(this.list.items.indexOf(node));
    this.selectionChanged.fire(node.item);
  }

  private render(): void {
    const rows: Node<T>[] = [];
    const filter = this.find?.filter && this.find.query ? this.find.query : null;
    // Filtering keeps a row that matches or has a matching row shown below it (its folders).
    const visit = (nodes: Node<T>[]): boolean => {
      let any = false;
      for (const n of nodes) {
        const at = rows.length;
        rows.push(n);
        const below =
          n.expanded &&
          n.children &&
          (!this.source.opensWithChildren || this.source.hasChildren(n.item))
            ? visit(n.children)
            : false;
        if (filter && !below && !findMatches(this.labelOf(n), filter)) rows.length = at;
        else any = true;
      }
      return any;
    };
    visit(this.root?.children ?? []);
    this.list.setItems(rows);
    const focused = this.sel.focused ? this.nodes.get(this.sel.focused) : undefined;
    const index = focused ? rows.indexOf(focused) : -1;
    if (index !== this.list.active) this.list.setActive(index);
  }

  private renderRow(node: Node<T>, row: HTMLElement): void {
    const hasChildren = this.source.hasChildren(node.item);
    row.setAttribute("aria-level", String(node.depth + 1));
    if (hasChildren) row.setAttribute("aria-expanded", String(node.expanded));
    else row.removeAttribute("aria-expanded");
    row.style.setProperty("--depth", String(node.depth));
    this.renderer.render(node.item, row, {
      depth: node.depth,
      expanded: node.expanded,
      loading: node.loading,
    });
    const selected = this.sel.has(this.source.id(node.item));
    row.classList.add("tree-row");
    row.classList.toggle("is-selected", selected);
    row.setAttribute("aria-selected", String(selected));
    row.classList.toggle(
      "is-find-match",
      !!this.find?.query && findMatches(this.labelOf(node), this.find.query),
    );
  }

  private labelOf(node: Node<T>): string {
    return this.source.label?.(node.item) ?? "";
  }

  /**
   * The find widget's query (D200): matching rows (shown ones: expanded folders) are highlighted,
   * or with `filter` the only rows shown, with their folders. Null ends it.
   */
  setFind(query: string | null, filter = false): void {
    this.find = query === null ? null : { query, filter };
    this.render();
    this.list.refresh();
  }

  /** Selects the next (or previous) row matching the find query; false when none does. */
  findNext(backwards = false, fromCurrent = false): boolean {
    const query = this.find?.query;
    if (!query) return false;
    const rows = this.list.items;
    // From the current row itself (as you type: a row that still matches stays selected).
    const active = this.list.active;
    const start =
      active < 0 ? (backwards ? 0 : -1) : fromCurrent ? active + (backwards ? 1 : -1) : active;
    const at = nextMatch(
      rows.map((n) => this.labelOf(n)),
      start,
      query,
      backwards,
    );
    const node = rows[at];
    if (!node) return false;
    this.select(node);
    return true;
  }

  /** How many shown rows match the find query. */
  findCount(): number {
    const query = this.find?.query;
    return query ? this.list.items.filter((n) => findMatches(this.labelOf(n), query)).length : 0;
  }

  private onKey(e: KeyboardEvent): void {
    // Escape clears the selection (VS Code's lists), unless something else wants it.
    if (e.key === "Escape" && !e.defaultPrevented && this.sel.selected.size) {
      e.preventDefault();
      this.clearSelection();
      return;
    }
    // Type-ahead (D200): a printable key jumps to the next row starting with what was typed.
    if (
      this.source.label &&
      e.key.length === 1 &&
      e.key !== " " &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      const prefix = this.typeAhead.push(e.key, e.timeStamp || Date.now());
      const rows = this.list.items;
      const at = typeAheadIndex(
        rows.map((n) => this.labelOf(n)),
        this.list.active,
        prefix,
      );
      const node = rows[at];
      if (node) this.select(node);
      e.preventDefault();
      return;
    }
    const handled = handleTreeKey<Node<T>>(e, {
      items: this.list.items,
      active: this.list.active,
      pageSize: this.list.pageSize,
      isFolder: (n) => this.source.hasChildren(n.item),
      opensOnEnter: (n) => this.opensLikeLeaf(n.item),
      isExpanded: (n) => n.expanded,
      parent: (n) => (n.parent && n.parent !== this.root ? n.parent : null),
      toggle: (n) => void this.toggle(n),
      select: (n, range) => this.select(n, { range }),
      open: (n) => this.opened.fire({ item: n.item, preserveFocus: false, preview: false }),
    });
    if (handled) e.preventDefault();
  }

  dispose(): void {
    this.store.dispose();
  }
}
