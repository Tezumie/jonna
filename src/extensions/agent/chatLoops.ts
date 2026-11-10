// Loops in a chat (D332, Claude Code's /loop + ScheduleWakeup; core/agent/chatLoop.ts has the
// rules and texts): `/loop [interval] <prompt>` starts one, the schedule_wakeup tool (offered only
// in a chat with a loop) paces, marks quiet checks or ends it, agent.stopLoop ends it from the
// chat's strip (view/chatFlowCards.ts LoopStrip). Each next check is a one-off scheduled message
// to the chat (the schedules' timer, D253): a fixed loop's next one is set as soon as the last
// one is sent, a self-paced loop's by the agent's schedule_wakeup; a self-paced turn that ends
// without one ends the loop. Saved with the folder (agent.loops); ide://agent/loops.

import {
  type ChatLoop,
  clampDelay,
  loopPace,
  loopStartContext,
  newLoop,
  parseLoopArgs,
  tickPrompt,
  validLoops,
} from "../../core/agent/chatLoop";
import { describeNext, durationText } from "../../core/agent/schedules";
import { type Disposable, type DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { effect, type ReadonlySignal, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { type ScheduleService, scheduledMessages } from "./schedules";
import type { AgentSession } from "./session";
import type { SessionManager } from "./sessions";
import { builtinSlash } from "./slashCommands";
import type { AgentTool } from "./tools";

const list = signal<readonly ChatLoop[]>([]);
/** The folder's loops (a chat's strip shows its own). */
export const chatLoops: ReadonlySignal<readonly ChatLoop[]> = list;

export function loopOf(session: string): ChatLoop | undefined {
  return list.peek().find((l) => l.session === session);
}

/** After the folder opens, how long before loops whose check is gone are tidied. */
const RESTORE_GRACE = 5000;

export class LoopService implements Disposable {
  /** Per self-paced loop waiting for the agent's schedule_wakeup: its turn's watcher. */
  private readonly waits = new Map<string, Disposable>();
  private readonly store: DisposableStore;

  constructor(
    private readonly services: WorkbenchServices,
    private readonly sessions: SessionManager,
    private readonly schedules: ScheduleService,
    store: DisposableStore,
  ) {
    this.store = store;
    // A loop's check went out (its schedule left the list): count it, set the next one.
    let seen = new Set<string>();
    store.add(
      effect(() => {
        const now = new Set(scheduledMessages.value.map((x) => x.id));
        const gone = [...seen].filter((id) => !now.has(id));
        seen = now;
        if (gone.length) queueMicrotask(() => this.checksSent(new Set(gone)));
        return undefined;
      }),
    );
  }

  get all(): readonly ChatLoop[] {
    return list.peek();
  }

  /** Starts a loop in `session` (replacing one it has). The /loop message is its first check. */
  start(session: AgentSession, prompt: string, every: number | undefined): ChatLoop {
    if (loopOf(session.id)) this.end(session.id, null);
    const loop = newLoop(session.id, prompt, every, Date.now());
    this.set([...list.peek(), loop]);
    if (every) this.scheduleNext(loop, every);
    else this.awaitWakeup(loop.session);
    return loop;
  }

  /** Ends a loop: its next check is cancelled; `why` goes in the chat as a note. */
  end(session: string, why: string | null): ChatLoop | null {
    const loop = loopOf(session);
    if (!loop) return null;
    this.waits.get(session)?.dispose();
    this.set(list.peek().filter((l) => l !== loop));
    if (loop.schedule) this.schedules.cancel(loop.schedule);
    if (why) this.sessions.find(session)?.addNotice(`Loop ended: ${why.replace(/[.\s]+$/, "")}.`);
    return loop;
  }

  /** schedule_wakeup: the next check (self-paced), a quiet mark, or the end. */
  wake(
    session: string,
    args: { delay: number; prompt: string; reason: string; noop: boolean; stop: boolean },
  ): string {
    const loop = loopOf(session);
    if (!loop) return "Error: this chat has no loop running (the user can start one with /loop).";
    if (args.stop) {
      this.end(session, args.reason || "the agent stopped it");
      return "The loop is ended. Say so in one line.";
    }
    const updated: ChatLoop = {
      ...loop,
      quiet: loop.quiet + (args.noop ? 1 : 0),
      ...(args.prompt && { prompt: args.prompt }),
      ...(args.reason && { reason: args.reason }),
    };
    this.replace(loop, updated);
    if (updated.every) {
      const next = updated.next ? ` Next check ${describeNext(updated.next, Date.now())}.` : "";
      return `Noted${args.noop ? " (a quiet check)" : ""}. This loop runs every ${durationText(updated.every)}: the delay is ignored.${next}`;
    }
    const ms = clampDelay(args.delay) * 1000;
    if (Date.now() + ms > updated.expires) {
      this.end(session, "it ran for its 7 days");
      return "The loop reached its 7 days and ended. Say so in one line.";
    }
    if (updated.schedule) this.schedules.cancel(updated.schedule);
    this.waits.get(session)?.dispose();
    const made = this.scheduleNext(updated, ms);
    return made
      ? `Next check ${describeNext(made, Date.now())}${args.noop ? " (this one was quiet)" : ""}. End your turn now, in a line or less.`
      : "Error: the next check couldn't be scheduled; the loop ended.";
  }

  restore(data: unknown): void {
    list.value = validLoops(data, Date.now());
    // Checks that were sent or dropped while the IDE was closed: a fixed loop sets its next one,
    // a self-paced one whose turn didn't schedule one ends.
    const timer = setTimeout(() => {
      const ids = new Set(scheduledMessages.peek().map((x) => x.id));
      for (const loop of list.peek()) {
        if (loop.schedule && ids.has(loop.schedule)) continue;
        if (loop.every) this.scheduleNext({ ...loop, schedule: undefined }, loop.every);
        else this.set(list.peek().filter((l) => l !== loop));
      }
    }, RESTORE_GRACE);
    this.store.add(toDisposable(() => clearTimeout(timer)));
  }

  save(): ChatLoop[] {
    return [...list.peek()];
  }

  clear(): void {
    for (const w of this.waits.values()) w.dispose();
    this.waits.clear();
    list.value = [];
  }

  dispose(): void {
    this.clear();
  }

  private set(next: readonly ChatLoop[]): void {
    list.value = next;
    this.services.persistence.scheduleSave();
  }

  private replace(old: ChatLoop, next: ChatLoop): void {
    this.set(list.peek().map((l) => (l === old ? next : l)));
  }

  /** The next check in `ms` (a one-off scheduled message); its due time, or null if refused. */
  private scheduleNext(loop: ChatLoop, ms: number): number | null {
    const current = loopOf(loop.session) ?? loop;
    try {
      const made = this.schedules.add({
        when: `in ${Math.max(60, Math.round(ms / 1000))} seconds`,
        prompt: tickPrompt(current, current.ticks + 1),
        target: { kind: "chat", session: loop.session },
        createdBy: "agent",
        from: loop.session,
      });
      this.replace(current, { ...current, ...loop, schedule: made.id, next: made.next });
      return made.next;
    } catch (err) {
      this.end(loop.session, err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /** Schedules that left the list: a loop's check sent (or its chat gone). */
  private checksSent(gone: ReadonlySet<string>): void {
    for (const loop of list.peek()) {
      if (!loop.schedule || !gone.has(loop.schedule)) continue;
      const session = this.sessions.find(loop.session);
      const sent = session ? deliveredIn(session, loop.schedule) : false;
      if (!sent) {
        // Cancelled from the schedules list, or the chat was deleted.
        this.end(loop.session, session ? "its next check was cancelled" : null);
        continue;
      }
      const next: ChatLoop = { ...loop, ticks: loop.ticks + 1, schedule: undefined };
      delete next.next;
      this.replace(loop, next);
      if (next.every) {
        if (Date.now() + next.every > next.expires) this.end(loop.session, "it ran for its 7 days");
        else this.scheduleNext(next, next.every);
      } else this.awaitWakeup(loop.session);
    }
  }

  /**
   * A self-paced loop's turn is under way (or about to be): when the chat goes idle after working
   * and the agent set no next check, the loop ends.
   */
  private awaitWakeup(sessionId: string): void {
    this.waits.get(sessionId)?.dispose();
    const session = this.sessions.find(sessionId);
    if (!session) return;
    let ran = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      stop.dispose();
      this.waits.delete(sessionId);
    };
    const stop = effect(() => {
      const status = session.status.value;
      if (done) return undefined;
      if (status !== "idle") ran = true;
      else if (ran)
        queueMicrotask(() => {
          if (done) return;
          finish();
          const loop = loopOf(sessionId);
          if (loop && !loop.every && !loop.schedule)
            this.end(sessionId, "the agent didn't schedule the next check");
        });
      return undefined;
    });
    this.waits.set(sessionId, { dispose: finish });
  }
}

/** Whether the schedule `id`'s message reached the chat (its items, or waiting to join a turn). */
function deliveredIn(session: AgentSession, id: string): boolean {
  const mark = `schedule id ${id})`;
  const has = (it: { type: string; text?: string }) =>
    it.type === "user" && typeof it.text === "string" && it.text.includes(mark);
  return session.reports.some(has) || session.items.slice(-40).some(has);
}

function wakeupTool(service: LoopService): AgentTool {
  return {
    spec: {
      name: "schedule_wakeup",
      description:
        "This chat runs a loop (/loop): end each check's turn with this. Self-paced: say when to check next (delay_seconds, clamped to 60–3600: shorter while things change, longer when nothing does) and pass the loop's prompt back. noop: true when nothing changed since the last check (quiet checks fold together in the chat). stop: true ends the loop (done, or no longer needed). reason: one short sentence on the chosen delay, shown to the user. In a fixed-interval loop the delay is ignored.",
      parameters: {
        type: "object",
        properties: {
          delay_seconds: { type: "integer", description: "Seconds until the next check (60–3600)" },
          prompt: { type: "string", description: "The loop's prompt, passed back each time" },
          reason: { type: "string", description: "One short sentence on the delay (shown)" },
          noop: { type: "boolean", description: "Nothing changed since the last check" },
          stop: { type: "boolean", description: "End the loop" },
        },
        required: ["delay_seconds", "prompt", "reason"],
      },
    },
    readOnly: true,
    concurrent: false,
    verb: "Next check",
    target: (a) =>
      a.stop === true
        ? "stop"
        : `in ${durationText(clampDelay(a.delay_seconds) * 1000)}${a.noop === true ? " · quiet" : ""}`,
    async run(args, host) {
      const result = service.wake(host.session, {
        delay: Number(args.delay_seconds),
        prompt: typeof args.prompt === "string" ? args.prompt.trim() : "",
        reason: typeof args.reason === "string" ? args.reason.trim().slice(0, 200) : "",
        noop: args.noop === true,
        stop: args.stop === true,
      });
      const isError = result.startsWith("Error:");
      return {
        result,
        ...(isError && { isError: true }),
        summary: args.stop === true ? "stopped" : args.noop === true ? "quiet" : "scheduled",
      };
    },
  };
}

/** A loop for the state and the agent: its pace, next check, counts. */
function describeLoop(l: ChatLoop, now: number) {
  return {
    session: l.session,
    prompt: l.prompt,
    pace: loopPace(l),
    ...(l.every && { everySeconds: Math.round(l.every / 1000) }),
    checks: l.ticks,
    quiet: l.quiet,
    ...(l.next && { next: new Date(l.next).toISOString(), nextText: describeNext(l.next, now) }),
    // The pending check's schedule (agent.runScheduleNow sends it now).
    ...(l.schedule && { scheduleId: l.schedule }),
    waiting: !l.next,
    ...(l.reason && { reason: l.reason }),
    ends: new Date(l.expires).toISOString(),
  };
}

export function registerChatLoops(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
  schedules: ScheduleService,
): LoopService {
  const service = new LoopService(services, sessions, schedules, sub);
  sub.add(service);
  sub.add(
    services.persistence.register("agent.loops", {
      save: () => service.save(),
      restore: (data) => service.restore(data),
    }),
  );
  sub.add(services.workspace.onDidClose(() => service.clear()));

  // Offered only in a chat with a loop.
  const tool = wakeupTool(service);
  const previous = sessions.extraTools;
  sessions.extraTools = (session) => [
    ...previous(session),
    ...(session && loopOf(session.id) ? [tool] : []),
  ];

  /** `/loop [interval] <prompt>`: starts the loop; the message is its first check. */
  const startFrom = (session: AgentSession, args: string): ChatLoop => {
    const parsed = parseLoopArgs(args);
    if ("error" in parsed) throw new Error(parsed.error);
    return service.start(session, parsed.prompt, parsed.every);
  };
  builtinSlash.set("loop", async (session, args) => ({
    context: loopStartContext(startFrom(session, args)),
  }));
  sub.add({ dispose: () => builtinSlash.delete("loop") });

  const { dispatcher, state } = services;
  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "Agent", ...c }));
  const sessionInput = s.string().describe("Session id (default: the active session)").optional();

  register({
    id: "agent.startLoop",
    title: "Start a loop",
    description:
      'Starts a loop in a chat (D332, same as typing /loop): the agent checks `prompt` now and again later, every `interval` ("5m", "2h") or self-paced without one, for up to 7 days.',
    input: s.object({
      session: sessionInput,
      prompt: s.string().describe("What to check each time"),
      interval: s.string().describe('"5m", "1h"; none: self-paced').optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ session, prompt, interval }, ctx) => {
      const target = sessions.require(session);
      const message = `/loop ${interval ? `${interval} ` : ""}${prompt}`;
      return ctx.execute("agent.send", { session: target.id, message, wait: false });
    },
  });

  register({
    id: "agent.stopLoop",
    title: "Stop the loop",
    description: "Ends a chat's loop (D332): its next check is cancelled.",
    input: s.object({ session: sessionInput }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ session }) => {
      const target = sessions.require(session);
      const ended = service.end(target.id, "you stopped it");
      return { stopped: !!ended };
    },
  });

  sub.add(
    state.register("ide://agent/loops", {
      description:
        "Loops running in this folder's chats (D332, /loop): each one's chat, prompt, pace (every N or self-paced), checks so far and quiet ones, the next check (none while the agent is choosing it) and the agent's reason, and when it ends.",
      get: () => {
        const now = Date.now();
        return { loops: list.value.map((l) => describeLoop(l, now)) };
      },
    }),
  );
  return service;
}
