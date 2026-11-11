// External agents over ACP (PLAN §8.1): Claude Code, Gemini CLI, Codex… run as subprocesses and
// use the same panel. The IDE answers their requests: file reads see the session's pending edits;
// file writes go to the changeset (review, or auto-apply); permission prompts are the inline cards;
// terminals are non-interactive exec runs. Presets + agent.externalAgents (user settings) are in
// acpAgents.ts.
// D208: with no folder open the agent runs in the chat's private folder (its file requests stay
// inside it); each turn's usage goes to the usage log; files it wrote itself are found after the
// turn and put under review; Codex's Guardian reviews fold into the step they reviewed.

import {
  AcpClient,
  type AcpCommand,
  type AcpHost,
  type AcpMcpServer,
  type AcpSetting,
  type ContentBlock,
  parseAvailableCommands,
  type SessionUpdate,
  type ToolCallFields,
} from "../../core/acp/client";
import { packageRunner, prettyCommand, updateCost } from "../../core/acp/display";
import { findMode, permissionLevel, pickMode, writesWithoutAsking } from "../../core/acp/modes";
import { changedByAgent, relativeTo, type StepWindow } from "../../core/acp/turnChanges";
import { nextImageId } from "../../core/agent/chatImages";
import type { Item } from "../../core/agent/conversation";
import { scratchIpc } from "../../core/ipc/agent";
import { fsIpc } from "../../core/ipc/fs";
import {
  type ExecResult,
  execIpc,
  type StdioProcess,
  startStdioProcess,
} from "../../core/ipc/process";
import { mcpIpc } from "../../core/ipc/system";
import type { Disposable } from "../../core/lifecycle/index";
import { ideMcpServer, isIdeToolRequest, mcpAgentAccess } from "../../core/mcp/agentAccess";
import { pathKey, samePath } from "../../core/paths/index";
import { product } from "../../core/product";
import { effect } from "../../core/reactive/index";
import {
  commandTouchesConfig,
  configQuestionDetail,
  type ProtectedConfig,
} from "../../core/security/agentConfigFiles";
import type { WorkbenchServices } from "../../workbench/services";
import { expandArgs } from "../lsp/servers";
import { type ExternalAgentConfig, helpChoices, helpCommandLine, shellArg } from "./acpAgents";
import { TurnWatch } from "./acpChanges";
import { AgentReviews } from "./acpReviews";
import { registerSlashSource } from "./composerExtras";
import { newId } from "./ids";
import { mayDeleteFiles } from "./permissions";
import { askProtectedWrite, askRiskyAccess, protectedTarget, riskyTargets } from "./riskyGuard";
import type { AgentSession } from "./session";
import { recordAgentUsage } from "./usageLog";

/** A model chosen by launch flag (not an ACP setting): changing it restarts the agent. */
export const LAUNCH_SETTING = "#launch";

const cacheKey = (agent: string) => `ide.acpSettings.${agent}`;

/** The settings an agent reported last time (for the model menu before it starts). */
export function cachedSettings(agent: string): AcpSetting[] | null {
  try {
    const raw = localStorage.getItem(cacheKey(agent));
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(v) ? (v as AcpSetting[]) : null;
  } catch {
    return null;
  }
}

/** Each chat's external agent's own slash commands (`available_commands_update`, D200). */
const agentCommands = new Map<string, { agent: string; commands: AcpCommand[] }>();

/** The external agent's commands in the composer's slash list (sent to the agent as typed). */
export function registerAgentSlashCommands(): Disposable {
  const source = registerSlashSource({
    list: (session) => {
      const entry = session ? agentCommands.get(session.id) : undefined;
      if (!session || !entry || session.model.peek() !== `acp/${entry.agent}`) return [];
      return entry.commands.map((c) => ({
        name: c.name,
        description: `${c.description}${c.hint ? ` (${c.hint})` : ""}`.slice(0, 120),
        source: entry.agent,
      }));
    },
  });
  return {
    dispose: () => {
      source.dispose();
      agentCommands.clear();
    },
  };
}

/** How each chat's agent reaches the IDE's tools (D223): `ide://agent/ideTools`. */
const ideToolsTransport = new Map<string, "http" | "stdio">();

export function registerIdeToolsState(services: WorkbenchServices): Disposable {
  return services.state.register("ide://agent/ideTools", {
    description:
      "External agents that have the IDE's tools (D211, D223), by chat id: how they reach the IDE's MCP server, `http` (agents that take HTTP MCP servers) or `stdio` (the IDE's executable as a proxy, for agents that take only stdio ones).",
    get: () => Object.fromEntries(ideToolsTransport),
  });
}

interface Terminal {
  output: string;
  done: Promise<ExecResult>;
  result?: ExecResult;
  limit: number;
}

/** One running external agent bound to one IDE session. */
export class AcpBackend {
  private process: StdioProcess | undefined;
  private client: AcpClient | undefined;
  private acpSession: string | undefined;
  private readonly tools = new Map<string, Extract<Item, { type: "tool" }>>();
  private readonly terminals = new Map<string, Terminal>();
  private assistant: Extract<Item, { type: "assistant" }> | undefined;
  private lastTool: Extract<Item, { type: "tool" }> | undefined;
  private stderr: string[] = [];
  /** Inside `session/load`: the agent replays the chat, which the transcript already has. */
  private loading = false;
  /**
   * Started without the chat's history (a restart, and the agent can't load sessions): the next
   * prompt carries a recap (D200).
   */
  private historyMissing = false;
  private readonly reviews: AgentReviews;
  /** This turn's look at the folder before it began (D208), for the files the agent changed. */
  private watch: TurnWatch | null = null;
  /** The session's cost so far as the agent last reported it (usage_update), in dollars. */
  private lastCost: number | null = null;
  /** `lastCost` when the turn began (null: unknown, a loaded session that never said). */
  private costBase: number | null = null;

  constructor(
    private readonly services: WorkbenchServices,
    private readonly session: AgentSession,
    readonly config: ExternalAgentConfig,
  ) {
    this.reviews = new AgentReviews(() => session.items, this.tools);
  }

