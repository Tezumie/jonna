import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerApi, type FromWorker, type ToWorker } from "./rpc";
import {
  extensionMayWriteSetting,
  hasPermission,
  inClaimedNamespace,
  networkAllows,
  parseManifest,
  requiredPermissions,
} from "./thirdParty";
import { declarativeOnly } from "./vscodePackage";

test("extensionMayWriteSetting: own and folder-level settings, never user-only or blocked ones", () => {
  assert.equal(extensionMayWriteSetting("acme.todo-tree", "todoTree.colors", "user"), true);
  assert.equal(extensionMayWriteSetting("acme.todo-tree", "editor.fontSize", undefined), true);
  assert.equal(extensionMayWriteSetting("acme.todo-tree", "lsp.servers", "user"), false);
  assert.equal(
    extensionMayWriteSetting("acme.todo-tree", "terminal.profiles.windows", "user"),
    false,
  );
  assert.equal(extensionMayWriteSetting("acme.todo-tree", "agent.runCommands", "user"), false);
  assert.equal(extensionMayWriteSetting("acme.todo-tree", "http.proxy", undefined), false);
  assert.equal(extensionMayWriteSetting("acme.todo-tree", "github.token", "both"), false);
  // D261: another extension's setting under the same short name isn't its own.
  const interpreter = "python.defaultInterpreterPath";
  assert.equal(
    extensionMayWriteSetting("evil.python", interpreter, "user", "ms-python.python"),
    false,
  );
  assert.equal(
    extensionMayWriteSetting("evil.python", "python.x", "workspace", "ms-python.python"),
    true,
  );
  assert.equal(
    extensionMayWriteSetting("ms-python.python", interpreter, "user", "ms-python.python"),
    true,
  );
});

test("parseManifest: our format with commands, views, settings, permissions", () => {
  const m = parseManifest(
    {
      id: "acme.todo",
      version: "1.0.0",
      main: "main.js",
      permissions: ["fs.read", "network:api.github.com"],
      contributes: {
        commands: [{ id: "todo.list", title: "List TODOs", effects: ["read"] }],
        keybindings: [{ key: "ctrl+alt+t", command: "todo.list" }],
        views: [{ id: "todo.view", title: "TODOs", location: "sidebar", type: "tree" }],
        settings: { "todo.tags": { type: "array", default: ["TODO"] } },
      },
    },
    "extension.json",
  );
  assert.equal(m.id, "acme.todo");
  assert.equal(m.main, "main.js");
  assert.equal(m.format, "ide");
  assert.deepEqual(m.contributes.commands[0]?.effects, ["read"]);
  assert.equal(m.contributes.views[0]?.type, "tree");
  assert.ok(m.contributes.settings["todo.tags"]);
});

test("parseManifest: rejects bad ids, paths, permissions and foreign command names", () => {
  assert.throws(() => parseManifest({ id: "Bad", version: "1" }, "extension.json"), /invalid id/);
  assert.throws(
    () => parseManifest({ id: "a.b", version: "1", main: "../x.js" }, "extension.json"),
    /main/,
  );
  assert.throws(
    () => parseManifest({ id: "a.b", version: "1", permissions: ["root"] }, "extension.json"),
    /unknown permission/,
  );
  assert.throws(
    () =>
      parseManifest(
        { id: "a.b", version: "1", contributes: { commands: [{ id: "editor.save", title: "x" }] } },
        "extension.json",
      ),
    /must start with/,
  );
});

