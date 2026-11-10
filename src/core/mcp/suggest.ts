// suggest_mcp_server and mcp_status (D343), the IDE's take on Claude Code's MCP registry search
// (search_mcp_registry, suggest_connectors) and its connectors' status / reconnect. The agent
// finds servers for a need in the built-in gallery (gallery.ts) and the official MCP registry
// (registry.ts) and shows up to three as a card: what each does, how it runs (npx, uvx, docker or
// a remote address), what it needs (a runtime, keys), a link to its page and Add, with fields for
// its inputs. Add writes the server through agent.installMcpServer; the values typed go to the
// server's stored inputs, never through the chat. mcp_status shows the configured servers and
// their state, with Reconnect on one that failed. The cards' data is kept in the calls' `detail`.
// DOM-free and tested.

import type { Item } from "../agent/conversation";
import { oncePerConversation } from "../agent/extensionSuggest";
import { type GalleryEntry, galleryConfig } from "./gallery";

export type McpRunner = "npx" | "uvx" | "docker" | "remote" | "other";

export interface SuggestedInput {
  id: string;
  description: string;
  password: boolean;
  options?: string[];
  default?: string;
}

export interface SuggestedServer {
  /** The gallery id, or the id a registry search gave it. */
  id: string;
  title: string;
  description: string;
  runner: McpRunner;
  /** What it runs or where it connects ("npx -y @scope/pkg@1.0.0", "https://…/mcp"). */
  runs: string;
  /** What must be installed for a local one ("Node.js"). */
  needs?: string;
  /** What Add asks for (the card's fields); left empty, asked when it first starts. */
  inputs: SuggestedInput[];
  /** A remote server that signs in with OAuth. */
  oauth?: boolean;
  homepage?: string;
  source: "builtin" | "registry";
  /** The registry's name for it ("io.github.acme/weather"): Add looks it up again after a restart. */
  registryName?: string;
  warnings?: string[];
  /** The name it was added under (from the card, or already configured under its id). */
  added?: string;
}

export interface McpSuggestion {
  reason?: string;
  items: SuggestedServer[];
  /** The user added one from the card. */
  engaged?: boolean;
}

export interface RankedEntry {
  entry: GalleryEntry;
  source: "builtin" | "registry";
  registryName?: string;
}

export const MAX_SUGGESTED_SERVERS = 3;

const STOP = new Set(
  "a an and the of for to in on with by or my our your this that is are be it as at from into mcp server servers tool tools use using access connect connector integration".split(
    " ",
  ),
);

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));

/** The words of a need ("query the Postgres database" → query, postgre, database). */
export function queryWords(query: string): string[] {
  return [...new Set(words(query))].slice(0, 8);
}

/**
 * What to ask the registry, whose search matches names only: the whole query, then its words
 * one by one (longest first), at most three requests.
 */
export function registryQueries(query: string): string[] {
  const whole = query.trim();
  const each = [...new Set(query.toLowerCase().split(/[^a-z0-9-]+/))]
    .filter((w) => w.length > 2 && !STOP.has(w))
    .sort((a, b) => b.length - a.length);
  return [...new Set([whole, ...each].filter(Boolean))].slice(0, 3);
}

export function runnerOf(entry: GalleryEntry): McpRunner {
  if (entry.config.url) return "remote";
  const program = (entry.config.command ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, "");
  return program === "npx" || program === "uvx" || program === "docker" ? program : "other";
}

export function runsOf(entry: GalleryEntry): string {
  return entry.config.url ?? [entry.config.command, ...(entry.config.args ?? [])].join(" ");
}

/**
 * How well a server matches the need: a word in its id or title counts most, one in its
 * description or category less; a server the registry named the same way scores on its name
 * too. 0: no match.
 */
export function serverScore(r: RankedEntry, need: readonly string[]): number {
  const named = new Set(words(`${r.entry.id} ${r.entry.title} ${r.registryName ?? ""}`));
  const described = new Set(words(`${r.entry.description} ${r.entry.category}`));
  let score = 0;
  for (const w of need) {
    if (named.has(w)) score += 3;
    else if (described.has(w)) score += 2;
    else if (w.length >= 4 && [...named, ...described].some((x) => x.startsWith(w))) score += 1;
  }
  return score;
}

