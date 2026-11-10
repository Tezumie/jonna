import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "./conversation";
import {
  everyoneWords,
  findMentions,
  type GroupMember,
  handoffMentions,
  handoffNote,
  isGroupContext,
  matchMembers,
  membersAfterMentions,
  mentionQuery,
  mentionRanges,
  mentionsEveryone,
  newContext,
  nextInChain,
  normalizeMembers,
  parseHandoffs,
  pendingFor,
  roomBrief,
  routeMessage,
  routeTogether,
  startChain,
} from "./groupChat";
import { parseSubagentFile } from "./subagents";

const MEMBERS: GroupMember[] = [
  { name: "scout", label: "Scout", role: "Researcher", description: "Finds things in the code." },
  { name: "forge", label: "Forge", role: "Builder" },
  { name: "tester", label: "Test runner", role: "Tester" },
  { name: "agent", label: "Agent", role: "Main agent" },
];

test("groupChat: mentions by label or id, longest first, outside code, each once", () => {
  assert.deepEqual(findMentions("@Forge and @scout, then @forge again", MEMBERS), [
    "forge",
    "scout",
  ]);
  assert.deepEqual(findMentions("@Test runner please", MEMBERS), ["tester"]);
  assert.deepEqual(findMentions("@tester please", MEMBERS), ["tester"]);
  // Not a mention: e-mail addresses, a longer word, code.
  assert.deepEqual(findMentions("mail me at x@forge.dev", MEMBERS), []);
  assert.deepEqual(findMentions("@Forgery is a word", MEMBERS), []);
  assert.deepEqual(findMentions("run `@Forge` or\n```\n@Scout\n```\nok", MEMBERS), []);
  assert.deepEqual(findMentions("(@Forge), @Forge's turn", MEMBERS), ["forge"]);
  assert.deepEqual(findMentions("@Nobody here", MEMBERS), []);
});

test("groupChat: a message goes to the first mentioned, the rest queue; else the last speaker", () => {
  assert.deepEqual(routeMessage("@Forge build it, then @Scout check", MEMBERS, "scout"), {
    speaker: "forge",
    queue: ["scout"],
  });
  assert.deepEqual(routeMessage("and now?", MEMBERS, "forge"), { speaker: "forge", queue: [] });
  assert.deepEqual(routeMessage("hello", MEMBERS, null), { speaker: "scout", queue: [] });
  // A last speaker who left the group: the first member.
  assert.deepEqual(routeMessage("hello", MEMBERS, "gone"), { speaker: "scout", queue: [] });
  assert.equal(routeMessage("hello", [], null), null);
});

test("groupChat: a reply hands over at a line's start or after an arrow, never to itself", () => {
  assert.deepEqual(handoffMentions("Done.\n@Forge can you build it?", MEMBERS, "scout"), ["forge"]);
  assert.deepEqual(handoffMentions("- **@Forge** build\n> @Test runner run", MEMBERS, "scout"), [
    "forge",
    "tester",
  ]);
  assert.deepEqual(handoffMentions("Next → @Forge", MEMBERS, "scout"), ["forge"]);
  assert.deepEqual(handoffMentions("Next -> @forge", MEMBERS, "scout"), ["forge"]);
  // In the middle of a sentence: named, not handed to.
  assert.deepEqual(handoffMentions("As @Forge said, it's fine.", MEMBERS, "scout"), []);
  assert.deepEqual(handoffMentions("@Scout here: I did it.", MEMBERS, "scout"), []);
  assert.deepEqual(handoffMentions("```\n@Forge\n```", MEMBERS, "scout"), []);
});

test("groupChat: a chain takes handed-to members first and stops at the limit", () => {
  // The user named Forge and Scout: Forge answered first, Scout waits (free).
  let chain = startChain(["scout"]);
  let step = nextInChain(chain, [], 2);
  assert.deepEqual(step.next, { name: "scout", fromUser: true });
  assert.equal(step.chain.autoTurns, 0);
  // Ping-pong between two agents: two automatic turns, then it stops.
  chain = startChain([]);
  step = nextInChain(chain, ["forge"], 2);
  assert.equal(step.next?.name, "forge");
  step = nextInChain(step.chain, ["scout"], 2);
  assert.equal(step.next?.name, "scout");
  assert.equal(step.chain.autoTurns, 2);
  step = nextInChain(step.chain, ["forge"], 2);
  assert.equal(step.next, null);
  assert.equal(step.limited, true);
  // Past the limit, a member the user named still answers.
  step = nextInChain({ queue: [{ name: "tester", fromUser: true }], autoTurns: 2 }, ["forge"], 2);
  assert.deepEqual(step.next, { name: "tester", fromUser: true });
  assert.equal(step.limited, true);
  // A member already waiting isn't queued twice; handed-to ones go first.
  step = nextInChain(startChain(["forge"]), ["forge", "tester"], 4);
  assert.equal(step.next?.name, "tester");
  assert.deepEqual(
    step.chain.queue.map((e) => e.name),
    ["forge"],
  );
  // A limit of 0: agents never answer each other on their own.
  assert.equal(nextInChain(startChain([]), ["forge"], 0).next, null);
  assert.equal(nextInChain(startChain([]), [], 4).limited, false);
});

