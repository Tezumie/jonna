import assert from "node:assert/strict";
import { test } from "node:test";
import { globToRegExp, isExcluded } from "./glob";

test("globs", () => {
  assert.ok(globToRegExp("**/.git").test(".git"));
  assert.ok(globToRegExp("**/.git").test("a/b/.git"));
  assert.ok(globToRegExp("**/node_modules").test("pkg/node_modules/x/y.js"));
  assert.ok(globToRegExp("*.log").test("debug.log"));
  assert.ok(!globToRegExp("*.log").test("logs/debug.log"));
  assert.ok(globToRegExp("**/*.{js,map}").test("dist/a.map"));
  assert.ok(globToRegExp("src/[ab].ts").test("src/a.ts"));
  assert.ok(isExcluded("out/x.js", { out: true, dist: false }));
  assert.ok(!isExcluded("dist/x.js", { out: true, dist: false }));
});

test("globs: nested and unbalanced braces, invalid classes", () => {
  const nested = globToRegExp("{a,{b,c}}.ts");
  for (const name of ["a.ts", "b.ts", "c.ts"]) assert.ok(nested.test(name), name);
  assert.ok(!nested.test("d.ts"));
  assert.ok(!nested.test("{b.ts"));
  // An unclosed `{` and a stray `}` are literal characters, not a broken RegExp.
  assert.ok(globToRegExp("{a,b").test("{a,b"));
  assert.ok(!globToRegExp("{a,b").test("a"));
  assert.ok(globToRegExp("a}.txt").test("a}.txt"));
  assert.ok(globToRegExp("{x,y}}").test("x}"));
  // A pattern that is still invalid (reversed range) matches nothing instead of throwing.
  assert.doesNotThrow(() => globToRegExp("[z-a].ts"));
  assert.ok(!globToRegExp("[z-a].ts").test("a.ts"));
  assert.ok(!isExcluded("src/a.ts", { "{src,lib": true, "[z-a]": true }));
});

test("globs: repeated **/ compile to one (no exponential backtracking); same matches", () => {
  const deep = `${"a/".repeat(40)}y`;
  const started = performance.now();
  assert.equal(globToRegExp("**/**/**/**/**/**/**/**/**/**/x").test(deep), false);
  assert.equal(globToRegExp("src/**/**/**").test(`src/${deep}`), true);
  assert.ok(performance.now() - started < 1_000);
  assert.equal(globToRegExp("**/**/x").test("x"), true);
  assert.equal(globToRegExp("**/**/x").test("a/b/x"), true);
  assert.equal(globToRegExp("a/**/**/b").test("a/b"), true);
  assert.equal(globToRegExp("a/**/**/b").test("a/c/d/b"), true);
});
