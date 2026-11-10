// D234: the worker side of the language providers added for VS Code's rest.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerApi, type FromWorker, type RequestMessage, type ToWorker } from "./rpc";

function fakeHost() {
  const sent: FromWorker[] = [];
  let deliver: (m: ToWorker) => void = () => {};
  const { api } = createWorkerApi(
    {
      post: (m) => {
        sent.push(m);
        if (m.t === "req")
          queueMicrotask(() => deliver({ t: "res", id: m.id, ok: true, value: null }));
      },
      onMessage: (h) => (deliver = h),
    },
    { id: "acme.lang", version: "1.0.0" },
  );
  const requests = () => sent.filter((m): m is RequestMessage => m.t === "req");
  let callId = 500;
  const ask = async (target: string, args: unknown) => {
    const id = ++callId;
    deliver({ t: "call", id, kind: "provider", target, args });
    await new Promise((r) => setTimeout(r, 0));
    const res = sent.find((m) => m.t === "res" && m.id === id);
    assert.ok(res && res.t === "res");
    return res.value;
  };
  return { api, requests, ask };
}

test("new providers register with their feature and answer provider calls", async () => {
  const h = fakeHost();
  const L = h.api.languages;
  L.registerTypeDefinitionProvider("x", () => ({ path: "a.x", startLine: 1 }));
  L.registerImplementationProvider("x", () => []);
  L.registerDeclarationProvider("x", () => null);
  L.registerDocumentHighlightProvider("x", () => [{ startLine: 1, kind: "read" }]);
  L.registerFoldingRangeProvider("x", () => [{ startLine: 1, endLine: 3 }]);
  L.registerDocumentLinkProvider("x", () => [{ startLine: 1, target: "https://e.com" }]);
  L.registerColorProvider("css", () => [], { presentations: () => ["red"] });
  L.registerOnTypeFormattingProvider("x", () => [], [";", "}"]);
  L.registerInlineCompletionProvider(["x", "y"], (ctx) => [`after ${ctx.word}`]);
  const symbols = L.registerWorkspaceSymbolProvider(({ query }) => [
    { name: query, path: "a.x", startLine: 2 },
  ]);
  const regs = h
    .requests()
    .filter((r) => r.method === "languages.register")
    .map((r) => r.params as Record<string, unknown>);
  assert.deepEqual(
    regs.map((r) => r.feature),
    [
      "typeDefinition",
      "implementation",
      "declaration",
      "documentHighlights",
      "foldingRanges",
      "documentLinks",
      "colors",
      "onTypeFormatting",
      "inlineCompletions",
      "workspaceSymbols",
    ],
  );
  const by = (feature: string) => regs.find((r) => r.feature === feature) ?? {};
  assert.equal(by("colors").presentations, true);
  assert.deepEqual(by("onTypeFormatting").triggerCharacters, [";", "}"]);
  assert.deepEqual(by("inlineCompletions").languages, ["x", "y"]);
  assert.deepEqual(by("workspaceSymbols").languages, ["*"]);

  assert.deepEqual(await h.ask(String(by("inlineCompletions").id), { word: "foo" }), ["after foo"]);
  assert.deepEqual(await h.ask(`${String(by("colors").id)}.presentations`, {}), ["red"]);
  assert.deepEqual(await h.ask(String(by("declaration").id), {}), null);
  assert.deepEqual(await h.ask(String(by("workspaceSymbols").id), { query: "main" }), [
    { name: "main", path: "a.x", startLine: 2 },
  ]);
  symbols.dispose();
  assert.equal(await h.ask(String(by("workspaceSymbols").id), { query: "main" }), null);
  assert.ok(h.requests().some((r) => r.method === "languages.unregister"));
});
