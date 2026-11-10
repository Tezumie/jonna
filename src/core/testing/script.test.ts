import assert from "node:assert/strict";
import { test } from "node:test";
import { matchValue, parseTestScript, printable, runTestScript } from "./script";

test("partial matching with operators", () => {
  assert.equal(matchValue({ a: 1, b: { c: [1, 2, 3] } }, { b: { c: [1, 2] } }), undefined);
  assert.equal(matchValue({ n: 5 }, { n: { $gte: 3, $lte: 5 } }), undefined);
  assert.match(matchValue({ n: 5 }, { n: { $lte: 4 } }) ?? "", /≤ 4/);
  assert.equal(matchValue({ s: "hello" }, { s: { $contains: "ell" } }), undefined);
  assert.equal(
    matchValue({ list: [1, 2] }, { list: { $length: 2 }, x: { $exists: false } }),
    undefined,
  );
  assert.match(matchValue({ a: "x" }, { a: "y" }) ?? "", /\$\.a: expected "y"/);
});

test("runs steps, retries until timeout, reports failures", async () => {
  let counter = 0;
  const lines: string[] = [];
  const script = parseTestScript(`{
    // comment
    "name": "demo",
    "steps": [
      { "run": "inc", "expect": { "n": 1 } },
      { "state": "ide://x", "expect": { "n": { "$gte": 3 } }, "timeoutMs": 2000 },
      { "run": "boom", "expectError": "nope" },
      { "run": "inc", "expect": { "n": 99 } }
    ]
  }`);
  const result = await runTestScript(script, {
    execute: async (id) => {
      if (id === "boom") throw new Error("nope, failed");
      counter++;
      return { n: counter };
    },
    state: async () => ({ n: ++counter }),
    log: (l) => lines.push(l),
  });
  assert.equal(result.passed, 3);
  assert.equal(result.failed, 1);
  assert.equal(result.failures[0]?.step, 4);
  assert.ok(lines.some((l) => l.startsWith("not ok 4 - inc")));
  // What the failed step saw is logged with it (D400): a CI log is all there is to go by.
  assert.match(result.failures[0]?.message ?? "", /got: \{"n":\d+\}$/);
});

test("saved results fill later steps' inputs, state paths and expectations", async () => {
  const calls: unknown[] = [];
  const states: string[] = [];
  const script = parseTestScript(`{
    "steps": [
      { "run": "make", "save": "t" },
      { "run": "use", "input": { "id": "\${t.id}", "label": "n-\${t.id}" }, "expect": { "id": "\${t.id}" } },
      { "state": "ide://x/\${t.id}/out", "expect": { "path": "ide://x/7/out" } }
    ]
  }`);
  const result = await runTestScript(script, {
    execute: async (command, input) => {
      calls.push(input);
      return command === "make" ? { id: 7 } : input;
    },
    state: async (path) => {
      states.push(path);
      return { path };
    },
    log: () => {},
  });
  assert.equal(result.failed, 0);
  assert.deepEqual(calls[1], { id: 7, label: "n-7" });
  assert.deepEqual(states, ["ide://x/7/out"]);
});

test("printed values keep short strings and shorten long ones", () => {
  assert.equal(printable({ a: "x", n: 1 }), '{"a":"x","n":1}');
  const png = "A".repeat(500_000);
  const line = printable({ width: 10, png });
  assert.match(line, /^\{"width":10,"png":"A{80}… \(500000 characters\)"\}$/);
  const many = printable(Array.from({ length: 50 }, () => "B".repeat(1500)));
  assert.ok(many.length < 20_100);
  assert.match(many, /… \(\d+ characters\)$/);
  assert.equal(printable(undefined), "undefined");
});
