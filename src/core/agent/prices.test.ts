import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetState, defaultPrice, formatCost, resolvePrice } from "./prices";

test("prices: the user's, the provider's, then the built-in list", () => {
  assert.equal(defaultPrice("anthropic/claude-sonnet-4-5-20250929")?.input, 3);
  assert.equal(defaultPrice("openrouter/openai/gpt-4o-mini")?.input, 0.15);
  // The longest prefix wins: gpt-4o-mini isn't gpt-4o.
  assert.equal(defaultPrice("openai/gpt-4o")?.input, 2.5);
  assert.equal(defaultPrice("ollama/qwen3:8b"), undefined);
  assert.equal(defaultPrice("x/claude-sonnet-4-5")?.cacheRead, 0.3);
  // Variants that cost more aren't priced as the base model (review 11).
  assert.equal(defaultPrice("openai/o3-pro"), undefined);
  assert.equal(defaultPrice("openai/gpt-5-pro"), undefined);
  assert.equal(defaultPrice("gpt-4o-2024-08-06")?.input, 2.5);
  const listed = { input: 1, output: 2 };
  assert.deepEqual(resolvePrice("openrouter/a/b", undefined, listed), listed);
  assert.deepEqual(resolvePrice("openrouter/a/b", { "a/b": { input: 9, output: 9 } }, listed), {
    input: 9,
    output: 9,
  });
  assert.equal(resolvePrice(null, {}), undefined);
});

test("cost labels and budgets", () => {
  assert.equal(formatCost(null), "");
  assert.equal(formatCost(0.00042), "$0.0004");
  assert.equal(formatCost(0.123), "$0.123");
  assert.equal(formatCost(2.5), "$2.50");
  assert.equal(budgetState(0.5, 0), "ok");
  assert.equal(budgetState(0.85, 1), "warn");
  assert.equal(budgetState(1, 1), "over");
  assert.equal(budgetState(null, 1), "ok");
});