test("parseManifest: claimed namespaces (IDE's own only), sections, command `when` (D208)", () => {
  const manifest = (id: string) => ({
    id,
    version: "1",
    permissions: ["git", "github"],
    namespaces: ["git", "github"],
    contributes: {
      commands: [{ id: "git.lineHistory", title: "Line history", when: "gitRepo" }],
      views: [
        {
          id: "git.stashesView",
          title: "Stashes",
          location: "sidebar",
          type: "tree",
          sectionOf: "scm.view",
          sectionOrder: 10,
        },
      ],
      settings: { "git.blame.heatmap": { type: "boolean", default: true } },
    },
  });
  const m = parseManifest(manifest("bundled.gittools"), "extension.json");
  assert.deepEqual(m.namespaces, ["git", "github"]);
  assert.equal(m.contributes.commands[0]?.when, "gitRepo");
  assert.equal(m.contributes.views[0]?.sectionOf, "scm.view");
  assert.equal(m.contributes.views[0]?.sectionOrder, 10);
  assert.ok(inClaimedNamespace(m, "git.lineHistory"));
  assert.ok(!inClaimedNamespace(m, "gittools.other"));
  // Anyone else's manifest may not claim them.
  assert.throws(
    () => parseManifest(manifest("acme.gitplus"), "extension.json"),
    /only extensions that come with the IDE/,
  );
  // A section is a sidebar view's.
  assert.throws(
    () =>
      parseManifest(
        {
          id: "acme.x",
          version: "1",
          contributes: {
            views: [
              { id: "x.v", title: "V", location: "panel", type: "tree", sectionOf: "scm.view" },
            ],
          },
        },
        "extension.json",
      ),
    /sectionOf/,
  );
  assert.deepEqual(requiredPermissions("github.notifications", ["read", "network"]).sort(), [
    "fs.read",
    "github",
    "network",
  ]);
});

test("parseManifest: menus, viewers, agents, MCP servers, providers and metadata (D176)", () => {
  const base = {
    id: "acme.todo",
    version: "1.0.0",
    icon: "list-tree",
    author: "Acme",
    categories: ["Other", 3],
    keywords: ["todo"],
    repository: { url: "https://github.com/acme/todo" },
    permissions: ["shell", "agent"],
  };
  const commands = [{ id: "todo.scan", title: "Scan" }];
  const m = parseManifest(
    {
      ...base,
      contributes: {
        commands,
        views: [
          { id: "todo.page", title: "Page", location: "editor", type: "webview", path: "p.html" },
        ],
        // Both shapes of menus.
        menus: [{ location: "editor/title", command: "todo.scan", icon: "zap" }],
        viewers: [
          { id: "todo.viewer", title: "Board", extensions: ["todo", ".TODO"], path: "v.html" },
        ],
        agents: [{ name: "Todo agent", command: "npx", args: ["todo-acp"] }],
        mcpServers: [{ name: "todo-db", command: "node", args: ["s.js"], env: { A: "1", B: 2 } }],
        modelProviders: [{ id: "acme", name: "Acme AI", baseUrl: "https://api.acme.ai/v1" }],
      },
    },
    "extension.json",
  );
  assert.equal(m.iconName, "list-tree");
  assert.equal(m.icon, undefined);
  assert.equal(m.author, "Acme");
  assert.equal(m.repository, "https://github.com/acme/todo");
  assert.deepEqual(m.categories, ["Other"]);
  assert.equal(m.contributes.views[0]?.location, "editor");
  assert.equal(m.contributes.menus[0]?.location, "editor/title");
  assert.deepEqual(m.contributes.viewers[0]?.extensions, [".todo", ".todo"]);
  assert.equal(m.contributes.agents[0]?.name, "Todo agent");
  assert.deepEqual(m.contributes.mcpServers[0]?.env, { A: "1" });
  assert.equal(m.contributes.modelProviders[0]?.baseUrl, "https://api.acme.ai/v1");
  const vscodeMenus = parseManifest(
    {
      ...base,
      contributes: { commands, menus: { "explorer/context": [{ command: "todo.scan" }] } },
    },
    "extension.json",
  );
  assert.equal(vscodeMenus.contributes.menus[0]?.location, "explorer/context");

  const bad = (contributes: Record<string, unknown>, permissions = base.permissions) =>
    assert.throws(() =>
      parseManifest(
        { ...base, permissions, contributes: { commands, ...contributes } },
        "extension.json",
      ),
    );
  // Another extension's command, a foreign viewer id, programs without permission, a provider
  // posing as a built-in one or over plain http.
  bad({ menus: [{ location: "explorer/context", command: "editor.save" }] });
  bad({ viewers: [{ id: "other.viewer", title: "x", extensions: [".x"], path: "v.html" }] });
  bad({ agents: [{ name: "a", command: "x" }] }, ["agent"]);
  bad({ mcpServers: [{ name: "a", command: "x" }] }, ["shell"]);
  bad({ modelProviders: [{ id: "x", name: "Anthropic", baseUrl: "https://evil.example" }] });
  bad({ modelProviders: [{ id: "x", name: "Mine", baseUrl: "http://example.com" }] });
  bad({ modelProviders: [{ id: "x", name: "Anthropic API", baseUrl: "https://evil.example" }] });
});

