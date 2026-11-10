// Running tasks (D134), VS Code's way: the task's process in a terminal tab
// (`services.taskTerminals`), its output through the task's problem matchers into Problems,
// dependencies first (in parallel unless `dependsOrder: "sequence"`; a background dependency
// counts as done once its matcher says a build finished), `${input:…}` asked once per run,
// `${command:…}` from the command's result. A task that's already running is offered to
// terminate or restart. `running` is the live list (status bar, ide://tasks).
import { output as outputChannels } from "../../core/diagnostics/output";
import { type Caller, callerLabel } from "../../core/dispatcher/types";
import type { RunSpec } from "../../core/ipc/process";
import type { DisposableStore } from "../../core/lifecycle/index";
import { type Signal, signal } from "../../core/reactive/index";
import { showDialog } from "../../ui/Dialog";
import type { TaskExecution, WorkbenchServices } from "../../workbench/services";
import { findNamed } from "./folders";
import { ProblemCollector, resolveMatchers, stripEscapes } from "./problemMatchers";
import {
  lateVariables,
  substituteLate,
  type TaskDefinition,
  type TaskInput,
  taskCwd,
} from "./tasks";

/** A background task without a matcher counts as started once its output is quiet this long. */
const QUIET_MS = 1500;
/** …or after this long at most. */
const START_LIMIT_MS = 10_000;
/** Output kept per task for agents (the end of it). */
const OUTPUT_KEEP = 16_000;

export interface RunningTask {
  task: TaskDefinition;
  execution: TaskExecution;
  started: number;
  /** Background tasks: a build finished (matcher) or the output settled. */
  ready: Promise<void>;
  /** Exit code once ended. */
  exited: Promise<number>;
  output(): string;
  problems(): number;
}

export interface RunResult {
  label: string;
  terminalId?: number;
  tabId?: string;
  running: boolean;
  exitCode?: number;
  problems?: number;
  output?: string;
  note?: string;
}

export class TaskRunner {
  readonly running: Signal<ReadonlyMap<string, RunningTask>> = signal(new Map());
  /** Labels, most recently run first. */
  readonly recent: string[] = [];
  /** tasks.json `inputs` of the task's file (set by load()). */
  inputs: TaskInput[] = [];

  constructor(
    private readonly services: WorkbenchServices,
    private readonly sub: DisposableStore,
  ) {}

  /**
   * Runs `task` (dependencies first) and resolves when it's under way: a background task once
   * it's ready, others when they end (`wait` false: as soon as they start).
   */
  async run(
    task: TaskDefinition,
    all: readonly TaskDefinition[],
    caller: Caller,
    wait = true,
    seen: Set<string> = new Set(),
  ): Promise<RunResult> {
    if (seen.has(task.label)) throw new Error(`Task "${task.label}" depends on itself.`);
    seen.add(task.label);
    // A dependency's name is looked up in the task's own folder first (D251).
    const deps = task.dependsOn.map((label) => {
      const d = findNamed(all, label, task.workspaceFolder);
      if (!d) throw new Error(`Task "${task.label}" depends on "${label}", which doesn't exist.`);
      return d;
    });
    // A dependency is done when it ended (or, running in the background, is ready).
    const runDep = async (d: TaskDefinition) => {
      const result = await this.run(d, all, caller, true, new Set(seen));
      if (result.exitCode !== undefined && result.exitCode !== 0)
        throw new Error(`Task "${d.label}" failed with exit code ${result.exitCode}.`);
    };
    if (task.dependsOrder === "sequence") for (const d of deps) await runDep(d);
    else await Promise.all(deps.map(runDep));
    if (!task.command) return { label: task.label, running: false, note: "Ran its dependencies." };

    // A start already under way (a dependency two tasks share, a double click) is joined, not
    // repeated: two copies of one task would write the same files.
    const inflight = this.starting.get(task.label);
    if (inflight) {
      const first = await inflight.catch(() => null);
      const entry = this.running.peek().get(task.label);
      if (entry) {
        if (wait) await (task.background ? entry.ready : entry.exited);
        return this.result(entry, true);
      }
      if (first) return first;
      throw new Error(`Task "${task.label}" didn't start.`);
    }
    const start = this.start(task, caller, wait, seen.size > 1).finally(() =>
      this.starting.delete(task.label),
    );
    this.starting.set(task.label, start);
    return start;
  }

  /** Labels being started right now → their start. */
  private readonly starting = new Map<string, Promise<RunResult>>();

