// The host's checks of D233's providers: provided tasks, source control state and rows, debug
// adapter descriptors, sessions and when getSession asks, file system schemes, and the terminal
// and tasks extensions' sides (an extension's terminal's start, a provided task's definition).
import assert from "node:assert/strict";
import { test } from "node:test";
import { signal } from "../../core/reactive/index";
import { EMPTY_SCM_STATE, type ScmState } from "../../workbench/extensionRegistries";
import { fromContributed } from "../tasks/extensionTasks";
import { extensionTerminalStart } from "../terminal/extensionTerminals";
import {
  checkDescriptor,
  checkProvidedConfigurations,
  checkScmState,
  checkSession,
  checkTask,
  isGitFolderName,
  matchFiles,
  matchWorkspaceFiles,
  openableUrl,
  schemeProblem,
  scmRows,
  sessionDecision,
} from "./workbenchChecks";

const taskContext = (granted: string[]) => ({
  source: "Demo",
  owner: "acme.demo",
  granted: (p: string) => granted.includes(p),
  cwd: (path: unknown) => {
    if (typeof path !== "string" || path.startsWith("..")) throw new Error("outside the folder");
    return `/ws/${path}`;
  },
  custom: (key: string) => `ext:acme.demo:task:${key}`,
});

test("checkTask: shell, process and custom tasks; permissions and bad ones refused", () => {
  const shell = checkTask(
    {
      name: "lint",
      group: "build",
      isBackground: true,
      presentation: { reveal: "never", panel: "bogus" },
      execution: { kind: "shell", commandLine: "eslint .", cwd: "src", env: { CI: "1" } },
    },
    "demo",
    taskContext(["shell"]),
  );
  assert.ok(typeof shell !== "string");
  assert.equal(shell.label, "demo: lint");
  assert.deepEqual(shell.spec, { kind: "shell", command: "eslint .", env: { CI: "1" } });
  assert.equal(shell.cwd, "/ws/src");
  assert.deepEqual(shell.group, { kind: "build", isDefault: false });
  assert.deepEqual(shell.presentation, { reveal: "never" });
  assert.equal(shell.background, true);
  const proc = checkTask(
    { name: "p", execution: { kind: "process", process: "node", args: ["a.js", 3] } },
    "demo",
    taskContext(["shell"]),
  );
  assert.ok(typeof proc !== "string");
  assert.deepEqual(proc.spec, { kind: "process", command: "node", args: ["a.js"] });
  const custom = checkTask(
    { name: "c", execution: { kind: "custom", key: "tasks1/c" } },
    "demo",
    taskContext(["terminal"]),
  );
  assert.ok(typeof custom !== "string");
  assert.equal(custom.spec.virtual, "ext:acme.demo:task:tasks1/c");
  // Without the permission, refused (with why).
  assert.match(
    String(
      checkTask(
        { name: "x", execution: { kind: "shell", commandLine: "ls" } },
        "demo",
        taskContext([]),
      ),
    ),
    /shell/,
  );
  assert.match(
    String(
      checkTask({ name: "c", execution: { kind: "custom", key: "k" } }, "demo", taskContext([])),
    ),
    /terminal/,
  );
  assert.match(
    String(
      checkTask(
        { name: "x", execution: { kind: "shell", commandLine: "ls", cwd: "../out" } },
        "demo",
        taskContext(["shell"]),
      ),
    ),
    /outside/,
  );
  assert.equal(typeof checkTask({ execution: {} }, "demo", taskContext(["shell"])), "string");
});

test("fromContributed: the tasks extension's definition with default presentation", () => {
  const t = fromContributed({
    owner: "acme.demo",
    label: "demo: lint",
    source: "Demo",
    spec: { kind: "shell", command: "eslint ." },
    command: "eslint .",
    background: false,
    presentation: { reveal: "silent" },
  });
  assert.equal(t.presentation.reveal, "silent");
  assert.equal(t.presentation.panel, "shared");
  assert.deepEqual(t.dependsOn, []);
  assert.equal(t.source, "Demo");
});

