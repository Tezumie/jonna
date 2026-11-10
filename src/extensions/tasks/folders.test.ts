// D251: tasks, launch configurations and terminals in a multi-root workspace.
import assert from "node:assert/strict";
import { test } from "node:test";
import { configFilesOf, findNamed, folderByInput, folderForFile, qualifiedName } from "./folders";
import { ProblemCollector, resolveMatchers } from "./problemMatchers";
import { parseTasksJson, substitute, taskCwd, type Variables } from "./tasks";

const API = { name: "api", path: "/w/api", index: 0 };
const WEB = { name: "web", path: "/w/web", index: 1 };
const FOLDERS = [API, WEB];
const filesOf = (root: string): [string, string][] => [
  [`${root}/.ide/tasks.json`, ".ide/tasks.json"],
  [`${root}/.vscode/tasks.json`, ".vscode/tasks.json"],
];

test("config files: every folder's, in precedence; sources name the folder only in multi-root", () => {
  assert.deepEqual(
    configFilesOf([API], filesOf).map((f) => [f.path, f.source, f.folder.name]),
    [
      ["/w/api/.ide/tasks.json", ".ide/tasks.json", "api"],
      ["/w/api/.vscode/tasks.json", ".vscode/tasks.json", "api"],
    ],
  );
  assert.deepEqual(
    configFilesOf(FOLDERS, filesOf).map((f) => [f.path, f.source, f.folder.name]),
    [
      ["/w/api/.ide/tasks.json", "api/.ide/tasks.json", "api"],
      ["/w/api/.vscode/tasks.json", "api/.vscode/tasks.json", "api"],
      ["/w/web/.ide/tasks.json", "web/.ide/tasks.json", "web"],
      ["/w/web/.vscode/tasks.json", "web/.vscode/tasks.json", "web"],
    ],
  );
  assert.equal(qualifiedName("build", API, false), "build");
  assert.equal(qualifiedName("build", API, true), "build (api)");
  assert.equal(qualifiedName("build", undefined, true), "build");
});

test("names: exact label, the nearer folder's, the only one; ambiguity refused", () => {
  const all = [
    { label: "build (api)", name: "build", workspaceFolder: "/w/api" },
    { label: "build (web)", name: "build", workspaceFolder: "/w/web" },
    { label: "lint (web)", name: "lint", workspaceFolder: "/w/web" },
    { label: "deploy" },
  ];
  assert.equal(findNamed(all, "build (web)")?.label, "build (web)");
  assert.equal(findNamed(all, "lint")?.label, "lint (web)");
  assert.equal(findNamed(all, "build", "/w/api")?.label, "build (api)");
  assert.equal(findNamed(all, "deploy", "/w/api")?.label, "deploy");
  assert.equal(findNamed(all, "nope"), undefined);
  assert.throws(() => findNamed(all, "build"), /"build \(api\)", "build \(web\)"/);
  // A user task of that name (not a folder's) is the one meant.
  assert.equal(
    findNamed([...all, { label: "build" }], "build")?.label,
    "build",
    "an exact label wins",
  );
  // Single folder: labels as written, the folder's own first.
  const single = [{ label: "compile", workspaceFolder: "/w/api" }, { label: "test" }];
  assert.equal(findNamed(single, "compile", "/w/api")?.label, "compile");
  assert.equal(findNamed(single, "test", "/w/api")?.label, "test");
});

test("a command's folder input: a name, a path, a path inside, else refused", () => {
  assert.equal(folderByInput(FOLDERS, "web"), WEB);
  assert.equal(folderByInput(FOLDERS, "/w/api"), API);
  assert.equal(folderByInput(FOLDERS, "/w/web/src/x.ts"), WEB);
  assert.equal(folderByInput([{ name: "Server", path: "/w/api" }], "api")?.name, "Server");
  assert.throws(
    () => folderByInput(FOLDERS, "docs"),
    /isn't a folder of the workspace \(api, web\)/,
  );
  assert.equal(folderForFile(FOLDERS, "/w/web/a.ts", API), WEB);
  assert.equal(folderForFile(FOLDERS, "/elsewhere/a.ts", API), API);
  assert.equal(folderForFile(FOLDERS, undefined, API), API);
});

