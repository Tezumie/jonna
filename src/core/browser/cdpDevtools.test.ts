import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bodyText,
  boxSize,
  colorSchemeMedia,
  declarations,
  deviceMetrics,
  failedRequest,
  findExpression,
  headerPairs,
  logEntry,
  NetworkLog,
  sheetSource,
  storageResult,
  stylesResult,
} from "./cdpDevtools";

test("D347: Network events become request records, redirects as hops of their own", () => {
  const log = new NetworkLog();
  const sent = log.apply("Network.requestWillBeSent", {
    requestId: "7",
    request: {
      url: "https://app.test/login",
      method: "POST",
      headers: { Accept: "*/*", "Set-Thing": "a\nb" },
      hasPostData: true,
    },
    timestamp: 100,
    wallTime: 1700000000,
    type: "Document",
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.reqHeaders, [
    ["Accept", "*/*"],
    ["Set-Thing", "a"],
    ["Set-Thing", "b"],
  ]);
  assert.equal(sent[0]?.startMs, 1700000000000);
  assert.equal(sent[0]?.hasRequestBody, true);
  assert.equal(sent[0]?.initiator, "navigation");
  // A redirect: the first hop ends with its status, the next starts under the same id.
  const hop = log.apply("Network.requestWillBeSent", {
    requestId: "7",
    request: { url: "https://app.test/home", method: "GET", headers: {} },
    redirectResponse: { status: 302, mimeType: "text/html", headers: { Location: "/home" } },
    timestamp: 100.05,
    wallTime: 1700000000.05,
    type: "Document",
  });
  assert.equal(hop.length, 2);
  assert.deepEqual(
    [hop[0]?.id, hop[0]?.status, hop[0]?.done, Math.round(hop[0]?.durationMs ?? 0)],
    ["7:1", 302, true, 50],
  );
  assert.deepEqual([hop[1]?.id, hop[1]?.url, hop[1]?.done], ["7", "https://app.test/home", false]);
  const res = log.apply("Network.responseReceived", {
    requestId: "7",
    timestamp: 100.15,
    response: {
      status: 200,
      mimeType: "text/html",
      headers: { "content-type": "text/html" },
      requestHeaders: { Cookie: "sid=1" },
    },
  });
  assert.equal(res[0]?.status, 200);
  assert.equal(Math.round(res[0]?.ttfbMs ?? 0), 100);
  assert.deepEqual(res[0]?.reqHeaders, [["Cookie", "sid=1"]]);
  const done = log.apply("Network.loadingFinished", {
    requestId: "7",
    timestamp: 100.3,
    encodedDataLength: 5120,
  });
  assert.deepEqual(
    [done[0]?.size, done[0]?.done, Math.round(done[0]?.durationMs ?? 0)],
    [5120, true, 250],
  );
  // Unknown ids and events are ignored.
  assert.deepEqual(log.apply("Network.loadingFinished", { requestId: "7" }), []);
  assert.deepEqual(log.apply("Network.dataReceived", { requestId: "8" }), []);
  assert.deepEqual(log.apply("Network.requestWillBeSent", {}), []);
});

test("D347: failures and websockets", () => {
  const log = new NetworkLog();
  log.apply("Network.requestWillBeSent", {
    requestId: "a",
    request: { url: "https://cdn.test/x.png", method: "GET", headers: {} },
    timestamp: 1,
    type: "Image",
  });
  const failed = log.apply("Network.loadingFailed", {
    requestId: "a",
    timestamp: 2,
    errorText: "net::ERR_NAME_NOT_RESOLVED",
  });
  assert.equal(failed[0]?.error, "net::ERR_NAME_NOT_RESOLVED");
  assert.equal(failed[0]?.initiator, "img");
  const f = failed[0] ? failedRequest(failed[0]) : null;
  assert.equal(f?.error, "net::ERR_NAME_NOT_RESOLVED");
  // A 404 counts; a cancelled one or an open one doesn't.
  assert.ok(failed[0] && failedRequest({ ...failed[0], error: undefined, status: 404 }));
  assert.equal(failed[0] && failedRequest({ ...failed[0], error: "cancelled" }), null);
  assert.equal(failed[0] && failedRequest({ ...failed[0], done: false }), null);
  const ws = log.apply("Network.webSocketCreated", { requestId: "w", url: "ws://localhost/hmr" });
  assert.equal(ws[0]?.protocol, "websocket");
  assert.equal(log.apply("Network.webSocketClosed", { requestId: "w" })[0]?.done, true);
  assert.deepEqual(headerPairs("nope"), []);
});

test("D347: bodies as text, base64 decoded and cut", () => {
  assert.equal(bodyText("hello", false, 100), "hello");
  assert.equal(bodyText(btoa("héllo".replace("é", "e")), true, 100), "hello");
  assert.equal(bodyText("abcdef", false, 3), "abc… (3 more characters)");
  assert.equal(bodyText("%%%", true, 100), "");
  assert.equal(bodyText(undefined, false, 10), "");
});

test("D347: the browser's own console lines", () => {
  assert.deepEqual(
    logEntry({
      entry: {
        source: "network",
        level: "error",
        text: "Failed to load resource: 404",
        timestamp: 5,
        url: "https://app.test/x.js",
        lineNumber: 9,
      },
    }),
    {
      level: "error",
      text: "Failed to load resource: 404",
      time: 5,
      source: "https://app.test/x.js:10",
    },
  );
  assert.equal(logEntry({ entry: { source: "violation", level: "verbose", text: "x" } }), null);
  assert.equal(logEntry({ entry: { source: "console-api", level: "error", text: "x" } }), null);
  assert.equal(
    logEntry({ entry: { source: "security", level: "warning", text: "Mixed" } })?.level,
    "warn",
  );
  assert.equal(logEntry(null), null);
});

test("D347: matched and computed styles in the shape of the built-in tab's", () => {
  const sheets = new Map([["s1", "https://app.test/site.css"]]);
  assert.deepEqual(sheetSource({ header: { styleSheetId: "s2", sourceURL: "", isInline: true } }), [
    "s2",
    "<style>",
  ]);
  assert.deepEqual(
    sheetSource({ header: { styleSheetId: "s1", sourceURL: "https://app.test/site.css" } }),
    ["s1", "https://app.test/site.css"],
  );
  const matched = {
    inlineStyle: { cssProperties: [{ name: "color", value: "red", important: false }] },
    matchedCSSRules: [
      {
        rule: {
          origin: "user-agent",
          selectorList: { text: "button" },
          style: { cssProperties: [] },
        },
      },
      {
        rule: {
          origin: "regular",
          styleSheetId: "s1",
          selectorList: { text: ".btn" },
          style: {
            range: { startLine: 11 },
            cssProperties: [
              { name: "margin", value: "4px !important", important: true },
              { name: "margin-top", value: "4px", implicit: true },
              { name: "colr", value: "x", parsedOk: false },
              { name: "padding", value: "2px", disabled: true },
            ],
          },
        },
      },
      {
        rule: {
          origin: "regular",
          styleSheetId: "s9",
          selectorList: { text: "#go" },
          style: { cssProperties: [{ name: "display", value: "flex" }] },
        },
      },
    ],
  };
  const computed = [
    { name: "display", value: "flex" },
    { name: "position", value: "relative" },
    { name: "margin-top", value: "4px" },
    { name: "border-left-width", value: "1px" },
  ];
  const r = stylesResult(
    matched,
    computed,
    sheets,
    boxSize({ model: { width: 80.123, height: 30 } }),
  );
  assert.deepEqual(r.inline, [["color", "red", false, true]]);
  assert.deepEqual(r.rules, [
    { selector: "#go", source: "<style>", props: [["display", "flex", false, true]] },
    {
      selector: ".btn",
      source: "https://app.test/site.css:12",
      props: [
        ["margin", "4px", true, true],
        ["padding", "2px", false, false],
      ],
    },
  ]);
  assert.deepEqual(r.box, {
    width: 80.12,
    height: 30,
    margin: ["4px", "0px", "0px", "0px"],
    border: ["0px", "0px", "0px", "1px"],
    padding: ["0px", "0px", "0px", "0px"],
    position: "relative",
    display: "flex",
  });
  assert.equal(r.computed.length, 4);
  assert.deepEqual(declarations(null), []);
  assert.equal(boxSize({}), null);
});

test("D347: storage and cookies (HttpOnly ones too) in the built-in tab's shape", () => {
  const r = storageResult(
    "https://app.test",
    { entries: [["theme", "dark"], ["empty"], [7, "not a key"]] },
    { entries: [] },
    {
      cookies: [
        {
          name: "sid",
          value: "abc",
          domain: "app.test",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
        { name: "seen", value: "1", domain: ".app.test", path: "/", expires: 1893456000 },
      ],
    },
  );
  assert.deepEqual(r.local, [
    ["theme", "dark"],
    ["empty", ""],
  ]);
  assert.deepEqual(r.session, []);
  assert.deepEqual(r.cookies, [
    ["sid", "abc"],
    ["seen", "1"],
  ]);
  assert.deepEqual(r.cookieAttributes[0], {
    name: "sid",
    domain: "app.test",
    path: "/",
    expires: "session",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  });
  assert.equal(r.cookieAttributes[1]?.expires, "2030-01-01T00:00:00.000Z");
});

test("D347: emulation and the element expression", () => {
  assert.deepEqual(deviceMetrics({ width: 375, height: 812 }), {
    method: "Emulation.setDeviceMetricsOverride",
    params: { width: 375, height: 812, deviceScaleFactor: 0, mobile: true },
  });
  assert.equal(deviceMetrics({ width: 1440, height: 900 }).params.mobile, false);
  assert.equal(
    deviceMetrics({ width: null, height: null }).method,
    "Emulation.clearDeviceMetricsOverride",
  );
  assert.deepEqual(colorSchemeMedia("dark"), {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  assert.deepEqual(colorSchemeMedia(null), {
    features: [{ name: "prefers-color-scheme", value: "" }],
  });
  assert.equal(
    findExpression({ ref: "e3", selector: undefined }),
    'window.__ideBridge.internal.find({"ref":"e3"})',
  );
  assert.equal(
    findExpression({ selector: 'a[href="x"]' }),
    'window.__ideBridge.internal.find({"selector":"a[href=\\"x\\"]"})',
  );
});
