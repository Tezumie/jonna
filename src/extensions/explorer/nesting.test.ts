// biome-ignore-all lint/suspicious/noTemplateCurlyInString: VS Code's nesting placeholders
import assert from "node:assert/strict";
import { test } from "node:test";
import manifest from "./extension.json";
import { DEFAULT_NESTING_PATTERNS, nestFiles, nestingRules, withNestedFiles } from "./nesting";

const nest = (names: string[], patterns: unknown = DEFAULT_NESTING_PATTERNS, dir = "src") =>
  Object.fromEntries(nestFiles(names, nestingRules(patterns), dir));

test("file nesting with VS Code's default patterns (D201)", () => {
  assert.deepEqual(
    nest([
      "a.ts",
      "a.js",
      "a.js.map",
      "a.d.ts",
      "b.js",
      "b.min.js",
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "tsconfig.json",
      "tsconfig.build.json",
      "README.md",
    ]),
    {
      // One level deep: a.js's own children go under a.ts too.
      "a.ts": ["a.d.ts", "a.js", "a.js.map"],
      "b.js": ["b.min.js"],
      "package.json": ["package-lock.json", "pnpm-lock.yaml"],
      "tsconfig.json": ["tsconfig.build.json"],
    },
  );
  // The setting's default is the same list.
  assert.deepEqual(
    manifest.contributes.settings["explorer.fileNesting.patterns"].default,
    DEFAULT_NESTING_PATTERNS,
  );
  // Nothing to nest under: no change.
  assert.deepEqual(nest(["a.js.map", "README.md"]), {});
  assert.deepEqual(nest(["a.ts"]), {});
});

test("file nesting: variables, wildcards, case and cycles", () => {
  assert.deepEqual(
    nest(["Component.tsx", "Component.module.css", "component.test.tsx", "Other.css"], {
      "*.tsx": "${capture}.*.css, ${capture}.test.tsx",
    }),
    { "Component.tsx": ["Component.module.css", "component.test.tsx"] },
  );
  assert.deepEqual(
    nest(["index.html", "index.css", "app.html"], { "*.html": "${basename}.css, ${extname}.x" }),
    { "index.html": ["index.css"] },
  );
  assert.deepEqual(nest(["main.go", "main.src.txt"], { "*.go": "${dirname}.txt" }, "main.src"), {
    "main.go": ["main.src.txt"],
  });
  // Two files that name each other stay at the top.
  assert.deepEqual(nest(["a.x", "a.y"], { "*.x": "${capture}.y", "*.y": "${capture}.x" }), {});
  // Bad entries are left out.
  assert.deepEqual(nestingRules({ "a*b*": "x", "dir/x": "y", "*.z": 3, "*.q": " , " }), []);
  assert.deepEqual(nestingRules(null), []);
});

test("a folder of thousands of files nests quickly", () => {
  const names: string[] = [];
  for (let i = 0; i < 5000; i++) names.push(`f${i}.js`, `f${i}.js.map`);
  const started = Date.now();
  const out = nest(names);
  assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`);
  assert.deepEqual(out["f7.js"], ["f7.js.map"]);
});

test("a collapsed nest parent takes its nested files along (D203)", () => {
  const nested: Record<string, string[]> = {
    "/w/a.ts": ["/w/a.js", "/w/a.js.map"],
    "/w/package.json": ["/w/package-lock.json"],
  };
  const expanded = new Set(["/w/package.json"]);
  const run = (paths: string[]) =>
    withNestedFiles(
      paths,
      (p) => nested[p],
      (p) => !expanded.has(p),
    );
  // Collapsed: the nested files follow their parent, in order.
  assert.deepEqual(run(["/w/a.ts", "/w/b.ts"]), ["/w/a.ts", "/w/a.js", "/w/a.js.map", "/w/b.ts"]);
  // Expanded: only what is selected (VS Code).
  assert.deepEqual(run(["/w/package.json"]), ["/w/package.json"]);
  // A nested file selected as well is listed once.
  assert.deepEqual(run(["/w/a.js", "/w/a.ts"]), ["/w/a.js", "/w/a.ts", "/w/a.js.map"]);
  assert.deepEqual(run([]), []);
});
