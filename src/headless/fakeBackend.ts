// A backend for tests: the commands the call layer sends are answered by handlers in this
// process. It is a transport installed in the call layer (`setTransport`), so nothing of a page
// is defined: no `window`, no `document`. A test proves the logic layer never touched the screen
// by those globals still being absent (a use of one fails where it is used).
import { setTransport, type Transport } from "../core/ipc/invoke";
import type { Disposable } from "../core/lifecycle/index";
import type { HeadlessBackend } from "./boot";

/**
 * Answers one backend command: its arguments (channels are live `Channel` objects; a raw call's
 * body is the bytes themselves) and options (`{ headers }` for a raw call).
 */
export type FakeCommand = (args: Record<string, unknown>, options: unknown) => unknown;

export interface FakeBackend extends HeadlessBackend {
  /** Every command called, in order. */
  readonly calls: string[];
  /** Commands called that no handler answers (they were rejected as the host rejects unknown ones). */
  readonly unanswered: Set<string>;
}

/** The backend connected in this realm (one at a time: the call layer is module-level state). */
let connected: Transport | null = null;

/**
 * A fake backend answering `commands` by name. A command without a handler is rejected with the
 * host's "unknown command" error (`{ code: "Invalid" }`), which callers already handle as a
 * failed call. A handler may throw `{ code, message }` to fail as the backend does. After it
 * disconnects, calls fail as calls over a closed connection do.
 */
export function fakeBackend(commands: Readonly<Record<string, FakeCommand>>): FakeBackend {
  const calls: string[] = [];
  const unanswered = new Set<string>();
  let open = false;
  let nextChannel = 1;
  const closeListeners = new Set<(error?: Error) => void>();
  const answer = async (command: string, args: unknown, options: unknown): Promise<unknown> => {
    if (!open) throw { code: "Unknown", message: `The backend is disconnected (${command}).` };
    calls.push(command);
    const handler = commands[command];
    if (!handler) {
      unanswered.add(command);
      throw { code: "Invalid", message: `unknown command: ${command}` };
    }
    return handler((args ?? {}) as Record<string, unknown>, options);
  };
  const transport: Transport = {
    kind: "fake",
    get state() {
      return open ? "open" : "closed";
    },
    request: (command, args) => answer(command, args, undefined),
    requestRaw: (command, body, headers) => answer(command, body, { headers }),
    openChannel: () => {
      const id = nextChannel++;
      return { id, wire: () => ({ __channel: id }), close: () => {} };
    },
    onClose: (listener) => {
      if (!open) {
        listener();
        return () => {};
      }
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
  };
  return {
    calls,
    unanswered,
    connect(): Disposable {
      if (connected) throw new Error("A backend is already connected in this realm.");
      connected = transport;
      open = true;
      setTransport(transport);
      return {
        dispose: () => {
          if (connected !== transport) return;
          connected = null;
          open = false;
          // The transport stays installed: work that outlives the session fails as calls over a
          // closed connection do, instead of reaching for a desktop that isn't there.
          for (const listener of [...closeListeners]) listener();
          closeListeners.clear();
        },
      };
    },
  };
}
