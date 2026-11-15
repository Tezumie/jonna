import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityLine,
  countOf,
  formatSize,
  platformLabel,
  storageShare,
  storageText,
} from "./model";

test("sync: sizes and storage (D435)", () => {
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(640), "640 B");
  assert.equal(formatSize(1536), "1.5 KB");
  assert.equal(formatSize(12 * 1024), "12 KB");
  assert.equal(formatSize(1024 ** 3), "1 GB");
  assert.equal(storageText(1.2 * 1024 ** 3, 50 * 1024 ** 3), "1.2 GB of 50 GB");
  assert.equal(storageText(2048, 0), "2 KB");
  assert.equal(storageShare(5, 10), 0.5);
  assert.equal(storageShare(50, 10), 1);
  assert.equal(storageShare(5, 0), 0);
});

test("sync: the status line", () => {
  assert.deepEqual(activityLine({ state: "idle", message: null, at: 5 }), {
    text: "Synced",
    time: 5,
  });
  assert.equal(activityLine({ state: "idle", message: null, at: null }).time, null);
  assert.equal(activityLine({ state: "syncing", message: null, at: 5 }).text, "Syncing…");
  assert.equal(activityLine({ state: "offline", message: "x", at: 5 }).text, "Offline: will retry");
  assert.equal(
    activityLine({ state: "error", message: "Storage is full.", at: 5 }).text,
    "Storage is full.",
  );
  assert.equal(
    activityLine({ state: "other", message: null, at: 5 }).text,
    "Another window is syncing",
  );
});

test("sync: small words", () => {
  assert.equal(platformLabel("windows"), "Windows");
  assert.equal(platformLabel("darwin"), "macOS");
  assert.equal(platformLabel("haiku"), "haiku");
  assert.equal(countOf(1, "file"), "1 file");
  assert.equal(countOf(3, "file"), "3 files");
});
