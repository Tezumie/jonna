import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTO_CHAT_WIDTH,
  chatChanges,
  contextBreakdown,
  conversationSizes,
  DETAILS_CARDS,
  DETAILS_WIDTH,
  detailsLayout,
  detailsSetting,
  formatElapsed,
  formatTokens,
  IMAGE_CHARS,
  MIN_CHAT_WIDTH,
  mcpServerOf,
  moveCard,
  promptPartsOf,
  rememberPromptParts,
  sanitizeFolded,
  sanitizeOrder,
  toolSizes,
  untilAutoCompact,
} from "./chatDetails";

test("details: auto shows the panel beside the chat when the chat keeps a comfortable width", () => {
  const fits = AUTO_CHAT_WIDTH + DETAILS_WIDTH;
  assert.equal(detailsLayout(fits, "auto"), "side");
  assert.equal(detailsLayout(fits - 1, "auto"), "sheet");
  assert.equal(detailsLayout(1600, "auto"), "side");
  assert.equal(detailsLayout(320, "auto"), "sheet");
  assert.equal(detailsLayout(0, "auto"), "sheet");
});

test("details: always keeps it beside a usable chat; never turns it off", () => {
  assert.equal(detailsLayout(MIN_CHAT_WIDTH + DETAILS_WIDTH, "always"), "side");
  assert.equal(detailsLayout(MIN_CHAT_WIDTH + DETAILS_WIDTH - 1, "always"), "sheet");
  assert.equal(detailsLayout(700, "always"), "side");
  assert.equal(detailsLayout(700, "auto"), "sheet");
  assert.equal(detailsLayout(4000, "never"), "off");
  assert.equal(detailsSetting("always"), "always");
  assert.equal(detailsSetting("never"), "never");
  assert.equal(detailsSetting("bogus"), "auto");
  assert.equal(detailsSetting(undefined), "auto");
});

test("details: token and time labels", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(850), "850");
  assert.equal(formatTokens(1000), "1k");
  assert.equal(formatTokens(12_449), "12.4k");
  assert.equal(formatTokens(383_500), "383.5k");
  assert.equal(formatTokens(999_999), "1M");
  assert.equal(formatTokens(1_000_000), "1M");
  assert.equal(formatTokens(1_250_000), "1.3M");
  assert.equal(formatTokens(-5), "0");
  assert.equal(formatElapsed(8_400), "8s");
  assert.equal(formatElapsed(184_000), "3m 04s");
  assert.equal(formatElapsed(3_720_000), "1h 02m");
  assert.equal(formatElapsed(-1), "0s");
});

test("details: prompt parts are remembered by text, the oldest dropped", () => {
  const parts = { instructions: 10, memory: 1, rules: 2, skills: 3, repoMap: 4 };
  rememberPromptParts("prompt A", parts);
  assert.deepEqual(promptPartsOf("prompt A"), parts);
  assert.equal(promptPartsOf("prompt B"), null);
  for (let i = 0; i < 20; i++) rememberPromptParts(`p${i}`, parts);
  assert.equal(promptPartsOf("prompt A"), null);
  assert.deepEqual(promptPartsOf("p19"), parts);
});

test("details: MCP tools are told apart by their description and grouped per server", () => {
  assert.equal(mcpServerOf("[MCP github] Lists issues"), "github");
  assert.equal(mcpServerOf("Reads a file"), null);
  assert.equal(mcpServerOf(undefined), null);
  const sizes = toolSizes([
    { name: "read_file", description: "Reads a file", parameters: {} },
    { name: "gh_issues", description: "[MCP github] Lists issues", parameters: {} },
    { name: "gh_prs", description: "[MCP github] Lists pull requests", parameters: {} },
    { name: "fs_x", description: "[MCP files] x", parameters: {} },
  ]);
  assert.ok(sizes.tools > 0);
  assert.deepEqual(
    sizes.mcp.map((s) => [s.server, s.tools]),
    [
      ["github", 2],
      ["files", 1],
    ],
  );
});

