// Helpers in their own git worktree (D231): `delegate` with `isolated: true` (or an agent whose
// file says `isolation: worktree`) starts a worktree agent (worktreeAgents.ts, D193) for that
// agent — its chat mode, instructions and model — in a branch, folder and window of its own,
// instead of running it in this chat. The chat goes on; a line in it follows the helper (setting
// up, working, waiting for you, done), and when the helper's chat ends its report comes back as a
// message (like a background subagent's), with Review changes / Merge in a notification.
// Headless (D246, the default; `agent.isolatedHelpers.window` false): no window. The helper's chat runs
// here in this window's process, its tools on the worktree (toolRoots.ts; Rust lets the worktree
// in as an extra root while it works), and its progress is read from that chat directly; the
// user opens it (agent.openThread) to watch or answer it.
// In a window: windows are separate processes, so progress is read from the helper's saved chat
// (the worktree registry), and Stop and follow-up messages are requests in the global state that
// the helper's window looks for.
// A report whose chat isn't open here waits in a store every window reads (D233); whichever
// window has that chat open takes it, exactly once.
// Commands: agent.helpers, agent.stopHelper; `sendToHelper` for follow-ups; state
// `ide://agent/helpers`. The DOM-free part is core/agent/isolatedHelpers.ts.

import { customModeId, findCustomMode } from "../../core/agent/chatModes";
import type { Item } from "../../core/agent/conversation";
import {
  FINISHED_STATES,
  followUpText,
  type HelperState,
  headlessHelperTask,
  headlessProgress,
  helperBranch,
  helperCap,
  helperOutcome,
  helperReport,
  helperStatusText,
  helpersInWindows,
  isolationRefusal,
  messagesFor,
  sanitizeMessages,
  sanitizeStops,
  stopRequested,
  withMessage,
  withoutMessages,
  withoutStop,
  withStop,
} from "../../core/agent/isolatedHelpers";
import type { ToolOutcome } from "../../core/agent/loop";
import {
  agentLabel,
  READ_TOOLS,
  resolveModelName,
  type SubagentDef,
  subagentTools,
} from "../../core/agent/subagents";
import {
  elapsedText,
  portSettings,
  progressFromChat,
  type WorktreeProgress,
  worktreeEnv,
} from "../../core/agent/worktrees";
import { agentStoreIpc } from "../../core/ipc/agent";
import { fsIpc } from "../../core/ipc/fs";
import { gitIpc } from "../../core/ipc/git";
import type { DisposableStore } from "../../core/lifecycle/index";
import { basename } from "../../core/paths/index";
import { effect, signal, untracked } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { customModes } from "./customModes";
import { newId } from "./ids";
import type { AgentSession } from "./session";
import { flushReports } from "./sessionSubagents";
import type { SessionManager } from "./sessions";
import type { ChatMode } from "./sessionTypes";
import { addToolGate } from "./toolGate";
import { helperRootOf, setToolRoot } from "./toolRoots";
import type { ToolHost } from "./tools";
import type { WorktreeRegistry, WorktreeStarted } from "./worktreeRuns";

const POLL_MS = 3000;
/** How often a window looks for reports kept for the chats it has open (another window's helpers). */
const PENDING_MS = 5000;
/** Tools a subagent here doesn't get but a helper in its own chat does, when the chat had them. */
const HELPER_EXTRAS = ["update_plan", "ask_user"];
/** Finished helpers kept for the chat's "N finished" and agent.helpers. */
const KEEP_FINISHED = 30;

export interface IsolatedHelper {
  /** Its worktree agent's chat id (the worktree registry's key). */
  id: string;
  /** The chat that started it (gets its report). */
  parent: string;
  /** In a group chat, the member that started it: its turn takes the report (D253). */
  speaker?: string;
  agent: string;
  label: string;
  role?: string;
  icon?: string;
  branch: string;
  folder: string;
  task: string;
  startedAt: number;
  state: HelperState;
  /** The line in the parent chat that follows it. */
  notice?: string;
  /** When Stop was asked. */
  stopAt?: number;
  finishedAt?: number;
  files?: number;
  added?: number;
  removed?: number;
  /**
   * Its report, kept in this window's state until the shared store took it (D233; the store
   * couldn't be written, or a helper saved before D233).
   */
  undelivered?: string;
  /** Its chat runs in this window (no window of its own), its tools on `folder`. */
  headless?: boolean;
  /** D351: an editing agent of a workflow run (its end goes to the run, not the chat). */
  workflow?: boolean;
}

/** D351: how a workflow's helper ended: its report and what it changed. */
export interface HelperEnd {
  helper: IsolatedHelper;
  report: string;
  files: string[];
}

const validHelper = (x: unknown): x is IsolatedHelper => {
  if (!x || typeof x !== "object") return false;
  const h = x as Partial<IsolatedHelper>;
  return (
    typeof h.id === "string" &&
    typeof h.parent === "string" &&
    typeof h.agent === "string" &&
    typeof h.label === "string" &&
    typeof h.branch === "string" &&
    typeof h.folder === "string" &&
    typeof h.task === "string" &&
    typeof h.startedAt === "number" &&
    typeof h.state === "string"
  );
};

