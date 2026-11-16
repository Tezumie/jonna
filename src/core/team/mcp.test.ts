import assert from "node:assert/strict";
import { test } from "node:test";
import { asksBeforeStart, mergeServers, usesRawSecret } from "../mcp/config";
import { type McpServerConfig, parseMcpConfig } from "../settings/vscodeImport";
import { literalSecretIn, mcpForTeam } from "./mcp";

test("team mcp: a secret written out is never published", () => {
  const cases: [McpServerConfig, string][] = [
    [
      { command: "npx", env: { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } },
      "env GITHUB_TOKEN",
    ],
    // Whatever the value looks like, under a name that says "secret".
    [{ command: "npx", env: { API_KEY: "hunter2" } }, "env API_KEY"],
    [{ command: "npx", env: { DB_PASSWORD: "correct horse" } }, "env DB_PASSWORD"],
    [
      { url: "https://x.example", headers: { Authorization: "Bearer abc123" } },
      "headers Authorization",
    ],
    [{ url: "https://x.example", headers: { "X-Api-Key": "abc" } }, "headers X-Api-Key"],
    // Whatever it is called, when it reads as a key.
    [{ command: "npx", env: { REGION: "sk-proj-abcdefgh12345678" } }, "env REGION"],
    [{ command: "npx", env: { EXTRA: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4" } }, "env EXTRA"],
    [{ command: "npx", env: { TOKEN: "${secret:mcp.input.github::token}" } }, "env TOKEN"],
    [{ command: "npx", args: ["--key", "AKIAIOSFODNN7EXAMPLE"] }, "an argument"],
    [{ url: "https://x.example/mcp?api_key=abc123" }, "its address"],
    [{ url: "https://user:pass@x.example/mcp" }, "its address"],
  ];
  for (const [config, where] of cases)
    assert.equal(literalSecretIn(config), where, JSON.stringify(config));
});

test("team mcp: placeholders and plain values are published", () => {
  const fine: McpServerConfig[] = [
    {
      command: "npx",
      args: ["-y", "@acme/server@1.2.0"],
      env: { GITHUB_TOKEN: "${input:github-token}" },
    },
    { command: "npx", env: { API_KEY: "${env:ACME_KEY}" } },
    { url: "https://x.example/mcp", headers: { Authorization: "Bearer ${input:token}" } },
    {
      command: "node",
      args: ["${workspaceFolder}/tools/server.js"],
      env: { LOG_LEVEL: "debug", REGION: "eu-west-1" },
    },
    { command: "uvx", args: ["mcp-server-fetch"], env: { HOME_DIR: "${userHome}/.cache" } },
    { url: "https://x.example/mcp?mode=fast" },
  ];
  for (const config of fine) assert.equal(literalSecretIn(config), null, JSON.stringify(config));
});

test("team mcp: the file published holds servers and the inputs they use, nothing else", () => {
  const mine = {
    servers: {
      github: { command: "npx", args: ["-y", "gh-mcp"], env: { GITHUB_TOKEN: "${input:gh}" } },
      local: { command: "node", args: ["server.js"], env: { TOKEN: "abc" } },
    },
    inputs: [
      {
        id: "gh",
        type: "promptString",
        description: "GitHub token",
        password: true,
        default: "ghp_x",
      },
      { id: "unused", type: "promptString", description: "Other", password: true },
    ],
    secrets: { leaked: "x" },
  };
  // One server holds a key: the whole publish is refused, saying which and where.
  const refused = mcpForTeam(mine);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.reason, /local.*env TOKEN.*\$\{input:name\}/);
  // Without it: published, with only the input it uses and never a typed-in default.
  const made = mcpForTeam(mine, ["github"]);
  assert.ok(made.ok);
  const text = made.ok ? made.text : "";
  assert.deepEqual(JSON.parse(text), {
    servers: {
      github: { command: "npx", args: ["-y", "gh-mcp"], env: { GITHUB_TOKEN: "${input:gh}" } },
    },
    inputs: [{ id: "gh", type: "promptString", description: "GitHub token", password: true }],
  });
  assert.ok(!text.includes("leaked") && !text.includes("ghp_x"));
  // It reads back as the app's own mcp.json does.
  const back = parseMcpConfig(JSON.parse(text));
  assert.deepEqual(Object.keys(back.servers), ["github"]);
  assert.equal(back.inputs[0]?.password, true);
  assert.equal(mcpForTeam(mine, ["nope"]).ok, false);
  assert.equal(mcpForTeam({}).ok, false);
});

test("team mcp: a team's servers ask before they start, and one naming a stored secret isn't started", () => {
  assert.equal(asksBeforeStart("team"), true);
  assert.equal(asksBeforeStart("workspace"), true);
  // The user's own, other tools' and extensions' don't ask.
  for (const kind of ["settings", "discovered", "extension"] as const)
    assert.equal(asksBeforeStart(kind), false, kind);
  assert.equal(usesRawSecret({ command: "x", env: { K: "${secret:mcp.input.a::b}" } }), true);
  // The user's own server of a name wins over the team's of that name.
  const merged = mergeServers([
    {
      label: "user mcp.json",
      kind: "settings",
      servers: { docs: { command: "mine" } },
      inputs: [],
    },
    {
      label: "team Studio",
      kind: "team",
      servers: { docs: { command: "theirs" }, db: { command: "db" } },
      inputs: [],
    },
  ]);
  assert.deepEqual(
    merged.map((m) => [m.name, m.config.command, m.source.kind]),
    [
      ["docs", "mine", "settings"],
      ["db", "db", "team"],
    ],
  );
});