/**
 * The servers for a need, best first, without duplicates (the same address or command, e.g. a
 * registry entry for a server the gallery has): a tie goes to the built-in gallery (vetted),
 * then to one that needs nothing typed in, then to a remote one (nothing to install).
 */
export function rankServers(list: readonly RankedEntry[], query: string): RankedEntry[] {
  const need = queryWords(query);
  const scored = list
    .map((r) => ({ r, score: need.length ? serverScore(r, need) : 1 }))
    .filter((x) => x.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        rank(a.r.source === "builtin") - rank(b.r.source === "builtin") ||
        rank(!a.r.entry.inputs?.length) - rank(!b.r.entry.inputs?.length) ||
        rank(a.r.entry.kind === "remote") - rank(b.r.entry.kind === "remote"),
    );
  const seen = new Set<string>();
  const out: RankedEntry[] = [];
  for (const { r } of scored) {
    const key = runsOf(r.entry)
      .toLowerCase()
      .replace(/@[\w.+-]*$|==[\w.+-]*$/, "");
    if (seen.has(key) || seen.has(`id:${r.entry.id}`)) continue;
    seen.add(key);
    seen.add(`id:${r.entry.id}`);
    out.push(r);
  }
  return out;
}

const rank = (first: boolean) => (first ? 0 : 1);

/** The card's row for an entry. `configured`: the configured server names (case as written). */
export function suggestedServer(r: RankedEntry, configured: readonly string[]): SuggestedServer {
  const e = r.entry;
  const added = configured.find((n) => n.toLowerCase() === e.id.toLowerCase());
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    runner: runnerOf(e),
    runs: runsOf(e),
    ...(e.needs && { needs: e.needs }),
    inputs: (e.inputs ?? []).map((i) => ({
      id: i.id,
      description: i.description,
      password: i.password,
      ...(i.options?.length && { options: i.options }),
      ...(i.default !== undefined && { default: i.default }),
    })),
    ...(e.oauth && { oauth: true }),
    ...(e.homepage && /^https?:\/\//.test(e.homepage) && { homepage: e.homepage }),
    source: r.source,
    ...(r.registryName && { registryName: r.registryName }),
    ...(e.warnings?.length && { warnings: e.warnings }),
    ...(added && { added }),
  };
}

export interface McpAddPlan {
  /** What goes into mcp.json (its inputs stay `${input:id}`). */
  server: Record<string, unknown>;
  inputs: ReturnType<typeof galleryConfig>["inputs"];
  /** Values typed in the card, stored before it starts. */
  presets: Record<string, string>;
  /** Inputs left empty: asked in a hidden box when it first starts. */
  later: string[];
  /** A choice that isn't one of the input's options. */
  invalid: string[];
}

/** What Add does with the card's values: which are stored now, which are asked at the start. */
export function planMcpAdd(
  entry: GalleryEntry,
  values: Readonly<Record<string, unknown>>,
): McpAddPlan {
  const { server, inputs } = galleryConfig(entry);
  const presets: Record<string, string> = {};
  const later: string[] = [];
  const invalid: string[] = [];
  for (const input of inputs) {
    const raw = values[input.id];
    const value = typeof raw === "string" ? (input.password ? raw : raw.trim()) : "";
    if (!value) later.push(input.id);
    else if (input.options?.length && !input.options.includes(value)) invalid.push(input.id);
    else presets[input.id] = value;
  }
  return { server, inputs, presets, later, invalid };
}

/** The card's data kept in a call's detail; null when there's none (or it isn't ours). */
export function parseMcpSuggestion(detail: string | undefined): McpSuggestion | null {
  if (!detail) return null;
  try {
    const v = JSON.parse(detail) as Partial<McpSuggestion>;
    if (!v || !Array.isArray(v.items)) return null;
    const items = v.items.filter(
      (i): i is SuggestedServer =>
        !!i &&
        typeof i.id === "string" &&
        typeof i.title === "string" &&
        typeof i.runs === "string" &&
        Array.isArray(i.inputs),
    );
    return items.length ? { ...v, items } : null;
  } catch {
    return null;
  }
}

