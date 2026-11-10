import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isGuardianStep,
  packageRunner,
  parseReview,
  prettyCommand,
  promptUsage,
  reviewLine,
  reviewTarget,
  updateCost,
} from "./display";

test("prettyCommand: Windows PowerShell titles become the command (D208)", () => {
  assert.deepEqual(
    prettyCommand(
      `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'npm run check'`,
    ),
    { command: "npm run check", shell: "PowerShell" },
  );
  // Debug-quoted (doubled backslashes), with switches before -Command.
  assert.deepEqual(
    prettyCommand(
      `"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "git status"`,
    ),
    { command: "git status", shell: "PowerShell" },
  );
  assert.deepEqual(prettyCommand(`pwsh -c 'echo ''hi'''`), {
    command: "echo 'hi'",
    shell: "PowerShell",
  });
  assert.deepEqual(prettyCommand(`cmd.exe /d /s /c "npm test"`), {
    command: "npm test",
    shell: "cmd",
  });
  assert.deepEqual(prettyCommand(`/bin/bash -lc 'ls -la'`), { command: "ls -la", shell: "bash" });
  assert.deepEqual(prettyCommand(`bash -lc 'echo '\\''x'\\'''`), {
    command: "echo 'x'",
    shell: "bash",
  });
  // Two quoted arguments stay quoted (only one whole argument is unwrapped).
  assert.deepEqual(prettyCommand(`powershell.exe -Command 'a' 'b'`), {
    command: "'a' 'b'",
    shell: "PowerShell",
  });
  assert.deepEqual(prettyCommand("npm run check"), { command: "npm run check" });
  assert.deepEqual(prettyCommand(`"C:\\Program Files\\nodejs\\node.exe" build.mjs`), {
    command: "node build.mjs",
  });
  assert.deepEqual(prettyCommand(`"powershell.exe -Command 'npm test'"`), {
    command: "npm test",
    shell: "PowerShell",
  });
  assert.deepEqual(prettyCommand("Read file 'src/a.ts'"), { command: "Read file 'src/a.ts'" });
  assert.deepEqual(prettyCommand(""), { command: "" });
});

test("Guardian reviews: recognised, parsed, one line (D208)", () => {
  assert.equal(isGuardianStep("guardian_assessment:r1", undefined), true);
  assert.equal(isGuardianStep("t1", "Guardian Review"), true);
  assert.equal(isGuardianStep("t1", "Run tests"), false);
  const r = parseReview(
    "Status: Approved\nAction: shell npm run check\nRisk: low\nAuthorization: high\nRationale: Runs the project's\nown checks.",
  );
  assert.deepEqual(r, {
    by: "Guardian",
    status: "approved",
    risk: "low",
    authorization: "high",
    action: "shell npm run check",
    rationale: "Runs the project's\nown checks.",
  });
  assert.equal(r && reviewLine(r), "Guardian: approved · low risk");
  assert.equal(reviewLine({ by: "Guardian", status: "in progress" }), "Guardian: reviewing…");
  assert.equal(parseReview("no fields here"), null);
  assert.equal(reviewTarget({ targetItemId: "call_1" }), "call_1");
  assert.equal(reviewTarget(null), null);
});

test("promptUsage: each agent's way of counting input (D208)", () => {
  // Claude Code / Codex: input without the cache, total with it.
  assert.deepEqual(
    promptUsage({
      usage: {
        inputTokens: 10,
        outputTokens: 50,
        cachedReadTokens: 900,
        cachedWriteTokens: 40,
        totalTokens: 1000,
      },
    }),
    { input: 950, output: 50, cacheRead: 900, cacheWrite: 40 },
  );
  // Gemini CLI: input with the cache, total = input + output.
  assert.deepEqual(
    promptUsage({
      usage: { inputTokens: 1000, outputTokens: 50, cachedReadTokens: 900, totalTokens: 1050 },
    }),
    { input: 1000, output: 50, cacheRead: 900, cacheWrite: 0 },
  );
  assert.deepEqual(promptUsage({ usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }), {
    input: 5,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.deepEqual(
    promptUsage({ _meta: { quota: { token_count: { input_tokens: 7, output_tokens: 3 } } } }),
    { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 },
  );
  assert.equal(promptUsage({ stopReason: "end_turn" }), null);
  assert.equal(promptUsage({ usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }), null);
  assert.equal(promptUsage(null), null);
});

test("updateCost: dollars only", () => {
  assert.equal(updateCost({ cost: { amount: 0.25, currency: "USD" } }), 0.25);
  assert.equal(updateCost({ cost: { amount: 1, currency: "EUR" } }), null);
  assert.equal(updateCost({ used: 1, size: 2 }), null);
});

test("packageRunner: npx-like launchers, by name or path", () => {
  assert.equal(packageRunner("npx"), "npx");
  assert.equal(packageRunner("C:\\Program Files\\nodejs\\npx.cmd"), "npx");
  assert.equal(packageRunner("/usr/local/bin/uvx"), "uvx");
  assert.equal(packageRunner("claude"), null);
  assert.equal(packageRunner("opencode2"), null);
});
