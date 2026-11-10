// The agent's monitor tool (D322, Claude Code's Monitor): a background command whose output lines
// are events. It runs as one of the chat's background commands (backgroundProcesses.ts: its id,
// the chat's list, kill_process, the folder closing), in the shell run_command uses (PowerShell
// on Windows), after run_command's permission check. Lines within 200 ms go to the chat as one
// automatic message (`auto: "monitor"`): a turn of its own when the chat is idle, or into the
// running turn at its next step, as a background command's end does (D253). A monitor sending
// too much is stopped; every one ends after its timeout. The batching rules are in
// core/agent/monitor.ts.

import type { ToolOutcome } from "../../core/agent/loop";
import {
  LineSplitter,
  MONITOR_BATCH_MS,
  type MonitorEnd,
  MonitorEvents,
  monitorEndText,
  monitorEventText,
  monitorTimeout,
  shortDuration,
  wsAddress,
  wsProtocols,
} from "../../core/agent/monitor";
import { sandboxArg } from "../../core/agent/sandbox";
import type { DisposableStore } from "../../core/lifecycle/index";
import type { WorkbenchServices } from "../../workbench/services";
import {
  type BackgroundProcess,
  backgroundProcesses,
  MAX_RUNNING_PER_CHAT,
} from "./backgroundProcesses";
import { askToConnect, openMonitorSocket, type SocketFeed } from "./monitorSocket";
import { sandboxPlanFor } from "./sandboxRun";
import { deliverAutoMessage } from "./sessionSubagents";
import type { SessionManager } from "./sessions";
import { helperEnvOf } from "./toolRoots";
import { type AgentTool, askToRun, commandFolder, type ToolHost } from "./tools";

/** How each running monitor ends early (the IDE's own reasons; a kill says nothing). */
const ending = new Map<string, MonitorEnd>();

function monitorTool(services: WorkbenchServices, sessions: SessionManager): AgentTool {
  const windows = services.platform === "windows";
  return {
    spec: {
      name: "monitor",
      description: `Start a background monitor: a command whose every output line is an event. You keep working; events arrive in this chat as messages (they start a turn of yours when you're idle). Lines within 200ms come as one message. Pick by how many messages you need: one ("tell me when the server is ready") → run_command with background: true and notify_on_exit, a command that exits when the condition holds; one per occurrence ("every time an ERROR line appears") → monitor with a command that never ends (${windows ? "Get-Content app.log -Wait -Tail 0 | Select-String ERROR" : "tail -f app.log | grep --line-buffered ERROR"}, a polling loop); one per occurrence until a known end → a command that prints lines, then exits. Its output is the event stream; its exit ends the watch (you get a message). Filter in the command so only what matters prints, and make the filter match every terminal state (errors, crashes), not just success: silence isn't success. A monitor that sends too many messages is stopped. It expires after timeout_ms (default 300000 = 5 minutes, at most 1800000): killed, and you get one message with the event count; start it again if you still need it. Stop it early with kill_process (its id, e.g. "bg3"). A WebSocket feed: ws: { url } instead of command, each message one event. A command runs in the shell run_command uses${windows ? " (PowerShell)" : ""}, and may ask the user like run_command.`,
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command whose output lines are events" },
          ws: {
            type: "object",
            description:
              "Instead of command: open a WebSocket and stream each incoming text frame as one event (a multiline frame stays one; binary frames come as [binary frame, N bytes]). No shell, no polling. Its close ends the watch, with the close code; errors come first.",
            properties: {
              url: { type: "string", description: "ws:// or wss:// address" },
              protocols: {
                type: "array",
                items: { type: "string" },
                description: "Subprotocols to ask for",
              },
            },
            required: ["url"],
          },
          description: {
            type: "string",
            description: 'What it watches, shown with every event ("errors in the dev server")',
          },
          timeout_ms: {
            type: "integer",
            description: "Stop it after this long (default 300000, at most 1800000)",
          },
          cwd: { type: "string", description: "Folder, relative to the workspace (default: root)" },
        },
        required: ["description"],
      },
    },
    readOnly: false,
    concurrent: false,
    verb: "Monitoring",
    target: (a) => String(a.description ?? a.command ?? ""),
    async run(args, host) {
      const command = typeof args.command === "string" ? args.command.trim() : "";
      const ws = socketArg(args.ws);
      const description =
        typeof args.description === "string" && args.description.trim()
          ? args.description.trim().slice(0, 120)
          : (command || String(ws?.url ?? "")).slice(0, 60);
      if (ws) {
        if (command) return { result: 'Error: give "command" or "ws", not both.', isError: true };
        return startSocketMonitor(host, ws, description, monitorTimeout(args.timeout_ms), sessions);
      }
      if (!command) return { result: 'Error: "command" (or "ws") is required.', isError: true };
      // In the command sandbox as run_command (D336).
      const plan = await sandboxPlanFor(services, args);
      const refused = await askToRun(host, command, args, plan);
      if (refused) return refused;
      if (host.cancelled()) return { result: "Stopped by the user.", isError: true };
      const folder = commandFolder(host, args.cwd);
      const timeoutMs = monitorTimeout(args.timeout_ms);
      let p: BackgroundProcess;
      try {
        p = backgroundProcesses.start(
          host.session,
          command,
          folder.abs,
          folder.label,
          helperEnvOf(host.session),
          sandboxArg(plan),
        );
      } catch (err) {
        return {
          result: `Error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
      watch(p, description, timeoutMs, sessions);
      return {
        result: `Monitor ${p.id} started: \`${command}\`${folder.label !== "." ? ` in ${folder.label}` : ""}. Its output lines will arrive as messages ("${description}"); it expires in ${shortDuration(timeoutMs)}. Go on with other work; stop it with kill_process { id: "${p.id}" }.`,
        summary: `${p.id} · ${shortDuration(timeoutMs)}`,
      };
    },
  };
}

