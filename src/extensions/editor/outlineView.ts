// The Outline sidebar view (D113): the active editor's symbols as a tree (classes, functions,
// methods…), following the cursor — the symbol it's in is highlighted and revealed. Click opens
// the symbol; the filter keeps matching symbols and their parents. Header: collapse all and a
// "…" menu (sort by position / name / kind, follow cursor, expand all); right-click a symbol to
// go to it, select it or copy its name or path (D131). State for agents:
// ide://editors/active/outline (the same symbols, flattened with depth and line).
import { h, on, replaceChildren } from "../../core/dom/index";
import { clipboardIpc } from "../../core/ipc/system";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect, type ReadonlySignal, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { icon } from "../../ui/Icon";
import { type MenuItem, showContextMenu, showMenu } from "../../ui/Menu";
import { Tree } from "../../ui/Tree";
import type { WorkbenchServices } from "../../workbench/services";
import type { ViewInstance } from "../../workbench/views";
import { symbolIcon, symbolPath } from "./chrome";
import type { EngineDocument, OutlineSymbol } from "./engine";

/** What the Outline shows: an editor's document, or a target with its own symbols. */
export interface OutlineTarget {
  path: string;
  /** The editor's document (null for a target with `custom` symbols). */
  doc: EngineDocument | null;
  line: number;
  /**
   * A notebook (D204): its own symbols (headings and code cells), its identity and version for
   * reloading, and how a symbol is opened (the cell is revealed).
   */
  custom?: {
    key: object;
    version: number;
    symbols(): Promise<OutlineSymbol[]>;
    open(symbol: OutlineSymbol, preserveFocus: boolean): void;
  };
}

const targetKey = (a: OutlineTarget): object | null => a.custom?.key ?? a.doc;
const targetVersion = (a: OutlineTarget): number => a.custom?.version ?? a.doc?.versionId ?? -1;

export interface OutlineSource {
  /** The active editor: its file, document and cursor line (null without one). */
  active(): OutlineTarget | null;
  /** Changes when the active editor, its text or its cursor changes. */
  readonly version: ReadonlySignal<unknown>;
  symbols(doc: EngineDocument): Promise<OutlineSymbol[]>;
  /** outline.sortOrder / outline.followCursor. */
  sortOrder(): OutlineSort;
  followCursor(): boolean;
}

type Node = { kind: "root" } | { kind: "symbol"; s: OutlineSymbol; id: string };

/** The target's symbols: its own, or its document's from the language providers. */
function symbolsOf(source: OutlineSource, a: OutlineTarget): Promise<OutlineSymbol[]> {
  if (a.custom) return a.custom.symbols();
  return a.doc ? source.symbols(a.doc) : Promise.resolve([]);
}

/** Symbols matching `q` (by name), with the parents that lead to them. */
export function filterSymbols(symbols: readonly OutlineSymbol[], q: string): OutlineSymbol[] {
  if (!q) return [...symbols];
  const out: OutlineSymbol[] = [];
  for (const s of symbols) {
    const children = filterSymbols(s.children, q);
    if (s.name.toLowerCase().includes(q) || children.length) out.push({ ...s, children });
  }
  return out;
}

export type OutlineSort = "position" | "name" | "kind";

/** Kinds in VS Code's "sort by kind" order (others after, alphabetically). */
const KIND_ORDER = [
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "interface",
  "struct",
  "enum",
  "type",
  "typeparameter",
  "constructor",
  "method",
  "function",
  "property",
  "field",
  "event",
  "operator",
  "variable",
  "constant",
  "enummember",
  "key",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "null",
];
const kindRank = (k: string) => {
  const i = KIND_ORDER.indexOf(k.toLowerCase().replace(/[\s_-]/g, ""));
  return i < 0 ? KIND_ORDER.length : i;
};

