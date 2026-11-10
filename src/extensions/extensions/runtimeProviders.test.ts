import assert from "node:assert/strict";
import { test } from "node:test";
import { Emitter } from "../../core/events/index";
import type { FeatureContext } from "../../workbench/extensionFeatures";
import { type ProviderDeps, type ProviderPart, providerFeature } from "./runtimeProviders";

/** Deps whose worker answers per part; `asked` records what was asked. */
function fakeDeps(answers: Partial<Record<ProviderPart | "provide", unknown>>) {
  const asked: { part: ProviderPart | "provide"; context: unknown }[] = [];
  const changed = new Emitter<void>();
  const deps: ProviderDeps = {
    ask: async (context, part) => {
      asked.push({ part: part ?? "provide", context });
      const answer = answers[part ?? "provide"];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    changed: changed.event,
    canAsk: (path) => path.startsWith("/ws/"),
    resolve: (path) => {
      if (typeof path !== "string" || path.startsWith("..")) throw new Error("outside");
      return path.startsWith("/") ? path : `/ws/${path}`;
    },
    resolveWritable: (path) => {
      if (typeof path !== "string" || path.includes(".git")) throw new Error("not writable");
      return path.startsWith("/") ? path : `/ws/${path}`;
    },
    ownCommand: (id) => id.startsWith("demo."),
  };
  return { deps, asked, changed };
}

const at = (path: string, word = "name"): FeatureContext => ({
  path,
  languageId: "plaintext",
  line: 2,
  column: 3,
  word,
  linePrefix: "  ",
});

test("rename's prepare: only when registered with it; asked as the prepare part", async () => {
  const { deps, asked } = fakeDeps({
    prepare: { range: { startLine: 2, startColumn: 1, endColumn: 5 }, placeholder: "name" },
  });
  assert.equal(providerFeature("rename", {}, deps).prepareRename, undefined);
  const prepare = providerFeature("rename", { prepare: true }, deps).prepareRename;
  assert.ok(prepare);
  assert.deepEqual(await prepare(at("/ws/a.txt")), {
    range: { startLine: 2, startColumn: 1, endColumn: 5 },
    placeholder: "name",
  });
  assert.equal(asked.at(-1)?.part, "prepare");
  // Documents it may not be asked about (not the folder's, not open) aren't.
  assert.equal(await prepare(at("/elsewhere/a.txt")), null);
  assert.equal(asked.length, 1);
  // A refusal reaches the editor as a rejection with the extension's message.
  const refusing = fakeDeps({ prepare: new Error("Only words.") });
  const refuse = providerFeature("rename", { prepare: true }, refusing.deps).prepareRename;
  await assert.rejects(refuse?.(at("/ws/a.txt", "")) ?? Promise.resolve(), /Only words\./);
});

test("code actions resolved when chosen: edits checked, ids released", async () => {
  const { deps, asked } = fakeDeps({
    provide: [{ title: "Later", resolveId: "a1" }],
    resolve: {
      title: "Later",
      edits: [
        { startLine: 1, text: "x" },
        { path: ".git/x", startLine: 1, text: "y" },
      ],
    },
  });
  const plain = providerFeature("codeActions", {}, deps);
  assert.equal(plain.resolveCodeAction, undefined);
  assert.equal(plain.releaseCodeActions, undefined);
  const part = providerFeature("codeActions", { resolve: true }, deps);
  const context = { path: "/ws/a.txt", languageId: "plaintext" };
  assert.deepEqual(
    await part.codeActions?.({
      ...context,
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
      diagnostics: [],
    }),
    [{ title: "Later", resolveId: "a1" }],
  );
  assert.deepEqual(await part.resolveCodeAction?.({ ...context, resolveId: "a1" }), [
    { startLine: 1, text: "x", path: "/ws/a.txt" },
  ]);
  assert.equal(asked.at(-1)?.part, "resolve");
  assert.deepEqual(asked.at(-1)?.context, { ...context, resolveId: "a1" });
  part.releaseCodeActions?.(["a1"]);
  part.releaseCodeActions?.([]);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(
    asked.filter((a) => a.part === "release").map((a) => a.context),
    [{ resolveIds: ["a1"] }],
  );
});

test("semantic tokens: the refresh event is the provider's onDidChange", () => {
  const { deps, changed } = fakeDeps({});
  const tokens = providerFeature(
    "semanticTokens",
    { legend: { tokenTypes: ["keyword"] } },
    deps,
  ).semanticTokens;
  let fired = 0;
  const sub = tokens?.onDidChange?.(() => fired++);
  changed.fire();
  sub?.dispose();
  changed.fire();
  assert.equal(fired, 1);
});
