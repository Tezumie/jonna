// Test coverage (D204), DOM-free and tested: the reports frameworks write read into one shape
// (per file: hits per line, branches per line, functions), merged across the commands of a run,
// and summed into percentages for the Test coverage view, the editor's margin and agents. Formats:
// lcov (node:test, c8, cargo llvm-cov), Istanbul's coverage-final.json (Jest, Vitest),
// coverage.py's JSON (pytest-cov, coverage run) and Go's -coverprofile.

export interface Counts {
  covered: number;
  total: number;
}

export interface FileCoverage {
  /** Relative to the workspace root, with `/`. */
  file: string;
  /** 1-based line → how many times it ran (0: never). Lines without code aren't in it. */
  lines: Map<number, number>;
  /** 1-based line → its branches (taken, all). */
  branches: Map<number, Counts>;
  functions: Counts;
  /**
   * Its functions by name, where the report names them (lcov `FN`, Istanbul's `fnMap`, coverage.py
   * 7.5+): VS Code's declarations under a file in the Test coverage view.
   */
  declarations?: Declaration[];
  /**
   * Which tests ran each line (D233, VS Code's per-test coverage): line → the tests' keys
   * (`testCoverageKey`: "file::Class::test" for pytest, from coverage.py's dynamic contexts; an
   * lcov `TN:` name as written). Only reports with per-test data have it.
   */
  contexts?: Map<number, string[]>;
  /**
   * Each branch's arms where the report gives their place (Istanbul's branchMap): line → the
   * 1-based column each arm starts at and whether it ran (D233: markers at the exact column).
   */
  branchArms?: Map<number, BranchArm[]>;
}

/** One way a branch can go, where it starts. */
export interface BranchArm {
  column: number;
  taken: boolean;
}

/** A function the report lists: where it starts and how often it ran. */
export interface Declaration {
  name: string;
  /** 1-based; 0 when the report doesn't say. */
  line: number;
  hits: number;
}

export interface CoverageTotals {
  lines: Counts;
  branches: Counts;
  functions: Counts;
}

/**
 * Turns a path a report printed (absolute, or relative to where the command ran) into a
 * workspace-relative one; null drops the file (outside the workspace, dependencies).
 */
export type ResolvePath = (path: string) => string | null;

/** The usual resolver: `root` is the workspace, `cwd` where the command ran (both absolute). */
export function resolverFor(root: string, cwd: string): ResolvePath {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root);
  const c = norm(cwd);
  return (path) => {
    let p = norm(path.trim()).replace(/^file:\/\//, "");
    if (!p) return null;
    // Windows drive paths may come as /C:/… from file URLs.
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    const absolute = p.startsWith("/") || /^[A-Za-z]:\//.test(p);
    let full = absolute ? p : `${c}/${p.replace(/^\.\//, "")}`;
    // "a/../b" segments (relative reports from sub-folders).
    const parts: string[] = [];
    for (const seg of full.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== ".") parts.push(seg);
    }
    full = parts.join("/");
    const lower = full.toLowerCase();
    const base = r.toLowerCase();
    if (!lower.startsWith(`${base}/`)) return null;
    const rel = full.slice(r.length + 1);
    if (/(^|\/)node_modules\//.test(rel)) return null;
    return rel;
  };
}

function empty(file: string): FileCoverage {
  return { file, lines: new Map(), branches: new Map(), functions: { covered: 0, total: 0 } };
}

