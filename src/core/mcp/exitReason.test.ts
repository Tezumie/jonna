import assert from "node:assert/strict";
import { test } from "node:test";
import { exitReason } from "./exitReason";

test("D345: a Node crash names its error, not the closing brace and version", () => {
  const stderr = [
    "node:internal/modules/cjs/loader:1228",
    "  throw err;",
    "  ^",
    "",
    "Error: Cannot find module 'C:\\work\\missing.mjs'",
    "    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)",
    "    at node:internal/main/run_main_module:28:49 {",
    "  code: 'MODULE_NOT_FOUND',",
    "  requireStack: []",
    "}",
    "",
    "Node.js v24.20.0",
  ];
  assert.equal(exitReason(stderr), "Error: Cannot find module 'C:\\work\\missing.mjs'");
});

test("D345: a Python traceback names its exception; otherwise the last meaningful line", () => {
  assert.equal(
    exitReason([
      "Traceback (most recent call last):",
      '  File "server.py", line 3, in <module>',
      "    import mcp",
      "ModuleNotFoundError: No module named 'mcp'",
    ]),
    "ModuleNotFoundError: No module named 'mcp'",
  );
  assert.equal(exitReason(["starting", "listening on stdio", "bye"]), "bye");
  assert.equal(exitReason(["}", "", "Node.js v24.20.0"]), "");
});
