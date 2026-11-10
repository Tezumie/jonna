// Agent panel menus: review/auto-apply mode, the "more" menu (checkpoints, delete), and the empty
// state. The model picker is view/modelPicker.ts (D227).

import { EFFORT_VALUES, effortLabel, findCustomMode } from "../../core/agent/chatModes";
import { greetingName, pickGreeting } from "../../core/agent/greetings";
import { MAIN_MEMBER } from "../../core/agent/groupChat";
import { h, on } from "../../core/dom/index";
import { agentFace } from "../../ui/AgentFace";
import { type MenuItem, showMenu } from "../../ui/Menu";
import type { WorkbenchServices } from "../../workbench/services";
import { locationLabel } from "../../workbench/workspace";
import { cachedSettings } from "./acp";
import { agentOwnModel, chatModelKey, soloAgentOf } from "./chatAgentModel";
import { isThisWorkspace } from "./chatWorkspace";
import { customModes } from "./customModes";
import { memberInfo } from "./groupChat";
import { OLLAMA_ID, type ProviderRegistry } from "./providers";
import type { AgentSession } from "./session";
import { subagentChoices } from "./subagents";
import { hasSavedChats } from "./threadList";

export function modelLabel(registry: ProviderRegistry, session: AgentSession): string {
  registry.models.value; // re-evaluate when the list changes
  // A group chat: each agent has its model (the pill opens the list, D242).
  if (session.members.value.length) return "Models";
  // A chat with one of the user's agents: that agent's model (D242).
  const key = chatModelKey(session, true) ?? registry.defaultModel()?.key;
  if (!key)
    return registry.statuses.value.some((s) => s.state === "loading")
      ? "Loading models…"
      : "No model";
  if (key.startsWith("acp/")) {
    // An external agent shows the model it runs on (D193). Until it has said (it takes a few
    // seconds to start), what it reported last time and the model chosen for it then (D269).
    const name = key.slice(4);
    const live = session.agentSettings.value;
    const isLive = live?.agent === name;
    const model = (isLive ? live.settings : cachedSettings(name))?.find(
      (s) => s.category === "model",
    );
    const remembered = isLive
      ? undefined
      : session.services.settings.peek<Record<string, Record<string, string>>>(
          "agent.externalAgentChoices",
        )?.[name]?.model;
    // A chat with one of your agents that has its own model of this external agent (D288: Plato
    // on Claude Code · Sonnet): that's what answers (the connection switches at the turn).
    const agent = soloAgentOf(session, true);
    const own = agent
      ? session.services.settings.get<Record<string, { model?: string; agentModel?: string }>>(
          "agent.subagents",
        )?.[agent]
      : undefined;
    const ownModel = own?.model === key ? own.agentModel : undefined;
    const current = ownModel ?? remembered ?? model?.current;
    const chosen = model?.options.find((o) => o.id === current);
    return chosen?.id ? `${name} · ${chosen.name}` : name;
  }
  return key.slice(key.indexOf("/") + 1);
}

/** A model key as the pill says it: an external agent's name, else the model's name. */
function shortModel(key: string): string {
  return key.startsWith("acp/") ? key.slice(4) : key.slice(key.indexOf("/") + 1);
}

/**
 * A group chat's model pill (D242): each of its agents with the model it runs on (its own, or the
 * chat's); picking one changes that agent's model, the main agent's being the chat's.
 */