export class IsolatedHelpers {
  readonly list = signal<readonly IsolatedHelper[]>([]);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private disposed = false;
  /** Headless helpers' chats whose worktree Rust has let in (the tool gate asks again after). */
  readonly allowed = new Set<string>();
  /** Headless helpers whose first message couldn't be sent: why. */
  private readonly startErrors = new Map<string, string>();

  constructor(
    private readonly services: WorkbenchServices,
    private readonly sessions: SessionManager,
    private readonly worktrees: WorktreeRegistry,
  ) {}

  /** The helpers still at work (not done, failed or stopped). */
  active(): IsolatedHelper[] {
    return this.list.peek().filter((h) => !FINISHED_STATES.has(h.state));
  }

  /** A chat's helpers, at work first. */
  forSession(session: string): IsolatedHelper[] {
    return this.list.peek().filter((h) => h.parent === session);
  }

  find(ref: string): IsolatedHelper | undefined {
    return this.list.peek().find((h) => h.id === ref || h.branch === ref);
  }

  max(): number {
    return helperCap(this.services.settings.peek<unknown>("agent.isolatedHelpers.max"));
  }

  /**
   * The delegate tool's `isolated` path: asks the user (as any action outside the chat does), then
   * starts the agent in a worktree and window of its own. Returns at once.
   */
  async start(opts: {
    session: string;
    def: SubagentDef;
    task: string;
    model: string | null;
    ask: ToolHost["ask"];
    /** The delegating chat's turn can't change files. */
    parentReadOnly: boolean;
    /** The delegating chat's tools: the helper gets no more (D232). */
    parentTools: readonly string[];
    /** Stop was pressed in the delegating chat. */
    cancelled?: () => boolean;
  }): Promise<ToolOutcome> {
    const { def } = opts;
    const label = agentLabel(def);
    const root = this.services.workspace.root.peek();
    // The agent's own tools within the chat's; its window's chat keeps that limit even when the
    // agent's mode isn't there (a file not committed), so it never falls back to every tool.
    const own = subagentTools(def, opts.parentTools);
    const tools = [
      ...own,
      ...HELPER_EXTRAS.filter((t) => opts.parentTools.includes(t) && !own.includes(t)),
    ];
    const refusal = isolationRefusal({
      agent: label,
      // A headless helper's own delegate: its worktree isn't a repository to branch from here.
      nested: helperRootOf(opts.session) !== undefined,
      // An agent whose tools only read (accessOf's "Read only") has nothing to do in a worktree.
      readOnly: def.readOnly === true || own.every((t) => READ_TOOLS.includes(t)),
      parentReadOnly: opts.parentReadOnly,
      gitRepo: !!root && this.services.context.get("gitRepo") === true,
      // Ones still being set up count too (two delegate calls at once).
      running: this.active().length + this.starting,
      max: this.max(),
    });
    if (refusal) return { result: refusal, isError: true };
    this.starting++;
    try {
      return await this.startNow({ ...opts, tools }, label);
    } finally {
      this.starting--;
    }
  }
  private starting = 0;
  /** D351: helpers a workflow run waits for: their end goes to it, not to the chat. */
  private readonly waiters = new Map<string, (end: HelperEnd) => void>();

  /**
   * D351: a workflow's editing agent as a helper. The run's permission card asked, and its card
   * follows the helper, so no ask, no line in the chat and no notification; the cap is the run's
   * (agent.workflows.maxEditingAgents). Headless always (a window per agent of a script would be
   * a crowd). `ended` resolves with its report and changes instead of a message to the chat.
   */
  async startForWorkflow(opts: {
    session: string;
    def: SubagentDef;
    task: string;
    model: string | null;
    parentTools: readonly string[];
    cancelled: () => boolean;
    onStart: (h: IsolatedHelper) => void;
  }): Promise<{ ended: Promise<HelperEnd> } | { error: string }> {
    const { def } = opts;
    const label = agentLabel(def);
    const root = this.services.workspace.root.peek();
    const own = subagentTools(def, opts.parentTools);
    const tools = [
      ...own,
      ...HELPER_EXTRAS.filter((t) => opts.parentTools.includes(t) && !own.includes(t)),
    ];
    const refusal = isolationRefusal({
      agent: label,
      nested: helperRootOf(opts.session) !== undefined,
      readOnly: def.readOnly === true || own.every((t) => READ_TOOLS.includes(t)),
      parentReadOnly: !opts.parentTools.includes("edit_file"),
      gitRepo: !!root && this.services.context.get("gitRepo") === true,
      running: 0,
      max: 1,
    });
    if (refusal) return { error: refusal.replace(/^Error: /, "") };
    let resolveEnd: (end: HelperEnd) => void = () => {};
    const ended = new Promise<HelperEnd>((resolve) => {
      resolveEnd = resolve;
    });
    const outcome = await this.startNow(
      {
        ...opts,
        tools,
        ask: async () => "once",
        workflow: { onStart: opts.onStart, onEnd: (end) => resolveEnd(end) },
      },
      label,
    );
    if (outcome.isError) return { error: outcome.result.replace(/^Error: /, "") };
    return { ended };
  }

