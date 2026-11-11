// D223: registry runner options checked, address variables and choices, password inputs keyed by
// what the server is, the lent server for stdio-only agents.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMcpConfig } from "../settings/vscodeImport";
import { chatToken, ideMcpServer, isIdeToolRequest, newChatKey } from "./agentAccess";
import { identityHash, secretId, serverIdentity } from "./config";
import { galleryConfig } from "./gallery";
import { registryEntry, registryRefusal, runnerRisks } from "./registry";

test("dangerous docker options are refused, others shown", () => {
  for (const args of [
    ["--privileged"],
    ["--privileged=true"],
    ["-v", "/:/host"],
    ["--volume=/etc:/etc"],
    ["-v", "/var/run/docker.sock:/var/run/docker.sock"],
    ["-v", "C:\\:/c"],
    ["-v", "~:/home"],
    ["--mount", "type=bind,source=/,target=/host"],
    ["--pid", "host"],
    ["--network=host"],
    ["--cap-add", "SYS_ADMIN"],
    ["--device", "/dev/kmsg"],
    ["--security-opt", "seccomp=unconfined"],
  ])
    assert.notEqual(runnerRisks("oci", args).refuse, null, args.join(" "));
  const fine = runnerRisks("oci", ["-e", "TOKEN", "-v", "data:/data", "--network", "none"]);
  assert.deepEqual(fine, { refuse: null, warnings: [] });
  const shown = runnerRisks("oci", ["-v", "/srv/cache:/cache", "-p", "8080:80", "-u", "root"]);
  assert.equal(shown.refuse, null);
  assert.deepEqual(shown.warnings, [
    "mounts /srv/cache from this computer",
    "opens port 8080:80",
    "runs as root in the container",
  ]);
  // Read as docker reads them, and with inputs' defaults and choices (D226 audit).
  for (const [args, inputs] of [
    [["-v/:/h"]],
    [["-v=/:/h"]],
    [["-vC:\\:/h"]],
    [["-itv", "/:/h"]],
    [["--mount", "type=bind,Source=/,target=/h"]],
    [["--mount", 'type=bind,"src=/",dst=/h']],
    [["-v", "/:/host/${input:sub}"]],
    [["-v", "${input:d}"], new Map([["d", { options: ["/:/host"] }]])],
    [["-v", "${input:d}:/x"], new Map([["d", { default: "/" }]])],
    [["-v", "/.:/h"]],
    [["-v", "/tmp/..:/h"]],
    [["-v", "\\\\?\\C:\\:/h"]],
    [["-v", "/run:/r"]],
    [["--net=HOST"]],
  ] as [string[], Map<string, { default?: string; options?: string[] }>?][])
    assert.notEqual(runnerRisks("oci", args, inputs).refuse, null, args.join(" "));
  for (const args of [["-c=sh x"], ["-ccurl x"], ["--call", "sh"]])
    assert.notEqual(runnerRisks("npm", args).refuse, null, args.join(" "));
  // A path the user types isn't judged.
  assert.deepEqual(runnerRisks("oci", ["-v", "${input:folder}:/data"]).warnings, []);
});

test("npx and uvx options that run other things", () => {
  assert.notEqual(runnerRisks("npm", ["-c", "curl x | sh"]).refuse, null);
  assert.notEqual(runnerRisks("npm", ["--call=sh"]).refuse, null);
  assert.deepEqual(runnerRisks("npm", ["-y", "--registry", "https://npm.evil.dev"]).warnings, [
    "installs from https://npm.evil.dev instead of npm",
  ]);
  assert.deepEqual(runnerRisks("pypi", ["--index-url", "https://pypi.evil.dev"]).warnings, [
    "installs from https://pypi.evil.dev instead of PyPI",
  ]);
});

test("a registry entry with a refused option isn't offered; one with a risky one says so", () => {
  const server = (runtimeArguments: { type: "named"; name: string; value?: string }[]) => ({
    name: "io.github.acme/box",
    packages: [{ registryType: "oci", identifier: "acme/box", version: "1", runtimeArguments }],
  });
  const bad = server([
    { type: "named", name: "--privileged" },
    { type: "named", name: "-v", value: "/:/host" },
  ]);
  // A named argument with nothing to fill in is a flag, passed as it is: --privileged is refused.
  assert.equal(registryEntry(bad), null);
  assert.match(registryRefusal(bad) ?? "", /--privileged/);
  const mount = server([{ type: "named", name: "-v", value: "/:/host" }]);
  assert.equal(registryEntry(mount), null);
  assert.match(registryRefusal(mount) ?? "", /mounts \/ into the container/);
  const risky = registryEntry(server([{ type: "named", name: "-p", value: "3000:3000" }]));
  assert.deepEqual(risky?.warnings, ["opens port 3000:3000"]);
  assert.deepEqual(risky?.config.args, ["run", "-i", "--rm", "-p", "3000:3000", "acme/box:1"]);
});