  private async start(
    task: TaskDefinition,
    caller: Caller,
    wait: boolean,
    asDependency: boolean,
  ): Promise<RunResult> {
    const already = this.running.peek().get(task.label);
    if (already) {
      // As a dependency, or for an agent: the running one does.
      if (asDependency || caller.kind !== "user") {
        if (task.background) await already.ready;
        return this.result(already, true);
      }
      const choice = await showDialog<"restart" | "terminate" | null>({
        title: "Task already running",
        message: `The task "${task.label}" is already active.`,
        actions: [
          { label: "Cancel", value: null },
          { label: "Terminate task", value: "terminate" },
          { label: "Restart task", value: "restart", variant: "primary" },
        ],
        cancelValue: null,
      });
      if (choice === "terminate") {
        await this.terminate(task.label);
        return { label: task.label, running: false, note: "Terminated." };
      }
      if (choice !== "restart") return this.result(already, true);
      await this.terminate(task.label);
    }

    await this.trust(`Task “${task.label}”`, caller);
    const spec = await this.resolveLate(task);
    if (!spec) return { label: task.label, running: false, note: "Cancelled." };
    const at = this.recent.indexOf(task.label);
    if (at >= 0) this.recent.splice(at, 1);
    this.recent.unshift(task.label);

    const execution = await this.services.taskTerminals.run({
      label: task.label,
      spec: spec.run,
      cwd: taskCwd(spec.cwd, task.workspaceFolder),
      presentation: task.presentation,
    });
    const entry = this.track(task, execution, `started (${callerLabel(caller)})`);
    if (wait) await entry.ready;
    return this.result(entry, false);
  }

  /**
   * A task's terminal taken back after a window reload (its process kept running): linked to the
   * task again, so it's in the running list, its exit is reported and its problem matchers read
   * what it prints from now on.
   */
  adopt(task: TaskDefinition, execution: TaskExecution): void {
    if (this.running.peek().has(task.label)) return;
    this.track(task, execution, "taken back after a window reload");
  }

  /** Follows a task's execution: problems, output, its end, and (background) when it's ready. */
  private track(task: TaskDefinition, execution: TaskExecution, how: string): RunningTask {
    const { workspace } = this.services;
    // Relative paths are the task's folder's (D251).
    const root = task.workspaceFolder ?? workspace.root.peek() ?? "";
    // Extensions' matchers and patterns by name (contributes.problemMatchers / problemPatterns).
    const contributed = this.services.contributions;
    const { matchers } = resolveMatchers(
      task.problemMatcher,
      root,
      {
        matchers: new Map(contributed.problemMatchers.peek().map((m) => [m.name, m.definition])),
        patterns: new Map(contributed.problemPatterns.peek().map((p) => [p.name, p.definition])),
      },
      workspace.folders.peek(),
    );
    const owner = `task:${task.label}`;
    const collector = new ProblemCollector(matchers);
    this.services.problems.clear(owner);
    // A noisy build reports problems chunk by chunk: publish at most every 150 ms (the Problems
    // view re-sorts and open editors re-mark on each publish).
    let publish: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      clearTimeout(publish);
      publish = undefined;
      this.services.problems.set(owner, collector.problems());
    };
    collector.onChange = () => {
      publish ??= setTimeout(flush, 150);
    };

