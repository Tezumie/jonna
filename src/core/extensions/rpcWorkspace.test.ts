// D251: the workspace's folders for extensions — asRelativePath, getWorkspaceFolder,
// updateWorkspaceFolders' checks, the path gate and the worker's mirror.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isWithin, resolveInRoot } from "../paths/index";
import { folderOf } from "../workspace/workspaceFile";
import { createWorkerApi, type FromWorker, type RequestMessage, type ToWorker } from "./rpc";
import {
  asRelativePath,
  gateWorkspacePath,
  getWorkspaceFolder,
  planFolderUpdate,
  readSnapshot,
  relativeCandidates,
  type WorkspaceFolder,
  type WorkspaceGate,
} from "./rpcWorkspace";

const one: WorkspaceFolder[] = [{ path: "/ws", name: "ws", index: 0 }];
const two: WorkspaceFolder[] = [
  { path: "/ws", name: "web", index: 0 },
  { path: "/srv/api", name: "api", index: 1 },
];
const win: WorkspaceFolder[] = [
  { path: "C:\\Work\\web", name: "web", index: 0 },
  { path: "D:\\api", name: "api", index: 1 },
];

test("getWorkspaceFolder: the folder holding an absolute path, the innermost when nested", () => {
  assert.equal(getWorkspaceFolder(two, "/srv/api/src/a.ts")?.name, "api");
  assert.equal(getWorkspaceFolder(two, "/ws")?.name, "web");
  assert.equal(getWorkspaceFolder(two, "/elsewhere/a.ts"), undefined);
  assert.equal(getWorkspaceFolder(two, "src/a.ts"), undefined);
  assert.equal(getWorkspaceFolder(two, 42), undefined);
  const nested = [...two, { path: "/ws/packages/ui", name: "ui", index: 2 }];
  assert.equal(getWorkspaceFolder(nested, "/ws/packages/ui/x.ts")?.name, "ui");
  assert.equal(getWorkspaceFolder(win, "c:/work/WEB/a.ts")?.name, "web");
});

test("asRelativePath: VS Code's rules for the folder's name", () => {
  // One folder: no name unless asked for.
  assert.equal(asRelativePath(one, "/ws/src/a.ts"), "src/a.ts");
  assert.equal(asRelativePath(one, "/ws/src/a.ts", true), "ws/src/a.ts");
  // Several: the name unless told not to.
  assert.equal(asRelativePath(two, "/srv/api/src/a.ts"), "api/src/a.ts");
  assert.equal(asRelativePath(two, "/ws/a.ts"), "web/a.ts");
  assert.equal(asRelativePath(two, "/srv/api/src/a.ts", false), "src/a.ts");
  // Outside every folder, or not a path: as it is.
  assert.equal(asRelativePath(two, "/tmp/x.ts"), "/tmp/x.ts");
  assert.equal(asRelativePath(two, "rel/x.ts"), "rel/x.ts");
  // A folder's own path counts as in the folder around it (none here).
  assert.equal(asRelativePath(two, "/srv/api"), "/srv/api");
  const nested = [...one, { path: "/ws/packages/ui", name: "ui", index: 1 }];
  assert.equal(asRelativePath(nested, "/ws/packages/ui"), "ws/packages/ui");
  assert.equal(asRelativePath(nested, "/ws/packages/ui/a.ts"), "ui/a.ts");
  // Windows paths, with "/" in the result.
  assert.equal(asRelativePath(win, "d:\\API\\src\\main.rs"), "api/src/main.rs");
});

