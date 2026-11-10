// A tree view whose rows come from an extension (`ide.ui.registerTreeView`, D102). Children are
// asked for when a row expands; clicking a row runs its command as the extension. Shown in the
// sidebar or as a dock tab, depending on the view's location. D208: buttons on a row shown on
// hover (`actions`, each a command) and a message line above the rows (`setMessage`). A row's
// context menu and its inline buttons come from `menus["view/item/context"]` (core/extensions/
// treeMenus.ts), shown on right-click / Shift+F10 and on hover.
import { h, on, replaceChildren } from "../../core/dom/index";
import type { TreeItem } from "../../core/extensions/rpc";
import { DisposableStore } from "../../core/lifecycle/index";
import { icon, knownIcon } from "../../ui/Icon";
import { type MenuItem, showContextMenu } from "../../ui/Menu";

/** Icon names the sprite has (an unknown name from an extension falls back to a dot). */
export const safeIcon = knownIcon;

import { setTooltip } from "../../ui/Tooltip";
import { Tree } from "../../ui/Tree";

/**
 * Rows the host builds itself (an extension's source control and file system sections, D233):
 * a letter after the name in a theme color (a token name), struck through or faded names.
 */
export type HostTreeItem = TreeItem & {
  badge?: string;
  badgeColor?: string;
  struck?: boolean;
  faded?: boolean;
};

type Node = { root: true } | { root?: false; item: HostTreeItem };

export interface TreeSource {
  /** The extension's rows under `parent` (top level when undefined). */
  children(parent?: TreeItem): Promise<TreeItem[]>;
  /** Runs a row's command. */
  run(command: { id: string; input?: unknown }): void;
  /** Whether the extension has registered a provider for this view yet. */
  ready(): boolean;
  /** Rows to expand on the next refresh (a host-built section's new groups, D233). */
  expand?(): readonly string[];
  /** A row's `view/item/context` menu: buttons on the row and context menu groups. */
  menu?(item: TreeItem): { inline: TreeAction[]; groups: TreeAction[][] };
  /** Rows can be dragged onto rows of the view (the extension handles drops). */
  canDrop?(): boolean;
  /** Rows dropped on `target` (undefined: below the rows). */
  drop?(target: TreeItem | undefined, sources: TreeItem[]): void;
  /** A row's checkbox was clicked. */
  check?(item: TreeItem, checked: boolean): void;
  /** The selected rows changed (D258). */
  selected?(items: TreeItem[]): void;
  /** A row was expanded or collapsed. */
  expanded?(item: TreeItem, expanded: boolean): void;
  /** A row's image (`iconPath`, D258): a URL the page can show, or null. */
  image?(item: TreeItem): Promise<string | null>;
}

/** VS Code's TreeItemCheckboxState (Unchecked 0, Checked 1), names or a boolean. */
export function isChecked(state: TreeItem["checkboxState"]): boolean | undefined {
  if (state === undefined || state === null) return undefined;
  return state === true || state === 1 || state === "checked";
}

/** A row button or menu item (an inline menu item may have no icon). */
type TreeAction = { icon?: string; title: string; command: { id: string; input?: unknown } };

