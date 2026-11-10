// The tools that shape a turn (D301–D305), after Claude Code's app: wrap_up (the box at the end of
// a turn: a recap, one question, buttons that answer it), mark_chapter (a divider and the chat's
// table of contents), propose_task / dismiss_task (a separate task offered as a card, started in a
// new chat), enter_plan_mode (asks to switch to Plan mode first) and notify (a message for a user
// who walked away). What they may say is checked in core/agent/turnTools.ts; the cards are drawn by
// view/turnCards.ts; the buttons run the commands in turnCommands.ts.

import type { Item } from "../../core/agent/conversation";
import { finishPlan } from "../../core/agent/plan";
import {
  latestTurn,
  parseChapter,
  parseNotify,
  parseProposal,
  parseWrapUp,
  TASK_DISMISSED,
  TASK_STARTED,
  WRAP_UP_ACTIONS,
  type WrapUpAction,
} from "../../core/agent/turnTools";
import { windowIpc } from "../../core/ipc/system";
import type { WorkbenchServices } from "../../workbench/services";
import type { Changeset } from "./changeset";
import { sendToPhone } from "./phoneNotify";
import type { AgentTool } from "./tools";

/** Each app action's button, and what it does (agent.runWrapUpAction runs it). */
export const WRAP_UP_LABELS: Record<WrapUpAction, string> = {
  review: "Review changes",
  keep_all: "Keep all",
  commit: "Commit…",
  create_pr: "Create PR",
  new_chat: "New chat",
  archive: "Archive chat",
};

/** The consent card's answers (enter_plan_mode). */
export const PLAN_YES = "Switch to Plan";
export const PLAN_NO = "Keep going";

/** The app actions that make sense for this chat now (a wrap_up button may offer only these). */
export async function wrapUpActionsNow(
  services: WorkbenchServices,
  changeset: Changeset,
): Promise<WrapUpAction[]> {
  const enabled = (id: string) => services.dispatcher.info(id)?.enabled === true;
  const pending = changeset.files.peek().length > 0;
  let changed = false;
  if (enabled("git.commit")) {
    const st = (await services.state.get("ide://git/status").catch(() => null))?.value as {
      staged?: unknown[];
      changes?: unknown[];
    } | null;
    changed = (st?.staged?.length ?? 0) + (st?.changes?.length ?? 0) > 0;
  }
  const now: Record<WrapUpAction, boolean> = {
    review: pending,
    keep_all: pending,
    commit: changed,
    create_pr: enabled("agent.createPullRequest") && enabled("github.createPullRequest"),
    new_chat: true,
    archive: true,
  };
  return WRAP_UP_ACTIONS.filter((a) => now[a]);
}

/** The call's place in the conversation: what came before it. */
function before(items: readonly Item[], itemId: string): readonly Item[] {
  const at = items.findIndex((it) => it.id === itemId);
  return at >= 0 ? items.slice(0, at) : items;
}

const WRAP_UP: AgentTool = {
  spec: {
    name: "wrap_up",
    description: `Fill the box the chat shows at the end of your turn: a recap and, when this turn leaves the user a decision or a step to take, one question with buttons that answer it (a turn with nothing pending gives the recap alone, and no box is drawn). Call it once in every turn where you kept a plan, changed files, ran commands or did multi-step work: when the work is done, before your closing message, which is ordinary text after this call. It also finishes the plan (no closing update_plan). Skip it for short answers, conversation, or a brief read-and-explain turn. recap and ask speak to the user ("you"); a reply button's label is the user's words back to you. App actions (only those available now; the result lists them if one isn't): ${WRAP_UP_ACTIONS.join(", ")}.`,
    parameters: {
      type: "object",
      properties: {
        recap: {
          type: "string",
          description:
            "What is now true or changed, then where it stands, including what isn't done or verified. Two or three short sentences, at most 300 characters. No recommendation here. Its first sentence is the chat's status in the lists.",
        },
        ask: {
          type: "string",
          description:
            "Only when the next move is the user's call (a choice of approach, a go-ahead, an approval): that one decision in one short sentence, without reasons or the options the buttons give. At most 100 characters.",
        },
        actions: {
          type: "array",
          description:
            "1–2 buttons answering the ask, your recommendation first; a second only when it's a realistic alternative.",
          items: {
            type: "object",
            properties: {
              label: {
                type: "string",
                description:
                  'A reply: 1–3 words, at most 24 characters ("Yes, fix it", "Not now"); a click sends it as the user\'s answer.',
              },
              action: { type: "string", enum: [...WRAP_UP_ACTIONS], description: "An app action." },
            },
          },
        },
        blocked: {
          type: "boolean",
          description:
            "True when your work stops until the user answers (the chat shows it needs them).",
        },
      },
      required: ["recap"],
    },
  },
  readOnly: true,
  verb: "Wrapped up",
  target: () => "",
  async run(args, host) {
    const available = await wrapUpActionsNow(host.services, host.changeset);
    const r = parseWrapUp(args, available, WRAP_UP_LABELS);
    if ("error" in r) return { result: `Error: ${r.error}`, isError: true };
    // The plan's step in progress is done: the turn is.
    host.setPlan(finishPlan(host.plan()));
    const w = r.wrapUp;
    return {
      result: w.ask
        ? `Shown: the recap, "${w.ask}" and ${w.actions?.map((b) => b.label).join(" / ")}. Now write your closing message.`
        : "Recap saved (no box: nothing waits on the user). Now write your closing message.",
      summary: w.ask ? "asked" : "recap",
    };
  },
};

