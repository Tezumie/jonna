import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commitFilesQuery,
  INCOMING_ID,
  layoutGraph,
  OUTGOING_ID,
  PromiseCache,
  refChipColor,
  refLabelColor,
  type SyncInfo,
  withSyncChanges,
} from "./graph";

const c = (hash: string, ...parents: string[]) => ({ hash, parents });

test("a straight history stays in lane 0", () => {
  const rows = layoutGraph([c("c", "b"), c("b", "a"), c("a")]);
  assert.deepEqual(
    rows.map((r) => r.lane),
    [0, 0, 0],
  );
  assert.equal(
    rows[0]?.edges.some((e) => e.part === "top"),
    false,
  );
  assert.equal(
    rows[1]?.edges.some((e) => e.part === "top"),
    true,
  );
  assert.equal(
    rows[2]?.edges.some((e) => e.part === "bottom"),
    false,
  );
});

test("a merge opens a lane for its second parent and it joins back at the fork", () => {
  // m merges f (feature) into b; both come from a.
  const rows = layoutGraph([c("m", "b", "f"), c("f", "a"), c("b", "a"), c("a")]);
  assert.deepEqual(
    rows.map((r) => r.lane),
    [0, 1, 0, 0],
  );
  assert.equal(rows[0]?.merge, true);
  assert.deepEqual(
    rows[0]?.edges.filter((e) => e.part === "bottom").map((e) => e.to),
    [0, 1],
  );
  // At a: lane 1 (waiting for a after f) joins lane 0's dot.
  assert.ok(rows[3]?.edges.some((e) => e.part === "top" && e.from === 1 && e.to === 0));
  // b's row: lane 1 passes through.
  assert.ok(rows[2]?.edges.some((e) => e.part === "through" && e.from === 1));
  assert.notEqual(rows[1]?.color, rows[0]?.color);
});

test("two branch tips get their own lanes", () => {
  const rows = layoutGraph([c("x", "a"), c("y", "a"), c("a")]);
  assert.deepEqual(
    rows.map((r) => r.lane),
    [0, 1, 0],
  );
  assert.equal(rows[2]?.width, 2);
});

// D210: VS Code's lane colors and the incoming / outgoing rows.
const labels =
  (map: Record<string, "ref" | "remote">) =>
  (hash: string): "ref" | "remote" | undefined =>
    map[hash];

test("the current branch's lane is the ref color down to where the remote is, then the remote's", () => {
  // HEAD (main) at c, origin/main at b: c is unpushed.
  const rows = layoutGraph([c("c", "b"), c("b", "a"), c("a")], {
    labelColor: labels({ c: "ref", b: "remote" }),
  });
  assert.deepEqual(
    rows.map((r) => r.color),
    ["ref", "remote", "remote"],
  );
  // b is joined from above in the ref color (the line it came in with), left below in purple.
  assert.equal(rows[1]?.edges.find((e) => e.part === "top")?.color, "ref");
  assert.equal(rows[1]?.edges.find((e) => e.part === "bottom")?.color, "remote");
});

test("lanes without a label keep their color; new lanes rotate through five", () => {
  const rows = layoutGraph([
    c("t1", "a"),
    c("t2", "a"),
    c("t3", "a"),
    c("t4", "a"),
    c("t5", "a"),
    c("t6", "a"),
    c("a"),
  ]);
  assert.deepEqual(
    rows.slice(0, 6).map((r) => r.color),
    ["0", "1", "2", "3", "4", "0"],
  );
  // A merge's second parent with a label takes it (VS Code: the parent's label color).
  const merged = layoutGraph([c("m", "b", "u"), c("u", "a"), c("b", "a"), c("a")], {
    labelColor: labels({ m: "ref", u: "remote" }),
  });
  assert.equal(merged[1]?.color, "remote");
  assert.equal(merged[0]?.color, "ref");
});

const sync = (over: Partial<SyncInfo>): SyncInfo => ({
  head: null,
  upstream: null,
  mergeBase: null,
  incoming: new Set(),
  ahead: 0,
  behind: 0,
  ...over,
});

test("outgoing changes: a row just above HEAD that HEAD hangs from, in the ref color", () => {
  // main at c (2 ahead of origin/main at a).
  const commits = [c("c", "b"), c("b", "a"), c("a")];
  const { items, graph } = withSyncChanges(
    commits,
    sync({ head: "c", upstream: "a", mergeBase: "a", ahead: 2 }),
  );
  assert.deepEqual(
    items.map((i) => (i.kind === "commit" ? i.commit.hash : `${i.kind}:${i.count}`)),
    ["outgoing:2", "c", "b", "a"],
  );
  assert.deepEqual(graph[0], { hash: OUTGOING_ID, parents: ["c"] });
  const rows = layoutGraph(graph, { labelColor: labels({ c: "ref", a: "remote" }) });
  assert.equal(rows[0]?.color, "ref");
  assert.equal(rows[0]?.lane, rows[1]?.lane);
  // HEAD is joined from the outgoing row.
  assert.ok(rows[1]?.edges.some((e) => e.part === "top"));
});

