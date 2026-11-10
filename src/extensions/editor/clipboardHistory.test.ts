import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ClipboardEntry,
  ClipboardHistory,
  historyRow,
  MAX_ENTRY_CHARS,
} from "./clipboardHistory";

test("ClipboardHistory: newest first, a repeat moves up, blanks and huge copies are skipped", () => {
  const h = new ClipboardHistory(3);
  h.add("a", 1);
  h.add("b", 2);
  h.add("   \n", 3);
  h.add("a", 4);
  assert.deepEqual(
    h.entries().map((e) => [e.text, e.at]),
    [
      ["a", 4],
      ["b", 2],
    ],
  );
  h.add("c", 5);
  h.add("d", 6);
  assert.deepEqual(
    h.entries().map((e) => e.text),
    ["d", "c", "a"],
  );
  h.add("x".repeat(MAX_ENTRY_CHARS + 1), 7);
  assert.equal(h.entries().length, 3);
  h.remove("c");
  assert.deepEqual(
    h.entries().map((e) => e.text),
    ["d", "a"],
  );
  h.clear();
  assert.equal(h.entries().length, 0);
});

test("historyRow: the first line with text, a count, and the rest as a preview", () => {
  const now = 10 * 60_000;
  assert.deepEqual(
    historyRow({ text: "\n  const a = 1;\n  return a;\n}\n", at: now - 120_000 }, now),
    {
      label: "const a = 1;",
      description: "4 lines · 2 min ago",
      detail: "return a; ⏎ }",
    },
  );
  assert.deepEqual(historyRow({ text: "token", at: now - 5_000 }, now), {
    label: "token",
    description: "5 characters · just now",
    detail: "",
  });
  const long = historyRow({ text: "y".repeat(200), at: now }, now);
  assert.equal(long.label.length, 80);
  assert.ok(long.label.endsWith("…"));
});

test("a value copied from a secrets file is listed hidden, and stays hidden (D407)", () => {
  const h = new ClipboardHistory();
  h.add("sk-live-123", 1000, true);
  const row = historyRow(h.entries()[0] as ClipboardEntry, 1000);
  assert.equal(row.label, "Hidden value");
  assert.ok(!JSON.stringify(row).includes("sk-live"));
  // Copied again from elsewhere: still hidden.
  h.add("sk-live-123", 2000);
  assert.equal(h.entries()[0]?.secret, true);
});
