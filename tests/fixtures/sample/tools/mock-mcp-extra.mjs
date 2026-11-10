// A small MCP server over stdio for tests/scripts/agent-m7-5.jsonc (D204): the "summarize" tool
// asks the client to sample (sampling/createMessage) and returns what the model said; resource
// templates (extra://notes/{name}) with subscriptions; "bump" changes a note and sends
// notifications/resources/updated for the subscribed ones.
// D207 (tests/scripts/agentB-m7-6.jsonc): "look" samples with an image.
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
let nextId = 1;
const pending = new Map();
const request = (method, params) =>
  new Promise((resolve) => {
    const id = `x${nextId++}`;
    pending.set(id, resolve);
    send({ id, method, params });
  });
const versions = new Map();
const subscribed = new Set();

async function callTool(id, params) {
  if (params.name === "summarize") {
    const answer = await request("sampling/createMessage", {
      messages: [
        { role: "user", content: { type: "text", text: "Sampling please: summarize the notes" } },
      ],
      systemPrompt: "You summarize.",
      maxTokens: 100,
    });
    const text = answer.error
      ? `sampling refused (${answer.error.code})`
      : `sampled: ${answer.content?.text ?? ""}`;
    return send({ id, result: { content: [{ type: "text", text }] } });
  }
  if (params.name === "look") {
    const answer = await request("sampling/createMessage", {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this picture?" },
            {
              type: "image",
              mimeType: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==",
            },
          ],
        },
      ],
      systemPrompt: "You describe images.",
      maxTokens: 50,
    });
    const text = answer.error
      ? `sampling refused: ${answer.error.message}`
      : `looked: ${answer.content?.text ?? ""}`;
    return send({ id, result: { content: [{ type: "text", text }] } });
  }
  if (params.name === "bump") {
    const name = String(params.arguments?.name ?? "a");
    versions.set(name, (versions.get(name) ?? 1) + 1);
    const uri = `extra://notes/${name}`;
    if (subscribed.has(uri)) send({ method: "notifications/resources/updated", params: { uri } });
    return send({ id, result: { content: [{ type: "text", text: `bumped ${name}` }] } });
  }
  return send({ id, error: { code: -32602, message: `unknown tool ${params.name}` } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const { id, method, params } = msg;
  if (method === undefined && pending.has(id)) {
    pending.get(id)(msg.error ? { error: msg.error } : (msg.result ?? {}));
    pending.delete(id);
    return;
  }
  if (method === "initialize")
    return send({
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: { subscribe: true } },
        serverInfo: { name: "mock-mcp-extra" },
      },
    });
  if (method === "tools/list")
    return send({
      id,
      result: {
        tools: [
          {
            name: "summarize",
            description: "Summarize with the client's model",
            inputSchema: { type: "object", properties: { text: { type: "string" } } },
            annotations: { readOnlyHint: true },
          },
          {
            name: "look",
            description: "Describe a picture with the client's model",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
          },
          {
            name: "bump",
            description: "Change a note",
            inputSchema: { type: "object", properties: { name: { type: "string" } } },
            annotations: { readOnlyHint: true },
          },
        ],
      },
    });
  if (method === "resources/list") return send({ id, result: { resources: [] } });
  if (method === "resources/templates/list")
    return send({
      id,
      result: {
        resourceTemplates: [
          { uriTemplate: "extra://notes/{name}", name: "Note", description: "A note by name" },
        ],
      },
    });
  if (method === "resources/subscribe") {
    subscribed.add(params.uri);
    return send({ id, result: {} });
  }
  if (method === "resources/unsubscribe") {
    subscribed.delete(params.uri);
    return send({ id, result: {} });
  }
  if (method === "resources/read") {
    const name = String(params.uri).split("/").pop();
    return send({
      id,
      result: {
        contents: [
          {
            uri: params.uri,
            mimeType: "text/plain",
            text: `note ${name} v${versions.get(name) ?? 1}`,
          },
        ],
      },
    });
  }
  if (method === "tools/call") return void callTool(id, params);
  if (id !== undefined) send({ id, error: { code: -32601, message: `unknown ${method}` } });
});
