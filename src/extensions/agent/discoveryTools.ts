// The agent's discovery tools (D342, D343), the IDE's take on Claude Code's SuggestSkills /
// SearchSkills, its MCP registry search (search_mcp_registry, suggest_connectors) and connector
// status: suggest_skill shows skills the user could add as a card; suggest_mcp_server finds MCP
// servers for a need in the built-in gallery and the MCP registry and shows them as a card the
// user adds from (typing any keys there); mcp_status shows the configured servers' state with
// Reconnect. The agent never adds anything itself: the cards' buttons are the user's clicks
// (discoveryCommands.ts). Each card's data is kept in its call's `detail`. Core logic in
// core/agent/skillSuggest.ts and core/mcp/suggest.ts.

import {
  keywordsOf,
  MAX_SUGGESTED_SKILLS,
  noSkillResult,
  type SkillSuggestion,
  skillSuggestionRefusal,
  skillSuggestionResult,
} from "../../core/agent/skillSuggest";
import { MCP_GALLERY } from "../../core/mcp/gallery";
import {
  MAX_SUGGESTED_SERVERS,
  type McpStatusCard,
  type McpSuggestion,
  mcpSuggestionRefusal,
  mcpSuggestionResult,
  type RankedEntry,
  rankServers,
  registryQueries,
  statusResult,
  statusRows,
  suggestedServer,
} from "../../core/mcp/suggest";
import type { WorkbenchServices } from "../../workbench/services";
import { searchRegistry } from "./mcpRegistry";
import { availableSkills } from "./skillCatalog";
import type { AgentTool } from "./tools";

/** The agent's MCP servers as ide://agent/mcp lists them. */
export async function mcpServerRows(services: WorkbenchServices) {
  const snap = await services.state.get("ide://agent/mcp", { budget: 200_000 }).catch(() => null);
  return statusRows(snap?.value);
}

const reasonOf = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 200) : "");

export const SUGGEST_SKILL_TOOL: AgentTool = {
  spec: {
    name: "suggest_skill",
    description:
      "Show the user skills they can add, as a card with Add buttons (they add it; you don't): skills from the IDE's catalog not installed yet, and installed ones they turned off. Call it when the task is one a skill could make repeatable (drafting in a house style, a review against a playbook, a recurring workflow) and no skill you have covers it. Not for one-off questions, not when unsure a skill would help, and at most once per conversation unless the user takes it up. Pass keywords drawn from the task; up to 3 are shown. Don't describe them in your answer: the card does.",
    parameters: {
      type: "object",
      properties: {
        keywords: {
          type: "array",
          items: { type: "string" },
          description: 'Words from the task, e.g. ["release notes", "changelog"]',
        },
        reason: {
          type: "string",
          description: "One line on what it would make repeatable, shown on the card",
        },
      },
      required: ["keywords", "reason"],
    },
  },
  readOnly: true,
  verb: "Suggested skills",
  target: (a) => (Array.isArray(a.keywords) ? a.keywords.map(String).join(", ") : ""),
  async run(args, host) {
    const refusal = skillSuggestionRefusal(host.items?.() ?? []);
    if (refusal) return { result: refusal, isError: true };
    const keywords = keywordsOf(args.keywords);
    if (!keywords.length)
      return {
        result: 'Error: give keywords from the task, e.g. { "keywords": ["release notes"] }.',
        isError: true,
      };
    const found = await availableSkills(host.services, keywords);
    if (!found.length) return { result: noSkillResult(keywords), isError: true };
    const reason = reasonOf(args.reason);
    const card: SkillSuggestion = {
      ...(reason && { reason }),
      items: found.slice(0, MAX_SUGGESTED_SKILLS).map((x) => ({
        name: x.name,
        description: x.description,
        source: x.source,
        ...(x.where && { where: x.where }),
      })),
    };
    return {
      result: skillSuggestionResult(card),
      summary: card.items.map((i) => i.name).join(", "),
      detail: JSON.stringify(card),
    };
  },
};

