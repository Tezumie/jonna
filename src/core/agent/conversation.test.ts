import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Item,
  imagesKept,
  type SpeakerLabels,
  stripSpeakerTag,
  toMessages,
  withSpeakerLabel,
} from "./conversation";

const user = (id: string, text: string): Item => ({ type: "user", id, text });
const reply = (id: string, text: string, speaker?: string, raw?: string): Item => ({
  type: "assistant",
  id,
  text,
  thinking: "",
  streaming: false,
  ...(speaker && { speaker }),
  ...(raw && { raw }),
});

const NAMES: Record<string, string> = { scout: "Scout", forge: "Forge", agent: "Agent" };
const labelsFor = (current: string | null): SpeakerLabels => ({
  current,
  label: (name) => NAMES[name] ?? name,
});

const ITEMS: Item[] = [
  user("u1", "Find the bug"),
  reply("a1", "It's in parse().", "scout"),
  reply("a2", "Fixed it.", "forge"),
  reply("a3", "Old reply"),
  user("u2", "Thanks"),
];

const assistantTexts = (items: readonly Item[], options: Parameters<typeof toMessages>[1]) =>
  toMessages(items, options)
    .filter((m) => m.role === "assistant")
    .map((m) => m.content);

test("conversation: every member's replies are labelled in a group chat, whoever answers", () => {
  const options = { textProtocol: false, budgetChars: 1e6, speakerLabels: labelsFor("forge") };
  // Forge's own reply is labelled too; one without a speaker is the main agent's.
  assert.deepEqual(assistantTexts(ITEMS, options), [
    "[Scout] It's in parse().",
    "[Forge] Fixed it.",
    "[Agent] Old reply",
  ]);
  // The same history renders the same bytes on every request, and after a handoff to another
  // member too (D253: the provider's prompt cache still covers it).
  assert.deepEqual(toMessages(ITEMS, options), toMessages(ITEMS, options));
  assert.deepEqual(
    toMessages(ITEMS, { ...options, speakerLabels: labelsFor("scout") }),
    toMessages(ITEMS, options),
  );
  assert.deepEqual(
    toMessages(ITEMS, { ...options, speakerLabels: labelsFor(null) }),
    toMessages(ITEMS, options),
  );
});

test("conversation: without speaker labels nothing changes", () => {
  assert.deepEqual(assistantTexts(ITEMS, { textProtocol: false, budgetChars: 1e6 }), [
    "It's in parse().",
    "Fixed it.",
    "Old reply",
  ]);
});

test("conversation: a text-protocol reply's raw text gets the label too", () => {
  const items: Item[] = [
    user("u", "Go"),
    reply("a", "Reading.", "scout", 'Reading.\n<tool_call>{"name":"read_file"}</tool_call>'),
  ];
  assert.deepEqual(
    assistantTexts(items, {
      textProtocol: true,
      budgetChars: 1e6,
      speakerLabels: labelsFor("forge"),
    }),
    ['[Scout] Reading.\n<tool_call>{"name":"read_file"}</tool_call>'],
  );
  // An empty reply (only tool calls) gets no lone "[Scout]", which models copy into their replies.
  assert.equal(withSpeakerLabel("", "scout", labelsFor("forge")), "");
  assert.equal(withSpeakerLabel("Hi", "forge", labelsFor("forge")), "[Forge] Hi");
});

test("conversation: a member's reply loses a copied speaker tag, not a link", () => {
  assert.equal(stripSpeakerTag("[Agent]"), "");
  assert.equal(stripSpeakerTag("[Agent] Looks good."), "Looks good.");
  assert.equal(stripSpeakerTag("[Rev]\nOverall fine."), "Overall fine.");
  assert.equal(stripSpeakerTag("[the docs](https://x.y) say so"), "[the docs](https://x.y) say so");
  assert.equal(stripSpeakerTag("See [Agent] above"), "See [Agent] above");
});

// A skill's model switching protocol mid-turn (D233): the same history renders for either.
const toolItem = (
  id: string,
  callId: string,
  name: string,
  args: unknown,
  result: string,
): Item => ({
  type: "tool",
  id,
  callId,
  name,
  args,
  status: "done",
  result,
});

