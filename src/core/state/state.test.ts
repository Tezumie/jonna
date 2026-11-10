import assert from "node:assert/strict";
import { test } from "node:test";
import { fitToBudget, StateTree } from "./index";

test("fitToBudget leaves small values alone and reports truncation", () => {
  const small = fitToBudget({ a: 1 }, 100);
  assert.equal(small.truncated, false);
  assert.deepEqual(small.value, { a: 1 });

  const big = {
    items: Array.from({ length: 1000 }, (_, i) => ({ i, name: `file-${i}.ts` })),
    text: "x".repeat(10_000),
  };
  const fitted = fitToBudget(big, 2_000);
  assert.equal(fitted.truncated, true);
  assert.ok(fitted.size <= 2_000, `size ${fitted.size}`);
  const value = fitted.value as { items: unknown[]; text: string };
  assert.ok(value.items.length > 0 && value.items.length < 1000);
  assert.deepEqual(
    value.items[0],
    { i: 0, name: "file-0.ts" },
    "keeps the first (most important) items",
  );
  assert.ok(fitted.notes.some((n) => n.startsWith("/items: showing")));
  assert.ok(fitted.notes.some((n) => n.startsWith("/text: string cut")));
});

test("StateTree registers, lists, reads with budget and unregisters", async () => {
  const tree = new StateTree();
  const reg = tree.register("ide://editors", {
    description: "Open editors",
    get: ({ budget }) => ({ budgetSeen: budget, tabs: ["a.ts", "b.ts"] }),
  });
  tree.register("ide://workspace", { description: "Workspace", get: async () => ({ root: "/w" }) });
  assert.throws(() => tree.register("ide://editors", { description: "", get: () => null }));
  assert.throws(() => tree.register("editors", { description: "", get: () => null }));

  assert.deepEqual(
    tree.list().map((p) => p.path),
    ["ide://editors", "ide://workspace"],
  );
  const snap = await tree.get("ide://editors", { budget: 500 });
  assert.deepEqual(snap.value, { budgetSeen: 500, tabs: ["a.ts", "b.ts"] });
  assert.equal(snap.truncated, false);
  await assert.rejects(tree.get("ide://nope"), /Known paths: ide:\/\/editors, ide:\/\/workspace/);

  const all = await tree.getTree({ budget: 1000 });
  assert.deepEqual(Object.keys(all.paths), ["ide://editors", "ide://workspace"]);
  const editors = all.paths["ide://editors"];
  assert.ok(editors);
  assert.equal((editors.value as { budgetSeen: number }).budgetSeen, 500);

  reg.dispose();
  assert.equal(tree.has("ide://editors"), false);
});

test("provider errors become values instead of failing the whole tree", async () => {
  const tree = new StateTree();
  tree.register("ide://broken", {
    description: "x",
    get: () => {
      throw new Error("nope");
    },
  });
  const snap = await tree.get("ide://broken");
  assert.deepEqual(snap.value, { error: "nope" });
});
