import assert from "node:assert/strict";
import { test } from "node:test";
import { hostLinkHash, isLoopbackHost, parseHostLink, socketUrl } from "./address";

test("web: a host link's fragment round-trips, and half a link is half", () => {
  const link = { address: "127.0.0.1:4000", token: "a b+c/=" };
  assert.deepEqual(parseHostLink(hostLinkHash(link)), link);
  assert.deepEqual(parseHostLink("#h=localhost:1"), { address: "localhost:1" });
  assert.deepEqual(parseHostLink(""), {});
});

test("web: this computer is reached plainly, any other host only encrypted", () => {
  const url = (typed: string) => {
    const made = socketUrl(typed);
    return "url" in made ? made.url : `error: ${made.error}`;
  };
  assert.equal(url("127.0.0.1:4000"), "ws://127.0.0.1:4000/");
  assert.equal(url(" localhost:4000 "), "ws://localhost:4000/");
  assert.equal(url("ws://[::1]:9/"), "ws://[::1]:9/");
  assert.equal(url("dev.example.com"), "wss://dev.example.com/");
  assert.equal(url("https://dev.example.com/host"), "wss://dev.example.com/host");
  assert.equal(url("wss://dev.example.com:8443/x#frag"), "wss://dev.example.com:8443/x");
  assert.match(url("ws://dev.example.com"), /^error: .*wss/);
  assert.match(url("ws://user:pw@127.0.0.1:1"), /^error/);
  assert.match(url("ftp://127.0.0.1"), /^error/);
  assert.match(url(""), /^error/);
  assert.ok(isLoopbackHost("127.0.0.1") && isLoopbackHost("LOCALHOST") && isLoopbackHost("[::1]"));
  assert.ok(!isLoopbackHost("127.0.0.1.example.com") && !isLoopbackHost("10.0.0.1"));
});
