// Web pages as agent context (D130): `web.fetch` (also the agent's way to read a page: it has the
// network effect, so the agent asks first) and the `@web <url>` mention's text.
import { normalizeUrl, pageText, type WebPageText } from "../../core/agent/webText";
import { aiIpc } from "../../core/ipc/agent";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";

export { normalizeUrl };

export async function fetchPage(
  url: string,
  maxChars = 40000,
): Promise<WebPageText & { status: number }> {
  const page = await aiIpc.webFetch(normalizeUrl(url));
  if (page.status >= 400) throw new Error(`${page.url} answered ${page.status}.`);
  return { ...pageText(page, maxChars), status: page.status };
}

/** The context a `@web <url>` mention sends with the message. */
export async function webMentionContext(url: string): Promise<string> {
  try {
    const page = await fetchPage(url, 30000);
    return `Web page ${page.url}${page.title ? ` — ${page.title}` : ""}:\n\n${page.text || "(no text)"}`;
  } catch (err) {
    return `Web page ${url} (couldn't be fetched: ${err instanceof Error ? err.message : String(err)})`;
  }
}

export function registerWebFetch(sub: DisposableStore, services: WorkbenchServices): void {
  sub.add(
    services.dispatcher.register({
      id: "web.fetch",
      title: "Fetch a web page",
      category: "Agent",
      description:
        "Downloads a web page (http/https) and returns its title and main text as Markdown-like text (no scripts, styles or navigation), for reading documentation, issues or articles. `maxChars` caps the text (default 20000).",
      input: s.object({
        url: s.string().describe("The page's address"),
        maxChars: s.integer({ min: 500, max: 100000 }).optional(),
      }),
      effects: ["read", "network"],
      agent: "discoverable",
      palette: false,
      run: async ({ url, maxChars }, ctx) => {
        // agent.webFetch.enabled (D179): the agent's web reading can be turned off; the user's
        // own @web mentions still work.
        if (
          (ctx.caller.kind === "agent" || ctx.caller.kind === "acp") &&
          services.settings.peek<boolean>("agent.webFetch.enabled") === false
        )
          throw new Error(
            "Reading web pages is turned off for the agent (agent.webFetch.enabled).",
          );
        return fetchPage(url, maxChars ?? 20000);
      },
    }),
  );
}
