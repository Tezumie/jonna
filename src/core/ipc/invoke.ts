// The only place that calls Tauri's `invoke`. Service wrappers in this folder build on it, and the
// rest of the app imports those wrappers (AGENTS.md: no raw `invoke` elsewhere).
import { Channel, type InvokeArgs, type InvokeOptions, invoke } from "@tauri-apps/api/core";

export { Channel };

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
    const value = await invoke<T>(command, args, options);
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

function toIpcError(command: string, err: unknown): IpcError {
  if (typeof err === "object" && err !== null && "code" in err && "message" in err) {
    const { code, message } = err as { code: unknown; message: unknown };
    return new IpcError(code as IpcErrorCode, String(message), command);
  }
  return new IpcError("Unknown", typeof err === "string" ? err : String(err), command);
}

/** True when running inside the Tauri webview (false in a plain browser tab, e.g. `node build.mjs --serve` opened directly). */
export function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}
