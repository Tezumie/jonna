import assert from "node:assert/strict";
import { test } from "node:test";
import { Emitter } from "../events/index";
import { LanguageClient } from "./client";
import { METHOD_NOT_FOUND, RpcConnection, RpcError } from "./jsonrpc";
import { applySemanticTokensEdits, resolveSemanticTokensDelta } from "./semanticTokens";
import {
  nextWorkspacePull,
  WORKSPACE_REPULL_MAX_MS,
  WORKSPACE_REPULL_MS,
  WorkspaceDiagnostics,
  workspacePullOutcome,
} from "./workspaceDiagnostics";

function pipe() {
  const a = new Emitter<string>();
  const b = new Emitter<string>();
  return {
    client: { send: (m: string) => queueMicrotask(() => b.fire(m)), onMessage: a.event },
    server: { send: (m: string) => queueMicrotask(() => a.fire(m)), onMessage: b.event },
  };
}

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

test("semantic token deltas apply to the kept tokens (D204)", () => {
  // Two tokens (5 numbers each); the second's length changes and a third is added.
  const previous = [0, 0, 3, 1, 0, 1, 2, 4, 2, 0];
  const next = applySemanticTokensEdits(previous, [
    { start: 10, deleteCount: 0, data: [2, 0, 5, 3, 1] },
    { start: 8, deleteCount: 1, data: [6] },
  ]);
  assert.deepEqual(next, [0, 0, 3, 1, 0, 1, 2, 4, 6, 0, 2, 0, 5, 3, 1]);
  // Deleting a token, an edit without data, and edits given in any order.
  assert.deepEqual(
    applySemanticTokensEdits(previous, [{ start: 0, deleteCount: 5 }]),
    [1, 2, 4, 2, 0],
  );
  assert.deepEqual(
    applySemanticTokensEdits(
      [1, 2, 3, 4],
      [
        { start: 0, deleteCount: 1, data: [9] },
        { start: 3, deleteCount: 1, data: [8, 7] },
      ],
    ),
    [9, 2, 3, 8, 7],
  );
  assert.deepEqual(applySemanticTokensEdits(previous, []), previous);
  // Edits that don't fit (past the end, overlapping) throw: the client asks for the full tokens.
  assert.throws(() => applySemanticTokensEdits([1, 2], [{ start: 1, deleteCount: 2 }]));
  assert.throws(() =>
    applySemanticTokensEdits(
      [1, 2, 3, 4],
      [
        { start: 0, deleteCount: 3 },
        { start: 2, deleteCount: 1 },
      ],
    ),
  );
  // A delta request may be answered with full tokens.
  assert.deepEqual(resolveSemanticTokensDelta(previous, { resultId: "2", data: [1, 1, 1, 1, 1] }), {
    data: [1, 1, 1, 1, 1],
    resultId: "2",
  });
  assert.deepEqual(
    resolveSemanticTokensDelta(Uint32Array.from([5, 5]), {
      edits: [{ start: 2, deleteCount: 0, data: [6] }],
    }),
    { data: [5, 5, 6] },
  );
});

