// Continuous run (VS Code's "Turn on continuous run"): which tests to run again after files were
// saved. Turned on for the whole run (every test) or for single files and tests. DOM-free and
// tested; continuousRun.ts debounces the saves and runs what this returns.
//
// Without a module graph, "affected" is a guess from names and folders, like VS Code's test
// extensions without their framework's watch mode:
// - a saved test file runs its own tests;
// - a saved source file runs the tests named after it (`util.ts` → `util.test.ts`,
//   `test_util.py`, `util_test.go`) in its project, the tests in its folder for Go and Rust,
//   and when none match, its project's tests;
// - files that aren't code (README.md, images) run nothing.

/** What continuousRun needs to know about a test (a subset of controller's Discovered). */
export interface WatchedTest {
  id: string;
  file: string;
  /** The project folder, relative ("" the root). */
  project: string;
}

/** What continuous run is on for. */
export interface ContinuousWatch {
  /** Every test (the Testing view's toggle). */
  all: boolean;
  /** Test files (relative). */
  files: ReadonlySet<string>;
  /** Single tests, by id. */
  tests: ReadonlySet<string>;
}

/** What to run: some files' tests, or one test. */
export type ContinuousTarget = { files: string[] } | { testId: string };

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|vue|svelte|py|rs|go|json|toml|mod)$/i;

export function isWatchable(rel: string): boolean {
  return (
    CODE.test(rel) &&
    !/(^|\/)(node_modules|target|dist|build|out|coverage|\.git|\.venv|venv|__pycache__)\//.test(rel)
  );
}

const dirOf = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const baseOf = (rel: string) => rel.slice(rel.lastIndexOf("/") + 1);

/** A file's name without test markers and extensions: `util.test.ts`, `test_util.py` → `util`. */
export function stemOf(rel: string): string {
  return baseOf(rel)
    .replace(/\.[^.]+$/, "")
    .replace(/\.(test|spec)$/, "")
    .replace(/^test_/, "")
    .replace(/_test$/, "")
    .toLowerCase();
}

const inProject = (rel: string, project: string) => !project || rel.startsWith(`${project}/`);

/** The test files a save of `saved` (a relative path) affects, among `files` (with projects). */
export function affectedFiles(
  saved: string,
  tests: readonly WatchedTest[],
  testFiles: ReadonlySet<string> = new Set(tests.map((t) => t.file)),
): string[] {
  if (!isWatchable(saved)) return [];
  if (testFiles.has(saved)) return [saved];
  // The project the saved file belongs to: the deepest test project that contains it.
  const projects = [...new Set(tests.map((t) => t.project))].filter((p) => inProject(saved, p));
  if (!projects.length) return [];
  const project = projects.sort((a, b) => b.length - a.length)[0] ?? "";
  const mine = [...new Set(tests.filter((t) => t.project === project).map((t) => t.file))];
  const stem = stemOf(saved);
  const dir = dirOf(saved);
  const named = mine.filter((f) => stemOf(f) === stem);
  // Go's and Rust's tests live with the code they test: the same folder.
  const sameFolder = /\.(go|rs)$/.test(saved) ? mine.filter((f) => dirOf(f) === dir) : [];
  const related = [...new Set([...named, ...sameFolder])];
  return related.length ? related : mine;
}

/**
 * What to run after `saved` (relative paths) were saved, given what continuous run is on for.
 * Files first (one run for all of them), then single tests whose file isn't among them.
 */
export function continuousTargets(
  saved: readonly string[],
  tests: readonly WatchedTest[],
  watch: ContinuousWatch,
): ContinuousTarget[] {
  const testFiles = new Set(tests.map((t) => t.file));
  const affected = new Set<string>();
  for (const s of saved) for (const f of affectedFiles(s, tests, testFiles)) affected.add(f);
  if (!affected.size) return [];
  const files = new Set<string>();
  if (watch.all) for (const f of affected) files.add(f);
  for (const f of watch.files) if (affected.has(f)) files.add(f);
  const out: ContinuousTarget[] = [];
  if (files.size) out.push({ files: [...files].sort() });
  for (const id of watch.tests) {
    const t = tests.find((x) => x.id === id);
    if (t && affected.has(t.file) && !files.has(t.file)) out.push({ testId: id });
  }
  return out;
}
