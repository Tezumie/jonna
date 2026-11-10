import assert from "node:assert/strict";
import { test } from "node:test";
import { correctedCommandLine, stickyApplies, typedText } from "./commandLine";

const screen = (lines: string[]) => (y: number) => lines[y];

test("a mark left on the blank row under the command moves up to it (ConPTY)", () => {
  const lines = ["PS C:\\w> npm install", "", "up to date"];
  assert.equal(correctedCommandLine(screen(lines), 1, "npm install"), 0);
});

test("a mark on a row with text is trusted (a two-line prompt keeps its dot on the first)", () => {
  const lines = ["~/w on main", "> npm test", "ok"];
  assert.equal(correctedCommandLine(screen(lines), 0, "npm test"), 0);
});

test("nothing nearby holds the command: the mark stays", () => {
  const lines = ["a", "", "b", "c"];
  assert.equal(correctedCommandLine(screen(lines), 1, "npm install"), 1);
});

test("searches above first, then below, within three rows", () => {
  const lines = ["", "", "x", "PS> ls", ""];
  assert.equal(correctedCommandLine(screen(lines), 1, "ls"), 3);
  assert.equal(correctedCommandLine(screen(["PS> ls", "", "", "", "", ""]), 5, "ls"), 5);
});

test("a mark on a row the command's output filled later moves up to the command (npm run dev)", () => {
  const lines = ["PS C:\\w> npm run dev -w apps/site", "", "> site@0.0.0 dev", "> vite", ""];
  // The mark on the blank row, and on the output's first line once it was written.
  assert.equal(correctedCommandLine(screen(lines), 1, "npm run dev -w apps/site"), 0);
  assert.equal(correctedCommandLine(screen(lines), 2, "npm run dev -w apps/site"), 0);
  // Whitespace only counts as blank.
  assert.equal(correctedCommandLine(screen(["PS> npm run dev", "   "]), 1, "npm run dev"), 0);
});

test("the same short command twice: each keeps its own line", () => {
  const lines = ["~/w on main", "> ls", "a.txt", "~/w on main", "> ls", "a.txt"];
  assert.equal(correctedCommandLine(screen(lines), 3, "ls"), 3);
  assert.equal(correctedCommandLine(screen(lines), 4, "ls"), 4);
});

test("the sticky line: a running command's line stays at the top, also at the bottom", () => {
  // Scrolled to the bottom of a dev server's log: its command line is far above the top.
  assert.equal(stickyApplies({ line: 3, top: 40, end: undefined, alternateBuffer: false }), true);
  // Its line on screen: no copy.
  assert.equal(stickyApplies({ line: 40, top: 40, end: undefined, alternateBuffer: false }), false);
  // Finished, its output scrolled away: no copy.
  assert.equal(stickyApplies({ line: 3, top: 40, end: 30, alternateBuffer: false }), false);
  assert.equal(stickyApplies({ line: 3, top: 20, end: 30, alternateBuffer: false }), true);
  // A full-screen program owns the screen.
  assert.equal(stickyApplies({ line: 3, top: 40, end: undefined, alternateBuffer: true }), false);
  // Its line trimmed off the scrollback, its output still there.
  assert.equal(stickyApplies({ line: -1, top: 0, end: undefined, alternateBuffer: false }), true);
});

test("D261: sendText's line breaks are Enter, and one Enter at the end", () => {
  assert.equal(typedText("ls", true), "ls\r");
  assert.equal(typedText("a\nb\r\nc", true), "a\rb\rc\r");
  assert.equal(typedText("echo hi\n", true), "echo hi\r");
  assert.equal(typedText("x", false), "x");
});