test("planFolderUpdate: VS Code's splice checks", () => {
  // Adding at the end.
  const add = planFolderUpdate(one, 1, 0, [{ path: "/srv/api" }]);
  assert.deepEqual(add?.added, [{ path: "/srv/api", name: "api" }]);
  assert.deepEqual(add?.removed, []);
  assert.deepEqual(
    add?.next.map((f) => f.path),
    ["/ws", "/srv/api"],
  );
  // deleteCount null / undefined is 0; repeats among the added are dropped; names kept.
  const named = planFolderUpdate(one, 1, null, [
    { path: "/a", name: "A" },
    { path: "/a" },
    { path: "/b" },
  ]);
  assert.deepEqual(named?.added, [
    { path: "/a", name: "A" },
    { path: "/b", name: "b" },
  ]);
  assert.ok(planFolderUpdate(one, 1, undefined, [{ path: "/a" }]));
  // Removing.
  const remove = planFolderUpdate(two, 1, 1, []);
  assert.deepEqual(remove?.removed, [{ path: "/srv/api", name: "api" }]);
  assert.deepEqual(remove?.added, []);
  // Replacing every folder: there is one afterwards.
  const replace = planFolderUpdate(two, 0, 2, [{ path: "/new" }]);
  assert.deepEqual(
    replace?.next.map((f) => f.path),
    ["/new"],
  );
  assert.equal(replace?.removed.length, 2);
});

test("planFolderUpdate: false (null) for invalid input or no change", () => {
  assert.equal(planFolderUpdate(one, -1, 0, [{ path: "/a" }]), null);
  assert.equal(planFolderUpdate(one, 0.5, 0, [{ path: "/a" }]), null);
  assert.equal(planFolderUpdate(one, 0, -1, [{ path: "/a" }]), null);
  assert.equal(planFolderUpdate(one, "0", 0, [{ path: "/a" }]), null);
  // Nothing to add or remove.
  assert.equal(planFolderUpdate(one, 0, 0, []), null);
  // More removed than there are; a start past the end.
  assert.equal(planFolderUpdate(one, 0, 2, []), null);
  assert.equal(planFolderUpdate(one, 2, 0, [{ path: "/a" }]), null);
  // A folder that isn't an absolute path, or no object at all.
  assert.equal(planFolderUpdate(one, 1, 0, [{ path: "rel/x" }]), null);
  assert.equal(planFolderUpdate(one, 1, 0, ["/a"]), null);
  assert.equal(planFolderUpdate(one, 1, 0, [{ path: "/a", name: 3 }]), null);
  // A folder twice afterwards (already in it, any case on Windows).
  assert.equal(planFolderUpdate(one, 1, 0, [{ path: "/ws" }]), null);
  assert.equal(planFolderUpdate(win, 2, 0, [{ path: "c:\\work\\WEB" }]), null);
  // Only a reorder or a rename: nothing the IDE can do through this call.
  assert.equal(planFolderUpdate(two, 0, 1, [{ path: "/ws", name: "renamed" }]), null);
  // No folder left.
  assert.equal(planFolderUpdate(two, 0, 2, []), null);
});

/** The WorkspaceService's resolve / contains, the same rules (workspace.ts), for the gate. */
function fakeWorkspace(folders: WorkspaceFolder[]): WorkspaceGate {
  const root = folders[0]?.path ?? null;
  return {
    root,
    multiRoot: folders.length > 1,
    contains: (p) => folders.some((f) => isWithin(f.path, p)),
    resolve(path) {
      if (folders.length <= 1 || /^([/\\]|[A-Za-z]:)/.test(path)) {
        const owner = /^([/\\]|[A-Za-z]:)/.test(path) ? folderOf(folders, path) : undefined;
        return resolveInRoot(owner?.path ?? root ?? "", path);
      }
      const [head, ...rest] = path.replace(/^\.?[\\/]+/, "").split(/[\\/]/);
      const named = folders.find((f) => f.name === head);
      if (named) return rest.length ? resolveInRoot(named.path, rest.join("/")) : named.path;
      return resolveInRoot(root ?? "", path);
    },
  };
}

