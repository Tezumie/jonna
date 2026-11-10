// D223: an external agent's turn split by model (`_meta.quota.model_usage`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { addRecord, emptySums, makeAgentRecord, parseRecord } from "../agent/usageLog";
import { promptModelUsage } from "./display";

test("Claude Code's and Codex's per-model rows", () => {
  // Claude Code: input without the cache, totalTokens with it.
  const claude = {
    stopReason: "end_turn",
    _meta: {
      quota: {
        token_count: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        model_usage: [
          {
            model: "claude-opus-5",
            token_count: {
              totalTokens: 1150,
              inputTokens: 100,
              cachedInputTokens: 1000,
              cachedWriteTokens: 0,
              outputTokens: 50,
            },
          },
          {
            model: "claude-haiku-5",
            token_count: { totalTokens: 30, inputTokens: 20, outputTokens: 10 },
          },
          { model: "", token_count: { inputTokens: 1 } },
          { model: "x" },
        ],
      },
    },
  };
  assert.deepEqual(promptModelUsage(claude), [
    { model: "claude-opus-5", usage: { input: 1100, output: 50, cacheRead: 1000, cacheWrite: 0 } },
    { model: "claude-haiku-5", usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 } },
  ]);
  // Codex: input already counts the cached tokens.
  const codex = {
    _meta: {
      quota: {
        model_usage: [
          {
            model: "gpt-6",
            token_count: {
              totalTokens: 1200,
              inputTokens: 1000,
              cachedInputTokens: 800,
              outputTokens: 200,
            },
          },
        ],
      },
    },
  };
  assert.deepEqual(promptModelUsage(codex), [
    { model: "gpt-6", usage: { input: 1000, output: 200, cacheRead: 800, cacheWrite: 0 } },
  ]);
  assert.deepEqual(promptModelUsage({ stopReason: "end_turn" }), []);
  assert.deepEqual(promptModelUsage(null), []);
});

test("a model's share of a turn counts tokens but not a request", () => {
  const main = makeAgentRecord({
    t: 1,
    agent: "Claude Code",
    model: "claude-opus-5",
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    cost: 0.5,
  });
  const part = makeAgentRecord({
    t: 1,
    agent: "Claude Code",
    model: "claude-haiku-5",
    usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 },
    cost: null,
    part: true,
  });
  assert.equal(part.part, true);
  assert.equal(parseRecord(JSON.parse(JSON.stringify(part)))?.part, true);
  const sums = emptySums();
  addRecord(sums, main);
  addRecord(sums, part);
  assert.equal(sums.requests, 1);
  assert.equal(sums.input, 120);
  assert.equal(sums.unpriced, 0);
  assert.equal(sums.cost, 0.5);
});
