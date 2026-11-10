import assert from "node:assert/strict";
import { test } from "node:test";
import { consoleDiff } from "./consoleDiff";
import {
  type ConsoleLine,
  type ConsoleSessionInfo,
  clearConsoleLines,
  consoleChoices,
  consoleKeyOf,
  continueOutput,
  DebugConsoles,
  linesForConsole,
} from "./consoleSessions";

test("output after an unfinished line continues it (the same console and stream)", () => {
  const c = new DebugConsoles();
  const out = (text: string, extra: Partial<ConsoleLine> = {}): ConsoleLine => ({
    kind: "output",
    text,
    sessionId: "s1",
    ...extra,
  });
  c.print(out("Name? "));
  const before = c.lines.peek();
  c.print(out("Bob\nnext "));
  assert.deepEqual(
    c.lines.peek().map((l) => l.text),
    ["Name? Bob\nnext "],
  );
  // The view redraws only that line.
  assert.deepEqual(consoleDiff(before, c.lines.peek()), {
    drop: 0,
    appendFrom: 0,
    redrawLast: true,
  });
  // Carriage returns redraw the unfinished line (from its start, as a terminal does).
  c.print(out("10%"));
  c.print(out("\r50%\r100%\ndone\n"));
  assert.equal(c.lines.peek().at(-1)?.text, "Name? Bob\n100% 10%\ndone\n");
  // After a finished line, from another stream or another console: a new entry.
  c.print(out("more"));
  c.print(out("oops\n", { stderr: true }));
  c.print(out(" x", { sessionId: "s2" }));
  assert.equal(c.lines.peek().length, 4);
  assert.equal(continueOutput(out("a"), { kind: "info", text: "b" }), null);
  assert.equal(continueOutput(undefined, out("a")), null);
});

test("the console view redraws only a continued last line", () => {
  const a: ConsoleLine = { kind: "info", text: "Running" };
  const b: ConsoleLine = { kind: "output", text: "Name? " };
  const b2: ConsoleLine = { kind: "output", text: "Name? Bob\n" };
  const c: ConsoleLine = { kind: "output", text: "hi\n" };
  assert.deepEqual(consoleDiff([a, b], [a, b2, c]), { drop: 0, appendFrom: 1, redrawLast: true });
  // Its copy isn't where it was: redraw everything.
  assert.equal(consoleDiff([a, b], [c]), null);
  assert.equal(consoleDiff([a, b], [a, { kind: "info", text: "x" }]), null);
});

const session = (
  id: string,
  kind = "launch",
  parentId: string | null = null,
  compound: string | null = null,
): ConsoleSessionInfo => ({ id, name: `n-${id}`, parentId, kind, compound });

test("children and workers write into their parent's console; other sessions have their own", () => {
  const sessions = [
    session("s1", "launcher"),
    session("s2", "child", "s1"),
    session("s3", "worker", "s2"),
    session("s4", "launch", "s1"), // a serverReadyAction browser
  ];
  assert.equal(consoleKeyOf("s3", sessions), "s1");
  assert.equal(consoleKeyOf("s2", sessions), "s1");
  assert.equal(consoleKeyOf("s4", sessions), "s4");
  assert.equal(consoleKeyOf("gone", sessions), "gone");
  // A child whose parent ended keeps its own.
  assert.equal(consoleKeyOf("s9", [session("s9", "child", "s0")]), "s9");
});

test("the picker lists running sessions' consoles (a compound's each), then ended ones", () => {
  const sessions = [
    session("s1", "launch", null, "Full stack"),
    session("s2", "launch", null, "Full stack"),
    session("s3", "child", "s2"),
    session("s4", "launch", "s2"),
  ];
  const lines: ConsoleLine[] = [
    { kind: "info", text: "Running" },
    { kind: "output", text: "old", sessionId: "s0", session: "Old run" },
    { kind: "output", text: "a", sessionId: "s1", session: "n-s1" },
  ];
  assert.deepEqual(consoleChoices(sessions, lines), [
    { id: "s1", name: "n-s1", depth: 0, live: true, compound: "Full stack" },
    { id: "s2", name: "n-s2", depth: 0, live: true, compound: "Full stack" },
    { id: "s4", name: "n-s4", depth: 1, live: true },
    { id: "s0", name: "Old run", depth: 0, live: false },
  ]);
});

test("a console shows its own lines and the ones of no session; clearing keeps the others'", () => {
  const lines: ConsoleLine[] = [
    { kind: "info", text: "generic" },
    { kind: "output", text: "one", sessionId: "s1" },
    { kind: "output", text: "two", sessionId: "s2" },
  ];
  assert.deepEqual(
    linesForConsole(lines, "s1").map((l) => l.text),
    ["generic", "one"],
  );
  assert.equal(linesForConsole(lines, null).length, 3);
  assert.deepEqual(
    clearConsoleLines(lines, "s1").map((l) => l.text),
    ["two"],
  );
  assert.deepEqual(clearConsoleLines(lines, null), []);
});

test("the consoles keep a capped list and show the selected one's", () => {
  const c = new DebugConsoles(3);
  c.print({ kind: "output", text: "a\n", sessionId: "s1" });
  c.print({ kind: "output", text: "b\n", sessionId: "s2" });
  c.selected.value = "s2";
  assert.deepEqual(
    c.shown.peek().map((l) => l.text),
    ["b\n"],
  );
  c.print({ kind: "output", text: "c\n", sessionId: "s2" });
  c.print({ kind: "output", text: "d\n", sessionId: "s2" });
  assert.equal(c.lines.peek().length, 3);
  c.clear();
  assert.deepEqual(c.lines.peek(), []);
});
