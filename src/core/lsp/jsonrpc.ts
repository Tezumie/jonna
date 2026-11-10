// JSON-RPC 2.0 over an abstract transport (LSP's message layer). DOM-free.
// Requests get ids and promises (with an optional timeout and cancellation via $/cancelRequest),
// notifications are fire-and-forget, and the peer's requests are answered by registered handlers
// (unknown methods get MethodNotFound so servers never hang waiting).
import { Emitter, type Event } from "../events/index";
import { type Disposable, NONE, toDisposable } from "../lifecycle/index";

export interface Transport {
  send(body: string): void;
  readonly onMessage: Event<string>;
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export const METHOD_NOT_FOUND = -32601;
export const REQUEST_CANCELLED = -32800;

type Pending = {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer?: ReturnType<typeof setTimeout>;
};
type Handler = (params: unknown) => unknown;

export interface CancelToken {
  readonly cancelled: boolean;
  /** Calls `fn` once on cancellation (now, if already cancelled); dispose to stop listening. */
  onCancel(fn: () => void): Disposable;
}

export class RpcConnection implements Disposable {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly requestHandlers = new Map<string, Handler>();
  private readonly notificationHandlers = new Map<string, Handler>();
  private readonly unhandled = new Emitter<{ method: string; params: unknown }>();
  /** Notifications without a handler (for logging). */
  readonly onUnhandledNotification = this.unhandled.event;
  private readonly sub: Disposable;
  private closed = false;

  constructor(private readonly transport: Transport) {
    this.sub = transport.onMessage((body) => this.receive(body));
  }

  request<T>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number; token?: CancelToken } = {},
  ): Promise<T> {
    if (this.closed) return Promise.reject(new RpcError(-32099, "Connection closed"));
    // Cancelled before it was sent: don't bother the server with a request nobody waits for.
    if (options.token?.cancelled)
      return Promise.reject(new RpcError(REQUEST_CANCELLED, "Cancelled"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      // Settling (answer, error, timeout, cancel, close) drops the token listener: a long-lived
      // token reused for many requests would otherwise keep one closure per request forever.
      let cancelListener: Disposable = NONE;
      const entry: Pending = {
        resolve: (v) => {
          cancelListener.dispose();
          resolve(v as T);
        },
        reject: (e) => {
          cancelListener.dispose();
          reject(e);
        },
      };
      if (options.timeoutMs) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          this.notify("$/cancelRequest", { id });
          entry.reject(new RpcError(-32001, `${method} timed out`));
        }, options.timeoutMs);
      }
      this.pending.set(id, entry);
      if (options.token)
        cancelListener = options.token.onCancel(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          clearTimeout(entry.timer);
          this.notify("$/cancelRequest", { id });
          entry.reject(new RpcError(REQUEST_CANCELLED, "Cancelled"));
        });
      this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  onRequest(method: string, handler: Handler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: Handler): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Fails every pending request (the server exited). */
  close(reason = "Connection closed"): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcError(-32099, reason));
    }
    this.pending.clear();
  }

  private write(message: object): void {
    this.transport.send(JSON.stringify(message));
  }

  private receive(body: string): void {
    let msg: {
      id?: number | string | null;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };
    try {
      msg = JSON.parse(body);
    } catch {
      return;
    }
    // Valid JSON that isn't an object ("null") would throw on the reads below.
    if (typeof msg !== "object" || msg === null) return;
    if (msg.method !== undefined && msg.id !== undefined && msg.id !== null) {
      void this.answer(msg.id, msg.method, msg.params);
      return;
    }
    if (msg.method !== undefined) {
      const handler = this.notificationHandlers.get(msg.method);
      if (!handler) this.unhandled.fire({ method: msg.method, params: msg.params });
      else
        try {
          handler(msg.params);
        } catch {
          // A notification with odd params (a server's bug) is dropped, not thrown into the
          // transport's listener (which would skip the other listeners of this message).
        }
      return;
    }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
    else p.resolve(msg.result ?? null);
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: METHOD_NOT_FOUND, message: `Unhandled method ${method}` },
      });
      return;
    }
    try {
      const result = await handler(params);
      this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (err) {
      this.write({
        jsonrpc: "2.0",
        id,
        // A handler may answer with its own code (MCP's -1 "user rejected", D204).
        error: {
          code: err instanceof RpcError ? err.code : -32603,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  dispose(): void {
    this.close();
    this.sub.dispose();
    this.unhandled.dispose();
  }
}

/** A cancel token driven by `cancel()`. */
export function cancelSource(): CancelToken & { cancel(): void } {
  const fns = new Set<() => void>();
  let cancelled = false;
  return {
    get cancelled() {
      return cancelled;
    },
    onCancel(fn) {
      if (cancelled) {
        fn();
        return NONE;
      }
      // A fresh wrapper per call, so the same function registered twice is removed separately.
      const listener = () => fn();
      fns.add(listener);
      return toDisposable(() => fns.delete(listener));
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      const pending = [...fns];
      fns.clear();
      for (const fn of pending) fn();
    },
  };
}