export const SUGGEST_MCP_SERVER_TOOL: AgentTool = {
  spec: {
    name: "suggest_mcp_server",
    description:
      "Find MCP servers for a need (a service, database or tool the task needs and no configured server covers) in the IDE's list of popular servers and the official MCP registry, and show up to 3 as a card: what each does, how it runs (npx, uvx, docker or a remote address), what it needs, and Add. The user adds one and types any keys in the card: never ask for keys or tokens in the chat, and don't add servers yourself. At most once per conversation unless the user takes it up. Check mcp_status first when a server may already be configured.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: 'What it should connect to or do, e.g. "postgres database" or "github"',
        },
        reason: {
          type: "string",
          description: "One line on what it adds for this task, shown on the card",
        },
      },
      required: ["query", "reason"],
    },
  },
  readOnly: true,
  verb: "Suggested MCP servers",
  target: (a) => String(a.query ?? ""),
  async run(args, host) {
    const refusal = mcpSuggestionRefusal(host.items?.() ?? []);
    if (refusal) return { result: refusal, isError: true };
    const query = typeof args.query === "string" ? args.query.trim().slice(0, 200) : "";
    if (!query)
      return { result: 'Error: give a query, e.g. { "query": "postgres" }.', isError: true };
    const list: RankedEntry[] = MCP_GALLERY.map((entry) => ({ entry, source: "builtin" }));
    let note: string | undefined;
    for (const q of registryQueries(query)) {
      const found = await searchRegistry(host.services, q, 20);
      if (found.source !== "registry") {
        note = `The MCP registry couldn't be searched (${found.error ?? "off"}): only the built-in list.`;
        break;
      }
      for (const hit of found.servers)
        if ("registryName" in hit)
          list.push({ entry: hit, source: "registry", registryName: hit.registryName });
    }
    const ranked = rankServers(list, query);
    if (!ranked.length)
      return {
        result: `${note ? `${note} ` : ""}No MCP server found for "${query}". Don't suggest one; go on without it.`,
        isError: true,
      };
    const configured = (await mcpServerRows(host.services)).map((r) => r.name);
    const reason = reasonOf(args.reason);
    const card: McpSuggestion = {
      ...(reason && { reason }),
      items: ranked.slice(0, MAX_SUGGESTED_SERVERS).map((r) => suggestedServer(r, configured)),
    };
    return {
      result: mcpSuggestionResult(card, note),
      summary: card.items.map((i) => i.title).join(", "),
      detail: JSON.stringify(card),
    };
  },
};

export const MCP_STATUS_TOOL: AgentTool = {
  spec: {
    name: "mcp_status",
    description:
      "The MCP servers configured for this folder and the user: each one's state (running with its tool count, starting, failed with the error, waiting for the user's approval or a key, not started yet), where it's configured and what it runs. The user sees it as a card with Reconnect on failed servers. Use it when an MCP tool is missing or failing, or before suggesting a server.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "One server (default: all)" } },
    },
  },
  readOnly: true,
  verb: "Checked MCP servers",
  target: (a) => String(a.name ?? ""),
  async run(args, host) {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const all = await mcpServerRows(host.services);
    const rows = name ? all.filter((r) => r.name.toLowerCase() === name.toLowerCase()) : all;
    const result = statusResult(rows, name || undefined);
    if (!rows.length) return { result, summary: "none" };
    const card: McpStatusCard = { servers: rows };
    const failed = rows.filter((r) => r.state === "failed").length;
    return {
      result,
      summary: `${rows.length} server${rows.length === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}`,
      detail: JSON.stringify(card),
    };
  },
};

export const DISCOVERY_TOOLS: AgentTool[] = [
  SUGGEST_SKILL_TOOL,
  SUGGEST_MCP_SERVER_TOOL,
  MCP_STATUS_TOOL,
];
