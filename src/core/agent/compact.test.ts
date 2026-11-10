import assert from "node:assert/strict";
import { test } from "node:test";
import { compactionCut, needsCompaction, parsePlan, planText, transcript } from "./compact";
import { type Item, toMessages } from "./conversation";

const user = (id: string, text = "do it"): Item => ({ type: "user", id, text });
const asst = (id: string, text = ""): Item => ({
  type: "assistant",
  id,
  text,
  thinking: "",
  streaming: false,
});
const tool = (id: string, result = "x".repeat(2000)): Item => ({
  type: "tool",
  id,
  callId: id,
  name: "read_file",
  args: { path: "a.ts" },
  status: "done",
  result,
});

test("parsePlan: objects, strings with checkboxes, JSON strings, junk", () => {
  assert.deepEqual(
    parsePlan({
      steps: [
        { text: "a", status: "done" },
        { text: "b", status: "in-progress" },
      ],
    }),
    [
      { text: "a", status: "done" },
      { text: "b", status: "in_progress" },
    ],
  );
  assert.deepEqual(parsePlan({ plan: "- [x] one\n- [ ] two" }), [
    { text: "one", status: "done" },
    { text: "two", status: "pending" },
  ]);
  assert.deepEqual(parsePlan({ steps: JSON.stringify([{ step: "c", completed: true }]) }), [
    { text: "c", status: "done" },
  ]);
  assert.equal(parsePlan({}), null);
  assert.equal(
    planText([
      { text: "a", status: "done" },
      { text: "b", status: "in_progress" },
    ]),
    "[x] a\n[~] b",
  );
});

test("a summary replaces what came before it in the messages", () => {
  const items: Item[] = [
    user("u1", "first task"),
    asst("a1", "old answer"),
    { type: "summary", id: "s", text: "Goal: X. Done: Y.", count: 2, auto: false },
    user("u2", "next"),
  ];
  const messages = toMessages(items, { textProtocol: false, budgetChars: 1e6 });
  assert.equal(messages.length, 1);
  assert.match(
    messages[0]?.content ?? "",
    /Summary of the conversation so far[\s\S]*Goal: X[\s\S]*next$/,
  );
  // Mid-turn summary: becomes its own user message, followed by the newer steps.
  const mid = toMessages(
    [
      user("u"),
      tool("t"),
      { type: "summary", id: "s", text: "S", count: 2, auto: true },
      asst("a", "hi"),
    ],
    {
      textProtocol: false,
      budgetChars: 1e6,
    },
  );
  assert.equal(mid[0]?.role, "user");
  assert.match(mid[0]?.content ?? "", /Continue from where you left off/);
  assert.equal(mid[1]?.content, "hi");
});

test("compactionCut keeps the current turn when it fits, never splits a tool from its call", () => {
  const items: Item[] = [
    user("u1"),
    asst("a1"),
    tool("t1"),
    asst("a2", "done"),
    user("u2"),
    asst("a3"),
  ];
  assert.equal(compactionCut(items, 100_000), 4);
  // One long turn: cut at an assistant step, keeping the newest steps that fit.
  const long: Item[] = [user("u")];
  for (let i = 0; i < 10; i++) long.push(asst(`a${i}`), tool(`t${i}`));
  const cut = compactionCut(long, 9000);
  assert.ok(cut > 2);
  assert.equal(long[cut]?.type, "assistant");
  assert.ok(needsCompaction(long, 9000));
  assert.ok(!needsCompaction(long, 1e6));
  assert.equal(compactionCut([user("u")], 10), 0);
});

test("transcript names a group chat's speakers when asked", () => {
  const items: Item[] = [
    { type: "user", id: "u1", text: "@Rev look" },
    {
      type: "assistant",
      id: "a1",
      text: "Looks fine.",
      thinking: "",
      streaming: false,
      speaker: "rev",
    },
    { type: "assistant", id: "a2", text: "Unlabelled.", thinking: "", streaming: false },
  ];
  const named = transcript(items, 1000, (n) => (n === "rev" ? "Rev" : n));
  assert.match(named, /REV: Looks fine\./);
  assert.match(named, /ASSISTANT: Unlabelled\./);
  assert.match(transcript(items, 1000), /ASSISTANT: Looks fine\./);
});

test("transcript shortens tool results and keeps the newest part", () => {
  const text = transcript([user("u", "hello"), tool("t", "y".repeat(5000))], 100_000);
  assert.match(text, /USER: hello/);
  assert.ok(text.length < 1500);
  assert.ok(transcript([user("u", "z".repeat(500))], 100).startsWith("…"));
});

test("observation masking: a long turn keeps its newest tool results whole and needs no summary (D127)", async () => {
  const { maskBoundary } = await import("./conversation");
  assert.equal(maskBoundary(10), 0);
  assert.equal(maskBoundary(17), 0);
  assert.equal(maskBoundary(18), 8);
  assert.equal(maskBoundary(25), 8);
  assert.equal(maskBoundary(26), 16);
  const items: Item[] = [{ type: "user", id: "u", text: "fix everything" }];
  for (let i = 0; i < 30; i++)
    items.push(
      { type: "assistant", id: `a${i}`, text: "", thinking: "", streaming: false },
      {
        type: "tool",
        id: `t${i}`,
        callId: `c${i}`,
        name: "read_file",
        args: { path: `f${i}.ts` },
        status: "done",
        result: `${i}:${"x".repeat(3000)}`,
      },
    );
  // Whole: ~90k characters. Masked (16 of 30 shortened): ~45k.
  const budget = 70_000;
  const sent = toMessages(items, { textProtocol: false, budgetChars: budget, stable: true });
  const tools = sent.filter((m) => m.role === "tool");
  assert.equal(tools.length, 30);
  assert.ok(tools[15]?.content.includes("omitted"));
  assert.ok(!tools[16]?.content.includes("omitted"));
  assert.ok(!tools[29]?.content.includes("omitted"));
  // The summary only comes when masking isn't enough.
  assert.equal(needsCompaction(items, budget), false);
  assert.equal(needsCompaction(items, 30_000), true);
});

test("the harness's feedback isn't a new turn: compaction keeps the task it answers (D127)", () => {
  const big = "y".repeat(400);
  const items: Item[] = [
    { type: "user", id: "old", text: "earlier task" },
    { type: "assistant", id: "a0", text: big, thinking: "", streaming: false },
    { type: "user", id: "task", text: "the task" },
    { type: "assistant", id: "a1", text: "done", thinking: "", streaming: false },
    { type: "user", id: "fb", text: "The project check `x` failed", auto: "verify" },
    { type: "assistant", id: "a2", text: "fixed", thinking: "", streaming: false },
  ];
  // The cut lands on the user's message, not on the feedback after it.
  assert.equal(compactionCut(items, 400), 2);
});
