// Model prices for the usage display (D199): dollars per million tokens. The user's agent.prices
// win, then what the provider lists (OpenRouter's /models), then the built-in list below — the
// published list prices of common hosted models, approximate and dated (October 2026); a model
// that isn't listed has no cost shown rather than a guess. DOM-free and tested.

/** Dollars per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * By model id prefix (the longest prefix that matches wins, so dated ids like
 * "claude-sonnet-4-5-20250929" find "claude-sonnet-4-5"). Anthropic's cache reads are 0.1× and
 * writes 1.25× the input price; OpenAI's cached input is listed per model.
 */
const anthropic = (input: number, output: number): ModelPrice => ({
  input,
  output,
  cacheRead: Math.round(input * 0.1 * 1000) / 1000,
  cacheWrite: Math.round(input * 1.25 * 1000) / 1000,
});

export const DEFAULT_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-4-5": anthropic(5, 25),
  "claude-opus-4-1": anthropic(15, 75),
  "claude-opus-4": anthropic(15, 75),
  "claude-sonnet-4-5": anthropic(3, 15),
  "claude-sonnet-4": anthropic(3, 15),
  "claude-3-7-sonnet": anthropic(3, 15),
  "claude-3-5-sonnet": anthropic(3, 15),
  "claude-haiku-4-5": anthropic(1, 5),
  "claude-3-5-haiku": anthropic(0.8, 4),
  "gpt-5-nano": { input: 0.05, output: 0.4, cacheRead: 0.005 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025 },
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4, cacheRead: 0.025 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cacheRead: 0.1 },
  "gpt-4.1": { input: 2, output: 8, cacheRead: 0.5 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cacheRead: 0.075 },
  "gpt-4o": { input: 2.5, output: 10, cacheRead: 1.25 },
  "o4-mini": { input: 1.1, output: 4.4, cacheRead: 0.275 },
  o3: { input: 2, output: 8, cacheRead: 0.5 },
};

export interface Totals {
  requests: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/**
 * Cost in dollars of `t` at `price` (null when unknown). Input counts every prompt token, cached
 * ones included: those are charged at the cache rates instead. Rounded to `digits` decimals (the
 * usage log keeps 8: a short completion on a cheap model costs millionths).
 */
export function costOf(t: Totals, price: ModelPrice | undefined, digits = 4): number | null {
  if (!price) return null;
  const fresh = Math.max(0, t.input - t.cacheRead - t.cacheWrite);
  const dollars =
    fresh * price.input +
    t.cacheRead * (price.cacheRead ?? price.input) +
    t.cacheWrite * (price.cacheWrite ?? price.input) +
    t.output * price.output;
  const scale = 10 ** digits;
  return Math.round((dollars / 1_000_000) * scale) / scale;
}

const DATED = /^(\d{6,}|\d{4}-\d{2}-\d{2}|latest)$/;

function valid(p: unknown): p is ModelPrice {
  const x = p as Partial<ModelPrice> | null;
  return !!x && typeof x.input === "number" && typeof x.output === "number";
}

/** The built-in price for a model id ("anthropic/claude-sonnet-4-5-2025…", "gpt-4o"…), if any. */
export function defaultPrice(model: string): ModelPrice | undefined {
  // OpenRouter ids carry the vendor ("openai/gpt-4o"); the provider part of a key is dropped too.
  const id = model.slice(model.lastIndexOf("/") + 1).toLowerCase();
  let best: string | undefined;
  for (const key of Object.keys(DEFAULT_PRICES))
    if (
      (id === key ||
        id.startsWith(`${key}:`) ||
        // Only a date or "latest" after the id: "o3-pro" and "gpt-5-pro" cost far more than "o3"
        // and "gpt-5", and an unknown variant shows no cost rather than a wrong one.
        (id.startsWith(`${key}-`) && DATED.test(id.slice(key.length + 1)))) &&
      key.length > (best?.length ?? 0)
    )
      best = key;
  return best ? DEFAULT_PRICES[best] : undefined;
}

/**
 * The price for "provider/model": agent.prices (the whole key, then the model id), then the
 * provider's listed price, then the built-in list.
 */
export function resolvePrice(
  model: string | null,
  userPrices: Record<string, unknown> | undefined,
  listed?: ModelPrice | null,
): ModelPrice | undefined {
  if (!model) return undefined;
  const short = model.slice(model.indexOf("/") + 1);
  const own = userPrices?.[model] ?? userPrices?.[short];
  if (valid(own)) return own;
  if (listed && valid(listed)) return listed;
  return defaultPrice(model);
}

/** "$0.0123", "$1.20", "<$0.01" (null: no price known). */
export function formatCost(dollars: number | null): string {
  if (dollars === null) return "";
  if (dollars === 0) return "$0";
  if (dollars < 0.01) return dollars < 0.0001 ? "<$0.0001" : `$${dollars.toFixed(4)}`;
  return `$${dollars.toFixed(dollars < 1 ? 3 : 2)}`;
}

export type BudgetState = "ok" | "warn" | "over";

/** Where a chat's cost stands against its budget (0: no budget). Warns from 80 %. */
export function budgetState(cost: number | null, budget: number): BudgetState {
  if (!budget || budget <= 0 || cost === null) return "ok";
  if (cost >= budget) return "over";
  return cost >= budget * 0.8 ? "warn" : "ok";
}
