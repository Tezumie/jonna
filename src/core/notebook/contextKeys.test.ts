import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesWhen } from "../context/when";
import { uriOf } from "../extensions/vscode/convert";
import { Uri } from "../extensions/vscode/types";
import { ideWhen } from "../extensions/vscodePackage";
import {
  cellExecutionState,
  cellUriString,
  fileUriString,
  NOTEBOOK_CONTEXT_KEYS,
  type NotebookContextState,
  notebookContextKeys,
  vscodeCellType,
} from "./contextKeys";

const state = (over: Partial<NotebookContextState> = {}): NotebookContextState => ({
  path: "C:\\work\\a b.ipynb",
  notebookType: "jupyter.notebook",
  focus: { editor: true, list: true, cellEditor: false, output: false },
  cell: {
    id: "c1",
    kind: "code",
    language: "python",
    runState: "idle",
    hasOutputs: false,
    editing: false,
  },
  kernel: "ms-toolsai.jupyter/.jvsc74a57bd0abc",
  kernelCount: 2,
  running: false,
  interruptible: false,
  readOnly: false,
  selectedCount: 1,
  ...over,
});

const lookup = (keys: Record<string, unknown>) => (k: string) => keys[k];

test("VS Code's cell kinds and execution states", () => {
  assert.equal(vscodeCellType("markdown"), "markup");
  assert.equal(vscodeCellType("code"), "code");
  assert.equal(vscodeCellType("raw"), "code");
  assert.equal(cellExecutionState("queued"), "pending");
  assert.equal(cellExecutionState("running"), "executing");
  assert.equal(cellExecutionState("ok"), "succeeded");
  assert.equal(cellExecutionState("error"), "failed");
  assert.equal(cellExecutionState("idle"), "idle");
});

test("a cell's Uri string is the shim's cell.document.uri.toString()", () => {
  for (const path of [
    "C:\\Users\\me\\a b.ipynb",
    "/home/me/x.ipynb",
    "untitled:Untitled-1.ipynb",
    "C:\\Users\\ü\\n%1.ipynb",
  ])
    for (const id of ["c1d2", "a_b-9"])
      assert.equal(
        cellUriString(path, id),
        uriOf(`vscode-notebook-cell:${path}#${id}`).toString(),
        path,
      );
});

test("a notebook's resource is Uri.file(path).toString()", () => {
  for (const path of ["C:\\Users\\me\\a b.ipynb", "/home/me/x.ipynb", "\\\\server\\share\\n.ipynb"])
    assert.equal(fileUriString(path), Uri.file(path).toString(), path);
});

test("Jupyter Keymap's command-mode keys hold only outside a cell's editor", () => {
  // Their `when`, and inputFocus as the workbench sets it (true in an editor's text).
  const when = "notebookEditorFocused && !inputFocus && !notebookOutputInputFocused";
  const command = notebookContextKeys(state());
  assert.equal(matchesWhen(when, lookup({ ...command, inputFocus: false })), true);
  const editing = notebookContextKeys(
    state({ focus: { editor: true, list: true, cellEditor: true, output: false } }),
  );
  assert.equal(matchesWhen(when, lookup({ ...editing, inputFocus: true })), false);
  // Shift+Enter: in a code cell's editor, or the list on a code cell.
  const run =
    "editorTextFocus && inputFocus && notebookEditorFocused && !interactiveEditorFocused || notebookCellListFocused && notebookCellType == 'code' && !interactiveEditorFocused";
  assert.equal(matchesWhen(run, lookup({ ...editing, inputFocus: true })), true);
  const markdown = notebookContextKeys(
    state({
      cell: {
        id: "m",
        kind: "markdown",
        language: "markdown",
        runState: "idle",
        hasOutputs: false,
        editing: true,
      },
    }),
  );
  assert.equal(markdown.notebookCellType, "markup");
  assert.equal(matchesWhen(run, lookup(markdown)), false);
});

test("Jupyter's menus: notebookKernel, notebookType and cell resources", () => {
  const keys = notebookContextKeys(state());
  const runByLine =
    "notebookKernel =~ /^ms-toolsai.jupyter\\// && notebookType == 'jupyter-notebook' && notebookCellType == code";
  assert.equal(matchesWhen(ideWhen(runByLine), lookup(keys)), true);
  assert.equal(
    matchesWhen(ideWhen(runByLine), lookup({ ...keys, notebookKernel: "bundled.jupyter/jupyter" })),
    false,
  );
  // No kernel: `!notebookKernel` holds.
  const none = notebookContextKeys(state({ kernel: null }));
  assert.equal(matchesWhen("!notebookKernel", lookup(none)), true);
  assert.equal(none.notebookKernelSelected, false);
  // A cell in a list Jupyter keeps of cell Uris.
  const cell = keys.notebookCellResource;
  assert.equal(
    matchesWhen(
      "notebookCellResource in jupyter.cells",
      lookup({ ...keys, "jupyter.cells": [cell, "x"] }),
    ),
    true,
  );
  assert.equal(keys.resourceExtname, ".ipynb");
  assert.equal(keys.resourceFilename, "a b.ipynb");
});

test("without a notebook every key is cleared", () => {
  const cleared = notebookContextKeys(null);
  assert.deepEqual(Object.keys(cleared).sort(), [...NOTEBOOK_CONTEXT_KEYS].sort());
  assert.ok(Object.values(cleared).every((v) => v === undefined));
  // And the set keys are exactly the listed ones.
  assert.deepEqual(
    Object.keys(notebookContextKeys(state())).sort(),
    [...NOTEBOOK_CONTEXT_KEYS].sort(),
  );
});
