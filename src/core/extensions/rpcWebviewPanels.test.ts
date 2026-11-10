// The worker side of run-time webview panels (ide.ui.createWebviewPanel): show options, page
// URIs, and the requests and callbacks through createWorkerApi with a fake host.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerApi, type FromWorker, type RequestMessage, type ToWorker } from "./rpc";
import { panelPlacement, rootPaths, webviewUri } from "./rpcWebviewPanels";

function fakeHost(answer: (method: string) => unknown = () => null) {
  const sent: FromWorker[] = [];
  let deliver: (m: ToWorker) => void = () => {};
  let callId = 1000;
  const { api } = createWorkerApi(
    {
      post: (m) => {
        sent.push(m);
        if (m.t === "req")
          queueMicrotask(() => deliver({ t: "res", id: m.id, ok: true, value: answer(m.method) }));
      },
      onMessage: (h) => (deliver = h),
    },
    { id: "acme.preview", version: "1.0.0", path: "C:\\ext\\preview" },
  );
  const requests = (method?: string) =>
    sent
      .filter((m): m is RequestMessage => m.t === "req")
      .filter((m) => !method || m.method === method)
      .map((m) => m.params as Record<string, unknown>);
  const methods = () => sent.filter((m): m is RequestMessage => m.t === "req").map((m) => m.method);
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const call = async (target: string, args: unknown) => {
    const id = ++callId;
    deliver({ t: "call", id, kind: "provider", target, args });
    await tick();
    await tick();
  };
  return { api, requests, methods, tick, call };
}

test("panelPlacement: VS Code's columns and places, and preserveFocus", () => {
  assert.deepEqual(panelPlacement(undefined), { placement: "main", preserveFocus: false });
  assert.deepEqual(panelPlacement(1), { placement: "main", preserveFocus: false });
  assert.deepEqual(panelPlacement(-1), { placement: "main", preserveFocus: false });
  assert.deepEqual(panelPlacement(-2), { placement: "beside", preserveFocus: false });
  assert.deepEqual(panelPlacement(2), { placement: "beside", preserveFocus: false });
  assert.deepEqual(panelPlacement("bottom"), { placement: "bottom", preserveFocus: false });
  assert.deepEqual(panelPlacement({ viewColumn: -2, preserveFocus: true }), {
    placement: "beside",
    preserveFocus: true,
  });
});

test("webviewUri: the extension's files as the page addresses them", () => {
  assert.equal(webviewUri("C:\\ext\\preview", "media/a.css"), "media/a.css");
  assert.equal(webviewUri("C:\\ext\\preview", "./main.js"), "main.js");
  assert.equal(webviewUri("C:\\ext\\preview", "C:\\ext\\preview\\media\\b.png"), "media/b.png");
  assert.equal(webviewUri("/ext/p/", "/ext/p/x/y.js"), "x/y.js");
  assert.throws(() => webviewUri("/ext/p", "../secret.txt"));
  assert.throws(() => webviewUri("/ext/p", "https://example.com/x.js"));
});

test("webviewUri: a file of a local resource root (a workspace folder) has an address of its own", () => {
  assert.equal(
    webviewUri("C:\\ext\\p", "C:\\work\\site\\img 1.png", ["C:\\work\\site"]),
    "/__fs/C%3A/work/site/img%201.png",
  );
  assert.equal(
    webviewUri("/ext/p", "/home/me/proj/a.css", ["/home/me/proj/"]),
    "/__fs/home/me/proj/a.css",
  );
  // Outside every root, or climbing out of one: not served.
  assert.throws(() => webviewUri("/ext/p", "/home/me/other/a.css", ["/home/me/proj"]));
  assert.throws(() => webviewUri("/ext/p", "/home/me/proj/../x", ["/home/me/proj"]));
  assert.throws(() => webviewUri("/ext/p", "/home/me/projX/a", ["/home/me/proj"]));
  assert.deepEqual(rootPaths([{ fsPath: "/a" }, "C:\\b", "relative", 3]), ["/a", "C:\\b"]);
});

