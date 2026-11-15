// Built-in agent (PLAN §8, DESIGN §13): sessions as dock tabs ("agent" view), models from Ollama
// (automatic) and OpenAI-compatible providers, the core toolset with changeset review, inline
// permission cards (for run_command and for IDE commands the agent calls), checkpoints and
// transcripts in app data. State: ide://agent (sessions) and ide://agent/session (the active one).

import { alwaysPattern } from "../../core/agent/autoApprove";
import type { ChatImage } from "../../core/agent/chatImages";
import { memoryIndex, notesIn, noteTypes } from "../../core/agent/memory";
import { chaptersOf, latestWrapUp, proposalsOf } from "../../core/agent/turnTools";
import type { BuiltinExtension, ExtensionContext } from "../../core/extensions/index";
import { agentStoreIpc } from "../../core/ipc/agent";
import type { DisposableStore } from "../../core/lifecycle/index";
import { samePath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { setAgentPermissionHandler } from "../../workbench/permissionPrompts";
import type { WorkbenchServices } from "../../workbench/services";
import { registerAgentSlashCommands, registerIdeToolsState } from "./acp";
import { registerAcpRegistry } from "./acpRegistry";
import { registerAgentConfig } from "./agentConfig";
import { registerAgentEditor } from "./agentEditorCommands";
import { registerAiFeatures } from "./aiFeatures";
import {
  browserDecision,
  browserUrl,
  registerAutoApprove,
  saveAlways,
  webDecision,
} from "./autoApprove";
import { registerBackgroundNews } from "./backgroundNews";
import { backgroundProcesses } from "./backgroundProcesses";
import { registerBackgroundTasks } from "./backgroundTasks";
import { registerRecordingCommands } from "./browserRecorder";
import { registerChatCommands } from "./chatCommands";
import { registerChatDetails } from "./chatDetails";
import { registerChatFlow } from "./chatFlow";
import { generateImageTool } from "./chatImageTools";
import { registerChatPullRequests } from "./chatPullRequests";
import { registerChatWorktrees } from "./chatWorktrees";
import { registerCheckpointCommands } from "./checkpointCommands";
import { registerCodeBlockCommands } from "./codeBlocks";
import { codebaseSearchTool, registerCodeIndex } from "./codeIndex";
import { registerAgentCommands } from "./commands";
import { registerCommandsPage } from "./commandsPage";
import { registerComputerUse } from "./computerTool";
import { registerCustomize } from "./customize";
import { registerCustomModes } from "./customModes";
import { deferredState } from "./deferredTools";
import { registerDictation } from "./dictation";
import { registerDiscoveryCommands } from "./discoveryCommands";
import { registerDocs } from "./docs";
import { registerDocsPage } from "./docsPage";
import manifest from "./extension.json";
import { registerFollowAgent } from "./follow";
import { registerFreeStart } from "./freeStart";
import { registerGroupChat, soloSpeaker } from "./groupChat";
import { registerHooks } from "./hooks";
import { registerHostPromptCommands } from "./hostPromptCommands";
import { registerAgentIgnore } from "./ignore";
import { registerInlineReview } from "./inlineReview";
import { registerIsolatedHelpers, sendToHelper } from "./isolatedHelpers";
import { createLanguageModel } from "./languageModel";
import { registerMainAgent } from "./mainAgent";
import { registerMcpClients } from "./mcp";
import { registerMcpFeatures } from "./mcpFeatures";
import { registerMcpPage } from "./mcpPage";
import { registerMcpSampling } from "./mcpSampling";
import { memoryFor } from "./memory";
import { registerModelChoices } from "./modelChoices";
import { registerNewChatMenu } from "./newChatMenu";
import { registerOpenedTracking } from "./opened";
import { registerOutputStyles } from "./outputStyles";
import { commandDenied, DEFAULT_DENIED_COMMANDS } from "./permissions";
import { registerPhoneNotify } from "./phoneNotify";
import { registerPlugins } from "./plugins";
import { registerPluginsPage } from "./pluginsPage";
import { registerProcessCommands } from "./processCommands";
import { ProviderRegistry } from "./providers";
import { registerRepoMap } from "./repoMap";
import { registerRiskyGuard } from "./riskyGuard";
import { registerRooms } from "./roomService";
import { registerRules } from "./rules";
import { registerRulesPage } from "./rulesPage";
import { setAgentRuntime } from "./runtime";
import { registerSandbox } from "./sandboxRun";
import { registerSchedules } from "./schedules";
import type { AgentSession } from "./session";
import { SessionManager } from "./sessions";
import { registerSetupCommands, SetupState } from "./setupCommands";
import { registerSkillCatalog } from "./skillCatalog";
import { registerSkills } from "./skills";
import { registerSkillsPage } from "./skillsPage";
import { registerSlashBuiltins } from "./slashBuiltins";
import { registerStatusLine } from "./statusLine";
import { registerSubagents } from "./subagents";
import { registerThreadList } from "./threadList";
import { setEmptyThreadCheck } from "./threadTabs";
import { latestFindings, pendingQuestions, registerToolCardCommands } from "./toolCardCommands";
import { registerTurnCommands } from "./turnCommands";
import { registerUnread } from "./unread";
import { registerUploadCommands } from "./uploads";
import { registerUsageState } from "./usage";
import { registerUsageLog } from "./usageLog";
import { registerUsagePage } from "./usagePage";
import { registerWebFetch } from "./webFetch";
import { registerWebSearch, webFetchTool, webSearchTool } from "./webSearch";
import { registerWidgets } from "./widgets";
import { registerWorkflows } from "./workflows";
import { registerWorktreeAgents } from "./worktreeAgents";
import { registerWorktreePages } from "./worktreePages";

/** IDE commands that run a command line in a shell: the field holding it. */
const SHELL_LINE_INPUT: Record<string, string> = {
  "terminal.sendText": "text",
  "terminal.runCommand": "command",
  "terminal.start": "command",
};

/** A chat image in ide://agent/session (D381): what it is, without its bytes. */
const imageState = (img: ChatImage) => ({
  id: img.id,
  mime: img.mime,
  ...(img.name && { name: img.name }),
  ...(img.source && { source: img.source }),
});

/** What the agent's setup hands the part that draws (screen.ts). */
export interface AgentCoreParts {
  services: WorkbenchServices;
  /** The extension's subscriptions: what the screen registers ends with the extension. */
  sub: DisposableStore;
  providers: ProviderRegistry;
  sessions: SessionManager;
  setup: SetupState;
  acpRegistry: ReturnType<typeof registerAcpRegistry>;
  chatDetails: ReturnType<typeof registerChatDetails>;
  dictation: ReturnType<typeof registerDictation>;
}

/**
 * What only a screen has, as the steps of the activation that register it: each is called where
 * the window's activation has always done that part (registration order is kept as it was).
 */
export interface AgentScreenSteps {
  /** Model logos: registry icons, the model chips' picker, agents' faces. */
  modelFaces(): void;
  /** The Providers section of the Customize page. */
  providersPage(): void;
  /** The Chats sidebar view. */
  chatsView(): void;
  /** The channel tab. */
  roomView(): void;
  /** The chat tab. */
  chatView(): void;
  /** Download and "Add to project" on attachments. */
  attachmentActions(): void;
  /** Looks for installed agents again when the window gets the focus back. */
  focusCheck(): void;
  /** The status bar's model item. */
  statusItem(): void;
}

/**
 * The agent's setup: sessions, providers, hooks, MCP, subagents, skills, workflows, the
 * permission handler, every command and `ide://agent` state path. It needs no screen: the
 * window passes `makeScreen` (screen.ts) for its views, a run with no window passes null. The
 * agent's host (agentHost.ts) is set by the caller before this runs.
 */
export function activateAgentCore(
  { subscriptions: sub, services }: ExtensionContext<WorkbenchServices>,
  makeScreen: ((parts: AgentCoreParts) => AgentScreenSteps) | null,
): void {
  {
    const { dock, dispatcher, state, settings, workspace } = services;
    const providers = new ProviderRegistry(services);
    Object.assign(services.languageModel, createLanguageModel(services, providers));
    const sessions = sub.add(new SessionManager(services, providers));
    // For a host that isn't the window (runtime.ts): a chat's events, its signals.
    setAgentRuntime(services, { sessions, providers });
    sub.add({ dispose: () => setAgentRuntime(services, null) });
    // The user's hooks on the agent's events (D227).
    sessions.hooks = registerHooks(sub, services);
    // The user's own chat modes (D227).
    registerCustomModes(sub, services);
    registerMainAgent(services, sub);
    registerAiFeatures(sub, services);
    // Pull requests from a chat (D227).
    registerChatPullRequests(sub, services, sessions);
    // The chat's details panel (D231): agent.toggleDetails, ide://agent/details.
    const chatDetails = registerChatDetails(sub, services, sessions, providers);
    // Dictation (D180, D384): this computer's speech model or a service with a key.
    const dictation = registerDictation(sub, services, providers);
    // Slash commands that act on a chat: /undo, /btw, /context… (D389).
    registerSlashBuiltins(sub, services, providers, sessions);
    // The repository map each chat starts with (D174).
    const repoMap = sub.add(registerRepoMap(services));
    // AI setup (D164): the "AI models" page and the first-run card in an empty chat.
    const setup = new SetupState();
    registerSetupCommands(sub, services, providers, setup);
    // External agents from the ACP agent registry (D215): the gallery on the Models page.
    const acpRegistry = registerAcpRegistry(sub, services, sessions);
    // What only a screen has (screen.ts), made here and called step by step below, each where the
    // window has always done it. Model logos first: preset agents' registry icons, the chips'
    // picker, agents' faces.
    const screen =
      makeScreen?.({
        services,
        sub,
        providers,
        sessions,
        setup,
        acpRegistry,
        chatDetails,
        dictation,
      }) ?? null;
    screen?.modelFaces();
    registerCustomize(sub, services);
    screen?.providersPage();

    // The Chats sidebar view (D291, a plain chat list; Channels of D237 before): its id stays.
    screen?.chatsView();
    registerUnread(sub, services);
    registerFreeStart(sub, services);
    registerThreadList(sub, services, sessions);
    // A chat whose tab may be reused: nothing in it, nothing typed or attached, no message
    // waiting for a folder (D244).
    setEmptyThreadCheck((id) => {
      const session = id ? sessions.find(id) : undefined;
      return (
        !!session &&
        session.items.length === 0 &&
        session.status.peek() === "idle" &&
        !session.folderRequest.peek() &&
        !session.draft.peek()?.trim() &&
        !session.attachments.peek().length &&
        !session.uploads.peek().length
      );
    });
    registerRooms(sub, services, sessions);
    // The channel tab (D237): one channel, direct message or the Inbox at a time.
    screen?.roomView();
    sub.add(
      dispatcher.register({
        id: "agent.showChats",
        title: "Show chats",
        category: "View",
        description:
          "Shows the Chats sidebar view (D291): this folder's chats, newest first, and other folders' saved ones.",
        input: s.empty(),
        effects: [],
        agent: "hidden",
        run: async (_input, ctx) => {
          await ctx.execute("view.show", { id: "agent.chats" });
        },
      }),
    );

    // The chat tab (the "agent" view).
    screen?.chatView();

    registerAgentCommands(sub, services, sessions, providers);
    registerToolCardCommands(sub, services, sessions);
    // Inline widgets (D334): their tab, commands, theme and ide://agent/widgets.
    registerWidgets(sub, services, sessions);
    // Output styles (D356) and the status line command (D357).
    registerOutputStyles(sub, services);
    registerStatusLine(sub, services, sessions, providers);
    registerCodeBlockCommands(sub, services, sessions);
    registerChatCommands(sub, services, sessions);
    registerTurnCommands(sub, services, sessions);
    registerGroupChat(sub, services, sessions);
    registerNewChatMenu(sub, services, sessions);
    registerCheckpointCommands(sub, services, sessions);
    // The Rules page (D204): edit, turn off, create from templates.
    registerRulesPage(sub, services, registerRules(sub, services, sessions));
    registerWebFetch(sub, services);
    registerWebSearch(sub, services);
    registerUploadCommands(sub, services, sessions);
    // Browser recordings (D340): Save, and ide://agent/recordings.
    registerRecordingCommands(sub, services);
    // Desktop control (D353): the computer tool's grants, stop banner and ide://agent/computerUse.
    registerComputerUse(sub, services, sessions);
    // The model settings as dropdowns in the Settings editor (D216).
    for (const d of registerModelChoices(services, providers)) sub.add(d);
    // Download and "Add to project" in the viewer and on sent attachments (D211).
    screen?.attachmentActions();
    registerProcessCommands(sub, services, sessions);
    const mcpClients = registerMcpClients(sub, services, sessions);
    // D200: MCP prompts, resources and elicitation; external agents' own slash commands.
    registerMcpFeatures(sub, services, sessions, mcpClients);
    // D204: sampling, the MCP servers page with its gallery and sign-in, auto-approve.
    registerMcpSampling(sub, services, sessions, providers, mcpClients);
    registerMcpPage(sub, services, sessions, mcpClients);
    // D342, D343: the discovery cards' Add / Reconnect, the skill catalog.
    registerDiscoveryCommands(sub, services, sessions, mcpClients);
    registerSkillCatalog(sub, services);
    registerCommandsPage(sub, services);
    registerAutoApprove(sub, services, mcpClients);
    // D213: Downloads and the like ask first; other agents' config files always ask.
    registerRiskyGuard(sub, services);
    // D336, D348–D350: the command sandbox (agent.sandbox, ide://agent/sandbox), its card's Allow.
    registerSandbox(sub, services, sessions);
    registerDocsPage(sub, services, registerDocs(sub, services, providers));
    sub.add(registerAgentSlashCommands());
    sub.add(registerIdeToolsState(services));
    // D204: the worktree agents' overview and compare pages.
    const worktreeAgents = registerWorktreeAgents(sub, services, sessions, providers);
    registerWorktreePages(sub, services, worktreeAgents);
    // Subagents (D195): the delegate tool joins the MCP tools; their files load before a turn.
    const subagents = registerSubagents(sub, services, sessions);
    // D231: delegate with isolated → a helper in a worktree of its own.
    const helpers = registerIsolatedHelpers(sub, services, sessions, worktreeAgents);
    // D337: the chat itself in a worktree (enter_worktree / exit_worktree).
    registerChatWorktrees(sub, services, sessions, worktreeAgents);
    subagents.isolated = helpers;
    subagents.messageHelper = (id, text) => sendToHelper(helpers, id, text);
    chatDetails.useHelpers(subagents.isolated);
    // D326: the Background tasks view (subagents, helpers, commands, monitors) and its chip.
    registerBackgroundTasks(sub, services, sessions, helpers);
    const mcpTools = sessions.extraTools;
    const mcpPrepare = sessions.prepare;
    // web_search (D200) and web_fetch (D292) go with web reading: off with agent.webFetch.enabled.
    const searchTool = webSearchTool();
    const fetchTool = webFetchTool();
    // codebase_search (D227) only with the codebase index on.
    const codeIndex = registerCodeIndex(sub, services, providers);
    const codeSearchTool = codebaseSearchTool(codeIndex);
    // generate_image (D381): an image model makes pictures for the chat and the project.
    const imageTool = generateImageTool(services, providers, (id) => {
      const s = sessions.find(id);
      return s ? { model: s.model.peek(), items: s.items } : null;
    });
    sessions.extraTools = (session) => [
      ...mcpTools(session),
      // The agent answering: its subagents (D288).
      ...subagents.tools(session && (session.turnSpeaker ?? soloSpeaker(session.chatMode.peek()))),
      ...(settings.peek<boolean>("agent.webFetch.enabled") === false
        ? []
        : [searchTool, fetchTool]),
      ...(codeIndex.enabled() ? [codeSearchTool] : []),
      ...(settings.peek<boolean>("agent.imageGeneration.enabled") === false ? [] : [imageTool]),
    ];
    sessions.prepare = async (session) => {
      await Promise.all([mcpPrepare(session), subagents.refresh()]);
    };
    registerSkillsPage(sub, services, registerSkills(sub, services, sessions, subagents));
    // D358, D360: Claude Code plugins; the notify message to the user's phone.
    registerPluginsPage(sub, services, registerPlugins(sub, services, subagents, mcpClients));
    registerPhoneNotify(sub, services);
    // D253: scheduled messages (the schedule tool, agent.schedule, ide://agent/schedules).
    const schedules = registerSchedules(sub, services, sessions);
    // D322, D323, D325: monitors, pull request watches, messages between chats.
    registerBackgroundNews(sub, services, sessions);
    // D338: workflow scripts run subagents from a script (run_workflow).
    registerWorkflows(sub, services, sessions, subagents);
    // D329-D333: hand-offs, plan documents, chat search, loops, the guide.
    registerChatFlow(sub, services, sessions, schedules);
    registerAgentConfig(sub, services, providers, subagents, sessions);
    // D230: the agent editor tab, agent.newAgent / editAgent / duplicateAgent, ide://agent/agents.
    registerAgentEditor(sub, services, providers, subagents);
    registerInlineReview(sub, services, sessions);
    registerAgentIgnore(sub, services);
    const opened = registerOpenedTracking(sub, services);
    // Follow the agent (D383): its edits open in the editor while agent.followEdits is on.
    registerFollowAgent(sub, services, () => sessions.active.peek());

    // The edit mode is remembered per workspace (D153).
    sub.add(
      services.persistence.register("agent.mode", {
        save: () => ({ autoApply: sessions.autoApply }),
        restore: (data) => {
          sessions.autoApply = (data as { autoApply?: unknown } | null)?.autoApply === true;
          // Chats not started yet take it (a saved chat keeps its own).
          for (const s of sessions.all())
            if (s.items.length === 0) s.autoApply.value = sessions.startsApplying();
        },
      }),
    );

    // Back in the window after installing an agent elsewhere: looked for again (D192).
    screen?.focusCheck();

    // Commands an agent calls (call_command) that change something are asked inline, in the
    // conversation of the session that called them.
    setAgentPermissionHandler(async (request) => {
      const session = sessions.find(request.session);
      if (!session) return "deny";
      const danger = request.effects.includes("destructive");
      // Web reading turned off: refused before anyone is asked (D179).
      // Searching (web.search, D200) follows the same two settings.
      const web = request.commandId === "web.fetch" || request.commandId === "web.search";
      if (web && settings.peek<boolean>("agent.webFetch.enabled") === false) return "deny";
      // Per-category auto-approve by domain (D204): Allow goes ahead, Ask always asks.
      const byDomain = web
        ? webDecision(services, request.input)
        : request.commandId.startsWith("browser.")
          ? await browserDecision(services, request.input)
          : null;
      // "Always" on a site's question saves its domain as Allow (D207, agent.autoApprove).
      const browser = request.commandId.startsWith("browser.");
      const siteUrl =
        web || browser
          ? web
            ? typeof (request.input as { url?: unknown } | null)?.url === "string"
              ? (request.input as { url: string }).url
              : null
            : await browserUrl(services, request.input)
          : null;
      const site = siteUrl ? alwaysPattern(web ? "web" : "browser", siteUrl) : null;
      const remember = async (answer: "once" | "always" | "deny") => {
        if (answer === "always" && siteUrl)
          await saveAlways(services, web ? "web" : "browser", siteUrl, (t) => session.addNotice(t));
        return answer === "always" ? "once" : answer;
      };
      if (byDomain === "ask") {
        const answer = await session.ask({
          title: `${web ? "Web" : "Browser"}: ${request.title}`,
          heading: request.title,
          code: request.commandId,
          kind: "ide",
          detail: "agent.autoApprove says to ask on this site.",
          ...(site && !danger && { always: site }),
          danger,
          evenWithFullAccess: true,
        });
        return remember(answer);
      }
      if (byDomain === "allow" && !danger) return "once";
      // Web pages without asking, when the user chose that (agent.webFetch.autoApprove, D179).
      if (web && settings.peek<boolean>("agent.webFetch.autoApprove") === true) return "once";
      // Browser protection (D179): page actions always ask, whatever the mode.
      if (browser && settings.peek<boolean>("agent.browserProtection") === true) {
        const answer = await session.ask({
          title: `Browser: ${request.title}`,
          heading: request.title,
          code: request.commandId,
          kind: "ide",
          detail: "Browser protection is on: browser actions ask each time.",
          ...(site && !danger && { always: site }),
          danger,
          evenWithFullAccess: true,
        });
        return remember(answer);
      }
      // The agent changing the IDE itself (panels, settings, extensions) always asks, whatever
      // the command mode: once, or for the whole chat (D176). agent.ideControl turns it off.
      if (request.ideControl && settings.peek<boolean>("agent.ideControl") !== false) {
        const answer = await session.ask({
          title: `Let the agent change the IDE: ${request.title}`,
          heading: "Change the IDE",
          code: request.commandId,
          kind: "ide",
          detail:
            request.confirmMessage ??
            "The agent wants to change the IDE itself (layout, views, settings or extensions). Allow for this chat to let it do more of this without asking.",
          ...(!danger && { always: "this chat" }),
          danger,
          evenWithFullAccess: true,
        });
        return answer === "always" ? "session" : answer;
      }
      // The user's own command or skill that lists it (`WebFetch(domain:docs.rs)`, D221).
      if (
        !danger &&
        session.preApproves("call_command", { id: request.commandId, input: request.input })
      )
        return "once";
      // "Run commands automatically" (agent.runCommands auto) covers the IDE's commands too:
      // setting a breakpoint or starting the debugger doesn't ask. Destructive ones still do,
      // and a command line typed into a terminal goes through the same denylist as run_command.
      // Not in a folder that isn't trusted (D103), as run_command.
      if (
        !danger &&
        settings.peek<string>("agent.runCommands") === "auto" &&
        services.trust.trusted
      ) {
        const field = SHELL_LINE_INPUT[request.commandId];
        if (!field) return "once";
        const line = (request.input as Record<string, unknown> | null)?.[field];
        if (
          typeof line === "string" &&
          !commandDenied(line, [
            ...DEFAULT_DENIED_COMMANDS,
            ...(settings.peek<string[]>("agent.deniedCommands") ?? []),
          ])
        )
          return "once";
      }
      const answer = await session.ask({
        title: `Run IDE command \`${request.commandId}\` (${request.title})`,
        heading: request.title,
        code: request.commandId,
        kind: "ide",
        ...(request.confirmMessage && { detail: request.confirmMessage }),
        // A page's command: Always is for its site (saved, D207); others for this session.
        ...(!danger && { always: site ?? "this session" }),
        danger,
      });
      if (site) return remember(answer);
      return answer === "always" ? "session" : answer;
    });
    sub.add({ dispose: () => setAgentPermissionHandler(undefined) });

    sub.add(
      settings.model.onDidChange((keys) => {
        if (keys.some((k) => k.startsWith("agent.ollama") || k === "agent.providers"))
          void providers.refresh();
      }),
    );
    // Sessions keep running across folder switches only in memory; their tabs close with the folder.
    sub.add(
      workspace.onDidClose(() => {
        for (const s of sessions.all()) {
          // The chat says why it stopped, with Continue (in this folder or the next, D161).
          s.stop("the folder was closed");
          void s.save();
        }
        // The old folder's sessions aren't the default target of commands in the next folder.
        sessions.active.value = null;
      }),
    );

    // The model list also feeds the status bar: which model answers.
    screen?.statusItem();

    sub.add(
      state.register("ide://agent", {
        description:
          "Agent sessions in this window (id, title, status, model, pending changes, `forkOf` for a fork: the chat it was copied from) and the model providers.",
        get: () => ({
          active: sessions.active.peek(),
          sessions: sessions.all().map((s) => ({
            id: s.id,
            title: s.title.peek(),
            status: s.status.peek(),
            model: s.model.peek(),
            autoApply: s.autoApply.peek(),
            pending: s.changeset.files.peek().map((f) => f.path),
            items: s.items.length,
            // A group chat's agents and who wrote the newest reply (D231).
            ...(s.members.peek().length && { members: s.members.peek() }),
            speaker: s.lastSpeaker(),
            // The chat it was forked from (D422).
            ...(s.forkOf && { forkOf: s.forkOf }),
          })),
          providers: providers.statuses.peek(),
          models: providers.models.peek().map((m) => m.key),
          // Tabs and windows the agent opened that are still open (agent.closeOpened, D179).
          opened: opened.live((id) => !!dock.findTab(id)).length,
        }),
      }),
    );
    // Sessions whose tabs are closed stay in memory until swept here (idle, nothing pending): they
    // are saved, and reopen from disk (Sessions…) when needed.
    // Chats of this folder with edits waiting for review load when it opens (D273): the editor's
    // inline Accept / Reject and the review bar come from loaded chats, and only chats with a tab
    // were loaded, so a folder closed with edits under review reopened without them.
    const loadPending = async () => {
      const folders = services.workspace.folderPaths();
      if (!folders.length) return;
      const saved = await agentStoreIpc.list().catch(() => []);
      for (const { id, meta } of saved) {
        const m = meta as { workspace?: unknown; pending?: unknown } | null;
        if (typeof m?.pending !== "number" || m.pending <= 0) continue;
        const where = m.workspace;
        if (typeof where !== "string" || !folders.some((f) => samePath(f, where))) continue;
        if (!sessions.find(id)) sessions.get(id);
      }
    };
    sub.add(services.workspace.onDidOpen(() => void loadPending()));
    void loadPending();
    const sweep = setInterval(() => {
      const shown = new Set(
        dock.tabs("agent").map((t) => (t.viewState as { session?: string } | null)?.session),
      );
      // Not idle while it has background work: a subagent's report, or a command whose end it
      // was told to hear (forgetting would stop the one and drop the other).
      const idle = (session: AgentSession) =>
        !session.busyNow() &&
        session.changeset.files.peek().length === 0 &&
        session.permissions.peek().length === 0 &&
        session.background.size === 0 &&
        // Reports waiting for a turn of their own (flushReports retries while it's busy).
        session.reports.length === 0 &&
        !backgroundProcesses.list(session.id).some((p) => p.notify && p.status === "running");
      for (const s of sessions.all())
        if (!shown.has(s.id) && s.id !== sessions.active.peek() && idle(s))
          void s.save().then(() => {
            // Checked again after the save: a turn may have started (a command naming the session)
            // or edits arrived meanwhile, and forgetting would dispose that live session.
            if (
              idle(s) &&
              s.id !== sessions.active.peek() &&
              sessions.find(s.id) === s &&
              !dock
                .tabs("agent")
                .some((t) => (t.viewState as { session?: string } | null)?.session === s.id)
            )
              sessions.forget(s.id);
          });
    }, 120_000);
    sub.add({ dispose: () => clearInterval(sweep) });
    const memory = memoryFor(services);
    memory.sessions = sessions;
    sub.add(
      state.register("ide://agent/repoMap", {
        description:
          "The repository map new chats start with (D174): the code files that matter most and the symbols they define, ranked by how much other code uses them.",
        get: () => repoMap.info(),
      }),
    );
    sub.add(
      dispatcher.register({
        id: "agent.showRepoMap",
        title: "Show the agent's repository map",
        category: "Agent",
        description:
          "The repository map a new chat starts with (D174), as text: ranked files with their main symbols, ranked toward `focus` (relative paths) and cut to `maxChars`. `refresh` rebuilds it first.",
        input: s.object({
          focus: s.array(s.string()).optional(),
          maxChars: s.integer({ min: 200, max: 40_000 }).optional(),
          refresh: s.boolean().optional(),
        }),
        effects: ["read"],
        run: async ({ focus, maxChars, refresh }) => {
          if (refresh) await repoMap.refresh();
          const text = await repoMap.text(
            focus ?? [],
            maxChars ?? settings.peek<number>("agent.repoMap.maxChars") ?? 4000,
          );
          return { ...repoMap.info(), text };
        },
      }),
    );
    sub.add(
      state.register("ide://agent/memory", {
        description: `Project memory (<workspace folder>/memory): the agent's notes per topic, the index its prompt gets, and saved sessions not yet tidied up (agent.dream).`,
        get: async () => {
          const files = await memory.files();
          return {
            enabled: memory.enabled(),
            folder: memory.dir(),
            files: files.map((f) => ({
              name: f.name,
              notes: notesIn(f.text).length,
              // How many of each kind (D315): { feedback: 2, project: 1 }.
              types: noteTypes(f.text),
              text: f.text,
            })),
            index: files.length ? memoryIndex(files) : "",
            untidiedSessions: (await memory.recentSessions()).length,
          };
        },
      }),
    );
    registerUsageState(sub, services, sessions, providers);
    registerUsageLog(sub);
    registerUsagePage(sub, services, providers, sessions);
    sub.add(
      state.register("ide://agent/session", {
        description:
          "The active agent session: its conversation (user messages, answers, tool calls with status and summaries, summaries of compacted parts), its plan, the latest turn's wrap-up (recap, ask, buttons), its chapters and proposed tasks, context usage, pending changes, permission requests, the ask_user questions waiting for answers and the latest review findings.",
        get: ({ budget }) => {
          const s = sessions.find(undefined);
          if (!s) return null;
          const max = budget > 8000 ? 80 : 30;
          return {
            id: s.id,
            title: s.title.peek(),
            status: s.status.peek(),
            model: s.model.peek(),
            // An external agent's own models and reasoning levels (agent.setAgentModel, D193).
            agentSettings: s.agentSettings.peek(),
            // A choice the agent hasn't taken yet (it is starting, or answering).
            ...(s.agentSettingPending.peek() && {
              agentSettingPending: s.agentSettingPending.peek(),
            }),
            // An external agent with the IDE's MCP tools (D211): "on", "off", "unsupported".
            ...(s.externalIdeTools && { ideTools: s.externalIdeTools }),
            // An external agent's plan limits from its last /status (D233: Codex's 5h / weekly).
            ...(s.externalLimits && { planLimits: s.externalLimits }),
            chatMode: s.chatMode.peek(),
            // How it works (D249): agent, plan or ask, whichever agent the chat is with.
            work: s.work(),
            // A group chat's agents (D231).
            ...(s.members.peek().length && { members: s.members.peek() }),
            ...(s.pullRequest.peek() && { pullRequest: s.pullRequest.peek() }),
            // Saved by another window since this one loaded it (D221): not saved here meanwhile.
            ...(s.conflict.peek() && { savedElsewhere: true }),
            textProtocol: s.textProtocol,
            items: s.items.slice(-max).map((i) =>
              i.type === "tool"
                ? {
                    type: i.type,
                    name: i.name,
                    args: i.args,
                    status: i.status,
                    summary: i.summary,
                    changes: i.changes,
                    ...(i.review && { review: i.review }),
                    ...(i.media?.length && { images: i.media.map(imageState) }),
                  }
                : i.type === "assistant"
                  ? {
                      type: i.type,
                      // What agent.forkSession's `item` takes (D422).
                      id: i.id,
                      text: i.text,
                      thinking: i.thinking.length > 0,
                      ...(i.speaker && { speaker: i.speaker }),
                      // Chat images (D381): their ids, not their bytes.
                      ...(i.media?.length && { images: i.media.map(imageState) }),
                    }
                  : i,
            ),
            pending: s.changeset.files
              .peek()
              .map((f) => ({ path: f.path, ...s.changeset.stat(f) })),
            permissions: s.permissions.peek().map((p) => ({ id: p.id, title: p.title })),
            checkpoints: s.checkpoints,
            // ask_user cards waiting for answers (D312), the latest review findings (D313).
            questions: pendingQuestions(s),
            findings: latestFindings(s),
            plan: s.plan.peek(),
            // The latest turn's wrap-up box, the chat's chapters and proposed tasks (D301–D303).
            wrapUp: latestWrapUp(s.items)?.wrapUp ?? null,
            chapters: chaptersOf(s.items),
            proposals: proposalsOf(s.items),
            usage: s.usage.peek(),
            totals: s.totals.peek(),
            promptChars: s.promptSize(),
            // Deferred tools (D319): named only, until tool_search loads them (`loadedTools`).
            ...deferredState(s),
          };
        },
      }),
    );
    // With no window: the host's waiting questions, readable and answerable (last, so nothing
    // the window registers moves).
    registerHostPromptCommands(sub, services);
  }
}

/**
 * The agent with no views: the extension a run with no window activates. Its host is whatever
 * was set for these services (agentHost.ts), else the one for no screen.
 */
export const agentCoreExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate: (context) => activateAgentCore(context, null),
};
