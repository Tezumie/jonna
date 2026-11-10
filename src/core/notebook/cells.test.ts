import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConcatDocument,
  cellDiagnostics,
  cellSemanticTokens,
  concatPath,
  divideAtBoundaries,
  maskMagics,
  semanticTokensDiff,
} from "./concat";
import { findInCells, findPattern, nearestMatch, replaceAllIn, replacementFor } from "./find";
import { codeCellLabel, markdownHeadings, notebookOutline } from "./outline";

// ---- The joined document (D204) ----

const cells = [
  { id: "a", text: "import os\nx = 1" },
  { id: "b", text: "%matplotlib inline\ny = x + 1\ny" },
  { id: "c", text: "" },
  { id: "d", text: "print(y)\r\n" },
];

test("cells join into one document, magics masked in place", () => {
  const doc = new ConcatDocument(cells, "python");
  assert.equal(doc.text, "import os\nx = 1\n#matplotlib inline\ny = x + 1\ny\n\nprint(y)\n");
  assert.deepEqual(doc.cellIds, ["a", "b", "c", "d"]);
  // Other languages keep their text (an R cell's `!x` is R).
  assert.equal(new ConcatDocument([{ id: "r", text: "!x" }], "r").text, "!x");
});

test("positions map both ways", () => {
  const doc = new ConcatDocument(cells, "python");
  assert.deepEqual(doc.toConcat("a", 1, 4), { line: 1, character: 4 });
  assert.deepEqual(doc.toConcat("b", 1, 0), { line: 3, character: 0 });
  assert.deepEqual(doc.toConcat("d", 0, 6), { line: 6, character: 6 });
  assert.equal(doc.toConcat("zz", 0, 0), null);
  assert.deepEqual(doc.fromConcat(3, 4), { cellId: "b", line: 1, character: 4 });
  assert.deepEqual(doc.fromConcat(5, 0), { cellId: "c", line: 0, character: 0 });
  assert.deepEqual(doc.fromConcat(0, 2), { cellId: "a", line: 0, character: 2 });
  assert.equal(doc.fromConcat(99, 0), null);
  assert.equal(doc.fromConcat(-1, 0), null);
  // Round trip for every line of every cell.
  for (const c of cells)
    c.text.split("\n").forEach((_, line) => {
      const at = doc.toConcat(c.id, line, 1);
      assert.ok(at);
      assert.deepEqual(doc.fromConcat(at.line, at.character), { cellId: c.id, line, character: 1 });
    });
});