export function showMembersModels(
  services: WorkbenchServices,
  registry: ProviderRegistry,
  session: AgentSession,
  anchor: HTMLElement,
): void {
  const run = (command: string, input: unknown) => () =>
    void services.dispatcher.execute(command, input).catch(() => {});
  const chat = session.model.peek() ?? registry.defaultModel()?.key ?? "";
  const sameAsChat = chat ? `Same as the chat (${shortModel(chat)})` : "Same as the chat";
  showMenu(
    anchor,
    [
      ...session.members.peek().map((name) => {
        const info = memberInfo(name);
        const own = name === MAIN_MEMBER ? null : agentOwnModel(name);
        return {
          label: info.label,
          keybinding:
            name === MAIN_MEMBER
              ? shortModel(chat) || "No model"
              : own
                ? shortModel(own)
                : sameAsChat,
          iconElement: () => agentFace(info.face, { size: 16 }),
          run:
            name === MAIN_MEMBER
              ? run("agent.chooseModel", { for: "main" })
              : run("agent.chooseModel", { for: `subagent:${name}` }),
        };
      }),
      {
        label: "Agents and models…",
        icon: "settings",
        separatorBefore: true,
        run: run("agent.showAgentConfig", {}),
      },
    ],
    "Each agent's model",
  );
}

/** What the chat may do on its own, as its access pill says it. */
export function accessLabel(services: WorkbenchServices, session: AgentSession): string {
  const full = services.settings.peek<string>("agent.runCommands") === "full";
  const apply = session.autoApply.peek();
  // Auto with Review edits picked after it: the label says so (D273: "Auto" that asked).
  return full ? (apply ? "Auto" : "Auto, review edits") : apply ? "Accept edits" : "Review";
}

export function showModeMenu(
  services: WorkbenchServices,
  session: AgentSession,
  anchor: HTMLElement,
): void {
  showMenu(anchor, modeItems(services, session), "Agent mode");
}

/** The chat's access: its edits, and commands (for every chat). */
function modeItems(services: WorkbenchServices, session: AgentSession): MenuItem[] {
  const set = (auto: boolean) => () =>
    void services.dispatcher
      .execute("agent.setMode", { session: session.id, autoApply: auto })
      .catch(() => {});
  // Terminal commands (D117): ask (allowlist) or run automatically (risky ones still ask).
  const commandMode = services.settings.peek<string>("agent.runCommands") ?? "ask";
  const commands = (mode: "ask" | "auto" | "full") => () => {
    void services.dispatcher.execute("agent.setCommandMode", { mode }).catch(() => {});
    // Full access is for walking away: edits apply too (checkpointed), nothing waits on review.
    if (mode === "full") set(true)();
  };
  return [
    { label: "Review edits", checked: !session.autoApply.peek(), run: set(false) },
    { label: "Accept edits (checkpointed)", checked: session.autoApply.peek(), run: set(true) },
    {
      label: "Ask before commands",
      checked: commandMode === "ask",
      separatorBefore: true,
      run: commands("ask"),
    },
    {
      label: "Run commands automatically",
      checked: commandMode === "auto",
      run: commands("auto"),
    },
    {
      label: "Auto: full access, never ask",
      checked: commandMode === "full",
      run: commands("full"),
    },
  ];
}

/**
 * A group chat's effort pill (D273): each of its agents with its reasoning effort (its own, or
 * the chat's); the main agent's is the chat's (agent.effort).
 */
export function showMembersEffort(
  services: WorkbenchServices,
  session: AgentSession,
  anchor: HTMLElement,
): void {
  const run = (command: string, input: unknown) => () =>
    void services.dispatcher.execute(command, input).catch(() => {});
  const chat = services.settings.peek<string>("agent.effort") || "default";
  const choices = subagentChoices(services);
  showMenu(
    anchor,
    session.members.peek().map((name) => {
      const info = memberInfo(name);
      const own = name === MAIN_MEMBER ? null : (choices[name]?.effort ?? null);
      return {
        label: info.label,
        keybinding: own
          ? effortLabel(own)
          : name === MAIN_MEMBER
            ? effortLabel(chat)
            : `Same as the chat (${effortLabel(chat)})`,
        iconElement: () => agentFace(info.face, { size: 16 }),
        submenu:
          name === MAIN_MEMBER
            ? EFFORT_VALUES.map((e) => ({
                label: effortLabel(e),
                checked: chat === e,
                run: run("settings.set", { key: "agent.effort", value: e }),
              }))
            : [
                {
                  label: "Same as the chat",
                  checked: !own,
                  run: run("agent.setSubagent", { name, effort: "" }),
                },
                ...EFFORT_VALUES.filter((e) => e !== "default").map((e, i) => ({
                  label: effortLabel(e),
                  checked: own === e,
                  ...(i === 0 && { separatorBefore: true }),
                  run: run("agent.setSubagent", { name, effort: e }),
                })),
              ],
      };
    }),
    "Each agent's effort",
  );
}

