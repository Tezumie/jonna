// The one door to the backend. Service wrappers in this folder build on `call` and `Channel`,
// and the rest of the app imports those wrappers (AGENTS.md: no raw backend call elsewhere).
// What carries a call is a `Transport`: the desktop framework's inside the app's window (chosen
// by itself when the framework's globals exist), or one a program installs with `setTransport`
// (a byte stream to a windowless host, `streamTransport.ts`). DOM-free.
import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";
import { createDesktopTransport } from "./desktopTransport";
import type { RawBody, Transport, TransportChannel } from "./transport";

export type { RawBody, Transport, TransportChannel, TransportState } from "./transport";

/** Error codes produced by the Rust side (`src-tauri/src/error.rs`). */
export type IpcErrorCode =
  | "NotFound"
  | "AlreadyExists"
  | "PermissionDenied"
  | "IsADirectory"
  | "NotADirectory"
  | "Io"
  | "OutsideScope"
  | "NoWorkspace"
  | "Invalid"
  | "Pty"
  | "Watch"
  | "Json"
  | "Git"
  | "GitMissing"
  | "GitSettingsChanged"
  | "Lsp"
  | "Ai"
  | "AiNoTools"
  | "Cancelled"
  | "Exec"
  | "Tauri"
  | "Unknown";

export class IpcError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
    readonly command: string,
  ) {
    super(message);
    this.name = "IpcError";
  }
}

/** Told about every failed call (the session log, D204); set once by the help extension. */
let failedCallListener: ((error: IpcError) => void) | null = null;

export function onFailedCall(listener: ((error: IpcError) => void) | null): void {
  failedCallListener = listener;
}

/** Told about every call when it settles (D209: the Git output channel lists git's calls). */
let callListener: ((command: string, ms: number, error?: IpcError) => void) | null = null;

export function onCall(
  listener: ((command: string, ms: number, error?: IpcError) => void) | null,
): void {
  callListener = listener;
}

function told(command: string, started: number, error?: IpcError): void {
  try {
    callListener?.(command, performance.now() - started, error);
  } catch {
    // A listener's failure never changes the call's.
  }
}

export async function call<T>(
  command: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
): Promise<T> {
  const started = callListener ? performance.now() : 0;
  try {
    const transport = currentTransport();
    const value = (await (isRawBody(args)
      ? transport.requestRaw(command, args, headersOf(options))
      : transport.request(command, args))) as T;
    if (callListener) told(command, started);
    return value;
  } catch (err) {
    const error = toIpcError(command, err);
    try {
      failedCallListener?.(error);
    } catch {
      // A listener's failure never changes the call's.
    }
    if (callListener) told(command, started, error);
    throw error;
  }
}

/** Bytes as a call's args are the request's raw body (the framework's own rule). */
function isRawBody(args: InvokeArgs | undefined): args is RawBody {
  return args instanceof ArrayBuffer || ArrayBuffer.isView(args) || Array.isArray(args);
}

/** A raw call's headers as a plain record (the callers' own object when it already is one). */
function headersOf(options: InvokeOptions | undefined): Record<string, string> {
  const headers = options?.headers;
  if (!headers) return {};
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const record: Record<string, string> = {};
    headers.forEach((value, name) => {
      record[name] = value;
    });
    return record;
  }
  return headers as Record<string, string>;
}

function toIpcError(command: string, err: unknown): IpcError {
  if (typeof err === "object" && err !== null && "code" in err && "message" in err) {
    const { code, message } = err as { code: unknown; message: unknown };
    return new IpcError(code as IpcErrorCode, String(message), command);
  }
  return new IpcError("Unknown", typeof err === "string" ? err : String(err), command);
}

/**
 * A stream of messages from the backend: make one, pass it inside a call's args (at any depth),
 * and `onmessage` gets every message the command sends, in order (a raw send as an
 * `ArrayBuffer`). The same shape as the desktop framework's channel, which carries it in the
 * app's window.
 */
export class Channel<T = unknown> {
  /** Called for every message. Assigning replaces the handler; earlier messages aren't replayed. */
  onmessage: (message: T) => void;
  /**
   * Called once if the connection to the backend is lost while the channel is open (a host
   * process that died). Never on the desktop, where the backend lives as long as the page.
   */
  onclose: (() => void) | null = null;
  /** The channel's id on its transport (0 when no backend is connected). */
  readonly id: number;
  readonly #end: TransportChannel;

  constructor(onmessage?: (message: T) => void) {
    this.onmessage = onmessage ?? (() => {});
    this.#end = currentTransport().openChannel(
      (message) => this.onmessage(message as T),
      () => this.onclose?.(),
    );
    this.id = this.#end.id;
  }

  /**
   * Stops reading: no later message reaches `onmessage`, and a transport that can tells the host
   * (which then stops sending, as it does on the desktop once the page is gone). In the app's
   * window this only silences the handler. Idempotent.
   */
  close(): void {
    this.onmessage = () => {};
    this.onclose = null;
    this.#end.close();
  }

  /** What `JSON.stringify` puts in a call's args for this channel (the transport's marker). */
  toJSON(): unknown {
    return this.#end.wire();
  }
}

/** Set by `setTransport`; null leaves the choice to the surroundings. */
let installed: Transport | null = null;
/** The desktop framework's, built the first time it's needed and its globals exist. */
let desktop: Transport | null = null;

/** Answers when nothing is connected (a plain browser tab, a unit test): every call fails. */
const noTransport: Transport = {
  kind: "none",
  state: "closed",
  request: () => Promise.reject(new Error("No backend is connected.")),
  requestRaw: () => Promise.reject(new Error("No backend is connected.")),
  openChannel: () => ({ id: 0, wire: () => null, close: () => {} }),
  onClose: () => () => {},
};

function currentTransport(): Transport {
  if (installed) return installed;
  if (isDesktopShell()) {
    desktop ??= createDesktopTransport();
    return desktop;
  }
  return noTransport;
}

/**
 * Installs what carries backend calls from here on (null: back to the default, the desktop
 * framework's when its globals exist). Install it before anything calls or makes a channel:
 * a channel belongs to the transport that was current when it was made.
 */
export function setTransport(transport: Transport | null): void {
  installed = transport;
}

/** The transport calls go through now (`kind` "none" when nothing is connected). */
export function getTransport(): Transport {
  return currentTransport();
}

/**
 * True when a backend answers calls: in the app's window, and wherever a transport was installed
 * (a windowless host). False in a plain browser tab (`node build.mjs --serve` opened directly)
 * and in unit tests.
 */
export function hasBackend(): boolean {
  return installed !== null || isDesktopShell();
}

/**
 * True when the desktop framework's window APIs exist (the app's own window): native window
 * controls, dialogs, the clipboard plugin, drag and drop. A backend alone doesn't imply them.
 */
export function isDesktopShell(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}
