import assert from "node:assert/strict";
import { test } from "node:test";
import { findMode, parseModes, permissionLevel, pickMode, writesWithoutAsking } from "./modes";

const claude = parseModes({
  modes: {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Default" },
      { id: "acceptEdits", name: "Accept Edits" },
      { id: "plan", name: "Plan Mode" },
      { id: "bypassPermissions", name: "Bypass Permissions" },
    ],
  },
});
const codex = parseModes({
  modes: {
    currentModeId: "auto",
    availableModes: [
      { id: "read-only", name: "Read Only" },
      { id: "auto", name: "Default" },
      { id: "full-access", name: "Full Access" },
    ],
  },
});

// What the real agents reported (October 2026, claude-agent-acp and codex-acp).
const claudeReal = parseModes({
  modes: {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Manual" },
      { id: "acceptEdits", name: "Accept edits" },
      { id: "plan", name: "Plan" },
      { id: "auto", name: "Auto" },
      { id: "bypassPermissions", name: "Bypass permissions" },
    ],
  },
});
const codexReal = parseModes({
  modes: {
    currentModeId: "agent",
    availableModes: [
      { id: "read-only", name: "Read-only" },
      { id: "workspace-write", name: "Workspace access" },
      { id: "agent", name: "Auto review" },
      { id: "agent-full-access", name: "Full access" },
    ],
  },
});

test("pickMode: the modes the real agents report", () => {
  assert.equal(pickMode(claudeReal, "ask"), null);
  assert.equal(pickMode(claudeReal, "edits"), "acceptEdits");
  assert.equal(pickMode(claudeReal, "full"), "bypassPermissions");
  // Codex starts in "agent" (Auto review), which never asked before a write.
  assert.equal(pickMode(codexReal, "ask"), "read-only");
  assert.equal(pickMode(codexReal, "edits"), null);
  assert.equal(pickMode(codexReal, "full"), "agent-full-access");
  assert.equal(findMode({ current: null, available: [{ id: "x", name: "X" }] }, "ask"), null);
});

test("parseModes reads ACP modes, null without any", () => {
  assert.equal(claude?.current, "default");
  assert.equal(claude?.available.length, 4);
  assert.equal(parseModes({}), null);
  assert.equal(parseModes({ modes: { availableModes: [] } }), null);
});

test("permissionLevel follows the review and run settings", () => {
  assert.equal(permissionLevel(true, "auto"), "ask");
  assert.equal(permissionLevel(false, "ask"), "ask");
  assert.equal(permissionLevel(false, "auto"), "edits");
  assert.equal(permissionLevel(true, "full"), "full");
});

test("pickMode: Claude Code and Codex modes per level, null when already there", () => {
  assert.equal(pickMode(claude, "ask"), null);
  assert.equal(pickMode(claude, "edits"), "acceptEdits");
  assert.equal(pickMode(claude, "full"), "bypassPermissions");
  // Codex's "auto" is named "Default", but the id wins for "ask": read-only asks before writing.
  assert.equal(pickMode(codex, "ask"), "read-only");
  assert.equal(pickMode(codex, "edits"), null);
  assert.equal(pickMode(codex, "full"), "full-access");
  assert.equal(pickMode({ current: null, available: [{ id: "x", name: "X" }] }, "ask"), null);
  assert.equal(pickMode(null, "ask"), null);
});

test("writesWithoutAsking: an agent that moves itself out of its asking mode", () => {
  assert.equal(writesWithoutAsking(claude, "bypassPermissions"), true);
  assert.equal(writesWithoutAsking(claude, "acceptEdits"), true);
  assert.equal(writesWithoutAsking(claude, "plan"), false);
  assert.equal(writesWithoutAsking(claude, "default"), false);
  assert.equal(writesWithoutAsking(codex, "full-access"), true);
  assert.equal(writesWithoutAsking(codexReal, "agent-full-access"), true);
  assert.equal(writesWithoutAsking(codex, "read-only"), false);
  assert.equal(writesWithoutAsking(claude, "nope"), false);
});
