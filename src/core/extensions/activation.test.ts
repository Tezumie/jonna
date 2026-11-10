// D295: activation as VS Code does it — remembered events, dependencies and their messages,
// dependents, the extension host's restart budget, implicit onLanguage.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ActivationMemory,
  activateDependencies,
  type DependencyState,
  dependentsOf,
  extensionDependencies,
  RestartBudget,
} from "./activation";
import { parseManifest } from "./thirdParty";

test("D295: activation events that fired are remembered", () => {
  const memory = new ActivationMemory();
  assert.equal(memory.matches(["onLanguage:python"]), false);
  memory.record("onLanguage:python");
  memory.record("onNotebook:jupyter-notebook");
  memory.record("onDebugResolve:debugpy");
  assert.equal(memory.matches(["onCommand:x", "onLanguage:python"]), true);
  assert.equal(memory.matches(["onLanguage:rust"]), false);
  assert.equal(memory.matches(["onNotebook:*"]), true);
  assert.equal(memory.matches(["onLanguage:*"]), true);
  assert.equal(memory.matches(["onDebug"]), true);
  assert.equal(memory.matches(["onFileSystem:*"]), false);
  memory.clear();
  assert.equal(memory.matches(["onLanguage:python"]), false);
});

test("D295: the extension host restarts at most 3 times in 5 minutes", () => {
  const budget = new RestartBudget();
  assert.equal(budget.take(0), true);
  assert.equal(budget.take(1000), true);
  assert.equal(budget.take(2000), true);
  assert.equal(budget.take(3000), false);
  // The first restart is out of the window again.
  assert.equal(budget.take(5 * 60_000), true);
  assert.equal(budget.take(5 * 60_000 + 1), false);
});

test("D295: extensionDependencies, lowercase and checked", () => {
  assert.deepEqual(
    extensionDependencies({
      extensionDependencies: ["ms-python.Python", "ms-python.python", "bad", 3, "vscode.git"],
    }),
    ["ms-python.python", "vscode.git"],
  );
  assert.deepEqual(extensionDependencies({}), []);
  assert.deepEqual(extensionDependencies(null), []);
});

test("D295: dependencies activate first; VS Code's messages when missing or failed", async () => {
  const order: string[] = [];
  const states: Record<string, DependencyState> = {
    "a.code": {
      kind: "code",
      displayName: "Code A",
      activate: async () => {
        order.push("a.code");
      },
    },
    "a.themes": { kind: "declarative" },
    "a.broken": {
      kind: "code",
      displayName: "Broken",
      activate: () => Promise.reject(new Error("boom")),
    },
  };
  const state = (id: string): DependencyState => states[id] ?? { kind: "missing" };
  await activateDependencies("Jupyter", ["vscode.git", "a.themes", "a.code"], state);
  assert.deepEqual(order, ["a.code"]);
  await assert.rejects(activateDependencies("Jupyter", ["a.code", "ms-python.python"], state), {
    message:
      "Cannot activate the 'Jupyter' extension because it depends on unknown extension 'ms-python.python'",
  });
  await assert.rejects(activateDependencies("Jupyter", ["a.broken"], state), {
    message:
      "Cannot activate the 'Jupyter' extension because its dependency 'Broken' failed to activate",
  });
});

test("D295: dependents, directly or through another", () => {
  const extensions = [
    { id: "ms-python.python", dependencies: [] },
    { id: "ms-toolsai.jupyter", dependencies: ["ms-python.python"] },
    { id: "acme.cells", dependencies: ["ms-toolsai.jupyter"] },
    { id: "acme.other", dependencies: [] },
  ];
  assert.deepEqual(dependentsOf("ms-python.python", extensions), [
    "ms-toolsai.jupyter",
    "acme.cells",
  ]);
  assert.deepEqual(dependentsOf("acme.other", extensions), []);
});

test("D295: implicit onLanguage only for languages with a configuration", () => {
  const m = parseManifest(
    {
      publisher: "acme",
      name: "langs",
      version: "1.0.0",
      main: "./out/extension.js",
      engines: { vscode: "^1.80.0" },
      contributes: {
        languages: [
          { id: "acme", extensions: [".acme"], configuration: "./language-configuration.json" },
          { id: "acme-log", extensions: [".acmelog"] },
        ],
      },
    },
    "package.json",
  );
  assert.ok(m.activation.includes("onLanguage:acme"));
  assert.ok(!m.activation.includes("onLanguage:acme-log"));
});
