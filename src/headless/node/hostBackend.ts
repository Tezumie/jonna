// Node only. The windowless host as a brain's backend: the host program started as a child
// process (core/ipc/node/hostProcess.ts), its transport installed in the call layer, and the
// process ended in order when the session ends.
import { setTransport } from "../../core/ipc/invoke";
import { type HostProcess, spawnHost } from "../../core/ipc/node/hostProcess";
import type { HostInfo } from "../../core/ipc/streamTransport";
import type { HeadlessBackend, HeadlessConnection } from "../boot";

export interface HostBackendOptions {
  /** The host program (`ide-host`). */
  binary: string;
  /** A separate profile for the host (`--user-data-dir`); none: the app's own. */
  userDataDir?: string;
  /** More arguments for the host. */
  args?: readonly string[];
  /** The host's environment (left out: this process's). */
  env?: Record<string, string | undefined>;
  /** The host's log (its stderr), in chunks. Left out: dropped. */
  onLog?: (text: string) => void;
  /** The host ended by itself (it crashed, or was killed): every later call fails. */
  onExit?: (code: number | null, signal: string | null) => void;
}

export interface HostBackend extends HeadlessBackend {
  /** The running host, once connected (its handshake answer: version, OS, commands). */
  readonly info: HostInfo | null;
}

/** A backend that starts the host program when the session connects. */
export function hostBackend(options: HostBackendOptions): HostBackend {
  let host: HostProcess | null = null;
  let closing = false;
  return {
    get info() {
      return host?.info ?? null;
    },
    async connect(): Promise<HeadlessConnection> {
      if (host) throw new Error("This backend is already connected.");
      const started = await spawnHost(options.binary, {
        args: [
          ...(options.userDataDir ? ["--user-data-dir", options.userDataDir] : []),
          ...(options.args ?? []),
        ],
        ...(options.env && { env: options.env }),
        client: "brain",
        ...(options.onLog && { onStderr: options.onLog }),
        onExit: (code, signal) => {
          if (!closing) options.onExit?.(code, signal);
        },
      });
      host = started;
      setTransport(started.transport);
      return {
        close: async () => {
          closing = true;
          // What the session's end started (a last save, audit entries) is answered first: the
          // host is asked to shut down once no call has been waiting for a moment.
          for (let quiet = 0, waited = 0; quiet < 3 && waited < 3000; waited += 10) {
            quiet = started.transport.pendingCalls === 0 ? quiet + 1 : 0;
            await new Promise<void>((done) => setTimeout(done, 10));
          }
          await started.stop();
        },
        dispose: () => {
          closing = true;
          started.kill();
          // The transport stays installed and closed: a late call fails as a call over a
          // closed connection does.
        },
      };
    },
  };
}