test("a serializer brings a panel back: the host's tab, its state, then normal updates", async () => {
  const h = fakeHost();
  const seen: unknown[] = [];
  const registration = h.api.ui.registerWebviewPanelSerializer("claudeVSCodePanel", {
    deserialize(panel, state) {
      seen.push(state, panel.viewType, panel.title, panel.visible);
      panel.webview.html = "<p>back</p>";
    },
  });
  await h.tick();
  assert.deepEqual(h.requests("webviewPanel.serializer"), [
    { viewType: "claudeVSCodePanel", register: true },
  ]);
  await h.call("webviewPanelSerializer.claudeVSCodePanel", {
    id: "restored1",
    title: "Claude",
    state: { session: "s1" },
    visible: true,
    active: false,
  });
  assert.deepEqual(seen, [{ session: "s1" }, "claudeVSCodePanel", "Claude", true]);
  // Not created again: the html goes as an update of the host's panel.
  assert.equal(h.requests("webviewPanel.create").length, 0);
  assert.deepEqual(h.requests("webviewPanel.update"), [{ id: "restored1", html: "<p>back</p>" }]);
  registration.dispose();
  await h.tick();
  assert.deepEqual(h.requests("webviewPanel.serializer").at(-1), {
    viewType: "claudeVSCodePanel",
    register: false,
  });
});

test("createWebviewPanel: one create with the html set in the same turn, then updates", async () => {
  const h = fakeHost((m) => (m === "webviewPanel.post" ? true : null));
  const panel = h.api.ui.createWebviewPanel("preview.md", "Preview", -2, { enableScripts: true });
  panel.webview.html = "<h1>one</h1>";
  panel.title = "Preview: a.md";
  await h.tick();
  const [create, ...rest] = h.requests("webviewPanel.create");
  assert.equal(rest.length, 0);
  assert.equal(create?.viewType, "preview.md");
  assert.equal(create?.title, "Preview: a.md");
  assert.equal(create?.html, "<h1>one</h1>");
  assert.equal(create?.placement, "beside");
  assert.equal(h.requests("webviewPanel.update").length, 0);
  // Later changes in one turn: one update.
  panel.webview.html = "<h1>two</h1>";
  panel.title = "Two";
  await h.tick();
  assert.deepEqual(h.requests("webviewPanel.update"), [
    { id: create?.id, html: "<h1>two</h1>", title: "Two" },
  ]);
  assert.equal(panel.webview.html, "<h1>two</h1>");
  assert.equal(await panel.webview.postMessage({ hi: 1 }), true);
  assert.deepEqual(h.requests("webviewPanel.post")[0], { id: create?.id, message: { hi: 1 } });
  assert.equal(panel.webview.asWebviewUri("media/x.css"), "media/x.css");
  assert.equal(panel.webview.cspSource, "'self'");
});

test("createWebviewPanel: messages, view state and the user's close reach the code", async () => {
  const h = fakeHost();
  const panel = h.api.ui.createWebviewPanel("x.view", "X");
  await h.tick();
  const id = String(h.requests("webviewPanel.create")[0]?.id);
  const seen: string[] = [];
  panel.webview.onDidReceiveMessage((m) => seen.push(`msg ${JSON.stringify(m)}`));
  panel.onDidChangeViewState((e) =>
    seen.push(`state ${e.webviewPanel.visible} ${e.webviewPanel.active}`),
  );
  panel.onDidDispose(() => seen.push("disposed"));
  await h.call(`webviewPanel.${id}`, { kind: "message", message: { a: 1 } });
  await h.call(`webviewPanel.${id}`, { kind: "state", visible: false, active: false });
  // The same state again: no event.
  await h.call(`webviewPanel.${id}`, { kind: "state", visible: false, active: false });
  await h.call(`webviewPanel.${id}`, { kind: "disposed" });
  assert.deepEqual(seen, ['msg {"a":1}', "state false false", "disposed"]);
  assert.equal(await panel.webview.postMessage("late"), false);
  // Disposed by the user: dispose() is a no-op (no request back).
  panel.dispose();
  await h.tick();
  assert.equal(h.requests("webviewPanel.dispose").length, 0);
});

test("createWebviewPanel: dispose closes it once; reveal goes after the create", async () => {
  const h = fakeHost();
  const panel = h.api.ui.createWebviewPanel("x.view", "X", { preserveFocus: true });
  panel.reveal(undefined, true);
  let disposed = 0;
  panel.onDidDispose(() => disposed++);
  await h.tick();
  assert.deepEqual(h.methods(), ["webviewPanel.create", "webviewPanel.reveal"]);
  assert.equal(h.requests("webviewPanel.create")[0]?.preserveFocus, true);
  panel.dispose();
  panel.dispose();
  await h.tick();
  assert.equal(disposed, 1);
  assert.equal(h.requests("webviewPanel.dispose").length, 1);
  assert.equal(h.requests("webviewPanel.reveal")[0]?.preserveFocus, true);
  // Disposed before it was ever sent: nothing goes out.
  const quick = h.api.ui.createWebviewPanel("x.view", "Y");
  quick.dispose();
  await h.tick();
  assert.equal(h.requests("webviewPanel.create").length, 1);
});
