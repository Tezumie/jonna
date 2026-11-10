// Plan mode's plan as a document (D330; core/agent/planDoc.ts has the rules). When a Plan turn
// ends, its answer is saved as `<user config>/plans/<chat id>.md` (next to settings.json, like
// Claude Code's ~/.claude/plans: no file in the project, and it works without a folder), and the
// chat's "Plan ready" notice becomes a card (view/chatFlowCards.ts) with Open to edit, Build and
// Keep planning. Build (agent.build) sends the file as it is now: the user's edits are what gets
// built. In Plan mode, a message after the user edited the file carries its text, so a revised
// plan starts from theirs. Commands: agent.openPlan, agent.keepPlanning; state ide://agent/planDoc.

import {
  buildMessage,
  editedPlanContext,
  latestPlanNotice,
  planAnswerBefore,
  planEdited,
  planFileName,
  planSteps,
  planTitle,
} from "../../core/agent/planDoc";
import { fsIpc } from "../../core/ipc/fs";
import type { DisposableStore } from "../../core/lifecycle/index";
import { dirname, joinPath, samePath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { AgentSession } from "./session";
import type { SessionManager } from "./sessions";

interface PlanDoc {
  path: string;
  /** The file's text as last read or written; undefined while it loads, null when there's none. */
  text: string | null | undefined;
  /** What the agent wrote (the turn's answer) when the IDE saved it. */
  written: string | null;
  /** Bumped when the text changes (the card's signature). */
  version: number;
  /** The edited text already sent with a Plan-mode message (sent once). */
  sentEdit?: string;
  /** The IDE's write in progress: a read waits for it (else it could bring back the old plan). */
  writing?: Promise<void>;
  /** Bumped by each IDE write: a read started before one is stale. */
  writes: number;
}

const docs = new Map<string, PlanDoc>();
let servicesRef: WorkbenchServices | null = null;
let sessionsRef: SessionManager | null = null;

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/** Where a chat's plan file is (null: no user settings folder to keep it in). */
export function planPathFor(services: WorkbenchServices, session: string): string | null {
  const settings = services.settings.filePath("user");
  return settings ? joinPath(joinPath(dirname(settings), "plans"), planFileName(session)) : null;
}

function docFor(session: string): PlanDoc | null {
  const existing = docs.get(session);
  if (existing) return existing;
  const path = servicesRef ? planPathFor(servicesRef, session) : null;
  if (!path) return null;
  const doc: PlanDoc = { path, text: undefined, written: null, version: 0, writes: 0 };
  docs.set(session, doc);
  return doc;
}

function changed(session: string, doc: PlanDoc, text: string | null): void {
  if (doc.text === text) return;
  doc.text = text;
  doc.version++;
  sessionsRef?.find(session)?.bump();
}

async function load(session: string, doc: PlanDoc): Promise<string | null> {
  await doc.writing;
  const writes = doc.writes;
  const text = await fsIpc.read(doc.path).then(decode, () => null);
  if (writes !== doc.writes) return doc.text ?? null;
  changed(session, doc, text);
  return text;
}

/**
 * A Plan turn ended (sessionTurn, where its "Plan ready" notice is added): its answer becomes the
 * chat's plan file.
 */
export async function savePlanDoc(session: AgentSession): Promise<void> {
  const at = latestPlanNotice(session.items);
  const answer = at >= 0 ? planAnswerBefore(session.items, at) : null;
  const doc = docFor(session.id);
  if (!answer || !doc) return;
  doc.writes++;
  doc.written = answer;
  doc.sentEdit = undefined;
  changed(session.id, doc, `${answer}\n`);
  const writing = fsIpc
    .write(doc.path, new TextEncoder().encode(`${answer}\n`), "agent")
    // The card still shows the plan from memory; the file is what Open to edit needs.
    .catch((err: unknown) => console.warn("saving the plan document failed", err));
  doc.writing = writing;
  await writing;
  if (doc.writing === writing) doc.writing = undefined;
}

/** The card's view of a chat's plan: the file's text (loaded on first look), its path, edited. */
export function planDocOf(session: AgentSession): {
  path: string;
  text: string | null | undefined;
  edited: boolean;
  version: number;
} | null {
  const doc = docFor(session.id);
  if (!doc) return null;
  if (doc.text === undefined) {
    // Loaded once, then kept up to date by saves (files.didSave) and the IDE's own writes.
    doc.text = null;
    doc.version++;
    void load(session.id, doc);
  }
  const answer = answerOf(session, doc);
  return {
    path: doc.path,
    text: doc.text,
    edited: !!doc.text && !!answer && planEdited(doc.text, answer),
    version: doc.version,
  };
}

/** What the agent wrote: as saved this run, else the answer before the latest plan notice. */
function answerOf(session: AgentSession, doc: PlanDoc): string | null {
  if (doc.written) return doc.written;
  const at = latestPlanNotice(session.items);
  return at >= 0 ? planAnswerBefore(session.items, at) : null;
}

/** Build's message (agent.build): the plan above, or the file as the user edited it. */
export async function planBuildMessage(session: AgentSession): Promise<string> {
  const doc = docFor(session.id);
  if (!doc) return buildMessage(null, null, false);
  const text = await load(session.id, doc);
  const answer = answerOf(session, doc);
  return buildMessage(doc.path, text, !!text && !!answer && planEdited(text, answer));
}

/** With a message in Plan mode: the plan file's text when the user edited it (once per edit). */
export async function planEditContext(session: AgentSession): Promise<string[]> {
  const mode = session.chatMode.peek();
  if (mode !== "plan" && session.overlay(mode) !== "plan") return [];
  if (latestPlanNotice(session.items) < 0) return [];
  const doc = docFor(session.id);
  if (!doc) return [];
  const text = await load(session.id, doc);
  const answer = answerOf(session, doc);
  if (!text || !answer || !planEdited(text, answer) || doc.sentEdit === text) return [];
  doc.sentEdit = text;
  return [editedPlanContext(doc.path, text)];
}

export function registerPlanDocs(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): void {
  servicesRef = services;
  sessionsRef = sessions;
  sub.add({
    dispose: () => {
      docs.clear();
      servicesRef = null;
      sessionsRef = null;
    },
  });
  // The user saved a plan file: its card shows the new text.
  sub.add(
    services.events.on("files.didSave", ({ path }) => {
      for (const [session, doc] of docs) if (samePath(doc.path, path)) void load(session, doc);
    }),
  );
  const { dispatcher, state } = services;
  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "Agent", ...c }));
  const sessionInput = s.string().describe("Session id (default: the active session)").optional();

  register({
    id: "agent.openPlan",
    title: "Open the plan to edit",
    description:
      "Opens a chat's plan (Plan mode's latest plan, saved as a Markdown file, D330) in an editor tab, where the user can change it before Build.",
    input: s.object({ session: sessionInput }),
    effects: [],
    agent: "hidden",
    run: async ({ session }, ctx) => {
      const target = sessions.require(session);
      const doc = docFor(target.id);
      if (!doc) throw new Error("There's no folder for plans (no user settings folder).");
      let text = await load(target.id, doc);
      if (text === null) {
        // Not saved yet (a plan from before plan files): saved now from the chat.
        await savePlanDoc(target);
        text = doc.text ?? null;
      }
      if (text === null) throw new Error("This chat has no plan yet.");
      await ctx.execute("editor.openFile", { path: doc.path });
      return { path: doc.path };
    },
  });

  register({
    id: "agent.keepPlanning",
    title: "Keep planning",
    description:
      "Keeps a chat in Plan mode after its plan (D330): the chat is shown so the user can say what to change; their edits to the plan file go with that message.",
    input: s.object({ session: sessionInput }),
    effects: [],
    agent: "hidden",
    run: async ({ session }, ctx) => {
      const target = sessions.require(session);
      await ctx.execute("agent.openSession", { session: target.id });
      return { session: target.id, mode: target.chatMode.peek() };
    },
  });

  sub.add(
    state.register("ide://agent/planDoc", {
      description:
        "The active chat's plan document (Plan mode, D330): its file, whether there is one, whether the user edited it since the agent wrote it, its title and step count. Build sends the file as it is.",
      get: () => {
        const target = sessions.find(undefined);
        if (!target) return null;
        const doc = planDocOf(target);
        if (!doc) return null;
        const text = doc.text ?? null;
        return {
          session: target.id,
          path: doc.path,
          exists: text !== null,
          edited: doc.edited,
          ...(text !== null && { title: planTitle(text), steps: planSteps(text) }),
        };
      },
    }),
  );
}