test("an address with variables and an argument with choices become inputs", () => {
  const remote = registryEntry({
    name: "io.acme/cloud",
    remotes: [
      {
        type: "streamable-http",
        url: "https://{region}.acme.dev/mcp",
        variables: { region: { description: "Region", choices: ["eu", "us"], default: "eu" } },
      },
    ],
  });
  assert.equal(remote?.config.url, "https://${input:region}.acme.dev/mcp");
  assert.deepEqual(remote?.inputs, [
    { id: "region", description: "Region", password: false, options: ["eu", "us"], default: "eu" },
  ]);
  const local = registryEntry({
    name: "io.acme/tool",
    packages: [
      {
        registryType: "npm",
        identifier: "acme-tool",
        packageArguments: [
          { type: "named", name: "--mode", choices: ["read", "write"], default: "read" },
        ],
      },
    ],
  });
  assert.deepEqual(local?.config.args, ["-y", "acme-tool", "--mode", "${input:mode}"]);
  const written = galleryConfig(local ?? (null as never)).inputs;
  assert.deepEqual(written, [
    {
      type: "pickString",
      id: "mode",
      description: "--mode",
      password: false,
      options: ["read", "write"],
      default: "read",
    },
  ]);
  // mcp.json's pickString inputs are read back (VS Code's format; { label, value } too).
  const parsed = parseMcpConfig({
    servers: {},
    inputs: [
      {
        type: "pickString",
        id: "mode",
        description: "Mode",
        options: ["read", { label: "W", value: "write" }],
        default: "read",
      },
      { type: "pickString", id: "empty", options: [] },
    ],
  });
  assert.deepEqual(parsed.inputs, [
    {
      id: "mode",
      description: "Mode",
      password: false,
      options: ["read", "write"],
      default: "read",
    },
  ]);
});

test("password inputs are stored by what the server is, not only its name", async () => {
  const mine = { url: "https://api.githubcopilot.com/mcp/", headers: {} };
  const theirs = { url: "https://evil.example/mcp" };
  assert.notEqual(await identityHash(mine), await identityHash(theirs));
  // The same server with a query or a trailing slash, or a newer version pin, is the same.
  assert.equal(
    serverIdentity({ url: "https://api.githubcopilot.com/mcp?x=1" }),
    serverIdentity(mine),
  );
  assert.equal(
    serverIdentity({ command: "npx", args: ["-y", "@acme/mcp@1.2.3"] }),
    serverIdentity({
      command: "C:\\Program Files\\nodejs\\npx.cmd",
      args: ["-y", "@acme/mcp@1.3.0"],
    }),
  );
  assert.notEqual(
    serverIdentity({ command: "npx", args: ["-y", "@acme/mcp"] }),
    serverIdentity({ command: "npx", args: ["-y", "@evil/mcp"] }),
  );
  // A program from the folder, or another environment, is another server (D226 audit).
  const npx = { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] };
  assert.notEqual(serverIdentity({ ...npx, command: "./tools/npx" }), serverIdentity(npx));
  assert.notEqual(
    serverIdentity({ ...npx, env: { NODE_OPTIONS: "--require ./steal.js" } }),
    serverIdentity(npx),
  );
  assert.notEqual(serverIdentity({ ...npx, cwd: "evil" }), serverIdentity(npx));
  const hash = await identityHash(mine);
  assert.match(hash, /^[0-9a-f]{12}$/);
  // Still under the server's own prefix, which Rust checks (secrets.rs mcp_prefix).
  assert.equal(secretId("github", "token", hash), `mcp.input.github::token@${hash}`);
  assert.equal(secretId("github", "token"), "mcp.input.github::token");
});

test("the lent server for HTTP and stdio-only agents", () => {
  const lent = { url: "http://127.0.0.1:4100/mcp", token: "t0k" };
  assert.deepEqual(ideMcpServer(lent, "My IDE", null), {
    type: "http",
    name: "myide",
    url: lent.url,
    headers: [{ name: "Authorization", value: "Bearer t0k" }],
  });
  const proxy = {
    command: "C:\\Program Files\\IDE\\ide.exe",
    flag: "--mcp-stdio-proxy",
    tokenEnv: "IDE_MCP_PROXY_TOKEN",
  };
  const stdio = ideMcpServer(lent, "My IDE", proxy);
  assert.deepEqual(stdio, {
    name: "myide",
    command: proxy.command,
    args: ["--mcp-stdio-proxy", lent.url],
    env: [{ name: "IDE_MCP_PROXY_TOKEN", value: "t0k" }],
  });
  // The token is never on the command line.
  assert.ok(!JSON.stringify("args" in stdio ? stdio.args : []).includes("t0k"));
  // A chat's token carries its key (D419); the agent's own question about one of the server's
  // tools is recognized by the server's name (D420), another server's isn't.
  assert.equal(
    chatToken(
      "t0k",
      newChatKey((b) => b.fill(171)),
    ),
    `t0k.${"ab".repeat(16)}`,
  );
  assert.equal(isIdeToolRequest("mcp__myide__ide_run_command", "My IDE"), true);
  assert.equal(isIdeToolRequest("mcp__github__create_issue", "My IDE"), false);
  assert.equal(isIdeToolRequest("Run npm test", "My IDE"), false);
});