/**
 * A group chat's access pill (D273): each of its agents with what it may do (the chat's, or its
 * own: its edits kept, or reading only); the main agent's is the chat's.
 */
export function showMembersAccess(
  services: WorkbenchServices,
  session: AgentSession,
  anchor: HTMLElement,
): void {
  const run = (command: string, input: unknown) => () =>
    void services.dispatcher.execute(command, input).catch(() => {});
  const chat = accessLabel(services, session);
  const choices = subagentChoices(services);
  showMenu(
    anchor,
    session.members.peek().map((name) => {
      const info = memberInfo(name);
      if (name === MAIN_MEMBER)
        return {
          label: info.label,
          keybinding: chat,
          iconElement: () => agentFace(info.face, { size: 16 }),
          submenu: modeItems(services, session),
        };
      const own = choices[name]?.access;
      const mode = findCustomMode(customModes.peek(), `custom:${name}`);
      // What it does now: the user's pick, else its file's, else the chat's.
      const now = mode?.readOnly
        ? "Read only"
        : mode?.acceptEdits
          ? "Accept edits"
          : `Same as the chat (${chat})`;
      return {
        label: info.label,
        keybinding: now,
        iconElement: () => agentFace(info.face, { size: 16 }),
        submenu: [
          {
            label: "Its default",
            checked: !own,
            run: run("agent.setSubagent", { name, access: "" }),
          },
          {
            label: "Accept edits (checkpointed)",
            checked: own === "edit",
            separatorBefore: true,
            run: run("agent.setSubagent", { name, access: "edit" }),
          },
          {
            label: "Read only",
            checked: own === "read",
            run: run("agent.setSubagent", { name, access: "read" }),
          },
        ],
      };
    }),
    "Each agent's access",
  );
}

