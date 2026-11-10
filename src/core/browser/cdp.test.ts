import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bindingMessage,
  bindingName,
  bridgeCall,
  bridgeInstall,
  CdpClient,
  externalUrl,
  launchArgs,
  parsePort,
  parseTargets,
  pickExternalPage,
  pngSize,
} from "./cdp";

test("D341: the page to work on in /json/list", () => {
  const ws = (id: string) => `ws://127.0.0.1:9222/devtools/page/${id}`;
  const targets = [
    { type: "page", url: "devtools://devtools/x", webSocketDebuggerUrl: ws("d") },
    { type: "service_worker", url: "https://a.test/sw.js", webSocketDebuggerUrl: ws("s") },
    { type: "page", url: "chrome://newtab/", webSocketDebuggerUrl: ws("n") },
    { type: "page", url: "https://app.test/home", webSocketDebuggerUrl: ws("a") },
    { type: "page", url: "http://localhost:5173/", webSocketDebuggerUrl: ws("l") },
  ];
  assert.equal(pickExternalPage(targets)?.webSocketDebuggerUrl, ws("a"));
  assert.equal(pickExternalPage(targets, "http://localhost:5173")?.webSocketDebuggerUrl, ws("l"));
  assert.equal(pickExternalPage(targets.slice(0, 3))?.webSocketDebuggerUrl, ws("n"));
  assert.equal(pickExternalPage([]), null);
  assert.deepEqual(parseTargets("not json"), []);
  assert.equal(parseTargets(JSON.stringify(targets)).length, 5);
});

test("D341: launch arguments, ports and addresses", () => {
  assert.deepEqual(launchArgs(9333, "C:\\p\\profile"), [
    "--remote-debugging-port=9333",
    "--user-data-dir=C:\\p\\profile",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ]);
  assert.equal(parsePort("9222"), 9222);
  assert.equal(parsePort("localhost:9333"), 9333);
  assert.equal(parsePort("http://127.0.0.1:9444/"), 9444);
  assert.equal(parsePort(":9555"), 9555);
  assert.equal(parsePort("80"), null);
  assert.equal(parsePort("example.com:9222"), null);
  assert.equal(externalUrl("localhost:5173/x"), "http://localhost:5173/x");
  assert.equal(externalUrl("example.com"), "https://example.com");
  assert.equal(externalUrl("http://a.test/"), "http://a.test/");
  assert.equal(externalUrl("about:blank"), "about:blank");
});

test("D341: the bridge's install script, calls and binding messages", () => {
  const name = bindingName(() => 0.5);
  assert.match(name, /^__ideBridgePost[0-9a-z]+$/);
  const install = bridgeInstall("/*bridge*/", name);
  assert.ok(
    install.startsWith(
      `window.__IDE_BRIDGE_MODE__="external";window.__IDE_BRIDGE_POST__="${name}";`,
    ),
  );
  assert.ok(install.endsWith("/*bridge*/"));
  const call = bridgeCall({
    ns: "ide-host",
    type: "call",
    id: 3,
    method: "snapshot",
    params: { a: "</script>" },
  });
  assert.equal(
    call,
    'void (window.__ideBridge && window.__ideBridge.receive({"ns":"ide-host","type":"call","id":3,"method":"snapshot","params":{"a":"</script>"}}))',
  );
  assert.deepEqual(bindingMessage({ name, payload: '{"type":"ready","url":"x"}' }, name), {
    type: "ready",
    url: "x",
  });
  assert.equal(bindingMessage({ name: "other", payload: "{}" }, name), null);
  assert.equal(bindingMessage({ name, payload: "[1]" }, name), null);
  assert.equal(bindingMessage({ name, payload: "{bad" }, name), null);
});

test("D341: PNG size from its header", () => {
  const header = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0,
    0, 0, 2, 208,
  ]);
  assert.deepEqual(pngSize(header), { width: 1280, height: 720 });
  assert.equal(pngSize(new Uint8Array(4)), null);
});

test("D341: protocol requests answer once; events go to the listener; close fails the rest", async () => {
  const sent: string[] = [];
  const events: string[] = [];
  const client = new CdpClient(
    (t) => sent.push(t),
    (method) => events.push(method),
    1000,
  );
  const first = client.request<{ value: number }>("Runtime.evaluate", { expression: "1" });
  const second = client.request("Page.navigate", { url: "x" });
  assert.deepEqual(JSON.parse(sent[0] ?? ""), {
    id: 1,
    method: "Runtime.evaluate",
    params: { expression: "1" },
  });
  client.handle('{"method":"Page.loadEventFired","params":{}}');
  client.handle('{"id":1,"result":{"value":1}}');
  client.handle('{"id":1,"result":{"value":2}}');
  client.handle("garbage");
  client.handle("null"); // valid JSON, not a message: ignored, not thrown
  assert.deepEqual(await first, { value: 1 });
  assert.deepEqual(events, ["Page.loadEventFired"]);
  client.handle('{"id":2,"error":{"message":"Cannot navigate"}}');
  await assert.rejects(second, /Cannot navigate/);
  const third = client.request("Page.reload");
  client.close("The browser closed.");
  await assert.rejects(third, /browser closed/);
  await assert.rejects(client.request("Page.reload"), /browser closed/);
});
