import assert from "node:assert/strict";
import { test } from "node:test";
import { colorProviderLanguages, validColors, validPresentations } from "./colors";
import {
  childNodes,
  childrenMethod,
  defaultDirection,
  findNode,
  type HierarchyItem,
  type HierarchyNode,
  HierarchySession,
  hierarchyTitle,
  isDirectionOf,
  kindOfDirection,
  nodeData,
  nodeOrigin,
  nodeTarget,
  otherDirection,
  prepareMethod,
  rootNodes,
  symbolKindName,
  treeData,
  treeFiles,
} from "./hierarchy";
import { pathToUri } from "./uri";

const range = (line: number, character: number, length = 3) => ({
  start: { line, character },
  end: { line, character: character + length },
});
const item = (name: string, path: string, line: number, kind = 12): HierarchyItem => ({
  name,
  kind,
  uri: pathToUri(path),
  range: range(line, 0, 20),
  selectionRange: range(line, 9),
  data: { name },
});
const rel = (p: string) => p.replace(/^\/work\//, "");

test("methods and directions", () => {
  assert.equal(prepareMethod("call"), "textDocument/prepareCallHierarchy");
  assert.equal(prepareMethod("type"), "textDocument/prepareTypeHierarchy");
  assert.equal(childrenMethod("incoming"), "callHierarchy/incomingCalls");
  assert.equal(childrenMethod("outgoing"), "callHierarchy/outgoingCalls");
  assert.equal(childrenMethod("supertypes"), "typeHierarchy/supertypes");
  assert.equal(childrenMethod("subtypes"), "typeHierarchy/subtypes");
  assert.equal(otherDirection("incoming"), "outgoing");
  assert.equal(otherDirection("subtypes"), "supertypes");
  assert.equal(kindOfDirection("outgoing"), "call");
  assert.equal(kindOfDirection("supertypes"), "type");
  assert.equal(defaultDirection("call"), "incoming");
  assert.equal(defaultDirection("type"), "subtypes");
  assert.ok(isDirectionOf("call", "outgoing"));
  assert.ok(!isDirectionOf("call", "subtypes"));
  assert.equal(hierarchyTitle("incoming", "f"), "Callers of f");
  assert.equal(hierarchyTitle("supertypes", "T"), "Supertypes of T");
  assert.equal(symbolKindName(12), "function");
  assert.equal(symbolKindName(5), "class");
  assert.equal(symbolKindName(99), "variable");
});

test("prepare's items become root rows; malformed ones are left out", () => {
  const roots = rootNodes([item("main", "/work/a.ts", 4), { name: "broken" } as HierarchyItem]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0]?.id, "0");
  assert.equal(roots[0]?.path, "/work/a.ts");
  assert.deepEqual(rootNodes(null), []);
});

test("incoming calls: the caller, with its call sites in its own file", () => {
  const [root] = rootNodes([item("target", "/work/a.ts", 1)]) as [HierarchyNode];
  const kids = childNodes("incoming", root, [
    { from: item("caller", "/work/b.ts", 10), fromRanges: [range(12, 4), range(15, 2)] },
    { from: null, fromRanges: [] },
  ]);
  assert.equal(kids.length, 1);
  const [k] = kids as [HierarchyNode];
  assert.equal(k.id, "0/0");
  assert.equal(k.item.name, "caller");
  assert.deepEqual(k.calls?.path, "/work/b.ts");
  assert.deepEqual(nodeTarget(k), { path: "/work/b.ts", line: 13, column: 5 });
  assert.deepEqual(nodeData(k, rel), {
    id: "0/0",
    name: "caller",
    kind: "function",
    path: "b.ts",
    line: 11,
    column: 10,
    calls: {
      path: "b.ts",
      positions: [
        { line: 13, column: 5 },
        { line: 16, column: 3 },
      ],
    },
  });
});

test("outgoing calls: the callee, with the call sites in the parent's file", () => {
  const [root] = rootNodes([item("main", "/work/a.ts", 1)]) as [HierarchyNode];
  const [k] = childNodes("outgoing", root, [
    { to: item("helper", "/work/c.ts", 20), fromRanges: [range(3, 2)] },
  ]) as [HierarchyNode];
  assert.equal(k.path, "/work/c.ts");
  assert.equal(k.calls?.path, "/work/a.ts");
  // A click goes to the call in main, as in VS Code.
  assert.deepEqual(nodeTarget(k), { path: "/work/a.ts", line: 4, column: 3 });
});

test("type hierarchy items, targets and the loaded tree as data", () => {
  const [root] = rootNodes([item("Base", "/work/a.ts", 0, 5)]) as [HierarchyNode];
  const kids = childNodes("subtypes", root, [
    { ...item("Child", "/work/b.ts", 2, 5), tags: [1], detail: "b.ts" },
    "nonsense",
  ]);
  assert.equal(kids.length, 1);
  const [k] = kids as [HierarchyNode];
  assert.equal(k.calls, undefined);
  assert.deepEqual(nodeTarget(k), { path: "/work/b.ts", line: 3, column: 10 });
  const loaded = new Map([[root.id, kids]]);
  assert.deepEqual(treeData([root], loaded, rel), [
    {
      id: "0",
      name: "Base",
      kind: "class",
      path: "a.ts",
      line: 1,
      column: 10,
      children: [
        {
          id: "0/0",
          name: "Child",
          kind: "class",
          detail: "b.ts",
          path: "b.ts",
          line: 3,
          column: 10,
          deprecated: true,
        },
      ],
    },
  ]);
  // The cap counts every row.
  assert.equal(treeData([root], loaded, rel, 1)[0]?.children?.length, 0);
  assert.deepEqual(childNodes("subtypes", root, null), []);
});

