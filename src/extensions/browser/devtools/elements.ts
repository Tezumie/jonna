// DevTools Elements: the page's DOM as a tree loaded on demand (expand to fetch children),
// hover to highlight in the page, the picker (select an element by clicking it in the page),
// edits (attributes, text, as HTML, delete), and a sidebar with the element's styles (styles.ts:
// every declaration editable in place, D146), computed values and box model. Node ids are the bridge's refs — the
// same ones agents use (browser.snapshot / browser.click).
import { h, on } from "../../../core/dom/index";
import { DisposableStore } from "../../../core/lifecycle/index";
import { icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import {
  type DevtoolsHost,
  type DevtoolsPanel,
  filterInput,
  iconButton,
  splitPanes,
} from "./common";
import { renderStyles, type StyleRule } from "./styles";

interface DomNode {
  id: string;
  kind: number;
  tag?: string;
  attrs?: [string, string][];
  childCount?: number;
  text?: string;
}

interface Styles {
  inline: StyleRule["props"];
  rules: StyleRule[];
  computed: [string, string][];
  box: {
    width: number;
    height: number;
    margin: string[];
    border: string[];
    padding: string[];
    position: string;
    display: string;
  };
}

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

export class ElementsPanel implements DevtoolsPanel {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly tree: HTMLElement;
  private readonly crumbs: HTMLElement;
  private readonly side: HTMLElement;
  private readonly nodes = new Map<string, DomNode>();
  private readonly searchBox: HTMLInputElement;
  private readonly searchCount: HTMLElement;
  /** The last search's matches (cleared when the query changes) and where we are in them. */
  private matches: { id: string; path: string[] }[] = [];
  private matchAt = -1;
  private readonly children = new Map<string, string[]>();
  private readonly expanded = new Set<string>([""]);
  private selected: string | null = null;
  private sideTab: "styles" | "computed" = "styles";
  private computedFilter = "";
  private stylesFilter = "";
  /** Listeners of the sidebar as rendered now (cleared on each render). */
  private readonly sideStore = new DisposableStore();
  private refreshTimer = 0;
  private shown = false;

  constructor(private readonly host: DevtoolsHost) {
    const s = this.store;
    const pick = iconButton(s, "square-dashed-mouse-pointer", "Select an element in the page", () =>
      host.run("browser.inspect", {}),
    );
    // Find in the DOM by CSS selector or text (Ctrl+F in the tree), Enter / Shift+Enter cycles.
    this.searchBox = h("input", {
      class: "input dt-filter dt-dom-search",
      type: "search",
      placeholder: "Find by selector or text",
      spellcheck: "false",
      "aria-label": "Find in the DOM",
    });
    this.searchCount = h("span", { class: "dt-note dt-dom-count" });
    s.add(
      on(this.searchBox, "keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void this.find(e.shiftKey ? -1 : 1);
        } else if (e.key === "Escape") {
          this.searchBox.value = "";
          this.searchCount.textContent = "";
          this.matches = [];
          this.tree.focus();
        }
      }),
    );
    s.add(
      on(this.searchBox, "input", () => {
        this.matches = [];
        this.searchCount.textContent = "";
      }),
    );
    const toolbar = h(
      "div",
      { class: "dt-toolbar" },
      pick,
      iconButton(s, "refresh-cw", "Refresh", () => void this.reload()),
      this.searchBox,
      this.searchCount,
      h("span", { class: "dt-spacer" }),
    );
    this.tree = h("div", { class: "dt-dom", tabindex: "0", role: "tree", "aria-label": "DOM" });
    s.add(on(this.tree, "keydown", (e) => this.onKey(e)));
    s.add(on(this.tree, "mouseleave", () => host.run("browser.highlight", {})));
    this.crumbs = h("div", { class: "dt-crumbs" });
    this.side = h("div", { class: "dt-side" });
    this.element = h(
      "div",
      { class: "dt-panel dt-elements" },
      toolbar,
      // The DOM and the styles sidebar, resizable (stacked when DevTools is narrow).
      splitPanes(s, h("div", { class: "dt-dom-wrap" }, this.tree, this.crumbs), this.side, {
        key: "elements",
        sized: "second",
        size: 320,
        min: 160,
        stackBelow: 560,
      }),
    );
    s.add(
      host.page.onDomChanged(() => {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = window.setTimeout(() => void this.refresh(), 200);
      }),
    );
    s.add(
      host.page.onPicked(({ id, path }) => {
        if (id) void this.reveal(id, path);
      }),
    );
    s.add({ dispose: () => clearTimeout(this.refreshTimer) });
  }

  onShow(): void {
    this.shown = true;
    void this.host.page.call("dom.watch", { on: true }).catch(() => {});
    if (!this.children.has("")) void this.reload();
  }

  onHide(): void {
    this.shown = false;
    void this.host.page.call("dom.watch", { on: false }).catch(() => {});
    this.host.run("browser.highlight", {});
  }

  /** New document: start from the top. */
  async reload(): Promise<void> {
    this.nodes.clear();
    this.children.clear();
    this.expanded.clear();
    this.expanded.add("");
    this.selected = null;
    try {
      await this.load("");
      // Open <html> and <body> like DevTools does.
      const html = this.children.get("")?.find((id) => this.nodes.get(id)?.tag === "html");
      if (html) {
        await this.load(html);
        this.expanded.add(html);
        const body = this.children.get(html)?.find((id) => this.nodes.get(id)?.tag === "body");
        if (body) {
          await this.load(body);
          this.expanded.add(body);
          this.selected = body;
        }
      }
    } catch (err) {
      this.tree.replaceChildren(
        h("div", { class: "dt-empty" }, err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    this.render();
    if (this.selected) void this.renderSide();
  }

  /** Reloads every expanded node's children (after DOM mutations). */
  private async refresh(): Promise<void> {
    if (!this.shown) return;
    const open = [...this.expanded];
    this.children.clear();
    for (const id of open) {
      if (id && !this.nodes.has(id)) continue;
      await this.load(id).catch(() => this.expanded.delete(id));
    }
    this.render();
    if (this.selected) void this.renderSide();
  }

  private async load(id: string): Promise<void> {
    const r = await this.host.page.call<{ node: DomNode; children: DomNode[] }>("dom.node", { id });
    if (id) this.nodes.set(id, r.node);
    for (const c of r.children) this.nodes.set(c.id, c);
    this.children.set(
      id,
      r.children.map((c) => c.id),
    );
  }

  /** Expands the path to `id` and selects it (picker, console, agents). */
  async reveal(id: string, path?: string[]): Promise<void> {
    if (!this.children.has("")) await this.reload();
    const chain =
      path ??
      (await this.host.page
        .call<{ path: string[] }>("dom.path", { id })
        .then((r) => r.path)
        .catch(() => [id]));
    for (const p of ["", ...chain.slice(0, -1)]) {
      if (!this.children.has(p)) await this.load(p).catch(() => {});
      this.expanded.add(p);
    }
    this.selected = id;
    this.render();
    this.tree.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center" });
    void this.renderSide();
  }

  /** Next (or previous) match of the search box's query. */
  private async find(step: 1 | -1): Promise<void> {
    const query = this.searchBox.value.trim();
    if (!query) return;
    if (!this.matches.length) {
      try {
        const r = await this.host.page.call<{
          total: number;
          matches: { id: string; path: string[] }[];
        }>("dom.search", { query });
        this.matches = r.matches;
        this.matchAt = step === 1 ? -1 : 0;
      } catch (err) {
        this.searchCount.textContent = err instanceof Error ? err.message : String(err);
        return;
      }
    }
    if (!this.matches.length) {
      this.searchCount.textContent = "No matches";
      return;
    }
    this.matchAt = (this.matchAt + step + this.matches.length) % this.matches.length;
    const m = this.matches[this.matchAt];
    this.searchCount.textContent = `${this.matchAt + 1} of ${this.matches.length}`;
    if (m) {
      await this.reveal(m.id, m.path);
      this.host.run("browser.highlight", { ref: m.id });
    }
  }

  // ---- Tree ----------------------------------------------------------------------------------

  private visibleRows(): { id: string; depth: number; closing?: boolean }[] {
    const out: { id: string; depth: number; closing?: boolean }[] = [];
    const walk = (parent: string, depth: number) => {
      for (const id of this.children.get(parent) ?? []) {
        if (out.length > 4000) return;
        out.push({ id, depth });
        const n = this.nodes.get(id);
        if (n?.kind === 1 && this.expanded.has(id) && (n.childCount ?? 0) > 0) {
          walk(id, depth + 1);
          out.push({ id, depth, closing: true });
        }
      }
    };
    walk("", 0);
    return out;
  }

  private render(): void {
    const rows = this.visibleRows().map(({ id, depth, closing }) =>
      this.renderRow(id, depth, closing),
    );
    this.tree.replaceChildren(...rows);
    this.renderCrumbs();
  }

  private renderRow(id: string, depth: number, closing?: boolean): HTMLElement {
    const n = this.nodes.get(id);
    const row = h("div", {
      class: `dt-dom-row${id === this.selected && !closing ? " is-selected" : ""}`,
      role: "treeitem",
      style: { "--depth": String(depth) },
      ...(!closing && { "data-id": id }),
    });
    if (!n) return row;
    if (closing) {
      row.append(
        h("span", { class: "dt-dom-toggle" }),
        h("span", { class: "dt-tag" }, `</${n.tag}>`),
      );
      row.addEventListener("click", () => this.select(id));
      return row;
    }
    const expandable = n.kind === 1 && (n.childCount ?? 0) > 0;
    const open = this.expanded.has(id);
    const toggleEl = h(
      "span",
      { class: `dt-dom-toggle${expandable ? " is-expandable" : ""}` },
      expandable ? icon(open ? "chevron-down" : "chevron-right") : null,
    );
    toggleEl.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.toggle(id);
    });
    row.append(toggleEl);
    if (n.kind === 1) {
      const tag = n.tag ?? "";
      row.append(h("span", { class: "dt-tag" }, `<${tag}`));
      for (const [k, v] of n.attrs ?? []) {
        const attr = h(
          "span",
          { class: "dt-attr" },
          " ",
          h("span", { class: "dt-attr-name" }, k),
          v !== "" ? "=" : "",
          v !== ""
            ? h(
                "span",
                { class: "dt-attr-value" },
                `"${v.length > 120 ? `${v.slice(0, 120)}…` : v}"`,
              )
            : "",
        );
        attr.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          void this.editAttribute(id, k, v);
        });
        row.append(attr);
      }
      row.append(h("span", { class: "dt-tag" }, ">"));
      if (n.text !== undefined) {
        const text = h("span", { class: "dt-text" }, n.text);
        text.addEventListener("dblclick", (e) => {
          e.stopPropagation();
          void this.editText(id, n.text ?? "");
        });
        row.append(text, h("span", { class: "dt-tag" }, `</${tag}>`));
      } else if (expandable && !open) {
        // The collapsed children: clicking them opens the element, as the arrow does.
        const more = h("span", { class: "dt-ellipsis", role: "button" }, "…");
        setTooltip(more, `Show ${n.childCount} child node${n.childCount === 1 ? "" : "s"}`);
        more.addEventListener("click", (e) => {
          e.stopPropagation();
          this.select(id);
          void this.toggle(id);
        });
        row.append(more, h("span", { class: "dt-tag" }, `</${tag}>`));
      } else if (!expandable && !VOID.has(tag))
        row.append(h("span", { class: "dt-tag" }, `</${tag}>`));
      if (id === this.selected) row.append(h("span", { class: "dt-dom-ref" }, ` == ${id}`));
    } else if (n.kind === 3) row.append(h("span", { class: "dt-text" }, `"${n.text}"`));
    else if (n.kind === 8) row.append(h("span", { class: "dt-comment" }, `<!-- ${n.text} -->`));
    else row.append(h("span", { class: "dt-comment" }, n.text ?? ""));
    row.addEventListener("click", () => this.select(id));
    row.addEventListener("dblclick", () => expandable && void this.toggle(id));
    row.addEventListener(
      "mouseenter",
      () => n.kind === 1 && this.host.run("browser.highlight", { ref: id }),
    );
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.select(id);
      this.contextMenu(e, n);
    });
    return row;
  }

  private async toggle(id: string): Promise<void> {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else {
      if (!this.children.has(id)) await this.load(id).catch(() => {});
      this.expanded.add(id);
    }
    this.render();
  }

  private select(id: string): void {
    this.selected = id;
    // Like Chrome: the selected element is $0 in the console.
    void this.host.page.call("dom.storeGlobal", { id }).catch(() => {});
    for (const row of Array.from(this.tree.querySelectorAll(".dt-dom-row")))
      row.classList.toggle("is-selected", (row as HTMLElement).dataset.id === id);
    this.renderCrumbs();
    void this.renderSide();
  }

  private parentOf(id: string): string | undefined {
    for (const [p, kids] of this.children) if (kids.includes(id)) return p;
    return undefined;
  }

  private renderCrumbs(): void {
    const chain: string[] = [];
    for (let id: string | undefined = this.selected ?? undefined; id; id = this.parentOf(id))
      chain.unshift(id);
    this.crumbs.replaceChildren(
      ...chain.map((id) => {
        const n = this.nodes.get(id);
        const label =
          n?.kind === 1
            ? `${n.tag}${attr(n, "id") ? `#${attr(n, "id")}` : ""}${attr(n, "class") ? `.${attr(n, "class")?.trim().split(/\s+/).join(".")}` : ""}`
            : "#text";
        const b = h("button", { class: "dt-crumb", type: "button" }, label);
        b.addEventListener("click", () => this.select(id));
        b.addEventListener("mouseenter", () => this.host.run("browser.highlight", { ref: id }));
        return b;
      }),
    );
  }

  private onKey(e: KeyboardEvent): void {
    const rows = this.visibleRows().filter((r) => !r.closing);
    const at = rows.findIndex((r) => r.id === this.selected);
    const move = (to: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (!r) return;
      this.select(r.id);
      this.host.run("browser.highlight", { ref: r.id });
      this.tree
        .querySelector(`[data-id="${CSS.escape(r.id)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    };
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at - 1);
    else if (e.key === "ArrowRight" && this.selected && !this.expanded.has(this.selected))
      void this.toggle(this.selected);
    else if (e.key === "ArrowLeft" && this.selected) {
      if (this.expanded.has(this.selected)) void this.toggle(this.selected);
      else {
        const p = this.parentOf(this.selected);
        if (p) this.select(p);
      }
    } else if ((e.key === "Delete" || e.key === "Backspace") && this.selected)
      void this.remove(this.selected);
    else if (e.key === "F2" && this.selected) void this.editHtml(this.selected);
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      this.searchBox.focus();
      this.searchBox.select();
    } else return;
    e.preventDefault();
  }

  private contextMenu(e: MouseEvent, n: DomNode): void {
    const { host } = this;
    const id = n.id;
    host.menu(e, [
      {
        label: "Edit as HTML",
        icon: "pencil",
        keybinding: "F2",
        run: () => void this.editHtml(id),
      },
      ...(n.kind === 1
        ? [
            { label: "Add attribute", run: () => void this.editAttribute(id, "", "") },
            { label: "Edit text", run: () => void this.editText(id, n.text ?? "") },
          ]
        : []),
      {
        label: "Delete element",
        icon: "trash-2" as const,
        destructive: true,
        run: () => void this.remove(id),
      },
      {
        label: "Copy element",
        icon: "copy" as const,
        separatorBefore: true,
        run: () => void this.copyHtml(id),
      },
      { label: "Copy selector", run: () => void this.copySelector(id) },
      { label: `Copy ref (${id})`, run: () => host.copy(id) },
      {
        label: "Scroll into view",
        separatorBefore: true,
        run: () => host.run("browser.scroll", { ref: id }),
      },
      {
        label: "Store as $0 (console)",
        run: () => void host.page.call("dom.storeGlobal", { id }).catch(() => {}),
      },
    ]);
  }

  private async prompt(prompt: string, value: string): Promise<string | undefined> {
    return this.host.services.quickInput.prompt({ prompt, value });
  }

  private async editAttribute(id: string, name: string, value: string): Promise<void> {
    const input = await this.prompt(
      name ? `Edit ${name} (empty removes it)` : 'New attribute (name="value")',
      name ? value : "",
    );
    if (input === undefined) return;
    if (!name) {
      const m = /^\s*([^\s=]+)\s*(?:=\s*"?([^"]*)"?)?\s*$/.exec(input);
      if (!m?.[1]) return;
      await this.host.page.call("dom.setAttribute", { id, name: m[1], value: m[2] ?? "" });
    } else if (input === "") await this.host.page.call("dom.removeAttribute", { id, name });
    else await this.host.page.call("dom.setAttribute", { id, name, value: input });
    await this.refresh();
  }

  private async editText(id: string, value: string): Promise<void> {
    const input = await this.prompt("Edit text", value);
    if (input === undefined) return;
    await this.host.page.call("dom.setText", { id, text: input });
    await this.refresh();
  }

  private async editHtml(id: string): Promise<void> {
    const { html } = await this.host.page.call<{ html: string }>("dom.outerHTML", { id });
    const input = await this.prompt("Edit as HTML", html);
    if (input === undefined || input === html) return;
    const r = await this.host.page.call<{ id: string | null }>("dom.setOuterHTML", {
      id,
      html: input,
    });
    await this.refresh();
    if (r.id) await this.reveal(r.id);
  }

  private async remove(id: string): Promise<void> {
    const parent = this.parentOf(id);
    await this.host.page.call("dom.remove", { id });
    if (parent !== undefined) this.selected = parent || null;
    await this.refresh();
  }

  private async copyHtml(id: string): Promise<void> {
    const { html } = await this.host.page.call<{ html: string }>("dom.outerHTML", { id });
    this.host.copy(html);
  }

  private async copySelector(id: string): Promise<void> {
    const chain: string[] = [];
    for (let at: string | undefined = id; at; at = this.parentOf(at)) {
      const n = this.nodes.get(at);
      if (n?.kind !== 1) continue;
      const elId = attr(n, "id");
      if (elId) {
        chain.unshift(`#${CSS.escape(elId)}`);
        break;
      }
      const parent = this.parentOf(at);
      const siblings = (this.children.get(parent ?? "") ?? []).filter(
        (s) => this.nodes.get(s)?.tag === n.tag,
      );
      chain.unshift(
        siblings.length > 1 ? `${n.tag}:nth-of-type(${siblings.indexOf(at) + 1})` : (n.tag ?? ""),
      );
    }
    this.host.copy(chain.join(" > "));
  }

  // ---- Sidebar: styles, computed, box model --------------------------------------------------

  private async renderSide(): Promise<void> {
    const id = this.selected;
    const n = id ? this.nodes.get(id) : undefined;
    if (!id || n?.kind !== 1) {
      this.side.replaceChildren(h("div", { class: "dt-empty" }, "Select an element."));
      return;
    }
    let styles: Styles;
    try {
      styles = await this.host.page.call<Styles>("dom.styles", { id });
    } catch (err) {
      this.side.replaceChildren(
        h("div", { class: "dt-empty" }, err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    if (this.selected !== id) return;
    this.sideStore.clear();
    const scrollTop = this.side.querySelector(".dt-side-body")?.scrollTop ?? 0;
    const tabs = (["styles", "computed"] as const).map((t) => {
      const b = h(
        "button",
        { class: "dt-subtab", type: "button", "aria-selected": String(t === this.sideTab) },
        t === "styles" ? "Styles" : "Computed",
      );
      b.addEventListener("click", () => {
        this.sideTab = t;
        void this.renderSide();
      });
      return b;
    });
    const body = h("div", { class: "dt-side-body" });
    if (this.sideTab === "styles") {
      body.append(
        renderStyles({
          host: this.host,
          store: this.sideStore,
          id,
          className: attr(n, "class") ?? "",
          inline: styles.inline,
          rules: styles.rules,
          filter: this.stylesFilter,
          setFilter: (text) => {
            this.stylesFilter = text;
            void this.renderSide().then(() =>
              this.side.querySelector<HTMLInputElement>(".dt-styles-bar .dt-filter")?.focus(),
            );
          },
          refresh: async () => {
            // The class attribute may have changed (.cls): the node's too.
            const parent = this.parentOf(id);
            if (parent !== undefined) await this.load(parent).catch(() => {});
            await this.renderSide();
          },
        }),
        this.boxModel(styles.box),
      );
    } else {
      const filter = filterInput(this.store, "Filter properties", (t) => {
        this.computedFilter = t;
        list.replaceChildren(...rowsFor());
      });
      filter.value = this.computedFilter;
      const rowsFor = () =>
        styles.computed
          .filter(
            ([p, v]) =>
              !this.computedFilter ||
              p.includes(this.computedFilter) ||
              v.toLowerCase().includes(this.computedFilter),
          )
          .map(([p, v]) =>
            h(
              "div",
              { class: "dt-prop" },
              h("span", { class: "dt-prop-name" }, p),
              ": ",
              h("span", { class: "dt-prop-value" }, v),
            ),
          );
      const list = h("div", { class: "dt-computed" }, ...rowsFor());
      body.append(this.boxModel(styles.box), filter, list);
    }
    this.side.replaceChildren(h("div", { class: "dt-subtabs" }, ...tabs), body);
    body.scrollTop = scrollTop;
  }

  private boxModel(box: Styles["box"]): HTMLElement {
    const sides = (label: string, values: string[], inner: HTMLElement) =>
      h(
        "div",
        { class: `dt-box dt-box-${label}` },
        h("span", { class: "dt-box-label" }, label),
        h("span", { class: "dt-box-t" }, num(values[0])),
        h(
          "div",
          { class: "dt-box-mid" },
          h("span", null, num(values[3])),
          inner,
          h("span", null, num(values[1])),
        ),
        h("span", { class: "dt-box-b" }, num(values[2])),
      );
    const content = h("div", { class: "dt-box-content" }, `${box.width} × ${box.height}`);
    return h(
      "div",
      { class: "dt-boxmodel" },
      sides(
        "margin",
        box.margin,
        sides("border", box.border, sides("padding", box.padding, content)),
      ),
      h("div", { class: "dt-note" }, `${box.display} · ${box.position}`),
    );
  }

  dispose(): void {
    if (this.shown) void this.host.page.call("dom.watch", { on: false }).catch(() => {});
    this.sideStore.dispose();
    this.store.dispose();
  }
}

function attr(n: DomNode, name: string): string | undefined {
  return n.attrs?.find(([k]) => k === name)?.[1];
}

function num(v: string | undefined): string {
  const n = Number.parseFloat(v ?? "");
  return !n ? "–" : String(Math.round(n * 100) / 100);
}
