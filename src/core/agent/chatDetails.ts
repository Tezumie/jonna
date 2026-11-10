// The chat's details panel (D231, after Claude Code's desktop app): the DOM-free part. When the
// panel sits beside the conversation and when it's a sheet behind a header button; the context
// window split by what the IDE sends; the chat's changes; short token and time labels; the sizes
// of the system prompt's parts (recorded when the prompt is built).

/** agent.detailsPanel. */
export type DetailsSetting = "auto" | "always" | "never";

/** Where the panel goes: beside the chat, as a sheet over its right edge, or nowhere. */
export type DetailsLayout = "side" | "sheet" | "off";

/** The panel's width beside the chat (px). */
export const DETAILS_WIDTH = 280;
/** With "auto", the chat keeps at least this much beside the panel (else it's a sheet). */
export const AUTO_CHAT_WIDTH = 480;
/** With "always", the chat keeps at least this much beside the panel (else it's a sheet). */
export const MIN_CHAT_WIDTH = 360;

export function detailsSetting(value: unknown): DetailsSetting {
  return value === "always" || value === "never" ? value : "auto";
}

/**
 * The panel's place for a chat tab `width` px wide: "auto" puts it beside the chat when the chat
 * keeps a comfortable width (as Claude's desktop app does; the column narrows to fit), "always"
 * whenever it keeps a usable one;
 * narrower, it's a sheet the header button opens. "never": no panel (the command can still open
 * the sheet).
 */
export function detailsLayout(width: number, setting: DetailsSetting): DetailsLayout {
  if (setting === "never") return "off";
  const needed = setting === "always" ? MIN_CHAT_WIDTH : AUTO_CHAT_WIDTH;
  return width >= needed + DETAILS_WIDTH ? "side" : "sheet";
}

/** "850", "12.4k", "383.5k", "1M", "1.2M" (one decimal, none when it's .0). */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  const one = (x: number) => (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, "");
  if (v < 1000) return String(v);
  if (v < 999_950) return `${one(v / 1000)}k`;
  return `${one(v / 1_000_000)}M`;
}

/** "8s", "3m 04s", "1h 02m": how long something has run. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

// ---------------------------------------------------------------------------------------------
// The system prompt's parts

/** The system prompt's parts, in characters (context.ts's systemPrompt records them). */
export interface PromptParts {
  /** Who and where the agent is, how to work and talk. */
  instructions: number;
  memory: number;
  rules: number;
  skills: number;
  repoMap: number;
}

const promptParts = new Map<string, PromptParts>();
/** Prompts are kept per chat; a few remembered cover the chats open in a window. */
const KEEP_PROMPTS = 12;

/** Remembers the parts of a system prompt just built (looked up by the prompt's text). */
export function rememberPromptParts(prompt: string, parts: PromptParts): void {
  promptParts.delete(prompt);
  promptParts.set(prompt, parts);
  while (promptParts.size > KEEP_PROMPTS) {
    const oldest = promptParts.keys().next();
    if (oldest.done) break;
    promptParts.delete(oldest.value);
  }
}

/** The parts of a system prompt built in this window, or null (built before a reload). */
export function promptPartsOf(prompt: string): PromptParts | null {
  return promptParts.get(prompt) ?? null;
}

// ---------------------------------------------------------------------------------------------
// The context window

export type ContextKey =
  | "conversation"
  | "attachments"
  | "system"
  | "rules"
  | "skills"
  | "tools"
  | "mcp";

/** What the next request carries, in characters (estimated as 4 per token). */
export interface ContextInput {
  /** The system prompt as a whole (null: not built yet in this chat). */
  system: number | null;
  /** Its parts when known (the rest of `system` counts as the system prompt). */
  parts: PromptParts | null;
  /** Built-in tools' schemas (JSON). */
  tools: number;
  /** MCP tools' schemas, per server. */
  mcp: readonly { server: string; tools: number; chars: number }[];
  /** Messages: text, tool calls and results, summaries, the IDE state on each message. */
  conversation: number;
  /** Attached files, mentions, pasted text; images count as IMAGE_CHARS each. */
  attachments: number;
}

/** What one image costs, roughly, in characters' worth (about 1 200 tokens). */
export const IMAGE_CHARS = 4800;

export interface ContextRow {
  key: ContextKey;
  label: string;
  tokens: number;
  /** Of the context window, 0–100 (one decimal). */
  percent: number;
}

