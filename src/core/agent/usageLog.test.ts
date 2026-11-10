import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentProvider,
  bucketLabel,
  dayKey,
  formatIn,
  formatTokens,
  makeAgentRecord,
  makeRecord,
  niceMax,
  parseRecord,
  providerAgent,
  resetAt,
  sessionSums,
  startOfDay,
  summarize,
  type UsageRecord,
} from "./usageLog";

const usage = (input: number, output: number, extra: Record<string, number> = {}) => ({
  inputTokens: input,
  outputTokens: output,
  ...extra,
});

test("makeRecord: priced, provider's cost, nothing reported (D201)", () => {
  const priced = makeRecord({
    t: 1,
    source: "chat",
    session: "s1",
    provider: "claude",
    model: "claude/claude-sonnet-4-5",
    usage: usage(1_000_000, 100_000, { cacheReadTokens: 600_000, cacheWriteTokens: 100_000 }),
    price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  });
  // 300k × 3 + 600k × 0.3 + 100k × 3.75 + 100k × 15 = 0.9 + 0.18 + 0.375 + 1.5
  assert.equal(priced?.cost, 2.955);
  assert.equal(priced?.costFrom, "price");
  assert.equal(priced?.session, "s1");
  const reported = makeRecord({
    t: 1,
    source: "completion",
    provider: "openrouter",
    model: "openrouter/x",
    usage: usage(10, 2, { cost: 0.00001 }),
    price: { input: 1000, output: 1000 },
  });
  assert.equal(reported?.cost, 0.00001);
  assert.equal(reported?.costFrom, "provider");
  assert.equal(reported?.session, undefined);
  const local = makeRecord({
    t: 1,
    source: "commit",
    provider: "ollama",
    model: "ollama/qwen",
    usage: usage(10, 5),
    price: undefined,
  });
  assert.equal(local?.cost, null);
  assert.equal(local?.costFrom, undefined);
  const onThisComputer = makeRecord({
    t: 1,
    source: "chat",
    provider: "ollama",
    model: "ollama/qwen",
    usage: usage(10, 5),
    price: undefined,
    local: true,
  });
  assert.equal(onThisComputer?.cost, 0);
  assert.equal(onThisComputer?.costFrom, "local");
  assert.equal(
    makeRecord({
      t: 1,
      source: "chat",
      provider: "p",
      model: "p/m",
      usage: { inputTokens: null, outputTokens: null },
      price: undefined,
    }),
    null,
  );
  // Tiny costs keep their precision.
  const tiny = makeRecord({
    t: 1,
    source: "completion",
    provider: "openai",
    model: "openai/gpt-5-nano",
    usage: usage(500, 0),
    price: { input: 0.05, output: 0.4 },
  });
  assert.equal(tiny?.cost, 0.000025);
});

test("parseRecord: validates and fills in (D201)", () => {
  assert.equal(parseRecord(null), null);
  assert.equal(parseRecord({ model: "a/b" }), null);
  assert.equal(parseRecord({ t: 5 }), null);
  const r = parseRecord({ t: 5, model: "ollama/x", input: -3, output: 2.6, source: "weird" });
  assert.deepEqual(r, {
    t: 5,
    source: "chat",
    provider: "ollama",
    model: "ollama/x",
    input: 0,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    cost: null,
  });
  assert.equal(
    parseRecord({ t: 5, model: "a/b", cost: 0.5, costFrom: "provider" })?.costFrom,
    "provider",
  );
});

const rec = (t: number, over: Partial<UsageRecord> = {}): UsageRecord => ({
  t,
  source: "chat",
  provider: "p",
  model: "p/m",
  input: 100,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0.01,
  ...over,
});