test("the path gate: every folder in, nothing else; one folder as before", () => {
  const single = fakeWorkspace(one);
  assert.equal(gateWorkspacePath(single, "src/a.ts"), "/ws/src/a.ts");
  assert.equal(gateWorkspacePath(single, "/ws/b.ts"), "/ws/b.ts");
  assert.throws(() => gateWorkspacePath(single, "../x"), /\.\.\/x is outside the open folder\./);
  assert.throws(() => gateWorkspacePath(single, "/srv/api/a.ts"), /outside the open folder/);
  assert.throws(() => gateWorkspacePath(single, 3), /path must be a string/);
  assert.throws(() => gateWorkspacePath(fakeWorkspace([]), "a"), /No folder is open/);

  const multi = fakeWorkspace(two);
  // The second folder: absolute, or relative with its name first.
  assert.equal(gateWorkspacePath(multi, "/srv/api/src/a.ts"), "/srv/api/src/a.ts");
  assert.equal(gateWorkspacePath(multi, "api/src/a.ts"), "/srv/api/src/a.ts");
  // Relative without a folder's name: the first folder.
  assert.equal(gateWorkspacePath(multi, "src/a.ts"), "/ws/src/a.ts");
  // Out of a folder with "..", or anywhere else.
  assert.throws(
    () => gateWorkspacePath(multi, "api/../../etc/passwd"),
    /outside the workspace's folders/,
  );
  assert.throws(() => gateWorkspacePath(multi, "/srv/api/../secret"), /outside the workspace/);
  assert.throws(() => gateWorkspacePath(multi, "/srv/apix/a"), /outside the workspace/);

  const windows = fakeWorkspace(win);
  assert.equal(gateWorkspacePath(windows, "d:/API/x.rs"), "D:\\api\\x.rs");
  assert.throws(() => gateWorkspacePath(windows, "D:\\other\\x"), /outside the workspace/);
});

test("relativeCandidates: each folder holding the path, or a RelativePattern's base", () => {
  const nested = [...one, { path: "/ws/packages/ui", name: "ui", index: 1 }];
  assert.deepEqual(relativeCandidates(nested, null, "/ws/packages/ui/a.ts"), [
    "packages/ui/a.ts",
    "a.ts",
  ]);
  assert.deepEqual(relativeCandidates(two, null, "/srv/api/a.ts"), ["a.ts"]);
  assert.deepEqual(relativeCandidates(two, null, "/tmp/a.ts"), []);
  assert.deepEqual(relativeCandidates(two, "/srv/api/src", "/srv/api/src/x/a.ts"), ["x/a.ts"]);
  assert.deepEqual(relativeCandidates(two, "/srv/api/src", "/srv/api/b.ts"), []);
});

test("readSnapshot: checked, indexed in order", () => {
  assert.equal(readSnapshot(null), undefined);
  assert.equal(readSnapshot({ folders: "x" }), undefined);
  assert.deepEqual(
    readSnapshot({ folders: [{ path: "/b", name: "" }, { nope: 1 }, { path: "/a", index: 7 }] }),
    {
      folders: [
        { path: "/b", name: "b", index: 0 },
        { path: "/a", name: "a", index: 1 },
      ],
      name: null,
      file: null,
    },
  );
});

function fakeWorker(workspace: unknown, answer: (method: string) => unknown = () => true) {
  const sent: FromWorker[] = [];
  let deliver: (m: ToWorker) => void = () => {};
  const { api } = createWorkerApi(
    {
      post: (m) => {
        sent.push(m);
        if (m.t === "req")
          queueMicrotask(() => deliver({ t: "res", id: m.id, ok: true, value: answer(m.method) }));
      },
      onMessage: (h) => (deliver = h),
    },
    { id: "acme.x", version: "1.0.0", workspace },
  );
  let id = 500;
  const push = (target: string, args: unknown) =>
    deliver({ t: "call", id: ++id, kind: "workspace", target, args });
  const requests = () => sent.filter((m): m is RequestMessage => m.t === "req");
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { api, push, requests, tick };
}

