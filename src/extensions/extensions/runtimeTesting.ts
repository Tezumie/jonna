// An extension's test controllers (`ide.tests.createTestController`, VS Code's, D247; worker side
// core/extensions/rpcTesting.ts). Each is an entry of `services.extensionFeatures.tests`
// (workbench/extensionTests.ts, which also checks what the worker sends): its items' snapshot, its
// run profiles, each item's last result and the runs' output. The Testing view draws them beside
// the built-in frameworks' tests; its Run / Debug buttons call `run`, which asks the extension's
// run profile through a "provider" call (no time limit: tests run as long as they run).
import type { ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { signal } from "../../core/reactive/index";
import {
  applyTestRunEvents,
  checkTestItems,
  checkTestProfiles,
  coverageOf,
  type ExtFileCoverage,
  type ExtTestController,
  type ExtTestItem,
  type ExtTestProfile,
  type ExtTestProfileKind,
  type ExtTestResult,
  MAX_TEST_OUTPUT,
  profileFor,
  settleTestResults,
} from "../../workbench/extensionTests";
import type { WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";
import type { ExtensionWorker } from "./workerHost";

/** At most this many controllers per extension. */
const MAX_CONTROLLERS = 10;

export interface TestingHostDeps {
  manifest: ThirdPartyManifest;
  services: WorkbenchServices;
  /** A path in the open folder (throws otherwise). */
  workspacePath(path: unknown): string;
  worker(): Promise<ExtensionWorker>;
}

class Controller implements ExtTestController {
  readonly items = signal<readonly ExtTestItem[]>([]);
  readonly profiles = signal<readonly ExtTestProfile[]>([]);
  readonly resolvable = signal(false);
  readonly results = signal<ReadonlyMap<string, ExtTestResult>>(new Map());
  readonly running = signal(false);
  readonly coverage = signal<readonly ExtFileCoverage[]>([]);
  /** Runs under way (by the worker's run id). */
  readonly runs = new Set<string>();
  private text = "";
  private runSeq = 0;
  readonly store = new DisposableStore();

  constructor(
    readonly owner: string,
    readonly key: string,
    readonly id: string,
    public label: string,
    /** The worker's id for it. */
    readonly cid: string,
    private readonly deps: TestingHostDeps,
  ) {}

  output(): string {
    return this.text;
  }

  appendOutput(text: string): void {
    if (!text) return;
    this.text = (this.text + text).slice(-MAX_TEST_OUTPUT);
  }

  startRun(run: string): void {
    // A run the user or the extension starts: its output replaces the last runs' (VS Code's
    // Test output shows the latest), and its coverage the last runs' (D255).
    if (!this.runs.size) {
      this.text = "";
      this.coverage.value = [];
    }
    this.runs.add(run);
    this.running.value = true;
  }

  endRun(run: string): void {
    if (!this.runs.delete(run)) return;
    if (!this.runs.size) {
      this.running.value = false;
      this.results.value = settleTestResults(this.results.peek());
    }
  }

  /** Adds a run's coverage (a file reported again replaces its earlier report). */
  addCoverage(files: readonly ExtFileCoverage[]): void {
    if (!files.length) return;
    const replaced = new Set(files.map((f) => f.file));
    this.coverage.value = [...this.coverage.peek().filter((f) => !replaced.has(f.file)), ...files];
  }

  async run(kind: ExtTestProfileKind, include?: readonly string[]): Promise<void> {
    // The items' tags (D255): a profile with a tag runs only items that have it.
    const items = this.items.peek();
    const tags = include?.length
      ? [...new Set(include.flatMap((wid) => items.find((i) => i.wid === wid)?.tags ?? []))]
      : undefined;
    const profile = profileFor(this.profiles.peek(), kind, tags);
    if (!profile)
      throw new Error(
        `${this.label} has no ${kind} profile${kind === "run" ? "" : " (it can only run tests)"}.`,
      );
    const worker = await this.deps.worker();
    const key = `h${++this.runSeq}`;
    await worker.call(
      "provider",
      `tests.${this.cid}.run`,
      { profile: profile.id, key, ...(include?.length && { include: [...include] }) },
      undefined,
      0,
    );
  }

  async resolve(wid?: string): Promise<void> {
    if (!this.resolvable.peek()) return;
    const worker = await this.deps.worker();
    await worker.call("provider", `tests.${this.cid}.resolve`, wid ? { item: wid } : {});
  }

  cancel(): void {
    void this.deps
      .worker()
      .then((w) => w.notify("provider", `tests.${this.cid}.cancel`, {}))
      .catch(() => {});
  }
}

export class ExtensionTestingHost implements Disposable {
  private readonly store = new DisposableStore();
  /** By the worker's id. */
  private readonly controllers = new Map<string, Controller>();

  constructor(private readonly deps: TestingHostDeps) {}

  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    switch (method) {
      case "tests.createController":
        return Promise.resolve(this.create(p));
      case "tests.update": {
        const c = this.controllers.get(String(p.controller));
        if (!c) return Promise.resolve(undefined);
        if (typeof p.label === "string" && p.label) c.label = p.label.slice(0, 100);
        c.items.value = checkTestItems(p.items, (path) => this.inFolder(path));
        c.profiles.value = checkTestProfiles(p.profiles);
        c.resolvable.value = p.resolvable === true;
        return Promise.resolve(undefined);
      }
      case "tests.run": {
        const c = this.controllers.get(String(p.controller));
        if (!c) return Promise.resolve(undefined);
        const run = String(p.run ?? "");
        if (!c.runs.has(run) && p.ended !== true) c.startRun(run);
        const { results, output } = applyTestRunEvents(c.results.peek(), p.events, (path) =>
          this.inFolder(path),
        );
        c.results.value = results;
        c.appendOutput(output);
        // Coverage it reported (D255): files of the folder, workspace-relative.
        c.addCoverage(
          coverageOf(p.events, (path) => {
            const abs = this.inFolder(path);
            return abs ? this.deps.services.workspace.relative(abs).replace(/\\/g, "/") : null;
          }),
        );
        if (p.ended === true) c.endRun(run);
        return Promise.resolve(undefined);
      }
      case "tests.dispose": {
        const c = this.controllers.get(String(p.controller));
        if (c) this.remove(c);
        return Promise.resolve(undefined);
      }
      default:
        return UNHANDLED;
    }
  }

  private create(p: Record<string, unknown>): undefined {
    const { manifest, services } = this.deps;
    const cid = String(p.controller ?? "");
    const id = typeof p.id === "string" ? p.id.trim().slice(0, 100) : "";
    if (!cid || !id) throw new Error("A test controller needs an id.");
    if ([...this.controllers.values()].some((c) => c.id === id))
      throw new Error(`${manifest.displayName} already has a test controller "${id}".`);
    if (this.controllers.size >= MAX_CONTROLLERS)
      throw new Error(`${manifest.displayName} has ${MAX_CONTROLLERS} test controllers already.`);
    const label =
      typeof p.label === "string" && p.label ? p.label.slice(0, 100) : manifest.displayName;
    const c = new Controller(manifest.id, `${manifest.id}/${id}`, id, label, cid, this.deps);
    this.controllers.set(cid, c);
    c.store.add(services.extensionFeatures.tests.add(c));
    return undefined;
  }

  private inFolder(path: string): string | null {
    try {
      return this.deps.workspacePath(path);
    } catch {
      return null;
    }
  }

  private remove(c: Controller): void {
    this.controllers.delete(c.cid);
    c.running.value = false;
    c.store.dispose();
  }

  /** The worker went away: its controllers (and their tests) leave the view. */
  workerGone(): void {
    for (const c of [...this.controllers.values()]) this.remove(c);
  }

  dispose(): void {
    this.workerGone();
    this.store.dispose();
  }
}
