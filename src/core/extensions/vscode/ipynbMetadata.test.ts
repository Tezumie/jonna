// Jupyter metadata in VS Code's ipynb layout (dropCustomMetadata), both ways, and the shim's
// NotebookData conversions built on it.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fromVscodeCellMetadata,
  fromVscodeNotebookMetadata,
  toVscodeCellMetadata,
  toVscodeNotebookMetadata,
} from "./ipynbMetadata";
import { editSteps } from "./notebookEditors";
import { fromIdeNotebook, toIdeNotebook } from "./notebooks";
import { NotebookCellData, NotebookData, NotebookEdit } from "./workbenchTypes";

test("a cell's metadata as VS Code's deserializer gives it", () => {
  const md = { tags: ["a"], collapsed: true };
  assert.deepEqual(
    toVscodeCellMetadata({ kind: "code", metadata: md, id: "c1", executionCount: 2 }),
    { execution_count: 2, metadata: md, id: "c1" },
  );
  // Not run: null. Markdown and raw cells have no count; attachments are kept.
  assert.deepEqual(toVscodeCellMetadata({ kind: "code", id: "c2", executionCount: null }), {
    execution_count: null,
    metadata: {},
    id: "c2",
  });
  assert.deepEqual(
    toVscodeCellMetadata({ kind: "markdown", id: "m", attachments: { "a.png": { x: 1 } } }),
    { metadata: {}, id: "m", attachments: { "a.png": { x: 1 } } },
  );
  assert.deepEqual(toVscodeCellMetadata({ kind: "raw", metadata: { format: "x" } }), {
    metadata: { format: "x" },
  });
  // A copy: an extension changing it doesn't change the IDE's.
  const out = toVscodeCellMetadata({ kind: "code", metadata: md });
  (out.metadata as { tags: string[] }).tags.push("b");
  assert.deepEqual(md.tags, ["a"]);
});

test("a cell's file metadata from what an extension wrote", () => {
  assert.deepEqual(
    fromVscodeCellMetadata({ execution_count: 1, metadata: { tags: [] }, id: "x" }),
    { metadata: { tags: [] }, id: "x" },
  );
  // VS Code's older layout (custom), and metadata with no layout taken as the file's.
  assert.deepEqual(fromVscodeCellMetadata({ custom: { metadata: { a: 1 } } }), {
    metadata: { a: 1 },
  });
  assert.deepEqual(fromVscodeCellMetadata({ owner: "me" }), { metadata: { owner: "me" } });
  assert.deepEqual(fromVscodeCellMetadata({ execution_count: 3 }), { metadata: {} });
  assert.deepEqual(fromVscodeCellMetadata(null), { metadata: {} });
});

test("the notebook's metadata is the file without its cells, and back", () => {
  const file = { kernelspec: { name: "python3" }, language_info: { name: "python" } };
  const md = toVscodeNotebookMetadata(file, { nbformat: 4, nbformatMinor: 4 });
  assert.deepEqual(md, {
    cells: [],
    metadata: file,
    nbformat: 4,
    nbformat_minor: 4,
    indentAmount: " ",
  });
  assert.deepEqual(fromVscodeNotebookMetadata(md), file);
  assert.deepEqual(fromVscodeNotebookMetadata({ custom: { metadata: { a: 1 } } }), { a: 1 });
  assert.deepEqual(fromVscodeNotebookMetadata({ kernelspec: { name: "x" } }), {
    kernelspec: { name: "x" },
  });
  assert.deepEqual(fromVscodeNotebookMetadata({ nbformat: 4 }), {});
});

