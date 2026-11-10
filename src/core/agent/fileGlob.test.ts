import assert from "node:assert/strict";
import { test } from "node:test";
import { byNewest, globMatcher, isGlob } from "./fileGlob";

test("D307: glob characters make a glob; a plain name stays fuzzy", () => {
  assert.equal(isGlob("**/*.ts"), true);
  assert.equal(isGlob("src/{a,b}.js"), true);
  assert.equal(isGlob("main.ts"), false);
  assert.equal(isGlob("src/main"), false);
});

test("D307: patterns match whole paths, a name pattern at any depth", () => {
  const ts = globMatcher("**/*.ts");
  assert.equal(ts("a.ts"), true);
  assert.equal(ts("src/deep/b.ts"), true);
  assert.equal(ts("src/b.tsx"), false);
  const anyDepth = globMatcher("*.md");
  assert.equal(anyDepth("README.md"), true);
  assert.equal(anyDepth("docs/guide/x.md"), true);
  const top = globMatcher("src/*");
  assert.equal(top("src/a.ts"), true);
  assert.equal(top("src/a/b.ts"), false);
  const all = globMatcher("src/**");
  assert.equal(all("src/a/b.ts"), true);
  assert.equal(all("lib/a.ts"), false);
  const braces = globMatcher("src/*.{js,ts}");
  assert.equal(braces("src/x.js"), true);
  assert.equal(braces("src/x.css"), false);
});

test("D307: a base folder: the pattern is relative to it", () => {
  const m = globMatcher("*.ts", "src");
  assert.equal(m("src/a.ts"), true);
  assert.equal(m("src/sub/a.ts"), true);
  assert.equal(m("lib/a.ts"), false);
  const direct = globMatcher("sub/*.ts", "src/");
  assert.equal(direct("src/sub/a.ts"), true);
  assert.equal(direct("sub/a.ts"), false);
});

test("D307: newest first, then by path", () => {
  assert.deepEqual(
    byNewest([
      { rel: "b", mtime: 1 },
      { rel: "a", mtime: 5 },
      { rel: "c", mtime: null },
      { rel: "a2", mtime: 1 },
    ]),
    ["a", "a2", "b", "c"],
  );
});
