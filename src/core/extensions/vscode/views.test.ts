// The shim's tree views, webview views and panels against a fake host: visibility, the user's
// expanding and collapsing, badges, canSelectMany's second argument, resolving a webview view
// when it first shows, a panel's column, and asWebviewUri for files outside the extension.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerApi, type FromWorker, type RequestMessage, type ToWorker } from "../rpc";
import { ShimCommands } from "./commands";
import type { Documents } from "./document";
import { Uri } from "./types";
import { createViews } from "./views";
import { createWebviews } from "./webviews";

const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeHost(answers: Record<string, unknown> = {}) {
  const sent: FromWorker[] = [];
  let deliver: (m: ToWorker) => void = () => {};
  let callId = 9000;
  const { api } = createWorkerApi(
    {
      post: (m) => {
        sent.push(m);
        if (m.t === "req")
          queueMicrotask(() =>
            deliver({ t: "res", id: m.id, ok: true, value: answers[m.method] ?? null }),
          );
      },
      onMessage: (h) => (deliver = h),
    },
    { id: "acme.views", version: "1.0.0", path: "/ext" },
  );
  const requests = (method: string) =>
    sent
      .filter((m): m is RequestMessage => m.t === "req" && m.method === method)
      .map((m) => m.params as Record<string, unknown>);
  const send = async (kind: "provider" | "tree", target: string, args: unknown) => {
    const id = ++callId;
    deliver({ t: "call", id, kind, target, args });
    for (let i = 0; i < 5; i++) await tick();
    const res = sent.find((m) => m.t === "res" && m.id === id);
    return res && res.t === "res" ? res.value : undefined;
  };
  const commands = new ShimCommands(api, [], "acme.run", () => {});
  return { api, requests, send, commands };
}

test("tree view: visible from the host, user expand / collapse, badge, canSelectMany", async () => {
  const h = fakeHost({ "view.watch": false });
  const views = createViews(h.api, h.commands, "/ext", () => {});
  const a = { name: "a" };
  const b = { name: "b" };
  const view = views.createTreeView("acme.list", {
    canSelectMany: true,
    treeDataProvider: {
      getChildren: (el?: unknown) => (el ? [] : [a, b]),
      getTreeItem: (el: unknown) => ({
        label: (el as { name: string }).name,
        collapsibleState: 1,
      }),
    },
  });
  const visibility: boolean[] = [];
  view.onDidChangeVisibility((e) => visibility.push(e.visible));
  const expanded: unknown[] = [];
  const collapsed: unknown[] = [];
  view.onDidExpandElement((e) => expanded.push(e.element));
  view.onDidCollapseElement((e) => collapsed.push(e.element));
  await tick();
  assert.equal(h.requests("view.watch")[0]?.viewId, "acme.list");
  assert.equal(view.visible, false);
  await h.send("provider", "view.acme.list.visible", { visible: true });
  assert.equal(view.visible, true);
  assert.deepEqual(visibility, [true]);

  const rows = (await h.send("tree", "acme.list", {})) as { id: string }[];
  assert.equal(rows.length, 2);
  // Loading children (a refresh) isn't an expansion; the user's is.
  await h.send("tree", "acme.list", { parent: rows[0] });
  assert.deepEqual(expanded, []);
  await h.send("provider", "tree.acme.list.expanded", { item: rows[0], expanded: true });
  await h.send("provider", "tree.acme.list.expanded", { item: rows[0], expanded: false });
  assert.deepEqual(expanded, [a]);
  assert.deepEqual(collapsed, [a]);

  view.badge = { value: 3, tooltip: "3 new" };
  await tick();
  assert.deepEqual(h.requests("tree.update").at(-1), {
    viewId: "acme.list",
    badge: { value: 3, tooltip: "3 new" },
  });

  await h.send("provider", "tree.acme.list.selection", { items: rows });
  const item = { view: "acme.list", id: rows[0]?.id };
  assert.deepEqual(h.commands.treeSelection(item, a), [a, b]);
  assert.deepEqual(h.commands.treeSelection(item, { other: 1 }), [{ other: 1 }]);
});

test("tree view: resolveTreeItem fills a missing tooltip", async () => {
  const h = fakeHost();
  const views = createViews(h.api, h.commands, "/ext", () => {});
  views.createTreeView("acme.lazy", {
    treeDataProvider: {
      getChildren: () => [1],
      getTreeItem: () => ({ label: "one" }),
      resolveTreeItem: (item) => ({ ...item, tooltip: "More about one" }),
    },
  });
  const rows = (await h.send("tree", "acme.lazy", {})) as { tooltip?: string }[];
  assert.equal(rows[0]?.tooltip, "More about one");
});

test("webview view: resolved the first time it shows, visibility changes after", async () => {
  const h = fakeHost({ "view.watch": false });
  const webviews = createWebviews(h.api, {} as Documents, "/ext", () => {});
  let resolved = 0;
  let view: { visible: boolean; onDidChangeVisibility(l: () => void): unknown } | undefined;
  webviews.registerWebviewViewProvider("acme.page", {
    resolveWebviewView: (v) => {
      resolved++;
      view = v as typeof view;
    },
  });
  await tick();
  await tick();
  assert.equal(resolved, 0, "not before it shows");
  await h.send("provider", "view.acme.page.visible", { visible: true });
  assert.equal(resolved, 1);
  assert.equal(view?.visible, true);
  let changes = 0;
  view?.onDidChangeVisibility(() => changes++);
  await h.send("provider", "view.acme.page.visible", { visible: false });
  await h.send("provider", "view.acme.page.visible", { visible: true });
  assert.equal(resolved, 1);
  assert.equal(changes, 2);
});

test("webview panel: a column by number, viewColumn from the host, asWebviewUri never throws", async () => {
  const h = fakeHost();
  const views = createViews(h.api, h.commands, "/ext", () => {});
  const panel = views.createWebviewPanel("acme.preview", "Preview", 2);
  await tick();
  const create = h.requests("webviewPanel.create")[0];
  assert.equal(create?.column, 2);
  assert.equal(create?.placement, "beside");
  assert.equal(panel.viewColumn, 1);
  await h.send("provider", `webviewPanel.${String(create?.id)}`, {
    kind: "state",
    visible: true,
    active: false,
    viewColumn: 2,
  });
  assert.equal(panel.viewColumn, 2);
  assert.equal(String(panel.webview.asWebviewUri(Uri.file("/ext/media/a.css"))), "media/a.css");
  const outside = Uri.file("/ws/data.csv");
  assert.equal(panel.webview.asWebviewUri(outside), outside);
});