test("summarize: today, 7 and 30 days, days, breakdowns, top chats (D201)", () => {
  const now = new Date(2026, 9, 24, 15, 0).getTime();
  const day = (back: number, hour = 10) => {
    const d = new Date(2026, 9, 24 - back, hour);
    return d.getTime();
  };
  const records = [
    rec(day(0), { session: "a", cost: 0.02 }),
    rec(day(0, 1), { session: "b", model: "q/big", provider: "q", cost: 0.5 }),
    rec(day(3), { session: "a", source: "subagent" }),
    rec(day(10), { cost: null, model: "ollama/l", provider: "ollama", source: "commit" }),
    rec(day(40), { session: "old", cost: 9 }),
  ];
  const s = summarize(records, now);
  assert.equal(s.today.requests, 2);
  assert.equal(s.today.cost, 0.52);
  assert.equal(s.week.requests, 3);
  assert.equal(s.month.requests, 4);
  assert.equal(s.month.unpriced, 1);
  assert.equal(s.month.cost, 0.53);
  assert.equal(s.days.length, 30);
  assert.equal(s.days[29]?.day, dayKey(now));
  assert.equal(s.days[29]?.requests, 2);
  assert.equal(s.days[26]?.requests, 1);
  assert.equal(s.days[0]?.start, startOfDay(now, 29));
  assert.deepEqual(
    s.byModel.map((m) => m.model),
    ["q/big", "p/m", "ollama/l"],
  );
  assert.deepEqual(
    s.byProvider.map((p) => p.provider),
    ["q", "p", "ollama"],
  );
  assert.deepEqual(
    s.bySource.map((x) => x.source),
    ["chat", "subagent", "commit"],
  );
  assert.deepEqual(
    s.topChats.map((c) => [c.session, c.requests]),
    [
      ["b", 1],
      ["a", 2],
    ],
  );
  assert.equal(s.topChats[1]?.last, day(0));
  assert.equal(s.since, day(40));
  assert.equal(s.records, 5);
  // Seven days only.
  assert.equal(summarize(records, now, { days: 7 }).days.length, 7);
  assert.equal(sessionSums(records, "a").requests, 2);
  assert.equal(sessionSums(records, "a").cost, 0.03);
  assert.equal(summarize([], now).since, null);
});

test("resetAt and formatIn: Anthropic times, OpenAI durations (D201)", () => {
  const at = Date.parse("2026-10-24T12:00:00Z");
  assert.equal(resetAt("2026-10-24T12:00:30Z", at), at + 30_000);
  assert.equal(resetAt("6m0s", at), at + 360_000);
  assert.equal(resetAt("1.5s", at), at + 1500);
  assert.equal(resetAt("120ms", at), at + 120);
  assert.equal(resetAt("2h", at), at + 7_200_000);
  assert.equal(resetAt("30", at), at + 30_000);
  assert.equal(resetAt("soon", at), null);
  assert.equal(resetAt(null, at), null);
  assert.equal(formatIn(500), "now");
  assert.equal(formatIn(40_000), "in 40 s");
  assert.equal(formatIn(360_000), "in 6 min");
  assert.equal(formatIn(3 * 3_600_000), "in 3 h");
  assert.equal(formatIn(86_400_000), "in 1 day");
});

test("formatTokens, bucketLabel, niceMax (D201)", () => {
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(12_345), "12k");
  assert.equal(formatTokens(1_234), "1.2k");
  assert.equal(formatTokens(4_500_000), "4.50M");
  assert.equal(bucketLabel("input-tokens"), "Input tokens");
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(0.37), 0.5);
  assert.equal(niceMax(7), 10);
  assert.equal(niceMax(120), 200);
});

test("makeAgentRecord: an external agent's turn, with or without tokens (D208)", () => {
  const withTokens = makeAgentRecord({
    t: 5,
    session: "s1",
    agent: "Claude Code",
    model: "opus",
    usage: { input: 1000, output: 50, cacheRead: 900, cacheWrite: 20 },
    cost: 0.0123,
  });
  assert.equal(withTokens.provider, "acp:Claude Code");
  assert.equal(withTokens.model, "acp:Claude Code/opus");
  assert.equal(withTokens.input, 1000);
  assert.equal(withTokens.cacheRead, 900);
  assert.equal(withTokens.cost, 0.0123);
  assert.equal(withTokens.costFrom, "agent");
  assert.equal(withTokens.unreported, undefined);
  const none = makeAgentRecord({ t: 6, agent: "Codex", model: "", usage: null, cost: null });
  assert.equal(none.model, "acp:Codex/default");
  assert.equal(none.unreported, true);
  assert.equal(none.cost, null);
  assert.deepEqual(parseRecord(JSON.parse(JSON.stringify(none))), none);
  assert.equal(agentProvider("a/b"), "acp:a-b");
  assert.equal(providerAgent("acp:Codex"), "Codex");
  assert.equal(providerAgent("openai"), null);
  const sums = summarize([withTokens, none], 10);
  assert.equal(sums.today.requests, 2);
  assert.equal(sums.today.unreported, 1);
  // The unknown cost isn't $0: one request has no price.
  assert.equal(sums.today.unpriced, 1);
});
