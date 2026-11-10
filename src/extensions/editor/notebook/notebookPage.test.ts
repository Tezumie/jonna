// D295: a controller's output page's layout: the visible part of each slot, the frame's clip
// path, the places that changed, and outputs as renderers' items.
import assert from "node:assert/strict";
import { test } from "node:test";
import { notebookWebviewUri } from "../../../core/extensions/vscode/notebooks";
import { Uri } from "../../../core/extensions/vscode/types";
import {
  changedPlaces,
  clipPathOf,
  outputItems,
  readHeights,
  resourcePathOf,
  resourceType,
  type SlotPlace,
  visibleRect,
} from "./notebookPageModel";

test("a controller's asWebviewUri is VS Code's, and the page reads it back to the file", () => {
  for (const path of ["C:\\Users\\me\\ext\\temp\\a b\\index.js", "/home/me/ext/index.js"]) {
    const address = notebookWebviewUri(Uri.file(path)).toString();
    assert.match(address, /^https:\/\/file%2B\.vscode-resource\.vscode-cdn\.net\//i);
    // VS Code lower-cases a drive letter; paths compare without case on Windows.
    assert.equal(resourcePathOf(address)?.toLowerCase(), path.toLowerCase());
  }
  // requirejs adds the extension and a query.
  assert.equal(
    resourcePathOf("https://file+.vscode-resource.vscode-cdn.net/c%3A/x/m.js?v=1"),
    "c:\\x\\m.js",
  );
  assert.equal(resourcePathOf("https://example.com/c%3A/x.js"), null);
  assert.equal(resourcePathOf("https://file%2B.vscode-resource.vscode-cdn.net/a/../b"), null);
  assert.equal(resourceType("x/index.JS"), "text/javascript");
  assert.equal(resourceType("x/a.woff2"), "font/woff2");
  assert.equal(resourceType("x/a.bin"), "application/octet-stream");
  // Not a file: given back as it is.
  const web = Uri.parse("https://example.com/a");
  assert.equal(notebookWebviewUri(web), web);
});

test("D295: a slot's visible part inside the areas that clip it", () => {
  const slot = { left: 10, top: 100, width: 200, height: 300 };
  assert.deepEqual(visibleRect(slot, []), slot);
  // A scrolling outputs area showing 150 px of it.
  assert.deepEqual(visibleRect(slot, [{ left: 0, top: 50, width: 500, height: 200 }]), {
    left: 10,
    top: 100,
    width: 200,
    height: 150,
  });
  // Collapsed away entirely.
  assert.equal(visibleRect(slot, [{ left: 0, top: 0, width: 500, height: 22 }]), null);
});

test("D295: the clip path is the slots' rectangles, nothing without any", () => {
  assert.equal(clipPathOf([]), "inset(0 100% 100% 0)");
  assert.equal(
    clipPathOf([
      { left: 0, top: 10, width: 100, height: 20.333 },
      { left: 5, top: 50, width: 0, height: 10 },
      { left: 5, top: 60, width: 10, height: 10 },
    ]),
    "path('M0 10h100v20.33h-100ZM5 60h10v10h-10Z')",
  );
});

test("D295: only the places that changed are sent", () => {
  const before = new Map<string, SlotPlace>([
    ["a", { id: "a", top: 0, left: 0, width: 100, visible: true }],
    ["b", { id: "b", top: 50, left: 0, width: 100, visible: true }],
  ]);
  const now: SlotPlace[] = [
    { id: "a", top: 0.2, left: 0, width: 100, visible: true },
    { id: "b", top: 80, left: 0, width: 100, visible: true },
    { id: "c", top: 0, left: 0, width: 0, visible: false },
  ];
  assert.deepEqual(
    changedPlaces(before, now).map((p) => p.id),
    ["b", "c"],
  );
});

test("D295: the page's heights are checked; outputs become renderers' items", () => {
  assert.deepEqual(
    readHeights([{ id: "o1", height: 40 }, { id: 3 }, { id: "o2", height: -5 }, null, "x"]),
    [
      { id: "o1", height: 40 },
      { id: "o2", height: 0 },
    ],
  );
  assert.deepEqual(readHeights("nope"), []);
  assert.deepEqual(
    outputItems(
      {
        "text/plain": ["IntSlider(", "value=3)"],
        "application/vnd.jupyter.widget-view+json": { model_id: "m1", version_major: 2 },
        "application/json": ["a", "b"],
      },
      { "application/vnd.jupyter.widget-view+json": { x: 1 } },
    ),
    [
      {
        mime: "text/plain",
        value: "IntSlider(value=3)",
        metadata: { "application/vnd.jupyter.widget-view+json": { x: 1 } },
      },
      {
        mime: "application/vnd.jupyter.widget-view+json",
        value: { model_id: "m1", version_major: 2 },
        metadata: { x: 1 },
      },
      {
        mime: "application/json",
        value: ["a", "b"],
        metadata: { "application/vnd.jupyter.widget-view+json": { x: 1 } },
      },
    ],
  );
});
