import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentIgnore, DEFAULT_AGENT_IGNORE } from "./ignore";
import {
  FolderIgnores,
  foldersOrPrimary,
  inputPathsIn,
  pathReadings,
  relativeInFolders,
  resolveInFolders,
  sandboxPath,
} from "./workspaceFolders";

const one = [{ path: "C:\\work\\app", name: "app" }];
const two = [
  { path: "C:\\work\\app", name: "app" },
  { path: "D:\\libs\\api", name: "api" },
];
const posix = [
  { path: "/home/me/web", name: "web" },
  { path: "/srv/shared", name: "shared" },
];

test("one folder: the sandbox is the folder, as before", () => {
  assert.equal(sandboxPath(one, "src/main.ts"), "C:\\work\\app\\src\\main.ts");
  assert.equal(sandboxPath(one, "C:/work/app/src/x.ts"), "C:\\work\\app\\src\\x.ts");
  assert.equal(sandboxPath(one, "c:\\WORK\\app\\a"), "C:\\work\\app\\a");
  assert.equal(sandboxPath(one, "."), "C:\\work\\app");
  assert.equal(sandboxPath(one, "../other/x"), null);
  assert.equal(sandboxPath(one, "C:\\work\\app\\..\\other"), null);
  assert.equal(sandboxPath(one, "D:\\libs\\api\\x.ts"), null);
  // A folder that only shares a prefix isn't inside.
  assert.equal(sandboxPath(one, "C:\\work\\app2\\x"), null);
  assert.equal(sandboxPath([], "x"), null);
});

test("several folders: every folder is reachable, nothing else", () => {
  // Relative: the first folder, or the folder whose name leads.
  assert.equal(sandboxPath(two, "src/a.ts"), "C:\\work\\app\\src\\a.ts");
  assert.equal(sandboxPath(two, "api/src/b.ts"), "D:\\libs\\api\\src\\b.ts");
  assert.equal(sandboxPath(two, "api"), "D:\\libs\\api");
  assert.equal(sandboxPath(two, "./api/x"), "D:\\libs\\api\\x");
  // Absolute in the second folder, any case.
  assert.equal(sandboxPath(two, "d:/LIBS/api/x.ts"), "D:\\libs\\api\\x.ts");
  // Out of a folder with "..", by name or absolute: refused.
  assert.equal(sandboxPath(two, "api/../../etc"), null);
  assert.equal(sandboxPath(two, "api/../secret"), null);
  assert.equal(sandboxPath(two, "D:\\libs\\api\\..\\other\\x"), null);
  assert.equal(sandboxPath(two, "D:\\libs"), null);
  assert.equal(sandboxPath(two, "E:\\x"), null);
  // POSIX.
  assert.equal(sandboxPath(posix, "shared/a/b"), "/srv/shared/a/b");
  assert.equal(sandboxPath(posix, "/srv/shared/x"), "/srv/shared/x");
  assert.equal(sandboxPath(posix, "/srv/sharedX/x"), null);
  assert.equal(sandboxPath(posix, "/etc/passwd"), null);
  assert.equal(sandboxPath(posix, "shared/../../../etc/passwd"), null);
});

test("resolve and relative read each other back", () => {
  for (const abs of ["C:\\work\\app\\src\\a.ts", "D:\\libs\\api\\b\\c.ts", "D:\\libs\\api"])
    assert.equal(resolveInFolders(two, relativeInFolders(two, abs)), abs);
  assert.equal(relativeInFolders(two, "D:\\libs\\api\\b.ts"), "api/b.ts");
  assert.equal(relativeInFolders(one, "C:\\work\\app\\b.ts"), "b.ts");
  assert.equal(relativeInFolders(two, "E:\\x"), "E:\\x");
});

test("foldersOrPrimary falls back to the first folder alone", () => {
  assert.deepEqual(foldersOrPrimary([], "/a/b"), [{ path: "/a/b", name: "b" }]);
  assert.deepEqual(foldersOrPrimary([], null), []);
  assert.equal(foldersOrPrimary(two, "C:\\work\\app"), two);
});

