import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claudeEnabled,
  describeMcpEntry,
  findInstalled,
  hookCommandsOf,
  hooksTableOf,
  lspServersOf,
  mcpServersOf,
  normalizeRelative,
  parseClaudeInstalled,
  parseClaudeMarketplaces,
  parseMarketplace,
  parseMarketplaceInput,
  parsePluginManifest,
  parsePluginRef,
  parsePluginsFile,
  pluginParts,
  substitutePluginRoot,
} from "./plugins";

/** Claude Code's placeholder for a plugin's folder. */
const VAR = ["$", "{CLAUDE_PLUGIN_ROOT}"].join("");

/** The start of Claude Code's own marketplace.json (anthropics/claude-code, saved Nov 2026). */
const REAL_MARKETPLACE = `{
  "$schema": "https://json.schemastore.org/claude-code-marketplace.json",
  "name": "claude-code-plugins",
  "version": "1.0.0",
  "description": "Anthropic's Claude Code plugins, installed from the claude-plugins-official repository",
  "owner": { "name": "Anthropic", "email": "support@anthropic.com" },
  "plugins": [
    {
      "name": "agent-sdk-dev",
      "description": "Development kit for working with the Claude Agent SDK",
      "source": {
        "source": "git-subdir",
        "url": "https://github.com/anthropics/claude-plugins-official.git",
        "path": "plugins/agent-sdk-dev",
        "ref": "main"
      },
      "category": "development"
    },
    {
      "name": "commit-commands",
      "description": "Commands for git commit workflows including commit, push, and PR creation",
      "author": { "name": "Anthropic", "email": "support@anthropic.com" },
      "source": {
        "source": "git-subdir",
        "url": "https://github.com/anthropics/claude-plugins-official.git",
        "path": "plugins/commit-commands",
        "ref": "main"
      },
      "category": "productivity"
    }
  ],
  "renames": {}
}`;

test("reads Claude Code's own marketplace.json", () => {
  const r = parseMarketplace(REAL_MARKETPLACE);
  assert.ok("marketplace" in r);
  const m = r.marketplace;
  assert.equal(m.name, "claude-code-plugins");
  assert.equal(m.owner, "Anthropic");
  assert.equal(m.plugins.length, 2);
  assert.deepEqual(m.plugins[1]?.source, {
    kind: "git",
    url: "https://github.com/anthropics/claude-plugins-official.git",
    path: "plugins/commit-commands",
    ref: "main",
  });
  assert.equal(m.plugins[1]?.author, "Anthropic");
  assert.equal(m.plugins[1]?.category, "productivity");
  assert.deepEqual(m.problems, []);
});

test("marketplace sources: relative paths, pluginRoot, github, urls; bad ones are problems", () => {
  const r = parseMarketplace(
    JSON.stringify({
      name: "local",
      metadata: { pluginRoot: "./plugins" },
      plugins: [
        { name: "a", source: "./tools/a" },
        { name: "b", source: "b" },
        { name: "c", source: { source: "github", repo: "acme/c-plugin" } },
        { name: "d", source: { source: "url", url: "https://gitlab.com/x/d.git" } },
        { name: "e", source: "../outside" },
        { name: "f", source: { source: "npm", package: "f; rm -rf" } },
        { name: "n", source: { source: "npm", package: "@acme/n-plugin", version: "1.2.0" } },
        { name: "../g", source: "./g" },
        { name: "a", source: "./again" },
        { name: "h", source: "./h", strict: false, commands: ["./cmds"] },
      ],
    }),
  );
  assert.ok("marketplace" in r);
  const byName = new Map(r.marketplace.plugins.map((p) => [p.name, p]));
  assert.deepEqual(byName.get("a")?.source, { kind: "path", path: "tools/a" });
  assert.deepEqual(byName.get("b")?.source, { kind: "path", path: "plugins/b" });
  assert.deepEqual(byName.get("c")?.source, {
    kind: "git",
    url: "https://github.com/acme/c-plugin.git",
  });
  assert.deepEqual(byName.get("d")?.source, { kind: "git", url: "https://gitlab.com/x/d.git" });
  assert.equal(byName.get("h")?.strict, false);
  assert.deepEqual(byName.get("n")?.source, {
    kind: "npm",
    package: "@acme/n-plugin",
    version: "1.2.0",
  });
  assert.ok(!byName.has("e") && !byName.has("f"));
  assert.equal(r.marketplace.problems.length, 4);
  assert.ok("error" in parseMarketplace("{"));
  assert.ok("error" in parseMarketplace('{"plugins": []}'));
});

