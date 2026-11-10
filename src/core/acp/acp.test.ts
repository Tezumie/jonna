import assert from "node:assert/strict";
import { test } from "node:test";
import { Emitter } from "../events/index";
import { RpcConnection } from "../lsp/jsonrpc";
import {
  AcpClient,
  type AcpHost,
  parseAvailableCommands,
  parseSettings,
  type SessionUpdate,
} from "./client";

function pipe() {
  const a = new Emitter<string>();
  const b = new Emitter<string>();
  return {
    client: { send: (m: string) => queueMicrotask(() => b.fire(m)), onMessage: a.event },
    server: { send: (m: string) => queueMicrotask(() => a.fire(m)), onMessage: b.event },
  };
}

test("a prompt turn: updates, file read/write, permission", async () => {
  const { client, server } = pipe();
  const agent = new RpcConnection(server);
  agent.onRequest("initialize", (p) => ({
    protocolVersion: (p as { protocolVersion: number }).protocolVersion,
    agentCapabilities: {},
    authMethods: [],
    agentInfo: { name: "fake" },
  }));
  agent.onRequest("session/new", () => ({ sessionId: "s1" }));
  agent.onRequest("session/prompt", async () => {
    agent.notify("session/update", {
      sessionId: "s1",
      update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } },
    });
    const read = await agent.request<{ content: string }>("fs/read_text_file", {
      sessionId: "s1",
      path: "/w/a.txt",
    });
    agent.notify("session/update", {
      sessionId: "s1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Edit a.txt",
        kind: "edit",
        status: "pending",
      },
    });
    const perm = await agent.request<{ outcome: { outcome: string; optionId?: string } }>(
      "session/request_permission",
      {
        sessionId: "s1",
        toolCall: { toolCallId: "t1" },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      },
    );
    if (perm.outcome.optionId === "yes")
      await agent.request("fs/write_text_file", {
        sessionId: "s1",
        path: "/w/a.txt",
        content: `${read.content}!`,
      });
    agent.notify("session/update", {
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
    });
    return { stopReason: "end_turn" };
  });
  const updates: SessionUpdate[] = [];
  const written: string[] = [];
  const host: AcpHost = {
    update: (_s, u) => updates.push(u),
    requestPermission: async (p) => ({
      outcome: "selected",
      optionId: p.options[0]?.optionId ?? "",
    }),
    readTextFile: async () => "hello",
    writeTextFile: async (p) => {
      written.push(p.content);
    },
    createTerminal: async () => "t",
    terminalOutput: () => ({ output: "", truncated: false, exitStatus: null }),
    waitForTerminalExit: async () => ({ exitCode: 0, signal: null }),
    killTerminal: () => {},
    releaseTerminal: () => {},
  };
  const c = new AcpClient(client, host);
  await c.initialize("test");
  assert.equal(c.agentName, "fake");
  const sid = await c.newSession("/w");
  assert.equal(await c.prompt(sid, [{ type: "text", text: "add !" }]), "end_turn");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(written, ["hello!"]);
  assert.deepEqual(
    updates.map((u) => u.sessionUpdate),
    ["agent_thought_chunk", "tool_call", "agent_message_chunk"],
  );
});

test("the agent's models and reasoning levels: config options, or the older models list", async () => {
  const settings = parseSettings({
    configOptions: [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "x",
        options: [],
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "sonnet",
        options: [
          {
            group: "anthropic",
            name: "Anthropic",
            options: [{ value: "sonnet", name: "Sonnet (recommended)" }],
          },
          { group: "other", name: "Other", options: [{ value: "opus" }] },
        ],
      },
      {
        id: "effort",
        name: "Effort",
        category: "thought_level",
        type: "select",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      },
      { id: "flag", name: "Flag", category: "model", type: "boolean", currentValue: true },
    ],
  });
  assert.deepEqual(
    settings.map((s) => [s.configId, s.category, s.current, s.options.map((o) => o.id)]),
    [
      ["model", "model", "sonnet", ["sonnet", "opus"]],
      ["effort", "thought_level", "high", ["low", "high"]],
    ],
  );
  assert.equal(settings[0]?.options[1]?.name, "opus");
  assert.equal(settings[0]?.options[0]?.name, "Sonnet");
  assert.equal(settings[0]?.options[0]?.group, "Anthropic");
  const legacy = parseSettings({
    models: {
      currentModelId: "b",
      availableModels: [{ modelId: "a" }, { modelId: "b", name: "B" }],
    },
  });
  assert.deepEqual(legacy[0], {
    configId: null,
    name: "Model",
    category: "model",
    current: "b",
    options: [
      { id: "a", name: "a" },
      { id: "b", name: "B" },
    ],
  });

  // Changing them over the wire.
  const { client, server } = pipe();
  const agent = new RpcConnection(server);
  agent.onRequest("initialize", () => ({ protocolVersion: 1 }));
  agent.onRequest("session/new", () => ({
    sessionId: "s1",
    models: { currentModelId: "a", availableModels: [{ modelId: "a" }, { modelId: "b" }] },
  }));
  const calls: unknown[] = [];
  agent.onRequest("session/set_model", (p) => {
    calls.push(p);
    return {};
  });
  const host = { update: () => {} } as unknown as AcpHost;
  const c = new AcpClient(client, host);
  await c.initialize("test");
  const sid = await c.newSession("/w");
  const model = c.settings[0];
  assert.ok(model);
  const after = await c.setSetting(sid, model, "b");
  assert.equal(after[0]?.current, "b");
  assert.deepEqual(calls, [{ sessionId: "s1", modelId: "b" }]);
});

test("session/load and the agent's slash commands (D200)", async () => {
  const { client, server } = pipe();
  const agent = new RpcConnection(server);
  agent.onRequest("initialize", () => ({
    protocolVersion: 1,
    agentCapabilities: { loadSession: true },
  }));
  let loaded: unknown = null;
  agent.onRequest("session/load", (p) => {
    loaded = p;
    agent.notify("session/update", {
      sessionId: "old",
      update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } },
    });
    return { configOptions: [] };
  });
  const updates: string[] = [];
  const host = {
    update: (_s: string, u: SessionUpdate) => updates.push(u.sessionUpdate),
  } as unknown as AcpHost;
  const c = new AcpClient(client, host);
  await c.initialize("test");
  assert.equal(c.canLoadSession, true);
  await c.loadSession("old", "/w");
  assert.deepEqual(loaded, { sessionId: "old", cwd: "/w", mcpServers: [] });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(updates, ["user_message_chunk"]);
  assert.deepEqual(
    parseAvailableCommands({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "web", description: "Search the web", input: { hint: "query" } },
        { name: "/plan", description: "Plan" },
        { name: "web", description: "duplicate" },
        { name: "bad name", description: "x" },
        { description: "no name" },
      ],
    }),
    [
      { name: "web", description: "Search the web", hint: "query" },
      { name: "plan", description: "Plan" },
    ],
  );
  assert.deepEqual(parseAvailableCommands({}), []);
});
