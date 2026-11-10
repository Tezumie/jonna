// A tiny MCP server over stdio (newline-delimited JSON) for tests/scripts/m6-94.jsonc and
// agent-m7-1-mcp.jsonc. Tools: "echo" (read-only) returns its text upper-cased; "ask" asks the
// user for a name through elicitation/create and says what came back; "grow" adds a tool, a
// prompt and a resource and says so with list_changed notifications. Prompts: "review" (focus,
// required). Resources: mock://notes/readme.
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
let nextId = 1;
const pending = new Map();
const request = (method, params) =>
  new Promise((resolve) => {
    const id = `s${nextId++}`;
    pending.set(id, resolve);
    send({ id, method, params });
  });

let grown = false;
const tools = () => [
  {
    name: "echo",
    description: "Echo text back in upper case",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "ask",
    description: "Ask the user for their name",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "grow",
    description: "Add a tool, a prompt and a resource",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  ...(grown
    ? [
        {
          name: "late",
          description: "A tool added later",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
      ]
    : []),
];
const prompts = () => [
  {
    name: "review",
    description: "Review the code with a focus",
    arguments: [{ name: "focus", description: "What to look at", required: true }],
  },
  ...(grown ? [{ name: "later", description: "A prompt added later" }] : []),
];
const resources = () => [
  {
    uri: "mock://notes/readme",
    name: "Mock notes",
    description: "Notes from the mock server",
    mimeType: "text/plain",
  },
  ...(grown ? [{ uri: "mock://notes/later", name: "Later notes", mimeType: "text/plain" }] : []),
];

async function callTool(id, params) {
  const name = params.name;
  if (name === "ask") {
    const answer = await request("elicitation/create", {
      message: "What is your name?",
      requestedSchema: {
        type: "object",
        properties: {
          name: { type: "string", title: "Name", minLength: 1 },
          color: { type: "string", enum: ["red", "green"], enumNames: ["Red", "Green"] },
        },
        required: ["name"],
      },
    });
    const text =
      answer.action === "accept"
        ? `elicited name=${answer.content?.name ?? ""} color=${answer.content?.color ?? "-"}`
        : `elicitation ${answer.action}`;
    return send({ id, result: { content: [{ type: "text", text }] } });
  }
  if (name === "grow") {
    grown = true;
    send({ method: "notifications/tools/list_changed" });
    send({ method: "notifications/prompts/list_changed" });
    send({ method: "notifications/resources/list_changed" });
    return send({ id, result: { content: [{ type: "text", text: "grew" }] } });
  }
  if (name === "late")
    return send({ id, result: { content: [{ type: "text", text: "late tool ran" }] } });
  return send({
    id,
    result: {
      content: [
        {
          type: "text",
          // With a TOKEN (an input, D193): say it arrived, so the test sees the secret got here.
          text: `${String(params.arguments?.text ?? "").toUpperCase()}${process.env.TOKEN ? ` token=${process.env.TOKEN}` : ""}`,
        },
      ],
    },
  });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const { id, method, params } = msg;
  if (method === undefined && pending.has(id)) {
    pending.get(id)(msg.result ?? {});
    pending.delete(id);
    return;
  }
  if (method === "initialize")
    return send({
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {
          tools: { listChanged: true },
          prompts: { listChanged: true },
          resources: { listChanged: true },
        },
        serverInfo: { name: "mock-mcp" },
      },
    });
  if (method === "tools/list") return send({ id, result: { tools: tools() } });
  if (method === "prompts/list") return send({ id, result: { prompts: prompts() } });
  if (method === "resources/list") return send({ id, result: { resources: resources() } });
  if (method === "resources/read")
    return send({
      id,
      result: {
        contents: [
          {
            uri: params.uri,
            mimeType: "text/plain",
            text:
              params.uri === "mock://notes/readme"
                ? "The mock notes say: resources work."
                : "Later.",
          },
        ],
      },
    });
  if (method === "prompts/get")
    return send({
      id,
      result: {
        description: "Review the code",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Mock review prompt for ${params.arguments?.focus ?? "?"}`,
            },
          },
        ],
      },
    });
  if (method === "tools/call") return void callTool(id, params);
  if (id !== undefined) send({ id, error: { code: -32601, message: `unknown ${method}` } });
});
