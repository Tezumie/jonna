import assert from "node:assert/strict";
import { test } from "node:test";
import { installCommand, installProgram, methodsFor, pickInstall } from "./install";

test("language server install commands per platform", () => {
  const methods = [
    { tool: "npm" as const, package: "pyright" },
    { tool: "pip" as const, package: "pyright" },
    { tool: "brew" as const, package: "pyright", platforms: ["mac"] },
  ];
  assert.deepEqual(
    methodsFor(methods, "windows").map((m) => m.tool),
    ["npm", "pip"],
  );
  assert.equal(installCommand(methods[1] as never, "windows"), "py -m pip install --user pyright");
  assert.equal(installCommand(methods[0] as never, "linux"), "npm install -g pyright");
  assert.equal(pickInstall(methodsFor(methods, "linux"), [false, true])?.tool, "pip");
  assert.equal(pickInstall(methodsFor(methods, "linux"), [false, false]), null);
});

test("pip is looked for as the program that runs it", () => {
  assert.equal(installProgram("pip", "windows"), "py");
  assert.equal(installProgram("pip", "linux"), "python3");
  assert.equal(installProgram("npm", "windows"), "npm");
});