/** Symbols in `order` (recursively); "position" keeps the file's order. */
export function sortSymbols(
  symbols: readonly OutlineSymbol[],
  order: OutlineSort,
): OutlineSymbol[] {
  const children = (s: OutlineSymbol) => ({ ...s, children: sortSymbols(s.children, order) });
  const list = symbols.map(children);
  if (order === "position") return list;
  const byName = (a: OutlineSymbol, b: OutlineSymbol) =>
    // Lowercased first: where the locale is plain C (Linux CI) the compare is by code point, and
    // "Zed" came before "alpha".
    a.name
      .toLocaleLowerCase()
      .localeCompare(b.name.toLocaleLowerCase(), undefined, { sensitivity: "base", numeric: true });
  return list.sort(
    order === "name" ? byName : (a, b) => kindRank(a.kind) - kindRank(b.kind) || byName(a, b),
  );
}

/** Symbols flattened (depth-first) for agents. */
export function flattenSymbols(
  symbols: readonly OutlineSymbol[],
  depth = 0,
  out: {
    name: string;
    kind: string;
    line: number;
    column: number;
    endLine: number;
    depth: number;
  }[] = [],
): typeof out {
  for (const s of symbols) {
    out.push({
      name: s.name,
      kind: s.kind,
      line: s.line,
      column: s.column,
      endLine: s.endLine,
      depth,
    });
    flattenSymbols(s.children, depth + 1, out);
  }
  return out;
}

export class OutlineView implements ViewInstance {
  private readonly store = new DisposableStore();
  private readonly tree: Tree<Node>;
  private readonly filter: HTMLInputElement;
  private readonly empty: HTMLElement;
  private readonly body: HTMLElement;
  private symbols: OutlineSymbol[] = [];
  private shownFor: { key: object | null; text: number } | null = null;
  private current = "";
  private readonly loading = signal(0);