/** lcov tracefiles: SF / DA / BRDA / FNF / FNH / end_of_record. */
export function parseLcov(text: string, resolve: ResolvePath): FileCoverage[] {
  const out: FileCoverage[] = [];
  let current: FileCoverage | null = null;
  let fnFound = -1;
  let fnHit = -1;
  const fnHits = new Map<string, number>();
  const fnLines = new Map<string, number>();
  // The test a record is for (lcov's TN:, when a tool writes one per test).
  let testName = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("TN:")) {
      testName = line.slice(3).trim();
      continue;
    }
    if (line.startsWith("SF:")) {
      const file = resolve(line.slice(3));
      current = file ? empty(file) : null;
      fnFound = -1;
      fnHit = -1;
      fnHits.clear();
      fnLines.clear();
      continue;
    }
    if (!current) continue;
    if (line === "end_of_record") {
      current.functions =
        fnFound >= 0
          ? { covered: Math.max(0, fnHit), total: fnFound }
          : { covered: [...fnHits.values()].filter((n) => n > 0).length, total: fnHits.size };
      const names = new Set([...fnLines.keys(), ...fnHits.keys()]);
      if (names.size)
        current.declarations = sortDeclarations(
          [...names].map((name) => ({
            name,
            line: fnLines.get(name) ?? 0,
            hits: fnHits.get(name) ?? 0,
          })),
        );
      out.push(current);
      current = null;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon);
    const fields = line.slice(colon + 1).split(",");
    if (key === "DA") {
      const n = Number(fields[0]);
      const hits = Number(fields[1]);
      if (n > 0 && Number.isFinite(hits)) {
        current.lines.set(n, Math.max(current.lines.get(n) ?? 0, hits));
        if (testName && hits > 0) addContext(current, n, testName);
      }
    } else if (key === "BRDA") {
      const n = Number(fields[0]);
      if (!(n > 0)) continue;
      const taken = fields[3];
      const b = current.branches.get(n) ?? { covered: 0, total: 0 };
      b.total++;
      if (taken !== undefined && taken !== "-" && Number(taken) > 0) b.covered++;
      current.branches.set(n, b);
    } else if (key === "FN") {
      // FN:<line>[,<end line>],<name> (lcov 2.0 added the end line).
      const n = Number(fields[0]);
      const name = (
        Number.isFinite(Number(fields[1])) && fields.length > 2 ? fields.slice(2) : fields.slice(1)
      ).join(",");
      if (name && lineNo(n)) fnLines.set(name, n);
    } else if (key === "FNDA") {
      const name = fields.slice(1).join(",");
      fnHits.set(name, Math.max(fnHits.get(name) ?? 0, Number(fields[0]) || 0));
    } else if (key === "FNF") fnFound = Number(fields[0]) || 0;
    else if (key === "FNH") fnHit = Number(fields[0]) || 0;
  }
  return out;
}

// Reports are read as untrusted JSON: a field of the wrong type is skipped, never thrown on (a
// broken report would otherwise lose the whole run's results).
type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
/** Lines past this aren't real source lines (a malformed report). */
const MAX_LINE = 10_000_000;
const lineNo = (v: unknown): number =>
  typeof v === "number" && Number.isInteger(v) && v > 0 && v <= MAX_LINE ? v : 0;
/** One Go coverage block spans at most this many lines. */
const MAX_BLOCK_LINES = 100_000;

/** Istanbul's coverage-final.json (Jest's and Vitest's `json` reporter). */
export function parseIstanbulJson(text: string, resolve: ResolvePath): FileCoverage[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const out: FileCoverage[] = [];
  for (const [key, value] of Object.entries(obj(data))) {
    if (!value || typeof value !== "object") continue;
    const entry = obj(value);
    const file = resolve(typeof entry.path === "string" ? entry.path : key);
    if (!file) continue;
    const fc = empty(file);
    const s = obj(entry.s);
    for (const [id, loc] of Object.entries(obj(entry.statementMap))) {
      const n = lineNo(obj(obj(loc).start).line);
      if (!n) continue;
      fc.lines.set(n, Math.max(fc.lines.get(n) ?? 0, count(s[id])));
    }
    const bs = obj(entry.b);
    for (const [id, raw] of Object.entries(obj(entry.branchMap))) {
      const br = obj(raw);
      const n = lineNo(br.line) || lineNo(obj(obj(br.loc).start).line);
      const counts = list(bs[id]);
      if (!n || !counts.length) continue;
      const b = fc.branches.get(n) ?? { covered: 0, total: 0 };
      b.total += counts.length;
      b.covered += counts.filter((c) => count(c) > 0).length;
      fc.branches.set(n, b);
      // Where each arm starts (columns are 0-based in Istanbul's maps).
      list(br.locations).forEach((loc, i) => {
        const start = obj(obj(loc).start);
        const armLine = lineNo(start.line);
        const column = start.column;
        if (!armLine || typeof column !== "number" || !Number.isInteger(column) || column < 0)
          return;
        const arms = fc.branchArms ?? new Map<number, BranchArm[]>();
        fc.branchArms = arms;
        const at = arms.get(armLine) ?? [];
        at.push({ column: column + 1, taken: count(counts[i]) > 0 });
        arms.set(armLine, at);
      });
    }
    const fns = Object.keys(obj(entry.fnMap));
    const f = obj(entry.f);
    fc.functions = {
      total: fns.length,
      covered: fns.filter((id) => count(f[id]) > 0).length,
    };
    const declarations = Object.entries(obj(entry.fnMap)).map(([id, raw]) => {
      const fn = obj(raw);
      return {
        name: typeof fn.name === "string" && fn.name ? fn.name : "(anonymous)",
        line: lineNo(obj(obj(fn.decl).start).line) || lineNo(obj(obj(fn.loc).start).line),
        hits: count(f[id]),
      };
    });
    if (declarations.length) fc.declarations = sortDeclarations(declarations);
    out.push(fc);
  }
  return out;
}

