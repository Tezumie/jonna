import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSearchEditor, serializeSearchEditor, withContext } from "./searchEditor";

test("a search editor's document round-trips in VS Code's format", () => {
  const q = {
    query: "a\\b",
    isRegex: true,
    matchCase: true,
    wholeWord: false,
    include: ["src", "lib"],
    exclude: ["dist"],
    contextLines: 1,
  };
  const lines = withContext(
    [{ line: 10, text: "foo a\\b", ranges: [[4, 7]] }],
    Array.from({ length: 12 }, (_, i) => (i === 9 ? "foo a\\b" : `line ${i + 1}`)),
    1,
  );
  assert.deepEqual(
    lines.map((l) => [l.line, l.ranges.length]),
    [
      [9, 0],
      [10, 1],
      [11, 0],
    ],
  );
  const text = serializeSearchEditor(q, [{ rel: "src/a.ts", lines }]);
  assert.equal(
    text,
    [
      "# Query: a\\\\b",
      "# Flags: RegExp CaseSensitive",
      "# Including: src, lib",
      "# Excluding: dist",
      "# ContextLines: 1",
      "",
      "1 result - 1 file",
      "",
      "src/a.ts:",
      "   9  line 9",
      "  10: foo a\\b",
      "  11  line 11",
      "",
    ].join("\n"),
  );
  assert.deepEqual(parseSearchEditor(text), q);
  assert.equal(parseSearchEditor("# Query: x\n").contextLines, 0);
});
