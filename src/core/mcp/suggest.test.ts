// D343: suggest_mcp_server's search, ranking, card and Add plan; mcp_status's rows.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "../agent/conversation";
import { galleryEntry, MCP_GALLERY } from "./gallery";
import { parseRegistryList, registryEntry } from "./registry";
import { REGISTRY_SAMPLE } from "./registrySample";
import {
  canReconnect,
  type McpStatusRow,
  mcpSuggestionRefusal,
  mcpSuggestionResult,
  parseMcpStatus,
  parseMcpSuggestion,
  planMcpAdd,
  queryWords,
  type RankedEntry,
  rankServers,
  registryQueries,
  runnerOf,
  statusResult,
  statusRows,
  suggestedServer,
} from "./suggest";

const sample = () =>
  parseRegistryList(REGISTRY_SAMPLE).flatMap((server): RankedEntry[] => {
    const entry = registryEntry(server);
    return entry ? [{ entry, source: "registry", registryName: server.name }] : [];
  });

test("the saved registry answer: deprecated left out, remotes and packages as entries", () => {
  const list = parseRegistryList(REGISTRY_SAMPLE);
  assert.deepEqual(
    list.map((s) => s.name),
    [
      "ai.smithery/Hint-Services-obsidian-github-mcp",
      "app.tuper/github-repos",
      "io.github.000safah000-ai/blackhawk-mcp",
      "io.github.06ketan/medium-ops",
    ],
  );
  const [smithery, apify, npm, pypi] = sample();
  assert.equal(smithery?.entry.kind, "remote");
  assert.ok(smithery);
  assert.equal(runnerOf(smithery.entry), "remote");
  // The header's {placeholder} is a password input; the address stays as published.
  assert.deepEqual(smithery?.entry.inputs?.[0], {
    id: "smithery-api-key",
    description: "Authorization: smithery_api_key",
    password: true,
  });
  assert.equal(apify?.entry.title, "GitHub Repos (Apify Actor) by Tuper");
  assert.equal(npm?.entry.config.command, "npx");
  assert.deepEqual(npm?.entry.config.args, ["-y", "blackhawk-mcp@1.0.0"]);
  // Required or secret variables are asked; an optional plain one isn't.
  assert.deepEqual(
    npm?.entry.inputs?.map((i) => [i.id, i.password]),
    [
      ["google-client-id", false],
      ["google-client-secret", true],
    ],
  );
  assert.equal(npm?.entry.needs, "Node.js");
  assert.equal(pypi?.entry.config.command, "uvx");
  assert.deepEqual(pypi?.entry.config.args, ["medium-ops==0.1.2", "mcp", "serve"]);
});

test("registry queries: the whole need, then its longest words", () => {
  assert.deepEqual(registryQueries("query the Postgres database"), [
    "query the Postgres database",
    "postgres",
    "database",
  ]);
  assert.deepEqual(registryQueries("github"), ["github"]);
  assert.deepEqual(registryQueries("an MCP server for Slack"), [
    "an MCP server for Slack",
    "slack",
  ]);
  assert.deepEqual(queryWords("Browse web pages with a browser"), [
    "browse",
    "web",
    "page",
    "browser",
  ]);
});

test("ranking: name matches first, the gallery wins a tie, duplicates dropped", () => {
  const gallery = MCP_GALLERY.map((entry): RankedEntry => ({ entry, source: "builtin" }));
  const github = rankServers([...sample(), ...gallery], "github");
  assert.ok(github.length >= 3);
  // Every hit is about GitHub; the built-in one comes before registry ones scoring the same.
  const builtin = github.findIndex((r) => r.source === "builtin");
  assert.ok(builtin >= 0, "the built-in GitHub server is found");
  assert.ok(
    github.slice(0, builtin).every((r) => r.source === "registry"),
    "only better-named registry servers before it",
  );
  // Nothing matches: nothing ranked.
  assert.deepEqual(rankServers(gallery, "zzzz-nothing"), []);
  // The same server twice (a registry copy of a gallery one): kept once.
  const fs = galleryEntry("filesystem");
  assert.ok(fs);
  const twice = rankServers(
    [
      { entry: fs, source: "builtin" },
      { entry: { ...fs, id: "filesystem-copy" }, source: "registry", registryName: "x/fs" },
    ],
    "files",
  );
  assert.equal(twice.length, 1);
  assert.equal(twice[0]?.source, "builtin");
});

