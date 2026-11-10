import assert from "node:assert/strict";
import { test } from "node:test";
import { agentAsMode, modeAllows } from "./chatModes";
import {
  allowsSubagent,
  BUILTIN_SUBAGENTS,
  EXPLORE_ENTRY,
  isSubagent,
  mapTools,
  mergeSubagents,
  parseSubagentFile,
  resolveModelName,
  type SubagentDef,
  subagentFile,
  subagentsField,
  subagentTemplate,
  subagentTools,
} from "./subagents";

test("Claude Code's agent files read as ours", () => {
  const def = parseSubagentFile(
    "---\nname: code-reviewer\ndescription: Reviews code. Use proactively.\ntools: Read, Grep, Glob, Bash, Agent(x)\nmodel: sonnet\npermissionMode: plan\nmaxTurns: 12\n---\nYou review.\n",
    "project",
    "/p/.claude/agents/code-reviewer.md",
  );
  assert.deepEqual(def, {
    name: "code-reviewer",
    description: "Reviews code. Use proactively.",
    prompt: "You review.",
    tools: ["read_file", "search", "find_files", "run_command"],
    model: "sonnet",
    readOnly: true,
    maxSteps: 12,
    source: "project",
    path: "/p/.claude/agents/code-reviewer.md",
  });
  const listed = parseSubagentFile(
    "---\nname: a\ndescription: d\ntools:\n  - read_file\n  - edit_file\n---\nx",
    "user",
  );
  assert.deepEqual(listed?.tools, ["read_file", "edit_file"]);
  assert.equal(parseSubagentFile("no header", "user"), null);
  assert.equal(parseSubagentFile("---\nname: bad name\ndescription: d\n---\n", "user"), null);
  assert.equal(parseSubagentFile(subagentTemplate("helper", "Helps."), "user")?.model, "inherit");
  assert.deepEqual(mapTools(["Edit", "MultiEdit", "mcp__x__y", "mcp__gh__*"]), [
    "edit_file",
    "mcp__x__y",
    "mcp__gh",
  ]);
});

test("precedence, tools and models", () => {
  const mine: SubagentDef = {
    ...(BUILTIN_SUBAGENTS[1] as SubagentDef),
    name: "reviewer",
    source: "project" as const,
    prompt: "mine",
  };
  const merged = mergeSubagents([mine], BUILTIN_SUBAGENTS);
  assert.equal(merged.find((d) => d.name === "reviewer")?.prompt, "mine");
  assert.equal(merged.length, BUILTIN_SUBAGENTS.length);
  const all = [
    "read_file",
    "edit_file",
    "run_command",
    "delegate",
    "search",
    "ask_user",
    "run_workflow",
  ];
  const general = BUILTIN_SUBAGENTS.find((d) => d.name === "general");
  assert.ok(general);
  assert.deepEqual(subagentTools(general, all), [
    "read_file",
    "edit_file",
    "run_command",
    "search",
  ]);
  assert.deepEqual(subagentTools(general, all, true), ["read_file", "search"]);
  const keys = ["anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-5-5", "ollama/qwen3:8b"];
  assert.equal(resolveModelName("sonnet", keys), "anthropic/claude-sonnet-5-5");
  assert.equal(resolveModelName("qwen3:8b", keys), "ollama/qwen3:8b");
  assert.equal(resolveModelName("inherit", keys), null);
  assert.equal(resolveModelName("opus", keys), null);
});

test("audit cases: tool lists never widen, block values, newest version", () => {
  const only = parseSubagentFile(
    "---\nname: a\ndescription: d\ntools: WebFetch, mcp__x__y\n---\n",
    "user",
  );
  assert.deepEqual(only?.tools, ["mcp__x__y"]);
  const flush = parseSubagentFile("---\nname: a\ndescription: d\ntools:\n- Read\n---\n", "user");
  assert.deepEqual(flush?.tools, ["read_file"]);
  const block = parseSubagentFile(
    '---\nname: a\ndescription: >\n  Reviews code.\n  Use often.\nmodel: "x/y" # chosen\n---\n',
    "user",
  );
  assert.equal(block?.description, "Reviews code. Use often.");
  assert.equal(block?.model, "x/y");
  assert.equal(
    resolveModelName("sonnet", ["a/claude-sonnet-4-5-20250929", "a/claude-sonnet-4-6"]),
    "a/claude-sonnet-4-6",
  );
});

