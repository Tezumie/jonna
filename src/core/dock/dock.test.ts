import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addTab,
  allGroups,
  type DockNode,
  deserialize,
  equalize,
  findGroup,
  findTab,
  type GroupNode,
  layoutRects,
  mainGroup,
  moveGroup,
  moveTab,
  neighborGroup,
  normalize,
  regionGroups,
  removeGroup,
  removeTab,
  resizeGroup,
  resolvePlacement,
  serialize,
  setHidden,
  setSplitSizes,
  splitGroup,
  splitRoot,
  type TabRef,
} from "./index";

const tab = (id: string, viewType = "editor"): TabRef => ({
  id,
  viewType,
  viewState: { path: `/${id}` },
});
const group = (id: string, ...tabs: TabRef[]): GroupNode => ({
  kind: "group",
  id,
  tabs,
  activeTabId: tabs[0]?.id ?? null,
});
const editorish = (t: TabRef) => t.viewType === "editor" || t.viewType === "welcome";

/** The default arrangement from docs/dock.md §3. */
function defaultTree(): DockNode {
  return {
    kind: "split",
    direction: "row",
    sizes: [0.7, 0.3],
    children: [
      {
        kind: "split",
        direction: "column",
        sizes: [0.7, 0.3],
        children: [group("main", tab("a"), tab("b")), group("bottom", tab("term", "terminal"))],
      },
      group("right", tab("agent", "agent")),
    ],
  };
}

const shape = (n: DockNode): unknown =>
  n.kind === "group"
    ? `${n.id}[${n.tabs.map((t) => t.id).join(",")}]`
    : { [n.direction]: n.children.map(shape) };
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test("insert: addTab places and activates; duplicates are rejected", () => {
  const t = addTab(defaultTree(), "main", tab("c"), 1);
  assert.deepEqual(
    findGroup(t, "main")?.tabs.map((x) => x.id),
    ["a", "c", "b"],
  );
  assert.equal(findGroup(t, "main")?.activeTabId, "c");
  assert.throws(() => addTab(t, "main", tab("a")));
  assert.throws(() => addTab(t, "nope", tab("z")));
});

test("close: removing a tab activates a neighbor; closing the last tab removes the group", () => {
  let t = removeTab(defaultTree(), "a");
  assert.equal(findGroup(t, "main")?.activeTabId, "b");
  t = removeTab(t, "term");
  assert.deepEqual(shape(t), { row: ["main[b]", "right[agent]"] });
  // Siblings share the space proportionally: column (0.7) absorbed into one group.
  assert.ok(t.kind === "split" && close(t.sizes[0] ?? 0, 0.7));
});

test("collapse + flatten: single-child splits collapse, row-in-row flattens", () => {
  const nested: DockNode = {
    kind: "split",
    direction: "row",
    sizes: [0.5, 0.5],
    children: [
      {
        kind: "split",
        direction: "row",
        sizes: [0.5, 0.5],
        children: [group("x", tab("1")), group("y", tab("2"))],
      },
      { kind: "split", direction: "column", sizes: [1], children: [group("z", tab("3"))] },
    ],
  };
  const n = normalize(structuredClone(nested));
  assert.deepEqual(shape(n as DockNode), { row: ["x[1]", "y[2]", "z[3]"] });
  assert.ok(n?.kind === "split");
  assert.deepEqual(
    n.sizes.map((s) => Math.round(s * 100)),
    [25, 25, 50],
  );
});

test("split: joins a same-direction parent, wraps otherwise", () => {
  // Right of "main" in a column → wraps main in a row.
  let t = splitGroup(defaultTree(), "main", "right", group("g1", tab("c")), 0.5);
  assert.deepEqual(shape(t), {
    row: [{ column: [{ row: ["main[a,b]", "g1[c]"] }, "bottom[term]"] }, "right[agent]"],
  });
  // Below "bottom" (column parent) → becomes a sibling in that column.
  t = splitGroup(t, "bottom", "bottom", group("g2", tab("d")), 0.5);
  const column = t.kind === "split" ? t.children[0] : undefined;
  assert.ok(
    column?.kind === "split" && column.direction === "column" && column.children.length === 3,
  );
  assert.ok(
    close(
      column.sizes.reduce((a, b) => a + b, 0),
      1,
    ),
  );
});