test("plugin.json: name, author, extra paths, inline hooks and MCP servers", () => {
  const r = parsePluginManifest(
    JSON.stringify({
      name: "formatter",
      version: "1.2.0",
      author: { name: "Ada" },
      commands: ["./extra/cmd.md"],
      agents: "./more-agents",
      hooks: { hooks: { Stop: [] } },
      mcpServers: "./servers.json",
    }),
  );
  assert.ok("manifest" in r);
  assert.equal(r.manifest.author, "Ada");
  const parts = pluginParts(r.manifest);
  assert.deepEqual(parts.commands, ["commands", "extra/cmd.md"]);
  assert.deepEqual(parts.agents, ["agents", "more-agents"]);
  assert.deepEqual(parts.skills, ["skills"]);
  assert.deepEqual(parts.inlineHooks, { hooks: { Stop: [] } });
  assert.equal(parts.mcpFile, "servers.json");
  assert.equal(
    pluginParts({ name: "x", commands: [], agents: [], skills: [] }).hooksFile,
    "hooks/hooks.json",
  );
  // No name: the folder's.
  const named = parsePluginManifest("{}", "folder-name");
  assert.ok("manifest" in named && named.manifest.name === "folder-name");
  assert.ok("error" in parsePluginManifest("{}"));
  assert.ok("error" in parsePluginManifest("not json"));
});

test("the plugin root variable is the plugin's folder, everywhere in a value", () => {
  const root = "C:\\Users\\me\\.ide\\plugins\\cache\\m\\p";
  assert.deepEqual(
    substitutePluginRoot(
      {
        command: "node",
        args: [`${VAR}/server.js`, "--x"],
        env: { DIR: VAR },
      },
      root,
    ),
    {
      command: "node",
      args: ["C:/Users/me/.ide/plugins/cache/m/p/server.js", "--x"],
      env: { DIR: "C:/Users/me/.ide/plugins/cache/m/p" },
    },
  );
  assert.equal(substitutePluginRoot(`python3 ${VAR}/h.py`, "/home/a/p/"), "python3 /home/a/p/h.py");
  assert.equal(substitutePluginRoot('sh "$CLAUDE_PLUGIN_ROOT/x.sh"', "/p"), 'sh "/p/x.sh"');
  // A `$` in the folder's name isn't read as a replacement pattern.
  assert.equal(substitutePluginRoot(VAR, "/a$&b"), "/a$&b");
});

test("/plugin marketplace add: github, URLs and folders", () => {
  assert.deepEqual(parseMarketplaceInput("anthropics/claude-code"), {
    kind: "git",
    url: "https://github.com/anthropics/claude-code.git",
  });
  assert.deepEqual(parseMarketplaceInput("anthropics/claude-code", true), {
    kind: "path",
    path: "anthropics/claude-code",
  });
  assert.deepEqual(parseMarketplaceInput("git@github.com:a/b.git"), {
    kind: "git",
    url: "git@github.com:a/b.git",
  });
  assert.deepEqual(parseMarketplaceInput('"C:\\my plugins"'), {
    kind: "path",
    path: "C:\\my plugins",
  });
  assert.equal(parseMarketplaceInput("  "), null);
});

test("relative paths stay inside", () => {
  assert.equal(normalizeRelative("./a/./b/"), "a/b");
  assert.equal(normalizeRelative("a/../b"), null);
  assert.equal(normalizeRelative("/etc"), null);
  assert.equal(normalizeRelative("C:/x"), null);
});

test("hooks and MCP files in their formats, and what they run", () => {
  const hooks = {
    description: "x",
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit",
          hooks: [{ type: "command", command: `python3 ${VAR}/h.py` }],
        },
      ],
      Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
    },
  };
  assert.deepEqual(hookCommandsOf(hooksTableOf(hooks)), [`python3 ${VAR}/h.py`, "echo done"]);
  assert.deepEqual(Object.keys(mcpServersOf({ mcpServers: { a: { command: "x" } } })), ["a"]);
  assert.deepEqual(Object.keys(mcpServersOf({ b: { url: "https://x" }, note: "y" })), ["b"]);
  assert.equal(describeMcpEntry("a", { command: "npx", args: ["-y", "srv"] }), "a: npx -y srv");
});