test("checkScmState: paths in the folder or its own scheme, own commands only, limits", () => {
  const state = checkScmState(
    {
      groups: [
        {
          id: "changes",
          label: "Changes",
          hideWhenEmpty: false,
          resources: [
            {
              path: "a.txt",
              decorations: { letter: "MOD", tone: "modified", strikeThrough: true },
            },
            { path: "../outside.txt" },
            { path: "memfs:/b.txt", command: { command: "demo.open", input: 1 } },
            { path: "other:/c.txt" },
            { path: "d.txt", command: { command: "git.commit" } },
          ],
        },
        { id: "changes", label: "Again", hideWhenEmpty: false, resources: [] },
      ],
      input: { value: "msg", placeholder: "Message", visible: true },
      count: 2.7,
      accept: { command: "git.push", title: "Push" },
    },
    {
      path: (p) => {
        if (typeof p !== "string" || p.startsWith("..")) throw new Error("outside");
        return `/ws/${p}`;
      },
      ownSchemes: ["memfs"],
      ownCommand: (id) => id.startsWith("demo."),
    },
  );
  assert.equal(state.groups.length, 1);
  const resources = state.groups[0]?.resources ?? [];
  assert.deepEqual(
    resources.map((r) => r.path),
    ["/ws/a.txt", "memfs:/b.txt", "/ws/d.txt"],
  );
  assert.equal(resources[0]?.letter, "MO");
  assert.equal(resources[0]?.strikeThrough, true);
  assert.deepEqual(resources[1]?.command, { id: "demo.open", input: 1 });
  assert.equal(resources[2]?.command, undefined, "another extension's command is dropped");
  assert.equal(state.count, 2);
  assert.equal(state.accept, null, "an accept command must be the extension's own");
});

test("scmRows: groups (empty ones hidden when asked), then resources with letter and color", () => {
  const state: ScmState = {
    ...EMPTY_SCM_STATE,
    groups: [
      { id: "empty", label: "Empty", hideWhenEmpty: true, resources: [] },
      {
        id: "changes",
        label: "Changes",
        hideWhenEmpty: true,
        resources: [{ path: "/ws/notes/sub/a.txt", letter: "M", tone: "modified" }],
      },
    ],
  };
  const entry = { key: "acme.demo/scm1", rootPath: "/ws/notes", state: signal(state) };
  const groups = scmRows(entry, undefined);
  assert.deepEqual(
    groups.map((g) => [g.id, g.description]),
    [["g:changes", "1"]],
  );
  const rows = scmRows(entry, groups[0]);
  assert.equal(rows[0]?.label, "a.txt");
  assert.equal(rows[0]?.description, "sub");
  assert.equal(rows[0]?.badge, "M");
  assert.equal(rows[0]?.badgeColor, "--git-modified-fg");
  assert.deepEqual(rows[0]?.command, {
    id: "extensions.scmOpenResource",
    input: { key: "acme.demo/scm1", group: "changes", index: 0 },
  });
});

test("checkDescriptor: executables, local ports and inline adapters", () => {
  assert.deepEqual(checkDescriptor({ kind: "executable", command: "node", args: ["a.js"] }), {
    kind: "executable",
    command: "node",
    args: ["a.js"],
  });
  assert.deepEqual(checkDescriptor({ kind: "server", port: 4711 }), {
    kind: "server",
    port: 4711,
    host: "127.0.0.1",
  });
  assert.deepEqual(checkDescriptor({ kind: "inline" }), { kind: "inline" });
  assert.throws(
    () => checkDescriptor({ kind: "server", port: 4711, host: "example.com" }),
    /this computer/,
  );
  assert.throws(() => checkDescriptor({ kind: "server", port: 70000 }), /port/);
  assert.throws(() => checkDescriptor({ kind: "executable", command: "" }), /command/);
  assert.throws(
    () => checkDescriptor({ kind: "executable", command: "x", env: { "A-B": "1" } }),
    /env/,
  );
  assert.throws(() => checkDescriptor({ kind: "other" }));
});

test("checkSession: a session needs an id, a token and an account", () => {
  const s = checkSession({
    id: "1",
    accessToken: "t",
    account: { label: "Ann" },
    scopes: ["a", 2],
  });
  assert.deepEqual(s, {
    id: "1",
    accessToken: "t",
    account: { id: "Ann", label: "Ann" },
    scopes: ["a"],
  });
  assert.equal(checkSession({ id: "1", accessToken: "t", account: {} }), null);
  assert.equal(checkSession({ accessToken: "t", account: { id: "a" } }), null);
  assert.equal(checkSession(null), null);
});

test("sessionDecision: another extension's session is asked about; silent never asks", () => {
  const session = { id: "1", accessToken: "t", account: { id: "a", label: "A" }, scopes: [] };
  const no = () => false;
  const base = { mine: false, silent: false, createIfNone: false, forceNewSession: false };
  assert.equal(sessionDecision({ ...base, mine: true }, session, no), "give");
  assert.equal(sessionDecision(base, session, no), "ask");
  assert.equal(
    sessionDecision(base, session, () => true),
    "give",
  );
  assert.equal(sessionDecision({ ...base, silent: true }, session, no), "none");
  assert.equal(sessionDecision(base, undefined, no), "none");
  assert.equal(sessionDecision({ ...base, createIfNone: true }, undefined, no), "askSignIn");
  assert.equal(
    sessionDecision({ ...base, createIfNone: true, mine: true }, undefined, no),
    "signIn",
  );
  assert.equal(
    sessionDecision({ ...base, createIfNone: true, silent: true }, undefined, no),
    "none",
  );
  assert.equal(
    sessionDecision({ ...base, forceNewSession: true }, session, () => true),
    "askSignIn",
  );
});

