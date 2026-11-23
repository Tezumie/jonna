import assert from "node:assert/strict";
import { test } from "node:test";
import { PersistenceService, recentWith, type StateBackend, withOwnChanges } from "./persistence";

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

test("persistence: a failed global write is reported to who asks, and never thrown", async () => {
  const disk = sharedDisk();
  const a = new PersistenceService(disk.backend);
  await a.loadGlobal();
  assert.equal(await a.saveGlobalChecked({ lastFolder: "/a" }), true);
  const save = disk.backend.save;
  disk.backend.save = async () => {
    throw new Error("disk full");
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await a.saveGlobalChecked({ lastFolder: "/b" }), false);
    // The plain save resolves as it always did.
    assert.equal(await a.saveGlobal({ lastFolder: "/c" }), undefined);
  } finally {
    console.warn = warn;
  }
  assert.equal(JSON.parse(disk.files.global ?? "{}").lastFolder, "/a");
  // This window keeps the values for now (the file is read again before the next write).
  assert.equal(a.globalState().lastFolder, "/c");
  disk.backend.save = save;
  assert.equal(await a.saveGlobalChecked({ hideImportLink: true }), true);
  assert.equal(JSON.parse(disk.files.global ?? "{}").hideImportLink, true);
});

/** A workspace with one contributor ("layout") whose value the test sets. */
function workspaceService(disk: ReturnType<typeof sharedDisk>) {
  const service = new PersistenceService(disk.backend);
  const restored: unknown[] = [];
  service.register("layout", { save: () => "this session", restore: (d) => void restored.push(d) });
  return { service, restored };
}

test("persistence: a workspace state that can't be read is never saved over", async () => {
  const disk = sharedDisk();
  const before = JSON.stringify({ version: 1, layout: "kept", "editor.hotExit": [{ path: "/a" }] });
  disk.files.workspace = before;
  const { service, restored } = workspaceService(disk);
  const warn = console.warn;
  console.warn = () => {};
  try {
    disk.failLoads(true);
    await service.restoreWorkspace();
    assert.deepEqual(restored, []);
    assert.equal(service.workspaceSavesHeld(), true);
    // Saves wait while the file stays unreadable.
    await service.flush();
    assert.equal(disk.files.workspace, before);
    // Readable again: what it held (never restored here) is kept inside what is saved.
    disk.failLoads(false);
    await service.flush();
    assert.equal(service.workspaceSavesHeld(), false);
    const saved = JSON.parse(disk.files.workspace ?? "{}");
    assert.equal(saved.layout, "this session");
    assert.equal(saved.unrestored, before);
    // The next folder starts clean.
    service.closeWorkspace();
    disk.files.workspace = null;
    await service.restoreWorkspace();
    await service.flush();
    assert.equal("unrestored" in JSON.parse(disk.files.workspace ?? "{}"), false);
  } finally {
    console.warn = warn;
  }
});

test("persistence: a read that fails once is tried again before giving up", async () => {
  const disk = sharedDisk();
  disk.files.workspace = JSON.stringify({ version: 1, layout: "kept" });
  const { service, restored } = workspaceService(disk);
  const load = disk.backend.load;
  let failures = 1;
  disk.backend.load = async (scope) => {
    if (failures-- > 0) throw new Error("sharing violation");
    return load(scope);
  };
  await service.restoreWorkspace();
  assert.deepEqual(restored, ["kept"]);
  assert.equal(service.workspaceSavesHeld(), false);
});

test("persistence: a state file of another version or damaged is kept in the saved state", async () => {
  for (const other of [
    JSON.stringify({ version: 2, layout: "newer build" }),
    '{ "version": 1, "lay',
  ]) {
    const disk = sharedDisk();
    disk.files.workspace = other;
    const { service, restored } = workspaceService(disk);
    await service.restoreWorkspace();
    assert.deepEqual(restored, []);
    assert.equal(service.workspaceSavesHeld(), false);
    await service.flush();
    assert.equal(JSON.parse(disk.files.workspace ?? "{}").unrestored, other);
    // Another start: the copy is carried on as it is, not wrapped once more.
    const again = workspaceService(disk);
    await again.service.restoreWorkspace();
    assert.deepEqual(again.restored, ["this session"]);
    await again.service.flush();
    assert.equal(JSON.parse(disk.files.workspace ?? "{}").unrestored, other);
  }
  // A state that restores normally carries nothing extra.
  const disk = sharedDisk();
  disk.files.workspace = JSON.stringify({ version: 1, layout: "kept" });
  const { service } = workspaceService(disk);
  await service.restoreWorkspace();
  await service.flush();
  assert.deepEqual(JSON.parse(disk.files.workspace ?? "{}"), {
    version: 1,
    layout: "this session",
  });
});

test("recentWith and withOwnChanges build on what is stored now (another window's changes stay)", async () => {
  assert.deepEqual(recentWith(["b", "a", "c"], "a", 3), ["a", "b", "c"]);
  assert.deepEqual(recentWith(["b", "c", "d"], "a", 3), ["a", "b", "c"]);
  assert.deepEqual(recentWith(undefined, "a", 3), ["a"]);
  // Two windows, each with the list it loaded: both commands end up stored.
  const disk = sharedDisk(JSON.stringify({ version: 1, recentCommands: ["old"] }));
  const a = new PersistenceService(disk.backend);
  const b = new PersistenceService(disk.backend);
  await a.loadGlobal();
  await b.loadGlobal();
  await b.saveGlobal((g) => ({ recentCommands: recentWith(g.recentCommands, "from.b", 12) }));
  await a.saveGlobal((g) => ({ recentCommands: recentWith(g.recentCommands, "from.a", 12) }));
  assert.deepEqual(JSON.parse(disk.files.global ?? "{}").recentCommands, [
    "from.a",
    "from.b",
    "old",
  ]);

  // This window changed x, removed y, set z; another window meanwhile changed w and added v.
  const before = { w: "info", x: "info", y: "debug" };
  const now = { w: "info", x: "trace", z: "error" };
  const stored = { w: "off", x: "info", y: "debug", v: "warning" };
  assert.deepEqual(withOwnChanges(stored, before, now), {
    w: "off",
    x: "trace",
    v: "warning",
    z: "error",
  });
  assert.deepEqual(withOwnChanges(undefined, {}, { a: "info" }), { a: "info" });
});