test("splitRoot: dock edges span the full height/width", () => {
  const t = splitRoot(defaultTree(), "bottom", group("g", tab("p", "problems")), 0.25);
  assert.deepEqual(shape(t), {
    column: [{ row: [{ column: ["main[a,b]", "bottom[term]"] }, "right[agent]"] }, "g[p]"],
  });
  const left = splitRoot(defaultTree(), "left", group("l", tab("q")), 0.2);
  assert.ok(left.kind === "split" && left.children.length === 3 && close(left.sizes[0] ?? 0, 0.2));
});

test("move: into another group, reorder within a group, split, dock edge", () => {
  let t = moveTab(defaultTree(), "term", { groupId: "main", index: 1 }, "x");
  assert.deepEqual(shape(t), { row: ["main[a,term,b]", "right[agent]"] });
  t = moveTab(t, "a", { groupId: "main", index: 3 }, "x");
  assert.deepEqual(
    findGroup(t, "main")?.tabs.map((x) => x.id),
    ["term", "b", "a"],
  );
  t = moveTab(t, "term", { groupId: "main", split: "right" }, "g1");
  assert.deepEqual(shape(t), { row: ["main[b,a]", "g1[term]", "right[agent]"] });
  t = moveTab(t, "agent", { root: "bottom" }, "g2", 0.3);
  assert.deepEqual(shape(t), { column: [{ row: ["main[b,a]", "g1[term]"] }, "g2[agent]"] });
  // Splitting a group off itself when it holds only that tab is a no-op.
  assert.equal(moveTab(t, "agent", { groupId: "g2", split: "left" }, "g3"), t);
  assert.throws(() => moveTab(t, "nope", { groupId: "main" }, "g4"));
});

test("removeGroup, resize, setSplitSizes, equalize", () => {
  let t = removeGroup(defaultTree(), "right");
  assert.deepEqual(shape(t), { column: ["main[a,b]", "bottom[term]"] });
  t = resizeGroup(defaultTree(), "bottom", 0.5);
  const col = t.kind === "split" ? t.children[0] : undefined;
  assert.ok(col?.kind === "split" && close(col.sizes[1] ?? 0, 0.5));
  t = setSplitSizes(t, [0], [3, 1]);
  const col2 = t.kind === "split" ? t.children[0] : undefined;
  assert.ok(col2?.kind === "split" && close(col2.sizes[0] ?? 0, 0.75));
  t = equalize(t);
  assert.ok(t.kind === "split" && close(t.sizes[0] ?? 0, 0.5));
});

test("closing everything leaves one empty group", () => {
  let t: DockNode = group("only", tab("x"));
  t = removeTab(t, "x");
  assert.deepEqual(t, { kind: "group", id: "only", tabs: [], activeTabId: null });
});

test("geometry: rects, neighbors, hidden groups give space away", () => {
  const rects = layoutRects(defaultTree());
  assert.ok(close(rects.get("bottom")?.y ?? 0, 0.7) && close(rects.get("right")?.x ?? 0, 0.7));
  assert.equal(neighborGroup(defaultTree(), "main", "right"), "right");
  assert.equal(neighborGroup(defaultTree(), "main", "bottom"), "bottom");
  assert.equal(neighborGroup(defaultTree(), "bottom", "top"), "main");
  assert.equal(neighborGroup(defaultTree(), "main", "left"), undefined);
  const hidden = setHidden(defaultTree(), ["bottom"], true);
  assert.ok(close(layoutRects(hidden).get("main")?.h ?? 0, 1));
  assert.equal(layoutRects(hidden).has("bottom"), false);
});

test("placement hints resolve by id, then by region", () => {
  const t = defaultTree();
  assert.equal(resolvePlacement(t, "bottom", editorish)?.id, "bottom");
  // After rearranging, ids are gone: hints resolve to the region.
  const renamed = JSON.parse(
    JSON.stringify(t).replaceAll('"bottom"', '"g7"').replaceAll('"right"', '"g8"'),
  );
  assert.equal(resolvePlacement(renamed, "bottom", editorish)?.id, "g7");
  assert.equal(resolvePlacement(renamed, "right", editorish)?.id, "g8");
  assert.equal(resolvePlacement(renamed, "main", editorish)?.id, "main");
  assert.equal(mainGroup(renamed, editorish)?.id, "main");
  const noBottom = removeGroup(renamed, "g7");
  assert.equal(resolvePlacement(noBottom, "bottom", editorish), undefined);
});