test("a range crossing cells is clipped to its start's cell", () => {
  const doc = new ConcatDocument(cells, "python");
  assert.deepEqual(
    doc.rangeFromConcat({ start: { line: 1, character: 0 }, end: { line: 3, character: 2 } }),
    { cellId: "a", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
  );
  assert.deepEqual(
    doc.rangeFromConcat({ start: { line: 3, character: 4 }, end: { line: 3, character: 5 } }),
    { cellId: "b", range: { start: { line: 1, character: 4 }, end: { line: 1, character: 5 } } },
  );
});

test("cell magics comment the whole cell; shell lines are masked", () => {
  assert.equal(maskMagics("%%bash\nls -la\n  echo", "python"), "#%bash\n#s -la\n  #cho");
  assert.equal(
    maskMagics("!pip install x\n  %time f()\nx = 1", "python"),
    "#pip install x\n  #time f()\nx = 1",
  );
  assert.equal(maskMagics("a != b", "python"), "a != b");
});

test("IPython beyond magics: shell and magic values, help lines (D229)", () => {
  const src =
    "files = !ls -la\nt = %time f()\nobj?\n  ??np.load\nnp.*load*?\nx = a != b\ny = 1 # why?";
  const out = maskMagics(src, "python");
  assert.equal(
    out,
    "files = []     \nt = ...      \n#bj?\n  #?np.load\n#p.*load*?\nx = a != b\ny = 1 # why?",
  );
  // Columns never move.
  assert.deepEqual(
    out.split("\n").map((l) => l.length),
    src.split("\n").map((l) => l.length),
  );
  // A diagnostic on the stand-in is dropped; one on the name before it stays.
  const nb = [{ id: "a", text: "files = !ls\nfiles" }];
  const doc = new ConcatDocument(nb, "python");
  const at = (character: number, end: number) => ({
    range: { start: { line: 0, character }, end: { line: 0, character: end } },
    message: "m",
  });
  assert.deepEqual(
    cellDiagnostics(doc, [at(8, 11), at(0, 5)], nb).map((d) => d.range.start.character),
    [0],
  );
});

test("cell ranges, edits inside one cell, semantic tokens per cell (D229)", () => {
  const doc = new ConcatDocument(cells, "python");
  assert.deepEqual(doc.cellRange("b"), {
    start: { line: 2, character: 0 },
    end: { line: 4, character: 1 },
  });
  assert.equal(doc.cellRange("zz"), null);
  // An auto-import at the top of the joined document lands at the top of the first cell.
  assert.deepEqual(
    doc.editFromConcat({ start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }),
    { cellId: "a", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
  );
  assert.deepEqual(
    doc.editFromConcat({ start: { line: 3, character: 0 }, end: { line: 4, character: 1 } }),
    { cellId: "b", range: { start: { line: 1, character: 0 }, end: { line: 2, character: 1 } } },
  );
  // Across cells: left out.
  assert.equal(
    doc.editFromConcat({ start: { line: 1, character: 0 }, end: { line: 2, character: 0 } }),
    null,
  );
  // Tokens: (line 0, 0, len 6), (line 1, 0, len 1), (line 3, 0, 1), (line 3, 4, 1), (line 6, 0, 5).
  const data = [0, 0, 6, 1, 0, 1, 0, 1, 2, 0, 2, 0, 1, 2, 0, 0, 4, 1, 2, 0, 3, 0, 5, 3, 0];
  assert.deepEqual(cellSemanticTokens(doc, "b", data), [1, 0, 1, 2, 0, 0, 4, 1, 2, 0]);
  assert.deepEqual(cellSemanticTokens(doc, "a", data), [0, 0, 6, 1, 0, 1, 0, 1, 2, 0]);
  assert.deepEqual(cellSemanticTokens(doc, "d", data), [0, 0, 5, 3, 0]);
  assert.deepEqual(cellSemanticTokens(doc, "c", data), []);
});

test("diagnostics land in their cells; magic lines and a cell's last expression are skipped", () => {
  const doc = new ConcatDocument(cells, "python");
  const d = (line: number, code?: string) => ({
    range: { start: { line, character: 0 }, end: { line, character: 1 } },
    message: "m",
    ...(code && { code }),
  });
  const mapped = cellDiagnostics(
    doc,
    [d(1), d(2), d(4, "reportUnusedExpression"), d(3, "reportUnusedExpression"), d(6)],
    cells,
  );
  assert.deepEqual(
    mapped.map((m) => [m.cellId, m.range.start.line]),
    [
      ["a", 1],
      ["b", 1],
      ["d", 0],
    ],
  );
  assert.equal(concatPath("/w/nb.ipynb", "py"), "/w/nb.ipynb.concat.py");
});

// ---- Outline ----

test("Markdown headings, fences skipped, setext read", () => {
  assert.deepEqual(markdownHeadings("# One\ntext\n```\n# not\n```\n## Two *em* ##\nThree\n===\n"), [
    { level: 1, text: "One", line: 1 },
    { level: 2, text: "Two em", line: 6 },
    { level: 1, text: "Three", line: 7 },
  ]);
  assert.equal(codeCellLabel("\n\n  import numpy as np\nx", 0), "import numpy as np");
  assert.equal(codeCellLabel("", 4), "Code cell 5");
});

test("the notebook outline nests code cells under headings", () => {
  const outline = notebookOutline([
    { id: "1", kind: "markdown", source: "# Intro" },
    { id: "2", kind: "code", source: "import os" },
    { id: "3", kind: "markdown", source: "## Load\nSome text" },
    { id: "4", kind: "code", source: "df = load()" },
    { id: "5", kind: "markdown", source: "# Results" },
    { id: "6", kind: "raw", source: "raw" },
    { id: "7", kind: "code", source: "plot(df)" },
  ]);
  const shape = (list: typeof outline): unknown =>
    list.map((e) => [e.name, e.kind, e.line, e.endLine, shape(e.children)]);
  assert.deepEqual(shape(outline), [
    [
      "Intro",
      "string",
      1,
      4,
      [
        ["import os", "cell", 2, 2, []],
        ["Load", "string", 3, 4, [["df = load()", "cell", 4, 4, []]]],
      ],
    ],
    ["Results", "string", 5, 7, [["plot(df)", "cell", 7, 7, []]]],
  ]);
  assert.equal(
    notebookOutline([{ id: "2", kind: "code", source: "x" }], { codeCells: false }).length,
    0,
  );
});

// ---- Find across cells ----

const findCells = [
  { id: "m", kind: "markdown" as const, source: "# Data\nLoad the data" },
  {
    id: "c",
    kind: "code" as const,
    source: "data = load()\nprint(data)",
    outputs: ["data loaded\n"],
  },
  { id: "r", kind: "raw" as const, source: "metadata" },
];

test("find matches every cell in order, with positions", () => {
  const all = findInCells(findCells, { query: "data" });
  assert.deepEqual(
    all.map((m) => [m.cellId, m.where, m.line, m.column, m.endColumn]),
    [
      ["m", "source", 1, 3, 7],
      ["m", "source", 2, 10, 14],
      ["c", "source", 1, 1, 5],
      ["c", "source", 2, 7, 11],
      ["r", "source", 1, 5, 9],
    ],
  );
  assert.equal(findInCells(findCells, { query: "data", caseSensitive: true }).length, 4);
  assert.equal(findInCells(findCells, { query: "data", wholeWord: true }).length, 4);
  assert.equal(findInCells(findCells, { query: "data", markdown: false }).length, 3);
  const withOutputs = findInCells(findCells, { query: "loaded", outputs: true });
  assert.deepEqual(
    withOutputs.map((m) => [m.where, m.output]),
    [["output", 0]],
  );
  assert.equal(findInCells(findCells, { query: "d.ta", regex: true }).length, 5);
  assert.equal(typeof findPattern({ query: "(", regex: true }), "string");
  assert.equal(findInCells(findCells, { query: "", regex: true }).length, 0);
  assert.equal(findInCells(findCells, { query: "x*", regex: true }).length, 0);
});

test("replace one with groups, replace all, next and previous", () => {
  const text = "data = load()\nprint(data)";
  const opts = { query: "(d)ata", regex: true };
  assert.equal(replacementFor(text, { start: 0, end: 4 }, "$1ATA", opts), "dATA");
  assert.equal(replacementFor(text, { start: 0, end: 4 }, "$1ATA", { query: "data" }), "$1ATA");
  assert.deepEqual(replaceAllIn(text, { query: "data" }, "df"), {
    text: "df = load()\nprint(df)",
    count: 2,
  });
  assert.deepEqual(replaceAllIn("a\r\nb", { query: "z" }, "y"), { text: "a\r\nb", count: 0 });
  const all = findInCells(findCells, { query: "data" });
  assert.equal(nearestMatch(all, { cellIndex: 1, offset: 0 }), 2);
  assert.equal(nearestMatch(all, { cellIndex: 1, offset: 1 }), 3);
  assert.equal(nearestMatch(all, { cellIndex: 2, offset: 9 }), 0); // wraps around
  assert.equal(nearestMatch(all, { cellIndex: 1, offset: 0 }, -1), 1);
  assert.equal(nearestMatch(all, { cellIndex: 0, offset: 0 }, -1), 4);
  assert.equal(nearestMatch([], { cellIndex: 0, offset: 0 }), -1);
});

test("an edit across cells is clipped to each cell's part (m7.12)", () => {
  const nb = [
    { id: "a", text: "import os\nx=1" },
    { id: "b", text: "def f( ):\n  return x" },
    { id: "c", text: "y = f()" },
  ];
  const doc = new ConcatDocument(nb, "python");
  // A formatter's whole-document edit: only the changed lines go to their cells.
  const formatted = "import os\nx = 1\ndef f():\n    return x\ny = f()";
  const edits = doc.splitEdit(
    { start: { line: 0, character: 0 }, end: { line: 4, character: 7 } },
    formatted,
  );
  const apply = (id: string) => {
    const cell = nb.find((c) => c.id === id)?.text ?? "";
    const lines = cell.split("\n");
    const off = (p: { line: number; character: number }) =>
      lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
    let out = cell;
    for (const e of edits.filter((x) => x.cellId === id).reverse())
      out = out.slice(0, off(e.range.start)) + e.text + out.slice(off(e.range.end));
    return out;
  };
  assert.deepEqual(
    edits.map((e) => e.cellId),
    ["a", "b"],
  );
  assert.equal(apply("a"), "import os\nx = 1");
  assert.equal(apply("b"), "def f():\n    return x");
  assert.equal(apply("c"), "y = f()");
  // Inside one cell: as before.
  const inside = { start: { line: 1, character: 1 }, end: { line: 1, character: 2 } };
  assert.deepEqual(doc.splitEdit(inside, " = "), [{ cellId: "a", range: inside, text: " = " }]);
  // Nothing to follow: the first cell takes the new text, the later part is deleted.
  assert.deepEqual(
    doc.splitEdit({ start: { line: 1, character: 0 }, end: { line: 2, character: 9 } }, "zzz"),
    [
      {
        cellId: "a",
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
        text: "zzz",
      },
      {
        cellId: "b",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
        text: "",
      },
    ],
  );
  // Past the end: nothing.
  const past = { start: { line: 9, character: 0 }, end: { line: 9, character: 0 } };
  assert.deepEqual(doc.splitEdit(past, "x"), []);
});

test("dividing new text at cell boundaries follows unchanged lines", () => {
  assert.deepEqual(divideAtBoundaries(["a\nb", "c"], "a\nB\nc"), ["a\nB", "c"]);
  // A line added at the end of the first part stays with it.
  assert.deepEqual(divideAtBoundaries(["a", "c"], "a\nnew\nc"), ["a\nnew", "c"]);
  // No unchanged line around the boundary: not divided.
  assert.equal(divideAtBoundaries(["a", "b"], "x\ny"), null);
  assert.deepEqual(divideAtBoundaries(["only"], "x"), ["x"]);
});

test("semantic tokens as a delta from what an editor has", () => {
  assert.deepEqual(semanticTokensDiff([1, 2, 3], [1, 2, 3]), []);
  assert.deepEqual(semanticTokensDiff([1, 2, 3, 4], [1, 9, 4]), [
    { start: 1, deleteCount: 2, data: [9] },
  ]);
  assert.deepEqual(semanticTokensDiff([], [5]), [{ start: 0, deleteCount: 0, data: [5] }]);
});
