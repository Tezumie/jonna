import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type GrepArgs,
  type GrepFile,
  grepArgs,
  grepIgnoresCase,
  grepPage,
  grepResult,
  includeGlobs,
  matchesType,
  sortFiles,
} from "./grep";

const args = (a: Record<string, unknown>): GrepArgs => {
  const r = grepArgs(a);
  if ("error" in r) throw new Error(r.error);
  return r;
};

const m = (line: number, text: string, ranges: [number, number][] = []) => ({
  line,
  text,
  ranges,
});

test("D306: Claude Code's names, the readable ones and the old ones all work", () => {
  const cc = args({ pattern: "a+b", "-A": 2, "-B": "1", "-i": true, "-n": false, "-o": true });
  assert.equal(cc.regex, true);
  assert.equal(cc.after, 2);
  assert.equal(cc.before, 1);
  assert.equal(cc.ignoreCase, true);
  assert.equal(cc.lineNumbers, false);
  assert.equal(cc.onlyMatching, true);
  assert.equal(cc.mode, "content");
  assert.equal(cc.headLimit, 250);
  const readable = args({ pattern: "x", context: 3, ignore_case: false, output_mode: "count" });
  assert.equal(readable.before, 3);
  assert.equal(readable.after, 3);
  assert.equal(readable.ignoreCase, false);
  assert.equal(readable.mode, "count");
  // The old query is literal unless regex: true.
  const old = args({ query: "a.b", include: ["src", "*.ts"] });
  assert.equal(old.regex, false);
  assert.deepEqual(old.include, ["src", "*.ts"]);
  assert.equal(args({ query: "a.b", regex: true }).regex, true);
  assert.equal(args({ pattern: "a.b", regex: false }).regex, false);
  assert.equal(args({ pattern: "x", "-C": 99 }).after, 20);
  assert.equal(args({ pattern: "x", head_limit: 0 }).headLimit, 0);
  assert.match(String((grepArgs({}) as { error: string }).error), /pattern/);
  assert.match(
    String((grepArgs({ pattern: "x", type: "cobol" }) as { error: string }).error),
    /glob/,
  );
  assert.match(
    String((grepArgs({ pattern: "x", output_mode: "nope" }) as { error: string }).error),
    /files_with_matches/,
  );
});

test("D306: smart case unless -i says otherwise", () => {
  assert.equal(grepIgnoresCase(args({ pattern: "todo" })), true);
  assert.equal(grepIgnoresCase(args({ pattern: "TODO" })), false);
  assert.equal(grepIgnoresCase(args({ pattern: "TODO", "-i": true })), true);
  assert.equal(grepIgnoresCase(args({ pattern: "todo", "-i": false })), false);
});

test("D306: path, glob and type make the include globs", () => {
  const a = (x: Record<string, unknown>) => args({ pattern: "x", ...x });
  assert.deepEqual(includeGlobs(a({}), null), []);
  assert.deepEqual(includeGlobs(a({ glob: "*.ts" }), null), ["*.ts"]);
  assert.deepEqual(includeGlobs(a({ type: "js" }), null), ["*.{js,jsx,mjs,cjs}"]);
  assert.deepEqual(includeGlobs(a({ type: "rust" }), null), ["*.rs"]);
  assert.deepEqual(includeGlobs(a({}), { rel: "src", isFile: false }), ["src/**"]);
  assert.deepEqual(includeGlobs(a({ glob: "*.ts" }), { rel: "src/", isFile: false }), [
    "src/**/*.ts",
  ]);
  assert.deepEqual(includeGlobs(a({ glob: "**/*.tsx" }), { rel: "web", isFile: false }), [
    "web/**/*.tsx",
  ]);
  assert.deepEqual(includeGlobs(a({ glob: "lib/*.ts" }), { rel: "web", isFile: false }), [
    "web/lib/*.ts",
  ]);
  // A folder's glob characters are literal.
  assert.deepEqual(includeGlobs(a({}), { rel: "app/[id]", isFile: false }), ["app/[[]id[]]/**"]);
  assert.deepEqual(includeGlobs(a({ glob: "*.ts" }), { rel: "src/a.ts", isFile: true }), [
    "src/a.ts",
  ]);
  assert.deepEqual(includeGlobs(a({}), { rel: ".", isFile: false }), []);
  assert.deepEqual(includeGlobs(a({ include: ["docs"] }), null), ["docs"]);
  assert.equal(matchesType("src/a.TS", "ts"), true);
  assert.equal(matchesType("src/a.js", "ts"), false);
  assert.equal(matchesType("src/a.js", null), true);
});

