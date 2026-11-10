import assert from "node:assert/strict";
import { test } from "node:test";
import { folderChoice } from "./folderChoice";

const api = { path: "/work/api", name: "api", index: 0 };
const web = { path: "/work/web", name: "web-app", index: 1 };

test("one folder is the folder; none is none", () => {
  assert.deepEqual(folderChoice([api], undefined, null), { kind: "folder", folder: api });
  assert.deepEqual(folderChoice([], undefined, "/x"), { kind: "none" });
});

test("several folders: the given one (path or name), the active file's, else ask", () => {
  assert.deepEqual(folderChoice([api, web], "web-app", null), { kind: "folder", folder: web });
  assert.deepEqual(folderChoice([api, web], "/work/web", null), { kind: "folder", folder: web });
  assert.deepEqual(folderChoice([api, web], "nope", null), { kind: "unknown", wanted: "nope" });
  assert.deepEqual(folderChoice([api, web], undefined, "/work/web/src/a.ts"), {
    kind: "folder",
    folder: web,
  });
  assert.deepEqual(folderChoice([api, web], undefined, "/elsewhere/a.ts"), { kind: "ask" });
  assert.deepEqual(folderChoice([api, web], undefined, null), { kind: "ask" });
});