test("parseManifest: a VS Code extension's declarative parts, its code once allowed (D256)", () => {
  const m = parseManifest(
    {
      name: "night-owl",
      publisher: "sdras",
      version: "2.0.1",
      main: "./out/extension.js",
      contributes: {
        themes: [
          { label: "Night Owl", uiTheme: "vs-dark", path: "./themes/Night Owl-color-theme.json" },
        ],
        grammars: [{ language: "toml", scopeName: "source.toml", path: "./syntaxes/toml.json" }],
        languages: [{ id: "toml", extensions: [".toml"] }],
        snippets: [{ language: "javascript", path: "./snippets/js.json" }],
        jsonValidation: [
          { fileMatch: "*.scene.json", url: "./schemas/scene.schema.json" },
          { fileMatch: ["/.owlrc", 7], url: "schemas/rc.json" },
          // A schema on the web isn't loaded; one without a pattern matches nothing.
          { fileMatch: "*.json", url: "https://example.com/schema.json" },
          { fileMatch: [], url: "./schemas/none.json" },
        ],
        commands: [{ command: "nightOwl.x", title: "X" }],
      },
    },
    "package.json",
  );
  // JSON schemas for files (D419), kept while its code isn't allowed: they need none.
  assert.deepEqual(m.contributes.jsonValidation, [
    { fileMatch: ["*.scene.json"], path: "schemas/scene.schema.json" },
    { fileMatch: ["/.owlrc"], path: "schemas/rc.json" },
  ]);
  assert.equal(declarativeOnly(m).contributes.jsonValidation?.length, 2);
  assert.equal(m.id, "sdras.night-owl");
  assert.equal(m.format, "vscode");
  // Its code runs in the Node host behind the shim (vscodePackage.test.ts has the rest).
  assert.equal(m.main, "out/extension.js");
  assert.equal(m.host, "node");
  assert.equal(m.contributes.commands[0]?.id, "nightOwl.x");
  // Until it's allowed, only what needs no code.
  const waiting = declarativeOnly(m);
  assert.equal(waiting.main, undefined);
  assert.equal(waiting.host, undefined);
  assert.deepEqual(waiting.permissions, []);
  assert.deepEqual(waiting.contributes.commands, []);
  assert.equal(waiting.contributes.themes[0]?.path, "themes/Night Owl-color-theme.json");
  assert.equal(waiting.contributes.grammars[0]?.scopeName, "source.toml");
  assert.equal(waiting.contributes.snippets[0]?.language, "javascript");
});

test("permissions: namespaces and effects, network domains", () => {
  assert.deepEqual(requiredPermissions("editor.openFile", []), []);
  assert.deepEqual(requiredPermissions("editor.getText", ["read"]), ["fs.read"]);
  assert.deepEqual(requiredPermissions("ui.copyText", []), ["clipboard"]);
  assert.deepEqual(requiredPermissions("explorer.newFile", ["write"]), ["fs.write"]);
  assert.deepEqual(requiredPermissions("git.commit", ["write"]).sort(), ["fs.write", "git"]);
  assert.deepEqual(requiredPermissions("tasks.run", ["exec"]), ["shell"]);
  assert.deepEqual(requiredPermissions("terminal.runCommand", ["exec"]), ["terminal"]);
  assert.ok(hasPermission(["shell"], "terminal"));
  assert.ok(hasPermission(["network:x.com"], "network"));
  assert.ok(!hasPermission(["fs.read"], "fs.write"));
  assert.ok(networkAllows(["network:api.github.com"], "https://api.github.com/repos"));
  assert.ok(!networkAllows(["network:api.github.com"], "https://evil.com/"));
  assert.ok(networkAllows(["network:*.example.com"], "https://a.b.example.com/x"));
  assert.ok(networkAllows(["network"], "http://localhost:3000"));
  assert.ok(!networkAllows(["network"], "file:///etc/passwd"));
});

