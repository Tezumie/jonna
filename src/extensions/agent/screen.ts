// The agent on a screen: its chat views, the model logos, the providers page, the status bar
// item and the window's own listeners. core.ts calls these steps at the points of its activation
// where the window has always done them; a run with no window has none of this.
import { dmAgent } from "../../core/agent/rooms";
import type { Json } from "../../core/dock/index";
import { on } from "../../core/dom/index";
import { clipboardIpc, dialogIpc } from "../../core/ipc/system";
import { toDisposable } from "../../core/lifecycle/index";
import { isAbsolute, relativePath } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import {
  agentFace as agentFaceElement,
  refreshModelFaces,
  setModelFaceResolver,
} from "../../ui/AgentFace";
import type { DockViewContext } from "../../workbench/dock/views";
import { AGENT_SETUP } from "./catalog";
import { chatModelKey, soloAgentOf } from "./chatAgentModel";
import { ChatsView } from "./chatsView";
import { isThisWorkspace } from "./chatWorkspace";
import type { AgentCoreParts, AgentScreenSteps } from "./core";
import { addCustomizeSection } from "./customize";
import { freeStartCard } from "./freeStart";
import { memberInfo } from "./groupChat";
import { InboxView } from "./inboxView";
import {
  chatGreeting,
  emptyState,
  modelLabel,
  showMembersAccess,
  showMembersEffort,
  showMembersModels,
  showModeMenu,
} from "./menus";
import { INBOX, resolveRoom, roomSession, roomTitle } from "./roomService";
import type { AgentSession } from "./session";
import { ROOM_VIEW } from "./threadTabs";
import { markSeen } from "./unread";
import { agentMark, providerMark, setRegistryIcons } from "./view/brandMark";
import { chatFaceElement } from "./view/groupFaces";
import { chooserContext, showModelPicker } from "./view/modelPicker";
import { setupPrompt } from "./view/setup";
import { setupPageDescriptor } from "./view/setupPage";
import { setAttachmentActions } from "./view/shots";
import { AgentView } from "./view/view";

