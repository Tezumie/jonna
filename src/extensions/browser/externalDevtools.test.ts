import assert from "node:assert/strict";
import { test } from "node:test";
import { ExternalDevtools } from "./externalDevtools";
import { Page } from "./page";

/** A protocol whose answers are given per method; every call is recorded. */
function fakeProtocol(answers: Record<string, (p: Record<string, unknown>) => unknown> = {}) {
  const calls: [string, Record<string, unknown>][] = [];
  const request = async <T>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    calls.push([method, params]);
    return (answers[method]?.(params) ?? {}) as T;
  };
  return { request, calls };
}

test("D347: the external page's requests, failures and browser console lines", async () => {
  const page = new Page("external", "window", () => {});
  const { request, calls } = fakeProtocol();
  const devtools = new ExternalDevtools(request, page, () => "main");
  await devtools.start();
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["Network.enable", "Log.enable"],
  );
  assert.equal(page.proxied, true);
  devtools.event("Network.requestWillBeSent", {
    requestId: "1",
    frameId: "main",
    type: "Document",
    request: { url: "https://app.test/", method: "GET", headers: {} },
    timestamp: 1,
    wallTime: 1000,
  });
  devtools.event("Network.requestWillBeSent", {
    requestId: "2",
    type: "Script",
    request: { url: "https://app.test/a.js", method: "GET", headers: {} },
    timestamp: 1,
  });
  devtools.event("Network.responseReceived", {
    requestId: "2",
    timestamp: 1.1,
    response: { status: 404, mimeType: "text/plain", headers: {} },
  });
  devtools.event("Network.loadingFinished", {
    requestId: "2",
    timestamp: 1.2,
    encodedDataLength: 9,
  });
  devtools.event("Log.entryAdded", {
    entry: { source: "network", level: "error", text: "Failed to load resource" },
  });
  assert.deepEqual(
    page.requests.peek().map((r) => [r.id, r.status, r.done]),
    [
      ["1", 0, false],
      ["2", 404, true],
    ],
  );
  assert.deepEqual(
    page.network.peek().map((n) => [n.url, n.status]),
    [["https://app.test/a.js", 404]],
  );
  assert.equal(page.console.peek()[0]?.text, "Failed to load resource");
  // A new document: the log starts over, keeping the page's own request still loading.
  page.beginLoad();
  devtools.newDocument();
  assert.deepEqual(
    page.requests.peek().map((r) => r.id),
    ["1"],
  );
});

test("D347: storage, cookies, highlight and resize over the protocol", async () => {
  const page = new Page("external", "window", () => {});
  page.handle({ type: "nav", url: "https://app.test/home", title: "Home" });
  const { request, calls } = fakeProtocol({
    "DOMStorage.getDOMStorageItems": (p) =>
      (p.storageId as { isLocalStorage: boolean }).isLocalStorage
        ? { entries: [["k", "v"]] }
        : { entries: [] },
    "Network.getCookies": () => ({ cookies: [{ name: "sid", value: "1", httpOnly: true }] }),
    "Runtime.evaluate": () => ({ result: { objectId: "obj1" } }),
    "Runtime.callFunctionOn": () => ({ result: { value: "e4" } }),
  });
  const devtools = new ExternalDevtools(request, page, () => "main");
  const st = await devtools.storage();
  assert.equal(st.origin, "https://app.test");
  assert.deepEqual(st.local, [["k", "v"]]);
  assert.deepEqual(st.cookies, [["sid", "1"]]);
  assert.equal(st.cookieAttributes[0]?.httpOnly, true);
  await devtools.setStorage("set", "cookie", "theme", "dark");
  assert.deepEqual(calls.find((c) => c[0] === "Network.setCookie")?.[1], {
    name: "theme",
    value: "dark",
    url: "https://app.test/home",
    path: "/",
  });
  assert.deepEqual(await devtools.highlight({ ref: "e4" }), { ref: "e4" });
  assert.equal(calls.find((c) => c[0] === "Overlay.highlightNode")?.[1].objectId, "obj1");
  await devtools.highlight(null);
  assert.ok(calls.some((c) => c[0] === "Overlay.hideHighlight"));
  const resized = await devtools.resize({ width: 375, height: 667, device: "iphone-se" }, "dark");
  assert.deepEqual(resized, { width: 375, height: 667, device: "iphone-se", colorScheme: "dark" });
  assert.ok(calls.some((c) => c[0] === "Emulation.setDeviceMetricsOverride"));
  assert.deepEqual(calls.find((c) => c[0] === "Emulation.setEmulatedMedia")?.[1], {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
});

test("D347: an element the bridge can't find is an error with its message", async () => {
  const page = new Page("external", "window", () => {});
  const { request } = fakeProtocol({
    "Runtime.evaluate": () => ({
      exceptionDetails: {
        exception: { description: "Error: No element e9 (take a new snapshot).\n    at find" },
      },
    }),
  });
  const devtools = new ExternalDevtools(request, page, () => "main");
  await assert.rejects(
    devtools.dom({ ref: "e9" }, 1000),
    /^Error: No element e9 \(take a new snapshot\)\.$/,
  );
});
