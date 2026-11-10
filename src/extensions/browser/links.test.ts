import assert from "node:assert/strict";
import { test } from "node:test";
import { ProxyMap, parseRequest, proxies, relayOrigin, routeOpen, targetAllows } from "./links";

test("open requests: http(s) only, known fields only", () => {
  assert.deepEqual(
    parseRequest({ type: "open", url: "http://127.0.0.1:8787/account", disposition: "self" }),
    { type: "open", url: "http://127.0.0.1:8787/account", disposition: "self", replace: false },
  );
  assert.equal(parseRequest({ type: "open", url: "javascript:alert(1)" }), null);
  assert.equal(parseRequest({ type: "open", url: "file:///etc/passwd" }), null);
  assert.equal(parseRequest({ type: "open", url: 42 }), null);
  const tab = parseRequest({
    type: "open",
    url: "https://example.com/",
    disposition: "tab",
    popup: "p1x",
    form: { entries: [["a", "b"]] },
    name: "results",
  });
  // A new tab carries the form posted into it, its name and the popup id.
  assert.deepEqual(tab, {
    type: "open",
    url: "https://example.com/",
    disposition: "tab",
    replace: false,
    popup: "p1x",
    name: "results",
    form: { method: "post", enctype: "application/x-www-form-urlencoded", entries: [["a", "b"]] },
  });
  // Reserved names pick no tab; a name only goes with a new tab.
  const blank = parseRequest({
    type: "open",
    url: "https://e.com/",
    disposition: "tab",
    name: "_blank",
  });
  assert.equal(blank && "name" in blank, false);
  const self = parseRequest({ type: "open", url: "https://e.com/", name: "x" });
  assert.equal(self && "name" in self, false);
  // A popup navigates its opener: http(s) only.
  assert.deepEqual(parseRequest({ type: "openerNavigate", url: "https://e.com/next" }), {
    type: "openerNavigate",
    url: "https://e.com/next",
    replace: false,
  });
  assert.equal(parseRequest({ type: "openerNavigate", url: "javascript:x" }), null);
  const post = parseRequest({
    type: "open",
    url: "http://localhost:8787/login",
    replace: true,
    form: { enctype: "TEXT/PLAIN", entries: [["name", "Ada"], [3, "x"], "junk"] },
  });
  assert.deepEqual(post, {
    type: "open",
    url: "http://localhost:8787/login",
    disposition: "self",
    replace: true,
    form: { method: "post", enctype: "text/plain", entries: [["name", "Ada"]] },
  });
  assert.equal(
    parseRequest({ type: "open", url: "http://x.test/", popup: "../bad id" })?.type,
    "open",
  );
  assert.equal(
    "popup" in (parseRequest({ type: "open", url: "http://x.test/", popup: "bad id!" }) ?? {}),
    false,
  );
});

test("popup relay messages", () => {
  assert.deepEqual(parseRequest({ type: "toOpener", data: { token: 1 } }), {
    type: "toOpener",
    data: { token: 1 },
    targetOrigin: "/",
  });
  assert.deepEqual(parseRequest({ type: "closePopup", id: "p2" }), {
    type: "closePopup",
    id: "p2",
  });
  assert.equal(parseRequest({ type: "toPopup", id: "<x>", data: 1 }), null);
  assert.equal(parseRequest({ type: "popupNavigate", id: "p2", url: "data:text/html,x" }), null);
  assert.equal(parseRequest({ type: "nav" }), null);
});

test("proxy URLs map back to the server they serve", () => {
  const map = new ProxyMap();
  map.remember("http://127.0.0.1:40001", "http://localhost:5173");
  map.remember("http://127.0.0.1:40002", "/work/app");
  assert.equal(map.realUrl("http://127.0.0.1:40001/a?b#c"), "http://localhost:5173/a?b#c");
  assert.equal(map.realUrl("http://127.0.0.1:40002/x.html"), "http://127.0.0.1:40002/x.html");
  assert.equal(map.upstream("http://127.0.0.1:40002"), null);
  assert.equal(map.has("http://127.0.0.1:40002"), true);
  assert.equal(map.has("http://127.0.0.1:9"), false);
  assert.equal(map.realUrl("not a url"), "not a url");
});

test("routes: local servers stay in the IDE, other sites follow the setting", () => {
  assert.deepEqual(
    routeOpen({ url: "http://127.0.0.1:8787/account", disposition: "self" }, null, "system"),
    {
      kind: "here",
      address: { kind: "local", url: "http://127.0.0.1:8787/account" },
    },
  );
  assert.deepEqual(routeOpen({ url: "http://localhost:3000/", disposition: "tab" }, null, "ide"), {
    kind: "tab",
    address: { kind: "local", url: "http://localhost:3000/" },
  });
  assert.deepEqual(routeOpen({ url: "https://example.com/", disposition: "tab" }, null, "system"), {
    kind: "system",
    url: "https://example.com/",
  });
  assert.deepEqual(routeOpen({ url: "https://example.com/", disposition: "self" }, null, "ide"), {
    kind: "here",
    address: { kind: "external", url: "https://example.com/" },
  });
  // A same-server new tab arrives as the proxy's URL.
  proxies.remember("http://127.0.0.1:40003", "http://localhost:5173");
  assert.deepEqual(
    routeOpen({ url: "http://127.0.0.1:40003/about", disposition: "tab" }, null, "ide"),
    {
      kind: "tab",
      address: { kind: "local", url: "http://localhost:5173/about" },
    },
  );
});

test("relayed origins and postMessage targets", () => {
  const px = "http://127.0.0.1:40001";
  // Same dev server: both pages see the proxy origin as their own.
  assert.equal(relayOrigin(px, "http://localhost:5173", px), px);
  // Another server: its real origin (what the app configured).
  assert.equal(
    relayOrigin("http://127.0.0.1:40009", "http://127.0.0.1:8787", px),
    "http://127.0.0.1:8787",
  );
  assert.equal(
    relayOrigin(null, "https://accounts.example.com", px),
    "https://accounts.example.com",
  );
  assert.equal(targetAllows("*", [null]), true);
  assert.equal(targetAllows("http://localhost:5173/path", ["http://localhost:5173", px]), true);
  assert.equal(targetAllows(px, ["http://localhost:5173", px]), true);
  assert.equal(targetAllows("https://evil.example", ["http://localhost:5173", px]), false);
  assert.equal(targetAllows("/", ["http://localhost:5173"]), false);
});
