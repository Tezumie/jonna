// D256: the `vscode` shim's text documents and the open-document set.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Documents, pathKey, ShimTextDocument } from "./document";
import { Position, Range } from "./types";

test("lines, offsets and positions, with CRLF", () => {
  const doc = new ShimTextDocument("/w/a.ts", "typescript", "ab\r\ncd\n\nef");
  assert.equal(doc.lineCount, 4);
  assert.equal(doc.lineAt(0).text, "ab");
  assert.ok(doc.lineAt(0).rangeIncludingLineBreak.isEqual(new Range(0, 0, 1, 0)));
  assert.equal(doc.lineAt(2).isEmptyOrWhitespace, true);
  assert.equal(doc.offsetAt(new Position(1, 1)), 5);
  assert.ok(doc.positionAt(5).isEqual(new Position(1, 1)));
  assert.ok(doc.positionAt(999).isEqual(new Position(3, 2)));
  assert.equal(doc.getText(new Range(0, 1, 1, 1)), "b\r\nc");
  assert.ok(doc.validatePosition(new Position(0, 99)).isEqual(new Position(0, 2)));
  assert.ok(doc.validatePosition(new Position(99, 0)).isEqual(new Position(3, 2)));
  assert.equal(doc.eol, 2);
  assert.equal(doc.fileName, "/w/a.ts");
});

test("words at a position", () => {
  const doc = new ShimTextDocument("/w/a.ts", "typescript", "const fooBar = 1.5;");
  assert.equal(doc.getText(doc.getWordRangeAtPosition(new Position(0, 8))), "fooBar");
  assert.equal(doc.getText(doc.getWordRangeAtPosition(new Position(0, 16))), "1.5");
  assert.equal(doc.getWordRangeAtPosition(new Position(0, 13)), undefined);
  assert.equal(doc.getText(doc.getWordRangeAtPosition(new Position(0, 3), /[a-z]+/)), "const");
});

test("a new text is one replaced range of the old", () => {
  const doc = new ShimTextDocument("/w/a.ts", "typescript", "hello world\nbye");
  const change = doc.setText("hello there world\nbye");
  assert.ok(change);
  assert.ok(change.range.isEqual(new Range(0, 6, 0, 6)));
  assert.equal(change.text, "there ");
  assert.equal(change.rangeOffset, 6);
  assert.equal(change.rangeLength, 0);
  assert.equal(doc.setText("hello there world\nbye"), null);
  const removal = doc.setText("hello\nbye");
  assert.ok(removal?.range.isEqual(new Range(0, 5, 0, 17)));
  assert.equal(removal?.text, "");
});

test("the open documents follow the IDE: open, change, language change, close", async () => {
  const texts = new Map([[pathKey("C:\\w\\a.ts"), "one"]]);
  const docs = new Documents({
    text: async (p) => texts.get(pathKey(p)) ?? "",
    save: async () => true,
  });
  const events: string[] = [];
  docs.onDidOpen.event((d) => events.push(`open ${d.languageId}`));
  docs.onDidChange.event((e) =>
    events.push(`change ${e.document.version} ${e.contentChanges[0]?.text}`),
  );
  docs.onDidClose.event((d) => events.push(`close ${d.languageId}`));
  await docs.sync("C:\\w\\a.ts", "typescript");
  texts.set(pathKey("C:\\w\\a.ts"), "one two");
  await Promise.all([docs.sync("C:\\w\\a.ts"), docs.sync("c:/w/a.ts")]);
  await docs.sync("C:\\w\\a.ts", "javascript");
  docs.close("C:\\w\\a.ts");
  assert.deepEqual(events, [
    "open typescript",
    "change 2  two",
    "close typescript",
    "open javascript",
    "close javascript",
  ]);
  assert.equal(docs.all().length, 0);
  assert.equal(pathKey("C:\\W\\A.ts"), "c:/w/a.ts");
});

test("D261: editor changes make a document dirty, saving and disk changes don't", async () => {
  let text = "a";
  const docs = new Documents({ text: async () => text, save: async () => true });
  const doc = await docs.sync("/w/a.ts", "typescript");
  assert.equal(doc?.isDirty, false);
  text = "ab";
  await docs.sync("/w/a.ts", undefined, { dirty: true });
  assert.equal(doc?.isDirty, true);
  await docs.saved("/w/a.ts");
  assert.equal(doc?.isDirty, false);
  text = "abc";
  await docs.sync("/w/a.ts", undefined, { dirty: false });
  assert.equal(doc?.isDirty, false);
});

test("D261: a document closed while a sync waits isn't opened again", async () => {
  let release: (t: string) => void = () => {};
  let calls = 0;
  const docs = new Documents({
    text: () => (calls++ === 0 ? Promise.resolve("a") : new Promise((r) => (release = r))),
    save: async () => true,
  });
  const opened: string[] = [];
  docs.onDidOpen.event((d) => opened.push(d.uri.path));
  await docs.sync("/w/a.ts", "typescript");
  const pending = docs.sync("/w/a.ts");
  await Promise.resolve();
  docs.close("/w/a.ts");
  release("ab");
  assert.equal(await pending, undefined);
  assert.equal(docs.get("/w/a.ts"), undefined);
  assert.equal(opened.length, 1);
});

test("audit: a change never splits a surrogate pair", () => {
  const doc = new ShimTextDocument("/w/a.md", "markdown", "x \u{1F600} y");
  // Another emoji shares the first half: the change is the whole character.
  const change = doc.setText("x \u{1F601} y");
  assert.ok(change);
  assert.equal(change.text, "\u{1F601}");
  assert.equal(change.rangeOffset, 2);
  assert.equal(change.rangeLength, 2);
  // And one that shares the second half (U+1F400 and U+1F800 end alike).
  const doc2 = new ShimTextDocument("/w/b.md", "markdown", "\u{1F400}!");
  const change2 = doc2.setText("\u{1F800}!");
  assert.equal(change2?.text, "\u{1F800}");
  assert.equal(change2?.rangeLength, 2);
});