test("rows by id, the files a tree points into, a row's own origin (m7.12)", () => {
  const [root] = rootNodes([item("f", "/work/a.ts", 4)]) as [HierarchyNode];
  const kids = childNodes("incoming", root, [
    { from: item("g", "/work/b.ts", 1), fromRanges: [range(2, 3)] },
    { from: item("h", "/work/c.ts", 7), fromRanges: [] },
  ]);
  const loaded = new Map([[root.id, kids]]);
  assert.equal(findNode([root], loaded, "0"), root);
  assert.equal(findNode([root], loaded, "0/1")?.item.name, "h");
  assert.equal(findNode([root], loaded, "0/5"), undefined);
  assert.equal(findNode([root], loaded, "0/1/0"), undefined);
  assert.deepEqual(treeFiles([root], loaded), ["/work/a.ts", "/work/b.ts", "/work/c.ts"]);
  const [g] = kids as [HierarchyNode];
  // Re-rooting goes to the symbol's name, not the call site a click opens.
  assert.deepEqual(nodeOrigin(g), { path: "/work/b.ts", line: 2, column: 10 });
  assert.equal(nodeOrigin({ ...g, path: null }), null);
});

test("color providers skip languages the built-in services color", () => {
  assert.deepEqual(colorProviderLanguages(["css", "scss", "less", "html", "json", "dart"]), [
    "html",
    "dart",
  ]);
  assert.deepEqual(
    validColors([
      { range: range(0, 0, 7), color: { red: 1, green: 0.5, blue: 2, alpha: -1 } },
      { range: range(1, 0), color: { red: 0, green: 0, blue: 0 } },
      { color: { red: 0, green: 0, blue: 0, alpha: 1 } },
    ]).map((c) => c.color),
    [
      { red: 1, green: 0.5, blue: 1, alpha: 0 },
      { red: 0, green: 0, blue: 0, alpha: 1 },
    ],
  );
  assert.deepEqual(validPresentations([{ label: "#ff0000" }, { nope: 1 }, null]), [
    { label: "#ff0000" },
  ]);
  assert.deepEqual(validColors(null), []);
});

test("a session loads levels lazily, once, and starts over when the direction changes", async () => {
  const asked: string[] = [];
  // a ← b ← c (incoming); a → d (outgoing).
  const files: Record<string, number> = { a: 1, b: 2, c: 3, d: 4 };
  const callers: Record<string, string[]> = { a: ["b"], b: ["c"], c: [] };
  let release: (() => void) | undefined;
  const request = async (method: string, params: unknown) => {
    const name = (params as { item: HierarchyItem }).item.name;
    asked.push(`${method} ${name}`);
    if (method === "callHierarchy/outgoingCalls") {
      await new Promise<void>((r) => {
        release = r;
      });
      return [{ to: item("d", "/work/d.ts", files.d ?? 0), fromRanges: [range(0, 0)] }];
    }
    return (callers[name] ?? []).map((n) => ({
      from: item(n, `/work/${n}.ts`, files[n] ?? 0),
      fromRanges: [range(0, 0)],
    }));
  };
  const session = new HierarchySession(
    "call",
    "incoming",
    rootNodes([item("a", "/work/a.ts", 1)]),
    request,
  );
  const [root] = session.roots as [HierarchyNode];
  const [b] = (await session.children(root)) as [HierarchyNode];
  assert.equal(b.item.name, "b");
  await session.children(root);
  assert.deepEqual(asked, ["callHierarchy/incomingCalls a"]);
  await session.expand(5);
  assert.deepEqual(
    session.data(rel).map((n) => n.children?.[0]?.children?.[0]?.name),
    ["c"],
  );
  assert.ok(!session.setDirection("subtypes"));
  // An answer for the old direction that arrives after a switch back is dropped.
  assert.ok(session.setDirection("outgoing"));
  const late = session.children(root);
  assert.ok(session.setDirection("incoming"));
  release?.();
  assert.equal((await late)[0]?.item.name, "d");
  assert.equal(session.loaded.size, 0);
  assert.equal(session.direction, "incoming");
});

test("a session's expand stops at its limit and skips failed levels", async () => {
  const make = (failAt: number) => {
    let n = 0;
    return new HierarchySession(
      "type",
      "subtypes",
      rootNodes([item("T", "/work/t.ts", 0, 5)]),
      async () => {
        n++;
        if (n === failAt) throw new Error("server error");
        return [item(`S${n}a`, "/work/s.ts", n, 5), item(`S${n}b`, "/work/s.ts", n, 5)];
      },
    );
  };
  const capped = make(-1);
  await capped.expand(10, 4);
  // T → 2 subtypes (3 rows), then the first of them → 2 more (5 rows ≥ 4): stopped.
  let data = capped.data(rel);
  assert.equal(data[0]?.children?.length, 2);
  assert.equal(data[0]?.children?.[0]?.children?.length, 2);
  assert.equal(data[0]?.children?.[1]?.children, undefined);
  // The third request fails: that row has no children, the rest are there.
  const failing = make(3);
  await failing.expand(2);
  data = failing.data(rel);
  assert.equal(data[0]?.children?.[0]?.children?.length, 2);
  assert.equal(data[0]?.children?.[1]?.children, undefined);
});