test("schemeProblem: the IDE's own and the web's schemes are refused", () => {
  assert.equal(schemeProblem("memfs"), "");
  for (const s of [
    "file",
    "untitled",
    "virtual",
    "git",
    "gitstage",
    "https",
    "agent-x",
    "a",
    "Mem",
  ])
    assert.notEqual(schemeProblem(s), "", s);
});

test("extensionTerminalStart: a pseudoterminal's key or a chosen shell; else none", () => {
  assert.deepEqual(extensionTerminalStart({ name: "Echo", pseudo: "ext:k" }), {
    profile: { path: [], virtual: "ext:k" },
    title: "Echo",
  });
  assert.deepEqual(extensionTerminalStart({ shell: { path: "bash", args: ["-l", 2] } }), {
    profile: { path: ["bash"], args: ["-l"] },
  });
  assert.equal(extensionTerminalStart({ cwd: "/ws" }), null);
  assert.equal(extensionTerminalStart(null), null);
});

test("env (D234): openable links and findFiles' matching", () => {
  assert.ok(openableUrl("https://example.com/a"));
  assert.ok(openableUrl("mailto:a@b.c"));
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "vscode://x", "not a url"])
    assert.ok(!openableUrl(bad), bad);
  const paths = ["README.md", "docs/a.md", "node_modules/x/README.md", "src/a.ts"];
  assert.deepEqual(matchFiles(paths, "**/*.md", "node_modules/**", 10), ["README.md", "docs/a.md"]);
  assert.deepEqual(matchFiles(paths, "**/*.md", undefined, 1), ["README.md"]);
  assert.deepEqual(matchFiles(paths, "", undefined, 10), paths);
});

test("matchWorkspaceFiles: every folder's files (D251), one folder as matchFiles", () => {
  const items = [
    { path: "README.md" },
    { path: "docs/a.md" },
    { path: "node_modules/x/README.md" },
    { path: "README.md", root: "/srv/api" },
    { path: "src/lib.rs", root: "/srv/api" },
  ];
  const single = items.filter((i) => !i.root);
  assert.deepEqual(matchWorkspaceFiles(single, "/ws", "**/*.md", "node_modules/**", 10), [
    "/ws/README.md",
    "/ws/docs/a.md",
  ]);
  assert.deepEqual(matchWorkspaceFiles(items, "/ws", "**/*.md", "node_modules/**", 10), [
    "/ws/README.md",
    "/ws/docs/a.md",
    "/srv/api/README.md",
  ]);
  // At most `max`, across folders.
  assert.deepEqual(matchWorkspaceFiles(items, "/ws", "**/*.md", undefined, 2), [
    "/ws/README.md",
    "/ws/docs/a.md",
  ]);
  // A RelativePattern: only under its base, the glob relative to it.
  assert.deepEqual(
    matchWorkspaceFiles(items, "/ws", { base: "/srv/api", pattern: "**/*.rs" }, undefined, 10),
    ["/srv/api/src/lib.rs"],
  );
  assert.deepEqual(
    matchWorkspaceFiles(items, "/ws", { base: "/ws/docs", pattern: "*.md" }, undefined, 10),
    ["/ws/docs/a.md"],
  );
});

test("checkProvidedConfigurations: named objects of the provider's type, launch unless attach", () => {
  const out = checkProvidedConfigurations(
    [
      { name: " Run memo ", type: "node", program: "a.memo" },
      { name: "Attach", request: "attach", port: 9229 },
      { type: "memo-dbg" },
      "nope",
      null,
      { name: "Huge", blob: "x".repeat(30_000) },
    ],
    "memo-dbg",
    "Memo",
  );
  assert.deepEqual(out, [
    {
      label: "Run memo",
      description: "Memo",
      body: { name: "Run memo", type: "memo-dbg", request: "launch", program: "a.memo" },
    },
    {
      label: "Attach",
      description: "Memo",
      body: { name: "Attach", type: "memo-dbg", request: "attach", port: 9229 },
    },
  ]);
  assert.deepEqual(checkProvidedConfigurations({ name: "x" }, "t", "E"), []);
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `c${i}` }));
  assert.equal(checkProvidedConfigurations(many, "t", "E").length, 20);
});

test("D261: .git under the names Windows also opens it by", () => {
  for (const name of [".git", ".GIT", ".git.", ".git ", ".git. .", "GIT~1", "git~12"])
    assert.equal(isGitFolderName(name), true, name);
  for (const name of [".github", "git", ".gitignore", "src", "GIT~"])
    assert.equal(isGitFolderName(name), false, name);
});