  private async startNow(
    opts: {
      session: string;
      def: SubagentDef;
      task: string;
      model: string | null;
      ask: ToolHost["ask"];
      tools: string[];
      cancelled?: () => boolean;
      /** D351: started by a workflow run (no ask, no chat line; its end goes to `onEnd`). */
      workflow?: { onStart: (h: IsolatedHelper) => void; onEnd: (end: HelperEnd) => void };
    },
    label: string,
  ): Promise<ToolOutcome> {
    const { def, task } = opts;
    const starter = this.worktrees.starter;
    if (!starter) return { result: "Error: worktree agents aren't available here.", isError: true };
    // Headless unless the user wants a window per helper (read once: this helper stays as started).
    const headless =
      !!opts.workflow ||
      !helpersInWindows(this.services.settings.peek<unknown>("agent.isolatedHelpers.window"));
    const answer = await opts.ask({
      title: `Start ${label} in a git worktree of its own?`,
      heading: "Start a helper in a worktree",
      detail: headless
        ? `It gets a new branch and folder of its own and works there in parallel, in this window (open its chat to watch it); you review and merge its changes. The task: ${task.slice(0, 400)}`
        : `It gets a new branch and a window of its own and works there in parallel; you review and merge its changes. The task: ${task.slice(0, 400)}`,
      kind: "agent",
    });
    if (opts.cancelled?.()) return { result: "Stopped by the user.", isError: true };
    if (answer === "deny")
      return {
        result:
          "The user declined starting a helper in a worktree. Delegate without isolated, or do it here.",
        isError: true,
        denied: true,
      };
    const parent = this.sessions.find(opts.session);
    // An agent's Claude alias (sonnet) names one of the models here (D232).
    const keys = parent?.providers.models.peek().map((m) => m.key) ?? [];
    // An external agent can't be held to the chat's tools: a helper runs on one of the IDE's
    // models (D232).
    const own = (m: string | null | undefined) => (m && !m.startsWith("acp/") ? m : null);
    const model =
      own(opts.model ? (resolveModelName(opts.model, keys) ?? opts.model) : null) ??
      own(parent?.model.peek()) ??
      parent?.providers.defaultModel()?.key ??
      undefined;
    let started: Awaited<ReturnType<typeof starter>>;
    try {
      started = await starter({
        task,
        branch: helperBranch(def.name, task),
        model,
        setup: true,
        // The user's own agents are chat modes; a built-in one (general) brings its instructions.
        ...(def.source !== "builtin" && { mode: customModeId(def.name) }),
        label,
        instructions: def.prompt,
        helper: opts.session,
        tools: opts.tools,
        ...(opts.cancelled && { cancelled: opts.cancelled }),
        ...(headless && { headless: true }),
      });
    } catch (err) {
      return {
        result: `Error: the worktree couldn't be created: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
    if (!started) return { result: "Error: the worktree wasn't created.", isError: true };
    if (started.cancelled) {
      await this.removeWorktree(started.folder, started.branch, started.chat);
      return { result: "Stopped by the user.", isError: true, summary: "stopped" };
    }
    if (started.headless) {
      // Its chat here, its tools on the worktree; a start that fails leaves nothing behind.
      const failed = await this.startHere(started, {
        def,
        task,
        model: model ?? null,
        tools: opts.tools,
        label,
      }).then(
        () => null,
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      if (failed !== null) {
        setToolRoot(started.chat, null);
        await fsIpc.forgetRoot(started.folder).catch(() => {});
        this.allowed.delete(started.chat);
        await this.removeWorktree(started.folder, started.branch, started.chat);
        return {
          result: `Error: ${label} couldn't start in its worktree (it was removed again): ${failed}. Delegate without isolated.`,
          isError: true,
        };
      }
    } else if (!started.spawned) {
      // No window (a test run opens none): nothing will work there, so nothing is left behind.
      await this.removeWorktree(started.folder, started.branch, started.chat);
      return {
        result: `Error: ${label}'s window didn't open, so nothing was started (its worktree was removed). Delegate without isolated.`,
        isError: true,
      };
    }
    const speaker = this.sessions.find(opts.session)?.turnSpeaker;
    const helper: IsolatedHelper = {
      id: started.chat,
      parent: opts.session,
      ...(speaker && { speaker }),
      agent: def.name,
      label,
      ...(def.role && { role: def.role }),
      ...(def.icon && { icon: def.icon }),
      branch: started.branch,
      folder: started.folder,
      task,
      startedAt: Date.now(),
      state: "starting",
      ...(started.headless && { headless: true }),
      ...(opts.workflow && { workflow: true }),
    };
    if (opts.workflow) {
      this.waiters.set(helper.id, opts.workflow.onEnd);
      this.set([...this.list.peek(), helper]);
      this.schedule(500);
      opts.workflow.onStart(helper);
      return { result: `Started ${label} in ${started.branch}.` };
    }
    if (parent) {
      const notice: Extract<Item, { type: "notice" }> = {
        type: "notice",
        id: newId("n"),
        text: helperStatusText(helper),
        detail: task.slice(0, 400),
        tone: "info",
      };
      parent.items.push(notice);
      parent.bump();
      helper.notice = notice.id;
    }
    this.set([...this.list.peek(), helper]);
    this.schedule(500);
    // No window pops up for a headless helper: say where to watch it.
    if (helper.headless)
      this.services.notifications.show(
        "info",
        `${label} works in a worktree of its own (${started.branch}), in this window.`,
        {
          title: "Helper in a worktree",
          actions: [
            {
              label: "Open its chat",
              run: () =>
                void this.services.dispatcher
                  .execute("agent.openThread", { session: helper.id })
                  .catch(() => {}),
            },
          ],
        },
      );
    return {
      result: `Started ${label} in a git worktree of its own (branch ${started.branch}, folder ${started.folder})${started.headless ? "; it runs in this window without one of its own (the user can open its chat)" : " and a window of its own"}. Its helper id is ${started.chat}. It works in parallel; its report will arrive as a message when it finishes. Go on with other work meanwhile, but don't edit the files it works on.`,
      summary: `in a worktree · ${started.branch}`,
    };
  }

  /**
   * A headless helper's chat, here: the worktree let in as an extra root, the chat's tools on it
   * (with the worktree's PORT), in the agent's mode (or its instructions in the first message),
   * on the chat's tools at most (D232), then its first message. Throws when it can't start.
   */
  private async startHere(
    started: WorktreeStarted,
    opts: {
      def: SubagentDef;
      task: string;
      model: string | null;
      tools: string[];
      label: string;
    },
  ): Promise<void> {
    await fsIpc.allowRoot(started.folder);
    this.allowed.add(started.chat);
    const record = this.worktrees.find(started.chat);
    const settings = this.services.settings;
    const env = record
      ? worktreeEnv(
          record.index,
          portSettings(
            settings.peek<unknown>("agent.worktree.basePort"),
            settings.peek<unknown>("agent.worktree.portStep"),
          ),
        )
      : {};
    setToolRoot(started.chat, started.folder, env);
    const session = this.sessions.get(started.chat);
    // Its own folder (the chat says "Started in <worktree>"), so it isn't one of this folder's chats.
    session.workspaceRoot = started.folder;
    if (opts.model) session.model.value = opts.model;
    // Never more tools than the chat that started it, whatever mode it ends up in (D232).
    session.toolLimit = opts.tools;
    // Its edits land in its worktree at once: they're reviewed and merged as its branch.
    session.autoApply.value = true;
    const wanted = opts.def.source !== "builtin" ? customModeId(opts.def.name) : null;
    const mode = wanted && findCustomMode(customModes.peek(), wanted) ? wanted : null;
    if (mode) session.chatMode.value = mode as ChatMode;
    const message = headlessHelperTask({
      from: basename(this.services.workspace.root.peek() ?? started.folder),
      folder: started.folder,
      branch: started.branch,
      task: opts.task,
      label: opts.label,
      ...(!mode && opts.def.prompt && { instructions: opts.def.prompt }),
    });
    void session.send(message).catch((err: unknown) => {
      // Couldn't start its turn (no model, a provider error before it began): it ends on it.
      this.startErrors.set(started.chat, err instanceof Error ? err.message : String(err));
      this.schedule(0);
    });
  }

  /**
   * A follow-up from the chat that started a helper (or the user): a headless one gets it at its
   * next step, or as a new turn when it's idle; a window helper's window passes it on to its chat
   * within a few seconds while it works. "unknown": no such helper, or it has finished.
   */
  async send(ref: string, text: string): Promise<"sent" | "queued" | "unknown"> {
    const helper = this.find(ref);
    if (!helper || FINISHED_STATES.has(helper.state) || helper.stopAt !== undefined)
      return "unknown";
    if (!text.trim()) return "unknown";
    const message = followUpText(text);
    if (helper.headless) {
      const session = this.sessions.find(helper.id);
      if (!session || session.deleted) return "unknown";
      if (session.canQueue()) {
        session.enqueue(message);
        return "queued";
      }
      void session.send(message).catch(() => {});
      this.schedule(500);
      return "sent";
    }
    const now = Date.now();
    await this.services.persistence.saveGlobal((g) => ({
      agentHelperMessages: withMessage(
        sanitizeMessages(g.agentHelperMessages),
        { id: helper.id, msg: newId("m"), text: message, at: now },
        now,
      ),
    }));
    return "queued";
  }

  /**
   * Stops a helper's work: a headless one's chat here at once; a window helper's window looks for
   * the request while it works.
   */
  async stop(ref: string): Promise<boolean> {
    const helper = this.find(ref);
    if (!helper || FINISHED_STATES.has(helper.state)) return false;
    const now = Date.now();
    if (helper.headless) {
      this.sessions.find(helper.id)?.stop("the chat that started it stopped it");
      this.change(helper.id, { stopAt: now, state: "stopping" });
      this.schedule(0);
      return true;
    }
    await this.services.persistence.saveGlobal((g) => ({
      agentStops: withStop(sanitizeStops(g.agentStops), helper.id, now),
    }));
    this.change(helper.id, { stopAt: now, state: "stopping" });
    this.schedule(0);
    return true;
  }

  /**
   * Undoes a helper start whose window didn't open: the worktree and branch it made a moment ago,
   * untouched. Straight through git, not the Delete worktree command, which asks the user (it's
   * for worktrees with someone's work in them).
   */
  private async removeWorktree(folder: string, branch: string, chat: string): Promise<void> {
    await gitIpc.worktreeOp("forceRemove", folder).catch(() => {});
    await gitIpc.repoOp("forceDeleteBranch", branch).catch(() => {});
    this.worktrees.remove(chat);
  }

  private set(next: readonly IsolatedHelper[]): void {
    // A report still waiting for its chat is kept (D232).
    const done = next.filter((h) => FINISHED_STATES.has(h.state) && !h.undelivered);
    const drop = new Set(done.slice(0, Math.max(0, done.length - KEEP_FINISHED)));
    this.list.value = next.filter((h) => !drop.has(h));
    this.services.persistence.scheduleSave();
  }

  private change(id: string, patch: Partial<IsolatedHelper>): IsolatedHelper | undefined {
    const current = this.list.peek().find((h) => h.id === id);
    // Most polls change nothing: no new list, no save.
    if (
      current &&
      Object.entries(patch).every(([k, v]) => current[k as keyof IsolatedHelper] === v)
    )
      return current;
    let changed: IsolatedHelper | undefined;
    this.set(
      this.list.peek().map((h) => {
        if (h.id !== id) return h;
        changed = { ...h, ...patch };
        return changed;
      }),
    );
    if (changed) this.showInChat(changed);
    return changed;
  }

  /** The parent chat's line follows the helper's state. */
  private showInChat(h: IsolatedHelper): void {
    const session = this.sessions.find(h.parent);
    const item = h.notice ? session?.items.find((i) => i.id === h.notice) : undefined;
    if (!session || item?.type !== "notice") return;
    const text = helperStatusText(h);
    if (item.text === text) return;
    item.text = text;
    if (h.state === "error") item.tone = "error";
    session.bump();
  }

  /**
   * Restored with the workspace: helpers still at work are followed again. A headless helper's
   * chat keeps working on its worktree when it's continued (its tools are tied to it again; the
   * folder is let in at its next tool call). One that was at work stopped with the window.
   */
  restore(data: unknown): void {
    this.list.value = Array.isArray(data) ? data.filter(validHelper) : [];
    const settings = this.services.settings;
    for (const h of this.list.peek()) {
      if (!h.headless) continue;
      const record = this.worktrees.find(h.id);
      setToolRoot(
        h.id,
        h.folder,
        record
          ? worktreeEnv(
              record.index,
              portSettings(
                settings.peek<unknown>("agent.worktree.basePort"),
                settings.peek<unknown>("agent.worktree.portStep"),
              ),
            )
          : {},
      );
    }
    if (this.active().length) this.schedule(1000);
  }

  schedule(delay = POLL_MS): void {
    clearTimeout(this.timer);
    if (this.disposed || !this.active().length) return;
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  private async poll(): Promise<void> {
    if (this.polling || this.disposed) return;
    this.polling = true;
    try {
      await this.worktrees.refresh().catch(() => {});
      const progress = this.worktrees.progress.peek();
      for (const h of this.active()) {
        const known = this.worktrees.find(h.id);
        const p = progress.get(h.id);
        let state: WorktreeProgress;
        let saved: unknown = null;
        if (h.headless) ({ state, saved } = await this.headlessState(h, !!known));
        else {
          // A record not read yet is starting; one the registry dropped has lost its worktree.
          state = known ? (p?.state ?? "starting") : "gone";
          const ended = state === "done" || state === "error" || state === "stopped";
          if (ended) saved = await this.savedChat(h.id);
        }
        const out = helperOutcome(state, saved, {
          stopRequested: h.stopAt !== undefined,
          startedAt: h.startedAt,
          now: Date.now(),
        });
        // Its report says what it changed: read again at the end (the registry reads it now and then).
        const diff =
          out.finished && known ? await this.worktrees.diff(known, 0).catch(() => null) : null;
        const counts = diff
          ? {
              files: diff.files.length,
              added: diff.files.reduce((n, f) => n + (f.added ?? 0), 0),
              removed: diff.files.reduce((n, f) => n + (f.removed ?? 0), 0),
            }
          : p?.files !== undefined && {
              files: p.files,
              added: p.added ?? 0,
              removed: p.removed ?? 0,
            };
        if (out.state === "waiting" && h.state !== "waiting") this.sayWaiting(h);
        const next = this.change(h.id, {
          state: out.state,
          ...counts,
          ...(out.finished && { finishedAt: Date.now() }),
        });
        if (out.finished && next)
          await this.finish(next, out.report, diff?.files.map((f) => f.path) ?? []);
      }
    } finally {
      this.polling = false;
      this.schedule();
    }
  }

  /**
   * A headless helper's progress from its chat here; from its saved chat when that isn't here
   * (the window restarted, or it was put away idle): busy there means it stopped with its window.
   */
  private async headlessState(
    h: IsolatedHelper,
    known: boolean,
  ): Promise<{ state: WorktreeProgress; saved: unknown }> {
    const failure = this.startErrors.get(h.id);
    if (failure !== undefined) {
      this.startErrors.delete(h.id);
      return {
        state: "error",
        saved: { items: [{ type: "notice", tone: "error", text: failure }] },
      };
    }
    const session = this.sessions.find(h.id);
    if (session && !session.deleted) {
      // Its worktree went (deleted outside the IDE): its tools have nothing to work on.
      if (!known) {
        session.stop("its worktree is gone");
        return { state: "gone", saved: { items: session.items } };
      }
      const state = headlessProgress({
        status: session.status.peek(),
        error: !!session.error.peek(),
        items: session.items,
      });
      return { state, saved: { items: session.items } };
    }
    const saved = await this.savedChat(h.id);
    return {
      state:
        saved && !session ? progressFromChat(saved, Date.now(), undefined, false).state : "gone",
      saved,
    };
  }

  private async savedChat(id: string): Promise<unknown> {
    const text = await agentStoreIpc.load(id).catch(() => null);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  private sayWaiting(h: IsolatedHelper): void {
    this.services.notifications.show(
      "info",
      `${h.label} is waiting for you in its ${h.headless ? "chat" : "window"} (${h.branch}).`,
      {
        title: "Helper in a worktree",
        actions: [
          h.headless
            ? {
                label: "Open its chat",
                run: () =>
                  void this.services.dispatcher
                    .execute("agent.openThread", { session: h.id })
                    .catch(() => {}),
              }
            : {
                label: "Open its window",
                run: () =>
                  void this.services.dispatcher
                    .execute("agent.worktrees", { branch: h.branch, action: "open" })
                    .catch(() => {}),
              },
        ],
      },
    );
  }

  /** Its report goes to the chat that started it; the user gets Review changes / Merge. */
  private async finish(h: IsolatedHelper, report: string, paths: string[] = []): Promise<void> {
    // Its worktree leaves the scope with it (a later turn in its chat lets it in again).
    if (h.headless) {
      this.allowed.delete(h.id);
      await fsIpc.forgetRoot(h.folder).catch(() => {});
    }
    // A workflow's agent (D351): the run takes its report; its card has Review / Merge.
    const waiter = this.waiters.get(h.id);
    if (waiter) {
      this.waiters.delete(h.id);
      waiter({ helper: h, report, files: paths });
      return;
    }
    if (h.stopAt !== undefined && !h.headless)
      await this.services.persistence
        .saveGlobal((g) => ({
          agentStops: withoutStop(sanitizeStops(g.agentStops), h.id, Date.now()),
        }))
        .catch(() => {});
    const text = helperReport({
      label: h.label,
      branch: h.branch,
      state: h.state,
      report,
      ...(h.headless && { headless: true }),
      ...(h.files !== undefined && { files: h.files, added: h.added, removed: h.removed }),
    });
    const session = this.sessions.find(h.parent);
    const open = !!session && !session.deleted;
    if (open) deliver(session, text, h.speaker);
    // Its chat isn't open here: the report waits in the shared store for whichever window opens
    // it (D233); kept here if that store can't be written.
    else await this.keep(h, text);
    const { dispatcher, notifications } = this.services;
    const changes = h.files !== 0;
    notifications.show(
      h.state === "error" ? "warning" : "info",
      `${helperStatusText(h)}.${open ? "" : " Its report goes to the chat that started it as soon as that chat is open in any window."}`,
      {
        title: "Helper in a worktree",
        actions: [
          ...(open
            ? []
            : [
                {
                  label: "Open its chat",
                  run: () =>
                    void dispatcher
                      .execute("agent.openSession", { session: h.parent })
                      .catch(() => {}),
                },
              ]),
          ...(changes
            ? [
                {
                  label: "Review changes",
                  run: () =>
                    void dispatcher
                      .execute("agent.compareWorktrees", { agents: [h.id] })
                      .catch(() => {}),
                },
                {
                  label: "Merge",
                  run: () =>
                    void dispatcher.execute("agent.applyWorktree", { agent: h.id }).catch(() => {}),
                },
              ]
            : []),
        ],
      },
    );
  }

  /** A report into the shared store (D233), or this window's state when that fails. */
  private async keep(h: IsolatedHelper, text: string): Promise<void> {
    try {
      await agentStoreIpc.reportPut(h.id, h.parent, text);
      if (h.undelivered !== undefined) this.change(h.id, { undelivered: undefined });
    } catch {
      this.change(h.id, { undelivered: text });
    }
  }

  private claiming = false;

  /**
   * Reports waiting for chats go to the ones open in this window: the ones this window kept, then
   * the shared store's (any window's helpers). A claim is exactly once across windows, so a chat
   * open in two windows gets a report once.
   */
  async deliverPending(): Promise<void> {
    if (this.claiming || this.disposed) return;
    this.claiming = true;
    try {
      for (const h of this.list.peek()) {
        if (!h.undelivered) continue;
        const session = this.sessions.find(h.parent);
        const text = h.undelivered;
        // Kept here only because the store failed (or from before D233): try the store again,
        // so another window that has the chat open can take it.
        if (!session) {
          await this.keep(h, text);
          continue;
        }
        this.change(h.id, { undelivered: undefined });
        // Its chat was deleted: nobody will read it.
        if (!session.deleted) deliver(session, text, h.speaker);
      }
      const waiting = await agentStoreIpc.reportList().catch(() => []);
      for (const entry of waiting) {
        const session = this.sessions.find(entry.chat);
        if (!session) continue;
        const text = await agentStoreIpc.reportClaim(entry.id).catch(() => null);
        if (text !== null && !session.deleted) deliver(session, text);
      }
    } finally {
      this.claiming = false;
    }
  }

  /** What `ide://agent/helpers` shows. */
  describe(): unknown[] {
    const now = Date.now();
    return this.list.peek().map((h) => ({
      ...h,
      elapsedMs: (h.finishedAt ?? now) - h.startedAt,
    }));
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
  }
}

/** A helper's report into its chat: the running turn takes it, or it starts one. */
function deliver(session: AgentSession, text: string, speaker?: string): void {
  const item: Item = {
    type: "user",
    id: newId("u"),
    text,
    auto: "subagent",
    ...(speaker && session.members.peek().length && { to: speaker }),
  };
  session.reports.push(item);
  if (!session.inTurn || session.cancelled) flushReports(session);
}

/**
 * In a helper's own window: while its chat works, look for a stop request and follow-up messages
 * from the chat that started it (windows share only files: the global state is read again each
 * time). A message goes to the chat as the user's (agent.send: it joins the running turn).
 */
export function watchForStop(
  sub: DisposableStore,
  services: WorkbenchServices,
  session: AgentSession,
): void {
  const started = Date.now();
  let seenBusy = false;
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    const busy = session.status.peek() !== "idle";
    seenBusy ||= busy;
    // Its turn ended (later messages are the user's own), or it never started.
    if (session.deleted || (seenBusy && !busy) || Date.now() - started > 6 * 3600_000) {
      clearInterval(timer);
      return;
    }
    checking = true;
    void (async () => {
      try {
        const global = await services.persistence.loadGlobal();
        const messages = messagesFor(
          sanitizeMessages(global.agentHelperMessages),
          session.id,
          Date.now(),
        );
        if (messages.length) {
          // Taken first, so a message is passed on once even when sending it fails.
          await services.persistence.saveGlobal((g) => ({
            agentHelperMessages: withoutMessages(
              sanitizeMessages(g.agentHelperMessages),
              messages.map((m) => m.msg),
              Date.now(),
            ),
          }));
          for (const m of messages)
            await services.dispatcher
              .execute("agent.send", { session: session.id, message: m.text, wait: false })
              .catch(() => {});
        }
        if (!stopRequested(sanitizeStops(global.agentStops), session.id, Date.now())) return;
        clearInterval(timer);
        await services.persistence.saveGlobal((g) => ({
          agentStops: withoutStop(sanitizeStops(g.agentStops), session.id, Date.now()),
        }));
        await services.dispatcher.execute("agent.stop", { session: session.id }).catch(() => {});
        services.notifications.show("info", "The chat that started this helper stopped it.", {
          title: "Helper in a worktree",
        });
      } catch {
        // The state file couldn't be read: look again next time.
      } finally {
        checking = false;
      }
    })();
  }, POLL_MS);
  sub.add({ dispose: () => clearInterval(timer) });
}

