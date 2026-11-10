import assert from "node:assert/strict";
import { test } from "node:test";
import { computeMergeChanges, MergeModel, textLines } from "./merge";

const text = (...l: string[]) => l.map((x) => `${x}\n`).join("");

test("textLines splits without terminators and remembers the final newline", () => {
  assert.deepEqual(textLines("a\nb\n"), { lines: ["a", "b"], finalNewline: true, eol: "\n" });
  assert.deepEqual(textLines("a\r\nb"), { lines: ["a", "b"], finalNewline: false, eol: "\r\n" });
  assert.deepEqual(textLines(""), { lines: [], finalNewline: false, eol: "\n" });
});

test("one-sided changes merge cleanly; both sides on the same lines conflict", () => {
  const base = ["a", "b", "c", "d", "e"];
  const current = ["A", "b", "c", "D", "e"];
  const incoming = ["a", "B", "c", "d2", "e"];
  const changes = computeMergeChanges(base, current, incoming);
  assert.equal(changes.length, 3);
  assert.deepEqual(
    changes.map((c) => c.conflict),
    [false, false, true],
  );
  assert.deepEqual(changes[0]?.current, { start: 0, end: 1 });
  assert.deepEqual(changes[1]?.incoming, { start: 1, end: 2 });
  assert.deepEqual(changes[2]?.base, { start: 3, end: 4 });
  // Theirs' change of c and d is one block: it overlaps ours' change of d, so it all conflicts.
  const wide = computeMergeChanges(base, current, ["a", "b", "C", "d2", "e"]);
  assert.deepEqual(
    wide.map((c) => [c.base, c.conflict]),
    [
      [{ start: 0, end: 1 }, false],
      [{ start: 2, end: 4 }, true],
    ],
  );
  assert.deepEqual(wide[1]?.current, { start: 2, end: 4 });
});

test("the same change on both sides is not a conflict", () => {
  const changes = computeMergeChanges(["a", "b"], ["a", "x"], ["a", "x"]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.conflict, false);
});

test("the result starts with clean changes taken and conflicts at the base text", () => {
  const m = new MergeModel(
    text("one", "two", "three", "four"),
    text("ONE", "two", "three", "4 ours"),
    text("one", "two", "THREE", "4 theirs"),
  );
  assert.equal(m.conflictCount, 1);
  assert.equal(m.unhandledCount, 1);
  assert.equal(m.text(), text("ONE", "two", "three", "four"));
  // THREE and the line after it touch: one conflict holds both sides' lines.
  const conflict = m.changes.find((c) => c.conflict);
  assert.ok(conflict);
  m.accept(conflict.id, "incoming");
  assert.equal(m.text(), text("ONE", "two", "THREE", "4 theirs"));
  assert.equal(m.unhandledCount, 0);
  m.accept(conflict.id, "both");
  assert.equal(m.text(), text("ONE", "two", "three", "4 ours", "THREE", "4 theirs"));
  m.accept(conflict.id, "base");
  assert.equal(m.text(), text("ONE", "two", "three", "four"));
  assert.equal(m.stateOf(conflict.id).handled, true);
  m.reset();
  assert.equal(m.unhandledCount, 1);
});

test("separate conflicts are counted and navigated", () => {
  const m = new MergeModel(
    text("a", "b", "c", "d", "e", "f"),
    text("a1", "b", "c", "d1", "e", "f"),
    text("a2", "b", "c", "d2", "e", "f"),
  );
  assert.equal(m.conflictCount, 2);
  assert.equal(m.nextConflict(-1, "next"), 0);
  assert.equal(m.nextConflict(0, "next"), 1);
  assert.equal(m.nextConflict(5, "next"), 0);
  assert.equal(m.nextConflict(5, "previous"), 1);
  m.accept(0, "current");
  assert.equal(m.unhandledCount, 1);
  assert.equal(m.nextConflict(-1, "next", true), 1);
  assert.deepEqual(m.resultSpan(1), { start: 3, end: 4 });
});

