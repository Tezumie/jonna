// A tiny ACP agent over stdio (newline-delimited JSON-RPC) for tests/scripts/m6-94.jsonc: on a
// prompt it thinks, reads README.md through the client, asks permission, writes the file back
// with a line added (through the client), and answers. D200 (agent-m7-1-mcp.jsonc): it can load
// a session (session/load replays the chat), lists its own slash commands, and "exit now" makes
// it answer and quit, so the next message starts it again and loads the session.
// D208 (acp-m7-6.jsonc): "agent writes itself" writes files without the client (as Codex does),
// streams a Guardian review before the PowerShell command it reviewed and a denied one, and
// reports usage (usage_update with a cost, and usage in its answer); "scratch check" writes and
// reads in its folder through the client and tries a file outside it.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";

let nextId = 1;
const pending = new Map();
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const request = (method, params) =>
  new Promise((resolve) => {
    const id = `a${nextId++}`;
    pending.set(id, resolve);
    send({ id, method, params });
  });
// Its settings (D193): a model and a reasoning level, as ACP session config options.
const current = { model: "fast", effort: "low" };
const configOptions = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: current.model,
    options: [
      { value: "fast", name: "Fast model" },
      { value: "smart", name: "Smart model" },
    ],
  },
  {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: current.effort,
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  },
];
const update = (sessionId, u) =>
  send({ method: "session/update", params: { sessionId, update: u } });
// The session this process picked up with session/load, if any.
let loadedFrom = null;
const commands = (sessionId) =>
  update(sessionId, {
    sessionUpdate: "available_commands_update",
    availableCommands: [
      {
        name: "mock-plan",
        description: "Plan with the mock agent",
        input: { hint: "what to plan" },
      },
      { name: "mock-status", description: "Show the mock agent's status" },
    ],
  });

/** The MCP servers the IDE handed over with the session (D211). */
let mcpServers = [];

/** One Streamable HTTP MCP request (JSON or an SSE stream with one answer). */
async function mcpCall(server, sessionHeader, body) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...Object.fromEntries(server.headers.map((h) => [h.name, h.value])),
    ...(sessionHeader.id && { "mcp-session-id": sessionHeader.id }),
  };
  const res = await fetch(server.url, { method: "POST", headers, body: JSON.stringify(body) });
  sessionHeader.id ??= res.headers.get("mcp-session-id") ?? undefined;
  if (body.id === undefined) return null;
  const text = await res.text();
  if (!text)
    throw new Error(`HTTP ${res.status} ${res.headers.get("content-type")} for ${body.method}`);
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const line of text.split("\n"))
      if (line.startsWith("data:") && line.slice(5).trim()) {
        const m = JSON.parse(line.slice(5));
        if (m.id === body.id) return m;
      }
    return null;
  }
  return JSON.parse(text);
}

/** With MOCK_ACP_STDIO_MCP=1 it takes only stdio MCP servers (D223), as many agents do. */
const stdioOnly = process.env.MOCK_ACP_STDIO_MCP === "1";

/** A stdio MCP server started as the session says (command, args, env): one request at a time. */
function stdioMcp(server) {
  const env = { ...process.env };
  for (const e of server.env ?? []) env[e.name] = e.value;
  const child = spawn(server.command, server.args ?? [], {
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    const m = JSON.parse(line);
    if (m.id !== undefined && waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
    }
  });
  return {
    call: (body) =>
      new Promise((resolve, reject) => {
        if (body.id !== undefined) waiting.set(body.id, resolve);
        child.stdin.write(`${JSON.stringify(body)}\n`);
        if (body.id === undefined) resolve(null);
        else setTimeout(() => reject(new Error(`no answer to ${body.method}`)), 30000);
      }),
    close: () => child.stdin.end(),
  };
}

