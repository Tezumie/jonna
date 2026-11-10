import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanTitle, splitTitle, withoutWrapperTags } from "./title";

test("splitTitle: a complete tag is taken out of the reply", () => {
  assert.deepEqual(splitTitle("<title>Snake game in Python</title>\nHere's the plan"), {
    text: "Here's the plan",
    title: "Snake game in Python",
    pending: false,
  });
  assert.deepEqual(splitTitle("  <title>Fix login.</title> Sure"), {
    text: "Sure",
    title: "Fix login",
    pending: false,
  });
});

test("splitTitle: half-written tags stay hidden; other replies pass through", () => {
  for (const partial of ["<", "<ti", "<title>", "<title>Snake ga", "<title>Snake game</ti"])
    assert.deepEqual(splitTitle(partial), { text: "", pending: true }, partial);
  assert.deepEqual(splitTitle("Sure, here"), { text: "Sure, here", pending: false });
  assert.deepEqual(splitTitle("<div>html</div>"), { text: "<div>html</div>", pending: false });
});

test("cleanTitle: quotes, markdown, trailing punctuation", () => {
  assert.equal(cleanTitle(' "**Add dark mode**!" '), "Add dark mode");
});

test("a title in a bare tag is taken too, not an HTML tag (D160)", () => {
  assert.deepEqual(splitTitle("<Landing Page Ready>\nHere it is."), {
    text: "Here it is.",
    title: "Landing Page Ready",
    pending: false,
  });
  assert.equal(splitTitle("<Landing Pa").pending, true);
  assert.equal(splitTitle("<div>hi</div>").text, "<div>hi</div>");
  assert.equal(splitTitle("Plain answer").text, "Plain answer");
});

test("withoutWrapperTags: <result> wrappers go, code and other tags stay (D163)", () => {
  assert.equal(
    withoutWrapperTags("I'll beef it up.\n<result>\nI upgraded the design.\n</result>"),
    "I'll beef it up.\nI upgraded the design.",
  );
  assert.equal(withoutWrapperTags("<result>Done.</result>"), "Done.");
  assert.equal(withoutWrapperTags("```html\n<result>\n```"), "```html\n<result>\n```");
  assert.equal(withoutWrapperTags("Use <div> here"), "Use <div> here");
  // While streaming: an opening tag alone.
  assert.equal(withoutWrapperTags("<result>\nI upgr"), "I upgr");
});
