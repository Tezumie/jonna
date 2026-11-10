// The usage log's model (D201): one record per model request, stored as JSON lines by Rust
// (`agent/usage/*.jsonl` in app data, 90 days / 20 MB), and what the Usage page shows from it —
// totals for today, 7 and 30 days, a bar per day, models, providers, features and the chats that
// cost the most — plus the providers' rate-limit resets. DOM-free and tested.

import { costOf, type ModelPrice } from "./prices";

/** What made the request. */
export type UsageSource =
  | "chat"
  | "subagent"
  | "summary"
  | "edit"
  | "completion"
  | "nextEdit"
  | "commit"
  | "memory"
  /** An MCP server's sampling request run on the user's model (D204). */
  | "sampling";

export const SOURCE_LABELS: Readonly<Record<UsageSource, string>> = {
  chat: "Chat",
  subagent: "Subagents",
  summary: "Summaries",
  edit: "Edit with AI",
  completion: "Suggestions",
  nextEdit: "Next-edit suggestions",
  commit: "Commit messages",
  memory: "Memory tidy-up",
  sampling: "MCP sampling",
};

export interface UsageRecord {
  /** When the request finished (ms since the epoch). */
  t: number;
  source: UsageSource;
  /** The chat it belongs to, if any. */
  session?: string;
  /** The provider's id (agent.providers, or "ollama"). */
  provider: string;
  /** "provider/model". */
  model: string;
  /** Prompt tokens, cached ones included. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Dollars; null when the model has no known price. */
  cost: number | null;
  /**
   * "provider": the provider's own figure (OpenRouter); "price": computed from a price; "local":
   * a model on this computer (no cost); "agent": an external agent's own figure (D208).
   */
  costFrom?: "provider" | "price" | "local" | "agent";
  /**
   * An external agent's turn that reported no tokens (D208): one request counted, tokens and cost
   * unknown (it may bill a subscription).
   */
  unreported?: true;
  /**
   * Another model's share of an external agent's turn (D223: `_meta.quota.model_usage`, Claude
   * Code's subagents on Haiku): its tokens count, but it isn't a request of its own, and the
   * turn's cost (when the agent gives one) is on the main record.
   */
  part?: true;
}

const SOURCES = new Set<string>(Object.keys(SOURCE_LABELS));

const count = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;

/** A stored line back as a record (null: not one; unknown fields are dropped). */
export function parseRecord(v: unknown): UsageRecord | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.t !== "number" || !Number.isFinite(r.t)) return null;
  if (typeof r.model !== "string" || !r.model) return null;
  const cost = typeof r.cost === "number" && Number.isFinite(r.cost) && r.cost >= 0 ? r.cost : null;
  return {
    t: r.t,
    source:
      typeof r.source === "string" && SOURCES.has(r.source) ? (r.source as UsageSource) : "chat",
    ...(typeof r.session === "string" && r.session && { session: r.session }),
    provider:
      typeof r.provider === "string" && r.provider
        ? r.provider
        : r.model.slice(0, Math.max(0, r.model.indexOf("/"))) || "unknown",
    model: r.model,
    input: count(r.input),
    output: count(r.output),
    cacheRead: count(r.cacheRead),
    cacheWrite: count(r.cacheWrite),
    cost,
    ...(r.costFrom === "provider" ||
    r.costFrom === "price" ||
    r.costFrom === "local" ||
    r.costFrom === "agent"
      ? { costFrom: r.costFrom }
      : {}),
    ...(r.unreported === true && { unreported: true as const }),
    ...(r.part === true && { part: true as const }),
  };
}

/** The usage a provider reported for one request (ChatEvent "done", in the IDE's units). */
export interface ReportedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  cost?: number | null;
}

/**
 * The record for one request, or null when the provider reported no tokens at all (nothing to
 * log rather than a guess). The provider's own cost wins over the price; a local model without a
 * price costs nothing.
 */
export function makeRecord(opts: {
  t: number;
  source: UsageSource;
  session?: string | undefined;
  provider: string;
  model: string;
  usage: ReportedUsage;
  price: ModelPrice | undefined;
  /** A model running on this computer (Ollama's own, not its cloud models). */
  local?: boolean;
}): UsageRecord | null {
  const u = opts.usage;
  const input = count(u.inputTokens);
  const output = count(u.outputTokens);
  if (!input && !output) return null;
  const cacheRead = Math.min(input, count(u.cacheReadTokens));
  const cacheWrite = Math.min(input - cacheRead, count(u.cacheWriteTokens));
  const reported = typeof u.cost === "number" && Number.isFinite(u.cost) && u.cost >= 0;
  const priced = costOf({ requests: 1, input, output, cacheRead, cacheWrite }, opts.price, 8);
  return {
    t: opts.t,
    source: opts.source,
    ...(opts.session && { session: opts.session }),
    provider: opts.provider,
    model: opts.model,
    input,
    output,
    cacheRead,
    cacheWrite,
    cost: reported ? (u.cost as number) : (priced ?? (opts.local ? 0 : null)),
    ...(reported
      ? { costFrom: "provider" as const }
      : priced !== null
        ? { costFrom: "price" as const }
        : opts.local
          ? { costFrom: "local" as const }
          : {}),
  };
}