  /**
   * A path the agent asked to read or write: inside the folder it works in (the open folder, or
   * the chat's private folder with none), or refused (D208). D251: in a multi-root workspace any
   * of the workspace's folders (ACP has one working folder, the first; the others are reachable).
   */
  private confine(path: string): string {
    const root = this.root;
    const windows = this.services.platform === "windows";
    const folders =
      root && !this.scratch && samePath(root, this.services.workspace.root.peek() ?? "")
        ? this.services.workspace.folderPaths()
        : [];
    const inside = (folder: string) => relativeTo(folder, path, windows) !== null;
    if (!root || !(inside(root) || folders.some(inside)))
      throw new Error(
        `${path} is outside the folder${folders.length > 1 ? "s" : ""} ${this.config.name} works in${root ? ` (${folders.length > 1 ? folders.join(", ") : root})` : ""}.`,
      );
    return root;
  }

  /**
   * D213: a file or terminal request into a Downloads folder asks first (once per chat and
   * folder), as do writes to other agents' configuration and startup files (every time). Throws
   * when the user says no.
   */
  private async guard(name: string, args: Record<string, unknown>): Promise<void> {
    if (this.scratch) return;
    const ask = (req: Parameters<AgentSession["ask"]>[0]) => this.session.ask(req);
    // Each risky folder the request works in asks on its own (D251: any workspace folder).
    for (const target of riskyTargets(this.services, name, args))
      if (
        !(await askRiskyAccess(
          this.services,
          this.session.id,
          ask,
          target.match,
          target.what,
          this.config.name,
        ))
      )
        throw new Error(
          `The user didn't allow ${this.config.name} to work in ${target.match.folder}: files there may come from the web. Don't try again; tell the user what you need.`,
        );
    const config = protectedTarget(this.services, name, args);
    if (config && !(await askProtectedWrite(ask, config.subject, config.found, this.config.name)))
      throw new Error(
        `The user didn't allow changing ${config.subject}. ${config.found.reason} Don't change it another way.`,
      );
  }

  /** A protected config file a permission request is about (its locations or command line). */
  private configRisk(
    toolCall: ToolCallFields,
    title: string,
  ): { subject: string; found: ProtectedConfig } | null {
    if (toolCall.kind === "read" || toolCall.kind === "search" || toolCall.kind === "fetch")
      return null;
    for (const loc of toolCall.locations ?? []) {
      const hit = protectedTarget(this.services, "write_file", { path: loc.path });
      if (hit) return hit;
    }
    const line = commandTouchesConfig(title, product.workspaceFolderName);
    return line ? { subject: line.subject, found: line } : null;
  }

  private host(): AcpHost {
    const s = this.session;
    return {
      update: (_sid, u) => this.onUpdate(u),
      requestPermission: async ({ toolCall, options }) => {
        const raw =
          toolCall.title ??
          this.tools.get(toolCall.toolCallId)?.summary ??
          "Allow the agent to continue?";
        // One of the IDE's own tools (D420): not asked here. The command it runs goes through
        // the IDE's permission policy as this chat's agent, which asks what needs asking.
        if (this.ideTools === "on" && isIdeToolRequest(raw, product.nameShort)) {
          const allow = options.find((o) => o.kind === "allow_once");
          if (allow) return { outcome: "selected", optionId: allow.optionId };
        }
        // A command as the user would type it, not its shell's full path and quoting (D208).
        const title = toolCall.kind === "execute" ? prettyCommand(raw).command || raw : raw;
        // Deletion protection (D179): a delete asks even with full access, and only once.
        const protect =
          this.services.settings.peek<boolean>("agent.deleteProtection") === true &&
          (toolCall.kind === "delete" || mayDeleteFiles(title));
        // D213: the agent changing another agent's config or a startup file (it writes them
        // itself, after asking) asks even with full access, every time, with the reason.
        const config = this.scratch ? null : this.configRisk(toolCall, title);
        const always =
          protect || config ? undefined : options.find((o) => o.kind === "allow_always");
        const answer = await s.ask({
          title: `${this.config.name}: ${title}`,
          heading: config ? "Change an agent or startup configuration file?" : title,
          detail: config
            ? `${this.config.name} wants to change ${config.subject}. ${configQuestionDetail(config.found)}`
            : this.config.name,
          ...(config && { code: title }),
          kind: "agent",
          ...(always && { always: always.name }),
          danger: toolCall.kind === "delete" || protect || !!config,
          ...((protect || config) && { evenWithFullAccess: true }),
        });
        const pick = (kinds: string[]) => options.find((o) => kinds.includes(o.kind));
        const chosen =
          answer === "always"
            ? (always ?? pick(["allow_once"]))
            : answer === "once"
              ? pick(["allow_once", "allow_always"])
              : pick(["reject_once", "reject_always"]);
        return chosen
          ? { outcome: "selected", optionId: chosen.optionId }
          : { outcome: "cancelled" };
      },
      readTextFile: async ({ path, line, limit }) => {
        const root = this.confine(path);
        await this.guard("read_file", { path });
        const text = this.scratch
          ? await scratchIpc.read(root, path)
          : ((await s.changeset.current(path)) ?? "");
        if (!line && !limit) return text;
        const lines = text.split("\n");
        const start = Math.max(0, (line ?? 1) - 1);
        return lines.slice(start, limit ? start + limit : undefined).join("\n");
      },
      writeTextFile: async ({ path, content }) => {
        const root = this.confine(path);
        await this.guard("write_file", { path });
        if (this.scratch) {
          // The chat's private folder: written as asked (nothing of the user's to review).
          await scratchIpc.write(root, path, content);
          if (!this.lastTool)
            s.items.push({
              type: "tool",
              id: newId("i"),
              callId: newId("c"),
              name: "acp:edit",
              args: { title: `Write ${path.split(/[\\/]/).pop() ?? path}` },
              status: "done",
              summary: "in the chat's own folder",
            });
          this.bump();
          return;
        }
        this.acpWrites.add(pathKey(path));
        await s.changeset.propose(path, content, s.turn);
        if (s.autoApply.peek()) await s.changeset.accept([path]);
        const item = this.lastTool;
        if (item) item.changes = [...new Set([...(item.changes ?? []), path])];
        else
          s.items.push({
            type: "tool",
            id: newId("i"),
            callId: newId("c"),
            name: "acp:edit",
            args: { title: `Write ${path}` },
            status: "done",
            summary: "",
            changes: [path],
          });
        this.bump();
      },
      createTerminal: async ({ command, args, cwd }) => {
        const id = newId("t");
        const line = [
          command,
          ...(args ?? []).map((a) => shellArg(a, this.services.platform === "windows")),
        ].join(" ");
        const term: Terminal = {
          output: "",
          limit: 256 * 1024,
          done: Promise.resolve({
            exitCode: null,
            timedOut: false,
            cancelled: true,
            durationMs: 0,
          }),
        };
        // Downloads and other agents' config files (D213): asked like the built-in agent's.
        try {
          await this.guard("run_command", { command: line, ...(cwd && { cwd }) });
        } catch (err) {
          term.output = err instanceof Error ? err.message : String(err);
          this.terminals.set(id, term);
          return id;
        }
        // Deletion protection (D179): the agent's own terminals check their command line too.
        if (
          this.services.settings.peek<boolean>("agent.deleteProtection") === true &&
          mayDeleteFiles(line)
        ) {
          const answer = await s.ask({
            title: `${this.config.name}: run \`${line}\``,
            heading: "Run a command that may delete files",
            code: line,
            detail: this.config.name,
            kind: "command",
            danger: true,
            evenWithFullAccess: true,
          });
          if (answer === "deny") {
            term.output = "The user denied running this command (it may delete files).";
            this.terminals.set(id, term);
            return id;
          }
        }
        // In the chat's private folder unless it names another (which must be inside it, D208).
        const dir = cwd ?? (this.scratch ? this.root : null);
        term.done = execIpc
          .run(id, line, { ...(dir && { cwd: dir }), timeoutMs: 3_600_000 }, (chunk) => {
            term.output = (term.output + chunk).slice(-term.limit);
            if (this.lastTool) s.outputs.set(this.lastTool.id, term.output);
            this.bump();
          })
          .then((r) => {
            term.result = r;
            return r;
          });
        this.terminals.set(id, term);
        return id;
      },
      terminalOutput: (id) => {
        const t = this.terminals.get(id);
        return {
          output: t?.output ?? "",
          truncated: false,
          exitStatus: t?.result
            ? {
                exitCode: t.result.exitCode,
                signal: t.result.cancelled || t.result.timedOut ? "SIGKILL" : null,
              }
            : null,
        };
      },
      waitForTerminalExit: async (id) => {
        const r = await (this.terminals.get(id)?.done ?? Promise.resolve(null));
        return {
          exitCode: r?.exitCode ?? null,
          signal: r && (r.cancelled || r.timedOut) ? "SIGKILL" : null,
        };
      },
      killTerminal: (id) => void execIpc.cancel(id).catch(() => {}),
      releaseTerminal: (id) => {
        void execIpc.cancel(id).catch(() => {});
        this.terminals.delete(id);
      },
    };
  }

