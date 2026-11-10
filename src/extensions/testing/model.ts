// The Testing view's model (D149), DOM-free and tested: which test frameworks a project uses,
// the tests in a file (read from its text, as VS Code's test extensions do before anything runs),
// the command that runs all of them, a file or one test, and the results read back from each
// framework's output (Vitest / Jest JSON, pytest's summary, cargo test, go test -json, node:test
// TAP). Mocha, Playwright and unittest's own parts are in frameworks.ts, coverage in coverage.ts.
import { fromJestFailureDetails, fromMessage, fromTapYaml } from "./assertions";

export type Framework =
  | "vitest"
  | "jest"
  | "node"
  | "mocha"
  | "playwright"
  | "pytest"
  | "unittest"
  | "cargo"
  | "go";

export const FRAMEWORKS: readonly Framework[] = [
  "vitest",
  "jest",
  "node",
  "mocha",
  "playwright",
  "pytest",
  "unittest",
  "cargo",
  "go",
];

export type TestStatus = "unknown" | "running" | "passed" | "failed" | "skipped";

export interface TestCase {
  /** Stable across runs: framework, file and the names from the outermost suite in. */
  id: string;
  framework: Framework;
  /** Relative to the workspace root, with `/`. */
  file: string;
  /** Suites, then the test's own name. */
  path: string[];
  /** 1-based. */
  line: number;
  /** Playwright: the config project the test runs in ("chromium"). */
  runnerProject?: string;
}

export interface TestResult {
  status: Exclude<TestStatus, "unknown" | "running">;
  durationMs?: number;
  message?: string;
  /** A failed assertion's values, when the framework reported or printed them. */
  expected?: string;
  actual?: string;
  /**
   * The test's own output (D209), where the framework reports it per test: Go's events, pytest's
   * captured output, cargo's stdout block, node:test's diagnostics, Jest / Vitest's full failure
   * messages with their stacks.
   */
  output?: string;
}

export const FRAMEWORK_LABEL: Record<Framework, string> = {
  vitest: "Vitest",
  jest: "Jest",
  node: "node:test",
  mocha: "Mocha",
  playwright: "Playwright",
  pytest: "pytest",
  unittest: "unittest",
  cargo: "cargo test",
  go: "go test",
};

/** Adds a failure's expected and actual values to its result, when found. */
function withComparison(
  r: TestResult,
  ea: { expected: string; actual: string } | null,
): TestResult {
  return ea ? { ...r, expected: ea.expected, actual: ea.actual } : r;
}

export function testId(framework: Framework, file: string, path: readonly string[]): string {
  return `${framework}:${file}::${path.join(" › ")}`;
}

// ---- Discovery ----------------------------------------------------------------------------------

/** Glob patterns of test files per language (search include patterns). */
export const TEST_FILE_GLOBS = {
  js: ["**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}", "**/__tests__/**/*.{js,jsx,ts,tsx}"],
  py: ["**/test_*.py", "**/*_test.py"],
  rs: ["**/*.rs"],
  go: ["**/*_test.go"],
};

const JS_CALL =
  /\b(describe|suite|context|it|test|specify)((?:\.(?:only|skip|todo|concurrent|sequential|fails))*)(?:\.each\s*(?:\([^)]*\)|`[^`]*`)\s*)?\s*\(\s*(['"`])((?:\\.|(?!\3)[^\\\n])*)\3/y;

/**
 * Tests in JavaScript / TypeScript: `describe` / `suite` / `context` blocks (nested by their
 * braces) and `it` / `test` / `specify` calls, with string, template or quoted names. A light
 * scan (strings and comments skipped), not a parser: dynamic names are kept as written.
 */
