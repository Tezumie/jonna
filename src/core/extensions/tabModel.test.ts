// window.tabGroups: the host's snapshot of the editor groups (tabModel.ts) and the shim's Tab /
// TabGroup objects and events over it (vscode/tabGroups.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DockNode, TabRef } from "../dock/index";
import { createWorkerApi, type FromWorker, type RequestMessage, type ToWorker } from "./rpc";
import { diffSnapshots, readSnapshot, tabInput, tabsSnapshot } from "./tabModel";
import { TabInputTerminal, TabInputText, TabInputTextDiff } from "./vscode/extraTypes";
import { createTabGroups, TABS_EVENT } from "./vscode/tabGroups";

const tab = (id: string, viewType: string, viewState: TabRef["viewState"] = null): TabRef => ({
  id,
  viewType,
  viewState,
});

const root: DockNode = {
  kind: "split",
  direction: "column",
  sizes: [0.7, 0.3],
  children: [
    {
      kind: "split",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        {
          kind: "group",
          id: "g1",
          activeTabId: "t2",
          tabs: [
            { ...tab("t1", "editor", { path: "/ws/a.ts" }), pinned: true },
            tab("t2", "diff", { path: "/ws/a.ts", against: "/ws/b.ts" }),
          ],
        },
        {
          kind: "group",
          id: "g2",
          activeTabId: "t3",
          tabs: [{ ...tab("t3", "notebook", { path: "/ws/n.ipynb" }), preview: true }],
        },
      ],
    },
    { kind: "group", id: "panel", activeTabId: "t9", tabs: [tab("t9", "terminal")] },
  ],
};

const info = { title: (t: TabRef) => t.id.toUpperCase(), isDirty: (t: TabRef) => t.id === "t1" };

test("tabInput: each view type's kind and files", () => {
  assert.deepEqual(tabInput(tab("x", "editor", { path: "/a" })), { kind: "text", uri: "/a" });
  assert.deepEqual(tabInput(tab("x", "diff", { path: "/a", staged: true })), {
    kind: "textDiff",
    original: "git:/a",
    modified: "/a",
  });
  assert.deepEqual(tabInput(tab("x", "diff", { path: "/a", base: "claude:/left" })), {
    kind: "textDiff",
    original: "claude:/left",
    modified: "/a",
  });
  assert.deepEqual(tabInput(tab("x", "extviewer:acme.png", { path: "/i.png" })), {
    kind: "custom",
    uri: "/i.png",
    viewType: "acme.png",
  });
  assert.deepEqual(
    tabInput(tab("x", "extpanel:acme.ext", { panel: "panel1" }), {
      panelViewType: () => "acme.view",
    }),
    { kind: "webview", viewType: "acme.view" },
  );
  assert.deepEqual(tabInput(tab("x", "terminal")), { kind: "terminal" });
  assert.deepEqual(tabInput(tab("x", "settings")), { kind: "other" });
});

test("tabsSnapshot: editor groups in order, panels left out, states", () => {
  const snap = tabsSnapshot(root, "panel", new Set(["panel"]), info);
  assert.deepEqual(
    snap.groups.map((g) => [g.id, g.viewColumn, g.isActive]),
    [
      ["g1", 1, true],
      ["g2", 2, false],
    ],
  );
  const [t1, t2] = snap.groups[0]?.tabs ?? [];
  assert.equal(t1?.isPinned, true);
  assert.equal(t1?.isDirty, true);
  assert.equal(t1?.isActive, false);
  assert.equal(t2?.isActive, true);
  assert.equal(t2?.label, "T2");
  assert.equal(snap.groups[1]?.tabs[0]?.isPreview, true);
  assert.equal(tabsSnapshot(root, "g2", new Set(["panel"]), info).groups[1]?.isActive, true);
});

