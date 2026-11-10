import assert from "node:assert/strict";
import { test } from "node:test";
import {
  combineDecisions,
  hookDecision,
  hookInput,
  hookSignatureText,
  hooksFor,
  labelHooks,
  matchesTool,
  mergeHooks,
  parseHooks,
} from "./hooks";

const claudeStyle = {
  PreToolUse: [
    { matcher: "Bash", hooks: [{ type: "command", command: "check-cmd", timeout: 5 }] },
    { matcher: "Edit|Write", hooks: [{ type: "command", command: "lint-file" }] },
  ],
  Stop: [{ hooks: [{ type: "command", command: "run-tests" }] }],
  Bogus: [{ hooks: [{ command: "x" }] }],
  PostToolUse: [{ matcher: "*", hooks: [{ type: "prompt", command: "skipped" }] }],
};

test("parseHooks reads Claude Code's format, skips the rest", () => {
  const t = parseHooks(claudeStyle, "user settings");
  assert.equal(t.PreToolUse?.length, 2);
  assert.equal(t.PreToolUse?.[0]?.commands[0]?.timeoutMs, 5000);
  assert.equal(t.PreToolUse?.[1]?.commands[0]?.timeoutMs, 60_000);
  assert.equal(t.Stop?.[0]?.matcher, "");
  assert.equal(t.PostToolUse, undefined);
  assert.deepEqual(parseHooks(null, "x"), {});
});

test("matchers take the IDE's tool names and Claude Code's", () => {
  assert.ok(matchesTool("Bash", "run_command"));
  assert.ok(matchesTool("Edit|Write", "write_file"));
  assert.ok(matchesTool("edit_file", "edit_file"));
  assert.ok(matchesTool("", "search"));
  assert.ok(matchesTool("*", "search"));
  assert.ok(!matchesTool("Bash", "read_file"));
  // Whole names only: "Read" doesn't take "ReadSomething".
  assert.ok(!matchesTool("Rea", "read_file"));
  // A broken regex is compared as a name.
  assert.ok(matchesTool("Bash(", "run_command") === false);
  const t = mergeHooks(parseHooks(claudeStyle, "user"), parseHooks(claudeStyle, "folder"));
  assert.deepEqual(
    hooksFor(t, "PreToolUse", { tool: "run_command" }).map((c) => [c.command, c.source]),
    [
      ["check-cmd", "user"],
      ["check-cmd", "folder"],
    ],
  );
  assert.equal(hooksFor(t, "Stop").length, 2);
});

test("hookDecision: exit 2 blocks, JSON decisions, failures don't block", () => {
  assert.deepEqual(hookDecision({ exitCode: 2, output: "no rm -rf\n", timedOut: false }), {
    block: true,
    reason: "no rm -rf",
    context: "",
  });
  assert.equal(hookDecision({ exitCode: 0, output: "", timedOut: false }).block, false);
  // Plain output is context for a prompt only: a tool hook's log lines aren't sent to the agent.
  const plain = { exitCode: 0, output: "remember the style guide", timedOut: false };
  assert.equal(hookDecision(plain, "UserPromptSubmit").context, "remember the style guide");
  assert.equal(hookDecision(plain, "PostToolUse").context, "");
  const deny = hookDecision({
    exitCode: 0,
    output: JSON.stringify({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "protected" },
    }),
    timedOut: false,
  });
  assert.deepEqual([deny.block, deny.reason], [true, "protected"]);
  const ctx = hookDecision({
    exitCode: 0,
    output: JSON.stringify({ hookSpecificOutput: { additionalContext: "branch: main" } }),
    timedOut: false,
  });
  assert.deepEqual([ctx.block, ctx.context], [false, "branch: main"]);
  assert.equal(
    hookDecision({
      exitCode: 0,
      output: '{"decision":"block","reason":"tests fail"}',
      timedOut: false,
    }).reason,
    "tests fail",
  );
  // A warning on stderr before the JSON doesn't hide the deny.
  const warned = hookDecision({
    exitCode: 0,
    output: `(node:1) DeprecationWarning: x\n${JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } })}\n`,
    timedOut: false,
  });
  assert.equal(warned.block, true);
  // Pretty-printed JSON after other output (Python's indent=2, PowerShell's ConvertTo-Json).
  const pretty = hookDecision({
    exitCode: 0,
    output: `checking…\r\n${JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } }, null, 2).replaceAll("\n", "\r\n")}\r\n`,
    timedOut: false,
  });
  assert.equal(pretty.block, true);
  // "continue": false stops for good: not a block (a Stop hook mustn't send the agent back).
  const halt = hookDecision({
    exitCode: 0,
    output: '{"continue":false,"stopReason":"budget spent"}',
    timedOut: false,
  });
  assert.deepEqual([halt.block, halt.halt, halt.reason], [false, true, "budget spent"]);
  assert.equal(combineDecisions([halt, ctx]).halt, true);
  const failed = hookDecision({ exitCode: 1, output: "boom", timedOut: false });
  assert.deepEqual([failed.block, failed.error], [false, "exit code 1: boom"]);
  assert.equal(hookDecision({ exitCode: null, output: "", timedOut: true }).error, "timed out");
  const all = combineDecisions([deny, ctx, failed]);
  assert.deepEqual(
    [all.block, all.reason, all.context, all.error],
    [true, "protected", "branch: main", "exit code 1: boom"],
  );
});

