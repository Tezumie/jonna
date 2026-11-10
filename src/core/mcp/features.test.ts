// D204: sampling, resource templates and subscriptions, the gallery (tool schemas on demand became deferred tools, D319: core/agent/toolSearch.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Emitter } from "../events/index";
import { RpcConnection, RpcError } from "../lsp/jsonrpc";
import { McpClient } from "./client";
import { galleryConfig, galleryEntry, MCP_GALLERY, searchGallery } from "./gallery";
import {
  preferredModel,
  readSamplingRequest,
  SAMPLING_MAX_TOKENS,
  SamplingGate,
  samplingPolicy,
  samplingPreview,
  samplingResult,
  toChatMessages,
} from "./sampling";
import {
  expandTemplate,
  parseTemplateArgs,
  requiredVariables,
  templateVariables,
} from "./templates";

function pipe() {
  const a = new Emitter<string>();
  const b = new Emitter<string>();
  return {
    client: { send: (m: string) => queueMicrotask(() => b.fire(m)), onMessage: a.event },
    server: { send: (m: string) => queueMicrotask(() => a.fire(m)), onMessage: b.event },
  };
}

test("sampling requests: checked, capped, turned into chat messages", () => {
  assert.equal(readSamplingRequest({}), null);
  assert.equal(readSamplingRequest({ messages: [{ role: "system", content: {} }] }), null);
  const req = readSamplingRequest({
    messages: [
      { role: "user", content: { type: "text", text: "Summarize" } },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Sure" },
          { type: "image", mimeType: "image/png", data: "x" },
        ],
      },
    ],
    systemPrompt: "Be brief",
    maxTokens: 1e9,
    temperature: 9,
    stopSequences: ["END", 3],
    modelPreferences: { hints: [{ name: "claude-sonnet" }] },
  });
  assert.ok(req);
  assert.equal(req.maxTokens, SAMPLING_MAX_TOKENS);
  assert.equal(req.temperature, 2);
  assert.deepEqual(req.stopSequences, ["END"]);
  assert.equal(preferredModel(req), "claude-sonnet");
  assert.deepEqual(toChatMessages(req), [
    { role: "system", content: "Be brief" },
    { role: "user", content: "Summarize" },
    { role: "assistant", content: "Sure\n[image image/png omitted]" },
  ]);
  assert.match(samplingPreview(req), /^system: Be brief\n\nuser: Summarize/);
  assert.deepEqual(samplingResult("ok", "m"), {
    role: "assistant",
    content: { type: "text", text: "ok" },
    model: "m",
    stopReason: "endTurn",
  });
});

test("sampling policy: per server, then *, then ask", () => {
  assert.equal(samplingPolicy({ docs: "allow", "*": "deny" }, "docs"), "allow");
  assert.equal(samplingPolicy({ docs: "allow", "*": "deny" }, "other"), "deny");
  assert.equal(samplingPolicy({ docs: "maybe" }, "docs"), "ask");
  assert.equal(samplingPolicy(null, "docs"), "ask");
});

test("sampling approval: ask once, always for a server, deny; one prompt at a time", async () => {
  const policies: Record<string, "ask" | "allow" | "deny"> = { blocked: "deny", trusted: "allow" };
  const answers: ("once" | "always" | "deny")[] = ["once", "always", "deny"];
  const asked: string[] = [];
  let open = 0;
  let most = 0;
  const gate = new SamplingGate(
    (server) => policies[server] ?? "ask",
    async (server) => {
      asked.push(server);
      open++;
      most = Math.max(most, open);
      await new Promise((r) => setTimeout(r, 5));
      open--;
      return answers.shift() ?? "deny";
    },
  );
  const req = { messages: [{ role: "user" as const, content: { type: "text", text: "x" } }] };
  assert.equal(await gate.decide("blocked", req), false);
  assert.equal(await gate.decide("trusted", req), true);
  assert.deepEqual(asked, []);
  // Two at once: asked one after the other.
  const [a, b] = await Promise.all([gate.decide("docs", req), gate.decide("docs", req)]);
  assert.deepEqual([a, b], [true, true]);
  assert.equal(most, 1);
  // "always" holds for the server: not asked again.
  assert.equal(await gate.decide("docs", req), true);
  assert.deepEqual(asked, ["docs", "docs"]);
  assert.ok(gate.alwaysAllowed("docs"));
  gate.forget("docs");
  assert.equal(await gate.decide("docs", req), false);
});

