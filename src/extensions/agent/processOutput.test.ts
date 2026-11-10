import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanOutput, OutputBuffer, outputFilter } from "./processOutput";

const ESC = String.fromCharCode(27);

test("cleaning: escapes, CRLF, progress redraws", () => {
  assert.equal(cleanOutput(`${ESC}[32mready${ESC}[0m\r\n`), "ready\n");
  assert.equal(cleanOutput("10%\r50%\r100%\ndone\n"), "100%\ndone\n");
  assert.equal(cleanOutput(`${ESC}]0;title\u0007x`), "x");
});

test("each read gets what arrived since the last one", () => {
  const b = new OutputBuffer();
  b.append("one\ntw");
  assert.equal(b.unread, 6);
  assert.deepEqual(b.read(), { text: "one\ntw", dropped: 0, more: false });
  assert.deepEqual(b.read(), { text: "", dropped: 0, more: false });
  b.append("o\nthree\n");
  assert.equal(b.read().text, "o\nthree\n");
  assert.equal(b.unread, 0);
  assert.equal(b.tail(9), "wo\nthree\n");
  // Nothing unread: wait_for's tail(unread) is empty, not the whole output (D293).
  assert.equal(b.tail(0), "");
});

test("escape sequences split across chunks", () => {
  const b = new OutputBuffer();
  b.append(`a${ESC}[3`);
  b.append("1mred\n");
  assert.equal(b.read().text, "ared\n");
});

test("a filter keeps matching lines; a partial last line waits", () => {
  const b = new OutputBuffer();
  b.append("GET / 200\nGET /x 404\nerror: boom\nGET /y 50");
  const r = b.read(outputFilter("error|404"));
  assert.equal(r.text, "GET /x 404\nerror: boom\n");
  assert.deepEqual(r.lines, { seen: 3, matched: 2 });
  b.append("0\n");
  assert.equal(b.read(outputFilter("500")).text, "GET /y 500\n");
  // Not a regular expression: plain text.
  assert.equal(outputFilter("a(b")?.test("xa(by"), true);
  assert.equal(outputFilter(""), null);
});

test("a full buffer drops the oldest output and says how much", () => {
  const b = new OutputBuffer(100);
  for (let i = 0; i < 30; i++) b.append(`line ${String(i).padStart(2, "0")}\n`);
  const r = b.read();
  assert.ok(r.dropped > 0);
  assert.equal(r.dropped + r.text.length, 30 * 8);
  assert.ok(r.text.endsWith("line 29\n"));
});

test("a long read stops at a line and leaves the rest", () => {
  const b = new OutputBuffer();
  b.append(`${"x".repeat(30)}\n`.repeat(10));
  const first = b.read(null, 100);
  assert.equal(first.more, true);
  assert.equal(first.text, `${"x".repeat(30)}\n`.repeat(3));
  const rest = b.read(null, 1000);
  assert.equal(rest.text.length, 31 * 7);
  assert.equal(rest.more, false);
});

test("filters that could backtrack badly match as plain text", () => {
  for (const p of ["(\\w+\\s?)+:", "(a+)+$", "(a|aa)*b", "(x)\\1", "a".repeat(201)]) {
    const f = outputFilter(p);
    assert.ok(f);
    assert.equal(f.test(p.slice(0, 200)), true, p);
    const started = Date.now();
    f.test(`${"a".repeat(5000)}!`);
    assert.ok(Date.now() - started < 50, p);
  }
  assert.equal(outputFilter("error|404")?.test("GET 404"), true);
  assert.equal(outputFilter("GET /\\w+ 500")?.test("GET /y 500"), true);
});