test("groupChat: the room brief names everyone, the speaker and how to hand over", () => {
  const brief = roomBrief(MEMBERS, "forge", { instructions: "Build things." });
  assert.ok(isGroupContext(brief));
  assert.match(brief, /You are Forge \(Builder\); answer as Forge only/);
  assert.match(brief, /- @Scout \(Researcher\): Finds things in the code\./);
  assert.match(brief, /- @Forge \(Builder\) — you/);
  // Every writer's tag explained, the speaker's own too (D253); nothing that changes per turn.
  assert.ok(brief.includes("each starting with its writer's [Name] (yours with [Forge])"));
  assert.equal(brief, roomBrief(MEMBERS, "forge", { instructions: "Build things." }));
  assert.match(brief, /start a line with their @name/);
  assert.match(brief, /Your own instructions as Forge:\nBuild things\./);
  assert.ok(!roomBrief(MEMBERS, "scout").includes("own instructions"));
  assert.match(handoffNote("Forge", "Scout"), /Scout handed the conversation to you, Forge/);
});

test("groupChat: members are known ones, once, at most six", () => {
  const known = (n: string) => n !== "ghost";
  assert.deepEqual(normalizeMembers(["scout", "Scout", "ghost", " forge "], known), [
    "scout",
    "forge",
  ]);
  assert.equal(normalizeMembers(["a", "b", "c", "d", "e", "f", "g"], () => true).length, 6);
});

test("groupChat: the @query being typed and the members it matches", () => {
  assert.deepEqual(mentionQuery("hi @Fo", 6), { start: 3, query: "Fo" });
  assert.deepEqual(mentionQuery("@", 1), { start: 0, query: "" });
  assert.deepEqual(mentionQuery("@Test r", 7), { start: 0, query: "Test r" });
  assert.equal(mentionQuery("mail x@fo", 9), null);
  assert.equal(mentionQuery("@a\nb", 4), null);
  assert.equal(mentionQuery("no at", 5), null);
  assert.deepEqual(
    matchMembers("te", MEMBERS).map((m) => m.name),
    ["tester"],
  );
  assert.deepEqual(
    matchMembers("o", MEMBERS).map((m) => m.name),
    ["scout", "forge"],
  );
  assert.equal(matchMembers("", MEMBERS).length, 4);
});

test("groupChat: handoffs from front matter (VS Code's format)", () => {
  const header = [
    "name: planner",
    "description: Plans",
    "handoffs:",
    "  - label: Start implementation",
    "    agent: implementer",
    "    prompt: 'Now implement the plan outlined above.'",
    "    send: true",
    "  - { label: Review it, agent: reviewer }",
    "  - label: No agent here",
    "tools: [read]",
  ].join("\n");
  assert.deepEqual(parseHandoffs(header), [
    {
      label: "Start implementation",
      agent: "implementer",
      prompt: "Now implement the plan outlined above.",
      send: true,
    },
    { label: "Review it", agent: "reviewer" },
  ]);
  assert.deepEqual(parseHandoffs("name: x"), []);
  // Through an agent file: the definition carries them, and the other keys still parse.
  const def = parseSubagentFile(`---\n${header}\n---\nPlan things.`, "project");
  assert.equal(def?.handoffs?.length, 2);
  assert.deepEqual(def?.tools, ["read_file"]);
});

test("groupChat: handoffs as a list at the key's own column", () => {
  const header = [
    "handoffs:",
    "- label: X",
    "  agent: y",
    "- label: Second",
    "  agent: z",
    "  send: true",
    "# a comment",
    "model: fast",
  ].join("\n");
  assert.deepEqual(parseHandoffs(header), [
    { label: "X", agent: "y" },
    { label: "Second", agent: "z", send: true },
  ]);
  // The next top-level key still ends the list.
  assert.deepEqual(
    parseHandoffs("handoffs:\n- label: A\n  agent: a\nother:\n- label: B\n  agent: b"),
    [{ label: "A", agent: "a" }],
  );
});

