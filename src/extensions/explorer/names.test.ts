import assert from "node:assert/strict";
import { test } from "node:test";
import { hasWindowsNames, validateName } from "./names";

test("names every system refuses", () => {
  assert.ok(validateName("  "));
  assert.ok(validateName(".."));
  assert.ok(validateName("a/b"));
  assert.equal(validateName("a.ts"), undefined);
  assert.equal(validateName(".gitignore"), undefined);
});

test("Windows' device names and trailing periods are refused only on Windows", () => {
  for (const name of ["nul", "NUL", "con.txt", "Aux", "prn", "COM1", "lpt9.log", "nul.tar.gz"])
    assert.ok(validateName(name, true), name);
  assert.ok(validateName("a.", true));
  assert.ok(validateName("a. ", true));
  for (const name of ["null", "console.ts", "com0", "com10", "lpt", "nul-2", "a.b", ".env"])
    assert.equal(validateName(name, true), undefined, name);
  assert.equal(validateName("nul"), undefined);
  assert.equal(validateName("a."), undefined);
});

test("hasWindowsNames: drives and shares, not WSL folders or other systems", () => {
  assert.equal(hasWindowsNames("C:\\w\\src"), true);
  assert.equal(hasWindowsNames("\\\\server\\share\\x"), true);
  assert.equal(hasWindowsNames("\\\\wsl.localhost\\Ubuntu\\home\\me"), false);
  assert.equal(hasWindowsNames("/home/me/w"), false);
});
