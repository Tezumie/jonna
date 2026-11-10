import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "./conversation";
import {
  chaptersOf,
  latestWrapUp,
  leadsTurn,
  parseChapter,
  parseNotify,
  parseProposal,
  parseWrapUp,
  proposalsOf,
  statusLine,
  TASK_DISMISSED,
  TASK_STARTED,
  WRAP_UP_ACTIONS,
  type WrapUpAction,
} from "./turnTools";

const LABELS = Object.fromEntries(WRAP_UP_ACTIONS.map((a) => [a, `App ${a}`])) as Record<
  WrapUpAction,
  string
>;
const user = (id: string, auto?: "verify"): Item => ({
  type: "user",
  id,
  text: "hi",
  ...(auto && { auto }),
});
const tool = (id: string, name: string, args: unknown, extra: Partial<Item> = {}): Item =>
  ({ type: "tool", id, callId: id, name, args, status: "done", ...extra }) as Item;
const said = (id: string, text: string): Item => ({
  type: "assistant",
  id,
  text,
  thinking: "",
  streaming: false,
});
const error = (r: { error: string } | object) => ("error" in r ? r.error : "");

test("D301: wrap_up takes a recap alone, or an ask with one or two buttons", () => {
  const r = parseWrapUp({ recap: "Done. Tests pass." }, [], LABELS);
  assert.deepEqual(r, { wrapUp: { recap: "Done. Tests pass." } });
  const asked = parseWrapUp(
    {
      recap: "Fixed it.",
      ask: "Commit it?",
      actions: [{ action: "commit", label: "ignored" }, { label: "Not now" }],
      blocked: true,
    },
    ["commit"],
    LABELS,
  );
  assert.deepEqual(asked, {
    wrapUp: {
      recap: "Fixed it.",
      ask: "Commit it?",
      actions: [{ label: "App commit", action: "commit" }, { label: "Not now" }],
      blocked: true,
    },
  });
  // blocked means nothing without a question.
  assert.deepEqual(parseWrapUp({ recap: "x", blocked: true }, [], LABELS), {
    wrapUp: { recap: "x" },
  });
});

