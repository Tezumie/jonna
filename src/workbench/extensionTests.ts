// Extensions' test controllers (VS Code's `tests.createTestController`, D247): the tests an extension's
// code finds and runs, shown in the Testing view next to the built-in frameworks' and run from it
// through the extension's run profiles. The extensions host keeps one entry per controller here
// (runtimeTesting.ts); the testing extension draws and runs them (extensionTestsView.ts,
// extensionTestCommands.ts). This file holds the shared shapes and the checks of what a worker
// sends (its items' snapshot, its runs' events). DOM-free, unit-tested.
import type { ReadonlySignal } from "../core/reactive/index";
import { OwnedList } from "./extensionRegistries";

/** One test item, as the host keeps it (the tree is flat: each names its parent). */
export interface ExtTestItem {
  /** The worker's id for the item object (unique in its controller). */
  wid: string;
  /** Its parent's `wid`; null at the top. */
  parent: string | null;
  /** The extension's own id of the item (unique among its siblings). */
  id: string;
  label: string;
  description?: string;
  /** Absolute path of its file in the open folder. */
  path?: string;
  /** 1-based. */
  line?: number;
  /** It may have children the extension finds when asked (resolveHandler). */
  canResolveChildren: boolean;
  busy: boolean;
  /** Why it couldn't be loaded (shown instead of a result). */
  error?: string;
  sortText?: string;
  /** Its test tags' ids (VS Code's TestTag, D255): a profile with a tag runs only these. */
  tags?: string[];
}

export type ExtTestProfileKind = "run" | "debug" | "coverage";

export interface ExtTestProfile {
  id: string;
  label: string;
  kind: ExtTestProfileKind;
  isDefault: boolean;
  /** Only for items with this tag (VS Code's TestRunProfile.tag, D255). */
  tag?: string;
}

/**
 * One file's coverage from a run (D255, VS Code's FileCoverage with its detailed statements):
 * workspace-relative path, line → times it ran, line → branches (taken, all), functions.
 */
export interface ExtFileCoverage {
  file: string;
  lines: [line: number, count: number][];
  branches?: [line: number, taken: number, total: number][];
  functions?: { name: string; line: number; hits: number }[];
}

export type ExtTestStatus = "queued" | "running" | "passed" | "failed" | "skipped";

export interface ExtTestResult {
  status: ExtTestStatus;
  durationMs?: number;
  /** A failure's message (the first one's, with its expected / actual values). */
  message?: string;
  expected?: string;
  actual?: string;
  /** Where it failed (VS Code's TestMessage.location, D264), a workspace path. */
  location?: { path: string; line: number };
}

/** What a run reports, in order (a worker's batch). */
export type ExtTestRunEvent =
  | { kind: "enqueued" | "started" | "skipped"; test: string }
  | { kind: "passed"; test: string; durationMs?: number }
  | {
      kind: "failed" | "errored";
      test: string;
      durationMs?: number;
      message?: string;
      expected?: string;
      actual?: string;
    }
  | { kind: "output"; text: string; test?: string }
  /** A file's coverage (D255: run.addCoverage). */
  | {
      kind: "coverage";
      path: string;
      lines: unknown;
      branches?: unknown;
      functions?: unknown;
    };

export interface ExtTestController {
  owner: string;
  /** "<extension id>/<controller id>": unique. */
  key: string;
  id: string;
  label: string;
  readonly items: ReadonlySignal<readonly ExtTestItem[]>;
  readonly profiles: ReadonlySignal<readonly ExtTestProfile[]>;
  /** It has a resolveHandler: items with `canResolveChildren` load when opened. */
  readonly resolvable: ReadonlySignal<boolean>;
  /** Each item's last result, by `wid`. */
  readonly results: ReadonlySignal<ReadonlyMap<string, ExtTestResult>>;
  /** A run is under way. */
  readonly running: ReadonlySignal<boolean>;
  /** The coverage the last run reported (D255: its coverage profile's run.addCoverage). */
  readonly coverage: ReadonlySignal<readonly ExtFileCoverage[]>;
  /** The output of the runs since the last one started (appendOutput). */
  output(): string;
  /**
   * Runs `include` (default: everything) with the default profile of `kind` (or the first of
   * it); resolves when the extension's run handler returns.
   */
  run(kind: ExtTestProfileKind, include?: readonly string[]): Promise<void>;
  /** Asks the extension for an item's children (none: the top-level items). */
  resolve(wid?: string): Promise<void>;
  /** Cancels the runs under way (their token). */
  cancel(): void;
}

export class ExtensionTestRegistry extends OwnedList<ExtTestController> {}

/** Limits, so one extension can't flood the view. */
export const MAX_TEST_ITEMS = 20_000;
const MAX_TEXT = 200;
const MAX_MESSAGE = 20_000;
export const MAX_TEST_OUTPUT = 1_000_000;

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v ? v.slice(0, max) : undefined;

