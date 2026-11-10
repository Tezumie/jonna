// Terminals served by the page instead of a process (D233): an extension's pseudoterminal, or the
// terminal of an extension's custom task. `ptyIpc` (process.ts) sends a spawn whose profile or
// run names a `virtual` key here, and every later call on an id from VIRTUAL_PTY_BASE up, so the
// terminal extension needs no second path: input, resize, kill and flow control go to the session
// instead of Rust. DOM-free and unit-tested.

/** Ids of virtual terminals start here; Rust's pty ids count up from 1 and never get near it. */
export const VIRTUAL_PTY_BASE = 1_000_000_000;

export interface VirtualPtyHandlers {
  onData(bytes: Uint8Array): void;
  onExit(code: number): void;
}

/** One open virtual terminal: what the user types, its size, and the tab closing. */
export interface VirtualPtySession {
  input(data: string): void;
  resize(cols: number, rows: number): void;
  /** The terminal was closed (or killed): no more output is read. */
  close(): void;
}

/** Opens a session for a new terminal of `cols` × `rows`; its output goes to `handlers`. */
export type VirtualPtyFactory = (
  size: { cols: number; rows: number },
  handlers: VirtualPtyHandlers,
) => VirtualPtySession | Promise<VirtualPtySession>;

export interface VirtualPtyInfo {
  id: number;
  pid: null;
  shell: string;
  cwd: string;
  integration: false;
}

const factories = new Map<string, { factory: VirtualPtyFactory; title: string }>();
const sessions = new Map<number, VirtualPtySession>();
let nextId = VIRTUAL_PTY_BASE;

/** Makes `key` spawnable (a profile or run spec with `virtual: key`); dispose to remove it. */
export function registerVirtualPty(
  key: string,
  factory: VirtualPtyFactory,
  title = "",
): { dispose(): void } {
  const entry = { factory, title };
  factories.set(key, entry);
  return {
    dispose: () => {
      if (factories.get(key) === entry) factories.delete(key);
    },
  };
}

export function isVirtualPty(id: number): boolean {
  return id >= VIRTUAL_PTY_BASE;
}

/** Whether `key` can be spawned now (a restored tab's key is gone after a restart). */
export function hasVirtualPty(key: string): boolean {
  return factories.has(key);
}

/** Starts a session of `key`; rejects when nothing serves it any more. */
export async function spawnVirtualPty(
  key: string,
  cols: number,
  rows: number,
  handlers: VirtualPtyHandlers,
): Promise<VirtualPtyInfo> {
  const entry = factories.get(key);
  if (!entry) throw new Error("The extension that made this terminal has stopped.");
  const id = ++nextId;
  let ended = false;
  const session = await entry.factory(
    { cols, rows },
    {
      onData: (bytes) => {
        if (!ended) handlers.onData(bytes);
      },
      onExit: (code) => {
        if (ended) return;
        ended = true;
        sessions.delete(id);
        handlers.onExit(code);
      },
    },
  );
  // Exited while it opened: nothing is kept.
  if (!ended) sessions.set(id, session);
  return { id, pid: null, shell: entry.title, cwd: "", integration: false };
}

/** Input for virtual terminal `id` (dropped once it has ended). */
export function writeVirtualPty(id: number, data: string): void {
  sessions.get(id)?.input(data);
}

export function resizeVirtualPty(id: number, cols: number, rows: number): void {
  sessions.get(id)?.resize(cols, rows);
}

export function killVirtualPty(id: number): void {
  const session = sessions.get(id);
  sessions.delete(id);
  session?.close();
}
