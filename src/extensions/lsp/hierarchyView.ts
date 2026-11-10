// The `hierarchy` dock tab (VS Code's Call Hierarchy / Type Hierarchy view): a header naming
// what's shown ("Callers of f"), a lazy tree (each row's children are asked when it's expanded;
// the roots open expanded) and a toolbar button that switches direction. A click on a row opens
// where it points (a call site, else the symbol) in a preview; its chevron expands it. m7.12:
// Refresh in the toolbar, a row menu (Show hierarchy of this item, Go to definition, Copy path,
// Refresh) and a "Results may be outdated" bar once a file the tree points into changed. Every
// action is a command.
import { h, on, replaceChildren } from "../../core/dom/index";
import { Emitter } from "../../core/events/index";
import { DisposableStore } from "../../core/lifecycle/index";
import {
  type HierarchyNode,
  type HierarchySession,
  hierarchyTitle,
  nodeOrigin,
  nodeTarget,
  otherDirection,
  symbolKindName,
} from "../../core/lsp/hierarchy";
import { effect, type ReadonlySignal } from "../../core/reactive/index";
import { type IconName, icon } from "../../ui/Icon";
import { type MenuItem, showContextMenu } from "../../ui/Menu";
import { setTooltip } from "../../ui/Tooltip";
import { Tree } from "../../ui/Tree";
import type { DockView, DockViewDescriptor, TabAction } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import type { HierarchySource } from "./hierarchySource";

/** Where a hierarchy was asked for (Refresh asks there again): a file and a 1-based position. */
export interface HierarchyOrigin {
  path: string;
  line: number;
  column: number;
}

/**
 * What the tab shows; `version` changes when the direction or the session does (the tree starts
 * over).
 */
export interface ShownHierarchy {
  session: HierarchySession;
  server: string;
  /** The server that answered prepare (Refresh falls back to it). */
  source: HierarchySource;
  origin: HierarchyOrigin;
  version: number;
}

type Row = { kind: "root" } | { kind: "node"; node: HierarchyNode };

// A Map: a plain object would answer "constructor" with its prototype's.
const SYMBOL_ICONS = new Map<string, IconName>([
  ["class", "box"],
  ["struct", "box"],
  ["interface", "box"],
  ["enum", "box"],
  ["module", "braces"],
  ["namespace", "braces"],
  ["package", "braces"],
  ["object", "braces"],
  ["function", "square-function"],
  ["method", "square-function"],
  ["constructor", "square-function"],
  ["event", "square-function"],
  ["operator", "square-function"],
]);

/** The toolbar's switch: what pressing it shows next. */
const SWITCH: Record<string, { icon: IconName; title: string }> = {
  incoming: { icon: "arrow-down-to-dot", title: "Show incoming calls" },
  outgoing: { icon: "arrow-up-from-dot", title: "Show outgoing calls" },
  supertypes: { icon: "arrow-up", title: "Show supertypes" },
  subtypes: { icon: "arrow-down", title: "Show subtypes" },
};

export function hierarchyViewDescriptor(
  services: WorkbenchServices,
  shown: ReadonlySignal<ShownHierarchy | null>,
  stale: ReadonlySignal<boolean>,
  rel: (path: string) => string,
): DockViewDescriptor {
  return {
    type: "hierarchy",
    title: () => "Hierarchy",
    icon: () => "list-tree",
    singleton: true,
    defaultPlacement: "bottom",
    create: () => new HierarchyView(services, shown, stale, rel),
  };
}

