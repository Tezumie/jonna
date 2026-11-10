import assert from "node:assert/strict";
import { test } from "node:test";
import { applySnippet, fencePath } from "./applyCode";

test("fencePath: the file a fence names", () => {
  assert.equal(fencePath("ts:src/a.ts"), "src/a.ts");
  assert.equal(fencePath("ts src/a.ts"), "src/a.ts");
  assert.equal(fencePath('python title="game/snake.py"'), "game/snake.py");
  assert.equal(fencePath("index.html"), "index.html");
  assert.equal(fencePath("src/main.rs"), "src/main.rs");
  assert.equal(fencePath("ts"), null);
  assert.equal(fencePath(""), null);
  assert.equal(fencePath("bash"), null);
  assert.equal(fencePath("ts https://x.com/a.ts"), null);
});

test("applySnippet: new files and most of a file replace it", () => {
  assert.deepEqual(applySnippet(null, "a\nb"), { text: "a\nb\n", how: "file" });
  assert.deepEqual(applySnippet("x\ny\n", "a\nb\n"), { text: "a\nb\n", how: "file" });
});

test("applySnippet: a function replaced between its first and last lines", () => {
  const file = [
    "import x from 'x';",
    "",
    "function add(a, b) {",
    "  return a - b;",
    "}",
    "",
    "function mul(a, b) {",
    "  return a * b;",
    "}",
    "",
    "export { add, mul };",
    "",
  ].join("\n");
  const r = applySnippet(file, "function add(a, b) {\n  // fixed\n  return a + b;\n}");
  assert.equal(r?.how, "range");
  assert.equal(r?.from, 3);
  assert.equal(r?.to, 5);
  assert.ok(r?.text.includes("return a + b;"));
  assert.ok(r?.text.includes("return a * b;"));
  assert.ok(!r?.text.includes("a - b"));
  // An anchor that appears twice, or not at all, isn't guessed.
  assert.equal(applySnippet(file, "}\nnothing\n}"), null);
  assert.equal(applySnippet(file, "function div(a, b) {\n  return a / b;\n}"), null);
});

test("applySnippet: CRLF files keep CRLF", () => {
  const file = "a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\n";
  const r = applySnippet(file, "b\nB2\nc");
  assert.equal(r?.text, "a\r\nb\r\nB2\r\nc\r\nd\r\ne\r\nf\r\ng\r\n");
});