/**
 * A worker's snapshot of its items, checked: each needs a `wid` and a label; a parent that isn't
 * there (or comes after its child) puts the item at the top; `path` goes through `resolvePath`
 * (inside the open folder, else dropped); at most MAX_TEST_ITEMS.
 */
export function checkTestItems(
  raw: unknown,
  resolvePath: (path: string) => string | null,
): ExtTestItem[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtTestItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= MAX_TEST_ITEMS) break;
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const wid = str(r.wid, 40);
    const label = str(r.label, MAX_TEXT) ?? str(r.id, MAX_TEXT);
    if (!wid || !label || seen.has(wid)) continue;
    seen.add(wid);
    const parent = typeof r.parent === "string" && seen.has(r.parent) ? r.parent : null;
    const rawPath = str(r.path, 4000);
    const path = rawPath ? resolvePath(rawPath) : null;
    const line =
      typeof r.line === "number" && Number.isFinite(r.line) && r.line >= 1
        ? Math.floor(r.line)
        : undefined;
    const description = str(r.description, MAX_TEXT);
    const error = str(r.error, MAX_MESSAGE);
    const sortText = str(r.sortText, MAX_TEXT);
    const tags = Array.isArray(r.tags)
      ? r.tags
          .filter((t): t is string => typeof t === "string" && !!t)
          .slice(0, 20)
          .map((t) => t.slice(0, 100))
      : [];
    out.push({
      wid,
      parent,
      id: str(r.id, MAX_TEXT) ?? wid,
      label,
      ...(description && { description }),
      ...(path && { path }),
      ...(path && line !== undefined && { line }),
      canResolveChildren: r.canResolveChildren === true,
      busy: r.busy === true,
      ...(error && { error }),
      ...(sortText && { sortText }),
      ...(tags.length && { tags }),
    });
  }
  return out;
}

const KINDS: readonly ExtTestProfileKind[] = ["run", "debug", "coverage"];

/** A worker's run profiles, checked (at most 20). */
export function checkTestProfiles(raw: unknown): ExtTestProfile[] {
  if (!Array.isArray(raw)) return [];
  const out: ExtTestProfile[] = [];
  for (const entry of raw.slice(0, 20)) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const id = str(r.id, 40);
    const kind = KINDS.find((k) => k === r.kind);
    if (!id || !kind || out.some((p) => p.id === id)) continue;
    const tag = str(r.tag, 100);
    out.push({
      id,
      label: str(r.label, MAX_TEXT) ?? kind,
      kind,
      isDefault: r.isDefault === true,
      ...(tag && { tag }),
    });
  }
  return out;
}

/**
 * The profile a Run / Debug / Coverage button uses: the kind's default, else its first. With the
 * items' `tags` (D255), only a profile without a tag or with one of them.
 */
export function profileFor(
  profiles: readonly ExtTestProfile[],
  kind: ExtTestProfileKind,
  tags?: readonly string[],
): ExtTestProfile | undefined {
  const of = profiles.filter((p) => p.kind === kind && (!tags || !p.tag || tags.includes(p.tag)));
  return of.find((p) => p.isDefault) ?? of[0];
}

/** At most this many files of coverage from one run. */
const MAX_COVERAGE_FILES = 2000;

/**
 * The coverage a run's events report (D255), checked: files inside the folder only
 * (`resolvePath` gives the workspace-relative path, or null), lines and branches as numbers.
 * A file reported twice keeps the last report.
 */
export function coverageOf(
  raw: unknown,
  resolvePath: (path: string) => string | null,
): ExtFileCoverage[] {
  if (!Array.isArray(raw)) return [];
  const byFile = new Map<string, ExtFileCoverage>();
  const n = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
  for (const e of raw) {
    if (!e || typeof e !== "object" || (e as { kind?: unknown }).kind !== "coverage") continue;
    const r = e as Record<string, unknown>;
    const file = typeof r.path === "string" ? resolvePath(r.path) : null;
    if (!file || (byFile.size >= MAX_COVERAGE_FILES && !byFile.has(file))) continue;
    const lines: [number, number][] = [];
    for (const x of Array.isArray(r.lines) ? r.lines.slice(0, 200_000) : []) {
      const pair = Array.isArray(x)
        ? x
        : [(x as { line?: unknown })?.line, (x as { count?: unknown })?.count];
      const line = n(pair[0]);
      const count = n(pair[1]);
      if (line && count !== null) lines.push([line, count]);
    }
    const branches: [number, number, number][] = [];
    for (const x of Array.isArray(r.branches) ? r.branches.slice(0, 100_000) : []) {
      const t = Array.isArray(x) ? x : [];
      const line = n(t[0]);
      const taken = n(t[1]);
      const total = n(t[2]);
      if (line && taken !== null && total && taken <= total) branches.push([line, taken, total]);
    }
    const functions: { name: string; line: number; hits: number }[] = [];
    for (const x of Array.isArray(r.functions) ? r.functions.slice(0, 20_000) : []) {
      const f = (x ?? {}) as Record<string, unknown>;
      const name = str(f.name, 300);
      const hits = n(f.hits);
      if (name && hits !== null) functions.push({ name, line: n(f.line) ?? 0, hits });
    }
    byFile.set(file, {
      file,
      lines,
      ...(branches.length && { branches }),
      ...(functions.length && { functions }),
    });
  }
  return [...byFile.values()];
}

