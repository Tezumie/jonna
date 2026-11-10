import assert from "node:assert/strict";
import { test } from "node:test";
import { terminalTitle, unescapeMark } from "./title";

test("terminal titles are shell · folder, never a raw path", () => {
  assert.equal(
    terminalTitle("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "C:\\work\\ide"),
    "pwsh · ide",
  );
  assert.equal(
    terminalTitle("C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "D:\\"),
    "powershell · D:",
  );
  assert.equal(terminalTitle("/bin/bash", "/home/me/project/"), "bash · project");
  assert.equal(terminalTitle("/usr/bin/zsh", "/"), "zsh · /");
});

test("shell-integration escapes are undone", () => {
  assert.equal(unescapeMark("C:\\\\Users\\x3b x"), "C:\\Users; x");
});
