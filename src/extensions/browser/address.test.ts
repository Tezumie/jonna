import assert from "node:assert/strict";
import { test } from "node:test";
import {
  displayAddress,
  fileUrl,
  isLocalUrl,
  parseAddress,
  pathFromUrl,
  rootFor,
  rootsOf,
} from "./address";

const root = "/work/app";

test("addresses", () => {
  assert.deepEqual(parseAddress("localhost:5173", root), {
    kind: "local",
    url: "http://localhost:5173",
  });
  assert.deepEqual(parseAddress(":3000/x", root), {
    kind: "local",
    url: "http://localhost:3000/x",
  });
  assert.deepEqual(parseAddress("http://127.0.0.1:8080/a", root), {
    kind: "local",
    url: "http://127.0.0.1:8080/a",
  });
  assert.deepEqual(parseAddress("https://localhost:5173", root), {
    kind: "external",
    url: "https://localhost:5173",
  });
  assert.deepEqual(parseAddress("example.com/docs", root), {
    kind: "external",
    url: "https://example.com/docs",
  });
  assert.deepEqual(parseAddress("index.html", root), {
    kind: "file",
    path: "/work/app/index.html",
  });
  assert.deepEqual(parseAddress("site/", root), { kind: "file", path: "/work/app/site" });
  assert.deepEqual(parseAddress("/work/app/x/page.htm", root), {
    kind: "file",
    path: "/work/app/x/page.htm",
  });
  assert.equal(parseAddress("", root), null);
  // A *.localhost dev server typed without http:// is local too (the proxy serves it).
  assert.deepEqual(parseAddress("app.localhost:3000", root), {
    kind: "local",
    url: "http://app.localhost:3000",
  });
  assert.equal(isLocalUrl("http://app.localhost:1/"), true);
  assert.equal(isLocalUrl("http://example.com"), false);
});

test("file urls round-trip", () => {
  const url = fileUrl("http://127.0.0.1:9", root, "/work/app/my site/index.html");
  assert.equal(url, "http://127.0.0.1:9/my%20site/index.html");
  assert.equal(
    pathFromUrl("http://127.0.0.1:9", root, `${url}?q=1#top`),
    "/work/app/my site/index.html",
  );
  assert.equal(pathFromUrl("http://127.0.0.1:9", root, "http://other/x"), null);
  assert.equal(displayAddress({ kind: "file", path: "/work/app/a/b.html" }, root), "a/b.html");
});

test("multi-root addresses name the folder first (D251)", () => {
  const folders = [
    { path: "/work/app", name: "app" },
    { path: "/work/api", name: "api" },
  ];
  // A folder's name first; a plain relative path is the first folder's.
  assert.deepEqual(parseAddress("api/index.html", folders), {
    kind: "file",
    path: "/work/api/index.html",
  });
  assert.deepEqual(parseAddress("index.html", folders), {
    kind: "file",
    path: "/work/app/index.html",
  });
  assert.deepEqual(parseAddress("/work/api/x.html", folders), {
    kind: "file",
    path: "/work/api/x.html",
  });
  // Outside every folder: not a workspace file.
  assert.equal(parseAddress("/elsewhere/x.html", folders), null);
  assert.equal(displayAddress({ kind: "file", path: "/work/api/x.html" }, folders), "api/x.html");
  assert.equal(displayAddress({ kind: "file", path: "/work/api" }, folders), "api/");
  // Shown and read back.
  assert.deepEqual(
    parseAddress(displayAddress({ kind: "file", path: "/work/api/a/b.html" }, folders), folders),
    {
      kind: "file",
      path: "/work/api/a/b.html",
    },
  );
  assert.equal(rootFor(folders, "/work/api/x.html"), "/work/api");
  assert.equal(rootFor(folders, "/elsewhere/x.html"), "/work/app");
  assert.equal(rootFor(null, "/x"), null);
  // One folder: its root, exactly as before.
  const one = {
    root: { peek: () => "/work/app" },
    folders: { peek: () => [folders[0] ?? { path: "", name: "" }] },
  };
  assert.equal(rootsOf(one), "/work/app");
  assert.equal(displayAddress({ kind: "file", path: "/work/app/x.html" }, rootsOf(one)), "x.html");
  const two = { root: { peek: () => "/work/app" }, folders: { peek: () => folders } };
  assert.equal(rootsOf(two), folders);
});
