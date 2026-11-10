// DevTools Sources: the page's documents, scripts and stylesheets as a tree by origin and folder
// (what the page loaded plus what the proxy served), and the selected one with syntax colors and
// line numbers. A resource that is a file in the workspace opens in the editor (with the line).
import { h, on } from "../../../core/dom/index";
import { DisposableStore } from "../../../core/lifecycle/index";
import { icon } from "../../../ui/Icon";
import {
  type DevtoolsHost,
  type DevtoolsPanel,
  filterInput,
  iconButton,
  languageOf,
  splitPanes,
} from "./common";
import { requestType } from "./network";

interface Resource {
  url: string;
  type: string;
  inline?: string;
}

export class SourcesPanel implements DevtoolsPanel {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  /** The find box of the file shown now. */
  private readonly findStore = new DisposableStore();
  private readonly treeEl: HTMLElement;
  private readonly viewer: HTMLElement;
  private resources: Resource[] = [];
  private selected: string | null = null;
  private filter = "";
  private readonly collapsed = new Set<string>();

  constructor(private readonly host: DevtoolsHost) {
    const s = this.store;
    this.treeEl = h("div", { class: "dt-src-tree" });
    this.viewer = h(
      "div",
      { class: "dt-src-view" },
      h("div", { class: "dt-empty" }, "Pick a file."),
    );
    this.element = h(
      "div",
      { class: "dt-panel dt-sources" },
      h(
        "div",
        { class: "dt-toolbar" },
        iconButton(s, "refresh-cw", "Refresh", () => void this.load()),
        filterInput(s, "Filter files", (t) => {
          this.filter = t;
          this.renderTree();
        }),
      ),
      splitPanes(this.store, this.treeEl, this.viewer, {
        key: "sources",
        sized: "first",
        size: 220,
        stackBelow: 440,
        stackedShare: 0.35,
        min: 120,
      }),
    );
  }

  onShow(): void {
    void this.load();
  }

  async load(): Promise<void> {
    const seen = new Map<string, Resource>();
    try {
      const r = await this.host.page.call<{ resources: Resource[] }>("resources");
      for (const res of r.resources) {
        const url = res.inline ? res.url : this.host.displayUrl(res.url);
        seen.set(url, { ...res, url });
      }
    } catch {
      /* page not connected: what the proxy saw still helps */
    }
    for (const req of this.host.page.requests.peek()) {
      const t = requestType(req);
      if ((t === "doc" || t === "js" || t === "css") && !seen.has(req.url))
        seen.set(req.url, {
          url: req.url,
          type: t === "doc" ? "document" : t === "js" ? "script" : "stylesheet",
        });
    }
    this.resources = [...seen.values()];
    this.renderTree();
  }