export function discoverJs(text: string, file: string, framework: Framework): TestCase[] {
  const out: TestCase[] = [];
  const suites: { name: string; depth: number }[] = [];
  let depth = 0;
  let line = 1;
  let i = 0;
  const n = text.length;
  let prev = "";
  while (i < n) {
    const c = text[i] ?? "";
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    // Comments.
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let k = i; k < stop; k++) if (text[k] === "\n") line++;
      i = stop;
      continue;
    }
    // A test or suite call where an identifier starts.
    if (/[a-z]/.test(c) && !/[\w$.]/.test(prev)) {
      JS_CALL.lastIndex = i;
      const m = JS_CALL.exec(text);
      if (m) {
        const kind = m[1] ?? "";
        const name = (m[4] ?? "").replace(/\\(.)/g, "$1");
        if (kind === "describe" || kind === "suite" || kind === "context")
          suites.push({ name, depth });
        else {
          const path = [...suites.map((s) => s.name), name];
          out.push({ id: testId(framework, file, path), framework, file, path, line });
        }
        // Skip past the name (its quotes), keeping the line count.
        for (let k = i; k < JS_CALL.lastIndex; k++) if (text[k] === "\n") line++;
        prev = text[JS_CALL.lastIndex - 1] ?? "";
        i = JS_CALL.lastIndex;
        continue;
      }
    }
    // Strings (template literals may span lines).
    if (c === '"' || c === "'" || c === "`") {
      let k = i + 1;
      while (k < n && text[k] !== c) {
        if (text[k] === "\\") k++;
        else if (text[k] === "\n") {
          if (c !== "`") break;
          line++;
        }
        k++;
      }
      prev = c;
      i = k + 1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth = Math.max(0, depth - 1);
      // A suite's body closed.
      while (suites.length && (suites.at(-1)?.depth ?? -1) >= depth) suites.pop();
    }
    prev = c;
    i++;
  }
  return out;
}

/** pytest: `test_*` functions, and `test_*` methods of `Test*` classes (by indentation). */
export function discoverPython(text: string, file: string): TestCase[] {
  const out: TestCase[] = [];
  let cls: { name: string; indent: number } | null = null;
  text.split(/\r?\n/).forEach((raw, index) => {
    const m = /^(\s*)(?:async\s+)?(def|class)\s+(\w+)/.exec(raw);
    if (!m) return;
    const indent = (m[1] ?? "").replace(/\t/g, "    ").length;
    const kind = m[2];
    const name = m[3] ?? "";
    if (cls && indent <= cls.indent) cls = null;
    if (kind === "class") {
      if (name.startsWith("Test")) cls = { name, indent };
      return;
    }
    if (!name.startsWith("test")) return;
    if (indent > 0 && !cls) return; // a nested helper, not collected
    const path = cls ? [cls.name, name] : [name];
    out.push({
      id: testId("pytest", file, path),
      framework: "pytest",
      file,
      path,
      line: index + 1,
    });
  });
  return out;
}

/**
 * The module path cargo prints for a file's tests: `src/lib.rs` / `src/main.rs` → "",
 * `src/a/mod.rs` → "a", `src/a/b.rs` → "a::b"; integration tests (`tests/x.rs`) are their own
 * crate → "".
 */
export function rustModulePath(file: string): string[] {
  const parts = file.split("/");
  const src = parts.lastIndexOf("src");
  if (src < 0) return [];
  const rest = parts.slice(src + 1);
  const last = (rest.pop() ?? "").replace(/\.rs$/, "");
  if (last !== "lib" && last !== "main" && last !== "mod") rest.push(last);
  return rest;
}

/** Rust: `#[test]` (also `#[tokio::test]` etc.) functions, inside their inline `mod`s. */
export function discoverRust(text: string, file: string): TestCase[] {
  const out: TestCase[] = [];
  const base = rustModulePath(file);
  const mods: { name: string; depth: number }[] = [];
  let depth = 0;
  let pendingTest = false;
  text.split(/\r?\n/).forEach((raw, index) => {
    const lineText = raw.replace(/\/\/.*$/, "");
    if (/#\[(?:[\w:]+::)?test\b/.test(lineText)) pendingTest = true;
    const mod = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*\{/.exec(lineText);
    if (mod) mods.push({ name: mod[1] ?? "", depth });
    const fn = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/.exec(lineText);
    if (fn && pendingTest) {
      pendingTest = false;
      const path = [...base, ...mods.map((m) => m.name), fn[1] ?? ""];
      out.push({
        id: testId("cargo", file, path),
        framework: "cargo",
        file,
        path,
        line: index + 1,
      });
    }
    for (const ch of lineText) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth = Math.max(0, depth - 1);
        while (mods.length && (mods.at(-1)?.depth ?? -1) >= depth) mods.pop();
      }
    }
  });
  return out;
}