test("the record file and finding an installed plugin", () => {
  const file = parsePluginsFile(
    JSON.stringify({
      marketplaces: [
        { name: "m", source: { kind: "path", path: "/x" }, dir: "/p/m", addedAt: 1 },
        { name: "bad name!", source: { kind: "path", path: "/x" }, dir: "/p" },
      ],
      plugins: [
        { name: "fmt", marketplace: "m", dir: "/p/c/m/fmt", enabled: true, hooks: true },
        { name: "fmt", marketplace: "n", dir: "/p/c/n/fmt", enabled: false },
        { name: "lint", marketplace: "m", dir: "/p/c/m/lint" },
      ],
    }),
  );
  assert.equal(file.marketplaces.length, 1);
  assert.equal(file.plugins.length, 3);
  assert.equal(file.plugins[0]?.id, "fmt@m");
  assert.equal(file.plugins[0]?.mcp, false);
  assert.equal(file.plugins[2]?.enabled, true);
  assert.equal((findInstalled(file, "lint") as { id: string }).id, "lint@m");
  assert.equal((findInstalled(file, "fmt@n") as { id: string }).id, "fmt@n");
  assert.match((findInstalled(file, "fmt") as { error: string }).error, /several/);
  assert.match((findInstalled(file, "nope") as { error: string }).error, /No installed/);
  assert.deepEqual(parsePluginsFile("garbage"), { marketplaces: [], plugins: [] });
  assert.deepEqual(parsePluginRef("a@b"), { name: "a", marketplace: "b" });
  assert.equal(parsePluginRef("../x"), null);
});

test("D375: output styles and LSP servers of a plugin", () => {
  const r = parsePluginManifest(
    JSON.stringify({ name: "go-tools", outputStyles: "./styles", lspServers: "./lsp.json" }),
  );
  assert.ok("manifest" in r);
  const parts = pluginParts(r.manifest);
  assert.deepEqual(parts.outputStyles, ["output-styles", "styles"]);
  assert.equal(parts.lspFile, "lsp.json");
  assert.deepEqual(
    lspServersOf({
      go: { command: "gopls", args: ["serve"], extensionToLanguage: { ".GO": "go" } },
      bad: { command: "x" },
      odd: { command: "y", extensionToLanguage: { go: "go" } },
    }),
    [{ name: "go", command: "gopls", args: ["serve"], extensions: { ".go": "go" } }],
  );
  assert.equal(pluginParts(parsePluginManifestOk('{"name":"p"}')).lspFile, ".lsp.json");
});

function parsePluginManifestOk(text: string) {
  const r = parsePluginManifest(text);
  if (!("manifest" in r)) throw new Error(r.error);
  return r.manifest;
}

test("D375: Claude Code's record of installed plugins, both versions, and its marketplaces", () => {
  const v1 = parseClaudeInstalled(
    JSON.stringify({
      version: 1,
      plugins: { "fmt@acme": { installPath: "C:/u/.claude/plugins/cache/acme/fmt", version: "1" } },
    }),
  );
  assert.deepEqual(v1, [
    {
      id: "fmt@acme",
      name: "fmt",
      marketplace: "acme",
      dir: "C:/u/.claude/plugins/cache/acme/fmt",
      version: "1",
    },
  ]);
  const v2 = parseClaudeInstalled(
    JSON.stringify({
      version: 2,
      plugins: {
        "lint@acme": [
          { scope: "project", installPath: "/p/lint" },
          { scope: "user", installPath: "/u/lint" },
        ],
        "../x@acme": [{ scope: "user", installPath: "/x" }],
        nomarket: [{ scope: "user", installPath: "/y" }],
      },
    }),
  );
  assert.deepEqual(
    v2.map((p) => [p.id, p.dir]),
    [["lint@acme", "/u/lint"]],
  );
  assert.deepEqual(parseClaudeInstalled("not json"), []);
  assert.equal(claudeEnabled(null, "a@b"), true);
  assert.equal(claudeEnabled({ "a@b": false }, "a@b"), false);
  assert.equal(claudeEnabled({ "a@b": true }, "a@b"), true);
  assert.deepEqual(
    parseClaudeMarketplaces(
      JSON.stringify({
        official: { installLocation: "C:/u/.claude/plugins/marketplaces/official" },
      }),
    ),
    [{ name: "official", dir: "C:/u/.claude/plugins/marketplaces/official" }],
  );
});

test("D375: the IDE's own settings for Claude Code's plugins are kept in its record", () => {
  const f = parsePluginsFile(
    JSON.stringify({ marketplaces: [], plugins: [], claude: { "fmt@acme": { enabled: false } } }),
  );
  assert.deepEqual(f.claude, { "fmt@acme": { enabled: false, hooks: false, mcp: false } });
});