test("diffSnapshots and readSnapshot", () => {
  const a = tabsSnapshot(root, "g1", new Set(["panel"]), info);
  const b = readSnapshot(JSON.parse(JSON.stringify(a)));
  assert.ok(b);
  assert.deepEqual(diffSnapshots(a, b), {
    groups: { opened: [], closed: [], changed: [] },
    tabs: { opened: [], closed: [], changed: [] },
  });
  const g1 = b.groups[0];
  assert.ok(g1);
  g1.tabs = g1.tabs.filter((t) => t.id !== "t2").map((t) => ({ ...t, isActive: true }));
  const kept = g1.tabs[0];
  assert.ok(kept);
  g1.tabs.push({ ...kept, id: "t5", isActive: false });
  const d = diffSnapshots(a, b);
  assert.deepEqual(d.tabs, { opened: ["t5"], closed: ["t2"], changed: ["t1"] });
  assert.deepEqual(d.groups.changed, ["g1"]);
  assert.equal(readSnapshot({ nope: 1 }), null);
});

function fakeWorker() {
  const sent: FromWorker[] = [];
  let deliver: (m: ToWorker) => void = () => {};
  const { api } = createWorkerApi(
    {
      post: (m) => {
        sent.push(m);
        if (m.t === "req")
          queueMicrotask(() => deliver({ t: "res", id: m.id, ok: true, value: true }));
      },
      onMessage: (h) => (deliver = h),
    },
    { id: "acme.tabs", version: "1.0.0" },
  );
  const requests = (method: string) =>
    sent
      .filter((m): m is RequestMessage => m.t === "req" && m.method === method)
      .map((m) => m.params as Record<string, unknown>);
  const push = async (snapshot: unknown) => {
    const sub = requests("events.subscribe").find((p) => p.type === TABS_EVENT)?.sub;
    deliver({ t: "call", id: Math.random(), kind: "event", target: String(sub), args: snapshot });
    await new Promise((r) => setTimeout(r, 0));
  };
  return { api, requests, push };
}

test("tabGroups: follows snapshots once looked at; stable objects; events; close", async () => {
  const w = fakeWorker();
  const { tabGroups } = createTabGroups(w.api);
  assert.equal(w.requests("events.subscribe").length, 0, "nothing until it's used");
  const events: { opened: number; closed: number; changed: number }[] = [];
  tabGroups.onDidChangeTabs((e) =>
    events.push({ opened: e.opened.length, closed: e.closed.length, changed: e.changed.length }),
  );
  assert.equal(w.requests("events.subscribe").length, 1);
  const snap = tabsSnapshot(root, "g1", new Set(["panel"]), info);
  await w.push(snap);
  assert.deepEqual(events, [{ opened: 3, closed: 0, changed: 0 }]);
  const [g1, g2] = tabGroups.all;
  assert.equal(g1?.viewColumn, 1);
  assert.equal(tabGroups.activeTabGroup, g1);
  const diffTab = g1?.activeTab;
  assert.ok(diffTab?.input instanceof TabInputTextDiff);
  assert.equal((diffTab.input as TabInputTextDiff).original.fsPath.replace(/\\/g, "/"), "/ws/b.ts");
  assert.ok(g1?.tabs[0]?.input instanceof TabInputText);
  assert.equal(g2?.tabs[0]?.isPreview, true);

  // The diff tab closes: the same Tab object is reported closed; the others stay the same.
  const first = g1?.tabs[0];
  const next = JSON.parse(JSON.stringify(snap));
  next.groups[0].tabs = next.groups[0].tabs.slice(0, 1);
  next.groups[0].tabs[0].isActive = true;
  let closed: unknown;
  tabGroups.onDidChangeTabs((e) => {
    closed = e.closed[0];
  });
  await w.push(next);
  assert.equal(closed, diffTab);
  assert.equal(tabGroups.all[0]?.tabs[0], first);
  assert.equal(tabGroups.all[0]?.activeTab, first);

  assert.equal(await tabGroups.close(first), true);
  assert.deepEqual(w.requests("tabs.close").at(-1), { ids: ["t1"], preserveFocus: false });
  await tabGroups.close(tabGroups.all[1], true);
  assert.deepEqual(w.requests("tabs.close").at(-1), { ids: ["t3"], preserveFocus: true });
  assert.equal(await tabGroups.close({}), false);
  assert.ok(new TabInputTerminal());
});
