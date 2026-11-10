import assert from "node:assert/strict";
import { test } from "node:test";
import { evalPlan } from "./browserEval";

/** The first candidate body (what runs when it compiles). */
const first = (code: string) => {
  const plan = evalPlan(code);
  return plan.mode === "async" ? plan.bodies[0] : "(eval)";
};

test("D317: without await the code goes to indirect eval as is", () => {
  assert.deepEqual(evalPlan("document.title"), { mode: "eval" });
  assert.deepEqual(evalPlan("const s = 'await'; s // await"), { mode: "eval" });
});

test("D317: with await, the last expression is returned", () => {
  assert.equal(
    first("const r = await fetch('/x');\nr.status"),
    "const r = await fetch('/x');\n\nreturn (r.status\n);",
  );
  assert.equal(first("await sleep(1); 42;"), "await sleep(1);\nreturn (42\n);");
  assert.equal(first("await x()"), "\nreturn (await x()\n);");
  // The code itself is always the last candidate.
  const plan = evalPlan("await x()");
  assert.equal(plan.mode === "async" && plan.bodies[plan.bodies.length - 1], "await x()");
});

test("D317: statements, continued lines and comments aren't taken as the last expression", () => {
  assert.equal(first("await f();\nif (a) b()"), "await f();\nif (a) b()");
  assert.equal(first("const a = await f()\n  .then(g)"), "const a = await f()\n  .then(g)");
  assert.equal(first("x = 1\nawait y()\n+ 2"), "x = 1\n\nreturn (await y()\n+ 2\n);");
  assert.equal(
    first("const v = await f();\nv\n// done"),
    "const v = await f();\n\nreturn (v\n// done\n);",
  );
});

test("D317: boundaries inside brackets, strings, templates and regexes don't count", () => {
  assert.equal(
    first("const o = await f({\n a: 1;\n});\no"),
    "const o = await f({\n a: 1;\n});\n\nreturn (o\n);",
  );
  assert.equal(first("await f('a;b')"), "\nreturn (await f('a;b')\n);");
  // A template literal with a substitution that holds semicolons and a newline.
  const template = ["await f(`x;$", "{1;2}\n;y`)"].join("");
  assert.equal(first(template), `\nreturn (${template}\n);`);
  assert.equal(
    first("const m = /;/.test(await g()); m"),
    "const m = /;/.test(await g());\nreturn (m\n);",
  );
});
