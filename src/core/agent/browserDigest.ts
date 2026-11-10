// The browser tabs line of the IDE state an agent gets with each message (D365): which pages are
// open and whether their console has errors. A page that's blank because its script threw shows
// nothing to a fetch of its HTML; the console says why, so the agent is told where to look.

/** What ide://browser gives for a tab (the parts used here). */
export interface BrowserTabState {
  tab?: string;
  url?: string;
  title?: string;
  errors?: number;
  warnings?: number;
  recentErrors?: { text: string; source?: string }[];
  failedRequests?: unknown[];
}

/** One line per tab (at most 4), with its latest error; "" with no tab. */
export function browserDigest(tabs: readonly BrowserTabState[]): string {
  const lines = tabs
    .filter((t) => t.url && t.url !== "about:blank")
    .slice(0, 4)
    .map((t) => {
      const title = t.title?.trim() ? ` "${t.title.trim().slice(0, 80)}"` : "";
      const errors = t.errors ?? 0;
      const failed = t.failedRequests?.length ?? 0;
      const counts = [
        errors && `${errors} console error${errors === 1 ? "" : "s"}`,
        failed && `${failed} failed request${failed === 1 ? "" : "s"}`,
      ].filter(Boolean);
      const latest = t.recentErrors?.at(-1)?.text.split("\n")[0]?.trim().slice(0, 200);
      return `- ${t.url}${title}${t.tab ? ` (tab ${t.tab})` : ""}${counts.length ? `: ${counts.join(", ")}` : ""}${latest ? `. Latest: ${latest}` : ""}`;
    });
  if (!lines.length) return "";
  const troubled = tabs.some((t) => (t.errors ?? 0) > 0 || (t.failedRequests?.length ?? 0) > 0);
  return `Browser tabs open in the IDE:\n${lines.join("\n")}${
    troubled ? "\nRead a tab's console and failed requests with browser_console." : ""
  }`;
}
