// D295: launch configurations resolved in VS Code's order, the built-in Python debugger's
// environment, and what extensions are told of sessions.
import assert from "node:assert/strict";
import { test } from "node:test";
import { activeStackItem, sessionInfo } from "./extensionEvents";
import { dapLaunchArguments, toConfig } from "./launch";
import { parseEnvFile, pythonFor, withPythonPath } from "./pythonDebug";
import {
  hasResolvers,
  type ResolverSource,
  type ResolveStep,
  resolveByProviders,
  resolveWithSubstitutedVariables,
} from "./resolution";
import { DAP_EVENTS } from "./session";

function source(
  steps: Record<string, ResolveStep[]>,
  log: string[] = [],
): ResolverSource & { log: string[] } {
  return {
    log,
    activate: async (type) => {
      log.push(`activate ${type}`);
    },
    resolvers: (step, type) => steps[`${step}:${type}`] ?? [],
  };
}

test("D295: resolveDebugConfiguration runs the type's providers, then '*', in order", async () => {
  const log: string[] = [];
  const s = source(
    {
      "resolve:python": [
        async (_f, c) => {
          log.push("python 1");
          return { ...c, a: 1 };
        },
        async (_f, c) => {
          log.push("python 2");
          return { ...c, b: (c.a as number) + 1 };
        },
      ],
      "resolve:*": [
        async (_f, c) => {
          log.push("star");
          return { ...c, star: true };
        },
      ],
    },
    log,
  );
  const r = await resolveByProviders({ type: "python", name: "x" }, "/w", s);
  assert.deepEqual(r, { type: "python", name: "x", a: 1, b: 2, star: true });
  assert.deepEqual(log, ["activate python", "python 1", "python 2", "star"]);
});

test("D295: a resolver that changes the type sends it through the new type's providers", async () => {
  const log: string[] = [];
  const s = source(
    {
      "resolve:python": [async (_f, c) => ({ ...c, type: "debugpy" })],
      "resolve:debugpy": [async (_f, c) => ({ ...c, python: "/venv/python" })],
    },
    log,
  );
  const r = await resolveByProviders({ type: "python", name: "x" }, null, s);
  assert.deepEqual(r, { type: "debugpy", name: "x", python: "/venv/python" });
  // onDebugResolve:<type> for each type it went through.
  assert.deepEqual(log, ["activate python", "activate debugpy"]);
});

test("D295: a type that comes back again isn't resolved twice (no endless loop)", async () => {
  let calls = 0;
  const s = source({
    "resolve:a": [
      async (_f, c) => {
        calls++;
        return { ...c, type: "b" };
      },
    ],
    "resolve:b": [async (_f, c) => ({ ...c, type: "a" })],
  });
  const r = await resolveByProviders({ type: "a", name: "x" }, null, s);
  assert.equal(r?.type, "a");
  assert.equal(calls, 1);
});

test("D295: null or undefined from a resolver cancels the launch", async () => {
  const s = source({ "resolve:node": [async () => undefined] });
  assert.equal(await resolveByProviders({ type: "node", name: "x" }, null, s), null);
  const s2 = source({ "substituted:node": [async () => null] });
  assert.equal(await resolveWithSubstitutedVariables({ type: "node", name: "x" }, null, s2), null);
});

test("D295: the substituted step runs the type's providers, then '*'", async () => {
  const order: string[] = [];
  const s = source({
    "substituted:*": [
      async (_f, c) => {
        order.push("star");
        return c;
      },
    ],
    "substituted:go": [
      async (_f, c) => {
        order.push("go");
        return { ...c, env: { A: "1" } };
      },
    ],
  });
  const r = await resolveWithSubstitutedVariables({ type: "go", name: "x" }, "/w", s);
  assert.deepEqual(order, ["go", "star"]);
  assert.deepEqual(r?.env, { A: "1" });
  assert.equal(hasResolvers(s, "substituted", "node"), true);
  assert.equal(hasResolvers(source({}), "resolve", "node"), false);
});

