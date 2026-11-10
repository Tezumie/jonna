// Workflow scripts (D338, Claude Code's Workflow tool): `run_workflow` runs a JavaScript script
// that orchestrates subagents deterministically. Its meta (name, description, phases) is read as a
// literal (core/agent/workflow.ts) and the user is asked with it; the script then runs in a
// locked-down worker (src/workers/workflow.worker.ts) and the tool returns at once with a run id.
// Each agent() call runs as one of the chat's background subagents (sessionSubagents.ts
// startBackground, through the turn's `background`: the subagent's tools, model and rules as
// delegate gives them), within the run's limits (agents per run, at once, wall clock). The chat
// shows the run as a card with its phases, agents and Stop (view/workflows.ts); its result comes
// back as an automatic message (D253). Runs are kept in this window: resume_from re-runs a script
// with the earlier run's agent() results cached, so only the changed calls run again.

import { type SubagentDef, subagentSystem, subagentTools } from "../../core/agent/subagents";
import {
  CallCache,
  type FromWorkflowWorker,
  parseWorkflowScript,
  type ToWorkflowWorker,
  usageLine,
  type WorkflowAgentOptions,
  type WorkflowAgentRecord,
  type WorkflowMeta,
  WorkflowRuntime,
  workflowEndText,
  workflowLimits,
} from "../../core/agent/workflow";
import { editingCalls, worktreeChanges } from "../../core/agent/workflowEditing";
import { sandboxPath } from "../../core/agent/workspaceFolders";
import type { DisposableStore } from "../../core/lifecycle/index";
import { signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { agentFolders } from "./ignore";
import { cleanPathArg } from "./pathArg";
import { rulesFor } from "./rules";
import type { AgentSession } from "./session";
import { deliverAutoMessage } from "./sessionSubagents";
import type { SessionManager } from "./sessions";
import { type SubagentRegistry, subagentEnabled, subagentModel } from "./subagents";
import type { AgentTool, ToolHost } from "./tools";

export type WorkflowStatus = "running" | "done" | "failed" | "stopped";

export interface WorkflowRun {
  id: string;
  session: string;
  meta: WorkflowMeta;
  script: string;
  /** The script's file, when it was run by path. */
  path?: string;
  args: unknown;
  status: WorkflowStatus;
  startedAt: number;
  endedAt?: number;
  runtime: WorkflowRuntime;
  logs: string[];
  /** The script's return value, as JSON. */
  result?: string;
  error?: string;
  /** The run whose results it reused. */
  resumedFrom?: string;
  /** The user's latest typed message when it started (the chat shows it until the next one). */
  startedUnder: string | null;
  stop(reason: string): void;
}

/** Runs kept for state and resume (the oldest finished ones go first). */
const KEEP_RUNS = 20;

/** The window's workflow runs. */
class WorkflowRuns {
  private readonly runs = new Map<string, WorkflowRun>();
  private next = 1;
  /** Bumped on every change (the chat's card redraws). */
  readonly version = signal(0);

  newId(): string {
    return `wf${this.next++}`;
  }

  add(run: WorkflowRun): void {
    this.runs.set(run.id, run);
    const ended = [...this.runs.values()].filter((r) => r.status !== "running");
    for (const old of ended.slice(0, Math.max(0, this.runs.size - KEEP_RUNS)))
      this.runs.delete(old.id);
    this.changed();
  }

  get(id: string): WorkflowRun | undefined {
    return this.runs.get(id);
  }

  list(session?: string): WorkflowRun[] {
    const all = [...this.runs.values()];
    return session ? all.filter((r) => r.session === session) : all;
  }

  changed(): void {
    this.version.value++;
  }
}

export const workflowRuns = new WorkflowRuns();

/** What every workflow agent is told about its answer (Claude Code's: its text IS the result). */
const WORKFLOW_SUFFIX = `

You are one agent of a workflow script: your final answer is returned to the script as data, not shown to a person. Answer with just what was asked for — no preamble, no sign-off.`;

/** A run as state and tool results show it. */
export function describeRun(run: WorkflowRun): Record<string, unknown> {
  const agents = run.runtime.agents;
  return {
    id: run.id,
    session: run.session,
    name: run.meta.name,
    description: run.meta.description,
    status: run.status,
    phases: run.meta.phases.map((p) => p.title),
    phase: run.runtime.phase,
    agents: agents.map((a) => ({
      n: a.n,
      label: a.label,
      phase: a.phase,
      status: a.status,
      tokens: a.inputTokens + a.outputTokens,
      ...(a.cost !== null && { cost: a.cost }),
      ...(a.error && { error: a.error }),
      ...(a.worktree && {
        worktree: {
          helper: a.worktree.helper,
          branch: a.worktree.branch,
          folder: a.worktree.folder,
          ended: a.worktree.ended,
          files: a.worktree.files.slice(0, 50),
          changes: a.worktree.ended ? worktreeChanges(a.worktree) : null,
        },
      }),
    })),
    usage: usageLine(agents),
    startedAt: new Date(run.startedAt).toISOString(),
    durationMs: (run.endedAt ?? Date.now()) - run.startedAt,
    ...(run.path && { path: run.path }),
    ...(run.resumedFrom && { resumedFrom: run.resumedFrom }),
    ...(run.error && { error: run.error }),
    ...(run.result !== undefined && { result: run.result.slice(0, 4000) }),
    logs: run.logs.slice(-20),
  };
}

/** Chats where the user said "always" to workflows (until the window closes). */
const allowedChats = new Set<string>();
/** D351: chats where the user said "always" to workflows with editing agents. */
const allowedEditingChats = new Set<string>();

/** What an editing agent is told besides its task (it runs as a helper in its own chat). */
const EDITING_SUFFIX = `

You are one agent of a workflow script, working in a git worktree of your own: make the changes there (the user reviews and merges your branch). Your final answer is returned to the script as data: say briefly what you changed, no preamble.`;

function workflowTool(
  services: WorkbenchServices,
  sessions: SessionManager,
  registry: SubagentRegistry,
): AgentTool {
  return {
    spec: {
      name: "run_workflow",
      description: `Run a workflow script that orchestrates several subagents deterministically, in the background: this returns at once with a run id, and the result arrives as a message when the workflow ends. ONLY call it when the user explicitly asked for a workflow, to fan out agents, or for multi-agent orchestration; otherwise use delegate. The user is asked first. The script (plain JavaScript, not TypeScript) must begin with \`export const meta = { name, description, phases: [{ title, detail? }] }\`: a pure literal (no variables, calls or interpolation); description is one line the user is asked with, one phase per phase() call. The body runs as an async function (await and return at the top level) with: agent(prompt, { label?, phase?, schema?, model?, tools?, agentType?, isolation?, files? }) → the subagent's final text, or the parsed object when schema (a JSON Schema with type: "object" at the root) is given, null if it failed; parallel(thunks, { limit? }) → all results, a barrier (a thunk that throws gives null); pipeline(items, stage1, stage2…) → each item goes through the stages on its own, no barrier (stages get (previous, item, index)); phase(title); log(text); args (your \`args\`). Example:\n  export const meta = { name: 'review', description: 'Review each area, then verify findings', phases: [{ title: 'Review' }, { title: 'Verify' }] }\n  const found = await pipeline(AREAS, a => agent(\`Review \${a} for bugs\`, { phase: 'Review', schema: FINDINGS }), r => parallel(r.findings.map(f => () => agent(\`Verify: \${f.title}\`, { phase: 'Verify', schema: VERDICT }))))\n  return found.flat().filter(Boolean)\nEach agent works in its own context with the read-only tools (no edits) and doesn't see this conversation: put what it needs in its prompt. An agent that must change files takes isolation: 'worktree' (written as a literal in its agent() call; at most agent.workflows.maxEditingAgents per run, only in a git repository): it edits in a git worktree of its own, never this folder, and agent() returns { result, branch, changes, files }; files: [paths] says what it will change, so two such agents never work on the same files at once. The user reviews and merges their branches; never merge them yourself unless asked. No file, network, Date.now() or Math.random() in the script. Keep it under ~10 agents unless the user asks for more (agent.workflows.maxAgents caps a run). resume_from re-runs a script (edited or not) reusing the earlier run's results for unchanged agent() calls.`,
      parameters: {
        type: "object",
        properties: {
          script: { type: "string", description: "The workflow script" },
          path: {
            type: "string",
            description: "A script file in the workspace, instead of `script`",
          },
          args: { description: "Passed to the script as `args` (a JSON value, not a string)" },
          resume_from: {
            type: "string",
            description:
              "A run id: its agent() results are reused for unchanged calls; without script or path, its script runs again",
          },
        },
        required: [],
      },
    },
    // What it may do is asked here; its agents get read-only tools.
    readOnly: true,
    concurrent: false,
    verb: "Ran workflow",
    target: (a) => {
      const parsed = typeof a.script === "string" ? parseWorkflowScript(a.script) : null;
      return parsed?.ok
        ? parsed.meta.name
        : String(a.path ?? (a.resume_from ? `again: ${String(a.resume_from)}` : ""));
    },
    async run(args, host) {
      if (!host.background)
        return { result: "Error: workflows aren't available here.", isError: true };
      const previous =
        typeof args.resume_from === "string" && args.resume_from.trim()
          ? workflowRuns.get(args.resume_from.trim())
          : undefined;
      if (typeof args.resume_from === "string" && args.resume_from.trim() && !previous)
        return {
          result: `Error: no workflow run ${args.resume_from} in this window (runs: ${
            workflowRuns
              .list()
              .map((r) => r.id)
              .join(", ") || "none"
          }).`,
          isError: true,
        };
      // The script: given, a file, or the run being resumed.
      let script = typeof args.script === "string" ? args.script : "";
      let path: string | undefined;
      if (!script && typeof args.path === "string" && args.path.trim()) {
        const abs = sandboxPath(agentFolders(services), cleanPathArg(args.path));
        if (!abs) return { result: `Error: ${args.path} is outside the workspace.`, isError: true };
        const text = await host.changeset.current(abs).catch(() => null);
        if (text === null) return { result: `Error: can't read ${args.path}.`, isError: true };
        script = text;
        path = abs;
      }
      if (!script && previous) {
        script = previous.script;
        path = previous.path;
      }
      if (!script.trim())
        return {
          result: "Error: give the workflow `script`, a `path`, or `resume_from`.",
          isError: true,
        };
      const parsed = parseWorkflowScript(script);
      if (!parsed.ok) return { result: `Error: ${parsed.error}`, isError: true };
      let argsJson: string;
      try {
        argsJson = JSON.stringify(args.args ?? null) ?? "null";
      } catch {
        return { result: "Error: `args` must be plain JSON.", isError: true };
      }
      const limits = workflowLimits({
        maxAgents: services.settings.peek<number>("agent.workflows.maxAgents"),
        concurrency: services.settings.peek<number>("agent.workflows.concurrency"),
        timeoutMinutes: services.settings.peek<number>("agent.workflows.timeoutMinutes"),
        maxEditing: services.settings.peek<number>("agent.workflows.maxEditingAgents"),
      });
      const { meta } = parsed;
      // D351: agents that edit, each in a worktree of its own; named on the card before it runs.
      const editors = editingCalls(parsed.body);
      if (editors.length) {
        const problem = !registry.isolated
          ? "agents that edit in worktrees aren't available here"
          : !(host.toolNames?.() ?? ["edit_file"]).includes("edit_file")
            ? "this chat can't change files (its mode only reads), so its workflow's agents can't either"
            : !(services.workspace.root.peek() && services.context.get("gitRepo") === true)
              ? "this folder isn't a git repository, so no agent can edit in a worktree of its own"
              : null;
        if (problem)
          return {
            result: `Error: ${problem}. Run it without isolation: 'worktree' (read-only agents), or make the changes yourself.`,
            isError: true,
          };
      }
      const allowed = editors.length
        ? allowedEditingChats.has(host.session)
        : allowedChats.has(host.session);
      if (!allowed) {
        const phases = meta.phases.length
          ? `\n\nPhases: ${meta.phases.map((p) => `${p.title}${p.detail ? ` (${p.detail})` : ""}`).join(" → ")}`
          : "";
        const answer = await host.ask({
          title: `Run workflow ${meta.name}`,
          heading: "Run a workflow",
          detail: `${meta.description}${phases}\n\nIt runs in the background: up to ${limits.maxAgents} agents (${limits.concurrency} at a time) with read-only tools, for at most ${Math.round(limits.timeoutMs / 60_000)} minutes. Each agent's usage counts like the chat's.${previous ? ` Unchanged calls reuse ${previous.id}'s results.` : ""}${editors.length ? `\n\nAgents that may edit, each in a git worktree of its own (at most ${limits.maxEditing}): ${[...new Set(editors)].join(", ")}. Their changes stay in their branches until you review and merge them; nothing is merged into this folder without you.` : ""}`,
          code: script.length > 4000 ? `${script.slice(0, 4000)}\n…` : script,
          kind: "tool",
          always: editors.length
            ? "workflows with editing agents in this chat"
            : "workflows in this chat",
        });
        if (answer === "deny") return { result: "The user declined the workflow.", denied: true };
        if (answer === "always")
          (editors.length ? allowedEditingChats : allowedChats).add(host.session);
      }
      if (host.cancelled()) return { result: "Stopped by the user.", isError: true };
      const session = sessions.find(host.session) ?? sessions.get(host.session);
      const run = startRun({
        services,
        registry,
        session,
        host,
        meta,
        body: parsed.body,
        script,
        argsJson,
        args: args.args,
        limits,
        editing: editors.length > 0,
        ...(path && { path }),
        ...(previous && { previous }),
      });
      return {
        result: `Workflow ${run.id} (${meta.name}) started in the background${previous ? `, reusing ${previous.id}'s results for unchanged calls` : ""}. Its result will arrive as a message when it ends; go on with other work or end your turn. The user sees its progress and can stop it (agent.stopWorkflow { id: "${run.id}" }).`,
        summary: `${run.id} · in the background`,
      };
    },
  };
}

/** Starts a run: the worker, its agents, its limits; ends with a message to the chat. */
function startRun(o: {
  services: WorkbenchServices;
  registry: SubagentRegistry;
  session: AgentSession;
  host: ToolHost;
  meta: WorkflowMeta;
  body: string;
  script: string;
  argsJson: string;
  args: unknown;
  limits: ReturnType<typeof workflowLimits>;
  /** D351: the script has editing agents the user was told about. */
  editing: boolean;
  path?: string;
  previous?: WorkflowRun;
}): WorkflowRun {
  const { services, registry, session, host, meta, limits } = o;
  const id = workflowRuns.newId();
  // What the chat may use bounds its agents, as it bounds a delegated subagent.
  const available = host.toolNames?.() ?? [];
  const background = host.background as NonNullable<ToolHost["background"]>;
  const changed = () => {
    workflowRuns.changed();
  };
  let worker: Worker | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** D351: an editing agent runs as a helper in a worktree of its own; this waits for its end. */
  const runEditing = async (
    def: SubagentDef,
    prompt: string,
    opts: WorkflowAgentOptions,
    record: WorkflowAgentRecord,
  ): Promise<string | null> => {
    const helpers = registry.isolated;
    if (!helpers) {
      record.error = "agents that edit in worktrees aren't available here";
      return null;
    }
    const phaseModel = meta.phases.find((p) => p.title === record.phase)?.model;
    const started = await helpers.startForWorkflow({
      session: session.id,
      def,
      task: `${prompt}${opts.files?.length ? `\n\nThe files you work on: ${opts.files.join(", ")}.` : ""}${EDITING_SUFFIX}`,
      model: opts.model ?? phaseModel ?? subagentModel(services, def),
      parentTools: available,
      cancelled: () => runtime.stopped,
      onStart: (h) => {
        record.worktree = {
          helper: h.id,
          branch: h.branch,
          folder: h.folder,
          files: [],
          added: 0,
          removed: 0,
          ended: false,
        };
        changed();
      },
    });
    if ("error" in started) {
      record.error = started.error;
      return null;
    }
    const end = await started.ended;
    record.worktree = {
      helper: end.helper.id,
      branch: end.helper.branch,
      folder: end.helper.folder,
      files: end.files,
      added: end.helper.added ?? 0,
      removed: end.helper.removed ?? 0,
      ended: true,
    };
    changed();
    if (end.helper.state !== "done") {
      record.error =
        end.helper.state === "error"
          ? `it stopped on an error${end.report ? `: ${end.report.slice(0, 200)}` : ""}`
          : "it was stopped";
      return null;
    }
    return end.report.trim() || "(It wrote no report.)";
  };

  const runAgent = async (
    prompt: string,
    opts: WorkflowAgentOptions,
    record: WorkflowAgentRecord,
  ): Promise<string | null> => {
    if (session.deleted) return null;
    const def = registry.subagent(opts.agentType ?? "general");
    if (!def || def.name === "explore" || !subagentEnabled(services, def.name)) {
      record.error = `no subagent named ${opts.agentType ?? "general"} is available`;
      return null;
    }
    if (opts.isolation === "worktree") return runEditing(def, prompt, opts, record);
    let tools = subagentTools(def, available, true);
    if (opts.tools) tools = tools.filter((t) => opts.tools?.includes(t));
    const phaseModel = meta.phases.find((p) => p.title === record.phase)?.model;
    const rules = rulesFor(services);
    const system = `${subagentSystem(def)}${rules.subagentSection(def, await rules.rules())}${WORKFLOW_SUFFIX}`;
    return new Promise<string | null>((resolve) => {
      const backgroundId = background({
        name: `${id} ${record.label}`,
        system,
        task: prompt,
        tools,
        maxSteps: def.maxSteps ?? 30,
        model: opts.model ?? phaseModel ?? subagentModel(services, def),
        ruleNeeds: def,
        progress: () => {},
        onUsage: (u) => {
          record.inputTokens += u.input;
          record.outputTokens += u.output;
          if (u.cost !== null) record.cost = (record.cost ?? 0) + u.cost;
          changed();
        },
        onReport: (report, error) => {
          delete record.backgroundId;
          if (error) record.error = error;
          if (report !== null && !report.trim()) record.error = "it wrote no answer";
          resolve(report?.trim() ? report.trim() : null);
        },
      });
      record.backgroundId = backgroundId;
      changed();
    });
  };

  const runtime = new WorkflowRuntime(
    limits,
    runAgent,
    new CallCache(o.previous?.runtime.results ?? []),
    changed,
  );
  runtime.allowEditing = o.editing;

  const finish = (status: Exclude<WorkflowStatus, "running">, detail?: string) => {
    if (run.status !== "running") return;
    run.status = status;
    run.endedAt = Date.now();
    if (status === "done") run.result = detail;
    else if (detail) run.error = detail;
    clearTimeout(timer);
    worker?.terminate();
    worker = null;
    // Agents the script didn't wait for stop with it.
    runtime.stop(status === "done" ? "The workflow ended." : (detail ?? "Stopped."));
    for (const a of runtime.agents) if (a.backgroundId) session.stopBackground(a.backgroundId);
    // Editing agents still at work stop too; their worktrees and changes stay for review.
    for (const a of runtime.agents)
      if (a.worktree && !a.worktree.ended) void registry.isolated?.stop(a.worktree.helper);
    session.background.delete(id);
    session.backgroundCount.value = session.background.size;
    changed();
    session.bump();
    // Stopped by the user (the card's Stop, the chat's Stop): they know; no turn starts.
    if (status === "stopped" || session.deleted) return;
    const text = workflowEndText({
      id,
      name: meta.name,
      status,
      ...(run.error && { error: run.error }),
      ...(run.result !== undefined && { result: run.result }),
      agents: runtime.agents,
      durationMs: run.endedAt - run.startedAt,
      logs: run.logs,
    });
    void session.loaded().then(() => {
      if (!session.deleted) deliverAutoMessage(session, text, "workflow");
    });
  };

  const run: WorkflowRun = {
    id,
    session: session.id,
    meta,
    script: o.script,
    ...(o.path && { path: o.path }),
    args: o.args,
    status: "running",
    startedAt: Date.now(),
    runtime,
    logs: [],
    startedUnder:
      [...session.items].reverse().find((i) => i.type === "user" && !i.auto)?.id ?? null,
    ...(o.previous && { resumedFrom: o.previous.id }),
    stop: (reason) => finish("stopped", reason),
  };
  workflowRuns.add(run);
  // One of the chat's background jobs: the chat's Stop (and deleting it) stops it too.
  session.background.set(id, {
    name: `workflow ${meta.name}`,
    started: run.startedAt,
    stop: () => run.stop("Stopped by the user."),
  });
  session.backgroundCount.value = session.background.size;
  session.bump();

  timer = setTimeout(
    () =>
      finish(
        "failed",
        `It ran past its time limit (${Math.round(limits.timeoutMs / 60_000)} minutes, agent.workflows.timeoutMinutes) and was stopped.`,
      ),
    limits.timeoutMs,
  );
  try {
    worker = new Worker("./workers/workflow.worker.js", { name: `workflow:${id}` });
  } catch (err) {
    finish(
      "failed",
      `The script couldn't start: ${err instanceof Error ? err.message : String(err)}`,
    );
    return run;
  }
  const post = (m: ToWorkflowWorker) => worker?.postMessage(m);
  worker.addEventListener("message", (e: MessageEvent) => {
    const m = e.data as FromWorkflowWorker;
    if (run.status !== "running") return;
    if (m.t === "agent") {
      let opts: unknown = {};
      try {
        opts = JSON.parse(m.opts) as unknown;
      } catch {}
      runtime.call(m.prompt, opts).then(
        (value) => post({ t: "agent", id: m.id, ok: true, value: JSON.stringify(value ?? null) }),
        (err: unknown) =>
          post({
            t: "agent",
            id: m.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
      );
    } else if (m.t === "phase") {
      runtime.phase = m.title;
      changed();
    } else if (m.t === "log") {
      run.logs.push(m.text);
      if (run.logs.length > 200) run.logs.splice(0, run.logs.length - 200);
      changed();
    } else if (m.t === "done") finish("done", m.result);
    else if (m.t === "error") finish("failed", `The script failed: ${m.error}`);
  });
  worker.addEventListener("error", (e: ErrorEvent) => {
    e.preventDefault();
    finish("failed", `The script failed: ${e.message || "its worker stopped"}`);
  });
  post({ t: "start", body: o.body, args: o.argsJson });
  return run;
}

/** Stops every running run (the extension stopping). */
function stopAll(): void {
  for (const r of workflowRuns.list()) if (r.status === "running") r.stop("The window closed.");
}

export function registerWorkflows(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
  registry: SubagentRegistry,
): void {
  const tool = workflowTool(services, sessions, registry);
  sub.add({ dispose: stopAll });
  const previous = sessions.extraTools;
  sessions.extraTools = (session) =>
    services.settings.peek<boolean>("agent.workflows.enabled") === false ||
    services.settings.peek<boolean>("agent.delegate") === false
      ? previous(session)
      : [...previous(session), tool];
  sub.add(
    services.state.register("ide://agent/workflows", {
      description:
        "The agent's workflow runs in this window (D338, the run_workflow tool): each one's id, chat, name, description, status (running, done, failed, stopped), phases and current phase, its agents (label, phase, status, tokens, cost, error), usage, duration, log lines, and its result once done. Stop one with agent.stopWorkflow.",
      get: () => ({ workflows: workflowRuns.list().map(describeRun) }),
    }),
  );
  sub.add(
    services.dispatcher.register({
      id: "agent.listWorkflows",
      title: "List workflow runs",
      category: "Agent",
      description:
        "Lists the agent's workflow runs in this window (D338): id, chat, name, status, agents and usage; `session` limits it to one chat. ide://agent/workflows has the same.",
      input: s.object({ session: s.string().optional() }),
      effects: [],
      agent: "hidden",
      run: ({ session }) => ({
        workflows: workflowRuns.list(session).map((r) => {
          const d = describeRun(r);
          return { ...d, agents: r.runtime.agents.length };
        }),
      }),
    }),
  );
  sub.add(
    services.dispatcher.register({
      id: "agent.stopWorkflow",
      title: "Stop a workflow",
      category: "Agent",
      description:
        "Stops a running workflow (D338): its script and the agents it started. `id` from ide://agent/workflows; without it, every running workflow of the chat `session` (else the active chat).",
      input: s.object({
        id: s.string().describe("A workflow run's id (wf1)").optional(),
        session: s.string().optional(),
      }),
      effects: [],
      run: ({ id, session }) => {
        const targets = id
          ? [workflowRuns.get(id)].filter((r): r is WorkflowRun => !!r)
          : workflowRuns.list(sessions.find(session)?.id ?? "");
        if (id && !targets.length) throw new Error(`No workflow run ${id}.`);
        const running = targets.filter((r) => r.status === "running");
        for (const r of running) r.stop("Stopped by the user.");
        return { stopped: running.map((r) => r.id) };
      },
    }),
  );
}
