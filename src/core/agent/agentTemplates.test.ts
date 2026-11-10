import assert from "node:assert/strict";
import { test } from "node:test";
import { setHeaderFields } from "./agentFile";
import {
  AGENT_TEMPLATES,
  accessFields,
  accessOf,
  EDIT_TOOLS,
  faceChoices,
  parseToolList,
  templateFile,
} from "./agentTemplates";
import { parseFace } from "./faces";
import { agentLabel, parseSubagentFile, READ_TOOLS } from "./subagents";

const FILE = `---
name: helper
description: Helps.
permissionMode: plan
color: blue
---

Help.
`;

test("access levels: read from a definition", () => {
  assert.equal(accessOf({ readOnly: true, tools: ["run_command"] }), "read");
  assert.equal(accessOf({}), "full");
  assert.equal(accessOf({ tools: ["read_file", "search"] }), "read");
  assert.equal(accessOf({ tools: [...EDIT_TOOLS].reverse() }), "edit");
  // A list of its own (a command but no edits) is neither.
  assert.equal(accessOf({ tools: ["read_file", "run_command"] }), null);
});

test("access levels: written to a file and read back", () => {
  for (const level of ["read", "edit", "full"] as const) {
    const text = setHeaderFields(FILE, accessFields(level, FILE));
    const def = parseSubagentFile(text, "project");
    assert.ok(def, level);
    assert.equal(accessOf(def), level);
    assert.match(text, /^color: blue$/m, "unknown keys stay");
  }
  // Leaving read-only drops permissionMode: plan, but another mode (Claude Code's) stays.
  assert.doesNotMatch(setHeaderFields(FILE, accessFields("full", FILE)), /permissionMode/);
  const accept = FILE.replace("permissionMode: plan", "permissionMode: acceptEdits");
  assert.match(
    setHeaderFields(accept, accessFields("edit", accept)),
    /^permissionMode: acceptEdits$/m,
  );
  assert.match(setHeaderFields(accept, accessFields("read", accept)), /^permissionMode: plan$/m);
});

test("tool lists: typed with commas, spaces or lines", () => {
  assert.deepEqual(parseToolList("read_file, search\nedit_file  read_file"), [
    "read_file",
    "search",
    "edit_file",
  ]);
  assert.deepEqual(parseToolList("  "), []);
});

test("templates: each one's file reads back as the agent it describes", () => {
  const ids = new Set<string>();
  for (const t of AGENT_TEMPLATES) {
    assert.ok(!ids.has(t.id), `${t.id} is unique`);
    ids.add(t.id);
    if (t.id === "blank") continue;
    assert.ok(t.label && t.description && t.instructions, t.id);
    assert.ok(t.description.length < 200, `${t.id}: the description stays short`);
    assert.ok(parseFace(t.icon), `${t.id}: a valid face`);
    const def = parseSubagentFile(templateFile(t, "x-agent"), "project");
    assert.ok(def, t.id);
    assert.equal(def.name, "x-agent");
    assert.equal(agentLabel(def), t.label);
    assert.equal(def.role, t.role);
    assert.equal(def.icon, t.icon);
    assert.equal(def.description, t.description);
    assert.equal(def.prompt, t.instructions.trim());
    assert.equal(accessOf(def), t.access, t.id);
    if (t.access === "read") assert.ok(def.readOnly);
  }
  // Read-only templates get only reading tools; every edit template's list is the edit set.
  assert.ok(EDIT_TOOLS.every((x) => READ_TOOLS.includes(x) || /_file$/.test(x)));
});

test("face choices: distinct shapes and eyes in one color, the current one first", () => {
  const current = { shape: "blob", color: 5, eyes: "wink" } as const;
  const faces = faceChoices(12, current);
  assert.equal(faces.length, 12);
  assert.deepEqual(faces[0], current);
  assert.ok(faces.every((f) => f.color === 5));
  assert.equal(new Set(faces.map((f) => `${f.shape}-${f.eyes}`)).size, 12);
  assert.equal(faceChoices(12).length, 12);
});