export interface ContextBreakdown {
  /** Tokens used (the provider's count for the last request when it gave one). */
  used: number;
  limit: number;
  /** Of the window, 0–100 (whole). */
  percent: number;
  /** The total is an estimate (no provider count yet). The split is always estimated. */
  estimated: boolean;
  rows: ContextRow[];
  free: number;
  mcpServers: { server: string; tools: number; tokens: number }[];
}

const LABELS: Record<ContextKey, string> = {
  conversation: "Messages",
  attachments: "Attachments",
  system: "System prompt",
  rules: "Rules and memory",
  skills: "Skills",
  tools: "Built-in tools",
  mcp: "MCP tools",
};

/** The order rows show in (the bar's segments too). */
export const CONTEXT_ORDER: readonly ContextKey[] = [
  "conversation",
  "attachments",
  "system",
  "rules",
  "skills",
  "tools",
  "mcp",
];

/**
 * The context window split by what the IDE sends. Each part is estimated from its size; when the
 * provider counted the last request (`measured`, not estimated), the parts are scaled to add up
 * to its count. Null when there's nothing to show (no window size known).
 */
export function contextBreakdown(
  input: ContextInput,
  measured: { tokens: number; limit: number; estimated: boolean } | null,
  limitFallback: number | null,
): ContextBreakdown | null {
  const limit = measured?.limit ?? limitFallback ?? 0;
  if (!(limit > 0)) return null;
  const chars: Record<ContextKey, number> = {
    conversation: input.conversation,
    attachments: input.attachments,
    system: 0,
    rules: 0,
    skills: 0,
    tools: input.tools,
    mcp: input.mcp.reduce((n, s) => n + s.chars, 0),
  };
  if (input.system !== null) {
    const p = input.parts;
    const rules = p ? p.rules + p.memory : 0;
    const skills = p ? p.skills : 0;
    chars.rules = rules;
    chars.skills = skills;
    chars.system = Math.max(0, input.system - rules - skills);
  }
  const estimate = CONTEXT_ORDER.reduce((n, k) => n + chars[k], 0) / 4;
  const exact = !!measured && !measured.estimated && measured.tokens > 0;
  const used = Math.round(exact ? measured.tokens : estimate);
  const scale = estimate > 0 ? used / estimate : 0;
  const pct = (tokens: number) => Math.round((tokens / limit) * 1000) / 10;
  const rows = CONTEXT_ORDER.filter((k) => chars[k] > 0).map((key) => {
    const tokens = Math.round((chars[key] / 4) * scale);
    return { key, label: LABELS[key], tokens, percent: pct(tokens) };
  });
  return {
    used,
    limit,
    percent: Math.min(100, Math.round((used / limit) * 100)),
    estimated: !exact,
    rows,
    free: Math.max(0, limit - used),
    mcpServers: input.mcp.map((s) => ({
      server: s.server,
      tools: s.tools,
      tokens: Math.round((s.chars / 4) * scale),
    })),
  };
}

/** A tool's MCP server, from its description's `[MCP <server>]` prefix, or null (built-in). */
export function mcpServerOf(description: string | undefined): string | null {
  const m = /^\[MCP ([^\]]+)\]/.exec(description ?? "");
  return m?.[1] ?? null;
}

/** Built-in and MCP tools' schema sizes from the specs the chat sends. */
export function toolSizes(
  specs: readonly { name: string; description?: string; parameters?: unknown }[],
): { tools: number; mcp: { server: string; tools: number; chars: number }[] } {
  let tools = 0;
  const servers = new Map<string, { server: string; tools: number; chars: number }>();
  for (const spec of specs) {
    const size = JSON.stringify(spec).length;
    const server = mcpServerOf(spec.description);
    if (!server) {
      tools += size;
      continue;
    }
    const s = servers.get(server) ?? { server, tools: 0, chars: 0 };
    s.tools++;
    s.chars += size;
    servers.set(server, s);
  }
  return { tools, mcp: [...servers.values()].sort((a, b) => b.chars - a.chars) };
}

/** The conversation's items as far as sizes go (core/agent/conversation.ts's Item). */
export type SizedItem =
  | {
      type: "user";
      text: string;
      state?: string;
      context?: readonly string[];
      images?: readonly string[];
      attachments?: readonly { text?: string; preview?: string }[];
    }
  | { type: "assistant"; text: string; thinking?: string }
  | { type: "tool"; args: unknown; result?: string; images?: readonly string[] }
  | { type: "summary"; text: string }
  | { type: "notice" };

