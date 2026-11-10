import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyDownload,
  type Download,
  describe,
  formatSize,
  fraction,
  statusText,
  summary,
} from "./downloadsModel";

const base: Download = {
  id: 1,
  url: "http://127.0.0.1:5/report.pdf",
  fileName: "report.pdf",
  path: null,
  received: 0,
  total: null,
  state: "progress",
  error: null,
  startedMs: 0,
  canCancel: true,
  webview: "main",
};

test("reports replace by id, newest first", () => {
  let list = applyDownload([], base);
  list = applyDownload(list, { ...base, id: 2, fileName: "b.zip" });
  list = applyDownload(list, { ...base, received: 10 });
  assert.deepEqual(
    list.map((d) => [d.id, d.received]),
    [
      [2, 0],
      [1, 10],
    ],
  );
});

test("progress words and fractions", () => {
  assert.equal(describe(base), "Starting");
  assert.equal(fraction(base), null);
  const half = { ...base, received: 512 * 1024, total: 1024 * 1024 };
  assert.equal(describe(half), "512 kB of 1.0 MB");
  assert.equal(fraction(half), 0.5);
  assert.equal(describe({ ...half, state: "done", received: 1024 * 1024 }), "Done, 1.0 MB");
  assert.equal(describe({ ...base, state: "failed", error: "network" }), "Failed: network");
  assert.equal(describe({ ...base, state: "cancelled" }), "Cancelled");
  assert.equal(formatSize(3 * 1024 * 1024 * 1024), "3.00 GB");
});

test("the status bar shows running downloads, else just the icon", () => {
  assert.equal(statusText([]), null);
  const a = { ...base, received: 25, total: 100 };
  const b = { ...base, id: 2, fileName: "b.zip", received: 25, total: 100 };
  assert.equal(statusText([a])?.text, "$(download) 25%");
  assert.equal(statusText([a, b])?.text, "$(download) 2 25%");
  assert.equal(statusText([a, { ...b, total: null }])?.text, "$(download) 2");
  assert.equal(statusText([{ ...a, state: "done" }])?.text, "$(download)");
});

test("agents see a summary", () => {
  assert.deepEqual(summary({ ...base, state: "done", path: "/d/report.pdf", received: 3 }), {
    id: 1,
    file: "report.pdf",
    url: base.url,
    state: "done",
    progress: "Done, 3 B",
    path: "/d/report.pdf",
    canCancel: false,
  });
});
