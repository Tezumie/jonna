import assert from "node:assert/strict";
import { test } from "node:test";
import type { SearchOptions } from "../../core/ipc/fs";
import {
  effectiveOptions,
  folderTree,
  formatResults,
  InputHistory,
  preserveCase,
  previewReplacement,
  SearchModel,
  sameSearch,
  searchRegExp,
} from "./model";

const base: SearchOptions = {
  query: "a.b",
  isRegex: false,
  matchCase: false,
  wholeWord: false,
  include: [],
  exclude: [],
};

test("literal queries are escaped; whole word wraps in \\b", () => {
  assert.equal(searchRegExp(base)?.test("xa.by"), true);
  assert.equal(searchRegExp(base)?.test("axb"), false);
  assert.equal(searchRegExp({ ...base, query: "foo", wholeWord: true })?.test("food"), false);
});

test("regex previews expand captures; literal previews don't", () => {
  const re = { ...base, query: "(\\w+)-(\\w+)", isRegex: true };
  assert.equal(previewReplacement("ab-cd", re, "$2-$1"), "cd-ab");
  assert.equal(previewReplacement("a.b", base, "$1"), "$1");
});

test("events of an older search are ignored and done resolves waiters", async () => {
  const model = new SearchModel();
  const first = model.begin(base);
  const second = model.begin({ ...base, query: "x" });
  first({ kind: "file", path: "/a", rel: "a", matches: [{ line: 1, text: "a", ranges: [] }] });
  assert.equal(model.files.length, 0);
  const done = model.whenDone();
  second({
    kind: "file",
    path: "/b",
    rel: "b",
    matches: [{ line: 2, text: "x", ranges: [[0, 1]] }],
  });
  second({ kind: "done", files: 1, matches: 1, truncated: false, cancelled: false, durationMs: 3 });
  await done;
  assert.equal(model.matchCount, 1);
  assert.equal(model.running, false);
});

test("dismiss: a match by line, then the whole file when empty", () => {
  const m = new SearchModel();
  const sink = m.begin({
    query: "a",
    isRegex: false,
    matchCase: false,
    wholeWord: false,
    include: [],
    exclude: [],
  });
  sink({
    kind: "file",
    path: "/w/a.ts",
    rel: "a.ts",
    matches: [
      { line: 1, text: "a", ranges: [[0, 1]] },
      { line: 2, text: "a", ranges: [[0, 1]] },
    ],
  } as never);
  assert.equal(m.dismiss("/w/a.ts", 1), true);
  assert.equal(m.matchCount, 1);
  assert.equal(m.dismiss("/w/a.ts", 2), true);
  assert.equal(m.files.length, 0);
  assert.equal(m.dismiss("/w/a.ts"), false);
});

test("a folder taken out of the workspace takes its results with it", () => {
  const m = new SearchModel();
  const sink = m.begin({
    query: "a",
    isRegex: false,
    matchCase: false,
    wholeWord: false,
    include: [],
    exclude: [],
  });
  for (const path of ["/w/a.ts", "/x/api/b.ts"])
    sink({ kind: "file", path, rel: path, matches: [] } as never);
  let changes = 0;
  m.onDidChange(() => changes++);
  assert.equal(
    m.keepFiles((f) => !f.path.startsWith("/x/api/")),
    1,
  );
  assert.deepEqual(
    m.files.map((f) => f.path),
    ["/w/a.ts"],
  );
  assert.equal(
    m.keepFiles(() => true),
    0,
  );
  assert.equal(changes, 1);
});

test("preserve case follows the match's pattern", () => {
  assert.equal(preserveCase("FOO", "bar"), "BAR");
  assert.equal(preserveCase("foo", "Bar"), "bar");
  assert.equal(preserveCase("Foo", "bar"), "Bar");
  assert.equal(preserveCase("fOo", "bar"), "bar");
  assert.equal(previewReplacement("Foo", { ...base, preserveCase: true }, "bar"), "Bar");
});