/**
 * Applies a run's events to the results (a new map) and returns the output they add. Events for
 * items the controller doesn't have are kept too (an item may arrive in a later snapshot).
 */
export function applyTestRunEvents(
  results: ReadonlyMap<string, ExtTestResult>,
  raw: unknown,
  /** A failure's location as a workspace path, or null outside it (D264). */
  resolvePath: (path: string) => string | null = () => null,
): { results: Map<string, ExtTestResult>; output: string } {
  const next = new Map(results);
  let output = "";
  if (!Array.isArray(raw)) return { results: next, output };
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.kind === "output") {
      if (typeof e.text === "string") output += e.text;
      continue;
    }
    const test = str(e.test, 40);
    if (!test) continue;
    const durationMs =
      typeof e.durationMs === "number" && Number.isFinite(e.durationMs) && e.durationMs >= 0
        ? Math.round(e.durationMs)
        : undefined;
    switch (e.kind) {
      case "enqueued":
        next.set(test, { status: "queued" });
        break;
      case "started":
        next.set(test, { status: "running" });
        break;
      case "skipped":
        next.set(test, { status: "skipped" });
        break;
      case "passed":
        next.set(test, { status: "passed", ...(durationMs !== undefined && { durationMs }) });
        break;
      case "failed":
      case "errored": {
        const message = str(e.message, MAX_MESSAGE);
        const expected = str(e.expected, MAX_MESSAGE);
        const actual = str(e.actual, MAX_MESSAGE);
        const loc = (e.location && typeof e.location === "object" ? e.location : {}) as {
          path?: unknown;
          line?: unknown;
        };
        const locPath = typeof loc.path === "string" ? resolvePath(loc.path.slice(0, 4000)) : null;
        const locLine =
          typeof loc.line === "number" && Number.isFinite(loc.line) && loc.line >= 1
            ? Math.floor(loc.line)
            : undefined;
        next.set(test, {
          status: "failed",
          ...(durationMs !== undefined && { durationMs }),
          ...(message && { message }),
          ...(expected !== undefined && { expected }),
          ...(actual !== undefined && { actual }),
          ...(locPath && locLine !== undefined && { location: { path: locPath, line: locLine } }),
        });
        break;
      }
    }
  }
  return { results: next, output };
}

/** A run ended: what it left queued or running didn't run (VS Code shows them as not run). */
export function settleTestResults(
  results: ReadonlyMap<string, ExtTestResult>,
): Map<string, ExtTestResult> {
  const next = new Map(results);
  for (const [wid, r] of next)
    if (r.status === "queued" || r.status === "running") next.delete(wid);
  return next;
}

/** The items under `parent` (null: the top), in the extension's order (`sortText`, then label). */
export function testChildren(items: readonly ExtTestItem[], parent: string | null): ExtTestItem[] {
  return items
    .filter((i) => i.parent === parent)
    .sort((a, b) => {
      const ka = a.sortText ?? a.label;
      const kb = b.sortText ?? b.label;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
}

/** The leaves under (and including) `wid`: what a result rolls up from. */
export function testLeaves(items: readonly ExtTestItem[], wid: string | null): ExtTestItem[] {
  const byParent = new Map<string | null, ExtTestItem[]>();
  for (const i of items) byParent.set(i.parent, [...(byParent.get(i.parent) ?? []), i]);
  const out: ExtTestItem[] = [];
  const walk = (at: string | null) => {
    for (const child of byParent.get(at) ?? []) {
      if (byParent.has(child.wid)) walk(child.wid);
      else out.push(child);
    }
  };
  const self = wid === null ? undefined : items.find((i) => i.wid === wid);
  if (self && !byParent.has(self.wid)) return [self];
  walk(wid);
  return out;
}

/** The status a parent row shows: running, failed, then passed / skipped when all are. */
export function rollUpStatus(
  results: ReadonlyMap<string, ExtTestResult>,
  wids: readonly string[],
): ExtTestStatus | "unknown" {
  let any = false;
  let all = true;
  let skipped = true;
  for (const wid of wids) {
    const s = results.get(wid)?.status;
    if (s === "running" || s === "queued") return "running";
    if (s === "failed") return "failed";
    if (s === "passed" || s === "skipped") any = true;
    else all = false;
    if (s !== "skipped") skipped = false;
  }
  if (!wids.length || !any) return "unknown";
  return skipped ? "skipped" : all ? "passed" : "unknown";
}
