import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkbenchContributions } from "./manifestWorkbench";
import { parseManifest } from "./thirdParty";

test("taskDefinitions: types kept, built-in ones and bad names refused", () => {
  const errors: string[] = [];
  const { taskDefinitions } = parseWorkbenchContributions(
    {
      taskDefinitions: [
        { type: "demo", required: ["flavor", 3], properties: { flavor: { type: "string" } } },
        { type: "demo" },
        { type: "shell" },
        { type: "bad/name" },
      ],
    },
    errors,
  );
  assert.deepEqual(taskDefinitions, [
    { type: "demo", required: ["flavor"], properties: { flavor: { type: "string" } } },
  ]);
  assert.equal(errors.length, 2);
});

test("debuggers: label, languages and snippets (each made a configuration of the type)", () => {
  const errors: string[] = [];
  const { debuggers } = parseWorkbenchContributions(
    {
      debuggers: [
        {
          type: "demo-dbg",
          label: "Demo",
          languages: ["demo"],
          configurationSnippets: [
            {
              label: "Demo: Launch",
              description: "Runs it",
              body: { request: "launch", name: "Run" },
            },
            { label: "Empty", body: {} },
          ],
        },
        { type: "node" },
        { type: "python" },
      ],
    },
    errors,
  );
  // The IDE's own debug types too: an extension's adapter runs them once it supplies one.
  assert.deepEqual(
    debuggers.map((d) => d.type),
    ["demo-dbg", "node", "python"],
  );
  assert.deepEqual(debuggers[0]?.snippets, [
    {
      label: "Demo: Launch",
      description: "Runs it",
      body: { request: "launch", name: "Run", type: "demo-dbg" },
    },
  ]);
  assert.equal(errors.length, 0);
});

test("manifest: the contributions are parsed (and empty for a VS Code extension)", () => {
  const m = parseManifest(
    {
      id: "acme.wb",
      version: "1.0.0",
      main: "main.js",
      contributes: { taskDefinitions: [{ type: "demo" }], debuggers: [{ type: "demo-dbg" }] },
    },
    "extension.json",
  );
  assert.equal(m.contributes.taskDefinitions[0]?.type, "demo");
  assert.equal(m.contributes.debuggers[0]?.label, "demo-dbg");
  const v = parseManifest(
    {
      name: "wb",
      publisher: "acme",
      version: "1.0.0",
      engines: { vscode: "^1.80.0" },
      contributes: { taskDefinitions: [{ type: "demo" }] },
    },
    "package.json",
  );
  assert.deepEqual(v.contributes.taskDefinitions, []);
});
