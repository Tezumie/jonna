// A remote MCP server over Streamable HTTP (D193): one POST per message, made by Rust (no CORS;
// stored inputs filled in there). D207: a 403 `insufficient_scope` signs in again asking for the
// extra scopes (MCP's step-up authorization) and sends the request once more; after initialize
// a standing GET stream (Rust: src-tauri/src/mcp/stream.rs) carries the server's notifications
// and requests while no POST is open, reconnecting with a pause, closed with the transport.
import { Emitter } from "../../core/events/index";
import { type McpStreamEvent, mcpClientIpc } from "../../core/ipc/system";
import type { Transport } from "../../core/lsp/jsonrpc";

/** The error a remote server's 401 turns into (src-tauri/src/mcp/remote.rs). */
export const isSignInError = (message: string) => /needs a sign-in/i.test(message);

/** A 403 asking for more scopes (remote.rs); the scopes it named, or "" when none. */
export function stepUpScope(message: string): string | null {
  if (!/insufficient_scope/.test(message)) return null;
  return /needs more access \(([^)]*)\)/.exec(message)?.[1] ?? "";
}

export type StreamState = "open" | "retrying" | "unsupported" | "closed";

export interface RemoteOptions {
  /** Signs in again for more scopes; true when it worked (the request is sent once more). */
  stepUp?: (scope: string) => Promise<boolean>;
  /** The GET stream's state changed. */
  onStreamState?: (state: StreamState, reconnects: number) => void;
}

/** Which transport holds each server's stream (a restart's new one may open before the old closes). */
const streamOwners = new Map<string, RemoteTransport>();

export class RemoteTransport implements Transport {
  private readonly messages = new Emitter<string>();
  readonly onMessage = this.messages.event;
  private session: string | null = null;
  private closed = false;
  private listening = false;
  /** One step-up at a time: requests refused meanwhile wait for it. */
  private stepping: Promise<boolean> | null = null;
  streamState: StreamState | null = null;
  reconnects = 0;

  constructor(
    private readonly server: string,
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly options: RemoteOptions = {},
  ) {}

  send(body: string): void {
    void this.post(body, true);
  }

  private async post(body: string, mayStepUp: boolean): Promise<void> {
    if (this.closed) return;
    // The server's requests in the reply stream (an elicitation) arrive before the reply (D200).
    const early = (message: string) => {
      if (!this.closed) this.messages.fire(message);
    };
    try {
      const reply = await mcpClientIpc.post(
        this.server,
        this.url,
        this.headers,
        this.session,
        body,
        early,
      );
      if (reply.sessionId) this.session = reply.sessionId;
      for (const m of reply.messages) if (!this.closed) this.messages.fire(m);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      let id: unknown;
      try {
        const parsed = JSON.parse(body) as { id?: unknown; method?: unknown };
        id = parsed.method !== undefined ? parsed.id : undefined;
      } catch {}
      const scope = stepUpScope(message);
      if (scope !== null && mayStepUp && this.options.stepUp && !this.closed) {
        this.stepping ??= this.options.stepUp(scope).finally(() => {
          this.stepping = null;
        });
        if (await this.stepping.catch(() => false)) return this.post(body, false);
      }
      // A request that failed gets an error answer, so its caller doesn't wait forever.
      if (id === undefined || this.closed) return;
      this.messages.fire(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }));
    }
  }

  /** Opens the standing GET stream (after initialize, so the session id is known). */
  listen(): void {
    if (this.closed || this.listening) return;
    this.listening = true;
    streamOwners.set(this.streamId, this);
    const onEvent = (event: McpStreamEvent) => {
      if (this.closed) return;
      if (event.kind === "message") {
        this.messages.fire(event.text);
        return;
      }
      if (event.state === "open" && this.streamState === "retrying") this.reconnects++;
      this.streamState = event.state;
      this.options.onStreamState?.(event.state, this.reconnects);
    };
    void mcpClientIpc
      .listen(this.streamId, this.server, this.url, this.headers, this.session, onEvent)
      .catch(() => onEvent({ kind: "state", state: "closed" }));
  }

  /** Streams are named after the server: a reload's new stream replaces the old one. */
  private get streamId(): string {
    return `mcp:${this.server}`;
  }

  dispose(): void {
    this.closed = true;
    if (this.listening && streamOwners.get(this.streamId) === this) {
      streamOwners.delete(this.streamId);
      void mcpClientIpc.unlisten(this.streamId).catch(() => {});
    }
    this.messages.dispose();
  }
}
