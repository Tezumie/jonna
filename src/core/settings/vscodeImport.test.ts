import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionFate, parseMcpConfig, translateKeybindings, translateWhen } from "./vscodeImport";

test("VS Code keybindings use the IDE's commands and contexts", () => {
  const ours = new Set([
    "palette.show",
    "editor.save",
    "editor.runAction",
    "git.push",
    "debug.start",
  ]);
  const { rules, skipped } = translateKeybindings(
    [
      { key: "ctrl+shift+p", command: "workbench.action.showCommands" },
      { key: "ctrl+s", command: "workbench.action.files.save", when: "editorTextFocus && !isMac" },
      { key: "ctrl+/", command: "editor.action.commentLine", when: "editorTextFocus" },
      { key: "ctrl+alt+p", command: "git.push" },
      { key: "f5", command: "-workbench.action.debug.start" },
      { key: "ctrl+k", command: "gitlens.showGraph" },
      { key: "ctrl+j", command: "workbench.action.debug.start", when: "someExtension.ready" },
      { key: "x", command: "-editor.action.commentLine" },
    ],
    (c) => ours.has(c),
  );
  assert.deepEqual(rules, [
    { key: "ctrl+shift+p", command: "palette.show" },
    { key: "ctrl+s", command: "editor.save", when: "editorFocus && !isMac" },
    {
      key: "ctrl+/",
      command: "editor.runAction",
      when: "editorFocus",
      args: { action: "editor.action.commentLine" },
    },
    { key: "ctrl+alt+p", command: "git.push" },
    { key: "f5", command: "-debug.start" },
  ]);
  assert.deepEqual(
    skipped.map((s) => s.command),
    ["gitlens.showGraph", "workbench.action.debug.start", "-editor.action.commentLine"],
  );
});

test("when clauses keep quoted values and reject unknown contexts", () => {
  assert.equal(translateWhen("debugState == 'stopped'"), "debugState == 'stopped'");
  assert.equal(translateWhen("inQuickOpen"), "quickInputVisible");
  assert.equal(translateWhen("resourceExtname == .ts"), null);
  assert.equal(translateWhen(""), undefined);
});

test("extensions install from Open VSX unless the IDE replaces them outright", () => {
  assert.equal(extensionFate("formulahendry.auto-close-tag").kind, "setting");
  assert.equal(extensionFate("christian-kohler.path-intellisense").kind, "builtin");
  // VS Code extensions run here: these install (with a note on what's also built in).
  const claude = extensionFate("Anthropic.claude-code");
  assert.equal(claude.kind, "store");
  assert.match((claude as { note?: string }).note ?? "", /agent panel/);
  assert.equal(extensionFate("ms-toolsai.jupyter").kind, "store");
  assert.equal(extensionFate("rust-lang.rust-analyzer").kind, "store");
  assert.deepEqual(extensionFate("someone.unknown"), { kind: "store" });
});

test("MCP configs in VS Code's, the portable and Claude Desktop's formats", () => {
  const vscode = parseMcpConfig({
    inputs: [
      { type: "promptString", id: "gh-token", description: "GitHub token", password: true },
      { type: "pickString", id: "other" },
    ],
    servers: {
      github: {
        type: "http",
        url: "https://api.example.com/mcp",
        headers: { Authorization: "Bearer ${input:gh-token}" },
      },
      fs: { type: "stdio", command: "npx", args: ["-y", "server-fs", 3], env: { A: "1", B: 2 } },
      broken: { type: "stdio" },
    },
  });
  assert.deepEqual(Object.keys(vscode.servers), ["github", "fs"]);
  assert.equal(vscode.servers.github?.type, "http");
  assert.deepEqual(vscode.servers.fs, {
    command: "npx",
    args: ["-y", "server-fs"],
    env: { A: "1" },
  });
  assert.deepEqual(vscode.inputs, [
    { id: "gh-token", description: "GitHub token", password: true },
  ]);
  const desktop = parseMcpConfig({
    mcpServers: { memory: { command: "uvx", args: ["mcp-memory"] } },
  });
  assert.deepEqual(desktop.servers.memory, { command: "uvx", args: ["mcp-memory"] });
});
