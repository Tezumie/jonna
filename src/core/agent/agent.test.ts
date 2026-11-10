import assert from "node:assert/strict";
import { test } from "node:test";
import { type Item, toMessages } from "./conversation";
import { applyEdits, nearestRegion } from "./edits";
import { parseToolCalls, toolsPrompt } from "./textProtocol";

test("applyEdits: exact, ambiguous, fuzzy indentation, CRLF, all", () => {
  const src = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 1;\n}\n";
  assert.deepEqual(applyEdits(src, [{ old: "return 1;", new: "return 2;" }]), {
    ok: false,
    error:
      "old_string occurs 2 times; include more surrounding lines to make it unique, or set replace_all.",
    index: 0,
  });
  const one = applyEdits(src, [
    { old: "function b() {\n  return 1;", new: "function b() {\n  return 3;" },
  ]);
  assert.ok(one.ok && one.text.includes("return 3") && one.text.includes("return 1"));
  const all = applyEdits(src, [{ old: "return 1;", new: "return 0;", all: true }]);
  assert.ok(all.ok && all.replacements === 2);
  // Wrong indentation in "old" still matches; the replacement takes the file's indentation.
  const fuzzy = applyEdits("class A {\n    run() {\n        go();\n    }\n}\n", [
    { old: "run() {\n    go();\n}", new: "run() {\n    stop();\n}" },
  ]);
  assert.ok(fuzzy.ok);
  assert.equal(fuzzy.ok && fuzzy.text, "class A {\n    run() {\n        stop();\n    }\n}\n");
  const crlf = applyEdits("a\r\nb\r\n", [{ old: "a\nb", new: "x\ny" }]);
  assert.ok(crlf.ok && crlf.text === "x\r\ny\r\n");
  assert.equal(applyEdits("abc", [{ old: "zzz", new: "y" }]).ok, false);
  assert.deepEqual(applyEdits("", [{ old: "", new: "new file" }]), {
    ok: true,
    text: "new file",
    replacements: 1,
  });
});

test("parseToolCalls: tagged, fenced, forgiving JSON, unknown names left as text", () => {
  const known = new Set(["read_file", "search"]);
  const r = parseToolCalls(
    'Let me look.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.ts",}}\n</tool_call>\n<tool_call>{"function": {"name": "search", "arguments": "{\\"query\\": \\"x\\"}"}}</tool_call>',
    known,
  );
  assert.equal(r.text, "Let me look.");
  assert.deepEqual(r.calls, [
    { name: "read_file", arguments: { path: "a.ts" }, block: 0 },
    { name: "search", arguments: { query: "x" }, block: 1 },
  ]);
  // D379: a block that isn't a call (bad JSON) still counts, so later calls keep their place.
  const skipped = parseToolCalls(
    '<tool_call>{oops</tool_call> <tool_call>{"name": "search", "arguments": {}}</tool_call> <tool_call>{"name": "read_file", "arguments": {"path": "c"}}',
    known,
  );
  assert.deepEqual(
    skipped.calls.map((c) => [c.name, c.block]),
    [
      ["search", 1],
      ["read_file", 2],
    ],
  );
  const fenced = parseToolCalls('```json\n{"tool": "search", "input": {"query": "y"}}\n```', known);
  assert.deepEqual(fenced.calls, [{ name: "search", arguments: { query: "y" } }]);
  const unclosed = parseToolCalls(
    '<tool_call>\n{"name": "read_file", "arguments": {"path": "b"}}',
    known,
  );
  assert.equal(unclosed.calls.length, 1);
  const other = parseToolCalls('```json\n{"name": "nope"}\n```', known);
  assert.equal(other.calls.length, 0);
  assert.ok(
    toolsPrompt([{ name: "read_file", description: "Read", parameters: {} }]).includes(
      "<tool_call>",
    ),
  );
});

test("applyEdits: loose whitespace and blank lines; nearestRegion", () => {
  const src = "function go() {\n  const a=1;\n\n  return a;\n}\n";
  const r = applyEdits(src, [{ old: "const a = 1;\nreturn a;", new: "const a = 2;\nreturn a;" }]);
  assert.ok(r.ok);
  assert.equal(r.ok && r.text, "function go() {\n  const a = 2;\n  return a;\n}\n");
  const miss = applyEdits(src, [{ old: "const b = 9;", new: "x" }]);
  assert.equal(miss.ok, false);
  assert.equal(!miss.ok && miss.notFound, true);
  const near = nearestRegion("a\nb\nc\nreturn a;\nd\ne", "return a;\nzzz", 1);
  assert.equal(near, "c\nreturn a;\nd\ne");
});

test("applyEdits: copied line-number prefixes and escaped newlines", () => {
  const src = "a\nb\nc\n";
  const r = applyEdits(src, [{ old: "    2| b\n    3| c", new: "    2| B\n    3| C" }]);
  assert.equal(r.ok && r.text, "a\nB\nC\n");
  const e = applyEdits(src, [{ old: "a\\nb", new: "x\\ny" }]);
  assert.equal(e.ok && e.text, "x\ny\nc\n");
});