/** Words that say the user is asking about MCP servers (taking a suggestion up). */
const ENGAGED = /\b(mcp|servers?|connectors?|integrations?|add(?:ed|ing)? (?:it|one|that))\b/i;

/** Why another suggestion isn't shown now (D314's rule), or null when it may be. */
export function mcpSuggestionRefusal(items: readonly Item[]): string | null {
  return oncePerConversation(
    items,
    "suggest_mcp_server",
    ENGAGED,
    "You already suggested MCP servers in this conversation and the user hasn't taken it up: don't suggest again unless they ask.",
  );
}

/** What the model gets back about the card. */
export function mcpSuggestionResult(s: McpSuggestion, note?: string): string {
  const list = s.items
    .map(
      (i) =>
        `${i.title} (${i.runner === "remote" ? "remote" : i.runner}${i.added ? `, already configured as ${i.added}` : ""})`,
    )
    .join(", ");
  return `${note ? `${note} ` : ""}Shown to the user as a card: ${list}. They add one from the card and type any keys there (never in the chat: don't ask for them). Don't describe the servers in your answer or add them yourself; a server added starts with the next message, and mcp_status says how it's doing.`;
}

// ---- mcp_status ------------------------------------------------------------------------------

export interface McpStatusRow {
  name: string;
  /** running, starting, failed, waiting (for approval or an input), not started. */
  state: string;
  tools: number;
  /** Where it's configured ("user mcp.json", ".vscode/mcp.json"…). */
  source: string;
  transport: "stdio" | "http";
  target: string;
  error?: string;
  needsSignIn?: boolean;
  /** Reconnected from the card: when, and how it went. */
  reconnected?: string;
}

export interface McpStatusCard {
  servers: McpStatusRow[];
  /** A Reconnect clicked on the card (the agent may look again). */
  engaged?: boolean;
}

/** `ide://agent/mcp`'s list as the card's rows (anything malformed left out). */
export function statusRows(raw: unknown): McpStatusRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x): McpStatusRow[] => {
    if (!x || typeof x !== "object") return [];
    const v = x as Record<string, unknown>;
    if (typeof v.name !== "string") return [];
    const text = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : "");
    const error = text("error");
    return [
      {
        name: v.name,
        state: text("state") || "not started",
        tools: typeof v.tools === "number" ? v.tools : 0,
        source: text("source"),
        transport: v.transport === "http" ? "http" : "stdio",
        target: text("target"),
        ...(error && { error: error.slice(0, 400) }),
        ...(v.needsSignIn === true && { needsSignIn: true }),
        ...(text("reconnected") && { reconnected: text("reconnected") }),
      },
    ];
  });
}

/** The rows that can be reconnected from the card: failed, or started and stuck. */
export function canReconnect(row: McpStatusRow): boolean {
  return row.state === "failed" || row.state === "running" || row.state === "waiting";
}

/** What the model gets back: one line per server. `name` narrows it to one. */
export function statusResult(rows: readonly McpStatusRow[], name?: string): string {
  if (!rows.length)
    return name
      ? `No MCP server named ${name} is configured.`
      : "No MCP servers are configured. To find one for a need, use suggest_mcp_server.";
  const lines = rows.map(
    (r) =>
      `- ${r.name}: ${r.state}${r.state === "running" ? `, ${r.tools} tools` : ""} (${r.transport}, ${r.source})${r.needsSignIn ? "; needs the user to sign in (MCP servers page)" : ""}${r.error ? `; error: ${r.error}` : ""}`,
  );
  const failed = rows.filter((r) => r.state === "failed").length;
  return `${lines.join("\n")}\n\nShown to the user as a card${failed ? " with Reconnect on the failed ones (they click it; the result isn't sent to you, call mcp_status again if needed)" : ""}. Servers that aren't started start with the next message.`;
}

export function parseMcpStatus(detail: string | undefined): McpStatusCard | null {
  if (!detail) return null;
  try {
    const v = JSON.parse(detail) as Partial<McpStatusCard>;
    if (!v || !Array.isArray(v.servers)) return null;
    return { ...v, servers: statusRows(v.servers) };
  } catch {
    return null;
  }
}
