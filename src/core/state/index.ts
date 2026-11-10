// The state tree: what agents "see" (PLAN §7). Features register providers for `ide://…` paths;
// `get(path, { budget })` returns their value, fitted to a size budget with truncation reported.
// The `ide://` scheme is internal and generic; it never changes with the product name.

import { closest } from "../agent/toolText";
import { type Disposable, toDisposable } from "../lifecycle/index";
import { type BudgetResult, fitToBudget } from "./budget";

export { type BudgetResult, fitToBudget } from "./budget";

export const STATE_SCHEME = "ide://";
const DEFAULT_BUDGET = 8_000;

export interface StateProviderContext {
  /** Size budget in JSON characters; providers may use it to pick what to include. */
  budget: number;
  /** The path's query, e.g. `ide://events?since=12` → { since: "12" } (D191). */
  params: Record<string, string>;
}

export interface StateProvider {
  /** What this path contains, for humans and models (shown by `list()`). */
  description: string;
  get(ctx: StateProviderContext): unknown | Promise<unknown>;
}

export interface StateSnapshot extends BudgetResult {
  path: string;
}

export class StateTree {
  private readonly providers = new Map<string, StateProvider>();

  register(path: string, provider: StateProvider): Disposable {
    if (!path.startsWith(STATE_SCHEME))
      throw new Error(`State path must start with ${STATE_SCHEME}: ${path}`);
    if (this.providers.has(path)) throw new Error(`State path already registered: ${path}`);
    this.providers.set(path, provider);
    return toDisposable(() => {
      if (this.providers.get(path) === provider) this.providers.delete(path);
    });
  }

  has(path: string): boolean {
    return this.providers.has(path);
  }

  /** Registered paths with descriptions, sorted. */
  list(): { path: string; description: string }[] {
    return [...this.providers]
      .map(([path, p]) => ({ path, description: p.description }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Reads one path. Throws for unknown paths (the message lists close matches). */
  async get(path: string, options: { budget?: number } = {}): Promise<StateSnapshot> {
    const q = path.indexOf("?");
    const base = q < 0 ? path : path.slice(0, q);
    const params: Record<string, string> =
      q < 0 ? {} : Object.fromEntries(new URLSearchParams(path.slice(q + 1)));
    const provider = this.providers.get(base);
    if (!provider) {
      const known = this.list().map((p) => p.path);
      const near = closest(base, known);
      throw new Error(
        `Unknown state path "${path}".${near.length ? ` Did you mean: ${near.join(", ")}?` : ""} Known paths: ${known.join(", ")}`,
      );
    }
    const budget = options.budget ?? DEFAULT_BUDGET;
    let value: unknown;
    try {
      value = await provider.get({ budget, params });
    } catch (err) {
      value = { error: err instanceof Error ? err.message : String(err) };
    }
    return { path, ...fitToBudget(value, budget) };
  }

  /**
   * Reads every path under `prefix` (default: all), splitting the total budget evenly.
   * This is the "whole IDE at a glance" view used by `dev.dumpState`.
   */
  async getTree(options: { prefix?: string; budget?: number } = {}): Promise<{
    budget: number;
    size: number;
    truncated: boolean;
    paths: Record<string, StateSnapshot>;
  }> {
    const prefix = options.prefix ?? STATE_SCHEME;
    const budget = options.budget ?? DEFAULT_BUDGET * 4;
    const paths = this.list()
      .map((p) => p.path)
      .filter((p) => p.startsWith(prefix));
    const perPath = Math.max(200, Math.floor(budget / Math.max(1, paths.length)));
    const snapshots = await Promise.all(paths.map((p) => this.get(p, { budget: perPath })));
    return {
      budget,
      size: snapshots.reduce((n, snap) => n + snap.size, 0),
      truncated: snapshots.some((snap) => snap.truncated),
      paths: Object.fromEntries(snapshots.map((snap) => [snap.path, snap])),
    };
  }
}
