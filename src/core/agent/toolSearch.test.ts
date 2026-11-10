import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolSpec } from "../ipc/agent";
import {
  AUTO_TOOL_COUNT,
  deferMode,
  deferredToolsNote,
  functionBlock,
  loadedToolNames,
  notLoadedMessage,
  parseToolQuery,
  searchTools,
  shortDescription,
  shouldDefer,
  TOOL_SEARCH,
  toolSearchResult,
  withLoadedTools,
} from "./toolSearch";

const spec = (name: string, description = "", parameters: unknown = { type: "object" }) =>
  ({ name, description, parameters }) satisfies ToolSpec;

const TOOLS = [
  spec("mcp__github__create_issue", "[MCP github] Create an issue in a repository."),
  spec("mcp__github__list_issues", "[MCP github] List issues."),
  spec("mcp__slack__send_message", "[MCP slack] Send a message to a channel."),
  spec("mcp__slack__list_channels", "[MCP slack] List channels."),
  spec("mcp__jupyter__runCell", "[MCP jupyter] Run a notebook cell."),
];

test("modes: the setting, D204's old one, and the threshold", () => {
  assert.equal(deferMode("always"), "always");
  assert.equal(deferMode("never", "onDemand"), "never");
  assert.equal(deferMode("auto", "onDemand"), "always");
  assert.equal(deferMode(undefined, "full"), "never");
  assert.equal(deferMode("weird"), "auto");
  assert.equal(shouldDefer("always", 0, 0), false);
  assert.equal(shouldDefer("always", 1, 10), true);
  assert.equal(shouldDefer("never", 500, 1e6), false);
  assert.equal(shouldDefer("auto", AUTO_TOOL_COUNT, 100), false);
  assert.equal(shouldDefer("auto", AUTO_TOOL_COUNT + 1, 100), true);
  assert.equal(shouldDefer("auto", 3, 30_000), true);
});

test("parsing: select:, keywords and +required", () => {
  assert.deepEqual(parseToolQuery("select: a , b,,"), { kind: "select", names: ["a", "b"] });
  assert.deepEqual(parseToolQuery("SELECT:x"), { kind: "select", names: ["x"] });
  assert.deepEqual(parseToolQuery(" +Slack send  message "), {
    kind: "keywords",
    required: ["slack"],
    terms: ["send", "message"],
  });
  assert.deepEqual(parseToolQuery("+"), { kind: "keywords", required: [], terms: [] });
});

test("select: exact names (case-insensitive), unknown ones with suggestions", () => {
  const r = searchTools("select:mcp__github__create_issue,MCP__SLACK__SEND_MESSAGE,issue", TOOLS);
  assert.deepEqual(
    r.matches.map((t) => t.name),
    ["mcp__github__create_issue", "mcp__slack__send_message"],
  );
  assert.deepEqual(r.unknown, ["issue"]);
  assert.deepEqual(r.suggestions, ["mcp__github__create_issue", "mcp__github__list_issues"]);
});

test("keywords: ranked by name words, then name and description", () => {
  const r = searchTools("notebook cell", TOOLS);
  assert.equal(r.matches[0]?.name, "mcp__jupyter__runCell");
  const list = searchTools("list", TOOLS, 1);
  assert.equal(list.matches.length, 1);
  // A word in the name beats one in the description only.
  const issue = searchTools("issue", TOOLS);
  assert.deepEqual(
    issue.matches.map((t) => t.name),
    ["mcp__github__create_issue", "mcp__github__list_issues"],
  );
  assert.equal(searchTools("nothing here", TOOLS).matches.length, 0);
  // An exact name as the query.
  assert.deepEqual(
    searchTools("mcp__slack__list_channels", TOOLS).matches.map((t) => t.name),
    ["mcp__slack__list_channels"],
  );
});

test("+required: in the name, ranked by the rest; alone, all that have it", () => {
  const r = searchTools("+slack send", TOOLS);
  assert.deepEqual(
    r.matches.map((t) => t.name),
    ["mcp__slack__send_message"],
  );
  assert.deepEqual(
    searchTools("+slack", TOOLS).matches.map((t) => t.name),
    ["mcp__slack__list_channels", "mcp__slack__send_message"],
  );
  assert.equal(searchTools("+github send", TOOLS).matches.length, 0);
});

test("the result carries definitions that read back as loaded; rewinds unload", () => {
  const found = searchTools("select:mcp__slack__send_message", TOOLS);
  const text = toolSearchResult("select:mcp__slack__send_message", found, []);
  assert.match(text, /<function>\{"name":"mcp__slack__send_message","description"/);
  assert.match(text, /Loaded: mcp__slack__send_message/);
  const items = [
    { type: "tool", name: TOOL_SEARCH, status: "done", result: text },
    {
      type: "tool",
      name: TOOL_SEARCH,
      status: "error",
      result: functionBlock(TOOLS[0] as ToolSpec),
    },
    {
      type: "tool",
      name: "read_file",
      status: "done",
      result: functionBlock(TOOLS[1] as ToolSpec),
    },
    { type: "user" },
  ];
  assert.deepEqual([...loadedToolNames(items)], ["mcp__slack__send_message"]);
  assert.equal(loadedToolNames(items.slice(1)).size, 0);
  const none = toolSearchResult("zzz", searchTools("zzz", TOOLS), ["a", "b"]);
  assert.match(none, /No deferred tool matches "zzz"\. Deferred tools: a, b\./);
  const unknown = toolSearchResult("select:x", searchTools("select:x", TOOLS), []);
  assert.match(unknown, /Not deferred tools: x\./);
});

test("the turn's list keeps its order and adds what was loaded", () => {
  const turn = [spec("read_file"), spec(TOOL_SEARCH)];
  const current = [spec("read_file"), spec(TOOL_SEARCH), ...TOOLS];
  assert.equal(withLoadedTools(turn, current, new Set()), turn);
  assert.deepEqual(
    withLoadedTools(turn, current, new Set(["mcp__slack__send_message", "gone"])).map(
      (t) => t.name,
    ),
    ["read_file", TOOL_SEARCH, "mcp__slack__send_message"],
  );
});

test("the note and the error say how to load", () => {
  assert.equal(deferredToolsNote([]), "");
  const note = deferredToolsNote(TOOLS.slice(0, 1));
  assert.match(
    note,
    /- mcp__github__create_issue: \[MCP github\] Create an issue in a repository\./,
  );
  assert.match(notLoadedMessage("mcp__x__y"), /tool_search \{"query": "select:mcp__x__y"\}/);
  assert.equal(shortDescription("One. Two."), "One.");
  assert.equal(shortDescription("x".repeat(100), 10).length, 10);
});
