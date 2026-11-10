import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fileUriPath,
  folderEntryPath,
  folderOf,
  isWorkspaceFile,
  newWorkspaceText,
  parseWorkspaceFile,
  resolveFolders,
  withFolders,
  withWorkspaceSetting,
  workspaceFileName,
  workspaceRelative,
} from "./workspaceFile";

test("workspace files are recognized by name (D251)", () => {
  assert.ok(isWorkspaceFile("C:\\w\\app.code-workspace"));
  assert.ok(isWorkspaceFile("/w/App.CODE-WORKSPACE"));
  assert.ok(!isWorkspaceFile("/w/app.code-workspace.bak"));
  assert.equal(workspaceFileName("/w/my app.code-workspace"), "my app");
});

test("a workspace file's folders, settings, launch and tasks", () => {
  const text = `{
    // the app and its api
    "folders": [
      { "path": "web" },
      { "path": "../api", "name": "Backend" },
      { "uri": "file:///c%3A/shared/lib" },
      { "uri": "vscode-remote://ssh-remote+box/home/x" },
      { "name": "no path" },
      "junk",
    ],
    "settings": { "editor.tabSize": 2 },
    "launch": { "compounds": [] },
  }`;
  const r = parseWorkspaceFile(text);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.data.folders, [
    { path: "web" },
    { path: "../api", name: "Backend" },
    { path: "c:/shared/lib" },
  ]);
  assert.deepEqual(r.data.settings, { "editor.tabSize": 2 });
  assert.deepEqual(r.data.launch, { compounds: [] });
  assert.equal(r.data.tasks, null);
  assert.deepEqual(r.data.skipped, ["vscode-remote://ssh-remote+box/home/x"]);
  // Broken or wrong-shaped files say why.
  assert.equal(parseWorkspaceFile("{ folders: ").ok, false);
  assert.equal(parseWorkspaceFile("[1]").ok, false);
  // An empty file is an empty workspace.
  const empty = parseWorkspaceFile("");
  assert.ok(empty.ok && empty.data.folders.length === 0);
});

test("folders resolve against the file's folder, named by the entry or the folder", () => {
  const win = resolveFolders("C:\\w\\proj\\app.code-workspace", [
    { path: "web" },
    { path: "../api", name: "Backend" },
    { path: "D:\\lib" },
    { path: "./web/" },
    { path: "web/../web" },
  ]);
  assert.deepEqual(win, [
    { path: "C:\\w\\proj\\web", name: "web", index: 0 },
    { path: "C:\\w\\api", name: "Backend", index: 1 },
    { path: "D:\\lib", name: "lib", index: 2 },
  ]);
  const posix = resolveFolders("/home/me/x.code-workspace", [{ path: "a" }, { path: "/srv/b" }]);
  assert.deepEqual(posix, [
    { path: "/home/me/a", name: "a", index: 0 },
    { path: "/srv/b", name: "b", index: 1 },
  ]);
});

test("folders are written relative when they're inside or beside the file's folder", () => {
  const file = "C:\\w\\proj\\app.code-workspace";
  assert.equal(folderEntryPath(file, "C:\\w\\proj"), ".");
  assert.equal(folderEntryPath(file, "C:\\w\\proj\\web"), "web");
  assert.equal(folderEntryPath(file, "C:\\w\\api"), "../api");
  assert.equal(folderEntryPath(file, "D:\\lib"), "D:\\lib");
  assert.equal(folderEntryPath("/a/b/x.code-workspace", "/a/c/d"), "../c/d");
  // An untitled workspace in the app's data folder writes absolute paths.
  assert.equal(
    folderEntryPath("C:\\data\\workspaces\\untitled\\1.code-workspace", "C:\\w\\proj"),
    "C:\\w\\proj",
  );
  // Round trip: written, read back, resolved to the same folders.
  const text = newWorkspaceText(file, [
    { path: "C:\\w\\proj\\web" },
    { path: "C:\\w\\api", name: "Backend" },
  ]);
  const back = parseWorkspaceFile(text);
  assert.ok(back.ok);
  if (!back.ok) return;
  assert.deepEqual(
    resolveFolders(file, back.data.folders).map((f) => [f.path, f.name]),
    [
      ["C:\\w\\proj\\web", "web"],
      ["C:\\w\\api", "Backend"],
    ],
  );
});

test("editing keeps the rest of the file", () => {
  const file = "/w/x.code-workspace";
  const text = `{
  // keep me
  "folders": [{ "path": "a" }],
  "settings": { "files.autoSave": "afterDelay" }
}
`;
  const added = withFolders(text, file, [{ path: "/w/a" }, { path: "/w/b", name: "B!" }]);
  assert.match(added, /\/\/ keep me/);
  const r = parseWorkspaceFile(added);
  assert.ok(r.ok && r.data.folders.length === 2 && r.data.folders[1]?.name === "B!");
  assert.ok(r.ok && r.data.settings["files.autoSave"] === "afterDelay");
  // A name equal to the folder's own isn't written.
  assert.doesNotMatch(withFolders(text, file, [{ path: "/w/a", name: "a" }]), /"name"/);
  const set = withWorkspaceSetting(added, "editor.tabSize", 4);
  const s = parseWorkspaceFile(set);
  assert.ok(s.ok && s.data.settings["editor.tabSize"] === 4);
  assert.match(set, /\/\/ keep me/);
  const unset = parseWorkspaceFile(withWorkspaceSetting(set, "editor.tabSize", undefined));
  assert.ok(unset.ok && !("editor.tabSize" in unset.data.settings));
  // An empty file gets an object.
  assert.ok(parseWorkspaceFile(withWorkspaceSetting("", "a", 1)).ok);
});

test("which folder holds a path, and the path as the workspace shows it", () => {
  const folders = [
    { path: "C:\\repo", name: "repo", index: 0 },
    { path: "C:\\repo\\packages\\ui", name: "ui", index: 1 },
    { path: "D:\\api", name: "Backend", index: 2 },
  ];
  assert.equal(folderOf(folders, "C:\\repo\\packages\\ui\\src\\a.ts")?.name, "ui");
  assert.equal(folderOf(folders, "c:\\REPO\\readme.md")?.name, "repo");
  assert.equal(folderOf(folders, "E:\\x"), undefined);
  assert.equal(workspaceRelative(folders, "D:\\api\\src\\main.ts"), "Backend/src/main.ts");
  assert.equal(workspaceRelative(folders, "D:\\api"), "Backend");
  assert.equal(workspaceRelative(folders, "E:\\x"), "E:\\x");
  assert.equal(workspaceRelative(folders.slice(0, 1), "C:\\repo\\a\\b.ts"), "a/b.ts");
});

test("file URIs", () => {
  assert.equal(fileUriPath("file:///home/me/a%20b"), "/home/me/a b");
  assert.equal(fileUriPath("file:///C:/x"), "C:/x");
  assert.equal(fileUriPath("file://server/share/x"), "\\\\server\\share\\x");
  assert.equal(fileUriPath("vscode-remote://x/y"), null);
  assert.equal(fileUriPath("file:///%E0%A4%A"), null);
});