test("the client answers sampling/createMessage, and a refusal is MCP's user-rejected error", async () => {
  const { client, server } = pipe();
  const s = new RpcConnection(server);
  let caps: Record<string, unknown> = {};
  s.onRequest("initialize", (p) => {
    caps = (p as { capabilities: Record<string, unknown> }).capabilities;
    return {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {}, resources: { subscribe: true } },
      serverInfo: { name: "s" },
    };
  });
  s.onRequest("tools/list", () => ({ tools: [] }));
  s.onRequest("resources/list", () => ({ resources: [{ uri: "doc://a", name: "A" }] }));
  s.onRequest("resources/templates/list", () => ({
    resourceTemplates: [{ uriTemplate: "doc://{name}", name: "Doc" }],
  }));
  const subscribed: string[] = [];
  s.onRequest("resources/subscribe", (p) => {
    subscribed.push((p as { uri: string }).uri);
    return {};
  });
  let allow = true;
  const c = new McpClient(client, "test", undefined, async (req) =>
    allow ? samplingResult(`echo ${toChatMessages(req).at(-1)?.content}`, "mock") : null,
  );
  await c.start();
  assert.deepEqual(caps.sampling, {});
  assert.deepEqual(
    c.resourceTemplates.map((t) => t.uriTemplate),
    ["doc://{name}"],
  );
  const answer = (await s.request("sampling/createMessage", {
    messages: [{ role: "user", content: { type: "text", text: "hi" } }],
    maxTokens: 10,
  })) as { content: { text: string }; model: string };
  assert.equal(answer.content.text, "echo hi");
  assert.equal(answer.model, "mock");
  allow = false;
  await assert.rejects(
    s.request("sampling/createMessage", {
      messages: [{ role: "user", content: { type: "text", text: "hi" } }],
    }),
    (err: unknown) => err instanceof RpcError && err.code === -1,
  );
  await assert.rejects(
    s.request("sampling/createMessage", { messages: [] }),
    (err: unknown) => err instanceof RpcError && err.code === -32602,
  );
  // Subscriptions: subscribe once, updates arrive.
  assert.ok(c.canSubscribe);
  assert.equal(await c.subscribe("doc://a"), true);
  assert.equal(await c.subscribe("doc://a"), true);
  assert.deepEqual(subscribed, ["doc://a"]);
  const updates: string[] = [];
  c.onDidUpdateResource((uri) => updates.push(uri));
  s.notify("notifications/resources/updated", { uri: "doc://a" });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(updates, ["doc://a"]);
  c.dispose();
});

test("a client without a sampling handler doesn't claim the capability", async () => {
  const { client, server } = pipe();
  const s = new RpcConnection(server);
  let caps: Record<string, unknown> = {};
  s.onRequest("initialize", (p) => {
    caps = (p as { capabilities: Record<string, unknown> }).capabilities;
    return { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "s" } };
  });
  s.onRequest("tools/list", () => ({ tools: [] }));
  const c = new McpClient(client, "test");
  await c.start();
  assert.equal(caps.sampling, undefined);
  assert.deepEqual(c.resourceTemplates, []);
  assert.equal(await c.subscribe("x://y"), false);
  c.dispose();
});

test("resource templates: variables, expansion (RFC 6570 levels 1–3), arguments", () => {
  const t = "github://repos/{owner}/{repo}/issues{?state,labels}";
  assert.deepEqual(templateVariables(t), ["owner", "repo", "state", "labels"]);
  assert.deepEqual(requiredVariables(t), ["owner", "repo"]);
  assert.equal(
    expandTemplate(t, { owner: "a b", repo: "x", state: "open" }),
    "github://repos/a%20b/x/issues?state=open",
  );
  assert.equal(expandTemplate("file:///{+path}", { path: "src/a b.ts" }), "file:///src/a%20b.ts");
  assert.equal(expandTemplate("x{/a,b}{#frag}", { a: "1", b: "2", frag: "top" }), "x/1/2#top");
  assert.equal(expandTemplate("x{.ext}{;v}", { ext: "json", v: "1" }), "x.json;v=1");
  assert.equal(expandTemplate("q{?a}{&b}", { a: "1", b: "2" }), "q?a=1&b=2");
  assert.deepEqual(parseTemplateArgs(t, "repo=ide openai state=closed"), {
    repo: "ide",
    state: "closed",
    owner: "openai",
  });
  assert.deepEqual(parseTemplateArgs("file:///{+path}", "src/a b.ts"), { path: "src/a b.ts" });
});

test("the gallery: entries are complete, searchable and write VS Code's shape", () => {
  const ids = new Set<string>();
  for (const e of MCP_GALLERY) {
    assert.ok(!ids.has(e.id), e.id);
    ids.add(e.id);
    assert.ok(e.config.command || e.config.url, e.id);
    assert.ok(e.homepage.startsWith("https://"), e.id);
    // Every ${input:x} it uses is declared.
    const used = JSON.stringify(e.config).match(/\$\{input:([^}]+)\}/g) ?? [];
    for (const u of used)
      assert.ok(
        e.inputs?.some((i) => u === `\${input:${i.id}}`),
        `${e.id} ${u}`,
      );
    if (e.kind === "remote") assert.ok(e.config.url?.startsWith("https://"), e.id);
  }
  assert.ok(searchGallery("browser").some((e) => e.id === "playwright"));
  assert.deepEqual(searchGallery("zzzz"), []);
  const github = galleryEntry("github");
  assert.ok(github);
  const written = galleryConfig(github);
  assert.equal(written.server.url, "https://api.githubcopilot.com/mcp/");
  assert.deepEqual(written.inputs[0], {
    type: "promptString",
    id: "github-token",
    description: "GitHub personal access token",
    password: true,
  });
});
