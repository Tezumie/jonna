// read_guide (D333): the IDE's user guide for the guide subagent (core/agent/subagents.ts
// BUILTIN_SUBAGENTS "guide", like Claude Code's claude-code-guide agent), and for the agent too.
// The guide's pages are docs/guide/*.md, bundled into the IDE by the help extension (its
// help.readDocs command reads them: no file or network access, so an installed build has them).
// Search ranks their sections (core/agent/guideSearch.ts); `page` returns one whole.

import {
  type GuidePage,
  guideIndexText,
  guideResultText,
  searchGuide,
} from "../../core/agent/guideSearch";
import type { WorkbenchServices } from "../../workbench/services";
import type { AgentTool } from "./tools";

/** The longest page returned whole. */
const PAGE_CHARS = 30_000;

let pagesCache: Promise<GuidePage[]> | null = null;

/** The guide's pages through help.readDocs (bundled with the IDE; read once). */
function guidePages(services: WorkbenchServices): Promise<GuidePage[]> {
  pagesCache ??= (async () => {
    const list = (await services.dispatcher.execute<{ pages?: { id: string; title: string }[] }>(
      "help.readDocs",
      {},
    )) ?? { pages: [] };
    const pages: GuidePage[] = [];
    for (const p of list.pages ?? []) {
      const page = await services.dispatcher
        .execute<{ id: string; title: string; markdown: string }>("help.readDocs", { page: p.id })
        .catch(() => null);
      if (page) pages.push({ id: page.id, title: page.title, text: page.markdown });
    }
    return pages;
  })().catch((err: unknown) => {
    pagesCache = null;
    throw err;
  });
  return pagesCache;
}

export function guideTool(services: WorkbenchServices): AgentTool {
  return {
    spec: {
      name: "read_guide",
      description:
        "The IDE's user guide (how to use the IDE itself: features, settings, commands, keys, the agent). `query`: the best matching sections, each with its page to cite; `page`: one page whole; neither: the list of pages.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to look for" },
          page: { type: "string", description: 'A page\'s file name or title ("05-agent.md")' },
        },
        required: [],
      },
    },
    readOnly: true,
    verb: "Read the guide",
    target: (a) => String(a.page ?? a.query ?? ""),
    async run(args) {
      const pages = await guidePages(services).catch(() => []);
      if (!pages.length) return { result: "Error: the user guide isn't available.", isError: true };
      const page = typeof args.page === "string" ? args.page.trim() : "";
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (page) {
        const n = page.toLowerCase().replace(/\.md$/, "");
        const found = pages.find(
          (p) =>
            p.id.toLowerCase().replace(/\.md$/, "") === n ||
            p.id.toLowerCase().replace(/^\d+-|\.md$/g, "") === n ||
            p.title.toLowerCase() === n,
        );
        if (!found)
          return {
            result: `Error: no page "${page}". Pages:\n${guideIndexText(pages)}`,
            isError: true,
          };
        const text =
          found.text.length > PAGE_CHARS
            ? `${found.text.slice(0, PAGE_CHARS)}\n… (cut: search with query for the rest)`
            : found.text;
        return { result: `(page: ${found.id})\n${text}`, summary: found.title };
      }
      if (!query) return { result: `Pages of the guide:\n${guideIndexText(pages)}` };
      const hits = searchGuide(pages, query, 5);
      return {
        result: hits.length
          ? guideResultText(hits, query)
          : `Nothing in the guide matches "${query}". Pages:\n${guideIndexText(pages)}`,
        summary: `${hits.length} section${hits.length === 1 ? "" : "s"}`,
      };
    },
  };
}