test("per-agent MCP tools and permission keys (D245)", () => {
  const def = parseSubagentFile(
    [
      "---",
      "name: a",
      "description: d",
      "tools: Read, Bash, mcp__gh",
      "disallowedTools: Bash, mcp__gh__delete_repo",
      "permissionMode: acceptEdits",
      "---",
      "",
    ].join("\n"),
    "user",
  );
  assert.ok(def);
  assert.deepEqual(def.disallowedTools, ["run_command", "mcp__gh__delete_repo"]);
  assert.equal(def.acceptEdits, true);
  assert.equal(def.readOnly, undefined);
  const available = [
    "read_file",
    "run_command",
    "mcp__gh__create_issue",
    "mcp__gh__delete_repo",
    "mcp__db__q",
  ];
  assert.deepEqual(subagentTools(def, available), ["read_file", "mcp__gh__create_issue"]);
  const mode = agentAsMode(def, ["read_file"]);
  assert.equal(mode.acceptEdits, true);
  assert.equal(modeAllows(mode, { name: "mcp__gh__create_issue", readOnly: false }), true);
  assert.equal(modeAllows(mode, { name: "mcp__gh__delete_repo", readOnly: false }), false);
  assert.equal(modeAllows(mode, { name: "run_command", readOnly: false }), false);
});

test("an agent's start mode (D249): mode: plan / ask, the team's defaults", async () => {
  const { newAgentFile } = await import("./agentFile");
  const { BUILT_IN_AGENTS, TEAM_START_MODES } = await import("./builtInAgents");
  const file = newAgentFile({
    name: "scout",
    description: "Looks around.",
    instructions: "Look.",
    startMode: "ask",
  });
  assert.match(file, /\nmode: ask\n/);
  const def = parseSubagentFile(file, "user");
  assert.equal(def?.startMode, "ask");
  assert.equal(def && agentAsMode(def, []).startMode, "ask");
  // Agent is the default: not written, not carried.
  assert.doesNotMatch(
    newAgentFile({ ...def, instructions: "x", startMode: "agent" } as never),
    /mode: agent/,
  );
  const plain = parseSubagentFile(file.replace("mode: ask", "mode: agent"), "user");
  assert.equal(plain && agentAsMode(plain, []).startMode, undefined);
  // Something else isn't a mode.
  assert.equal(
    parseSubagentFile(file.replace("mode: ask", "mode: wild"), "user")?.startMode,
    undefined,
  );
  // The planner plans and Chat answers; their files say so.
  assert.deepEqual(TEAM_START_MODES, { planner: "plan", chat: "ask" });
  const planner = BUILT_IN_AGENTS.find((a) => a.name === "planner");
  assert.equal(planner && parseSubagentFile(planner.text, "user")?.startMode, "plan");
});

test("the team shows its models' logos (D270); a file still on its first face moves once", async () => {
  const { BUILT_IN_AGENTS, withTeamModelIcon } = await import("./builtInAgents");
  for (const a of BUILT_IN_AGENTS) assert.match(a.text, /\nicon: model\n/);
  const planner = BUILT_IN_AGENTS.find((a) => a.name === "planner")?.text ?? "";
  const old = planner.replace("icon: model", "icon: squircle-2-wide");
  assert.match(withTeamModelIcon("planner", old) ?? "", /\nicon: model\n/);
  // A face the user picked, another agent, or one already moved: left alone.
  assert.equal(
    withTeamModelIcon("planner", planner.replace("icon: model", "icon: blob-4-dots")),
    null,
  );
  assert.equal(withTeamModelIcon("reviewer", old), null);
  assert.equal(withTeamModelIcon("planner", planner), null);
});

test("the default team (D272): Plato plans, Gabby answers, named for their modes", async () => {
  const { BUILT_IN_AGENTS, TEAM_START_MODES } = await import("./builtInAgents");
  assert.deepEqual(
    BUILT_IN_AGENTS.map((a) => [a.name, a.label, a.role]),
    [
      ["planner", "Plato", "Plan"],
      ["chat", "Gabby", "Ask"],
    ],
  );
  assert.deepEqual(TEAM_START_MODES, { planner: "plan", chat: "ask" });
  for (const a of BUILT_IN_AGENTS) {
    const def = parseSubagentFile(a.text, "user");
    assert.equal(def?.label, a.label);
    assert.equal(def?.role, a.role);
    assert.doesNotMatch(a.text, /@Builder/);
  }
});

test("an agent's effort and access picked for it (D273): the pick beats its file", async () => {
  const { withAccess, effortLabel } = await import("./chatModes");
  const planner = parseSubagentFile(
    "---\nname: planner\ndescription: d\npermissionMode: plan\n---\nPlan.",
    "user",
  );
  assert.ok(planner);
  assert.equal(agentAsMode(planner, ["read_file"]).readOnly, true);
  // Accept edits: it may edit now, and its edits are kept.
  const editing = agentAsMode({ ...withAccess(planner, "edit"), effort: "high" }, ["read_file"]);
  assert.equal(editing.readOnly, undefined);
  assert.equal(editing.acceptEdits, true);
  assert.equal(editing.tools, null);
  assert.equal(editing.effort, "high");
  // Read only: only the reading tools, edits never kept.
  const reading = agentAsMode(
    withAccess({ ...planner, readOnly: false, acceptEdits: true }, "read"),
    ["read_file"],
  );
  assert.deepEqual(reading.tools, ["read_file"]);
  assert.equal(reading.acceptEdits, undefined);
  // No pick: its file's; "default" effort isn't carried.
  assert.equal(withAccess(planner, undefined), planner);
  assert.equal(agentAsMode({ ...planner, effort: "default" }, []).effort, undefined);
  assert.equal(effortLabel("xhigh"), "Extra high");
  assert.equal(effortLabel("default"), "Model default");
});

