// Agent sessions of this window: created per agent tab, restored from app data when a saved tab
// comes back, the "active" one (last focused) for commands without a session id.
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { effect, signal, untracked } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { externalAgents } from "./acpAgents";
import { watchAttention } from "./attention";
import { readText } from "./changeset";
import type { AgentHooks } from "./hooks";
import type { ProviderRegistry } from "./providers";
import { AgentSession, chatTools } from "./session";
import type { AgentTool } from "./tools";

export class SessionManager implements Disposable {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly contents = new Map<string, Disposable>();
  readonly active = signal<string | null>(null);
  /** Bumped when sessions are added, saved or deleted (the Chats list reloads). */
  readonly listVersion = signal(0);
  /** Bumped when a session is opened in this window or closed (the inline review follows). */
  readonly members = signal(0);
  changed(): void {
    this.listVersion.value = this.listVersion.peek() + 1;
  }
  /** Tools beyond the built-in ones (MCP, subagents, web search) for a chat, or any chat. */
  extraTools: (session?: AgentSession) => ReturnType<AgentSession["extraTools"]> = () => [];

  /** The IDE's own tools a new chat would have now (not MCP servers'): the MCP page's count. */
  builtinTools(): AgentTool[] {
    return chatTools(this.services, false, () => [], this.extraTools()).filter((t) => !t.mcp);
  }
  /** Runs before every turn (starts MCP servers). */
  prepare: (session?: AgentSession) => Promise<void> = async () => {};
  /** The automatic review's run (set by the subagents). */
  reviewSpec: AgentSession["reviewSpec"] = () => null;
  /** What a tool result about a file adds besides rules (the skills for it, D221). */
  fileNote: (session: AgentSession, path: string) => Promise<string> = async () => "";

  constructor(
    private readonly services: WorkbenchServices,
    private readonly providers: ProviderRegistry,
  ) {
    this.contents.set(
      "disk",
      services.quickDiff.registerContent("disk", (path) => readText(services, path)),
    );
    // The main agent changed (Start free picked OpenCode, the model menu): chats with nothing in
    // them yet follow it (D241), so a channel's or an agent's empty chat doesn't keep the old one.
    this.contents.set(
      "main-model",
      services.settings.model.onDidChange((keys) => {
        if (!keys.includes("agent.model")) return;
        for (const s of this.sessions.values())
          if (!s.items.length && s.status.peek() === "idle") this.applyMain(s, true);
      }),
    );
    // Auto (full access) is global and means nothing waits on the user: every chat's edits
    // apply too (D273: a new folder's chats said Auto and still asked to review).
    this.contents.set(
      "full-access",
      services.settings.model.onDidChange((keys) => {
        if (!keys.includes("agent.runCommands") || !this.fullAccess()) return;
        for (const s of this.sessions.values()) s.autoApply.value = true;
      }),
    );
  }

  /** Auto: full access, never ask (`agent.runCommands` "full"). */
  private fullAccess(): boolean {
    return this.services.settings.peek<string>("agent.runCommands") === "full";
  }

  /** A chat with nothing in it takes the main agent's external agent (or, `reset`, drops one). */
  private applyMain(session: AgentSession, reset: boolean): void {
    const main = this.services.settings.peek<string>("agent.model") ?? "";
    const external =
      main.startsWith("acp/") &&
      externalAgents(this.services).some((a) => `acp/${a.name}` === main);
    if (external) session.model.value = main;
    else if (reset && session.model.peek()?.startsWith("acp/")) session.model.value = null;
  }

  /** The user's agent hooks (D227), set by the extension. */
  hooks: AgentHooks | null = null;

  /** The edit mode last chosen in this workspace (Review edits / Accept edits), kept per workspace. */
  autoApply = false;

  /** What a chat not started yet takes: the workspace's choice, or Auto's. */
  startsApplying(): boolean {
    return this.autoApply || this.fullAccess();
  }

  /** The session with `id` (loaded from disk if it was saved), or a new one. */
  get(id?: string | null): AgentSession {
    const existing = id ? this.sessions.get(id) : undefined;
    if (existing) return existing;
    const session = new AgentSession(this.services, this.providers, id ?? undefined);
    // New chats start in the mode last chosen in this workspace (a saved chat loads its own);
    // with Auto on, edits apply wherever the chat is.
    session.autoApply.value = this.startsApplying();
    session.extraTools = () => this.extraTools(session);
    session.prepare = () => this.prepare(session);
    session.runHook = async (event, fields) => this.hooks?.run(session, event, fields) ?? null;
    session.reviewSpec = (files, tools) => this.reviewSpec(files, tools);
    session.fileNote = (path) => this.fileNote(session, path);
    this.sessions.set(session.id, session);
    this.members.value = this.members.peek() + 1;
    const store = new DisposableStore();
    store.add(
      this.services.quickDiff.registerContent(
        `agent:${session.id}`,
        async (path) => session.changeset.get(path)?.proposed ?? null,
      ),
    );
    // What a file held before the agent's edits under review (D199: the left side of its diff,
    // the file itself on the right).
    store.add(
      this.services.quickDiff.registerContent(`agentBase:${session.id}`, async (path) => {
        const f = session.changeset.get(path);
        return f ? (f.original ?? "") : null;
      }),
    );
    // What a file held before the agent's latest applied change (Open diff on applied cards).
    store.add(
      this.services.quickDiff.registerContent(
        `agentBefore:${session.id}`,
        async (path) => session.changeset.appliedBefore(path) ?? null,
      ),
    );
    // Diff tabs showing its proposals refresh when the changeset changes.
    store.add(
      effect(() => {
        session.changeset.files.value;
        untracked(() => this.services.quickDiff.changed());
        return undefined;
      }),
    );
    // It needs the user while the window is in the background: the taskbar flashes (D254).
    store.add(watchAttention(this.services, session));
    this.contents.set(session.id, store);
    // A new chat starts with the main agent (D196): an external agent too, when that's the one.
    // One opened by id that was never saved (a channel's conversation made earlier, D241) too.
    if (id)
      void session.hydrate().then((found) => {
        if (!found && !session.items.length && !session.model.peek())
          this.applyMain(session, false);
      });
    else this.applyMain(session, false);
    if (!this.active.peek()) this.active.value = session.id;
    return session;
  }

  find(id: string | undefined): AgentSession | undefined {
    const key = id ?? this.active.peek();
    return key ? this.sessions.get(key) : undefined;
  }

  /** The session for a command: given id, else the active one. */
  require(id: string | undefined): AgentSession {
    const s = this.find(id);
    if (!s) throw new Error("No agent session. Open one with Ctrl/Cmd+L.");
    return s;
  }

  all(): AgentSession[] {
    return [...this.sessions.values()];
  }

  forget(id: string): void {
    this.sessions.get(id)?.endHooks("other");
    this.sessions.get(id)?.dispose();
    this.sessions.delete(id);
    this.members.value = this.members.peek() + 1;
    this.contents.get(id)?.dispose();
    this.contents.delete(id);
    if (this.active.peek() === id) this.active.value = this.sessions.keys().next().value ?? null;
  }

  dispose(): void {
    // The window is closing: SessionEnd as Claude Code's exit (best effort, the page is going).
    for (const s of this.sessions.values()) s.endHooks("prompt_input_exit");
    for (const s of this.sessions.values()) s.dispose();
    for (const d of this.contents.values()) d.dispose();
  }
}
