// suggest_extension (D314, core in core/agent/extensionSuggest.ts): the agent looks up Open VSX
// extensions for a capability the task needs and shows them as an install card (view/toolCards.ts);
// the user installs from the card (agent.installSuggestedExtension, a user click running
// extensions.installFromStore), so the agent never installs on its own. The card's data goes in
// the call's detail. Searching goes straight to the store (not extensions.searchStore), so the
// Extensions view's results aren't replaced by the agent's search.

import {
  type ExtensionSuggestion,
  MAX_SUGGESTED,
  type SuggestedExtension,
  suggestionRefusal,
  suggestionResult,
} from "../../core/agent/extensionSuggest";
import { parseStoreSearch, type StoreItem } from "../../core/extensions/openVsx";
import { extIpc } from "../../core/ipc/extensions";
import { storeDetailsOf, storeEnabled } from "../extensions/store";
import type { AgentTool } from "./tools";

/** Installed extensions' versions by lowercase id. */
async function installedVersions(
  host: Parameters<AgentTool["run"]>[1],
): Promise<Map<string, string>> {
  const r = (await host.services.dispatcher.execute("extensions.list", {}).catch(() => null)) as {
    extensions?: { id: string; version: string | null }[];
  } | null;
  return new Map((r?.extensions ?? []).map((e) => [e.id.toLowerCase(), e.version ?? "?"]));
}

function suggested(
  i: StoreItem & { publisher?: string },
  installed: Map<string, string>,
): SuggestedExtension {
  const version = installed.get(i.id.toLowerCase());
  return {
    id: i.id,
    displayName: i.displayName || i.name,
    publisher: i.publisher || i.namespace,
    description: i.description,
    ...(i.verified && { verified: true }),
    ...(i.iconUrl && { iconUrl: i.iconUrl }),
    ...(version && { installed: version }),
  };
}

export const SUGGEST_EXTENSION_TOOL: AgentTool = {
  spec: {
    name: "suggest_extension",
    description:
      "Show the user Open VSX extensions they can install, as a card with an Install button (they install it; you don't). Use it only when the task needs a capability an extension gives (a language's highlighting or language server, a debugger, a linter or formatter integration) and nothing installed covers it; at most once per conversation unless the user takes it up. Give a search query, or the ids (namespace.name) to show; up to 3 are shown. Don't describe them in your answer: the card does.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: 'Words to search Open VSX for, e.g. "prisma"' },
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Specific extensions (namespace.name) instead of a search",
        },
        reason: {
          type: "string",
          description: "One line on what it adds for this task, shown on the card",
        },
      },
      required: ["reason"],
    },
  },
  readOnly: true,
  verb: "Suggested extensions",
  target: (a) =>
    Array.isArray(a.ids) && a.ids.length ? a.ids.map(String).join(", ") : String(a.query ?? ""),
  async run(args, host) {
    if (!storeEnabled(host.services))
      return {
        result: "The extension store is off (extensions.store.enabled): nothing to suggest.",
        isError: true,
      };
    const refusal = suggestionRefusal(host.items?.() ?? []);
    if (refusal) return { result: refusal, isError: true };
    const ids = (Array.isArray(args.ids) ? args.ids : [])
      .map((x) => String(x).trim())
      .filter((x) => /^[^.\s]+\.[^\s]+$/.test(x))
      .slice(0, MAX_SUGGESTED);
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!ids.length && !query)
      return {
        result: 'Error: give a query (e.g. "prisma") or ids (namespace.name).',
        isError: true,
      };
    let found: (StoreItem & { publisher?: string })[];
    try {
      found = ids.length
        ? (await Promise.all(ids.map((id) => storeDetailsOf(id).catch(() => null)))).filter(
            (d): d is NonNullable<typeof d> => d !== null,
          )
        : parseStoreSearch(await extIpc.storeSearch(query, { size: MAX_SUGGESTED * 2 })).items;
    } catch (err) {
      return {
        result: `Error: Open VSX didn't answer (${err instanceof Error ? err.message : String(err)}).`,
        isError: true,
      };
    }
    if (!found.length)
      return {
        result: `Nothing on Open VSX for ${ids.length ? ids.join(", ") : `"${query}"`}. Don't suggest one; go on without it.`,
        isError: true,
      };
    const installed = await installedVersions(host);
    const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 200) : "";
    const card: ExtensionSuggestion = {
      ...(reason && { reason }),
      items: found.slice(0, MAX_SUGGESTED).map((i) => suggested(i, installed)),
    };
    return {
      result: suggestionResult(card),
      summary: card.items.map((i) => i.displayName).join(", "),
      detail: JSON.stringify(card),
    };
  },
};
