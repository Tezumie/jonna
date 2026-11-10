// Web search for the agent (D200): `web.search` (network effect: an agent asks first, like
// web.fetch), the agent's `web_search` tool, `agent.setupWebSearch` (provider, key or address)
// and `@web search <words>` mentions. The provider is agent.webSearch.provider (off by default);
// Brave, Tavily and Exa keys live in the secrets file and are read by Rust, which makes the
// request. With no provider the tool answers with how to set one up.

import { QUESTION_FETCH_CHARS } from "../../core/agent/webQuestion";
import {
  capResults,
  domainList,
  filterByDomains,
  formatResults,
  providerInfo,
  searchPlan,
  setupMessage,
  WEB_SEARCH_PROVIDERS,
  type WebSearchMode,
  type WebSearchResult,
  webMentionKind,
  webSearchKeyId,
} from "../../core/agent/webSearch";
import { aiIpc } from "../../core/ipc/agent";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { registerMentionSource } from "./composerExtras";
import type { AgentTool } from "./tools";
import { fetchPage } from "./webFetch";
import { answerFromPage } from "./webFetchQuestion";

const settingKey = "agent.webSearch.provider";

/** Whether a search can run now, or the message saying what's missing. */
async function readiness(
  services: WorkbenchServices,
): Promise<{ ok: true; provider: string; url?: string } | { ok: false; message: string }> {
  const provider = services.settings.peek<string>(settingKey) ?? "off";
  const info = providerInfo(provider);
  if (!info) return { ok: false, message: setupMessage("off") };
  if (info.key) {
    const has = await aiIpc.hasKey(webSearchKeyId(provider)).catch(() => false);
    return has ? { ok: true, provider } : { ok: false, message: setupMessage(provider, "key") };
  }
  const url = services.settings.peek<string>("agent.webSearch.searxngUrl")?.trim() ?? "";
  return url ? { ok: true, provider, url } : { ok: false, message: setupMessage(provider, "url") };
}

const maxResults = (services: WorkbenchServices, count?: number) =>
  Math.max(
    1,
    Math.min(20, count ?? services.settings.peek<number>("agent.webSearch.maxResults") ?? 8),
  );

interface SearchArgs {
  query: string;
  count: number;
  allowed?: readonly string[];
  blocked?: readonly string[];
  mode?: WebSearchMode;
}

/** One search (D320: domains and extended mode as `searchPlan` says for the provider). */
async function search(
  provider: string,
  args: SearchArgs,
  url?: string,
): Promise<{ results: WebSearchResult[]; pages: PageExcerpt[] }> {
  const allowed = args.allowed ?? [];
  const blocked = args.blocked ?? [];
  const plan = searchPlan(
    provider,
    args.query,
    args.count,
    allowed,
    blocked,
    args.mode ?? "standard",
  );
  const raw = await aiIpc.webSearch(provider, plan.query, plan.ask, url, plan.options);
  const results = capResults(filterByDomains(raw, allowed, blocked), plan.keep);
  return { results, pages: await readTopPages(results.slice(0, plan.readPages)) };
}

type PageExcerpt = { url: string; title?: string; text: string };

/** An extended search reads its top results' pages (a short excerpt each; one that fails is left out). */
async function readTopPages(results: readonly WebSearchResult[]): Promise<PageExcerpt[]> {
  const read = await Promise.all(
    results.map((r) =>
      fetchPage(r.url, 3000).then(
        (p): PageExcerpt | null =>
          p.text ? { url: p.url, ...(p.title && { title: p.title }), text: p.text } : null,
        () => null,
      ),
    ),
  );
  return read.filter((p): p is PageExcerpt => p !== null);
}

