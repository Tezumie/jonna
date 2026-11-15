// What carries a backend call. `invoke.ts` talks to one of these and nothing else: the desktop
// framework's (`desktopTransport.ts`) inside the app's window, a byte stream to a windowless
// host (`streamTransport.ts`) anywhere else. DOM-free and framework-free: types only.

/** A raw request body, in any of the forms the desktop framework accepts. */
export type RawBody = ArrayBuffer | Uint8Array | number[];

/** `connecting` until the backend has answered the handshake; `closed` is final. */
export type TransportState = "connecting" | "open" | "closed";

/** The transport's end of one channel (the host pushes messages, the client reads them). */
export interface TransportChannel {
  /** The channel's id on this transport; 0 when no backend is connected. */
  readonly id: number;
  /**
   * What stands for the channel inside a call's args (the value `JSON.stringify` puts there):
   * the desktop framework's marker string, or `{ __channel: id }` on a byte stream.
   */
  wire(): unknown;
  /**
   * The client stops reading: no later message is delivered, and a transport that can tells the
   * host (its sends then fail as they do on the desktop once the page is gone). Idempotent.
   */
  close(): void;
}

export interface Transport {
  /** "desktop", "stream", "none", or a test's own. */
  readonly kind: string;
  readonly state: TransportState;
  /**
   * A command with JSON args. Resolves with the JSON result, or an `ArrayBuffer` for the commands
   * that answer bytes. Rejects with the command's serialized error (`{ code, message }` for the
   * app's own error type), a string, or anything else: `call` turns each into an `IpcError`.
   */
  request(command: string, args?: Record<string, unknown>): Promise<unknown>;
  /** A command whose body is raw bytes, with string headers beside it. Results as `request`. */
  requestRaw(command: string, body: RawBody, headers: Record<string, string>): Promise<unknown>;
  /**
   * Opens a channel. `onMessage` gets each message in the order the host sent it (a JSON value,
   * or an `ArrayBuffer` for a raw send). `onEnd` is called once if the connection is lost while
   * the channel is open (never after `close()`).
   */
  openChannel(onMessage: (message: unknown) => void, onEnd?: () => void): TransportChannel;
  /**
   * Hears the connection ending (`error` when it wasn't asked for). Called at once when it has
   * already ended. Returns a function that stops listening.
   */
  onClose(listener: (error?: Error) => void): () => void;
}
