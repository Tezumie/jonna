// Continuous run (VS Code's "Turn on continuous run"): saved files run the tests they affect again
// (continuous.ts decides which), for every test or for chosen files and tests. Saves are collected
// for a moment first, runs never overlap (saves during a run wait for it, then run once), and
// turning it off stops a run it started. Not kept across restarts, as in VS Code.
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { effect, type Signal, signal } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { type ContinuousTarget, continuousTargets } from "./continuous";
import type { RunSummary, TestController } from "./controller";

/** How long saves are collected before a run (several files saved at once run once). */
const DEBOUNCE_MS = 800;

export class ContinuousRun implements Disposable {
  /** On for every test. */
  readonly all: Signal<boolean> = signal(false);
  /** On for these test files (relative). */
  readonly files: Signal<ReadonlySet<string>> = signal<ReadonlySet<string>>(new Set());
  /** On for these tests (ids). */
  readonly tests: Signal<ReadonlySet<string>> = signal<ReadonlySet<string>>(new Set());
  /** Runs it started (for state and tests). */
  readonly runs = signal(0);
  /** The last run it started: when, what, the counts. */
  last: { at: number; targets: ContinuousTarget[]; summary: RunSummary | null } | null = null;
  private readonly store = new DisposableStore();
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Saves came in while a run went on: run again once it ends. */
  private queued = false;
  /** A run of ours is going on (between its targets too). */
  private busy = false;

  constructor(
    private readonly services: WorkbenchServices,
    private readonly controller: TestController,
  ) {
    this.store.add({ dispose: () => clearTimeout(this.timer) });
    this.store.add(
      services.events.on("files.didSave", ({ path }) => {
        // Any of the workspace's folders; named as tests name files (D251).
        const { workspace } = services;
        if (!this.isOn() || !path || !workspace.contains(path)) return;
        this.pending.add(workspace.relative(path));
        this.schedule();
      }),
    );
    // A run someone else started ended while saves waited: run them now.
    this.store.add(
      effect(() => {
        const running = controller.running.value;
        if (!running && this.queued && !this.busy) {
          this.queued = false;
          this.schedule();
        }
        return undefined;
      }),
    );
  }

  isOn(): boolean {
    return this.all.peek() || this.files.peek().size > 0 || this.tests.peek().size > 0;
  }

  /** For a file or test (or every test): turns it on, off, or (`on` missing) the other way. */
  set(scope: { file?: string; test?: string }, on?: boolean): boolean {
    let now: boolean;
    if (scope.test) {
      const next = new Set(this.tests.peek());
      now = on ?? !next.has(scope.test);
      if (now) next.add(scope.test);
      else next.delete(scope.test);
      this.tests.value = next;
    } else if (scope.file) {
      const next = new Set(this.files.peek());
      now = on ?? !next.has(scope.file);
      if (now) next.add(scope.file);
      else next.delete(scope.file);
      this.files.value = next;
    } else {
      now = on ?? !this.all.peek();
      this.all.value = now;
    }
    if (!this.isOn()) this.stopRuns();
    return now;
  }

  /** Everything off (and a run it started stopped). */
  stopAll(): void {
    this.all.value = false;
    this.files.value = new Set();
    this.tests.value = new Set();
    this.stopRuns();
  }

  private stopRuns(): void {
    clearTimeout(this.timer);
    this.pending.clear();
    this.queued = false;
    if (this.busy) this.controller.cancel();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    if (!this.isOn() || !this.pending.size) return;
    if (this.busy || this.controller.running.peek()) {
      this.queued = true;
      return;
    }
    // Never asks: without trust, saves don't run anything (turning it on asked).
    if (this.services.trust.state.peek() !== "trusted") {
      this.pending.clear();
      return;
    }
    const saved = [...this.pending];
    this.pending.clear();
    const targets = continuousTargets(saved, this.controller.tests.peek(), {
      all: this.all.peek(),
      files: this.files.peek(),
      tests: this.tests.peek(),
    });
    if (!targets.length) return;
    this.busy = true;
    this.runs.value = this.runs.peek() + 1;
    this.last = { at: Date.now(), targets, summary: null };
    const last = this.last;
    try {
      for (const target of targets) {
        if (!this.isOn()) break;
        const summary = await this.controller
          .run({ ...target, label: `Continuous run: ${this.describe(target)}` })
          .catch(() => null);
        // Quiet, like VS Code: the results show in the view, the margin and the status bar.
        if (summary) last.summary = summary;
        if (summary?.cancelled) break;
      }
    } finally {
      this.busy = false;
    }
    if (this.queued) {
      this.queued = false;
      this.schedule();
    }
  }

  private describe(target: ContinuousTarget): string {
    if ("testId" in target) {
      const t = this.controller.tests.peek().find((x) => x.id === target.testId);
      return t ? t.path.join(" › ") : "a test";
    }
    return target.files.length === 1 ? (target.files[0] ?? "") : `${target.files.length} files`;
  }

  /** The folder changed: everything off, nothing pending. */
  reset(): void {
    this.stopAll();
    this.last = null;
  }

  dispose(): void {
    this.stopRuns();
    this.store.dispose();
  }
}
