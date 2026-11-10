// A minimal Agent Client Protocol client (agentclientprotocol.com, v1) over a JSON-RPC connection:
// the IDE is the client, an external agent (Claude Code, Gemini CLI, Codex…) runs as a subprocess.
// The host supplies what the agent may ask for: permission prompts, file reads/writes (the IDE's
// changeset) and terminals. DOM-free; tested with an in-memory agent.
import { RpcConnection, type Transport } from "../lsp/jsonrpc";
import { type AgentTurnUsage, type ModelTurnUsage, promptModelUsage, promptUsage } from "./display";
import { type AcpModes, parseModes } from "./modes";

/** An MCP server handed to the agent with its session (ACP `McpServer`: stdio, or HTTP when the
 * agent advertises `mcpCapabilities.http`). */
export type AcpMcpServer =
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
  | { type: "http"; name: string; url: string; headers: { name: string; value: string }[] };

export const ACP_PROTOCOL_VERSION = 1;

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name: string }
  | { type: string; [key: string]: unknown };

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export interface ToolCallFields {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  content?: ToolCallContent[];
  locations?: { path: string; line?: number | null }[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export type SessionUpdate =
  | {
      sessionUpdate: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk";
      content: ContentBlock;
    }
  | ({ sessionUpdate: "tool_call" | "tool_call_update" } & ToolCallFields)
  | { sessionUpdate: "plan"; entries: { content: string; priority?: string; status?: string }[] }
  | { sessionUpdate: string; [key: string]: unknown };

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface AcpHost {
  update(sessionId: string, update: SessionUpdate): void;
  requestPermission(params: {
    sessionId: string;
    toolCall: ToolCallFields;
    options: PermissionOption[];
  }): Promise<{ outcome: "selected"; optionId: string } | { outcome: "cancelled" }>;
  readTextFile(params: {
    sessionId: string;
    path: string;
    line?: number | null;
    limit?: number | null;
  }): Promise<string>;
  writeTextFile(params: { sessionId: string; path: string; content: string }): Promise<void>;
  createTerminal(params: {
    sessionId: string;
    command: string;
    args?: string[];
    cwd?: string | null;
    env?: { name: string; value: string }[];
    outputByteLimit?: number | null;
  }): Promise<string>;
  terminalOutput(id: string): {
    output: string;
    truncated: boolean;
    exitStatus: { exitCode: number | null; signal: string | null } | null;
  };
  waitForTerminalExit(id: string): Promise<{ exitCode: number | null; signal: string | null }>;
  killTerminal(id: string): void;
  releaseTerminal(id: string): void;
}

/** One value of an agent's setting (a model, a reasoning level). */
export interface AcpChoice {
  id: string;
  name: string;
  description?: string;
  /** The group it is listed under (ACP option groups, e.g. a provider). */
  group?: string;
}

/**
 * A setting the agent offers for its session (D193): its model or its reasoning level. ACP's
 * session config options (`configOptions`, changed with `session/set_config_option`), or the older
 * `models` list (`session/set_model`), for agents that only have that (`configId` null).
 */
export interface AcpSetting {
  configId: string | null;
  name: string;
  category: "model" | "thought_level";
  current: string | null;
  options: AcpChoice[];
}

/** A choice's label: its name without "(recommended)" (the menu marks nothing that way). */
function choiceName(name: unknown, id: string): string {
  const text = typeof name === "string" && name.trim() ? name : id;
  return text.replace(/\s*\((recommended|default)\)\s*$/i, "").trim() || id;
}

/** The model and reasoning settings in a `session/new` (or `set_config_option`) answer. */
export function parseSettings(r: unknown): AcpSetting[] {
  const out: AcpSetting[] = [];
  const o = (r ?? {}) as { configOptions?: unknown; models?: unknown };
  if (Array.isArray(o.configOptions))
    for (const raw of o.configOptions) {
      const c = raw as {
        id?: unknown;
        name?: unknown;
        category?: unknown;
        type?: unknown;
        currentValue?: unknown;
        options?: unknown;
      };
      if (c?.type !== "select" || typeof c.id !== "string" || !Array.isArray(c.options)) continue;
      if (c.category !== "model" && c.category !== "thought_level") continue;
      const options: AcpChoice[] = [];
      const value = (v: unknown, group?: string) => {
        const x = v as { value?: unknown; name?: unknown; description?: unknown };
        if (typeof x?.value !== "string") return;
        options.push({
          id: x.value,
          name: choiceName(x.name, x.value),
          ...(typeof x.description === "string" && x.description && { description: x.description }),
          ...(group && { group }),
        });
      };
      for (const entry of c.options) {
        const g = entry as { group?: unknown; name?: unknown; options?: unknown };
        if (Array.isArray(g?.options))
          for (const v of g.options) value(v, typeof g.name === "string" ? g.name : undefined);
        else value(entry);
      }
      if (!options.length) continue;
      out.push({
        configId: c.id,
        name: typeof c.name === "string" && c.name ? c.name : c.category,
        category: c.category,
        current: typeof c.currentValue === "string" ? c.currentValue : null,
        options,
      });
    }
  // The older, unstable `models` field: used only when no config option names the model.
  const m = o.models as { availableModels?: unknown; currentModelId?: unknown } | undefined;
  if (!out.some((s) => s.category === "model") && Array.isArray(m?.availableModels)) {
    const options = m.availableModels.flatMap((raw) => {
      const x = raw as { modelId?: unknown; name?: unknown; description?: unknown };
      if (typeof x?.modelId !== "string") return [];
      return [
        {
          id: x.modelId,
          name: choiceName(x.name, x.modelId),
          ...(typeof x.description === "string" && x.description && { description: x.description }),
        },
      ];
    });
    if (options.length)
      out.unshift({
        configId: null,
        name: "Model",
        category: "model",
        current: typeof m.currentModelId === "string" ? m.currentModelId : null,
        options,
      });
  }
  return out;
}

/** A slash command the agent offers (`available_commands_update`, D200). */
export interface AcpCommand {
  name: string;
  description: string;
  /** What to type after it, when it takes input. */
  hint?: string;
}

/** The commands in an `available_commands_update` (names without the slash). */
export function parseAvailableCommands(update: unknown): AcpCommand[] {
  const list = (update as { availableCommands?: unknown })?.availableCommands;
  if (!Array.isArray(list)) return [];
  const out: AcpCommand[] = [];
  for (const raw of list) {
    const c = raw as { name?: unknown; description?: unknown; input?: { hint?: unknown } | null };
    const name = typeof c?.name === "string" ? c.name.replace(/^\//, "").trim() : "";
    if (!name || /\s/.test(name) || out.some((x) => x.name === name)) continue;
    out.push({
      name,
      description: typeof c.description === "string" ? c.description : "",
      ...(typeof c.input?.hint === "string" && c.input.hint && { hint: c.input.hint }),
    });
  }
  return out;
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string;
}

export class AcpClient {
  readonly connection: RpcConnection;
  authMethods: AuthMethod[] = [];
  agentName = "";

  constructor(transport: Transport, host: AcpHost) {
    const c = new RpcConnection(transport);
    this.connection = c;
    c.onNotification("session/update", (p) => {
      const { sessionId, update } = p as { sessionId: string; update: SessionUpdate };
      if (update && typeof update === "object") host.update(sessionId, update);
    });
    c.onRequest("session/request_permission", (p) =>
      host
        .requestPermission(p as Parameters<AcpHost["requestPermission"]>[0])
        .then((outcome) => ({ outcome })),
    );
    c.onRequest("fs/read_text_file", async (p) => ({
      content: await host.readTextFile(p as Parameters<AcpHost["readTextFile"]>[0]),
    }));
    c.onRequest("fs/write_text_file", async (p) => {
      await host.writeTextFile(p as Parameters<AcpHost["writeTextFile"]>[0]);
      return {};
    });
    c.onRequest("terminal/create", async (p) => ({
      terminalId: await host.createTerminal(p as Parameters<AcpHost["createTerminal"]>[0]),
    }));
    c.onRequest("terminal/output", (p) =>
      host.terminalOutput((p as { terminalId: string }).terminalId),
    );
    c.onRequest("terminal/wait_for_exit", (p) =>
      host.waitForTerminalExit((p as { terminalId: string }).terminalId),
    );
    c.onRequest("terminal/kill", (p) => {
      host.killTerminal((p as { terminalId: string }).terminalId);
      return {};
    });
    c.onRequest("terminal/release", (p) => {
      host.releaseTerminal((p as { terminalId: string }).terminalId);
      return {};
    });
  }

  /** What the agent takes in a prompt besides text (images, embedded files). */
  promptCapabilities: { image?: boolean; embeddedContext?: boolean } = {};
  /** The agent can pick up an earlier session (`session/load`, D200). */
  canLoadSession = false;
  /** The agent takes HTTP MCP servers in session/new (`mcpCapabilities.http`, D211). */
  mcpHttp = false;

  /** `timeoutMs`: longer for an agent a package runner fetches first (npx, D401). */
  async initialize(clientName: string, timeoutMs = 120000): Promise<void> {
    const r = await this.connection.request<{
      protocolVersion?: number;
      authMethods?: AuthMethod[];
      agentInfo?: { name?: string; title?: string };
      agentCapabilities?: {
        promptCapabilities?: { image?: boolean; embeddedContext?: boolean };
        loadSession?: boolean;
        mcpCapabilities?: { http?: boolean; sse?: boolean };
      };
    }>(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: { name: clientName, version: "1" },
      },
      { timeoutMs },
    );
    this.authMethods = r?.authMethods ?? [];
    this.promptCapabilities = r?.agentCapabilities?.promptCapabilities ?? {};
    this.canLoadSession = r?.agentCapabilities?.loadSession === true;
    this.mcpHttp = r?.agentCapabilities?.mcpCapabilities?.http === true;
    this.agentName = r?.agentInfo?.title ?? r?.agentInfo?.name ?? "";
  }

  authenticate(methodId: string): Promise<unknown> {
    return this.connection.request("authenticate", { methodId }, { timeoutMs: 600000 });
  }

  async newSession(cwd: string, mcpServers: AcpMcpServer[] = []): Promise<string> {
    const r = await this.connection.request<{ sessionId: string }>(
      "session/new",
      { cwd, mcpServers },
      { timeoutMs: 120000 },
    );
    if (!r?.sessionId) throw new Error("The agent didn't start a session.");
    this.settings = parseSettings(r);
    this.modes = parseModes(r);
    return r.sessionId;
  }

  /**
   * Picks up an earlier session after a restart (D200): the agent replays the conversation as
   * session/update notifications before it answers (the host decides what to do with them).
   */
  async loadSession(
    sessionId: string,
    cwd: string,
    mcpServers: Parameters<AcpClient["newSession"]>[1] = [],
  ): Promise<void> {
    const r = await this.connection.request<unknown>(
      "session/load",
      { sessionId, cwd, mcpServers },
      { timeoutMs: 120000 },
    );
    this.settings = parseSettings(r);
    this.modes = parseModes(r);
  }

  /** The session's modes (D227), as the agent last reported them; null when it has none. */
  modes: AcpModes | null = null;

  /** Switches the session's mode (`session/set_mode`). */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.connection.request("session/set_mode", { sessionId, modeId });
    if (this.modes) this.modes = { ...this.modes, current: modeId };
  }

  /** The session's model and reasoning settings, as the agent last reported them (D193). */
  settings: AcpSetting[] = [];

  /** Changes a setting; the agent's answer (all settings) replaces `settings`. */
  async setSetting(sessionId: string, setting: AcpSetting, value: string): Promise<AcpSetting[]> {
    if (setting.configId === null) {
      await this.connection.request("session/set_model", { sessionId, modelId: value });
      this.settings = this.settings.map((s) => (s === setting ? { ...s, current: value } : s));
    } else {
      const r = await this.connection.request("session/set_config_option", {
        sessionId,
        configId: setting.configId,
        value,
      });
      const next = parseSettings(r);
      // An agent that answers without the list: only this value changed.
      this.settings = next.length
        ? this.mergeLegacy(next)
        : this.settings.map((s) =>
            s.configId === setting.configId ? { ...s, current: value } : s,
          );
    }
    return this.settings;
  }

  /** `config_option_update`: the agent changed its settings itself. */
  updateSettings(configOptions: unknown): AcpSetting[] {
    this.settings = this.mergeLegacy(parseSettings({ configOptions }));
    return this.settings;
  }

  /** Config options don't carry the older model list: keep it when they name no model. */
  private mergeLegacy(next: AcpSetting[]): AcpSetting[] {
    const legacy = this.settings.find((s) => s.configId === null);
    return legacy && !next.some((s) => s.category === "model") ? [legacy, ...next] : next;
  }

  /** The tokens the last turn used, when the agent said (D208: `usage` in its answer). */
  lastUsage: AgentTurnUsage | null = null;
  /** The last turn's tokens by model (`_meta.quota.model_usage`, D223), when the agent said. */
  lastModelUsage: ModelTurnUsage[] = [];

  /** Resolves with the stop reason when the agent's turn ends. */
  async prompt(sessionId: string, prompt: ContentBlock[]): Promise<string> {
    this.lastUsage = null;
    this.lastModelUsage = [];
    const r = await this.connection.request<{ stopReason?: string }>("session/prompt", {
      sessionId,
      prompt,
    });
    this.lastUsage = promptUsage(r);
    this.lastModelUsage = promptModelUsage(r);
    return r?.stopReason ?? "end_turn";
  }

  cancel(sessionId: string): void {
    this.connection.notify("session/cancel", { sessionId });
  }

  dispose(): void {
    this.connection.dispose();
  }
}
