// D234: decoration types, editor events, file system watchers, findFiles, settings.update,
// workspaceState and env on the worker side.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerApi, type FromWorker, type RequestMessage, type ToWorker } from "./rpc";
import { relativeTo } from "./rpcExtras";

function fakeHost(
  answer: (method: string, params: Record<string, unknown>) => unknown = () => null,
  workspace: unknown = { folders: [{ path: "/ws", name: "ws", index: 0 }], name: "ws", file: null },
) {
  const sent: FromWorker[] = [];
  let deliver: (m: ToWorker) => void = () => {};
  const { api } = createWorkerApi(
    {
      post: (m) => {
        sent.push(m);
        if (m.t === "req")
          queueMicrotask(() =>
            deliver({
              t: "res",
              id: m.id,
              ok: true,
              value: answer(m.method, m.params as Record<string, unknown>),
            }),
          );
      },
      onMessage: (h) => (deliver = h),
    },
    { id: "acme.x", version: "1.0.0", appName: "Studio", language: "de-DE", workspace },
  );
  const requests = () => sent.filter((m): m is RequestMessage => m.t === "req");
  const tick = () => new Promise((r) => setTimeout(r, 0));
  let id = 900;
  const event = (sub: string, payload: unknown) =>
    deliver({ t: "call", id: ++id, kind: "event", target: sub, args: payload });
  return { api, requests, tick, event };
}

test("relativeTo: inside the folder only, Windows paths without case", () => {
  assert.equal(relativeTo("/ws", "/ws/a/b.md"), "a/b.md");
  assert.equal(relativeTo("/ws", "/wsx/a.md"), null);
  assert.equal(relativeTo("/ws", "/ws"), null);
  assert.equal(relativeTo("C:\\Work\\p", "c:\\work\\P\\src\\a.ts"), "src/a.ts");
});

test("decoration types: create, set, clear, dispose requests", async () => {
  const h = fakeHost();
  const type = h.api.editor.createDecorationType({ color: "error", after: { contentText: "!" } });
  await type.set("a.ts", [{ startLine: 2, hover: "x" }]);
  await type.clear();
  type.dispose();
  await h.tick();
  const calls = h.requests().filter((r) => r.method.includes("DecorationType"));
  assert.deepEqual(
    calls.map((r) => r.method),
    [
      "editor.createDecorationType",
      "editor.setDecorationType",
      "editor.clearDecorationType",
      "editor.disposeDecorationType",
    ],
  );
  assert.deepEqual(calls[1]?.params, {
    key: type.key,
    ranges: [{ startLine: 2, hover: "x" }],
    path: "a.ts",
  });
});

test("editor events subscribe to their event types", async () => {
  const h = fakeHost();
  const seen: unknown[] = [];
  h.api.editor.onDidChangeSelection((e) => seen.push(e));
  h.api.editor.onDidChangeActive((e) => seen.push(e));
  h.api.editor.onDidChangeVisibleRange((e) => seen.push(e));
  const subs = h.requests().filter((r) => r.method === "events.subscribe");
  assert.deepEqual(
    subs.map((r) => (r.params as { type: string }).type),
    ["editor.didChangeSelection", "editor.didChangeActive", "editor.didChangeVisibleRange"],
  );
  h.event(String((subs[1]?.params as { sub?: string } | undefined)?.sub), null);
  await h.tick();
  assert.deepEqual(seen, [null]);
});

