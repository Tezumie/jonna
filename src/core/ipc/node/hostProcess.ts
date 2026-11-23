// Node only: nothing the window's bundle imports may import this file. Starts the windowless
// host as a child process and talks to it over its stdin/stdout (the wire contract's carrier),
// or dials a host that listens on a loopback socket. The host's stderr is its log.
import { type ChildProcess, spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import {
  type ByteDuplex,
  type HostInfo,
  StreamTransport,
  type StreamTransportOptions,
} from "../streamTransport";

export interface HostProcessOptions extends StreamTransportOptions {
  /** The host binary's arguments. */
  args?: readonly string[];
  cwd?: string;
  /** The child's whole environment (left out: this process's). */
  env?: Record<string, string | undefined>;
  /** The host's log (its stderr), as text, in chunks as they arrive. */
  onStderr?: (text: string) => void;
  /** The process ended: its exit code, or the signal that killed it. */
  onExit?: (code: number | null, signal: string | null) => void;
}

export interface HostProcess {
  /** Connected: the handshake has been answered. Install it with `setTransport`. */
  readonly transport: StreamTransport;
  /** The host's handshake answer (version, OS, the commands it serves). */
  readonly info: HostInfo;
  readonly pid: number | undefined;
  /** Resolves when the process has ended (it never rejects). */
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  /**
   * Asks the host to shut down and waits for the process to end; kills it when it hasn't after
   * `timeoutMs` (5 s).
   */
  stop(timeoutMs?: number): Promise<void>;
  /** Kills the process now. */
  kill(): void;
}

/** A duplex over a writable and a readable (a child's stdin and stdout, a socket's two halves). */
export function duplexFromStreams(
  output: Writable,
  input: Readable,
  close: () => void = () => output.end(),
): ByteDuplex {
  let onClose: (error?: Error) => void = () => {};
  let closed = false;
  const finish = (error?: Error) => {
    if (closed) return;
    closed = true;
    onClose(error);
  };
  input.on("end", () => finish());
  input.on("close", () => finish());
  input.on("error", (error: Error) => finish(error));
  // A write to a process that has gone fails later, as an event (EPIPE), not as an exception.
  output.on("error", (error: Error) => finish(error));
  return {
    write: (bytes) => {
      if (closed) throw new Error("The stream has ended.");
      // Node keeps what the other side hasn't taken yet; the bytes stay in order.
      output.write(bytes);
    },
    onData: (listener) => {
      input.on("data", (chunk: Uint8Array) => listener(chunk));
    },
    onClose: (listener) => {
      onClose = listener;
    },
    close,
  };
}

/**
 * Starts `binary` (the windowless host) with pipes for its stdin, stdout and stderr, and resolves
 * once it has answered the handshake. Rejects when it can't be started, exits first, or speaks
 * another protocol (the process is killed then).
 *
 *     const host = await spawnHost(path, { onStderr: (text) => process.stderr.write(text) });
 *     setTransport(host.transport);
 */
export async function spawnHost(
  binary: string,
  options: HostProcessOptions = {},
): Promise<HostProcess> {
  const child: ChildProcess = spawn(binary, options.args ?? [], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  // Never started (no such file, not executable): an event, a moment later. Heard from the
  // start, so it is never an unhandled one.
  let spawnError: Error | null = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  const couldNotStart = (why: unknown): Error =>
    new Error(
      `Couldn't start the host (${binary}): ${why instanceof Error ? why.message : String(why)}`,
    );
  const { stdin, stdout, stderr } = child;
  if (!stdin || !stdout || !stderr) {
    child.kill();
    await new Promise<void>((resolve) => setImmediate(resolve));
    throw couldNotStart(spawnError ?? "it has no pipes");
  }
  stderr.setEncoding("utf8");
  stderr.on("data", (text: string) => options.onStderr?.(text));

  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    let done = false;
    const finish = (code: number | null, signal: string | null) => {
      if (done) return;
      done = true;
      options.onExit?.(code, signal);
      resolve({ code, signal });
    };
    child.once("exit", (code, signal) => {
      finish(code, signal);
      // The host is gone, but its pipes close only when nothing else holds their other end,
      // and on Windows the console of a command it ran can outlive it holding the error pipe:
      // this process then never ended (one run in ten of the end-to-end test, D469). A moment
      // for what the host last wrote, then the pipes are closed from here.
      const closePipes = setTimeout(() => {
        stdin.destroy();
        stdout.destroy();
        stderr.destroy();
      }, 250);
      closePipes.unref();
    });
    // Never started: there is no exit event.
    child.once("error", () => finish(null, null));
  });

  const transport = new StreamTransport(duplexFromStreams(stdin, stdout), options);
  child.once("error", () => transport.close());

  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };
  let info: HostInfo;
  try {
    info = await transport.ready;
  } catch (err) {
    kill();
    // The spawn's own failure may be reported just after the pipes'.
    await new Promise<void>((resolve) => setImmediate(resolve));
    throw couldNotStart(spawnError ?? err);
  }

  return {
    transport,
    info,
    pid: child.pid,
    exited,
    stop: async (timeoutMs = 5000) => {
      await transport.shutdown(timeoutMs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), timeoutMs);
      });
      const outcome = await Promise.race([exited, late]);
      clearTimeout(timer);
      if (outcome === "late") {
        kill();
        await exited;
      }
    },
    kill,
  };
}

export interface HostSocketOptions extends StreamTransportOptions {
  /** Loopback unless said otherwise. */
  host?: string;
  port: number;
}

/**
 * Dials a host that listens on a socket (`token` is the connection's secret) and resolves with
 * the connected transport once it has answered the handshake.
 */
export async function connectHostSocket(options: HostSocketOptions): Promise<StreamTransport> {
  const socket: Socket = connect({ host: options.host ?? "127.0.0.1", port: options.port });
  socket.setNoDelay(true);
  const transport = new StreamTransport(
    duplexFromStreams(socket, socket, () => socket.destroy()),
    options,
  );
  try {
    await transport.ready;
  } catch (err) {
    socket.destroy();
    throw err;
  }
  return transport;
}
