// What the discovery cards do (D342, D343), as commands the cards run as the user's click (tests
// may run them too): Add on a suggest_skill card adds the skill (agent.addSkillFromCatalog); Add
// on a suggest_mcp_server card writes the server with agent.installMcpServer (which shows what a
// registry server runs and asks where to install it) and stores the values typed in the card as
// the server's inputs; Reconnect on an mcp_status card restarts the server and redraws its row.
// Each marks its card (the agent may suggest again). The values a card's fields hold reach
// agent.addSuggestedMcpServer through `stashCardValues`, not the command's input, so keys never
// land in the command log.

import type { Item } from "../../core/agent/conversation";
import { parseSkillSuggestion } from "../../core/agent/skillSuggest";
import type { DisposableStore } from "../../core/lifecycle/index";
import { type GalleryEntry, galleryEntry } from "../../core/mcp/gallery";
import { parseMcpStatus, parseMcpSuggestion, planMcpAdd } from "../../core/mcp/suggest";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { mcpServerRows } from "./discoveryTools";
import type { McpClients } from "./mcp";
import { lookUpRegistry, registryHit } from "./mcpRegistry";
import type { AgentSession } from "./session";
import type { SessionManager } from "./sessions";

type ToolItem = Extract<Item, { type: "tool" }>;

/** What each card is doing now, by tool call: the names / ids being added or reconnected. */
const busy = new Map<string, ReadonlySet<string>>();
const NONE: ReadonlySet<string> = new Set();
export const discoveryBusy = (item: string): ReadonlySet<string> => busy.get(item) ?? NONE;

/** Values typed in a suggest_mcp_server card's fields, by "<item>\0<server id>". */
const stashed = new Map<string, Record<string, string>>();

/** The card hands its fields' values over before it runs agent.addSuggestedMcpServer. */
export function stashCardValues(item: string, id: string, values: Record<string, string>): void {
  stashed.set(`${item}\0${id}`, values);
}

/** The card `id` (a tool call of `name`), or the chat's latest one when no id is given. */
const toolItem = (session: AgentSession, id: string | undefined, name: string): ToolItem => {
  const it = id
    ? session.items.find((i) => i.id === id)
    : session.items.findLast((i) => i.type === "tool" && i.name === name && i.status === "done");
  if (it?.type !== "tool" || it.name !== name)
    throw new Error(`No ${name} card${id ? ` ${id}` : ""} in this chat.`);
  return it;
};

/** Runs `work` with `key` shown as busy on card `item`. */
async function whileBusy<T>(
  session: AgentSession,
  item: string,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const mark = (on: boolean) => {
    const now = new Set(discoveryBusy(item));
    if (on) now.add(key);
    else now.delete(key);
    if (now.size) busy.set(item, now);
    else busy.delete(item);
    session.bump();
  };
  mark(true);
  try {
    return await work();
  } finally {
    mark(false);
  }
}

