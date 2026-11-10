// The Testing view's controller (D149, D204): finds tests in the workspace (a text search for test
// files, then each file read and scanned, see model.ts; Playwright and unittest are then listed by
// their own runner when the folder is trusted), runs them with their framework from the folder of
// their project (the nearest package.json, pyproject.toml, Cargo.toml or go.mod), and reads the
// results back — with coverage when asked (coverage.ts) and into the run history (history.ts).
// One run at a time; Stop cancels it. Nothing runs before the folder is trusted.
import { fsIpc, type LineMatch, searchIpc } from "../../core/ipc/fs";
import { execIpc } from "../../core/ipc/process";
import type { Disposable } from "../../core/lifecycle/index";
import { joinPath, relativePath } from "../../core/paths/index";
import {
  batch,
  computed,
  type ReadonlySignal,
  type Signal,
  signal,
} from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { workspaceFolderName, workspaceFolderPath } from "../../workbench/workspaceFolder";
import {
  coverageForTest,
  type FileCoverage,
  goModulePath,
  goResolver,
  mergeCoverage,
  parseCoveragePyJson,
  parseGoProfile,
  parseIstanbulJson,
  parseLcov,
  resolverFor,
} from "./coverage";
import {
  prefixRel,
  prefixRun,
  projectCandidates,
  renameTestFile,
  renameTestId,
  sameNaming,
  type TestNaming,
} from "./folders";
import {
  discoverUnittest,
  MOCHA_DEFAULT_SPEC,
  mochaSpec,
  parseMochaJson,
  parsePlaywrightJson,
  parseUnittest,
  parseUnittestList,
  specGlobs,
  unittestListCommand,
} from "./frameworks";
import { type HistoryTarget, RunHistory, type RunRecord } from "./history";
import {
  coverageReport,
  discoverGo,
  discoverJs,
  discoverPython,
  discoverRust,
  type Framework,
  jsFramework,
  type ParsedRun,
  parseCargo,
  parseGoJson,
  parseJestJson,
  parsePytest,
  parseTap,
  runCommand,
  TEST_FILE_GLOBS,
  type TestCase,
  type TestResult,
  type TestStatus,
  testRunEnv,
  unittestModule,
} from "./model";
import { parseCoverage, parseResults, serializeCoverage, serializeResults } from "./persist";

/** A test found in the workspace, with the folder its framework runs from. */
export interface Discovered extends TestCase {
  /**
   * The project folder, relative to the workspace root ("" for the root); with several folders
   * (D251), starting with its folder's name ("api" for that folder's top).
   */
  project: string;
}

export interface RunSummary {
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  finishedAt: number;
  commands: string[];
  /** The frameworks' own summary lines. */
  notes: string[];
  cancelled: boolean;
  /** The history entry this run made. */
  runId?: number;
}

export interface RunTarget extends HistoryTarget {}

/** A test whose coverage is shown alone (its key parts and its name). */
export interface CoverageTest {
  file: string;
  path: string[];
  label: string;
}

/** The last coverage run's report, merged over its commands. */
export interface CoverageReport {
  files: FileCoverage[];
  finishedAt: number;
  /** What ran ("All tests", a file…). */
  label: string;
  /** Commands that wrote no report, and why. */
  problems: string[];
}

const MAX_FILES = 600;
const MAX_FILE_BYTES = 1_000_000;
const MAX_OUTPUT = 8_000_000;
const MAX_REPORT_BYTES = 64_000_000;
const LIST_TIMEOUT_MS = 90_000;
const EXCLUDE = [
  "**/node_modules/**",
  "**/target/**",
  "**/dist/**",
  "**/build/**",
  "**/.venv/**",
  "**/venv/**",
  "**/.git/**",
  "**/vendor/**",
];

const PYTHON_MARKERS = ["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini", "setup.py"];
const PROJECT_MARKERS: Record<Framework, string[]> = {
  vitest: ["package.json"],
  jest: ["package.json"],
  node: ["package.json"],
  mocha: ["package.json"],
  playwright: ["package.json"],
  pytest: PYTHON_MARKERS,
  unittest: PYTHON_MARKERS,
  cargo: ["Cargo.toml"],
  go: ["go.mod"],
};

/** What to install when a coverage run wrote nothing. */
const COVERAGE_HINT: Partial<Record<Framework, string>> = {
  vitest: "install @vitest/coverage-v8 (npm i -D @vitest/coverage-v8)",
  jest: "check Jest's coverage settings",
  node: "node:test's lcov coverage needs Node 22 or later",
  mocha: "install c8 (npm i -D c8)",
  pytest: "install pytest-cov (pip install pytest-cov)",
  unittest: "install coverage (pip install coverage)",
  cargo: "install cargo-llvm-cov (cargo install cargo-llvm-cov)",
  go: "check the go test output",
};

const decoder = new TextDecoder();