test("applyEdits: escaped quotes, HTML entities, curly quotes, near matches", () => {
  const js =
    "const button = document.querySelector('#hello');\n\nbutton.addEventListener('click', () => {\n  button.textContent = 'Hello!';\n});\n";
  const esc = applyEdits(js, [
    { old: "button.textContent = \\'Hello!\\';", new: "button.textContent = \\'Hi\\';" },
  ]);
  assert.equal(esc.ok && esc.text.includes("button.textContent = 'Hi';"), true);
  const html = '<main>\n  <button id="hello">Click me</button>\n</main>\n';
  const ent = applyEdits(html, [
    {
      old: '&lt;button id="hello"&gt;Click me&lt;/button&gt;',
      new: '&lt;button id="hello"&gt;Go&lt;/button&gt;',
    },
  ]);
  assert.equal(ent.ok && ent.text.includes('<button id="hello">Go</button>'), true);
  const curly = applyEdits(js, [
    { old: "querySelector(\u2018#hello\u2019)", new: "querySelector('#hi')" },
  ]);
  assert.equal(curly.ok && curly.text.includes("querySelector('#hi')"), true);
  // A small typo in old_string (missing semicolon, extra space) still finds the one close block.
  const near = applyEdits(js, [
    {
      old: "button.addEventListener('click', () =>  {\n  button.textContent = 'Hello!'\n});",
      new: "button.addEventListener('click', () => {\n  button.textContent = 'Bye';\n});",
    },
  ]);
  assert.equal(near.ok && near.text.includes("'Bye'"), true);
  assert.equal(applyEdits(js, [{ old: "totally different text here", new: "x" }]).ok, false);
});

test("toMessages: screenshots follow the tool results as a user message, newest two, vision only", () => {
  const tool = (id: string, images?: string[]) => ({
    type: "tool" as const,
    id,
    callId: `c${id}`,
    name: "screenshot",
    args: {},
    status: "done" as const,
    result: "ok",
    ...(images && { images }),
  });
  const items: Item[] = [
    { type: "user", id: "u", text: "look" },
    tool("1", ["A"]),
    tool("2", ["B"]),
    tool("3", ["C"]),
  ];
  const vision = toMessages(items, { textProtocol: false, budgetChars: 1e6, vision: true });
  const withImages = vision.filter((m) => m.images?.length);
  assert.equal(withImages.length, 1);
  assert.deepEqual(withImages[0]?.images, ["B", "C"]);
  assert.equal(withImages[0]?.role, "user");
  assert.equal(vision[vision.length - 1], withImages[0]);
  const blind = toMessages(items, { textProtocol: false, budgetChars: 1e6 });
  assert.ok(blind.every((m) => !m.images));
});

test("messages for caching (D112): state, images, reasoning, old results kept while they fit", () => {
  const items: Item[] = [
    { type: "user", id: "u1", text: "first", state: "Active editor: a.ts", images: ["AAA"] },
    {
      type: "assistant",
      id: "a1",
      text: "",
      thinking: "t",
      streaming: false,
      reasoning: [{ type: "thinking", thinking: "t", signature: "s" }],
    },
    {
      type: "tool",
      id: "t1",
      callId: "c1",
      name: "read_file",
      args: { path: "a.ts" },
      status: "done",
      result: "x".repeat(5000),
    },
    { type: "assistant", id: "a2", text: "done", thinking: "", streaming: false },
    { type: "user", id: "u2", text: "second" },
    { type: "assistant", id: "a3", text: "ok", thinking: "", streaming: false },
    { type: "user", id: "u3", text: "third" },
  ];
  const stable = toMessages(items, {
    textProtocol: false,
    budgetChars: 100_000,
    vision: true,
    stable: true,
  });
  assert.ok(stable[0]?.content.startsWith("<ide_state>\nActive editor: a.ts\n</ide_state>"));
  assert.deepEqual(stable[0]?.images, ["AAA"]);
  assert.deepEqual(stable[1]?.thinkingBlocks, [
    { type: "thinking", thinking: "t", signature: "s" },
  ]);
  // Not shortened: the earlier request had it whole, and changing it would miss the cache.
  assert.equal(stable[2]?.content.length, 5000);
  const plain = toMessages(items, { textProtocol: false, budgetChars: 100_000, vision: false });
  assert.ok((plain[2]?.content.length ?? 0) < 5000);
  assert.equal(plain[0]?.images, undefined);
  assert.ok(plain[0]?.content.includes("can't see images"));
});

test("parseToolCalls: a fenced example followed by prose isn't a call (D163)", () => {
  const known = new Set(["search"]);
  const example = parseToolCalls(
    'You could call:\n```json\n{"tool": "search", "input": {"query": "y"}}\n```\nbut I won\'t.',
    known,
  );
  assert.equal(example.calls.length, 0);
});
