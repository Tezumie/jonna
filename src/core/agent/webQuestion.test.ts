import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerResult,
  FALLBACK_CHARS,
  fallbackResult,
  foundNothing,
  MAX_PARTS,
  mergeTask,
  PAGE_QUESTION_SYSTEM,
  PART_CHARS,
  partTask,
  splitPage,
} from "./webQuestion";

test("a short page is one part", () => {
  assert.deepEqual(splitPage("hello"), { parts: ["hello"], truncated: false });
  assert.deepEqual(splitPage(""), { parts: [], truncated: false });
});

test("a long page is cut at paragraph breaks, at most MAX_PARTS, the rest said", () => {
  const para = `${"word ".repeat(19)}end.\n\n`; // 100 characters
  const text = para.repeat(30); // 3000
  const { parts, truncated } = splitPage(text, 1000, 10);
  assert.equal(parts.join(""), text);
  assert.ok(!truncated);
  for (const p of parts) {
    assert.ok(p.length <= 1000);
    assert.ok(p.endsWith("\n\n"), "cut after a paragraph");
  }
  const capped = splitPage(text, 1000, 2);
  assert.equal(capped.parts.length, 2);
  assert.ok(capped.truncated);
  // No break in the window: a hard cut at the size.
  const flat = splitPage("x".repeat(2500), 1000, 10);
  assert.deepEqual(
    flat.parts.map((p) => p.length),
    [1000, 1000, 500],
  );
  // The defaults read up to about 96 000 characters.
  assert.equal(splitPage("y".repeat(PART_CHARS * MAX_PARTS + 1)).truncated, true);
});

test("the messages carry the question, the page and its part", () => {
  const task = partTask("What version?", { url: "https://x.dev", title: "X" }, "v2", 1, 3);
  assert.match(task, /^Question: What version\?/);
  assert.match(task, /Page: https:\/\/x\.dev — X \(part 2 of 3\)/);
  assert.match(task, /<page>\nv2\n<\/page>$/);
  assert.doesNotMatch(partTask("q", { url: "u" }, "p", 0, 1), /part/);
  assert.match(mergeTask("q", "u", ["a", "b"]), /Part answer 2:\nb/);
  assert.match(PAGE_QUESTION_SYSTEM, /untrusted/);
});

test("nothing found, answers and the fallback", () => {
  assert.ok(foundNothing("NOT IN THIS PART."));
  assert.ok(foundNothing("  not in this part "));
  assert.ok(foundNothing(""));
  assert.ok(!foundNothing("Version 2."));
  assert.equal(
    answerResult({ url: "u", title: "T" }, "q", " A \n", "cut"),
    'u — T\n\nAnswer to "q", from the page:\nA\n\n(cut)',
  );
  const fallback = fallbackResult({ url: "u" }, "z".repeat(FALLBACK_CHARS + 10), "timeout");
  assert.match(fallback, /couldn't be answered by a model: timeout/);
  assert.match(fallback, /… \(cut\)$/);
  assert.match(fallbackResult({ url: "u" }, "", "x"), /\(no text\)$/);
});
