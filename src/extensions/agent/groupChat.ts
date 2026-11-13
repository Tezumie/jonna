// Group chats and handoffs (D231; the rules are core/agent/groupChat.ts). A group chat is an
// ordinary session with `members`: each turn is answered by one member, in that member's mode (its
// instructions, tools and model, as when chatting with the agent alone), told who else is in the
// room. A message goes to the member it mentions first (the others it mentions answer after);
// a reply that hands over (`@Forge` opening a line) gives the next turn to that member, up to
// `agent.groupChat.maxAutoTurns` agent-to-agent turns per message. Stop ends the round.
// Handoffs (VS Code's `handoffs:`) move any chat to another agent: `agent.handoff`.

import { BUILT_IN_MODES, customModeId, findCustomMode } from "../../core/agent/chatModes";
import type { Item } from "../../core/agent/conversation";
import { agentFace, type FaceSpec, faceFromSeed } from "../../core/agent/faces";
import {
  DEFAULT_MAX_AUTO_TURNS,
  findMentions,
  GROUP_CONTEXT_TAG,
  type GroupMember,
  type Handoff,
  handoffMentions,
  handoffNote,
  MAIN_MEMBER,
  MAX_MEMBERS,
  membersAfterMentions,
  newContext,
  nextInChain,
  normalizeMembers,
  pendingFor,
  roomBrief,
  routeTogether,
  startChain,
} from "../../core/agent/groupChat";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import { type FaceState, agentFace as faceElement, faceGroup } from "../../ui/AgentFace";
import type { IconName } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import type { WorkbenchServices } from "../../workbench/services";
import { customModes } from "./customModes";
import { newId } from "./ids";
import { mainAgent } from "./mainAgent";
import { isRoomContext } from "./roomService";
import type { AgentSession } from "./session";
import type { SessionManager } from "./sessions";
import { sendNow } from "./sessionTurn";
import type { ChatMode } from "./sessionTypes";
import { showThreadTab } from "./threadTabs";

/** The main agent as a member: its id stays MAIN_MEMBER, its name and face are the user's (D234). */
function mainMember(): GroupMember & { face: FaceSpec } {
  const { label, face } = mainAgent.peek();
  return {
    name: MAIN_MEMBER,
    label,
    role: "Agent",
    description: "The IDE's own coding agent: reads and edits the project, runs commands.",
    face,
  };
}

/** Every agent a chat can include: the main agent, then the user's agents. */
export function knownAgents(): (GroupMember & { face: FaceSpec })[] {
  return [
    mainMember(),
    ...customModes
      .peek()
      .filter((m) => m.agent)
      .map((m) => ({
        name: m.name,
        label: m.agent?.label ?? m.name,
        ...(m.agent?.role && { role: m.agent.role }),
        ...(m.description && { description: m.description }),
        face: agentFace(m.agent?.icon, m.name, m.model),
      })),
  ];
}

/**
 * Who an @mention in `session` can name (D275): the known agents plus its members, so a member
 * whose file has no agent details (an older one) is colored as its mention is answered.
 */
export function mentionTargets(session: AgentSession): GroupMember[] {
  const known = knownAgents();
  const names = new Set(known.map((a) => a.name));
  return [...known, ...membersOf(session).filter((m) => !names.has(m.name))];
}

/** An agent by name (or label, case ignored); one that's gone keeps its name and a face from it. */
export function memberInfo(name: string): GroupMember & { face: FaceSpec; known: boolean } {
  const key = name.toLowerCase();
  const agents = knownAgents();
  // An exact name first: another agent's label mustn't take its place (D232).
  const found =
    agents.find((a) => a.name.toLowerCase() === key) ??
    agents.find((a) => a.label.toLowerCase() === key);
  return found
    ? { ...found, known: true }
    : { name, label: name, face: faceFromSeed(name), known: false };
}

/** The group's members as the rules need them. */
export function membersOf(session: AgentSession): GroupMember[] {
  return session.members.peek().map((n) => memberInfo(n));
}

