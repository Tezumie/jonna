import assert from "node:assert/strict";
import { test } from "node:test";
import { changeNote, changeNotesText, KEEP_TEXT_CHARS, ReadTracker, textHash } from "./readTracker";

test("D308: an unchanged file has no note; a changed one a short diff, told once", () => {
  const t = new ReadTracker();
  t.record("a", "/w/a.ts", "one\ntwo\nthree\n");
  assert.equal(t.observe("a", "one\ntwo\nthree\n", "a.ts"), null);
  const c = t.observe("a", "one\nTWO\nthree\nfour\n", "a.ts");
  assert.ok(c);
  assert.equal(c.shown, true);
  assert.match(c.note, /^a\.ts changed since you last read it/);
  assert.match(c.note, /@@ line 2 @@\n-two\n\+TWO/);
  assert.match(c.note, /@@ line 4 @@\n\+four/);
  // Remembered as it is now: the same change isn't told again.
  assert.equal(t.observe("a", "one\nTWO\nthree\nfour\n", "a.ts"), null);
  // Not tracked: nothing to say.
  assert.equal(t.observe("zzz", "x", "zzz"), null);
});

test("D308: a deleted file is told and forgotten", () => {
  const t = new ReadTracker();
  t.record("a", "/w/a.ts", "x\n");
  const c = t.observe("a", null, "a.ts");
  assert.equal(c?.deleted, true);
  assert.match(c?.note ?? "", /deleted/);
  assert.equal(t.has("a"), false);
});

test("D308: removed lines, and a change too large to show", () => {
  const removed = changeNote("f", "a\nb\nc\n", "a\nc\n");
  assert.match(removed.note, /@@ removed after line 1 @@\n-b/);
  const before = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const after = Array.from({ length: 200 }, (_, i) => `LINE ${i}`).join("\n");
  const big = changeNote("f", before, after);
  assert.equal(big.shown, false);
  assert.match(big.note, /\+200 −200 lines, too many to show\)\. Read it again/);
  assert.equal(changeNote("f", null, "x").shown, false);
  assert.match(changeNote("f", "a\r\nb\r\n", "a\nb\n").note, /line endings only/);
});

test("D308: a large file is kept as a hash: the change is named, not shown", () => {
  const t = new ReadTracker();
  const big = "x".repeat(KEEP_TEXT_CHARS + 1);
  t.record("b", "/w/b", big);
  assert.equal(t.observe("b", big, "b"), null);
  const c = t.observe("b", `${big}y`, "b");
  assert.equal(c?.shown, false);
});

test("D308: newest first, the oldest forgotten past the cap; stamps kept per file", () => {
  const t = new ReadTracker();
  for (let i = 0; i < 205; i++) t.record(`k${i}`, `/w/${i}`, "x");
  assert.equal(t.has("k0"), false);
  assert.equal(t.has("k204"), true);
  assert.deepEqual(
    t.recent(2).map((r) => r.key),
    ["k204", "k203"],
  );
  t.setStamp("k204", "3:100");
  assert.equal(t.recent(1)[0]?.stamp, "3:100");
  // Seen again: its stamp is cleared (the next check compares the text once more).
  t.record("k204", "/w/204", "y");
  assert.equal(t.recent(1)[0]?.stamp, null);
  assert.notEqual(textHash("ab"), textHash("ba"));
});

test("D308: several notes are capped and count what was left out", () => {
  assert.equal(changeNotesText([]), null);
  const r = changeNotesText(["a".repeat(50), "b".repeat(50), "c".repeat(50)], 120);
  assert.equal(r?.included, 2);
  assert.match(r?.text ?? "", /… 1 more files changed/);
  assert.equal(changeNotesText(["x"])?.included, 1);
});