test("conversation: native calls are written as <tool_call> text for a text-protocol model", () => {
  const items: Item[] = [
    user("u1", "Read it"),
    reply("a1", "Reading."),
    toolItem("t1", "c1", "read_file", { path: "a.ts" }, "contents"),
    toolItem("t2", "c2", "list_dir", { path: "." }, "a.ts"),
  ];
  const out = toMessages(items, { textProtocol: true, budgetChars: 100_000 });
  assert.equal(out.length, 3);
  assert.equal(out[1]?.role, "assistant");
  assert.equal(out[1]?.toolCalls, undefined);
  assert.equal(
    out[1]?.content,
    'Reading.\n\n<tool_call>\n{"name":"read_file","arguments":{"path":"a.ts"}}\n</tool_call>\n<tool_call>\n{"name":"list_dir","arguments":{"path":"."}}\n</tool_call>',
  );
  assert.equal(out[2]?.role, "user");
  assert.match(out[2]?.content ?? "", /<tool_result name="read_file">\ncontents/);
  assert.match(out[2]?.content ?? "", /<tool_result name="list_dir">\na\.ts/);
  // Deterministic: the same bytes on the next request (prompt caching).
  assert.deepEqual(toMessages(items, { textProtocol: true, budgetChars: 100_000 }), out);
});

test("conversation: a native call without any assistant text still gets its <tool_call> block", () => {
  const items: Item[] = [user("u1", "Go"), toolItem("t1", "c1", "search", { query: "x" }, "none")];
  const out = toMessages(items, { textProtocol: true, budgetChars: 100_000 });
  assert.equal(
    out[1]?.content,
    '<tool_call>\n{"name":"search","arguments":{"query":"x"}}\n</tool_call>',
  );
});

test("conversation: a text-protocol reply's raw text isn't given its calls twice", () => {
  const raw =
    'Reading.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n</tool_call>';
  const items: Item[] = [
    user("u1", "Read it"),
    reply("a1", "Reading.", undefined, raw),
    toolItem("t1", "i1", "read_file", { path: "a.ts" }, "contents"),
  ];
  const out = toMessages(items, { textProtocol: true, budgetChars: 100_000 });
  assert.equal(out[1]?.content, raw);
});

test("conversation: text-protocol calls become native calls with their results for a native model", () => {
  const raw =
    'Reading.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n</tool_call>';
  const items: Item[] = [
    user("u1", "Read it"),
    reply("a1", "Reading.", undefined, raw),
    toolItem("t1", "i1", "read_file", { path: "a.ts" }, "contents"),
    reply("a2", "Done."),
  ];
  const out = toMessages(items, { textProtocol: false, budgetChars: 100_000 });
  assert.equal(out[1]?.content, "Reading.");
  assert.deepEqual(out[1]?.toolCalls, [
    { id: "i1", name: "read_file", arguments: { path: "a.ts" } },
  ]);
  assert.deepEqual(out[2], {
    role: "tool",
    content: "contents",
    toolCallId: "i1",
    toolName: "read_file",
  });
  assert.equal(out[3]?.content, "Done.");
});

test("an external agent's steps reach an IDE model as text, not as its tool calls (D244)", () => {
  const items: Item[] = [
    { type: "user", id: "u1", text: "go" },
    { type: "assistant", id: "a1", text: "Running tests.", thinking: "", streaming: false },
    {
      type: "tool",
      id: "t1",
      callId: "ext-1",
      name: "acp:execute",
      args: {},
      status: "done",
      summary: "npm test",
    },
  ];
  const messages = toMessages(items, { textProtocol: false, budgetChars: 100_000 });
  assert.ok(
    messages.every((m) => !m.toolCalls?.length),
    "no native calls",
  );
  assert.ok(
    messages.every((m) => m.role !== "tool"),
    "no tool results",
  );
  const reply = messages.find((m) => m.role === "assistant");
  assert.match(reply?.content ?? "", /Running tests\.\n\[npm test: done\]/);
});