export class TestController implements Disposable {
  readonly tests: Signal<readonly Discovered[]> = signal([]);
  readonly results: Signal<ReadonlyMap<string, TestResult | { status: "running" }>> = signal(
    new Map(),
  );
  /** What's running ("All tests", a file, a test), or null. */
  readonly running: Signal<string | null> = signal(null);
  readonly discovering = signal(false);
  readonly summary: Signal<RunSummary | null> = signal(null);
  /** Files that failed as a whole (didn't load): message by relative path. */
  readonly fileErrors: Signal<ReadonlyMap<string, string>> = signal(new Map());
  /** The last coverage run's report (null: none, or cleared). */
  readonly coverage: Signal<CoverageReport | null> = signal(null);
  /**
   * "Show coverage for test" (D233, from per-test data): the test whose lines the margin, the
   * explorer and the Test coverage tab show; null: every test's. A new report clears it.
   */
  readonly coverageTest: Signal<CoverageTest | null> = signal(null);
  /** The coverage shown: the last report, or the chosen test's part of it. */
  readonly shownCoverage: ReadonlySignal<CoverageReport | null> = computed(() => {
    const report = this.coverage.value;
    const test = this.coverageTest.value;
    if (!report || !test) return report;
    return { ...report, files: coverageForTest(report.files, test), label: test.label };
  });
  /** The last runs (bumped `historyVersion` when it changes). */
  readonly history = new RunHistory(20);
  readonly historyVersion = signal(0);
  /** The last run's output (all its commands). */
  output = "";
  private runId = "";
  private cancelled = false;
  private discovery = 0;

  constructor(private readonly services: WorkbenchServices) {}

  status(id: string): TestStatus {
    return this.results.peek().get(id)?.status ?? "unknown";
  }

  private get root(): string | null {
    return this.services.workspace.root.peek();
  }

  /** Several folders (D251): test files, ids and projects start with the folder's name. */
  private get multi(): boolean {
    return this.services.workspace.folders.peek().length > 1;
  }

  /** How test files and ids are named now (folders.ts). */
  naming(): TestNaming {
    const folders = this.services.workspace.folders.peek();
    const root = this.root;
    return {
      multi: this.multi,
      folders: folders.length
        ? folders.map((f) => ({ path: f.path, name: f.name }))
        : root
          ? [{ path: root, name: root }]
          : [],
    };
  }

  /**
   * The workspace's naming changed (D251: one folder to several and back, a folder renamed):
   * the last results and the history are renamed, so they stay with their tests.
   */
  rename(from: TestNaming, to: TestNaming = this.naming()): void {
    if (sameNaming(from, to)) return;
    const results = new Map<string, TestResult | { status: "running" }>();
    for (const [id, r] of this.results.peek()) {
      const renamed = renameTestId(id, from, to);
      if (renamed !== null) results.set(renamed, r);
    }
    this.results.value = results;
    this.history.rename(
      (id) => renameTestId(id, from, to),
      (file) => renameTestFile(file, from, to),
    );
    this.historyChanged();
  }

  /** A file as tests name it (folders.ts): relative to the root, or to its folder with its name. */
  private relOf(path: string): string {
    const root = this.root;
    if (!root) return path;
    return this.multi
      ? this.services.workspace.relative(path)
      : relativePath(root, path).replace(/\\/g, "/");
  }

  /** A rel path (a file, a project; "" for the root) made absolute. */
  private abs(rel: string): string {
    const root = this.root ?? "";
    if (this.multi) return this.services.workspace.resolve(rel);
    return rel ? joinPath(root, rel) : root;
  }

  /** The workspace folder a rel path is in, and the name its rel paths start with ("" for one). */
  private folderOfRel(rel: string): { path: string; prefix: string } {
    const root = this.root ?? "";
    if (!this.multi) return { path: root, prefix: "" };
    const head = rel.split("/")[0] ?? "";
    const folder = this.services.workspace.folders.peek().find((f) => f.name === head);
    return folder ? { path: folder.path, prefix: head } : { path: root, prefix: "" };
  }

  /** The folder's top project ("" for the root; a folder's name with several). */
  private topOf(rel: string): string {
    return this.multi ? (rel.split("/")[0] ?? "") : "";
  }

  private get windows(): boolean {
    return this.services.platform === "windows";
  }

  private async readText(path: string, max = MAX_FILE_BYTES): Promise<string | null> {
    const open = this.services.documents.text(path);
    if (open !== undefined && open !== null) return open;
    const stat = await fsIpc.stat(path).catch(() => null);
    if (!stat || stat.size > max) return null;
    return fsIpc.read(path).then(
      (b) => decoder.decode(b),
      () => null,
    );
  }

  /** Files whose text matches `query` (regex) under `include`. */
  private find(query: string, include: string[]): Promise<string[]> {
    const files = new Set<string>();
    return new Promise((resolve) => {
      searchIpc
        .start(
          {
            query,
            isRegex: true,
            matchCase: true,
            wholeWord: false,
            include,
            exclude: EXCLUDE,
            maxResults: 20000,
          },
          (e) => {
            if (e.kind === "file") {
              if (files.size < MAX_FILES && (e.matches as LineMatch[]).length) files.add(e.path);
            } else resolve([...files]);
          },
          true,
        )
        .catch(() => resolve([...files]));
    });
  }