test("variables: ${workspaceFolder} is the config's folder; ${workspaceFolder:Name} any folder", () => {
  const v: Variables = {
    workspaceFolder: "/w/api",
    folders: FOLDERS,
    file: "/w/web/src/page.ts",
    pathSeparator: "/",
  };
  assert.equal(
    substitute(
      "${workspaceFolder} ${workspaceFolderBasename} ${workspaceFolder:web} ${workspaceFolderBasename:web} ${workspaceRoot:api}",
      v,
    ),
    "/w/api api /w/web web /w/api",
  );
  // The file is in another folder: relative to its own folder; scoped to the folder that has it.
  assert.equal(
    substitute("${fileWorkspaceFolder} ${fileWorkspaceFolderBasename} ${relativeFile}", v),
    "/w/web web src/page.ts",
  );
  assert.equal(substitute("${relativeFile:web} ${relativeFileDirname:web}", v), "src/page.ts src");
  // An unknown folder stays as written (VS Code refuses it; nothing is guessed).
  assert.equal(substitute("${workspaceFolder:docs}", v), "${workspaceFolder:docs}");
  // A file in the config's folder: relative to it.
  assert.equal(
    substitute("${relativeFile} ${fileWorkspaceFolder}", { ...v, file: "/w/api/a/b.ts" }),
    "a/b.ts /w/api",
  );
});

test("variables with one folder: as before, and its own name works too", () => {
  const v: Variables = { workspaceFolder: "/w/app", file: "/w/app/src/x.ts", pathSeparator: "/" };
  assert.equal(
    substitute("${relativeFile} ${fileWorkspaceFolder} ${workspaceFolder:app}", v),
    "src/x.ts /w/app /w/app",
  );
  assert.equal(substitute("${relativeFile}", { ...v, file: "/tmp/y.ts" }), "/tmp/y.ts");
  assert.equal(substitute("plain text", v), "plain text");
});

test("tasks of a folder: its variables; a relative cwd and the default cwd are its own", () => {
  const json = {
    version: "2.0.0",
    tasks: [
      {
        label: "build",
        type: "shell",
        command: "make -C ${workspaceFolder:web} ${workspaceFolder}",
      },
      { label: "sub", type: "shell", command: "ls", options: { cwd: "src" } },
    ],
  };
  const [build, sub] = parseTasksJson(
    json,
    "api/.vscode/tasks.json",
    { workspaceFolder: "/w/api", folders: FOLDERS, pathSeparator: "/" },
    "linux",
  );
  assert.equal(build?.command, "make -C /w/web /w/api");
  assert.equal(taskCwd(build?.cwd, "/w/api"), "/w/api");
  assert.equal(taskCwd(sub?.cwd, "/w/web"), "/w/web/src");
  assert.equal(taskCwd("/abs/dir", "/w/web"), "/abs/dir");
  assert.equal(taskCwd(undefined, undefined), undefined);
});

test("problem matchers: relative paths and fileLocation's ${workspaceFolder} are the task's folder", () => {
  const out = "src/main.ts(3,7): error TS2322: Type 'string' is not assignable.\r\n";
  const problems = (matcher: unknown, root: string) => {
    const { matchers } = resolveMatchers(matcher, root, undefined, FOLDERS);
    const c = new ProblemCollector(matchers);
    c.feed(out);
    c.end();
    return c.problems().map((p) => p.path);
  };
  assert.deepEqual(problems("$tsc", "/w/web"), ["/w/web/src/main.ts"]);
  assert.deepEqual(
    problems({ base: "$tsc", fileLocation: ["relative", "${workspaceFolder}/pkg"] }, "/w/web"),
    ["/w/web/pkg/src/main.ts"],
  );
  assert.deepEqual(
    problems({ base: "$tsc", fileLocation: ["relative", "${workspaceFolder:api}/pkg"] }, "/w/web"),
    ["/w/api/pkg/src/main.ts"],
  );
});
