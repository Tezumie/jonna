// D251: a language server with every folder of a multi-root workspace.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Emitter } from "../events/index";
import { LanguageClient } from "./client";
import { RpcConnection } from "./jsonrpc";

function pipe() {
  const a = new Emitter<string>();
  const b = new Emitter<string>();
  return {
    client: { send: (m: string) => queueMicrotask(() => b.fire(m)), onMessage: a.event },
    server: { send: (m: string) => queueMicrotask(() => a.fire(m)), onMessage: b.event },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

async function serverWith(capabilities: unknown) {
  const { client, server } = pipe();
  const s = new RpcConnection(server);
  let init: { rootUri?: string; workspaceFolders?: unknown } = {};
  s.onRequest("initialize", (p) => {
    init = p as typeof init;
    return { capabilities };
  });
  const changes: unknown[] = [];
  s.onNotification("initialized", () => {});
  s.onNotification("workspace/didChangeWorkspaceFolders", (p) => changes.push(p));
  const scopes: (string | undefined)[] = [];
  const lc = new LanguageClient(client, {
    id: "mock",
    rootPath: "/w/api",
    folders: [
      { path: "/w/api", name: "api" },
      { path: "/w/web", name: "Web app" },
    ],
    languages: ["python"],
    clientName: "test",
    configuration: (_section, scope) => {
      scopes.push(scope);
      return scope?.startsWith("/w/web") ? "web" : "first";
    },
  });
  await lc.start(1);
  return { s, lc, init: () => init, changes, scopes };
}

test("initialize names every folder; rootUri is the first", async () => {
  const { s, lc, init } = await serverWith({});
  assert.equal(init().rootUri, "file:///w/api");
  assert.deepEqual(init().workspaceFolders, [
    { uri: "file:///w/api", name: "api" },
    { uri: "file:///w/web", name: "Web app" },
  ]);
  assert.deepEqual(await s.request("workspace/workspaceFolders"), init().workspaceFolders);
  lc.dispose();
});

test("folder changes go to a server that takes them, and workspace/workspaceFolders follows", async () => {
  const { s, lc, changes } = await serverWith({
    workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
  });
  assert.equal(lc.takesFolderChanges, true);
  const told = lc.setWorkspaceFolders([
    { path: "/w/api", name: "api" },
    { path: "/w/docs", name: "docs" },
  ]);
  assert.equal(told, "told");
  await tick();
  assert.deepEqual(changes, [
    {
      event: {
        added: [{ uri: "file:///w/docs", name: "docs" }],
        removed: [{ uri: "file:///w/web", name: "Web app" }],
      },
    },
  ]);
  assert.deepEqual(await s.request("workspace/workspaceFolders"), [
    { uri: "file:///w/api", name: "api" },
    { uri: "file:///w/docs", name: "docs" },
  ]);
  // The same list again: nothing to tell.
  assert.equal(
    lc.setWorkspaceFolders([
      { path: "/w/api", name: "api" },
      { path: "/w/docs", name: "docs" },
    ]),
    "unchanged",
  );
  // A rename only: nothing added or taken out, nothing sent; the new name is answered.
  assert.equal(
    lc.setWorkspaceFolders([
      { path: "/w/api", name: "api" },
      { path: "/w/docs", name: "Docs" },
    ]),
    "unchanged",
  );
  await tick();
  assert.equal(changes.length, 1);
  lc.dispose();
});

test("a server without folder-change support isn't sent them (it keeps its folders)", async () => {
  const { lc, changes } = await serverWith({
    workspace: { workspaceFolders: { supported: true } },
  });
  assert.equal(lc.takesFolderChanges, false);
  assert.equal(lc.setWorkspaceFolders([{ path: "/w/api", name: "api" }]), "kept");
  await tick();
  assert.deepEqual(changes, []);
  lc.dispose();
});

test("workspace/configuration passes each item's scope (a folder's own settings)", async () => {
  const { s, lc, scopes } = await serverWith({});
  assert.deepEqual(
    await s.request("workspace/configuration", {
      items: [
        { section: "python", scopeUri: "file:///w/web/main.py" },
        { section: "python", scopeUri: "file:///w/api" },
        { section: "python" },
      ],
    }),
    ["web", "first", "first"],
  );
  assert.deepEqual(scopes, ["/w/web/main.py", "/w/api", undefined]);
  lc.dispose();
});

test("folders changed while the server starts are sent once it's initialized", async () => {
  const { client, server } = pipe();
  const s = new RpcConnection(server);
  let answer: (v: unknown) => void = () => {};
  s.onRequest(
    "initialize",
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  s.onNotification("initialized", () => {});
  const changes: unknown[] = [];
  s.onNotification("workspace/didChangeWorkspaceFolders", (p) => changes.push(p));
  const lc = new LanguageClient(client, {
    id: "mock",
    rootPath: "/w/api",
    folders: [{ path: "/w/api", name: "api" }],
    languages: ["python"],
    clientName: "test",
  });
  const started = lc.start(1);
  await tick();
  assert.equal(
    lc.setWorkspaceFolders([
      { path: "/w/api", name: "api" },
      { path: "/w/web", name: "web" },
    ]),
    "kept",
  );
  answer({
    capabilities: {
      workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
    },
  });
  await started;
  await tick();
  assert.deepEqual(changes, [
    { event: { added: [{ uri: "file:///w/web", name: "web" }], removed: [] } },
  ]);
  lc.dispose();
});

test("one folder is named as before multi-root: the last part of its path", async () => {
  const { client, server } = pipe();
  const s = new RpcConnection(server);
  let init: { workspaceFolders?: unknown } = {};
  s.onRequest("initialize", (p) => {
    init = p as typeof init;
    return { capabilities: {} };
  });
  s.onNotification("initialized", () => {});
  const lc = new LanguageClient(client, {
    id: "mock",
    rootPath: "/",
    // The workspace names a filesystem root by its path; servers got "root" before.
    folders: [{ path: "/", name: "/" }],
    languages: ["python"],
    clientName: "test",
  });
  await lc.start(1);
  assert.deepEqual(init.workspaceFolders, [{ uri: "file:///", name: "root" }]);
  lc.dispose();
});

test("a document the server lost is forgotten and reported, to be opened again (D380)", async () => {
  const { s, lc } = await serverWith({});
  const opened: string[] = [];
  s.onNotification("textDocument/didOpen", (p) =>
    opened.push((p as { textDocument: { uri: string } }).textDocument.uri),
  );
  // The server answers as typescript-language-server does for a file it wasn't told about.
  s.onRequest("textDocument/completion", () => {
    throw new Error("Unexpected resource file:///w/api/a.mjs");
  });
  lc.didOpen("/w/api/a.mjs", "javascript", "fu");
  await tick();
  const lost: string[] = [];
  lc.onDocumentLost((path) => lost.push(path));
  await assert.rejects(
    lc.request("textDocument/completion", {
      textDocument: { uri: "file:///w/api/a.mjs" },
      position: { line: 0, character: 2 },
    }),
  );
  assert.deepEqual(lost, ["/w/api/a.mjs"]);
  assert.equal(lc.isOpen("/w/api/a.mjs"), false);
  // Opened again by the editor: the server gets it.
  lc.didOpen("/w/api/a.mjs", "javascript", "fu");
  await tick();
  assert.equal(opened.length, 2);
  lc.dispose();
});