test("workspace diagnostics keep the latest report per file and its result id", () => {
  const ws = new WorkspaceDiagnostics();
  const d = (message: string) => ({ range, message });
  assert.deepEqual(
    ws.apply([
      { kind: "full", uri: "file:///w/a.py", resultId: "1", items: [d("a")] },
      { kind: "full", uri: "file:///w/b.py", items: [] },
    ]),
    ["file:///w/a.py"],
  );
  // A clean file without a result id isn't kept (big repositories: memory, request size).
  assert.deepEqual(ws.uris(), ["file:///w/a.py"]);
  assert.deepEqual(ws.previousResultIds(), [{ uri: "file:///w/a.py", value: "1" }]);
  // Unchanged keeps the items (and takes the new id); the same full report changes nothing.
  assert.deepEqual(ws.apply([{ kind: "unchanged", uri: "file:///w/a.py", resultId: "2" }]), []);
  assert.equal(ws.items("file:///w/a.py")[0]?.message, "a");
  assert.deepEqual(ws.previousResultIds(), [{ uri: "file:///w/a.py", value: "2" }]);
  assert.deepEqual(ws.apply([{ kind: "full", uri: "file:///w/b.py", items: [] }]), []);
  assert.deepEqual(ws.apply([{ kind: "full", uri: "file:///w/b.py", items: [d("b")] }]), [
    "file:///w/b.py",
  ]);
  // Fixed: it changed (its markers go), and it's forgotten.
  assert.deepEqual(ws.apply([{ kind: "full", uri: "file:///w/b.py", items: [] }]), [
    "file:///w/b.py",
  ]);
  assert.deepEqual(ws.uris(), ["file:///w/a.py"]);
  ws.apply([{ kind: "full", uri: "file:///w/b.py", items: [d("b")] }]);
  // Unchanged for a file we never had is ignored; junk is skipped.
  assert.deepEqual(ws.apply([{ kind: "unchanged", uri: "file:///w/c.py", resultId: "9" }]), []);
  assert.deepEqual(ws.uris().sort(), ["file:///w/a.py", "file:///w/b.py"]);
  assert.deepEqual(ws.clear().sort(), ["file:///w/a.py", "file:///w/b.py"]);
  assert.deepEqual(ws.uris(), []);
});

test("workspace/diagnostic streams partial results through $/progress, refresh reaches the client", async () => {
  const { client, server } = pipe();
  const s = new RpcConnection(server);
  s.onRequest("initialize", () => ({
    capabilities: {
      diagnosticProvider: { workspaceDiagnostics: true, interFileDependencies: true },
    },
  }));
  let params: { partialResultToken?: string; previousResultIds?: unknown } = {};
  s.onRequest("workspace/diagnostic", async (p) => {
    params = p as typeof params;
    s.notify("$/progress", {
      token: params.partialResultToken,
      value: { items: [{ kind: "full", uri: "file:///w/x.py", items: [{ range, message: "x" }] }] },
    });
    await new Promise((r) => setTimeout(r, 5));
    return { items: [{ kind: "full", uri: "file:///w/y.py", resultId: "7", items: [] }] };
  });
  const lc = new LanguageClient(client, {
    id: "mock",
    rootPath: "/w",
    languages: ["python"],
    clientName: "test",
  });
  const caps = await lc.start();
  assert.equal(caps.diagnosticProvider?.workspaceDiagnostics, true);
  const ws = new WorkspaceDiagnostics();
  const partial: string[][] = [];
  const result = await lc.requestWithPartialResults<{ items: [] }>(
    "workspace/diagnostic",
    { previousResultIds: ws.previousResultIds() },
    (value) => partial.push(ws.apply((value as { items: [] }).items)),
  );
  ws.apply(result.items);
  assert.deepEqual(partial, [["file:///w/x.py"]]);
  assert.equal(ws.items("file:///w/x.py")[0]?.message, "x");
  assert.deepEqual(ws.previousResultIds(), [{ uri: "file:///w/y.py", value: "7" }]);
  assert.match(String(params.partialResultToken), /^partial-/);
  // The partial token isn't work progress.
  assert.equal(lc.progress.size, 0);
  const refreshed: string[] = [];
  lc.onRefresh((kind) => refreshed.push(kind));
  await s.request("workspace/diagnostic/refresh");
  await s.request("workspace/semanticTokens/refresh");
  assert.deepEqual(refreshed, ["diagnostics", "semanticTokens"]);
  lc.dispose();
});