export function agentScreen(parts: AgentCoreParts): AgentScreenSteps {
  const { services, sub, providers, sessions, setup, acpRegistry, chatDetails, dictation } = parts;
  const { dock, dispatcher, notifications, workspace } = services;
  /** A model's logo (its key; "" the default model): its agent's or its provider's. */
  const markForModel = (model: string): HTMLElement | null => {
    // The default: an external agent when new chats start on one (`acp/…` isn't in the
    // providers' list, D270), else the providers' default.
    const wanted = services.settings.peek<string>("agent.model");
    const key =
      model || (wanted?.startsWith("acp/") ? wanted : undefined) || providers.defaultModel()?.key;
    if (!key) return null;
    if (key.startsWith("acp/"))
      return agentMark(services, key.slice(4), (id) => acpRegistry.find(id)?.icon);
    const status = providers.statuses.value.find((p) => p.id === key.slice(0, key.indexOf("/")));
    return status ? providerMark(services, status) : null;
  };
  /**
   * No model to use (or the preview on demand): the empty chat says so and offers one button to
   * the AI models page, which handles every way to get one (D166).
   */
  const setupCard = (session: AgentSession): HTMLElement | null => {
    const loading = providers.statuses.peek().some((st) => st.state === "loading");
    const external = session.model.peek()?.startsWith("acp/") === true;
    const preview = setup.preview.peek() === session.id;
    if (!preview && (external || loading || providers.defaultModel())) return null;
    return setupPrompt(
      preview,
      (command) => run(command),
      freeStartCard((command) => run(command)),
      chatGreeting(services, session),
    );
  };
  const run = (command: string, input: unknown = {}) =>
    void dispatcher.execute(command, input).catch(() => {});
  let refreshed = false;
  const ensureModels = () => {
    if (refreshed) return;
    refreshed = true;
    void providers.refresh();
  };
  // A chat view: a thread or chat (the "agent" tab), or a channel's or a direct message's
  // conversation (the channel tab, D238: `room` set).
  const agentView = (state: Json, ctx: DockViewContext, room?: string) => {
    ensureModels();
    return new AgentView(state, ctx, {
      session: (st) => sessions.get((st as { session?: string } | null)?.session),
      run,
      query: (command, input) => dispatcher.execute(command, input ?? {}),
      openLink: (href) => {
        if (/^(https?:|mailto:)/i.test(href)) run("agent.openLink", { url: href });
        // In-page anchors (footnotes, #section) aren't files; a UNC or `//host` path
        // would make Windows connect to that host before any check (D161).
        else if (
          href.startsWith("#") ||
          /^(file:)?(\\\\|\/\/)/i.test(href.replace(/^file:\/\//i, "file:"))
        )
          return;
        else {
          // Links to workspace files (path, path:line or path#L42) open in the editor.
          const m = /^(.*?)(?::(\d+)|#L(\d+)(?:-L?\d+)?)?$/.exec(
            href.replace(/^file:\/\//, "").replace(/#(?!L\d).*$/, ""),
          );
          const path = m?.[1] ?? href;
          // Workspace-relative ("api/src/x.ts" in another folder of a multi-root workspace).
          run("editor.openFile", {
            path: isAbsolute(path) ? path : workspace.resolve(path),
            ...((m?.[2] ?? m?.[3]) && { line: Number(m?.[2] ?? m?.[3]) }),
          });
        }
      },
      copy: (text) =>
        void clipboardIpc.writeText(text).then(() => notifications.show("info", "Copied.")),
      root: () => workspace.root.peek() ?? "",
      relative: (path) =>
        workspace.root.peek() ? workspace.relative(path) : relativePath("", path),
      openFolder: workspace.root,
      isThisWorkspace: (stored) => {
        // Read so a banner or panel showing the answer follows the window's workspace.
        workspace.root.value;
        workspace.file.value;
        return isThisWorkspace(services, stored);
      },
      modelLabel: (s) => {
        setup.preview.value; // the first-run card shown on demand re-renders the chat
        return modelLabel(providers, s);
      },
      modelMark: (s) => {
        providers.models.value;
        if (s.members.value.length) return null;
        return markForModel(chatModelKey(s, true) ?? "");
      },
      showModelMenu: (s, a) => {
        // A group chat: its agents and their models, each changed on its own (D242).
        if (s.members.peek().length) {
          showMembersModels(services, providers, s, a);
          return;
        }
        // Opens at once with the list it has (waiting on a refresh made it lag: every
        // provider is listed again, a hosted catalog of hundreds or a dead key included);
        // models pulled meanwhile show up while it's open (D169, D227).
        showModelPicker(a, {
          services,
          registry: providers,
          session: s,
          installed: setup.installed.peek(),
          registryIcon: (id) => acpRegistry.find(id)?.icon,
          // A chat with one of the user's agents: a pick sets that agent's model (D242).
          agent: soloAgentOf(s),
        });
        void providers.refreshIfStale(30_000, 0);
      },
      // A group chat: each agent's access, as its models (D273).
      showModeMenu: (s, a) =>
        s.members.peek().length ? showMembersAccess(services, s, a) : showModeMenu(services, s, a),
      showMembersEffort: (s, a) => showMembersEffort(services, s, a),
      pickFolder: (title) => dialogIpc.pickFolder(title),
      autoRunCommands: () => services.settings.get<string>("agent.runCommands") !== "ask",
      fullAccess: () => services.settings.get<string>("agent.runCommands") === "full",
      emptyState: (s) => setupCard(s) ?? emptyState(services, providers, s),
      streamText: () => services.settings.get<boolean>("agent.streamText") !== false,
      setting: (key) => services.settings.get<unknown>(key),
      fileDropTarget: (element, drop) => services.fileDropTarget(element, drop),
      warn: (message) => services.notifications.show("warning", message),
      details: chatDetails,
      transcribe: (recording) => dictation.transcribe(recording),
      prepareVoice: () => dictation.prepare(),
      missingAgent: (s) => {
        const model = s.model.value;
        if (!model?.startsWith("acp/")) return null;
        const name = model.slice(4);
        const info = AGENT_SETUP[name];
        const found = setup.installed.value;
        if (!info) return null;
        // Looked up once when such an agent is picked.
        if (!found) {
          queueMicrotask(
            () => void services.dispatcher.execute("agent.detectTools", {}).catch(() => {}),
          );
          return null;
        }
        // Or its program is there but didn't start as an agent (an old version, another
        // program of that name): the last error says the command wasn't found or failed.
        // Only the program failing to start, not an ordinary error ("model not found").
        const program = info.program.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const failed = new RegExp(
          `ENOENT|is not recognized as an internal or external command|${program}: (command )?not found|(unknown|unexpected) (option|argument)[^\\n]*--acp`,
          "i",
        ).test(s.error.value ?? "");
        // Installed but not signed in (D192): the agent says "Authentication required".
        const signIn =
          found.get(info.program) !== false &&
          /(^|[^y] )authentication required|not (logged|signed) in|please (log|sign) ?in|run [`'"]?\S*\/login/i.test(
            s.error.value ?? "",
          );
        if (signIn)
          return {
            name,
            program: info.program,
            install: info.install,
            signIn: info.signIn,
          };
        return found.get(info.program) === false || failed
          ? {
              name,
              program: info.program,
              install: info.install,
              failed: found.get(info.program) !== false,
            }
          : null;
      },
      activated: (s) => {
        sessions.active.value = s.id;
        void providers.refreshIfStale(30000, 0);
      },
      ...(room && { room }),
      seen: (s) => markSeen(s.id, s.updated),
    });
  };
  return {
    modelFaces() {
      // Preset agents without a logo file show their registry icon (D239).
      setRegistryIcons((id) => acpRegistry.find(id)?.icon);
      // Model chips (agents, subagents, AI features) open the chat's picker (D288).
      chooserContext.registry = providers;
      chooserContext.installed = () => setup.installed.peek();
      chooserContext.registryIcon = (id) => acpRegistry.find(id)?.icon;
      sub.add(toDisposable(() => (chooserContext.registry = null)));
      // Agents show their model's logo as their face (D270): redrawn when the default model or the
      // providers change (an agent's own model changing redraws its views).
      setModelFaceResolver(markForModel);
      sub.add(
        effect(() => {
          providers.models.value;
          providers.statuses.value;
          acpRegistry.agents.value;
          acpRegistry.installedVersion.value;
          services.settings.get("agent.model");
          queueMicrotask(refreshModelFaces);
          return undefined;
        }),
      );
    },
    providersPage() {
      sub.add(
        addCustomizeSection({
          id: "models",
          label: "Providers",
          icon: "plug",
          detail:
            "Providers and models: Anthropic, OpenAI, Gemini, Ollama… or Claude Code, Codex, Copilot",
          keywords:
            "providers api keys anthropic openai gemini xai openrouter ollama claude codex copilot agents registry acp cursor goose opencode kimi qwen",
          order: 10,
          page: setupPageDescriptor({
            services,
            providers,
            setup,
            registry: acpRegistry,
            session: () => sessions.active.peek() ?? undefined,
          }),
        }),
      );
    },
    chatsView() {
      // The Chats sidebar view (D291, a plain chat list; Channels of D237 before): its id stays.
      sub.add(
        services.views.register({
          id: "agent.chats",
          title: "Chats",
          icon: "agent",
          command: "agent.showChats",
          // New chat is the view's first row (right-click it: to the side, with an agent…); the
          // title bar keeps ⋯: Sessions…, scheduled messages, providers, MCP, memory, settings.
          actions: [{ command: "agent.channelsMenu", icon: "ellipsis", title: "More", menu: true }],
          create: (host) => new ChatsView(host, services),
        }),
      );
    },
    roomView() {
      // The channel tab (D237): one channel, direct message or the Inbox at a time.
      sub.add(
        dock.views.register({
          type: ROOM_VIEW,
          // Its preview doesn't close the thread's beside it, nor the other way (D244).
          previewKind: ROOM_VIEW,
          title: (state) => roomTitle((state as { room?: string } | null)?.room ?? INBOX),
          icon: (state) => ((state as { room?: string } | null)?.room === INBOX ? "bell" : "hash"),
          iconElement: (state) => {
            const agent = dmAgent((state as { room?: string } | null)?.room ?? "");
            return agent ? agentFaceElement(memberInfo(agent).face, { size: 16 }) : undefined;
          },
          defaultPlacement: "right",
          create: (state, ctx) => {
            // A channel tab saved since D291 holds its conversation ({ session }): a plain chat.
            const savedSession = (state as { session?: unknown } | null)?.session;
            if (typeof savedSession === "string") return agentView({ session: savedSession }, ctx);
            const saved = (state as { room?: string } | null)?.room ?? INBOX;
            // A tab of a channel that's gone (archived, another folder's, an agent deleted): the
            // Inbox, rather than a new conversation for a room that isn't there (D244).
            const room = resolveRoom(saved) ?? INBOX;
            if (room === INBOX)
              return new InboxView(ctx, {
                run,
                execute: (command, input) => dispatcher.execute(command, input ?? {}),
              });
            // A channel tab saved before (D291): its conversation, as a plain chat.
            return agentView({ session: roomSession(room) }, ctx);
          },
        }),
      );
    },
    chatView() {
      sub.add(
        dock.views.register({
          type: "agent",
          previewKind: "agent",
          title: () => "Agent",
          icon: () => "agent",
          // The chat's agents (D234): open chats tell apart by their faces, and show who's busy.
          iconElement: (state) => {
            const id = (state as { session?: string } | null)?.session;
            const session = id ? sessions.find(id) : undefined;
            if (!session) return undefined;
            const status = session.status.peek();
            return chatFaceElement(
              session,
              16,
              status === "waiting" ? "waiting" : status === "running" ? "working" : "idle",
            );
          },
          // Answering: the title shimmers, as the chat's row in the sidebar does (D401).
          working: (state) => {
            const id = (state as { session?: string } | null)?.session;
            return (id ? sessions.find(id) : undefined)?.status.peek() === "running";
          },
          defaultPlacement: "right",
          create: (state, ctx) => agentView(state, ctx),
        }),
      );
    },
    attachmentActions() {
      // Download and "Add to project" in the viewer and on sent attachments (D211).
      setAttachmentActions({
        save: (attachment) =>
          void services.dispatcher
            .execute("agent.saveAttachmentAs", { attachment })
            .catch((err) =>
              services.notifications.show(
                "error",
                err instanceof Error ? err.message : String(err),
              ),
            ),
        addToProject: (attachment) =>
          void services.dispatcher
            .execute("agent.addAttachmentToProject", { attachment })
            .catch((err) =>
              services.notifications.show(
                "error",
                err instanceof Error ? err.message : String(err),
              ),
            ),
      });
      sub.add({ dispose: () => setAttachmentActions(null) });
    },
    focusCheck() {
      // Back in the window after installing an agent elsewhere (a terminal outside, an installer):
      // looked for again, so a chat that said "Install" can start without a restart (D192).
      let lastFocusCheck = 0;
      sub.add(
        on(window, "focus", () => {
          const found = setup.installed.peek();
          if (!found || Date.now() - lastFocusCheck < 5000) return;
          const missing = [...found.values()].some((v) => v === false);
          if (!missing) return;
          lastFocusCheck = Date.now();
          void services.dispatcher.execute("agent.detectTools", {}).catch(() => {});
        }),
      );
    },
    statusItem() {
      // The model list also feeds the status bar: which model answers, and whether Ollama is there.
      sub.add(
        services.statusBar.add({
          id: "agent.model",
          name: "Agent model",
          alignment: "right",
          priority: 15,
          text: () => {
            const active = sessions.active.value ? sessions.find(sessions.active.value) : undefined;
            if (!active || dock.tabs("agent").length === 0) return "";
            const busy = active.status.value !== "idle";
            return `$(bot) ${busy ? "Working…" : modelLabel(providers, active)}`;
          },
          tooltip: () => "Agent model · Select",
          command: "agent.selectModel",
        }),
      );
    },
  };
}
