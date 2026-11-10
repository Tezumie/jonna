import assert from "node:assert/strict";
import { test } from "node:test";
import { consoleDiff } from "./consoleDiff";
import type { ConsoleLine } from "./controller";

const line = (text: string): ConsoleLine => ({ kind: "output", text });

test("consoleDiff appends new lines", () => {
  const a = line("a");
  const b = line("b");
  assert.deepEqual(consoleDiff([], [a]), { drop: 0, appendFrom: 0 });
  assert.deepEqual(consoleDiff([a], [a, b]), { drop: 0, appendFrom: 1 });
});

test("consoleDiff keeps showing new lines once the list is capped (same length)", () => {
  const [a, b, c, d] = ["a", "b", "c", "d"].map(line) as [
    ConsoleLine,
    ConsoleLine,
    ConsoleLine,
    ConsoleLine,
  ];
  // Capped at 3: [a, b, c] → [b, c, d]: drop one from the top, append d.
  assert.deepEqual(consoleDiff([a, b, c], [b, c, d]), { drop: 1, appendFrom: 2 });
  // Every shown line trimmed but the last.
  assert.deepEqual(consoleDiff([a, b, c], [c, d]), { drop: 2, appendFrom: 1 });
});

test("consoleDiff redraws when cleared or rewritten", () => {
  const a = line("a");
  const b = line("b");
  assert.equal(consoleDiff([a], []), null);
  assert.equal(consoleDiff([a, b], [line("x")]), null);
  // The last line is still there but something before it changed.
  assert.equal(consoleDiff([a, b], [line("x"), b]), null);
});
