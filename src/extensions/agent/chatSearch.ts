// Searching this folder's other chats (D331, Claude Code's search_session_transcripts): the
// search_chats tool (read-only, no permission ask) and the commands agent.searchChats (a person:
// a box, then the hits; picking one opens that chat at the message) and agent.openChatMessage.
// Saved chats are read from the transcript store once per saved version (cached by its stamp);
// loaded ones are searched as they are now. Ranking: core/agent/chatSearch.ts.

import {
  type ChatHit,
  chatMessagesOf,
  hitsText,
  type SearchableChat,
  searchChats,
} from "../../core/agent/chatSearch";
import type { Item } from "../../core/agent/conversation";
import { SizedCache, stringBytes } from "../../core/cache/index";
import { agentStoreIpc } from "../../core/ipc/agent";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { isThisWorkspace } from "./chatWorkspace";
import type { SessionManager } from "./sessions";
import type { AgentTool } from "./tools";

/** The most chats searched (newest first): an old folder's long history stays quick. */
const MAX_CHATS = 400;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
/** Saved chats read at once. */
const READ_AT_ONCE = 8;
/** What the saved chats' text may hold in memory between searches, and one chat at most. */
const CACHE_BYTES = 16 * 1024 * 1024;
const CACHE_ENTRY_BYTES = 2 * 1024 * 1024;

interface Cached {
  stamp: string | null;
  chat: SearchableChat;
}

interface SavedMeta {
  title?: string;
  updated?: number;
  workspace?: string | null;
  archived?: boolean;
}

/** A saved transcript's items, if it reads as one. */
function savedItems(json: string | null): Item[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as { items?: unknown };
    return Array.isArray(v.items)
      ? (v.items as Item[]).filter(
          (it) =>
            !!it &&
            (it.type === "user" || it.type === "assistant") &&
            typeof (it as { text?: unknown }).text === "string",
        )
      : [];
  } catch {
    return [];
  }
}

export class ChatSearcher {
  /**
   * Saved chats' text by id, bounded by size, not count (D416): 400 chats can be a few kilobytes
   * or hundreds of megabytes. One evicted or too big is read from the store again next search.
   */
  private readonly cache = new SizedCache<string, Cached>({
    maxBytes: CACHE_BYTES,
    maxEntryBytes: CACHE_ENTRY_BYTES,
    sizeOf: ({ chat }) =>
      stringBytes(chat.title) +
      chat.messages.reduce((sum, m) => sum + stringBytes(m.text) + stringBytes(m.item) + 32, 0),
  });

  constructor(
    private readonly services: WorkbenchServices,
    private readonly sessions: SessionManager,
  ) {}

  /** This folder's chats as searched, except `skip` (the chat asking). */
  private async chats(skip?: string): Promise<SearchableChat[]> {
    const saved = (await agentStoreIpc.list().catch(() => []))
      .map((r) => ({ id: r.id, meta: (r.meta ?? {}) as SavedMeta }))
      .filter((r) => r.id !== skip && isThisWorkspace(this.services, r.meta.workspace))
      .sort((a, b) => (b.meta.updated ?? 0) - (a.meta.updated ?? 0))
      .slice(0, MAX_CHATS);
    const out = new Map<string, SearchableChat>();
    const toRead: typeof saved = [];
    for (const r of saved) {
      const live = this.sessions.find(r.id);
      if (live && !live.deleted) continue;
      toRead.push(r);
    }
    const stamps = await agentStoreIpc.stamps(toRead.map((r) => r.id)).catch(() => []);
    const reads: (() => Promise<void>)[] = toRead.map((r, i) => async () => {
      const stamp = stamps[i] ?? null;
      const hit = this.cache.get(r.id);
      if (hit && hit.stamp === stamp && stamp !== null) {
        out.set(r.id, hit.chat);
        return;
      }
      const items = savedItems(await agentStoreIpc.load(r.id).catch(() => null));
      const chat: SearchableChat = {
        id: r.id,
        title: r.meta.title || "Chat",
        updated: r.meta.updated ?? 0,
        messages: chatMessagesOf(items),
      };
      this.cache.set(r.id, { stamp, chat });
      out.set(r.id, chat);
    });
    for (let i = 0; i < reads.length; i += READ_AT_ONCE)
      await Promise.all(reads.slice(i, i + READ_AT_ONCE).map((f) => f()));
    // Loaded chats as they are now (what isn't saved yet included).
    for (const live of this.sessions.all()) {
      if (live.id === skip || live.deleted || !live.items.length) continue;
      if (!out.has(live.id) && !isThisWorkspace(this.services, live.workspaceRoot)) continue;
      out.set(live.id, {
        id: live.id,
        title: live.title.peek(),
        updated: live.updated,
        messages: chatMessagesOf(live.items),
      });
    }
    // Chats that are gone leave the cache.
    const ids = new Set(saved.map((r) => r.id));
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
    return [...out.values()];
  }