/**
 * One turn of an external agent (D208): ACP agents answer a whole turn, so it's one record with
 * the tokens it reported (in the IDE's units: input with the cached ones), or none — then it's
 * still counted, as a request with tokens and cost unknown. A cost only when the agent gave one
 * (Claude Code's is priced at API rates even on a subscription); no price list is applied, since
 * the IDE can't know whether the agent bills API credits or a subscription.
 */
export function makeAgentRecord(opts: {
  t: number;
  /** The chat (default), or the feature it answered for (D207: commit messages, memory). */
  source?: UsageSource;
  session?: string | undefined;
  agent: string;
  /** The agent's model id, as its model menu has it ("" when it has none). */
  model: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  cost: number | null;
  /** Another model's share of the same turn (D223). */
  part?: boolean;
}): UsageRecord {
  const u = opts.usage;
  const input = count(u?.input);
  const output = count(u?.output);
  const cacheRead = Math.min(input, count(u?.cacheRead));
  const cacheWrite = Math.min(input - cacheRead, count(u?.cacheWrite));
  const cost =
    typeof opts.cost === "number" && Number.isFinite(opts.cost) && opts.cost >= 0
      ? Math.round(opts.cost * 1e8) / 1e8
      : null;
  const provider = agentProvider(opts.agent);
  return {
    t: opts.t,
    source: opts.source ?? "chat",
    ...(opts.session && { session: opts.session }),
    provider,
    model: `${provider}/${opts.model.trim() || "default"}`,
    input,
    output,
    cacheRead,
    cacheWrite,
    cost,
    ...(cost !== null && { costFrom: "agent" as const }),
    ...(!input && !output && !opts.part && { unreported: true as const }),
    ...(opts.part && { part: true as const }),
  };
}

/** The usage log's provider id of an external agent: "acp:Codex" (no "/": models split on it). */
export const agentProvider = (agent: string): string => `acp:${agent.replace(/\//g, "-")}`;

/** The external agent a provider id names, if it's one. */
export const providerAgent = (provider: string): string | null =>
  provider.startsWith("acp:") ? provider.slice(4) : null;

export interface UsageSums {
  requests: number;
  /** Of `requests`: external agents' turns that reported no tokens (D208). */
  unreported: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Dollars, of the requests that had a cost. */
  cost: number;
  /** Requests with no known cost (local models, unpriced ones). */
  unpriced: number;
}

export const emptySums = (): UsageSums => ({
  requests: 0,
  unreported: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  unpriced: 0,
});

export function addRecord(s: UsageSums, r: UsageRecord): void {
  if (!r.part) s.requests++;
  if (r.unreported) s.unreported++;
  s.input += r.input;
  s.output += r.output;
  s.cacheRead += r.cacheRead;
  s.cacheWrite += r.cacheWrite;
  if (r.cost !== null) s.cost += r.cost;
  else if (!r.part) s.unpriced++;
}

const roundSums = (s: UsageSums): UsageSums => ({
  ...s,
  cost: Math.round(s.cost * 1e6) / 1e6,
});

/** "2026-10-24" in local time. */
export function dayKey(t: number): string {
  const d = new Date(t);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Local midnight `back` days before `now`'s day. */
export function startOfDay(now: number, back = 0): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - back);
  return d.getTime();
}

export interface UsageDay extends UsageSums {
  day: string;
  /** Local midnight. */
  start: number;
}

export interface UsageSummary {
  today: UsageSums;
  week: UsageSums;
  month: UsageSums;
  /** The last `days` days, oldest first, empty days included. */
  days: UsageDay[];
  /** Within the period, most expensive first (then most tokens). */
  byModel: (UsageSums & { model: string; provider: string })[];
  byProvider: (UsageSums & { provider: string })[];
  bySource: (UsageSums & { source: UsageSource })[];
  topChats: (UsageSums & { session: string; last: number })[];
  /** The oldest record kept, if any. */
  since: number | null;
  /** How many records the summary read. */
  records: number;
}

/** The map's value for `key`, made with `make` the first time. */
function entry<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let v = map.get(key);
  if (v === undefined) {
    v = make();
    map.set(key, v);
  }
  return v;
}

const rank = <T extends UsageSums>(a: T, b: T): number =>
  b.cost - a.cost || b.input + b.output - (a.input + a.output) || b.requests - a.requests;

/**
 * What the Usage page shows: totals for today (since local midnight), the last 7 and 30 days
 * (today included), one entry per day of the last `days`, and breakdowns over those days.
 */
