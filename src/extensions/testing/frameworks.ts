// More test frameworks (D204), DOM-free and tested: Mocha (its config's spec, the JSON
// reporter), Playwright (`playwright test --list --reporter=json` for the exact tests and
// projects, the same JSON for results) and Python's unittest (a small listing script, `-v`
// output). The others are in model.ts.
import { type ExpectedActual, fromMessage, fromValues } from "./assertions";
import { type ResolvePath, resolverFor } from "./coverage";
import type { ParsedRun, TestCase, TestResult } from "./model";
import { clipOutput, plainOutput, testId } from "./model";

const clip = (s: string, max = 4000) => (s.length > max ? `${s.slice(0, max)}…` : s);
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

/** The JSON object in `output` that starts with `marker` (other output may surround it). */
export function jsonObjectAt(output: string, marker: RegExp): unknown {
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

const withValues = (r: TestResult, ea: ExpectedActual | null): TestResult =>
  ea ? { ...r, expected: ea.expected, actual: ea.actual } : r;

// ---- Mocha ---------------------------------------------------------------------------------------

/** Mocha's default spec when its config names none: `./test/*.{js,cjs,mjs}`. */
export const MOCHA_DEFAULT_SPEC = ["test/*.{js,cjs,mjs}"];

/**
 * The spec globs in a Mocha config: `.mocharc.json` / `.jsonc` (`"spec"`), `.mocharc.yml` /
 * `.yaml` (`spec:` as a value or a list) or package.json's `"mocha"` key. Empty: none named.
 */
export function mochaSpec(text: string | null, kind: "json" | "yaml" | "package"): string[] {
  if (!text) return [];
  const asList = (v: unknown): string[] =>
    typeof v === "string"
      ? [v]
      : Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string")
        : [];
  if (kind === "yaml") {
    const lines = text.split(/\r?\n/);
    const i = lines.findIndex((l) => /^spec\s*:/.test(l));
    if (i < 0) return [];
    const inline = (lines[i] ?? "").replace(/^spec\s*:\s*/, "").trim();
    const unq = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, "$2");
    if (inline.startsWith("["))
      return inline.slice(1, inline.lastIndexOf("]")).split(",").map(unq).filter(Boolean);
    if (inline) return [unq(inline)];
    const out: string[] = [];
    for (let k = i + 1; k < lines.length; k++) {
      const m = /^\s+-\s+(.+)$/.exec(lines[k] ?? "");
      if (!m) break;
      out.push(unq(m[1] ?? ""));
    }
    return out;
  }
  try {
    // JSONC: comments and trailing commas out first.
    const clean = text
      .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str) => str ?? "")
      .replace(/,(\s*[}\]])/g, "$1");
    const data = JSON.parse(clean) as Record<string, unknown>;
    const cfg = kind === "package" ? (data.mocha as Record<string, unknown> | undefined) : data;
    return asList(cfg?.spec);
  } catch {
    return [];
  }
}

