// The shim's text editors over a fake IDE: what the active editor says about its selection and
// indentation after a tab switch, whose events arrive while the document is still being read.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkerApi } from "../rpc";
import type { ActiveEditorEvent, SelectionEvent, VisibleRangeEvent } from "../rpcExtras";
import { Documents } from "./document";
import { createEditors } from "./editors";

const tick = () => new Promise((r) => setTimeout(r, 0));

function harness() {
  const listeners = {
    active: [] as ((e: ActiveEditorEvent | null) => void)[],
    selection: [] as ((e: SelectionEvent) => void)[],
    visible: [] as ((e: VisibleRangeEvent) => void)[],
    settings: [] as ((keys: string[]) => void)[],
  };
  const on =
    <T>(list: ((e: T) => void)[]) =>
    (listener: (e: T) => void) => {
      list.push(listener);
      return { dispose() {} };
    };
  /** What ide://editors/active answers. */
  const state = {
    absolutePath: "/ws/a.ts" as string | null,
    indentation: { tabSize: 2, insertSpaces: true },
  };
  const ide = {
    editor: {
      active: async () => null,
      onDidChangeActive: on(listeners.active),
      onDidChangeSelection: on(listeners.selection),
      onDidChangeVisibleRange: on(listeners.visible),
    },
    state: { get: async () => ({ ...state }) },
    settings: { onChange: on(listeners.settings) },
  } as unknown as WorkerApi;
  const docs = new Documents({
    // Slower than the events of the same batch, as the real read is.
    text: async (path) => {
      await tick();
      return `text of ${path}\n`.repeat(60);
    },
    save: async () => true,
  });
  const editors = createEditors(ide, docs);
  const emit = <T>(list: ((e: T) => void)[], e: T) => {
    for (const l of list) l(e);
  };
  return { editors, listeners, state, emit };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

test("a tab switch keeps the selection and visible lines that came with it", async () => {
  const h = harness();
  await h.editors.ready;
  // One batch, as the IDE sends it: the editor, then where its cursor and lines are.
  h.emit(h.listeners.active, { path: "/ws/a.ts", language: "typescript" });
  h.emit(h.listeners.selection, {
    path: "/ws/a.ts",
    selections: [{ startLine: 50, startColumn: 3, endLine: 50, endColumn: 3 }],
  });
  h.emit(h.listeners.visible, { path: "/ws/a.ts", startLine: 40, endLine: 70 });
  // Read through a function: the checks below are of what it is then, not of what it was.
  const active = () => h.editors.activeTextEditor;
  assert.equal(active(), undefined);
  await settle();
  const editor = active();
  assert.ok(editor);
  assert.equal(editor.selection.active.line, 49);
  assert.equal(editor.selection.active.character, 2);
  assert.equal(editor.visibleRanges[0]?.start.line, 39);

  // Another file's selection isn't this editor's.
  h.state.absolutePath = "/ws/b.ts";
  h.emit(h.listeners.active, { path: "/ws/b.ts", language: "typescript" });
  await settle();
  assert.equal(active()?.document.fileName, "/ws/b.ts");
  assert.equal(active()?.selection.active.line, 0);
});

test("TextEditor.options is the file's indentation, and says when it changes", async () => {
  const h = harness();
  await h.editors.ready;
  h.state.indentation = { tabSize: 2, insertSpaces: false };
  h.emit(h.listeners.active, { path: "/ws/a.ts", language: "typescript" });
  await settle();
  const editor = h.editors.activeTextEditor;
  assert.ok(editor);
  assert.deepEqual(editor.options, { tabSize: 2, indentSize: 2, insertSpaces: false });

  const seen: unknown[] = [];
  h.editors.onDidChangeTextEditorOptions((e) => seen.push(e.options));
  // A setting that changes nothing for this file fires nothing.
  h.emit(h.listeners.settings, ["editor.fontSize"]);
  await settle();
  assert.equal(seen.length, 0);
  h.state.indentation = { tabSize: 8, insertSpaces: false };
  h.emit(h.listeners.settings, ["editor.tabSize"]);
  await settle();
  assert.deepEqual(seen, [{ tabSize: 8, indentSize: 8, insertSpaces: false }]);
  assert.equal(editor.options.tabSize, 8);

  // The IDE's active editor is another file: this one keeps what it had.
  h.state.absolutePath = "/ws/other.ts";
  h.state.indentation = { tabSize: 3, insertSpaces: true };
  h.emit(h.listeners.settings, ["editor.tabSize"]);
  await settle();
  assert.equal(editor.options.tabSize, 8);
});