test("details: the context splits by part and scales to the provider's count", () => {
  const input = {
    system: 4000,
    parts: { instructions: 2000, memory: 400, rules: 600, skills: 800, repoMap: 200 },
    tools: 2000,
    mcp: [{ server: "github", tools: 3, chars: 1000 }],
    conversation: 8000,
    attachments: 400,
  };
  const est = contextBreakdown(input, null, 10_000);
  assert.ok(est);
  // 4000 + 2000 + 1000 + 8000 + 400 = 15 400 chars → 3 850 tokens.
  assert.equal(est.used, 3850);
  assert.equal(est.estimated, true);
  assert.equal(est.limit, 10_000);
  assert.equal(est.percent, 39);
  const by = Object.fromEntries(est.rows.map((r) => [r.key, r.tokens]));
  assert.equal(by.system, 550); // 4000 - rules/memory (1000) - skills (800) = 2200 chars
  assert.equal(by.rules, 250);
  assert.equal(by.skills, 200);
  assert.equal(by.tools, 500);
  assert.equal(by.mcp, 250);
  assert.equal(by.conversation, 2000);
  assert.equal(by.attachments, 100);
  assert.equal(est.free, 10_000 - 3850);
  // The provider counted 7 700: everything doubles, and the total is exact.
  const exact = contextBreakdown(input, { tokens: 7700, limit: 20_000, estimated: false }, null);
  assert.ok(exact);
  assert.equal(exact.used, 7700);
  assert.equal(exact.estimated, false);
  assert.equal(exact.limit, 20_000);
  assert.equal(exact.rows.find((r) => r.key === "conversation")?.tokens, 4000);
  assert.equal(exact.rows.find((r) => r.key === "conversation")?.percent, 20);
  assert.equal(exact.mcpServers[0]?.tokens, 500);
});

test("details: no window size, nothing; no system prompt yet, no system rows", () => {
  const input = { system: null, parts: null, tools: 400, mcp: [], conversation: 0, attachments: 0 };
  assert.equal(contextBreakdown(input, null, null), null);
  const b = contextBreakdown(input, null, 1000);
  assert.ok(b);
  assert.deepEqual(
    b.rows.map((r) => r.key),
    ["tools"],
  );
  // An estimated count from the provider stays an estimate.
  const e = contextBreakdown(input, { tokens: 300, limit: 1000, estimated: true }, null);
  assert.equal(e?.estimated, true);
  assert.equal(e?.used, 100);
});

test("details: the conversation counts from the newest summary, attachments apart", () => {
  const sizes = conversationSizes([
    { type: "user", text: "x".repeat(1000) },
    { type: "summary", text: "s".repeat(50) },
    {
      type: "user",
      text: "hello",
      state: "st",
      context: ["c".repeat(30)],
      images: ["img"],
    },
    { type: "assistant", text: "answer", thinking: "ignored" },
    { type: "tool", args: { a: 1 }, result: "r".repeat(10) },
    { type: "notice" },
  ]);
  assert.equal(sizes.conversation, 50 + 5 + 2 + 6 + JSON.stringify({ a: 1 }).length + 10);
  assert.equal(sizes.attachments, 30 + IMAGE_CHARS);
});

test("details: the chat's changes add up each turn's files once, pending ones too", () => {
  const stats: Record<string, { added: number; removed: number }> = {
    "1#a.ts": { added: 3, removed: 1 },
    "2#a.ts": { added: 2, removed: 0 },
    "2#b.ts": { added: 5, removed: 4 },
  };
  const totals = chatChanges(
    [
      { type: "user", turn: 1 },
      { type: "tool", changes: ["a.ts"] },
      { type: "tool", changes: ["a.ts"] },
      { type: "assistant" },
      { type: "user", turn: 2 },
      { type: "tool", changes: ["a.ts", "b.ts", "gone.ts"] },
    ],
    (path, turn) => stats[`${turn}#${path}`],
    [
      { path: "b.ts", added: 5, removed: 4 },
      { path: "c.ts", added: 1, removed: 1 },
    ],
  );
  assert.deepEqual(totals, { files: 3, added: 11, removed: 6, review: 2 });
  assert.deepEqual(
    chatChanges([], () => undefined, []),
    { files: 0, added: 0, removed: 0, review: 0 },
  );
});

test("details: folded cards keep known names once", () => {
  assert.deepEqual(sanitizeFolded(["context", "nope", "context", 3, "plan"]), ["context", "plan"]);
  assert.deepEqual(sanitizeFolded("context"), []);
});

test("cards' order: saved, then new ones; moving one before another (D409)", () => {
  assert.deepEqual(sanitizeOrder(["plan", "nope", "context"]), [
    "plan",
    "context",
    "environment",
    "changes",
    "background",
  ]);
  assert.deepEqual(sanitizeOrder(undefined), [...DETAILS_CARDS]);
  const order = [...DETAILS_CARDS];
  assert.deepEqual(moveCard(order, "plan", "environment"), [
    "plan",
    "environment",
    "context",
    "changes",
    "background",
  ]);
  assert.deepEqual(moveCard(order, "environment", null), [
    "context",
    "changes",
    "background",
    "plan",
    "environment",
  ]);
  assert.deepEqual(moveCard(order, "context", "context"), order);
});

test("untilAutoCompact: 80% of 70% of the window, or of a channel's cap (D409)", () => {
  assert.equal(untilAutoCompact(0, 100_000, null), 56_000);
  assert.equal(untilAutoCompact(50_000, 100_000, null), 6_000);
  assert.equal(untilAutoCompact(90_000, 100_000, null), 0);
  assert.equal(untilAutoCompact(0, 1_000_000, 32_000), 25_600);
});
