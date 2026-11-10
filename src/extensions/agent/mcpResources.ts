// MCP resource templates and subscriptions (D204). A template (`resources/templates/list`) is
// filled in when its @-mention is sent: each variable is asked in a quick input (or comes from
// agent.mcpResources' `values`), and the URI it makes is read like any resource. A resource a
// chat attached is subscribed to when the server allows it (`resources/subscribe`); when the
// server says it changed (`notifications/resources/updated`), the chat's next message carries its
// new text, so the agent works with what's current. The template model is
// core/mcp/templates.ts.
import type { DisposableStore } from "../../core/lifecycle/index";
import type { McpClient } from "../../core/mcp/client";
import { resourceContext } from "../../core/mcp/prompts";
import { expandTemplate, requiredVariables, templateVariables } from "../../core/mcp/templates";
import type { WorkbenchServices } from "../../workbench/services";
import { registerSendContext } from "./composerExtras";
import type { McpClients } from "./mcp";
import type { SessionManager } from "./sessions";

interface Watched {
  server: string;
  uri: string;
  /** Chats that attached it. */
  sessions: Set<string>;
  /** Chats whose next message should carry its new text. */
  stale: Set<string>;
  updates: number;
}

const key = (server: string, uri: string) => `${server}\0${uri}`;

export class ResourceWatch {
  private readonly watched = new Map<string, Watched>();
  private readonly hooked = new WeakSet<McpClient>();

  constructor(
    private readonly clients: McpClients,
    /** The chats that still exist (a deleted one's subscriptions end). */
    private readonly alive: () => Set<string> = () => new Set(),
  ) {}

  private client(server: string): McpClient | undefined {
    return this.clients.runningServers().find((r) => r.name === server)?.client;
  }

  /** A chat attached `uri`: subscribe (when the server offers it) and remember who. */
  async attached(server: string, uri: string, session: string): Promise<boolean> {
    const client = this.client(server);
    if (!client?.canSubscribe) return false;
    if (!this.hooked.has(client)) {
      this.hooked.add(client);
      // The client's emitter goes with it: no listener outlives the server.
      client.onDidUpdateResource((changed) => this.changed(server, changed));
    }
    const ok = await client.subscribe(uri).catch(() => false);
    if (!ok) return false;
    const k = key(server, uri);
    const entry = this.watched.get(k) ?? {
      server,
      uri,
      sessions: new Set<string>(),
      stale: new Set<string>(),
      updates: 0,
    };
    entry.sessions.add(session);
    this.watched.set(k, entry);
    return true;
  }

  private changed(server: string, uri: string): void {
    const entry = this.watched.get(key(server, uri));
    if (!entry) return;
    entry.updates++;
    for (const s of entry.sessions) entry.stale.add(s);
  }

  /** The new text of what changed for this chat since its last message (then it's current). */
  async takeUpdates(session: string): Promise<string[]> {
    this.prune();
    const out: string[] = [];
    for (const entry of this.watched.values()) {
      if (!entry.stale.delete(session)) continue;
      const client = this.client(entry.server);
      if (!client) continue;
      const result = await client.readResource(entry.uri).catch(() => null);
      if (!result) continue;
      out.push(
        `The MCP resource ${entry.uri} from ${entry.server}, attached earlier, changed since. Its current text:\n\n${resourceContext(entry.server, entry.uri, result)}`,
      );
    }
    return out;
  }

  /** A chat went away: stop watching for it (and unsubscribe what no chat needs). */
  forget(session: string): void {
    for (const [k, entry] of this.watched) {
      entry.sessions.delete(session);
      entry.stale.delete(session);
      if (entry.sessions.size) continue;
      this.watched.delete(k);
      void this.client(entry.server)?.unsubscribe(entry.uri);
    }
  }

  /** A server stopped: its subscriptions ended with it; a deleted chat's are dropped. */
  prune(): void {
    const alive = this.alive();
    for (const [k, entry] of this.watched) {
      if (!this.client(entry.server)) {
        this.watched.delete(k);
        continue;
      }
      for (const s of [...entry.sessions]) if (!alive.has(s)) this.forget(s);
    }
  }

  list(): { server: string; uri: string; chats: number; updates: number; pending: number }[] {
    this.prune();
    return [...this.watched.values()].map((e) => ({
      server: e.server,
      uri: e.uri,
      chats: e.sessions.size,
      updates: e.updates,
      pending: e.stale.size,
    }));
  }
}

/** Whether a mention's URI is a template still to fill in. */
export const isTemplate = (uri: string) => /\{[^}]+\}/.test(uri);

/**
 * The URI a template makes: `values` first, then each missing variable asked (`ask` gives null
 * when the user cancels). Throws when a needed one stays empty.
 */
export async function fillTemplate(
  template: string,
  values: Record<string, string>,
  ask: (name: string) => Promise<string | null>,
): Promise<string> {
  const filled = { ...values };
  const needed = new Set(requiredVariables(template));
  for (const name of templateVariables(template)) {
    if (filled[name] !== undefined) continue;
    const typed = await ask(name);
    if (typed === null) throw new Error("Cancelled.");
    if (typed.trim()) filled[name] = typed.trim();
    else if (needed.has(name)) throw new Error(`${template} needs ${name}.`);
  }
  return expandTemplate(template, filled);
}

export function registerResourceWatch(
  sub: DisposableStore,
  services: WorkbenchServices,
  clients: McpClients,
  sessions: SessionManager,
): ResourceWatch {
  const watch = new ResourceWatch(clients, () => new Set(sessions.all().map((s) => s.id)));
  sub.add(registerSendContext((session) => watch.takeUpdates(session.id)));
  sub.add(
    services.state.register("ide://agent/mcp/subscriptions", {
      description:
        "MCP resources the agent's chats attached and the IDE subscribed to (D204): server, uri, how many chats have it, how many updates came, and how many chats will get the new text with their next message.",
      get: () => ({ subscriptions: watch.list() }),
    }),
  );
  return watch;
}
