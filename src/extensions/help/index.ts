// Built-in Help (D133): the user guide in a Documentation tab (Help → Documentation), and the
// same pages for agents (`help.readDocs`), so "how do I…" questions get answers from the guide.
// D204: Report a problem, the session log, starting with extensions off, and What's new.
import type { BuiltinExtension } from "../../core/extensions/index";
import { product } from "../../core/product";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { DocsView, docsViewDescriptor } from "./docsView";
import { ErrorCapture } from "./errorCapture";
import manifest from "./extension.json";
import { registerOutput } from "./outputCommands";
import { docPages, findPage } from "./pages";
import { registerReleaseNotes } from "./releaseNotes";
import { registerReportCommands } from "./reportCommands";
import { registerSafeMode } from "./safeMode";

export const helpExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dispatcher, dock } = services;
    // The session log's frontend side first, so later activation errors are in it (D204).
    const capture = sub.add(new ErrorCapture(services));
    capture.install(window);
    registerReportCommands(sub, services, capture);
    // Output channels, log.level, the Output tab (D209).
    registerOutput(sub, services);
    registerSafeMode(sub, services);
    registerReleaseNotes(sub, services);
    sub.add(dock.views.register(docsViewDescriptor(services)));
    const pages = docPages(product.nameShort);

    sub.add(
      dispatcher.register({
        id: "help.showDocs",
        title: "Documentation",
        category: "Help",
        description:
          "Opens the user guide in a tab, optionally on a page (e.g. 'quick-access', 'agent', 'git').",
        input: s.object({ page: s.string().describe("Page name or title").optional() }),
        effects: [],
        agent: "discoverable",
        run: ({ page }) => {
          const target = page ? findPage(pages, page) : undefined;
          if (page && !target)
            throw new Error(`No page "${page}" (${pages.map((p) => p.title).join(", ")}).`);
          const tabId = dock.openView("docs", target ? { page: target.id } : null, "main", true);
          const ref = dock.findTab(tabId);
          const tab = ref?.group.tabs[ref.index];
          const view = tab ? dock.view(tab) : undefined;
          if (target && view instanceof DocsView) view.show(target.id);
          return { tabId, page: target?.id ?? null };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "help.readDocs",
        title: "Read the user guide",
        category: "Help",
        description:
          "The IDE's user guide for answering how-to questions: without `page`, the list of pages; with it, that page's Markdown.",
        input: s.object({ page: s.string().describe("Page name or title").optional() }),
        effects: ["read"],
        agent: "discoverable",
        palette: false,
        run: ({ page }) => {
          if (!page) return { pages: pages.map((p) => ({ id: p.id, title: p.title })) };
          const found = findPage(pages, page);
          if (!found) throw new Error(`No page "${page}".`);
          return { id: found.id, title: found.title, markdown: found.text };
        },
      }),
    );
  },
};
