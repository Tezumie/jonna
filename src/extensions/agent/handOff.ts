// hand_off_task (D329, Claude Code's hand_off_to_session; core/agent/handOff.ts has the texts): a
// new message about something else arrives while the agent is mid-task. The task moves to a new
// chat that starts working on it at once (it's the user's task already): its first message is the
// remaining plan, and this conversation so far goes with it as context (the fork's transcript,
// D324). The call shows here as a card linking to that chat (view/chatFlowCards.ts), and this
// turn goes on to answer the new message. Unlike propose_task (D303), which only offers a new task,
// this moves work in progress.

import { forkBudget, forkTranscript } from "../../core/agent/fork";
import {
  beforeCall,
  handOffContext,
  handOffMessage,
  handOffResult,
  parseHandOff,
} from "../../core/agent/handOff";
import type { SessionManager } from "./sessions";
import { helperRootOf } from "./toolRoots";
import type { AgentTool } from "./tools";

export function handOffTool(sessions: SessionManager): AgentTool {
  return {
    spec: {
      name: "hand_off_task",
      description:
        "Move the task you're in the middle of into a new chat of its own (it gets this conversation so far plus your remaining plan, and starts working at once), so you can answer the user now. Use it when a new user message about something else arrives mid-task; not for small corrections, a question about the task itself, or when the user said to keep the work here. Write a bold title line and one sentence right before the call; after it, stop that task here and answer the new message, no recap. Files you changed stay on disk (and in this chat's review).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "The task, under 60 characters." },
          remaining_plan: {
            type: "string",
            description:
              "What is left: the steps, the files, what done looks like (the new chat's first message).",
          },
        },
        required: ["title", "remaining_plan"],
      },
    },
    // It starts work that edits files: offered in Agent mode only.
    readOnly: false,
    concurrent: false,
    verb: "Handed off",
    target: (a) => String(a.title ?? ""),
    async run(args, host, itemId) {
      const r = parseHandOff(args);
      if ("error" in r) return { result: `Error: ${r.error}`, isError: true };
      const from = sessions.find(host.session);
      if (!from) return { result: "Error: this chat isn't loaded.", isError: true };
      // A helper's chat works in its own worktree: a new chat would work in the window's folder.
      if (helperRootOf(host.session))
        return {
          result:
            "Error: a helper in its own worktree can't hand work off; finish it or report back.",
          isError: true,
        };
      const { title } = r.handOff;
      const transcript = forkTranscript(
        beforeCall(from.items, itemId),
        forkBudget(from.usage.peek()?.limit ?? null),
      );
      const next = sessions.get();
      next.title.value = title;
      // The same agent and model carry on (Plan or Ask never get here: the tool edits).
      next.chatMode.value = from.chatMode.peek();
      if (from.model.peek()) next.model.value = from.model.peek();
      sessions.changed();
      const context = handOffContext({ id: from.id, title: from.title.peek() }, transcript.text);
      // Through send (one turn at a time, held messages sent after it), as a typed message is.
      void next.send(handOffMessage(r.handOff), [context]).catch((err: unknown) => {
        next.addNotice(
          `The handed-off task couldn't start: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      return {
        result: handOffResult({ id: next.id, title }),
        summary: "handed off",
        // The card's link: the new chat (core/agent/handOff.ts handOffChat).
        detail: next.id,
      };
    },
  };
}