test("hookInput: Claude Code's field names", () => {
  const input = JSON.parse(
    hookInput("PreToolUse", {
      sessionId: "s1",
      cwd: "/w",
      tool: "run_command",
      toolInput: { command: "ls" },
    }),
  );
  assert.equal(input.hook_event_name, "PreToolUse");
  assert.equal(input.tool_name, "run_command");
  assert.deepEqual(input.tool_aliases, ["Bash"]);
  assert.deepEqual(input.tool_input, { command: "ls" });
  assert.equal(
    JSON.parse(hookInput("Stop", { sessionId: "s", cwd: "/", stopHookActive: true }))
      .stop_hook_active,
    true,
  );
});

test("the hook signature covers every folder that sets hooks", () => {
  const key = (p: string) => p.toLowerCase();
  const a = parseHooks(
    { Stop: [{ matcher: "", hooks: [{ type: "command", command: "npm test" }] }] },
    ".claude/settings.json",
  );
  const b = parseHooks(
    { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./check.sh" }] }] },
    ".claude/settings.json",
  );
  // One folder: signed as before (so an earlier approval holds).
  assert.equal(
    hookSignatureText([{ root: "C:\\App", table: a }], key),
    JSON.stringify(["c:\\app", a]),
  );
  // A folder without hooks added: nothing new runs, the same signature.
  assert.equal(
    hookSignatureText(
      [
        { root: "C:\\App", table: a },
        { root: "D:\\Lib", table: {} },
      ],
      key,
    ),
    JSON.stringify(["c:\\app", a]),
  );
  // A folder with hooks added: a different signature (asked again).
  const two = hookSignatureText(
    [
      { root: "C:\\App", table: a },
      { root: "D:\\Lib", table: b },
    ],
    key,
  );
  assert.notEqual(two, JSON.stringify(["c:\\app", a]));
  assert.ok(two.includes("d:\\\\lib") && two.includes("./check.sh"));
  // The same hooks in another folder: another signature.
  assert.notEqual(
    hookSignatureText([{ root: "C:\\Other", table: a }], key),
    hookSignatureText([{ root: "C:\\App", table: a }], key),
  );
  assert.equal(hookSignatureText([], key), "[]");
});

test("labelHooks names the folder in each command's source", () => {
  const t = parseHooks(
    { Stop: [{ matcher: "", hooks: [{ type: "command", command: "x" }] }] },
    ".claude/settings.json",
  );
  assert.equal(hooksFor(labelHooks(t, "api"), "Stop")[0]?.source, "api: .claude/settings.json");
});

test("D371: the rest of Claude Code's events, each matched on its own field", () => {
  const t = parseHooks(
    {
      SessionStart: [
        { matcher: "startup|resume", hooks: [{ command: "start" }] },
        { matcher: "compact", hooks: [{ command: "after-compact" }] },
      ],
      PreCompact: [{ matcher: "auto", hooks: [{ command: "pre" }] }],
      Notification: [{ hooks: [{ command: "ping" }] }],
      SubagentStop: [{ matcher: "reviewer", hooks: [{ command: "sub" }] }],
      SessionEnd: [{ hooks: [{ command: "end" }] }],
    },
    "user settings",
  );
  const names = (e: Parameters<typeof hooksFor>[1], f: Parameters<typeof hooksFor>[2]) =>
    hooksFor(t, e, f).map((c) => c.command);
  assert.deepEqual(names("SessionStart", { source: "resume" }), ["start"]);
  assert.deepEqual(names("SessionStart", { source: "compact" }), ["after-compact"]);
  assert.deepEqual(names("PreCompact", { trigger: "manual" }), []);
  assert.deepEqual(names("PreCompact", { trigger: "auto" }), ["pre"]);
  assert.deepEqual(names("Notification", { notificationType: "permission_prompt" }), ["ping"]);
  assert.deepEqual(names("SubagentStop", { agentType: "explore" }), []);
  assert.deepEqual(names("SubagentStop", { agentType: "reviewer" }), ["sub"]);
  assert.deepEqual(names("SessionEnd", { reason: "clear" }), ["end"]);
  const input = JSON.parse(
    hookInput("PreCompact", {
      sessionId: "s",
      cwd: "/w",
      trigger: "manual",
      customInstructions: "keep the API",
    }),
  );
  assert.deepEqual(
    [input.hook_event_name, input.trigger, input.custom_instructions],
    ["PreCompact", "manual", "keep the API"],
  );
  // A session's start takes plain output as context, as Claude Code does; a notification doesn't.
  const plain = { exitCode: 0, output: "branch: main", timedOut: false };
  assert.equal(hookDecision(plain, "SessionStart").context, "branch: main");
  assert.equal(hookDecision(plain, "Notification").context, "");
});
