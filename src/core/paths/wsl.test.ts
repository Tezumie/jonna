import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWslPath } from "./wsl";

test("parseWslPath: Windows paths into WSL (D192)", () => {
  const want = { distro: "Ubuntu", linux: "/home/me/app" };
  assert.deepEqual(parseWslPath("\\\\wsl.localhost\\Ubuntu\\home\\me\\app"), want);
  assert.deepEqual(parseWslPath("\\\\wsl$\\Ubuntu\\home\\me\\app"), want);
  assert.deepEqual(parseWslPath("\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\me\\app"), want);
  assert.deepEqual(parseWslPath("//wsl.localhost/Ubuntu/home/me/app"), want);
  assert.equal(parseWslPath("C:\\Users\\me"), null);
  assert.equal(parseWslPath("\\\\server\\share"), null);
  assert.equal(parseWslPath("/home/me"), null);
});
