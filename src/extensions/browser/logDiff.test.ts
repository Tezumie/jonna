import assert from "node:assert/strict";
import { test } from "node:test";
import { logDiff } from "./page";

const a = { n: "a" };
const b = { n: "b" };
const c = { n: "c" };
const d = { n: "d" };

test("logDiff: appends", () => {
  assert.deepEqual(logDiff([], [a, b]), { dropped: 0, added: [a, b], replaced: null });
  assert.deepEqual(logDiff([a], [a, b, c]), { dropped: 0, added: [b, c], replaced: null });
  assert.deepEqual(logDiff([a, b], [a, b]), { dropped: 0, added: [], replaced: null });
});

test("logDiff: a capped log drops from the front while appending", () => {
  assert.deepEqual(logDiff([a, b, c], [b, c, d]), { dropped: 1, added: [d], replaced: null });
  assert.deepEqual(logDiff([a, b, c], [c, d]), { dropped: 2, added: [d], replaced: null });
});

test("logDiff: the last item replaced in place (a repeat count)", () => {
  const b2 = { n: "b", count: 2 };
  assert.deepEqual(logDiff([a, b], [a, b2]), { dropped: 0, added: [], replaced: b2 });
  assert.deepEqual(logDiff([a, b], [a, b2, c]), { dropped: 0, added: [c], replaced: b2 });
  assert.deepEqual(logDiff([a], [b2]), { dropped: 0, added: [], replaced: b2 });
});

test("logDiff: anything else is a redraw", () => {
  assert.equal(logDiff([a, b], []), null);
  assert.equal(logDiff([a, b, c], [d]), null);
  // The anchor is there but something before it changed.
  assert.equal(logDiff([a, b, c], [d, b, c]), null);
});