test("effective options apply exclude settings, smart case and open editors", () => {
  const cfg = {
    filesExclude: { "**/.git": true, "**/off": false },
    searchExclude: { "**/node_modules": true },
    useIgnoreFiles: true,
    followSymlinks: true,
    smartCase: true,
    maxResults: 100,
  };
  const q = { ...base, query: "Foo", exclude: ["dist"] };
  const o = effectiveOptions(q, cfg, ["a.ts"]);
  assert.deepEqual(o.exclude, ["dist", "**/.git", "**/node_modules"]);
  assert.equal(o.matchCase, true);
  assert.equal(o.useIgnoreFiles, true);
  assert.equal(o.maxResults, 100);
  assert.equal("useExcludeSettings" in o, false);
  const off = effectiveOptions(
    { ...q, query: "foo", useExcludeSettings: false, onlyOpenEditors: true },
    cfg,
    ["a.ts"],
  );
  assert.deepEqual(off.exclude, ["dist"]);
  assert.equal(off.useIgnoreFiles, false);
  assert.equal(off.matchCase, false);
  assert.deepEqual(off.include, ["a.ts"]);
  assert.equal(sameSearch(o, { ...o, preserveCase: true, lines: [3] }), true);
  assert.equal(sameSearch(o, { ...o, query: "x" }), false);
});

test("results copy as path then numbered lines", () => {
  const files = [
    { path: "/w/a.ts", rel: "a.ts", matches: [{ line: 3, text: "  foo()", ranges: [] }] },
  ];
  assert.equal(formatResults(files), "a.ts\n  3: foo()");
});

test("results as a folder tree: folders first, sorted, single-child folders compacted (D172)", () => {
  const f = (rel: string, n = 1) => ({
    path: `/w/${rel}`,
    rel,
    matches: Array.from({ length: n }, (_, i) => ({
      line: i + 1,
      text: "x",
      ranges: [[0, 1]] as [number, number][],
    })),
  });
  const root = folderTree([
    f("src/core/a.ts", 2),
    f("README.md"),
    f("src/core/b.ts"),
    f("src/main.ts"),
    f("docs/deep/er/x.md"),
  ]);
  assert.equal(root.count, 6);
  assert.deepEqual(
    root.files.map((x) => x.rel),
    ["README.md"],
  );
  assert.deepEqual(
    root.folders.map((x) => [x.name, x.rel, x.count]),
    [
      ["docs/deep/er", "docs/deep/er", 1],
      ["src", "src", 4],
    ],
  );
  const src = root.folders[1];
  assert.deepEqual(
    src?.folders.map((x) => [x.name, x.count]),
    [["core", 3]],
  );
  assert.deepEqual(
    src?.files.map((x) => x.rel),
    ["src/main.ts"],
  );
  assert.deepEqual(
    src?.folders[0]?.files.map((x) => x.rel),
    ["src/core/a.ts", "src/core/b.ts"],
  );
  // Windows separators group the same way.
  assert.equal(folderTree([f("src\\a.ts")]).folders[0]?.name, "src");
});

test("search history: Up / Down from what's typed, like VS Code (D172)", () => {
  const h = new InputHistory(["alpha", "beta"]);
  assert.equal(h.previous("draft"), "beta");
  assert.equal(h.previous("beta"), "alpha");
  assert.equal(h.previous("alpha"), undefined);
  assert.equal(h.next(), "beta");
  assert.equal(h.next(), "draft");
  assert.equal(h.next(), undefined);
  // Just searched "beta": the first Up skips it.
  h.add("beta");
  assert.equal(h.previous("beta"), "alpha");
  h.reset();
  // A repeat moves to the end; empty isn't remembered.
  h.add("alpha");
  h.add("  ");
  assert.deepEqual(h.entries, ["beta", "alpha"]);
  assert.equal(new InputHistory().previous("x"), undefined);
});
