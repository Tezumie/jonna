import assert from "node:assert/strict";
import { test } from "node:test";
import { parseManifest } from "../../core/extensions/thirdParty";
import { joinRelative, parseSnippets, themeKind } from "./contributions";
import { missingPermissions, parseRegistry, startOrder } from "./registry";

test("parseRegistry: tolerant of missing and broken data", () => {
  assert.deepEqual(parseRegistry(""), {
    dev: [],
    disabled: [],
    granted: {},
    declined: {},
    bundled: [],
    sources: {},
    customized: [],
    bisect: null,
    disabledIn: {},
    autoUpdate: {},
  });
  assert.deepEqual(parseRegistry("{not json"), {
    dev: [],
    disabled: [],
    granted: {},
    declined: {},
    bundled: [],
    sources: {},
    customized: [],
    bisect: null,
    disabledIn: {},
    autoUpdate: {},
  });
  assert.deepEqual(
    parseRegistry(
      JSON.stringify({
        dev: ["/a", 3],
        disabled: ["x.y"],
        granted: { "x.y": ["fs.read", 1] },
        bundled: ["b.c"],
      }),
    ),
    {
      dev: ["/a"],
      disabled: ["x.y"],
      granted: { "x.y": ["fs.read"] },
      declined: {},
      bundled: ["b.c"],
      sources: {},
      customized: [],
      bisect: null,
      disabledIn: {},
      autoUpdate: {},
    },
  );
  // Where installed extensions came from (D185): bad entries are dropped.
  assert.deepEqual(
    parseRegistry(
      JSON.stringify({
        sources: {
          "a.b": { repo: "https://github.com/a/b.git", ref: "v1", path: "ext" },
          "c.d": { repo: 3 },
          "e.f": { repo: "x/y", ref: "" },
        },
      }),
    ).sources,
    {
      "a.b": { repo: "https://github.com/a/b.git", ref: "v1", path: "ext" },
      "e.f": { repo: "x/y" },
    },
  );
});

test("missingPermissions: a new version asking for more needs a new grant", () => {
  const m = parseManifest(
    { id: "a.b", version: "2", permissions: ["fs.read", "network:api.x.com"] },
    "extension.json",
  );
  assert.deepEqual(missingPermissions(m, ["fs.read"]), ["network:api.x.com"]);
  assert.deepEqual(missingPermissions(m, ["fs.read", "network:api.x.com"]), []);
});

test("joinRelative: theme includes stay inside the extension", () => {
  assert.equal(joinRelative("themes/dark.json", "./base.json"), "themes/base.json");
  assert.equal(joinRelative("themes/dark.json", "../shared/x.json"), "shared/x.json");
  assert.equal(joinRelative("dark.json", "base.json"), "base.json");
  assert.throws(() => joinRelative("dark.json", "../../etc/passwd"), /outside/);
});

test("parseSnippets: VS Code format, several prefixes, array bodies", () => {
  const out = parseSnippets(
    {
      Log: { prefix: ["log", "cl"], body: ["console.log($1);", "$0"], description: "Log" },
      Bad: { prefix: "x" },
      Named: { body: "x" },
    },
    "javascript",
    "a.b",
  );
  assert.deepEqual(
    out.map((s) => [s.prefix, s.body]),
    [
      ["log", "console.log($1);\n$0"],
      ["cl", "console.log($1);\n$0"],
      ["Named", "x"],
    ],
  );
});

test("themeKind: VS Code uiTheme values", () => {
  assert.equal(themeKind("vs"), "light");
  assert.equal(themeKind("hc-light"), "light");
  assert.equal(themeKind("vs-dark"), "dark");
  assert.equal(themeKind("hc-black"), "dark");
});

test("parseManifest: camelCase prefix for dashed names, reserved names need the full id", () => {
  const m = parseManifest(
    {
      id: "acme.todo-list",
      version: "1",
      contributes: { commands: [{ id: "todoList.show", title: "Show" }] },
    },
    "extension.json",
  );
  assert.equal(m.contributes.commands[0]?.id, "todoList.show");
  assert.throws(
    () =>
      parseManifest(
        {
          id: "acme.git",
          version: "1",
          contributes: { commands: [{ id: "git.push2", title: "x" }] },
        },
        "extension.json",
      ),
    /must start with acme\.git\./,
  );
});

test("D264: extensions start earliest installed first (their command ids are theirs)", () => {
  const records = [{ id: "aaa.python" }, { id: "dev.copy" }, { id: "ms-python.python" }];
  const order = startOrder(records, { "aaa.python": 2000, "ms-python.python": 1000 });
  assert.deepEqual(
    order.map((r) => r.id),
    ["dev.copy", "ms-python.python", "aaa.python"],
  );
  const registry = parseRegistry(JSON.stringify({ installedAt: { a: 5, b: "x", c: -1 } }));
  assert.deepEqual(registry.installedAt, { a: 5 });
});
