import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "./conversation";
import {
  buildMessage,
  editedPlanContext,
  latestPlanNotice,
  planAnswerBefore,
  planEdited,
  planFileName,
  planSteps,
  planTitle,
} from "./planDoc";

const items: Item[] = [
  { type: "user", id: "u1", text: "plan it" },
  { type: "assistant", id: "a1", text: "Looking first.", thinking: "" },
  { type: "tool", id: "t1", name: "read_file", args: {}, status: "done" },
  {
    type: "assistant",
    id: "a2",
    text: "<title>Plan</title>\n# Add search\n\n1. Parse\n2. Rank",
    thinking: "",
  },
  { type: "notice", id: "n1", text: "Plan ready.", tone: "info", actions: ["build"] },
] as Item[];

test("planAnswerBefore takes the turn's last answer, without wrapper tags", () => {
  assert.equal(latestPlanNotice(items), 4);
  assert.equal(planAnswerBefore(items, 4), "# Add search\n\n1. Parse\n2. Rank");
  // No answer since the user's message: none.
  assert.equal(planAnswerBefore(items.slice(0, 1), 1), null);
  assert.equal(latestPlanNotice(items.slice(0, 3)), -1);
  // A closing line after the plan (after wrap_up) isn't the plan.
  const closing = [
    ...items.slice(0, 4),
    { type: "assistant", id: "a3", text: "That's the plan.", thinking: "", streaming: false },
    ...items.slice(4),
  ] as Item[];
  assert.equal(planAnswerBefore(closing, 5), "# Add search\n\n1. Parse\n2. Rank");
  // No heading: the longest answer.
  const plain = [
    { type: "user", id: "u", text: "plan" },
    {
      type: "assistant",
      id: "x",
      text: "1. Do a\n2. Do b, then c",
      thinking: "",
      streaming: false,
    },
    { type: "assistant", id: "y", text: "Done.", thinking: "", streaming: false },
  ] as Item[];
  assert.equal(planAnswerBefore(plain, 3), "1. Do a\n2. Do b, then c");
});

test("planEdited ignores line endings and edges", () => {
  assert.equal(planEdited("# A\r\n1. x\r\n", "# A\n1. x"), false);
  assert.equal(planEdited("# A\n1. y", "# A\n1. x"), true);
});

test("planTitle and planSteps", () => {
  assert.equal(planTitle("Intro\n\n## Add **search**\n1. a"), "Add search");
  assert.equal(planTitle("Just a line"), "Just a line");
  assert.equal(planTitle(""), "Plan");
  assert.equal(planSteps("# T\n1. a\n2) b\n- [ ] c\n   - sub"), 3);
  assert.equal(planSteps("# T\n- a\n- b\n  - nested"), 2);
});

test("buildMessage sends the edited file's text, else points at the plan above", () => {
  assert.equal(buildMessage(null, null, false), "Build it: carry out the plan above.");
  assert.match(buildMessage("/p/s1.md", "# A", false), /plan above \(saved as \/p\/s1\.md\)/);
  const edited = buildMessage("/p/s1.md", "# A\n1. mine\n", true);
  assert.match(edited, /as the user edited it \(\/p\/s1\.md\)/);
  assert.ok(edited.endsWith("# A\n1. mine"));
  assert.match(editedPlanContext("/p/s1.md", " x "), /\(\/p\/s1\.md\)[\s\S]*\n\nx$/);
  assert.equal(planFileName("s1a:b"), "s1a_b.md");
});
