// A remote MCP server for tests/scripts/agentB-m7-6.jsonc (D207), served by mock-ollama.mjs at
// http://127.0.0.1:<port>/remote-mcp/mcp (Streamable HTTP): a standing GET stream (a session's
// first stream sends tools/list_changed for a tool added meanwhile and ends, to be reopened by
// the client), OAuth (protected resource and authorization server metadata, registration, an
// authorization page that signs in at once, tokens naming their scopes) and an "admin" tool that
// answers 403 insufficient_scope until the token has the admin scope. State is per session, so
// the script can run twice against one mock.

const sessions = new Map();
let nextSession = 1;

const baseTools = () => [
  {
    name: "ping",
    description: "Answers pong",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "admin",
    description: "Needs the admin scope",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
];

/** Answers the request if it's this server's; false otherwise. */
export function handleRemoteMcp(req, res, body, base) {
  const url = new URL(req.url ?? "/", base);
  const json = (status, value, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(value));
    return true;
  };
  if (url.pathname === "/.well-known/oauth-protected-resource/remote-mcp/mcp")
    return json(200, {
      resource: `${base}/remote-mcp/mcp`,
      authorization_servers: [`${base}/remote-mcp`],
      scopes_supported: ["read", "admin"],
    });
  if (url.pathname === "/.well-known/oauth-authorization-server/remote-mcp")
    return json(200, {
      issuer: `${base}/remote-mcp`,
      authorization_endpoint: `${base}/remote-mcp/authorize`,
      token_endpoint: `${base}/remote-mcp/token`,
      registration_endpoint: `${base}/remote-mcp/register`,
      code_challenge_methods_supported: ["S256"],
    });
  if (!url.pathname.startsWith("/remote-mcp/")) return false;
  const path = url.pathname.slice("/remote-mcp".length);
  if (path === "/register") return json(201, { client_id: "mock-client" });
  if (path === "/authorize") {
    const back = new URL(url.searchParams.get("redirect_uri") ?? base);
    const scope = (url.searchParams.get("scope") ?? "").trim().replace(/\s+/g, ".");
    back.searchParams.set("code", `code.${scope}`);
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    res.writeHead(302, { location: back.toString() });
    res.end();
    return true;
  }
  if (path === "/token") {
    const code = new URLSearchParams(body).get("code") ?? "";
    const scopes = code.replace(/^code\./, "");
    return json(200, {
      access_token: `tok.${scopes}`,
      token_type: "Bearer",
      expires_in: 3600,
      scope: scopes.replace(/\./g, " "),
    });
  }
  if (path !== "/mcp") return json(404, { error: "not found" });
  const session = sessions.get(String(req.headers["mcp-session-id"] ?? ""));
  if (req.method === "GET") {
    if (!String(req.headers.accept ?? "").includes("text/event-stream"))
      return json(405, { error: "GET needs text/event-stream" });
    if (!session) return json(404, { error: "no such session" });
    session.streams++;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    res.write(": open\n\n");
    if (session.streams === 1) {
      // A tool appears while no request is open: only the stream can tell the client.
      setTimeout(() => {
        session.tools.push({
          name: "late",
          description: "Added later",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        });
        res.write(
          `id: ev1\nretry: 300\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`,
        );
        // The first stream ends: the client opens another.
        setTimeout(() => res.end(), 100);
      }, 500);
    } else {
      const beat = setInterval(() => res.write(": keepalive\n\n"), 10_000);
      req.on("close", () => clearInterval(beat));
    }
    return true;
  }
  if (req.method === "DELETE") return json(200, {});
  let msg;
  try {
    msg = JSON.parse(body);
  } catch {
    return json(400, { error: "bad json" });
  }
  if (msg.method === undefined || msg.id === undefined) {
    res.writeHead(202);
    res.end();
    return true;
  }
  const reply = (result) => json(200, { jsonrpc: "2.0", id: msg.id, result });
  if (msg.method === "initialize") {
    const id = `mock-session-${nextSession++}`;
    sessions.set(id, { streams: 0, tools: baseTools() });
    return json(
      200,
      {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "mock-remote" },
        },
      },
      { "mcp-session-id": id },
    );
  }
  const tools = session?.tools ?? baseTools();
  if (msg.method === "tools/list") return reply({ tools });
  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    if (name === "admin") {
      if (!String(req.headers.authorization ?? "").includes("admin"))
        return json(
          403,
          { error: "insufficient_scope" },
          {
            "www-authenticate": `Bearer error="insufficient_scope", scope="admin", resource_metadata="${base}/.well-known/oauth-protected-resource/remote-mcp/mcp"`,
          },
        );
      return reply({ content: [{ type: "text", text: "admin ok" }] });
    }
    if (name === "ping") return reply({ content: [{ type: "text", text: "pong" }] });
    if (name === "late") return reply({ content: [{ type: "text", text: "late ok" }] });
    return json(200, {
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32602, message: "unknown tool" },
    });
  }
  return json(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown" } });
}
