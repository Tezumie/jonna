// A chat as a stream of events, for a front end that isn't the window: a terminal printing as
// the agent works, a client attached to a running brain, newline-delimited JSON on stdout. It is
// built on what a chat already tells its views: its signals (status, permissions, questions,
// usage, cost, error), its version (bumped whenever its items change), its decisions
// (`onDidDecide`) and the workbench's `agent.didEdit` event. Nothing polls: each change is read
// once, compared with what was told before, and told as events in the conversation's order.
//
// Every event is plain JSON (`JSON.stringify` gives its wire form): the union below is the
// contract. DOM-free.
import { type AskQuestion, parseAskUser } from "../../core/agent/askUser";
import type { Item, ToolStatus } from "../../core/agent/conversation";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { effect, untracked } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { AgentSession } from "./session";
import type { SessionStatus } from "./sessionTypes";
import type { PermissionDecision } from "./unattended";

/**
 * Why a turn ended. `end`: the agent answered. `stopped`: it was stopped (Stop, a limit of the
 * run, the folder closing). `max_steps`: it paused at the step limit with work left. `error`:
 * the model or the provider failed (`error` on the event says how).
 */
export type TurnEndReason = "end" | "stopped" | "max_steps" | "error";

/** What the chat has used: the context of the last request, and totals since it was loaded. */
export interface SessionUsage {
  /** The last request's context, in tokens, and the model's limit; null before any request. */
  context: { tokens: number; limit: number; estimated: boolean; cached?: number } | null;
  /** Tokens since the chat was loaded in this process. */
  totals: {
    requests: number;
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
  };
  /** Dollars spent, priced as each request was made; null while no request had a known price. */
  cost: number | null;
}

interface Base {
  /** The chat's id. */
  session: string;
}

export type SessionEvent = Base &
  (
    | {
        /** The observer attached: where the chat stands. Always the first event. */
        type: "session";
        title: string;
        /** The model's key ("<provider>/<model>", "acp/<agent>"), or null for the default. */
        model: string | null;
        chatMode: string;
        status: SessionStatus;
        /** How many items the conversation already holds (they are not replayed). */
        items: number;
      }
    | { type: "status"; status: SessionStatus }
    | { type: "turn.start" }
    | {
        /** A message in the conversation that the model didn't write. */
        type: "message";
        id: string;
        text: string;
        /** Set when the IDE sent it, not the person: a failed check, a report, a schedule… */
        auto?: string;
      }
    | {
        /** More of an answer's text. `reset`: `delta` is the whole text again (it was rewritten). */
        type: "text";
        id: string;
        delta: string;
        reset?: true;
        /** The agent that writes it, in a chat with several. */
        speaker?: string;
      }
    | { type: "thinking"; id: string; delta: string; reset?: true }
    | {
        /** A tool call as the model made it (`args` may still be filled in by `tool.update`). */
        type: "tool.start";
        id: string;
        callId: string;
        name: string;
        args: unknown;
      }
    | { type: "tool.update"; id: string; args: unknown }
    | {
        /** A running command's output as it comes. `reset`: the kept tail was cut; `delta` is it. */
        type: "tool.output";
        id: string;
        delta: string;
        reset?: true;
      }
    | {
        type: "tool.end";
        id: string;
        callId: string;
        name: string;
        status: Exclude<ToolStatus, "pending" | "running">;
        /** One line ("120 lines", "exit 1 · 4.2s"). */
        summary?: string;
        /** What the model was given back. */
        result?: string;
        /** Files the call proposed changes to. */
        changes?: string[];
      }
    | { type: "notice"; id: string; text: string; tone: "info" | "error"; detail?: string }
    | { type: "summary"; id: string; text: string; count: number; auto: boolean }
    | {
        /** A question waits on the chat: answer with `agent.respondPermission` (`id`). */
        type: "permission.request";
        id: string;
        title: string;
        heading?: string;
        detail?: string;
        /** What it is about, as code: a command line, a command's id. */
        code?: string;
        kind?: "command" | "ide" | "tool" | "agent";
        danger?: boolean;
        /** The pattern "always" would allow from now on, when the request offers it. */
        always?: string;
      }
    | ({ type: "permission.decision" } & PermissionDecision)
    | {
        /** ask_user waits: answer with `agent.answer` (`id` is its `item`). */
        type: "question";
        id: string;
        questions: AskQuestion[];
      }
    | { type: "question.answered"; id: string }
    | {
        /** The agent changed a file: `proposed` waits for review, `applied` is on disk. */
        type: "edit";
        path: string;
        /** The first changed line (1-based). */
        line: number;
        state: "proposed" | "applied";
      }
    | ({ type: "usage" } & SessionUsage)
    | {
        type: "turn.end";
        reason: TurnEndReason;
        /** The turn's answer: the text of the last reply it wrote ("" when it wrote none). */
        text: string;
        /** The failure, when `reason` is "error". */
        error?: string;
        usage: SessionUsage;
      }
    | {
        /** The chat's error changed (a turn failing also ends with `turn.end`). */
        type: "error";
        message: string;
      }
  );