/** A spec ("test/**\/*.spec.js", "./test", "test/unit") as search globs. */
export function specGlobs(spec: readonly string[], project: string): string[] {
  const prefix = project ? `${project}/` : "";
  return spec.map((s) => {
    const p = s.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    // A folder: its files (Mocha reads the folder's .js / .cjs / .mjs files).
    const glob = /[*?{[]/.test(p) || /\.[cm]?[jt]sx?$/.test(p) ? p : `${p}/*.{js,cjs,mjs,ts}`;
    return `${prefix}${glob}`;
  });
}

interface MochaTest {
  title?: string;
  fullTitle?: string;
  file?: string;
  duration?: number;
  err?: Record<string, unknown>;
}

/**
 * Mocha's JSON reporter. `known` maps "file|full title" to discovered tests (Mocha prints only the
 * full title, suites and test joined by spaces).
 */
export function parseMochaJson(
  output: string,
  resolve: ResolvePath,
  known: ReadonlyMap<string, TestCase>,
): ParsedRun {
  const results = new Map<string, TestResult>();
  const extra: TestCase[] = [];
  const data = jsonObjectAt(output, /\{\s*"stats"\s*:/) as {
    stats?: { passes?: number; failures?: number; pending?: number };
    tests?: MochaTest[];
    failures?: MochaTest[];
    pending?: MochaTest[];
  } | null;
  if (!data) return { results, extra };
  const key = (t: MochaTest) => `${t.file ?? ""}|${t.fullTitle ?? t.title ?? ""}`;
  const failed = new Set((data.failures ?? []).map(key));
  const pending = new Set((data.pending ?? []).map(key));
  // Failures outside a test ("before all" hooks) are only in `failures`.
  const all = [...(data.tests ?? [])];
  for (const f of data.failures ?? []) if (!all.some((t) => key(t) === key(f))) all.push(f);
  for (const t of all) {
    const file = resolve(t.file ?? "") ?? "";
    const full = t.fullTitle ?? t.title ?? "";
    const title = t.title ?? full;
    const found = known.get(`${file}|${full}`);
    const prefix = full.endsWith(title) ? full.slice(0, full.length - title.length).trim() : "";
    const path = found?.path ?? (prefix ? [prefix, title] : [title]);
    const id = found?.id ?? testId("mocha", file, path);
    const k = key(t);
    const status = failed.has(k) ? "failed" : pending.has(k) ? "skipped" : "passed";
    const err = t.err && Object.keys(t.err).length ? t.err : null;
    const message = err
      ? stripAnsi(String(err.stack ?? err.message ?? "")).trim() || String(err.message ?? "Failed")
      : "";
    const result: TestResult = {
      status,
      ...(typeof t.duration === "number" && { durationMs: Math.round(t.duration) }),
      ...(message && { message: clip(message) }),
    };
    results.set(id, status === "failed" ? withValues(result, fromValues(err)) : result);
    if (!found && file) extra.push({ id, framework: "mocha", file, path, line: 1 });
  }
  const s = data.stats;
  return {
    results,
    extra,
    ...(s && {
      summary: `${s.passes ?? 0} passed, ${s.failures ?? 0} failed, ${s.pending ?? 0} skipped`,
    }),
  };
}

// ---- Playwright --------------------------------------------------------------------------------

interface PwResult {
  status?: string;
  duration?: number;
  errors?: { message?: string; stack?: string }[];
  error?: { message?: string; stack?: string };
}
interface PwSpec {
  title?: string;
  file?: string;
  line?: number;
  tests?: {
    projectName?: string;
    projectId?: string;
    expectedStatus?: string;
    status?: string;
    results?: PwResult[];
  }[];
}
interface PwSuite {
  title?: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}

export interface PlaywrightRun extends ParsedRun {
  /** Every test in the report (the listing's tests, for discovery). */
  tests: TestCase[];
  projects: string[];
}

/**
 * Playwright's JSON report, from `--list` (tests only) or a run (with results). Files are
 * relative to the config's rootDir. With more than one project, each test is listed under its
 * project (the first name in its path), as the Playwright extension shows them.
 */
export function parsePlaywrightJson(output: string, root: string, cwd: string): PlaywrightRun {
  const results = new Map<string, TestResult>();
  const tests: TestCase[] = [];
  const data = jsonObjectAt(output, /\{\s*"config"\s*:/) as {
    config?: { rootDir?: string; projects?: { name?: string }[] };
    suites?: PwSuite[];
    stats?: { expected?: number; unexpected?: number; skipped?: number; flaky?: number };
    errors?: { message?: string }[];
  } | null;
  if (!data) return { results, extra: [], tests, projects: [] };
  const projects = (data.config?.projects ?? []).map((p) => p.name ?? "").filter(Boolean);
  const several = projects.length > 1;
  const resolve = resolverFor(root, data.config?.rootDir ?? cwd);
  const seen = new Set<string>();
  const walk = (suite: PwSuite, titles: string[], top: boolean) => {
    const here = top ? titles : [...titles, suite.title ?? ""];
    for (const spec of suite.specs ?? []) {
      const file = resolve(spec.file ?? suite.file ?? "");
      if (!file) continue;
      for (const t of spec.tests ?? [{}]) {
        const project = t.projectName ?? t.projectId ?? "";
        const path = [...(several && project ? [project] : []), ...here, spec.title ?? ""];
        const id = testId("playwright", file, path);
        if (!seen.has(id)) {
          seen.add(id);
          tests.push({
            id,
            framework: "playwright",
            file,
            path,
            line: spec.line ?? 1,
            ...(project && { runnerProject: project }),
          });
        }
        const last = t.results?.at(-1);
        if (!last) continue;
        const status =
          t.status === "skipped" || last.status === "skipped"
            ? "skipped"
            : t.status === "unexpected"
              ? "failed"
              : "passed";
        const errors = last.errors?.length ? last.errors : last.error ? [last.error] : [];
        const message = stripAnsi(
          errors.map((e) => e.stack ?? e.message ?? "").join("\n\n"),
        ).trim();
        const result: TestResult = {
          status,
          ...(typeof last.duration === "number" && { durationMs: Math.round(last.duration) }),
          ...(message && { message: clip(message) }),
        };
        results.set(id, status === "failed" ? withValues(result, fromMessage(message)) : result);
      }
    }
    for (const child of suite.suites ?? []) walk(child, here, false);
  };
  for (const s of data.suites ?? []) walk(s, [], true);
  const st = data.stats;
  return {
    results,
    extra: tests,
    tests,
    projects,
    ...(st &&
      Object.keys(st).length > 0 && {
        summary: `${(st.expected ?? 0) + (st.flaky ?? 0)} passed, ${st.unexpected ?? 0} failed, ${st.skipped ?? 0} skipped`,
      }),
  };
}

// ---- unittest ------------------------------------------------------------------------------------

/**
 * Lists unittest's tests the way `python -m unittest discover` finds them: one
 * `@@TEST {"id", "file", "line"}` line each (`error` for a module that didn't import).
 */
export const UNITTEST_LIST_SCRIPT = `import json, os, sys, inspect, unittest
def walk(s):
    for t in s:
        if isinstance(t, unittest.TestSuite):
            yield from walk(t)
        else:
            yield t
suite = unittest.TestLoader().discover(".", pattern="test*.py", top_level_dir=".")
for t in walk(suite):
    info = {"id": t.id()}
    if type(t).__name__ in ("_FailedTest", "ModuleImportFailure"):
        info["error"] = str(getattr(t, "_exception", "") or "")
    else:
        try:
            m = inspect.unwrap(getattr(t, t._testMethodName))
            info["file"] = os.path.relpath(inspect.getsourcefile(m)).replace(os.sep, "/")
            info["line"] = inspect.getsourcelines(m)[1]
        except Exception:
            pass
    print("@@TEST " + json.dumps(info), flush=True)
`;

/** The command that runs the listing script (base64, so neither shell touches its quotes). */
export function unittestListCommand(windows: boolean): string {
  const py = windows ? "python" : "python3";
  const b64 = btoa(UNITTEST_LIST_SCRIPT);
  return `${py} -c "import base64;exec(base64.b64decode('${b64}'))"`;
}

export interface UnittestListing {
  tests: TestCase[];
  /** Modules that didn't import: their message. */
  errors: { id: string; message: string }[];
}

/** The listing script's output; `project` is the folder it ran in (relative to the root). */
export function parseUnittestList(output: string, project: string): UnittestListing {
  const tests: TestCase[] = [];
  const errors: UnittestListing["errors"] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("@@TEST ")) continue;
    let info: { id?: string; file?: string; line?: number; error?: string };
    try {
      info = JSON.parse(line.slice(7));
    } catch {
      continue;
    }
    const id = info.id ?? "";
    if (info.error !== undefined) {
      errors.push({ id, message: info.error });
      continue;
    }
    const parts = id.split(".");
    if (parts.length < 2) continue;
    const method = parts.at(-1) ?? "";
    const cls = parts.at(-2) ?? "";
    // A method from elsewhere (a decorator's wrapper): the module's file, line unknown.
    const outside = !info.file || info.file.startsWith("../") || /^[A-Za-z]:|^\//.test(info.file);
    const rel = outside ? `${parts.slice(0, -2).join("/")}.py` : (info.file ?? "");
    const file = project ? `${project}/${rel}` : rel;
    const path = [cls, method];
    tests.push({
      id: testId("unittest", file, path),
      framework: "unittest",
      file,
      path,
      line: outside ? 1 : (info.line ?? 1),
    });
  }
  return { tests, errors };
}

/** unittest test classes (any TestCase subclass) and their `test*` methods, from the text. */
export function discoverUnittest(text: string, file: string): TestCase[] {
  const out: TestCase[] = [];
  let cls: { name: string; indent: number } | null = null;
  text.split(/\r?\n/).forEach((raw, index) => {
    const m = /^(\s*)(?:async\s+)?(def|class)\s+(\w+)\s*(\([^)]*\))?/.exec(raw);
    if (!m) return;
    const indent = (m[1] ?? "").replace(/\t/g, "    ").length;
    if (cls && indent <= cls.indent) cls = null;
    const name = m[3] ?? "";
    if (m[2] === "class") {
      if (indent === 0 && /TestCase\b/.test(m[4] ?? "")) cls = { name, indent };
      return;
    }
    if (!cls || !name.startsWith("test")) return;
    const path = [cls.name, name];
    out.push({
      id: testId("unittest", file, path),
      framework: "unittest",
      file,
      path,
      line: index + 1,
    });
  });
  return out;
}

/**
 * `python -m unittest -v`: "test_x (mod.Class.test_x) ... ok | FAIL | ERROR | skipped '…'" (older
 * Pythons print "(mod.Class)"), and the FAIL: / ERROR: sections. `known` maps dotted ids
 * ("mod.Class.test_x") to discovered tests.
 */
export function parseUnittest(output: string, known: ReadonlyMap<string, TestCase>): ParsedRun {
  // Plain for the parsing; a failure's traceback keeps its colors (Python 3.13+ with FORCE_COLOR).
  const plain = plainOutput(output, true);
  const text = plain.text;
  const results = new Map<string, TestResult>();
  const extra: TestCase[] = [];
  const fullId = (method: string, inner: string) =>
    inner.endsWith(`.${method}`) ? inner : `${inner}.${method}`;
  // Failure sections: "=====\nFAIL: test_x (mod.Class.test_x)\n-----\n…".
  const details = new Map<string, string>();
  const sections = text.split(/^={20,}\n/m).slice(1);
  for (const s of sections) {
    // A docstring's first line may sit between the title and the dashes.
    const m = /^(?:FAIL|ERROR): ([\w.]+) \(([\w.]+)\)[^\n]*\n(?:[^\n]*\n)??-{20,}\n([\s\S]*)$/.exec(
      s,
    );
    if (!m) continue;
    const body = (m[3] ?? "").replace(/\n-{20,}\nRan \d+ tests?[\s\S]*$/, "").trim();
    const id = fullId(m[1] ?? "", m[2] ?? "");
    details.set(id, [details.get(id), body].filter(Boolean).join("\n\n"));
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? "";
    // A docstring's first line follows on its own line: "name (id)\ndoc ... ok".
    const next = lines[i + 1] ?? "";
    if (/^\w+ \([\w.]+\)$/.test(line) && / \.\.\. /.test(next)) {
      line = `${line}${next.slice(next.lastIndexOf(" ... "))}`;
      i++;
    }
    const m =
      /^([\w.]+) \(([\w.]+)\)(?: .*?)? \.\.\. (ok|FAIL|ERROR|skipped.*|expected failure|unexpected success)$/.exec(
        line,
      );
    if (!m) continue;
    const id = fullId(m[1] ?? "", m[2] ?? "");
    const word = m[3] ?? "";
    // A module that didn't import ("unittest.loader._FailedTest.pkg.test_a"): the file failed.
    if (/^unittest\.loader\._FailedTest\./.test(id)) {
      const module = m[1] ?? "";
      const file = `${module.replace(/\./g, "/")}.py`;
      results.set(testId("unittest", file, []), {
        status: "failed",
        message: clip(details.get(id) ?? `${module} failed to import`),
      });
      continue;
    }
    const status =
      word === "ok" || word === "expected failure"
        ? "passed"
        : word.startsWith("skipped")
          ? "skipped"
          : "failed";
    const found = known.get(id);
    const parts = id.split(".");
    const path = found?.path ?? [parts.at(-2) ?? "", parts.at(-1) ?? ""];
    const file = found?.file ?? `${parts.slice(0, -2).join("/")}.py`;
    const testIdValue = found?.id ?? testId("unittest", file, path);
    const message = status === "failed" ? (details.get(id) ?? word) : "";
    const detail = details.get(id);
    const result: TestResult = {
      status,
      ...(message && { message: clip(message) }),
      ...(status === "failed" && detail && { output: clipOutput(plain.recolor(detail)) }),
    };
    results.set(
      testIdValue,
      status === "failed" ? withValues(result, fromMessage(message)) : result,
    );
    if (!found) extra.push({ id: testIdValue, framework: "unittest", file, path, line: 1 });
  }
  const ran = /^Ran (\d+) tests? in ([\d.]+)s/m.exec(text);
  const outcome = /^(OK|FAILED)(?: \((.*)\))?$/m.exec(text);
  return {
    results,
    extra,
    ...(ran && {
      summary: `${ran[1]} ran${outcome ? `, ${outcome[1] === "OK" ? "OK" : `failed (${outcome[2] ?? ""})`}` : ""}`,
    }),
  };
}