const files: GrepFile[] = sortFiles([
  { path: "src/b.ts", matches: [m(9, "b9"), m(2, "b2")] },
  { path: "src/a.ts", matches: [m(3, "a3 foo", [[3, 6]]), m(4, "a4 foo", [[3, 6]])] },
  { path: "c.md", matches: [m(1, "c1")] },
]);

test("D306: files sort by path and matches by line, so pages are stable", () => {
  assert.deepEqual(
    files.map((f) => f.path),
    ["c.md", "src/a.ts", "src/b.ts"],
  );
  assert.deepEqual(
    files[2]?.matches.map((x) => x.line),
    [2, 9],
  );
});

test("D306: content mode pages over matching lines and says how to get the rest", () => {
  const a = args({ pattern: "x", head_limit: 2 });
  const page = grepPage(files, a);
  assert.equal(page.total, 5);
  const text = grepResult(page, a, () => null);
  assert.equal(
    text,
    "c.md:1: c1\nsrc/a.ts:3: a3 foo\n… 3 more matching lines (showing 1-2 of 5): pass offset: 2 for the next page, or narrow the search with path, glob or type.",
  );
  const next = args({ pattern: "x", head_limit: 2, offset: 2 });
  const second = grepResult(grepPage(files, next), next, () => null);
  assert.match(
    second,
    /^src\/a\.ts:4: a4 foo\nsrc\/b\.ts:2: b2\n… 1 more matching lines \(showing 3-4 of 5\): pass offset: 4/,
  );
  const last = args({ pattern: "x", offset: 4 });
  assert.equal(
    grepResult(grepPage(files, last), last, () => null),
    "src/b.ts:9: b9\n(matching lines 5-5 of 5)",
  );
  const past = args({ pattern: "x", offset: 9 });
  assert.match(
    grepResult(grepPage(files, past), past, () => null),
    /past the end: there are 5/,
  );
});

test("D306: files and count modes", () => {
  const f = args({ pattern: "x", output_mode: "files_with_matches" });
  assert.equal(
    grepResult(grepPage(files, f), f, () => null),
    "c.md\nsrc/a.ts\nsrc/b.ts",
  );
  const c = args({ pattern: "x", output_mode: "count", head_limit: 2 });
  assert.equal(
    grepResult(grepPage(files, c), c, () => null),
    "c.md:1\nsrc/a.ts:2\n… 1 more files with counts (showing 1-2 of 3): pass offset: 2 for the next page, or narrow the search with path, glob or type.\n3 matching lines in these 2 files.",
  );
  assert.equal(
    grepResult(grepPage([], c), c, () => null, ["(note)"]),
    "No matches.\n(note)",
  );
});

test("D306: context lines around matches, merged when they overlap", () => {
  const lines = ["l1", "l2", "a3 foo", "a4 foo", "l5", "l6", "l7", "l8", "l9"];
  const a = args({ pattern: "foo", "-C": 1, path: "src/a.ts" });
  const one: GrepFile[] = [
    { path: "src/a.ts", matches: [m(3, "a3 foo"), m(4, "a4 foo"), m(8, "l8")] },
  ];
  assert.equal(
    grepResult(grepPage(one, a), a, () => lines),
    [
      "src/a.ts-2- l2",
      "src/a.ts:3: a3 foo",
      "src/a.ts:4: a4 foo",
      "src/a.ts-5- l5",
      "--",
      "src/a.ts-7- l7",
      "src/a.ts:8: l8",
      "src/a.ts-9- l9",
    ].join("\n"),
  );
  // Without line numbers, and -o shows only the matched parts.
  const plain = args({ pattern: "foo", "-n": false });
  assert.equal(
    grepResult(grepPage(files.slice(1, 2), plain), plain, () => null),
    "src/a.ts: a3 foo\nsrc/a.ts: a4 foo",
  );
  const only = args({ pattern: "foo", "-o": true });
  assert.equal(
    grepResult(grepPage(files.slice(1, 2), only), only, () => null),
    "src/a.ts:3: foo\nsrc/a.ts:4: foo",
  );
});

test("D306: a long result ends early at a match and names the next offset", () => {
  const big: GrepFile[] = [
    { path: "big.txt", matches: Array.from({ length: 200 }, (_, i) => m(i + 1, "x".repeat(200))) },
  ];
  const a = args({ pattern: "x" });
  const text = grepResult(grepPage(big, a), a, () => null);
  assert.ok(text.length < 21_000);
  const shown = text.split("\n").filter((l) => l.startsWith("big.txt:")).length;
  assert.ok(shown < 200);
  assert.match(text, new RegExp(`pass offset: ${shown} for the next page\\.`));
});
