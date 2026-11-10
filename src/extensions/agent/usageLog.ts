// Writing the usage log (D201): every model request the IDE makes — the chat, its subagents and
// summaries, and the AI features (edit, suggestions, commit messages, memory tidy-up) — becomes
// one record (`core/agent/usageLog.ts`) appended by Rust to app data. Batched a little so a burst
// of completions is one write. `agent.usage.keepHistory: false` stops it. Local only.

import type { ModelPrice } from "../../core/agent/prices";
import {
  makeAgentRecord,
  makeRecord,
  parseRecord,
  type UsageRecord,
  type UsageSource,
} from "../../core/agent/usageLog";
import {
  aiIpc,
  type ChatEvent,
  type ProviderLimits,
  type ProviderRef,
  type RateLimits,
  usageIpc,
} from "../../core/ipc/agent";
import type { DisposableStore } from "../../core/lifecycle/index";
import { signal } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { ModelChoice } from "./providers";

/** Bumped when the log is cleared: the Usage page reads it again. */
export const usageLogVersion = signal(0);

/** Records that just reached the log: the Usage page adds them without reading it all again. */
const appendListeners = new Set<(records: readonly UsageRecord[]) => void>();
export function onUsageAppended(listener: (records: readonly UsageRecord[]) => void): {
  dispose(): void;
} {
  appendListeners.add(listener);
  return { dispose: () => appendListeners.delete(listener) };
}

let queue: UsageRecord[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

function flush(): void {
  timer = undefined;
  const batch = queue;
  queue = [];
  if (!batch.length) return;
  void usageIpc
    .append(batch)
    .then(() => {
      for (const l of appendListeners) l(batch);
    })
    .catch((err: unknown) => console.warn("usage log: records not written", err));
}

/** Logs one finished request (nothing when the provider reported no tokens). */
export function recordUsage(
  services: WorkbenchServices,
  opts: {
    source: UsageSource;
    session?: string | undefined;
    choice: Pick<ModelChoice, "key" | "provider" | "info">;
    event: Extract<ChatEvent, { kind: "done" }>;
    price: ModelPrice | undefined;
  },
): UsageRecord | null {
  if (services.settings.peek<boolean>("agent.usage.keepHistory") === false) return null;
  const record = makeRecord({
    t: Date.now(),
    source: opts.source,
    session: opts.session,
    provider: opts.choice.provider.id,
    model: opts.choice.key,
    usage: opts.event,
    price: opts.price,
    local: opts.choice.provider.kind === "ollama" && !opts.choice.info.remote,
  });
  if (!record) return null;
  queueRecord(record);
  return record;
}

function queueRecord(record: UsageRecord): void {
  queue.push(record);
  // Soon, but one write for a burst; the page sees it within a second.
  timer ??= setTimeout(flush, 400);
}

/**
 * Logs one turn of an external agent (D208): its tokens and cost when it reported them, else a
 * request with both unknown (`unreported`).
 */
export function recordAgentUsage(
  services: WorkbenchServices,
  opts: Omit<Parameters<typeof makeAgentRecord>[0], "t">,
): UsageRecord | null {
  if (services.settings.peek<boolean>("agent.usage.keepHistory") === false) return null;
  const record = makeAgentRecord({ t: Date.now(), ...opts });
  queueRecord(record);
  return record;
}

/** Writes what's still queued when the extension goes away (a window closing). */
export function registerUsageLog(sub: DisposableStore): void {
  sub.add({ dispose: () => flushUsage() });
}

/** Writes what's queued now (before reading the log back). */
export function flushUsage(): void {
  if (timer) clearTimeout(timer);
  flush();
}

/** The log's records since `since` (ms), oldest first; unreadable lines are skipped. */
export async function loadUsage(since: number): Promise<UsageRecord[]> {
  flushUsage();
  const raw = await usageIpc.load(Math.max(0, Math.floor(since)));
  const out: UsageRecord[] = [];
  for (const r of raw) {
    const rec = parseRecord(r);
    if (rec) out.push(rec);
  }
  return out;
}

/** What each provider (by id) reported about its limits: headers this run, OpenRouter credits. */
export const providerLimits = signal<Readonly<Record<string, ProviderLimits>>>({});

/**
 * Reads the providers' limits: the rate-limit headers Rust kept from their last responses (no
 * network) and, for OpenRouter, the key's credits (one request each, with the key on Rust's side).
 */
export async function refreshLimits(
  refs: readonly ProviderRef[],
  opts: { credits?: boolean } = {},
): Promise<Record<string, ProviderLimits>> {
  const rate = await aiIpc.rateLimits().catch(() => ({}) as Record<string, RateLimits>);
  const before = providerLimits.peek();
  const out: Record<string, ProviderLimits> = {};
  await Promise.all(
    refs.map(async (ref) => {
      const old = before[ref.id];
      let credits = old?.credits ?? null;
      let creditsError = old?.creditsError ?? null;
      if (opts.credits !== false && isOpenRouter(ref.baseUrl)) {
        const got = await aiIpc.providerLimits(ref).catch((err: unknown) => ({
          rate: null,
          credits: null,
          creditsError: err instanceof Error ? err.message : String(err),
        }));
        credits = got.credits;
        creditsError = got.creditsError;
      }
      out[ref.id] = { rate: rate[ref.id] ?? null, credits, creditsError };
    }),
  );
  providerLimits.value = out;
  return out;
}

export const isOpenRouter = (baseUrl: string): boolean => baseUrl.includes("openrouter.ai");

export async function clearUsage(): Promise<number> {
  if (timer) clearTimeout(timer);
  timer = undefined;
  queue = [];
  const n = await usageIpc.clear();
  usageLogVersion.value++;
  return n;
}
