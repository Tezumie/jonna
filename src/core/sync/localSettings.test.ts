import assert from "node:assert/strict";
import { test } from "node:test";
import { staysLocal } from "./localSettings";

test("sync: settings that run programs or point at paths stay on the computer", () => {
  for (const key of [
    "accounts.serverUrl",
    "sync.projects",
    "team.added",
    "team.off",
    "agent.hooks",
    "agent.statusLine",
    "agent.mcpServers",
    "agent.externalAgents",
    "agent.allowedCommands",
    "agent.runCommands",
    "agent.sandbox",
    "agent.sandbox.allowWrite",
    "agent.worktree.setupScript",
    "lsp.servers",
    "terminal.profiles.windows",
    "terminal.defaultProfile.linux",
    "terminal.automationProfile.osx",
    "task.allowAutomaticTasks",
    "debug.gdbPath",
    "debug.pythonPath",
    "python.defaultInterpreterPath",
    "remote.containers.dockerPath",
    "someExtension.toolPath",
  ])
    assert.equal(staysLocal(key), true, key);
  for (const key of [
    "editor.fontSize",
    "workbench.colorTheme",
    "terminal.bell",
    "agent.outputStyle",
    "agent.skills.disabled",
    "files.associations",
    "sync.chats",
    "editor.formatOnSave",
  ])
    assert.equal(staysLocal(key), false, key);
});