test("groupChat: handoff prompts as block scalars", () => {
  const header = [
    "handoffs:",
    "  - label: Literal",
    "    agent: a",
    "    prompt: |",
    "      First line.",
    "        Indented line.",
    "",
    "      After a blank.",
    "    send: true",
    "- label: Folded",
    "  agent: b",
    "  prompt: >-",
    "    Joined",
    "    with spaces.",
    "name: x",
  ].join("\n");
  assert.deepEqual(parseHandoffs(header), [
    {
      label: "Literal",
      agent: "a",
      prompt: "First line.\n  Indented line.\n\nAfter a blank.",
      send: true,
    },
    { label: "Folded", agent: "b", prompt: "Joined with spaces." },
  ]);
  // The first key on the item line can open a block too.
  assert.deepEqual(
    parseHandoffs("handoffs:\n  - prompt: |\n      Do it.\n    label: L\n    agent: c"),
    [{ label: "L", agent: "c", prompt: "Do it." }],
  );
});

test("groupChat: handoff flow maps split only at commas outside quotes", () => {
  const header = [
    "handoffs:",
    "  - {label: \"A, B\", agent: x, prompt: 'Say \"hi\", then it''s done'}",
    "  - { label: don't stop, agent: y, send: true }",
  ].join("\n");
  assert.deepEqual(parseHandoffs(header), [
    { label: "A, B", agent: "x", prompt: 'Say "hi", then it\'s done' },
    { label: "don't stop", agent: "y", send: true },
  ]);
});

test("groupChat: mentions in any kind of code don't count", () => {
  // Inline code spans of any backtick-run length (a run closes on one of exactly its length).
  assert.deepEqual(findMentions("Run ``@Forge`` and ``a ` @Scout`` now", MEMBERS), []);
  assert.deepEqual(findMentions("A lone ` then @Forge", MEMBERS), ["forge"]);
  assert.deepEqual(handoffMentions("``@Forge`` is a tag", MEMBERS, "scout"), []);
  // Indented fences (up to 3 spaces), with tildes and longer runs.
  assert.deepEqual(handoffMentions("Look:\n   ```\n@Forge run\n   ```", MEMBERS, "scout"), []);
  assert.deepEqual(handoffMentions("~~~~\n@Forge\n~~~\n@Scout\n~~~~\nok", MEMBERS, "agent"), []);
  // Indented code after a blank line; a 4-space line inside a paragraph or a list isn't code.
  assert.deepEqual(handoffMentions("Example:\n\n    @Forge run x\n", MEMBERS, "scout"), []);
  assert.deepEqual(handoffMentions("    @Forge run x", MEMBERS, "scout"), []);
  assert.deepEqual(findMentions("Line one\n    @Forge continues", MEMBERS), ["forge"]);
  assert.deepEqual(findMentions("- item\n\n    @Forge in the item", MEMBERS), ["forge"]);
  // A fence inside a list may sit deeper than 3 spaces.
  assert.deepEqual(findMentions("1. Do:\n\n     ```\n     @Forge\n     ```", MEMBERS), []);
  // Outside code, a handoff still counts.
  assert.deepEqual(
    handoffMentions("```\n@Scout\n```\n@Forge, please build `x`.", MEMBERS, "agent"),
    ["forge"],
  );
});

test("groupChat: a mention in a chat with one agent makes it a group (D233)", () => {
  // The main agent's chat: @Rev brings Rev in, the main agent stays.
  assert.deepEqual(membersAfterMentions([], "agent", ["rev"]), {
    names: ["agent", "rev"],
    joined: ["rev"],
  });
  // A chat with Rev: mentioning Rev again changes nothing; another agent joins Rev.
  assert.equal(membersAfterMentions([], "rev", ["rev"]), null);
  assert.deepEqual(membersAfterMentions([], "rev", ["Rev", "scout"]), {
    names: ["rev", "scout"],
    joined: ["scout"],
  });
  assert.equal(membersAfterMentions([], "agent", []), null);
});

test("groupChat: mentions join a group up to the limit, each once", () => {
  assert.deepEqual(membersAfterMentions(["agent", "rev"], "agent", ["scout", "scout", "rev"]), {
    names: ["agent", "rev", "scout"],
    joined: ["scout"],
  });
  const full = ["a", "b", "c", "d", "e"];
  assert.deepEqual(membersAfterMentions(full, "agent", ["f", "g"])?.joined, ["f"]);
  assert.equal(membersAfterMentions([...full, "f"], "agent", ["g"]), null);
});

