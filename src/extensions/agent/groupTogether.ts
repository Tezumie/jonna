// Members answering one message at the same time (D245, Grok's groups and Slack's @channel): beside
// the member whose turn it is, each one `@all` called on (or several mentions, with
// agent.groupChat.answerTogether) answers from the conversation so far, read-only, on its own
// model. They don't see each other's answers. Each answer joins the chat once the turn is over:
// one in the middle of the turn's tool calls would split them from their results.

import { findCustomMode } from "../../core/agent/chatModes";
import { transcript } from "../../core/agent/compact";
import type { Item } from "../../core/agent/conversation";
import type { LoopDeps } from "../../core/agent/loop";
import { READ_TOOLS } from "../../core/agent/subagents";
import { aiIpc, type ModelDetails } from "../../core/ipc/agent";
import { customModes } from "./customModes";
import { memberContext, memberInfo, memberMode, memberNames } from "./groupChat";
import { newId } from "./ids";
import type { ModelChoice } from "./providers";
import type { AgentSession } from "./session";
import { runSubagent } from "./sessionSubagents";

/** What the conversation shows each one (the newest part of it). */
const HISTORY_CHARS = 24_000;
/** Answers here are short: a few reads at most. */
const MAX_STEPS = 12;
/** How long an answer waits for the turn to end before it's dropped (an hour). */
const WAIT_LIMIT_MS = 60 * 60_000;

const RULES = `Several agents are answering the user's last message at the same time; you don't see the others' answers. Answer from your own role and point of view, briefly. You can read and search the project but not change anything here: if something should change, say what, and hand it on with a line starting @Name.`;

/** Starts the answers of `names` beside the running turn (sessionTurn, after the turn started). */
export function startTogether(
  session: AgentSession,
  names: readonly string[],
  deps: LoopDeps,
  budgetChars: number,
  fallback: { choice: ModelChoice; details: ModelDetails },
): void {
  if (!names.length) return;
  const who = memberNames(names);
  const notice: Extract<Item, { type: "notice" }> = {
    type: "notice",
    id: newId("n"),
    text: `${who} ${names.length > 1 ? "are" : "is"} answering too…`,
    tone: "info",
  };
  // The conversation as it is now (the user's message last), the same for each.
  const history = transcript(session.items, HISTORY_CHARS, (n) => memberInfo(n).label);
  session.items.push(notice);
  session.bump();
  let left = names.length;
  // Changed in place, never taken out: the running turn holds the list.
  const finished = () => {
    if (--left > 0) return;
    notice.text = `${who} answered.`;
    session.bump();
  };
  for (const name of names) {
    const id = newId("b");
    let stopped = false;
    const requests = new Set<string>();
    session.background.set(id, {
      name,
      started: Date.now(),
      stop: () => {
        stopped = true;
        for (const r of requests) void aiIpc.cancel(r).catch(() => {});
      },
    });
    session.backgroundCount.value = session.background.size;
    const mode = memberMode(name);
    const label = memberInfo(name).label;
    const model = findCustomMode(customModes.peek(), mode)?.model ?? null;
    const tools = session
      .toolsFor(mode)
      .filter((t) => t.readOnly && READ_TOOLS.includes(t.spec.name))
      .map((t) => t.spec.name);
    void runSubagent(
      session,
      {
        system: `${memberContext(session, name)}\n\n${RULES}`,
        task: `The conversation so far:\n\n${history}\n\nAnswer the user's last message as ${label}.`,
        tools,
        maxSteps: MAX_STEPS,
        progress: () => {},
        // An external agent's model can't answer here: the turn's model does.
        ...(model && !model.startsWith("acp/") && { model }),
        cancelled: () => stopped || session.deleted,
        requests,
      },
      deps,
      budgetChars,
      () => {},
      fallback,
    )
      .then(
        (text) => (stopped ? null : text.trim()),
        (err: unknown) =>
          stopped
            ? null
            : `(${label} couldn't answer: ${err instanceof Error ? err.message : err})`,
      )
      .then((text) => {
        session.background.delete(id);
        session.backgroundCount.value = session.background.size;
        if (text && !session.deleted) whenIdle(session, () => addAnswer(session, name, text));
        finished();
      });
  }
}

/** The answer as a reply of that member's. */
function addAnswer(session: AgentSession, speaker: string, text: string): void {
  session.items.push({
    type: "assistant",
    id: newId("a"),
    text,
    thinking: "",
    streaming: false,
    speaker,
  });
  session.bump();
}

/** Runs `add` when no turn is running (tried again every second while one is). */
function whenIdle(session: AgentSession, add: () => void, since = Date.now()): void {
  if (session.deleted || Date.now() - since > WAIT_LIMIT_MS) return;
  if (!session.inTurn && session.status.peek() === "idle") {
    add();
    void session.save();
    return;
  }
  setTimeout(() => whenIdle(session, add, since), 1000);
}
