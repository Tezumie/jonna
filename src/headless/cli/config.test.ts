import assert from "node:assert/strict";
import { test } from "node:test";
import { listDecision, modeSettings } from "../../extensions/agent/unattended";
import { parseArgs, UsageError } from "./args";
import { composePrompt, limitsOf, modelChoice, policyOf, reviewOf } from "./config";

const known = {
  external: ["Claude Code", "Codex"],
  custom: [{ id: "custom:Reviewer", name: "Reviewer" }],
};

test("the permission policy: the flags' mode and lists; asking only when somebody can answer", () => {
  assert.deepEqual(policyOf(parseArgs(["-p", "x"]), false), { otherwise: "deny" });
  assert.deepEqual(policyOf(parseArgs([]), true), { otherwise: "wait" });
  assert.deepEqual(
    policyOf(
      parseArgs(["-p", "x", "--permission-mode", "auto", "--allow", "npm test", "--deny", "rm"]),
      false,
    ),
    { mode: "auto", allow: ["npm test"], deny: ["rm"], otherwise: "deny" },
  );
});

test("the policy decides as the app's lists do: deny wins, allow answers, the rest is left", () => {
  const policy = policyOf(
    parseArgs(["-p", "x", "--allow", "npm test", "--allow", "write_file", "--deny", "git push"]),
    false,
  );
  const command = (code: string) => ({ title: `Run ${code}`, kind: "command" as const, code });
  assert.deepEqual(listDecision(policy, command("npm test -- --watch")), {
    answer: "once",
    rule: "npm test",
  });
  assert.deepEqual(listDecision(policy, command("git push origin main")), {
    answer: "deny",
    rule: "git push",
  });
  // Allowed and denied parts in one line: denied.
  assert.equal(listDecision(policy, command("npm test && git push"))?.answer, "deny");
  assert.equal(listDecision(policy, command("curl example.com")), null);
});

test("flags override settings, and no flag means no override", () => {
  // Nothing named: nothing for the run to hold above the settings files.
  const none = parseArgs(["-p", "x"]);
  assert.equal(policyOf(none, false).mode, undefined);
  assert.deepEqual(modelChoice(none, known), { settings: {} });
  assert.deepEqual(limitsOf(none), {});
  // The mode's settings are the ones the app's access menu writes.
  assert.deepEqual(modeSettings("full-access").settings, { "agent.runCommands": "full" });
  const effort = modelChoice(parseArgs(["-p", "x", "--effort", "HIGH"]), known);
  assert.deepEqual(effort.settings, { "agent.effort": "high" });
  assert.deepEqual(limitsOf(parseArgs(["-p", "x", "--max-steps", "5", "--timeout", "1.5"])), {
    maxSteps: 5,
    timeoutMs: 1500,
  });
});

test("edits: written in a one shot unless --review or the ask mode; a session follows the app", () => {
  assert.equal(reviewOf(parseArgs(["-p", "x"]), true), false);
  assert.equal(reviewOf(parseArgs(["-p", "x", "--review"]), true), true);
  assert.equal(reviewOf(parseArgs(["-p", "x", "--permission-mode", "ask"]), true), true);
  assert.equal(reviewOf(parseArgs(["-p", "x", "--permission-mode", "auto"]), true), false);
  assert.equal(
    reviewOf(parseArgs(["-p", "x", "--permission-mode", "full-access", "--review"]), true),
    true,
  );
  assert.equal(reviewOf(parseArgs([]), false), undefined);
});

test("--model: a provider's model, or an external agent with its own model", () => {
  const of = (...argv: string[]) => modelChoice(parseArgs(["-p", "x", ...argv]), known);
  assert.equal(of("--model", "ollama/qwen3:8b").model, "ollama/qwen3:8b");
  assert.equal(of("--model", "claude-sonnet").model, "claude-sonnet");
  assert.equal(of("--model", "claude code").model, "acp/Claude Code");
  assert.deepEqual(of("--model", "Codex:gpt-5"), {
    model: "acp/Codex",
    agentModel: "gpt-5",
    settings: {},
  });
  assert.equal(of("--model", "acp/Codex").model, "acp/Codex");
  assert.throws(() => of("--model", "acp/Nobody"), UsageError);
  // The effort goes to whichever answers.
  assert.equal(of("--model", "Codex", "--effort", "high").agentLevel, "high");
  assert.throws(() => of("--effort", "extreme"), /--effort is one of/);
});

test("--agent: one of the user's agents, or an external agent", () => {
  const of = (...argv: string[]) => modelChoice(parseArgs(["-p", "x", ...argv]), known);
  assert.equal(of("--agent", "reviewer").agentMode, "custom:Reviewer");
  assert.equal(of("--agent", "Codex").model, "acp/Codex");
  assert.deepEqual(of("--agent", "Codex", "--model", "gpt-5"), {
    model: "acp/Codex",
    agentModel: "gpt-5",
    settings: {},
  });
  assert.equal(of("--agent", "Reviewer", "--mode", "plan").workMode, "plan");
  assert.throws(() => of("--agent", "Reviewr"), /Did you mean Reviewer\?/);
  assert.throws(() => of("--agent", "Codex", "--model", "Claude Code"), /another external agent/);
});

test("the prompt: the argument, standard input, or both with the input as context", () => {
  assert.equal(composePrompt("fix it", undefined), "fix it");
  assert.equal(composePrompt(undefined, "from a pipe\n"), "from a pipe");
  assert.equal(
    composePrompt("explain", "﻿line 1\r\nline 2\n"),
    "explain\n\n<stdin>\nline 1\r\nline 2\n</stdin>",
  );
  assert.equal(composePrompt("explain", "  \n"), "explain");
  assert.equal(composePrompt(undefined, ""), "");
});
