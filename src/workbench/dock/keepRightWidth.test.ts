import assert from "node:assert/strict";
import { test } from "node:test";
import type { DockNode } from "../../core/dock/index";
import { dragPair, keptRightSizes } from "./keepRightWidth";

const group = (id: string, viewType: string): DockNode => ({
  kind: "group",
  id,
  tabs: [{ id: `t-${id}`, viewType, viewState: null }],
  activeTabId: `t-${id}`,
});

test("keptRightSizes: the agent column keeps its pixels when the dock widens (D164)", () => {
  const root: DockNode = {
    kind: "split",
    direction: "row",
    sizes: [0.6, 0.4],
    children: [group("main", "welcome"), group("right", "agent")],
  };
  // 1000 px → 1600 px: the agent stays 400 px (0.25 of 1600).
  const sizes = keptRightSizes(root, 1000, 1600);
  assert.ok(sizes);
  assert.ok(Math.abs((sizes?.[1] ?? 0) - 0.25) < 1e-9);
  assert.ok(Math.abs((sizes?.[0] ?? 0) - 0.75) < 1e-9);
  // No agent on the right: proportions stay.
  const plain: DockNode = { ...root, children: [group("a", "editor"), group("b", "editor")] };
  assert.equal(keptRightSizes(plain, 1000, 1600), null);
});

test("keptRightSizes: a remembered width comes back after a narrow window (D174)", () => {
  const root: DockNode = {
    kind: "split",
    direction: "row",
    sizes: [0.4, 0.6],
    children: [group("main", "editor"), group("right", "agent")],
  };
  // Clamped at 60% of 500 px; asked for its 380 px again at 1600.
  const sizes = keptRightSizes(root, 500, 1600, 380);
  assert.ok(Math.abs((sizes?.[1] ?? 0) - 380 / 1600) < 1e-9);
  // NaN sizes never come out.
  const broken: DockNode = { ...root, sizes: [Number.NaN, Number.NaN] } as DockNode;
  assert.equal(keptRightSizes(broken, 500, 1600), null);
});

test("dragPair: both sides keep the minimum while they fit", () => {
  assert.deepEqual(dragPair(300, 300, 50, 160), [350, 250]);
  assert.deepEqual(dragPair(300, 300, -500, 160), [160, 440]);
  assert.deepEqual(dragPair(300, 300, 500, 160), [440, 160]);
});

test("dragPair: panes too small for the minimum don't jump, and never go negative", () => {
  // 100 px between two panes with an 80 px minimum: the first used to snap to 20 on any move.
  assert.deepEqual(dragPair(50, 50, 0, 80), [50, 50]);
  assert.deepEqual(dragPair(50, 50, 10, 80), [50, 50]);
  assert.deepEqual(dragPair(50, 50, -10, 80), [50, 50]);
  // The bigger one gives up room down to the minimum.
  assert.deepEqual(dragPair(90, 30, -40, 80), [80, 40]);
  // A pair under the minimum (a tiny window): both stay within the pair.
  const [a, b] = dragPair(30, 30, 100, 80);
  assert.ok(a >= 0 && b >= 0 && a + b === 60);
});
