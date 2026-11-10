import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseTasksJson,
  quoteTaskArg,
  scriptTasks,
  substitute,
  taskPlatform,
  taskShellKind,
} from "./tasks";

const v = { workspaceFolder: "/w/app", file: "/w/app/src/main.ts", pathSeparator: "/" };

test("variables", () => {
  assert.equal(
    substitute(
      "${workspaceFolder}/out/${fileBasenameNoExtension}.js ${relativeFile} ${env:HOME}",
      v,
    ),
    "/w/app/out/main.js src/main.ts ${env:HOME}",
  );
});

test("tasks.json", () => {
  const tasks = parseTasksJson(
    {
      version: "2.0.0",
      tasks: [
        {
          label: "build",
          type: "shell",
          command: "tsc",
          args: ["-p", "${workspaceFolder}/tsconfig.json"],
          group: { kind: "build", isDefault: true },
        },
        {
          label: "dev",
          type: "shell",
          command: "vite",
          isBackground: true,
          options: { cwd: "${workspaceFolder}/web" },
        },
        { type: "npm", script: "lint" },
        { label: "all", dependsOn: ["build", "dev"] },
        { label: "win", command: "make", windows: { command: "nmake" } },
        { label: 3 },
      ],
    },
    ".vscode/tasks.json",
    v,
    "linux",
  );
  assert.deepEqual(
    tasks.map((t) => [t.label, t.command, t.background, t.group?.isDefault ?? null, t.cwd ?? null]),
    [
      ["build", "tsc -p /w/app/tsconfig.json", false, true, null],
      ["dev", "vite", true, null, "/w/app/web"],
      ["npm: lint", "npm run lint", false, null, null],
      ["all", "", false, null, null],
      ["win", "make", false, null, null],
    ],
  );
});

test("task arguments are quoted for their shell: substituted file names stay literal", () => {
  assert.equal(quoteTaskArg("$(touch x).py", "posix"), "'$(touch x).py'");
  assert.equal(quoteTaskArg("it's", "posix"), "'it'\\''s'");
  assert.equal(quoteTaskArg("C:\\a b\\$(calc)", "pwsh"), "'C:\\a b\\$(calc)'");
  assert.equal(quoteTaskArg("a’;calc;’b", "pwsh"), "'a’’;calc;’’b'");
  assert.equal(quoteTaskArg("@args", "pwsh"), "'@args'");
  assert.equal(quoteTaskArg("C:\\plain\\x.ts", "pwsh"), "C:\\plain\\x.ts");
  assert.equal(quoteTaskArg('a "b"', "cmd"), '"a ""b"""');
  assert.equal(taskShellKind(undefined, "windows"), "pwsh");
  assert.equal(taskShellKind("C:\\Windows\\System32\\cmd.exe", "windows"), "cmd");
  assert.equal(taskShellKind("C:\\Program Files\\Git\\bin\\bash.exe", "windows"), "posix");
  assert.equal(taskShellKind(undefined, "linux"), "posix");
  const [task] = parseTasksJson(
    { tasks: [{ label: "run", command: "node", args: ["${file}"] }] },
    "tasks.json",
    { ...v, file: "/w/app/$(id).js" },
    "linux",
  );
  assert.equal(task?.command, "node '/w/app/$(id).js'");
});

test("package.json scripts", () => {
  const tasks = scriptTasks({ scripts: { dev: "vite", build: "vite build", n: 1 } }, [
    "pnpm-lock.yaml",
  ]);
  assert.deepEqual(
    tasks.map((t) => [t.label, t.command, t.background]),
    [
      ["pnpm: dev", "pnpm dev", true],
      ["pnpm: build", "pnpm build", false],
    ],
  );
});

test("a WSL folder's tasks use their linux block (they run in the distribution)", () => {
  const wsl = "\\\\wsl.localhost\\Ubuntu\\home\\me\\app";
  assert.equal(taskPlatform("windows", wsl), "linux");
  assert.equal(taskPlatform("windows", "//wsl$/Debian/srv"), "linux");
  // A remote window's folder (D252): the remote's POSIX path.
  assert.equal(taskPlatform("windows", "/home/me/app"), "linux");
  assert.equal(taskPlatform("windows", "C:\\proj"), "windows");
  assert.equal(taskPlatform("linux", "/home/me/app"), "linux");
  assert.equal(taskPlatform("windows", "C:\\work\\app"), "windows");
  assert.equal(taskPlatform("windows", null), "windows");
  assert.equal(taskPlatform("linux", wsl), "linux");
  const json = {
    version: "2.0.0",
    tasks: [
      { label: "b", command: "make", windows: { command: "nmake" }, linux: { command: "gmake" } },
    ],
  };
  const vars = { workspaceFolder: wsl, pathSeparator: "/" };
  assert.equal(parseTasksJson(json, "x", vars, taskPlatform("windows", wsl))[0]?.command, "gmake");
  assert.equal(parseTasksJson(json, "x", vars, "windows")[0]?.command, "nmake");
});
