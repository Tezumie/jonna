import assert from "node:assert/strict";
import { test } from "node:test";
import { helpChoices, helpCommandLine, shellArg } from "./acpAgents";

test("the --help probe quotes a program path with spaces (D223)", () => {
  assert.equal(helpCommandLine("copilot", true), "copilot --help");
  assert.equal(helpCommandLine("/usr/bin/copilot", false), "/usr/bin/copilot --help");
  // PowerShell runs a quoted path only after `&`.
  assert.equal(
    helpCommandLine("C:\\Program Files\\Copilot\\copilot.exe", true),
    "& 'C:\\Program Files\\Copilot\\copilot.exe' --help",
  );
  assert.equal(helpCommandLine("/opt/My Agents/agent", false), "'/opt/My Agents/agent' --help");
});

test("an agent's terminal arguments reach the program as they are", () => {
  assert.equal(shellArg("src/a.ts", false), "src/a.ts");
  // The shell would expand $x and backticks inside double quotes before the program saw them.
  assert.equal(shellArg("x=1; echo $x `id`", false), "'x=1; echo $x `id`'");
  assert.equal(shellArg("it's", false), "'it'\\''s'");
  assert.equal(shellArg("", false), "''");
  // PowerShell: '' inside single quotes; a Windows path keeps single backslashes.
  assert.equal(shellArg("C:\\Program Files\\x", true), "'C:\\Program Files\\x'");
  assert.equal(shellArg("it's", true), "'it''s'");
});

test("models listed by an agent's --help", () => {
  const help = `Options:
  --acp                 Start as an ACP server
  --model <model>       Set the AI model to use (choices: "claude-sonnet-5", "gpt-6-sol",
                        "gemini-3.8-flash")
  --effort <level>      Reasoning effort`;
  assert.deepEqual(helpChoices(help, "--model"), [
    "claude-sonnet-5",
    "gpt-6-sol",
    "gemini-3.8-flash",
  ]);
  assert.deepEqual(helpChoices("--model <m> any model", "--model"), []);
  assert.deepEqual(helpChoices("", "--model"), []);
});