export function chapterTool(items: () => readonly Item[]): AgentTool {
  return {
    spec: {
      name: "mark_chapter",
      description:
        "Mark the start of a new chapter of this chat when the work shifts to a meaningfully different phase: exploration done and implementation starting, a fix landed and verification starting, or the user turning to an unrelated request. The user sees a divider and a table of contents to jump between chapters. Use sparingly (a typical chat has 3–8; a chapter covers a coherent stretch of work, not a tool call), never for the chat's very first message.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: 'A short noun phrase, under 40 characters ("Auth bug fix").',
          },
          summary: {
            type: "string",
            description: "Optional: one line, shown on hover in the table of contents.",
          },
        },
        required: ["title"],
      },
    },
    readOnly: true,
    verb: "Chapter",
    target: (a) => String(a.title ?? ""),
    async run(args, _host, itemId) {
      const r = parseChapter(args, before(items(), itemId));
      if ("error" in r) return { result: `Error: ${r.error}`, isError: true };
      return { result: `Chapter "${r.chapter.title}" marked.`, summary: r.chapter.title };
    },
  };
}

export function proposeTool(items: () => readonly Item[]): AgentTool {
  return {
    spec: {
      name: "propose_task",
      description:
        "Offer the user a separate task as a card they can start in a new chat (or dismiss): real follow-up work that is a task of its own, found while working (a bug elsewhere, a refactor worth doing, tests missing). Never what you're about to do anyway, nor part of the current task. At most 3 a turn. The brief is the new chat's first message: complete on its own (what, where, why, how to check), since that chat doesn't see this one.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "A few words (at most 60 characters)." },
          brief: {
            type: "string",
            description: "The new chat's first message, self-contained.",
          },
        },
        required: ["title", "brief"],
      },
    },
    readOnly: true,
    verb: "Proposed a task",
    target: (a) => String(a.title ?? ""),
    async run(args, _host, itemId) {
      const r = parseProposal(args, latestTurn(before(items(), itemId)));
      if ("error" in r) return { result: `Error: ${r.error}`, isError: true };
      return {
        result: `Shown to the user as a card (task_id: ${itemId}). If it goes stale, dismiss_task it.`,
      };
    },
  };
}

export function dismissTool(items: () => readonly Item[]): AgentTool {
  return {
    spec: {
      name: "dismiss_task",
      description:
        "Withdraw a task you proposed (propose_task) that the user hasn't started: it went stale (done here after all, turned out unnecessary, or replaced by a better one: propose that first).",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "The task_id propose_task returned." },
          reason: { type: "string", description: "Optional: one line on why." },
        },
        required: ["task_id"],
      },
    },
    readOnly: true,
    verb: "Withdrew a task",
    target: () => "",
    async run(args) {
      const id = typeof args.task_id === "string" ? args.task_id.trim() : "";
      const task = items().find(
        (it): it is Extract<Item, { type: "tool" }> =>
          it.type === "tool" && it.name === "propose_task" && it.id === id,
      );
      if (!task) return { result: `Error: no proposed task "${id}".`, isError: true };
      if (task.summary === TASK_STARTED)
        return { result: "The user already started it in a new chat: it can't be withdrawn." };
      if (task.summary === TASK_DISMISSED) return { result: "It was dismissed already." };
      task.summary = TASK_DISMISSED;
      return { result: "Withdrawn: the card is gone." };
    },
  };
}

