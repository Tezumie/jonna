// Node only. `acp`: the agent as an Agent Client Protocol agent (version 1, the version the
// IDE's own client speaks: src/core/acp/client.ts) on standard input and output, newline-delimited
// JSON-RPC. An editor starts it, opens sessions in a folder, sends prompts, and gets the work
// back as session updates: text, thoughts, tool calls with their status and diffs. Permission
// requests go to the editor. Sessions are the app's chats (session/load resumes one).
//
// One process serves one folder: the brain starts with the first session's `cwd`.
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  ACP_PROTOCOL_VERSION,
  type ContentBlock,
  type PermissionOption,
  type SessionUpdate,
  type ToolCallContent,
  type ToolCallFields,
} from "../../core/acp/client";
import { Emitter } from "../../core/events/index";
import { RpcConnection, RpcError, type Transport } from "../../core/lsp/jsonrpc";
import { product } from "../../core/product";
import { modeSettings } from "../../extensions/agent/unattended";
import type { AccessMode, BrainChat, HostedBrain, SessionEvent } from "../run";
import type { CliArgs } from "./args";
import { EFFORTS, limitsOf, policyOf } from "./config";
import type { Io } from "./io";
import { openChat, start } from "./launch";
import { cliName } from "./name";
import { EXIT } from "./output";
import { toolBrief } from "./render";
import { disposeSoon } from "./serve";

/** A session's mode as the editor sees it: one of the app's access modes, or plan. */
type AcpModeId = AccessMode | "plan";

const MODES: readonly { id: AcpModeId; name: string; description: string }[] = [
  { id: "ask", name: "Ask", description: "Edits are kept for your review; commands ask first" },
  {
    id: "accept-edits",
    name: "Accept edits",
    description: "Edits are accepted; commands ask first",
  },
  { id: "auto", name: "Auto", description: "Commands run; risky ones still ask" },
  { id: "full-access", name: "Full access", description: "Nothing asks" },
  { id: "plan", name: "Plan", description: "Read-only: researches and writes a plan" },
];

interface AcpSession {
  chat: BrainChat;
  mode: AcpModeId;
  /** The prompt under way: aborting it stops the turn. */
  running: AbortController | null;
  cancelled: boolean;
  /** Tool calls started and not ended (a permission request is about the newest). */
  openTools: string[];
  events: { dispose(): void };
}

/** The text of a prompt's content blocks: text as it is, files by their path or their content. */
export function promptText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "resource_link" && typeof block.uri === "string")
      parts.push(`@${fileOfUri(block.uri)}`);
    else if (block.type === "resource") {
      const resource = (block as { resource?: { uri?: unknown; text?: unknown } }).resource;
      if (typeof resource?.text === "string")
        parts.push(
          `<file path="${typeof resource.uri === "string" ? fileOfUri(resource.uri) : "attached"}">\n${resource.text}\n</file>`,
        );
    }
  }
  return parts.join("\n").trim();
}

function fileOfUri(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    const path = decodeURIComponent(new URL(uri).pathname);
    return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path;
  } catch {
    return uri;
  }
}

/** ACP's kind for one of the agent's tools (it picks the icon in an editor). */
export function toolKind(name: string): string {
  if (/^(read_file|read_|list_|view_)/.test(name)) return "read";
  if (/^(write_file|edit_file|apply_patch|multi_edit|create_)/.test(name)) return "edit";
  if (/^(delete_|remove_)/.test(name)) return "delete";
  if (/^(move_|rename_)/.test(name)) return "move";
  if (/(search|grep|find|glob)/.test(name)) return "search";
  if (/^(run_command|run_|exec|terminal)/.test(name)) return "execute";
  if (/(fetch|web)/.test(name)) return "fetch";
  if (/(think|plan|todo)/.test(name)) return "think";
  return "other";
}