  /** The nearest folder (up to the root) with one of `markers`, relative to the root. */
  private readonly markerCache = new Map<string, boolean>();
  private async exists(rel: string): Promise<boolean> {
    const root = this.root;
    if (!root) return false;
    let exists = this.markerCache.get(rel);
    if (exists === undefined) {
      exists = await fsIpc.stat(this.abs(rel)).then(
        () => true,
        () => false,
      );
      this.markerCache.set(rel, exists);
    }
    return exists;
  }

  private async projectOf(rel: string, framework: Framework): Promise<string | null> {
    // Never above the file's own workspace folder (D251).
    for (const dir of projectCandidates(rel, this.multi ? 1 : 0)) {
      for (const marker of PROJECT_MARKERS[framework])
        if (await this.exists(dir ? `${dir}/${marker}` : marker)) return dir;
    }
    // Python and node:test run from the root without a config file; the others need theirs.
    return framework === "pytest" || framework === "unittest" || framework === "node"
      ? this.topOf(rel)
      : null;
  }

  /** Mocha's projects: folders with a .mocharc file or package.json's "mocha", and their spec. */
  private async mochaProjects(): Promise<Map<string, string[]>> {
    const root = this.root;
    const out = new Map<string, string[]>();
    if (!root) return out;
    const [rcs, pkgs] = await Promise.all([
      // Any non-empty config (an empty one still says "Mocha", but there's nothing to read).
      this.find(String.raw`\S`, [
        "**/.mocharc.{json,jsonc,yml,yaml,js,cjs,mjs}",
        ".mocharc.{json,jsonc,yml,yaml,js,cjs,mjs}",
      ]),
      this.find(String.raw`"mocha"\s*:`, ["**/package.json"]),
    ]);
    for (const path of [...rcs, ...pkgs]) {
      const rel = this.relOf(path);
      const name = rel.split("/").pop() ?? "";
      const dir = rel.slice(0, Math.max(0, rel.length - name.length - 1));
      const text = await this.readText(path);
      const kind = name === "package.json" ? "package" : /\.ya?ml$/.test(name) ? "yaml" : "json";
      // A .js config can't be read without running it: Mocha's default spec then.
      const spec = /\.[cm]?js$/.test(name) ? [] : mochaSpec(text, kind);
      // package.json lists mocha as a dependency only: that's a Mocha project too.
      if (kind === "package" && !spec.length && !/"mocha"\s*:\s*\{/.test(text ?? "")) {
        if (!out.has(dir)) out.set(dir, []);
        continue;
      }
      out.set(dir, [...(out.get(dir) ?? []), ...spec]);
    }
    return out;
  }

  /** pytest or unittest for a Python file (testing.pythonRunner, else what the project uses). */
  private readonly pythonCache = new Map<string, boolean>();
  private async pythonFramework(text: string, rel: string): Promise<Framework> {
    const choice = this.services.settings.peek<string>("testing.pythonRunner") ?? "auto";
    if (choice === "pytest" || choice === "unittest") return choice;
    if (/^\s*(import pytest|from pytest\b)/m.test(text)) return "pytest";
    const usesUnittest =
      /^\s*(import unittest|from unittest\b)/m.test(text) && /\(\s*[\w.]*TestCase\s*\)/.test(text);
    if (!usesUnittest) return "pytest";
    // A project set up for pytest runs its unittest classes with pytest too.
    const project = (await this.projectOf(rel, "pytest")) ?? "";
    let pytest = this.pythonCache.get(project);
    if (pytest === undefined) {
      const at = (name: string) => this.abs(project ? `${project}/${name}` : name);
      const checks: [string, RegExp][] = [
        ["pytest.ini", /[\s\S]?/],
        ["conftest.py", /[\s\S]?/],
        ["pyproject.toml", /^\[tool\.pytest/m],
        ["setup.cfg", /^\[tool:pytest\]/m],
        ["tox.ini", /^\[pytest\]/m],
      ];
      pytest = false;
      for (const [name, re] of checks) {
        const t = await this.readText(at(name));
        if (t !== null && re.test(t)) {
          pytest = true;
          break;
        }
      }
      this.pythonCache.set(project, pytest);
    }
    return pytest ? "pytest" : "unittest";
  }

  /** Finds the workspace's tests (again). Returns how many. */
  async discover(): Promise<number> {
    const root = this.root;
    const generation = ++this.discovery;
    if (!root) {
      this.tests.value = [];
      return 0;
    }
    this.discovering.value = true;
    this.markerCache.clear();
    this.pythonCache.clear();
    try {
      const mocha = await this.mochaProjects();
      const mochaGlobs = [...mocha].flatMap(([dir, spec]) =>
        specGlobs(spec.length ? spec : MOCHA_DEFAULT_SPEC, dir),
      );
      const jsQuery = String.raw`\b(it|test|specify|describe|suite|context)(\.\w+)*\s*\(`;
      const [js, mochaFiles, py, rs, go] = await Promise.all([
        this.find(jsQuery, TEST_FILE_GLOBS.js),
        mochaGlobs.length ? this.find(jsQuery, mochaGlobs) : Promise.resolve([]),
        this.find(
          String.raw`^\s*(async\s+)?def\s+test|^class\s+\w+\s*\(.*TestCase|^class\s+Test`,
          TEST_FILE_GLOBS.py,
        ),
        this.find(String.raw`#\[(\w+::)*test\b`, TEST_FILE_GLOBS.rs),
        this.find(String.raw`^func\s+Test`, TEST_FILE_GLOBS.go),
      ]);
      const packages = new Map<string, string | null>();
      const packageJson = async (project: string) => {
        if (!packages.has(project))
          packages.set(
            project,
            await this.readText(this.abs(project ? `${project}/package.json` : "package.json")),
          );
        return packages.get(project) ?? null;
      };
      const found: Discovered[] = [];
      const add = async (
        path: string,
        framework: Framework | ((text: string, rel: string) => Promise<Framework | null>),
        scan: (text: string, rel: string, fw: Framework) => TestCase[],
      ) => {
        // Only the workspace's folders' files (any of them, D251).
        if (!this.services.workspace.contains(path)) return;
        const text = await this.readText(path);
        if (text === null) return;
        const rel = this.relOf(path);
        const fw = typeof framework === "string" ? framework : await framework(text, rel);
        if (!fw) return;
        const project = await this.projectOf(rel, fw);
        if (project === null) return;
        for (const t of scan(text, rel, fw)) found.push({ ...t, project });
      };
      const jsFw = async (text: string, rel: string): Promise<Framework | null> => {
        // The nearest package.json decides (monorepos: each package its own runner).
        const top = this.topOf(rel);
        const project = (await this.projectOf(rel, "jest")) ?? top;
        return (
          jsFramework(await packageJson(project), text, mocha.has(project)) ??
          jsFramework(await packageJson(top), text, mocha.has(top))
        );
      };
      for (const p of new Set([...js, ...mochaFiles]))
        await add(p, jsFw, (t, r, fw) => discoverJs(t, r, fw));
      for (const p of py)
        await add(
          p,
          (text, rel) => this.pythonFramework(text, rel),
          (t, r, fw) => (fw === "unittest" ? discoverUnittest(t, r) : discoverPython(t, r)),
        );
      for (const p of rs) await add(p, "cargo", (t, r) => discoverRust(t, r));
      for (const p of go) await add(p, "go", (t, r) => discoverGo(t, r));
      if (generation !== this.discovery) return this.tests.peek().length;
      // Playwright and unittest know their tests better (projects, parameters, any class name):
      // ask them, when the folder may run commands.
      const listed = await this.listWithRunners(found);
      if (generation !== this.discovery) return this.tests.peek().length;
      listed.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
      this.tests.value = listed;
      return listed.length;
    } finally {
      if (generation === this.discovery) this.discovering.value = false;
    }
  }

  /**
   * Playwright's `--list` and unittest's own discovery replace what the text scan found for
   * their projects (the scan stays when listing fails or the folder isn't trusted).
   */
  private async listWithRunners(found: Discovered[]): Promise<Discovered[]> {
    const root = this.root;
    if (!root || !this.services.trust.trusted) return found;
    if (this.services.settings.peek<boolean>("testing.listWithRunner") === false) return found;
    const groups = new Map<string, { framework: Framework; project: string }>();
    for (const t of found)
      if (t.framework === "playwright" || t.framework === "unittest")
        groups.set(`${t.framework}|${t.project}`, { framework: t.framework, project: t.project });
    let out = found;
    for (const { framework, project } of groups.values()) {
      const cwd = this.abs(project);
      const command =
        framework === "playwright"
          ? "npx playwright test --list --reporter=json"
          : unittestListCommand(this.windows);
      let text = "";
      const id = `tests-list-${Date.now()}`;
      this.listing.add(id);
      const result = await execIpc
        .run(id, command, { cwd, timeoutMs: LIST_TIMEOUT_MS }, (c) => {
          if (text.length < MAX_OUTPUT) text += c;
        })
        .catch(() => null)
        .finally(() => this.listing.delete(id));
      // The folder closed (or another one opened) meanwhile: its tests aren't this folder's.
      if (this.root !== root) return found;
      if (!result) continue;
      // Playwright's are relative to its folder: given the folder's name (several, D251).
      const folder = this.folderOfRel(project);
      const tests =
        framework === "playwright"
          ? parsePlaywrightJson(text, folder.path, cwd).tests.map((t) =>
              folder.prefix
                ? {
                    ...t,
                    id: t.id.replace(/^playwright:/, `playwright:${folder.prefix}/`),
                    file: prefixRel(folder.prefix, t.file),
                  }
                : t,
            )
          : parseUnittestList(text, project).tests;
      if (!tests.length) continue;
      out = [
        ...out.filter((t) => !(t.framework === framework && t.project === project)),
        ...tests.map((t) => ({ ...t, project })),
      ];
    }
    return out;
  }

  /** The test files changed on disk: find their tests again (debounced by the caller). */
  async rediscoverFile(path: string): Promise<void> {
    const root = this.root;
    if (!root) return;
    const rel = this.relOf(path);
    const before = this.tests.peek().filter((t) => t.file === rel);
    if (!before.length) return;
    const first = before[0];
    if (!first) return;
    const fw = first.framework;
    // Listed by their runner: a text scan would lose projects; the next refresh lists again.
    if (fw === "playwright" && before.some((t) => t.runnerProject)) return;
    const text = await this.readText(path);
    const scanned =
      text === null
        ? []
        : fw === "pytest"
          ? discoverPython(text, rel)
          : fw === "unittest"
            ? discoverUnittest(text, rel)
            : fw === "cargo"
              ? discoverRust(text, rel)
              : fw === "go"
                ? discoverGo(text, rel)
                : discoverJs(text, rel, fw);
    const next = [
      ...this.tests.peek().filter((t) => t.file !== rel),
      ...scanned.map((t) => ({ ...t, project: first.project })),
    ].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    this.tests.value = next;
  }

  cancel(): boolean {
    if (!this.running.peek()) return false;
    this.cancelled = true;
    void execIpc.cancel(this.runId).catch(() => {});
    return true;
  }

  /** The tests `target` names. */
  select(target: RunTarget): Discovered[] {
    let tests = this.tests.peek();
    if (target.testId) tests = tests.filter((t) => t.id === target.testId);
    else if (target.testIds) {
      const keep = new Set(target.testIds);
      tests = tests.filter((t) => keep.has(t.id));
    } else if (target.file) tests = tests.filter((t) => t.file === target.file);
    else if (target.files) {
      const keep = new Set(target.files);
      tests = tests.filter((t) => keep.has(t.file));
    }
    if (target.failedOnly) tests = tests.filter((t) => this.status(t.id) === "failed");
    return [...tests];
  }

  // ---- Kept across reloads (D209, VS Code's testing.keepResults) ----------------------------

  private get keepResults(): boolean {
    return this.services.settings.peek<boolean | undefined>("testing.keepResults") !== false;
  }

  /** A git-ignored folder under the IDE's folder in the workspace. */
  private async ignoredDir(root: string, name: string): Promise<string> {
    await fsIpc.createDir(root, workspaceFolderName()).catch(() => {});
    await fsIpc.createDir(workspaceFolderPath(root), name).catch(() => {});
    const dir = workspaceFolderPath(root, name);
    await fsIpc.write(joinPath(dir, ".gitignore"), new TextEncoder().encode("*\n")).catch(() => {});
    return dir;
  }

  private saving: Promise<void> = Promise.resolve();

  /** The history and the last results into `<IDE folder>/testing/results.json`. */
  saveResults(): Promise<void> {
    const root = this.root;
    if (!root || !this.keepResults) return this.saving;
    const text = serializeResults(this.history, this.results.peek(), this.naming());
    this.saving = this.saving.then(async () => {
      const dir = await this.ignoredDir(root, "testing");
      await fsIpc
        .write(joinPath(dir, "results.json"), new TextEncoder().encode(text))
        .catch(() => {});
    });
    return this.saving;
  }

  /** The history changed (cleared): bumped and kept. */
  historyChanged(): void {
    this.historyVersion.value = this.historyVersion.peek() + 1;
    void this.saveResults();
  }

  /**
   * A folder opened: its kept history, last results and coverage come back (D209). Returns how
   * many runs came back.
   */
  async restoreKept(root: string | null): Promise<number> {
    // Another folder's (or none's) runs aren't this one's.
    this.history.clear();
    this.historyVersion.value = this.historyVersion.peek() + 1;
    if (!root || !this.keepResults) return 0;
    const read = (path: string) =>
      fsIpc.read(path).then(
        (b) => decoder.decode(b),
        () => null,
      );
    const [resultsText, coverageText] = await Promise.all([
      read(workspaceFolderPath(root, "testing", "results.json")),
      read(workspaceFolderPath(root, "coverage", "last.json")),
    ]);
    if (this.root !== root) return 0;
    let runs = 0;
    const kept = resultsText ? parseResults(resultsText) : null;
    if (kept) {
      this.history.setMax(this.services.settings.peek<number>("testing.resultsHistory") ?? 20);
      runs = this.history.restore(kept.history);
      // Kept under another naming (D251: the folder alone then, a workspace now, or the other
      // way; a file from before names them relative to the folder): renamed to today's.
      const from = kept.naming ?? { multi: false, folders: [{ path: root, name: root }] };
      const to = this.naming();
      const same = sameNaming(from, to);
      const keptResults = same ? kept.results : new Map<string, TestResult>();
      if (!same) {
        for (const [id, r] of kept.results) {
          const renamed = renameTestId(id, from, to);
          if (renamed !== null) keptResults.set(renamed, r);
        }
        this.history.rename(
          (id) => renameTestId(id, from, to),
          (file) => renameTestFile(file, from, to),
        );
      }
      // Results of this session win over the kept ones (a run may have finished meanwhile).
      const now = new Map(this.results.peek());
      for (const [id, r] of keptResults) if (!now.has(id)) now.set(id, r);
      this.results.value = now;
      this.historyVersion.value = this.historyVersion.peek() + 1;
    }
    const coverage = coverageText ? parseCoverage(coverageText) : null;
    if (coverage && !this.coverage.peek()) this.coverage.value = coverage;
    return runs;
  }

  /**
   * Where coverage reports go: `<folder>/<IDE folder>/coverage/` (git-ignored, replaced per run)
   * of the folder the tests ran in (D251); the merged report (last.json) is the first folder's.
   */
  private async coverageDir(root: string): Promise<string> {
    const folder = workspaceFolderPath(root);
    const dir = workspaceFolderPath(root, "coverage");
    await fsIpc.delete(dir).catch(() => {});
    await fsIpc.createDir(root, workspaceFolderName()).catch(() => {});
    await fsIpc.createDir(folder, "coverage").catch(() => {});
    await fsIpc.write(joinPath(dir, ".gitignore"), new TextEncoder().encode("*\n")).catch(() => {});
    return dir;
  }

  /** Runs `target`; the summary of what ran. */
  async run(target: RunTarget = {}): Promise<RunSummary> {
    const root = this.root;
    if (!root) throw new Error("Open a folder first.");
    if (this.running.peek()) throw new Error("Tests are running already. Stop them first.");
    if (!this.tests.peek().length) await this.discover();
    const tests = this.select(target);
    if (!tests.length)
      throw new Error(
        target.testId || target.testIds || target.file || target.files || target.failedOnly
          ? "No matching tests."
          : "No tests found (Vitest, Jest, node:test, Mocha, Playwright, pytest, unittest, cargo test or go test).",
      );
    const coverage = target.coverage === true;

    // Batches: one command per project and framework, narrowed to a file or a test when that's
    // what was asked (node:test runs file by file).
    type Batch = {
      framework: Framework;
      project: string;
      file?: string;
      test?: Discovered;
      tests: Discovered[];
    };
    const batches = new Map<string, Batch>();
    const single = target.testId
      ? tests[0]
      : target.testIds?.length === 1
        ? tests.find((t) => t.id === target.testIds?.[0])
        : undefined;
    const files = new Set(tests.map((t) => t.file));
    const perFile =
      target.file !== undefined ||
      ((target.failedOnly || target.testIds !== undefined) && files.size <= 8);
    for (const t of tests) {
      const byFile = perFile || t.framework === "node";
      // Playwright's projects run apart when one test is asked for (its --project).
      const key = `${t.framework}|${t.project}|${byFile ? t.file : ""}`;
      let b = batches.get(key);
      if (!b) {
        b = {
          framework: t.framework,
          project: t.project,
          ...(byFile && { file: t.file }),
          ...(single && { test: single, file: single.file }),
          tests: [],
        };
        batches.set(key, b);
      }
      b.tests.push(t);
    }

    const label = target.label
      ? target.label
      : single
        ? single.path.join(" › ")
        : target.file
          ? target.file
          : target.failedOnly
            ? "Failed tests"
            : target.testIds
              ? `${tests.length} test${tests.length === 1 ? "" : "s"}`
              : "All tests";
    await this.services.trust.require(`Running tests (${label})`);
    // Another run may have started while this one discovered tests or waited for trust.
    if (this.running.peek()) throw new Error("Tests are running already. Stop them first.");
    this.running.value = coverage ? `${label} with coverage` : label;
    this.cancelled = false;
    this.output = "";
    this.runId = `tests-${Date.now()}`;
    const results = new Map(this.results.peek());
    for (const t of tests) results.set(t.id, { status: "running" });
    this.results.value = results;
    const fileErrors = new Map(this.fileErrors.peek());
    for (const f of files) fileErrors.delete(f);
    const started = Date.now();
    const commands: string[] = [];
    const notes: string[] = [];
    const windows = this.windows;
    const timeoutMs =
      this.services.settings.peek<number | undefined>("testing.timeoutSeconds") ?? 600;
    const reports: FileCoverage[][] = [];
    const problems: string[] = [];
    try {
      // Each folder's own coverage folder, emptied once per run (several folders, D251).
      const covRoots = new Map<string, Promise<string>>();
      const covRootOf = (folder: string) => {
        let dir = covRoots.get(folder);
        if (!dir) {
          dir = this.coverageDir(folder);
          covRoots.set(folder, dir);
        }
        return dir;
      };
      if (coverage) await covRootOf(root);
      let n = 0;
      for (const b of batches.values()) {
        if (this.cancelled) break;
        const local = (rel: string) =>
          b.project && rel.startsWith(`${b.project}/`) ? rel.slice(b.project.length + 1) : rel;
        const report = coverage ? coverageReport(b.framework) : null;
        let covDir: string | undefined;
        if (report) {
          const name = String(++n);
          const covRoot = await covRootOf(this.folderOfRel(b.project).path);
          await fsIpc.createDir(covRoot, name).catch(() => {});
          covDir = joinPath(covRoot, name);
        } else if (coverage) problems.push(`${b.framework}: no coverage (not supported)`);
        const command = runCommand(
          b.framework,
          {
            ...(b.file !== undefined && { file: local(b.file) }),
            ...(b.test && { test: { ...b.test, file: local(b.test.file), path: b.test.path } }),
          },
          windows,
          covDir,
        );
        commands.push(command);
        let out = "";
        const cwd = this.abs(b.project);
        this.output += `${this.output ? "\n\n" : ""}$ ${command}\n`;
        const env = testRunEnv(b.framework, covDir && joinPath(covDir, ".coverage"));
        const result = await execIpc
          .run(this.runId, command, { cwd, timeoutMs: timeoutMs * 1000, env }, (chunk) => {
            if (out.length < MAX_OUTPUT) out += chunk;
          })
          .catch((err: unknown) => {
            out += `\n${err instanceof Error ? err.message : String(err)}`;
            return null;
          });
        this.output += out.length > 200_000 ? `${out.slice(0, 200_000)}\n… (output cut)` : out;
        const parsed = this.parse(b.framework, b.project, out, b.tests, b.file);
        if (parsed.summary) notes.push(`${b.framework}: ${parsed.summary}`);
        this.apply(parsed, b.tests, out, result?.exitCode ?? null, fileErrors);
        if (result?.timedOut) notes.push(`${command}: timed out after ${timeoutMs} s`);
        if (report && covDir && !this.cancelled) {
          // A report that can't be read costs its coverage, not the run's results.
          const read = await this.readCoverage(b.project, cwd, covDir, report).catch(
            () => [] as FileCoverage[],
          );
          if (read.length) reports.push(read);
          else problems.push(`${b.framework}: no coverage report (${COVERAGE_HINT[b.framework]})`);
        }
      }
    } finally {
      // Anything still marked running (cancelled, crashed) goes back to its previous state.
      const now = new Map(this.results.peek());
      for (const [id, r] of now) if (r.status === "running") now.delete(id);
      this.results.value = now;
      this.fileErrors.value = fileErrors;
      this.running.value = null;
    }
    const counts = { passed: 0, failed: 0, skipped: 0 };
    for (const t of tests) {
      const s = this.status(t.id);
      if (s === "passed" || s === "failed" || s === "skipped") counts[s]++;
    }
    if (coverage) {
      const report = { files: mergeCoverage(...reports), finishedAt: Date.now(), label, problems };
      batch(() => {
        this.coverage.value = report;
        this.coverageTest.value = null;
      });
      notes.push(...problems);
      // Kept for the next start (D209), beside the reports it came from.
      if (this.keepResults)
        void fsIpc
          .write(
            workspaceFolderPath(root, "coverage", "last.json"),
            new TextEncoder().encode(serializeCoverage(report)),
          )
          .catch(() => {});
    }
    const record = this.record(target, tests, label, started, commands, counts, coverage);
    const summary: RunSummary = {
      ...counts,
      durationMs: Date.now() - started,
      finishedAt: Date.now(),
      commands,
      notes,
      cancelled: this.cancelled,
      runId: record.id,
    };
    this.summary.value = summary;
    return summary;
  }

  /** The run into the history: what it was asked to run, and each test's result. */
  private record(
    target: RunTarget,
    tests: readonly Discovered[],
    label: string,
    started: number,
    commands: string[],
    counts: { passed: number; failed: number; skipped: number },
    coverage: boolean,
  ): RunRecord {
    this.history.setMax(this.services.settings.peek<number>("testing.resultsHistory") ?? 20);
    const results = this.results.peek();
    // "Failed tests" means those that failed then: rerunning it later runs the same ones.
    const again: HistoryTarget = target.failedOnly
      ? { testIds: tests.map((t) => t.id), label }
      : { ...target, label };
    delete again.coverage;
    const record = this.history.add({
      label,
      startedAt: started,
      durationMs: Date.now() - started,
      target: again,
      coverage,
      cancelled: this.cancelled,
      ...counts,
      commands,
      results: tests.flatMap((t) => {
        const r = results.get(t.id);
        if (!r || r.status === "running") return [];
        return [
          {
            id: t.id,
            name: t.path.join(" › "),
            file: t.file,
            status: r.status,
            ...(r.durationMs !== undefined && { durationMs: r.durationMs }),
            ...(r.message !== undefined && { message: r.message }),
            ...(r.output !== undefined && { output: r.output }),
          },
        ];
      }),
    });
    this.historyChanged();
    return record;
  }

  /** A coverage run's report read back (empty when there's none). */
  private async readCoverage(
    project: string,
    cwd: string,
    dir: string,
    report: { file: string; format: string },
  ): Promise<FileCoverage[]> {
    const text = await this.readText(joinPath(dir, report.file), MAX_REPORT_BYTES);
    if (text === null) return [];
    // Relative to the project's folder, then with its name (several folders, D251).
    const folder = this.folderOfRel(project);
    const local = resolverFor(folder.path, cwd);
    const resolve = (path: string) => {
      const rel = local(path);
      return rel === null ? null : prefixRel(folder.prefix, rel);
    };
    switch (report.format) {
      case "lcov":
        return parseLcov(text, resolve);
      case "istanbul":
        return parseIstanbulJson(text, resolve);
      case "coveragepy":
        return parseCoveragePyJson(text, resolve);
      case "go": {
        const mod = goModulePath((await this.readText(joinPath(cwd, "go.mod"))) ?? "");
        return mod ? parseGoProfile(text, goResolver(mod, project)) : [];
      }
    }
    return [];
  }

  clearCoverage(): boolean {
    const had = this.coverage.peek() !== null;
    this.coverage.value = null;
    this.coverageTest.value = null;
    // Every folder's (a run puts reports in the folder it ran in, D251).
    const folders = this.services.workspace.folderPaths();
    const root = this.root;
    for (const folder of folders.length ? folders : root ? [root] : [])
      void fsIpc.delete(workspaceFolderPath(folder, "coverage")).catch(() => {});
    return had;
  }

  private parse(
    framework: Framework,
    project: string,
    out: string,
    tests: readonly Discovered[],
    file: string | undefined,
  ): ParsedRun {
    const cwd = this.abs(project);
    // Reports relative to the project's workspace folder, then given its name (D251).
    const folder = this.folderOfRel(project);
    const root = folder.path;
    const knownIds = new Set(tests.map((t) => t.id));
    const inFolder = (run: ParsedRun, fw: Framework) => prefixRun(run, fw, folder.prefix, knownIds);
    const resolveIn = (path: string) => {
      const rel = resolverFor(root, cwd)(path);
      return rel === null ? null : prefixRel(folder.prefix, rel);
    };
    const prefix = (rel: string) => (project && rel ? `${project}/${rel}` : rel);
    /** Ids and files printed relative to the project folder → relative to the root. */
    const underProject = (run: ParsedRun, fw: Framework): ParsedRun => {
      if (!project) return run;
      const known = new Set(tests.map((t) => t.id));
      const fix = (id: string) =>
        known.has(id) ? id : id.replace(new RegExp(`^${fw}:`), `${fw}:${project}/`);
      const results = new Map<string, TestResult>();
      for (const [id, r] of run.results) results.set(fix(id), r);
      return {
        ...run,
        results,
        extra: run.extra.map((t) =>
          known.has(t.id) ? t : { ...t, id: fix(t.id), file: prefix(t.file) },
        ),
      };
    };
    switch (framework) {
      case "vitest":
      case "jest":
        return inFolder(parseJestJson(out, framework, root), framework);
      case "node":
        return parseTap(out, file ?? tests[0]?.file ?? "");
      case "mocha":
        return parseMochaJson(
          out,
          resolveIn,
          new Map(tests.map((t) => [`${t.file}|${t.path.join(" ")}`, t])),
        );
      case "playwright":
        return inFolder(parsePlaywrightJson(out, root, cwd), "playwright");
      case "pytest":
        // pytest prints paths relative to where it ran (the project folder).
        return underProject(parsePytest(out), "pytest");
      case "unittest": {
        const local = (rel: string) =>
          project && rel.startsWith(`${project}/`) ? rel.slice(project.length + 1) : rel;
        const known = new Map(
          tests.map((t) => [`${unittestModule(local(t.file))}.${t.path.join(".")}`, t]),
        );
        return underProject(parseUnittest(out, known), "unittest");
      }
      case "cargo":
        return parseCargo(out, new Map(tests.map((t) => [t.path.join("::"), t])));
      case "go":
        return parseGoJson(out, new Map(tests.map((t) => [t.path[0] ?? "", t])));
    }
  }

  /** Results into the map; tests the run reported but discovery missed are added. */
  private apply(
    parsed: ParsedRun,
    ran: readonly Discovered[],
    out: string,
    exitCode: number | null,
    fileErrors: Map<string, string>,
  ): void {
    const results = new Map(this.results.peek());
    for (const [id, r] of parsed.results) {
      // A file that didn't load (Jest / Vitest report it without tests).
      const fileOnly = /::$/.exec(id);
      if (fileOnly) {
        const file = id.slice(id.indexOf(":") + 1, -2);
        fileErrors.set(file, r.message ?? "The file failed to load.");
        for (const t of ran)
          if (t.file === file) results.set(t.id, { status: "failed", message: r.message ?? "" });
        continue;
      }
      results.set(id, r);
    }
    // Nothing came back at all, and the command failed: say why on every test it was for.
    if (!parsed.results.size && exitCode !== 0) {
      const tail = out.trim().split(/\r?\n/).slice(-25).join("\n");
      for (const t of ran)
        results.set(t.id, {
          status: "failed",
          message: `The test run failed before reporting results${exitCode === null ? "" : ` (exit code ${exitCode})`}:\n${tail}`,
        });
    }
    const known = new Set(this.tests.peek().map((t) => t.id));
    const project = ran[0]?.project ?? "";
    const added = parsed.extra
      .filter((t) => !known.has(t.id) && t.file && t.path.length)
      .map((t) => ({ ...t, project }));
    if (added.length)
      this.tests.value = [...this.tests.peek(), ...added].sort(
        (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
      );
    this.results.value = results;
  }

  /** The node_modules folder (absolute) that holds `pkg`, from the project up to the root. */
  async nodeModulesWith(project: string, pkg: string): Promise<string | null> {
    const root = this.root;
    if (!root) return null;
    const parts = project ? project.split("/") : [];
    // Not above the project's own workspace folder (D251).
    for (let n = parts.length; n >= (this.multi ? 1 : 0); n--) {
      const dir = parts.slice(0, n).join("/");
      const rel = `${dir ? `${dir}/` : ""}node_modules/${pkg}/package.json`;
      if (await this.exists(rel)) return this.abs(dir ? `${dir}/node_modules` : "node_modules");
    }
    return null;
  }

  /** Runner listings under way (Playwright's --list…): stopped with the controller. */
  private readonly listing = new Set<string>();

  dispose(): void {
    this.cancel();
    for (const id of this.listing) void execIpc.cancel(id).catch(() => {});
    this.listing.clear();
  }
}
