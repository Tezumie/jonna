import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExternalProblem } from "../../workbench/services";
import { MAX_PROBLEMS, ProblemCollector, resolveMatchers, stripEscapes } from "./problemMatchers";

const ROOT = "/work/app";

function run(matcher: unknown, output: string): ExternalProblem[] {
  const { matchers } = resolveMatchers(matcher, ROOT);
  const c = new ProblemCollector(matchers);
  c.feed(output);
  c.end();
  return c.problems();
}

test("$tsc reads tsc's errors relative to the folder", () => {
  const out = [
    "src/main.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "\x1b[96msrc/util.ts\x1b[0m:\x1b[93m10\x1b[0m:\x1b[93m2\x1b[0m - \x1b[91merror\x1b[0m TS1005: ';' expected.",
    "Found 2 errors.",
  ].join("\r\n");
  const problems = run("$tsc", out);
  assert.equal(problems.length, 2);
  assert.deepEqual(
    { ...problems[0], message: problems[0]?.message.slice(0, 4) },
    {
      path: "/work/app/src/main.ts",
      severity: "error",
      message: "Type",
      source: "ts",
      code: "2322",
      line: 3,
      column: 7,
      endLine: 3,
      endColumn: 1000,
    },
  );
  assert.equal(problems[1]?.path, "/work/app/src/util.ts");
  assert.equal(problems[1]?.line, 10);
});

test("$eslint-stylish: a file line, then one line per problem (loop)", () => {
  const out = [
    "/work/app/src/a.js",
    "  1:10  error    'x' is defined but never used  no-unused-vars",
    "  4:1   warning  Unexpected console statement   no-console",
    "",
    "/work/app/src/b.js",
    "  2:3  error  Missing semicolon  semi",
    "",
    "✖ 3 problems (2 errors, 1 warning)",
  ].join("\n");
  const problems = run("$eslint-stylish", out);
  assert.deepEqual(
    problems.map((p) => [p.path, p.line, p.column, p.severity, p.code]),
    [
      ["/work/app/src/a.js", 1, 10, "error", "no-unused-vars"],
      ["/work/app/src/a.js", 4, 1, "warning", "no-console"],
      ["/work/app/src/b.js", 2, 3, "error", "semi"],
    ],
  );
});

test("$gcc and $msCompile", () => {
  const gcc = run("$gcc", "main.c:5:3: error: expected ';' before 'return'\n");
  assert.deepEqual([gcc[0]?.path, gcc[0]?.line, gcc[0]?.column], ["/work/app/main.c", 5, 3]);
  const ms = run(
    "$msCompile",
    "C:\\src\\app.cpp(12,4): error C2065: 'y': undeclared identifier [C:\\src\\app.vcxproj]\n",
  );
  assert.equal(ms[0]?.path, "C:\\src\\app.cpp");
  assert.deepEqual([ms[0]?.line, ms[0]?.column, ms[0]?.code], [12, 4, "C2065"]);
});

test("a custom matcher, its defaults and `base`", () => {
  const custom = run(
    {
      owner: "x",
      fileLocation: ["relative", "${workspaceFolder}/web"],
      pattern: { regexp: "^(.*):(\\d+): (.*)$" },
    },
    "page.ts:4: bad thing\n",
  );
  assert.deepEqual(
    [custom[0]?.path, custom[0]?.line, custom[0]?.message],
    ["/work/app/web/page.ts", 4, "bad thing"],
  );
  const based = run(
    { base: "$tsc", severity: "warning", fileLocation: "absolute" },
    "/x/y.ts(1,2): error TS1: z\n",
  );
  assert.equal(based[0]?.path, "/x/y.ts");
  const { unknown } = resolveMatchers(["$nope", { base: "$missing" }], ROOT);
  assert.deepEqual(unknown, ["$nope", "$missing"]);
});

test("$tsc-watch: each rebuild replaces the last one's problems", () => {
  const { matchers } = resolveMatchers("$tsc-watch", ROOT);
  const c = new ProblemCollector(matchers);
  const seen: number[] = [];
  c.onChange = (p) => seen.push(p.length);
  c.feed("[10:00:00 AM] Starting compilation in watch mode...\n");
  c.feed("a.ts(1,1): error TS1: one\n");
  assert.equal(c.ready, false);
  c.feed("[10:00:02 AM] Found 1 error. Watching for file changes.\n");
  assert.equal(c.ready, true);
  assert.equal(c.problems().length, 1);
  c.feed("[10:01:00 AM] File change detected. Starting incremental compilation...\n");
  assert.equal(c.problems().length, 1, "the last build's problems stay until new ones come");
  c.feed("[10:01:01 AM] Found 0 errors. Watching for file changes.\n");
  assert.equal(c.problems().length, 0);
});

test("stripEscapes removes colors and titles", () => {
  assert.equal(stripEscapes("\x1b]0;title\x07\x1b[1;31mred\x1b[0m"), "red");
});

test("escapes split across chunks and progress redraws don't corrupt lines", () => {
  const { matchers } = resolveMatchers("$tsc", ROOT);
  const c = new ProblemCollector(matchers);
  c.feed("\x1b[3");
  c.feed("1msrc/a.ts(1,2): error TS1: one\x1b[0m\n");
  c.feed("\r[=====] 50%\rsrc/b.ts(3,4): error TS2: two\r\n");
  c.end();
  assert.deepEqual(
    c.problems().map((p) => [p.path, p.line]),
    [
      ["/work/app/src/a.ts", 1],
      ["/work/app/src/b.ts", 3],
    ],
  );
});

test("extensions' named matchers and patterns ($name, base, pattern by name)", () => {
  const named = {
    matchers: new Map<string, unknown>([
      ["lintr", { owner: "lintr", fileLocation: "relative", pattern: "$lintr-line" }],
      ["inline", { owner: "inline", pattern: { regexp: "^(\\S+):(\\d+) (.*)$" } }],
    ]),
    patterns: new Map<string, unknown>([
      [
        "lintr-line",
        {
          regexp: "^(\\S+):(\\d+):(\\d+): (\\w+): (.*)$",
          file: 1,
          line: 2,
          column: 3,
          severity: 4,
          message: 5,
        },
      ],
    ]),
  };
  const { matchers, unknown } = resolveMatchers(
    ["$lintr", { base: "$inline", owner: "mine" }, "$nope", { pattern: "$missing" }],
    ROOT,
    named,
  );
  assert.deepEqual(unknown, ["$nope", "$missing"]);
  assert.equal(matchers.length, 2);
  const c = new ProblemCollector(matchers);
  c.feed("src/a.R:3:5: warning: line too long\nb.txt:7 bad thing\n");
  c.end();
  const problems = c.problems();
  assert.equal(problems.length, 2);
  const lint = problems.find((p) => p.message === "line too long");
  assert.equal(lint?.severity, "warning");
  assert.equal(lint?.line, 3);
  assert.equal(lint?.column, 5);
  assert.ok(problems.some((p) => p.message === "bad thing" && p.line === 7));
  // Without them, the names are unknown.
  assert.deepEqual(resolveMatchers("$lintr", ROOT).unknown, ["$lintr"]);
});

test("a long-running task keeps at most MAX_PROBLEMS problems, the newest", () => {
  const { matchers } = resolveMatchers("$tsc", ROOT);
  const c = new ProblemCollector(matchers);
  const total = MAX_PROBLEMS + 50;
  for (let i = 1; i <= total; i++) c.feed(`src/a.ts(${i},1): error TS1005: ';' expected.\n`);
  const problems = c.problems();
  assert.equal(problems.length, MAX_PROBLEMS);
  assert.equal(problems[0]?.line, 51);
  assert.equal(problems.at(-1)?.line, total);
});
