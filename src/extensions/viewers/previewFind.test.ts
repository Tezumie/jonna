import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findInSegments,
  firstMatchFrom,
  matchCountLabel,
  type SegmentMatch,
  stepMatch,
  type TextSegment,
} from "./previewFind";

const segs = (...parts: [string, number][]): TextSegment[] =>
  parts.map(([text, block]) => ({ text, block }));

test("matches inside one text node and across inline markup", () => {
  // "Hello **world**" then a second paragraph "world peace".
  const s = segs(["Hello ", 0], ["world", 0], ["world peace", 1]);
  const m = findInSegments(s, { query: "o w" }) as SegmentMatch[];
  assert.deepEqual(m, [{ startSegment: 0, startOffset: 4, endSegment: 1, endOffset: 1 }]);
  const all = findInSegments(s, { query: "world" }) as SegmentMatch[];
  assert.deepEqual(all, [
    { startSegment: 1, startOffset: 0, endSegment: 1, endOffset: 5 },
    { startSegment: 2, startOffset: 0, endSegment: 2, endOffset: 5 },
  ]);
});

test("a match never joins two blocks", () => {
  const s = segs(["end", 0], ["start", 1]);
  assert.deepEqual(findInSegments(s, { query: "endstart" }), []);
  assert.deepEqual(findInSegments(s, { query: "d s", regex: false }), []);
  // A regex can't reach over the break either (no \n in the text it sees as one line).
  assert.deepEqual(findInSegments(s, { query: "d.s", regex: true }), []);
});

test("case, whole word and regex options; bad patterns", () => {
  const s = segs(["Find the finder; FIND it", 0]);
  assert.equal((findInSegments(s, { query: "find" }) as SegmentMatch[]).length, 3);
  assert.equal(
    (findInSegments(s, { query: "find", caseSensitive: true }) as SegmentMatch[]).length,
    1,
  );
  assert.equal((findInSegments(s, { query: "find", wholeWord: true }) as SegmentMatch[]).length, 2);
  assert.equal((findInSegments(s, { query: "f\\w+r", regex: true }) as SegmentMatch[]).length, 1);
  assert.equal(typeof findInSegments(s, { query: "(", regex: true }), "string");
  assert.deepEqual(findInSegments(s, { query: "" }), []);
});

test("next / previous wrap; the label", () => {
  assert.equal(stepMatch(-1, 3, 1), 0);
  assert.equal(stepMatch(-1, 3, -1), 2);
  assert.equal(stepMatch(2, 3, 1), 0);
  assert.equal(stepMatch(0, 3, -1), 2);
  assert.equal(stepMatch(0, 0, 1), -1);
  assert.equal(matchCountLabel("x", 1, 4, null), "2 of 4");
  assert.equal(matchCountLabel("x", -1, 0, null), "No results");
  assert.equal(matchCountLabel("(", -1, 0, "bad"), "Bad pattern");
  assert.equal(matchCountLabel("", -1, 0, null), "");
  const m = (startSegment: number) => ({
    startSegment,
    startOffset: 0,
    endSegment: 0,
    endOffset: 1,
  });
  assert.equal(firstMatchFrom([m(1), m(5), m(9)], 4), 1);
  assert.equal(firstMatchFrom([m(1), m(5)], 7), 0);
});