  constructor(
    host: HTMLElement,
    private readonly services: WorkbenchServices,
    private readonly source: OutlineSource,
  ) {
    this.filter = h("input", {
      class: "input outline-filter",
      type: "search",
      placeholder: "Filter symbols",
      "aria-label": "Filter symbols",
    }) as HTMLInputElement;
    this.empty = h("div", { class: "empty-state outline-empty" });
    const body = h("div", { class: "outline-body" });
    this.body = body;
    host.append(
      h(
        "div",
        { class: "outline-view" },
        h("div", { class: "outline-header" }, this.filter),
        body,
        this.empty,
      ),
    );
    this.tree = this.store.add(
      new Tree<Node>(
        body,
        {
          id: (n) => (n.kind === "symbol" ? n.id : ""),
          hasChildren: (n) => n.kind === "root" || n.s.children.length > 0,
          children: async (n) => {
            const list = n.kind === "root" ? this.shown() : n.s.children;
            const prefix = n.kind === "root" ? "" : `${n.id}/`;
            return list.map((s, i) => ({ kind: "symbol" as const, s, id: `${prefix}${i}` }));
          },
        },
        { render: (n, row, info) => this.renderRow(n, row, info.expanded) },
        { rowHeight: 22, ariaLabel: "Outline" },
      ),
    );
    this.store.add(
      this.tree.onDidOpen(({ item, preserveFocus }) => {
        const a = this.source.active();
        if (item.kind !== "symbol" || !a) return;
        if (a.custom) {
          a.custom.open(item.s, preserveFocus);
          return;
        }
        void services.dispatcher
          .execute("editor.openFile", {
            path: a.path,
            line: item.s.line,
            column: item.s.column,
            preserveFocus,
          })
          .catch(() => {});
      }),
    );
    this.store.add(
      this.tree.onContextMenu(({ item, x, y }) => {
        if (item?.kind === "symbol") this.rowMenu(item, x, y);
      }),
    );
    let frame = 0;
    this.store.add(
      on(this.filter, "input", () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => void this.show());
      }),
    );
    // The editor changed (or its text, or the cursor): reload symbols when the text changed
    // (debounced), else just move the highlight.
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.store.add({
      dispose: () => {
        cancelAnimationFrame(frame);
        clearTimeout(timer);
        clearTimeout(this.retry);
      },
    });
    this.store.add(
      effect(() => {
        this.source.version.value;
        const a = this.source.active();
        const text = a ? targetVersion(a) : -1;
        const key = a ? targetKey(a) : null;
        if (!a) {
          // A load still waiting for the editor that just closed mustn't show its symbols.
          clearTimeout(timer);
          this.loading.value = this.loading.peek() + 1;
          this.shownFor = null;
          this.symbols = [];
          void this.show();
        } else if (this.shownFor?.key !== key || this.shownFor.text !== text) {
          clearTimeout(timer);
          timer = setTimeout(() => void this.load(), this.shownFor?.key === key ? 400 : 0);
        } else this.follow();
        return undefined;
      }),
    );
  }

  private async load(attempt = 0): Promise<void> {
    clearTimeout(this.retry);
    const a = this.source.active();
    if (!a) return;
    const token = this.loading.peek() + 1;
    this.loading.value = token;
    const symbols = await symbolsOf(this.source, a).catch(() => []);
    if (token !== this.loading.peek() || this.store.isDisposed) return;
    this.symbols = symbols;
    this.shownFor = { key: targetKey(a), text: targetVersion(a) };
    await this.show();
    // A language service that's still starting (TypeScript's worker, a language server) answers
    // with nothing at first: ask again a few times.
    if (!symbols.length && attempt < 5)
      this.retry = setTimeout(
        () => {
          const now = this.source.active();
          if (now && targetKey(now) === targetKey(a)) void this.load(attempt + 1);
        },
        1000 * (attempt + 1),
      );
  }
  private retry: ReturnType<typeof setTimeout> | undefined;

  /** The list last shown, until the symbols, the filter or the order change. */
  private shownCache: {
    symbols: OutlineSymbol[];
    query: string;
    order: string;
    list: OutlineSymbol[];
  } | null = null;

  /**
   * The symbols as shown (filtered, sorted). The same list until something changes (D379):
   * sorting copies every symbol, so two calls gave different objects and following the cursor
   * never found the symbol it was on, besides re-sorting the file on every cursor move.
   */
  private shown(): OutlineSymbol[] {
    const query = this.filter.value.trim().toLowerCase();
    const order = this.source.sortOrder();
    const c = this.shownCache;
    if (c && c.symbols === this.symbols && c.query === query && c.order === order) return c.list;
    const list = sortSymbols(filterSymbols(this.symbols, query), order);
    this.shownCache = { symbols: this.symbols, query, order, list };
    return list;
  }

  /** Re-sorts / re-follows after an Outline setting changed. */
  refresh(): void {
    this.current = "";
    void this.show();
  }

  collapseAll(): void {
    this.tree.collapseAll();
  }

  async expandAll(): Promise<void> {
    const walk = (symbols: readonly OutlineSymbol[], prefix: string): string[] =>
      symbols.flatMap((s, i) =>
        s.children.length ? [`${prefix}${i}`, ...walk(s.children, `${prefix}${i}/`)] : [],
      );
    await this.tree.setRoot({ kind: "root" }, walk(this.shown(), ""));
    this.follow();
  }

  /** The symbol and its ancestors for a row id ("0/2/1"). */
  private chain(id: string): OutlineSymbol[] {
    const out: OutlineSymbol[] = [];
    let level = this.shown();
    for (const part of id.split("/")) {
      const s = level[Number(part)];
      if (!s) break;
      out.push(s);
      level = s.children;
    }
    return out;
  }

  private rowMenu(node: Extract<Node, { kind: "symbol" }>, x: number, y: number): void {
    const a = this.source.active();
    if (!a) return;
    const s = node.s;
    const run = (command: string, input: unknown) =>
      void this.services.dispatcher.execute(command, input).catch(() => {});
    const copy = (text: string) =>
      void clipboardIpc.writeText(text).then(
        () => this.services.notifications.show("info", "Copied."),
        () => {},
      );
    const custom = a.custom;
    const items: MenuItem[] = [
      {
        label: "Go to symbol",
        icon: "arrow-right",
        run: () =>
          custom
            ? custom.open(s, false)
            : run("editor.openFile", { path: a.path, line: s.line, column: s.column }),
      },
      {
        label: "Select symbol",
        disabled: !!custom,
        run: () =>
          void this.services.dispatcher
            .execute("editor.openFile", { path: a.path, line: s.line, column: s.column })
            .then(() =>
              run("editor.select", {
                startLine: s.line,
                startColumn: s.column,
                endLine: s.endLine,
                endColumn: s.endColumn,
              }),
            )
            .catch(() => {}),
      },
      { label: "Copy name", icon: "copy", separatorBefore: true, run: () => copy(s.name) },
      {
        label: "Copy path",
        icon: "clipboard-copy",
        run: () =>
          copy(
            this.chain(node.id)
              .map((c) => c.name)
              .join("."),
          ),
      },
      {
        label: "Collapse all",
        icon: "list-collapse",
        separatorBefore: true,
        run: () => this.collapseAll(),
      },
      { label: "Expand all", icon: "list-tree", run: () => void this.expandAll() },
    ];
    this.store.add(showContextMenu(x, y, items));
  }

  private async show(): Promise<void> {
    const list = this.shown();
    const a = this.source.active();
    this.empty.hidden = list.length > 0;
    // The empty list would push the message down.
    this.body.hidden = list.length === 0;
    replaceChildren(
      this.empty,
      h("span", { class: "empty-state-icon" }, icon("list-tree")),
      h(
        "div",
        { class: "empty-state-title" },
        !a
          ? "No editor is open"
          : this.symbols.length
            ? "No symbols match"
            : "No symbols found in this file",
      ),
    );
    // Everything expanded (outlines are small); collapsing is remembered until the file changes.
    const ids: string[] = [];
    const walk = (symbols: readonly OutlineSymbol[], prefix: string) =>
      symbols.forEach((s, i) => {
        const id = `${prefix}${i}`;
        if (s.children.length) {
          ids.push(id);
          walk(s.children, `${id}/`);
        }
      });
    walk(list, "");
    await this.tree.setRoot({ kind: "root" }, ids);
    this.follow();
  }

  /** Highlights (and reveals) the innermost symbol containing the cursor. */
  private follow(): void {
    const a = this.source.active();
    if (!a || this.filter.value) return;
    if (!this.source.followCursor()) {
      if (this.current) {
        this.current = "";
        this.tree.rerender();
      }
      return;
    }
    const shown = this.shown();
    const path = symbolPath(shown, a.line);
    let id = "";
    let level = shown;
    for (const s of path) {
      const i = level.indexOf(s);
      if (i < 0) break;
      id = id ? `${id}/${i}` : String(i);
      level = s.children;
    }
    if (id === this.current) return;
    this.current = id;
    this.tree.rerender();
    if (id) this.tree.reveal(id);
  }

  private renderRow(n: Node, row: HTMLElement, expanded: boolean): void {
    row.classList.add("outline-row");
    if (n.kind !== "symbol") return;
    row.classList.toggle("is-current", n.id === this.current);
    const glyph = icon(symbolIcon(n.s.kind));
    glyph.classList.add("outline-kind", `is-${n.s.kind}`);
    replaceChildren(
      row,
      n.s.children.length
        ? icon(expanded ? "chevron-down" : "chevron-right")
        : h("span", { class: "twistie-spacer" }),
      glyph,
      h("span", { class: "outline-name" }, n.s.name),
      h("span", { class: "outline-line" }, String(n.s.line)),
    );
  }

  focus(): void {
    this.tree.focus();
  }

  dispose(): void {
    this.store.dispose();
  }
}

