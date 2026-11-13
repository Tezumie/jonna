import assert from "node:assert/strict";
import { test } from "node:test";
import { startLayoutOf, startLayoutPlan } from "./startLayout";

test("startLayoutOf keeps a known layout and falls back to default", () => {
  assert.equal(startLayoutOf("agent"), "agent");
  assert.equal(startLayoutOf("code"), "code");
  assert.equal(startLayoutOf("editor"), "default");
  assert.equal(startLayoutOf(undefined), "default");
});

test("default: chats and the agent beside welcome; a folder shows the explorer, no terminal", () => {
  assert.deepEqual(startLayoutPlan("default", false), {
    sidebar: "agent.chats",
    sidebarVisible: true,
    main: ["welcome"],
    bottom: [],
    right: ["agent"],
    readme: true,
  });
  const folder = startLayoutPlan("default", true);
  assert.equal(folder.sidebar, "explorer.view");
  assert.deepEqual(folder.bottom, []);
});

test("agent: the chat alone with the chats list, with or without a folder", () => {
  for (const folder of [false, true]) {
    const plan = startLayoutPlan("agent", folder);
    assert.equal(plan.sidebar, "agent.chats");
    assert.equal(plan.sidebarVisible, true);
    assert.deepEqual([plan.main, plan.bottom, plan.right], [[], [], ["agent"]]);
    assert.equal(plan.readme, false);
  }
});

test("code: welcome alone; the explorer shows only with a folder", () => {
  const empty = startLayoutPlan("code", false);
  assert.equal(empty.sidebar, "explorer.view");
  assert.equal(empty.sidebarVisible, false);
  assert.deepEqual([empty.main, empty.bottom, empty.right], [["welcome"], [], []]);
  assert.equal(startLayoutPlan("code", true).sidebarVisible, true);
});