export function registerIsolatedHelpers(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
  worktrees: WorktreeRegistry,
): IsolatedHelpers {
  const helpers = new IsolatedHelpers(services, sessions, worktrees);
  sub.add(helpers);
  const { dispatcher, quickInput, notifications } = services;
  // A headless helper's tool call: its worktree in Rust's scope first (let in again after the
  // helper ended, when its chat is continued; after a restart or a folder switch).
  sub.add(
    addToolGate(async (ctx) => {
      const folder = helperRootOf(ctx.session);
      if (!folder || helpers.allowed.has(ctx.session)) return null;
      try {
        await fsIpc.allowRoot(folder);
        helpers.allowed.add(ctx.session);
        return null;
      } catch (err) {
        return {
          result: `Error: your worktree ${folder} can't be reached (${err instanceof Error ? err.message : String(err)}). It may have been deleted; tell the user.`,
          isError: true,
          summary: "no worktree",
        };
      }
    }),
  );
  // Rust forgets extra roots when the folder changes.
  sub.add(services.workspace.onDidOpen(() => helpers.allowed.clear()));
  sub.add(services.workspace.onDidClose(() => helpers.allowed.clear()));
  // A chat opened (or restored) in this window takes the reports kept for it; one that's open
  // already takes those another window's helpers leave, within a few seconds (D233).
  sub.add(
    effect(() => {
      sessions.members.value;
      untracked(() => void helpers.deliverPending());
      return undefined;
    }),
  );
  const pending = setInterval(() => {
    if (sessions.all().length) void helpers.deliverPending();
  }, PENDING_MS);
  sub.add({ dispose: () => clearInterval(pending) });
  sub.add(
    services.persistence.register("agent.isolatedHelpers", {
      save: () => helpers.list.peek(),
      restore: (data) => helpers.restore(data),
    }),
  );
  sub.add(
    services.state.register("ide://agent/helpers", {
      description:
        "Helpers working in git worktrees of their own (D231: delegate with isolated, or an agent with isolation: worktree): id (its worktree chat: open it with agent.openThread { session: id } when headless), the chat that started it (parent), agent name, label, role, icon, branch, folder, task, headless (its chat runs in this window, no window of its own; agent.isolatedHelpers.window), state (starting, working, waiting — for the user in its chat or window, stopping, done, error, stopped), files changed and lines added / removed, elapsed; and the limit (agent.isolatedHelpers.max).",
      get: () => ({ helpers: helpers.describe(), max: helpers.max() }),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.stopHelper",
      title: "Stop a helper in a worktree",
      category: "Agent",
      description:
        "Stops a helper working in a git worktree (ide://agent/helpers lists them; `helper`: its id or branch). Its chat (here, or in its window) stops its turn; its worktree and changes stay for review.",
      input: s.object({ helper: s.string() }),
      effects: [],
      agent: "discoverable",
      palette: false,
      run: async ({ helper }) => ({ stopped: await helpers.stop(helper) }),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.helpers",
      title: "Helpers in worktrees",
      category: "Agent",
      description:
        "Lists the helpers working in git worktrees of their own (started by delegate with isolated). With `helper` (id or branch) and `action`: open its chat (a headless helper's, here) or its window, review its changes (the compare page), merge them into this folder (agent.applyWorktree, asks first) or stop it. A person running it picks one.",
      input: s.object({
        helper: s.string().optional(),
        action: s.enum(["open", "review", "merge", "stop"] as const).optional(),
      }),
      effects: ["write"],
      agent: "discoverable",
      run: async ({ helper, action }, ctx) => {
        let target = helper ? helpers.find(helper) : undefined;
        if (helper && !target)
          throw new Error(`No helper ${helper} (ide://agent/helpers lists them).`);
        if (!target && ctx.caller.kind === "user") {
          const all = [...helpers.list.peek()].reverse();
          if (!all.length) {
            notifications.show(
              "info",
              "No helpers in worktrees yet. The agent starts one when it delegates with isolated (or to an agent with isolation: worktree).",
            );
            return { helpers: [] };
          }
          const picked = await quickInput.pick(
            all.map((h) => ({
              id: h.id,
              label: `${h.label} · ${h.branch}`,
              description: `${h.state} · ${elapsedText((h.finishedAt ?? Date.now()) - h.startedAt)}`,
              detail: h.task.slice(0, 120),
              icon: "git-branch" as const,
            })),
            { placeholder: "Helpers in worktrees" },
          );
          target = picked ? helpers.find(picked.id) : undefined;
        }
        if (!target) return { helpers: helpers.describe() };
        let what = action;
        if (!what && ctx.caller.kind === "user")
          what = (
            await quickInput.pick(
              [
                target.headless
                  ? { id: "open", label: "Open its chat", icon: "messages-square" as const }
                  : { id: "open", label: "Open its window", icon: "app-window" as const },
                { id: "review", label: "Review its changes", icon: "eye" as const },
                { id: "merge", label: "Merge into this folder", icon: "git-merge" as const },
                ...(FINISHED_STATES.has(target.state)
                  ? []
                  : [{ id: "stop", label: "Stop it", icon: "square" as const }]),
              ],
              { placeholder: `${target.label} · ${target.branch}` },
            )
          )?.id as typeof action;
        if (what === "open")
          return target.headless
            ? ctx.execute("agent.openThread", { session: target.id })
            : ctx.execute("agent.worktrees", { branch: target.branch, action: "open" });
        if (what === "review")
          return ctx.execute("agent.compareWorktrees", { agents: [target.id] });
        if (what === "merge") return ctx.execute("agent.applyWorktree", { agent: target.id });
        if (what === "stop") return { stopped: await helpers.stop(target.id) };
        return { helper: helpers.describe().find((h) => (h as IsolatedHelper).id === target.id) };
      },
    }),
  );
  return helpers;
}

/**
 * A follow-up to a running helper (the lead's model tool and command call this): `helperId` is its
 * id (ide://agent/helpers' `id`, the "helper id" in delegate's result) or its branch. A headless
 * helper gets the message at its next step ("queued"), or as a new turn when it's idle ("sent");
 * a window helper's window passes it to its chat within a few seconds ("queued"). "unknown": no
 * such helper, it has finished or is stopping, or the text is empty.
 */
export function sendToHelper(
  helpers: IsolatedHelpers,
  helperId: string,
  text: string,
): Promise<"sent" | "queued" | "unknown"> {
  return helpers.send(helperId, text);
}