export type SessionEventListener = (event: SessionEvent) => void;

/** An event without the chat it is from (the observer adds it). */
type Unaddressed = SessionEvent extends infer E
  ? E extends unknown
    ? Omit<E, "session">
    : never
  : never;

/** What was last told about one item. */
interface Told {
  type: Item["type"];
  text: string;
  thinking: string;
  status: ToolStatus | null;
  args: string;
  output: string;
}

const json = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
};

/** The chat's usage now (the same numbers `ide://agent/session` gives). */
export function sessionUsage(session: AgentSession): SessionUsage {
  return {
    context: session.usage.peek(),
    totals: { ...session.totals.peek() },
    cost: session.cost.peek(),
  };
}

/** The text of the last reply that isn't one of `earlier` (item ids); "" when there is none. */
function answerNotIn(session: AgentSession, earlier: ReadonlySet<string>): string {
  for (let i = session.items.length - 1; i >= 0; i--) {
    const item = session.items[i];
    if (item?.type === "assistant" && item.text.trim() && !earlier.has(item.id)) return item.text;
  }
  return "";
}

/**
 * Tells `listener` everything that happens in `session` from now on, as events, until the
 * returned disposable is disposed. What the conversation already holds is not replayed (the
 * first event, `session`, says how much there is). Load the chat first (`session.loaded()`): a
 * saved conversation arriving later would be told as new.
 */