test("createWorkerApi: requests, replies and host calls into handlers", async () => {
  const sent: FromWorker[] = [];
  let deliver: (m: ToWorker) => void = () => {};
  const { api } = createWorkerApi(
    { post: (m) => sent.push(m), onMessage: (h) => (deliver = h) },
    { id: "a.b", version: "1" },
  );
  const result = api.commands.execute<number>("x.y", { n: 1 });
  const req = sent.find((m) => m.t === "req" && m.method === "commands.execute");
  assert.ok(req && req.t === "req");
  deliver({ t: "res", id: req.id, ok: true, value: 42 });
  assert.equal(await result, 42);

  api.commands.register("b.hello", (input) => `hi ${(input as { name: string }).name}`);
  deliver({ t: "call", id: 7, kind: "command", target: "b.hello", args: { name: "Ada" } });
  await new Promise((r) => setTimeout(r, 0));
  const reply = sent.find((m) => m.t === "res" && m.id === 7);
  assert.deepEqual(reply, { t: "res", id: 7, ok: true, value: "hi Ada" });

  const failing = api.state.get("ide://nope");
  const req2 = sent.filter((m) => m.t === "req").pop();
  assert.ok(req2 && req2.t === "req");
  deliver({ t: "res", id: req2.id, ok: false, error: "denied" });
  await assert.rejects(failing, /denied/);
});

test("parseManifest: screenshots are image files of the extension, with captions (D190)", () => {
  const m = parseManifest(
    {
      id: "acme.pics",
      version: "1.0.0",
      screenshots: [
        "screenshots/1.png",
        { path: "./screenshots/2.webp", caption: "Board" },
        "../outside.png",
        "https://example.com/a.png",
        "notes.txt",
        "screenshots/1.png",
      ],
    },
    "extension.json",
  );
  assert.deepEqual(m.screenshots, [
    { path: "screenshots/1.png" },
    { path: "screenshots/2.webp", caption: "Board" },
  ]);
  assert.deepEqual(
    parseManifest({ id: "acme.none", version: "1.0.0" }, "extension.json").screenshots,
    [],
  );
});

test("parseManifest: problem matchers and patterns, in both formats", () => {
  const contributes = {
    problemMatchers: [
      { name: "lintr", owner: "lintr", pattern: "$lintr-line" },
      { owner: "no name" },
      { name: "bad name!", pattern: {} },
    ],
    problemPatterns: [
      { name: "lintr-line", regexp: "^(.*)$", file: 1 },
      { name: "multi", patterns: [{ regexp: "a" }, { regexp: "b", loop: true }] },
    ],
  };
  const ours = parseManifest({ id: "a.b", version: "1", contributes }, "extension.json");
  assert.deepEqual(ours.contributes.problemMatchers, [
    { name: "lintr", definition: { owner: "lintr", pattern: "$lintr-line" } },
  ]);
  assert.deepEqual(ours.contributes.problemPatterns, [
    { name: "lintr-line", pattern: { regexp: "^(.*)$", file: 1 } },
    { name: "multi", pattern: [{ regexp: "a" }, { regexp: "b", loop: true }] },
  ]);
  const vscode = parseManifest(
    {
      name: "lint",
      publisher: "acme",
      version: "1.0.0",
      engines: { vscode: "^1.80.0" },
      contributes,
    },
    "package.json",
  );
  assert.equal(vscode.contributes.problemMatchers.length, 1);
});
