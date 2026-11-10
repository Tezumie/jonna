import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeSettings } from "./manager";
import { pickInterpreter, pyrightSettings, venvCandidates } from "./python";

test("python interpreter: setting, then the folder's venv", () => {
  assert.deepEqual(venvCandidates("/w/", "linux").slice(0, 2), [
    "/w/.venv/bin/python",
    "/w/venv/bin/python",
  ]);
  assert.equal(venvCandidates("C:\\w", "windows")[0], "C:\\w\\.venv\\Scripts\\python.exe");
  assert.equal(
    pickInterpreter("${workspaceFolder}/.venv/bin/python", "/w", []),
    "/w/.venv/bin/python",
  );
  assert.equal(pickInterpreter("", "/w", ["/w/venv/bin/python"]), "/w/venv/bin/python");
  assert.equal(pickInterpreter(undefined, "/w", []), undefined);
  assert.deepEqual(
    mergeSettings(
      { python: { analysis: { autoSearchPaths: true } } },
      pyrightSettings("/w/.venv/bin/python"),
    ),
    { python: { analysis: { autoSearchPaths: true }, pythonPath: "/w/.venv/bin/python" } },
  );
});