test("D295: the configuration as written is kept beside the filled-in one", () => {
  const c = toConfig(
    { name: "Run", type: "debugpy", request: "launch", program: "${workspaceFolder}/a.py" },
    "launch.json",
    { workspaceFolder: "/w", pathSeparator: "/" },
  );
  assert.equal(c?.program, "/w/a.py");
  assert.equal(c?.unresolved?.program, "${workspaceFolder}/a.py");
});

test("D295: an extension's adapter gets the configuration without the IDE's defaults", () => {
  const c = toConfig({ name: "x", type: "mock", request: "launch", custom: 1 }, "x", {
    workspaceFolder: "/w",
    pathSeparator: "/",
  });
  assert.ok(c);
  assert.deepEqual(dapLaunchArguments({ ...c, verbatim: true }), {
    name: "x",
    type: "mock",
    request: "launch",
    custom: 1,
  });
  // The built-in ones keep theirs.
  assert.deepEqual(dapLaunchArguments(c).args, []);
});

test("D295: .env files as python-dotenv reads them", () => {
  const env = parseEnvFile(
    [
      "# comment",
      "A=1",
      "export B = two words # trailing",
      "C='single $A ${A}'",
      'D="line\\nbreak ${A}"',
      "E=${A}-${HOME}",
      "bad line",
      "",
    ].join("\r\n"),
    { HOME: "/home/me" },
  );
  assert.deepEqual(env, {
    A: "1",
    B: "two words",
    C: "single $A ${A}",
    D: "line\nbreak 1",
    E: "1-/home/me",
  });
});

test("D295: the built-in Python debugger's interpreter", () => {
  const base = { folder: "/w", venvs: ["/w/.venv/bin/python"], fallback: "python3" };
  assert.equal(pythonFor({ ...base, configPython: "/usr/bin/python3.12" }), "/usr/bin/python3.12");
  assert.equal(pythonFor({ ...base, configPython: ["/opt/py", "-X", "dev"] }), "/opt/py");
  assert.equal(pythonFor({ ...base, configPython: undefined, debugPythonPath: "/d/py" }), "/d/py");
  // VS Code's default "python" is no choice: the folder's venv is.
  assert.equal(
    pythonFor({ ...base, configPython: undefined, defaultInterpreterPath: "python" }),
    "/w/.venv/bin/python",
  );
  assert.equal(
    pythonFor({
      ...base,
      configPython: undefined,
      defaultInterpreterPath: "${workspaceFolder}/env/bin/python",
    }),
    "/w/env/bin/python",
  );
  assert.equal(pythonFor({ ...base, venvs: [], configPython: undefined }), "python3");
  assert.equal(withPythonPath("C:\\d\\libs", "C:\\x", "windows"), "C:\\d\\libs;C:\\x");
  assert.equal(withPythonPath("/d/libs", undefined, "linux"), "/d/libs");
});

test("D295: what extensions are told of a session and of the focused frame", () => {
  const info = sessionInfo({
    id: "s2",
    name: "Child",
    parentId: "s1",
    config: { type: "debugpy", raw: { type: "debugpy", python: "/p" }, workspaceFolder: "/w" },
  });
  assert.deepEqual(info, {
    id: "s2",
    name: "Child",
    type: "debugpy",
    configuration: { type: "debugpy", python: "/p" },
    parentSession: "s1",
    workspaceFolder: "/w",
  });
  assert.equal(activeStackItem(null), null);
  assert.deepEqual(activeStackItem({ state: "running", threadId: 3, frames: [], frameIndex: 0 }), {
    threadId: 3,
  });
  assert.deepEqual(
    activeStackItem({
      state: "stopped",
      threadId: 3,
      frames: [{ id: 7 }, { id: 8 }],
      frameIndex: 1,
    }),
    { threadId: 3, frameId: 8 },
  );
  assert.ok(DAP_EVENTS.has("stopped") && !DAP_EVENTS.has("debugpyAttach"));
});
