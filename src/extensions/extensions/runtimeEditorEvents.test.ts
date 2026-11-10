import assert from "node:assert/strict";
import { test } from "node:test";
import { editorChanges } from "./runtimeEditorEvents";

const snap = (path: string | null, line = 1, top = 1) => ({
  path,
  language: path ? "ts" : "",
  selections: path ? [{ startLine: line, startColumn: 1, endLine: line, endColumn: 1 }] : [],
  visibleRange: path ? { startLine: top, endLine: top + 30 } : null,
});

test("editor events: what changed between two looks at the active editor", () => {
  assert.deepEqual(Object.keys(editorChanges(null, snap("/a.ts"))).sort(), [
    "editor.didChangeActive",
    "editor.didChangeSelection",
    "editor.didChangeVisibleRange",
  ]);
  assert.deepEqual(editorChanges(snap("/a.ts"), snap("/a.ts")), {});
  assert.deepEqual(editorChanges(snap("/a.ts"), snap("/a.ts", 4)), {
    "editor.didChangeSelection": {
      path: "/a.ts",
      selections: [{ startLine: 4, startColumn: 1, endLine: 4, endColumn: 1 }],
    },
  });
  assert.deepEqual(editorChanges(snap("/a.ts"), snap("/a.ts", 1, 9)), {
    "editor.didChangeVisibleRange": { path: "/a.ts", startLine: 9, endLine: 39 },
  });
  assert.deepEqual(editorChanges(snap("/a.ts"), snap(null)), { "editor.didChangeActive": null });
});

test("editor events: the active notebook and its selected cells (D265)", () => {
  const nb = (path: string | null, selection: number[] = [0]) => ({
    ...snap(null),
    notebook: path ? { path, selection } : null,
  });
  assert.deepEqual(editorChanges(nb(null), nb(null)), {});
  assert.deepEqual(editorChanges(nb(null), nb("/a.ipynb")), {
    "notebook.didChangeEditor": { path: "/a.ipynb", selection: [0] },
  });
  assert.deepEqual(editorChanges(nb("/a.ipynb"), nb("/a.ipynb", [1, 2])), {
    "notebook.didChangeEditor": { path: "/a.ipynb", selection: [1, 2] },
  });
  assert.deepEqual(editorChanges(nb("/a.ipynb"), snap("/b.ts")), {
    "notebook.didChangeEditor": null,
    "editor.didChangeActive": { path: "/b.ts", language: "ts" },
    "editor.didChangeSelection": {
      path: "/b.ts",
      selections: [{ startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 }],
    },
    "editor.didChangeVisibleRange": { path: "/b.ts", startLine: 1, endLine: 31 },
  });
});