/** The context an `@web search <words>` mention sends with the message. */
async function searchMentionContext(services: WorkbenchServices, query: string): Promise<string> {
  const ready = await readiness(services);
  if (!ready.ok) return `Web search for "${query}" (not set up: ${ready.message})`;
  try {
    const { results } = await search(
      ready.provider,
      { query, count: maxResults(services) },
      ready.url,
    );
    return formatResults(query, results);
  } catch (err) {
    return `Web search for "${query}" failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export function webSearchTool(): AgentTool {
  return {
    spec: {
      name: "web_search",
      description:
        'Search the web (the provider the user set up): returns titles, addresses and short snippets. Then read a page with web_fetch. For current docs, error messages, release notes, libraries. `allowed_domains` keeps results to those sites, `blocked_domains` leaves sites out. `mode` "extended" searches harder and reads the top pages: slower and several times the cost, for when a standard search falls short. After answering from the results, end with a "Sources:" list of the URLs you used, as Markdown links. The user may have to approve it.',
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for" },
          count: { type: "integer", description: "How many results (default 8, at most 20)" },
          allowed_domains: {
            type: "array",
            items: { type: "string" },
            description: "Only results from these domains (and their subdomains)",
          },
          blocked_domains: {
            type: "array",
            items: { type: "string" },
            description: "Never results from these domains",
          },
          mode: {
            type: "string",
            enum: ["standard", "extended"],
            description: "standard (default) or extended",
          },
        },
        required: ["query"],
      },
    },
    readOnly: true,
    verb: "Searched the web",
    target: (a) => String(a.query ?? ""),
    async run(args, host) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return { result: '"query" is required (a string).', isError: true };
      // Not set up: say how, without asking the user to approve a search that can't run.
      const ready = await readiness(host.services);
      if (!ready.ok) return { result: ready.message, summary: "not set up" };
      const count = typeof args.count === "number" ? Math.floor(args.count) : undefined;
      const allowedDomains = domainList(args.allowed_domains);
      const blockedDomains = domainList(args.blocked_domains);
      const extended = args.mode === "extended";
      const r = (await host.services.dispatcher.execute(
        "web.search",
        {
          query,
          ...(count && { count }),
          ...(allowedDomains.length && { allowedDomains }),
          ...(blockedDomains.length && { blockedDomains }),
          ...(extended && { mode: "extended" }),
        },
        { kind: "agent", session: host.session },
      )) as { results?: WebSearchResult[]; text?: string };
      const results = r.results ?? [];
      return {
        result: r.text ?? formatResults(query, results),
        summary: `${results.length} result${results.length === 1 ? "" : "s"}${extended ? " · extended" : ""}`,
        detail: results.map((x) => `${x.title} — ${x.url}`).join("\n"),
      };
    },
  };
}

/**
 * `web_fetch` (D292): a page's title and main text, as a tool of its own (it was call_command
 * web.fetch, a step models missed). It runs web.fetch as the agent, so the same approval, the
 * same agent.webFetch.enabled switch and the same `WebFetch(domain:…)` rules apply.
 */
export function webFetchTool(): AgentTool {
  return {
    spec: {
      name: "web_fetch",
      description:
        "Read a web page (http/https): its title and main text as Markdown-like text, without scripts, styles or navigation. For documentation, issues, release notes or a page from web_search. With `prompt` (a question about the page), a separate model reads the page and only its answer comes back: use it for big pages when you need one thing from them. `max_chars` caps the text (default 20000). The user may have to approve it.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The page's address" },
          prompt: {
            type: "string",
            description:
              "What to find out from the page; the answer comes back instead of the text",
          },
          max_chars: { type: "integer", description: "At most this much text (500-100000)" },
        },
        required: ["url"],
      },
    },
    readOnly: true,
    verb: "Read the page",
    target: (a) => String(a.url ?? ""),
    async run(args, host, itemId) {
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) return { result: '"url" is required (a string).', isError: true };
      const question = typeof args.prompt === "string" ? args.prompt.trim() : "";
      const max = question
        ? QUESTION_FETCH_CHARS
        : typeof args.max_chars === "number"
          ? Math.min(100000, Math.max(500, Math.floor(args.max_chars)))
          : undefined;
      try {
        const page = (await host.services.dispatcher.execute(
          "web.fetch",
          { url, ...(max && { maxChars: max }) },
          { kind: "agent", session: host.session },
        )) as { url: string; title?: string; text?: string; truncated?: boolean };
        // A question (D321): the page goes to a model, the answer comes back.
        if (question)
          return await answerFromPage(
            host,
            itemId,
            {
              url: page.url,
              ...(page.title && { title: page.title }),
              text: page.text ?? "",
              ...(page.truncated && { truncated: true }),
            },
            question,
          );
        const text = page.text || "(no text)";
        return {
          result: `${page.url}${page.title ? ` — ${page.title}` : ""}\n\n${text}`,
          summary: page.title || page.url,
        };
      } catch (err) {
        return {
          result: `Couldn't read ${url}: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
          summary: "failed",
        };
      }
    },
  };
}

