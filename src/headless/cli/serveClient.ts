// Node only. A small client for `serve` (serve.ts has the protocol): connect with the token,
// send requests, hear chat events. Bundled on its own (`serve-client.mjs`) so a front end, or a
// test, can import it without the brain.
import { connect, type Socket } from "node:net";

export interface ServeClientOptions {
  /** Loopback unless said otherwise. */
  host?: string;
  port: number;
  token: string;
  /** This client's name (for the server's log). */
  client?: string;
}

export interface ServeClient {
  /** The server's answer to hello (its protocol, version, folder). */
  readonly hello: Record<string, unknown>;
  /** Sends a request; resolves with its result, rejects with the server's error. */
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Hears every chat event of the chats subscribed to. Returns what stops it. */
  onEvent(listener: (event: Record<string, unknown>) => void): () => void;
  /** Hears the server's other notices (`hostPrompts`). */
  onNotify(listener: (name: string, params: unknown) => void): () => void;
  /** Told when the connection ends. */
  onClose(listener: () => void): void;
  close(): void;
}

/** An error the server answered with. */
export class ServeRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ServeRequestError";
  }
}

/** Connects to a running `serve` and says hello. Rejects when refused (a wrong token, busy). */
export function connectServe(options: ServeClientOptions): Promise<ServeClient> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ host: options.host ?? "127.0.0.1", port: options.port });
    socket.setNoDelay(true);
    socket.setEncoding("utf8");
    let nextId = 1;
    let buffer = "";
    let settled = false;
    const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
    const eventListeners = new Set<(event: Record<string, unknown>) => void>();
    const notifyListeners = new Set<(name: string, params: unknown) => void>();
    const closeListeners: (() => void)[] = [];

    const request = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
      new Promise<T>((done, failed) => {
        if (socket.destroyed) {
          failed(new Error("The connection is closed."));
          return;
        }
        const id = nextId++;
        pending.set(id, { resolve: done as (v: unknown) => void, reject: failed });
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });

    const onMessage = (line: string): void => {
      let message: {
        id?: number;
        result?: unknown;
        error?: { code?: string; message?: string };
        event?: Record<string, unknown>;
        notify?: string;
        params?: unknown;
      };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.event) {
        for (const listener of [...eventListeners]) listener(message.event);
        return;
      }
      if (typeof message.notify === "string") {
        for (const listener of [...notifyListeners]) listener(message.notify, message.params);
        return;
      }
      if (typeof message.id !== "number") return;
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.error)
        waiting.reject(
          new ServeRequestError(message.error.code ?? "Failed", message.error.message ?? "failed"),
        );
      else waiting.resolve(message.result);
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line) onMessage(line);
        at = buffer.indexOf("\n");
      }
    });
    const ended = (error?: Error): void => {
      for (const waiting of pending.values())
        waiting.reject(error ?? new Error("The connection closed."));
      pending.clear();
      if (!settled) {
        settled = true;
        reject(error ?? new Error("The connection closed before hello was answered."));
      }
      for (const listener of closeListeners.splice(0)) listener();
    };
    socket.on("error", (error) => ended(error));
    socket.on("close", () => ended());
    socket.on("connect", () => {
      request<Record<string, unknown>>("hello", {
        token: options.token,
        ...(options.client && { client: options.client }),
      }).then(
        (hello) => {
          settled = true;
          resolve({
            hello,
            request,
            onEvent: (listener) => {
              eventListeners.add(listener);
              return () => eventListeners.delete(listener);
            },
            onNotify: (listener) => {
              notifyListeners.add(listener);
              return () => notifyListeners.delete(listener);
            },
            onClose: (listener) => {
              if (socket.destroyed) listener();
              else closeListeners.push(listener);
            },
            close: () => socket.destroy(),
          });
        },
        (error: Error) => {
          settled = true;
          socket.destroy();
          reject(error);
        },
      );
    });
  });
}