test("workspace pulls repeat after each answer, back off on failures, stop when unsupported (D218)", () => {
  assert.equal(nextWorkspacePull("ok", 0), WORKSPACE_REPULL_MS);
  assert.equal(nextWorkspacePull("failed", 1), WORKSPACE_REPULL_MS * 2);
  assert.equal(nextWorkspacePull("failed", 2), WORKSPACE_REPULL_MS * 4);
  assert.equal(nextWorkspacePull("failed", 30), WORKSPACE_REPULL_MAX_MS);
  assert.equal(nextWorkspacePull("unsupported", 0), null);
  assert.equal(nextWorkspacePull("cancelled", 0), null);
  // LSP's error codes.
  assert.equal(workspacePullOutcome(new RpcError(METHOD_NOT_FOUND, "no"), false), "unsupported");
  assert.equal(workspacePullOutcome(new RpcError(-32801, "modified"), false), "ok");
  assert.equal(workspacePullOutcome(new RpcError(-32802, "busy"), false), "ok");
  assert.equal(
    workspacePullOutcome(new RpcError(-32802, "busy", { retriggerRequest: false }), false),
    "cancelled",
  );
  assert.equal(workspacePullOutcome(new RpcError(-32603, "crash"), false), "failed");
  assert.equal(workspacePullOutcome(new Error("closed"), false), "failed");
  // Our own cancellation (the binding was disposed).
  assert.equal(workspacePullOutcome(new RpcError(-32800, "Cancelled"), true), "cancelled");
});

test("didSave carries the saved text when the server asks (save.includeText), after the pending edit (D218)", async () => {
  for (const includeText of [true, false]) {
    const { client, server } = pipe();
    const s = new RpcConnection(server);
    s.onRequest("initialize", () => ({
      capabilities: { textDocumentSync: { openClose: true, change: 1, save: { includeText } } },
    }));
    const seen: { method: string; params: unknown }[] = [];
    for (const m of ["textDocument/didOpen", "textDocument/didChange", "textDocument/didSave"])
      s.onNotification(m, (p) => seen.push({ method: m, params: p }));
    const lc = new LanguageClient(client, {
      id: "mock",
      rootPath: "/w",
      languages: ["python"],
      clientName: "test",
    });
    await lc.start();
    lc.didOpen("/w/a.py", "python", "one");
    // The editor binding: an edit not yet sent goes out first.
    let pending: string | null = "two";
    lc.flushDocument = (path) => {
      if (path !== "/w/a.py") return undefined;
      if (pending !== null) lc.didChange(path, pending);
      const text = pending ?? "one";
      pending = null;
      return text;
    };
    lc.didSave("/w/a.py");
    // A file the binding doesn't sync: the caller's text, if any.
    lc.didSave("/w/b.py", "bee");
    lc.didSave("/w/c.py");
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(
      seen.map((e) => e.method),
      [
        "textDocument/didOpen",
        "textDocument/didChange",
        "textDocument/didSave",
        "textDocument/didSave",
        "textDocument/didSave",
      ],
    );
    const saves = seen.filter((e) => e.method === "textDocument/didSave").map((e) => e.params);
    assert.deepEqual(
      saves,
      includeText
        ? [
            { textDocument: { uri: "file:///w/a.py" }, text: "two" },
            { textDocument: { uri: "file:///w/b.py" }, text: "bee" },
            { textDocument: { uri: "file:///w/c.py" } },
          ]
        : [
            { textDocument: { uri: "file:///w/a.py" } },
            { textDocument: { uri: "file:///w/b.py" } },
            { textDocument: { uri: "file:///w/c.py" } },
          ],
    );
    lc.dispose();
  }
});

test("a notebook's save is its joined document's, with the text when the server asks (D229)", async () => {
  for (const includeText of [true, false]) {
    const { client, server } = pipe();
    const s = new RpcConnection(server);
    s.onRequest("initialize", () => ({
      capabilities: { textDocumentSync: { openClose: true, change: 1, save: { includeText } } },
    }));
    const saves: unknown[] = [];
    s.onNotification("textDocument/didSave", (p) => saves.push(p));
    const lc = new LanguageClient(client, {
      id: "mock",
      rootPath: "/w",
      languages: ["python"],
      clientName: "test",
    });
    await lc.start();
    lc.joinedDocuments = (path) =>
      path === "/w/nb.ipynb" ? [{ path: "/w/nb.ipynb.concat.py", text: "x = 1\nx" }] : [];
    lc.didSave("/w/nb.ipynb");
    lc.didSave("/w/a.py");
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(saves, [
      {
        textDocument: { uri: "file:///w/nb.ipynb.concat.py" },
        ...(includeText && { text: "x = 1\nx" }),
      },
      { textDocument: { uri: "file:///w/a.py" } },
    ]);
    lc.dispose();
  }
});
