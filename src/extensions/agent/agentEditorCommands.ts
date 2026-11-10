// The agent editor's commands and state (D230): agent.newAgent (a draft tab, from a template),
// agent.createAgent (writes the file: what the draft's "Create agent" runs, and what an agent or a
// script calls directly), agent.editAgent (a subagent's file opens: agent.editSubagent, D288) and
// agent.duplicateAgent. `ide://agent/agents` lists every agent with its face, access, model and
// switch.

import {
  AGENT_DRAFT_SYSTEM,
  type AgentDraft,
  agentDraftPrompt,
  parseAgentDraft,
} from "../../core/agent/agentDraft";
import { agentIdFromLabel, newAgentFile, setHeaderFields } from "../../core/agent/agentFile";
import {
  AGENT_TEMPLATES,
  type AgentAccess,
  accessFile,
  accessOf,
} from "../../core/agent/agentTemplates";
import { BUILT_IN_MODES } from "../../core/agent/chatModes";
import { agentFace, encodeFace, iconCode, MODEL_ICON, parseFace } from "../../core/agent/faces";
import { MAIN_MEMBER } from "../../core/agent/groupChat";
import {
  agentLabel,
  isBundledAgent,
  isSubagent,
  validSubagentName,
} from "../../core/agent/subagents";
import type { Json } from "../../core/dock/index";
import { fsIpc } from "../../core/ipc/fs";
import type { DisposableStore } from "../../core/lifecycle/index";
import { basename, dirname, joinPath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { type DockViewDescriptor, stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { workspaceFolderName, workspaceFolderPath } from "../../workbench/workspaceFolder";
import {
  AGENT_EDITOR_VIEW,
  type AgentEditorState,
  AgentEditorView,
  agentSourceLabel,
} from "./agentEditor";
import { customModes } from "./customModes";
import { mainAgent } from "./mainAgent";
import type { ProviderRegistry } from "./providers";
import { projectInstructionsBlocked } from "./riskyGuard";
import { type SubagentRegistry, subagentEnabled, subagentModel, userAgentsDir } from "./subagents";
import { pickWorkspaceFolder } from "./workspaceFolderPick";

const SCOPES = ["project", "user"] as const;
const ACCESS = ["read", "edit", "full"] as const;

/** A tab's state (from disk or an agent) → what the editor opens. */
function editorState(state: Json): AgentEditorState {
  const name = stateField(state, "name");
  if (typeof name === "string") return { name };
  const template = stateField(state, "template");
  const scope = stateField(state, "scope");
  const from = stateField(state, "from");
  const generated = parseAgentDraft(JSON.stringify(stateField(state, "generated") ?? null));
  return {
    draft: true,
    ...(typeof template === "string" && { template }),
    ...((scope === "project" || scope === "user") && { scope }),
    ...(typeof from === "string" && { from }),
    ...(generated && { generated }),
  };
}

export function registerAgentEditor(
  sub: DisposableStore,
  services: WorkbenchServices,
  providers: ProviderRegistry,
  registry: SubagentRegistry,
): void {
  const { dispatcher, dock, state, workspace } = services;
  const deps = { services, providers, registry };

  sub.add(
    dock.views.register({
      type: AGENT_EDITOR_VIEW,
      title: (st) => {
        const name = stateField(st, "name");
        if (typeof name !== "string") return "New agent";
        if (name === MAIN_MEMBER) return mainAgent.value.label;
        const def = registry.get(name);
        return def ? agentLabel(def) : name;
      },
      icon: () => "bot",
      tooltip: (st) => {
        const name = stateField(st, "name");
        const path = typeof name === "string" ? registry.get(name)?.path : undefined;
        return path ?? "New agent";
      },
      defaultPlacement: "main",
      editorLike: true,
      create: (st, ctx) => new AgentEditorView(editorState(st), ctx, deps),
    } satisfies DockViewDescriptor),
  );

  /** The agent's tab, brought forward when it's open. */
  const openEditor = (name: string): string => {
    const open = dock.tabs(AGENT_EDITOR_VIEW).find((t) => stateField(t.viewState, "name") === name);
    if (open) {
      dock.activateTab(open.id, true);
      return open.id;
    }
    return dock.openView(AGENT_EDITOR_VIEW, { name }, "main", true);
  };

  const openDraft = (draft: {
    template?: string;
    scope?: string;
    from?: string;
    generated?: AgentDraft;
  }) =>
    dock.openView(AGENT_EDITOR_VIEW, { draft: true, ...draft } as unknown as Json, "main", true);

  // Generate an agent from a description (D245): runs only when asked, like a commit message
  // (AGENTS.md rule 8's exceptions), on the memory tidy-up's model (the agent's own upkeep).
  sub.add(
    dispatcher.register({
      id: "agent.generateAgent",
      title: "Generate agent from a description…",
      category: "Agent",
      description:
        "Drafts a new agent from a description of what it should do (D245): a model writes its name, role, description, instructions and access, and the draft opens in the agent editor to check before Create agent. Asks for the description when omitted. `open: false` returns the draft without opening it.",
      input: s.object({
        description: s.string().describe("What the agent should do").optional(),
        scope: s.enum(SCOPES).optional(),
        open: s.boolean().optional(),
      }),
      effects: [],
      agent: "discoverable",
      run: async ({ description, scope, open }) => {
        const { languageModel, quickInput, notifications } = services;
        if (!languageModel.model("memory"))
          throw new Error("Set up a model first (Agent: Manage providers).");
        const typed =
          description?.trim() ||
          (
            await quickInput.prompt({
              prompt: "Describe the agent: what it does and when to use it",
              placeholder: "Reviews SQL migrations for locking and data loss before they ship",
            })
          )?.trim();
        if (!typed) return null;
        const working = notifications.show("info", "Drafting the agent…");
        let reply: string;
        try {
          reply = await languageModel.generate({
            purpose: "memory",
            system: AGENT_DRAFT_SYSTEM,
            prompt: agentDraftPrompt(
              typed,
              registry.agents().map((d) => d.name),
            ),
            maxTokens: 1500,
          });
        } finally {
          working.dispose();
        }
        const draft = parseAgentDraft(reply);
        if (!draft) throw new Error("The model's reply wasn't an agent. Try again, or a template.");
        if (open === false) return { draft };
        return { draft, tabId: openDraft({ generated: draft, ...(scope && { scope }) }) };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.newAgent",
      title: "New agent…",
      category: "Agent",
      description: `Opens a new agent in the agent editor (a draft until Create agent): its face, name, role, what it does, instructions, model, access and where it lives. \`template\` fills it: ${AGENT_TEMPLATES.map((t) => t.id).join(", ")}. \`scope\`: user (your agents folder, in every project; the default) or project (<IDE folder>/agents, shared through git). To create one without the form, use agent.createAgent.`,
      input: s.object({
        template: s.enum(AGENT_TEMPLATES.map((t) => t.id)).optional(),
        scope: s.enum(SCOPES).optional(),
      }),
      effects: [],
      agent: "hidden",
      run: ({ template, scope }) => ({
        tabId: openDraft({ ...(template && { template }), ...(scope && { scope }) }),
      }),
    }),
  );

  const createAgent = async (input: {
    label: string;
    description: string;
    name?: string | undefined;
    role?: string | undefined;
    instructions?: string | undefined;
    icon?: string | undefined;
    access?: AgentAccess | undefined;
    tools?: string[] | undefined;
    maxSteps?: number | undefined;
    model?: string | undefined;
    scope?: "project" | "user" | undefined;
    mode?: "agent" | "plan" | "ask" | undefined;
    /** Multi-root workspaces (D251): the folder (path or name) a project agent goes in. */
    folder?: string | undefined;
  }) => {
    const label = input.label.trim();
    const name = (input.name ?? agentIdFromLabel(label)).trim();
    if (!name || !validSubagentName(name))
      throw new Error("Use letters, digits, - and _ in the agent's name (up to 48).");
    if (name.toLowerCase() === "explore")
      throw new Error("explore is the built-in explore helper's name: pick another.");
    // The chat's own modes: an agent named so would never show as a chat (D232).
    if (BUILT_IN_MODES.has(name.toLowerCase()))
      throw new Error(`${name} is the name of a built-in chat mode: pick another.`);
    const description = input.description.trim();
    if (!description) throw new Error("Say what the agent does (its description).");
    const existing = registry.agents().find((d) => d.name.toLowerCase() === name.toLowerCase());
    if (existing && !isBundledAgent(existing))
      throw new Error(`An agent named ${name} already exists (${existing.path ?? "built in"}).`);
    // In every project unless asked for this one (D233).
    const scope = input.scope ?? "user";
    // A project agent goes in the folder given, the active editor's, or the one picked (D251).
    const root =
      scope === "project" && workspace.root.peek()
        ? await pickWorkspaceFolder(services, input.folder, "New agent in which folder?")
        : workspace.root.peek();
    const projectOk = !!root && !projectInstructionsBlocked(services, root);
    if (scope === "project" && !projectOk)
      throw new Error("Open a trusted folder for a project agent, or create it just for you.");
    const dir =
      scope === "project" && root ? workspaceFolderPath(root, "agents") : userAgentsDir(services);
    if (!dir) throw new Error("No folder for your agents.");
    const path = joinPath(dir, `${name}.md`);
    if (
      await fsIpc.stat(path).then(
        () => true,
        () => false,
      )
    )
      throw new Error(`${name}.md already exists.`);
    if (scope === "project" && root) {
      await fsIpc.createDir(root, workspaceFolderName()).catch(() => {});
      await fsIpc.createDir(workspaceFolderPath(root), "agents").catch(() => {});
    } else await fsIpc.createDir(dirname(dir), basename(dir)).catch(() => {});
    // Its model's logo unless a face is given (D270).
    const face = parseFace(input.icon);
    const access = input.access ?? "read";
    let text = newAgentFile({
      name,
      ...(label && label !== name && { label }),
      ...(input.role?.trim() && { role: input.role.trim() }),
      icon: face ? encodeFace(face) : MODEL_ICON,
      description,
      instructions: input.instructions?.trim() || `You are ${label || name}. ${description}`,
      ...accessFile(access),
      ...(input.tools?.length && { tools: input.tools }),
      ...(input.mode && { startMode: input.mode }),
    });
    if (input.maxSteps && input.maxSteps > 0)
      text = setHeaderFields(text, { maxTurns: String(Math.min(200, Math.floor(input.maxSteps))) });
    await fsIpc.write(path, new TextEncoder().encode(text));
    await registry.refresh();
    // Its chat mode comes from a reload that runs on its own: chatting with it right after
    // (agent.chatWith, a group chat) needs it there first (D232).
    for (let i = 0; i < 30 && !customModes.peek().some((m) => m.name === name); i++)
      await new Promise((r) => setTimeout(r, 100));
    if (input.model)
      await dispatcher.execute("agent.setSubagent", { name, model: input.model }).catch(() => {});
    return { name, path, scope };
  };

  sub.add(
    dispatcher.register({
      id: "agent.createAgent",
      title: "Create agent",
      category: "Agent",
      description:
        "Creates an agent file (D230): `label` is its name (the id and file name come from it unless `name` is given), `description` what it does (the main agent reads it to decide when to hand it work), `instructions` its prompt, `access` read (read-only), edit (reads and edits files) or full (every tool, commands too), or an explicit `tools` list; `icon` a face code (shape-color-eyes), or model (the default: the logo of the model it uses); `model` provider/model (default: the chat's); `scope` project (default with a folder) or user. The agent can then be delegated to and chatted with.",
      input: s.object({
        label: s.string(),
        description: s.string(),
        name: s.string().describe("The id / file name; default from label").optional(),
        role: s.string().optional(),
        instructions: s.string().optional(),
        icon: s.string().optional(),
        access: s.enum(ACCESS).optional(),
        tools: s.array(s.string()).optional(),
        maxSteps: s.integer({ min: 1, max: 200 }).optional(),
        model: s.string().optional(),
        scope: s.enum(SCOPES).optional(),
        folder: s
          .string()
          .describe("Multi-root workspaces: the folder (path or name) a project agent goes in")
          .optional(),
        mode: s
          .enum(["agent", "plan", "ask"])
          .describe("The mode its chats start in (default agent)")
          .optional(),
      }),
      effects: ["write"],
      agent: "hidden",
      palette: false,
      run: (input) => createAgent(input),
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.editAgent",
      title: "Edit agent…",
      category: "Agent",
      description:
        "Opens one of your agents (or the project's) in the agent editor, by `name` (its id; ide://agent/agents lists them; `agent` is the main agent: its name, face and model, and the subagents). Asks which when omitted. A subagent's file opens in the text editor (agent.editSubagent).",
      input: s.object({ name: s.string().optional() }),
      effects: [],
      agent: "hidden",
      run: async ({ name }) => {
        let n = name;
        // The main agent (D286): the same editor, with what can be changed of it.
        if (n === MAIN_MEMBER) return { tabId: openEditor(MAIN_MEMBER), name: MAIN_MEMBER };
        if (!n) {
          const mine = registry.agents();
          if (!mine.length) throw new Error("No agents yet: create one with New agent.");
          const picked = await services.quickInput.pick(
            mine.map((d) => ({
              id: d.name,
              label: agentLabel(d),
              description: d.role ?? "",
              detail: d.description,
            })),
            { placeholder: "Edit which agent?" },
          );
          if (!picked) return null;
          n = picked.id;
        }
        await registry.refresh();
        const def = registry.get(n);
        if (!def) throw new Error(`No agent named ${n}.`);
        // A subagent is a Claude Code file (D288): it opens in the text editor (a built-in one is
        // copied to .claude/agents first).
        if (isSubagent(def)) return dispatcher.execute("agent.editSubagent", { name: def.name });
        return { tabId: openEditor(def.name), name: def.name };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.duplicateAgent",
      title: "Duplicate agent",
      category: "Agent",
      description:
        "Opens a copy of an agent (`name`; a built-in helper too) as a new draft in the agent editor, to rename and create.",
      input: s.object({ name: s.string() }),
      effects: [],
      agent: "hidden",
      palette: false,
      run: ({ name }) => {
        const def = registry.get(name);
        if (!def) throw new Error(`No agent named ${name}.`);
        return { tabId: openDraft({ from: def.name }) };
      },
    }),
  );

  sub.add(
    state.register("ide://agent/agents", {
      description:
        "Your agents (D230; D288: not the subagents, see ide://agent/subagents): your own and the project's (Markdown files in the agents folders), each with its name (id), label, role, its subagents (when it's limited to some), icon (a face code, or model: its model's logo), description, model (or inherit), access (read, edit, full or custom), source (project, user, claude-code, builtin), path and whether it's on.",
      get: () =>
        registry.agents().map((d) => {
          const access = accessOf(d);
          const source = agentSourceLabel(d);
          return {
            name: d.name,
            label: agentLabel(d),
            ...(d.role && { role: d.role }),
            icon: iconCode(agentFace(d.icon, d.name)),
            description: d.description,
            model: subagentModel(services, d) ?? "inherit",
            access: access ?? "custom",
            source: source === "Claude Code" ? "claude-code" : d.source,
            ...(d.path && { path: d.path }),
            enabled: subagentEnabled(services, d.name),
            // The subagents it may run (D288); absent: all.
            ...(d.subagents && { subagents: d.subagents }),
          };
        }),
    }),
  );
}
