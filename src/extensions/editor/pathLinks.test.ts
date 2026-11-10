import assert from "node:assert/strict";
import { test } from "node:test";
import { findPathCandidates, resolveCandidate } from "./pathLinks";

const paths = (text: string) => findPathCandidates(text).map((c) => c.path);

test("finds file paths with line and column suffixes", () => {
  assert.deepEqual(paths('import "./styles/app.css";'), ["./styles/app.css"]);
  assert.deepEqual(paths("see docs/notes.md and README.md"), ["docs/notes.md", "README.md"]);
  const [c] = findPathCandidates("error in src/main.ts:12:5 here");
  assert.equal(c?.path, "src/main.ts");
  assert.equal(c?.line, 12);
  assert.equal(c?.column, 5);
  const [w] = findPathCandidates("C:\\work\\a.ts(3,7): error");
  assert.equal(w?.path, "C:\\work\\a.ts");
  assert.equal(w?.line, 3);
  assert.equal(w?.column, 7);
});

test("skips URLs, versions, domains, module names and plain words", () => {
  assert.deepEqual(paths("https://example.com/a/b.html"), []);
  assert.deepEqual(paths("version 1.2.3 of react from ./util"), []);
  assert.deepEqual(paths("visit example.com or obj.prop"), []);
  assert.deepEqual(paths("console.log(x)"), []);
});

test("resolves relative to the file, then the workspace", () => {
  assert.deepEqual(resolveCandidate("./a.css", "/w/src", "/w"), ["/w/src/a.css"]);
  assert.deepEqual(resolveCandidate("../b.ts", "/w/src/x", "/w"), ["/w/src/b.ts"]);
  assert.deepEqual(resolveCandidate("src/c.ts", "/w/src", "/w"), [
    "/w/src/src/c.ts",
    "/w/src/c.ts",
  ]);
  assert.deepEqual(resolveCandidate("/abs/d.ts", "/w", "/w"), ["/abs/d.ts"]);
  assert.deepEqual(resolveCandidate("lib/e.ts", "C:\\w\\src", "C:\\w"), [
    "C:\\w\\src\\lib\\e.ts",
    "C:\\w\\lib\\e.ts",
  ]);
});
