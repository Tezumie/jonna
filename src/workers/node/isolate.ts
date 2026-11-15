// Node only. A script's body compiled in a context of its own (`node:vm`), for a worker thread:
// what a page's worker gets from the engine and a Node thread doesn't.
//
// What it is: the body runs against a fresh global that has the language's built-ins and the
// few names it is given, nothing of Node (no `process`, `require`, `fetch`, timers of its own).
// `import()` rejects (no loader is given to the compiled code), and `eval` / `new Function`
// throw in that context (code generation from strings is off at the engine, WebAssembly too).
//
// What it is not: a security boundary. `node:vm` says so itself: the functions and objects
// handed in come from the thread's own realm, and code written to escape through them (or
// through an engine bug) is not stopped here, and nothing limits memory or CPU. The thread
// around it has had its process, loaders and network taken away (scope.ts, workers/lockdown.ts)
// so that the ordinary ways out lead nowhere; a script is still only run when the run's policy
// or a person allowed it.
import { createContext, Script } from "node:vm";

/** Compiles `body` as an async function of `params`, in a context holding only `globals`. */
export type IsolatedCompile = (
  params: readonly string[],
  body: string,
  globals: Readonly<Record<string, unknown>>,
  filename: string,
) => (...values: unknown[]) => Promise<unknown>;

export const compileIsolated: IsolatedCompile = (params, body, globals, filename) => {
  const context = createContext(
    { ...globals },
    { codeGeneration: { strings: false, wasm: false } },
  );
  // The same lines as an async function made from text: the parameters, `) {`, the strict
  // line, then the body from line 4 on (an error's line is told from that).
  const source = `(async function (${params.join(", ")}\n) {\n"use strict";\n${body}\n})`;
  // No `importModuleDynamically`: an `import()` in the body rejects instead of loading.
  const made: unknown = new Script(source, { filename }).runInContext(context);
  if (typeof made !== "function") throw new Error("The script didn't compile to a function.");
  return made as (...values: unknown[]) => Promise<unknown>;
};
