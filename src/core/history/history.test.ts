import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationHistory } from "./index";

test("undo and redo replay operations in order; push clears redo", async () => {
  const h = new OperationHistory();
  const log: string[] = [];
  const op = (name: string) => ({
    label: name,
    kind: "file" as const,
    paths: [],
    undo: async () => void log.push(`undo ${name}`),
    redo: async () => void log.push(`redo ${name}`),
  });
  h.push(op("a"));
  h.push(op("b"));
  assert.equal(h.undoLabel(), "b");
  await Promise.all([h.undo(), h.undo()]);
  assert.deepEqual(log, ["undo b", "undo a"]);
  assert.equal(await h.undo(), null);
  assert.equal(await h.redo(), "a");
  h.push(op("c"));
  assert.equal(h.canRedo(), false);
  assert.deepEqual(
    h.entries().done.map((e) => e.label),
    ["c", "a"],
  );
});

test("a failed undo stays on the stack (nothing changed) until discarded", async () => {
  const h = new OperationHistory();
  let fail = true;
  h.push({
    label: "x",
    kind: "file",
    paths: [],
    confirm: { undo: "Delete x?" },
    undo: async () => {
      if (fail) throw new Error("changed since");
    },
    redo: async () => {},
  });
  await assert.rejects(h.undo(), /changed since/);
  assert.equal(h.canUndo(), true);
  assert.equal(h.peek("undo")?.confirm, "Delete x?");
  fail = false;
  assert.equal(await h.undo(), "x");
  assert.equal(h.peek("redo")?.label, "x");
  assert.equal(h.peek("redo")?.confirm, undefined);
  h.discard("redo");
  assert.equal(h.canRedo(), false);
});

test("a push while a step runs keeps the order; undo(expected) refuses another entry", async () => {
  const h = new OperationHistory();
  let release: () => void = () => {};
  const op = (name: string, gate = false) => ({
    label: name,
    kind: "file" as const,
    paths: [],
    undo: () => (gate ? new Promise<void>((r) => (release = r)) : Promise.resolve()),
    redo: async () => {},
  });
  h.push(op("a"));
  const b = h.push(op("b", true));
  const running = h.undo(b);
  await Promise.resolve();
  await Promise.resolve();
  h.push(op("c"));
  release();
  assert.equal(await running, "b");
  // b was undone, but c came after: no redo of b on top of c.
  assert.equal(h.canRedo(), false);
  assert.deepEqual(
    h.entries().done.map((e) => e.label),
    ["c", "a"],
  );
  await assert.rejects(h.undo(12345), /meanwhile/);
  assert.equal(h.peek("undo")?.label, "c");
});

test("a step still running when the history is cleared doesn't land in the new stacks", async () => {
  const h = new OperationHistory();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.push({ label: "slow", kind: "file", paths: [], undo: () => gate, redo: async () => {} });
  const running = h.undo();
  await Promise.resolve();
  h.clear(); // the folder switched while the undo ran
  release();
  await running;
  assert.equal(h.canRedo(), false);
  assert.equal(h.canUndo(), false);
});