/**
 * The members that can answer: an agent whose file was removed or renamed can't (D232). Its turn
 * would otherwise go in Agent mode, with every tool, whatever it was allowed before.
 */
function answering(session: AgentSession, names = session.members.peek()): GroupMember[] {
  return names.filter((n) => canAnswer(n)).map((n) => memberInfo(n));
}

/** The main agent, or an agent whose own mode is there (by its exact name, not a label). */
function canAnswer(name: string): boolean {
  return (
    name === MAIN_MEMBER || !!findCustomMode(customModes.peek(), customModeId(name) as ChatMode)
  );
}

/**
 * A speaker that's gone gives its turn to the first member still here; `note` is what the chat
 * says about it (null: nothing to say).
 */
function availableSpeaker(
  session: AgentSession,
  speaker: string,
  names: readonly string[],
): { speaker: string; note: string | null } {
  if (canAnswer(speaker)) return { speaker, note: null };
  const fallback = answering(session, names)[0]?.name ?? MAIN_MEMBER;
  return {
    speaker: fallback,
    note: `${speaker} isn't available any more (its agent file was removed or renamed): ${memberInfo(fallback).label} answers instead. Remove it from the chat's members, or bring its file back.`,
  };
}

/** The chat mode a member's turn runs in: the main agent's Agent mode, or the agent's own. */
export function memberMode(name: string): ChatMode {
  if (name === MAIN_MEMBER) return "agent";
  const mode = customModeId(name) as ChatMode;
  // An agent that's gone (its file removed): its turn goes in Agent mode rather than read-only.
  return findCustomMode(customModes.peek(), mode) ? mode : "agent";
}

/** Who speaks in a chat with one agent: the agent its mode is, else the main agent. */
export function soloSpeaker(mode: ChatMode): string {
  const custom = findCustomMode(customModes.peek(), mode);
  return custom?.agent ? custom.name : MAIN_MEMBER;
}

/** The faces of a group's members, stacked (the chat's header, its row, the composer). */
export function groupFaces(names: readonly string[], size: number): HTMLElement {
  return names.length === 1
    ? faceElement(memberInfo(names[0] ?? MAIN_MEMBER).face, { size })
    : faceGroup(
        names.map((n) => memberInfo(n).face),
        size,
      );
}

/**
 * A chat's face (D234): its agents' faces in a group chat, else the agent it's with, in
 * `state` (the chat's tab, so open chats tell apart at a glance).
 */
export function chatFaceElement(
  session: AgentSession,
  size: number,
  state?: FaceState,
): HTMLElement {
  const members = session.members.peek();
  if (members.length) return groupFaces(members, size);
  const info = memberInfo(soloSpeaker(session.chatMode.peek()));
  return faceElement(info.face, { size, ...(state && { state }) });
}

/** A group chat's header: its agents' faces, their names in the tooltip. */
export function showGroupFaces(slot: HTMLElement, names: readonly string[]): void {
  slot.replaceChildren(groupFaces(names, 20));
  setTooltip(slot, `Group chat: ${memberNames(names)}`);
}