test("D301: wrap_up says what to fix, with the count it ran", () => {
  assert.match(error(parseWrapUp({ recap: "a".repeat(303) }, [], LABELS)), /this one ran 303/);
  assert.match(error(parseWrapUp({}, [], LABELS)), /Give a recap/);
  assert.match(
    error(parseWrapUp({ recap: "x", ask: "q".repeat(101), actions: ["Yes"] }, [], LABELS)),
    /ran 101/,
  );
  assert.match(
    error(parseWrapUp({ recap: "x", ask: "Go?", actions: ["A", "B", "C"] }, [], LABELS)),
    /at most 2/,
  );
  assert.match(error(parseWrapUp({ recap: "x", actions: ["A"] }, [], LABELS)), /add the one/);
  assert.match(error(parseWrapUp({ recap: "x", ask: "Go?" }, [], LABELS)), /1 or 2 actions/);
  assert.match(
    error(
      parseWrapUp(
        { recap: "x", ask: "Go?", actions: [{ label: "Yes please do it now" }] },
        [],
        LABELS,
      ),
    ),
    /sentence/,
  );
  assert.match(
    error(parseWrapUp({ recap: "x", ask: "Go?", actions: [{ label: "/commit" }] }, [], LABELS)),
    /can't start/,
  );
  assert.match(
    error(parseWrapUp({ recap: "x", ask: "Go?", actions: ["Yes", "yes"] }, [], LABELS)),
    /same label/,
  );
  // An app action that isn't available now names those that are.
  const gone = error(
    parseWrapUp({ recap: "x", ask: "Go?", actions: [{ action: "commit" }] }, ["review"], LABELS),
  );
  assert.match(gone, /isn't available now/);
  assert.match(gone, /Available now: review/);
  assert.match(
    error(parseWrapUp({ recap: "x", ask: "Go?", actions: [{ action: "deploy" }] }, [], LABELS)),
    /no app action "deploy".*use a reply/,
  );
});

test("D301: the latest turn's wrap-up survives in its call; an older turn's is gone", () => {
  const w = { recap: "Done here. More later.", ask: "Ship it?", actions: [{ label: "Ship" }] };
  const items: Item[] = [user("u1"), tool("w1", "wrap_up", w), said("a1", "Closing words.")];
  assert.deepEqual(latestWrapUp(items), {
    itemId: "w1",
    wrapUp: { recap: w.recap, ask: "Ship it?", actions: [{ label: "Ship" }] },
  });
  // A check the IDE ran after it (an automatic message) is the same turn.
  assert.equal(latestWrapUp([...items, user("v", "verify")])?.itemId, "w1");
  assert.equal(latestWrapUp([...items, user("u2")]), null);
  // A call that failed doesn't count.
  assert.equal(
    latestWrapUp([user("u1"), tool("w2", "wrap_up", w, { status: "error" } as Partial<Item>)]),
    null,
  );
});

test("D301: the status line is the recap's first sentence", () => {
  assert.equal(statusLine("Fixed the parser. Tests pass."), "Fixed the parser.");
  assert.equal(statusLine("Version 1.2 ships today"), "Version 1.2 ships today");
  assert.equal(statusLine("a".repeat(200)).length, 140);
});

test("D302: chapters need a title under 40 characters, and not at the very start", () => {
  const later: Item[] = [user("u1"), said("a", "Done."), user("u2")];
  assert.deepEqual(parseChapter({ title: "Auth bug fix", summary: "The fix" }, later), {
    chapter: { title: "Auth bug fix", summary: "The fix" },
  });
  assert.match(error(parseChapter({ title: "x".repeat(45) }, later)), /ran 45/);
  assert.match(error(parseChapter({}, later)), /title/);
  // The first message's first step: no chapter yet.
  assert.match(error(parseChapter({ title: "Start" }, [user("u1")])), /very start/);
  assert.match(
    error(parseChapter({ title: "Start" }, [user("u1"), tool("p", "update_plan", {})])),
    /very start/,
  );
  // After some work in the first turn, a shift is fine.
  const worked: Item[] = [user("u1"), said("s1", ""), tool("r", "read_file", {}), said("s2", "")];
  assert.ok("chapter" in parseChapter({ title: "Implementation" }, worked));
  // The same chapter twice in a row.
  const marked = [...later, tool("c", "mark_chapter", { title: "Auth bug fix" })];
  assert.match(error(parseChapter({ title: "auth bug fix" }, marked)), /already/);
  assert.deepEqual(chaptersOf(marked), [{ id: "c", title: "Auth bug fix" }]);
});

test("D302: a chapter leads its turn only before anything the user sees", () => {
  const step1: Item[] = [said("s", ""), tool("a", "update_plan", {})];
  assert.equal(leadsTurn(step1, 2), true);
  assert.equal(leadsTurn([said("s", "Looking."), tool("a", "x", {})], 2), false);
  assert.equal(leadsTurn([said("s1", ""), tool("a", "x", {}), said("s2", "")], 3), false);
});

test("D303: proposals need a title and a brief, at most three a turn", () => {
  const turn: Item[] = [];
  assert.deepEqual(parseProposal({ title: "Add tests", brief: "Write tests for X." }, turn), {
    task: { title: "Add tests", brief: "Write tests for X." },
  });
  assert.match(error(parseProposal({ title: "Add tests" }, turn)), /brief/);
  assert.match(error(parseProposal({ title: "t".repeat(61), brief: "b" }, turn)), /ran 61/);
  const three = [1, 2, 3].map((n) => tool(`p${n}`, "propose_task", { title: "T", brief: "B" }));
  assert.match(error(parseProposal({ title: "T", brief: "B" }, three)), /At most 3/);
  const states = proposalsOf([
    ...three,
    {
      ...(three[0] as Extract<Item, { type: "tool" }>),
      id: "p4",
      summary: TASK_STARTED,
      detail: "s9",
    },
  ]);
  assert.deepEqual(
    states.map((s) => s.state),
    ["open", "open", "open", "started"],
  );
  assert.equal(states[3]?.chat, "s9");
  const dismissed = proposalsOf([
    { ...(three[0] as Extract<Item, { type: "tool" }>), summary: TASK_DISMISSED },
  ]);
  assert.equal(dismissed[0]?.state, "dismissed");
});

test("D305: notify takes one line under 200 characters", () => {
  assert.deepEqual(parseNotify({ message: " Build finished: 2 failures " }), {
    message: "Build finished: 2 failures",
  });
  assert.match(error(parseNotify({ message: "a\nb" })), /one line/);
  assert.match(error(parseNotify({ message: "m".repeat(205) })), /ran 205/);
  assert.match(error(parseNotify({})), /Give the message/);
});