test("file system watcher: the glob on folder-relative paths, renames as delete + create", async () => {
  const h = fakeHost();
  const w = h.api.workspace.createFileSystemWatcher("**/*.md", { ignoreChange: true });
  const seen: string[] = [];
  w.onDidCreate((p) => seen.push(`+${p}`));
  w.onDidChange((p) => seen.push(`~${p}`));
  w.onDidDelete((p) => seen.push(`-${p}`));
  const subs = h
    .requests()
    .filter((r) => r.method === "events.subscribe")
    .map((r) => r.params as { type: string; sub: string });
  assert.deepEqual(
    subs.map((s) => s.type),
    ["files.didCreate", "files.didDelete", "files.didRename"],
  );
  const sub = (type: string) => subs.find((s) => s.type === type)?.sub ?? "";
  await h.tick();
  h.event(sub("files.didCreate"), { path: "/ws/docs/a.md" });
  h.event(sub("files.didCreate"), { path: "/ws/a.ts" });
  h.event(sub("files.didCreate"), { path: "/elsewhere/b.md" });
  h.event(sub("files.didRename"), { from: "/ws/x.md", to: "/ws/y.txt" });
  await h.tick();
  await h.tick();
  assert.deepEqual(seen, ["+/ws/docs/a.md", "-/ws/x.md"]);
  w.dispose();
  assert.ok(h.requests().some((r) => r.method === "events.unsubscribe"));
});

test("file system watcher: every folder's events; a RelativePattern relative to its base", async () => {
  const h = fakeHost(() => null, {
    folders: [
      { path: "/ws", name: "web", index: 0 },
      { path: "/srv/api", name: "api", index: 1 },
    ],
    name: "Untitled (Workspace)",
    file: "/data/u.code-workspace",
  });
  const all = h.api.workspace.createFileSystemWatcher("src/**/*.ts");
  const api = h.api.workspace.createFileSystemWatcher({
    base: { path: "/srv/api" },
    pattern: "**/*.rs",
  });
  const seen: string[] = [];
  all.onDidCreate((p) => seen.push(`all ${p}`));
  api.onDidCreate((p) => seen.push(`api ${p}`));
  const creates = h
    .requests()
    .filter((r) => r.method === "events.subscribe")
    .map((r) => r.params as { type: string; sub: string })
    .filter((s) => s.type === "files.didCreate");
  for (const path of ["/ws/src/a.ts", "/srv/api/src/b.ts", "/srv/api/src/c.rs", "/ws/d.rs"])
    for (const s of creates) h.event(s.sub, { path });
  await h.tick();
  assert.deepEqual(seen, ["all /ws/src/a.ts", "all /srv/api/src/b.ts", "api /srv/api/src/c.rs"]);
});

test("findFiles: a RelativePattern goes as { base, pattern }", async () => {
  const h = fakeHost();
  await h.api.workspace.findFiles({ base: "/srv/api", pattern: "**/*.rs" }, undefined, 5);
  await h.api.workspace.findFiles({ base: { path: "/ws" }, pattern: "*.md" });
  const calls = h.requests().filter((r) => r.method === "fs.findFiles");
  assert.deepEqual(calls[0]?.params, {
    include: { base: "/srv/api", pattern: "**/*.rs" },
    maxResults: 5,
  });
  assert.deepEqual(calls[1]?.params, { include: { base: "/ws", pattern: "*.md" } });
});

test("findFiles, settings.update, workspaceState, env", async () => {
  const h = fakeHost();
  await h.api.workspace.findFiles("**/*.md", "node_modules/**", 10);
  await h.api.settings.update("x.tabs", 4, "workspace");
  await h.api.workspaceState.set("k", 1);
  await h.api.workspaceState.get("k");
  await h.api.env.openExternal("https://example.com");
  await h.api.env.clipboard.writeText("hi");
  assert.equal(h.api.env.appName, "Studio");
  assert.equal(h.api.env.language, "de-DE");
  const byMethod = (m: string) => h.requests().find((r) => r.method === m)?.params;
  assert.deepEqual(byMethod("fs.findFiles"), {
    include: "**/*.md",
    exclude: "node_modules/**",
    maxResults: 10,
  });
  assert.deepEqual(byMethod("commands.execute"), {
    id: "settings.set",
    input: { key: "x.tabs", value: 4, scope: "workspace" },
  });
  assert.deepEqual(byMethod("storage.set"), { key: "k", value: 1, scope: "workspace" });
  assert.deepEqual(byMethod("env.openExternal"), { url: "https://example.com" });
  assert.deepEqual(byMethod("env.clipboardWrite"), { text: "hi" });
});