export function showMoreMenu(
  services: WorkbenchServices,
  session: AgentSession,
  anchor: HTMLElement,
): void {
  const run =
    (command: string, input: unknown = {}) =>
    () =>
      void services.dispatcher.execute(command, input).catch(() => {});
  const turns = [...session.checkpoints].sort((a, b) => b - a);
  const userTurns = session.items.filter(
    (i): i is Extract<(typeof session.items)[number], { type: "user" }> =>
      i.type === "user" && !i.auto,
  );
  // The message that started turn `t`: by its recorded turn (retries and edits skip numbers,
  // D160); chats saved before that by position.
  const turnLabel = (t: number) => {
    const m =
      userTurns.find((u) => u.turn === t && !u.steer) ??
      (userTurns.some((u) => u.turn !== undefined) ? undefined : userTurns[t - 1]);
    return (m?.text ?? "").replace(/\s+/g, " ").slice(0, 40);
  };
  showMenu(
    anchor,
    [
      { label: "New session", icon: "plus", run: run("agent.newSession") },
      { label: "Sessions…", icon: "history", run: run("agent.showHistory") },
      // Parallel agents and second opinions (D193).
      // Shown in every folder (D194): without git they say what they need.
      {
        label: "New agent in a worktree…",
        icon: "folder-git-2",
        disabled: services.context.get("gitRepo") !== true,
        ...(services.context.get("gitRepo") !== true && { keybinding: "needs a git repository" }),
        run: run("agent.startInWorktree"),
      },
      {
        label: "Best of N…",
        icon: "layers",
        disabled: services.context.get("gitRepo") !== true,
        run: run("agent.bestOfN"),
      },
      {
        // The overview: state, files changed, elapsed, PORT (D204).
        label: "Worktree agents",
        icon: "git-branch",
        disabled: services.context.get("gitRepo") !== true,
        run: run("agent.worktreeAgents"),
      },
      {
        // D227: the agent commits the chat's work and opens the pull request from it.
        label: session.pullRequest.peek()?.number
          ? `Pull request #${session.pullRequest.peek()?.number}`
          : "Open pull request",
        icon: "git-pull-request",
        disabled: services.context.get("gitRepo") !== true,
        run: session.pullRequest.peek()?.number
          ? run("github.openPullRequest", { number: session.pullRequest.peek()?.number })
          : run("agent.createPullRequest", { session: session.id }),
      },
      {
        label: "Review changes",
        icon: "eye",
        submenu: [
          {
            label: "Uncommitted changes…",
            run: run("agent.reviewChanges", { scope: "uncommitted" }),
          },
          { label: "Staged changes…", run: run("agent.reviewChanges", { scope: "staged" }) },
          {
            label: "This branch…",
            run: run("agent.reviewChanges", { scope: "branch" }),
          },
          {
            label: "This chat's pending edits…",
            disabled: session.changeset.files.peek().length === 0,
            run: run("agent.reviewChanges", { scope: "pending", session: session.id }),
          },
        ],
      },
      { label: "MCP servers…", icon: "server", run: run("agent.showMcpPage") },
      { label: "Auto-approve…", icon: "shield", run: run("agent.showAutoApprove") },
      { label: "Docs for @docs…", icon: "book-open", run: run("agent.showDocs") },
      // Which rules files the agent follows, and why (D200).
      { label: "Rules…", icon: "book-open", run: run("agent.showRules") },
      // Subagents and each part's model (D195).
      { label: "Configure agents…", icon: "bot", run: run("agent.showAgentConfig") },
      // Tokens, cost and limits across chats (D201).
      { label: "Usage", icon: "chart-column", run: run("agent.showUsage") },
      // D253: a message for this chat's agent later, or on repeat.
      {
        label: "Schedule a message…",
        icon: "clock",
        run: run("agent.schedule", { session: session.id }),
      },
      ...(session.backgroundCount.peek() > 0
        ? [
            {
              label: `Stop background subagents (${session.backgroundCount.peek()})`,
              icon: "square" as const,
              run: run("agent.stopSubagents", { session: session.id }),
            },
          ]
        : []),
      {
        label: "Rename chat…",
        icon: "pencil",
        disabled: session.items.length === 0,
        run: run("agent.renameSession", { session: session.id }),
      },
      ...(session.folder.peek()
        ? [
            {
              // A folder, or a multi-root workspace's file (D251).
              label: `Open ${locationLabel(session.folder.peek() ?? "")}`,
              icon: "folder-open" as const,
              disabled: isThisWorkspace(services, session.folder.peek()),
              run: run("agent.openChatFolder", { session: session.id }),
            },
          ]
        : []),
      {
        label: "Restore checkpoint",
        icon: "rotate-ccw",
        disabled: turns.length === 0,
        submenu: turns.length
          ? turns.map((t) => ({
              label: `Before turn ${t}: ${turnLabel(t)}`,
              run: run("agent.restoreCheckpoint", { session: session.id, turn: t }),
            }))
          : undefined,
        separatorBefore: true,
      },
      {
        label: "Export as Markdown",
        icon: "file-text",
        separatorBefore: true,
        disabled: session.items.length === 0,
        run: run("agent.exportMarkdown", { session: session.id }),
      },
      {
        label: "Copy conversation",
        icon: "copy",
        disabled: session.items.length === 0,
        run: run("agent.exportMarkdown", { session: session.id, copy: true }),
      },
      {
        label: "Close what the agent opened",
        icon: "x",
        keybinding: services.keyboard.labelFor("agent.closeOpened") ?? undefined,
        run: run("agent.closeOpened", { session: session.id }),
      },
      {
        label: "Tidy up agent memory",
        icon: "bookmark",
        run: run("agent.dream", { wait: false }),
      },
      {
        label: "Agent settings",
        icon: "settings",
        separatorBefore: true,
        run: run("settings.open", { category: "Agent" }),
      },
      {
        label: "Delete session",
        icon: "trash-2",
        destructive: true,
        separatorBefore: true,
        run: run("agent.deleteSession", { session: session.id }),
      },
    ],
    "Agent",
  );
}

