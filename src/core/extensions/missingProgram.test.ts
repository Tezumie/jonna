import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { missingBundledProgram } from "./missingProgram";

const dir = "C:\\Users\\me\\AppData\\Roaming\\ide\\extensions";

describe("missingBundledProgram", () => {
  it("finds a program missing from an extension's folder", () => {
    assert.deepEqual(
      missingBundledProgram(
        `spawn ${dir}\\ms-python.python\\python-env-tools\\bin\\pet.exe ENOENT`,
        dir,
      ),
      { program: "pet.exe", extensionFolder: "ms-python.python" },
    );
  });

  it("reads it inside a longer message and without case on Windows", () => {
    assert.deepEqual(
      missingBundledProgram(
        `Failed to run Python Environment Tool: Error: spawn ${dir.toLowerCase()}\\ms-python.python\\python-env-tools\\bin\\pet.exe ENOENT`,
        dir,
      ),
      { program: "pet.exe", extensionFolder: "ms-python.python" },
    );
  });

  it("works with forward slashes", () => {
    assert.deepEqual(
      missingBundledProgram(
        "spawn /home/me/.ide/extensions/ext.one/bin/tool ENOENT",
        "/home/me/.ide/extensions/",
      ),
      { program: "tool", extensionFolder: "ext.one" },
    );
  });

  it("leaves programs outside the extensions alone", () => {
    assert.equal(missingBundledProgram("spawn python ENOENT", dir), null);
    assert.equal(missingBundledProgram("spawn C:\\Python312\\python.exe ENOENT", dir), null);
    assert.equal(missingBundledProgram(`spawn ${dir}\\..\\evil.exe ENOENT`, dir), null);
    assert.equal(missingBundledProgram(`spawn ${dir}\\loose.exe ENOENT`, dir), null);
  });

  it("ignores other messages", () => {
    assert.equal(missingBundledProgram("Could not find a Python interpreter", dir), null);
    assert.equal(missingBundledProgram(`spawn ${dir}\\a\\b.exe EACCES`, dir), null);
    assert.equal(missingBundledProgram("spawn x ENOENT", ""), null);
  });
});