/** "Scout, Forge and Agent". */
export function memberNames(names: readonly string[]): string {
  const labels = names.map((n) => memberInfo(n).label);
  return labels.length <= 1
    ? (labels[0] ?? "")
    : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** What a member is told with its turn: the room, and its own instructions. */
/** A context entry's kind for `newContext` (D253): a member's brief, a channel's line, or null. */
export function contextKind(entry: string): string | null {
  if (entry.startsWith(GROUP_CONTEXT_TAG)) return "group";
  if (isRoomContext(entry)) return "room";
  return null;
}

export function memberContext(
  session: AgentSession,
  speaker: string,
  names: readonly string[] = session.members.peek(),
): string {
  const mode = findCustomMode(customModes.peek(), memberMode(speaker));
  return roomBrief(
    names.map((n) => memberInfo(n)),
    speaker,
    { instructions: mode?.instructions ?? null },
  );
}

/** A group chat's turn as worked out: nothing in the chat changes until `commit` (D233). */
export interface GroupTurn {
  speaker: string;
  mode: ChatMode;
  context: string;
  /**
   * Members answering the message at the same time as `speaker` (D245: `@all`, or several
   * mentions with agent.groupChat.answerTogether), read-only, beside the turn.
   */
  together: string[];
  /**
   * Makes the routing real once the turn has started: members the message brought in join (with
   * a line saying so), the round's queue is set and the hand-off taken. A turn that doesn't
   * start (a hook stops the message, no model) never calls it, so it leaves the chat as it was.
   * `answeredTogether`: the caller starts `together`'s answers; otherwise they're queued.
   */
  commit(answeredTogether?: boolean): void;
}

/**
 * A group chat's turn (sendNow calls it): who answers, in which mode, and what that member is
 * told. `text` is the user's message (null: a turn without one — an agent-to-agent turn, Continue,
 * a background report). A message naming agents not in the group brings them in (Grok's way).
 * Pure: the changes wait for `commit`.
 */
export function groupTurn(session: AgentSession, text: string | null): GroupTurn | null {
  const current = session.members.peek();
  // Agents the message names that aren't in the room join it (up to the limit). In a chat with
  // one agent that makes it a group of that agent and the ones named (D233: "@Rev" in a chat
  // with the main agent brings Rev in, and Rev answers).
  const after =
    text === null
      ? null
      : membersAfterMentions(
          current,
          soloSpeaker(session.chatMode.peek()),
          findMentions(text, knownAgents()),
        );
  if (!current.length && !after) return null;
  const names = after?.names ?? current;
  const joined = after?.joined ?? [];
  const becomesGroup = !current.length;
  let speaker: string;
  let queued: string[] = [];
  let together: string[] = [];
  if (text !== null) {
    const members = answering(session, names);
    // A hand-off to one no longer in the chat doesn't count (D244).
    const handed =
      session.nextSpeaker && names.includes(session.nextSpeaker) ? session.nextSpeaker : null;
    const route = routeTogether(
      text,
      members,
      session.lastSpeaker(),
      session.services.settings.peek<boolean>("agent.groupChat.answerTogether") === true,
    );
    speaker = handed ?? route?.speaker ?? members[0]?.name ?? MAIN_MEMBER;
    queued = handed
      ? findMentions(text, members).filter((n) => n !== handed)
      : (route?.queue ?? []);
    together = (route?.together ?? []).filter((n) => n !== speaker);
  } else {
    const last = session.lastSpeaker();
    const handedTo =
      session.nextSpeaker && current.includes(session.nextSpeaker) ? session.nextSpeaker : null;
    // Continue after a handoff that failed, or a report for the member that delegated (D253):
    // that member, not the one that spoke last.
    const pending = pendingFor(session.items);
    const owed = pending && current.includes(pending) ? pending : null;
    speaker =
      handedTo ?? owed ?? (last && current.includes(last) ? last : (current[0] ?? MAIN_MEMBER));
  }
  const available = availableSpeaker(session, speaker, names);
  speaker = available.speaker;
  together = together.filter((n) => n !== speaker);
  const withChain = text !== null;
  let committed = false;
  return {
    speaker,
    mode: memberMode(speaker),
    context: memberContext(session, speaker, names),
    together,
    commit: (answeredTogether = false) => {
      if (committed) return;
      committed = true;
      if (becomesGroup && !session.members.peek().length) {
        session.members.value = names;
        session.addNotice(`${memberNames(joined)} joined the chat.`);
      } else if (joined.length) {
        // Whatever changed the members meanwhile stays; these are added if still missing.
        const now = session.members.peek();
        const add = joined.filter((n) => !now.includes(n)).slice(0, MAX_MEMBERS - now.length);
        if (add.length) {
          session.members.value = [...now, ...add];
          session.addNotice(`${memberNames(add)} joined the chat.`);
        }
      }
      if (withChain)
        session.groupChain = startChain(answeredTogether ? queued : [...queued, ...together]);
      session.nextSpeaker = null;
      if (available.note) session.addNotice(available.note);
    },
  };
}

/**
 * After a group turn ended well: the next member in the round (one the reply handed to, then one
 * the user named), as a turn of its own, or nothing. Past the limit the chat says it paused.
 */
export function continueGroup(
  session: AgentSession,
  speaker: string | null,
  firstItem: number,
): void {
  const chain = session.groupChain;
  if (!chain || !session.members.peek().length || session.deleted) {
    session.groupChain = null;
    return;
  }
  const members = answering(session);
  const reply = session.items
    .slice(firstItem)
    .findLast((it) => it.type === "assistant" && it.text.trim());
  const handed = reply?.type === "assistant" ? handoffMentions(reply.text, members, speaker) : [];
  const setting = session.services.settings.peek<number>("agent.groupChat.maxAutoTurns");
  const max =
    typeof setting === "number" && setting >= 0 ? Math.floor(setting) : DEFAULT_MAX_AUTO_TURNS;
  const step = nextInChain(chain, handed, max);
  if (step.limited)
    session.addNotice(
      max === 0
        ? "Agents don't answer each other on their own here (agent.groupChat.maxAutoTurns is 0): mention one to bring it in."
        : `Paused after ${max} replies between agents: your turn. Mention an agent to go on.`,
    );
  if (!step.next) {
    session.groupChain = null;
    return;
  }
  session.groupChain = step.chain;
  const next = step.next.name;
  const kept = step.chain;
  /** Who was still to answer, for the line that says the round ended. */
  const owed = () =>
    memberNames(
      [next, ...kept.queue.map((e) => e.name)].filter((n, i, all) => all.indexOf(n) === i),
    );
  const started = Date.now();
  // After the turn has let go of the session (its save, held messages, reports). Still busy
  // (a report's turn, a summary): it waits for it, up to ROUND_WAIT_MS (D253: it used to end
  // there without a word, and the members queued never answered).
  const attempt = () => {
    if (session.groupChain !== kept || session.deleted) return;
    if (session.busyNow()) {
      if (Date.now() - started < ROUND_WAIT_MS) setTimeout(attempt, 500);
      else {
        session.groupChain = null;
        session.addNotice(
          `The round of replies stopped (the chat stayed busy): ${owed()} didn't answer. Mention them to go on.`,
        );
      }
      return;
    }
    // Taken out of the chat (or turned off) while the round went on: it ends here (D244).
    if (!session.members.peek().includes(next) || !canAnswer(next)) {
      session.groupChain = null;
      session.addNotice(
        `${memberInfo(next).label} isn't in the chat any more: the round ends here.`,
      );
      return;
    }
    const from = speaker ? memberInfo(speaker).label : null;
    let note: Item | null = null;
    void session
      .exclusive(async () => {
        if (session.groupChain !== kept) return;
        note = {
          type: "user",
          id: newId("u"),
          text: handoffNote(memberInfo(next).label, step.next?.fromUser ? null : from),
          auto: "group",
          // Continue after a failure goes to this member too (D253).
          to: next,
          // Not again when this member's brief is already the latest one (D253).
          context: newContext(session.items, [memberContext(session, next)], contextKind),
        };
        session.items.push(note);
        session.nextSpeaker = next;
        await sendNow(session, "", [], { resume: true });
      })
      .catch(() => {
        // It couldn't start (a message or a report got there first): the round ends here,
        // and says who didn't answer, unless a new message started a round of its own.
        if (note && session.items[session.items.length - 1] === note) {
          session.items.pop();
          session.bump();
        }
        if (session.groupChain === kept) {
          session.groupChain = null;
          session.addNotice(
            `The round of replies stopped: ${owed()} didn't answer. Mention them to go on.`,
          );
        }
        session.nextSpeaker = null;
      });
  };
  setTimeout(attempt, 0);
}

/** How long a round's next member waits for a busy chat before the round ends (D253). */
const ROUND_WAIT_MS = 60_000;

type Header = (GroupMember & { face: FaceSpec }) | null;

/** Headers per reply, worked out once per change of the chat (one pass, not one per reply). */
const headerCache = new WeakMap<
  AgentSession,
  {
    version: number;
    modes: unknown;
    main: unknown;
    members: unknown;
    turn: string | null;
    headers: Map<string, Header>;
  }
>();

/**
 * Who wrote a reply, when the chat should say so above it: in a group chat, the first reply after
 * your message and each change of speaker; in a chat with one agent, only where a handoff changed
 * the speaker. Null: no header.
 */
export function speakerHeader(
  session: AgentSession,
  item: Extract<Item, { type: "assistant" }>,
): Header {
  const version = session.version.peek();
  const modes = customModes.peek();
  const main = mainAgent.peek();
  const members = session.members.peek();
  // The running turn's replies get their speaker when it ends: until then, its speaker's.
  const turn = session.turnSpeaker;
  let cached = headerCache.get(session);
  if (
    !cached ||
    cached.version !== version ||
    cached.modes !== modes ||
    cached.main !== main ||
    cached.members !== members ||
    cached.turn !== turn
  ) {
    const headers = new Map<string, Header>();
    const group = members.length > 0;
    // The last thing said before each reply: your message, or a reply (by whom).
    let last: { user: true } | { user: false; speaker: string } | null = null;
    // Who wrote the last reply, across your messages: a solo chat shows the speaker when it
    // changes (a handoff), not on every reply.
    let lastReply: string | null = null;
    const lastUser = turn ? session.items.findLastIndex((it) => it.type === "user") : -1;
    // Two agents answered in a solo chat (one switched in): the first reply is named too, so the
    // earlier agent's replies aren't left nameless beside the later one's (D410).
    const speakers = new Set<string>();
    session.items.forEach((it, i) => {
      if (it.type === "assistant" && it.text.trim())
        speakers.add(it.speaker ?? (turn && i > lastUser ? turn : MAIN_MEMBER));
    });
    const several = speakers.size > 1;
    session.items.forEach((it, i) => {
      if (it.type === "user" && !it.auto) last = { user: true };
      if (it.type !== "assistant") return;
      const speaker =
        it.speaker ?? (turn && i > lastUser ? turn : several ? MAIN_MEMBER : undefined);
      if (speaker) {
        const prev = last as { user: true } | { user: false; speaker: string } | null;
        const show =
          prev && !prev.user
            ? prev.speaker !== speaker
            : group || (lastReply !== null ? lastReply !== speaker : several);
        headers.set(it.id, show ? memberInfo(speaker) : null);
      }
      if (it.text.trim()) {
        last = { user: false, speaker: speaker ?? MAIN_MEMBER };
        lastReply = speaker ?? MAIN_MEMBER;
      }
    });
    cached = { version, modes, main, members, turn, headers };
    headerCache.set(session, cached);
  }
  return cached.headers.get(item.id) ?? null;
}

/** The handoffs an agent's reply offers (its file's `handoffs:`). */
export function handoffsOf(speaker: string | undefined): readonly Handoff[] {
  if (!speaker || speaker === MAIN_MEMBER) return [];
  const handoffs = customModes.peek().find((m) => m.name === speaker)?.handoffs ?? [];
  // A button for an agent that isn't there (removed, renamed, a VS Code built-in) would only fail.
  return handoffs.filter((h) => memberInfo(h.agent).known || BUILT_IN_MODES.has(h.agent));
}

/**
 * Picks several agents (the quick input picks one at a time): each pick toggles an agent, the
 * first row finishes. Null when cancelled.
 */
export async function pickMembers(
  services: WorkbenchServices,
  initial: readonly string[],
  finish: string,
): Promise<string[] | null> {
  let picked = [...initial];
  for (;;) {
    const agents = knownAgents();
    const enough = picked.length >= 2;
    const choice = await services.quickInput.pick(
      [
        {
          id: "__done",
          label: finish,
          description: enough
            ? memberNames(picked)
            : `pick at least 2 agents (${picked.length} picked)`,
          icon: "users" as IconName,
          disabled: !enough,
        },
        ...agents.map((a) => {
          const on = picked.includes(a.name);
          return {
            id: a.name,
            label: a.label,
            description: [a.role, on ? "in the chat" : ""].filter(Boolean).join(" · "),
            ...(a.description && { detail: a.description }),
            icon: (on ? "check" : "square") as IconName,
            disabled: !on && picked.length >= MAX_MEMBERS,
          };
        }),
      ],
      { placeholder: `Agents in the group chat (up to ${MAX_MEMBERS}): pick to add or remove` },
    );
    if (!choice) return null;
    if (choice.id === "__done") return picked;
    picked = picked.includes(choice.id)
      ? picked.filter((n) => n !== choice.id)
      : [...picked, choice.id];
  }
}

export function registerGroupChat(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): void {
  const { dispatcher, dock } = services;
  const known = (n: string) => knownAgents().some((a) => a.name === n);
  const resolve = (name: string) => {
    const info = memberInfo(name);
    return info.known ? info.name : null;
  };
  const sessionInput = s.string().describe("Session id (default: the active session)").optional();

  sub.add(
    dispatcher.register({
      id: "agent.newGroupChat",
      title: "New group chat…",
      category: "Agent",
      description:
        "Starts a group chat (D231): 2–6 agents and the user in one chat. `members` are agent names from ide://agent/chatModes (without `custom:`), `agent` for the main agent. A message goes to the agent it @mentions first (the others it mentions answer after), else to the one that spoke last; an agent's reply that starts a line with @Name hands the next turn to that agent (agent.groupChat.maxAutoTurns per message). Without `members` (or with fewer than 2), asks which, starting from those given. Returns the session id.",
      input: s.object({
        members: s.array(s.string()).describe("Agent names; `agent` is the main agent").optional(),
        title: s.string().optional(),
      }),
      effects: [],
      agent: "hidden",
      run: async ({ members, title }, ctx) => {
        let names = normalizeMembers(
          (members ?? []).map((n) => resolve(n) ?? n),
          known,
        );
        // Only a person can answer the picker.
        if (names.length < 2 && ctx.caller.kind !== "user")
          throw new Error(
            `A group chat needs at least 2 agents: ${(members ?? []).filter((n) => !resolve(n)).join(", ") || "name them"} (ide://agent/chatModes lists them; \`agent\` is the main agent).`,
          );
        if (names.length < 2) {
          const picked = await pickMembers(services, names, "Start the group chat");
          if (!picked) return null;
          names = normalizeMembers(picked, known);
        }
        if (names.length < 2) throw new Error("A group chat needs at least 2 agents.");
        const session = sessions.get();
        session.members.value = names;
        session.chatMode.value = "agent";
        session.title.value = title?.trim() || memberNames(names);
        showThreadTab(dock, session.id);
        sessions.active.value = session.id;
        sessions.changed();
        return { session: session.id, members: names };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.setGroupMembers",
      title: "Agents in this chat…",
      category: "Agent",
      description:
        "Sets a group chat's agents (D231; 2–6 names, `agent` for the main agent), or turns a chat into a group chat. An empty list makes it an ordinary chat again (with the agent that spoke last). Without `members`, asks.",
      input: s.object({
        session: sessionInput,
        members: s.array(s.string()).optional(),
      }),
      effects: [],
      agent: "hidden",
      run: async ({ session, members }, ctx) => {
        const target = session
          ? sessions.get(session)
          : (sessions.find(undefined) ?? sessions.get());
        const current = target.members.peek();
        const start = current.length ? current : [soloSpeaker(target.chatMode.peek())];
        if (!members && ctx.caller.kind !== "user")
          throw new Error("Name the agents (`members`): only a person can answer the picker.");
        const wanted =
          members ??
          (await pickMembers(services, start, current.length ? "Done" : "Make it a group chat"));
        if (!wanted) return null;
        const names = normalizeMembers(
          wanted.map((n) => resolve(n) ?? n),
          known,
        );
        if (names.length === 1 || (names.length === 0 && wanted.length > 0))
          throw new Error("A group chat needs at least 2 agents (an empty list ends the group).");
        if (!names.length && current.length) {
          // Back to one agent: the one that spoke last carries on.
          const last = target.lastSpeaker();
          target.chatMode.value = memberMode(
            last && current.includes(last) ? last : (current[0] ?? MAIN_MEMBER),
          );
        }
        const joined = names.filter((n) => !current.includes(n));
        const left = current.filter((n) => !names.includes(n));
        target.members.value = names;
        target.groupChain = null;
        if (joined.length) target.addNotice(`${memberNames(joined)} joined the chat.`);
        if (left.length) target.addNotice(`${memberNames(left)} left the chat.`);
        void target.save();
        sessions.changed();
        return { session: target.id, members: names };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.inviteAgent",
      title: "Invite an agent to this chat…",
      category: "Agent",
      description:
        'Brings one of the user\'s agents into this chat as a group member (D233), when the user asks to talk with it, to bring it in, or wants its view. The chat becomes a group chat (the agent already in it stays) and the invited agent answers in the conversation itself — unlike the delegate tool, which has an agent do a task on its own and report back. `agent`: its name or label ("Rev" or "rev"; ide://agent/chatModes lists them, `agent` is the main agent). With `answerNext` (default true) it answers right after the current reply. An agent calling it changes its own chat; otherwise `session` (default the active chat).',
      input: s.object({
        agent: s.string().describe("The agent's name or label"),
        session: sessionInput,
        answerNext: s
          .boolean()
          .describe("It answers after the current reply (default true)")
          .optional(),
      }),
      effects: [],
      agent: "discoverable",
      run: async ({ agent, session, answerNext }, ctx) => {
        // Who's in a chat is the user's and its agents' business: not an extension's or an MCP
        // client's (D233 audit).
        if (ctx.caller.kind === "ext" || ctx.caller.kind === "mcp")
          throw new Error("Only you or the chat's agent can bring an agent into a chat.");
        const own =
          ctx.caller.kind === "agent" || ctx.caller.kind === "acp" ? ctx.caller.session : session;
        const target = own ? sessions.get(own) : (sessions.find(undefined) ?? sessions.get());
        const name = resolve(agent);
        if (!name)
          throw new Error(
            `No agent named ${agent}. The user's agents: ${
              knownAgents()
                .filter((a) => a.name !== MAIN_MEMBER)
                .map((a) => (a.label === a.name ? a.name : `${a.label} (${a.name})`))
                .join(", ") || "none yet"
            }.`,
          );
        if (!canAnswer(name))
          throw new Error(
            `${memberInfo(name).label} can't answer in a chat (its agent file is gone).`,
          );
        // Called during a turn (the agent inviting it): the invited agent answers once this
        // reply is done. An agent's invitation counts against maxAutoTurns and says who handed
        // over, as an @mention in its reply would; the user's own counts as theirs.
        const queueNext = (): boolean => {
          // An agent already in the chat answers next too (D288: handed back), never the one
          // answering now.
          if (answerNext === false || !target.inTurn || name === target.turnSpeaker) return false;
          const chain = target.groupChain;
          target.groupChain = {
            queue: [...(chain?.queue ?? []), { name, fromUser: ctx.caller.kind === "user" }],
            autoTurns: chain?.autoTurns ?? 0,
          };
          return true;
        };
        const current = target.members.peek();
        const after = membersAfterMentions(current, soloSpeaker(target.chatMode.peek()), [name]);
        if (!after) {
          const inRoom = (current.length ? current : [soloSpeaker(target.chatMode.peek())]).some(
            (n) => n.toLowerCase() === name.toLowerCase(),
          );
          if (!inRoom) throw new Error(`The chat is full (${MAX_MEMBERS} agents at most).`);
          return { session: target.id, members: current, joined: [], answersNext: queueNext() };
        }
        target.members.value = after.names;
        target.addNotice(`${memberNames(after.joined)} joined the chat.`);
        const next = queueNext();
        void target.save();
        sessions.changed();
        return {
          session: target.id,
          members: after.names,
          joined: after.joined,
          answersNext: next,
        };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.handoff",
      title: "Hand the chat to another agent…",
      category: "Agent",
      description:
        "Moves a chat to another agent (D231, VS Code's handoffs): `to` is an agent name (ide://agent/chatModes without `custom:`), `agent` for the main agent, or `plan` / `ask`. The chat continues in that agent's mode; `prompt` goes in the message box, or is sent at once with `send`. In a group chat the agent answers next (and joins the group if it isn't in it). Without `to`, asks which.",
      input: s.object({
        session: sessionInput,
        to: s.string().describe("Agent name, `agent`, `plan` or `ask`").optional(),
        prompt: s.string().optional(),
        send: s.boolean().optional(),
      }),
      effects: [],
      agent: "hidden",
      run: async ({ session, to, prompt, send }, ctx) => {
        const target = session
          ? sessions.get(session)
          : (sessions.find(undefined) ?? sessions.get());
        // A chat opened a moment ago (a fork, D422) may still be loading: switching it before its
        // conversation is there would save it empty.
        await target.hydrating;
        // A turn that has finished but is still saving: wait for it, as a message sent then does
        // (D273: a handoff the moment the answer appeared was refused).
        await target.settle();
        if (target.busyNow())
          throw new Error("The agent is still working; wait for it or stop it first.");
        const group = target.members.peek();
        const current = group.length ? target.lastSpeaker() : soloSpeaker(target.chatMode.peek());
        let name = to?.trim();
        if (!name) {
          if (ctx.caller.kind !== "user")
            throw new Error("Name the agent to hand the chat to (`to`).");
          const picked = await services.quickInput.pick(
            knownAgents()
              .filter((a) => a.name !== current)
              .map((a) => ({
                id: a.name,
                label: a.label,
                description: [a.role, group.includes(a.name) ? "in the chat" : ""]
                  .filter(Boolean)
                  .join(" · "),
                ...(a.description && { detail: a.description }),
              })),
            { placeholder: "Hand the chat to which agent?" },
          );
          if (!picked) return null;
          name = picked.id;
        }
        const builtIn = name === "plan" || name === "ask";
        const resolved = builtIn ? name : resolve(name);
        if (!resolved)
          throw new Error(`No agent named ${name} (ide://agent/chatModes lists them).`);
        const text = prompt?.trim() ?? "";
        if (group.length) {
          if (builtIn) throw new Error("In a group chat, hand over to one of its agents.");
          if (!group.includes(resolved)) {
            if (group.length >= MAX_MEMBERS)
              throw new Error(`A group chat has at most ${MAX_MEMBERS} agents.`);
            target.members.value = [...group, resolved];
            target.addNotice(`${memberInfo(resolved).label} joined the chat.`);
          }
          const label = memberInfo(resolved).label;
          if (send) {
            target.nextSpeaker = resolved;
            await ctx.execute("agent.send", {
              session: target.id,
              message: text || `Over to you, @${label}.`,
              wait: false,
            });
            return { session: target.id, to: resolved, sent: true };
          }
          target.draft.value = `@${label} ${text}`.trimEnd();
          return { session: target.id, to: resolved, sent: false };
        }
        const mode: ChatMode = builtIn ? (resolved as ChatMode) : memberMode(resolved);
        if (target.chatMode.peek() !== mode) {
          target.chatMode.value = mode;
          target.addNotice(
            builtIn
              ? `Switched to ${resolved === "plan" ? "Plan" : "Ask"} mode.`
              : `Handed to ${memberInfo(resolved).label}.`,
          );
          void target.save();
        }
        if (send && text) {
          await ctx.execute("agent.send", { session: target.id, message: text, wait: false });
          return { session: target.id, to: resolved, mode, sent: true };
        }
        if (text) target.draft.value = text;
        return { session: target.id, to: resolved, mode, sent: false };
      },
    }),
  );
}