export function summarize(
  records: readonly UsageRecord[],
  now: number,
  opts: { days?: number; top?: number } = {},
): UsageSummary {
  const days = Math.max(1, Math.min(90, opts.days ?? 30));
  const top = opts.top ?? 10;
  const today = emptySums();
  const week = emptySums();
  const month = emptySums();
  const t0 = startOfDay(now);
  const t7 = startOfDay(now, 6);
  const t30 = startOfDay(now, 29);
  const from = startOfDay(now, days - 1);
  const perDay: UsageDay[] = [];
  const index = new Map<string, UsageDay>();
  for (let back = days - 1; back >= 0; back--) {
    const start = startOfDay(now, back);
    const d: UsageDay = { day: dayKey(start), start, ...emptySums() };
    perDay.push(d);
    index.set(d.day, d);
  }
  const models = new Map<string, UsageSums & { model: string; provider: string }>();
  const providers = new Map<string, UsageSums & { provider: string }>();
  const sources = new Map<UsageSource, UsageSums & { source: UsageSource }>();
  const chats = new Map<string, UsageSums & { session: string; last: number }>();
  let since: number | null = null;
  for (const r of records) {
    since = since === null ? r.t : Math.min(since, r.t);
    if (r.t > now + 60_000) continue; // a clock that went back: not "today"
    if (r.t >= t0) addRecord(today, r);
    if (r.t >= t7) addRecord(week, r);
    if (r.t >= t30) addRecord(month, r);
    if (r.t < from) continue;
    const d = index.get(dayKey(r.t));
    if (d) addRecord(d, r);
    addRecord(
      entry(models, r.model, () => ({ model: r.model, provider: r.provider, ...emptySums() })),
      r,
    );
    addRecord(
      entry(providers, r.provider, () => ({ provider: r.provider, ...emptySums() })),
      r,
    );
    addRecord(
      entry(sources, r.source, () => ({ source: r.source, ...emptySums() })),
      r,
    );
    if (r.session) {
      const session = r.session;
      const c = entry(chats, session, () => ({ session, last: r.t, ...emptySums() }));
      addRecord(c, r);
      c.last = Math.max(c.last, r.t);
    }
  }
  return {
    today: roundSums(today),
    week: roundSums(week),
    month: roundSums(month),
    days: perDay.map((d) => ({ ...d, cost: Math.round(d.cost * 1e6) / 1e6 })),
    byModel: [...models.values()].sort(rank).map((x) => ({ ...x, ...roundSums(x) })),
    byProvider: [...providers.values()].sort(rank).map((x) => ({ ...x, ...roundSums(x) })),
    bySource: [...sources.values()].sort(rank).map((x) => ({ ...x, ...roundSums(x) })),
    topChats: [...chats.values()]
      .sort(rank)
      .slice(0, top)
      .map((x) => ({ ...x, ...roundSums(x) })),
    since,
    records: records.length,
  };
}

/** One chat's sums over every record kept (its subagents and summaries included). */
export function sessionSums(records: readonly UsageRecord[], session: string): UsageSums {
  const s = emptySums();
  for (const r of records) if (r.session === session) addRecord(s, r);
  return roundSums(s);
}

/** "950", "12.3k", "4.5M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

/** A rate-limit bucket as a provider reported it (Rust `ai::limits`). */
export interface LimitBucket {
  name: string;
  limit: number | null;
  remaining: number | null;
  reset: string | null;
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * When a bucket refills, in ms since the epoch: Anthropic sends an RFC 3339 time, OpenAI a
 * duration from the response ("6m0s", "1.5s", "120ms"). Null when it can't be read.
 */
export function resetAt(reset: string | null, observedAt: number): number | null {
  if (!reset) return null;
  const text = reset.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const t = Date.parse(text);
    return Number.isFinite(t) ? t : null;
  }
  if (/^\d+(\.\d+)?$/.test(text)) return observedAt + Number(text) * 1000; // seconds
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)];
  if (!parts.length || parts.map((p) => p[0]).join("") !== text) return null;
  return observedAt + parts.reduce((ms, p) => ms + Number(p[1]) * (UNIT_MS[p[2] ?? "s"] ?? 0), 0);
}

/** "now", "in 40 s", "in 6 min", "in 3 h", "in 2 days". */
export function formatIn(ms: number): string {
  if (ms <= 1000) return "now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `in ${s} s`;
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86400) return `in ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return `in ${d} day${d === 1 ? "" : "s"}`;
}

/** "Requests", "Input tokens"… from a bucket name. */
export function bucketLabel(name: string): string {
  const words = name.replace(/[-_]+/g, " ").trim();
  return words ? words[0]?.toUpperCase() + words.slice(1) : "Limit";
}

/** Nice round maximum for a bar chart's scale (1, 2, 5 × 10^n), at least `max`. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}