export function observeSession(
  services: Pick<WorkbenchServices, "events">,
  session: AgentSession,
  listener: SessionEventListener,
): Disposable {
  const store = new DisposableStore();
  const id = session.id;
  let disposed = false;
  const emit = (event: Unaddressed): void => {
    if (disposed) return;
    try {
      listener({ session: id, ...event } as SessionEvent);
    } catch (err) {
      console.error("A session event listener failed", err);
    }
  };

  const told = new Map<string, Told>();
  const snapshot = (item: Item): Told => ({
    type: item.type,
    text: item.type === "tool" ? "" : item.text,
    thinking: item.type === "assistant" ? item.thinking : "",
    status: item.type === "tool" ? item.status : null,
    args: item.type === "tool" ? json(item.args) : "",
    output: "",
  });
  for (const item of session.items) told.set(item.id, snapshot(item));

  let status = session.status.peek();
  /** The items there were when the running turn started: its answer is not one of them. */
  let beforeTurn: ReadonlySet<string> = new Set(told.keys());
  let permissions = new Set(session.permissions.peek().map((p) => p.id));
  let questions = new Set(session.questions.peek().map((q) => q.itemId));
  let usage = json(sessionUsage(session));
  let error = session.error.peek();

  emit({
    type: "session",
    title: session.title.peek(),
    model: session.model.peek(),
    chatMode: session.chatMode.peek(),
    status,
    items: session.items.length,
  });

  /** A grown text as its new part; anything else as the whole text, marked. */
  const grown = (before: string, now: string): { delta: string; reset?: true } | null => {
    if (now === before) return null;
    if (now.startsWith(before)) return { delta: now.slice(before.length) };
    return { delta: now, reset: true };
  };

  const syncItems = (): void => {
    const live = new Set<string>();
    for (const item of session.items) {
      live.add(item.id);
      const before = told.get(item.id);
      if (item.type === "assistant") {
        const thinking = grown(before?.thinking ?? "", item.thinking);
        if (thinking) emit({ type: "thinking", id: item.id, ...thinking });
        const text = grown(before?.text ?? "", item.text);
        if (text)
          emit({
            type: "text",
            id: item.id,
            ...text,
            ...(item.speaker && { speaker: item.speaker }),
          });
        told.set(item.id, snapshot(item));
      } else if (item.type === "tool") {
        const args = json(item.args);
        if (!before)
          emit({
            type: "tool.start",
            id: item.id,
            callId: item.callId,
            name: item.name,
            args: item.args,
          });
        else if (before.args !== args) emit({ type: "tool.update", id: item.id, args: item.args });
        const output = session.outputs.get(item.id) ?? before?.output ?? "";
        const more = grown(before?.output ?? "", output);
        if (more?.delta) emit({ type: "tool.output", id: item.id, ...more });
        const ended = item.status !== "pending" && item.status !== "running";
        const wasEnded =
          !!before &&
          before.status !== null &&
          before.status !== "pending" &&
          before.status !== "running";
        if (ended && (!wasEnded || before?.status !== item.status))
          emit({
            type: "tool.end",
            id: item.id,
            callId: item.callId,
            name: item.name,
            status: item.status as Exclude<ToolStatus, "pending" | "running">,
            ...(item.summary !== undefined && { summary: item.summary }),
            ...(item.result !== undefined && { result: item.result }),
            ...(item.changes?.length && { changes: [...item.changes] }),
          });
        told.set(item.id, { ...snapshot(item), output });
      } else if (!before || before.text !== item.text) {
        if (item.type === "user")
          emit({
            type: "message",
            id: item.id,
            text: item.text,
            ...(item.auto && { auto: item.auto }),
          });
        else if (item.type === "notice")
          emit({
            type: "notice",
            id: item.id,
            text: item.text,
            tone: item.tone,
            ...(item.detail && { detail: item.detail }),
          });
        else
          emit({
            type: "summary",
            id: item.id,
            text: item.text,
            count: item.count,
            auto: item.auto,
          });
        told.set(item.id, snapshot(item));
      }
    }
    // Items a retry or a rewind dropped are forgotten (an id is never used twice).
    for (const key of [...told.keys()]) if (!live.has(key)) told.delete(key);
  };

  const sync = (): void => {
    const nowStatus = session.status.peek();
    // A turn starting is told before what it brings.
    if (status === "idle" && nowStatus !== "idle") {
      beforeTurn = new Set(told.keys());
      emit({ type: "turn.start" });
    }
    syncItems();

    const nowPermissions = session.permissions.peek();
    for (const p of nowPermissions)
      if (!permissions.has(p.id))
        emit({
          type: "permission.request",
          id: p.id,
          title: p.title,
          ...(p.heading && { heading: p.heading }),
          ...(p.detail && { detail: p.detail }),
          ...(p.code && { code: p.code }),
          ...(p.kind && { kind: p.kind }),
          ...(p.danger && { danger: true }),
          ...(p.always && { always: p.always }),
        });
    permissions = new Set(nowPermissions.map((p) => p.id));

    const nowQuestions = session.questions.peek();
    const open = new Set(nowQuestions.map((q) => q.itemId));
    for (const q of nowQuestions) {
      if (questions.has(q.itemId)) continue;
      const item = session.items.find((i) => i.id === q.itemId);
      const card = item?.type === "tool" ? parseAskUser(item.args) : null;
      emit({
        type: "question",
        id: q.itemId,
        questions: card && !("error" in card) ? card.questions : [],
      });
    }
    for (const before of questions)
      if (!open.has(before)) emit({ type: "question.answered", id: before });
    questions = open;

    const nowUsage = json(sessionUsage(session));
    if (nowUsage !== usage) {
      usage = nowUsage;
      emit({ type: "usage", ...sessionUsage(session) });
    }

    const nowError = session.error.peek();
    if (nowError !== error) {
      error = nowError;
      if (nowError) emit({ type: "error", message: nowError });
    }

    if (nowStatus !== status) {
      const before = status;
      status = nowStatus;
      emit({ type: "status", status: nowStatus });
      if (nowStatus === "idle" && before !== "idle") {
        const failure = session.error.peek();
        const reason: TurnEndReason = failure
          ? "error"
          : session.endedBy === "stopped"
            ? "stopped"
            : session.endedBy === "max_steps"
              ? "max_steps"
              : "end";
        emit({
          type: "turn.end",
          reason,
          text: answerNotIn(session, beforeTurn),
          ...(failure && { error: failure }),
          usage: sessionUsage(session),
        });
      }
    }
  };

  store.add(
    effect(() => {
      // Everything a change can show up in: read here so the effect runs again when it does.
      session.version.value;
      session.status.value;
      session.permissions.value;
      session.questions.value;
      session.usage.value;
      session.totals.value;
      session.cost.value;
      session.error.value;
      untracked(sync);
      return undefined;
    }),
  );
  store.add(session.onDidDecide((decision) => emit({ type: "permission.decision", ...decision })));
  store.add(
    services.events.on("agent.didEdit", (edit) => {
      if (edit.session !== id) return;
      emit({
        type: "edit",
        path: edit.path,
        line: edit.line,
        state: edit.staged ? "proposed" : "applied",
      });
    }),
  );
  store.add({
    dispose: () => {
      disposed = true;
    },
  });
  return store;
}