/** coverage.py's `coverage json` (pytest-cov's `--cov-report=json`). */
export function parseCoveragePyJson(text: string, resolve: ResolvePath): FileCoverage[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const out: FileCoverage[] = [];
  for (const [path, raw] of Object.entries(obj(obj(data).files))) {
    const file = resolve(path);
    if (!file) continue;
    const f = obj(raw);
    const fc = empty(file);
    for (const v of list(f.executed_lines)) {
      const n = lineNo(v);
      if (n) fc.lines.set(n, 1);
    }
    for (const v of list(f.missing_lines)) {
      const n = lineNo(v);
      if (n && !fc.lines.has(n)) fc.lines.set(n, 0);
    }
    const branch = (pairs: unknown, taken: boolean) => {
      for (const pair of list(pairs)) {
        const from = lineNo(list(pair)[0]);
        if (!from) continue;
        const b = fc.branches.get(from) ?? { covered: 0, total: 0 };
        b.total++;
        if (taken) b.covered++;
        fc.branches.set(from, b);
      }
    };
    branch(f.executed_branches, true);
    branch(f.missing_branches, false);
    // `coverage json --show-contexts` (pytest-cov's --cov-context=test): each line's tests.
    for (const [lineText, names] of Object.entries(obj(f.contexts))) {
      const n = lineNo(Number(lineText));
      if (!n) continue;
      for (const name of list(names)) {
        const key = typeof name === "string" ? contextKey(name, resolve) : null;
        if (key) addContext(fc, n, key);
      }
    }
    // coverage.py 7.5+ lists functions (the "" entry is the module's own code).
    const fns = Object.entries(obj(f.functions)).filter(([name]) => name !== "");
    fc.functions = {
      total: fns.length,
      covered: fns.filter(([, v]) => count(obj(obj(v).summary).covered_lines) > 0).length,
    };
    if (fns.length)
      fc.declarations = sortDeclarations(
        fns.map(([name, v]) => {
          const lines = [...list(obj(v).executed_lines), ...list(obj(v).missing_lines)]
            .map(lineNo)
            .filter((n) => n > 0);
          return {
            name,
            line: lines.length ? Math.min(...lines) : 0,
            hits: count(obj(obj(v).summary).covered_lines) > 0 ? 1 : 0,
          };
        }),
      );
    out.push(fc);
  }
  return out;
}

/**
 * Go's -coverprofile ("mode: set" then `importpath/file.go:sl.sc,el.ec stmts count`). `resolve`
 * gets the import path of the file ("example.com/mod/pkg/a.go"); a line ran when any block on it
 * ran.
 */
export function parseGoProfile(text: string, resolve: ResolvePath): FileCoverage[] {
  const byFile = new Map<string, FileCoverage>();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^(.+\.go):(\d+)\.\d+,(\d+)\.(\d+) \d+ (\d+)$/.exec(raw.trim());
    if (!m) continue;
    const file = resolve(m[1] ?? "");
    if (!file) continue;
    let fc = byFile.get(file);
    if (!fc) {
      fc = empty(file);
      byFile.set(file, fc);
    }
    const start = Number(m[2]);
    let end = Number(m[3]);
    // A block ending at column 1 doesn't reach into that line.
    if (Number(m[4]) <= 1 && end > start) end--;
    // A broken line ("1.1,999999999.1") would fill a map with a billion lines.
    if (!lineNo(start) || !lineNo(end) || end - start > MAX_BLOCK_LINES) continue;
    const hits = Number(m[5]);
    for (let n = start; n <= end; n++) fc.lines.set(n, Math.max(fc.lines.get(n) ?? 0, hits));
  }
  return [...byFile.values()];
}

/** A Go import path's file → workspace-relative, given the module's path and its folder. */
export function goResolver(modulePath: string, projectDir: string): ResolvePath {
  const prefix = `${modulePath.replace(/\/+$/, "")}/`;
  return (p) => {
    const path = p.replace(/\\/g, "/");
    if (!path.startsWith(prefix)) return null;
    const rest = path.slice(prefix.length);
    // Stays inside the module's folder ("mod/../../x.go" in a broken profile doesn't).
    if (rest.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
    return projectDir ? `${projectDir}/${rest}` : rest;
  };
}

/** go.mod's `module` line. */
export function goModulePath(goMod: string): string | null {
  return /^\s*module\s+("?)([^\s"]+)\1/m.exec(goMod)?.[2] ?? null;
}

