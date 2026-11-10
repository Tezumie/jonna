import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "./conversation";
import { FORK_PROMPT, forkBudget, forkSystem, forkTranscript } from "./fork";

const user = (id: string, text: string, auto?: "limit" | "process"): Item => ({
  type: "user",
  id,
  text,
  ...(auto && { auto }),
});
const said = (id: string, text: string): Item => ({
  type: "assistant",
  id,
  text,
  thinking: "",
  streaming: false,
});
const tool = (id: string, result: string, status: "done" | "running" = "done"): Item => ({
  type: "tool",
  id,
  callId: id,
  name: status === "running" ? "delegate" : "read_file",
  args: { path: `${id}.ts` },
  status,
  result,
});

test("the conversation as a transcript: who said what, tool calls with results", () => {
  const { text, omitted } = forkTranscript(
    [
      user("u1", "Fix the login bug"),
      said("a1", "Looking at it."),
      tool("t1", "export function login() {}"),
      { type: "notice", id: "n", text: "Stopped.", tone: "info" },
      user("u2", "(carry on)", "limit"),
      user("u3", "Background command bg1 ended", "process"),
      // The delegate call that starts the fork is still running: not in it.
      tool("t2", "", "running"),
    ],
    10_000,
  );
  assert.equal(omitted, 0);
  assert.equal(
    text,
    [
      "USER: Fix the login bug",
      "YOU (the agent): Looking at it.",
      'TOOL read_file {"path":"t1.ts"} → done\nexport function login() {}',
      "IDE (automatic message: process): Background command bg1 ended",
    ].join("\n\n"),
  );
});

test("a summary stands in for what it replaced", () => {
  const { text } = forkTranscript(
    [
      user("u0", "old stuff"),
      { type: "summary", id: "s", text: "Goal: X.", count: 1, auto: true },
      user("u1", "next"),
    ],
    10_000,
  );
  assert.doesNotMatch(text, /old stuff/);
  assert.match(text, /^USER: Summary of the conversation so far[\s\S]*Goal: X\.[\s\S]*next/);
});

test("too long: the first request stays, then the newest messages that fit", () => {
  const items: Item[] = [user("u0", "The original task")];
  for (let i = 1; i <= 40; i++) items.push(said(`a${i}`, `step ${i} ${"x".repeat(200)}`));
  const { text, omitted } = forkTranscript(items, 3000);
  assert.ok(text.length <= 3100, `length ${text.length}`);
  assert.match(text, /^USER: The original task\n\n\[\d+ earlier messages left out\]/);
  assert.match(text, /step 40 x+$/);
  assert.doesNotMatch(text, /step 1 /);
  assert.ok(omitted > 20);
});

test("old tool results are shortened more than recent ones", () => {
  const items: Item[] = [user("u", "go")];
  for (let i = 0; i < 10; i++) items.push(tool(`t${i}`, "y".repeat(5000)));
  const { text } = forkTranscript(items, 1_000_000);
  const blocks = text.split("\n\nTOOL ").slice(1);
  assert.equal(blocks.length, 10);
  assert.ok((blocks[0] ?? "").length < 500);
  assert.ok((blocks[9] ?? "").length > 1500 && (blocks[9] ?? "").length < 2200);
});

test("the budget is about a third of the window, within bounds; the prompt has both parts", () => {
  assert.equal(forkBudget(100_000), 140_000);
  assert.equal(forkBudget(null), 44_800);
  assert.equal(forkBudget(2_000), 8_000);
  assert.equal(forkBudget(2_000_000), 240_000);
  const s = forkSystem("You do one task.", "USER: hi");
  assert.ok(s.startsWith("You do one task."));
  assert.ok(s.includes(FORK_PROMPT));
  assert.ok(s.endsWith("<conversation>\nUSER: hi\n</conversation>"));
  // Not twice when the base is the fork's own.
  assert.equal(forkSystem(FORK_PROMPT, "x").split(FORK_PROMPT).length, 2);
});
