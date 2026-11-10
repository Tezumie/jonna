import assert from "node:assert/strict";
import { test } from "node:test";
import { agentIdFromLabel, headerValue, newAgentFile, setBody, setHeaderFields } from "./agentFile";
import { parseSubagentFile } from "./subagents";

const FILE = `---
name: tester
description: Runs the tests.
color: blue   # Claude Code's own key
tools:
  - Read
  - Bash
hooks:
  PreToolUse: x
---

Run the tests and report.
`;

test("agent files: fields change in place, unknown keys and comments stay", () => {
  const out = setHeaderFields(FILE, {
    label: "Test runner",
    role: "Tester",
    description: "Runs: the tests # all of them",
    tools: "read_file, run_command",
    hooks: null,
  });
  assert.match(out, /^name: tester$/m);
  assert.match(out, /^color: blue {3}# Claude Code's own key$/m);
  assert.match(out, /^description: "Runs: the tests # all of them"$/m);
  assert.match(out, /^tools: read_file, run_command$/m);
  assert.doesNotMatch(out, /- Read|hooks|PreToolUse/);
  assert.match(out, /^label: Test runner$/m);
  assert.match(out, /\nRun the tests and report\.\n$/);
  const def = parseSubagentFile(out, "project");
  assert.equal(def?.label, "Test runner");
  assert.equal(def?.role, "Tester");
  assert.equal(def?.description, "Runs: the tests # all of them");
  assert.deepEqual(def?.tools, ["read_file", "run_command"]);
});

test("agent files: the instructions are replaced, CRLF files stay CRLF", () => {
  const crlf = FILE.replace(/\n/g, "\r\n");
  const out = setBody(setHeaderFields(crlf, { icon: "blob-3-dots" }), "Line one\nLine two\n\n");
  assert.ok(!/[^\r]\n/.test(out), "every newline is CRLF");
  assert.match(out, /icon: blob-3-dots\r\n---\r\n\r\nLine one\r\nLine two\r\n$/);
  assert.equal(parseSubagentFile(out, "user")?.prompt, "Line one\r\nLine two");
});

test("agent files: values YAML would misread are quoted", () => {
  assert.equal(headerValue("plain words"), "plain words");
  assert.equal(headerValue("yes"), '"yes"');
  assert.equal(headerValue("- a list?"), '"- a list?"');
  assert.equal(headerValue('say "hi" #1'), '"say \\"hi\\" #1"');
  assert.equal(headerValue(""), '""');
  assert.equal(headerValue("two\nlines"), "two lines");
});

test("agent files: a new file parses back, ids come from labels", () => {
  const text = newAgentFile({
    name: "docs-writer",
    label: "Docs writer",
    role: "Docs",
    icon: "cloud-2-happy",
    description: "Writes and updates docs.",
    readOnly: true,
    instructions: "Keep it short.",
  });
  const def = parseSubagentFile(text, "user");
  assert.equal(def?.name, "docs-writer");
  assert.equal(def?.label, "Docs writer");
  assert.equal(def?.icon, "cloud-2-happy");
  assert.equal(def?.readOnly, true);
  assert.equal(def?.model, "inherit");
  assert.equal(def?.prompt, "Keep it short.");
  assert.equal(agentIdFromLabel("Test runner!"), "test-runner");
  assert.equal(agentIdFromLabel("Café Ünïcode"), "cafe-unicode");
  assert.equal(agentIdFromLabel("!!!"), "");
});
