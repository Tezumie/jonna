// VS Code's cell commands with their arguments, as an extension runs them (Jupyter's
// `notebook.cell.execute` with `{ ranges, document }` after it adds cells).
import assert from "node:assert/strict";
import { test } from "node:test";
import { cellTargets } from "./commands";
import { Uri } from "./types";
import { NotebookRange } from "./workbenchTypes";

test("the cells VS Code's cell commands are given", () => {
  const document = Uri.file("/w/n.ipynb");
  assert.deepEqual(
    cellTargets({
      ranges: [
        { start: 2, end: 4 },
        { start: 7, end: 8 },
      ],
      document,
    }),
    { path: document.fsPath, indexes: [2, 3, 7] },
  );
  // A NotebookCell, or a menu's { cell }.
  const notebook = { uri: Uri.parse("untitled:Interactive-1.interactive") };
  assert.deepEqual(cellTargets({ index: 5, notebook }), {
    path: "untitled:Interactive-1.interactive",
    indexes: [5],
  });
  assert.deepEqual(cellTargets({ cell: { index: 0, notebook } })?.indexes, [0]);
  assert.equal(cellTargets(undefined), undefined);
  assert.equal(cellTargets({ ranges: [{ start: 0, end: 1 }] }), undefined);
});

test("audit: class instances (NotebookRange, the shim's notebook) are cells' targets too", () => {
  const document = Uri.file("/w/n.ipynb");
  assert.deepEqual(cellTargets({ ranges: [new NotebookRange(1, 3)], document })?.indexes, [1, 2]);
  class Notebook {
    uri = Uri.file("/w/m.ipynb");
  }
  assert.deepEqual(cellTargets({ index: 4, notebook: new Notebook() }), {
    path: Uri.file("/w/m.ipynb").fsPath,
    indexes: [4],
  });
});
