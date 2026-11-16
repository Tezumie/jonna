// The Documentation tab (D133, on the Settings tab's frame since D439): the bundled user guide
// with a search box and its pages on the left, the open page's sections under its name, and
// the page (or what a search found) beside them. Links: other pages ("02-quick-access.md"),
// anchors ("#models"), web pages (the system browser) and `command:<id>` links that run an IDE
// command, like VS Code's command links in Markdown.
import type { Json } from "../../core/dock/index";
import { type Child, h, on } from "../../core/dom/index";
import { openerIpc } from "../../core/ipc/system";
import { DisposableStore } from "../../core/lifecycle/index";
import { product } from "../../core/product";
import { type IconName, icon } from "../../ui/Icon";
import { markdownNodes } from "../../ui/markdown/render";
import { setTooltip } from "../../ui/Tooltip";
import type { DockView, DockViewContext, DockViewDescriptor } from "../../workbench/dock/views";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { type DocHit, type DocSection, pageSections, searchDocs } from "./docsSearch";
import { type DocPage, docPages, findPage } from "./pages";

export function docsViewDescriptor(services: WorkbenchServices): DockViewDescriptor {
  return {
    type: "docs",
    title: () => "Documentation",
    icon: () => "book-open",
    singleton: true,
    defaultPlacement: "main",
    editorLike: true,
    create: (state, ctx) => new DocsView(services, state, ctx),
  };
}

/** Each page's icon in the navigation (and all there is of it when the navigation is a rail). */
const PAGE_ICONS: Record<string, IconName> = {
  "01-getting-started.md": "play",
  "02-quick-access.md": "zap",
  "03-user-interface.md": "layout-dashboard",
  "04-editing.md": "pencil",
  "05-agent.md": "bot",
  "06-agents-channels.md": "users",
  "07-agent-customize.md": "sliders-horizontal",
  "08-git.md": "git-branch",
  "09-search.md": "search",
  "10-terminal.md": "square-terminal",
  "11-browser.md": "globe",
  "12-tasks.md": "list-checks",
  "13-debugging.md": "bug-play",
  "14-testing.md": "flask-conical",
  "15-notebooks.md": "notebook",
  "16-settings-themes.md": "settings",
  "17-keyboard-shortcuts.md": "keyboard",
  "18-extensions.md": "puzzle",
  "19-remote.md": "server",
  "20-workspaces.md": "folder-open",
  "21-troubleshooting.md": "message-circle-question",
  "23-sync.md": "refresh-cw",
};

/** The pages that open a group in the navigation (a line above them). */
const GROUP_STARTS = new Set(["04-editing.md", "08-git.md", "16-settings-themes.md"]);

/** Typing settles before the guide is searched. */
const QUERY_DEBOUNCE_MS = 120;

