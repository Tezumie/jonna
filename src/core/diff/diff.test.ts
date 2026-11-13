import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyChange,
  applySelectedLines,
  changeAtLine,
  diffLines,
  diffStat,
  lineMarks,
  rebase,
  revertChange,
  splitLines,
  stagedMarks,
} from "./index";

const lines = (...l: string[]) => l.map((x) => `${x}\n`);

test("splitLines keeps terminators and a last unterminated line", () => {
  assert.deepEqual(splitLines("a\nb\r\nc"), ["a\n", "b\r\n", "c"]);
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines("a\n"), ["a\n"]);
  assert.deepEqual(splitLines("a\rb\r\n\nc\r"), ["a\r", "b\r\n", "\n", "c\r"]);
  // A large LF-only text splits in linear time (it took minutes: each line searched the whole
  // rest of the text for a "\r" that isn't there).
  const big = "x\n".repeat(400_000);
  const started = performance.now();
  assert.equal(splitLines(big).length, 400_000);
  assert.ok(performance.now() - started < 2000);
  assert.equal(splitLines("y\r".repeat(50_000)).length, 50_000);
});

test("splitLines ends a line at a lone \\r, as the editor does", () => {
  assert.deepEqual(splitLines("a\r\r\r\nb\rc"), ["a\r", "\r", "\r\n", "b\r", "c"]);
  assert.deepEqual(splitLines("a\r"), ["a\r"]);
  assert.deepEqual(splitLines("\r\n\r"), ["\r\n", "\r"]);
});

test("a file with stray \\r shows no change against the editor's normalized text", () => {
  // The editor turns every break into its line ending; the index keeps "\r\r\r\n".
  const index = "# Log\r\r\r\nNewest\r\r\r\n| a |\r\r\r\n";
  const buffer = index.replace(/\r\n|\r|\n/g, "\r\n");
  assert.deepEqual(diffLines(splitLines(index), splitLines(buffer)), []);
  const edited = buffer.replace("Newest", "Oldest");
  assert.deepEqual(diffLines(splitLines(index), splitLines(edited)), [
    { originalStart: 3, originalEnd: 4, modifiedStart: 3, modifiedEnd: 4 },
  ]);
});

test("diffLines finds separate added, modified and deleted regions", () => {
  const a = lines("1", "2", "3", "4", "5", "6", "7");
  const b = lines("1", "two", "3", "4", "4.5", "5", "7");
  const changes = diffLines(a, b);
  assert.deepEqual(changes, [
    { originalStart: 1, originalEnd: 2, modifiedStart: 1, modifiedEnd: 2 },
    { originalStart: 4, originalEnd: 4, modifiedStart: 4, modifiedEnd: 5 },
    { originalStart: 5, originalEnd: 6, modifiedStart: 6, modifiedEnd: 6 },
  ]);
  assert.deepEqual(lineMarks(changes), [
    { kind: "modified", startLine: 2, endLine: 2 },
    { kind: "added", startLine: 5, endLine: 5 },
    { kind: "deleted", startLine: 6, endLine: 6 },
  ]);
  assert.deepEqual(diffStat(changes), { added: 2, removed: 2 });
});

test("diffLines ignores line-ending differences and handles empty sides", () => {
  assert.deepEqual(diffLines(["a\r\n", "b\r\n"], ["a\n", "b\n"]), []);
  assert.deepEqual(diffLines([], lines("x")), [
    { originalStart: 0, originalEnd: 0, modifiedStart: 0, modifiedEnd: 1 },
  ]);
  assert.deepEqual(diffLines(lines("x"), []), [
    { originalStart: 0, originalEnd: 1, modifiedStart: 0, modifiedEnd: 0 },
  ]);
});

test("applyChange stages one change; revertChange undoes one", () => {
  const a = lines("1", "2", "3", "4");
  const b = lines("one", "2", "3", "4", "5");
  const [first, second] = diffLines(a, b);
  assert.ok(first && second);
  assert.equal(applyChange(a, b, second), "1\n2\n3\n4\n5\n");
  assert.equal(applyChange(a, b, first), "one\n2\n3\n4\n");
  assert.equal(revertChange(a, b, first), "1\n2\n3\n4\n5\n");
  // Every change applied in turn reproduces the modified text.
  let staged = a.join("");
  for (;;) {
    const next = diffLines(splitLines(staged), b)[0];
    if (!next) break;
    staged = applyChange(splitLines(staged), b, next);
  }
  assert.equal(staged, b.join(""));
});

test("a missing final newline is fixed when a line moves into the middle", () => {
  const a = ["a\n", "b"];
  const b = ["a\n", "b\n", "c"];
  const [change] = diffLines(a, b);
  assert.ok(change);
  assert.equal(applyChange(a, b, change), "a\nb\nc");
  assert.equal(revertChange(a, b, change), "a\nb");
});

