import assert from "node:assert/strict";
import { test } from "node:test";
import { Emitter } from "../events/index";
import { LanguageClient } from "./client";
import { cancelSource, RpcConnection, type RpcError } from "./jsonrpc";
import { pathToUri, uriToPath } from "./uri";

/** Two connected in-memory transports (messages delivered asynchronously, like a pipe). */
function pipe() {
  const a = new Emitter<string>();
  const b = new Emitter<string>();
  return {
    client: { send: (m: string) => queueMicrotask(() => b.fire(m)), onMessage: a.event },
    server: { send: (m: string) => queueMicrotask(() => a.fire(m)), onMessage: b.event },
  };
}

test("uris round-trip POSIX, Windows and UNC paths", () => {
  assert.equal(pathToUri("/home/a b/x#1.ts"), "file:///home/a%20b/x%231.ts");
  assert.equal(uriToPath("file:///home/a%20b/x%231.ts"), "/home/a b/x#1.ts");
  assert.equal(pathToUri("C:\\Work\\é.rs"), "file:///c%3A/Work/%C3%A9.rs");
  assert.equal(uriToPath("file:///c%3A/Work/%C3%A9.rs"), "C:\\Work\\é.rs");
  assert.equal(uriToPath("file:///C:/x/y.rs"), "C:\\x\\y.rs");
  assert.equal(pathToUri("\\\\srv\\share\\a.txt"), "file://srv/share/a.txt");
  assert.equal(uriToPath("file://srv/share/a.txt"), "\\\\srv\\share\\a.txt");
  assert.equal(uriToPath("untitled:1"), null);
});

test("requests, errors, server requests and cancellation", async () => {
  const { client, server } = pipe();
  const c = new RpcConnection(client);
  const s = new RpcConnection(server);
  s.onRequest("add", (p) => (p as number[]).reduce((x, y) => x + y, 0));
  s.onRequest("fail", () => {
    throw new Error("nope");
  });
  c.onRequest("ping", () => "pong");
  assert.equal(await c.request("add", [1, 2, 3]), 6);
  await assert.rejects(c.request("fail"), (e: RpcError) => e.message === "nope");
  await assert.rejects(c.request("missing"), (e: RpcError) => e.code === -32601);
  assert.equal(await s.request("ping"), "pong");
  // A request the server never answers: cancel sends $/cancelRequest and rejects.
  const cancelled: unknown[] = [];
  s.onNotification("$/cancelRequest", (p) => cancelled.push(p));
  s.onRequest("slow", () => new Promise(() => {}));
  const token = cancelSource();
  const slow = c.request("slow", undefined, { token });
  token.cancel();
  await assert.rejects(slow, (e: RpcError) => e.code === -32800);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(cancelled.length, 1);
  // Closing fails what is pending.
  const pending = c.request("slow");
  c.close();
  await assert.rejects(pending);
});

test("client handshake, sync and diagnostics", async () => {
  const { client, server } = pipe();
  const s = new RpcConnection(server);
  const seen: { method: string; params: unknown }[] = [];
  s.onRequest("initialize", (p) => {
    seen.push({ method: "initialize", params: p });
    return { capabilities: { textDocumentSync: 1, hoverProvider: true } };
  });
  for (const m of [
    "initialized",
    "textDocument/didOpen",
    "textDocument/didChange",
    "textDocument/didClose",
    "exit",
  ])
    s.onNotification(m, (p) => seen.push({ method: m, params: p }));
  s.onRequest("shutdown", () => null);
  const lc = new LanguageClient(client, {
    id: "mock",
    rootPath: "/w",
    languages: ["tsx"],
    clientName: "test",
    configuration: (section) => (section === "a" ? { b: 1 } : null),
  });
  const caps = await lc.start(42);
  assert.equal(caps.hoverProvider, true);
  assert.equal(lc.state, "running");
  lc.didOpen("/w/a.tsx", "tsx", "x");
  lc.didChange("/w/a.tsx", "xy");
  const diags: string[] = [];
  lc.onDiagnostics((d) => diags.push(`${d.path}:${d.diagnostics.length}`));
  s.notify("textDocument/publishDiagnostics", {
    uri: "file:///w/a.tsx",
    diagnostics: [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "m" },
    ],
  });
  assert.deepEqual(
    await s.request("workspace/configuration", { items: [{ section: "a" }, { section: "z" }] }),
    [{ b: 1 }, null],
  );
  lc.didClose("/w/a.tsx");
  await lc.stop();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(diags, ["/w/a.tsx:1"]);
  assert.deepEqual(
    seen.map((x) => x.method),
    [
      "initialize",
      "initialized",
      "textDocument/didOpen",
      "textDocument/didChange",
      "textDocument/didClose",
      "exit",
    ],
  );
  const open = seen[2]?.params as { textDocument: { languageId: string; uri: string } };
  assert.equal(open.textDocument.languageId, "typescriptreact");
  const change = seen[3]?.params as {
    textDocument: { version: number };
    contentChanges: { text: string }[];
  };
  assert.equal(change.textDocument.version, 2);
  assert.equal(change.contentChanges[0]?.text, "xy");
  assert.equal((seen[0]?.params as { processId: number } | undefined)?.processId, 42);
});

