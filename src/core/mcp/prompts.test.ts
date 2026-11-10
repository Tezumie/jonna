import assert from "node:assert/strict";
import { test } from "node:test";
import {
  argumentHint,
  parsePromptArgs,
  parseResourceMention,
  promptCommandName,
  promptContext,
  resourceContext,
  resourceLabel,
  resourceMention,
} from "./prompts";

const review = {
  name: "review",
  arguments: [
    { name: "focus", required: true },
    { name: "depth", required: false },
  ],
};

test("prompt arguments from the typed text", () => {
  assert.equal(argumentHint(review), "<focus> [depth]");
  assert.deepEqual(parsePromptArgs(review, "tests deep"), {
    values: { focus: "tests", depth: "deep" },
    missing: [],
  });
  assert.deepEqual(parsePromptArgs(review, 'depth=2 "error handling"'), {
    values: { depth: "2", focus: "error handling" },
    missing: [],
  });
  assert.deepEqual(parsePromptArgs(review, ""), { values: {}, missing: ["focus"] });
  // One argument takes the whole text; the last open one takes what's left.
  const one = { name: "ask", arguments: [{ name: "q", required: true }] };
  assert.deepEqual(parsePromptArgs(one, "what is this").values, { q: "what is this" });
  assert.deepEqual(parsePromptArgs(review, "a b c").values, { focus: "a", depth: "b c" });
});

test("prompt messages and resources as context", () => {
  assert.equal(promptCommandName("my server", "re.view"), "mcp__my_server__re_view");
  const text = promptContext("docs", "review", {
    description: "Review code",
    messages: [
      { role: "user", content: { type: "text", text: "Look at tests" } },
      { role: "assistant", content: { type: "text", text: "OK" } },
      { role: "user", content: { type: "resource", resource: { uri: "x://a", text: "body" } } },
    ],
  });
  assert.match(
    text,
    /^The user ran the MCP prompt \/mcp__docs__review from server docs \(Review code\)/,
  );
  assert.match(text, /Look at tests\n\n\(assistant\) OK\n\nbody$/);
  const res = resourceContext("docs", "x://a", {
    contents: [{ text: "hello" }, { blob: "AAAA", mimeType: "image/png" }],
  });
  assert.match(res, /hello\n\n\[binary image\/png, 3 bytes\]/);
  const m = resourceMention("docs", "file:///a b.md");
  assert.deepEqual(parseResourceMention(m), { server: "docs", uri: "file:///a b.md" });
  assert.equal(parseResourceMention("@web x"), null);
  assert.equal(resourceLabel({ uri: "file:///x/notes.md?y" }), "notes.md");
  assert.equal(resourceLabel({ uri: "x", title: "Notes" }), "Notes");
});
