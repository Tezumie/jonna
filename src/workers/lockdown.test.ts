import assert from "node:assert/strict";
import { test } from "node:test";
import { lockdown } from "./lockdown";

/** A worker scope as the browser builds one: the APIs are on prototypes, some as getters. */
function fakeScope() {
  const navigatorProto = {};
  for (const name of [
    "storage",
    "serviceWorker",
    "storageBuckets",
    "locks",
    "usb",
    "serial",
    "hid",
  ])
    Object.defineProperty(navigatorProto, name, { get: () => ({ name }), configurable: true });
  Object.defineProperty(navigatorProto, "userAgent", { get: () => "test", configurable: true });
  const workerProto: Record<string, unknown> = {
    fetch: () => {},
    importScripts: () => {},
    Notification: class {},
    webkitRequestFileSystem: () => {},
    setTimeout: () => {},
  };
  Object.defineProperty(workerProto, "caches", { get: () => ({}), configurable: true });
  Object.defineProperty(workerProto, "indexedDB", { get: () => ({}), configurable: true });
  const root = Object.create(workerProto) as Record<string, unknown>;
  root.WebSocket = class {};
  root.BroadcastChannel = class {};
  root.navigator = Object.create(navigatorProto);
  return root;
}

test("lockdown: the network, storage and what workers share are gone", () => {
  const root = fakeScope();
  lockdown(root);
  for (const name of [
    "fetch",
    "importScripts",
    "caches",
    "indexedDB",
    "WebSocket",
    "BroadcastChannel",
    "Notification",
    "webkitRequestFileSystem",
  ])
    assert.equal(root[name], undefined, name);
  const navigator = root.navigator as Record<string, unknown>;
  for (const name of [
    "storage",
    "serviceWorker",
    "storageBuckets",
    "locks",
    "usb",
    "serial",
    "hid",
  ])
    assert.equal(navigator[name], undefined, `navigator.${name}`);
  // What code needs stays.
  assert.equal(typeof root.setTimeout, "function");
  assert.equal(navigator.userAgent, "test");
});

test("lockdown: what it removed can't be put back", () => {
  const root = fakeScope();
  lockdown(root);
  const proto = Object.getPrototypeOf(root) as object;
  assert.throws(() => Object.defineProperty(proto, "fetch", { value: () => {} }));
  const navigatorProto = Object.getPrototypeOf(root.navigator) as object;
  assert.throws(() => Object.defineProperty(navigatorProto, "storageBuckets", { value: {} }));
  // Shadowing on the object itself gives nothing either: the prototype's is not writable.
  assert.throws(() => {
    (root as { fetch?: unknown }).fetch = () => {};
  });
});
