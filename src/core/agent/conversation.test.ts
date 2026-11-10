import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Item,
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
