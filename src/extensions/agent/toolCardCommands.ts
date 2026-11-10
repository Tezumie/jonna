// What the chat's tool cards do (D312–D314), as commands (the cards call them; tests and agents
// may too): Fix / Fix all on a review's findings send the agent a message asking for the fixes
// (a chat in Ask mode, like a /review chat, switches to Agent mode first, as Build does for a
// plan); Install on a suggested extension runs extensions.installFromStore as the user's click
// and marks the card. Also what ide://agent/session shows of them: the questions waiting and the
// latest findings.

import { normalizeAnswers, parseAskUser, skipAll } from "../../core/agent/askUser";
import type { Item } from "../../core/agent/conversation";
import { parseSuggestion } from "../../core/agent/extensionSuggest";
import { type Finding, fixMessage, parseFindings } from "../../core/agent/findings";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { AgentSession } from "./session";
import type { SessionManager } from "./sessions";

type ToolItem = Extract<Item, { type: "tool" }>;

/** Extensions being installed from a suggest_extension card now, by its tool call (lowercase ids). */
const installing = new Map<string, ReadonlySet<string>>();
const NONE: ReadonlySet<string> = new Set();

/** What the card of tool call `item` is installing now (its Install buttons say so). */
export const installingFrom = (item: string): ReadonlySet<string> => installing.get(item) ?? NONE;

const toolItem = (session: AgentSession, id: string, name: string): ToolItem => {
  const it = session.items.find((i) => i.id === id);
  if (it?.type !== "tool" || it.name !== name)
    throw new Error(`No ${name} card ${id} in this chat.`);
  return it;
};

/** agent.answer's `answers` for the open question (`item`'s, or the first): keyed by question. */
export function questionAnswers(
  session: AgentSession,
  raw: unknown,
  item: string | undefined,
): Record<string, string> {
  const open = session.questions.peek();
  const q = item ? open.find((x) => x.itemId === item) : open[0];
  if (!q) throw new Error("The agent isn't waiting for an answer.");
  const card = parseAskUser(toolItem(session, q.itemId, "ask_user").args);
  if ("error" in card) throw new Error(card.error);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error('answers: an object by question, e.g. { "Auth method": "OAuth" }');
  const answers = normalizeAnswers(card, raw as Record<string, unknown>);
  if ("error" in answers) throw new Error(answers.error);
  return answers;
}

/** agent.answer's `skip` (D335): every question of the open card (`item`'s, or the first) skipped. */
export function skippedAnswers(
  session: AgentSession,
  item: string | undefined,
): Record<string, string> {
  const open = session.questions.peek();
  const q = item ? open.find((x) => x.itemId === item) : open[0];
  if (!q) throw new Error("The agent isn't waiting for an answer.");
  const card = parseAskUser(toolItem(session, q.itemId, "ask_user").args);
  if ("error" in card) throw new Error(card.error);
  return skipAll(card);
}

/** The ask_user cards waiting, with their questions (ide://agent/session `questions`). */
export function pendingQuestions(session: AgentSession) {
  return session.questions.peek().flatMap((q) => {
    const it = session.items.find((i) => i.id === q.itemId);
    const card = it?.type === "tool" ? parseAskUser(it.args) : null;
    if (!card || "error" in card) return [];
    return [
      {
        item: q.itemId,
        questions: card.questions.map((x) => ({
          question: x.question,
          ...(x.header && { header: x.header }),
          options: x.options.map((o) => o.label),
          ...(x.multiSelect && { multiSelect: true }),
        })),
      },
    ];
  });
}

/** The latest report_findings card (ide://agent/session `findings`), or null. */
export function latestFindings(
  session: AgentSession,
): { item: string; findings: Finding[] } | null {
  for (let i = session.items.length - 1; i >= 0; i--) {
    const it = session.items[i];
    if (it?.type !== "tool" || it.name !== "report_findings" || it.status !== "done") continue;
    const card = parseFindings(it.args);
    if (!("error" in card)) return { item: it.id, findings: card.findings };
  }
  return null;
}

export function registerToolCardCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): void {
  const register = (c: Parameters<typeof services.dispatcher.register>[0]) =>
    sub.add(services.dispatcher.register(c));
  const sessionInput = s.string().describe("Session id (default: the active session)").optional();

  register({
    id: "agent.fixFindings",
    title: "Fix review findings",
    category: "Agent",
    description:
      "Asks a chat's agent to fix the findings of its report_findings card (D313): `index` (1-based) for one, else all that have no outcome yet. A chat in Ask mode (a review) switches to Agent mode first. The agent re-reports them with their outcomes.",
    input: s.object({
      session: sessionInput,
      item: s.string().describe("The report_findings call (default: the latest)").optional(),
      index: s.integer({ min: 1 }).describe("One finding (1-based); default all").optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ session, item, index }, ctx) => {
      const target = sessions.require(session);
      const found = item
        ? {
            item,
            findings: (() => {
              const card = parseFindings(toolItem(target, item, "report_findings").args);
              return "error" in card ? [] : card.findings;
            })(),
          }
        : latestFindings(target);
      const all = found?.findings ?? [];
      const picked = index !== undefined ? all.slice(index - 1, index) : all;
      if (!picked.length) throw new Error("No findings to fix in this chat.");
      // A review runs in Ask mode, which can't edit: fixing is Agent work (as Build does).
      const before = { mode: target.chatMode.peek(), work: target.workMode.peek() };
      if (target.work() === "ask") target.setWork("agent");
      try {
        await ctx.execute("agent.send", {
          session: target.id,
          message: fixMessage(picked),
          wait: false,
        });
      } catch (err) {
        target.chatMode.value = before.mode;
        target.workMode.value = before.work;
        throw err;
      }
      return { session: target.id, asked: picked.length };
    },
  });

  register({
    id: "agent.installSuggestedExtension",
    title: "Install a suggested extension",
    category: "Agent",
    description:
      "Installs an extension from the agent's suggest_extension card (D314) with extensions.installFromStore, as the user's choice, and marks the card (installed; the agent may suggest again).",
    input: s.object({
      session: sessionInput,
      item: s.string().describe("The suggest_extension call"),
      id: s.string().describe("namespace.name from the card"),
    }),
    effects: ["write", "network"],
    agent: "hidden",
    run: async ({ session, item, id }, ctx) => {
      const target = sessions.require(session);
      const it = toolItem(target, item, "suggest_extension");
      const card = parseSuggestion(it.detail);
      const entry = card?.items.find((x) => x.id.toLowerCase() === id.toLowerCase());
      if (!card || !entry) throw new Error(`${id} isn't on that card.`);
      const key = entry.id.toLowerCase();
      const mark = (on: boolean) => {
        const now = new Set(installingFrom(item));
        if (on) now.add(key);
        else now.delete(key);
        if (now.size) installing.set(item, now);
        else installing.delete(item);
        target.bump();
      };
      mark(true);
      let result: { id?: string | null; version?: string } | null;
      try {
        result = (await ctx.execute("extensions.installFromStore", {
          id: entry.id,
        })) as typeof result;
      } finally {
        mark(false);
      }
      // The user said no to what it asks for: nothing installed, the card stays as it was.
      if (!result?.id) return { installed: null, cancelled: true };
      const version = result.version || "latest";
      it.detail = JSON.stringify({
        ...card,
        engaged: true,
        items: card.items.map((x) => (x === entry ? { ...x, installed: version } : x)),
      });
      target.bump();
      void target.save();
      return { installed: entry.id };
    },
  });
}