test("Jupyter's edits in VS Code's layout reach the file's metadata", () => {
  const nb = {
    ids: ["a"],
    metadata: toVscodeNotebookMetadata({ kernelspec: { name: "old" }, extra: 1 }),
    cellMetadata: () => toVscodeCellMetadata({ kind: "code", metadata: { tags: ["t"] }, id: "a" }),
    ipynb: true,
  };
  // Jupyter sets the kernelspec as VS Code's ipynb would see it.
  const newMeta = { ...nb.metadata, metadata: { kernelspec: { name: "new" } } };
  assert.deepEqual(editSteps(NotebookEdit.updateNotebookMetadata(newMeta), nb, "/n.ipynb"), [
    {
      command: "notebook.setMetadata",
      input: { path: "/n.ipynb", metadata: { kernelspec: { name: "new" }, extra: null } },
    },
  ]);
  const cellMeta = { execution_count: 1, metadata: { tags: ["t", "u"], slideshow: {} }, id: "a" };
  assert.deepEqual(editSteps(NotebookEdit.updateCellMetadata(0, cellMeta), nb, "/n.ipynb"), [
    {
      command: "notebook.setMetadata",
      input: { path: "/n.ipynb", cellId: "a", metadata: { tags: ["t", "u"], slideshow: {} } },
    },
  ]);
  // A new cell's metadata, unwrapped.
  const cell = new NotebookCellData(2, "x", "python");
  cell.metadata = { execution_count: null, metadata: { tags: ["n"] } };
  const steps = editSteps(NotebookEdit.insertCells(1, [cell]), nb, "/n.ipynb");
  assert.deepEqual(steps[0]?.input.metadata, { tags: ["n"] });
});

test("a Jupyter NotebookData round-trips through the IDE's cells without loss", () => {
  const data = new NotebookData([
    Object.assign(new NotebookCellData(2, "print(1)", "python"), {
      metadata: { execution_count: 4, metadata: { tags: ["x"] }, id: "c1" },
      executionSummary: { executionOrder: 4 },
    }),
    Object.assign(new NotebookCellData(2, "SELECT 1", "sql"), {
      metadata: { execution_count: null, metadata: {}, id: "c2" },
    }),
    Object.assign(new NotebookCellData(1, "# Hi", "markdown"), {
      metadata: { metadata: {}, id: "c3", attachments: { "a.png": { "image/png": "AA" } } },
    }),
  ]);
  data.metadata = toVscodeNotebookMetadata({ language_info: { name: "python" } });
  const ide = toIdeNotebook(data, "jupyter-notebook");
  assert.deepEqual(ide.metadata, { language_info: { name: "python" } });
  assert.deepEqual(
    ide.cells.map((c) => [c.id, c.metadata, c.executionCount, c.extra]),
    [
      ["c1", { tags: ["x"] }, 4, undefined],
      // Not the notebook's language: in the file's metadata, as VS Code writes it.
      ["c2", { vscode: { languageId: "sql" } }, null, undefined],
      ["c3", {}, null, { attachments: { "a.png": { "image/png": "AA" } } }],
    ],
  );
  const back = fromIdeNotebook(ide, "jupyter-notebook");
  assert.deepEqual(
    back.cells.map((c) => [c.languageId, c.metadata]),
    [
      ["python", { execution_count: 4, metadata: { tags: ["x"] }, id: "c1" }],
      ["sql", { execution_count: null, metadata: { vscode: { languageId: "sql" } }, id: "c2" }],
      ["markdown", { metadata: {}, id: "c3", attachments: { "a.png": { "image/png": "AA" } } }],
    ],
  );
  assert.deepEqual(back.metadata?.metadata, { language_info: { name: "python" } });
});

test("another type's metadata comes back as its serializer wrote it", () => {
  const data = new NotebookData([
    Object.assign(new NotebookCellData(2, "q", "sql"), { metadata: { owner: "me" } }),
    Object.assign(new NotebookCellData(2, "r", "kusto"), {
      metadata: { vscode: { languageId: "kusto", x: 1 } },
    }),
  ]);
  const ide = toIdeNotebook(data, "acme.book");
  // The IDE keeps each cell's language in its metadata…
  assert.deepEqual(ide.cells[0]?.metadata, { owner: "me", vscode: { languageId: "sql" } });
  const back = fromIdeNotebook(ide, "acme.book");
  // …and gives back only what the extension wrote.
  assert.deepEqual(back.cells[0]?.metadata, { owner: "me" });
  assert.deepEqual(back.cells[0]?.languageId, "sql");
  assert.deepEqual(back.cells[1]?.metadata, { vscode: { languageId: "kusto", x: 1 } });
});
