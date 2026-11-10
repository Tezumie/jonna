// The Documentation tab (D133): the bundled user guide with its pages on the left. Links: other
// pages ("02-quick-access.md"), anchors ("#models"), web pages (the system browser) and
// `command:<id>` links that run an IDE command, like VS Code's command links in Markdown.
import type { Json } from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { openerIpc } from "../../core/ipc/system";
import { DisposableStore } from "../../core/lifecycle/index";
import { product } from "../../core/product";
import { markdownNodes } from "../../ui/markdown/render";
import type { DockView, DockViewContext, DockViewDescriptor } from "../../workbench/dock/views";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
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

export class DocsView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly pages: DocPage[] = docPages(product.nameShort);
  private readonly nav: HTMLElement;
  private readonly body: HTMLElement;
  private page: DocPage;

  constructor(
    private readonly services: WorkbenchServices,
    state: Json,
    private readonly ctx: DockViewContext,
  ) {
    const first = this.pages[0] as DocPage;
    const wanted = stateField(state, "page");
    this.page = (typeof wanted === "string" && findPage(this.pages, wanted)) || first;
    this.nav = h("nav", { class: "docs-nav", "aria-label": "Pages" });
    this.body = h("div", { class: "docs-body" });
    this.element = h(
      "div",
      { class: "docs-view", tabindex: "-1" },
      this.nav,
      h("div", { class: "docs-scroll" }, this.body),
    );
    this.render();
  }

  /** Shows `page` (an id, short name or title), optionally at a heading. */
  show(page: string, anchor?: string): boolean {
    const found = findPage(this.pages, page);
    if (!found) return false;
    this.page = found;
    this.ctx.updateState({ page: found.id });
    this.render();
    if (anchor) this.scrollTo(anchor);
    return true;
  }

  private render(): void {
    this.nav.replaceChildren(
      ...this.pages.map((p) => {
        const b = h(
          "button",
          { class: { "docs-nav-item": true, "is-active": p === this.page }, type: "button" },
          p.title,
        );
        on(b, "click", () => this.show(p.id));
        return b;
      }),
    );
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
    );
    const scroller = this.body.parentElement;
    if (scroller) scroller.scrollTop = 0;
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
    return { page: this.page.id };
  }

  dispose(): void {
    this.store.dispose();
  }
}