export class DocsView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  /** Listeners of what is drawn now; emptied before each redraw. */
  private readonly drawn = this.store.add(new DisposableStore());
  private readonly pages: DocPage[] = docPages(product.nameShort);
  /** Each page's sections, cut once: the navigation's contents and what a search reads. */
  private readonly sections: DocSection[] = this.pages.flatMap(pageSections);
  private readonly navItems: HTMLElement;
  private readonly body: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly searches: HTMLInputElement[];
  private page: DocPage;
  private query = "";
  /** Whether the search's results are on show (a result opened shows its page instead). */
  private searching = false;
  private queryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly services: WorkbenchServices,
    state: Json,
    private readonly ctx: DockViewContext,
  ) {
    const first = this.pages[0] as DocPage;
    const wanted = stateField(state, "page");
    this.page = (typeof wanted === "string" && findPage(this.pages, wanted)) || first;

    const searchBox = (where: string) => {
      const input = h("input", {
        class: "input settings-search-input",
        type: "search",
        placeholder: "Search the guide",
        spellcheck: "false",
        "aria-label": "Search the guide",
      });
      this.store.add(
        on(input, "input", () => {
          for (const other of this.searches) if (other !== input) other.value = input.value;
          clearTimeout(this.queryTimer);
          this.queryTimer = setTimeout(() => this.search(input.value, false), QUERY_DEBOUNCE_MS);
        }),
      );
      this.store.add(
        on(input, "keydown", (event) => {
          if (event.key === "Enter") {
            // The best match, without reaching for the mouse.
            clearTimeout(this.queryTimer);
            this.search(input.value, false);
            const [best] = this.hits();
            if (best) this.open(best.section);
          } else if (event.key === "Escape" && input.value !== "") {
            event.stopPropagation();
            clearTimeout(this.queryTimer);
            this.search("");
          }
        }),
      );
      return {
        input,
        element: h("div", { class: `settings-search ${where}` }, icon("search"), input),
      };
    };
    const navSearch = searchBox("is-nav");
    const headerSearch = searchBox("is-header");
    this.searches = [navSearch.input, headerSearch.input];
    this.store.add({ dispose: () => clearTimeout(this.queryTimer) });

    this.navItems = h("div", { class: "settings-nav-items" });
    this.body = h("div", { class: "docs-body" });
    this.scroller = h("div", { class: "settings-scroll docs-scroll" }, this.body);
    this.element = h(
      "div",
      { class: "settings-view docs-guide", tabindex: "-1" },
      h(
        "div",
        { class: "settings-layout" },
        h(
          "nav",
          { class: "settings-nav docs-nav", "aria-label": "Pages" },
          navSearch.element,
          this.navItems,
        ),
        h("div", { class: "settings-main" }, headerSearch.element, this.scroller),
      ),
    );
    // The arrows move along the pages; Enter and Space open one (a button's own).
    this.store.add(
      on(this.navItems, "keydown", (event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const items = [...this.navItems.querySelectorAll<HTMLElement>(".settings-nav-item")];
        const at = items.indexOf(event.target as HTMLElement);
        const to = items[at + (event.key === "ArrowDown" ? 1 : -1)];
        if (at < 0 || !to) return;
        event.preventDefault();
        to.focus();
      }),
    );
    const query = stateField(state, "query");
    if (typeof query === "string" && query.trim() !== "") {
      this.query = query;
      this.searching = true;
      for (const input of this.searches) input.value = query;
    }
    this.render();
  }

  /** Shows `page` (an id, short name or title), optionally at a heading. */
  show(page: string, anchor?: string): boolean {
    const found = findPage(this.pages, page);
    if (!found) return false;
    this.page = found;
    this.searching = false;
    this.save();
    this.render();
    if (anchor) this.scrollTo(anchor);
    return true;
  }

  /**
   * Searches the guide and shows what was found; an empty query shows the open page again.
   * `fill` writes the query into the search boxes (a search asked for by a command).
   */
  search(query: string, fill = true): number {
    this.query = query.trim();
    this.searching = this.query !== "";
    if (fill) for (const input of this.searches) input.value = query;
    this.save();
    this.render();
    return this.searching ? this.hits().length : 0;
  }

  private hits(): DocHit[] {
    return searchDocs(this.sections, this.query);
  }

  private save(): void {
    this.ctx.updateState(this.serialize());
  }

  /** A result opened: its page at its heading. The query stays in the box, to search on. */
  private open(section: DocSection): void {
    this.show(section.page, section.anchor || undefined);
  }

  private render(): void {
    this.drawn.clear();
    this.drawNav();
    if (this.searching) this.drawResults();
    else this.drawPage();
    this.scroller.scrollTop = 0;
  }

  private drawNav(): void {
    const out: HTMLElement[] = [];
    for (const p of this.pages) {
      const selected = !this.searching && p === this.page;
      if (GROUP_STARTS.has(p.id))
        out.push(h("div", { class: "settings-nav-separator", role: "separator" }));
      const el = h(
        "button",
        {
          class: {
            "settings-nav-item": true,
            "docs-nav-item": true,
            "is-selected": selected,
            "is-active": selected,
          },
          type: "button",
          "data-page": p.id,
          "aria-label": p.title,
          ...(selected && { "aria-current": "page" }),
        },
        icon(PAGE_ICONS[p.id] ?? "book-open"),
        h("span", { class: "settings-nav-label" }, p.title),
      );
      setTooltip(el, p.title, undefined, { placement: "right" });
      this.drawn.add(on(el, "click", () => this.show(p.id)));
      out.push(el);
      // The open page's sections, as Settings lists a page's: click to go there.
      if (!selected) continue;
      for (const section of this.sections) {
        if (section.page !== p.id || section.level !== 2) continue;
        const sub = h(
          "button",
          { class: "settings-nav-sub", type: "button", title: section.heading },
          section.heading,
        );
        this.drawn.add(on(sub, "click", () => this.scrollTo(section.anchor)));
        out.push(sub);
      }
    }
    this.navItems.replaceChildren(...out);
  }

  private drawPage(): void {
    const at = this.pages.indexOf(this.page);
    const turn = (to: DocPage | undefined, label: string, glyph: IconName): Child => {
      if (!to) return h("span", null);
      const el = h(
        "button",
        { class: `docs-turn${glyph === "arrow-right" ? " is-next" : ""}`, type: "button" },
        h("span", { class: "docs-turn-label" }, label),
        h("span", { class: "docs-turn-title" }, to.title),
      );
      this.drawn.add(on(el, "click", () => this.show(to.id)));
      return el;
    };
    this.body.replaceChildren(
      h(
        "div",
        { class: "md md-document docs-page" },
        ...markdownNodes(this.page.text, {
          headingShift: 0,
          softBreaks: "space",
          openLink: (href) => this.openLink(href),
          copy: (t) =>
            void this.services.dispatcher.execute("ui.copyText", { text: t }).catch(() => {}),
        }),
      ),
      h(
        "nav",
        { class: "docs-turns", "aria-label": "Previous and next page" },
        turn(this.pages[at - 1], "Previous", "arrow-left"),
        turn(this.pages[at + 1], "Next", "arrow-right"),
      ),
    );
  }

  private drawResults(): void {
    const hits = this.hits();
    const rows = hits.map((hit) => {
      const { section, snippet } = hit;
      const words: Child[] = [];
      let from = 0;
      for (const [start, end] of snippet.marks) {
        if (start > from) words.push(snippet.text.slice(from, start));
        words.push(h("mark", { class: "settings-match" }, snippet.text.slice(start, end)));
        from = end;
      }
      if (from < snippet.text.length) words.push(snippet.text.slice(from));
      const el = h(
        "button",
        {
          class: "docs-hit",
          type: "button",
          "data-page": section.page,
          "data-anchor": section.anchor,
        },
        h(
          "span",
          { class: "docs-hit-where" },
          icon(PAGE_ICONS[section.page] ?? "book-open"),
          h("span", { class: "docs-hit-page" }, section.pageTitle),
          section.level > 1 ? icon("chevron-right") : null,
          section.level > 1 ? h("span", { class: "docs-hit-heading" }, section.heading) : null,
        ),
        h("span", { class: "docs-hit-text" }, ...words),
      );
      this.drawn.add(on(el, "click", () => this.open(section)));
      return el;
    });
    const count =
      hits.length === 0
        ? "Nothing found"
        : `${hits.length} ${hits.length === 1 ? "place" : "places"} in the guide`;
    this.body.replaceChildren(
      h(
        "div",
        { class: "docs-results" },
        h(
          "header",
          { class: "docs-results-head" },
          h("h1", { class: "settings-page-title" }, `Search: ${this.query}`),
          h("p", { class: "docs-results-count" }, count),
        ),
        hits.length === 0
          ? h(
              "p",
              { class: "docs-results-empty" },
              "No page of the guide has all of those words. Try fewer words, or another word for the same thing.",
            )
          : h("div", { class: "settings-card docs-hits" }, ...rows),
      ),
    );
  }

  private openLink(href: string): void {
    const run = (id: string, input: unknown = {}) =>
      void this.services.dispatcher.execute(id, input).catch((err: unknown) => {
        this.services.notifications.show("error", err instanceof Error ? err.message : String(err));
      });
    if (href.startsWith("command:")) run(href.slice("command:".length));
    else if (href.startsWith("#")) this.scrollTo(href.slice(1));
    else if (/^https?:\/\//i.test(href)) void openerIpc.openUrl(href).catch(() => {});
    else {
      const [file, anchor] = href.split("#");
      if (file) this.show(file, anchor);
    }
  }

  private scrollTo(anchor: string): void {
    const target = this.body.querySelector(`[id="${CSS.escape(anchor)}"]`);
    target?.scrollIntoView({ block: "start" });
  }

  focus(): void {
    this.element.focus();
  }

  serialize(): Json {
    return this.searching ? { page: this.page.id, query: this.query } : { page: this.page.id };
  }

  dispose(): void {
    this.store.dispose();
  }
}
