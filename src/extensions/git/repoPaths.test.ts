import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deepestRoot,
  foldersWithoutRepository,
  matchRepository,
  pickerOrder,
  repositoriesTouched,
  repositoryFolderName,
  shownRepositories,
  statusPollMs,
} from "./repoPaths";

test("changed files start a status read only in their repositories", () => {
  const roots = ["/w", "/w/libs/a", ""];
  assert.deepEqual(
    [...repositoriesTouched(roots, { paths: ["/w/libs/a/x.ts"], overflow: false })],
    [1],
  );
  assert.deepEqual(
    [
      ...repositoriesTouched(roots, { paths: ["/w/src/y.ts", "/w/libs/a/z"], overflow: false }),
    ].sort(),
    [0, 1],
  );
  assert.equal(repositoriesTouched(roots, { paths: ["/else/f"], overflow: false }).size, 0);
  // Too many to list: every repository (not the empty root of a closed one).
  assert.deepEqual([...repositoriesTouched(roots, { paths: [], overflow: true })], [0, 1]);
});

test("the status poll is slow while the folder is watched", () => {
  assert.equal(statusPollMs(false), 5000);
  assert.ok(statusPollMs(true) >= 30_000);
});

test("the repository picker lists the selected repository first", () => {
  assert.deepEqual(pickerOrder(["a", "b", "c"], "c"), ["c", "a", "b"]);
  assert.deepEqual(pickerOrder(["a", "b", "c"], "a"), ["a", "b", "c"]);
  assert.deepEqual(pickerOrder(["a", "b"], undefined), ["a", "b"]);
  assert.deepEqual(pickerOrder(["a", "b"], "z"), ["a", "b"]);
});

test("a path belongs to the deepest repository containing it", () => {
  const roots = ["/w", "/w/libs/a", "/w/libs/ab", ""];
  assert.equal(deepestRoot(roots, "/w/src/x.ts"), 0);
  assert.equal(deepestRoot(roots, "/w/libs/a/x.ts"), 1);
  assert.equal(deepestRoot(roots, "/w/libs/ab/x.ts"), 2);
  assert.equal(deepestRoot(roots, "/w/libs/a"), 1);
  assert.equal(deepestRoot(roots, "/elsewhere/x"), -1);
  assert.equal(deepestRoot(["C:\\w", "C:\\w\\sub"], "c:\\W\\Sub\\f.txt"), 1);
});

test("a repository input matches a root, a relative path or a folder name", () => {
  const repos = [
    { root: "/w", name: "w" },
    { root: "/w/libs/core", name: "core" },
  ];
  assert.equal(matchRepository(repos, "/w", "/w/libs/core"), 1);
  assert.equal(matchRepository(repos, "/w", "libs/core"), 1);
  assert.equal(matchRepository(repos, "/w", "core"), 1);
  assert.equal(matchRepository(repos, "/w", "."), 0);
  assert.equal(matchRepository(repos, "/w", "nope"), -1);
  assert.equal(matchRepository(repos, "/w", " "), -1);
  // The open folder is a subfolder of its repository: "." is that repository.
  assert.equal(matchRepository(repos, "/w/app", "."), 0);
});

test("in a multi-root workspace a folder's name means that folder's repository", () => {
  const folders = [
    { path: "/w", name: "web" },
    { path: "/x/api", name: "api" },
    { path: "/y/mono/tools", name: "tools" },
  ];
  // The lead's resolve: a leading folder name is that folder.
  const resolve = (p: string) => {
    const [head, ...rest] = p.split("/");
    const f = folders.find((x) => x.name === head);
    if (!f) return `/w/${p}`;
    return rest.length ? `${f.path}/${rest.join("/")}` : f.path;
  };
  const repos = [
    { root: "/w", name: "w" },
    { root: "/x/api", name: "api" },
    { root: "/y/mono", name: "mono" },
    { root: "/x/api/vendor/lib", name: "lib" },
  ];
  const ws = { folders, resolve };
  assert.equal(matchRepository(repos, "/w", "api", ws), 1);
  assert.equal(matchRepository(repos, "/w", "web", ws), 0);
  // The folder is inside a bigger repository: that one.
  assert.equal(matchRepository(repos, "/w", "tools", ws), 2);
  // A folder-prefixed relative path.
  assert.equal(matchRepository(repos, "/w", "api/vendor/lib", ws), 3);
  assert.equal(matchRepository(repos, "/w", ".", ws), 0);
  assert.equal(matchRepository(repos, "/w", "mono", ws), 2);
  // One folder: matched as before (no folder-name step).
  assert.equal(
    matchRepository(repos, "/w", "web", {
      folders: [{ path: "/w", name: "web" }],
      resolve: (p) => `/w/${p}`,
    }),
    -1,
  );
});

test("a folder's repository is named by the folder in a multi-root workspace", () => {
  const folders = [
    { path: "/w", name: "web" },
    { path: "/y/mono/tools", name: "tools" },
  ];
  assert.equal(repositoryFolderName(folders, "/w"), "web");
  assert.equal(repositoryFolderName(folders, "/y/mono"), "tools");
  assert.equal(repositoryFolderName(folders, "/w/libs/core"), undefined);
  assert.equal(repositoryFolderName([{ path: "/w", name: "web" }], "/w"), undefined);
});

test("initialize offers the folders no repository holds", () => {
  const folders = [
    { path: "/w", name: "web" },
    { path: "/x/api", name: "api" },
    { path: "/y/mono/tools", name: "tools" },
  ];
  assert.deepEqual(
    foldersWithoutRepository(folders, ["/w", "/y/mono", ""]).map((f) => f.name),
    ["api"],
  );
  assert.equal(foldersWithoutRepository(folders, []).length, 3);
});

test("multiple mode shows the repositories not hidden, never none", () => {
  const key = (r: string) => r;
  assert.deepEqual(shownRepositories([".", "a", "b"], new Set(["a"]), key, "."), [".", "b"]);
  assert.deepEqual(shownRepositories([".", "a"], new Set(), key, "a"), [".", "a"]);
  // All hidden: the selected one stays, else the first.
  assert.deepEqual(shownRepositories([".", "a"], new Set([".", "a"]), key, "a"), ["a"]);
  assert.deepEqual(shownRepositories([".", "a"], new Set([".", "a"]), key, undefined), ["."]);
  assert.deepEqual(shownRepositories([], new Set(["a"]), key, undefined), []);
});