    // The Tasks output channel (D209).
    const began = Date.now();
    outputChannels.append("tasks", "info", `Task "${task.label}" ${how}`);
    let output = "";
    let last = Date.now();
    const tap = execution.onOutput((text) => {
      collector.feed(text);
      output = (output + text).slice(-OUTPUT_KEEP * 2);
      last = Date.now();
    });
    // Neither the output tap nor a pending publish outlives the extension; removed at the end.
    const stopPublish = {
      dispose: () => {
        clearTimeout(publish);
        tap.dispose();
      },
    };
    this.sub.add(stopPublish);
    const exited = execution.exited.then((code) => {
      collector.end();
      tap.dispose();
      flush();
      this.sub.delete(stopPublish);
      const problems = collector.problems().length;
      outputChannels.append(
        "tasks",
        code === 0 ? "info" : "warn",
        `Task "${task.label}" ended with exit code ${code} after ${Date.now() - began} ms${problems ? `, ${problems} problem${problems === 1 ? "" : "s"}` : ""}`,
      );
      this.forget(task.label, entry);
      // "silent": the terminal comes forward only when something went wrong.
      if (task.presentation.reveal === "silent" && (code !== 0 || collector.problems().length))
        execution.reveal(false);
      return code;
    });
    const ready = task.background
      ? new Promise<void>((resolve) => {
          const started = Date.now();
          // Until it's ready, ends, or the IDE closes; then removed (one per run would pile up).
          const stop = { dispose: () => clearInterval(timer) };
          const done = () => {
            this.sub.delete(stop);
            resolve();
          };
          const timer = setInterval(() => {
            const quiet = Date.now() - last > QUIET_MS && Date.now() - started > QUIET_MS;
            const settled = collector.hasBackground
              ? collector.ready
              : quiet || Date.now() - started > START_LIMIT_MS;
            if (
              settled ||
              Date.now() - started > (collector.hasBackground ? 120_000 : START_LIMIT_MS)
            )
              done();
          }, 200);
          this.sub.add(stop);
          void exited.then(done);
        })
      : exited.then(() => undefined);
    const entry: RunningTask = {
      task,
      execution,
      started: Date.now(),
      ready,
      exited,
      output: () => stripEscapes(output).replace(/\r/g, "").slice(-OUTPUT_KEEP),
      problems: () => collector.problems().length,
    };
    const next = new Map(this.running.peek());
    next.set(task.label, entry);
    this.running.value = next;
    return entry;
  }

  private async result(entry: RunningTask, alreadyRunning: boolean): Promise<RunResult> {
    const ended = await Promise.race([
      entry.exited.then((code) => ({ code })),
      new Promise<null>((r) => setTimeout(() => r(null), 0)),
    ]);
    return {
      label: entry.task.label,
      terminalId: entry.execution.terminalId,
      tabId: entry.execution.tabId,
      running: ended === null,
      ...(ended && { exitCode: ended.code }),
      problems: entry.problems(),
      output: entry.output().slice(-8000),
      ...(alreadyRunning && { note: "It was already running." }),
    };
  }

  private forget(label: string, entry: RunningTask | undefined): void {
    const map = this.running.peek();
    if (!map.has(label) || (entry && map.get(label) !== entry)) return;
    const next = new Map(map);
    next.delete(label);
    this.running.value = next;
  }

  /** Ends a running task (its terminal stays with the exit notice). */
  async terminate(label: string): Promise<boolean> {
    const entry = this.running.peek().get(label);
    if (!entry) return false;
    entry.execution.kill();
    await Promise.race([entry.exited, new Promise((r) => setTimeout(r, 3000))]);
    this.forget(label, entry);
    return true;
  }

  /**
   * Tasks come from the folder's files: they run once the folder is trusted (D103). Test
   * scripts can't answer the dialog: they trust the folder first (workspace.setTrust).
   */
  private async trust(what: string, caller: Caller): Promise<void> {
    const { trust } = this.services;
    if (caller.kind === "test" && trust.state.peek() === "unknown")
      throw new Error(`${what} can't run: the folder isn't trusted (workspace.setTrust).`);
    await trust.require(what);
  }

  /** `${input:…}` (asked once per run) and `${command:…}` in the command, args, cwd and env. */
  private async resolveLate(
    task: TaskDefinition,
  ): Promise<{ run: RunSpec; cwd: string | undefined } | null> {
    const s = task.spec;
    const envTexts = Object.values(s.env ?? {}).filter((x): x is string => x !== null);
    const texts = [s.command, ...(s.args ?? []), task.cwd ?? "", ...envTexts];
    const names = [...new Set(texts.flatMap(lateVariables))];
    const values = new Map<string, string>();
    for (const name of names) {
      const value = await this.valueOf(name, task);
      if (value === undefined) return null;
      values.set(name, value);
    }
    const sub = (t: string) => substituteLate(t, values);
    return {
      run: {
        ...s,
        command: sub(s.command),
        ...(s.args && { args: s.args.map(sub) }),
        ...(s.env && {
          env: Object.fromEntries(
            Object.entries(s.env).map(([k, v]) => [k, v === null ? null : sub(v)]),
          ),
        }),
      },
      cwd: task.cwd ? sub(task.cwd) : undefined,
    };
  }

  private async valueOf(name: string, task: TaskDefinition): Promise<string | undefined> {
    const { quickInput, dispatcher } = this.services;
    const [kind, id = ""] = [name.slice(0, name.indexOf(":")), name.slice(name.indexOf(":") + 1)];
    const runCommand = async (command: string, args: unknown) => {
      const result = await dispatcher.execute(command, (args ?? {}) as Record<string, unknown>);
      return typeof result === "string" ? result : JSON.stringify(result ?? "");
    };
    if (kind === "command") return runCommand(id, {});
    // The task's own file's inputs first (each folder's tasks.json has its own, D251).
    const input = task.inputs?.find((i) => i.id === id) ?? this.inputs.find((i) => i.id === id);
    if (!input) throw new Error(`The task uses \${input:${id}}, but tasks.json has no such input.`);
    if (input.type === "command" && input.command) return runCommand(input.command, input.args);
    if (input.type === "pickString") {
      const options = input.options ?? [];
      const ordered = [
        ...options.filter((o) => o.value === input.default),
        ...options.filter((o) => o.value !== input.default),
      ];
      const picked = await quickInput.pick(
        ordered.map((o) => ({
          id: o.value,
          label: o.label,
          ...(o.label !== o.value && { description: o.value }),
        })),
        { placeholder: input.description },
      );
      return picked?.id;
    }
    return quickInput.prompt({
      prompt: input.description,
      ...(input.default !== undefined && { value: input.default }),
    });
  }
}