export function registerWebSearch(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, quickInput, settings } = services;
  sub.add(
    dispatcher.register({
      id: "web.search",
      title: "Search the web",
      category: "Agent",
      description:
        "Searches the web with the provider set in agent.webSearch.provider (Brave Search, Tavily, Exa or a SearXNG address) and returns up to `count` results (title, url, snippet; default agent.webSearch.maxResults). `allowedDomains` / `blockedDomains` keep results to or away from sites; `mode: extended` asks for more results (Tavily's advanced depth) and reads the top three pages. When no provider is set up it returns `setup` with how to do it instead. Read a result with web.fetch.",
      input: s.object({
        query: s.string().describe("What to search for"),
        count: s.integer({ min: 1, max: 20 }).optional(),
        allowedDomains: s.array(s.string()).describe("Only results from these domains").optional(),
        blockedDomains: s.array(s.string()).describe("No results from these domains").optional(),
        mode: s.enum(["standard", "extended"] as const).optional(),
      }),
      effects: ["read", "network"],
      agent: "discoverable",
      palette: false,
      run: async ({ query, count, allowedDomains, blockedDomains, mode }, ctx) => {
        // The agent's web access off (agent.webFetch.enabled, D179) covers searching too.
        if (
          (ctx.caller.kind === "agent" || ctx.caller.kind === "acp") &&
          settings.peek<boolean>("agent.webFetch.enabled") === false
        )
          throw new Error("Web access is turned off for the agent (agent.webFetch.enabled).");
        const ready = await readiness(services);
        if (!ready.ok) return { results: [], setup: ready.message, text: ready.message };
        const { results, pages } = await search(
          ready.provider,
          {
            query,
            count: maxResults(services, count),
            allowed: domainList(allowedDomains),
            blocked: domainList(blockedDomains),
            mode: mode ?? "standard",
          },
          ready.url,
        );
        return {
          provider: ready.provider,
          results,
          ...(pages.length && { pagesRead: pages.length }),
          text: formatResults(query, results, pages),
        };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.setupWebSearch",
      title: "Set up web search",
      category: "Agent",
      description:
        "Chooses the agent's web search provider (agent.webSearch.provider): brave, tavily or exa (asks for the API key in a hidden box and stores it on this computer; it's never shown to the agent), searxng (a self-hosted address, `url`), or off. Without `provider`, shows a picker.",
      input: s.object({
        provider: s.enum(["off", "brave", "tavily", "exa", "searxng"] as const).optional(),
        url: s.string().describe("searxng: the instance's address").optional(),
        forgetKey: s.boolean().describe("Remove the stored key for `provider`").optional(),
      }),
      effects: ["write"],
      agent: "hidden",
      run: async ({ provider, url, forgetKey }) => {
        let chosen: string | undefined = provider;
        if (!chosen) {
          const current = settings.peek<string>(settingKey) ?? "off";
          const picked = await quickInput.pick(
            [
              ...WEB_SEARCH_PROVIDERS.map((p) => ({
                id: p.id,
                label: p.label,
                description: `${p.key ? "API key" : "address, no key"}${p.id === current ? " · in use" : ""}`,
                detail: p.signup,
              })),
              {
                id: "off",
                label: "Off",
                description: current === "off" ? "in use" : "the agent can't search",
              },
            ],
            { placeholder: "Web search provider for the agent" },
          );
          if (!picked) return { provider: current, changed: false };
          chosen = picked.id;
        }
        const info = providerInfo(chosen);
        if (info && forgetKey) {
          await aiIpc.setKey(webSearchKeyId(chosen), null);
          return { provider: chosen, keyForgotten: true };
        }
        if (info?.key) {
          const id = webSearchKeyId(chosen);
          const has = await aiIpc.hasKey(id).catch(() => false);
          const key = await quickInput.prompt({
            prompt: `${info.label} API key (stored on this computer, never shown to the agent)${has ? "; leave empty to keep the stored one" : ""}`,
            placeholder: info.signup,
            password: true,
          });
          if (key === undefined)
            return { provider: settings.peek<string>(settingKey) ?? "off", changed: false };
          if (key.trim()) await aiIpc.setKey(id, key.trim());
          else if (!has)
            return { provider: settings.peek<string>(settingKey) ?? "off", changed: false };
        } else if (info) {
          let address = url?.trim();
          if (!address) {
            const typed = await quickInput.prompt({
              prompt: "SearXNG address (its json format must be on in settings.yml)",
              placeholder: "http://localhost:8080",
              value: settings.peek<string>("agent.webSearch.searxngUrl") ?? "",
              validate: (v) =>
                /^https?:\/\/\S+$/i.test(v.trim()) ? undefined : "Type an http(s) address.",
            });
            if (!typed)
              return { provider: settings.peek<string>(settingKey) ?? "off", changed: false };
            address = typed.trim();
          }
          if (!/^https?:\/\/\S+$/i.test(address)) throw new Error("The address must be http(s).");
          await settings.update("agent.webSearch.searxngUrl", address, "user");
        }
        await settings.update(settingKey, chosen, "user");
        return { provider: chosen, changed: true };
      },
    }),
  );

  // `@web search <words>` (and "@web <words>" that isn't an address, typed in the picker).
  sub.add(
    registerMentionSource({
      prefix: "@web search ",
      icon: "search",
      items: (query) => {
        const m = /^@?(web|search)\s+(.+)$/i.exec(query.trim());
        const kind = m?.[2]
          ? webMentionKind(m[1]?.toLowerCase() === "search" ? `search ${m[2]}` : m[2])
          : null;
        if (kind?.kind !== "search") return [];
        return [
          {
            id: `@web search ${kind.query}`,
            label: `Search the web for "${kind.query}"`,
            description:
              (settings.peek<string>(settingKey) ?? "off") === "off"
                ? "Web search isn't set up (Agent: Set up web search)"
                : "The results go with the message",
            icon: "search",
          },
        ];
      },
      label: (mention) => `Search: ${mention.slice("@web search ".length)}`,
      context: (mention) => searchMentionContext(services, mention.slice("@web search ".length)),
    }),
  );
}
