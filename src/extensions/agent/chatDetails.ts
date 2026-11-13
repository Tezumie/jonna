// The chat's details panel (D231, after Claude Code's desktop app): what the panel shows, gathered
// from the session (environment, context window, changes, background work, plan) for the view
// (view/details.ts) and for `ide://agent/details`; `agent.toggleDetails`; the folded cards and
// "hidden" kept in the global state. The layout math and the context split are in
// core/agent/chatDetails.ts (DOM-free, tested).

import {
  type ContextBreakdown,
  chatChanges,
  contextBreakdown,
  conversationSizes,
  DETAILS_CARDS,
  type DetailsCard,
  type DetailsLayout,
  detailsSetting,
  moveCard,
  promptPartsOf,
  type SizedItem,
  sanitizeFolded,
  sanitizeOrder,
  toolSizes,
  untilAutoCompact,
} from "../../core/agent/chatDetails";
import { findCustomMode } from "../../core/agent/chatModes";
import type { HelperState } from "../../core/agent/isolatedHelpers";
import { describeRepeat } from "../../core/agent/schedules";
import { type Disposable, type DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { basename, samePath } from "../../core/paths/index";
import { type ReadonlySignal, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { locationLabel } from "../../workbench/workspace";
import { backgroundProcesses } from "./backgroundProcesses";
import { agentOwnModel, chatModelKey } from "./chatAgentModel";
import { isThisWorkspace } from "./chatWorkspace";
import { customModes } from "./customModes";
import { memberMode } from "./groupChat";
import type { IsolatedHelpers } from "./isolatedHelpers";
import { modelLabel } from "./menus";
import { outputStyleLabel } from "./outputStyles";
import type { ProviderRegistry } from "./providers";
import { type PrWatchInfo, prWatches, prWatchOf } from "./prWatches";
import { conversationRoom } from "./roomService";
import { rulesFor } from "./rules";
import { scheduledMessages, schedulesOf } from "./schedules";
import type { AgentSession } from "./session";
import type { SessionManager } from "./sessions";
import { contextLengthFor } from "./sessionUsage";

/** What the panel shows for one chat (also `ide://agent/details`). */
export interface ChatDetailsData {
  environment: {
    /** Where the agent runs. */
    where: string;
    folder: { name: string; path: string; open: boolean } | null;
    /** The workspace's other folders (D251), which the agent reads and edits too; this window's chat only. */
    folders: { name: string; path: string }[];
    branch: string | null;
    model: string;
    /** One of the user's agents the chat is with (D230), or null for the main agent. */
    agent: {
      name: string;
      label: string;
      role?: string;
      icon?: string;
      path?: string;
      /** The model it answers with (null: the default), for its face (D270). */
      model: string | null;
    } | null;
    mode: { id: string; label: string };
    /** The output style in use (D356); "" for Default. */
    outputStyle: string;
  };
  context:
    | (ContextBreakdown & {
        rules: { name: string; tokens: number }[];
        /** Each built-in tool the requests carry, largest first (D409). */
        builtIn: { name: string; tokens: number }[];
        /** Tools the requests name only, loaded with tool_search (D319): not in the window. */
        deferred: { builtIn: number; mcp: number; builtInTokens: number; mcpTokens: number };
        /** Tokens of messages left before the IDE's agent summarizes by itself (D409). */
        autoCompactIn: number | null;
        /** The chat is with an external agent: it compacts its own context (/compact). */
        external: boolean;
      })
    | null;
  changes: { files: number; added: number; removed: number; review: number };
  background: {
    running: {
      kind: "subagent" | "command";
      id: string;
      label: string;
      detail?: string;
      startedAt: number;
      /** A command started by the monitor tool (D322): `label` is what it watches. */
      monitor?: true;
      /** Up at an address (a dev server, D367): a server icon, not a spinner. */
      serving?: true;
    }[];
    finished: number;
    /** The pull request the chat watches (D323), where it stands. */
    pullRequest: PrWatchInfo | null;
    /** Helpers working in git worktrees of their own (D231, isolatedHelpers.ts), newest last. */
    helpers: {
      id: string;
      agent: string;
      label: string;
      role?: string;
      icon?: string;
      state: HelperState;
      startedAt: number;
      finishedAt?: number;
      files?: number;
      added?: number;
      removed?: number;
    }[];
    /** Scheduled messages to this chat or made by its agent (D253), soonest first. */
    scheduled: { id: string; label: string; repeat: string; next: number }[];
  };
  plan: { done: number; total: number; current: string | null };
}

/** A details panel on screen, for agent.toggleDetails and the state. */
export interface DetailsControl {
  /** Shows or hides it (flips without `show`); returns whether it shows now. */
  toggle(show?: boolean): boolean;
  layout(): DetailsLayout;
  shown(): boolean;
  /** Its tab is on screen. */
  onScreen(): boolean;
}

/** What the view needs from the extension (index.ts passes it to AgentView). */
export interface DetailsHost {
  /** Reactive: reads the session's signals, so an effect re-runs when they change. */
  data(
    session: AgentSession,
    extra: { branch: string | null; limit: number | null },
  ): ChatDetailsData;
  /** The chat's model's context window when no request has said yet. */
  contextLimit(session: AgentSession): Promise<number | null>;
  /** The open folder's git branch (null outside a repository). */
  branch(): Promise<string | null>;
  /** A command is registered (an extension may be off). */
  has(command: string): boolean;
  readonly folded: ReadonlySignal<ReadonlySet<DetailsCard>>;
  setFolded(card: DetailsCard, folded: boolean): void;
  /** The cards' order, dragged by their headers (D409), for every chat. */
  readonly order: ReadonlySignal<readonly DetailsCard[]>;
  setOrder(order: readonly DetailsCard[]): void;
  /** The user hid the panel beside the chat (it stays a button). */
  readonly hidden: ReadonlySignal<boolean>;
  setHidden(hidden: boolean): void;
  attach(session: string, control: DetailsControl): Disposable;
  /** The worktree helpers (registered after this, index.ts). */
  useHelpers(helpers: IsolatedHelpers | null): void;
  /** Reads the helpers' list (an effect that calls it re-runs when a helper changes). */
  watchHelpers(): void;
  /** Reads the workspace's folders (an effect that calls it re-runs when one is added or removed). */
  watchFolders(): void;
}

const MODE_LABELS: Record<string, string> = { agent: "Agent", plan: "Plan", ask: "Ask" };
/** A finished background subagent's notice (sessionSubagents.ts). */
const FINISHED_NOTICE = /^Subagent .+ (finished|was stopped)\.$/;

export function registerChatDetails(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
  providers: ProviderRegistry,
): DetailsHost {
  const { dispatcher, persistence, settings, state, workspace } = services;
  const saved = persistence.globalState().agentDetails;
  const folded = signal<ReadonlySet<DetailsCard>>(new Set(sanitizeFolded(saved?.folded)));
  const hidden = signal(saved?.hidden === true);
  const order = signal<readonly DetailsCard[]>(sanitizeOrder(saved?.order));
  const save = () =>
    void persistence.saveGlobal({
      agentDetails: {
        folded: [...folded.peek()],
        ...(hidden.peek() && { hidden: true }),
        order: [...order.peek()],
      },
    });
  const controls = new Map<string, Set<DetailsControl>>();
  /** When each background subagent was first seen running (per chat, by id): its elapsed time. */
  const firstSeen = new WeakMap<AgentSession, Map<string, number>>();
  const helperSource = signal<IsolatedHelpers | null>(null);

  const branch = async (): Promise<string | null> => {
    try {
      const git = (await state.get("ide://git/status", { budget: 2000 })).value as {
        branch?: { head: string | null };
      } | null;
      return git?.branch ? (git.branch.head ?? "(detached)") : null;
    } catch {
      return null;
    }
  };

  const contextLimit = async (session: AgentSession): Promise<number | null> => {
    const key = session.model.peek() ?? providers.defaultModel()?.key;
    const choice = key ? providers.find(key) : undefined;
    if (!choice) return null;
    const details = await providers.detailsFor(choice).catch(() => null);
    return details ? contextLengthFor(session, choice, details) : null;
  };

  const data: DetailsHost["data"] = (session, extra) => {
    session.version.value;
    session.status.value;
    const root = session.folder.value;
    const open = workspace.root.value;
    workspace.file.value;
    // A group chat (D232): the member that answered last, not the chat's own Agent mode.
    const speaker = session.members.value.length ? session.lastSpeaker() : null;
    const mode = speaker ? memberMode(speaker) : session.chatMode.value;
    const custom = findCustomMode(customModes.value, mode);
    const agent = custom?.agent
      ? {
          name: custom.name,
          label: custom.agent.label,
          ...(custom.agent.role && { role: custom.agent.role }),
          ...(custom.agent.icon && { icon: custom.agent.icon }),
          ...(custom.agent.path && { path: custom.agent.path }),
          model: speaker ? agentOwnModel(custom.name, true) : chatModelKey(session, true),
        }
      : null;
    // This window's (D251: its folder, or its multi-root workspace's file).
    const isOpen = !!root && !!open && isThisWorkspace(services, root);
    // Context: the split is estimated from what the next request carries.
    const usage = session.usage.value;
    const promptText = session.frozenSystem;
    // The tools of the mode shown (the last speaker's in a group chat, D233); during a turn its own.
    const split = session.splitTools(session.turnMode !== null ? undefined : mode);
    const tools = toolSizes(split.tools.map((t) => t.spec));
    const deferredSizes = toolSizes(split.deferred.map((t) => t.spec));
    const sizes = conversationSizes(session.items as readonly SizedItem[]);
    const breakdown = contextBreakdown(
      {
        system: promptText?.length ?? null,
        parts: promptText ? promptPartsOf(promptText) : null,
        tools: tools.tools,
        mcp: tools.mcp,
        conversation: sizes.conversation,
        attachments: sizes.attachments,
      },
      usage,
      extra.limit,
    );
    // Nothing sent yet and nothing typed: no context to speak of.
    const external = (chatModelKey(session, true) ?? "").startsWith("acp/");
    const messages = (breakdown?.rows ?? [])
      .filter((r) => r.key === "conversation" || r.key === "attachments")
      .reduce((n, r) => n + r.tokens, 0);
    const room = conversationRoom(session.id);
    const cap = room ? (settings.peek<number>("agent.channels.contextTokens") ?? 32_000) : null;
    const context =
      breakdown && (usage || session.items.length)
        ? {
            ...breakdown,
            builtIn: split.tools
              .filter((t) => !t.mcp)
              .map((t) => ({
                name: t.spec.name,
                tokens: Math.round(JSON.stringify(t.spec).length / 4),
              }))
              .sort((a, b) => b.tokens - a.tokens),
            deferred: {
              builtIn: split.deferred.filter((t) => !t.mcp).length,
              mcp: split.deferred.filter((t) => t.mcp).length,
              builtInTokens: Math.round(deferredSizes.tools / 4),
              mcpTokens: Math.round(deferredSizes.mcp.reduce((n, x) => n + x.chars, 0) / 4),
            },
            autoCompactIn:
              external || settings.peek<boolean>("agent.autoCompact") === false
                ? null
                : untilAutoCompact(messages, breakdown.limit, cap),
            external,
            rules: promptText
              ? rulesFor(services)
                  .peek()
                  .filter((r) => r.activation === "always" && r.text.trim())
                  .map((r) => ({
                    name: basename(r.path),
                    tokens: Math.round(Math.min(r.text.length, 8000) / 4),
                  }))
              : [],
          }
        : null;
    const files = session.changeset.files.value;
    const changes = chatChanges(
      session.items,
      (path, turn) => session.changeset.appliedStat(path, turn),
      files.map((f) => ({ path: f.path, ...session.changeset.stat(f) })),
    );
    // Background work: subagents (D195) and commands (D201).
    session.backgroundCount.value;
    backgroundProcesses.version.value;
    const now = Date.now();
    const running: ChatDetailsData["background"]["running"] = [];
    let seen = firstSeen.get(session);
    if (!seen) {
      seen = new Map();
      firstSeen.set(session, seen);
    }
    for (const id of [...seen.keys()]) if (!session.background.has(id)) seen.delete(id);
    for (const [id, b] of session.background) {
      // `started` when the run records it; else when this window first saw it.
      const started = (b as { started?: number }).started ?? seen.get(id) ?? now;
      seen.set(id, started);
      running.push({ kind: "subagent", id, label: b.name, startedAt: started });
    }
    const processes = backgroundProcesses.list(session.id);
    for (const p of processes)
      if (p.status === "running")
        running.push({
          kind: "command",
          id: p.id,
          label: p.monitor ? p.monitor.description : p.command,
          ...(p.monitor
            ? { detail: p.command, monitor: true as const }
            : p.urls[0] && { detail: p.urls[0], serving: true as const }),
          startedAt: p.startedAt,
        });
    // A watched pull request (D323): read so the panel follows it.
    prWatches.value;
    const pullRequest = prWatchOf(session.id);
    const finished =
      processes.filter((p) => p.status !== "running").length +
      session.items.filter((i) => i.type === "notice" && FINISHED_NOTICE.test(i.text)).length;
    // Helpers in worktrees (D231): the chat's last few, at work or finished.
    const helpers = (helperSource.value?.list.value ?? [])
      .filter((x) => x.parent === session.id)
      .slice(-6)
      .map((x) => ({
        id: x.id,
        agent: x.agent,
        label: x.label,
        ...(x.role && { role: x.role }),
        ...(x.icon && { icon: x.icon }),
        state: x.state,
        startedAt: x.startedAt,
        ...(x.finishedAt !== undefined && { finishedAt: x.finishedAt }),
        ...(x.files !== undefined && { files: x.files }),
        ...(x.added !== undefined && { added: x.added }),
        ...(x.removed !== undefined && { removed: x.removed }),
      }));
    // Scheduled messages (D253): read so the panel follows them.
    scheduledMessages.value;
    const scheduled = schedulesOf(session.id)
      .sort((a, b) => a.next - b.next)
      .map((x) => ({ id: x.id, label: x.label, repeat: describeRepeat(x.repeat), next: x.next }));
    const steps = session.plan.value;
    return {
      environment: {
        where: "This computer",
        folder: root ? { name: locationLabel(root), path: root, open: isOpen } : null,
        folders: isOpen
          ? workspace.folders.value
              // Not the first one: the row above is it (also for a chat kept with its
              // workspace file, D251, whose `root` is that file).
              .filter((f) => !samePath(f.path, open ?? ""))
              .map((f) => ({ name: f.name, path: f.path }))
          : [],
        branch: isOpen ? extra.branch : null,
        model: modelLabel(providers, session),
        agent,
        mode: {
          id: mode,
          label: custom ? (custom.agent?.label ?? custom.name) : (MODE_LABELS[mode] ?? mode),
        },
        outputStyle: outputStyleLabel(settings.get<string>("agent.outputStyle")),
      },
      context,
      changes,
      background: { running, finished, pullRequest, helpers, scheduled },
      plan: {
        done: steps.filter((p) => p.status === "done").length,
        total: steps.length,
        current: steps.find((p) => p.status === "in_progress")?.text ?? null,
      },
    };
  };

  /** The control for a chat: the one on screen first. */
  const controlFor = (id: string): DetailsControl | undefined => {
    const list = [...(controls.get(id) ?? [])];
    return list.find((c) => c.onScreen()) ?? list[0];
  };

  sub.add(
    dispatcher.register({
      id: "agent.toggleDetails",
      title: "Toggle chat details",
      category: "Agent",
      description:
        "Shows or hides a chat's details panel (D231): where it runs (folder, branch, model, agent, mode), how full its context window is and with what, its file changes, its background subagents and commands. Wide chat tabs show it beside the conversation (agent.detailsPanel), narrow ones as a sheet over the right edge. Without `show` it flips. Returns whether it shows.",
      input: s.object({
        session: s.string().describe("Session id (default: the active session)").optional(),
        show: s.boolean().describe("true shows it, false hides it").optional(),
      }),
      effects: [],
      run: ({ session, show }) => {
        const id = session ?? sessions.active.peek();
        const control = id ? controlFor(id) : undefined;
        if (!id || !control) throw new Error("That chat isn't open in a tab.");
        const shown = control.toggle(show);
        return { session: id, shown, layout: control.layout() };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.moveDetailsCard",
      title: "Move a chat details card",
      category: "Agent",
      description:
        "Moves one of the chat details panel's cards (environment, context, changes, background, plan) before another, or to the end without `before` (D409: what dragging a card's header does). The order holds for every chat.",
      input: s.object({
        card: s.enum(DETAILS_CARDS),
        before: s
          .enum(DETAILS_CARDS)
          .describe("The card it goes before (none: the end)")
          .optional(),
      }),
      effects: [],
      agent: "hidden",
      run: ({ card, before }) => {
        const next = moveCard(order.peek(), card, before ?? null);
        order.value = next;
        save();
        return { order: next };
      },
    }),
  );

  sub.add(
    state.register("ide://agent/details", {
      description:
        "The details panel of a chat (`?session=<id>`, default the active one, D231): where it shows (side, sheet, off) and whether it's open; environment (folder, branch, model, agent, mode), context window (used, limit, per part: messages, attachments, system prompt, rules and memory, skills, built-in and MCP tools — the split estimated), changes, background work, plan.",
      get: async (params) => {
        const id = (params as { session?: string }).session ?? sessions.active.peek();
        const session = id ? sessions.find(id) : undefined;
        if (!session) return null;
        const control = controlFor(session.id);
        const [b, limit] = await Promise.all([branch(), contextLimit(session)]);
        return {
          session: session.id,
          setting: detailsSetting(settings.peek("agent.detailsPanel")),
          layout: control?.layout() ?? null,
          shown: control?.shown() ?? false,
          folded: [...folded.peek()],
          order: [...order.peek()],
          ...data(session, { branch: b, limit }),
        };
      },
    }),
  );

  return {
    data,
    contextLimit,
    branch,
    has: (command) => dispatcher.has(command),
    folded,
    setFolded: (card, value) => {
      const next = new Set(folded.peek());
      if (value) next.add(card);
      else next.delete(card);
      folded.value = next;
      save();
    },
    order,
    setOrder: (value) => {
      order.value = sanitizeOrder(value);
      save();
    },
    hidden,
    setHidden: (value) => {
      if (hidden.peek() === value) return;
      hidden.value = value;
      save();
    },
    watchHelpers: () => {
      helperSource.value?.list.value;
    },
    watchFolders: () => {
      workspace.folders.value;
    },
    useHelpers: (helpers) => {
      helperSource.value = helpers;
    },
    attach: (session, control) => {
      let set = controls.get(session);
      if (!set) {
        set = new Set();
        controls.set(session, set);
      }
      set.add(control);
      return toDisposable(() => {
        set.delete(control);
        if (!set.size) controls.delete(session);
      });
    },
  };
}