test("serialize/deserialize round-trip and reject malformed input", () => {
  const t = setHidden(defaultTree(), ["right"], true);
  const back = deserialize(JSON.parse(JSON.stringify(serialize(t))));
  assert.deepEqual(back, t);
  assert.equal(deserialize(null), null);
  assert.equal(deserialize({ kind: "split", direction: "diagonal", children: [] }), null);
  assert.equal(deserialize({ kind: "group", id: "a", tabs: [{ id: 1 }] }), null);
  const dup = { kind: "split", direction: "row", children: [group("a"), group("a")] };
  assert.equal(deserialize(dup), null);
  assert.equal(allGroups(deserialize({ kind: "group", id: "e", tabs: [] }) as DockNode).length, 1);
  assert.ok(findTab(back as DockNode, "agent"));
});

test("region groups count hidden groups and follow rearrangement", () => {
  const t = defaultTree();
  const ids = (r: "bottom" | "right", n: DockNode) =>
    regionGroups(n, r, editorish).map((g) => g.id);
  assert.deepEqual(ids("bottom", t), ["bottom"]);
  assert.deepEqual(ids("right", t), ["right"]);
  const hidden = setHidden(t, ["bottom", "right"], true);
  assert.deepEqual(ids("bottom", hidden), ["bottom"]);
  assert.deepEqual(ids("right", hidden), ["right"]);
  // A second terminal split next to the first stays in the bottom region.
  const two = splitGroup(t, "bottom", "right", group("b2", tab("term2", "terminal")));
  assert.deepEqual(ids("bottom", two).sort(), ["b2", "bottom"]);
  // Editors never count, even at the bottom.
  const ed = splitGroup(t, "main", "bottom", group("e2", tab("x")));
  assert.equal(ids("bottom", ed).includes("e2"), false);
});

test("moveGroup splits next to another group, keeping id, tabs and active tab", () => {
  const root: DockNode = {
    kind: "split",
    direction: "row",
    children: [group("a", tab("1"), tab("2")), group("b", tab("3"))],
    sizes: [0.5, 0.5],
  };
  const moved = moveGroup(root, "a", { groupId: "b", split: "bottom" });
  // b is the only top-level child left, split into a column with a below it.
  assert.equal(moved.kind, "split");
  assert.equal((moved as { direction: string }).direction, "column");
  const a = findGroup(moved, "a");
  assert.deepEqual(
    a?.tabs.map((t) => t.id),
    ["1", "2"],
  );
  assert.equal(a?.activeTabId, "1");
});

test("moveGroup into a group merges its tabs at the index and activates the moved active tab", () => {
  const src = group("a", tab("1"), tab("2"));
  src.activeTabId = "2";
  const root: DockNode = {
    kind: "split",
    direction: "row",
    children: [src, group("b", tab("3"), tab("4"))],
    sizes: [0.5, 0.5],
  };
  const merged = moveGroup(root, "a", { groupId: "b", index: 1 });
  assert.equal(merged.kind, "group");
  assert.deepEqual(
    (merged as GroupNode).tabs.map((t) => t.id),
    ["3", "1", "2", "4"],
  );
  assert.equal((merged as GroupNode).activeTabId, "2");
});

test("moveGroup to a dock edge, and no-ops", () => {
  const root: DockNode = {
    kind: "split",
    direction: "row",
    children: [group("a", tab("1")), group("b", tab("2"))],
    sizes: [0.5, 0.5],
  };
  const edged = moveGroup(root, "b", { root: "left" });
  assert.deepEqual(
    allGroups(edged).map((g) => g.id),
    ["b", "a"],
  );
  assert.equal(moveGroup(root, "a", { groupId: "a", split: "left" }), root);
  const single = group("only", tab("1"));
  assert.equal(moveGroup(single, "only", { root: "top" }), single);
});

test("pinned tabs stay pinned through serialize/deserialize; bad sizes are replaced", () => {
  const t: DockNode = {
    kind: "group",
    id: "g",
    tabs: [
      { id: "a", viewType: "v", viewState: null, pinned: true },
      { id: "b", viewType: "v", viewState: null },
    ],
    activeTabId: "b",
  };
  const back = deserialize(JSON.parse(JSON.stringify(serialize(t))));
  assert.ok(back?.kind === "group");
  assert.equal(back.tabs[0]?.pinned, true);
  assert.equal(back.tabs[1]?.pinned, undefined);
  // 1e999 is valid JSON that parses to Infinity: it would make every rect NaN.
  const split = deserialize(
    JSON.parse(
      '{"kind":"split","direction":"row","sizes":[1e999,1],"children":[' +
        '{"kind":"group","id":"x","tabs":[],"activeTabId":null},' +
        '{"kind":"group","id":"y","tabs":[],"activeTabId":null}]}',
    ),
  );
  assert.ok(split?.kind === "split");
  assert.deepEqual(split.sizes, [0.5, 0.5]);
});
