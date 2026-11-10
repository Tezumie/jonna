// The Docs page (D204, dock view `agent.docs`): the documentation sites indexed for @docs, each
// with its state, pages and chunks and when it was read, Refresh / Stop / Remove, and a form to
// add one; pages that need JavaScript are counted on the row (D207). Everything goes through
// commands (agent.addDocs, agent.refreshDocs, agent.removeDocs);
// the service is docs.ts.

import { relativeAge } from "../../core/agent/rooms";
import type { Json } from "../../core/dock/index";
import { h } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { icon } from "../../ui/Icon";
import type { DockView } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { addCustomizeSection, openCustomize } from "./customize";
import type { DocsService } from "./docs";
import {
  addButton,
  cardRow,
  emptyNote,
  field,
  pageButton,
  pageGroup,
  pageHeader,
  pickRowAction,
  runCommand,
  textInput,
} from "./view/pageKit";

/** "· 2 skipped · 1 needs JavaScript (not read)": pages needing JavaScript counted apart (D207). */
function skippedText(skipped: number, needsJs: number): string {
  const other = skipped - needsJs;
  return `${other > 0 ? ` · ${other} skipped` : ""}${needsJs ? ` · ${needsJs} ${needsJs === 1 ? "needs" : "need"} JavaScript (not read)` : ""}`;
}

class DocsView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly render = this.store.add(new DisposableStore());
  private readonly body: HTMLElement;
  /** The Add form is open (Sources' + Add). */
  private adding = false;

  constructor(
    private readonly services: WorkbenchServices,
    private readonly docs: DocsService,
  ) {
    this.body = h("div", { class: "ai-setup docs-page" });
    this.element = h("div", { class: "ai-page", tabindex: "-1" }, this.body);
    this.store.add(
      effect(() => {
        docs.statuses.value;
        services.settings.version.value;
        // An address being typed isn't wiped by a redraw. Only a field counts: the page itself
        // (focused when its tab opens) or a clicked button kept every change from showing.
        const active = this.element.ownerDocument.activeElement;
        if (!(this.element.contains(active) && active?.matches("input, textarea, select")))
          this.draw();
        return undefined;
      }),
    );
  }

  private run(command: string, input: unknown = {}): Promise<unknown> {
    return runCommand(this.services, command, input);
  }

  private draw(): void {
    this.render.clear();
    const st = this.render;
    const rows = this.docs.sources().map((src) => {
      const status = this.docs.status(src.name);
      const detail =
        status.state === "crawling"
          ? `Reading… ${status.progress?.done ?? 0} pages · ${status.progress?.url ?? ""}`
          : status.state === "ready"
            ? `${status.pages} pages · ${status.chunks} passages${status.crawledAt ? ` · read ${relativeAge(status.crawledAt)}` : ""}${skippedText(status.skipped ?? 0, status.needsJavaScript ?? 0)}${status.embeddedWith ? " · searched by meaning" : status.embedError ? " · by words only (embedding failed)" : ""}`
            : status.state === "failed"
              ? `Failed: ${status.error ?? ""}${status.pages ? ` (keeps ${status.pages} pages from before)` : ""}`
              : "Not read yet";
      const refresh =
        status.state === "crawling"
          ? {
              id: "stop",
              label: "Stop reading",
              run: () => this.run("agent.refreshDocs", { name: src.name, stop: true }),
            }
          : {
              id: "refresh",
              label: status.state === "new" ? "Read now" : "Read again",
              run: () => this.run("agent.refreshDocs", { name: src.name }),
            };
      const menu = () =>
        pickRowAction(this.services, `@docs:${src.name}`, [
          refresh,
          {
            id: "remove",
            label: "Remove",
            run: () => this.run("agent.removeDocs", { name: src.name }),
          },
        ]);
      return cardRow(st, {
        attrs: { "data-docs": src.name },
        glyph: icon("library"),
        name: `@docs:${src.name}`,
        badges: [
          status.state === "ready"
            ? "Ready"
            : status.state === "crawling"
              ? "Reading"
              : status.state === "failed"
                ? "Failed"
                : "New",
        ],
        details: [src.url, detail],
        open: menu,
        more: menu,
      });
    });
    const url = textInput("Documentation address", "", "https://example.dev/docs/");
    const name = textInput("Name", "", "Default: from the address");
    const add = pageButton(
      st,
      "Add and read",
      "plus",
      async () => {
        if (!url.value.trim()) return;
        const typed = {
          url: url.value.trim(),
          ...(name.value.trim() && { name: name.value.trim() }),
        };
        url.value = "";
        name.value = "";
        this.adding = false;
        await this.run("agent.addDocs", typed);
      },
      "button button-primary button-sm",
    );
    const cancel = pageButton(st, "Cancel", null, () => {
      this.adding = false;
      this.draw();
    });
    const form = this.adding
      ? h(
          "div",
          { class: "ai-form" },
          h(
            "div",
            { class: "agent-page-grid" },
            field("Address", url, "Its start page: the pages under that folder are read."),
            field("Name", name),
          ),
          h("div", { class: "ai-form-actions" }, add, cancel),
        )
      : null;
    this.body.replaceChildren(
      pageHeader("Docs", null),
      pageGroup(
        "Sources",
        rows.length,
        [
          addButton(
            st,
            "Add",
            () => {
              this.adding = !this.adding;
              this.draw();
              // The new form's field (D407): `url` was the old, detached one.
              if (this.adding) this.body.querySelector<HTMLInputElement>(".ai-form input")?.focus();
            },
            { "data-new": "docs", title: "Add documentation" },
          ),
        ],
        [
          form,
          rows.length
            ? h("div", { class: "mcp-list" }, ...rows)
            : form
              ? null
              : emptyNote("No documentation yet. Add reads a site for @docs."),
        ],
        { "data-group": "sources" },
      ),
    );
  }

  focus(): void {
    this.element.focus();
  }

  serialize(): Json {
    return null;
  }

  dispose(): void {
    this.store.dispose();
  }
}

export function registerDocsPage(
  sub: DisposableStore,
  services: WorkbenchServices,
  docs: DocsService,
): void {
  sub.add(
    addCustomizeSection({
      id: "docs",
      label: "Docs",
      icon: "library",
      detail: "Documentation sites indexed for @docs mentions",
      keywords: "@docs documentation crawl index",
      order: 60,
      page: { create: () => new DocsView(services, docs) },
    }),
  );
  sub.add(
    services.dispatcher.register({
      id: "agent.showDocs",
      title: "Docs for @docs…",
      category: "Agent",
      description:
        "Opens the Docs page: documentation sites indexed for @docs mentions, to add, refresh or remove one.",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: () => {
        void docs.refreshStatuses();
        return openCustomize(services, "docs");
      },
    }),
  );
}
