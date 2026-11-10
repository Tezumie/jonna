import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_PANEL_STATE, RestorablePanels, toSavedPanel } from "./webviewPanelRestore";

test("saved panels: checked, too-big state left out", () => {
  assert.equal(toSavedPanel(null), null);
  assert.equal(toSavedPanel({ owner: "a b", viewType: "x" }), null);
  assert.equal(toSavedPanel({ owner: "acme.x", viewType: "" }), null);
  assert.deepEqual(
    toSavedPanel({ owner: "acme.x", viewType: "v", title: "T", state: { n: 1 }, groupId: "g3" }),
    { owner: "acme.x", viewType: "v", title: "T", state: { n: 1 }, groupId: "g3" },
  );
  const big = "x".repeat(MAX_PANEL_STATE + 1);
  assert.deepEqual(toSavedPanel({ owner: "acme.x", viewType: "v", state: big }), {
    owner: "acme.x",
    viewType: "v",
    title: "",
  });
});

test("restorable panels wait for their extension, which takes those it can restore", () => {
  const panels = new RestorablePanels();
  panels.load([
    { owner: "anthropic.claude-code", viewType: "claudeVSCodePanel", title: "Claude", shown: true },
    { owner: "anthropic.claude-code", viewType: "other", title: "?" },
    { owner: "acme.preview", viewType: "preview", title: "Preview" },
    "junk",
  ]);
  assert.equal(panels.pending.peek().length, 3);
  const taken = panels.take("anthropic.claude-code", (t) => t === "claudeVSCodePanel");
  assert.deepEqual(
    taken.map((p) => p.title),
    ["Claude"],
  );
  assert.equal(panels.pending.peek().length, 2);
  // Saving keeps the open ones first, then those still waiting.
  const saved = panels.save([{ owner: "acme.live", viewType: "v", title: "Live" }]);
  assert.deepEqual(
    saved.map((p) => p.title),
    ["Live", "?", "Preview"],
  );
  panels.clear();
  assert.equal(panels.pending.peek().length, 0);
});