/**
 * A coverage.py dynamic context as a test key: pytest-cov's "t/test_a.py::TestA::test_b[1]|run"
 * → "t/test_a.py::TestA::test_b" (workspace-relative, parameters folded, the phase dropped);
 * null for code that ran outside a test (the "" context: imports).
 */
export function contextKey(context: string, resolve: ResolvePath): string | null {
  const nodeid = context.replace(/\|(run|setup|teardown)$/, "").trim();
  if (!nodeid) return null;
  const [file = "", ...names] = nodeid.split("::");
  if (!names.length) return nodeid;
  const rel = resolve(file) ?? file;
  return [rel, ...names.map((n) => n.replace(/\[.*\]$/, ""))].join("::");
}

/** The key a test's per-test coverage goes by ("file::Class::test", as contextKey makes). */
export function testCoverageKey(test: { file: string; path: readonly string[] }): string {
  return [test.file, ...test.path].join("::");
}

/** Whether a line's context names `test`: its key, or (lcov's TN:) its name. */
export function contextMatches(
  context: string,
  test: { file: string; path: readonly string[] },
): boolean {
  return (
    context === testCoverageKey(test) ||
    context === test.path.join(" ") ||
    context === test.path.join(" › ") ||
    (test.path.length === 1 && context === test.path[0])
  );
}

function addContext(fc: FileCoverage, line: number, key: string): void {
  const map = fc.contexts ?? new Map<number, string[]>();
  fc.contexts = map;
  const at = map.get(line);
  if (!at) map.set(line, [key]);
  else if (!at.includes(key)) at.push(key);
}

/** Whether any file of a report says which tests ran its lines. */
export function hasPerTestCoverage(files: readonly FileCoverage[]): boolean {
  return files.some((f) => f.contexts && f.contexts.size > 0);
}

/** Every test key a report names, sorted (the "Show coverage for test" picker). */
export function coverageContexts(files: readonly FileCoverage[]): string[] {
  const all = new Set<string>();
  for (const f of files)
    for (const keys of f.contexts?.values() ?? []) for (const k of keys) all.add(k);
  return [...all].sort();
}

/** The tests that ran `line` of a file (empty without per-test data). */
export function testsCovering(fc: FileCoverage, line: number): string[] {
  return fc.contexts?.get(line) ?? [];
}

/**
 * The coverage of one test (VS Code's "Show coverage for test"): per file, the lines it ran as
 * covered and the file's other lines as not; files it didn't run are left out. Branches and
 * functions aren't per test in any report, so they're left out too.
 */
export function coverageForTest(
  files: readonly FileCoverage[],
  test: { file: string; path: readonly string[] },
): FileCoverage[] {
  const out: FileCoverage[] = [];
  for (const fc of files) {
    if (!fc.contexts?.size) continue;
    const lines = new Map<number, number>();
    let ran = 0;
    for (const n of fc.lines.keys()) {
      const hit = (fc.contexts.get(n) ?? []).some((c) => contextMatches(c, test));
      lines.set(n, hit ? 1 : 0);
      if (hit) ran++;
    }
    if (!ran) continue;
    out.push({ ...empty(fc.file), lines });
  }
  return out;
}