test("agents and subagents (D288): the kind, Customize's file, no handing off inside", () => {
  const reviewer = BUILTIN_SUBAGENTS.find((d) => d.name === "reviewer");
  assert.ok(reviewer);
  // Built in, or a file from Claude Code's folder: a subagent; an agents folder's file: an agent.
  assert.equal(isSubagent(reviewer), true);
  assert.equal(isSubagent(EXPLORE_ENTRY), true);
  assert.equal(isSubagent({ source: "project", kind: "subagent" }), true);
  assert.equal(isSubagent({ source: "user", kind: "agent" }), false);
  assert.equal(isSubagent({ source: "user" }), false);
  // Customize: its copy reads back as it is (label, read-only, steps), now from the project.
  const copy = parseSubagentFile(
    subagentFile(reviewer),
    "project",
    "/p/.claude/agents/reviewer.md",
  );
  assert.ok(copy);
  assert.equal(copy.name, "reviewer");
  assert.equal(copy.label, "Review");
  assert.equal(copy.description, reviewer.description);
  assert.equal(copy.prompt, reviewer.prompt);
  assert.equal(copy.readOnly, true);
  assert.equal(copy.maxSteps, reviewer.maxSteps);
  assert.equal(copy.model, "inherit");
  const plan = BUILTIN_SUBAGENTS.find((d) => d.name === "plan");
  assert.ok(plan);
  assert.equal(parseSubagentFile(subagentFile(plan), "user")?.omitRules, true);
  // Explore has no prompt of its own: its copy gets one to fill in.
  assert.match(parseSubagentFile(subagentFile(EXPLORE_ENTRY), "user")?.prompt ?? "", /explore/);
  // A subagent works privately: it never hands the chat on or runs subagents itself.
  const general = BUILTIN_SUBAGENTS.find((d) => d.name === "general");
  assert.ok(general);
  assert.deepEqual(subagentTools(general, ["read_file", "hand_off", "delegate", "edit_file"]), [
    "read_file",
    "edit_file",
  ]);
});

test("an agent's own subagents (D288): `subagents:` read, written, and Explore denied", () => {
  const read = (v: string) =>
    parseSubagentFile(`---\nname: gabby\ndescription: d\nsubagents: ${v}\n---\nHi.`, "user");
  assert.deepEqual(read("explore, reviewer")?.subagents, ["explore", "reviewer"]);
  assert.deepEqual(read("none")?.subagents, []);
  assert.equal(read("*")?.subagents, undefined);
  const plain = parseSubagentFile("---\nname: a\ndescription: d\n---\n", "user");
  assert.equal(plain?.subagents, undefined);
  assert.equal(allowsSubagent(undefined, "plan"), true);
  assert.equal(allowsSubagent({ subagents: ["Plan"] }, "plan"), true);
  assert.equal(allowsSubagent({ subagents: [] }, "plan"), false);
  const all = ["explore", "plan", "reviewer"];
  assert.equal(subagentsField(["reviewer", "plan", "explore"], all), null);
  assert.equal(subagentsField([], all), "none");
  assert.equal(subagentsField(["plan"], all), "plan");
  // Explore is a tool: an agent not allowed it doesn't get it; allowed, or no list, it does.
  const gabby = read("plan");
  assert.ok(gabby);
  assert.equal(modeAllows(agentAsMode(gabby, []), { name: "explore", readOnly: true }), false);
  const open = read("explore");
  assert.ok(open);
  assert.equal(modeAllows(agentAsMode(open, []), { name: "explore", readOnly: true }), true);
});

test("the guide subagent (D333) reads the guide, read-only, in the background too", () => {
  const guide = BUILTIN_SUBAGENTS.find((d) => d.name === "guide");
  assert.ok(guide?.readOnly);
  const available = [
    "read_guide",
    "find_commands",
    "get_state",
    "read_file",
    "edit_file",
    "wrap_up",
  ];
  assert.deepEqual(subagentTools(guide as SubagentDef, available), [
    "read_guide",
    "find_commands",
    "get_state",
  ]);
  assert.deepEqual(subagentTools(guide as SubagentDef, available, true), [
    "read_guide",
    "find_commands",
    "get_state",
  ]);
  // A turn's own tools never go to a subagent (D329, D332).
  const all: SubagentDef = { name: "x", description: "", prompt: "", source: "project" };
  assert.deepEqual(subagentTools(all, ["read_file", "hand_off_task", "schedule_wakeup"]), [
    "read_file",
  ]);
});
