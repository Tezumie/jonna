import assert from "node:assert/strict";
import { test } from "node:test";
import { isBrowserType, pageScriptPath, pageUrlRegex, pickPageTarget } from "./browser";

const unix = { webRoot: "/w/app", pathMapping: {}, windows: false, caseInsensitive: false };
const win = {
  webRoot: "C:\\w\\app",
  pathMapping: { "/static/": "C:\\w\\app\\public" },
  windows: true,
  caseInsensitive: true,
};

test("page scripts map to the project's files", () => {
  assert.ok(isBrowserType("pwa-chrome") && isBrowserType("msedge") && !isBrowserType("node"));
  assert.equal(
    pageScriptPath("http://localhost:5173/src/main.ts?t=12", unix),
    "/w/app/src/main.ts",
  );
  assert.equal(pageScriptPath("http://localhost:5173/@fs/w/lib/a.js", unix), "/w/lib/a.js");
  assert.equal(pageScriptPath("webpack://app/./src/index.js", unix), "/w/app/src/index.js");
  assert.equal(pageScriptPath("webpack://app/node_modules/x/y.js", unix), null);
  assert.equal(pageScriptPath("chrome-extension://abc/x.js", unix), null);
  assert.equal(
    pageScriptPath("http://127.0.0.1:8080/static/a%20b.js", win),
    "C:\\w\\app\\public\\a b.js",
  );
  assert.equal(pageScriptPath("http://127.0.0.1:8080/js/app.js", win), "C:\\w\\app\\js\\app.js");
});

test("breakpoint URL regexes match the scripts serving a file", () => {
  const re = new RegExp(pageUrlRegex("/w/app/src/main.ts", unix));
  assert.ok(re.test("http://localhost:5173/src/main.ts"));
  assert.ok(re.test("http://localhost:5173/src/main.ts?t=1700"));
  assert.ok(!re.test("http://localhost:5173/src/main.tsx"));
  const w = new RegExp(pageUrlRegex("C:\\w\\app\\public\\a b.js", win));
  assert.ok(w.test("http://127.0.0.1:8080/static/a%20b.js"));
  assert.ok(w.test("http://127.0.0.1:8080/PUBLIC/a%20b.js"));
});

test("the page target to attach to", () => {
  const targets = [
    { type: "service_worker", url: "http://x/sw.js", webSocketDebuggerUrl: "ws://sw" },
    { type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://blank" },
    { type: "page", url: "http://localhost:3000/app", webSocketDebuggerUrl: "ws://app" },
  ];
  assert.equal(pickPageTarget(targets, "http://localhost:3000"), "ws://app");
  assert.equal(pickPageTarget(targets), "ws://blank");
  assert.equal(pickPageTarget([], "x"), null);
});

test("Windows /@fs/ paths, brackets and bad escapes", () => {
  const w = { webRoot: "C:\\w\\app", pathMapping: {}, windows: true, caseInsensitive: true };
  assert.ok(
    new RegExp(pageUrlRegex("C:\\lib\\a.js", w)).test("http://localhost:5173/@fs/C:/lib/a.js"),
  );
  assert.ok(
    new RegExp(pageUrlRegex("/w/app/pages/[slug].js", unix)).test("http://h/pages/[slug].js"),
  );
  assert.equal(pageScriptPath("http://h/a%zz.js", unix), "/w/app/a%zz.js");
});
