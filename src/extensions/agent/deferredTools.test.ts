import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "../../core/agent/conversation";
import { loadedToolNames, TOOL_SEARCH, withLoadedTools } from "../../core/agent/toolSearch";
import type { WorkbenchServices } from "../../workbench/services";
import {
  deferredNote,
  deferredState,
  loadedTools,
  notLoaded,
  splitDeferred,
} from "./deferredTools";
import type { AgentTool, ToolHost } from "./tools";

const services = (mode: string) =>
  ({
    settings: { peek: (key: string) => (key === "agent.deferTools" ? mode : undefined) },
  }) as unknown as WorkbenchServices;

const tool = (name: string, mcp = false): AgentTool => ({
  spec: { name, description: `${name} does things.`, parameters: { type: "object" } },
  readOnly: true,
  ...(mcp && { mcp: true as const }),
  verb: name,
  target: () => "",
  run: async () => ({ result: "ran" }),
});

const TOOLS = [
  tool("read_file"),
  tool("mcp__echo__echo", true),
  tool("mcp__echo__ask", true),
  tool("web_search"),
];
const names = (tools: readonly AgentTool[]) => tools.map((t) => t.spec.name);

test("never, or few tools on auto: nothing deferred", () => {
  for (const mode of ["never", "auto"]) {
    const split = splitDeferred(services(mode), TOOLS, []);
    assert.deepEqual(names(split.tools), names(TOOLS));
    assert.equal(split.deferred.length, 0);
    assert.equal(deferredNote(split), "");
  }
});

test("a chat defers, loads with tool_search, and a rewind unloads", async () => {
  const items: Item[] = [];
  let split = splitDeferred(services("always"), TOOLS, items);
  // tool_search where the first MCP tool was; the MCP tools only named.
  assert.deepEqual(names(split.tools), ["read_file", TOOL_SEARCH, "web_search"]);
  assert.deepEqual(names(split.deferred), ["mcp__echo__echo", "mcp__echo__ask"]);
  assert.match(deferredNote(split), /- mcp__echo__echo: mcp__echo__echo does things\./);
  assert.match(notLoaded(split, "mcp__echo__echo")?.result ?? "", /select:mcp__echo__echo/);
  assert.equal(notLoaded(split, "read_file"), null);
  assert.deepEqual(deferredState({ splitTools: () => split, items }), {
    deferredTools: ["mcp__echo__echo", "mcp__echo__ask"],
    loadedTools: [],
  });
  // The model searches.
  const search = split.tools.find((t) => t.spec.name === TOOL_SEARCH);
  const outcome = await search?.run({ query: "select:mcp__echo__echo" }, {} as ToolHost, "i1");
  assert.equal(outcome?.summary, "1 loaded");
  const turn = split.tools.map((t) => t.spec);
  items.push({
    type: "tool",
    id: "i1",
    callId: "c1",
    name: TOOL_SEARCH,
    args: {},
    status: "done",
    result: outcome?.result ?? "",
  });
  split = splitDeferred(services("always"), TOOLS, items);
  assert.deepEqual(names(split.tools), ["read_file", TOOL_SEARCH, "mcp__echo__echo", "web_search"]);
  assert.deepEqual(names(split.deferred), ["mcp__echo__ask"]);
  assert.equal(notLoaded(split, "mcp__echo__echo"), null);
  // The turn's list keeps its order and gains the loaded tool at the end.
  assert.deepEqual(
    withLoadedTools(
      turn,
      split.tools.map((t) => t.spec),
      loadedToolNames(items),
    ).map((t) => t.name),
    ["read_file", TOOL_SEARCH, "web_search", "mcp__echo__echo"],
  );
  // Rewound past the search: deferred again.
  items.length = 0;
  assert.equal(splitDeferred(services("always"), TOOLS, items).deferred.length, 2);
  // An empty query is an error, no match says what's deferred.
  assert.equal((await search?.run({}, {} as ToolHost, "i2"))?.isError, true);
  const none = await search?.run({ query: "zzz" }, {} as ToolHost, "i3");
  assert.match(none?.result ?? "", /Deferred tools: mcp__echo__echo, mcp__echo__ask/);
});

test("the IDE's rarely used tools load on demand; called by name, they run and stay (D390)", () => {
  const tools = [tool("read_file"), tool("generate_image"), tool("schedule"), tool("web_search")];
  const items: Item[] = [];
  // On auto, with no MCP tools: the on-demand ones are deferred all the same.
  let split = splitDeferred(services("auto"), tools, items);
  assert.deepEqual(names(split.tools), ["read_file", TOOL_SEARCH, "web_search"]);
  assert.deepEqual(names(split.deferred), ["generate_image", "schedule"]);
  assert.match(deferredNote(split), /- generate_image: generate_image does things\./);
  // Called without a search, it runs (no "not loaded" error)…
  assert.equal(notLoaded(split, "generate_image"), null);
  items.push({
    type: "tool",
    id: "i1",
    callId: "c1",
    name: "generate_image",
    args: {},
    status: "done",
    result: "made img1",
  });
  // …and is part of the chat's tools from then on.
  assert.deepEqual([...loadedTools(items)], ["generate_image"]);
  split = splitDeferred(services("auto"), tools, items);
  assert.deepEqual(names(split.tools), ["read_file", TOOL_SEARCH, "generate_image", "web_search"]);
  assert.deepEqual(names(split.deferred), ["schedule"]);
  // never: everything is sent, nothing named.
  split = splitDeferred(services("never"), tools, []);
  assert.deepEqual(names(split.tools), names(tools));
  assert.equal(deferredNote(split), "");
});