test("the card's row: runner, inputs, configured already", () => {
  const [, , npm] = sample();
  assert.ok(npm);
  const row = suggestedServer(npm, ["Blackhawk-MCP"]);
  assert.equal(row.runner, "npx");
  assert.equal(row.runs, "npx -y blackhawk-mcp@1.0.0");
  assert.equal(row.added, "Blackhawk-MCP");
  assert.equal(row.registryName, "io.github.000safah000-ai/blackhawk-mcp");
  assert.equal(row.inputs.length, 2);
  assert.equal(suggestedServer(npm, []).added, undefined);
  const card = { reason: "Reads your sheets", items: [row] };
  assert.deepEqual(parseMcpSuggestion(JSON.stringify(card)), card);
  assert.equal(parseMcpSuggestion("{}"), null);
  assert.match(mcpSuggestionResult(card), /never in the chat/);
});

test("Add's plan: typed values stored, empty ones asked at the start, bad choices refused", () => {
  const [, , npm] = sample();
  assert.ok(npm);
  const plan = planMcpAdd(npm.entry, {
    "google-client-id": "  my-id ",
    "google-client-secret": "",
    other: "x",
  });
  assert.deepEqual(plan.presets, { "google-client-id": "my-id" });
  assert.deepEqual(plan.later, ["google-client-secret"]);
  assert.deepEqual(plan.invalid, []);
  assert.deepEqual(plan.server.env, {
    GOOGLE_CLIENT_ID: "${input:google-client-id}",
    GOOGLE_CLIENT_SECRET: "${input:google-client-secret}",
  });
  // A password keeps its spaces (it's the user's secret as typed).
  assert.equal(
    planMcpAdd(npm.entry, { "google-client-secret": " s " }).presets["google-client-secret"],
    " s ",
  );
  const pick = {
    ...npm.entry,
    inputs: [{ id: "region", description: "Region", password: false, options: ["eu", "us"] }],
  };
  assert.deepEqual(planMcpAdd(pick, { region: "mars" }).invalid, ["region"]);
  assert.deepEqual(planMcpAdd(pick, { region: "eu" }).presets, { region: "eu" });
});

test("suggest_mcp_server: once per conversation unless taken up", () => {
  const card: Item = {
    type: "tool",
    id: "t1",
    callId: "c1",
    name: "suggest_mcp_server",
    args: {},
    status: "done",
    detail: JSON.stringify({ items: [] }),
  };
  const user = (text: string): Item => ({ type: "user", id: `u${text}`, text });
  assert.equal(mcpSuggestionRefusal([user("hi")]), null);
  assert.match(mcpSuggestionRefusal([card]) ?? "", /already suggested MCP servers/);
  assert.equal(mcpSuggestionRefusal([card, user("any other MCP server?")]), null);
  assert.equal(
    mcpSuggestionRefusal([{ ...card, detail: JSON.stringify({ engaged: true }) }]),
    null,
  );
});

test("mcp_status: rows from ide://agent/mcp, the model's lines, Reconnect", () => {
  const rows = statusRows([
    {
      name: "echo",
      state: "running",
      tools: 2,
      source: "user mcp.json",
      transport: "stdio",
      target: "node x",
    },
    {
      name: "broken",
      state: "failed",
      tools: 0,
      source: ".vscode/mcp.json",
      transport: "stdio",
      target: "node y",
      error: "spawn ENOENT",
    },
    { nope: true },
  ]);
  assert.equal(rows.length, 2);
  const broken = rows[1] as McpStatusRow;
  assert.equal(canReconnect(broken), true);
  assert.equal(canReconnect({ ...broken, state: "not started" }), false);
  const text = statusResult(rows);
  assert.match(text, /- echo: running, 2 tools/);
  assert.match(text, /- broken: failed .*error: spawn ENOENT/);
  assert.match(text, /Reconnect on the failed ones/);
  assert.match(statusResult([]), /No MCP servers are configured/);
  assert.match(statusResult([], "gh"), /No MCP server named gh/);
  const kept = parseMcpStatus(
    JSON.stringify({ servers: [{ ...rows[1], reconnected: "running" }] }),
  );
  assert.equal(kept?.servers[0]?.reconnected, "running");
});