const PLAN_MODE: AgentTool = {
  spec: {
    name: "enter_plan_mode",
    description:
      "Ask the user to switch this chat to Plan mode before a non-trivial implementation: you'd look around read-only and write a plan they approve (Build) before any file changes. Only when the task touches several files or there's a real choice of approach to agree on first; not for small or clear changes, nor when the user already gave detailed instructions. Needs their consent: you get their answer; on yes the rest of this turn is read-only: research, then reply with the plan.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Optional: one line on why a plan first (shown on the card).",
        },
      },
    },
  },
  // Not read-only: it's offered in Agent mode only (Plan and Ask keep to read-only tools).
  readOnly: false,
  concurrent: false,
  verb: "Asked to plan first",
  target: () => "",
  async run(_args, host, itemId) {
    if (host.services.settings.peek<string>("agent.runCommands") === "full")
      return {
        result:
          "Not asked: the user is away (full access). Carry on in Agent mode; say in your answer that a plan first would have helped, if it would.",
        summary: "not asked",
      };
    if (!host.question) return { result: "Error: asking isn't available here.", isError: true };
    const answer = await host.question(itemId);
    if (answer === null) return { result: "The user didn't answer (stopped).", isError: true };
    if (answer !== PLAN_YES)
      return {
        result:
          answer === PLAN_NO
            ? "The user wants you to keep going in Agent mode: carry on with the task."
            : `The user answered instead: ${answer}`,
        summary: answer === PLAN_NO ? PLAN_NO : "answered",
      };
    await host.services.dispatcher.execute("agent.setChatMode", {
      session: host.session,
      mode: "plan",
    });
    host.followChatMode?.();
    return {
      result:
        "Plan mode is on: the rest of this turn is read-only (file edits and commands are refused). Research what you need, then reply with a concrete plan (files to change and what to do in each, in order, and how to check it). The user presses Build to have it carried out.",
      summary: PLAN_YES,
    };
  },
};

/** Whether the user is at the window now (notify skips a message they'd see anyway). */
function atWindow(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

export function notifyTool(items: () => readonly Item[]): AgentTool {
  return {
    spec: {
      name: "notify",
      description:
        "Send the user a desktop notification (the taskbar flashes and a notification waits in the window; their phone gets it too if they set that up). A notification they didn't need is annoying: err toward not sending one. Not for routine progress, nor at the end of a turn (the IDE tells them when you finish). Send one when there's a real chance they walked away and something is worth coming back for mid-task (a long run finished, you need a decision to go on), or when they asked for it. When the user is at the window it isn't sent, and the result says so.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "One line, under 200 characters: what's worth coming back for.",
          },
        },
        required: ["message"],
      },
    },
    readOnly: true,
    verb: "Notified",
    target: (a) => String(a.message ?? "").slice(0, 80),
    async run(args, host, itemId) {
      const r = parseNotify(args);
      if ("error" in r) return { result: `Error: ${r.error}`, isError: true };
      const sent = latestTurn(before(items(), itemId)).some(
        (it) => it.type === "tool" && it.name === "notify" && it.summary === "sent",
      );
      if (sent)
        return { result: "Not sent: one notification a turn is enough.", summary: "not sent" };
      if (atWindow())
        return {
          result: "Not sent: the user is at the window and sees the chat.",
          summary: "not sent",
        };
      if (host.services.settings.peek<boolean>("agent.notifyWhenAway") === false)
        return {
          result: "Not sent: the user turned off notifications (agent.notifyWhenAway).",
          summary: "not sent",
        };
      void windowIpc.requestAttention().catch(() => {});
      host.services.notifications.show("info", r.message, {
        actions: [
          {
            label: "Show",
            run: () =>
              void host.services.dispatcher
                .execute("agent.openSession", { session: host.session })
                .catch(() => {}),
          },
        ],
      });
      // D360: to the user's phone too, when they set a webhook.
      const phone = await sendToPhone(host.services, r.message, { chat: host.session });
      const also =
        phone === "sent"
          ? " It went to the user's phone too."
          : phone === "none"
            ? ""
            : ` (Their phone webhook failed: ${phone.error})`;
      return { result: `Sent.${also}`, summary: "sent" };
    },
  };
}

/**
 * The turn tools a chat of the IDE's agent gets (chatTools). `items`: its conversation (a call
 * checks what came before it in the turn).
 */
export function turnTools(items: () => readonly Item[]): AgentTool[] {
  return [
    WRAP_UP,
    chapterTool(items),
    proposeTool(items),
    dismissTool(items),
    PLAN_MODE,
    notifyTool(items),
  ];
}