/** The account's first name for greetings, read now and then (the account can change). */
let accountName: string | null = null;
let accountAsked = 0;

/** Each chat keeps its greeting while it's empty (it isn't picked again on every redraw). */
const greetings = new WeakMap<AgentSession, { key: string; text: string }>();

/** An empty chat's greeting (D240): a short line, random, with the user's name when known. */
export function chatGreeting(services: WorkbenchServices, session: AgentSession): string {
  if (Date.now() - accountAsked > 60_000) {
    accountAsked = Date.now();
    void services.state
      .get("ide://accounts")
      .then((snap) => {
        const profile = (snap.value as { ide?: { profile?: { name?: string } | null } } | null)?.ide
          ?.profile;
        accountName = greetingName(profile?.name);
      })
      .catch(() => {});
  }
  const place = services.workspace.root.peek() ? "project" : "new";
  // Kept per place only: a name read after the first draw doesn't swap the line (D244).
  const key = place;
  const kept = greetings.get(session);
  if (kept?.key === key) return kept.text;
  // A brand-new user (no saved chats yet) isn't welcomed back.
  const text = pickGreeting(place, accountName, hasSavedChats.peek());
  greetings.set(session, { key, text });
  return text;
}

/**
 * An empty chat (D240): a greeting, as chat apps have it. Only when no model can answer yet does it
 * say what's missing, with the buttons to fix it.
 */
export function emptyState(
  services: WorkbenchServices,
  registry: ProviderRegistry,
  session: AgentSession,
): HTMLElement {
  const title = h("div", { class: "agent-empty-title" }, chatGreeting(services, session));
  const external = session.model.peek()?.startsWith("acp/") === true;
  const choice =
    (session.model.peek() && registry.find(session.model.peek() as string)) ||
    registry.defaultModel();
  if (external || choice) return h("div", { class: "agent-empty" }, title);
  const ollama = registry.statuses.peek().find((s) => s.id === OLLAMA_ID);
  const loading = registry.statuses.peek().some((s) => s.state === "loading");
  let text: string;
  let action: HTMLElement | null = null;
  if (loading) text = "Looking for models…";
  else if (ollama?.state === "unreachable") {
    text =
      "No model found. Install and start Ollama, then pull a model (e.g. `ollama pull qwen3:8b`) — it appears here automatically. Or add an OpenAI-compatible provider.";
    action = h(
      "button",
      { class: "button button-secondary button-sm", type: "button" },
      "Get Ollama",
    );
    on(
      action,
      "click",
      () =>
        void services.dispatcher
          .execute("agent.openLink", { url: "https://ollama.com/download" })
          .catch(() => {}),
    );
  } else text = "No models yet. Pull one with `ollama pull qwen3:8b`, then refresh.";
  const retry = h(
    "button",
    { class: "button button-ghost button-sm", type: "button" },
    "Refresh models",
  );
  on(retry, "click", () => void services.dispatcher.execute("agent.refreshModels").catch(() => {}));
  return h(
    "div",
    { class: "agent-empty" },
    title,
    h("div", { class: "agent-empty-text" }, text),
    h("div", { class: "agent-empty-actions" }, action, retry),
  );
}
