// D270: a command typed after the user pressed Escape in bash keeps its first letter.
import assert from "node:assert/strict";
import { test } from "node:test";
import { commandInput, holdsEscape } from "./typing";

test("bash holds a lone Escape; other shells don't", () => {
  assert.ok(holdsEscape("C:\\Program Files\\Git\\bin\\bash.exe"));
  assert.ok(holdsEscape("/bin/bash"));
  assert.ok(holdsEscape("/usr/bin/sh"));
  for (const shell of ["pwsh.exe", "C:\\Windows\\System32\\cmd.exe", "/bin/zsh", "fish"])
    assert.ok(!holdsEscape(shell), shell);
});

test("a held Escape is cancelled with Ctrl+G before the command", () => {
  const bash = "C:\\Program Files\\Git\\bin\\bash.exe";
  assert.equal(commandInput("cp a b", "\x1b", bash), "\x07cp a b\r");
  // Alt+x (Escape and a key in one chunk), other keys, nothing yet: typed as it is.
  assert.equal(commandInput("cp a b", "\x1bx", bash), "cp a b\r");
  assert.equal(commandInput("cp a b", "ls\r", bash), "cp a b\r");
  assert.equal(commandInput("cp a b", "", bash), "cp a b\r");
  // PowerShell drops the line on Escape at once: nothing to cancel.
  assert.equal(commandInput("cp a b", "\x1b", "pwsh.exe"), "cp a b\r");
});
