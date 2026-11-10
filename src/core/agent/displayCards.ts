// Cards in the chat from the agent's display tools (D171, D172): like Claude's widgets, ChatGPT's
// Apps SDK and MCP Apps, link / file cards and a question to click come from a tool call with
// JSON arguments, drawn beside the answer; the answer stays plain Markdown, so copying it gives
// what you'd paste anywhere. Charts and diagrams are ```mermaid in the answer itself (the one
// widely used fenced format, drawn by the Markdown renderer). suggest_extension's card draws from
// its call's detail (core/agent/extensionSuggest.ts), not from its arguments. DOM-free and tested.

import { type AskCard, parseAskUser } from "./askUser";
import { type FindingsCard, parseFindings } from "./findings";

export type DisplayCard =
  | { kind: "links"; items: { title: string; url: string; note?: string; file?: boolean }[] }
  /** ask_user's questions (D312): one to four, each with its options. */
  | AskCard
  /** report_findings' review findings (D313). */
  | FindingsCard;

/** The tools whose calls are drawn as a card in the conversation, not a row in the work group. */
export const DISPLAY_TOOL_NAMES = new Set([
  "show_links",
  "ask_user",
  "report_findings",
  "suggest_extension",
  // D342, D343: drawn from their calls' detail (extensions/agent/view/discoveryCards.ts).
  "suggest_skill",
  "suggest_mcp_server",
  "mcp_status",
  // D350: suggest_sandbox_allowance (extensions/agent/view/sandboxCard.ts).
  "suggest_sandbox_allowance",
  // An inline widget (D334): its card is view/widgetCard.ts.
  "show_widget",
]);

const MAX_LINKS = 12;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** The card a display tool's arguments describe; null when they don't (the call is an error). */
export function cardFromTool(name: string, args: unknown): DisplayCard | null {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  switch (name) {
    case "show_links": {
      const items = (Array.isArray(a.items) ? (a.items as unknown[]) : [])
        .map((raw) => {
          const it = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
          const url = text(it.url);
          const path = text(it.path);
          const line = typeof it.line === "number" && it.line > 0 ? Math.floor(it.line) : undefined;
          const note = text(it.note);
          if (/^https?:\/\/\S+$/.test(url))
            return { title: text(it.title) || hostOf(url), url, ...(note && { note }) };
          if (path) {
            const target = line ? `${path}:${line}` : path;
            return {
              title: text(it.title) || target,
              url: target,
              file: true,
              ...(note && { note }),
            };
          }
          return null;
        })
        .filter((x) => x !== null);
      return items.length ? { kind: "links", items: items.slice(0, MAX_LINKS) } : null;
    }
    case "ask_user": {
      const card = parseAskUser(args);
      return "error" in card ? null : card;
    }
    case "report_findings": {
      const card = parseFindings(args);
      return "error" in card ? null : card;
    }
    default:
      return null;
  }
}