test("the worker's mirror: workspaceFolders, rootPath, name, workspaceFile", async () => {
  const empty = fakeWorker({ folders: [], name: null, file: null });
  assert.equal(empty.api.workspace.workspaceFolders, undefined);
  assert.equal(empty.api.workspace.rootPath, undefined);
  assert.equal(empty.api.workspace.name, undefined);
  // Without "fs.read" the host sends nothing: undefined, and updates refused.
  const blind = fakeWorker(undefined);
  assert.equal(blind.api.workspace.workspaceFolders, undefined);
  assert.equal(blind.api.workspace.updateWorkspaceFolders(0, 0, { path: "/a" }), false);

  const h = fakeWorker({ folders: one, name: "ws", file: null });
  const ws = h.api.workspace;
  assert.deepEqual(ws.workspaceFolders, one);
  assert.equal(ws.rootPath, "/ws");
  assert.equal(ws.name, "ws");
  assert.equal(ws.workspaceFile, undefined);
  assert.ok(Object.isFrozen(ws.workspaceFolders));
  assert.equal(ws.asRelativePath("/ws/a/b.ts"), "a/b.ts");

  const seen: unknown[] = [];
  ws.onDidChangeWorkspaceFolders((e) => seen.push(["vs", e.added.map((f) => f.name)]));
  ws.onDidChangeFolders((e) => seen.push(["ide", e.added.length, ws.workspaceFolders?.length]));
  const snapshot = { folders: two, name: "Untitled (Workspace)", file: "/data/u.code-workspace" };
  h.push("changed", { snapshot, added: [two[1]], removed: [] });
  await h.tick();
  // The mirror is current when the listeners run.
  assert.deepEqual(seen, [
    ["vs", ["api"]],
    ["ide", 1, 2],
  ]);
  assert.equal(ws.workspaceFile, "/data/u.code-workspace");
  assert.equal(ws.getWorkspaceFolder("/srv/api/x")?.index, 1);
  assert.equal(ws.asRelativePath("/srv/api/x"), "api/x");
  // A rename (no change event).
  h.push("snapshot", { ...snapshot, folders: [one[0], { ...two[1], name: "backend" }] });
  await h.tick();
  assert.equal(ws.workspaceFolders?.[1]?.name, "backend");
  assert.equal(seen.length, 2);
});

test("updateWorkspaceFolders: checked, sent once, refused while one is under way", async () => {
  const h = fakeWorker({ folders: one, name: "ws", file: null });
  const ws = h.api.workspace;
  assert.equal(ws.updateWorkspaceFolders(5, 0, { path: "/a" }), false);
  assert.equal(ws.updateWorkspaceFolders(1, 0, { path: "relative" }), false);
  assert.equal(ws.updateWorkspaceFolders(1, 0, { path: "/srv/api", name: "api" }), true);
  // VS Code's: no second update until the first is confirmed.
  assert.equal(ws.updateWorkspaceFolders(1, 0, { path: "/b" }), false);
  const sent = h.requests().filter((r) => r.method === "workspace.updateFolders");
  assert.deepEqual(sent[0]?.params, {
    start: 1,
    deleteCount: 0,
    folders: [{ path: "/srv/api", name: "api" }],
  });
  await h.tick();
  assert.equal(ws.updateWorkspaceFolders(1, 0, { path: "/b" }), true);
});

test("folders() and folderOf() ask the host", async () => {
  const h = fakeWorker({ folders: one, name: "ws", file: null }, (method) =>
    method === "workspace.folders" ? two : method === "workspace.folderOf" ? two[1] : null,
  );
  assert.deepEqual(await h.api.workspace.folders(), two);
  assert.deepEqual(await h.api.workspace.folderOf("api/x"), two[1]);
  assert.deepEqual(h.requests().at(-1)?.params, { path: "api/x" });
});
