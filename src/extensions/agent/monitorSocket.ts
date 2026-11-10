// A monitor over a WebSocket (D328, Claude Code's Monitor `ws`): the socket is opened in Rust
// (src-tauri/src/agent/socket.rs; the webview's CSP stays closed to sockets) and runs as one of
// the chat's background entries (backgroundProcesses.ts: an id, kill_process, the chat's list),
// its address in place of a command line. Each text frame is one event, a binary frame its size,
// an error an event of its own before the close; the close (code and reason) ends the watch.

import type { ToolOutcome } from "../../core/agent/loop";
import { wsExitCode, wsFrameEvent } from "../../core/agent/monitor";
import { type MonitorSocketEvent, monitorSocketIpc } from "../../core/ipc/agent";
import type { ProcessRunner } from "./backgroundProcesses";
import { newId } from "./ids";
import type { ToolHost } from "./tools";

/** An open monitor socket: its frames, held until the monitor listens, and how it closed. */
export class SocketFeed {
  private queue: MonitorSocketEvent[] = [];
  private listener: ((e: MonitorSocketEvent) => void) | null = null;
  /** How it closed (set by its last event). */
  closed: { code: number | null; reason: string } | null = null;
  /** The subprotocol the server picked. */
  protocol: string | null = null;
  /** Each event's text as the monitor sends it (frames, errors). */
  onFrame: ((text: string) => void) | null = null;

  constructor(readonly socketId: string) {}

  /** From Rust's channel. */
  push(e: MonitorSocketEvent): void {
    if (e.kind === "closed") this.closed = { code: e.code, reason: e.reason };
    if (this.listener) this.listener(e);
    else this.queue.push(e);
  }

  /** What runs the background entry: it ends when the socket closes; Stop closes it. */
  runner(): ProcessRunner {
    return {
      run: (onChunk) =>
        new Promise((resolve) => {
          const take = (e: MonitorSocketEvent) => {
            if (e.kind === "closed") {
              onChunk(
                `[closed${e.code === null ? "" : ` ${e.code}`}${e.reason ? `: ${e.reason}` : ""}]\n`,
              );
              resolve({ exitCode: wsExitCode(e.code) });
              return;
            }
            const text =
              e.kind === "error"
                ? `[error: ${e.message}]`
                : wsFrameEvent(e.kind === "text" ? { text: e.text } : { bytes: e.bytes });
            // What process_output and the Output tab show: each event on its own line(s).
            onChunk(`${text}\n`);
            this.onFrame?.(text);
          };
          this.listener = take;
          for (const e of this.queue.splice(0)) take(e);
        }),
      cancel: () => monitorSocketIpc.close(this.socketId),
    };
  }
}

/** Opens the socket (resolves once the server accepted it); the monitor runs it from there. */
export async function openMonitorSocket(
  url: string,
  protocols: readonly string[],
  lifetimeMs: number,
): Promise<SocketFeed> {
  const feed = new SocketFeed(newId("ws"));
  const opened = await monitorSocketIpc.open(feed.socketId, url, protocols, lifetimeMs, (e) =>
    feed.push(e),
  );
  feed.protocol = opened.protocol;
  return feed;
}

/**
 * Asks the user before connecting, as run_command asks before a command: with agent.runCommands
 * "ask" (or "auto" in a folder that isn't trusted) a card shows the address.
 */
export async function askToConnect(host: ToolHost, url: string): Promise<ToolOutcome | null> {
  const mode = host.services.settings.peek<string>("agent.runCommands");
  const untrusted = mode === "auto" && host.services.trust.trusted !== true;
  if (mode !== "ask" && !untrusted) return null;
  const answer = await host.ask({
    title: `Open a WebSocket to ${url}`,
    heading: "Open a WebSocket",
    code: url,
    kind: "tool",
    detail: untrusted
      ? "This folder isn't trusted, so connections ask even in automatic mode."
      : "Each message it receives comes to this chat as an event.",
  });
  if (answer === "deny")
    return { result: "The user denied opening this WebSocket.", denied: true, summary: "denied" };
  return null;
}