test("D451: what was sent stays as it was while the chat grows (append-only)", () => {
  // A long turn: replies with reasoning and text blocks, thirty tool calls with long results,
  // then a second message. Each request's messages must start with the previous request's.
  const items: Item[] = [{ type: "user", id: "u1", text: "do the work", state: "editor: a.ts" }];
  const sent: string[][] = [];
  const send = () =>
    sent.push(
      toMessages(items, { textProtocol: false, budgetChars: 4_000_000, stable: true }).map((m) =>
        JSON.stringify(m),
      ),
    );
  for (let i = 0; i < 30; i++) {
    items.push({
      type: "assistant",
      id: `a${i}`,
      text: `Step ${i}.`,
      thinking: "",
      streaming: false,
      reasoning: [
        { type: "thinking", thinking: `plan ${i}`, signature: `s${i}` },
        { type: "text", text: `Step ${i}.` },
      ],
    });
    items.push({
      type: "tool",
      id: `t${i}`,
      callId: `c${i}`,
      name: "read_file",
      args: { path: `f${i}.ts` },
      status: "done",
      result: "x".repeat(5000),
    });
    send();
  }
  items.push({ type: "user", id: "u2", text: "and now this" });
  send();
  for (let i = 1; i < sent.length; i++) {
    const before = sent[i - 1] ?? [];
    assert.deepEqual(sent[i]?.slice(0, before.length), before, `request ${i} changed its past`);
  }
  // The reply's blocks go back in their order, its text among them.
  const first = JSON.parse(sent[0]?.[1] ?? "{}") as { thinkingBlocks?: { type: string }[] };
  assert.deepEqual(
    first.thinkingBlocks?.map((b) => b.type),
    ["thinking", "text"],
  );
});

test("D451: a relabelled reply keeps its text out of its blocks; screenshots leave in steps", () => {
  const reply: Item = {
    type: "assistant",
    id: "a",
    text: "Hello.",
    thinking: "",
    streaming: false,
    speaker: "scout",
    reasoning: [
      { type: "thinking", thinking: "hm", signature: "s" },
      { type: "text", text: "Hello." },
    ],
  };
  const [, message] = toMessages([{ type: "user", id: "u", text: "hi" }, reply], {
    textProtocol: false,
    budgetChars: 100_000,
    speakerLabels: { current: null, label: (n) => n.toUpperCase() },
  });
  assert.equal(message?.content, "[SCOUT] Hello.");
  assert.deepEqual(
    (message?.thinkingBlocks as { type: string }[] | undefined)?.map((b) => b.type),
    ["thinking"],
  );
  // Two newest without `stable`; with it, between two and five, changing once in four.
  assert.deepEqual(
    [1, 2, 3, 5, 6, 9, 10].map((n) => imagesKept(n, true)),
    [1, 2, 3, 5, 2, 5, 2],
  );
  assert.deepEqual(
    [1, 2, 3, 9].map((n) => imagesKept(n, false)),
    [1, 2, 2, 2],
  );
});

test("D452: a tool search's result names what it loaded; whole results while the provider trims", () => {
  const big = "x".repeat(4000);
  const items: Item[] = [
    user("u1", "go"),
    toolItem(
      "t0",
      "c0",
      "tool_search",
      { query: "select:mcp__a__one" },
      '<functions>\n<function>{"name":"mcp__a__one","description":"d","parameters":{}}</function>\n</functions>',
    ),
    ...Array.from({ length: 30 }, (_, i) =>
      toolItem(`t${i + 1}`, `c${i + 1}`, "read_file", {}, big),
    ),
  ];
  const options = { textProtocol: false, stable: true } as const;
  const tools = (budgetChars: number, serverTrims: boolean) =>
    toMessages(items, { ...options, budgetChars, serverTrims }).filter((m) => m.role === "tool");
  const whole = tools(1_000_000, false);
  assert.deepEqual(whole[0]?.toolRefs, ["mcp__a__one"]);
  assert.equal(whole[1]?.toolRefs, undefined);
  const raw = whole.reduce((n, m) => n + m.content.length, 0);
  // Over the budget: shortened here, or sent whole when the provider clears them itself…
  assert.ok(tools(raw - 10_000, false).some((m) => m.content.length < big.length));
  assert.ok(tools(raw - 10_000, true).every((m, i) => i === 0 || m.content === big));
  // …but not far past it.
  assert.ok(tools(Math.floor(raw / 2), true).some((m) => m.content.length < big.length));
});