test("groupChat: @all and answering together (D245)", () => {
  assert.equal(mentionsEveryone("@all what do you think?"), true);
  assert.equal(mentionsEveryone("ok @Everyone."), true);
  assert.equal(mentionsEveryone("@channel what do you think?"), true);
  assert.equal(mentionsEveryone("@channels"), false);
  assert.equal(mentionsEveryone("mail me at x@all.dev"), false);
  assert.equal(mentionsEveryone("`@all` in code"), false);
  assert.equal(mentionsEveryone("@allison"), false);
  // @all: the one whose turn it is answers with tools, every other member beside it.
  assert.deepEqual(routeTogether("@all ideas?", MEMBERS, "forge", false), {
    speaker: "forge",
    queue: [],
    together: ["scout", "tester", "agent"],
  });
  // Several mentions: one after another, or together when the setting says so.
  assert.deepEqual(routeTogether("@Scout @Forge look", MEMBERS, null, false), {
    speaker: "scout",
    queue: ["forge"],
    together: [],
  });
  assert.deepEqual(routeTogether("@Scout @Forge look", MEMBERS, null, true), {
    speaker: "scout",
    queue: [],
    together: ["forge"],
  });
});

test("groupChat: a brief or channel line goes again only when it changed or is far back (D253)", () => {
  const kind = (c: string) =>
    c.startsWith("<group_chat>") ? "group" : c.startsWith("[Channel]") ? "room" : null;
  const user = (id: string, context?: string[]): Item => ({
    type: "user",
    id,
    text: id,
    ...(context && { context }),
  });
  const scout = "<group_chat>You are Scout</group_chat>";
  const forge = "<group_chat>You are Forge</group_chat>";
  const room = "[Channel] #general: chat";
  const history: Item[] = [user("u1", [room, scout, "mode rules"]), user("u2")];
  // The same brief and line: not again; other context always goes.
  assert.deepEqual(newContext(history, [room, scout, "mode rules"], kind), ["mode rules"]);
  // Another member's brief: sent; then Scout again after Forge: Scout's again (the latest is Forge's).
  assert.deepEqual(newContext(history, [scout.replace("Scout", "Forge")], kind), [forge]);
  const switched = [...history, user("u3", [forge])];
  assert.deepEqual(newContext(switched, [scout], kind), [scout]);
  // After a summary the model no longer reads them: sent again.
  const summarized: Item[] = [
    ...history,
    { type: "summary", id: "s", text: "…", count: 2, auto: true },
  ];
  assert.deepEqual(newContext(summarized, [room, scout], kind), [room, scout]);
  // Far back (trimmed for the budget, maybe): sent again.
  const long = [...history, ...Array.from({ length: 12 }, (_, i) => user(`x${i}`))];
  assert.deepEqual(newContext(long, [scout], kind), [scout]);
});

test("groupChat: a resumed turn is for the member a handoff or a report was for (D253)", () => {
  const note = (to: string): Item => ({
    type: "user",
    id: `n${to}`,
    text: "(your turn)",
    auto: "group",
    to,
  });
  const reply = (speaker: string, text = "ok"): Item => ({
    type: "assistant",
    id: `a${speaker}`,
    text,
    thinking: "",
    streaming: false,
    speaker,
  });
  const notice: Item = { type: "notice", id: "x", text: "It failed.", tone: "error" };
  // Scout handed to Forge, Forge's turn failed before a word: Continue is Forge's.
  assert.equal(pendingFor([reply("scout"), note("forge"), notice]), "forge");
  // Forge answered after it: nothing owed.
  assert.equal(pendingFor([reply("scout"), note("forge"), reply("forge")]), null);
  // A report for the member that delegated, after someone else's reply.
  const report: Item = { type: "user", id: "r", text: "Report…", auto: "subagent", to: "scout" };
  assert.equal(pendingFor([reply("forge"), report]), "scout");
  // The user wrote last: their words route it.
  assert.equal(pendingFor([note("forge"), { type: "user", id: "u", text: "@scout hi" }]), null);
  assert.equal(pendingFor([]), null);
});

test("groupChat: mentions in shown text, for coloring (D273)", () => {
  const members = [
    { name: "agent", label: "Jonna" },
    { name: "planner", label: "Plato" },
    { name: "test", label: "Test runner" },
  ];
  const text = "@Gabby? @plato and @Jonna, then @Test runner. @channel mail a@plato.dev @Platoo";
  assert.deepEqual(
    mentionRanges(text, members).map((r) => [text.slice(r.start, r.end), r.name]),
    [
      ["@plato", "planner"],
      ["@Jonna", "agent"],
      ["@Test runner", "test"],
      ["@channel", null],
    ],
  );
  assert.deepEqual(mentionRanges("no mentions", members), []);
  assert.deepEqual(
    mentionRanges("`@Plato` in code, @Plato not", members).map((r) => r.start),
    [18],
  );
  assert.deepEqual(
    mentionRanges("@everyone @all", []).map((r) => r.name),
    [null, null],
  );
});

test("groupChat: the @ list offers @channel in a channel, @everyone elsewhere (D274)", () => {
  assert.equal(everyoneWords(true)[0], "channel");
  assert.equal(everyoneWords(false)[0], "everyone");
  assert.equal(
    everyoneWords(false).find((w) => w.startsWith("ch")),
    "channel",
  );
});