test("an already-cancelled token never sends; settled requests drop their cancel listener", async () => {
  const sent: string[] = [];
  const replies = new Emitter<string>();
  const c = new RpcConnection({ send: (m) => sent.push(m), onMessage: replies.event });
  const done = cancelSource();
  done.cancel();
  await assert.rejects(c.request("slow", undefined, { token: done }), (e: RpcError) => {
    return e.code === -32800;
  });
  assert.equal(sent.length, 0);
  // A token kept for many requests: each answered request removes its listener.
  let live = 0;
  const shared = cancelSource();
  const counting = {
    get cancelled() {
      return shared.cancelled;
    },
    onCancel(fn: () => void) {
      live++;
      const sub = shared.onCancel(fn);
      return {
        dispose: () => {
          live--;
          sub.dispose();
        },
      };
    },
  };
  for (let i = 0; i < 3; i++) {
    const answer = c.request<number>("n", undefined, { token: counting });
    const { id } = JSON.parse(sent[sent.length - 1] ?? "{}") as { id: number };
    replies.fire(JSON.stringify({ jsonrpc: "2.0", id, result: i }));
    assert.equal(await answer, i);
  }
  assert.equal(live, 0);
  const timedOut = c.request("never", undefined, { token: counting, timeoutMs: 1 });
  await assert.rejects(timedOut, (e: RpcError) => e.code === -32001);
  assert.equal(live, 0);
  c.dispose();
});

test("an editor opening a file a request opened from disk takes it over", async () => {
  const { client, server } = pipe();
  const s = new RpcConnection(server);
  const seen: string[] = [];
  s.onRequest("initialize", () => ({ capabilities: { textDocumentSync: 1 } }));
  s.onRequest("shutdown", () => null);
  for (const m of ["textDocument/didOpen", "textDocument/didChange", "textDocument/didClose"])
    s.onNotification(m, (p) => {
      const text =
        (p as { textDocument: { text?: string } }).textDocument.text ??
        (p as { contentChanges?: { text: string }[] }).contentChanges?.[0]?.text ??
        "";
      seen.push(`${m.slice(13)} ${text}`);
    });
  const lc = new LanguageClient(client, {
    id: "m",
    rootPath: "/w",
    languages: ["md"],
    clientName: "test",
  });
  await lc.start(1);
  // A request opens it from disk; the editor opens it before the request ends.
  const release = lc.openTemporarily("/w/a.md", "md", "disk");
  assert.equal(lc.isOpenTemporarily("/w/a.md"), true);
  lc.didOpen("/w/a.md", "md", "editor");
  assert.equal(lc.isOpenTemporarily("/w/a.md"), false);
  release();
  // The editor's edits keep reaching the server.
  lc.didChange("/w/a.md", "edited");
  assert.equal(lc.isOpen("/w/a.md"), true);
  // Already open: a request neither reopens nor closes it.
  lc.openTemporarily("/w/a.md", "md", "disk")();
  assert.equal(lc.isOpen("/w/a.md"), true);
  // Monaco's fsPath spells the drive in lower case: the same document either way.
  lc.didOpen("C:\\w\\c.md", "md", "c");
  assert.equal(lc.isOpen("c:\\w\\c.md"), true);
  lc.openTemporarily("c:\\w\\c.md", "md", "disk")();
  assert.equal(lc.isOpen("C:\\w\\c.md"), true);
  // Alone, the request's file is closed again.
  lc.openTemporarily("/w/b.md", "md", "b")();
  assert.equal(lc.isOpen("/w/b.md"), false);
  await lc.stop();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, [
    "didOpen disk",
    "didClose ",
    "didOpen editor",
    "didChange edited",
    "didOpen c",
    "didOpen b",
    "didClose ",
  ]);
});