test("incoming changes: a row just above the fork, the upstream's commits run into it", () => {
  // main at b, origin/main at u (1 behind, 1 ahead); they forked at a.
  const commits = [c("u", "a"), c("b", "a"), c("a")];
  const { items, graph } = withSyncChanges(
    commits,
    sync({
      head: "b",
      upstream: "u",
      mergeBase: "a",
      incoming: new Set(["u"]),
      ahead: 1,
      behind: 1,
    }),
  );
  assert.deepEqual(
    items.map((i) => (i.kind === "commit" ? i.commit.hash : i.kind)),
    ["u", "outgoing", "b", "incoming", "a"],
  );
  assert.deepEqual(graph[0]?.parents, [INCOMING_ID]);
  assert.deepEqual(graph[3], { hash: INCOMING_ID, parents: ["a"] });
  const rows = layoutGraph(graph, { labelColor: labels({ b: "ref", u: "remote" }) });
  assert.equal(rows[3]?.color, "remote");
  // u's lane comes down to the incoming row, which joins a.
  assert.equal(rows[3]?.lane, rows[0]?.lane);
  assert.ok(rows[4]?.edges.some((e) => e.part === "top" && e.from === rows[3]?.lane));
});

test("no sync rows when in sync, without an upstream, or when the fork isn't listed", () => {
  const commits = [c("b", "a"), c("a")];
  const kinds = (s: SyncInfo) => withSyncChanges(commits, s).items.map((i) => i.kind);
  assert.deepEqual(kinds(sync({ head: "b", upstream: "b", mergeBase: "b" })), ["commit", "commit"]);
  assert.deepEqual(kinds(sync({ head: "b", ahead: 1 })), ["commit", "commit"]);
  assert.deepEqual(
    kinds(sync({ head: "b", upstream: "x", mergeBase: "z", behind: 1, incoming: new Set(["x"]) })),
    ["commit", "commit"],
  );
});

test("refLabelColor: the current branch, its upstream, a detached HEAD", () => {
  const branch = { head: "main", upstream: "origin/main", detached: false };
  assert.equal(refLabelColor(["HEAD -> main", "origin/main"], branch), "ref");
  assert.equal(refLabelColor(["origin/main"], branch), "remote");
  assert.equal(refLabelColor(["tag: v1", "feature"], branch), undefined);
  assert.equal(refLabelColor(["HEAD"], { head: null, upstream: null, detached: true }), "ref");
});

test("refLabelColor: the base branch is orange unless it's the branch or its upstream", () => {
  const branch = {
    head: "feature",
    upstream: "origin/feature",
    detached: false,
    base: "origin/main",
  };
  assert.equal(refLabelColor(["origin/main", "origin/HEAD"], branch), "base");
  // The upstream wins over the base on one commit; the current branch over both.
  assert.equal(refLabelColor(["origin/main", "origin/feature"], branch), "remote");
  assert.equal(refLabelColor(["origin/main", "HEAD -> feature"], branch), "ref");
  // On the default branch itself there's no third color.
  const onMain = { head: "main", upstream: "origin/main", detached: false, base: "origin/main" };
  assert.equal(refLabelColor(["origin/main"], onMain), "remote");
  // A base lane runs down from its commit like the others.
  const rows = layoutGraph([c("f", "m"), c("m2", "m"), c("m")], {
    labelColor: (h) => (h === "f" ? "ref" : h === "m2" ? "base" : undefined),
  });
  assert.equal(rows[1]?.color, "base");
});

test("refChipColor: by kind in Auto, by lane in All branches; the base orange", () => {
  const branch = {
    head: "feature",
    upstream: "origin/feature",
    detached: false,
    base: "origin/main",
  };
  assert.equal(refChipColor({ kind: "head", name: "feature" }, branch, "3", true), null);
  assert.equal(refChipColor({ kind: "remote", name: "origin/feature" }, branch, "3", true), null);
  assert.equal(refChipColor({ kind: "remote", name: "origin/main" }, branch, "3", false), "base");
  assert.equal(refChipColor({ kind: "branch", name: "other" }, branch, "3", true), "3");
  assert.equal(refChipColor({ kind: "branch", name: "other" }, branch, "3", false), null);
  assert.equal(refChipColor({ kind: "tag", name: "v1" }, branch, "1", true), "1");
  assert.equal(refChipColor({ kind: "tag", name: "v1" }, branch, "1", false), null);
});

test("a commit's files are read against its first parent; a root commit's from its detail", () => {
  assert.deepEqual(commitFilesQuery(c("b", "a", "m")), { kind: "range", left: "a", right: "b" });
  assert.deepEqual(commitFilesQuery(c("root")), { kind: "detail" });
});

test("the promise cache reuses answers, drops the oldest and forgets failures", async () => {
  const cache = new PromiseCache<number>(2);
  let loads = 0;
  const load = (v: number) => () => {
    loads++;
    return Promise.resolve(v);
  };
  assert.equal(await cache.get("a", load(1)), 1);
  assert.equal(await cache.get("a", load(9)), 1);
  assert.equal(loads, 1);
  await cache.get("b", load(2));
  // "a" was used last-but-one, then "c" pushes out the oldest ("a" was touched before "b").
  await cache.get("a", load(9));
  await cache.get("c", load(3));
  assert.equal(cache.size, 2);
  assert.equal(await cache.get("b", load(4)), 4);
  const failing = cache.get("x", () => Promise.reject(new Error("no")));
  await assert.rejects(failing);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(await cache.get("x", load(5)), 5);
});
