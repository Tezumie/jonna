import assert from "node:assert/strict";
import { test } from "node:test";
import { Emitter } from "../events/index";
import { RpcConnection } from "../lsp/jsonrpc";
import { agentToolName, McpClient } from "./client";

function pipe() {
  const a = new Emitter<string>();
  const b = new Emitter<string>();
  return {
    client: { send: (m: string) => queueMicrotask(() => b.fire(m)), onMessage: a.event },
    server: { send: (m: string) => queueMicrotask(() => a.fire(m)), onMessage: b.event },
  };
}

test("initialize, paged tools/list, tools/call", async () => {
  const { client, server } = pipe();
  const s = new RpcConnection(server);
  let initialized = false;
  s.onRequest("initialize", () => ({
    protocolVersion: "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: {
      name: "files",
      icons: [{ src: "https://files.dev/icon.png", sizes: ["48x48"] }, { src: "file:///x.png" }],
    },
  }));
  s.onNotification("notifications/initialized", () => {
    initialized = true;
  });
  s.onRequest("tools/list", (p) =>
    (p as { cursor?: string }).cursor
      ? { tools: [{ name: "write", annotations: { destructiveHint: true } }] }
      : { tools: [{ name: "read", annotations: { readOnlyHint: true } }], nextCursor: "2" },
  );
  s.onRequest("tools/call", (p) => {
    const { name, arguments: args } = p as { name: string; arguments: { x: number } };
    // An image tool (D381): an image part and an embedded image resource.
    if (name === "draw")
      return {
        content: [
          { type: "text", text: "drew" },
          { type: "image", mimeType: "image/jpeg", data: "/9j/" },
          { type: "resource", resource: { uri: "x.png", mimeType: "image/png", blob: "iVBO" } },
          { type: "audio", data: "x" },
        ],
      };
    return { content: [{ type: "text", text: `${name}:${args.x}` }], isError: false };
  });
  const c = new McpClient(client, "test");
  await c.start();
  assert.equal(initialized, true);
  assert.equal(c.serverName, "files");
  // serverInfo.icons (2025-11-25): only what the IDE shows.
  assert.deepEqual(c.serverIcons, [{ src: "https://files.dev/icon.png", sizes: ["48x48"] }]);
  assert.deepEqual(
    c.tools.map((t) => t.name),
    ["read", "write"],
  );
  assert.deepEqual(await c.call("read", { x: 1 }), { text: "read:1", isError: false });
  assert.deepEqual(await c.call("draw", {}), {
    text: "drew\n[audio]",
    isError: false,
    images: [
      { mime: "image/jpeg", data: "/9j/" },
      { mime: "image/png", data: "iVBO" },
    ],
  });
  assert.equal(agentToolName("my server", "do.thing"), "mcp__my_server__do_thing");
});

test("a server's malformed tools and results are skipped, not thrown", async () => {
  const { client, server } = pipe();
  const s = new RpcConnection(server);
  s.onRequest("initialize", () => ({ capabilities: { tools: {} } }));
  s.onRequest("tools/list", () => ({ tools: [null, { name: 3 }, "x", { name: "ok" }] }));
  s.onRequest("tools/call", (p) =>
    (p as { name: string }).name === "flat"
      ? { content: "not a list" }
      : { content: [null, 7, { type: "text", text: "fine" }] },
  );
  const c = new McpClient(client, "test");
  await c.start();
  assert.deepEqual(
    c.tools.map((t) => t.name),
    ["ok"],
  );
  assert.deepEqual(await c.call("ok", {}), { text: "fine", isError: false });
  assert.deepEqual(await c.call("flat", {}), { text: "", isError: false });
});

test("prompts, resources, list_changed and elicitation (D200)", async () => {
  const { client, server } = pipe();
  const s = new RpcConnection(server);
  let tools = [{ name: "one" }];
  let promptLists = 0;
  let clientCaps: { elicitation?: unknown } = {};
  s.onRequest("initialize", (p) => {
    clientCaps = (p as { capabilities: typeof clientCaps }).capabilities;
    return {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: true }, prompts: {}, resources: {} },
      serverInfo: { name: "rich" },
    };
  });
  s.onRequest("tools/list", () => ({ tools }));
  s.onRequest("prompts/list", () => {
    promptLists++;
    return { prompts: [{ name: "review", arguments: [{ name: "focus", required: true }] }] };
  });
  s.onRequest("resources/list", () => ({
    resources: [{ uri: "mock://notes", name: "Notes" }, { name: "no uri" }],
  }));
  s.onRequest("resources/read", (p) => ({
    contents: [{ uri: (p as { uri: string }).uri, text: "the notes" }],
  }));
  s.onRequest("prompts/get", (p) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Review ${(p as { arguments: { focus: string } }).arguments.focus}`,
        },
      },
    ],
  }));
  const asked: string[] = [];
  const c = new McpClient(client, "test", async (req) => {
    asked.push(req.message);
    return { action: "accept", content: { name: "Ada" } };
  });
  await c.start();
  assert.ok(clientCaps.elicitation, "the client says it takes elicitations");
  assert.deepEqual(
    c.resources.map((r) => r.uri),
    ["mock://notes"],
  );
  assert.equal(c.prompts[0]?.name, "review");
  assert.equal((await c.readResource("mock://notes")).contents?.[0]?.text, "the notes");
  const got = await c.getPrompt("review", { focus: "tests" });
  assert.deepEqual(got.messages?.[0]?.content, { type: "text", text: "Review tests" });

  // tools/list_changed re-lists, and fires once the new list is in.
  tools = [{ name: "one" }, { name: "two" }];
  const changed = new Promise<void>((resolve) => c.onDidChangeTools(() => resolve()));
  s.notify("notifications/tools/list_changed");
  await changed;
  assert.equal(c.tools.length, 2);

  // A burst of prompts/list_changed lists at most twice more, not once per notification.
  const before = promptLists;
  const listed = new Promise<void>((resolve) =>
    c.onDidChangeList((kind) => kind === "prompts" && resolve()),
  );
  for (let i = 0; i < 5; i++) s.notify("notifications/prompts/list_changed");
  await listed;
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(promptLists - before <= 2, `listed ${promptLists - before} times`);

  // The server asks the user something.
  const answer = await s.request<{ action: string; content: { name: string } }>(
    "elicitation/create",
    {
      message: "Your name?",
      requestedSchema: { type: "object", properties: { name: { type: "string" } } },
    },
  );
  assert.deepEqual(answer, { action: "accept", content: { name: "Ada" } });
  assert.deepEqual(asked, ["Your name?"]);
  c.dispose();
});

test("without an elicitation handler it declines; older servers still list tools", async () => {
  const { client, server } = pipe();
  const s = new RpcConnection(server);
  s.onRequest("initialize", () => ({ protocolVersion: "2024-11-05", serverInfo: { name: "old" } }));
  s.onRequest("tools/list", () => ({ tools: [{ name: "t" }] }));
  const c = new McpClient(client, "test");
  await c.start();
  assert.equal(c.tools.length, 1);
  assert.deepEqual(c.prompts, []);
  const answer = await s.request("elicitation/create", { message: "x" });
  assert.deepEqual(answer, { action: "decline" });
  c.dispose();
});