/** By line, then name; one entry per name and line. */
function sortDeclarations(list: Declaration[]): Declaration[] {
  const seen = new Map<string, Declaration>();
  for (const d of list) {
    const key = `${d.line}:${d.name}`;
    const prev = seen.get(key);
    if (prev) prev.hits += d.hits;
    else seen.set(key, { ...d });
  }
  return [...seen.values()].sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

/** Several reports into one (the same file from two commands: the hits add up). */
export function mergeCoverage(...lists: readonly FileCoverage[][]): FileCoverage[] {
  const byFile = new Map<string, FileCoverage>();
  for (const list of lists)
    for (const fc of list) {
      const prev = byFile.get(fc.file);
      if (!prev) {
        byFile.set(fc.file, {
          file: fc.file,
          lines: new Map(fc.lines),
          branches: new Map([...fc.branches].map(([k, v]) => [k, { ...v }])),
          functions: { ...fc.functions },
          ...(fc.declarations && { declarations: fc.declarations.map((d) => ({ ...d })) }),
          ...(fc.contexts && {
            contexts: new Map([...fc.contexts].map(([k, v]) => [k, [...v]])),
          }),
          ...(fc.branchArms && {
            branchArms: new Map([...fc.branchArms].map(([k, v]) => [k, v.map((a) => ({ ...a }))])),
          }),
        });
        continue;
      }
      for (const [n, keys] of fc.contexts ?? []) for (const k of keys) addContext(prev, n, k);
      for (const [n, arms] of fc.branchArms ?? []) {
        const map = prev.branchArms ?? new Map<number, BranchArm[]>();
        prev.branchArms = map;
        const at = map.get(n) ?? [];
        for (const arm of arms) {
          const same = at.find((a) => a.column === arm.column);
          if (same) same.taken ||= arm.taken;
          else at.push({ ...arm });
        }
        map.set(n, at);
      }
      if (fc.declarations)
        prev.declarations = sortDeclarations([...(prev.declarations ?? []), ...fc.declarations]);
      for (const [n, hits] of fc.lines) prev.lines.set(n, (prev.lines.get(n) ?? 0) + hits);
      for (const [n, b] of fc.branches) {
        const p = prev.branches.get(n);
        // The same branches seen twice: the better count wins (not a sum, they're the same).
        if (!p || p.total < b.total) prev.branches.set(n, { ...b });
        else if (p.total === b.total) p.covered = Math.max(p.covered, b.covered);
      }
      if (fc.functions.total > prev.functions.total) prev.functions = { ...fc.functions };
      else if (fc.functions.total === prev.functions.total)
        prev.functions.covered = Math.max(prev.functions.covered, fc.functions.covered);
    }
  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}

export function fileTotals(fc: FileCoverage): CoverageTotals {
  let covered = 0;
  for (const hits of fc.lines.values()) if (hits > 0) covered++;
  const branches = { covered: 0, total: 0 };
  for (const b of fc.branches.values()) {
    branches.covered += b.covered;
    branches.total += b.total;
  }
  return { lines: { covered, total: fc.lines.size }, branches, functions: { ...fc.functions } };
}

export function totals(list: readonly FileCoverage[]): CoverageTotals {
  const t: CoverageTotals = {
    lines: { covered: 0, total: 0 },
    branches: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
  };
  for (const fc of list) {
    const f = fileTotals(fc);
    for (const k of ["lines", "branches", "functions"] as const) {
      t[k].covered += f[k].covered;
      t[k].total += f[k].total;
    }
  }
  return t;
}

/** Percent with one decimal, or null when there's nothing to cover. */
export function percent(c: Counts): number | null {
  return c.total ? Math.round((c.covered / c.total) * 1000) / 10 : null;
}

/**
 * VS Code's statement coverage: covered lines and branches over all of them (what the view and
 * the explorer show as one number).
 */
export function combinedPercent(t: CoverageTotals): number | null {
  return percent({
    covered: t.lines.covered + t.branches.covered,
    total: t.lines.total + t.branches.total,
  });
}

/** Line ranges ("3-4, 8") of the lines that never ran: what agents get back. */
export function uncoveredRanges(fc: FileCoverage, max = 60): string {
  const lines = [...fc.lines]
    .filter(([, hits]) => hits === 0)
    .map(([n]) => n)
    .sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < lines.length && ranges.length < max; ) {
    const start = lines[i] ?? 0;
    let end = start;
    while (lines[i + 1] === end + 1) {
      end++;
      i++;
    }
    i++;
    ranges.push(start === end ? String(start) : `${start}-${end}`);
  }
  return ranges.join(", ");
}

/**
 * The next line that didn't run fully (never ran, or a branch not taken) after `line`, or before
 * it (`direction` -1), wrapping around the file: VS Code's "Go to next / previous uncovered line"
 * of the editor's coverage toolbar. Null when every line ran.
 */
export function nextUncovered(fc: FileCoverage, line: number, direction: 1 | -1): number | null {
  const states = lineStates(fc);
  const missed = [...states]
    .filter(([, st]) => st !== "covered")
    .map(([n]) => n)
    .sort((a, b) => a - b);
  if (!missed.length) return null;
  if (direction === 1) return missed.find((n) => n > line) ?? missed[0] ?? null;
  return [...missed].reverse().find((n) => n < line) ?? missed.at(-1) ?? null;
}

/** The branch arms on `line` that never ran, by column (the margin's column markers). */
export function untakenArms(fc: FileCoverage, line: number): number[] {
  return (fc.branchArms?.get(line) ?? [])
    .filter((a) => !a.taken)
    .map((a) => a.column)
    .sort((a, b) => a - b);
}

/** How a line shows in the margin: ran, never ran, or ran with branches not taken. */
export type LineCoverage = "covered" | "uncovered" | "partial";

export function lineStates(fc: FileCoverage): Map<number, LineCoverage> {
  const out = new Map<number, LineCoverage>();
  for (const [n, hits] of fc.lines) {
    const b = fc.branches.get(n);
    out.set(n, hits === 0 ? "uncovered" : b && b.covered < b.total ? "partial" : "covered");
  }
  return out;
}
