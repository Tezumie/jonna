// A backend for tests: the commands the call layer sends are answered by handlers in this
// process. Until the call layer has a transport to set, it reaches the backend through the bridge
// the desktop framework's own `invoke` looks for, so this installs that bridge, and nothing else
// of a page: the `window` it has to define holds only the bridge and fails, on the record, for
// any other use (a test can assert the logic layer never touched the screen). No `document`.
import type { Disposable } from "../core/lifecycle/index";
import type { HeadlessBackend } from "./boot";

/** Answers one backend command: its arguments (channels are live `Channel` objects) and options. */
export type FakeCommand = (args: Record<string, unknown>, options: unknown) => unknown;

export interface FakeBackend extends HeadlessBackend {
  /** Every command called, in order. */
  readonly calls: string[];
  /** Commands called that no handler answers (they were rejected as the host rejects unknown ones). */
  readonly unanswered: Set<string>;
  /** Every use of `window` other than the framework's bridge (each also threw). */
  readonly screenAccess: string[];
}

interface Bridge {
  invoke(command: string, args?: unknown, options?: unknown): Promise<unknown>;
  transformCallback(callback: (message: unknown) => void, once?: boolean): number;
  unregisterCallback(id: number): void;
}

const BRIDGE = "__TAURI_INTERNALS__";

/** What answers once a backend has disconnected: every call fails, as over a closed connection. */
const disconnected: Bridge = {
  invoke: (command) =>
    Promise.reject({ code: "Unknown", message: `The backend is disconnected (${command}).` }),
  transformCallback: () => 0,
  unregisterCallback: () => {},
};

/** The backend connected in this realm (one at a time: the call layer is module-level state). */
let connected: { bridge: Bridge; screenAccess: string[] } | null = null;
/** Where uses of `window` are recorded while no backend is connected (the last one's list). */
let lastScreenAccess: string[] = [];
let trapInstalled = false;

/** Defines the bridge-only `window`, once per realm; it stays for work that outlives a session. */
function installWindowTrap(): void {
  if (trapInstalled) return;
  const globals = globalThis as Record<string, unknown>;
  if ("window" in globals)
    throw new Error("This realm has a window: the fake backend is for none.");
  globals.window = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === BRIDGE) return connected?.bridge ?? disconnected;
        const use = `window.${String(key)}`;
        (connected?.screenAccess ?? lastScreenAccess).push(use);
        throw new ReferenceError(`${use} was used: there is no screen in this session`);
      },
      has: (_target, key) => key === BRIDGE,
    },
  );
  trapInstalled = true;
}

/**
 * A fake backend answering `commands` by name. A command without a handler is rejected with the
 * host's "unknown command" error (`{ code: "Invalid" }`), which callers already handle as a
 * failed call. A handler may throw `{ code, message }` to fail as the backend does. After it
 * disconnects, calls fail as calls over a closed connection do.
 */
export function fakeBackend(commands: Readonly<Record<string, FakeCommand>>): FakeBackend {
  const calls: string[] = [];
  const unanswered = new Set<string>();
  const screenAccess: string[] = [];
  const callbacks = new Map<number, (message: unknown) => void>();
  let nextCallback = 1;
  const bridge: Bridge = {
    invoke: async (command, args, options) => {
      calls.push(command);
      const handler = commands[command];
      if (!handler) {
        unanswered.add(command);
        throw { code: "Invalid", message: `unknown command: ${command}` };
      }
      return handler((args ?? {}) as Record<string, unknown>, options);
    },
    transformCallback: (callback) => {
      const id = nextCallback++;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback: (id) => {
      callbacks.delete(id);
    },
  };
  return {
    calls,
    unanswered,
    screenAccess,
    connect(): Disposable {
      if (connected) throw new Error("A backend is already connected in this realm.");
      installWindowTrap();
      const connection = { bridge, screenAccess };
      connected = connection;
      // What the call layer looks for to know there is a backend.
      (globalThis as Record<string, unknown>)[BRIDGE] = bridge;
      return {
        dispose: () => {
          if (connected !== connection) return;
          connected = null;
          lastScreenAccess = screenAccess;
          delete (globalThis as Record<string, unknown>)[BRIDGE];
          callbacks.clear();
        },
      };
    },
  };
}