/** Reads the most recent terminal through the IDE's MCP tools. */
async function readTerminalThroughIde() {
  if (stdioOnly) {
    const server = mcpServers.find((s) => s.type === undefined && s.command);
    if (!server) return "no IDE tools";
    // The token travels in the environment, never on the command line.
    if (server.args.some((a) => /^[0-9a-f]{40,}$/.test(a))) return "token on the command line";
    const mcp = stdioMcp(server);
    try {
      return `${await readTerminal((body) => mcp.call(body))} over stdio`;
    } finally {
      mcp.close();
    }
  }
  const server = mcpServers.find((s) => s.type === "http");
  if (!server) return "no IDE tools";
  const session = {};
  return readTerminal((body) => mcpCall(server, session, body));
}

async function readTerminal(mcpRequest) {
  await mcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mock-acp", version: "1" },
    },
  });
  await mcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" });
  const listed = await mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = (listed?.result?.tools ?? []).map((t) => t.name);
  const tool = names.find((n) => n.includes("readOutput"));
  if (!tool) return `no read tool in ${names.length} tools`;
  const r = await mcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: tool, arguments: { lines: 50 } },
  });
  const out = (r?.result?.content ?? []).map((c) => c.text ?? "").join("");
  return out.includes("TERMINAL-MARKER-42") ? "saw the marker" : `no marker: ${out.slice(0, 200)}`;
}