  async search(query: string, limit: number, skip?: string): Promise<ChatHit[]> {
    return searchChats(await this.chats(skip), query, limit);
  }

  /** A message's item id in a chat, by its number (1 = the first) or its id. */
  async itemOf(session: string, message: string | number): Promise<string | null> {
    if (typeof message === "string" && !/^\d+$/.test(message.trim())) return message.trim();
    const n = Number(message);
    const live = this.sessions.find(session);
    const items = live
      ? live.items
      : savedItems(await agentStoreIpc.load(session).catch(() => null));
    return chatMessagesOf(items).find((m) => m.n === n)?.item ?? null;
  }
}

function searchTool(searcher: ChatSearcher): AgentTool {
  return {
    spec: {
      name: "search_chats",
      description:
        "Search the user's other chats in this folder (titles, their messages and your answers; not tool output) for earlier work, decisions or something they said before. Returns each matching chat's id, title and date with snippets, each by its message number (#n). Words, not a regex; best matches first.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words to look for" },
          limit: {
            type: "integer",
            description: `Chats to return (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT})`,
          },
        },
        required: ["query"],
      },
    },
    readOnly: true,
    verb: "Searched chats",
    target: (a) => String(a.query ?? ""),
    async run(args, host) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return { result: 'Error: give "query" (words to look for).', isError: true };
      const asked = Number(args.limit);
      const limit = Math.min(
        MAX_LIMIT,
        Math.max(1, Number.isFinite(asked) && asked > 0 ? Math.floor(asked) : DEFAULT_LIMIT),
      );
      const hits = await searcher.search(query, limit, host.session);
      return {
        result: hits.length
          ? `${hitsText(hits)}\n\n(To show the user one: call_command agent.openChatMessage {session, message: n}.)`
          : `No chat in this folder mentions "${query}".`,
        summary: `${hits.length} chat${hits.length === 1 ? "" : "s"}`,
      };
    },
  };
}

export function registerChatSearch(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): void {
  const searcher = new ChatSearcher(services, sessions);
  const tool = searchTool(searcher);
  const previous = sessions.extraTools;
  sessions.extraTools = (session) => [...previous(session), tool];

  const { dispatcher, quickInput } = services;
  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "Agent", ...c }));

  register({
    id: "agent.openChatMessage",
    title: "Open a chat at a message",
    description:
      "Opens one of this folder's chats and scrolls to a message (D331): `message` is its number in the chat (1 = the first, as search_chats gives it) or its item id.",
    input: s.object({
      session: s.string().describe("The chat's id"),
      message: s.string().describe("The message's number (#n) or item id"),
    }),
    effects: [],
    agent: "discoverable",
    run: async ({ session, message }, ctx) => {
      const item = await searcher.itemOf(session, message);
      if (!item) throw new Error(`No message ${message} in chat ${session}.`);
      await ctx.execute("agent.showMessage", { session, item });
      return { session, item };
    },
  });

  register({
    id: "agent.searchChats",
    title: "Search chats…",
    description:
      "Searches this folder's agent chats (titles, messages and answers; D331). A person types the words and picks a hit, which opens that chat at the message; otherwise returns the hits.",
    input: s.object({
      query: s.string().describe("Words to look for").optional(),
      limit: s.number().describe("Chats to return (default 10)").optional(),
    }),
    effects: ["read"],
    run: async ({ query, limit }, ctx) => {
      const user = ctx.caller.kind === "user";
      const words =
        query ??
        (user
          ? await quickInput.prompt({
              prompt: "Search chats",
              validate: (v) => (v.trim() ? undefined : "Type words to look for."),
            })
          : undefined);
      if (!words?.trim()) return { hits: [] };
      const hits = await searcher.search(words, Math.min(MAX_LIMIT, Math.max(1, limit ?? 10)));
      if (!user) return { hits };
      if (!hits.length) {
        services.notifications.show("info", `No chat in this folder mentions "${words.trim()}".`);
        return { hits };
      }
      const picked = await quickInput.pick(
        hits.flatMap((h) =>
          h.matches.map((m) => ({
            id: `${h.id}\u0000${m.item}`,
            label: h.title,
            description: `#${m.n} · ${new Date(h.updated).toLocaleDateString()}`,
            detail: m.snippet,
          })),
        ),
        { placeholder: `Chats mentioning "${words.trim()}"` },
      );
      if (!picked) return { hits };
      const [session, item] = picked.id.split("\u0000");
      if (session && item) await ctx.execute("agent.showMessage", { session, item });
      return { hits, opened: session ?? null };
    },
  });
}