  private bump(): void {
    this.session.version.value = this.session.version.peek() + 1;
  }

  private onUpdate(u: SessionUpdate): void {
    const s = this.session;
    if (u.sessionUpdate === "available_commands_update") {
      agentCommands.set(s.id, { agent: this.config.name, commands: parseAvailableCommands(u) });
      this.bump();
      return;
    }
    if (u.sessionUpdate === "usage_update") {
      this.onUsage(u);
      return;
    }
    // The replay of a loaded session: the chat shows it already (only settings are taken).
    if (this.loading && u.sessionUpdate !== "config_option_update") return;
    const text = (c: unknown) =>
      (c as { type?: string; text?: string })?.type === "text"
        ? ((c as { text: string }).text ?? "")
        : "";
    if (u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_thought_chunk") {
      const last = s.items[s.items.length - 1];
      if (!this.assistant || last !== this.assistant) {
        this.assistant = {
          type: "assistant",
          id: newId("i"),
          text: "",
          thinking: "",
          streaming: true,
          model: this.config.name,
          // Which agent wrote it, for the chat lists' logo (D405).
          modelKey: `acp/${this.config.name}`,
        };
        s.items.push(this.assistant);
      }
      const content = (u as { content: unknown }).content as
        | { type?: string; data?: unknown; mimeType?: unknown }
        | undefined;
      // An image in the agent's message (D381): a chat image with an id, like a model's.
      if (
        u.sessionUpdate === "agent_message_chunk" &&
        content?.type === "image" &&
        typeof content.data === "string"
      ) {
        const media = this.assistant.media ?? [];
        media.push({
          id: nextImageId(s.items),
          mime: typeof content.mimeType === "string" ? content.mimeType : "image/png",
          data: content.data,
          source: this.config.name,
        });
        this.assistant.media = media;
        this.bump();
        return;
      }
      const chunk = text(content);
      if (u.sessionUpdate === "agent_message_chunk") this.assistant.text += chunk;
      else this.assistant.thinking += chunk;
    } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
      const f = u as ToolCallFields;
      if (this.assistant) this.assistant.streaming = false;
      // Codex's Guardian reviewing a step: one line on that step (D208).
      if (this.reviews.isReview(f)) {
        this.reviews.take(f);
        this.bump();
        return;
      }
      let item = this.tools.get(f.toolCallId);
      if (!item) {
        item = {
          type: "tool",
          id: newId("i"),
          callId: f.toolCallId,
          name: `acp:${f.kind ?? "other"}`,
          args: {},
          status: "running",
        };
        this.tools.set(f.toolCallId, item);
        s.items.push(item);
        this.reviews.attach(item);
      }
      const args = item.args as Record<string, unknown>;
      if (f.title && item.name === "acp:execute") {
        // `"C:\…\powershell.exe" -Command 'npm run check'` → `npm run check`, tagged PowerShell.
        const pretty = prettyCommand(f.title);
        args.title = pretty.command || f.title;
        if (pretty.shell) args.shell = pretty.shell;
        else delete args.shell;
      } else if (f.title) args.title = f.title;
      if (f.locations?.[0]?.path) args.path = f.locations[0].path;
      // The files it names, read before it changes them (D208: the turn's changed files).
      const ran = f.status === "completed" || f.status === "failed";
      // When it ran (D403): a file no step names is the agent's only if it changed meanwhile.
      // Made for any step this turn hasn't timed yet, a reused id too (D407); one first heard of
      // already finished ran some time before: from the turn's start.
      let window = this.stepWindows.get(f.toolCallId);
      if (!window) {
        window = {
          kind: f.kind ?? "other",
          start: ran ? this.turnStartedAt : Date.now(),
          end: null,
        };
        this.stepWindows.set(f.toolCallId, window);
      }
      if (f.kind) window.kind = f.kind;
      if (ran && window.end === null) window.end = Date.now();
      const named = this.stepPaths.get(f.toolCallId) ?? new Set<string>();
      this.stepPaths.set(f.toolCallId, named);
      for (const loc of f.locations ?? [])
        if (loc.path) {
          this.watch?.note(loc.path, undefined, ran);
          named.add(loc.path);
        }
      for (const c of f.content ?? [])
        if (c.type === "diff" && c.path) {
          this.watch?.note(c.path, c.oldText ?? null, ran);
          named.add(c.path);
        }
      if (f.rawInput !== undefined) args.input = f.rawInput;
      const wasRunning = item.status === "running";
      if (f.status === "completed") item.status = "done";
      else if (f.status === "failed") item.status = "error";
      else item.status = "running";
      // Done: what it changed shows on its card now, not only after the turn (D223).
      if (wasRunning && ran && named.size && this.watch)
        void this.liveChanges(this.watch, item, [...named]);
      const parts = (f.content ?? []).map((c) =>
        c.type === "content" ? text(c.content) : c.type === "diff" ? `Edit ${c.path}` : "",
      );
      if (parts.some(Boolean)) item.detail = parts.filter(Boolean).join("\n").slice(0, 8000);
      this.lastTool =
        item.status === "running" ? item : this.lastTool === item ? undefined : this.lastTool;
    } else if (u.sessionUpdate === "current_mode_update" && this.client?.modes) {
      // The agent changed its own mode (a plan mode's exit): the next turn picks again. To one
      // that writes without asking while the IDE asks: put back at once.
      const id = (u as { currentModeId?: unknown }).currentModeId;
      if (typeof id === "string") {
        this.client.modes = { ...this.client.modes, current: id };
        if (writesWithoutAsking(this.client.modes, id)) void this.syncMode().catch(() => {});
      }
      return;
    } else if (u.sessionUpdate === "config_option_update" && this.client) {
      // The agent changed its model or reasoning level itself (D193).
      const next = this.client.updateSettings((u as { configOptions?: unknown }).configOptions);
      this.publish([...this.shown.filter((s) => s.configId === LAUNCH_SETTING), ...next]);
      return;
    } else if (u.sessionUpdate === "plan") {
      const entries = (u as { entries: { content: string; status?: string }[] }).entries ?? [];
      const mark = (st?: string) => (st === "completed" ? "✓" : st === "in_progress" ? "▸" : "·");
      s.items.push({
        type: "notice",
        id: newId("n"),
        text: `Plan:\n${entries.map((e) => `${mark(e.status)} ${e.content}`).join("\n")}`,
        tone: "info",
      });
    }
    this.bump();
  }

  /**
   * `usage_update` (ACP, stable): how full the agent's context is (the chat's meter) and, from
   * some agents (Claude Code), the session's cost so far.
   */
  private onUsage(u: SessionUpdate): void {
    const v = u as { used?: unknown; size?: unknown };
    const used = typeof v.used === "number" && v.used > 0 ? Math.round(v.used) : 0;
    const size = typeof v.size === "number" && v.size > 0 ? Math.round(v.size) : 0;
    const cost = updateCost(u);
    if (cost !== null) {
      this.lastCost = cost;
      // A loaded session's cost so far isn't this chat's next turn.
      if (this.loading) this.costBase = cost;
    }
    if (used && size && !this.loading) {
      this.session.usage.value = { tokens: used, limit: size, estimated: false };
      this.bump();
    }
  }

  /** One usage record for the turn that just ended (D208), and the chat's own totals. */
  private recordTurn(): void {
    const usage = this.client?.lastUsage ?? null;
    const cost =
      this.lastCost !== null && this.costBase !== null
        ? Math.max(0, this.lastCost - this.costBase)
        : null;
    this.costBase = this.lastCost ?? this.costBase;
    const model = this.shown.find((s) => s.category === "model");
    // By model when the agent splits the turn (D223, `_meta.quota.model_usage`: Claude Code's
    // subagents on another model): one record per model, the first carrying the request and the
    // cost; the rows are the fuller count (they include subagents), so they replace `usage`.
    const rows = this.client?.lastModelUsage ?? [];
    if (rows.length > 1) {
      const current = model?.current ?? "";
      const main = Math.max(
        0,
        rows.findIndex((r) => current && (r.model === current || r.model.startsWith(current))),
      );
      const ordered = [rows[main], ...rows.filter((_, i) => i !== main)].filter((r) => !!r);
      for (const [i, r] of ordered.entries())
        recordAgentUsage(this.services, {
          session: this.session.id,
          agent: this.config.name,
          model: r.model,
          usage: r.usage,
          cost: i === 0 ? cost : null,
          ...(i > 0 && { part: true }),
        });
    } else
      recordAgentUsage(this.services, {
        session: this.session.id,
        agent: this.config.name,
        model: model?.current ?? "",
        usage,
        cost,
      });
    const t = this.session.totals.peek();
    this.session.totals.value = {
      requests: t.requests + 1,
      input: t.input + (usage?.input ?? 0),
      cacheRead: t.cacheRead + (usage?.cacheRead ?? 0),
      cacheWrite: t.cacheWrite + (usage?.cacheWrite ?? 0),
      output: t.output + (usage?.output ?? 0),
    };
    if (cost !== null && cost > 0)
      this.session.cost.value =
        Math.round(((this.session.cost.peek() ?? 0) + cost) * 10_000) / 10_000;
  }

  /** Each step's named files (locations, diffs), by tool call id, for its own comparison. */
  private readonly stepPaths = new Map<string, Set<string>>();
  /** When each step of the turn ran, by tool call id (D403). */
  private readonly stepWindows = new Map<string, StepWindow>();
  /** When the turn began (D407: a file's time from before it doesn't say who changed it). */
  private turnStartedAt = 0;
  /** Files this turn wrote through ACP's fs/write_text_file (the changeset has them). */
  private readonly acpWrites = new Set<string>();

  private writtenThroughAcp(path: string): boolean {
    return this.acpWrites.has(pathKey(path));
  }

  /**
   * A step finished (D223): the files it named are compared now and go under review on its
   * card, so the changes show step by step. The end of the turn compares them again.
   */
  private async liveChanges(
    watch: TurnWatch,
    item: Extract<Item, { type: "tool" }>,
    named: string[],
  ): Promise<void> {
    const s = this.session;
    const turn = s.turn;
    const found = await watch
      .step(named.filter((p) => !this.writtenThroughAcp(p)))
      .catch(() => null);
    if (!found || this.watch !== watch) return;
    for (const c of found.changes)
      await s.changeset.adopt(c.path, c.before, c.after, turn).catch(() => {});
    const paths = found.changes.map((c) => c.path);
    if (paths.length && s.autoApply.peek()) await s.changeset.accept(paths).catch(() => {});
    if (!paths.length) return;
    item.changes = [...new Set([...(item.changes ?? []), ...paths])];
    this.bump();
  }

  /**
   * The files the agent wrote itself this turn (D208): compared with the folder as it was when
   * the turn began, then under review like the IDE agent's own edits.
   */
  private async collectChanges(
    watch: TurnWatch,
    earlier: ReadonlySet<Extract<Item, { type: "tool" }>>,
  ): Promise<void> {
    const s = this.session;
    const turn = s.turn;
    // Written through ACP's fs requests: already under review. (A step's own comparison, D223,
    // is redone: a later step may have changed the file again.)
    // Stop ends the comparing too (D294): a big turn's files were compared one by one, the chat
    // "working" all the while.
    const finished = await watch.finish(
      (path) => this.writtenThroughAcp(path),
      () => s.cancelled,
    );
    // Not the agent's (D403): a file no step named that changed while none of its steps that can
    // write was running: the person, a formatter or another agent editing the folder meanwhile.
    const named = [...this.stepPaths.values()].flatMap((set) => [...set]);
    const windows = [...this.stepWindows.values()];
    const now = Date.now();
    const foreign: string[] = [];
    const isAgents = async (path: string) => {
      if (named.some((p) => samePath(p, path))) return true;
      // Saved by the person after a step of the agent's changed it: still the agent's change.
      if (finished.savedOverAgent.some((p) => samePath(p, path))) return true;
      const stat = await fsIpc.stat(path).catch(() => null);
      if (changedByAgent(stat?.mtimeMs ?? null, windows, now, this.turnStartedAt)) return true;
      foreign.push(path);
      return false;
    };
    const result = { ...finished, changes: [] as typeof finished.changes, others: [] as string[] };
    for (const c of finished.changes)
      if (c.before === c.after || (await isAgents(c.path))) result.changes.push(c);
    for (const p of finished.others) if (await isAgents(p)) result.others.push(p);
    for (const c of result.changes) {
      if (s.cancelled) break;
      await s.changeset.adopt(c.path, c.before, c.after, turn).catch(() => {});
    }
    // A file a step changed and a later one put back is no change (adopt dropped it).
    const paths = result.changes.filter((c) => c.before !== c.after).map((c) => c.path);
    if (paths.length && s.autoApply.peek()) await s.changeset.accept(paths).catch(() => {});
    // On the step that named each file, else on one "Changed files" step of the turn.
    const rest: string[] = [];
    const turnTools = [...this.tools.values()].filter((t) => !earlier.has(t));
    for (const path of paths) {
      if (turnTools.some((t) => t.changes?.some((p) => samePath(p, path)))) continue;
      const step = turnTools.find(
        (t) =>
          typeof (t.args as { path?: unknown }).path === "string" &&
          samePath((t.args as { path: string }).path, path),
      );
      if (step) step.changes = [...new Set([...(step.changes ?? []), path])];
      else rest.push(path);
    }
    // Its own line, not on a "Changed files" step: a turn that changed nothing mustn't look
    // like an edit because something else did.
    if (foreign.length) {
      // Ten names at most (D407): a formatter run over the folder meanwhile changes hundreds.
      const names = foreign.slice(0, 10).map((p) => p.split(/[\\/]/).pop() ?? p);
      const more = foreign.length > 10 ? ` and ${foreign.length - 10} more` : "";
      const notice: Item = {
        type: "notice",
        id: newId("n"),
        text: `Changed while none of ${this.config.name}'s steps ran, so not counted as its work: ${names.join(", ")}${more}.`,
        tone: "info",
      };
      const end = s.items[s.items.length - 1];
      if (end?.type === "assistant") s.items.splice(s.items.length - 1, 0, notice);
      else s.items.push(notice);
    }
    const notes = [
      ...result.others.map((p) => `${p.split(/[\\/]/).pop() ?? p} (not text: not shown)`),
      ...(result.committed ? ["It made commits: see the Git log."] : []),
      ...(result.userSaved.length
        ? [
            `Compared from your own save on: ${result.userSaved.map((p) => p.split(/[\\/]/).pop() ?? p).join(", ")}.`,
          ]
        : []),
      ...(result.savedOverAgent.length
        ? [
            `Changed by the agent, then saved by you (the diff includes your save): ${result.savedOverAgent.map((p) => p.split(/[\\/]/).pop() ?? p).join(", ")}.`,
          ]
        : []),
      ...result.bulk.map(
        (b) =>
          `${b.folder}/ (${b.files} new files) was made by a command, a clone or a download: not under review (see the Explorer).`,
      ),
      ...(result.skipped
        ? [
            `${result.skipped} more changed file(s) weren't compared (too many): see Source control.`,
          ]
        : []),
    ];
    if (!rest.length && !notes.length) return;
    const item: Extract<Item, { type: "tool" }> = {
      type: "tool",
      id: newId("i"),
      callId: newId("c"),
      name: "acp:edit",
      args: { title: "Changed files" },
      status: "done",
      summary: `${paths.length + result.others.length} file${paths.length + result.others.length === 1 ? "" : "s"}`,
      ...(rest.length && { changes: rest }),
      ...(notes.length && { detail: notes.join("\n") }),
    };
    // Before its last answer, with the turn's other steps.
    const last = s.items[s.items.length - 1];
    if (last?.type === "assistant") s.items.splice(s.items.length - 1, 0, item);
    else s.items.push(item);
  }

  /** The folder the agent's process and session were started in. */
  root: string | null = null;
  /** No folder was open: `root` is the chat's private folder in app data (D208). */
  scratch = false;

  /** Whether the agent was started for this window's folder (`null`: none open). */
  startedFor(folder: string | null): boolean {
    if (!this.root) return true;
    return folder === null ? this.scratch : !this.scratch && samePath(this.root, folder);
  }
  /** Its session was picked up with session/load after a restart (D200). */
  resumed = false;

  /** A start under way: callers share it (the model menu, picking the agent, a message). */
  private starting: Promise<void> | null = null;

  private start(): Promise<void> {
    if (this.client && this.acpSession) return Promise.resolve();
    if (!this.starting) {
      const p = this.startNow().finally(() => {
        if (this.starting === p) this.starting = null;
      });
      this.starting = p;
    }
    return this.starting;
  }

  private async startNow(): Promise<void> {
    if (this.client && this.acpSession) return;
    // No folder open: the chat's own folder in app data (D208), where its file requests stay.
    const folder = this.services.workspace.root.peek();
    // A risky folder (Downloads, home, Desktop, temp, a drive root; D213): the user says so before the agent
    // starts there and reads the instruction files it finds (AGENTS.md, CLAUDE.md). D251: every
    // folder of the workspace (it may read any of them).
    const folders = folder ? this.services.workspace.folderPaths() : [];
    for (const each of folders.length ? folders : folder ? [folder] : []) {
      const risk = this.services.trust.risky.riskOf(each);
      if (
        risk &&
        !(await askRiskyAccess(
          this.services,
          this.session.id,
          (req) => this.session.ask(req),
          risk,
          [this.config.command, ...(this.config.args ?? [])].join(" "),
          this.config.name,
        ))
      )
        throw new Error(
          `${this.config.name} wasn't started: ${each} is a risky folder (files from the web can hold instructions for agents). Open a project folder instead, or allow it when asked.`,
        );
    }
    const root = folder ?? (await scratchIpc.dir(this.session.id));
    this.root = root;
    this.scratch = !folder;
    this.stderr = [];
    this.process = await startStdioProcess(
      `acp:${this.session.id}`,
      {
        command: this.config.command,
        args: [
          ...expandArgs(this.config.args, root),
          ...(this.config.modelFlag && this.remembered().model
            ? [this.config.modelFlag, this.remembered().model as string]
            : []),
        ],
        cwd: root,
        env: this.config.env ?? {},
        framing: "ndjson",
      },
      {
        stderr: (line) => {
          this.stderr.push(line);
          if (this.stderr.length > 40) this.stderr.shift();
        },
        exit: () => {
          this.client?.dispose();
          this.client = undefined;
          this.acpSession = undefined;
        },
      },
    );
    this.client = new AcpClient(this.process.transport, this.host());
    // npx / uvx fetch the agent's package before it starts: a new version (Claude Code's adapter
    // is large) took over two minutes once, with only "initialize timed out" to show for it (D401).
    const fetcher = packageRunner(this.config.command);
    const slow = fetcher
      ? setTimeout(() => {
          // Only while a message waits on it (D407): a start for the model menu (prepare) in an
          // idle chat would leave the line in the saved chat.
          if (this.session.status.peek() === "idle") return;
          this.session.items.push({
            type: "notice",
            id: newId("n"),
            text: `Still starting ${this.config.name}: ${fetcher} is downloading it (a new version can take a few minutes the first time).`,
            tone: "info",
          });
          this.bump();
        }, 15000)
      : undefined;
    try {
      await this.client
        .initialize(product.nameLong, fetcher ? 600000 : 120000)
        .finally(() => clearTimeout(slow));
      // After a restart: pick up the agent's own session when it can (D200).
      const saved = this.session.acpResume;
      let resumed = false;
      // Its cost so far: unknown for a loaded session until it says (usage_update), else none.
      this.lastCost = null;
      this.costBase = null;
      if (
        saved &&
        saved.agent === this.config.name &&
        samePath(saved.root, root) &&
        this.client.canLoadSession
      ) {
        this.loading = true;
        try {
          await this.client.loadSession(saved.id, root, await this.ideServers());
          this.acpSession = saved.id;
          resumed = true;
        } catch {
          // Gone (the agent forgot it, or wants a sign-in first): a new session, with a recap.
        } finally {
          this.loading = false;
        }
      }
      if (!this.acpSession)
        try {
          this.acpSession = await this.client.newSession(root, await this.ideServers());
        } catch (err) {
          const method = this.client.authMethods[0];
          if (!method) throw err;
          await this.client.authenticate(method.id);
          this.acpSession = await this.client.newSession(root, await this.ideServers());
        }
      this.session.acpResume = { agent: this.config.name, id: this.acpSession, root };
      this.resumed = resumed;
      if (!resumed) this.costBase = 0;
      this.historyMissing = !resumed && this.session.items.some((i) => i.type === "user");
      this.publish(await this.withLaunchModels(this.client.settings, root));
      await this.applyRemembered();
    } catch (err) {
      const tail = this.stderr.slice(-4).join("\n");
      await this.stop();
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${this.config.name} didn't start: ${message}${tail ? `\n${tail}` : ""}\n(${this.config.command} ${(this.config.args ?? []).join(" ")}${this.config.description ? ` — ${this.config.description}` : ""})`,
      );
    }
  }

  /**
   * Sends a message: its text, the context that goes with it (attached files and pastes, as
   * text, which every agent takes) and images when the agent takes them (D160).
   */
  async prompt(
    text: string,
    extra: {
      context?: readonly string[];
      images?: readonly string[];
      /** The chat so far, sent when the agent started without it (a restart, no session/load). */
      history?: string;
      /** The model of this turn's agent (D288); unset: the one remembered for the agent. */
      model?: string | undefined;
    } = {},
  ): Promise<void> {
    await this.start();
    // Stop pressed while it was starting (npx, a first run can take seconds): nothing is sent
    // (D244; cancel() had no session to cancel yet).
    if (this.session.cancelled) throw new Error("Stopped.");
    if (!this.client || !this.acpSession) throw new Error(`${this.config.name} isn't running.`);
    this.assistant = undefined;
    this.lastTool = undefined;
    const recap =
      this.historyMissing && extra.history?.trim()
        ? [`Earlier in this conversation (you were restarted):\n${extra.history.trim()}`]
        : [];
    this.historyMissing = false;
    const blocks: ContentBlock[] = [
      ...recap.map((c) => ({ type: "text" as const, text: c })),
      ...(extra.context ?? []).map((c) => ({ type: "text" as const, text: c })),
      { type: "text", text },
    ];
    const images = extra.images ?? [];
    if (images.length && this.client.promptCapabilities.image)
      for (const data of images) blocks.push({ type: "image", mimeType: "image/png", data });
    else if (images.length)
      blocks.push({
        type: "text",
        text: `(${images.length} image(s) attached; ${this.config.name} can't take images.)`,
      });
    // The mode first: one that can't be made to ask ends the turn here, before anything starts.
    await this.syncMode();
    await this.syncModel(extra.model).catch(() => {});
    if (this.session.cancelled) throw new Error("Stopped.");
    // The folder before the turn, to find the files the agent writes itself (D208). A private
    // folder holds nothing of the user's: nothing to review there.
    this.acpWrites.clear();
    this.stepPaths.clear();
    this.stepWindows.clear();
    this.turnStartedAt = Date.now();
    const watch =
      this.scratch || !this.root
        ? null
        : new TurnWatch(this.services, this.root, (p) => this.writtenThroughAcp(p));
    const earlier = new Set(this.tools.values());
    await watch?.start();
    this.watch = watch;
    // Review edits or the command setting changed mid-turn: the agent's mode follows at once.
    const resync = () => void this.syncMode().catch(() => {});
    const settingsSub = this.services.settings.model.onDidChange((keys) => {
      if (keys.includes("agent.runCommands")) resync();
    });
    let firstRun = true;
    const autoApplySub = effect(() => {
      this.session.autoApply.value;
      if (!firstRun) resync();
      firstRun = false;
      return undefined;
    });
    let stop: string;
    try {
      stop = await this.client.prompt(this.acpSession, blocks);
      this.recordTurn();
    } finally {
      settingsSub.dispose();
      autoApplySub.dispose();
      this.watch = null;
      this.reviews.endTurn();
      if (watch) {
        this.session.gathering.value = true;
        try {
          await this.collectChanges(watch, earlier).catch(() => {});
        } finally {
          this.session.gathering.value = false;
        }
      }
      watch?.dispose();
    }
    const last = this.assistant as Extract<Item, { type: "assistant" }> | undefined;
    if (last) last.streaming = false;
    for (const item of this.tools.values())
      if (item.status === "running") item.status = stop === "cancelled" ? "error" : "done";
    if (stop === "max_tokens" || stop === "refusal" || stop === "max_turn_requests")
      this.session.items.push({
        type: "notice",
        id: newId("n"),
        text: `${this.config.name} stopped: ${stop.replace(/_/g, " ")}.`,
        tone: "info",
      });
    this.bump();
  }

  /** Starts the agent without a message, so its models are known before the first one (D193). */
  async prepare(): Promise<void> {
    await this.start();
  }

  /**
   * Puts the agent in the mode that matches the IDE's permission settings (D227): Codex and
   * Claude Code write files themselves, so with "Review edits" or "Ask before commands" on they
   * must ask before writing, not only show the change afterwards. When the IDE asks and the
   * switch fails, this throws: the turn mustn't run in a mode that writes unasked.
   */
  private async syncMode(): Promise<void> {
    const client = this.client;
    if (!client || !this.acpSession || this.scratch) return;
    const level = permissionLevel(
      !this.session.autoApply.peek(),
      this.services.settings.peek<string>("agent.runCommands") ?? "ask",
    );
    const mode = pickMode(client.modes, level);
    if (mode)
      await client.setMode(this.acpSession, mode).catch((err: unknown) => {
        // Left in a mode that writes without asking while the IDE asks: the turn doesn't start
        // (it would edit unasked). Other levels: the agent's own mode is no worse than asked.
        if (level === "ask")
          throw new Error(
            `${this.config.name} couldn't be put in a mode that asks before writing (${err instanceof Error ? err.message : String(err)}), so the message wasn't sent. Try again, or turn off Review edits.`,
          );
      });
    // An agent that can't be asked to wait (no modes, or none that asks): said once, so "Review
    // edits" doesn't look ignored when its changes show up after they're made.
    if (level === "ask" && !findMode(client.modes, "ask") && !this.toldNoAskMode) {
      this.toldNoAskMode = true;
      this.session.items.push({
        type: "notice",
        id: newId("n"),
        text: `${this.config.name} writes files itself and has no mode that asks first: its changes show for review after each step, and Reject puts a file back.`,
        tone: "info",
      });
      this.bump();
    }
  }
  private toldNoAskMode = false;

  /** The settings shown now (ACP's, plus a launch-flag model for agents like Copilot). */
  private shown: AcpSetting[] = [];
  /** Started over with another launch model: the agent's own memory of the chat is gone. */
  lostContext = false;

  /** The agent's settings, for the model menu (the session shows them; kept for next time). */
  private publish(settings: AcpSetting[]): void {
    this.shown = settings;
    this.session.agentSettings.value = { agent: this.config.name, settings };
    try {
      localStorage.setItem(cacheKey(this.config.name), JSON.stringify(settings));
    } catch {}
  }

  /** With `modelFlag` and no ACP model choice: the models its `--help` lists. */
  private async withLaunchModels(settings: AcpSetting[], root: string): Promise<AcpSetting[]> {
    const flag = this.config.modelFlag;
    if (!flag || settings.some((s) => s.category === "model")) return settings;
    let help = "";
    await execIpc
      .run(
        `acp-help:${this.session.id}`,
        helpCommandLine(this.config.command, this.services.platform === "windows"),
        { cwd: root, timeoutMs: 15000 },
        (chunk) => {
          help += chunk;
        },
      )
      .catch(() => {});
    const ids = helpChoices(help, flag);
    const current = this.remembered().model ?? "";
    const options = [
      { id: "", name: "Default" },
      ...ids.map((id) => ({ id, name: id })),
      ...(current && !ids.includes(current) ? [{ id: current, name: current }] : []),
    ];
    return [
      { configId: LAUNCH_SETTING, name: "Model", category: "model", current, options },
      ...settings,
    ];
  }

  /** The model / reasoning level picked last time for this agent (agent.externalAgentChoices). */
  private remembered(): Record<string, string> {
    const all =
      this.services.settings.peek<Record<string, Record<string, string>>>(
        "agent.externalAgentChoices",
      ) ?? {};
    const mine = all[this.config.name];
    return mine && typeof mine === "object" ? mine : {};
  }

  private async applyRemembered(): Promise<void> {
    const wanted = this.remembered();
    for (const setting of this.client?.settings ?? []) {
      const value = wanted[setting.category];
      if (!value || value === setting.current || !setting.options.some((o) => o.id === value))
        continue;
      // A model that went away, or an agent that refuses: it keeps its own choice.
      await this.setSetting(setting.category, value, false).catch(() => {});
    }
  }

  /**
   * The model for the turn about to run (D288): the answering agent's own (Plato on Claude Code ·
   * Sonnet), else the one remembered for this external agent (the main agent's), so the two take
   * turns on one connection. Not remembered. An agent whose model is a launch flag keeps its own
   * (switching would restart it and lose the conversation).
   */
  async syncModel(id?: string): Promise<void> {
    if (this.shown.some((s) => s.configId === LAUNCH_SETTING)) return;
    const wanted = id ?? this.remembered().model;
    if (!wanted) return;
    const setting = this.client?.settings.find((s) => s.category === "model");
    if (!this.client || !this.acpSession || !setting || setting.current === wanted) return;
    if (!setting.options.some((o) => o.id === wanted)) return;
    const next = await this.client.setSetting(this.acpSession, setting, wanted);
    this.publish([...this.shown.filter((s) => s.configId === LAUNCH_SETTING), ...next]);
  }

  /** Picks the agent's model (or reasoning level); remembered for its next sessions. */
  async setSetting(
    category: AcpSetting["category"],
    value: string,
    remember = true,
  ): Promise<void> {
    const launch = this.shown.find((s) => s.configId === LAUNCH_SETTING);
    if (category === "model" && (launch || (this.config.modelFlag && !this.client))) {
      // Chosen at launch: remembered, then the agent starts over with it (D194).
      if (value && !/^[\w.:/-]+$/.test(value)) throw new Error(`Not a model name: ${value}`);
      await this.remember(category, value);
      if (this.client) {
        await this.stop();
        this.lostContext = true;
      }
      this.publish(
        this.shown.map((s) =>
          s.configId === LAUNCH_SETTING
            ? {
                ...s,
                current: value,
                options: s.options.some((o) => o.id === value)
                  ? s.options
                  : [...s.options, { id: value, name: value }],
              }
            : s,
        ),
      );
      return;
    }
    await this.start();
    const client = this.client;
    const setting = client?.settings.find((s) => s.category === category);
    if (!client || !this.acpSession || !setting)
      throw new Error(
        `${this.config.name} doesn't offer a choice of ${category.replace("_", " ")}.`,
      );
    if (!setting.options.some((o) => o.id === value))
      throw new Error(
        `${this.config.name} has no ${category === "model" ? "model" : "level"} ${value} (it has ${setting.options.map((o) => o.id).join(", ")}).`,
      );
    const next = await client.setSetting(this.acpSession, setting, value);
    this.publish([...this.shown.filter((s) => s.configId === LAUNCH_SETTING), ...next]);
    if (remember) await this.remember(category, value);
  }

  private async remember(category: AcpSetting["category"], value: string): Promise<void> {
    const all = {
      ...(this.services.settings.peek<Record<string, Record<string, string>>>(
        "agent.externalAgentChoices",
      ) ?? {}),
    };
    all[this.config.name] = { ...this.remembered(), [category]: value };
    await this.services.settings.update("agent.externalAgentChoices", all, "user").catch(() => {});
  }

  cancel(): void {
    if (this.client && this.acpSession) this.client.cancel(this.acpSession);
    for (const id of this.terminals.keys()) void execIpc.cancel(id).catch(() => {});
  }

  /** Whether this chat's agent got the IDE's tools (D211), for ide://agent/session. */
  ideTools: "on" | "off" | "unsupported" = "off";

  /**
   * The IDE's own MCP server for the agent's session (D211): terminals, editors, diagnostics, git
   * and every agent-visible command, the tools the built-in agent has. Only for agents that take
   * HTTP MCP servers; calls run under the permission policy (writes ask). Off with
   * `agent.externalAgents.ideTools: false`.
   */
  private async ideServers(): Promise<AcpMcpServer[]> {
    ideToolsTransport.delete(this.session.id);
    if (this.services.settings.peek<boolean>("agent.externalAgents.ideTools") === false) {
      this.ideTools = "off";
      return [];
    }
    if (!this.client) {
      this.ideTools = "unsupported";
      return [];
    }
    // An agent that takes only stdio MCP servers (every ACP agent does) gets the IDE's own
    // executable as a proxy to the same server (D223).
    const http = this.client.mcpHttp;
    const proxy = http ? null : await mcpIpc.stdioProxy().catch(() => null);
    if (!http && !proxy) {
      this.ideTools = "unsupported";
      return [];
    }
    // Its calls are this chat's (D419): questions show here, under this chat's access mode.
    const lent = await mcpAgentAccess.acquire(`acp:${this.session.id}`, {
      agent: this.config.name,
      session: this.session.id,
    });
    if (!lent) {
      this.ideTools = "off";
      return [];
    }
    this.ideTools = "on";
    ideToolsTransport.set(this.session.id, http ? "http" : "stdio");
    return [ideMcpServer(lent, product.nameShort, proxy)];
  }

  async stop(): Promise<void> {
    mcpAgentAccess.release(`acp:${this.session.id}`);
    this.ideTools = "off";
    ideToolsTransport.delete(this.session.id);
    this.client?.dispose();
    this.client = undefined;
    this.acpSession = undefined;
    // The agent's terminals (a dev server it started) would run on for up to an hour.
    for (const id of this.terminals.keys()) void execIpc.cancel(id).catch(() => {});
    this.terminals.clear();
    await this.process?.stop();
    this.process = undefined;
  }
}