test("input paths: inside a folder as is, a folder's name picks it, else the first folder", () => {
  assert.deepEqual(inputPathsIn(one, { path: "src/x", paths: ["C:\\work\\app\\y"] }), [
    "C:\\work\\app\\src/x",
    "C:\\work\\app\\y",
  ]);
  assert.deepEqual(inputPathsIn(two, { path: "api/.env", file: "D:\\libs\\api\\k.pem" }), [
    "D:\\libs\\api\\.env",
    "D:\\libs\\api\\k.pem",
  ]);
  assert.deepEqual(inputPathsIn([], { path: "x" }), []);
});

test("path readings: workspace path, plus the folder's own with several folders", () => {
  assert.deepEqual(pathReadings(one, "C:\\work\\app\\src\\a.ts"), ["src/a.ts"]);
  assert.deepEqual(pathReadings(two, "D:\\libs\\api\\src\\a.ts"), ["api/src/a.ts", "src/a.ts"]);
  assert.deepEqual(pathReadings(two, "C:\\work\\app\\src\\a.ts"), ["app/src/a.ts", "src/a.ts"]);
});

test("ignore rules apply per folder, relative to that folder", () => {
  const ignores = new FolderIgnores([
    { folder: two[0] as (typeof two)[0], matcher: new AgentIgnore([...DEFAULT_AGENT_IGNORE]) },
    {
      folder: two[1] as (typeof two)[1],
      matcher: new AgentIgnore([...DEFAULT_AGENT_IGNORE, "/private/"]),
    },
  ]);
  // Secrets in the second folder are hidden too.
  assert.equal(ignores.ignored("D:\\libs\\api\\.env"), true);
  assert.equal(ignores.ignored("d:\\libs\\API\\config\\server.key"), true);
  // Anchored to the folder that wrote the rule.
  assert.equal(ignores.ignored("D:\\libs\\api\\private\\a.txt"), true);
  assert.equal(ignores.ignored("C:\\work\\app\\private\\a.txt"), false);
  assert.equal(ignores.ignored("E:\\elsewhere\\.env"), false);
  // Workspace-relative paths (search results) by the folder their name picks.
  assert.equal(ignores.ignoredRel("api/private/a.txt"), true);
  assert.equal(ignores.ignoredRel("api/src/a.ts"), false);
  assert.equal(ignores.ignoredRel("api/.env"), true);
  assert.equal(ignores.ignoredRel(".env"), true);
  assert.equal(ignores.ignoredRel("src/main.ts"), false);
  assert.equal(ignores.ignoredRel("D:\\libs\\api\\private\\x"), true);
  // Relative to the first folder (a helper's worktree).
  assert.equal(ignores.ignoredInFirst("private/a.txt"), false);
  assert.equal(ignores.ignoredInFirst(".env"), true);
});

test("nested folders: the outer folder's rules still cover the inner one", () => {
  const outer = { path: "/repo", name: "repo" };
  const inner = { path: "/repo/packages/pkg", name: "pkg" };
  const ignores = new FolderIgnores([
    { folder: outer, matcher: new AgentIgnore(["packages/pkg/secret.txt"]) },
    { folder: inner, matcher: new AgentIgnore(["!secret.txt"]) },
  ]);
  assert.equal(ignores.ignored("/repo/packages/pkg/secret.txt"), true);
  assert.equal(ignores.ignored("/repo/packages/pkg/other.txt"), false);
});

test("one folder: workspace-relative matching is unchanged", () => {
  const ignores = new FolderIgnores([
    { folder: one[0] as (typeof one)[0], matcher: new AgentIgnore(["/secrets/"]) },
  ]);
  assert.equal(ignores.ignoredRel("secrets/a"), true);
  assert.equal(ignores.ignoredRel("app/secrets/a"), false);
  assert.equal(ignores.ignored("C:\\work\\app\\secrets\\a"), true);
  assert.equal(ignores.ignored("C:\\work\\app"), false);
});