export class ExtensionTreeView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly tree: Tree<Node>;
  private readonly empty: HTMLElement;
  private readonly message: HTMLElement;
  /** The rows loaded so far, by id (what an expansion reports). */
  private readonly known = new Map<string, TreeItem>();

  constructor(
    private readonly source: TreeSource,
    title: string,
  ) {
    const host = h("div", { class: "ext-tree" });
    this.empty = h("div", { class: "empty-state", hidden: true });
    this.message = h("div", { class: "ext-tree-message", hidden: true });
    this.element = h("div", { class: "ext-tree-view" }, this.message, this.empty, host);
    this.tree = this.store.add(
      new Tree<Node>(
        host,
        {
          id: (n) => (n.root ? "" : n.item.id),
          hasChildren: (n) => n.root === true || n.item.collapsible === true,
          children: async (n) => {
            const items = await this.source
              .children(n.root ? undefined : n.item)
              .catch((err: unknown) => {
                if (n.root) this.showEmpty(err instanceof Error ? err.message : String(err));
                return [];
              });
            if (n.root && items.length) this.empty.hidden = true;
            if (
              n.root &&
              !items.length &&
              this.empty.hidden &&
              this.message.hidden &&
              this.source.ready()
            )
              this.showEmpty("Nothing to show.");
            const valid = items.filter(validItem);
            for (const item of valid) if (this.known.size < 20_000) this.known.set(item.id, item);
            return valid.map((item) => ({ item }));
          },
        },
        { render: (n, row, info) => this.render(n, row, info.expanded) },
        { rowHeight: 22, ariaLabel: title },
      ),
    );
    // Rows the user (or a reveal) expanded or collapsed: VS Code's onDidExpandElement /
    // onDidCollapseElement, not the loading of children (a refresh reloads them).
    let expanded = new Set(this.tree.expandedIds());
    this.store.add(
      this.tree.onDidChangeExpansion(() => {
        const now = new Set(this.tree.expandedIds());
        for (const id of now)
          if (id && !expanded.has(id)) {
            const item = this.known.get(id);
            if (item) this.source.expanded?.(item, true);
          }
        for (const id of expanded)
          if (id && !now.has(id)) {
            const item = this.known.get(id);
            if (item) this.source.expanded?.(item, false);
          }
        expanded = now;
      }),
    );
    this.store.add(
      this.tree.onDidChangeSelection(() =>
        this.source.selected?.(
          this.tree.selectedItems().flatMap((n) => (n.root ? [] : [n.item as TreeItem])),
        ),
      ),
    );
    this.store.add(
      this.tree.onDidOpen(({ item }) => {
        if (!item.root && item.item.command) this.source.run(item.item.command);
      }),
    );
    this.store.add(
      this.tree.onContextMenu(({ item, x, y }) => {
        if (!item || item.root || !this.source.menu) return;
        const groups = this.source.menu(item.item).groups.filter((g) => g.length);
        if (!groups.length) return;
        const items = groups.flatMap((g, i) =>
          g.map(
            (a, j): MenuItem => ({
              label: a.title,
              ...(a.icon && { icon: safeIcon(a.icon) }),
              separatorBefore: i > 0 && j === 0,
              run: () => this.source.run(a.command),
            }),
          ),
        );
        this.store.add(showContextMenu(x, y, items));
      }),
    );
    this.listenForDrops();
    void this.refresh();
  }

  /** Rows dragged within the view, when the extension takes drops (VS Code's tree drag and drop). */
  private listenForDrops(): void {
    let dragging: TreeItem[] | null = null;
    let over: HTMLElement | null = null;
    const list = this.tree.element;
    const mark = (row: HTMLElement | null, root: boolean) => {
      over?.classList.remove("is-drop-folder");
      over = row;
      row?.classList.add("is-drop-folder");
      list.classList.toggle("is-drop-root", root);
    };
    const targetOf = (e: DragEvent): Node | null | undefined =>
      this.tree.itemAt(e.target instanceof Element ? e.target : null) ??
      this.tree.itemAtPoint(e.clientX, e.clientY);
    this.store.add(
      on(list, "dragstart", (e) => {
        const node = this.tree.itemAt(e.target instanceof Element ? e.target : null);
        if (!node || node.root || !this.source.canDrop?.()) return;
        const selected = this.tree.selectedItems().flatMap((n) => (n.root ? [] : [n.item]));
        dragging = selected.some((i) => i.id === node.item.id) ? selected : [node.item];
        e.dataTransfer?.setData("text/plain", dragging.map((i) => i.label).join("\n"));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      }),
    );
    this.store.add(
      on(list, "dragover", (e) => {
        if (!dragging) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const node = targetOf(e);
        const row =
          e.target instanceof Element ? e.target.closest<HTMLElement>(".vlist-row") : null;
        mark(node && !node.root ? row : null, node === null);
      }),
    );
    this.store.add(
      on(list, "dragleave", (e) => {
        if (!(e.relatedTarget instanceof Node) || !list.contains(e.relatedTarget))
          mark(null, false);
      }),
    );
    const end = () => {
      dragging = null;
      mark(null, false);
    };
    this.store.add(
      on(list, "drop", (e) => {
        const sources = dragging;
        const node = targetOf(e);
        end();
        if (!sources || node === undefined) return;
        e.preventDefault();
        const target = node && !node.root ? node.item : undefined;
        if (target && sources.some((s) => s.id === target.id)) return;
        this.source.drop?.(target, sources);
      }),
    );
    this.store.add(on(list, "dragend", end));
  }

  private showEmpty(text: string): void {
    this.empty.textContent = text;
    this.empty.hidden = false;
  }

  /** A line above the rows (the extension's message: what's shown, or why nothing is). */
  setMessage(text: string): void {
    this.message.textContent = text;
    this.message.hidden = !text;
    if (text) this.empty.hidden = true;
  }

  /** The latest load of the rows (reveal waits for it: a view just shown is still loading). */
  private loading: Promise<void> = Promise.resolve();

  refresh(): Promise<void> {
    this.loading = this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    this.empty.hidden = true;
    await this.tree.setRoot({ root: true }, [
      ...this.tree.expandedIds(),
      ...(this.source.expand?.() ?? []),
    ]);
  }

  private render(n: Node, row: HTMLElement, expanded: boolean): void {
    if (n.root) return;
    const item = n.item;
    row.classList.add("ext-tree-row");
    row.dataset.item = item.id;
    row.classList.toggle("is-strong", item.strong === true);
    row.classList.toggle("is-struck", item.struck === true);
    row.classList.toggle("is-faded", item.faded === true);
    const color = item.badgeColor ? { color: `var(${item.badgeColor})` } : undefined;
    const chevron = item.collapsible
      ? icon(expanded ? "chevron-down" : "chevron-right")
      : h("span", { class: "ext-tree-spacer" });
    row.draggable = this.source.canDrop?.() === true;
    replaceChildren(
      row,
      chevron,
      ...this.checkbox(item),
      ...this.icon(item),
      h("span", { class: "ext-tree-label" }, item.label),
      ...(item.description ? [h("span", { class: "ext-tree-desc" }, item.description)] : []),
      ...this.rowActions(item),
      ...(item.badge ? [h("span", { class: "ext-tree-badge", style: color }, item.badge)] : []),
    );
    if (item.tooltip) setTooltip(row, item.tooltip, undefined, { ariaLabel: false });
  }

  /** The row's icon: an image of the extension's (D258), else one of the IDE's set. */
  private icon(item: HostTreeItem): Element[] {
    if ((item.iconPath || item.iconPathDark) && this.source.image) {
      const img = h("img", { class: "ext-tree-img", alt: "" });
      void this.source.image(item).then((url) => {
        if (url) img.src = url;
        else img.replaceWith(icon(safeIcon(item.icon, "circle-dot")));
      });
      return [img];
    }
    return item.icon ? [icon(safeIcon(item.icon))] : [];
  }

  /**
   * Shows a row (D258): its parents (`path`, top first) are expanded on the way; then it's
   * selected, expanded or focused as asked.
   */
  async reveal(
    path: readonly string[],
    options: { select?: boolean; focus?: boolean; expand?: boolean },
  ): Promise<void> {
    const id = path[path.length - 1];
    if (id === undefined) return;
    await this.loading.catch(() => {});
    for (const parent of path.slice(0, -1))
      if (this.tree.has(parent) && !this.tree.isExpanded(parent)) await this.tree.expand(parent);
    if (!this.tree.has(id)) return;
    if (options.select !== false) this.tree.reveal(id);
    if (options.expand) await this.tree.expand(id);
    if (options.focus) this.tree.focus();
  }

  /** A checkbox before the label (`checkboxState`); a click tells the extension. */
  private checkbox(item: HostTreeItem): HTMLElement[] {
    const checked = isChecked(item.checkboxState);
    if (checked === undefined) return [];
    const box = h("input", {
      type: "checkbox",
      class: "checkbox ext-tree-check",
      "aria-label": item.label,
      checked,
    });
    box.checked = checked;
    // The row reacts on mousedown (selection) and click (open): the box keeps them to itself.
    box.onmousedown = (e) => e.stopPropagation();
    box.onclick = (e) => e.stopPropagation();
    box.onchange = () => {
      // Shown at once (VS Code toggles it too); the extension may refresh with its own state.
      item.checkboxState = box.checked ? 1 : 0;
      this.source.check?.(item, box.checked);
    };
    return [box];
  }

  /** The row's inline menu items, then its own `actions` (4 at most). */
  private rowActions(item: TreeItem): HTMLElement[] {
    const inline = this.source.menu?.(item).inline ?? [];
    const list = [...inline, ...(item.actions ?? [])];
    return list.length ? [this.actions(list)] : [];
  }

  /** Hover buttons; each runs its command as the extension (the row isn't opened). */
  private actions(list: readonly TreeAction[]): HTMLElement {
    const buttons = list.slice(0, 4).flatMap((a) => {
      if (!a || typeof a.title !== "string" || typeof a.command?.id !== "string") return [];
      const b = h(
        "button",
        { class: "icon-button ext-tree-action", type: "button", "aria-label": a.title },
        icon(safeIcon(a.icon, "circle-dot")),
      );
      setTooltip(b, a.title);
      // The row reacts on mousedown (selection); the button keeps it to itself. The row is
      // re-rendered as a whole, so these handlers go with it.
      b.onmousedown = (e) => e.stopPropagation();
      b.onclick = (e) => {
        e.stopPropagation();
        this.source.run(a.command);
      };
      return [b];
    });
    return h("span", { class: "ext-tree-actions" }, ...buttons);
  }

  focus(): void {
    this.tree.element.focus();
  }

  dispose(): void {
    this.store.dispose();
  }
}

function validItem(item: unknown): item is TreeItem {
  const i = item as Partial<TreeItem> | null;
  return !!i && typeof i.id === "string" && typeof i.label === "string";
}
