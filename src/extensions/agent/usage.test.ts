import assert from "node:assert/strict";
import { test } from "node:test";
import { costOf, priceFor } from "./usage";

test("costOf: fresh, cached and output tokens at their prices (D191)", () => {
  const t = {
    requests: 2,
    input: 1_000_000,
    cacheRead: 600_000,
    cacheWrite: 100_000,
    output: 200_000,
  };
  // 300k fresh × 3 + 600k × 0.3 + 100k × 3.75 + 200k × 15 = 0.9 + 0.18 + 0.375 + 3 = 4.455
  assert.equal(costOf(t, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }), 4.455);
  assert.equal(costOf(t, undefined), null);
  const prices = {
    "anthropic/claude-x": { input: 3, output: 15 },
    "gpt-y": { input: 1, output: 2 },
  };
  assert.equal(priceFor(prices, "anthropic/claude-x")?.input, 3);
  assert.equal(priceFor(prices, "openai/gpt-y")?.output, 2);
  assert.equal(priceFor(prices, "local/none"), undefined);
});