/** `ws` as given: an object, its JSON as a string (some models send that), or a bare address. */
function socketArg(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    if (text.startsWith("{"))
      try {
        const parsed: unknown = JSON.parse(text);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      } catch {
        return { url: text };
      }
    return { url: text };
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** A WebSocket monitor (D328): asks, connects, then watches like a command's. */
async function startSocketMonitor(
  host: ToolHost,
  ws: Record<string, unknown>,
  description: string,
  timeoutMs: number,
  sessions: SessionManager,
): Promise<ToolOutcome> {
  const url = wsAddress(ws.url);
  if (!url) return { result: 'Error: "ws.url" must be a ws:// or wss:// address.', isError: true };
  const protocols = wsProtocols(ws.protocols);
  if (!protocols)
    return { result: 'Error: "ws.protocols" must be subprotocol names.', isError: true };
  const refused = await askToConnect(host, url);
  if (refused) return refused;
  if (host.cancelled()) return { result: "Stopped by the user.", isError: true };
  if (
    backgroundProcesses.list(host.session).filter((p) => p.status === "running").length >=
    MAX_RUNNING_PER_CHAT
  )
    return {
      result: `Error: ${MAX_RUNNING_PER_CHAT} background commands are running in this chat already; stop one with kill_process first.`,
      isError: true,
    };
  let feed: SocketFeed;
  try {
    // Rust closes it a little after the monitor's own timeout, in case this page is gone.
    feed = await openMonitorSocket(url, protocols, timeoutMs + 10_000);
  } catch (err) {
    return {
      result: `Error: couldn't open the WebSocket: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
  const p = backgroundProcesses.startWith(host.session, url, ".", () => feed.runner());
  watch(p, description, timeoutMs, sessions, feed);
  return {
    result: `Monitor ${p.id} started: WebSocket ${url}${feed.protocol ? ` (subprotocol ${feed.protocol})` : ""}. Each frame it receives will arrive as a message ("${description}"); it expires in ${shortDuration(timeoutMs)}. Go on with other work; stop it with kill_process { id: "${p.id}" }.`,
    summary: `${p.id} · ws · ${shortDuration(timeoutMs)}`,
  };
}

/** Sends a monitor's events to its chat until it ends. */
function watch(
  p: BackgroundProcess,
  description: string,
  timeoutMs: number,
  sessions: SessionManager,
  /** A WebSocket monitor's frames (D328): each one an event, instead of output lines. */
  feed?: SocketFeed,
): void {
  p.monitor = { description, timeoutMs, events: 0, ...(feed && { ws: true as const }) };
  // Set after the process started: the chat's background list shows it as a monitor.
  backgroundProcesses.noteChanged();
  const lines = new LineSplitter();
  const events = new MonitorEvents();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const send = (text: string) => {
    // Its chat may have been put away (no tab): loaded again to hear it, as an ended command's.
    const session = sessions.find(p.session) ?? sessions.get(p.session);
    void session.loaded().then(() => {
      if (!session.deleted) deliverAutoMessage(session, text, "monitor");
    });
  };
  const stop = (end: MonitorEnd) => {
    if (p.status !== "running" || ending.has(p.id)) return;
    ending.set(p.id, end);
    clearTimeout(flushTimer);
    events.clear();
    void backgroundProcesses.kill(p.id);
  };
  const flush = () => {
    flushTimer = undefined;
    if (ending.has(p.id)) return;
    const flood = events.flood(Date.now());
    if (flood) {
      stop({ kind: "flood", ...flood });
      return;
    }
    const batch = events.take(Date.now());
    if (!batch) return;
    if (p.monitor) p.monitor.events = events.total;
    // What it sent isn't news to process_output any more.
    p.output.read();
    send(monitorEventText(p.id, description, batch, !!feed));
  };
  const add = (found: string[]) => {
    if (!found.length || ending.has(p.id)) return;
    if (events.add(found, Date.now())) flushTimer = setTimeout(flush, MONITOR_BATCH_MS);
    if (p.monitor) p.monitor.events = events.total;
  };
  if (feed) feed.onFrame = (text) => add([text]);
  else p.onChunk = (chunk) => add(lines.push(chunk));
  const expiry = setTimeout(() => stop({ kind: "expired", afterMs: timeoutMs }), timeoutMs);

  const off = backgroundProcesses.onDidEnd((ended) => {
    if (ended.id !== p.id) return;
    watches.delete(watcher);
    off.dispose();
    clearTimeout(expiry);
    const end = ending.get(p.id);
    ending.delete(p.id);
    if (!end) {
      // Killed (kill_process, the user's Stop, the chat deleted): the agent did it or knows.
      if (p.status === "killed") {
        clearTimeout(flushTimer);
        events.clear();
        return;
      }
      // Ended on its own: what it printed last, then the end.
      add(lines.end());
      clearTimeout(flushTimer);
      if (events.waiting) flush();
    }
    if (p.monitor) p.monitor.events = events.total;
    send(
      monitorEndText(
        p.id,
        description,
        end ??
          (feed?.closed
            ? { kind: "closed", ...feed.closed }
            : p.status === "failed"
              ? { kind: "failed", error: p.error ?? "unknown error" }
              : { kind: "exited", code: p.exitCode }),
        events.total,
      ),
    );
  });
  const watcher = {
    dispose: () => {
      clearTimeout(expiry);
      clearTimeout(flushTimer);
      off.dispose();
    },
  };
  watches.add(watcher);
}

/** The running monitors' timers and listeners (the extension stopping ends them). */
const watches = new Set<{ dispose(): void }>();

export function registerMonitors(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): void {
  const tool = monitorTool(services, sessions);
  sub.add({
    dispose: () => {
      for (const w of [...watches]) w.dispose();
      watches.clear();
    },
  });
  const previous = sessions.extraTools;
  sessions.extraTools = (session) => [...previous(session), tool];
  sub.add(
    services.state.register("ide://agent/monitors", {
      description:
        "The agent's monitors (D322, the monitor tool): background commands whose output lines are sent to their chat as events. Each one's id (kill it with agent.killProcess), chat, command, description, status, events sent so far, timeout.",
      get: () => ({
        monitors: backgroundProcesses
          .list()
          .filter((p) => p.monitor)
          .map((p) => ({
            id: p.id,
            session: p.session,
            command: p.command,
            description: p.monitor?.description ?? "",
            status: p.status,
            events: p.monitor?.events ?? 0,
            timeoutMs: p.monitor?.timeoutMs ?? 0,
            startedAt: new Date(p.startedAt).toISOString(),
          })),
      }),
    }),
  );
}
