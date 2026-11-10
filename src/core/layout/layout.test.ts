import assert from "node:assert/strict";
import { test } from "node:test";
import { clampSidebar, LayoutModel, SIDEBAR_LIMITS } from "./index";

test("sidebar size is clamped", () => {
  assert.equal(clampSidebar(10), SIDEBAR_LIMITS.min);
  assert.equal(clampSidebar(99_999), SIDEBAR_LIMITS.max);
  assert.equal(clampSidebar(Number.NaN), SIDEBAR_LIMITS.default);
  const layout = new LayoutModel();
  layout.resizeSidebar(333.4);
  assert.equal(layout.sidebarSize.peek(), 333);
});

test("snapshot round-trips; M1 (v1) snapshots migrate; bad data is ignored", () => {
  const a = new LayoutModel();
  a.sidebarVisible.value = false;
  a.resizeSidebar(400);
  const b = new LayoutModel();
  b.restore(JSON.parse(JSON.stringify(a.snapshot())));
  assert.deepEqual(b.snapshot(), a.snapshot());
  const c = new LayoutModel();
  c.restore({
    version: 1,
    sidebar: { visible: false, size: 300 },
    panel: { visible: true, size: 9 },
  });
  assert.deepEqual(c.snapshot().sidebar, { visible: false, size: 300 });
  const d = new LayoutModel();
  const before = d.snapshot();
  d.restore({ version: 3 });
  d.restore("nope");
  d.restore({ version: 2, sidebar: { visible: "yes", size: "big" } });
  assert.deepEqual(d.snapshot(), before);
});
