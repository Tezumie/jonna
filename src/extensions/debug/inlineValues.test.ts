import assert from "node:assert/strict";
import { test } from "node:test";
import {
  debuggedLanguage,
  formatInlineValue,
  inlineValueLines,
  inlineValuesOn,
  MAX_INLINE_DECORATOR_LENGTH,
  MAX_NUM_INLINE_VALUES,
  mostSpecificScopes,
  syntaxFor,
  wordsByLine,
} from "./inlineValues";
import { stepTargetAt } from "./stepTargets";

test("inline values: the setting and the languages 'auto' covers", () => {
  assert.equal(inlineValuesOn("on", "/w/notes.txt"), true);
  assert.equal(inlineValuesOn(true, "/w/notes.txt"), true);
  assert.equal(inlineValuesOn("off", "/w/a.js"), false);
  assert.equal(inlineValuesOn(false, "/w/a.js"), false);
  assert.equal(inlineValuesOn("auto", "/w/notes.txt"), false);
  for (const p of ["/w/a.ts", "/w/a.py", "/w/m.go", "/w/m.rs", "/w/m.cpp", "/w/P.cs", "/w/x.h"])
    assert.equal(inlineValuesOn("auto", p), true, p);
  assert.equal(debuggedLanguage("C:\\w\\App.TSX"), "javascript");
});

test("inline values: words of the code only, not comments or strings", () => {
  const js = [
    "const total = add(a, b); // total of a",
    "const s = 'a b' + `x {y}",
    "still template` + c;",
    "/* skipped",
    "   q */ r = 1.5e3 + obj.prop;",
  ];
  const words = wordsByLine(js, 1, 5, syntaxFor("/w/a.js"));
  assert.deepEqual(words.get("total"), [1]);
  assert.deepEqual(words.get("a"), [1]);
  assert.deepEqual(words.get("s"), [2]);
  assert.equal(words.has("x"), false);
  assert.equal(words.has("still"), false);
  assert.deepEqual(words.get("c"), [3]);
  assert.equal(words.has("skipped"), false);
  assert.equal(words.has("q"), false);
  assert.deepEqual(words.get("r"), [5]);
  assert.equal(words.has("e3"), false);
  // Like VS Code (every word of the code), a property name counts.
  assert.deepEqual(words.get("prop"), [5]);
  // `from` leaves earlier lines out, but a comment opened above still counts.
  assert.equal(wordsByLine(js, 5, 5, syntaxFor("/w/a.js")).has("q"), false);

  const py = ["x = 1  # y", 's = """doc', 'z """', "t = 'w' + v"];
  const pw = wordsByLine(py, 1, 4, syntaxFor("/w/a.py"));
  assert.deepEqual(pw.get("x"), [1]);
  assert.equal(pw.has("y"), false);
  assert.equal(pw.has("doc"), false);
  assert.equal(pw.has("z"), false);
  assert.deepEqual(pw.get("v"), [4]);
  assert.equal(pw.has("w"), false);

  // Rust: lifetimes aren't characters; char literals are skipped.
  const rs = ["fn f<'a>(x: &'a str) -> char { let c = 'q'; x }"];
  const rw = wordsByLine(rs, 1, 1, syntaxFor("/w/m.rs"));
  assert.deepEqual(rw.get("x"), [1]);
  assert.deepEqual(rw.get("c"), [1]);
  assert.equal(rw.has("q"), false);
  // Long lines are left out, as in VS Code.
  const long = [`v = ${"1 + ".repeat(200)}1`];
  assert.equal(wordsByLine(long, 1, 1, syntaxFor("/w/a.js")).has("v"), false);
});

test("inline values: per line, narrowest scope first, ordered as in the line, up to the stop", () => {
  const lines = [
    "let total = 0;", // 1
    "function add(a, b) {", // 2
    "  const sum = a + b; // b", // 3
    "  return sum;", // 4 (stopped)
    "}", // 5
    "total = add(total, 1);", // 6
  ];
  const out = inlineValueLines({
    lines,
    syntax: syntaxFor("/w/a.js"),
    stopLine: 4,
    scopes: [
      {
        startLine: 2,
        variables: [
          { name: "b", value: "2" },
          { name: "a", value: "1" },
          { name: "sum", value: "3" },
        ],
      },
      {
        startLine: 1,
        variables: [
          { name: "total", value: "0" },
          { name: "a", value: "outer" },
        ],
      },
    ],
  });
  assert.deepEqual(out, [
    { line: 1, text: "total = 0" },
    { line: 2, text: "a = 1, b = 2" },
    { line: 3, text: "sum = 3, a = 1, b = 2" },
    { line: 4, text: "sum = 3" },
  ]);
  // A long value is cut; breaks become spaces.
  const big = inlineValueLines({
    lines: ["print(data)"],
    syntax: syntaxFor("/w/a.py"),
    stopLine: 1,
    scopes: [{ startLine: 1, variables: [{ name: "data", value: `{\n${"x".repeat(300)}` }] }],
  });
  assert.equal(big[0]?.text.length, MAX_INLINE_DECORATOR_LENGTH + 3);
  assert.ok(big[0]?.text.startsWith("data = { x"));
  assert.equal(formatInlineValue("a\tb"), "a b");
  // At most 100 names per scope.
  const many = Array.from({ length: 150 }, (_, i) => ({ name: `v${i}`, value: String(i) }));
  const wide = inlineValueLines({
    lines: many.map((v) => `use(${v.name});`),
    syntax: syntaxFor("/w/a.js"),
    stopLine: many.length,
    scopes: [{ startLine: 1, variables: many }],
  });
  assert.equal(wide.length, MAX_NUM_INLINE_VALUES);
});

test("inline values: the most specific scopes", () => {
  const scopes = [
    { name: "Local", ref: 1, expensive: false, line: 10, endLine: 20 },
    { name: "Closure", ref: 2, expensive: false, line: 1, endLine: 100 },
    { name: "Other", ref: 3, expensive: false, line: 30, endLine: 40 },
    { name: "Global", ref: 4, expensive: true },
  ];
  assert.deepEqual(
    mostSpecificScopes(scopes, 15).map((s) => s.name),
    ["Local", "Closure"],
  );
  // No lines from the debugger: every cheap scope.
  assert.deepEqual(
    mostSpecificScopes(
      [
        { name: "Locals", ref: 1, expensive: false },
        { name: "Globals", ref: 2, expensive: true },
      ],
      5,
    ).map((s) => s.name),
    ["Locals"],
  );
});

test("step into target: the call under the cursor", () => {
  const targets = [
    { id: 1, label: "outer", line: 3, column: 5, endLine: 3, endColumn: 30 },
    { id: 2, label: "inner", line: 3, column: 11, endLine: 3, endColumn: 20 },
    { id: 3, label: "noEnd", line: 5, column: 3 },
    { id: 4, label: "later", line: 5, column: 12 },
  ];
  assert.equal(stepTargetAt(targets, 3, 12)?.label, "inner");
  assert.equal(stepTargetAt(targets, 3, 25)?.label, "outer");
  assert.equal(stepTargetAt(targets, 3, 2), undefined);
  assert.equal(stepTargetAt(targets, 5, 5)?.label, "noEnd");
  assert.equal(stepTargetAt(targets, 5, 14)?.label, "later");
  assert.equal(stepTargetAt(targets, 9, 1), undefined);
  assert.equal(stepTargetAt([{ id: 9, label: "x" }], 1, 1), undefined);
});
