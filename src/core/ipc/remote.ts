// Remote development (D252, src-tauri/src/remote, docs/remote.md): connecting this window to a
// remote (ssh:<host>, or wsl:<distro> for local development and the UI tests), the remote folder
// picker, the connection's log, ~/.ssh/config hosts and forwarded ports. Once connected, the
// workspace's paths are the remote's POSIX paths and the usual fs / git / process wrappers reach
// it unchanged.

import type { DirEntry } from "./fs";
import { Channel, call } from "./invoke";

/** What the window's remote is (after connecting). */
export interface RemoteInfo {
  /** "ssh:box" / "wsl:Ubuntu". */
  authority: string;
  /** "SSH: box". */
  label: string;
  os: string;
  arch: string;
  home: string;
  user: string;
  /** The remote's login shell. */
  shell: string;
  /** The server's version. */
  version: string;
}

/**
 * Events on the connect call's channel: progress while connecting, ssh's questions (answer with
 * `askpassAnswer`; `secret` masks the input; a host-key question asks yes/no), a question ssh
 * stopped waiting for, and the end of the connection (later, at any time).
 */
export type RemoteEvent =
  | { kind: "progress"; message: string }
  | { kind: "askpass"; id: number; prompt: string; secret: boolean }
  | { kind: "askpassCancel"; id: number }
  | { kind: "disconnected"; reason: string };

export interface RemoteStatus {
  authority: string;
  label: string;
  connected: boolean;
  info: RemoteInfo | null;
}

/** A host from ~/.ssh/config (named ones, no wildcards). */
export interface RemoteHost {
  host: string;
  hostname?: string;
  user?: string;
  port?: number;
}

/** A port listening on the remote. */
export interface ListeningPort {
  port: number;
  host?: string;
  pid?: number;
  process?: string;
}

export const remoteIpc = {
  /**
   * Connects this window to `authority`: starts ssh (or wsl.exe), installs the server there when
   * needed, starts it. Rejects with the reason (sign-in refused, unknown host, unsupported OS…).
   * Called again for the window's remote: reconnects (or, still connected, returns at once).
   */
  connect: (authority: string, onEvent: (e: RemoteEvent) => void): Promise<RemoteInfo> =>
    call<RemoteInfo>("remote_connect", { authority, onEvent: new Channel<RemoteEvent>(onEvent) }),
  /** The answer to ssh's question `id`; null cancels. Never stored or logged. */
  askpassAnswer: (id: number, answer: string | null): Promise<void> =>
    call<void>("remote_askpass_answer", { id, answer }),
  /** Closes the connection; the window is local again (close its folder first). */
  disconnect: (): Promise<void> => call<void>("remote_disconnect"),
  /** The window's remote and whether it's connected; null for a local window. */
  status: (): Promise<RemoteStatus | null> => call<RemoteStatus | null>("remote_status"),
  /** A folder anywhere on the remote, for the folder picker (`~` is the home folder). */
  browse: (path: string): Promise<DirEntry[]> => call<DirEntry[]>("remote_browse", { path }),
  /** What ssh and the server reported for this connection. */
  log: (): Promise<string> => call<string>("remote_log"),
  hosts: (): Promise<RemoteHost[]> => call<RemoteHost[]>("remote_hosts"),
  /** Forwards the remote's `port` to localhost here; the local port (the same when free). */
  forwardPort: (port: number): Promise<number> => call<number>("remote_forward_port", { port }),
  unforward: (port: number): Promise<void> => call<void>("remote_unforward", { port }),
  forwarded: (): Promise<{ remote: number; local: number }[]> =>
    call<{ remote: number; local: number }[]>("remote_forwarded"),
  listening: (): Promise<ListeningPort[]> => call<ListeningPort[]>("remote_listening"),
  /**
   * Runs docker (or the devcontainers CLI) with `args`, no shell between (D266): each output line
   * to `onOutput`; the exit code and stdout.
   */
  docker: (
    tool: "docker" | "devcontainer",
    args: readonly string[],
    cwd: string | null,
    onOutput: (line: string) => void,
  ): Promise<{ code: number | null; stdout: string }> =>
    call<{ code: number | null; stdout: string }>("remote_docker", {
      tool,
      args,
      cwd,
      onOutput: new Channel<string>(onOutput),
    }),
  /** The docker program for dev containers (`remote.containers.dockerPath`; null: `docker`). */
  setDocker: (path: string | null): Promise<void> => call<void>("remote_set_docker", { path }),
};
