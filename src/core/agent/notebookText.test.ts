import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CELL_OUTPUT_CHARS,
  notebookCells,
  notebookRead,
  pageRange,
  pagesLabel,
} from "./notebookText";

const ESC = String.fromCharCode(27);
const nb = JSON.stringify({
  nbformat: 4,
  cells: [
    { id: "intro", cell_type: "markdown", source: ["# Title\n", "Some text"] },
    {
      id: "c2",
      cell_type: "code",
      execution_count: 3,
      source: "print('hi')\n1 + 1",
      outputs: [
        { output_type: "stream", name: "stdout", text: ["hi\n"] },
        { output_type: "execute_result", data: { "text/plain": ["2"] } },
        { output_type: "display_data", data: { "image/png": "iVBOR", "text/plain": "<Figure>" } },
      ],
    },
    {
      cell_type: "code",
      source: "boom()",
      outputs: [
        {
          output_type: "error",
          ename: "NameError",
          evalue: "boom",
          traceback: [`${ESC}[31mNameError${ESC}[0m: name 'boom' is not defined`],
        },
      ],
    },
    {
      cell_type: "code",
      source: "x",
      outputs: [{ output_type: "stream", text: "y".repeat(5000) }],
    },
  ],
});

test("D310: a notebook reads as cells with their text outputs", () => {
  const cells = notebookCells(nb);
  assert.ok(Array.isArray(cells));
  assert.equal(cells.length, 4);
  const r = notebookRead("a.ipynb", cells, 1, 100);
  assert.ok("text" in r);
  assert.match(
    r.text,
    /^a\.ipynb \(Jupyter notebook, 4 cells\)\n<cell id="intro" type="markdown">\n# Title\nSome text\n<\/cell>/,
  );
  assert.match(
    r.text,
    /<cell id="c2" type="code" execution="3">\nprint\('hi'\)\n1 \+ 1\n<output>\nhi\n2\n\[image\/png output: an image, not shown here\]\n<Figure>\n<\/output>\n<\/cell>/,
  );
  // An older notebook's cell without an id; an error's traceback without colors.
  assert.match(
    r.text,
    /<cell id="cell-3" type="code">\nboom\(\)\n<output>\nNameError: name 'boom' is not defined/,
  );
  // Outputs are capped per cell.
  assert.match(r.text, /more characters of output/);
  assert.ok(!r.text.includes("y".repeat(CELL_OUTPUT_CHARS + 1)));
});

test("D310: cells page with offset and limit", () => {
  const cells = notebookCells(nb);
  assert.ok(Array.isArray(cells));
  const r = notebookRead("a.ipynb", cells, 2, 1);
  assert.ok("text" in r);
  assert.match(r.text, /cells 2-2\)/);
  assert.match(r.text, /… 2 more cells \(offset 3;/);
  assert.ok(!r.text.includes("intro"));
  assert.ok("error" in notebookRead("a.ipynb", cells, 9, 1));
});

test("D310: not a notebook", () => {
  assert.ok("error" in (notebookCells("{") as object));
  assert.match((notebookCells("{}") as { error: string }).error, /no cells/);
});

test("D310: page ranges", () => {
  assert.deepEqual(pageRange("1-5", 30), [1, 2, 3, 4, 5]);
  assert.deepEqual(pageRange("3", 30), [3]);
  assert.deepEqual(pageRange(3, 30), [3]);
  assert.deepEqual(pageRange("2, 4-5", 30), [2, 4, 5]);
  assert.deepEqual(pageRange("8-", 10), [8, 9, 10]);
  assert.deepEqual(pageRange("9-12", 10), [9, 10]);
  assert.match((pageRange("1-21", 30) as { error: string }).error, /at most 20/);
  assert.match((pageRange("40", 30) as { error: string }).error, /has 30 pages/);
  assert.match((pageRange("5-2", 30) as { error: string }).error, /isn't a page range/);
  assert.match((pageRange("a", 30) as { error: string }).error, /isn't a page range/);
  assert.equal(pagesLabel([1, 2, 3, 7, 9, 10]), "1-3, 7, 9-10");
});