  private renderTree(): void {
    // origin → folder path → files
    const groups = new Map<string, Map<string, Resource[]>>();
    for (const r of this.resources) {
      if (this.filter && !r.url.toLowerCase().includes(this.filter)) continue;
      let origin = "(inline)";
      let folder = "/";
      if (!r.inline) {
        try {
          const u = new URL(r.url);
          origin = u.host || u.protocol;
          folder = u.pathname.split("/").slice(0, -1).join("/") || "/";
        } catch {
          // A workspace path (static previews): its folders.
          origin = "(workspace)";
          folder = `/${r.url.split("/").slice(0, -1).join("/")}`.replace(/\/$/, "") || "/";
        }
      }
      const byFolder = groups.get(origin) ?? new Map<string, Resource[]>();
      groups.set(origin, byFolder);
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), r]);
    }
    const rows: HTMLElement[] = [];
    for (const [origin, folders] of groups) {
      rows.push(this.folderRow(origin, origin, 0, "globe"));
      if (this.collapsed.has(origin)) continue;
      for (const [folder, files] of [...folders].sort(([a], [b]) => a.localeCompare(b))) {
        const key = `${origin}${folder}`;
        if (folder !== "/") rows.push(this.folderRow(key, folder, 1, "folder"));
        if (this.collapsed.has(key)) continue;
        for (const f of files.sort((a, b) => a.url.localeCompare(b.url))) {
          const name = f.inline ? f.url : f.url.split("?")[0]?.split("/").pop() || "(index)";
          const row = h(
            "div",
            {
              class: `dt-src-row${f.url === this.selected ? " is-selected" : ""}`,
              style: { "--depth": String(folder === "/" ? 1 : 2) },
              title: f.url,
            },
            icon(
              f.type === "stylesheet" ? "hash" : f.type === "document" ? "file-code" : "file-code",
            ),
            h("span", null, name),
          );
          row.addEventListener("click", () => void this.open(f.url));
          rows.push(row);
        }
      }
    }
    this.treeEl.replaceChildren(
      ...(rows.length ? rows : [h("div", { class: "dt-empty" }, "No sources yet.")]),
    );
  }

  private folderRow(
    key: string,
    label: string,
    depth: number,
    glyph: "globe" | "folder",
  ): HTMLElement {
    const open = !this.collapsed.has(key);
    const row = h(
      "div",
      { class: "dt-src-row is-folder", style: { "--depth": String(depth) } },
      icon(open ? "chevron-down" : "chevron-right"),
      icon(glyph),
      h("span", null, label),
    );
    row.addEventListener("click", () => {
      if (open) this.collapsed.add(key);
      else this.collapsed.delete(key);
      this.renderTree();
    });
    return row;
  }

  /** Shows a resource (by its shown URL), optionally at a line. */
  async open(url: string, line?: number): Promise<void> {
    if (!this.resources.some((r) => r.url === url)) {
      await this.load();
      if (!this.resources.some((r) => r.url === url)) this.resources.push({ url, type: "script" });
    }
    this.selected = url;
    this.renderTree();
    const res = this.resources.find((r) => r.url === url);
    this.viewer.replaceChildren(h("div", { class: "dt-empty" }, "Loading…"));
    let text: string;
    try {
      text = res?.inline ?? (await this.host.resourceText(url));
    } catch (err) {
      this.viewer.replaceChildren(
        h("div", { class: "dt-empty" }, err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    if (this.selected !== url) return;
    const file = res?.inline ? null : await this.host.workspaceFile(url);
    const head = h("div", { class: "dt-src-head" }, h("span", { class: "dt-src-path" }, url));
    if (file) {
      const b = h(
        "button",
        { class: "button button-secondary button-sm", type: "button" },
        "Open in editor",
      );
      b.addEventListener("click", () =>
        this.host.run("editor.openFile", { path: file, ...(line && { line }) }),
      );
      head.append(b);
    }
    const shown = text.length > 500000 ? `${text.slice(0, 500000)}\n…` : text;
    const lines = shown.split("\n");
    const gutter = h("pre", { class: "dt-src-gutter" }, lines.map((_, i) => i + 1).join("\n"));
    const code = h("pre", { class: "dt-src-code" }, shown);
    const body = h("div", { class: "dt-src-body" }, gutter, code);
    head.append(this.findBox(code, body));
    this.viewer.replaceChildren(head, body);
    if (shown.length < 300000) {
      const nodes = await this.host.highlight(shown, languageOf(url));
      if (nodes && this.selected === url) code.replaceChildren(...nodes);
    }
    if (line) {
      const lineHeight = Number.parseFloat(getComputedStyle(code).lineHeight) || 18;
      body.scrollTop = Math.max(0, (line - 5) * lineHeight);
      const mark = h("div", {
        class: "dt-src-mark",
        style: { top: `${(line - 1) * lineHeight}px` },
      });
      body.append(mark);
    }
  }

  /**
   * Find in the shown file (D146): matches are marked with the CSS Custom Highlight API (the
   * colored code stays as it is), Enter / Shift+Enter go through them, Ctrl+F focuses the box.
   */
  private findBox(code: HTMLElement, body: HTMLElement): HTMLElement {
    this.findStore.clear();
    const input = h("input", {
      class: "input dt-filter dt-src-find",
      type: "search",
      placeholder: "Find in file",
      spellcheck: "false",
      "aria-label": "Find in file",
    });
    const count = h("span", { class: "dt-note" });
    const registry = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS
      ?.highlights;
    const HighlightCtor = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    let ranges: Range[] = [];
    let at = -1;
    const clear = () => {
      registry?.delete("dt-find");
      registry?.delete("dt-find-current");
    };
    const search = () => {
      ranges = [];
      at = -1;
      clear();
      const q = input.value.toLowerCase();
      if (!q) {
        count.textContent = "";
        return;
      }
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      // The text nodes of the colored code, as one string with their offsets.
      const nodes: { node: Text; start: number }[] = [];
      let text = "";
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        nodes.push({ node: n as Text, start: text.length });
        text += (n as Text).data;
      }
      const lower = text.toLowerCase();
      const at0 = (offset: number) => {
        let lo = 0;
        let hi = nodes.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if ((nodes[mid]?.start ?? 0) <= offset) lo = mid;
          else hi = mid - 1;
        }
        const n = nodes[lo];
        return n ? { node: n.node, offset: offset - n.start } : null;
      };
      for (
        let i = lower.indexOf(q);
        i >= 0 && ranges.length < 5000;
        i = lower.indexOf(q, i + q.length)
      ) {
        const a = at0(i);
        const b = at0(i + q.length);
        if (!a || !b) continue;
        const r = document.createRange();
        r.setStart(a.node, a.offset);
        r.setEnd(b.node, Math.min(b.offset, b.node.length));
        ranges.push(r);
      }
      if (registry && HighlightCtor) registry.set("dt-find", new HighlightCtor(...ranges));
      count.textContent = ranges.length ? `${ranges.length} found` : "No matches";
    };
    const go = (step: 1 | -1) => {
      if (!ranges.length) search();
      if (!ranges.length) return;
      at = (at + step + ranges.length) % ranges.length;
      const r = ranges[at];
      if (!r) return;
      if (registry && HighlightCtor) registry.set("dt-find-current", new HighlightCtor(r));
      count.textContent = `${at + 1} of ${ranges.length}`;
      const box = r.getBoundingClientRect();
      const view = body.getBoundingClientRect();
      if (box.top < view.top || box.bottom > view.bottom)
        body.scrollTop += box.top - view.top - view.height / 3;
    };
    let timer = 0;
    this.findStore.add(
      on(input, "input", () => {
        clearTimeout(timer);
        timer = window.setTimeout(search, 120);
      }),
    );
    this.findStore.add(
      on(input, "keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          go(e.shiftKey ? -1 : 1);
        } else if (e.key === "Escape") {
          input.value = "";
          search();
        }
      }),
    );
    this.findStore.add(
      on(body, "keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
          e.preventDefault();
          input.focus();
          input.select();
        }
      }),
    );
    body.tabIndex = 0;
    this.findStore.add({
      dispose: () => {
        clearTimeout(timer);
        clear();
      },
    });
    return h("span", { class: "dt-src-findbar" }, input, count);
  }

  dispose(): void {
    this.findStore.dispose();
    this.store.dispose();
  }
}
