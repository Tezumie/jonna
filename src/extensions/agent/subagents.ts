// Agents and subagents (D195; split as in Claude Code in D288). Agents are the personas you talk
// to: Markdown files in the folder's `<IDE folder>/agents/` (`.vscode` and the legacy folder name
// too) and the user's `<config>/agents/`. Subagents are workers an agent runs for a task: the
// built-in ones (core/agent/subagents.ts) and Claude Code's files in the folder's and the user's
// `.claude/agents/`. The `delegate` tool runs a subagent (in the foreground, or in the background
// while the agent goes on); `hand_off` brings an agent into the chat to answer next.
// `agent.subagents` holds the user's choices per agent or subagent — its model, or turned off.

import { subagentTitle } from "../../core/agent/backgroundTasks";
import {
  BUILT_IN_AGENTS,
  FIRST_TEAM,
  TEAM_START_MODES,
  withTeamModelIcon,
} from "../../core/agent/builtInAgents";
import { type AgentAccess, agentAsMode, withAccess } from "../../core/agent/chatModes";
import { FORK_DEF, forkBudget, forkSystem, forkTranscript } from "../../core/agent/fork";
import { MAIN_MEMBER } from "../../core/agent/groupChat";
import { wantsIsolation } from "../../core/agent/isolatedHelpers";
import {
  agentLabel,
  allowsSubagent,
  BUILTIN_SUBAGENTS,
  EXPLORE_ENTRY,
  isSubagent,
  mergeSubagents,
  parseSubagentFile,
  READ_TOOLS,
  type SubagentDef,
  type SubagentSource,
  subagentFile,
  subagentSystem,
  subagentTemplate,
  subagentTools,
  validSubagentName,
} from "../../core/agent/subagents";
import type { ToolSpec } from "../../core/ipc/agent";
import { fsIpc } from "../../core/ipc/fs";
import { appIpc, settingsIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { basename, dirname, joinPath, samePath } from "../../core/paths/index";
import { batch, effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { confirmAction } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import { workspaceFolderPaths } from "../../workbench/workspaceFolder";
import { agentModes } from "./customModes";
import type { IsolatedHelpers } from "./isolatedHelpers";
import { mainAgent } from "./mainAgent";
import { activePlugins } from "./pluginContributions";
import { projectInstructionsBlocked } from "./riskyGuard";
import { rulesFor } from "./rules";
import type { AgentSession } from "./session";
import type { SessionManager } from "./sessions";
import type { AgentTool } from "./tools";

/** What the user chose for one subagent (`agent.subagents`). */
export interface SubagentChoice {
  model?: string;
  /**
   * With `model` an external agent ("acp/Claude Code"): which of its own models this agent
   * answers on (D288), switched for its turns; unset: the one the external agent remembers.
   */
  agentModel?: string;
  enabled?: boolean;
  /** Its reasoning effort in chats (D273); unset: the chat's (agent.effort). */
  effort?: string;
  /** Its access in chats (D273); unset: what its file says, else the chat's. */
  access?: AgentAccess;
}

/** The external agent's own model one of your agents answers on (D288), if it picked one. */
export function agentExternalModel(
  services: WorkbenchServices,
  name: string | null | undefined,
): string | undefined {
  if (!name) return undefined;
  const choice = subagentChoices(services)[name];
  return choice?.model?.startsWith("acp/") && choice.agentModel ? choice.agentModel : undefined;
}

export function subagentChoices(services: WorkbenchServices): Record<string, SubagentChoice> {
  const raw = services.settings.peek<Record<string, SubagentChoice>>("agent.subagents");
  return raw && typeof raw === "object" ? raw : {};
}

/** The model a subagent runs on: the user's choice, else its file's, else the chat's (null). */
/** Claude Code's built-in subagent names → ours (D286). */
const CLAUDE_SUBAGENT_NAMES: Readonly<Record<string, string>> = {
  "general-purpose": "general",
  plan: "plan",
  explore: "explore",
};

export function subagentModel(services: WorkbenchServices, def: SubagentDef): string | null {
  const chosen = subagentChoices(services)[def.name]?.model;
  if (chosen) return chosen;
  return def.model && def.model !== "inherit" ? def.model : null;
}

export function subagentEnabled(services: WorkbenchServices, name: string): boolean {
  if (name === "explore" && services.settings.peek<boolean>("agent.explore") === false)
    return false;
  return subagentChoices(services)[name]?.enabled !== false;
}

/** The user's agents folder (`<config>/agents`). */
export function userAgentsDir(services: WorkbenchServices): string | null {
  const file = services.settings.filePath("user");
  return file ? joinPath(dirname(file), "agents") : null;
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

/**
 * The team every user starts with (D237, D241): written once into the user's agents folder as
 * ordinary agent files (no model: they use the chat's), so they're edited, renamed or deleted like
 * any agent of the user's own, and one that's deleted doesn't come back.
 */
async function seedTeam(services: WorkbenchServices): Promise<boolean> {
  // Not yet: the user's settings (and so their agents folder) aren't known.
  const dir = userAgentsDir(services);
  if (!dir) return false;
  // Read from disk (the global state is shared by every window): each agent is written once, so
  // one the user deleted never comes back. Before D245 one flag stood for the first team.
  let done: string[] = [];
  let iconsMoved = false;
  await services.persistence.saveGlobal((current) => {
    done = current.teamAgentsWritten ?? (current.teamAgentsSeeded ? [...FIRST_TEAM] : []);
    iconsMoved = current.teamIconsModel === true;
    return {};
  });
  if (!iconsMoved) await moveTeamToModelIcons(services, dir, done);
  const todo = BUILT_IN_AGENTS.filter((a) => !done.includes(a.name));
  if (!todo.length) return true;
  await fsIpc.createDir(dirname(dir), basename(dir)).catch(() => {});
  const written: string[] = [];
  for (const a of todo) {
    const path = joinPath(dir, `${a.name}.md`);
    const exists = await fsIpc.stat(path).then(
      () => true,
      () => false,
    );
    if (exists) written.push(a.name);
    else
      await fsIpc
        .write(path, new TextEncoder().encode(a.text))
        .then(() => written.push(a.name))
        .catch(() => {});
  }
  // Marked once they're there (D244): a failed write is tried again next time.
  if (written.length)
    await services.persistence.saveGlobal((current) => {
      const before = current.teamAgentsWritten ?? (current.teamAgentsSeeded ? [...FIRST_TEAM] : []);
      return { teamAgentsWritten: [...new Set([...before, ...written])] };
    });
  return true;
}

/**
 * Once (D270): the team's files written before show their model's logo, unless the user changed
 * their face.
 */
async function moveTeamToModelIcons(
  services: WorkbenchServices,
  dir: string,
  written: readonly string[],
): Promise<void> {
  for (const name of written) {
    const path = joinPath(dir, `${name}.md`);
    const text = await fsIpc.read(path).then(decode, () => null);
    const moved = text === null ? null : withTeamModelIcon(name, text);
    if (moved) await fsIpc.write(path, new TextEncoder().encode(moved)).catch(() => {});
  }
  await services.persistence.saveGlobal(() => ({ teamIconsModel: true }));
}

export class SubagentRegistry {
  /**
   * Your agents (personas you talk to) and the subagents (workers an agent runs), both kinds
   * (D288): agents from the agents folders, subagents from Claude Code's `.claude/agents` folders
   * and the built-in ones. Each kind has its own names: an agent may share one with a subagent.
   */
  readonly list = signal<readonly SubagentDef[]>([EXPLORE_ENTRY, ...BUILTIN_SUBAGENTS]);
  /** Files that didn't read as an agent (no header, no name or description). */
  readonly problems = signal<readonly string[]>([]);
  /** Helpers in worktrees of their own (D231), when the worktree agents are there. */
  isolated: IsolatedHelpers | null = null;
  private loading: Promise<void> | null = null;
  /** The user's home folder (for Claude Code's `~/.claude/agents`), once asked. */
  private home: string | null | undefined;

  constructor(private readonly services: WorkbenchServices) {}

  /**
   * The folders read, highest precedence first: each workspace folder's (D251: the first first),
   * then the user's. The agents folders hold agents; Claude Code's `.claude/agents` folders, the
   * project's and the user's, hold subagents, as in Claude Code (D288).
   */
  dirs(): { dir: string; source: SubagentSource; kind: "agent" | "subagent" }[] {
    const first = this.services.workspace.root.peek();
    const listed = this.services.workspace.folders.peek();
    const folders = first ? (listed.length ? listed.map((f) => f.path) : [first]) : [];
    const user = userAgentsDir(this.services);
    const claudeUser =
      this.home && this.services.settings.peek<boolean>("agent.thirdPartyConfigs") !== false
        ? joinPath(joinPath(this.home, ".claude"), "agents")
        : null;
    return [
      // D213: not a folder's own in restricted mode or a risky folder (Downloads…), each folder
      // judged on its own.
      ...folders
        .filter((root) => !projectInstructionsBlocked(this.services, root))
        .flatMap((root) => [
          ...workspaceFolderPaths(root, "agents").map((dir) => ({
            dir,
            source: "project" as const,
            kind: "agent" as const,
          })),
          {
            dir: joinPath(joinPath(root, ".claude"), "agents"),
            source: "project" as const,
            kind: "subagent" as const,
          },
        ]),
      ...(user ? [{ dir: user, source: "user" as const, kind: "agent" as const }] : []),
      ...(claudeUser
        ? [{ dir: claudeUser, source: "user" as const, kind: "subagent" as const }]
        : []),
      // D358: the enabled plugins' subagents (the user installed them), after the user's own.
      ...activePlugins
        .peek()
        .flatMap((p) =>
          p.agentDirs.map((dir) => ({ dir, source: "user" as const, kind: "subagent" as const })),
        ),
    ].filter((d, i, all) => all.findIndex((x) => samePath(x.dir, d.dir)) === i);
  }

  /** Where a new subagent of yours is written: the project's `.claude/agents`, else your own. */
  subagentDir(scope: "project" | "user"): string | null {
    return (
      this.dirs().find(
        (d) =>
          d.kind === "subagent" &&
          d.source === scope &&
          // Never into a plugin's folder (D358).
          !activePlugins.peek().some((p) => p.agentDirs.includes(d.dir)),
      )?.dir ??
      (scope === "user" && this.home ? joinPath(joinPath(this.home, ".claude"), "agents") : null)
    );
  }

  refresh(): Promise<void> {
    // Asked while a load runs: one more after it (that load may have listed the folder before
    // the change). Callers get the promise of the load that sees it.
    if (this.loading) {
      this.again ??= this.loading.then(() => {
        this.again = null;
        return this.refresh();
      });
      return this.again;
    }
    this.loading = this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }
  private again: Promise<void> | null = null;

  /** The team's files are written (or were before): seedTeam isn't tried again (D241). */
  private teamSettled = false;

  private async load(): Promise<void> {
    if (!this.teamSettled) this.teamSettled = await seedTeam(this.services).catch(() => false);
    if (this.home === undefined)
      this.home = (await appIpc.info().catch(() => null))?.homeDir ?? null;
    const agents: SubagentDef[][] = [];
    const subagents: SubagentDef[][] = [];
    const problems: string[] = [];
    for (const { dir, source, kind } of this.dirs()) {
      const entries = await fsIpc.listDir(dir).catch(() => []);
      const defs: SubagentDef[] = [];
      for (const e of entries) {
        if (e.kind !== "file" || !e.name.endsWith(".md")) continue;
        const path = joinPath(dir, e.name);
        const text = await fsIpc
          .read(path)
          .then(decode)
          .catch(() => "");
        const def = parseSubagentFile(text, source, path);
        if (def) defs.push({ ...def, kind });
        else problems.push(path);
      }
      (kind === "agent" ? agents : subagents).push(defs);
    }
    // A subagent file named as a built-in one (explore, plan, reviewer, general) replaces it, as
    // in Claude Code: the explore tool and the automatic review run what it says.
    batch(() => {
      this.list.value = [
        ...mergeSubagents(...agents),
        ...mergeSubagents(...subagents, [EXPLORE_ENTRY, ...BUILTIN_SUBAGENTS]),
      ];
      this.problems.value = problems;
    });
  }

  /** Your agents: the personas you talk to (D288). */
  agents(): SubagentDef[] {
    return this.list.peek().filter((d) => !isSubagent(d));
  }

  /** The subagents: built in and Claude Code's files (D288). */
  subagents(): SubagentDef[] {
    return this.list.peek().filter((d) => isSubagent(d));
  }

  /**
   * Subagents an agent may run now (not explore: it has its own tool): the ones on, and with
   * `speaker` (one of your agents) the ones its `subagents:` list allows (D288).
   */
  delegable(speaker?: string | null): SubagentDef[] {
    const agent = speaker
      ? this.agents().find((d) => d.name.toLowerCase() === speaker.toLowerCase())
      : undefined;
    return this.subagents().filter(
      (d) =>
        d.name !== "explore" &&
        subagentEnabled(this.services, d.name) &&
        allowsSubagent(agent, d.name),
    );
  }

  /** An agent by name (a persona first, for the editor and the pages), else a subagent. */
  get(name: string): SubagentDef | undefined {
    const key = name.toLowerCase();
    return this.agents().find((d) => d.name.toLowerCase() === key) ?? this.subagent(name);
  }

  /** A subagent by name; Claude Code's own names (`general-purpose`, `Explore`, `Plan`) map. */
  subagent(name: string): SubagentDef | undefined {
    const key = CLAUDE_SUBAGENT_NAMES[name.toLowerCase()] ?? name.toLowerCase();
    return this.subagents().find((d) => d.name.toLowerCase() === key);
  }

  /** The chat of a session id (set by registerSubagents): where follow-ups go (D245). */
  findSession: (id: string) => AgentSession | undefined = () => undefined;
  /**
   * A follow-up to a worktree helper (isolatedHelpers.ts `sendToHelper`, set where the helpers
   * are made; a hook so this file doesn't load theirs).
   */
  messageHelper: (id: string, text: string) => Promise<"sent" | "queued" | "unknown"> = async () =>
    "unknown";

  /**
   * The agent's ways to pass work on (D288): `delegate` runs a subagent (a worker, privately, a
   * report back; agent.delegate), `hand_off` brings one of your agents into the conversation to
   * answer next (in the open; agent.handOff). `speaker`: the agent answering (its subagents).
   */
  tools(speaker?: string | null): AgentTool[] {
    const out: AgentTool[] = [];
    const defs = this.delegable(speaker);
    if (this.services.settings.peek<boolean>("agent.delegate") !== false && defs.length)
      out.push(delegateTool(this, defs, this.services), followUpTool(this));
    const agents = this.agents().filter((d) => subagentEnabled(this.services, d.name));
    if (this.services.settings.peek<boolean>("agent.handOff") !== false && agents.length)
      out.push(handOffTool(agents, this.services));
    return out;
  }
}

/**
 * Hands the conversation to one of the user's agents (D288, as OpenBot's and Grok's teammates
 * hand work on): it joins this chat and answers right after this reply, seeing the whole
 * conversation, and can hand it back the same way. Unlike a subagent, it works in the open.
 */
function handOffTool(agents: readonly SubagentDef[], services: WorkbenchServices): AgentTool {
  const names = [MAIN_MEMBER, ...agents.map((d) => d.name)];
  return {
    spec: {
      name: "hand_off",
      description: `Hand the conversation to another of the user's agents: it joins this chat and answers right after your reply, seeing everything said so far, and can hand it back. Use it when another agent's job fits better (planning, a second view, the main agent building a plan), and say in your reply what you want from it. To have a task done privately with only a report back, use a subagent (delegate) instead. Agents (name, then what it does):\n- ${MAIN_MEMBER} ("${mainAgent.peek().label}"): the main agent; builds and hands work out\n${agents
        .map(
          (d) =>
            `- ${d.name}${agentLabel(d) !== d.name ? ` ("${agentLabel(d)}")` : ""}: ${d.description}`,
        )
        .join("\n")}`,
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", enum: names, description: "Which agent answers next" },
          reason: { type: "string", description: "What you want from it, in a few words" },
        },
        required: ["agent"],
      },
    },
    readOnly: true,
    verb: "Handed to",
    target: (a) => {
      const name = String(a.agent ?? "");
      const def = agents.find((d) => d.name === name);
      const who = name === MAIN_MEMBER ? mainAgent.peek().label : def ? agentLabel(def) : name;
      return `${who}${a.reason ? `: ${String(a.reason).slice(0, 70)}` : ""}`;
    },
    async run(args, host) {
      const name = typeof args.agent === "string" ? args.agent : "";
      if (!names.includes(name))
        return {
          result: `Error: no agent named ${name}. Agents: ${names.join(", ")}.`,
          isError: true,
        };
      try {
        const r = (await services.dispatcher.execute(
          "agent.inviteAgent",
          { agent: name },
          { kind: "agent", session: host.session },
        )) as { answersNext?: boolean };
        return {
          result: r.answersNext
            ? `${name} answers right after your reply, seeing this conversation. Finish your reply with what you want from it.`
            : `${name} won't answer next: it's the agent answering now, or it can't take a turn here.`,
        };
      } catch (err) {
        return {
          result: `Error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

/**
 * A follow-up to a subagent working in the background (D245, Claude Code's messages to its agent
 * team, Cursor's follow-ups): it reads it at its next step. "sent" or why not.
 */
export function messageBackground(
  session: AgentSession | undefined,
  id: string,
  text: string,
  from: string,
): "sent" | "finished" | "unknown" {
  const run = session?.background.get(id);
  if (!run?.message) return "unknown";
  return run.message(text, from) ? "sent" : "finished";
}

function followUpTool(registry: SubagentRegistry): AgentTool {
  return {
    spec: {
      name: "message_subagent",
      description:
        "Send a follow-up to a subagent you started in the background (delegate with background: true) or to a helper working in a worktree (isolated: true): more context, a correction, or a narrower question. Its id is in delegate's result. It reads it at its next step and its report still comes as a message. It can't answer back before then.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The background subagent's or the helper's id" },
          message: { type: "string", description: "What to tell it" },
        },
        required: ["id", "message"],
      },
    },
    readOnly: true,
    verb: "Messaged",
    target: (a) => `${String(a.id ?? "")}: ${String(a.message ?? "").slice(0, 70)}`,
    async run(args, host) {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      const text = typeof args.message === "string" ? args.message.trim() : "";
      if (!id || !text) return { result: "Error: give the id and a message.", isError: true };
      const outcome = messageBackground(registry.findSession(host.session), id, text, "the agent");
      if (outcome === "sent") return { result: "Sent: it reads it at its next step." };
      // A helper in a worktree (D245): its chat takes it, here or in its window.
      if (outcome === "unknown" && registry.isolated) {
        const helper = await registry.messageHelper(id, text);
        if (helper !== "unknown")
          return { result: "Sent to the helper: it reads it at its next step." };
      }
      return {
        result:
          outcome === "finished"
            ? "It has finished (its report is on its way): there's nothing to send it to."
            : `Error: no subagent ${id} is working in the background in this chat.`,
        isError: outcome !== "finished",
      };
    },
  };
}

function delegateTool(
  registry: SubagentRegistry,
  defs: readonly SubagentDef[],
  services: WorkbenchServices,
): AgentTool {
  const isolation = !!registry.isolated;
  const spec: ToolSpec = {
    name: "delegate",
    description: `Hand a self-contained task to a subagent. It works in its own context with its own tools (and maybe another model) and returns only a report, so its steps don't fill this conversation. Give it everything it needs in \`task\`: it doesn't see this conversation. With background: true it works while you go on (read-only tools only) and its report arrives as a message later; otherwise you wait for the report.${
      services.settings.peek<boolean>("agent.parallelToolCalls") === false
        ? ""
        : " Several delegate calls in one step run at the same time, each in its own context: split independent work across them (two of them never edit the same file at once)."
    }${
      isolation
        ? " With isolated: true it works in a git worktree of its own (a branch of its own; it runs in this window, or a window of its own with agent.isolatedHelpers.window) and may change files there in parallel, without touching this folder; it returns at once, its report arrives as a message later, and the user reviews and merges its changes. Use it for larger independent changes; only in a git repository. Agents marked (isolated) do this unless you pass isolated: false."
        : ""
    } With fork: true it starts from a copy of this conversation instead (no brief needed; \`agent\` optional: a copy of you), works in the background with read-only tools${isolation ? " (unless isolated)" : ""} and reports back as a message: a fork for side work that leans on this conversation, a fresh subagent with a full brief otherwise. A subagent works privately and reports back; to bring one of the user's own agents into this conversation instead (it joins and answers in the open, when the user asks to talk with it or its job fits better), use hand_off. Subagents (name, then the label the user calls it by):\n${defs
      .map(
        (d) =>
          `- ${d.name}${agentLabel(d) !== d.name ? ` ("${agentLabel(d)}")` : ""}: ${d.description}${isolation && d.isolation ? " (isolated)" : ""}`,
      )
      .join("\n")}`,
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", enum: defs.map((d) => d.name), description: "Which subagent" },
        task: {
          type: "string",
          description: "The task, with the context it needs (files, what to look for, the goal)",
        },
        description: {
          type: "string",
          description: "A short (3-5 word) title for the task, shown to the user",
        },
        background: {
          type: "boolean",
          description: "Work in the background while you go on (default false)",
        },
        fork: {
          type: "boolean",
          description: "Start from a copy of this conversation, in the background (default false)",
        },
        ...(isolation && {
          isolated: {
            type: "boolean",
            description:
              "Work in a git worktree and window of its own, changing files there in parallel (default: the agent's own setting)",
          },
        }),
      },
      // `agent` may be left out with fork (a copy of the agent itself).
      required: ["task"],
    },
  };
  return {
    spec,
    // What it may do is checked per call inside (its tools ask as usual).
    readOnly: true,
    // "Ran Plan: …" (D288): the subagent by the name the user knows.
    verb: "Ran",
    target: (a) => {
      const name = String(a.agent ?? "");
      const def = name ? registry.subagent(name) : a.fork === true ? FORK_DEF : undefined;
      return `${def ? agentLabel(def) : name}: ${String(a.task ?? "").slice(0, 70)}`;
    },
    async run(args, host, itemId) {
      const name = typeof args.agent === "string" ? args.agent.trim() : "";
      const task = typeof args.task === "string" ? args.task.trim() : "";
      const fork = args.fork === true;
      // A fork without a subagent named is a copy of the agent itself (D324).
      const def = name ? registry.subagent(name) : fork ? FORK_DEF : undefined;
      // Only the ones offered (on, and allowed to the agent answering, D288).
      if (!def || (def !== FORK_DEF && !defs.some((d) => d.name === def.name)))
        return {
          result: `Error: ${name ? `no subagent named ${name}` : "name the subagent (`agent`)"}. Available: ${defs.map((d) => d.name).join(", ")}${fork ? "" : ", or fork: true for a copy of you"}.`,
          isError: true,
        };
      if (!task) return { result: "Error: give the subagent a task.", isError: true };
      // A fork (D324): this conversation so far, trimmed to fit, goes with it.
      const parent = fork ? registry.findSession(host.session) : undefined;
      if (fork && !parent) return { result: "Error: forks aren't available here.", isError: true };
      const conversation = parent
        ? forkTranscript(parent.items, forkBudget(parent.usage.peek()?.limit ?? null))
        : null;
      // In a worktree of its own (D231): it starts there and this returns at once.
      if (registry.isolated && wantsIsolation(args.isolated, def))
        return registry.isolated.start({
          session: host.session,
          def,
          task: conversation
            ? `The conversation you continue from (you're a fork of its agent):\n<conversation>\n${conversation.text}\n</conversation>\n\nYour task: ${task}`
            : task,
          model: subagentModel(services, def),
          ask: (request) => host.ask(request),
          // Ask and Plan modes (and read-only agents) have no editing tools.
          parentReadOnly: !(host.toolNames?.() ?? ["edit_file"]).includes("edit_file"),
          // What this chat may use bounds the helper (D232), as it bounds a subagent here.
          parentTools: host.toolNames?.() ?? [],
          cancelled: () => host.cancelled(),
        });
      if (!host.subagent)
        return { result: "Error: subagents aren't available here.", isError: true };
      // A fork always works in the background (Claude Code's forks do).
      const background = args.background === true || fork;
      const available = host.toolNames?.() ?? [];
      const tools = subagentTools(def, available, background);
      const model = def === FORK_DEF ? null : subagentModel(services, def);
      // The project's rules it gets in its prompt (D204): the always-on ones unless it omits
      // them, the ones naming it, and those its definition lists; folder and matching-files
      // rules come with its reads and edits of the files they cover (D207, ruleNeeds).
      const rules = rulesFor(services);
      const own = `${subagentSystem(def)}${rules.subagentSection(def, await rules.rules())}`;
      const system = conversation ? forkSystem(own, conversation.text) : own;
      const maxSteps = def.maxSteps ?? 30;
      if (background) {
        if (!host.background)
          return { result: "Error: background subagents aren't available here.", isError: true };
        const id = host.background({
          name: def.name,
          system,
          task,
          title: subagentTitle(args.description, task),
          agentName: def.name,
          tools,
          maxSteps,
          model,
          ruleNeeds: def,
          progress: () => {},
        });
        const what = fork ? `a fork${def === FORK_DEF ? "" : ` (${def.name})`}` : def.name;
        const trimmed = conversation?.omitted
          ? ` It got this conversation without ${conversation.omitted} older messages (to fit).`
          : fork
            ? " It got this conversation so far."
            : "";
        return {
          result: `Started ${what} in the background (id ${id}).${trimmed} Its report will arrive as a message; go on with other work meanwhile. To steer it while it works, message_subagent with that id.`,
          summary: fork ? "forked" : "in the background",
        };
      }
      const looked: string[] = [];
      const report = await host.subagent({
        system,
        task,
        title: subagentTitle(args.description, task),
        agentName: def.name,
        tools,
        maxSteps,
        model,
        ruleNeeds: def,
        progress: (line) => {
          looked.push(line);
          host.output(itemId, `${line}\n`);
        },
      });
      const text = report.trim()
        ? report.trim().slice(0, 12_000)
        : `${def.name} wrote no report. It ran: ${looked.slice(-15).join("; ") || "nothing"}.`;
      return {
        result: text,
        summary: `${def.name} · ${looked.length} step${looked.length === 1 ? "" : "s"}`,
        detail: text,
      };
    },
  };
}

/**
 * The Explore agent the explore tool runs (D288): your Explore file, else the built-in one. Set
 * by registerSubagents (the window's registry).
 */
export let exploreAgent: () => SubagentDef = () => EXPLORE_ENTRY;

export function registerSubagents(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): SubagentRegistry {
  const registry = new SubagentRegistry(services);
  exploreAgent = () => registry.subagent("explore") ?? EXPLORE_ENTRY;
  registry.findSession = (id) => sessions.find(id);
  const { dispatcher, state, events, workspace } = services;
  void registry.refresh();
  // The user's agents are also chats of their own (D230): each is a chat mode.
  sub.add(
    effect(() => {
      // Turning an agent off (agent.subagents) takes its chat away too.
      services.settings.get("agent.subagents");
      agentModes.value = registry.list.value
        // Agents only (D288): subagents are workers, not chats.
        .filter((d) => !isSubagent(d) && subagentEnabled(services, d.name))
        // The model picked for it in the agent editor (agent.subagents) beats its file's (D232).
        .map((d) =>
          agentAsMode(
            {
              ...withAccess(d, subagentChoices(services)[d.name]?.access),
              model: subagentModel(services, d) ?? undefined,
              effort: subagentChoices(services)[d.name]?.effort,
              // A team agent's file from before `mode:` (D249).
              ...(!d.startMode &&
                d.source === "user" &&
                TEAM_START_MODES[d.name] && { startMode: TEAM_START_MODES[d.name] }),
            },
            READ_TOOLS,
          ),
        );
      return undefined;
    }),
  );
  // The automatic review (agent.autoReview, off by default): the reviewer subagent looks at the
  // files a turn changed, in the background, and its report comes back to the agent.
  sessions.reviewSpec = (files, available) => {
    if (services.settings.peek<boolean>("agent.autoReview") !== true) return null;
    const def = registry.subagent("reviewer");
    if (!def || !subagentEnabled(services, def.name)) return null;
    return {
      name: def.name,
      system: `${subagentSystem(def)}${rulesFor(services).subagentSection(def)}`,
      task: `Review the changes just made to these files (read them; they may be proposals still waiting for the user's review):\n${files
        .slice(0, 40)
        .map((f) => `- ${f}`)
        .join(
          "\n",
        )}\n\nReport only real problems, most severe first. If they look right, say so in one line.`,
      tools: subagentTools(def, available, true),
      maxSteps: def.maxSteps ?? 30,
      ...(subagentModel(services, def) && { model: subagentModel(services, def) as string }),
      ruleNeeds: def,
      progress: () => {},
    };
  };
  sub.add(workspace.onDidOpen(() => void registry.refresh()));
  sub.add(workspace.onDidClose(() => void registry.refresh()));
  sub.add(workspace.onDidChangeFolders(() => void registry.refresh()));
  // The first load can come before the settings know where the user's folder is (no folder open):
  // the user's agents, the team's included, then weren't listed until something reloaded (D241).
  if (!userAgentsDir(services)) {
    const started = Date.now();
    const wait = setInterval(() => {
      if (!userAgentsDir(services) && Date.now() - started < 60_000) return;
      clearInterval(wait);
      void registry.refresh();
    }, 250);
    sub.add({ dispose: () => clearInterval(wait) });
  }
  // Trusting the folder (or putting it in restricted mode) changes whether its own load (D213).
  let lastTrust = services.trust.state.peek();
  sub.add(
    effect(() => {
      const now = services.trust.state.value;
      if (now !== lastTrust) {
        lastTrust = now;
        void registry.refresh();
      }
      return undefined;
    }),
  );
  const inAgents = (path: string) =>
    path.endsWith(".md") && registry.dirs().some((d) => samePath(dirname(path), d.dir));
  for (const event of ["files.didSave", "files.didCreate", "files.didDelete"] as const)
    sub.add(
      events.on(event, ({ path }) => {
        if (inAgents(path)) void registry.refresh();
      }),
    );
  sub.add(
    events.on("files.didRename", ({ from, to }) => {
      if (inAgents(from) || inAgents(to)) void registry.refresh();
    }),
  );

  const describe = () =>
    registry.list.peek().map((d) => ({
      name: d.name,
      kind: isSubagent(d) ? "subagent" : "agent",
      description: d.description,
      source: d.source,
      ...(d.path && { path: d.path }),
      enabled: subagentEnabled(services, d.name),
      model: subagentModel(services, d) ?? "inherit",
      // On an external agent: which of its own models (D288).
      ...(agentExternalModel(services, d.name) && {
        agentModel: agentExternalModel(services, d.name),
      }),
      readOnly: d.readOnly === true,
      ...(subagentChoices(services)[d.name]?.effort && {
        effort: subagentChoices(services)[d.name]?.effort,
      }),
      ...(subagentChoices(services)[d.name]?.access && {
        access: subagentChoices(services)[d.name]?.access,
      }),
      ...(d.tools && { tools: d.tools }),
      ...(d.rules && { rules: d.rules }),
      ...(d.omitRules && { omitRules: true }),
      // The rules it gets (D204), as last read.
      projectRules: rulesFor(services)
        .subagentRules(d)
        .map((r) => r.path),
    }));
  sub.add(
    state.register("ide://agent/subagents", {
      description:
        "Your agents and the subagents (D288, as in Claude Code), each with its `kind`: agents are the personas you talk to (the agents folders; hand_off brings one into a chat), subagents the workers an agent runs privately with the delegate tool (built in: explore, plan, reviewer, general; your own from .claude/agents in the project and your home). Each with its model (or inherit), whether it's on, read-only and its tools; `delegable`: the subagents an agent can run now.",
      get: () => ({
        subagents: describe(),
        delegable: registry.delegable().map((d) => d.name),
        problems: registry.problems.peek(),
      }),
    }),
  );

  const setChoice = async (name: string, change: SubagentChoice) => {
    const all = { ...subagentChoices(services) };
    const next = { ...(all[name] ?? {}), ...change };
    if (next.model === "" || next.model === "inherit") delete next.model;
    // An external agent's own model goes with the external agent (D288).
    if (!next.agentModel || !next.model?.startsWith("acp/")) delete next.agentModel;
    if (next.enabled !== false) delete next.enabled;
    if (!next.effort || next.effort === "default") delete next.effort;
    if (next.access !== "edit" && next.access !== "read") delete next.access;
    if (Object.keys(next).length) all[name] = next;
    else delete all[name];
    await services.settings.update(
      "agent.subagents",
      Object.keys(all).length ? all : undefined,
      "user",
    );
  };

  sub.add(
    dispatcher.register({
      id: "agent.setSubagent",
      title: "Configure a subagent",
      category: "Agent",
      description:
        "Sets a subagent's model (provider/model; empty or inherit: the chat's model), turns it on or off, or sets one of your agents' reasoning effort and access in chats (D273: a group chat's Effort and Access lists; empty: the chat's). See ide://agent/subagents for the names.",
      input: s.object({
        name: s.string(),
        model: s.string().describe("provider/model, or empty for the chat's").optional(),
        agentModel: s
          .string()
          .describe(
            "With model acp/<external agent>: which of that agent's own models it answers on (its ids, as agent.chooseModel {for: external:<agent>} lists them); empty: the one the external agent remembers",
          )
          .optional(),
        enabled: s.boolean().optional(),
        effort: s
          .enum(["", "default", "low", "medium", "high", "xhigh", "max"] as const)
          .describe("Its reasoning effort; empty or default: the chat's")
          .optional(),
        access: s
          .enum(["", "edit", "read"] as const)
          .describe(
            "edit: its edits are kept without review; read: it only reads; empty: its file's, else the chat's",
          )
          .optional(),
      }),
      effects: ["write"],
      agent: "hidden",
      run: async ({ name, model, agentModel, enabled, effort, access }) => {
        const def = registry.get(name);
        if (!def) throw new Error(`No subagent named ${name}.`);
        await setChoice(def.name, {
          ...(model !== undefined && { model }),
          // A new model without one: the external agent's own model is cleared too.
          ...((agentModel !== undefined || model !== undefined) && {
            agentModel: agentModel ?? "",
          }),
          ...(enabled !== undefined && { enabled }),
          ...(effort !== undefined && { effort }),
          ...(access !== undefined && { access: access || undefined }),
        });
        if (def.name === "explore" && enabled !== undefined)
          await services.settings.update("agent.explore", enabled ? undefined : false, "user");
        const chosen = subagentChoices(services)[def.name];
        return {
          name: def.name,
          model: subagentModel(services, def) ?? "inherit",
          enabled: subagentEnabled(services, def.name),
          effort: chosen?.effort ?? "default",
          access: chosen?.access ?? "",
        };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.resetAgents",
      title: "Reset agents to defaults",
      category: "Agent",
      description: `Puts your agents back as a new install has them (D272): every agent in your agents folder goes to the trash, the default team (${BUILT_IN_AGENTS.map((a) => `${a.label}, ${a.role}`).join("; ")}) is written again as it first was, and their model and on/off choices are cleared. Agents in a project's files and Claude Code's aren't touched; the main agent stays as it is.`,
      input: s.empty(),
      effects: ["destructive"],
      agent: "hidden",
      confirm: () =>
        `Reset your agents? Every agent you made goes to the trash (Restore from trash brings one back), and changes to the default agents are lost: ${BUILT_IN_AGENTS.map((a) => `${a.label} (${a.role})`).join(" and ")} come back as they first were. Agents in a project's files aren't touched.`,
      run: async () => {
        const dir = userAgentsDir(services);
        if (!dir) throw new Error("Your agents folder isn't known yet.");
        const mine = registry.list
          .peek()
          .filter((d) => d.source === "user" && d.path && samePath(dirname(d.path), dir));
        const removed: string[] = [];
        for (const d of mine) {
          if (!d.path) continue;
          const trashed = await fsIpc.trash(d.path).catch(() => null);
          if (!trashed) await settingsIpc.deleteUserFile(d.path);
          removed.push(d.name);
        }
        await fsIpc.createDir(dirname(dir), basename(dir)).catch(() => {});
        for (const a of BUILT_IN_AGENTS)
          await fsIpc.write(joinPath(dir, `${a.name}.md`), new TextEncoder().encode(a.text));
        // Their models and on/off choices go too: as a new install has them.
        const reset = new Set([...removed, ...BUILT_IN_AGENTS.map((a) => a.name)]);
        const choices = Object.fromEntries(
          Object.entries(subagentChoices(services)).filter(([name]) => !reset.has(name)),
        );
        await services.settings.update(
          "agent.subagents",
          Object.keys(choices).length ? choices : undefined,
          "user",
        );
        await services.persistence.saveGlobal((current) => ({
          teamAgentsWritten: [
            ...new Set([
              ...(current.teamAgentsWritten ?? []),
              ...BUILT_IN_AGENTS.map((a) => a.name),
            ]),
          ],
          teamIconsModel: true,
        }));
        await registry.refresh();
        return {
          removed: removed.filter((n) => !BUILT_IN_AGENTS.some((a) => a.name === n)),
          written: BUILT_IN_AGENTS.map((a) => a.name),
        };
      },
    }),
  );
  /**
   * Writes a subagent file into Claude Code's folder (D288): the project's `.claude/agents` when
   * a trusted folder is open (unless `scope` is user), else `~/.claude/agents`.
   */
  const writeSubagent = async (
    name: string,
    text: string,
    scope: "project" | "user" | undefined,
  ): Promise<string> => {
    const want = scope ?? (registry.subagentDir("project") ? "project" : "user");
    const dir = registry.subagentDir(want);
    if (!dir)
      throw new Error(
        want === "project"
          ? "Open a trusted folder for a project subagent, or make it yours (scope user)."
          : "Your home folder wasn't found.",
      );
    const path = joinPath(dir, `${name}.md`);
    if (
      await fsIpc.stat(path).then(
        () => true,
        () => false,
      )
    )
      throw new Error(`${path} already exists.`);
    const claude = dirname(dir);
    await fsIpc.createDir(dirname(claude), basename(claude)).catch(() => {});
    await fsIpc.createDir(claude, basename(dir)).catch(() => {});
    await fsIpc.write(path, new TextEncoder().encode(text));
    await registry.refresh();
    return path;
  };

  sub.add(
    dispatcher.register({
      id: "agent.newSubagent",
      title: "New subagent…",
      category: "Agent",
      description:
        "Creates a subagent (D288): a Claude Code file in the project's .claude/agents (`scope` project, the default with a folder open) or ~/.claude/agents (user), with `name` and `description`, read-only to start, and opens it to edit. A person running it without `name` is asked for both.",
      input: s.object({
        name: s.string().describe("Letters, digits, - and _").optional(),
        description: s.string().describe("What it does and when to use it").optional(),
        scope: s.enum(["project", "user"] as const).optional(),
      }),
      effects: ["write"],
      agent: "hidden",
      run: async ({ name, description, scope }, ctx) => {
        let n = name?.trim();
        let about = description?.trim();
        if (!n) {
          if (ctx.caller.kind !== "user") throw new Error("Name the subagent (`name`).");
          n = (
            await services.quickInput.prompt({
              prompt: "The subagent's name (its file name too)",
              placeholder: "e.g. test-runner",
              validate: (v) =>
                validSubagentName(v.trim()) ? undefined : "Letters, digits, - and _ (up to 48)",
            })
          )?.trim();
          if (!n) return null;
          about ??= (
            await services.quickInput.prompt({
              prompt: "What it does, and when an agent should run it",
              placeholder: "e.g. Runs the tests and reports what fails. Use after changes.",
            })
          )?.trim();
          if (about === undefined) return null;
        }
        if (!validSubagentName(n))
          throw new Error("Use letters, digits, - and _ in the subagent's name (up to 48).");
        const path = await writeSubagent(n, subagentTemplate(n, about ?? ""), scope);
        await dispatcher.execute("editor.openFile", { path }).catch(() => {});
        return { name: n, created: path };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.editSubagent",
      title: "Edit subagent…",
      category: "Agent",
      description:
        "Opens a subagent's file in the editor (D288; ide://agent/subagents lists them). A built-in one (Explore, Plan, Review, General purpose) is copied to .claude/agents first: that copy replaces it, and deleting it brings the built-in back. Asks which when a person omits `name`.",
      input: s.object({
        name: s.string().optional(),
        scope: s.enum(["project", "user"] as const).optional(),
      }),
      effects: ["write"],
      agent: "hidden",
      run: async ({ name, scope }, ctx) => {
        let n = name;
        if (!n) {
          if (ctx.caller.kind !== "user") throw new Error("Name the subagent (`name`).");
          const picked = await services.quickInput.pick(
            registry.subagents().map((d) => ({
              id: d.name,
              label: agentLabel(d),
              description: d.source === "builtin" ? "Built in" : (d.path ?? ""),
              detail: d.description,
            })),
            { placeholder: "Edit which subagent?" },
          );
          if (!picked) return null;
          n = picked.id;
        }
        await registry.refresh();
        const def = registry.subagent(n);
        if (!def) throw new Error(`No subagent named ${n}.`);
        const path =
          def.path && def.source !== "builtin"
            ? def.path
            : await writeSubagent(def.name, subagentFile(def), scope);
        await dispatcher.execute("editor.openFile", { path });
        return { name: def.name, path, customized: def.source === "builtin" };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.deleteSubagent",
      title: "Delete a subagent",
      category: "Agent",
      description:
        "Deletes your or the project's subagent file (built-in subagents can only be turned off). Asks first when a person runs it.",
      input: s.object({ name: s.string() }),
      effects: ["write"],
      agent: "hidden",
      palette: false,
      run: async ({ name }, ctx) => {
        const def = registry.get(name);
        if (!def) throw new Error(`No subagent named ${name}.`);
        if (!def.path || def.source === "builtin")
          throw new Error(`${name} is built in: turn it off instead.`);
        if (
          ctx.caller.kind === "user" &&
          !(await confirmAction(
            `Delete ${agentLabel(def)}?`,
            `${def.path} goes to the trash (Restore from trash brings it back).`,
            "Delete",
            true,
          ))
        )
          return { deleted: false };
        // Into the app trash, so it can come back (D232); a file outside the folder's and the
        // app's reach (the trash can't take it) is deleted as before.
        const trashed = await fsIpc.trash(def.path).catch(() => null);
        if (!trashed) await settingsIpc.deleteUserFile(def.path);
        await registry.refresh();
        return { deleted: true, path: def.path, ...(trashed && { trashed }) };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.messageSubagent",
      title: "Message a background subagent…",
      category: "Agent",
      description:
        "Sends a follow-up to a subagent working in the background or a helper in a worktree (D245): more context or a correction it reads at its next step. `id` from ide://agent/details or ide://agent/helpers; asks for the message when omitted.",
      input: s.object({
        session: s.string().optional(),
        id: s.string().describe("The background subagent's id"),
        message: s.string().optional(),
      }),
      effects: [],
      agent: "hidden",
      run: async ({ session, id, message }) => {
        const target = sessions.find(session);
        const helpers = registry.isolated;
        const name = target?.background.get(id)?.name ?? "the subagent";
        const text =
          message?.trim() ||
          (await services.quickInput.prompt({ prompt: `Message to ${name}` }))?.trim();
        if (!text) return null;
        const outcome = messageBackground(target, id, text, "the user");
        // A helper in a worktree (D245): `id` is its chat's id or branch.
        if (
          outcome === "unknown" &&
          helpers &&
          (await registry.messageHelper(id, text)) !== "unknown"
        )
          return { sent: true, helper: true };
        if (outcome === "unknown") throw new Error("That subagent isn't working any more.");
        if (outcome === "finished")
          throw new Error(`${name} has finished: its report is on its way.`);
        target?.addNotice(`Sent to ${name}: ${text.slice(0, 200)}`);
        return { sent: true };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.stopSubagents",
      title: "Stop background subagents",
      category: "Agent",
      description:
        "Stops the subagents a chat started in the background, or just the one `id` (its id in ide://agent/details).",
      input: s.object({
        session: s.string().optional(),
        id: s.string().describe("One background subagent").optional(),
      }),
      effects: [],
      agent: "hidden",
      run: ({ session, id }) => ({ stopped: sessions.find(session)?.stopBackground(id) ?? 0 }),
    }),
  );
  return registry;
}
