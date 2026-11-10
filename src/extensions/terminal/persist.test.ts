import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dimmed,
  logicalLines,
  MAX_SAVED_CHARS,
  parseSavedOutputs,
  restoredBanner,
  savedRange,
} from "./persist";

const E = "\x1b";

test("restored output is dim everywhere, even after its own resets", () => {
  assert.equal(dimmed("plain"), `${E}[2mplain${E}[0m`);
  assert.equal(
    dimmed(`${E}[31mred${E}[0m ok${E}[m${E}[1;38;5;208mx`),
    `${E}[2m${E}[31;2mred${E}[0;2m ok${E}[0;2m${E}[1;38;5;208;2mx${E}[0m`,
  );
  // Cursor movements are left alone.
  assert.equal(dimmed(`a${E}[2Cb`), `${E}[2ma${E}[2Cb${E}[0m`);
});

test("the banner ends with the separator on its own line", () => {
  const text = restoredBanner({ text: "$ ls\r\na.txt\r\n$ \r\n", time: 0 }, "14:02");
  assert.ok(text.startsWith(`${E}[2m$ ls\r\na.txt\r\n$ `));
  assert.ok(text.endsWith(`──── Restored session · 14:02 ────${E}[0m\r\n`));
  assert.ok(!text.includes("\r\n\r\n"));
});

test("saved outputs are read back defensively and capped", () => {
  const big = "x".repeat(MAX_SAVED_CHARS + 10);
  const map = parseSavedOutputs({
    a: { text: "hello", time: 5 },
    b: { text: "", time: 1 },
    c: { text: 3, time: 1 },
    d: null,
    e: { text: big, time: 2 },
  });
  assert.deepEqual([...map.keys()], ["a", "e"]);
  assert.equal(map.get("e")?.text.length, MAX_SAVED_CHARS);
  assert.equal(parseSavedOutputs(null).size, 0);
  assert.equal(parseSavedOutputs([1, 2]).size, 0);
});

test("the saved rows are the last N up to the output's end", () => {
  assert.deepEqual(savedRange(250, 240, 100), { start: 151, end: 250 });
  assert.deepEqual(savedRange(3, 10, 100), { start: 0, end: 10 });
  assert.equal(savedRange(5, 5, 0), null);
});

test("a saved screen keeps the output offset it reflects, unless it was cut", () => {
  const big = "x".repeat(MAX_SAVED_CHARS + 10);
  const map = parseSavedOutputs({
    a: { text: "hello", time: 5, offset: 1234 },
    b: { text: "hi", time: 5, offset: -1 },
    c: { text: "hi", time: 5, offset: "9" },
    d: { text: big, time: 5, offset: 99 },
  });
  assert.deepEqual(map.get("a"), { text: "hello", time: 5, offset: 1234 });
  assert.equal(map.get("b")?.offset, undefined);
  assert.equal(map.get("c")?.offset, undefined);
  assert.equal(map.get("d")?.offset, undefined);
  assert.equal(map.get("d")?.text.length, MAX_SAVED_CHARS);
});

test("plain lines join wrapped rows, so a restart reflows them at any width (D253)", () => {
  const rows = [
    { text: "PS C:w> ls", wrapped: false },
    { text: "-".repeat(40), wrapped: false },
    { text: "-".repeat(30), wrapped: true },
    { text: "a.txt   ", wrapped: false },
    { text: "PS C:w> ", wrapped: false },
    { text: "", wrapped: false },
  ];
  const { text, fresh } = logicalLines(rows);
  assert.equal(text, `PS C:w> ls\n${"-".repeat(70)}\na.txt\nPS C:w>`);
  assert.equal(fresh, 4);
  // A first row that continues one from before the range starts a line of its own.
  assert.equal(logicalLines([{ text: "tail", wrapped: true }]).text, "tail");
  assert.deepEqual(logicalLines([{ text: "  ", wrapped: false }]), { text: "", fresh: 0 });
});

test("the banner uses the plain lines when saved, with no cursor moves (D253)", () => {
  const saved = {
    text: `${E}[2m${"-".repeat(10)}${E}[1D${E}[1X${E}[A${E}[60C`,
    time: 0,
    lines: "PS C:w> ls\nfile.txt\nPS C:w>",
  };
  const banner = restoredBanner(saved, "14:02");
  assert.ok(banner.startsWith(`${E}[2mPS C:w> ls\r\nfile.txt\r\nPS C:w>${E}[0m\r\n`));
  assert.ok(!banner.includes(`${E}[A`));
  // Read back from the state with them.
  const map = parseSavedOutputs({ a: saved, b: { text: "x", time: 1, lines: 5 } });
  assert.equal(map.get("a")?.lines, saved.lines);
  assert.equal(map.get("b")?.lines, undefined);
});
