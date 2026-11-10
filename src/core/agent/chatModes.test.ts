import assert from "node:assert/strict";
import { test } from "node:test";
import {
  customModeId,
  findCustomMode,
  mergeModes,
  modeAllows,
  modeTemplate,
  parseModeFile,
  parseModeSetting,
} from "./chatModes";

test("parseModeFile reads Copilot's chat mode files", () => {
  const m = parseModeFile(
    "review.chatmode.md",
    "---\ndescription: Review changes\ntools: ['codebase', 'search']\nmodel: openai/gpt-5\n---\n\nReview, don't edit.\n",
    ".github/chatmodes/review.chatmode.md",
  );
  assert.deepEqual(m, {
    name: "review",
    description: "Review changes",
    instructions: "Review, don't edit.",
    tools: ["codebase", "search"],
    model: "openai/gpt-5",
    source: ".github/chatmodes/review.chatmode.md",
  });
  assert.equal(parseModeFile("x.agent.md", "Just instructions.", "s")?.tools, null);
  assert.equal(
    parseModeFile("x.agent.md", "---\nname: Docs writer\n---\nWrite docs.", "s")?.name,
    "Docs writer",
  );
  assert.equal(parseModeFile("empty.chatmode.md", "---\ndescription: x\n---\n", "s"), null);
  // The template parses into a mode.
  assert.deepEqual(parseModeFile("t.chatmode.md", modeTemplate("T"), "s")?.tools, ["read", "edit"]);
});

test("parseModeSetting and mergeModes: the user's first, built-in names kept", () => {
  const user = parseModeSetting([
    { name: "Review", instructions: "Look only.", tools: ["read"] },
    { name: "", instructions: "x" },
    { name: "Ask", instructions: "clash with a built-in" },
    "junk",
  ]);
  assert.deepEqual(
    user.map((m) => m.name),
    ["Review", "Ask"],
  );
  const folder = [parseModeFile("review.chatmode.md", "Other review", "f")].filter(
    (m) => m !== null,
  );
  const all = mergeModes(user, folder);
  assert.deepEqual(
    all.map((m) => [m.name, m.source]),
    [["Review", "user settings"]],
  );
  assert.equal(findCustomMode(all, customModeId("Review"))?.name, "Review");
  assert.equal(findCustomMode(all, "agent"), undefined);
});

test("modeAllows: groups, Claude Code's and Copilot's names, MCP", () => {
  const mode = (tools: string[] | null) => ({
    name: "m",
    description: "",
    instructions: "x",
    tools,
    model: null,
    source: "s",
  });
  const read = { name: "read_file", readOnly: true };
  const edit = { name: "edit_file", readOnly: false };
  const run = { name: "run_command", readOnly: false };
  const mcp = { name: "mcp__github__issues", readOnly: false };
  assert.ok(modeAllows(mode(null), run));
  assert.ok(modeAllows(mode(["codebase"]), read));
  assert.ok(!modeAllows(mode(["codebase"]), edit));
  assert.ok(modeAllows(mode(["editFiles"]), edit));
  assert.ok(modeAllows(mode(["Bash"]), run));
  assert.ok(modeAllows(mode(["run_command"]), run));
  assert.ok(!modeAllows(mode(["read", "edit"]), run));
  assert.ok(modeAllows(mode(["mcp"]), mcp));
  assert.ok(!modeAllows(mode(["read"]), mcp));
});
