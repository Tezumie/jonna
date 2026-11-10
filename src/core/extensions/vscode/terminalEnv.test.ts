// D264: VS Code's EnvironmentVariableCollection in the shim.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TerminalEnvChange } from "../rpcTerminals";
import { EnvironmentVariableCollection } from "./terminalEnv";
import { EnvironmentVariableMutatorType } from "./types";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("changes go to the IDE once per tick, in the order they were set", async () => {
  const sent: TerminalEnvChange[][] = [];
  const c = new EnvironmentVariableCollection((changes) => sent.push(changes));
  c.replace("PORT", "1234");
  c.prepend("PATH", "/venv/bin:");
  c.append("NODE_OPTIONS", " --inspect");
  await tick();
  assert.deepEqual(sent, [
    [
      { variable: "PORT", value: "1234", type: "replace" },
      { variable: "PATH", value: "/venv/bin:", type: "prepend" },
      { variable: "NODE_OPTIONS", value: " --inspect", type: "append" },
    ],
  ]);
  assert.equal(c.get("PATH")?.type, EnvironmentVariableMutatorType.Prepend);
  assert.equal([...c].length, 3);
  // The same value again sends nothing; delete and clear do.
  c.replace("PORT", "1234");
  await tick();
  assert.equal(sent.length, 1);
  c.delete("PORT");
  await tick();
  assert.equal(sent[1]?.length, 2);
  c.clear();
  await tick();
  assert.deepEqual(sent[2], []);
  assert.equal(c.getScoped({ workspaceFolder: undefined }), c);
});
