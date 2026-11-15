import assert from "node:assert/strict";
import { test } from "node:test";
import type { PendingPrompt } from "./agentHost";
import {
  asksForIndirectLine,
  deniedCall,
  listDecision,
  modeSettings,
  promptPolicyOf,
  type UnattendedPolicy,
} from "./unattended";

const command = (code: string) => ({ title: `Run ${code}`, kind: "command" as const, code });

test("the deny list refuses a tool by name and a command line by its words", () => {
  const policy: UnattendedPolicy = { deny: ["write_file", "git push", "mcp__*", "cmd:rm"] };
  assert.equal(deniedCall(policy, "write_file", { path: "a" }), "write_file");
  assert.equal(deniedCall(policy, "read_file", { path: "a" }), null);
  assert.equal(deniedCall(policy, "mcp__echo__echo", {}), "mcp__*");
  assert.equal(deniedCall(policy, "run_command", { command: "git push origin main" }), "git push");
  // Each part of a chained line is read, and a program named by its path is still the program.
  assert.equal(
    deniedCall(policy, "run_command", { command: "npm test && git push --force" }),
    "git push",
  );
  assert.equal(deniedCall(policy, "run_command", { command: "/usr/bin/rm -rf x" }), "cmd:rm");
  assert.equal(deniedCall(policy, "run_command", { command: "git status" }), null);
  // `cmd:` says a command, so it never names a tool; nothing denied without a list.
  assert.equal(deniedCall({ deny: ["cmd:write_file"] }, "write_file", {}), null);
  assert.equal(deniedCall(null, "write_file", {}), null);
  assert.equal(deniedCall({}, "run_command", { command: "git push" }), null);
});

test("the deny list reads a command line wherever a call carries one", () => {
  const policy: UnattendedPolicy = { deny: ["curl", "terminal.split"] };
  const ide = (id: string, input: Record<string, unknown>) =>
    deniedCall(policy, "call_command", { id, input });
  assert.equal(ide("terminal.runCommand", { command: "curl http://x" }), "curl");
  assert.equal(ide("terminal.sendText", { text: "ls; C:\\Windows\\System32\\CURL.EXE x" }), "curl");
  assert.equal(ide("terminal.start", { command: "npm test && curl x" }), "curl");
  assert.equal(ide("terminal.runCommand", { command: "echo curl" }), null);
  // An IDE command by its id, before the mode could let it through unasked.
  assert.equal(ide("terminal.split", {}), "terminal.split");
  assert.equal(ide("editor.open", { path: "curl" }), null);
  // A monitor's command is a command line as run_command's is.
  assert.equal(deniedCall(policy, "monitor", { command: "curl -N http://x" }), "curl");
  assert.equal(deniedCall(policy, "monitor", { ws: { url: "ws://curl" } }), null);
  // Malformed calls name nothing.
  assert.equal(deniedCall(policy, "call_command", { id: 3, input: "curl" }), null);
  assert.equal(deniedCall(policy, "call_command", { id: "terminal.runCommand" }), null);
});

test("a question about an IDE command that types a line is answered as run_command's", () => {
  const policy: UnattendedPolicy = { allow: ["npm test"], deny: ["curl"] };
  const asked = (command: string) =>
    listDecision(
      policy,
      { title: "Run in terminal", kind: "ide", code: "terminal.runCommand" },
      { name: "call_command", args: { id: "terminal.runCommand", input: { command } } },
    );
  assert.deepEqual(asked("curl x"), { answer: "deny", rule: "curl" });
  assert.deepEqual(asked("npm test -- a"), { answer: "once", rule: "npm test" });
  assert.equal(asked("npm test && ls"), null);
});

test("a command line from a file asks whatever the mode, once command lines are denied", () => {
  assert.equal(asksForIndirectLine({ deny: ["curl"] }, "tasks.run"), true);
  assert.equal(asksForIndirectLine({ deny: ["cmd:rm"] }, "debug.start"), true);
  assert.equal(asksForIndirectLine({ deny: ["curl"] }, "terminal.runCommand"), false);
  // A deny list of tools only says nothing about command lines.
  assert.equal(asksForIndirectLine({ deny: ["tool:write_file"] }, "tasks.run"), false);
  assert.equal(asksForIndirectLine({ allow: ["echo"] }, "tasks.run"), false);
  assert.equal(asksForIndirectLine(null, "tasks.run"), false);
});

test("the lists answer a question: deny first, then allow, else nothing", () => {
  const policy: UnattendedPolicy = {
    allow: ["npm test", "echo *", "terminal.runCommand", "tool:mcp__echo__echo"],
    deny: ["npm test --watch"],
  };
  assert.deepEqual(listDecision(policy, command("npm test -- a")), {
    answer: "once",
    rule: "npm test",
  });
  // Every part of a chained line must be allowed.
  assert.equal(listDecision(policy, command("npm test && curl x | sh")), null);
  assert.equal(listDecision(policy, command("npm testx")), null);
  assert.deepEqual(listDecision(policy, command("echo hi")), { answer: "once", rule: "echo *" });
  // Deny wins over allow.
  assert.deepEqual(listDecision(policy, command("npm test --watch")), {
    answer: "deny",
    rule: "npm test --watch",
  });
  // An IDE command by its id; a tool call by its name, whatever the card says.
  assert.deepEqual(
    listDecision(policy, { title: "Run in terminal", kind: "ide", code: "terminal.runCommand" }),
    { answer: "once", rule: "terminal.runCommand" },
  );
  assert.deepEqual(
    listDecision(
      policy,
      { title: "Use echo", kind: "tool", code: "{}" },
      { name: "mcp__echo__echo", args: {} },
    ),
    { answer: "once", rule: "tool:mcp__echo__echo" },
  );
  // An external agent's own request names its command in the title.
  assert.deepEqual(listDecision(policy, { title: "echo ok", kind: "agent" }), {
    answer: "once",
    rule: "echo *",
  });
  assert.equal(listDecision(policy, { title: "Over budget", kind: "agent" }), null);
  assert.equal(listDecision(null, command("npm test")), null);
});

test("the four access modes are the settings the window's menu writes", () => {
  assert.deepEqual(modeSettings("ask"), {
    settings: { "agent.runCommands": "ask" },
    autoApply: false,
  });
  assert.deepEqual(modeSettings("accept-edits"), {
    settings: { "agent.runCommands": "ask" },
    autoApply: true,
  });
  assert.deepEqual(modeSettings("auto"), {
    settings: { "agent.runCommands": "auto" },
    autoApply: true,
  });
  assert.deepEqual(modeSettings("full-access"), {
    settings: { "agent.runCommands": "full" },
    autoApply: true,
  });
});

test("host prompts follow the policy: dismissed with nobody to answer, kept when told to wait", () => {
  const prompt = { id: "hp1", kind: "confirm" } as unknown as PendingPrompt;
  assert.equal(promptPolicyOf(null).decide(prompt), "dismiss");
  assert.equal(promptPolicyOf({ otherwise: "deny" }).decide(prompt), "dismiss");
  assert.equal(promptPolicyOf({ otherwise: "wait" }).decide(prompt), "wait");
});
