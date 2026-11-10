import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "../../../core/agent/conversation";
import { textToolDraft } from "../../../core/agent/loop";
import {
  layoutTurns,
  thinkingActivity,
  thoughtHeadline,
  workActivity,
  workRows,
  workSummary,
} from "./turns";

const user = (id: string): Item => ({ type: "user", id, text: "hi" });
const asst = (
  id: string,
  text: string,
  extra: Partial<Item & { type: "assistant" }> = {},
): Item => ({
  type: "assistant",
  id,
  text,
  thinking: "",
  streaming: false,
  ...extra,
});
const tool = (id: string, name: string, extra: Partial<Item & { type: "tool" }> = {}): Item => ({
  type: "tool",
  id,
  callId: id,
  name,
  args: { path: "a.ts" },
  status: "done",
  ...extra,
});

const shape = (items: Item[]) =>
  layoutTurns(items).map((s) =>
    s.kind === "work"
      ? `work[${s.entries.map((e) => (e.kind === "thinking" ? `T:${e.item.id}` : e.item.id)).join(",")}]`
      : s.item.id,
  );

test("plain answer: no group", () => {
  assert.deepEqual(shape([user("u"), asst("a", "Hello")]), ["u", "a"]);
});

test("a group chat's next agent: a turn of its own, the harness's note hidden (D231)", () => {
  const note: Item = { type: "user", id: "g", text: "(Your turn)", auto: "group" };
  assert.deepEqual(
    shape([
      user("u"),
      asst("a1", "", { speaker: "scout" }),
      tool("t1", "read_file"),
      asst("a2", "@Forge build it", { speaker: "scout" }),
      note,
      asst("b1", "Built.", { speaker: "forge" }),
    ]),
    ["u", "work[t1]", "a2", "b1"],
  );
});

test("text between steps shows in the conversation; the steps between collapse (D159)", () => {
  assert.deepEqual(
    shape([
      user("u"),
      asst("a1", "Looking", { thinking: "hmm", thinkingMs: 2000 }),
      tool("t1", "read_file"),
      asst("a2", ""),
      tool("t2", "edit_file", { changes: ["/x/a.ts"] }),
      asst("a3", "Done", { thinking: "ok" }),
      user("u2"),
      asst("b", "Sure"),
    ]),
    ["u", "a1", "work[T:a1,t1,t2,T:a3]", "a3", "u2", "b"],
  );
  // Two texts with steps after each: two groups, the changes card under the last one.
  const two = layoutTurns([
    user("u"),
    asst("n1", "First I'll look."),
    tool("t1", "read_file"),
    asst("n2", "Now the fix."),
    tool("t2", "edit_file", { changes: ["/a"] }),
    asst("a", "Fixed."),
  ]);
  assert.deepEqual(
    two.map((s) =>
      s.kind === "work" ? `work[${s.entries.map((e) => e.item.id).join(",")}]` : s.item.id,
    ),
    ["u", "n1", "work[t1]", "n2", "work[t2]", "a"],
  );
  const groups = two.filter((s) => s.kind === "work");
  assert.deepEqual(
    groups.map((g) => g.kind === "work" && g.changes),
    [[], ["/a"]],
  );
  const work = layoutTurns([
    user("u"),
    tool("t", "edit_file", { changes: ["/p"] }),
    asst("a", "x"),
  ])[1];
  assert.ok(work?.kind === "work");
  assert.deepEqual(work.changes, ["/p"]);
});

test("while streaming: text before a tool call is the answer until the call comes", () => {
  assert.deepEqual(shape([user("u"), asst("a", "Let me look", { streaming: true })]), ["u", "a"]);
  // A new step that hasn't written yet shows as the group's "Thinking".
  assert.deepEqual(shape([user("u"), tool("t", "read_file"), asst("a", "", { streaming: true })]), [
    "u",
    "work[t,T:a]",
  ]);
});

test("summary and activity lines", () => {
  const segs = layoutTurns([
    user("u"),
    tool("t1", "write_file"),
    tool("t2", "write_file"),
    tool("t3", "read_file"),
    tool("t4", "run_command", { status: "error" }),
    asst("a", "ok"),
  ]);
  const work = segs[1];
  assert.ok(work?.kind === "work");
  assert.equal(workSummary(work.entries), "Created 2 files, read a file, ran a command, 1 failed");
  const label = () => ({ verb: "Read", target: "src/App.tsx" });
  assert.equal(
    workActivity(
      [{ kind: "item", item: tool("r", "read_file", { status: "running" }) as never }],
      label,
    ),
    "Reading src/App.tsx",
  );
  assert.equal(
    workSummary([
      { kind: "thinking", item: asst("a", "", { thinking: "x", thinkingMs: 4200 }) as never },
    ]),
    "Thought for 4s",
  );
});

test("activity while streaming: tool drafts and thought headings", () => {
  const label = () => ({ verb: "", target: "" });
  const drafting = asst("a", "", {
    streaming: true,
    toolDraft: { name: "write_file", path: "index.html", chars: 12400 },
  });
  assert.equal(
    workActivity([{ kind: "thinking", item: drafting as never }], label),
    "Writing index.html (12k characters)",
  );
  assert.equal(
    thinkingActivity("Let me see.\n\n**Planning the layout**\n\nThe page needs"),
    "Planning the layout",
  );
  assert.equal(thinkingActivity("just thinking out loud"), "Working");
  assert.deepEqual(
    textToolDraft(
      'Sure.<tool_call>{"name": "write_file", "arguments": {"path": "a.css", "content": "body {',
    ),
    { name: "write_file", path: "a.css", chars: 72 },
  );
  assert.equal(textToolDraft('<tool_call>{"name":"x"}</tool_call>'), null);
});