async function prompt(id, { sessionId, prompt: blocks }) {
  // "just answer": no edit, no permission prompt (the model-choice test, D193).
  const said = (word) => (blocks ?? []).some((b) => b.type === "text" && b.text.includes(word));
  // A one-off answer for a feature (D207: a commit message written by an external agent).
  if (said("Answer with the text only")) {
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Write it with the mock agent" },
    });
    return send({ id, result: { stopReason: "end_turn" } });
  }
  // A group chat answered by an external agent (D232): it answers as the member it's told it is.
  if (said("acpgroup check") || said("handed the conversation to you, Forge")) {
    const text = said("You are Forge")
      ? "Forge via acp: built it."
      : said("You are Scout")
        ? "Scout via acp: researched.\n@Forge, please build it."
        : "No member brief.";
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    return send({ id, result: { stopReason: "end_turn" } });
  }
  // One of the user's agents on an external agent (D249): it answers, told whose instructions.
  if (said("acpagent check")) {
    const text = said("chat mode (the user's own mode")
      ? "Chat via acp: answered."
      : "No agent instructions.";
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    return send({ id, result: { stopReason: "end_turn" } });
  }
  // A member on its own model spoke meanwhile (D235): the agent is told what it missed.
  if (said("acpmixed")) {
    const text = said("REV: Rev on its own model.")
      ? "Main via acp: saw what Rev said."
      : "Main via acp: missed it.";
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    return send({ id, result: { stopReason: "end_turn" } });
  }
  // Codex's /status card (D233): plan limits only as text.
  if ((blocks ?? []).some((b) => b.type === "text" && b.text.trim().startsWith("/status"))) {
    const text = [
      ">_ Mock Codex (v0.0.1)",
      " Model:            mock-codex (reasoning medium)",
      " Context window:   100% left (0 used / 272K)",
      " 5h limit:         [████░░░░░░░░░░░░] 30% used (resets 14:32)",
      " Weekly limit:     [█░░░░░░░░░░░░░░░] 5% used (resets 09:00 on 3 Nov)",
    ].join("\n");
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
    return send({ id, result: { stopReason: "end_turn" } });
  }
  // D294: a command that makes a folder of files (a clone), and one file beside it.
  if (said("clone a folder")) {
    const cwd = process.cwd();
    mkdirSync(`${cwd}/cloned-repo/pkg`, { recursive: true });
    for (let i = 0; i < 120; i++) writeFileSync(`${cwd}/cloned-repo/pkg/f${i}.py`, `x = ${i}\n`);
    writeFileSync(`${cwd}/clone-note.txt`, "cloned\n");
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Cloned it." },
    });
    return send({ id, result: { stopReason: "end_turn" } });
  }
  // D403: a read, a pause in which the test edits a file of its own, then a command that writes
  // one: only the command's file is the agent's.
  if (said("while others edit")) {
    const cwd = process.cwd();
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "r1",
      title: "Read notes.txt",
      kind: "read",
      status: "completed",
    });
    await new Promise((r) => setTimeout(r, 6000));
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "echo made > by-command.txt",
      kind: "execute",
      status: "in_progress",
    });
    writeFileSync(`${cwd}/by-command.txt`, "made\n");
    await new Promise((r) => setTimeout(r, 300));
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" });
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Others checked." },
    });
    return send({ id, result: { stopReason: "end_turn" } });
  }
  if (said("read my terminal")) {
    const found = await readTerminalThroughIde().catch((e) => `failed: ${e.message}`);
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `Terminal check: ${found}` },
    });
    return send({ id, result: { stopReason: "end_turn" } });
  }
  // D365: the IDE's state comes with the message (its browser tabs) and browser_console is listed.
  if (said("check the browser")) {
    const server = mcpServers.find((s) => s.type === "http");
    let listed = "no IDE tools";
    if (server) {
      const session = {};
      const call = (body) => mcpCall(server, session, body);
      await call({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "mock-acp", version: "1" },
        },
      });
      await call({ jsonrpc: "2.0", method: "notifications/initialized" });
      const r = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const names = (r?.result?.tools ?? []).map((t) => t.name);
      listed = names.includes("browser_console") ? "console tool listed" : "no console tool";
    }
    const state = said("<ide_state>") ? "state sent" : "no state";
    const tabs = said("Browser tabs open in the IDE") ? "tabs told" : "no tabs";
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `Browser check: ${listed}, ${state}, ${tabs}` },
    });
    return send({ id, result: { stopReason: "end_turn" } });
  }
  if (said("agent writes itself")) {
    const cwd = process.cwd();
    appendFileSync(`${cwd}/notes.txt`, "Changed by the agent.\n");
    writeFileSync(`${cwd}/made-by-agent.txt`, "new\n");
    // Guardian reviews the command before the command's own step appears.
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "guardian_assessment:r1",
      title: "Guardian Review",
      kind: "think",
      status: "in_progress",
      content: [
        {
          type: "content",
          content: { type: "text", text: "Status: In progress\nAction: shell npm run check" },
        },
      ],
      rawInput: { targetItemId: "cmd1", reviewId: "r1" },
    });
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "guardian_assessment:r1",
      status: "completed",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "Status: Approved\nAction: shell npm run check\nRisk: low\nAuthorization: high\nRationale: Runs the project's own checks.",
          },
        },
      ],
      rawOutput: { targetItemId: "cmd1", reviewId: "r1" },
    });
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "cmd1",
      title: `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'npm run check'`,
      kind: "execute",
      status: "completed",
    });
    // A review that stops its command: the command never runs.
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "guardian_assessment:r2",
      title: "Guardian Review",
      kind: "think",
      status: "failed",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "Status: Denied\nAction: shell rm -rf /\nRisk: high\nRationale: It would delete everything.",
          },
        },
      ],
      rawInput: { targetItemId: "cmd2", reviewId: "r2" },
    });
    update(sessionId, {
      sessionUpdate: "usage_update",
      used: 1200,
      size: 200000,
      cost: { amount: 0.05, currency: "USD" },
    });
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Wrote the files myself." },
    });
    return send({
      id,
      result: {
        stopReason: "end_turn",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cachedReadTokens: 1000,
          cachedWriteTokens: 5,
          totalTokens: 1035,
        },
      },
    });
  }
  // D223 (mcp-acp-m7-7.jsonc): one step edits a git-ignored file that already exists, its card
  // shows the change while the turn goes on (a pause for the test to look and save a file of its
  // own), and the answer splits the turn's tokens by model.
  if (said("step by step")) {
    const cwd = process.cwd();
    const file = `${cwd}/build/step-a.txt`;
    mkdirSync(`${cwd}/build`, { recursive: true });
    // There before the step (an ignored file git has no copy of).
    writeFileSync(file, "before\n");
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "s1",
      title: "Edit build/step-a.txt",
      kind: "edit",
      status: "pending",
      locations: [{ path: file }],
    });
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(file, "before\nafter\n");
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "s1", status: "completed" });
    await new Promise((r) => setTimeout(r, 5000));
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Steps done." },
    });
    return send({
      id,
      result: {
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        _meta: {
          quota: {
            token_count: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
            model_usage: [
              {
                model: "fast",
                token_count: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
              },
              {
                model: "mock-haiku",
                token_count: { inputTokens: 40, outputTokens: 7, totalTokens: 47 },
              },
            ],
          },
        },
      },
    });
  }
  if (said("scratch check")) {
    const cwd = process.cwd();
    const inside = `${cwd}/scratch-note.txt`;
    const wrote = await request("fs/write_text_file", { sessionId, path: inside, content: "kept" });
    const back = await request("fs/read_text_file", { sessionId, path: inside });
    const outside = await request("fs/read_text_file", {
      sessionId,
      path: `${cwd}/../../../../config/settings.json`,
    });
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `Scratch: wrote=${wrote.error ? "no" : "yes"}/read=${back.content ?? "-"}/outside=${outside.error ? "refused" : "READ"}/cwd=${basename(cwd)}`,
      },
    });
    return send({ id, result: { stopReason: "end_turn" } });
  }
  if (said("exit now")) {
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Exiting." },
    });
    send({ id, result: { stopReason: "end_turn" } });
    return void setTimeout(() => process.exit(0), 50);
  }
  if (said("just answer") || said("/mock-status")) {
    const recap = said("you were restarted") ? " with a recap" : "";
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `ACP done on ${current.model} (${current.effort})${loadedFrom ? ` loaded ${loadedFrom}` : ""}${recap}.`,
      },
    });
    return send({ id, result: { stopReason: "end_turn" } });
  }
  update(sessionId, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "Planning an edit." },
  });
  update(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    title: "Add a line to README.md",
    kind: "edit",
    status: "pending",
    locations: [{ path: `${process.cwd()}/README.md` }],
  });
  const read = await request("fs/read_text_file", {
    sessionId,
    path: `${process.cwd()}/README.md`,
  });
  const perm = await request("session/request_permission", {
    sessionId,
    toolCall: { toolCallId: "t1", title: "Add a line to README.md", kind: "edit" },
    options: [
      { optionId: "ok", name: "Allow", kind: "allow_once" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ],
  });
  if (perm.outcome?.optionId === "ok") {
    await request("fs/write_text_file", {
      sessionId,
      path: `${process.cwd()}/README.md`,
      content: `${read.content}\nAdded by ACP.\n`,
    });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
  } else
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" });
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `ACP done on ${current.model} (${current.effort}).` },
  });
  send({ id, result: { stopReason: "end_turn" } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg.error ? { error: msg.error } : (msg.result ?? {}));
    pending.delete(msg.id);
    return;
  }
  if (msg.method === "initialize")
    return send({
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, mcpCapabilities: stdioOnly ? {} : { http: true } },
        authMethods: [],
        agentInfo: { name: "mock-acp" },
      },
    });
  if (msg.method === "session/new" || msg.method === "session/load")
    mcpServers = msg.params.mcpServers ?? [];
  if (msg.method === "session/new") {
    send({ id: msg.id, result: { sessionId: "acp1", configOptions: configOptions() } });
    return void setTimeout(() => commands("acp1"), 20);
  }
  if (msg.method === "session/load") {
    const sid = msg.params.sessionId;
    loadedFrom = sid;
    // The replay of the conversation, before the answer (the client already shows it).
    update(sid, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "earlier" },
    });
    update(sid, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "REPLAYED answer" },
    });
    commands(sid);
    return send({ id: msg.id, result: { configOptions: configOptions() } });
  }
  if (msg.method === "session/set_config_option") {
    current[msg.params.configId] = msg.params.value;
    return send({ id: msg.id, result: { configOptions: configOptions() } });
  }
  if (msg.method === "session/prompt") return void prompt(msg.id, msg.params);
  if (msg.method === "session/cancel") return;
  if (msg.id !== undefined)
    send({ id: msg.id, error: { code: -32601, message: `unknown ${msg.method}` } });
});