export function registerDiscoveryCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
  clients: McpClients,
): void {
  const register = (c: Parameters<typeof services.dispatcher.register>[0]) =>
    sub.add(services.dispatcher.register(c));
  const sessionInput = s.string().describe("Session id (default: the active session)").optional();
  sub.add({
    dispose: () => {
      busy.clear();
      stashed.clear();
    },
  });

  register({
    id: "agent.addSuggestedSkill",
    title: "Add a suggested skill",
    category: "Agent",
    description:
      "Adds a skill from the agent's suggest_skill card (D342) with agent.addSkillFromCatalog, as the user's choice, and marks the card (added; the agent may suggest again).",
    input: s.object({
      session: sessionInput,
      item: s.string().describe("The suggest_skill call (default: the latest)").optional(),
      name: s.string().describe("The skill's name from the card"),
    }),
    effects: ["write"],
    agent: "hidden",
    palette: false,
    run: async ({ session, item, name }, ctx) => {
      const target = sessions.require(session);
      const it = toolItem(target, item, "suggest_skill");
      const card = parseSkillSuggestion(it.detail);
      const entry = card?.items.find((x) => x.name === name);
      if (!card || !entry) throw new Error(`${name} isn't on that card.`);
      const result = (await whileBusy(target, it.id, name, () =>
        ctx.execute("agent.addSkillFromCatalog", { name }),
      )) as { added: string | null; how?: string; path?: string };
      if (!result.added) return { added: null };
      it.detail = JSON.stringify({
        ...card,
        engaged: true,
        items: card.items.map((x) => (x === entry ? { ...x, added: true } : x)),
      });
      target.bump();
      void target.save();
      return result;
    },
  });

  register({
    id: "agent.addSuggestedMcpServer",
    title: "Add a suggested MCP server",
    category: "Agent",
    description:
      "Adds an MCP server from the agent's suggest_mcp_server card (D343) with agent.installMcpServer (a registry server shows what it runs first; a person picks this folder or every folder unless `scope` says), then stores the values typed in the card's fields as the server's inputs (keys as secrets, never shown to the agent; an empty one is asked when it starts). `values` is for scripts: the card hands its fields over without the command log. Marks the card (added; the agent may suggest again).",
    input: s.object({
      session: sessionInput,
      item: s.string().describe("The suggest_mcp_server call (default: the latest)").optional(),
      id: s.string().describe("The server's id from the card"),
      scope: s.enum(["folder", "user"] as const).optional(),
      name: s.string().describe("Name to give it (default its id)").optional(),
      values: s
        .unknown()
        .describe("Input values by id (scripts; not keys you care about)")
        .optional(),
    }),
    effects: ["write", "exec"],
    agent: "hidden",
    palette: false,
    run: async ({ session, item, id, scope, name, values }, ctx) => {
      const target = sessions.require(session);
      const it = toolItem(target, item, "suggest_mcp_server");
      const card = parseMcpSuggestion(it.detail);
      const row = card?.items.find((x) => x.id === id);
      if (!card || !row) throw new Error(`${id} isn't on that card.`);
      const typed = stashed.get(`${it.id}\0${id}`);
      stashed.delete(`${it.id}\0${id}`);
      const given: Record<string, unknown> = {
        ...(values && typeof values === "object" && !Array.isArray(values)
          ? (values as Record<string, unknown>)
          : {}),
        ...typed,
      };
      return whileBusy(target, it.id, id, async () => {
        // The entry as the card showed it: the gallery's, or the registry's (found again after
        // a restart by its registry name).
        const entry: GalleryEntry | null =
          row.source === "builtin"
            ? (galleryEntry(id) ?? null)
            : (registryHit(id) ??
              (row.registryName ? await lookUpRegistry(services, row.registryName) : null));
        if (!entry)
          throw new Error(`${row.title} can't be found again (the registry is offline?).`);
        const plan = planMcpAdd(entry, given);
        if (plan.invalid.length)
          throw new Error(`Not one of the choices: ${plan.invalid.join(", ")}.`);
        const installed = (await ctx.execute("agent.installMcpServer", {
          id: entry.id,
          ...(row.registryName && { registry: row.registryName }),
          ...(scope && { scope }),
          ...(name && { name }),
        })) as { installed: boolean; name?: string; file?: string };
        if (!installed.installed || !installed.name) return { added: null };
        const stored = await clients.presetInputs(installed.name, plan.presets);
        it.detail = JSON.stringify({
          ...card,
          engaged: true,
          items: card.items.map((x) => (x === row ? { ...x, added: installed.name } : x)),
        });
        target.bump();
        void target.save();
        return {
          added: installed.name,
          file: installed.file,
          stored,
          askedAtStart: plan.later.filter((x) => !stored.includes(x)),
        };
      });
    },
  });

  register({
    id: "agent.reconnectMcpServer",
    title: "Reconnect an MCP server",
    category: "Agent",
    description:
      "Restarts one MCP server (as agent.mcpServers { restart } does) and, from an mcp_status card (D343), redraws its row with the state it reached.",
    input: s.object({
      session: sessionInput,
      item: s
        .string()
        .describe("The mcp_status call whose card to update (default: the latest showing it)")
        .optional(),
      name: s.string(),
    }),
    effects: ["exec"],
    agent: "hidden",
    palette: false,
    run: async ({ session, item, name }, ctx) => {
      const target = sessions.require(session);
      const restart = () => ctx.execute("agent.mcpServers", { restart: name });
      // The card named, else the latest one showing that server; none: only the restart.
      const it = item
        ? toolItem(target, item, "mcp_status")
        : target.items.findLast(
            (i): i is ToolItem =>
              i.type === "tool" &&
              i.name === "mcp_status" &&
              !!parseMcpStatus(i.detail)?.servers.some((r) => r.name === name),
          );
      const card = it ? parseMcpStatus(it.detail) : null;
      const row = card?.servers.find((r) => r.name === name);
      if (item && !row) throw new Error(`${name} isn't on that card.`);
      if (!it || !card || !row) {
        await restart();
        const now = (await mcpServerRows(services)).find((r) => r.name === name);
        return {
          name,
          state: now?.state ?? "not started",
          ...(now?.error && { error: now.error }),
        };
      }
      await whileBusy(target, it.id, name, restart);
      const now = (await mcpServerRows(services)).find((r) => r.name === name);
      const state = now?.state ?? "not started";
      it.detail = JSON.stringify({
        ...card,
        engaged: true,
        servers: card.servers.map((r) =>
          r === row
            ? { ...(now ?? r), reconnected: state, ...(now?.error ? {} : { error: undefined }) }
            : r,
        ),
      });
      target.bump();
      void target.save();
      return { name, state, ...(now?.error && { error: now.error }) };
    },
  });
}
