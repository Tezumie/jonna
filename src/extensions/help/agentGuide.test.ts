import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_GUIDE_TOPICS, agentGuide } from "./agentGuide";

const facts = { workspaceFolder: ".acme" };

test("agent guide: the overview says how to reach the IDE and points at the topics", () => {
  const text = agentGuide(undefined, facts);
  assert.match(text, /not VS Code/);
  assert.match(text, /ide_find_commands/);
  assert.match(text, /help\.readDocs/);
  assert.match(text, /\.acme\//);
  assert.match(text, /"topic": "extensions"/);
});

test("agent guide: extensions cover the formats, the checks, the log and updating", () => {
  const text = agentGuide("extensions", facts);
  for (const needle of [
    "extensions.guide",
    "choosing-a-format",
    '"host": "node"',
    'require("vscode")',
    "extensions.create",
    "extensions.loadUnpacked",
    "extensions.installFromFolder",
    "extensions.installPermanently",
    "extensions.copyForDevelopment",
    "ide://extensions?id=<id>",
    "extensions.try",
    ".acme/extensions/<name>",
  ])
    assert.ok(text.includes(needle), needle);
  assert.deepEqual([...AGENT_GUIDE_TOPICS], ["extensions"]);
});
