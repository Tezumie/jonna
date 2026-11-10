import assert from "node:assert/strict";
import { test } from "node:test";
import { commandTouchesConfig, protectedConfig } from "./agentConfigFiles";

test("protected config files: other agents' settings, MCP lists, startup files", () => {
  assert.equal(protectedConfig("/home/me/.codex/config.toml")?.risk, "codex");
  assert.equal(protectedConfig("C:\\Users\\Me\\.codex\\config.toml")?.risk, "codex");
  assert.equal(protectedConfig("~/.codex/AGENTS.md")?.risk, "codex");
  assert.equal(protectedConfig(".claude/settings.json")?.risk, "claude");
  assert.equal(protectedConfig("app/.claude/settings.local.json")?.risk, "claude");
  assert.equal(protectedConfig("C:\\Users\\Me\\.CLAUDE\\Settings.json")?.risk, "claude");
  assert.equal(protectedConfig("/home/me/.claude.json")?.risk, "claude");
  // Claude Code's commands and rules are ordinary files the agent may edit.
  assert.equal(protectedConfig(".claude/commands/review.md"), null);
  assert.equal(protectedConfig(".claude/CLAUDE.md"), null);
  assert.equal(protectedConfig(".mcp.json")?.risk, "mcp");
  assert.equal(protectedConfig("/home/me/.cursor/mcp.json")?.risk, "mcp");
  assert.equal(protectedConfig(".vscode/mcp.json")?.risk, "mcp");
  assert.equal(protectedConfig(".jonna/mcp.json", ".jonna")?.risk, "mcp");
  assert.equal(protectedConfig("docs/mcp.json"), null);
  assert.equal(protectedConfig(".gemini/settings.json")?.risk, "agent");
  assert.equal(protectedConfig(".vscode/settings.json"), null);
  assert.equal(protectedConfig("/home/me/.bashrc")?.risk, "shell");
  assert.equal(protectedConfig("/home/me/.zshrc")?.risk, "shell");
  assert.equal(
    protectedConfig("C:\\Users\\Me\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1")?.risk,
    "shell",
  );
  assert.equal(
    protectedConfig("C:\\Users\\Me\\Documents\\WindowsPowerShell\\profile.ps1")?.risk,
    "shell",
  );
  assert.equal(protectedConfig("scripts/profile.ps1"), null);
  assert.equal(protectedConfig("/home/me/.config/fish/config.fish")?.risk, "shell");
  assert.equal(protectedConfig(".npmrc")?.risk, "shell");
  assert.equal(protectedConfig(".git/hooks/pre-commit")?.risk, "git");
  assert.equal(protectedConfig(".git/config")?.risk, "git");
  assert.equal(protectedConfig(".gitignore"), null);
  assert.equal(protectedConfig("/home/me/.ssh/authorized_keys")?.risk, "ssh");
  assert.equal(
    protectedConfig(
      "C:\\Users\\Me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.lnk",
    )?.risk,
    "startup",
  );
  // Windows ignores a trailing dot: `.bashrc.` is .bashrc.
  assert.equal(protectedConfig(".claude/settings.json.")?.risk, "claude");
  assert.equal(protectedConfig("src/index.ts"), null);
  assert.equal(protectedConfig(""), null);
});

test("protected config files: in command lines", () => {
  assert.equal(commandTouchesConfig("echo 'export X=1' >> ~/.bashrc")?.risk, "shell");
  assert.equal(commandTouchesConfig("cp evil.toml $HOME/.codex/config.toml")?.risk, "codex");
  assert.equal(commandTouchesConfig("codex mcp add helper -- node x.js")?.risk, "mcp");
  assert.equal(commandTouchesConfig("claude mcp add-json x '{}'")?.risk, "mcp");
  assert.equal(
    commandTouchesConfig("codex --dangerously-bypass-approvals-and-sandbox")?.risk,
    "agent",
  );
  assert.equal(commandTouchesConfig("codex exec -c approval_policy=never hi")?.risk, "agent");
  assert.equal(
    commandTouchesConfig("Set-Content -Path .claude\\settings.json -Value x")?.risk,
    "claude",
  );
  assert.equal(commandTouchesConfig("npm test"), null);
  assert.equal(commandTouchesConfig("git commit -m 'fix .mcp handling'"), null);
  assert.equal(commandTouchesConfig("codex --version"), null);
});

test("a file's default NTFS stream and .. segments name the protected file", () => {
  assert.equal(protectedConfig("/u/.claude/settings.json::$DATA")?.risk, "claude");
  assert.equal(protectedConfig("/u/.bashrc::$data")?.risk, "shell");
  assert.equal(protectedConfig("/r/.git:$I30:$INDEX_ALLOCATION/config")?.risk, "git");
  assert.equal(protectedConfig("/r/.git/x/../config")?.risk, "git");
  assert.equal(commandTouchesConfig("cp evil .git/info/../config")?.risk, "git");
  // A named stream of an ordinary file, and .. that leaves the folder, aren't protected.
  assert.equal(protectedConfig("/r/notes.txt:zone"), null);
  assert.equal(protectedConfig("/r/.ssh/../notes.txt"), null);
});