test("the verify step's run after the answer keeps the answer shown (D127)", () => {
  const items = [
    user("u"),
    tool("e", "edit_file", { changes: ["a.ts"] }),
    asst("a", "Fixed it."),
    tool("v", "run_command", { check: true, args: { command: "npm test" } }),
  ];
  assert.deepEqual(shape(items), ["u", "work[e,v]", "a"]);
  assert.equal(
    workSummary(layoutTurns(items).flatMap((s) => (s.kind === "work" ? s.entries : []))),
    "Checks passed, edited a file",
  );
});

test("work rows: first thought on top, later thinking inside its tool, answer's at the end", () => {
  const items = [
    user("u"),
    asst("a1", "", { thinking: "**Looking around**\nread first" }),
    tool("t1", "read_file"),
    asst("a2", "", { thinking: "Now run it. Then more." }),
    tool("t2", "run_command"),
    asst("a3", "Checking the build."),
    tool("t3", "run_command"),
    asst("a4", "Done", { thinking: "all good" }),
  ];
  const groups = layoutTurns(items).filter((s) => s.kind === "work");
  const names = (entries: Parameters<typeof workRows>[0]) =>
    workRows(entries).map(
      (r) =>
        `${r.kind}:${r.kind === "tool" ? `${r.item.id}${r.thinking ? `+${r.thinking.id}` : ""}` : r.item.id}`,
    );
  const [first, second] = groups;
  assert.ok(first?.kind === "work" && second?.kind === "work");
  assert.deepEqual(names(first.entries), ["thought:a1", "tool:t1", "tool:t2+a2"]);
  // a3's text shows between the groups; the second group holds what came after it.
  assert.deepEqual(names(second.entries), ["tool:t3", "thoughts:a4"]);
  const rows = workRows(first.entries);
  assert.equal(rows[0]?.kind === "thought" && rows[0].text, "Looking around");
});

test("work rows: a step still thinking shows its headline", () => {
  const rows = workRows([
    { kind: "item", item: tool("t1", "read_file") as never },
    {
      kind: "item",
      item: asst("a2", "", {
        thinking: "Hmm, the tests look flaky here.",
        streaming: true,
      }) as never,
    },
  ]);
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["tool", "thought"],
  );
});

test("thought headline: heading, else first sentence, shortened", () => {
  assert.equal(thoughtHeadline("## Plan:\nstuff"), "Plan");
  assert.equal(thoughtHeadline("The user wants a logo. Let me see."), "The user wants a logo.");
  assert.ok(thoughtHeadline("x".repeat(200)).endsWith("…"));
});

test("a cut-off reply's carry-on stays in the same group, unshown (D157)", () => {
  assert.deepEqual(
    shape([
      user("u"),
      tool("t1", "read_file"),
      asst("a1", "", { thinking: "long" }),
      { type: "user", id: "lim", text: "(carry on)", auto: "limit" },
      tool("t2", "write_file"),
      asst("a2", "Done"),
    ]),
    ["u", "work[t1,a1,t2]", "a2"],
  );
});

test("a display tool's card sits in the conversation, not the work group (D171)", () => {
  assert.deepEqual(
    shape([
      user("u"),
      tool("t1", "read_file"),
      asst("a1", ""),
      tool("c", "show_links"),
      asst("a2", ""),
      tool("t2", "search"),
      asst("a3", "Signups peaked in March."),
    ]),
    ["u", "work[t1]", "c", "work[t2]", "a3"],
  );
  // A call that failed is a row in the work, like any tool.
  assert.deepEqual(
    shape([user("u"), tool("c", "show_links", { status: "error" }), asst("a", "Done")]),
    ["u", "work[c]", "a"],
  );
});

test("D301–D303: wrap_up isn't drawn where it was called; a proposed task is a card", () => {
  assert.deepEqual(
    shape([
      user("u"),
      asst("s1", ""),
      tool("r", "read_file"),
      tool("p", "propose_task"),
      asst("s2", ""),
      tool("w", "wrap_up"),
      asst("a", "Done."),
    ]),
    ["u", "work[r]", "p", "a"],
  );
  // A call that failed stays a row, so the user sees it.
  assert.deepEqual(
    shape([user("u"), asst("s1", ""), tool("w", "wrap_up", { status: "error" }), asst("a", "x")]),
    ["u", "work[w]", "a"],
  );
});

test("D302: a chapter that opens a turn goes above its message; later, where it was marked", () => {
  assert.deepEqual(
    shape([
      user("u1"),
      asst("a1", "Done."),
      user("u2"),
      asst("s1", ""),
      tool("c", "mark_chapter"),
      tool("r", "read_file"),
      asst("s2", ""),
      tool("c2", "mark_chapter"),
      tool("e", "edit_file"),
      asst("a2", "Fixed."),
    ]),
    ["u1", "a1", "c", "u2", "work[r]", "c2", "work[e]", "a2"],
  );
});
