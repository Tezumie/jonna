// Channels and direct messages (D237, D238), as in Slack: each is a conversation you talk in.
// A channel's conversation is `Room.session`; a direct message's is kept here per agent. Both are
// ordinary chats with `room` set: a channel's has its agents as a group (@Name picks who answers),
// a direct message is a chat with its agent (@mentioning another brings them in). "Reply in
// thread" on a message starts a thread: a chat with `parent`, shown on the right.
// Also here: channel memory, task channels, and the commands agents use (posting to a channel,
// reading a thread, keeping a channel note), and ide://agent/channels.

import { BUILT_IN_AGENT_NAMES, FIRST_TEAM } from "../../core/agent/builtInAgents";
import { customModeId } from "../../core/agent/chatModes";
import { transcript } from "../../core/agent/compact";
import { MAIN_MEMBER } from "../../core/agent/groupChat";
import {
  DM_PREFIX,
  defaultRooms,
  dmAgent,
  dmRoomId,
  memoryNote,
  newRoomId,
  ROOM_BRIEF_PREFIX,
  type Room,
  roomActivity,
  roomBriefLine,
  roomMembers,
  roomName,
  roomNameProblem,
  type ThreadParent,
  taskRoomName,
  threadRoom,
  threadStatus,
  withNewTeam,
  withNote,
} from "../../core/agent/rooms";
import type { Caller } from "../../core/dispatcher/types";
import type { DisposableStore } from "../../core/lifecycle/index";
import { effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { confirmAction } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import { deleteChat } from "./commands";
import { customModes } from "./customModes";
import { knownAgents, memberInfo, pickMembers } from "./groupChat";
import type { AgentSession } from "./session";
import type { SessionManager } from "./sessions";
import type { ChatMode } from "./sessionTypes";
import { threads } from "./threadList";
import { ROOM_VIEW, setRoomConversation, showRoomTab, showThreadTab } from "./threadTabs";

/** This folder's channels (archived ones included, hidden in lists). */
export const rooms = signal<readonly Room[]>(defaultRooms(BUILT_IN_AGENT_NAMES));
/** Each agent's direct-message conversation (agent name → session id). */
export const dmSessions = signal<ReadonlyMap<string, string>>(new Map());

export const INBOX = "inbox";

/** A channel by id, name or "#name"; a direct message by `dm:<agent>`, agent name or label. */
export function resolveRoom(ref: string): string | null {
  const raw = ref.trim();
  if (!raw) return null;
  if (raw === INBOX) return INBOX;
  // A direct message by its agent's id (case and label normalized: one conversation per agent).
  if (raw.startsWith(DM_PREFIX)) {
    const info = memberInfo(raw.slice(DM_PREFIX.length));
    return info.known ? dmRoomId(info.name) : null;
  }
  const name = roomName(raw);
  const channel = () =>
    rooms.peek().find((r) => !r.archived && (r.id === raw || r.name === name))?.id ?? null;
  // "#name" is a channel; a bare name is an agent's direct messages first (D244: a channel named
  // like an agent mustn't take its messages).
  if (raw.startsWith("#")) return channel();
  const agent = knownAgents().find(
    (a) =>
      a.name.toLowerCase() === raw.toLowerCase() || a.label.toLowerCase() === raw.toLowerCase(),
  );
  return agent ? dmRoomId(agent.name) : channel();
}

export function roomById(id: string | null | undefined): Room | undefined {
  return id ? rooms.peek().find((r) => r.id === id) : undefined;
}

/** "#general", the agent's name for a direct message, "Inbox". */
export function roomTitle(id: string): string {
  if (id === INBOX) return "Inbox";
  const agent = dmAgent(id);
  if (agent) return memberInfo(agent).label;
  const room = roomById(id);
  return room ? `#${room.name}` : `#${id}`;
}

/** The room whose conversation `session` is (not a thread: that's in `session.parent`). */
export function conversationRoom(sessionId: string): string | null {
  const room = rooms.peek().find((r) => r.session === sessionId);
  if (room) return room.id;
  for (const [agent, id] of dmSessions.peek()) if (id === sessionId) return dmRoomId(agent);
  return null;
}

/** What a conversation in a channel or a thread is told with each message. */
export function roomContext(session: AgentSession): string | null {
  return roomBriefLine(roomById(session.room) ?? null, session.parent);
}

export function isRoomContext(text: string): boolean {
  return text.startsWith(ROOM_BRIEF_PREFIX);
}

/** The agent a chat is with: `custom:<name>`, or `agent` for the main one in any mode (D249). */
function chatAgentOf(session: AgentSession): string {
  const mode = session.chatMode.peek();
  return mode.startsWith("custom:") ? mode : "agent";
}

/** Makes `session` a conversation of `roomId`: its agents (a channel's as a group). */
export function joinRoom(session: AgentSession, roomId: string): void {
  session.room = roomId;
  const agent = dmAgent(roomId);
  if (agent) {
    session.members.value = [];
    // In the mode it starts in (D249), only when it changes: a mode picked since stays.
    const mode = (agent === MAIN_MEMBER ? "agent" : customModeId(agent)) as ChatMode;
    if (chatAgentOf(session) !== mode) session.setAgent(mode);
    return;
  }
  const room = roomById(roomId);
  const known = (n: string) => memberInfo(n).known;
  const members = room ? room.members.filter(known) : [];
  if (members.length > 1) {
    session.members.value = members;
    session.chatMode.value = "agent";
  } else {
    session.members.value = [];
    const only = members[0] ?? MAIN_MEMBER;
    const mode = (only === MAIN_MEMBER ? "agent" : customModeId(only)) as ChatMode;
    if (chatAgentOf(session) !== mode) session.setAgent(mode);
  }
}

/** At most this many task channels open at once when an agent asks for another (D244). */
const MAX_OPEN_TASKS = 8;

/**
 * A message an agent posts (to a channel, a thread, a task): marked as the agent's, never taken
 * for the user's own (D244), and never a slash command run in the user's name.
 */
function postedText(message: string, caller: Caller): string {
  if (caller.kind === "user") return message;
  const text = message.trim().replace(/^\/+/, "");
  return `(Posted by an agent, not the user.)\n${text}`;
}

let roomSessionImpl: (roomId: string) => string = () => "";

/** The conversation of a channel or a direct message: its session id, made the first time. */
export function roomSession(roomId: string): string {
  return roomSessionImpl(roomId);
}

export function registerRooms(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): void {
  const { dispatcher, persistence, workspace, dock, state } = services;
  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "Agent", ...c }));
  const known = (n: string) => memberInfo(n).known;
  // D291: a channel's or direct message's conversation opens in the chat panel, as a chat.
  setRoomConversation((room) => (room === INBOX ? null : roomSession(room)));
  const save = (next: readonly Room[]) => {
    rooms.value = next;
    persistence.scheduleSave();
  };
  const update = (id: string, change: (r: Room) => Room) =>
    save(rooms.peek().map((r) => (r.id === id ? change(r) : r)));

  /** A new conversation for a room: an empty chat with its agents. */
  const newConversation = (roomId: string): AgentSession => {
    const session = sessions.get();
    joinRoom(session, roomId);
    session.title.value = roomTitle(roomId);
    session.keepsTitle = true;
    const agent = dmAgent(roomId);
    if (agent) dmSessions.value = new Map(dmSessions.peek()).set(agent, session.id);
    else update(roomId, (r) => ({ ...r, session: session.id }));
    persistence.scheduleSave();
    return session;
  };
  roomSessionImpl = (roomId) => {
    const agent = dmAgent(roomId);
    const id = agent ? dmSessions.peek().get(agent) : roomById(roomId)?.session;
    if (!id) return newConversation(roomId).id;
    // An empty conversation isn't saved: after a restart it comes back with no room or agents
    // (D244). Once loaded, one that doesn't say its room is given it again.
    const session = sessions.get(id);
    session.keepsTitle = true;
    void session.loaded().then(() => {
      if (session.room !== roomId) joinRoom(session, roomId);
      // One renamed by its first message before D415 gets the room's name back.
      session.title.value = roomTitle(roomId);
    });
    return id;
  };
  sub.add({ dispose: () => (roomSessionImpl = () => "") });

  // A channel's conversation made before its agents' files were read (the first run, D245) got
  // no members: once they're known, it gets the channel's agents. Only while it's idle and has
  // none, so the user's own changes to who's in it stay.
  sub.add(
    effect(() => {
      customModes.value;
      rooms.value;
      queueMicrotask(() => {
        for (const room of rooms.peek()) {
          const convo = room.session ? sessions.find(room.session) : undefined;
          if (!convo || convo.members.peek().length || convo.busyNow()) continue;
          if (room.members.filter((n) => memberInfo(n).known).length > 1) joinRoom(convo, room.id);
        }
      });
      return undefined;
    }),
  );

  // Another folder: its own channels. A folder without saved ones starts with #general.
  sub.add(
    effect(() => {
      workspace.root.value;
      rooms.value = defaultRooms(BUILT_IN_AGENT_NAMES);
      dmSessions.value = new Map();
      return undefined;
    }),
  );
  sub.add(
    persistence.register("agent.channels", {
      // Before the dock: its restored channel tabs open these channels' conversations (D244).
      early: true,
      save: () => ({ rooms: rooms.peek(), dms: Object.fromEntries(dmSessions.peek()) }),
      restore: (data) => {
        // D237 saved the list itself; D238 saves { rooms, dms }.
        const o = (Array.isArray(data) ? { rooms: data } : data) as {
          rooms?: unknown;
          dms?: unknown;
        } | null;
        if (!o || typeof o !== "object") return;
        const list = (Array.isArray(o.rooms) ? o.rooms : []).flatMap((r): Room[] => {
          const x = r as Partial<Room>;
          if (typeof x.id !== "string" || typeof x.name !== "string") return [];
          return [
            {
              id: x.id,
              name: x.name,
              members: Array.isArray(x.members)
                ? x.members.filter((m): m is string => typeof m === "string")
                : [MAIN_MEMBER],
              purpose: typeof x.purpose === "string" ? x.purpose : "",
              created: typeof x.created === "number" ? x.created : Date.now(),
              ...(x.archived === true && { archived: true }),
              ...(typeof x.session === "string" && { session: x.session }),
              ...(Array.isArray(x.memory) && {
                memory: x.memory.filter((n): n is string => typeof n === "string"),
              }),
              ...(x.task &&
                (x.task.status === "open" || x.task.status === "done") && {
                  task: {
                    status: x.task.status,
                    ...(typeof x.task.summary === "string" && { summary: x.task.summary }),
                  },
                }),
            },
          ];
        });
        // A #general the first team left as it was gets the planner and Chat (D245).
        if (list.length) rooms.value = withNewTeam(list, FIRST_TEAM, BUILT_IN_AGENT_NAMES);
        if (o.dms && typeof o.dms === "object")
          dmSessions.value = new Map(
            Object.entries(o.dms as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === "string",
            ),
          );
      },
    }),
  );

  const require = (ref: string) => {
    const id = resolveRoom(ref);
    if (!id || id === INBOX)
      throw new Error(
        `No channel or agent named ${ref} (ide://agent/channels lists them; "#name" for a channel, an agent's name for its direct messages).`,
      );
    return id;
  };
  const requireChannel = (ref: string) => {
    const room = roomById(require(ref));
    if (!room) throw new Error(`${ref} is a direct message, not a channel.`);
    return room;
  };

  register({
    id: "agent.openChannel",
    title: "Open channel…",
    description:
      'Shows a channel ("#general"), an agent\'s direct messages (its name, or "dm:<agent>"), or "inbox" (every conversation that needs you or is working) in the channel tab (D237): its conversation, which you and its agents talk in. `newTab` keeps the current one open. Without `channel`, asks which.',
    input: s.object({
      channel: s.string().optional(),
      newTab: s.boolean().optional(),
      side: s.boolean().describe("Open it to the side (a new group)").optional(),
    }),
    effects: [],
    run: async ({ channel, newTab, side }) => {
      let id = channel ? (channel === INBOX ? INBOX : require(channel)) : null;
      if (!id) {
        const picked = await services.quickInput.pick(
          [
            { id: INBOX, label: "Inbox", description: "What needs you, what's working" },
            ...rooms
              .peek()
              .filter((r) => !r.archived)
              .map((r) => ({ id: r.id, label: `#${r.name}`, description: r.purpose })),
            ...knownAgents().map((a) => ({
              id: dmRoomId(a.name),
              label: a.label,
              description: a.role ?? "",
            })),
          ],
          { placeholder: "Open a channel or a direct message" },
        );
        if (!picked) return null;
        id = picked.id;
      }
      showRoomTab(dock, id, { ...(newTab && { newTab }), ...(side && { side }) });
      if (id !== INBOX) sessions.active.value = roomSession(id);
      return { channel: id, ...(id !== INBOX && { session: roomSession(id) }) };
    },
  });
  register({
    id: "agent.showInbox",
    title: "Show inbox",
    description:
      "Shows the Inbox (D237): every conversation in this folder that needs you, is working, or finished lately, as a list or a board.",
    input: s.empty(),
    effects: [],
    run: () => {
      showRoomTab(dock, INBOX);
      return { channel: INBOX };
    },
  });
  register({
    id: "agent.newConversation",
    title: "New conversation",
    description:
      "Starts a channel's or a direct message's conversation over (D238): the old one stays in Sessions… and the Inbox. Default: the main agent's direct messages.",
    input: s.object({ channel: s.string().optional() }),
    effects: [],
    agent: "hidden",
    run: ({ channel }) => {
      const id = channel ? require(channel) : dmRoomId(MAIN_MEMBER);
      const session = newConversation(id);
      // A tab showing the room shows the old conversation: it's opened again on the new one.
      const tabs = dock
        .tabs(ROOM_VIEW)
        .filter((t) => (t.viewState as { room?: string } | null)?.room === id);
      for (const tab of tabs)
        dock.replaceTab(tab.id, ROOM_VIEW, { room: id }, true, { preview: !!tab.preview });
      if (!tabs.length) showRoomTab(dock, id);
      sessions.active.value = session.id;
      return { session: session.id, channel: id };
    },
  });
  register({
    id: "agent.postToChannel",
    title: "Post to a channel…",
    description:
      "Sends `message` in a channel (\"#general\") or an agent's direct messages (its name) (D238): the channel's agents answer there (@Name in the message picks who). With `wait: true`, returns once they're done, with the answer. Agents use it to hand work to a channel the user can see.",
    input: s.object({
      channel: s.string(),
      message: s.string(),
      wait: s.boolean().optional(),
      open: s.boolean().optional(),
    }),
    // A post starts work the user sees: an agent's asks first, as any write does (D244).
    effects: ["write"],
    run: async ({ channel, message, wait, open }, ctx) => {
      if (!message.trim()) throw new Error("Type a message to post.");
      const id = require(channel);
      const session = roomSession(id);
      if (open === true) showRoomTab(dock, id);
      const result = await dispatcher.execute("agent.send", {
        message: postedText(message, ctx.caller),
        session,
        wait: wait === true,
      });
      sessions.changed();
      return { session, channel: id, ...(wait === true && { result }) };
    },
  });
  register({
    id: "agent.replyInThread",
    title: "Reply in thread",
    description:
      "Starts a thread on a message (D238, Slack's Reply in thread): a side conversation on the right, with the same agents, told the message it answers. The message shows its replies. With `message`, sends it at once.",
    input: s.object({
      session: s.string(),
      item: s.string(),
      message: s.string().optional(),
      newTab: s.boolean().optional(),
    }),
    effects: ["write"],
    run: async ({ session: from, item, message, newTab }, ctx) => {
      const source = sessions.get(from);
      await source.loaded();
      const it = source.items.find((i) => i.id === item);
      if (!it || (it.type !== "user" && it.type !== "assistant"))
        throw new Error("Reply in thread works on a message (yours or an agent's).");
      if (source.parent) throw new Error("This is already a thread: reply in it.");
      // An existing thread on that message is opened rather than a second one started.
      // An open thread not saved yet counts too (it isn't in the lists): never a second one.
      const existing =
        sessions.all().find((t) => t.parent?.session === source.id && t.parent.item === item) ??
        threads.peek().find((t) => t.parent?.session === source.id && t.parent.item === item);
      if (existing) {
        showThreadTab(dock, existing.id, { ...(newTab && { newTab }) });
        sessions.active.value = existing.id;
        if (message?.trim())
          await dispatcher.execute("agent.send", {
            message: postedText(message, ctx.caller),
            session: existing.id,
            wait: false,
          });
        return { session: existing.id };
      }
      const author =
        it.type === "user"
          ? "You"
          : memberInfo(it.speaker ?? source.turnSpeaker ?? MAIN_MEMBER).label;
      const parent: ThreadParent = {
        session: source.id,
        item,
        author,
        text: it.text.replace(/\s+$/, "").slice(0, 2000),
      };
      const thread = sessions.get();
      thread.room = source.room ?? conversationRoom(source.id);
      thread.parent = parent;
      thread.members.value = [...source.members.peek()];
      thread.chatMode.value = source.chatMode.peek();
      thread.workMode.value = source.workMode.peek();
      // Whoever wrote the message answers in its thread first: the agent, or for your message
      // the agent that answered it (else the one that spoke last).
      const after = source.items.slice(source.items.indexOf(it) + 1);
      const answeredBy = after.find((i) => i.type === "assistant" && i.speaker);
      thread.nextSpeaker =
        it.type === "assistant"
          ? (it.speaker ?? null)
          : answeredBy?.type === "assistant"
            ? (answeredBy.speaker ?? null)
            : source.lastSpeaker();
      thread.title.value = `Thread: ${it.text.replace(/\s+/g, " ").trim().slice(0, 50)}`;
      showThreadTab(dock, thread.id, { ...(newTab && { newTab }) });
      sessions.active.value = thread.id;
      if (message?.trim())
        await dispatcher.execute("agent.send", {
          message: postedText(message, ctx.caller),
          session: thread.id,
          wait: false,
        });
      void thread.save();
      sessions.changed();
      return { session: thread.id };
    },
  });
  register({
    id: "agent.readThread",
    title: "Read a conversation",
    description:
      "Returns another conversation in this folder as text (D238): a channel's or a direct message's (`channel`) or a thread's (`session`, from ide://agent/channels). Agents use it to catch up on what was said elsewhere.",
    input: s.object({
      session: s.string().optional(),
      channel: s.string().optional(),
      maxChars: s.number().optional(),
    }),
    effects: [],
    run: async ({ session, channel, maxChars }) => {
      let id = session ?? null;
      if (!id && channel) {
        const room = require(channel);
        const agent = dmAgent(room);
        id = (agent ? dmSessions.peek().get(agent) : roomById(room)?.session) ?? null;
        if (!id) return { channel: room, text: "(Nothing has been said there yet.)" };
      }
      if (!id) throw new Error("Name a `session` (a thread) or a `channel`.");
      // This folder's conversations only (D244): another project's chats aren't the agent's.
      const here =
        threads.peek().some((t) => t.id === id) ||
        rooms.peek().some((r) => r.session === id) ||
        [...dmSessions.peek().values()].includes(id);
      if (!here) throw new Error(`No conversation ${id} in this folder (ide://agent/channels).`);
      const target = sessions.get(id);
      await target.loaded();
      const limit = Math.max(500, Math.min(maxChars ?? 12_000, 40_000));
      return {
        session: id,
        title: target.title.peek(),
        text: transcript(target.items, limit, (n) => memberInfo(n).label),
      };
    },
  });
  register({
    id: "agent.createChannel",
    title: "Create channel…",
    description:
      "Creates a channel (D237): a named conversation with standing agents (`members`: agent names, `agent` for the main one) and a `purpose` every conversation in it is told. Without `name`, asks. Returns its id.",
    input: s.object({
      name: s.string().optional(),
      members: s.array(s.string()).optional(),
      purpose: s.string().optional(),
      open: s.boolean().optional(),
    }),
    effects: ["write"],
    run: async ({ name, members, purpose, open }, ctx) => {
      let raw = name;
      if (raw === undefined && ctx.caller.kind === "user")
        raw = await services.quickInput.prompt({
          prompt: "New channel's name, e.g. frontend",
          validate: (v) => roomNameProblem(roomName(v), rooms.peek()) ?? undefined,
        });
      if (raw === undefined || raw === null) return null;
      const clean = roomName(raw);
      const problem = roomNameProblem(clean, rooms.peek());
      if (problem) throw new Error(problem);
      const list = rooms.peek();
      const room: Room = {
        id: newRoomId(clean, list),
        name: clean,
        members: roomMembers(members ?? knownAgents().map((a) => a.name), known),
        purpose: (purpose ?? "").trim().slice(0, 500),
        created: Date.now(),
      };
      save([...list, room]);
      if (open !== false) showRoomTab(dock, room.id);
      return { channel: room.id, name: room.name, members: room.members };
    },
  });
  register({
    id: "agent.createTaskChannel",
    title: "New task channel…",
    description:
      "Makes a channel for one task (D238, Slack Code's task channels): named from the task, with the agents that should work on it (`members`, default the main agent and the built-in team), the task posted as its first message. The agents work there; agent.closeTaskChannel closes it when it's done. Without `task`, asks.",
    input: s.object({
      task: s.string().optional(),
      members: s.array(s.string()).optional(),
      open: s.boolean().optional(),
      wait: s.boolean().optional(),
    }),
    effects: ["write"],
    run: async ({ task, members, open, wait }, ctx) => {
      if (
        ctx.caller.kind !== "user" &&
        rooms.peek().filter((r) => r.task?.status === "open").length >= MAX_OPEN_TASKS
      )
        throw new Error(
          `${MAX_OPEN_TASKS} task channels are open: close one first (agent.closeTaskChannel).`,
        );
      let text = task;
      if (text === undefined && ctx.caller.kind === "user")
        text = await services.quickInput.prompt({
          prompt: "What's the task?",
          validate: (v) => (v.trim() ? undefined : "Say what should be done."),
        });
      if (!text?.trim()) return null;
      const list = rooms.peek();
      const name = taskRoomName(text, list);
      const team = [MAIN_MEMBER, ...BUILT_IN_AGENT_NAMES].filter(known);
      const room: Room = {
        id: newRoomId(name, list),
        name,
        members: roomMembers(members ?? team, known),
        purpose: text.trim().replace(/\s+/g, " ").slice(0, 500),
        created: Date.now(),
        task: { status: "open" },
      };
      save([...list, room]);
      if (open !== false) showRoomTab(dock, room.id);
      const result = await dispatcher.execute("agent.send", {
        message: postedText(text.trim(), ctx.caller),
        session: roomSession(room.id),
        wait: wait === true,
      });
      return { channel: room.id, name: room.name, ...(wait === true && { result }) };
    },
  });
  register({
    id: "agent.closeTaskChannel",
    title: "Close task channel",
    description:
      "Marks a task channel done (D238) with an optional `summary`, kept in the channel's memory, and archives it (its conversation stays in Sessions… and the Inbox).",
    input: s.object({ channel: s.string(), summary: s.string().optional() }),
    effects: ["write"],
    run: ({ channel, summary }) => {
      const room = requireChannel(channel);
      if (!room.task) throw new Error(`#${room.name} isn't a task channel.`);
      const note = summary ? memoryNote(summary) : "";
      update(room.id, (r) => ({
        ...r,
        archived: true,
        task: { status: "done", ...(note && { summary: note }) },
        ...(note && { memory: withNote(r.memory, `Done: ${note}`) }),
      }));
      return { channel: room.id, closed: true };
    },
  });
  register({
    id: "agent.rememberInChannel",
    title: "Remember in channel…",
    description:
      "Keeps a note in a channel's memory (D238): a decision or convention every conversation in the channel is told from then on. One line; at most 30 notes (the oldest go).",
    input: s.object({ channel: s.string(), note: s.string() }),
    effects: ["write"],
    run: ({ channel, note }, ctx) => {
      const room = requireChannel(channel);
      if (!memoryNote(note)) throw new Error("The note is empty.");
      const memory = withNote(room.memory, note);
      update(room.id, (r) => ({ ...r, memory }));
      // Every later message in the channel carries it: the user sees what an agent kept (D244).
      if (ctx.caller.kind !== "user")
        services.notifications.show(
          "info",
          `An agent kept a note in #${room.name}: "${memoryNote(note)}" (right-click the channel → Channel memory… to remove it).`,
        );
      return { channel: room.id, notes: memory.length };
    },
  });
  register({
    id: "agent.channelMemory",
    title: "Channel memory…",
    description:
      "Shows a channel's notes (D238): add one, or pick one to remove it. `remove` removes a note by its text.",
    input: s.object({ channel: s.string(), remove: s.string().optional() }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ channel, remove }) => {
      const room = requireChannel(channel);
      if (remove !== undefined) {
        update(room.id, (r) => ({ ...r, memory: (r.memory ?? []).filter((n) => n !== remove) }));
        return { channel: room.id, removed: true };
      }
      const picked = await services.quickInput.pick(
        [
          { id: "__add", label: "Add a note…", description: "Told to every conversation here" },
          ...(room.memory ?? []).map((n, i) => ({
            id: String(i),
            label: n,
            description: "Remove",
          })),
        ],
        { placeholder: `#${room.name}'s memory: pick a note to remove it` },
      );
      if (!picked) return null;
      if (picked.id === "__add") {
        const note = await services.quickInput.prompt({ prompt: `A note for #${room.name}` });
        if (!note?.trim()) return null;
        return dispatcher.execute("agent.rememberInChannel", { channel: room.id, note });
      }
      const note = room.memory?.[Number(picked.id)];
      if (note === undefined) return null;
      return dispatcher.execute("agent.channelMemory", { channel: room.id, remove: note });
    },
  });
  register({
    id: "agent.editChannel",
    title: "Edit channel…",
    description:
      "Changes a channel's name, agents (`members`) or `purpose` (D237). The channel's conversation gets the new agents from its next message.",
    input: s.object({
      channel: s.string(),
      name: s.string().optional(),
      members: s.array(s.string()).optional(),
      purpose: s.string().optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    run: ({ channel, name, members, purpose }) => {
      const room = requireChannel(channel);
      const next: Room = { ...room };
      if (name !== undefined) {
        const clean = roomName(name);
        const problem = roomNameProblem(clean, rooms.peek(), room.id);
        if (problem) throw new Error(problem);
        next.name = clean;
      }
      if (members !== undefined) next.members = roomMembers(members, known);
      if (purpose !== undefined) next.purpose = purpose.trim().slice(0, 500);
      save(rooms.peek().map((r) => (r.id === room.id ? next : r)));
      // The conversation's agents follow the channel's.
      const convo = room.session ? sessions.find(room.session) : undefined;
      if (convo && members !== undefined) joinRoom(convo, room.id);
      return { channel: next.id, name: next.name, members: next.members, purpose: next.purpose };
    },
  });
  register({
    id: "agent.editChannelMembers",
    title: "Edit channel agents…",
    description: "Asks which agents a channel has (D237).",
    input: s.object({ channel: s.string() }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ channel }) => {
      const room = requireChannel(channel);
      const picked = await pickMembers(services, room.members, `Save #${room.name}'s agents`);
      if (!picked) return null;
      return dispatcher.execute("agent.editChannel", { channel: room.id, members: picked });
    },
  });
  register({
    id: "agent.editChannelPurpose",
    title: "Edit channel purpose…",
    description:
      "Asks what a channel is for (D237): every conversation in it is told, with each message.",
    input: s.object({ channel: s.string() }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ channel }) => {
      const room = requireChannel(channel);
      const purpose = await services.quickInput.prompt({
        prompt: `What #${room.name} is for`,
        value: room.purpose,
      });
      if (purpose === undefined || purpose === null) return null;
      return dispatcher.execute("agent.editChannel", { channel: room.id, purpose });
    },
  });
  register({
    id: "agent.archiveChannel",
    title: "Archive channel",
    description:
      "Archives a channel (D237): it leaves the sidebar; its conversations stay saved (Inbox, Sessions…). `restore: true` brings it back.",
    input: s.object({
      channel: s.string(),
      restore: s.boolean().optional(),
      ask: s.boolean().describe("Ask before archiving (the sidebar's menu)").optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ channel, restore, ask }) => {
      const ref = channel.replace(/^#/, "");
      const room =
        rooms.peek().find((r) => r.id === ref) ??
        rooms.peek().find((r) => r.name === roomName(ref) && !!r.archived === (restore === true));
      if (!room) throw new Error(`No channel named ${channel}.`);
      if (restore === true) {
        const problem = roomNameProblem(room.name, rooms.peek(), room.id);
        if (problem) throw new Error(`${problem} Rename that one first.`);
      } else if (
        ask &&
        !(await confirmAction(
          `Archive #${room.name}?`,
          "It leaves the sidebar; its conversations stay saved. Archived channels… brings it back.",
          "Archive",
        ))
      )
        return { channel: room.id, archived: false };
      update(room.id, (r) => {
        const { archived: _was, ...rest } = r;
        return restore === true ? rest : { ...rest, archived: true };
      });
      return { channel: room.id, archived: restore !== true };
    },
  });
  register({
    id: "agent.deleteChannel",
    title: "Delete channel",
    description:
      "Deletes a channel for good (D270): it leaves the sidebar and its conversations and threads are deleted. agent.archiveChannel keeps them instead.",
    input: s.object({ channel: s.string() }),
    effects: ["destructive"],
    agent: "hidden",
    confirm: ({ channel }) => {
      const room = roomById(channel.replace(/^#/, ""));
      return `Delete ${room ? `#${room.name}` : "this channel"}? Its conversations and threads are deleted too.`;
    },
    run: async ({ channel }) => {
      const ref = channel.replace(/^#/, "");
      const room =
        rooms.peek().find((r) => r.id === ref) ??
        rooms.peek().find((r) => !r.archived && r.name === roomName(ref));
      if (!room) throw new Error(`No channel named ${channel}.`);
      // Its tab closes first: it would otherwise open a new conversation for the channel.
      for (const t of dock.tabs(ROOM_VIEW))
        if ((t.viewState as { room?: string } | null)?.room === room.id)
          await dock.closeTab(t.id, true);
      save(rooms.peek().filter((r) => r.id !== room.id));
      const chats = new Set(threads.peek().flatMap((t) => (t.room === room.id ? [t.id] : [])));
      if (room.session) chats.add(room.session);
      for (const id of chats) await deleteChat(services, sessions, id);
      return { channel: room.id, deleted: chats.size };
    },
  });
  register({
    id: "agent.restoreChannel",
    title: "Archived channels…",
    description:
      "Lists the archived channels (not task channels) and brings the one picked back (D244).",
    input: s.empty(),
    effects: ["write"],
    agent: "hidden",
    run: async () => {
      const archived = rooms.peek().filter((r) => r.archived && !r.task);
      if (!archived.length) return { restored: null };
      const picked = await services.quickInput.pick(
        archived.map((r) => ({ id: r.id, label: `#${r.name}`, description: r.purpose })),
        { placeholder: "Bring an archived channel back" },
      );
      if (!picked) return null;
      await dispatcher.execute("agent.archiveChannel", { channel: picked.id, restore: true });
      return { restored: picked.id };
    },
  });
  register({
    id: "agent.openThread",
    title: "Open thread",
    description:
      "Shows a thread or a chat (a session id) in the thread tab, replacing the one shown there (D237); `newTab` opens a tab of its own.",
    input: s.object({
      session: s.string(),
      newTab: s.boolean().optional(),
      side: s.boolean().describe("Open it to the side (a new group)").optional(),
    }),
    effects: [],
    agent: "hidden",
    run: ({ session, newTab, side }) => {
      const how = { ...(newTab && { newTab }), ...(side && { side }) };
      // A channel's own conversation opens as the channel.
      const room = conversationRoom(session);
      if (room) showRoomTab(dock, room, how);
      else showThreadTab(dock, session, how);
      sessions.get(session);
      sessions.active.value = session;
      return { session, ...(room && { channel: room }) };
    },
  });

  sub.add(
    state.register("ide://agent/channels", {
      description:
        "This folder's channels and direct messages (D237, D238): each with its conversation's session id, agents, purpose, memory, task state and activity, and its threads (title, status: needs-you / working / failed / done, the newest reply, the message they answer). Post with agent.postToChannel, read one with agent.readThread.",
      get: () => {
        const list = rooms.peek().filter((r) => !r.archived);
        const rows = threads.peek();
        const activity = roomActivity(rows, list);
        const threadsOf = (id: string, main: string | undefined) =>
          rows
            .filter((t) => t.id !== main && threadRoom(t, list) === id)
            .sort((a, b) => b.updated - a.updated)
            .slice(0, 20)
            .map((t) => ({
              session: t.id,
              title: t.title,
              status: threadStatus(t),
              ...(t.unread && { unread: true }),
              ...(t.last && { last: t.last }),
              ...(t.lastBy && { lastBy: t.lastBy }),
              ...(t.parent && {
                replyingTo: { author: t.parent.author, text: t.parent.text.slice(0, 120) },
              }),
            }));
        return {
          channels: list.map((r) => ({
            id: r.id,
            name: r.name,
            members: r.members,
            purpose: r.purpose,
            ...(r.session && { session: r.session }),
            ...(r.memory?.length && { memory: r.memory }),
            ...(r.task && { task: r.task.status }),
            ...activity.get(r.id),
            threads: threadsOf(r.id, r.session),
          })),
          directMessages: knownAgents().map((a) => {
            const id = dmRoomId(a.name);
            const session = dmSessions.peek().get(a.name);
            return {
              id,
              agent: a.name,
              label: a.label,
              ...(session && { session }),
              ...activity.get(id),
              threads: threadsOf(id, session),
            };
          }),
          inbox: {
            needsYou: rows.filter((r) => threadStatus(r) === "needs-you").length,
            working: rows.filter((r) => threadStatus(r) === "working").length,
            unread: rows.filter((r) => r.unread).length,
          },
        };
      },
    }),
  );
}