/** Go: `func TestX(t *testing.T)`. */
export function discoverGo(text: string, file: string): TestCase[] {
  const out: TestCase[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const m = /^func\s+(Test\w*)\s*\(\s*\w+\s+\*testing\.T\s*\)/.exec(raw);
    if (m?.[1])
      out.push({
        id: testId("go", file, [m[1]]),
        framework: "go",
        file,
        path: [m[1]],
        line: index + 1,
      });
  });
  return out;
}

/**
 * The JavaScript framework a project runs its tests with, from package.json (and whether the
 * project has a Mocha config file).
 */
export function jsFramework(
  packageJson: string | null,
  fileText: string,
  mocharc = false,
): Framework | null {
  let deps: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(packageJson ?? "{}") as Record<string, unknown>;
    deps = {
      ...((pkg.dependencies as object) ?? {}),
      ...((pkg.devDependencies as object) ?? {}),
    };
  } catch {
    /* not JSON */
  }
  // The file's own import decides first (a Vitest project's Playwright e2e files are Playwright's).
  if (/from\s+['"]@playwright\/test['"]|require\(['"]@playwright\/test['"]\)/.test(fileText))
    return "playwright";
  if (/from\s+['"]vitest['"]/.test(fileText) || "vitest" in deps) return "vitest";
  if (/from\s+['"]node:test['"]|require\(['"]node:test['"]\)/.test(fileText)) return "node";
  if ("jest" in deps || /from\s+['"]@jest\/globals['"]/.test(fileText)) return "jest";
  if ("mocha" in deps || mocharc) return "mocha";
  return null;
}

// ---- Running -----------------------------------------------------------------------------------

export interface RunScope {
  /** One file (relative), or every file of the framework. */
  file?: string;
  /** One test (with `file`). */
  test?: TestCase;
}

/**
 * A shell-safe quoted argument: single quotes (POSIX `'\''`, PowerShell `''`). PowerShell also
 * ends a string at the typographic quotes ‘ ’ ‚ ‛ (a test named "it’s fine"): doubled too.
 */
export function quoteArg(v: string, windows: boolean): string {
  return windows ? `'${v.replace(/['‘’‚‛]/g, "$&$&")}'` : `'${v.replace(/'/g, "'\\''")}'`;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The coverage report a framework's coverage run writes into its folder, and its format. */
export type CoverageFormat = "lcov" | "istanbul" | "coveragepy" | "go";

export function coverageReport(
  framework: Framework,
): { file: string; format: CoverageFormat } | null {
  switch (framework) {
    case "vitest":
    case "jest":
      return { file: "coverage-final.json", format: "istanbul" };
    case "node":
    case "mocha":
    case "cargo":
      return { file: "lcov.info", format: "lcov" };
    case "pytest":
    case "unittest":
      return { file: "coverage.json", format: "coveragepy" };
    case "go":
      return { file: "cover.out", format: "go" };
    case "playwright":
      return null;
  }
}

/** `dir` and `name` joined with the platform's separator (dir is absolute). */
const inDir = (dir: string, name: string, windows: boolean) =>
  `${dir.replace(/[\\/]+$/, "")}${windows ? "\\" : "/"}${name}`;

const join = (parts: readonly (string | false | undefined)[]) =>
  parts.filter((p): p is string => !!p).join(" ");

/**
 * The command line that runs `scope` with `framework`, from the project's folder. With
 * `coverageDir` (absolute) it also measures coverage, written there (`coverageReport`).
 */
export function runCommand(
  framework: Framework,
  scope: RunScope,
  windows: boolean,
  coverageDir?: string,
): string {
  const q = (v: string) => quoteArg(v, windows);
  const file = scope.file;
  const t = scope.test;
  const cov = coverageDir;
  const py = windows ? "python" : "python3";
  switch (framework) {
    case "vitest":
      return join([
        "npx vitest run --reporter=json",
        cov &&
          `--coverage.enabled=true --coverage.reporter=json --coverage.reportsDirectory ${q(cov)}`,
        file && q(file),
        t && `-t ${q(`^${escapeRegex(t.path.join(" "))}$`)}`,
      ]);
    case "jest":
      return join([
        "npx jest --json --testLocationInResults",
        cov && `--coverage --coverageReporters=json --coverageDirectory ${q(cov)}`,
        file && `--runTestsByPath ${q(file)}`,
        t && `-t ${q(`^${escapeRegex(t.path.join(" "))}$`)}`,
      ]);
    case "node": {
      const ts = file && /\.(ts|tsx|mts|cts)$/.test(file);
      const runner = ts ? "npx tsx --test" : "node --test";
      return join([
        runner,
        cov
          ? `--experimental-test-coverage --test-reporter=lcov --test-reporter-destination ${q(inDir(cov, "lcov.info", windows))} --test-reporter=tap --test-reporter-destination=stdout`
          : "--test-reporter=tap",
        t && `--test-name-pattern=${q(`^${escapeRegex(t.path.at(-1) ?? "")}$`)}`,
        file && q(file),
      ]);
    }
    case "mocha":
      // c8 (V8's coverage as lcov) runs Mocha when coverage is asked for.
      return join([
        cov && `npx c8 --reporter=lcovonly --reports-dir ${q(cov)}`,
        cov ? "mocha --reporter json" : "npx mocha --reporter json",
        t && `--grep ${q(`^${escapeRegex(t.path.join(" "))}$`)}`,
        file && q(file),
      ]);
    case "playwright":
      return join([
        "npx playwright test --reporter=json",
        t ? q(`${t.file}:${t.line}`) : file && q(file),
        t?.runnerProject && `--project ${q(t.runnerProject)}`,
      ]);
    case "pytest": {
      const target = t ? `${t.file}::${t.path.join("::")}` : (file ?? "");
      // Colors on (D233): results are read from the plain text, a test's output keeps them.
      const run = join([
        `${py} -m pytest -rA --color=yes`,
        // Each line's tests (coverage.py's dynamic contexts, "Show coverage for test"): the
        // data file (COVERAGE_FILE, set by the run), then a JSON report with its contexts.
        cov && "--cov=. --cov-branch --cov-context=test --cov-report=",
        target && q(target),
      ]);
      if (!cov) return run;
      return `${run}; ${py} -m coverage json --show-contexts -o ${q(inDir(cov, "coverage.json", windows))}`;
    }
    case "unittest": {
      // No target: unittest discovers (test*.py from the folder), as `discover` does.
      const target = t
        ? `${unittestModule(t.file)}.${t.path.join(".")}`
        : file
          ? unittestModule(file)
          : "";
      const args = join(["-m unittest -v", target && q(target)]);
      if (!cov) return `${py} ${args}`;
      // coverage.py runs unittest, then writes its JSON (`;` works in sh and PowerShell).
      const data = q(inDir(cov, ".coverage", windows));
      return `${py} -m coverage run --branch --data-file ${data} ${args}; ${py} -m coverage json --data-file ${data} -o ${q(inDir(cov, "coverage.json", windows))}`;
    }
    case "cargo": {
      // cargo-llvm-cov (when installed) takes cargo test's own arguments.
      const base = cov
        ? `cargo llvm-cov --lcov --output-path ${q(inDir(cov, "lcov.info", windows))}`
        : "cargo test";
      if (t) return `${base} ${cov ? "-- " : ""}${q(t.path.join("::"))}${cov ? "" : " --"} --exact`;
      const mod = file ? rustModulePath(file).join("::") : "";
      const integration = file?.startsWith("tests/") ?? false;
      if (file && integration)
        return `${base} --test ${q((file.split("/").pop() ?? "").replace(/\.rs$/, ""))}`;
      return mod ? `${base} ${cov ? "-- " : ""}${q(`${mod}::`)}` : base;
    }
    case "go": {
      const dir = file
        ? file.includes("/")
          ? `./${file.slice(0, file.lastIndexOf("/"))}`
          : "."
        : "./...";
      return join([
        "go test -json",
        cov && `-coverprofile ${q(inDir(cov, "cover.out", windows))}`,
        t && `-run ${q(`^${t.path[0] ?? ""}$`)}`,
        dir,
      ]);
    }
  }
}

/** The dotted module unittest runs for a file relative to its folder ("a/test_b.py" → a.test_b). */
export function unittestModule(file: string): string {
  return file
    .replace(/\\/g, "/")
    .replace(/\.py$/, "")
    .replace(/\/__init__$/, "")
    .split("/")
    .filter(Boolean)
    .join(".");
}

// ---- Results -------------------------------------------------------------------------------------

/** Results keyed by test id; `extra` are tests the run reported that discovery hadn't found. */
export interface ParsedRun {
  results: Map<string, TestResult>;
  extra: TestCase[];
  /** The framework's own summary line, when it printed one. */
  summary?: string;
}

const clip = (s: string, max = 4000) => (s.length > max ? `${s.slice(0, max)}…` : s);
/** A test's own output: its end kept (where a failure is). */
const OUTPUT_MAX = 20_000;
export const clipOutput = (s: string) => {
  if (s.length <= OUTPUT_MAX) return s;
  // Not inside a color code: from its start, so no "[31m" shows as text.
  let start = s.length - OUTPUT_MAX;
  const esc = s.lastIndexOf("\u001b", start);
  if (esc >= 0 && start - esc < 32 && !/[A-Za-z]/.test(s.slice(esc + 2, start))) start = esc;
  return `… ${s.slice(start)}`;
};
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

/**
 * A run's output as plain text for the parsers, with a way back to the colored original (D233):
 * test runs force colors (FORCE_COLOR, pytest's --color=yes), results are read from the plain
 * text, and each test's own output keeps its colors for the Test results tab.
 */
export interface PlainOutput {
  /** Without escape sequences (and with `\r\n` as `\n` when asked). */
  readonly text: string;
  /** Whether the original had any escape sequence (else `colored` is the plain text). */
  readonly hasColor: boolean;
  /** The original text of plain [start, end), with the escape sequences in and around it. */
  colored(start: number, end: number): string;
  /** The colored original of `part`, a piece of `text` found at or after `from` (else `part`). */
  recolor(part: string, from?: number): string;
}

export function plainOutput(output: string, crlf = false): PlainOutput {
  const pattern = crlf
    ? // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
      /\u001b\[[0-9;]*[A-Za-z]|\r(?=\n)/g
    : // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
      /\u001b\[[0-9;]*[A-Za-z]/g;
  const hasColor = output.includes("\u001b[");
  if (!hasColor && !(crlf && output.includes("\r\n")))
    return {
      text: output,
      hasColor: false,
      colored: (start, end) => output.slice(start, end),
      recolor: (part) => part,
    };
  // at[i]: where the plain text's character i is in the original.
  const at = new Int32Array(output.length + 1);
  const chunks: string[] = [];
  let n = 0;
  let last = 0;
  const keep = (from: number, to: number) => {
    if (to <= from) return;
    chunks.push(output.slice(from, to));
    for (let i = from; i < to; i++) at[n++] = i;
  };
  for (const m of output.matchAll(pattern)) {
    keep(last, m.index);
    last = m.index + m[0].length;
  }
  keep(last, output.length);
  at[n] = output.length;
  const text = chunks.join("");
  const colored = (start: number, end: number): string => {
    const s0 = Math.max(0, Math.min(start, n));
    const e0 = Math.max(s0, Math.min(end, n));
    // From just after the character before (the codes that color the first one) to the next
    // character (the codes that end the last one).
    const from = s0 > 0 ? (at[s0 - 1] ?? 0) + 1 : 0;
    const to = e0 < n ? (at[e0] ?? output.length) : output.length;
    const slice = output.slice(from, to);
    // A slice may end just before a line's "\n" (its "\r" inside it).
    return crlf ? slice.replace(/\r(?=\n|$)/g, "") : slice;
  };
  return {
    text,
    hasColor,
    colored,
    recolor: (part, from = 0) => {
      if (!hasColor || !part) return part;
      const i = text.indexOf(part, from);
      return i < 0 ? part : colored(i, i + part.length);
    },
  };
}

/** The JSON object in `output` that starts with `marker` (other output may surround it). */
function jsonBlock(output: string, marker: RegExp): unknown {
  const m = marker.exec(output);
  if (!m) return null;
  let depth = 0;
  let inString = false;
  for (let i = m.index; i < output.length; i++) {
    const c = output[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(output.slice(m.index, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The workspace-relative form of a path a framework printed (absolute or relative). */
function relativeTo(root: string, path: string): string {
  const p = path.replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return p.toLowerCase().startsWith(`${r.toLowerCase()}/`)
    ? p.slice(r.length + 1)
    : p.replace(/^\.\//, "");
}

/** Vitest's and Jest's JSON reporter (the same shape). */
export function parseJestJson(output: string, framework: Framework, root: string): ParsedRun {
  const results = new Map<string, TestResult>();
  const extra: TestCase[] = [];
  const data = jsonBlock(output, /\{\s*"num(Failed|Total|Passed)\w*"\s*:/) as {
    numPassedTests?: number;
    numFailedTests?: number;
    numPendingTests?: number;
    testResults?: {
      name?: string;
      message?: string;
      assertionResults?: {
        ancestorTitles?: string[];
        title?: string;
        status?: string;
        duration?: number | null;
        failureMessages?: string[];
        failureDetails?: unknown[];
        location?: { line?: number } | null;
      }[];
    }[];
  } | null;
  if (!data) return { results, extra };
  for (const fileResult of data.testResults ?? []) {
    const file = relativeTo(root, fileResult.name ?? "");
    for (const a of fileResult.assertionResults ?? []) {
      const path = [...(a.ancestorTitles ?? []), a.title ?? ""];
      const id = testId(framework, file, path);
      const status =
        a.status === "passed" ? "passed" : a.status === "failed" ? "failed" : "skipped";
      // The output keeps the framework's colors (the Test results tab draws them); the message
      // is plain text (hovers, peeks, agents).
      const raw = (a.failureMessages ?? []).join("\n").trim();
      const message = stripAnsi(raw).trim();
      const result: TestResult = {
        status,
        ...(typeof a.duration === "number" && { durationMs: Math.round(a.duration) }),
        ...(message && { message: clip(message), output: clipOutput(raw) }),
      };
      results.set(
        id,
        status === "failed"
          ? withComparison(
              result,
              fromJestFailureDetails(a.failureDetails) ?? (message ? fromMessage(message) : null),
            )
          : result,
      );
      extra.push({ id, framework, file, path, line: a.location?.line ?? 1 });
    }
    // A file that failed to load (syntax error, missing import): no assertions, a message.
    if (!fileResult.assertionResults?.length && fileResult.message)
      results.set(testId(framework, file, []), {
        status: "failed",
        message: clip(stripAnsi(fileResult.message)),
      });
  }
  return {
    results,
    extra,
    summary: `${data.numPassedTests ?? 0} passed, ${data.numFailedTests ?? 0} failed, ${data.numPendingTests ?? 0} skipped`,
  };
}

/** pytest with `-rA`: the short summary's PASSED / FAILED / … lines and the failure sections. */
export function parsePytest(output: string): ParsedRun {
  const plain = plainOutput(output);
  const text = plain.text;
  const results = new Map<string, TestResult>();
  const extra: TestCase[] = [];
  // "____ TestX.test_y ____" or "____ test_y ____" sections under FAILURES; PASSES (-rA) has
  // the passed tests' captured output the same way (D209: each test's own output).
  const details = new Map<string, string>();
  const passes = new Map<string, string>();
  const sections = (heading: RegExp, into: Map<string, string>) => {
    const start = heading.exec(text);
    if (!start) return;
    const section = text.slice(start.index + start[0].length);
    const end = section.search(/^=+ .*=+$/m);
    const body = end >= 0 ? section.slice(0, end) : section;
    const parts = body.split(/^_{3,} (.+?) _{3,}$/m);
    for (let i = 1; i + 1 < parts.length; i += 2)
      into.set((parts[i] ?? "").trim(), (parts[i + 1] ?? "").trim());
  };
  sections(/^=+ FAILURES =+$/m, details);
  sections(/^=+ ERRORS =+$/m, details);
  sections(/^=+ PASSES =+$/m, passes);
  const rank = { passed: 0, skipped: 1, failed: 2 } as const;
  for (const m of text.matchAll(
    /^(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\s+(\S+?)(?:\s+-\s+(.*))?$/gm,
  )) {
    const word = m[1] ?? "";
    // "tests/test_a.py::TestX::test_y[param]" → file and names (parameters folded together).
    const nodeid = (m[2] ?? "").replace(/\[.*\]$/, "");
    const [file = "", ...names] = nodeid.split("::");
    if (!names.length) continue;
    const id = testId("pytest", file, names);
    const status =
      word === "PASSED" || word === "XFAIL" ? "passed" : word === "SKIPPED" ? "skipped" : "failed";
    const prev = results.get(id);
    if (prev && rank[prev.status] >= rank[status]) continue;
    const detail = details.get(names.join(".")) ?? details.get(names.at(-1) ?? "");
    const message = [m[3], detail].filter(Boolean).join("\n\n");
    const own =
      status === "failed"
        ? detail
        : (passes.get(names.join(".")) ?? passes.get(names.at(-1) ?? ""));
    const result: TestResult = {
      status,
      ...(message && { message: clip(message) }),
      // Colored as printed (--color=yes), from the plain text's section.
      ...(own && { output: clipOutput(plain.recolor(own)) }),
    };
    results.set(
      id,
      status === "failed" && detail ? withComparison(result, fromMessage(detail)) : result,
    );
    if (!prev) extra.push({ id, framework: "pytest", file, path: names, line: 1 });
  }
  const summary = /^=+ (.*(?:passed|failed|error|skipped).*?) =+$/m.exec(text)?.[1];
  return { results, extra, ...(summary && { summary }) };
}

/** `cargo test`: "test a::b ... ok | FAILED | ignored" and the "---- a::b stdout ----" blocks. */
export function parseCargo(output: string, files: ReadonlyMap<string, TestCase>): ParsedRun {
  const plain = plainOutput(output);
  const text = plain.text;
  const results = new Map<string, TestResult>();
  const extra: TestCase[] = [];
  const blocks = new Map<string, string>();
  /** The blocks as printed (colors kept, CARGO_TERM_COLOR / FORCE_COLOR). */
  const coloredBlocks = new Map<string, string>();
  for (const m of text.matchAll(
    /^---- (\S+) stdout ----\n([\s\S]*?)(?=^---- |^failures:|^test result:)/gm,
  )) {
    const block = (m[2] ?? "").trim();
    blocks.set(m[1] ?? "", block);
    coloredBlocks.set(m[1] ?? "", plain.recolor(block, m.index));
  }
  for (const m of text.matchAll(/^test (\S+) \.\.\. (ok|FAILED|ignored)/gm)) {
    const name = m[1] ?? "";
    const status = m[2] === "ok" ? "passed" : m[2] === "FAILED" ? "failed" : "skipped";
    // Discovery knows the file; a name it didn't see is listed under its module path.
    const known = files.get(name);
    const id = known?.id ?? testId("cargo", "", name.split("::"));
    const message = blocks.get(name);
    results.set(id, {
      status,
      ...(message && {
        message: clip(message),
        output: clipOutput(coloredBlocks.get(name) ?? message),
      }),
    });
    if (!known) extra.push({ id, framework: "cargo", file: "", path: name.split("::"), line: 1 });
  }
  const summary = /^test result: (.*)$/m.exec(text)?.[1];
  return { results, extra, ...(summary && { summary }) };
}

/** `go test -json`: one event per line; a test's output collected for its message. */
export function parseGoJson(output: string, byName: ReadonlyMap<string, TestCase>): ParsedRun {
  const results = new Map<string, TestResult>();
  const extra: TestCase[] = [];
  const logs = new Map<string, string[]>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    let e: { Action?: string; Test?: string; Output?: string; Elapsed?: number; Package?: string };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e.Test) continue;
    const top = e.Test.split("/")[0] ?? e.Test;
    if (e.Action === "output" && e.Output) {
      const list = logs.get(top) ?? [];
      if (list.length < 400) list.push(e.Output);
      logs.set(top, list);
      continue;
    }
    if ((e.Action !== "pass" && e.Action !== "fail" && e.Action !== "skip") || top !== e.Test)
      continue;
    const known = byName.get(top);
    const id = known?.id ?? testId("go", e.Package ?? "", [top]);
    const status = e.Action === "pass" ? "passed" : e.Action === "fail" ? "failed" : "skipped";
    // What the test printed, colors kept for the output; the message plain.
    const own = (logs.get(top) ?? []).join("").trim();
    const message = status === "failed" ? stripAnsi(own).trim() : "";
    results.set(id, {
      status,
      ...(typeof e.Elapsed === "number" && { durationMs: Math.round(e.Elapsed * 1000) }),
      ...(message && { message: clip(message) }),
      ...(own && { output: clipOutput(own) }),
    });
    if (!known) extra.push({ id, framework: "go", file: e.Package ?? "", path: [top], line: 1 });
  }
  return { results, extra };
}

/** node:test's TAP: "ok 1 - name" / "not ok 2 - name" with its YAML block; leaves only. */
export function parseTap(output: string, file: string): ParsedRun {
  const plain = plainOutput(output);
  const lines = plain.text.split(/\r?\n/);
  // Where each line starts in the plain text (a test's YAML block keeps its colors).
  const lineStart: number[] = [];
  if (plain.hasColor) {
    let offset = 0;
    for (const m of plain.text.matchAll(/\r?\n|$/g)) {
      lineStart.push(offset);
      offset = m.index + m[0].length;
      if (lineStart.length >= lines.length) break;
    }
  }
  const results = new Map<string, TestResult>();
  const extra: TestCase[] = [];
  const indentOf = (l: string) => Math.floor((/^\s*/.exec(l)?.[0].length ?? 0) / 4);
  const RESULT = /^\s*(not ok|ok) \d+ - (.*?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/;
  const suites: string[] = [];
  const subtestAt: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const indent = indentOf(raw);
    const sub = /^\s*# Subtest: (.*)$/.exec(raw);
    if (sub) {
      suites.length = indent;
      suites[indent] = (sub[1] ?? "").trim();
      subtestAt[indent] = i;
      continue;
    }
    const m = RESULT.exec(raw);
    if (!m) continue;
    // A suite reports after its children: only tests without nested results count.
    const start = subtestAt[indent] ?? i;
    const children = lines.slice(start + 1, i).some((l) => RESULT.test(l) && indentOf(l) > indent);
    if (children) continue;
    const path = [...suites.slice(0, indent), (m[2] ?? "").trim()];
    let message = "";
    // The YAML block under the result, dedented (its own indentation kept for the values).
    const yaml: string[] = [];
    const coloredYaml: string[] = [];
    const base = indent * 4 + 2;
    for (let k = i + 1; k < lines.length; k++) {
      const l = lines[k] ?? "";
      if (/^\s*\.\.\.\s*$/.test(l) || RESULT.test(l) || /^\s*# Subtest:/.test(l)) break;
      if (/^\s*---\s*$/.test(l)) continue;
      const cut = Math.min(base, /^\s*/.exec(l)?.[0].length ?? 0);
      yaml.push(l.slice(cut));
      const start = lineStart[k];
      if (start !== undefined) coloredYaml.push(plain.colored(start + cut, start + l.length));
    }
    if (m[1] === "not ok")
      message = yaml
        .map((l) => l.trim())
        .join("\n")
        .trim();
    const duration = /^duration_ms: ([\d.]+)/m.exec(yaml.join("\n"))?.[1];
    const id = testId("node", file, path);
    const result: TestResult = {
      status: m[3] ? "skipped" : m[1] === "ok" ? "passed" : "failed",
      ...(duration !== undefined && { durationMs: Math.round(Number(duration)) }),
      ...(message && {
        message: clip(message),
        output: clipOutput(
          (coloredYaml.length === yaml.length ? coloredYaml : yaml).join("\n").trim(),
        ),
      }),
    };
    results.set(
      id,
      result.status === "failed" ? withComparison(result, fromTapYaml(yaml.join("\n"))) : result,
    );
    extra.push({ id, framework: "node", file, path, line: 1 });
  }
  const text = lines.join("\n");
  const pass = /^# pass (\d+)/m.exec(text)?.[1];
  const fail = /^# fail (\d+)/m.exec(text)?.[1];
  return {
    results,
    extra,
    ...(pass !== undefined && { summary: `${pass} passed, ${fail ?? 0} failed` }),
  };
}

/** The nearest test at or above `line` in `file` (run the test at the cursor). */
export function testAt(tests: readonly TestCase[], file: string, line: number): TestCase | null {
  let best: TestCase | null = null;
  for (const t of tests)
    if (t.file === file && t.line <= line && (!best || t.line > best.line)) best = t;
  return best;
}

/**
 * The environment of a test run (D233). Output goes through a pipe, so tools turn their colors
 * off; these turn them back on (Node's tools, Jest / Vitest, Python 3.13+'s tracebacks,
 * cargo's own output). Results are parsed from the plain text, a test's output keeps the colors.
 * A pytest coverage run writes its data file into its coverage folder (`dataFile`), where the
 * JSON report step reads it.
 */
export function testRunEnv(framework: Framework, dataFile?: string): Record<string, string> {
  return {
    FORCE_COLOR: "1",
    CARGO_TERM_COLOR: "always",
    ...(dataFile && (framework === "pytest" || framework === "unittest")
      ? { COVERAGE_FILE: dataFile }
      : {}),
  };
}
