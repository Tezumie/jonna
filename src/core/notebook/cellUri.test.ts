import assert from "node:assert/strict";
import { test } from "node:test";
import { pathOf, uriOf } from "../extensions/vscode/convert";
import { parseCellPath } from "./cellUri";

test("a cell document's path, as the worker sends it, back to its notebook and cell", () => {
  for (const notebook of [
    "C:\\Users\\me\\a b.ipynb",
    "/home/me/x.ipynb",
    "untitled:Untitled-1.ipynb",
  ]) {
    const uri = uriOf(`vscode-notebook-cell:${notebook}#c1d2`);
    // pathOf (what setDiagnostics gets), and the encoded form a language client sends back.
    assert.deepEqual(parseCellPath(pathOf(uri)), { notebook, cellId: "c1d2" }, notebook);
    assert.deepEqual(parseCellPath(uri.toString()), { notebook, cellId: "c1d2" }, notebook);
  }
  assert.deepEqual(parseCellPath("vscode-notebook-cell:/c:/Users/me/n.ipynb#W1"), {
    notebook: "c:\\Users\\me\\n.ipynb",
    cellId: "W1",
  });
  assert.equal(parseCellPath("C:\\Users\\me\\n.ipynb"), null);
  assert.equal(parseCellPath("vscode-notebook-cell:/n.ipynb"), null);
  assert.equal(parseCellPath("vscode-notebook-cell:/n.ipynb#bad id!"), null);
});