/** Registers the Outline view and `ide://editors/active/outline`. */
export function registerOutline(
  sub: DisposableStore,
  services: WorkbenchServices,
  source: OutlineSource,
): void {
  const views = new Set<OutlineView>();
  const { dispatcher, settings } = services;
  sub.add(
    services.views.register({
      id: "outline.view",
      title: "Outline",
      icon: "list-tree",
      command: "outline.show",
      // Hidden from the activity bar, it sits at the bottom of the Explorer (like VS Code).
      sectionOf: "explorer.view",
      sectionOrder: 10,
      actions: [
        { command: "outline.collapseAll", icon: "list-collapse", title: "Collapse all" },
        { command: "outline.showMenu", icon: "ellipsis", title: "More actions", menu: true },
      ],
      create: (host) => {
        const view = new OutlineView(host, services, source);
        views.add(view);
        return {
          focus: () => view.focus(),
          dispose: () => {
            views.delete(view);
            view.dispose();
          },
        };
      },
    }),
  );
  // Sort order and follow-cursor changes re-render every Outline.
  let last = "";
  sub.add(
    effect(() => {
      settings.version.value;
      const now = `${source.sortOrder()}|${source.followCursor()}`;
      if (now !== last) {
        last = now;
        for (const v of views) v.refresh();
      }
      return undefined;
    }),
  );
  const register = (id: string, title: string, description: string, run: () => unknown) =>
    sub.add(
      dispatcher.register({
        id,
        title,
        category: "Outline",
        description,
        input: s.empty(),
        effects: [],
        agent: "hidden",
        run: async () => run(),
      }),
    );
  register("outline.collapseAll", "Collapse all", "Collapses every symbol in the Outline.", () => {
    for (const v of views) v.collapseAll();
  });
  register("outline.expandAll", "Expand all", "Expands every symbol in the Outline.", async () => {
    for (const v of views) await v.expandAll();
  });
  register(
    "outline.toggleFollowCursor",
    "Toggle follow cursor",
    "Switches outline.followCursor (the Outline highlights the symbol the cursor is in).",
    () => settings.update("outline.followCursor", !source.followCursor(), "user"),
  );
  sub.add(
    dispatcher.register({
      id: "outline.sort",
      title: "Sort outline",
      category: "Outline",
      description: "Sets outline.sortOrder: position (as in the file), name, or kind then name.",
      input: s.object({ order: s.enum(["position", "name", "kind"]) }),
      effects: ["write"],
      agent: "hidden",
      run: async ({ order }) => {
        await settings.update(
          "outline.sortOrder",
          order === "position" ? undefined : order,
          "user",
        );
        return { order };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "outline.showMenu",
      title: "Outline actions",
      category: "Outline",
      description: 'The Outline\'s "…" menu at a point: sort order, follow cursor, expand all.',
      input: s.object({ x: s.number(), y: s.number() }),
      effects: [],
      agent: "hidden",
      palette: false,
      run: ({ x, y }) => {
        const order = source.sortOrder();
        const run =
          (command: string, input: unknown = {}) =>
          () =>
            void dispatcher.execute(command, input).catch(() => {});
        const items: MenuItem[] = [
          {
            label: "Sort by position",
            checked: order === "position",
            run: run("outline.sort", { order: "position" }),
          },
          {
            label: "Sort by name",
            checked: order === "name",
            run: run("outline.sort", { order: "name" }),
          },
          {
            label: "Sort by kind",
            checked: order === "kind",
            run: run("outline.sort", { order: "kind" }),
          },
          {
            label: "Follow cursor",
            separatorBefore: true,
            checked: source.followCursor(),
            run: run("outline.toggleFollowCursor"),
          },
          {
            label: "Collapse all",
            icon: "list-collapse",
            separatorBefore: true,
            run: run("outline.collapseAll"),
          },
          { label: "Expand all", icon: "list-tree", run: run("outline.expandAll") },
        ];
        sub.add(showMenu({ x, y }, items, "Outline"));
      },
    }),
  );
  sub.add(
    services.dispatcher.register({
      id: "outline.show",
      title: "Show outline",
      category: "View",
      description: "Shows the Outline view: the active editor's symbols, following the cursor.",
      input: s.empty(),
      effects: [],
      // Not hidden: extensions open it through VS Code's outline.focus (Jupyter's toolbar).
      agent: "discoverable",
      run: async (_input, ctx) => {
        await ctx.execute("view.show", { id: "outline.view" });
      },
    }),
  );
  sub.add(
    services.state.register("ide://editors/active/outline", {
      description:
        "The active editor's symbols (classes, functions, methods…) flattened depth-first: name, kind, line range, depth.",
      get: async () => {
        const a = source.active();
        if (!a) return null;
        return { path: a.path, symbols: flattenSymbols(await symbolsOf(source, a)) };
      },
    }),
  );
}
