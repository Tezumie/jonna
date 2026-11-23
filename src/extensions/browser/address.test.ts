import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addressFiles,
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

test("the files an address may show (what a caller may see is checked on these)", () => {
  assert.deepEqual(addressFiles(".env", root), ["/work/app/.env"]);
  assert.deepEqual(
    addressFiles("config/.env?x=1#top", root).includes("/work/app/config/.env"),
    true,
  );
  assert.deepEqual(addressFiles("/work/app/keys/id_rsa", root), ["/work/app/keys/id_rsa"]);
  assert.equal(addressFiles("file:///work/app/.env", root).includes("/work/app/.env"), true);
  assert.equal(
    addressFiles("file:///C:/work/app/.env", "C:\\work\\app").includes("C:/work/app/.env"),
    true,
  );
  // A page on this machine: static previews and dev servers serve the folder at its paths.
  assert.deepEqual(addressFiles("http://127.0.0.1:4173/sub/.env?raw", root), [
    "/work/app/sub/.env",
  ]);
  assert.deepEqual(addressFiles("localhost:5173/%2Eenv", root), ["/work/app/.env"]);
  assert.deepEqual(addressFiles("http://localhost:5173/", root), []);
  assert.deepEqual(addressFiles("http://localhost:5173/../../etc/passwd", root), [
    "/work/app/etc/passwd",
  ]);
  // The web names no workspace file; nothing open, nothing to check.
  assert.deepEqual(addressFiles("https://example.com/.env", root), []);
  assert.deepEqual(addressFiles("example.com/.env", root), []);
  assert.deepEqual(addressFiles(".env", null), []);
  const folders = [
    { path: "/work/app", name: "app" },
    { path: "/work/api", name: "api" },
  ];
  assert.deepEqual(addressFiles("api/.env", folders), ["/work/api/.env"]);
  assert.deepEqual(addressFiles("http://localhost:3000/.env", folders), [
    "/work/app/.env",
    "/work/api/.env",
  ]);
});