test("typing in the result keeps the segments and marks the conflict edited", () => {
  const m = new MergeModel(
    text("a", "b", "c", "d", "e", "f"),
    text("a1", "b", "c", "d1", "e", "f"),
    text("a2", "b", "c", "d2", "e", "f"),
  );
  // Lines added above the file and the first conflict typed over by hand.
  m.setResultText(text("header", "mine", "b", "c", "d", "e", "f"));
  assert.equal(m.stateOf(0).choice, "edited");
  assert.equal(m.stateOf(0).handled, true);
  assert.equal(m.unhandledCount, 1);
  assert.deepEqual(m.resultSpan(1), { start: 4, end: 5 });
  // Accepting the second still replaces just its lines.
  m.accept(1, "incoming");
  assert.equal(m.text(), text("header", "mine", "b", "c", "d2", "e", "f"));
  // A hand edit equal to a choice is that choice.
  m.setResultText(text("header", "mine", "b", "c", "d1", "e", "f"));
  assert.equal(m.stateOf(1).choice, "current");
});

test("lines inserted right after a conflict join it", () => {
  const m = new MergeModel(text("a", "x", "z"), text("a", "y1", "z"), text("a", "y2", "z"));
  m.accept(0, "current");
  m.setResultText(text("a", "y1", "extra", "z"));
  assert.deepEqual(m.resultSpan(0), { start: 1, end: 3 });
  assert.equal(m.stateOf(0).choice, "edited");
});

test("a conflict with an empty base (both added) and both-sides order", () => {
  const m = new MergeModel("", text("ours"), text("theirs"));
  assert.equal(m.conflictCount, 1);
  assert.equal(m.text(), "");
  m.accept(0, "bothIncomingFirst");
  assert.equal(m.text(), text("theirs", "ours"));
});

test("mapLine follows the regions between panes", () => {
  const m = new MergeModel(
    text("a", "b", "c", "d"),
    text("a", "new", "b", "c", "d"),
    text("a", "b", "c", "D"),
  );
  // Line "c" is 3 in current, 2 in incoming, 3 in the result (current's insert taken).
  assert.equal(m.mapLine("current", "incoming", 3), 2);
  assert.equal(m.mapLine("incoming", "result", 2), 3);
  assert.equal(m.mapLine("result", "base", 3), 2);
});

test("CRLF files keep their line endings", () => {
  const m = new MergeModel("a\r\nb\r\n", "a\r\nB1\r\n", "a\r\nB2\r\n");
  m.accept(0, "incoming");
  assert.equal(m.text(), "a\r\nB2\r\n");
});

test("a current side without a line break takes the others' CRLF", () => {
  const m = new MergeModel("a\r\nb\r\n", "a", "a\r\nb\r\nc\r\n");
  assert.ok(m.text().includes("\r\n"));
  assert.ok(!/[^\r]\n/.test(m.text()), m.text());
});

test("both added the file: common lines stay common, each difference is a conflict (D219)", () => {
  const m = new MergeModel(
    "",
    text("import a", "one", "shared", "two", "end"),
    text("import a", "uno", "shared", "end", "extra"),
  );
  // "one"/"uno", "two"/nothing and nothing/"extra": three conflicts, not one for the whole file.
  assert.equal(m.conflictCount, 3);
  assert.equal(m.text(), text("import a", "shared", "end"));
  m.accept(0, "incoming");
  m.accept(1, "current");
  m.accept(2, "incoming");
  assert.equal(m.text(), text("import a", "uno", "shared", "two", "end", "extra"));
  assert.equal(m.unhandledCount, 0);
  // The same file on both sides: nothing to merge.
  assert.equal(new MergeModel("", text("x"), text("x")).changes.length, 0);
});

test("a final newline only the incoming side added is kept (D219)", () => {
  // Base and current end without one; incoming adds one (and changes nothing else).
  const m = new MergeModel("a\nb", "a\nB", "a\nb\n");
  assert.equal(m.text(), "a\nB\n");
  // Incoming took it away, current left it: gone.
  assert.equal(new MergeModel("a\nb\n", "a\nB\n", "a\nb").text(), "a\nB");
  // Current changed it: current's.
  assert.equal(new MergeModel("a\nb\n", "a\nB", "a\nb\n").text(), "a\nB");
  // Reset brings it back after a hand edit took it away.
  m.setResultText("a\nB");
  m.reset();
  assert.equal(m.text(), "a\nB\n");
});