/** A chat event as the session update it becomes; null when the editor isn't told. */
export function updateOf(event: SessionEvent): SessionUpdate | null {
  switch (event.type) {
    case "text":
      return event.delta
        ? { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.delta } }
        : null;
    case "thinking":
      return event.delta
        ? { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.delta } }
        : null;
    case "tool.start": {
      const brief = toolBrief(event.name, event.args);
      return {
        sessionUpdate: "tool_call",
        toolCallId: event.id,
        title: brief ? `${event.name}: ${brief.split("\n")[0]?.slice(0, 200)}` : event.name,
        kind: toolKind(event.name),
        status: "in_progress",
        rawInput: event.args,
      };
    }
    case "tool.update":
      return { sessionUpdate: "tool_call_update", toolCallId: event.id, rawInput: event.args };
    case "notice":
      return event.tone === "error"
        ? {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: `${event.text}\n` },
          }
        : null;
    default:
      return null;
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runAcp(args: CliArgs, io: Io): Promise<number> {
  // Standard output carries the protocol and nothing else.
  const received = new Emitter<string>();
  const transport: Transport = {
    send: (body) => {
      io.out(`${body}\n`);
    },
    onMessage: received.event,
  };
  const connection = new RpcConnection(transport);
  let buffer = "";
  io.stdin.setEncoding("utf8");
  io.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line) received.fire(line);
      at = buffer.indexOf("\n");
    }
  });

  let finish: (code: number) => void = () => {};
  const finished = new Promise<number>((done) => {
    finish = done;
  });
  io.stdin.on("end", () => finish(EXIT.ok));
  io.stdin.on("close", () => finish(EXIT.ok));
  io.onBroken(() => finish(EXIT.ok));
  const onSignal = () => finish(EXIT.interrupted);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const policy = policyOf(args, true);
  const startMode: AcpModeId = args.mode === "plan" ? "plan" : (args.permissionMode ?? "ask");
  let booting: Promise<{ brain: HostedBrain; folder: string }> | null = null;
  const sessions = new Map<string, AcpSession>();

  /** The brain, started in the first session's folder. */
  const brainFor = (cwd: unknown): Promise<{ brain: HostedBrain; folder: string }> => {
    const wanted = typeof cwd === "string" && cwd ? resolve(cwd) : undefined;
    if (!booting) {
      booting = start(
        { ...args, ...(wanted && { cwd: wanted }) },
        {
          frontend: "acp",
          policy,
          ...(args.verbose && { log: (text: string) => io.err(text) }),
        },
      ).then((started) => {
        for (const note of started.notes) io.err(`${note}\n`);
        started.brain.onHostExit((code, signal) => {
          io.err(`The host program ended unexpectedly (${signal ?? `exit code ${code}`}).\n`);
          finish(EXIT.failed);
          setTimeout(() => process.exit(EXIT.failed), 500);
        });
        return { brain: started.brain, folder: started.folder };
      });
      booting.catch(() => {
        booting = null;
      });
    }
    return booting.then((ready) => {
      const same = (a: string, b: string) =>
        process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
      if (wanted && !same(wanted, ready.folder))
        throw new RpcError(
          -32602,
          `This agent process works in ${ready.folder}; start another one for ${wanted}.`,
        );
      return ready;
    });
  };

  const notify = (sessionId: string, update: SessionUpdate): void =>
    connection.notify("session/update", { sessionId, update });

  /** MCP servers the editor hands over join the run's own (the app's format). */
  const addMcpServers = (brain: HostedBrain, servers: unknown): void => {
    if (!Array.isArray(servers) || !servers.length) return;
    const merged: Record<string, unknown> = {
      ...(brain.services.settings.peek<Record<string, unknown>>("agent.mcpServers") ?? {}),
    };
    for (const raw of servers) {
      const s = raw as {
        name?: unknown;
        command?: unknown;
        args?: unknown;
        env?: { name?: unknown; value?: unknown }[];
        url?: unknown;
        headers?: { name?: unknown; value?: unknown }[];
      };
      if (typeof s?.name !== "string") continue;
      const pairs = (list: { name?: unknown; value?: unknown }[] | undefined) =>
        Object.fromEntries(
          (Array.isArray(list) ? list : []).flatMap((e) =>
            typeof e?.name === "string" && typeof e.value === "string" ? [[e.name, e.value]] : [],
          ),
        );
      if (typeof s.command === "string")
        merged[s.name] = {
          command: s.command,
          args: Array.isArray(s.args) ? s.args.map(String) : [],
          env: pairs(s.env),
        };
      else if (typeof s.url === "string")
        merged[s.name] = { url: s.url, headers: pairs(s.headers) };
    }
    brain.override({ "agent.mcpServers": merged });
  };

  const modelKey = (brain: HostedBrain, chat: BrainChat): string | null =>
    chat.session.model.peek() ?? brain.agent.providers.defaultModel()?.key ?? null;

  /** What a session offers: its modes, its model and its reasoning effort. */
  const describe = (brain: HostedBrain, session: AcpSession) => {
    const models = brain.agent.providers.models.peek().map((m) => m.key);
    const current = modelKey(brain, session.chat);
    if (current && !models.includes(current)) models.unshift(current);
    return {
      modes: {
        currentModeId: session.mode,
        availableModes: MODES.map((m) => ({ ...m })),
      },
      configOptions: [
        ...(models.length
          ? [
              {
                id: "model",
                name: "Model",
                category: "model",
                type: "select",
                currentValue: current ?? models[0],
                options: models.map((value) => ({ value, name: value })),
              },
            ]
          : []),
        {
          id: "effort",
          name: "Reasoning effort",
          category: "thought_level",
          type: "select",
          currentValue: brain.services.settings.peek<string>("agent.effort") || "default",
          options: EFFORTS.map((value) => ({ value, name: value })),
        },
      ],
    };
  };

  /** Makes the brain's settings and the chat match the session's mode (before each turn). */
  const applyMode = async (brain: HostedBrain, session: AcpSession): Promise<void> => {
    const access: AccessMode = session.mode === "plan" ? "ask" : session.mode;
    const applied = modeSettings(access);
    policy.mode = access;
    brain.override(applied.settings);
    session.chat.session.autoApply.value = applied.autoApply;
    const work = session.mode === "plan" ? "plan" : "agent";
    if (session.chat.session.work() !== work)
      await brain.execute("agent.setChatMode", { session: session.chat.id, mode: work });
  };

  /** The change a tool call made to `path`, as a diff the editor can show. */
  const diffOf = async (
    brain: HostedBrain,
    session: AcpSession,
    path: string,
  ): Promise<ToolCallContent | null> => {
    const absolute = isAbsolute(path) ? path : brain.services.workspace.resolve(path);
    const changeset = session.chat.session.changeset;
    const pending = changeset.get(absolute);
    if (pending)
      return {
        type: "diff",
        path: absolute,
        oldText: pending.original,
        newText: pending.deleted ? "" : pending.proposed,
      };
    const before = changeset.appliedBefore(absolute);
    if (before === undefined) return null;
    const now = await readFile(absolute, "utf8").catch(() => "");
    return { type: "diff", path: absolute, oldText: before, newText: now };
  };

  const askClient = async (
    sessionId: string,
    toolCall: ToolCallFields,
    options: PermissionOption[],
  ): Promise<string | null> => {
    try {
      const answer = await connection.request<{
        outcome?: { outcome?: string; optionId?: string };
      }>("session/request_permission", { sessionId, toolCall, options });
      return answer?.outcome?.outcome === "selected" ? (answer.outcome.optionId ?? null) : null;
    } catch {
      return null;
    }
  };

  const onEvent = (brain: HostedBrain, session: AcpSession, event: SessionEvent): void => {
    const sessionId = session.chat.id;
    const update = updateOf(event);
    if (update) notify(sessionId, update);
    if (event.type === "tool.start") session.openTools.push(event.id);
    else if (event.type === "tool.end") {
      session.openTools = session.openTools.filter((id) => id !== event.id);
      void (async () => {
        const diffs: ToolCallContent[] = [];
        for (const path of event.changes ?? []) {
          const diff = await diffOf(brain, session, path).catch(() => null);
          if (diff) diffs.push(diff);
        }
        const result = (event.result ?? event.summary ?? "").slice(0, 20_000);
        notify(sessionId, {
          sessionUpdate: "tool_call_update",
          toolCallId: event.id,
          status: event.status === "done" ? "completed" : "failed",
          content: [
            ...diffs,
            ...(result
              ? [{ type: "content" as const, content: { type: "text" as const, text: result } }]
              : []),
          ],
          ...(event.changes?.length && {
            locations: event.changes.map((path) => ({
              path: isAbsolute(path) ? path : brain.services.workspace.resolve(path),
            })),
          }),
        });
      })();
    } else if (event.type === "permission.request") {
      void (async () => {
        const toolCallId = session.openTools.at(-1) ?? `permission-${event.id}`;
        const chosen = await askClient(
          sessionId,
          {
            toolCallId,
            title: event.code ? `${event.title}: ${event.code}` : event.title,
            kind: event.kind === "command" ? "execute" : "other",
            status: "pending",
            ...(event.code && { rawInput: { command: event.code } }),
            ...(event.detail && {
              content: [{ type: "content", content: { type: "text", text: event.detail } }],
            }),
          },
          [
            { optionId: "once", name: "Allow", kind: "allow_once" },
            ...(event.always
              ? [
                  {
                    optionId: "always",
                    name: `Always allow ${event.always}`,
                    kind: "allow_always" as const,
                  },
                ]
              : []),
            { optionId: "deny", name: "Reject", kind: "reject_once" },
          ],
        );
        const answer = chosen === "once" || chosen === "always" ? chosen : "deny";
        await brain
          .execute("agent.respondPermission", { session: sessionId, id: event.id, answer })
          .catch(() => {});
      })();
    } else if (event.type === "question") {
      // The protocol has no question of its own: each one is asked as a choice among its options.
      void (async () => {
        const answers: Record<string, string> = {};
        let any = false;
        for (const [index, q] of event.questions.entries()) {
          if (!q.options.length) continue;
          const chosen = await askClient(
            sessionId,
            {
              toolCallId: event.id,
              title: q.question || q.header || "Question",
              kind: "other",
              status: "pending",
            },
            [
              ...q.options.map((o, n) => ({
                optionId: `option-${n}`,
                name: o.label,
                kind: "allow_once" as const,
              })),
              { optionId: "skip", name: "Skip", kind: "reject_once" },
            ],
          );
          const picked = /^option-(\d+)$/.exec(chosen ?? "");
          const label = picked ? q.options[Number(picked[1])]?.label : undefined;
          if (label) {
            answers[String(index + 1)] = label;
            any = true;
          } else answers[String(index + 1)] = "The user skipped this question";
        }
        await brain
          .execute(
            "agent.answer",
            any
              ? { session: sessionId, item: event.id, answers }
              : { session: sessionId, item: event.id, skip: true },
          )
          .catch(() => {});
      })();
    }
  };

  const adopt = (brain: HostedBrain, chat: BrainChat, mode: AcpModeId): AcpSession => {
    const existing = sessions.get(chat.id);
    if (existing) return existing;
    const session: AcpSession = {
      chat,
      mode,
      running: null,
      cancelled: false,
      openTools: [],
      events: { dispose: () => {} },
    };
    session.events = chat.onEvent((event) => onEvent(brain, session, event));
    sessions.set(chat.id, session);
    return session;
  };

  const sessionOf = (id: unknown): AcpSession => {
    const session = typeof id === "string" ? sessions.get(id) : undefined;
    if (!session)
      throw new RpcError(
        -32602,
        `No session ${String(id)}: open it with session/new or session/load.`,
      );
    return session;
  };

  /** The app's slash commands, offered to the editor once a session exists. */
  const offerCommands = (brain: HostedBrain, sessionId: string): void => {
    void brain
      .execute<{ commands: { name: string; description: string; argumentHint?: string }[] }>(
        "agent.slash",
        { session: sessionId, pick: false },
      )
      .then(({ commands }) =>
        notify(sessionId, {
          sessionUpdate: "available_commands_update",
          availableCommands: commands.map((c) => ({
            name: c.name,
            description: c.description,
            ...(c.argumentHint && { input: { hint: c.argumentHint } }),
          })),
        }),
      )
      .catch(() => {});
  };

  connection.onRequest("initialize", (params) => {
    const asked = (params as { protocolVersion?: unknown } | null)?.protocolVersion;
    return {
      // The version both sides speak: this agent's only one, whatever newer one was asked for.
      protocolVersion:
        typeof asked === "number" && asked < ACP_PROTOCOL_VERSION ? asked : ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: false },
      },
      agentInfo: {
        name: cliName(),
        title: product.nameLong,
        version: product.version,
      },
      authMethods: [],
    };
  });
  connection.onRequest("authenticate", () => ({}));

  connection.onRequest("session/new", async (params) => {
    const p = (params ?? {}) as { cwd?: unknown; mcpServers?: unknown };
    const { brain } = await brainFor(p.cwd);
    addMcpServers(brain, p.mcpServers);
    const { chat } = await openChat(
      brain,
      { ...args, continue: false, resume: undefined, sessionId: undefined },
      false,
    );
    const session = adopt(brain, chat, startMode);
    await applyMode(brain, session);
    setTimeout(() => offerCommands(brain, chat.id), 0);
    return { sessionId: chat.id, ...describe(brain, session) };
  });

  connection.onRequest("session/load", async (params) => {
    const p = (params ?? {}) as { sessionId?: unknown; cwd?: unknown; mcpServers?: unknown };
    if (typeof p.sessionId !== "string") throw new RpcError(-32602, "sessionId is needed.");
    const { brain } = await brainFor(p.cwd);
    addMcpServers(brain, p.mcpServers);
    const { chat } = await openChat(
      brain,
      {
        ...args,
        continue: false,
        resume: undefined,
        sessionId: undefined,
        model: undefined,
        agent: undefined,
      },
      false,
      p.sessionId,
    );
    // The conversation so far, replayed before the answer (as the protocol asks).
    for (const item of chat.session.items) {
      if (item.type === "user" && !item.auto)
        notify(chat.id, {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: item.text },
        });
      else if (item.type === "assistant") {
        if (item.thinking)
          notify(chat.id, {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: item.thinking },
          });
        if (item.text)
          notify(chat.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: item.text },
          });
      } else if (item.type === "tool") {
        const brief = toolBrief(item.name, item.args);
        notify(chat.id, {
          sessionUpdate: "tool_call",
          toolCallId: item.id,
          title: brief ? `${item.name}: ${brief.split("\n")[0]?.slice(0, 200)}` : item.name,
          kind: toolKind(item.name),
          status: item.status === "done" ? "completed" : "failed",
          rawInput: item.args,
          ...(item.result && {
            content: [
              { type: "content", content: { type: "text", text: item.result.slice(0, 20_000) } },
            ],
          }),
        });
      }
    }
    const session = adopt(brain, chat, startMode);
    await applyMode(brain, session);
    setTimeout(() => offerCommands(brain, chat.id), 0);
    return describe(brain, session);
  });

  connection.onRequest("session/prompt", async (params) => {
    const p = (params ?? {}) as { sessionId?: unknown; prompt?: unknown };
    const session = sessionOf(p.sessionId);
    const { brain } = await brainFor(undefined);
    const text = promptText(Array.isArray(p.prompt) ? (p.prompt as ContentBlock[]) : []);
    if (!text) throw new RpcError(-32602, "The prompt has no text.");
    if (session.running) throw new RpcError(-32600, "This session is already working on a prompt.");
    await applyMode(brain, session);
    session.running = new AbortController();
    session.cancelled = false;
    const before = { ...session.chat.session.totals.peek() };
    try {
      const result = await session.chat.send(text, {
        ...limitsOf(args),
        signal: session.running.signal,
      });
      // Edits held for review (the ask mode): the editor decides about each file now.
      if (!session.cancelled)
        for (const path of result.pending) {
          const diff = await diffOf(brain, session, path).catch(() => null);
          const chosen = await askClient(
            session.chat.id,
            {
              toolCallId: `review-${path}`,
              title: `Apply the changes to ${path}`,
              kind: "edit",
              status: "pending",
              ...(diff && { content: [diff] }),
              locations: [{ path }],
            },
            [
              { optionId: "accept", name: "Apply", kind: "allow_once" },
              { optionId: "reject", name: "Discard", kind: "reject_once" },
            ],
          );
          await brain
            .execute(chosen === "accept" ? "agent.acceptAll" : "agent.rejectAll", {
              session: session.chat.id,
              paths: [path],
            })
            .catch((err) => io.err(`review of ${path}: ${messageOf(err)}\n`));
        }
      if (result.reason === "error")
        throw new RpcError(-32603, result.error ?? "The model or the provider failed.");
      const totals = session.chat.session.totals.peek();
      const input = totals.input - before.input;
      const output = totals.output - before.output;
      const cached = totals.cacheRead - before.cacheRead;
      return {
        stopReason:
          session.cancelled || result.reason === "cancelled" || result.reason === "stopped"
            ? "cancelled"
            : result.reason === "end"
              ? "end_turn"
              : "max_turn_requests",
        usage: {
          inputTokens: input,
          outputTokens: output,
          cachedReadTokens: cached,
          totalTokens: input + output + cached,
        },
      };
    } finally {
      session.running = null;
    }
  });

  connection.onNotification("session/cancel", (params) => {
    const session = sessions.get(String((params as { sessionId?: unknown } | null)?.sessionId));
    if (!session?.running) return;
    session.cancelled = true;
    session.running.abort();
  });

  connection.onRequest("session/set_mode", async (params) => {
    const p = (params ?? {}) as { sessionId?: unknown; modeId?: unknown };
    const session = sessionOf(p.sessionId);
    const mode = MODES.find((m) => m.id === p.modeId)?.id;
    if (!mode)
      throw new RpcError(
        -32602,
        `No mode ${String(p.modeId)}: ${MODES.map((m) => m.id).join(", ")}.`,
      );
    session.mode = mode;
    const { brain } = await brainFor(undefined);
    if (!session.running) await applyMode(brain, session);
    notify(session.chat.id, { sessionUpdate: "current_mode_update", currentModeId: mode });
    return {};
  });

  const setModel = async (session: AcpSession, model: string): Promise<void> => {
    const { brain } = await brainFor(undefined);
    try {
      await brain.execute("agent.selectModel", {
        session: session.chat.id,
        model,
        remember: false,
      });
    } catch (err) {
      throw new RpcError(-32602, messageOf(err));
    }
  };

  connection.onRequest("session/set_config_option", async (params) => {
    const p = (params ?? {}) as { sessionId?: unknown; configId?: unknown; value?: unknown };
    const session = sessionOf(p.sessionId);
    const { brain } = await brainFor(undefined);
    const value = String(p.value ?? "");
    if (p.configId === "model") await setModel(session, value);
    else if (p.configId === "effort") {
      if (!(EFFORTS as readonly string[]).includes(value))
        throw new RpcError(-32602, `Effort is one of ${EFFORTS.join(", ")}.`);
      brain.override({ "agent.effort": value });
    } else throw new RpcError(-32602, `No option ${String(p.configId)}.`);
    return { configOptions: describe(brain, session).configOptions };
  });

  connection.onRequest("session/set_model", async (params) => {
    const p = (params ?? {}) as { sessionId?: unknown; modelId?: unknown };
    await setModel(sessionOf(p.sessionId), String(p.modelId ?? ""));
    return {};
  });

  const code = await finished;
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  for (const session of sessions.values()) session.events.dispose();
  connection.dispose();
  const ready = await (booting as Promise<{ brain: HostedBrain }> | null)?.catch(() => null);
  if (ready) await disposeSoon(ready.brain);
  return code;
}
