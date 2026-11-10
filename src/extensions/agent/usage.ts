// What the agent has used (D191, wishlist 19): `ide://agent/usage` — tokens in and out, cache
// reads and writes, and the cost (D199: agent.prices, else the provider's listed price, else the
// built-in list; core/agent/prices.ts), per session and in all, with the chat budget
// (agent.budget.perChat), for the agent to budget with and the user to see.
import { costOf, type ModelPrice, resolvePrice, type Totals } from "../../core/agent/prices";
import { summarize } from "../../core/agent/usageLog";
import { agentStoreIpc } from "../../core/ipc/agent";
import type { DisposableStore } from "../../core/lifecycle/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { ProviderRegistry } from "./providers";
import type { SessionManager } from "./sessions";
import { loadUsage, providerLimits, refreshLimits } from "./usageLog";

export { costOf, type ModelPrice, type Totals } from "../../core/agent/prices";

/** A model's price: the user's, the provider's listing (OpenRouter), or the built-in list. */
export function priceOf(
  services: WorkbenchServices,
  providers: ProviderRegistry,
  model: string | null,
): ModelPrice | undefined {
  if (!model || model.startsWith("acp/")) return undefined;
  const listed = providers.find(model)?.info.pricing;
  return resolvePrice(
    model,
    services.settings.peek<Record<string, unknown>>("agent.prices"),
    listed
      ? {
          input: listed.input,
          output: listed.output,
          ...(listed.cacheRead != null && { cacheRead: listed.cacheRead }),
          ...(listed.cacheWrite != null && { cacheWrite: listed.cacheWrite }),
        }
      : null,
  );
}

/** The price for "provider/model" from agent.prices (exact key, else the model id alone). */
export function priceFor(
  prices: Record<string, unknown> | undefined,
  model: string | null,
): ModelPrice | undefined {
  if (!prices || !model) return undefined;
  const short = model.slice(model.indexOf("/") + 1);
  const p = (prices[model] ?? prices[short]) as Partial<ModelPrice> | undefined;
  return p && typeof p.input === "number" && typeof p.output === "number"
    ? (p as ModelPrice)
    : undefined;
}

export function registerUsageState(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
  providers: ProviderRegistry,
): void {
  sub.add(
    services.state.register("ide://agent/usage", {
      description:
        "Tokens the agent's sessions used in this window: per session (requests, prompt tokens and how many came from the cache, output, the context the last request filled, the cost in dollars and the chat budget, agent.budget.perChat) and in all. Prices: agent.prices, else the provider's listing (OpenRouter), else a built-in list of common hosted models (approximate).",
      get: () => {
        const budget = services.settings.peek<number>("agent.budget.perChat") ?? 0;
        const all: Totals = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
        let cost = 0;
        let costKnown = true;
        const list = sessions.all().map((s) => {
          const t = s.totals.peek();
          for (const k of Object.keys(all) as (keyof Totals)[]) all[k] += t[k];
          // What the chat cost as it went (several models: each priced when used), else now.
          const c = s.cost.peek() ?? costOf(t, priceOf(services, providers, s.model.peek()));
          if (c === null) costKnown = costKnown && t.requests === 0;
          else cost += c;
          const last = s.usage.peek();
          return {
            id: s.id,
            title: s.title.peek(),
            model: s.model.peek(),
            ...t,
            cacheHitRate: t.input ? Math.round((t.cacheRead / t.input) * 100) / 100 : null,
            cost: c,
            ...(budget > 0 && { budget }),
            ...(last && {
              context: { used: last.tokens, limit: last.limit, estimated: last.estimated },
            }),
          };
        });
        return {
          sessions: list,
          total: { ...all, cost: costKnown ? Math.round(cost * 10_000) / 10_000 : null },
          ...(costKnown
            ? {}
            : {
                note: 'Cost is null where a model has no known price (local models cost nothing; others: set agent.prices, e.g. { "anthropic/claude-sonnet-4-5": { "input": 3, "output": 15, "cacheRead": 0.3 } }).',
              }),
        };
      },
    }),
  );
  // The history across restarts (D201): the local usage log, summed.
  sub.add(
    services.state.register("ide://agent/usage/history", {
      description:
        "The usage log kept on this computer (90 days): requests, tokens and cost today, in the last 7 and 30 days, per day, by model, provider and feature (chat, subagent, summary, edit, completion, nextEdit, commit, memory), and the chats that cost the most (with titles). `?days=7|30|90` sets the period of the days and breakdowns (default 30). Cost: the provider's own figure (OpenRouter) or the price (agent.prices, the provider's listing, built-in list prices); `unpriced` counts requests without one. External agents (provider `acp:<name>`, D208) log one record per turn with the tokens and cost they report; `unreported` counts their turns that reported no tokens (cost unknown: they may bill a subscription).",
      get: async ({ params }) => {
        const days = Math.max(1, Math.min(90, Number(params.days) || 30));
        const records = await loadUsage(Date.now() - 90 * 86_400_000);
        const sum = summarize(records, Date.now(), { days });
        const titles = new Map<string, string>();
        for (const r of await agentStoreIpc.list().catch(() => [])) {
          const title = (r.meta as { title?: unknown } | null)?.title;
          if (typeof title === "string") titles.set(r.id, title);
        }
        for (const live of sessions.all()) titles.set(live.id, live.title.peek());
        const keep = services.settings.peek<boolean>("agent.usage.keepHistory") !== false;
        return {
          keepHistory: keep,
          since: sum.since,
          records: sum.records,
          today: sum.today,
          week: sum.week,
          month: sum.month,
          days: sum.days
            .filter((d) => d.requests > 0)
            .map((d) => ({
              day: d.day,
              requests: d.requests,
              tokens: d.input + d.output,
              cost: d.cost,
            })),
          byModel: sum.byModel,
          byProvider: sum.byProvider,
          bySource: sum.bySource,
          topChats: sum.topChats.map((c) => ({ ...c, title: titles.get(c.session) ?? null })),
        };
      },
    }),
  );
  sub.add(
    services.state.register("ide://agent/usage/limits", {
      description:
        "What each model provider reported about its limits: the rate-limit headers of its last response this run (buckets such as requests / tokens / input-tokens with limit, remaining and reset — Anthropic, OpenAI and compatible servers) and OpenRouter's key credits from the last agent.refreshUsageLimits. null: not reported (local models, servers that send no headers). No network here.",
      get: async () => {
        const refs = providers.providers();
        const all = await refreshLimits(refs, { credits: false });
        const cached = providerLimits.peek();
        return refs.map((r) => ({
          id: r.id,
          name: r.name,
          kind: r.kind,
          rate: all[r.id]?.rate ?? null,
          credits: cached[r.id]?.credits ?? null,
        }));
      },
    }),
  );
}