/**
 * The conversation's and the attachments' sizes in characters, from the newest summary on (what
 * came before it isn't sent any more).
 */
export function conversationSizes(items: readonly SizedItem[]): {
  conversation: number;
  attachments: number;
} {
  let from = 0;
  for (let i = items.length - 1; i >= 0; i--)
    if (items[i]?.type === "summary") {
      from = i;
      break;
    }
  let conversation = 0;
  let attachments = 0;
  for (const it of items.slice(from)) {
    if (it.type === "user") {
      conversation += it.text.length + (it.state?.length ?? 0);
      for (const c of it.context ?? []) attachments += c.length;
      attachments += (it.images?.length ?? 0) * IMAGE_CHARS;
    } else if (it.type === "assistant") conversation += it.text.length;
    else if (it.type === "tool") {
      conversation += JSON.stringify(it.args ?? null).length + (it.result?.length ?? 0);
      attachments += (it.images?.length ?? 0) * IMAGE_CHARS;
    } else if (it.type === "summary") conversation += it.text.length;
  }
  return { conversation, attachments };
}

// ---------------------------------------------------------------------------------------------
// Changes

/**
 * The chat's file changes: every (turn, file) its tool calls changed, with the lines added and
 * removed as applied (`stat`), and the files still to review. Turns come from the user messages
 * that started them.
 */
export function chatChanges(
  items: readonly (
    | { type: "user"; turn?: number }
    | { type: "tool"; changes?: readonly string[] }
    | { type: "assistant" | "summary" | "notice" }
  )[],
  stat: (path: string, turn: number | undefined) => { added: number; removed: number } | undefined,
  pending: readonly { path: string; added: number; removed: number }[],
): { files: number; added: number; removed: number; review: number } {
  const seen = new Set<string>();
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  let turn: number | undefined;
  for (const it of items) {
    if (it.type === "user") {
      if (it.turn !== undefined) turn = it.turn;
      continue;
    }
    if (it.type !== "tool") continue;
    for (const path of it.changes ?? []) {
      const key = `${turn ?? ""}#${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const s = stat(path, turn);
      if (!s) continue;
      files.add(path);
      added += s.added;
      removed += s.removed;
    }
  }
  // Pending edits not counted from a turn (an external agent's, a proposal): their own stat.
  for (const p of pending)
    if (!files.has(p.path)) {
      files.add(p.path);
      added += p.added;
      removed += p.removed;
    }
  return { files: files.size, added, removed, review: pending.length };
}

// ---------------------------------------------------------------------------------------------
// Folded cards

export const DETAILS_CARDS = ["environment", "context", "changes", "background", "plan"] as const;
export type DetailsCard = (typeof DETAILS_CARDS)[number];

/**
 * The cards' order as saved (D409: dragged by their headers): the known ones in the saved order,
 * then any the saved list doesn't name (a card added later) in the default order.
 */
export function sanitizeOrder(value: unknown): DetailsCard[] {
  const saved = sanitizeFolded(value);
  return [...saved, ...DETAILS_CARDS.filter((c) => !saved.includes(c))];
}

/** `order` with `card` moved before `before` (null: to the end). */
export function moveCard(
  order: readonly DetailsCard[],
  card: DetailsCard,
  before: DetailsCard | null,
): DetailsCard[] {
  if (card === before) return [...order];
  const rest = order.filter((c) => c !== card);
  const at = before === null ? -1 : rest.indexOf(before);
  if (at < 0) return [...rest, card];
  return [...rest.slice(0, at), card, ...rest.slice(at)];
}

/**
 * How many tokens of messages the chat can still take before the IDE's agent summarizes it by
 * itself (agent.autoCompact, sessionTurn's `needsCompaction`): at 80% of the conversation's
 * budget, which is 70% of the window (or the channel's cap). Null: it doesn't (off, or an
 * external agent, which manages its own).
 */
export function untilAutoCompact(
  messagesTokens: number,
  limit: number,
  cap: number | null,
): number {
  const budget = Math.floor(limit * 0.7);
  const conversation = cap !== null && cap > 0 ? Math.min(budget, cap) : budget;
  return Math.max(0, Math.round(conversation * 0.8 - messagesTokens));
}

/** The folded cards as saved (unknown names dropped, no repeats). */
export function sanitizeFolded(value: unknown): DetailsCard[] {
  if (!Array.isArray(value)) return [];
  const known = new Set<string>(DETAILS_CARDS);
  return [...new Set(value.filter((v): v is DetailsCard => typeof v === "string" && known.has(v)))];
}