test("changeAtLine finds changes, deleted ones on either neighbouring line", () => {
  const changes = diffLines(lines("1", "2", "3"), lines("1", "3"));
  assert.ok(changeAtLine(changes, 1));
  assert.ok(changeAtLine(changes, 2));
  assert.equal(changeAtLine(changes, 3), undefined);
});

test("random edits round-trip through diff + apply", () => {
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let round = 0; round < 200; round++) {
    const a = Array.from({ length: rand(30) }, () => `${rand(6)}\n`);
    const b = Array.from({ length: rand(30) }, () => `${rand(6)}\n`);
    let text = a.join("");
    for (const _ of diffLines(a, b)) {
      const next = diffLines(splitLines(text), b)[0];
      if (!next) break;
      text = applyChange(splitLines(text), b, next);
    }
    assert.equal(text, b.join(""), `round ${round}`);
    // Reverting every change (last first, so indices stay valid) gives back the original.
    let back = b.join("");
    for (const c of diffLines(a, b).reverse()) back = revertChange(a, splitLines(back), c);
    assert.equal(back, a.join(""), `revert round ${round}`);
  }
});

test("a rewrite past the edit budget is one change, found quickly", () => {
  const original: string[] = [];
  const modified: string[] = [];
  for (let i = 0; i < 4000; i++) {
    original.push(`old ${i}\n`);
    modified.push(`new ${i}\n`);
  }
  const started = Date.now();
  assert.deepEqual(diffLines(original, modified), [
    { originalStart: 0, originalEnd: 4000, modifiedStart: 0, modifiedEnd: 4000 },
  ]);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
  // Just under the budget still gets the exact diff (every other line changed).
  const half = original.slice(0, 600).map((l, i) => (i % 2 ? `x${l}` : l));
  const changes = diffLines(original.slice(0, 600), half);
  assert.equal(changes.length, 300);
  assert.deepEqual(diffStat(changes), { added: 300, removed: 300 });
});

test("rebase keeps the user's edits and the agent's (D161)", () => {
  const base = "a\nb\nc\nd\ne\nf\n";
  const ours = "A\nb\nc\nd\ne\nf\n"; // the user changed line 1
  const theirs = "a\nb\nc\nd\nE\nf\nnew\n"; // the agent changed line 5 and added one
  assert.equal(rebase(base, ours, theirs), "A\nb\nc\nd\nE\nf\nnew\n");
  // Lines added above shift the agent's change down.
  assert.equal(rebase(base, "x\ny\na\nb\nc\nd\ne\nf\n", theirs), "x\ny\na\nb\nc\nd\nE\nf\nnew\n");
  // The same line: a conflict.
  assert.equal(rebase(base, "a\nb\nc\nd\nX\nf\n", theirs), null);
  assert.equal(rebase(base, base, theirs), theirs);
  assert.equal(rebase(base, ours, base), ours);
});

test("applySelectedLines: only the selected lines' changes (D200)", () => {
  const o = splitLines("a\nb\nc\nd\n");
  const m = splitLines("a\nB\nc\nD\nE\n");
  assert.equal(applySelectedLines(o, m, 2, 2), "a\nB\nc\nd\n");
  // Part of a change that grew: its selected new line, none of its old ones.
  assert.equal(applySelectedLines(o, m, 4, 4), "a\nb\nc\nD\n");
  // Part of a change of equal size: line for line, the others unchanged.
  assert.equal(
    applySelectedLines(splitLines("a\nb\nc\nd\ne\n"), splitLines("a\nB\nC\nD\ne\n"), 3, 3),
    "a\nb\nC\nd\ne\n",
  );
  assert.equal(applySelectedLines(o, m, 5, 2), "a\nB\nc\nD\nE\n");
  assert.equal(applySelectedLines(o, m, 1, 1), "a\nb\nc\nd\n");
  // A deletion counts when the selection touches the line next to it.
  const del = splitLines("x\n");
  assert.equal(applySelectedLines(splitLines("a\nx\nb\n"), splitLines("a\nb\n"), 2, 2), "a\nb\n");
  assert.equal(del.length, 1);
});

test("staged marks: changes against HEAD that the index already has (D203)", () => {
  const head = [
    { kind: "modified" as const, startLine: 2, endLine: 6 },
    { kind: "deleted" as const, startLine: 10, endLine: 10 },
    { kind: "added" as const, startLine: 20, endLine: 21 },
  ];
  const index = [
    { kind: "modified" as const, startLine: 4, endLine: 4 },
    { kind: "added" as const, startLine: 20, endLine: 21 },
  ];
  assert.deepEqual(stagedMarks(head, index), [
    { kind: "modified", startLine: 2, endLine: 3, staged: true },
    { kind: "modified", startLine: 5, endLine: 6, staged: true },
    { kind: "deleted", startLine: 10, endLine: 10, staged: true },
  ]);
  assert.deepEqual(stagedMarks([], index), []);
});
