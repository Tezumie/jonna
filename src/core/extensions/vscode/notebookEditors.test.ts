// D265: the shim's notebook documents: what changed between two reads, selections, edits.
import assert from "node:assert/strict";
import { test } from "node:test";
import { contentChange, editSteps, metadataPatch, rangesOf, ShimNotebook } from "./notebookEditors";
import {
  NotebookCellData,
  NotebookCellOutput,
  NotebookCellOutputItem,
  NotebookEdit,
  NotebookRange,
} from "./workbenchTypes";

test("content changes are one range: what was removed and what was added", () => {
  assert.deepEqual(contentChange(["a", "b"], ["a", "b"], [], []), []);
  const [added] = contentChange(["a", "c"], ["a", "b", "c"], ["A", "C"], ["A", "B", "C"]);
  assert.deepEqual(
    [added?.range.start, added?.range.end, added?.removedCells, added?.addedCells],
    [1, 1, [], ["B"]],
  );
  const [removed] = contentChange(["a", "b", "c"], ["c"], ["A", "B", "C"], ["C"]);
  assert.deepEqual(
    [removed?.range.start, removed?.range.end, removed?.removedCells],
    [0, 2, ["A", "B"]],
  );
});

test("selected cells become ranges of neighbours", () => {
  assert.deepEqual(
    rangesOf([4, 0, 1, 2]).map((r) => [r.start, r.end]),
    [
      [0, 3],
      [4, 5],
    ],
  );
  assert.deepEqual(rangesOf([]), []);
});

test("a metadata replacement removes keys that went, but keeps the IDE's language key", () => {
  assert.deepEqual(metadataPatch({ a: 1, b: 2, vscode: { languageId: "sql" } }, { a: 3 }), {
    a: 3,
    b: null,
  });
});

test("NotebookEdits as the IDE's cell commands", () => {
  const nb = { ids: ["x", "y", "z"], metadata: { m: 1 }, cellMetadata: () => ({ t: 1 }) };
  const replace = NotebookEdit.replaceCells(new NotebookRange(1, 3), [
    new NotebookCellData(1, "# New", "markdown"),
    new NotebookCellData(2, "raw text", "raw"),
  ]);
  assert.deepEqual(
    editSteps(replace, nb, "/n.ipynb").map((s) => [s.command, s.input]),
    [
      ["notebook.deleteCell", { path: "/n.ipynb", cellIds: ["y", "z"] }],
      ["notebook.insertCell", { path: "/n.ipynb", index: 1, kind: "markdown", source: "# New" }],
      ["notebook.insertCell", { path: "/n.ipynb", index: 2, kind: "raw", source: "raw text" }],
    ],
  );
  assert.deepEqual(editSteps(NotebookEdit.updateNotebookMetadata({ n: 2 }), nb, "/n.ipynb"), [
    { command: "notebook.setMetadata", input: { path: "/n.ipynb", metadata: { n: 2, m: null } } },
  ]);
  assert.throws(
    () => editSteps(NotebookEdit.updateCellMetadata(7, {}), nb, "/n.ipynb"),
    /No cell 7/,
  );
});

test("D267: a new cell's outputs, metadata and execution order go in with it", () => {
  const nb = { ids: [], metadata: {}, cellMetadata: () => ({}) };
  const cell = new NotebookCellData(2, "print(1)", "python");
  cell.outputs = [new NotebookCellOutput([NotebookCellOutputItem.stdout("1\n")])];
  cell.metadata = { tags: ["x"] };
  cell.executionSummary = { executionOrder: 4 };
  const steps = editSteps(NotebookEdit.insertCells(0, [cell]), nb, "/n.ipynb", (outputs) =>
    outputs.map(() => ({ output_type: "stream", name: "stdout", text: "1\n" })),
  );
  assert.deepEqual(steps[0]?.input, {
    path: "/n.ipynb",
    index: 0,
    kind: "code",
    source: "print(1)",
    metadata: { tags: ["x"] },
    outputs: [{ output_type: "stream", name: "stdout", text: "1\n" }],
    executionCount: 4,
  });
});

test("a cell keeps one TextDocument for its life: versions, change, close and open events", () => {
  const events: string[] = [];
  const nb = new ShimNotebook(
    "/w/n.ipynb",
    "jupyter.notebook",
    async () => true,
    () => [],
    {
      opened: (d) => events.push(`open ${d.uri.fragment} v${d.version}`),
      changed: (e) => events.push(`change ${e.document.uri.fragment} v${e.document.version}`),
      closed: (d) => events.push(`close ${d.uri.fragment}`),
    },
  );
  const read = (cells: { id: string; source: string; language?: string }[]) => ({
    path: "/w/n.ipynb",
    type: "jupyter.notebook",
    cells: cells.map((c, index) => ({
      index,
      id: c.id,
      kind: "code" as const,
      source: c.source,
      language: c.language ?? "python",
    })),
  });
  nb.update(
    read([
      { id: "a", source: "x = 1" },
      { id: "b", source: "y" },
    ]),
  );
  const doc = nb.cellAt(0)?.document;
  assert.deepEqual(events.splice(0), ["open a v1", "open b v1"]);
  // Typing: the same document, a new version and VS Code's change event.
  const changes = nb.update(
    read([
      { id: "a", source: "x = 12" },
      { id: "b", source: "y" },
    ]),
  );
  assert.equal(nb.cellAt(0)?.document, doc);
  assert.equal(doc?.version, 2);
  assert.equal(doc?.getText(), "x = 12");
  assert.deepEqual(events.splice(0), ["change a v2"]);
  assert.equal(changes.cellChanges[0]?.document, doc);
  // The editor's text first (a provider asked about it): the read after it changes nothing.
  nb.syncCellText("a", "x = 123");
  assert.deepEqual(events.splice(0), ["change a v3"]);
  nb.update(
    read([
      { id: "a", source: "x = 123" },
      { id: "b", source: "y" },
    ]),
  );
  assert.deepEqual(events.splice(0), []);
  // A new language: closed and opened again, still the same object.
  nb.update(
    read([
      { id: "a", source: "x = 123", language: "julia" },
      { id: "b", source: "y" },
    ]),
  );
  assert.equal(nb.cellAt(0)?.document, doc);
  assert.equal(doc?.languageId, "julia");
  assert.deepEqual(events.splice(0), ["close a", "open a v3"]);
  // A deleted cell's document closes; the notebook's closing closes the rest.
  nb.update(read([{ id: "a", source: "x = 123", language: "julia" }]));
  assert.deepEqual(events.splice(0), ["close b"]);
  nb.closeCells();
  assert.deepEqual(events.splice(0), ["close a"]);
  assert.equal(doc?.isClosed, true);
});
