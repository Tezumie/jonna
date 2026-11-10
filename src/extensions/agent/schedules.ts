// Scheduled messages (D253, core/agent/schedules.ts has the rules): the agent's `schedule` tool,
// the commands (agent.schedule, agent.schedules, agent.cancelSchedule, agent.runScheduleNow) and
// ide://agent/schedules. They're kept with the folder (workspace state) and run while the IDE is
// open: one timer for the soonest, at most a minute long so a sleeping computer catches up when it
// wakes. A due one sends its prompt to its chat (into the running turn, or a turn of its own, as a
// background subagent's report does), to a channel or an agent's DMs (agent.postToChannel), or to a
// new chat with an agent. Missed while the IDE was closed: it runs once when the folder opens.

import {
  afterRun,
  DAY,
  DEFAULT_EXPIRY_DAYS,
  describeNext,
  describeRepeat,
  dueSchedules,
  labelFor,
  MAX_EXPIRY_DAYS,
  MAX_SCHEDULES,
  MINUTE,
  parseWhen,
  type Schedule,
  type ScheduleTarget,
  scheduledText,
  untilNext,
  validSchedules,
  whenProblem,
} from "../../core/agent/schedules";
import { agentStoreIpc } from "../../core/ipc/agent";
import { type DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { type ReadonlySignal, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { backgroundProcesses } from "./backgroundProcesses";
import { newId } from "./ids";
import { exitNotice } from "./processTools";
import { deliverAutoMessage } from "./sessionSubagents";
import type { SessionManager } from "./sessions";
import type { AgentTool } from "./tools";

/** The longest the timer sleeps: a computer waking from sleep runs what came due within a minute. */
const TICK_MAX = MINUTE;
/** After the folder opens, overdue schedules wait this long (the window settles first). */
const STARTUP_GRACE = 8000;

const list = signal<readonly Schedule[]>([]);
/** This folder's schedules (the details panel lists a chat's). */
export const scheduledMessages: ReadonlySignal<readonly Schedule[]> = list;

/** A chat's schedules: those that send to it, and those its agent made. */
export function schedulesOf(session: string): Schedule[] {
  return list
    .peek()
    .filter(
      (x) => (x.target.kind === "chat" && x.target.session === session) || x.from === session,
    );
}

/** Where a schedule sends, for people: "this chat", "#general", "a new chat with reviewer". */
function targetText(t: ScheduleTarget, from?: string): string {
  if (t.kind === "chat") return t.session === from ? "this chat" : `chat ${t.session}`;
  if (t.kind === "channel") return t.channel.startsWith("#") ? t.channel : `${t.channel}'s DMs`;
  return t.agent === "agent" ? "a new chat with the main agent" : `a new chat with ${t.agent}`;
}

/** One schedule as the agent and ide://agent/schedules show it. */
function describe(x: Schedule, now: number, from?: string) {
  return {
    id: x.id,
    label: x.label,
    prompt: x.prompt,
    to: targetText(x.target, from),
    target: x.target,
    repeat: describeRepeat(x.repeat),
    next: new Date(x.next).toISOString(),
    nextText: describeNext(x.next, now),
    runs: x.runs,
    createdBy: x.createdBy,
    ...(x.from && { from: x.from }),
    ...(x.expires !== undefined && { expires: new Date(x.expires).toISOString() }),
    ...(x.lastError && { lastError: x.lastError }),
  };
}

export interface ScheduleSpec {
  when: string;
  prompt: string;
  target: ScheduleTarget;
  createdBy: "user" | "agent";
  from?: string;
  /** A repeating one stops after this many days (default DEFAULT_EXPIRY_DAYS, at most a year). */
  expiresInDays?: number;
}

export class ScheduleService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** No overdue schedule runs before this (just restored). */
  private notBefore = 0;
  private running = false;

  constructor(
    private readonly services: WorkbenchServices,
    private readonly sessions: SessionManager,
  ) {}

  get all(): readonly Schedule[] {
    return list.peek();
  }

  /** Adds a schedule; throws with what's wrong (the time, too many). */
  add(spec: ScheduleSpec): Schedule {
    const now = Date.now();
    const prompt = spec.prompt.trim();
    if (!prompt) throw new Error("Say what to send (`prompt`).");
    const when = parseWhen(spec.when, now);
    if ("error" in when) throw new Error(when.error);
    const problem = whenProblem(when, now);
    if (problem) throw new Error(problem);
    if (list.peek().length >= MAX_SCHEDULES)
      throw new Error(`There are already ${MAX_SCHEDULES} schedules here: cancel some first.`);
    const days = Math.min(MAX_EXPIRY_DAYS, Math.max(1, spec.expiresInDays ?? DEFAULT_EXPIRY_DAYS));
    const schedule: Schedule = {
      id: newId("s"),
      label: labelFor(prompt),
      prompt,
      target: spec.target,
      next: "at" in when ? when.at : when.first,
      ...("repeat" in when && { repeat: when.repeat, expires: now + days * DAY }),
      created: now,
      createdBy: spec.createdBy,
      ...(spec.from && { from: spec.from }),
      runs: 0,
    };
    this.set([...list.peek(), schedule]);
    return schedule;
  }

  cancel(id: string): Schedule | null {
    const found = list.peek().find((x) => x.id === id) ?? null;
    if (found) this.set(list.peek().filter((x) => x.id !== id));
    return found;
  }

  /** Runs it now; a repeating one keeps its rhythm, a one-off is done. */
  async runNow(id: string): Promise<void> {
    const found = list.peek().find((x) => x.id === id);
    if (!found) throw new Error(`No schedule ${id}.`);
    await this.fire(found, Date.now());
  }

  /** The folder's saved schedules (workspace state). */
  restore(data: unknown): void {
    list.value = validSchedules(data);
    this.notBefore = Date.now() + STARTUP_GRACE;
    this.arm();
  }

  save(): Schedule[] {
    return [...list.peek()];
  }

  /** The folder closed: its schedules go with it (they're saved with it). */
  clear(): void {
    clearTimeout(this.timer);
    list.value = [];
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  private set(next: readonly Schedule[]): void {
    list.value = next;
    this.services.persistence.scheduleSave();
    this.arm();
  }

  private arm(): void {
    clearTimeout(this.timer);
    const now = Date.now();
    const wait = untilNext(list.peek(), now);
    if (wait === null) return;
    const delay = Math.min(TICK_MAX, Math.max(wait, this.notBefore - now, 0));
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const due of dueSchedules(list.peek(), Date.now())) await this.fire(due, Date.now());
    } finally {
      this.running = false;
      this.arm();
    }
  }

  /** Sends it, then moves it on (or drops a one-off). A failure is kept on it, and it moves on. */
  private async fire(x: Schedule, now: number): Promise<void> {
    let error: string | null = null;
    try {
      await this.send(x, scheduledText(x, now));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const current = list.peek();
    if (!current.some((y) => y.id === x.id)) return; // cancelled while it was sent
    const after = error === "gone" ? null : afterRun(x, now);
    let moved: Schedule | null = null;
    if (after) {
      const { lastError: _old, ...rest } = after;
      moved = error ? { ...rest, lastError: error } : rest;
    }
    this.set(current.flatMap((y) => (y.id !== x.id ? [y] : moved ? [moved] : [])));
    if (error && error !== "gone")
      this.services.notifications.show(
        "warning",
        `Scheduled message "${x.label}" couldn't be sent: ${error}`,
      );
  }

  private async send(x: Schedule, text: string): Promise<void> {
    const t = x.target;
    if (t.kind === "chat") {
      const loaded = this.sessions.find(t.session);
      // Deleted (not open, not saved): the schedule goes with it.
      if (!loaded && !(await agentStoreIpc.stamps([t.session]).catch(() => [null]))[0])
        throw new Error("gone");
      const session = loaded ?? this.sessions.get(t.session);
      await session.hydrating;
      if (session.deleted) throw new Error("gone");
      deliverAutoMessage(session, text, "schedule");
      this.sessions.changed();
      return;
    }
    if (t.kind === "channel") {
      await this.services.dispatcher.execute("agent.postToChannel", {
        channel: t.channel,
        message: text,
      });
      return;
    }
    const opened = await this.services.dispatcher.execute<{ session?: string } | null>(
      "agent.chatWith",
      { agent: t.agent },
    );
    const session = opened?.session ? this.sessions.find(opened.session) : undefined;
    if (!session) throw new Error(`couldn't start a chat with ${t.agent}`);
    deliverAutoMessage(session, text, "schedule");
  }
}

/** The tool's `to`: where the agent wants it sent. */
function targetFrom(args: Record<string, unknown>, session: string): ScheduleTarget {
  const channel = typeof args.channel === "string" ? args.channel.trim() : "";
  const agent = typeof args.agent === "string" ? args.agent.trim() : "";
  if (channel && agent) throw new Error("Give `channel` or `agent`, not both.");
  if (channel) return { kind: "channel", channel };
  if (agent) return { kind: "new", agent };
  return { kind: "chat", session };
}

function scheduleTool(service: ScheduleService): AgentTool {
  return {
    spec: {
      name: "schedule",
      description:
        'Schedule a message for later, or a repeating one, while the IDE stays open: "in 20 minutes" check a deploy, "every 2 hours" look at the queue, "every weekday at 9am" sum up yesterday\'s commits. When it\'s due, `prompt` arrives as a message in this chat (a turn of yours starts), or with `channel` in a channel ("#general") or an agent\'s direct messages (its name), or with `agent` in a new chat with that agent (another agent\'s work for later). Times: "in 20 minutes", "at 15:30", "tomorrow at 9am", "2026-11-03 09:00", "every 30 minutes", "hourly", "daily at 9:00", "every weekday at 9am", "every monday and thursday at 17:00". At least a minute ahead; repeats at most every 5 minutes, and stop after `expires_in_days` (default 7; when the user asks for an ongoing one, "every day" with no end, set how long they want, up to 365). Write the prompt for whoever reads it then: it won\'t see this conversation unless it\'s this chat. To wait for a running command instead, use process_output with wait_for. action "list" shows this chat\'s schedules; "cancel" removes one by id.',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "list", "cancel"], description: "Default add" },
          when: { type: "string", description: 'e.g. "in 20 minutes", "every weekday at 9am"' },
          prompt: { type: "string", description: "The message to send then" },
          channel: {
            type: "string",
            description: 'Send it in a channel ("#general") or an agent\'s DMs (its name)',
          },
          agent: {
            type: "string",
            description: 'Send it to a new chat with this agent ("agent": the main agent)',
          },
          expires_in_days: {
            type: "integer",
            description: "A repeating one stops after this many days (default 7, at most 365)",
          },
          id: { type: "string", description: "The schedule to cancel" },
        },
        required: [],
      },
    },
    readOnly: false,
    concurrent: false,
    verb: "Scheduled",
    target: (a) =>
      a.action === "list"
        ? "schedules"
        : a.action === "cancel"
          ? String(a.id ?? "")
          : `${String(a.when ?? "")}: ${labelFor(String(a.prompt ?? ""))}`,
    async run(args, host) {
      const action = typeof args.action === "string" ? args.action : "add";
      const now = Date.now();
      if (action === "list") {
        const mine = schedulesOf(host.session);
        return {
          result: mine.length
            ? JSON.stringify(
                mine.map((x) => describe(x, now, host.session)),
                null,
                1,
              )
            : "No schedules for this chat.",
          summary: `${mine.length} scheduled`,
        };
      }
      if (action === "cancel") {
        const id = typeof args.id === "string" ? args.id : "";
        const found = schedulesOf(host.session).find((x) => x.id === id);
        if (!found)
          return {
            result: `Error: no schedule "${id}" for this chat (action "list" shows them).`,
            isError: true,
          };
        service.cancel(id);
        return { result: `Cancelled "${found.label}".`, summary: "cancelled" };
      }
      try {
        const target = targetFrom(args, host.session);
        const when = typeof args.when === "string" ? args.when : "";
        const prompt = typeof args.prompt === "string" ? args.prompt : "";
        const parsed = parseWhen(when, now);
        if ("error" in parsed) throw new Error(parsed.error);
        // One number for what's asked and what's saved ("30" as a string counts).
        const asked = Number(args.expires_in_days);
        const days = Math.min(
          MAX_EXPIRY_DAYS,
          Math.max(
            1,
            Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : DEFAULT_EXPIRY_DAYS,
          ),
        );
        // A repeat, or work started somewhere else, runs while the user may be away: asked
        // once. A one-off wake-up in this chat is the agent's own follow-up: not asked.
        if ("repeat" in parsed || target.kind !== "chat") {
          const answer = await host.ask({
            title: `Schedule "${labelFor(prompt)}"`,
            heading: "Schedule a message",
            detail: `${"repeat" in parsed ? describeRepeat(parsed.repeat) : when}, to ${targetText(target, host.session)}${"repeat" in parsed ? ` for ${days} days` : ""}. Each run is a turn of an agent (it uses the model).`,
            code: prompt.slice(0, 600),
            kind: "tool",
            always: "this session",
          });
          if (answer === "deny")
            return { result: "The user declined this schedule.", denied: true, summary: "denied" };
        }
        const made = service.add({
          when,
          prompt,
          target,
          createdBy: "agent",
          from: host.session,
          expiresInDays: days,
        });
        return {
          result: `Scheduled (id ${made.id}): ${describeRepeat(made.repeat)}, next ${describeNext(made.next, now)}, to ${targetText(made.target, host.session)}.${made.repeat ? ` It stops ${new Date(made.expires ?? 0).toLocaleDateString()}.` : ""} It runs only while the IDE is open.`,
          summary: describeNext(made.next, now),
        };
      } catch (err) {
        return {
          result: `Error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

export function registerSchedules(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): ScheduleService {
  const { dispatcher, state, quickInput, persistence, workspace } = services;
  const service = new ScheduleService(services, sessions);
  sub.add(toDisposable(() => service.dispose()));
  sub.add(
    persistence.register("agent.schedules", {
      save: () => service.save(),
      restore: (data) => service.restore(data),
    }),
  );
  sub.add(workspace.onDidClose(() => service.clear()));

  // A background command started with notify_on_exit that ended: its chat's agent is told.
  sub.add(
    backgroundProcesses.onDidEnd((p) => {
      const text = exitNotice(p);
      if (!text) return;
      // Its chat may have been put away meanwhile (no tab): loaded again to hear it, as a
      // scheduled message's is. A deleted chat (nothing saved) isn't brought back.
      const session = sessions.find(p.session) ?? sessions.get(p.session);
      void session.loaded().then(() => {
        if (!session.deleted && session.items.length) deliverAutoMessage(session, text, "process");
      });
    }),
  );

  // The tool joins the others (MCP servers', subagents', skills').
  const tool = scheduleTool(service);
  const previous = sessions.extraTools;
  sessions.extraTools = (session) => [...previous(session), tool];

  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "Agent", ...c }));

  sub.add(
    state.register("ide://agent/schedules", {
      description:
        "Scheduled messages in this folder (D253): each one's id, label, prompt, where it goes (a chat, a channel or an agent's DMs, a new chat with an agent), how it repeats, when it runs next, how many times it ran, who made it and the last error. They run while the IDE is open.",
      get: () => {
        const now = Date.now();
        return { schedules: list.value.map((x) => describe(x, now)) };
      },
    }),
  );

  register({
    id: "agent.schedule",
    title: "Schedule a message to the agent…",
    description:
      'Schedules a message for later or on repeat (D253): `when` ("in 20 minutes", "tomorrow at 9am", "every weekday at 9am", "every 2 hours"…), `prompt`, and where it goes: `session` (a chat, default the active one), `channel` ("#general" or an agent\'s name for its DMs) or `agent` (a new chat with that agent each time). Repeats stop after `expiresInDays` (default 7). Asks for what\'s missing when a person runs it. Returns the schedule.',
    input: s.object({
      prompt: s.string().optional(),
      when: s.string().optional(),
      session: s.string().optional(),
      channel: s.string().optional(),
      agent: s.string().optional(),
      expiresInDays: s.number().optional(),
    }),
    effects: ["write"],
    run: async ({ prompt, when, session, channel, agent, expiresInDays }, ctx) => {
      const asked = ctx.caller.kind === "user";
      const text =
        prompt ??
        (asked
          ? await quickInput.prompt({
              prompt: "What should the agent be told then?",
              placeholder: "Check whether the nightly build passed and sum up what failed",
            })
          : undefined);
      if (!text?.trim()) return null;
      const time =
        when ??
        (asked
          ? await quickInput.prompt({
              prompt: "When?",
              placeholder: "in 30 minutes · tomorrow at 9am · every weekday at 9am · every 2 hours",
            })
          : undefined);
      if (!time?.trim()) return null;
      const target: ScheduleTarget = channel
        ? { kind: "channel", channel }
        : agent
          ? { kind: "new", agent }
          : { kind: "chat", session: sessions.require(session).id };
      const made = service.add({
        when: time,
        prompt: text,
        target,
        createdBy: "user",
        ...(expiresInDays !== undefined && { expiresInDays }),
      });
      if (asked)
        services.notifications.show(
          "info",
          `Scheduled "${made.label}": ${describeRepeat(made.repeat)}, next ${describeNext(made.next, Date.now())}.`,
        );
      return describe(made, Date.now());
    },
  });

  register({
    id: "agent.schedules",
    title: "Scheduled messages…",
    description:
      "Lists this folder's scheduled messages (D253, ide://agent/schedules). When a person runs it, picking one offers Run now and Cancel.",
    input: s.empty(),
    effects: ["read"],
    run: async (_input, ctx) => {
      const now = Date.now();
      const all = list.peek();
      if (ctx.caller.kind !== "user") return all.map((x) => describe(x, now));
      if (!all.length) {
        services.notifications.show(
          "info",
          'Nothing is scheduled. Ask the agent ("remind me in an hour to…", "every morning, check…") or run Schedule a message to the agent.',
        );
        return [];
      }
      const picked = await quickInput.pick(
        all.map((x) => ({
          id: x.id,
          label: x.label,
          description: `${describeRepeat(x.repeat)} · next ${describeNext(x.next, now)}`,
          detail: `To ${targetText(x.target)}${x.lastError ? ` · last run failed: ${x.lastError}` : ""}`,
        })),
        { placeholder: "Scheduled messages" },
      );
      if (!picked) return all.map((x) => describe(x, now));
      const action = await quickInput.pick(
        [
          { id: "run", label: "Run now" },
          { id: "cancel", label: "Cancel it" },
        ],
        { placeholder: picked.label },
      );
      if (action?.id === "run") await service.runNow(picked.id);
      if (action?.id === "cancel") service.cancel(picked.id);
      return list.peek().map((x) => describe(x, Date.now()));
    },
  });

  register({
    id: "agent.cancelSchedule",
    title: "Cancel a scheduled message",
    description: "Removes a scheduled message by `id` (from ide://agent/schedules).",
    input: s.object({ id: s.string() }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ id }) => {
      const found = service.cancel(id);
      if (!found) throw new Error(`No schedule ${id}.`);
      return { cancelled: id };
    },
  });

  register({
    id: "agent.runScheduleNow",
    title: "Run a scheduled message now",
    description:
      "Sends a scheduled message now (`id` from ide://agent/schedules); a repeating one keeps its rhythm, a one-off is done.",
    input: s.object({ id: s.string() }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ id }) => {
      await service.runNow(id);
      return { ran: id };
    },
  });

  return service;
}
