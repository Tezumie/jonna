import assert from "node:assert/strict";
import { test } from "node:test";
import { PersistenceService, type StateBackend } from "./persistence";

/** One state file shared by several windows (each its own PersistenceService). */
function sharedDisk(initial: string | null = null) {
  const files: Record<string, string | null> = { global: initial, workspace: null };
  let failLoads = false;
  const backend: StateBackend = {
    load: async (scope) => {
      if (failLoads) throw new Error("sharing violation");
      return files[scope] ?? null;
    },
    save: async (scope, json) => {
      files[scope] = json;
    },
  };
  return {
    backend,
    files,
    failLoads: (v: boolean) => {
      failLoads = v;
    },
  };
}

test("persistence: a window's save keeps what another window wrote since it loaded", async () => {
  const disk = sharedDisk();
  const a = new PersistenceService(disk.backend);
  const b = new PersistenceService(disk.backend);
  await a.loadGlobal();
  await b.loadGlobal();
  // B trusts a folder; A, loaded before, then opens one.
  await b.saveGlobal((g) => ({ trust: { ...g.trust, "/work/app": true } }));
  await a.saveGlobal({ lastFolder: "/work/other" });
  const saved = JSON.parse(disk.files.global ?? "{}");
  assert.deepEqual(saved.trust, { "/work/app": true });
  assert.equal(saved.lastFolder, "/work/other");
  // B takes its trust back; A's next save must not bring it back.
  await b.saveGlobal((g) => ({ trust: { ...g.trust, "/work/app": false } }));
  await a.saveGlobal({ hideImportLink: true });
  assert.deepEqual(JSON.parse(disk.files.global ?? "{}").trust, { "/work/app": false });
  assert.deepEqual(a.globalState().trust, { "/work/app": false });
});

test("persistence: an unreadable or corrupt file keeps what the window has", async () => {
  const disk = sharedDisk(JSON.stringify({ version: 1, recentFolders: ["/a"] }));
  const a = new PersistenceService(disk.backend);
  await a.loadGlobal();
  disk.failLoads(true);
  await a.saveGlobal({ lastFolder: "/a" });
  assert.deepEqual(JSON.parse(disk.files.global ?? "{}").recentFolders, ["/a"]);
  disk.failLoads(false);
  disk.files.global = "{ not json";
  await a.saveGlobal({ hideImportLink: true });
  const saved = JSON.parse(disk.files.global ?? "{}");
  assert.deepEqual(saved.recentFolders, ["/a"]);
  assert.equal(saved.hideImportLink, true);
});

test("persistence: saves run in order", async () => {
  const disk = sharedDisk();
  const a = new PersistenceService(disk.backend);
  await Promise.all([
    a.saveGlobal((g) => ({ recentFolders: [...(g.recentFolders ?? []), "/one"] })),
    a.saveGlobal((g) => ({ recentFolders: [...(g.recentFolders ?? []), "/two"] })),
  ]);
  assert.deepEqual(JSON.parse(disk.files.global ?? "{}").recentFolders, ["/one", "/two"]);
});

test("persistence: a contributor marked early is restored before the others (D244)", async () => {
  const disk = sharedDisk();
  disk.files.workspace = JSON.stringify({ version: 1, dock: 1, channels: 2 });
  const service = new PersistenceService(disk.backend);
  const order: string[] = [];
  service.register("dock", { save: () => 1, restore: () => void order.push("dock") });
  service.register("channels", {
    early: true,
    save: () => 2,
    restore: () => void order.push("channels"),
  });
  await service.restoreWorkspace();
  assert.deepEqual(order, ["channels", "dock"]);
});

test("persistence: every global key survives a read and a save (D293)", async () => {
  const disk = sharedDisk();
  const a = new PersistenceService(disk.backend);
  await a.loadGlobal();
  await a.saveGlobal({
    recentCommands: ["git.commit"],
    teamAgentsSeeded: true,
    teamAgentsWritten: ["planner"],
    teamIconsModel: false,
  });
  // Another window reads it, saves something else: the keys are still there.
  const b = new PersistenceService(disk.backend);
  await b.loadGlobal();
  await b.saveGlobal({ lastFolder: "/x" });
  const saved = JSON.parse(disk.files.global ?? "{}");
  assert.deepEqual(saved.recentCommands, ["git.commit"]);
  assert.equal(saved.teamAgentsSeeded, true);
  assert.deepEqual(saved.teamAgentsWritten, ["planner"]);
  assert.equal(saved.teamIconsModel, false);
  assert.deepEqual(b.globalState().recentCommands, ["git.commit"]);
});

test("D344: hidden notices survive a reload, and only strings are kept", async () => {
  const disk = sharedDisk();
  const a = new PersistenceService(disk.backend);
  await a.loadGlobal();
  await a.saveGlobal({ hiddenNotices: ["lsp.yield.pyright.ms-python.python"] });
  const raw = JSON.parse(disk.files.global ?? "{}");
  disk.files.global = JSON.stringify({ ...raw, hiddenNotices: [...raw.hiddenNotices, 7] });
  const b = new PersistenceService(disk.backend);
  await b.loadGlobal();
  assert.deepEqual(b.globalState().hiddenNotices, ["lsp.yield.pyright.ms-python.python"]);
});