class HierarchyView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly tree: Tree<Row>;
  private readonly header: HTMLElement;
  private readonly outdated: HTMLElement;
  private readonly body: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly changed = this.store.add(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  private current: ShownHierarchy | null = null;

  constructor(
    private readonly services: WorkbenchServices,
    shown: ReadonlySignal<ShownHierarchy | null>,
    stale: ReadonlySignal<boolean>,
    private readonly rel: (path: string) => string,
  ) {
    this.header = h("div", { class: "hierarchy-header" });
    const refresh = h(
      "button",
      { class: "button button-secondary button-sm", type: "button" },
      "Refresh",
    );
    this.store.add(on(refresh, "click", () => this.run("lsp.refreshHierarchy", {})));
    // VS Code's wording; the tree stays as it is until the user asks.
    this.outdated = h(
      "div",
      { class: "hierarchy-outdated", hidden: true, role: "status" },
      h("span", null, "Results may be outdated."),
      refresh,
    );
    this.empty = h(
      "div",
      { class: "empty-state" },
      h("span", { class: "empty-state-icon" }, icon("list-tree")),
      h("div", { class: "empty-state-title" }, "No hierarchy shown"),
      h(
        "div",
        { class: "empty-state-text" },
        "Right-click a function or type in an editor and choose Show call hierarchy or Show type hierarchy.",
      ),
    );
    const body = h("div", { class: "hierarchy-body" });
    this.body = body;
    this.element = h(
      "div",
      { class: "hierarchy-view", tabindex: "-1" },
      this.header,
      this.outdated,
      body,
      this.empty,
    );
    this.tree = this.store.add(
      new Tree<Row>(
        body,
        {
          id: (r) => (r.kind === "node" ? r.node.id : ""),
          hasChildren: () => true,
          children: async (r) => {
            const current = this.current;
            const session = current?.session;
            if (!session) return [];
            if (r.kind === "root") return session.roots.map((node) => ({ kind: "node", node }));
            const direction = session.direction;
            // A failed level (the server stopped, an error) shows as no rows.
            const kids = await session.children(r.node).catch(() => []);
            // Answered after a switch of direction or another hierarchy: its rows would take the
            // new tree's ids (D232).
            if (this.current !== current || session.direction !== direction) return [];
            return kids.map((node) => ({ kind: "node" as const, node }));
          },
          label: (r) => (r.kind === "node" ? r.node.item.name : ""),
          opensWithChildren: (r) => r.kind === "node",
          // The roots open expanded, as in VS Code.
          startsExpanded: (r) => r.kind === "node" && !r.node.id.includes("/"),
        },
        { render: (r, row, info) => this.renderRow(r, row, info.expanded) },
        { rowHeight: 22, ariaLabel: "Hierarchy" },
      ),
    );
    this.store.add(
      this.tree.onDidOpen(({ item, preserveFocus, preview }) => {
        if (item.kind !== "node") return;
        const at = nodeTarget(item.node);
        if (!at) return;
        void services.dispatcher
          .execute("editor.openFile", { ...at, preserveFocus, preview })
          .catch((err: unknown) =>
            services.notifications.show("error", err instanceof Error ? err.message : String(err)),
          );
      }),
    );
    this.store.add(
      this.tree.onContextMenu(({ item, x, y }) => {
        if (item?.kind === "node") this.rowMenu(item.node, x, y);
      }),
    );
    this.store.add(
      effect(() => {
        this.current = shown.value;
        void this.rebuild();
        return undefined;
      }),
    );
    this.store.add(
      effect(() => {
        this.outdated.hidden = !stale.value;
        return undefined;
      }),
    );
  }

  /** Runs a command; a failure shows as a notification (the menu has no other place for it). */
  private run(command: string, input: Record<string, unknown>): void {
    void this.services.dispatcher
      .execute(command, input)
      .catch((err: unknown) =>
        this.services.notifications.show("error", err instanceof Error ? err.message : String(err)),
      );
  }

  /** VS Code's row menu in the call / type hierarchy view. */
  private rowMenu(node: HierarchyNode, x: number, y: number): void {
    const kind = this.current?.session.kind;
    const symbol = node.path ? nodeOrigin(node) : null;
    const items: MenuItem[] = [
      {
        label:
          kind === "type" ? "Show type hierarchy of this item" : "Show call hierarchy of this item",
        icon: "list-tree",
        disabled: !symbol,
        run: () => this.run("lsp.showHierarchyOfItem", { id: node.id }),
      },
      {
        label: "Go to definition",
        icon: "arrow-right",
        disabled: !symbol,
        run: () => symbol && this.run("editor.openFile", { ...symbol }),
      },
      {
        label: "Copy path",
        icon: "clipboard-copy",
        separatorBefore: true,
        disabled: !node.path,
        run: () => node.path && this.run("explorer.copyPath", { path: node.path }),
      },
      {
        label: "Refresh",
        icon: "refresh-cw",
        separatorBefore: true,
        run: () => this.run("lsp.refreshHierarchy", {}),
      },
    ];
    this.store.add(showContextMenu(x, y, items));
  }

  private async rebuild(): Promise<void> {
    const current = this.current;
    this.empty.hidden = !!current;
    this.body.hidden = !current;
    if (!current) {
      this.header.replaceChildren();
      await this.tree.setRoot(null);
    } else {
      const { session } = current;
      const names = session.roots.map((r) => r.item.name).join(", ");
      replaceChildren(
        this.header,
        h("span", { class: "hierarchy-title" }, hierarchyTitle(session.direction, names)),
        h("span", { class: "hierarchy-server" }, current.server),
      );
      await this.tree.setRoot({ kind: "root" });
    }
    this.changed.fire();
  }

  private renderRow(r: Row, row: HTMLElement, expanded: boolean): void {
    row.classList.add("hierarchy-row");
    if (r.kind !== "node") return;
    const { item, path, calls } = r.node;
    const twistie = icon(expanded ? "chevron-down" : "chevron-right");
    twistie.setAttribute("data-tree-twistie", "");
    const kind = symbolKindName(item.kind);
    const glyph = icon(SYMBOL_ICONS.get(kind) ?? "variable");
    const where = path ? this.rel(path).replaceAll("\\", "/") : item.uri;
    const detail = item.detail || where;
    const name = h("span", { class: "hierarchy-name" }, item.name);
    if (item.tags?.includes(1)) name.classList.add("is-deprecated");
    const sites = calls?.ranges.length ?? 0;
    const parts = [
      twistie,
      glyph,
      name,
      h("span", { class: "hierarchy-detail" }, detail),
      ...(sites > 1 ? [h("span", { class: "search-count" }, String(sites))] : []),
    ];
    replaceChildren(row, ...parts);
    setTooltip(
      row,
      `${kind} ${item.name} — ${where}:${item.selectionRange.start.line + 1}${sites > 1 ? ` (${sites} calls)` : ""}`,
      undefined,
      { ariaLabel: false },
    );
  }

  actions(): TabAction[] {
    const direction = this.current?.session.direction;
    if (!direction) return [];
    const next = SWITCH[otherDirection(direction)];
    const refresh: TabAction = {
      icon: "refresh-cw",
      title: "Refresh",
      command: "lsp.refreshHierarchy",
    };
    if (!next) return [refresh];
    return [{ icon: next.icon, title: next.title, command: "lsp.setHierarchyDirection" }, refresh];
  }

  title(): string {
    const kind = this.current?.session.kind;
    return kind === "call" ? "Call hierarchy" : kind === "type" ? "Type hierarchy" : "Hierarchy";
  }

  focus(): void {
    this.tree.focus();
  }

  serialize(): null {
    return null;
  }

  /** The session lives in memory only: the tab doesn't come back after a restart. */
  persist(): boolean {
    return false;
  }

  dispose(): void {
    this.store.dispose();
  }
}
