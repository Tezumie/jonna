import assert from "node:assert/strict";
import { test } from "node:test";
import type { TabRef } from "../core/dock/index";
import {
  moveDestination,
  movedViewId,
  movedViewIds,
  SIDEBAR_VIEW_TYPE,
  sameIds,
  tabOfMovedView,
} from "./movedViews";

const tab = (id: string, viewType: string, viewState: TabRef["viewState"]): TabRef => ({
  id,
  viewType,
  viewState,
});

test("movedViewId reads the view id from a tab's state", () => {
  assert.equal(movedViewId({ id: "scm.graph" }), "scm.graph");
  assert.equal(movedViewId({ id: "" }), null);
  assert.equal(movedViewId({ id: 3 }), null);
  assert.equal(movedViewId(null), null);
  assert.equal(movedViewId(["scm.graph"]), null);
});

test("movedViewIds lists only sidebar-view tabs with an id", () => {
  const tabs = [
    tab("t1", SIDEBAR_VIEW_TYPE, { id: "scm.graph" }),
    tab("t2", "editor", { path: "/a.ts", id: "scm.graph2" }),
    tab("t3", SIDEBAR_VIEW_TYPE, null),
    tab("t4", SIDEBAR_VIEW_TYPE, { id: "outline.view" }),
  ];
  assert.deepEqual([...movedViewIds(tabs)].sort(), ["outline.view", "scm.graph"]);
  assert.equal(tabOfMovedView(tabs, "outline.view")?.id, "t4");
  assert.equal(tabOfMovedView(tabs, "scm.graph2"), undefined);
});

test("sameIds compares sets", () => {
  assert.ok(sameIds(new Set(["a", "b"]), new Set(["b", "a"])));
  assert.ok(!sameIds(new Set(["a"]), new Set(["a", "b"])));
  assert.ok(!sameIds(new Set(["a"]), new Set(["b"])));
});

test("moveDestination toggles without a target", () => {
  assert.equal(moveDestination(false, undefined), "dock");
  assert.equal(moveDestination(true, undefined), "sidebar");
  assert.equal(moveDestination(true, "dock"), "dock");
});
