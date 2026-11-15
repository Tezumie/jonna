import assert from "node:assert/strict";
import { test } from "node:test";
import { compileIsolated } from "./isolate";

const run = (body: string, globals: Record<string, unknown> = {}, ...values: unknown[]) =>
  compileIsolated(["args", "agent"], body, globals, "workflow.js")(...values);

test("a script's body runs as an async function of what it is given", async () => {
  const agent = async (prompt: string) => `did ${prompt}`;
  assert.equal(
    await run("const a = await agent(args.what); return a + '!';", {}, { what: "x" }, agent),
    "did x!",
  );
  // Strict, as a workflow's body always was.
  await assert.rejects(run("undeclared = 1;"), /not defined/);
});

test("nothing of Node is in reach, only the names handed in", async () => {
  const names = [
    "process",
    "require",
    "module",
    "Buffer",
    "fetch",
    "WebSocket",
    "setTimeout",
    "setImmediate",
    "navigator",
    "global",
    "performance",
    "Worker",
  ];
  // As text: an array made in there is another realm's, never deep-equal to one made here.
  assert.equal(
    await run(
      `return ${JSON.stringify(names)}.filter((n) => typeof globalThis[n] !== "undefined").join();`,
    ),
    "",
  );
  assert.equal(await run("return typeof given;", { given: () => 1 }), "function");
  // The context's own global is not the thread's.
  assert.equal(await run("return globalThis === args;", {}, globalThis), false);
});

test("import() rejects instead of loading a module", async () => {
  await assert.rejects(run("return (await import('node:fs')).readFileSync;"), (err: unknown) =>
    /ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING|dynamic import/i.test(
      `${(err as { code?: string }).code} ${String(err)}`,
    ),
  );
});

test("code can't be made from text inside it", async () => {
  await assert.rejects(run("return eval('1 + 1');"), /Code generation from strings disallowed/);
  await assert.rejects(run("return new Function('return 1')();"), /Code generation/);
  await assert.rejects(
    run("return (async () => {}).constructor('return 1')();"),
    /Code generation/,
  );
  await assert.rejects(
    run("return (function* () {}).constructor('yield 1')().next();"),
    /Code generation/,
  );
});

test("an error says its line in the body", async () => {
  const err = await run("const a = 1;\nconst b = 2;\nthrow new Error('here');").then(
    () => null,
    (e: unknown) => e as { stack?: string },
  );
  // Line 3 of the body is line 6 of what is compiled: three lines come before it.
  assert.match(err?.stack ?? "", /workflow\.js:6/);
  assert.throws(() => run("const = ;"), /SyntaxError|Unexpected/);
});
