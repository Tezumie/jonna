// The `vscode` shim's terminals (VS Code's createTerminal, window.terminals / activeTerminal and
// their events) over `ide.terminals` (rpcTerminals.ts): a shell or a pseudoterminal in a terminal
// tab that opens unshown until show(), whose process id, closing (exitStatus), being the active
// one, the user's typing (state.isInteractedWith) and shell integration (shellIntegration,
// executeCommand, onDidStart/EndTerminalShellExecution, each command's output through read()) the
// host reports. The user's terminals (and other extensions') are listed too, as VS Code lists
// every terminal. DOM-free and unit-tested.

import type { WorkerApi } from "../rpc";
import type { OtherTerminal, Pseudoterminal, TerminalEvent } from "../rpcTerminals";
import { pathOf, uriOf } from "./convert";
import { TerminalShellExecutionCommandLineConfidence } from "./extraTypes";
import { type Event, EventEmitter, TerminalExitReason, type Uri } from "./types";

/** VS Code's Pseudoterminal (events and methods). */
export interface VsPseudoterminal {
  onDidWrite: Event<string>;
  onDidClose?: Event<number | undefined | void>;
  open(dimensions: unknown): void;
  close(): void;
  handleInput?(data: string): void;
  setDimensions?(dimensions: unknown): void;
}

/** VS Code's Pseudoterminal as the IDE's (a terminal's, a custom task's). */
export function toIdePty(pty: VsPseudoterminal, onClose?: (code: number) => void): Pseudoterminal {
  return {
    open: (dimensions, io) => {
      pty.onDidWrite((text) => io.write(text));
      pty.onDidClose?.((code) => {
        const exit = typeof code === "number" ? code : 0;
        io.exit(exit);
        onClose?.(exit);
      });
      pty.open(dimensions);
    },
    input: (data) => pty.handleInput?.(data),
    resize: (dimensions) => pty.setDimensions?.(dimensions),
    close: () => pty.close(),
  };
}

/**
 * A Windows command-line tail as its arguments (`-NoExit -Command "a b"` → three), the way
 * programs read theirs: spaces outside double quotes separate, `""` inside quotes is a quote.
 */
export function splitCommandLine(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else quoted = !quoted;
      started = true;
    } else if (!quoted && (c === " " || c === "\t")) {
      if (started) args.push(current);
      current = "";
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

export interface TerminalOptions {
  name?: string;
  shellPath?: string;
  shellArgs?: string[] | string;
  cwd?: string | Uri;
  env?: Record<string, string | null>;
  pty?: VsPseudoterminal;
  /** VS Code's: not listed and not shown to the user until show(); never saved (D388). */
  hideFromUser?: boolean;
  /** VS Code's: not saved with the folder, gone after a restart (D388). */
  isTransient?: boolean;
}

/** VS Code's TerminalShellIntegration. */
export interface ShellIntegration {
  readonly cwd: Uri | undefined;
  executeCommand(commandLine: string, args?: string[]): Execution;
}

export interface Execution {
  commandLine: { value: string; isTrusted: boolean; confidence: number };
  cwd: Uri | undefined;
  read(): AsyncIterable<string>;
  /** Output the host sent while it runs (after the first read()). */
  push(text: string): void;
  /** Ends read() once what was printed has been read (the command finished). */
  end(): void;
}

/** One command's output kept for its readers (VS Code's read() gives all of it to each). */
const MAX_OUTPUT_CHUNKS = 10_000;

/**
 * One command run in a terminal (VS Code's TerminalShellExecution). read() yields what it prints
 * (escape codes included) from its start: the first read() asks the host for what it printed so
 * far (`fetch`), then the rest arrives as it comes; each reader gets all of it, and its iteration
 * ends with the command.
 */
export function execution(
  value: string,
  cwd: string,
  confidence: number,
  fetch: () => Promise<string | null>,
): Execution {
  let ended = false;
  /** Asked once; until it answers, later chunks wait behind what it brings. */
  let asked = false;
  let ready = false;
  const chunks: string[] = [];
  const waiting = new Set<() => void>();
  const wake = () => {
    for (const w of [...waiting]) w();
    waiting.clear();
  };
  const start = () => {
    if (asked) return;
    asked = true;
    void fetch()
      .catch(() => null)
      .then((early) => {
        if (early) chunks.unshift(early);
        ready = true;
        wake();
      });
  };
  return {
    commandLine: { value, isTrusted: confidence === 2, confidence },
    cwd: cwd ? uriOf(cwd) : undefined,
    read: () => {
      start();
      let at = 0;
      return {
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<string>> => {
            for (;;) {
              if (ready && at < chunks.length)
                return { done: false, value: chunks[at++] as string };
              if (ready && ended) return { done: true, value: undefined };
              await new Promise<void>((resolve) => waiting.add(resolve));
            }
          },
        }),
      };
    },
    push: (text) => {
      if (ended || !text || chunks.length >= MAX_OUTPUT_CHUNKS) return;
      chunks.push(text);
      wake();
    },
    end: () => {
      ended = true;
      wake();
    },
  };
}

export function createTerminals(ide: WorkerApi, unsupported: (name: string) => void) {
  type ShimTerminal = ReturnType<typeof makeTerminal>;
  const terminals: ShimTerminal[] = [];
  let active: ShimTerminal | undefined;
  const onDidOpenTerminal = new EventEmitter<unknown>();
  const onDidCloseTerminal = new EventEmitter<unknown>();
  const onDidChangeActiveTerminal = new EventEmitter<unknown>();
  const onDidChangeTerminalState = new EventEmitter<unknown>();
  const onDidChangeTerminalShellIntegration = new EventEmitter<{
    terminal: unknown;
    shellIntegration: unknown;
  }>();
  const onDidStartTerminalShellExecution = new EventEmitter<{
    terminal: unknown;
    shellIntegration: unknown;
    execution: unknown;
  }>();
  const onDidEndTerminalShellExecution = new EventEmitter<{
    terminal: unknown;
    shellIntegration: unknown;
    execution: unknown;
    exitCode: number | undefined;
  }>();

  const setActive = (terminal: ShimTerminal | undefined) => {
    if (active === terminal) return;
    active = terminal;
    onDidChangeActiveTerminal.fire(terminal);
  };

  /** One of its own (`o`), or one it didn't make (`other`: the user's). */
  function makeTerminal(o: TerminalOptions, other?: OtherTerminal) {
    const env = o.env
      ? Object.fromEntries(
          Object.entries(o.env).filter((e): e is [string, string] => typeof e[1] === "string"),
        )
      : undefined;
    let exitStatus: { code: number | undefined; reason: number } | undefined;
    let resolvePid: (pid: number | undefined) => void = () => {};
    const processId = new Promise<number | undefined>((r) => (resolvePid = r));
    let closed = false;
    const state = { isInteractedWith: false };
    let cwd = "";
    /** Commands sent with executeCommand, waiting for their start (in order). */
    const queued: Execution[] = [];
    let running: Execution | undefined;
    let shellIntegration: ShellIntegration | undefined;
    const end = (reason: number, code?: number) => {
      if (closed) return;
      closed = true;
      exitStatus = { code, reason };
      running?.end();
      for (const q of queued.splice(0)) q.end();
      const i = terminals.indexOf(terminal);
      if (i >= 0) terminals.splice(i, 1);
      resolvePid(undefined);
      if (active === terminal) setActive(undefined);
      onDidCloseTerminal.fire(terminal);
    };
    const onEvent = (e: TerminalEvent) => {
      if (closed) return;
      switch (e.kind) {
        case "started":
          resolvePid(e.pid ?? undefined);
          return;
        case "closed":
          end(e.reason, e.code);
          return;
        case "active":
          if (e.active) setActive(terminal);
          else if (active === terminal) setActive(undefined);
          return;
        case "interacted":
          if (state.isInteractedWith) return;
          state.isInteractedWith = true;
          onDidChangeTerminalState.fire(terminal);
          return;
        case "shellIntegration":
          cwd = e.cwd;
          shellIntegration = {
            get cwd() {
              return cwd ? uriOf(cwd) : undefined;
            },
            executeCommand: (commandLine: string, args?: string[]) => {
              const line = args?.length
                ? [commandLine, ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(" ")
                : commandLine;
              const run = execution(
                line,
                cwd,
                TerminalShellExecutionCommandLineConfidence.High,
                readOutput,
              );
              queued.push(run);
              terminal.sendText(line, true);
              return run;
            },
          };
          onDidChangeTerminalShellIntegration.fire({ terminal, shellIntegration });
          return;
        case "cwd":
          cwd = e.cwd;
          return;
        case "commandStart": {
          running?.end();
          running =
            queued.shift() ??
            execution(
              e.commandLine,
              e.cwd,
              e.commandLine
                ? TerminalShellExecutionCommandLineConfidence.Medium
                : TerminalShellExecutionCommandLineConfidence.Low,
              readOutput,
            );
          onDidStartTerminalShellExecution.fire({
            terminal,
            shellIntegration,
            execution: running,
          });
          return;
        }
        case "output":
          running?.push(e.text);
          return;
        case "commandEnd": {
          const run = running;
          running = undefined;
          if (!run) return;
          run.end();
          onDidEndTerminalShellExecution.fire({
            terminal,
            shellIntegration,
            execution: run,
            exitCode: e.exitCode,
          });
          return;
        }
      }
    };
    const pty = o.pty;
    const created = other
      ? Promise.resolve(ide.terminals.attach(other, onEvent))
      : ide.terminals.create({
          ...(o.name && { name: o.name }),
          ...(o.shellPath && { shellPath: o.shellPath }),
          // A string is Windows' command-line tail (VS Code passes it as is): split as Windows does.
          ...(o.shellArgs && {
            shellArgs: Array.isArray(o.shellArgs) ? o.shellArgs : splitCommandLine(o.shellArgs),
          }),
          ...(o.cwd && { cwd: typeof o.cwd === "string" ? o.cwd : pathOf(o.cwd) }),
          ...(env && { env }),
          // Its pseudoterminal closing itself ends the terminal and its tab (VS Code's exitStatus:
          // Extension).
          ...(pty && {
            pty: toIdePty(pty, (code) => {
              if (closed) return;
              end(TerminalExitReason.Extension, code);
              void created.then((t) => t.dispose()).catch(() => {});
            }),
          }),
          background: true,
          // The Python extension's shell-integration probes and helpers (D388): no tab.
          ...(o.hideFromUser === true && { hidden: true }),
          ...(o.isTransient === true && { transient: true }),
          onEvent,
        });
    /** What the running command printed so far (its later output comes as events). */
    const readOutput = () => created.then((t) => ide.terminals.readOutput(t.id));
    const terminal = {
      name: other?.name ?? o.name ?? "",
      processId,
      creationOptions: o,
      get exitStatus() {
        return exitStatus;
      },
      state,
      get shellIntegration(): ShellIntegration | undefined {
        return shellIntegration;
      },
      sendText: (text: string, shouldExecute = true) =>
        void created.then((t) => t.sendText(text, shouldExecute)).catch(() => {}),
      show: (preserveFocus?: boolean) => {
        void created.then((t) => t.show(!preserveFocus)).catch(() => {});
      },
      hide: () => {},
      dispose: () => {
        if (closed) return;
        void created.then((t) => t.dispose()).catch(() => {});
        end(TerminalExitReason.Extension);
      },
    };
    created.catch((err: unknown) => {
      unsupported(`window.createTerminal (${err instanceof Error ? err.message : String(err)})`);
      terminal.dispose();
    });
    return terminal;
  }

  // Every terminal, as VS Code lists them: the user's (and other extensions') too. Those open
  // already are in window.terminals; one opened later fires onDidOpenTerminal.
  const adopted = new Set<string>();
  const adopt = (other: OtherTerminal, opened: boolean) => {
    if (adopted.has(other.id)) return;
    adopted.add(other.id);
    const terminal = makeTerminal({ name: other.name }, other);
    terminals.push(terminal);
    if (opened) onDidOpenTerminal.fire(terminal);
  };
  void ide.terminals
    .watchOthers((t) => adopt(t, true))
    .then((now) => {
      for (const t of now) adopt(t, false);
    })
    .catch(() => {});

  const createTerminal = (
    nameOrOptions?: string | TerminalOptions,
    shellPath?: string,
    shellArgs?: string[] | string,
  ) => {
    const o =
      typeof nameOrOptions === "object"
        ? nameOrOptions
        : { name: nameOrOptions, shellPath, shellArgs };
    const terminal = makeTerminal(o);
    terminals.push(terminal);
    onDidOpenTerminal.fire(terminal);
    return terminal;
  };

  return {
    createTerminal,
    get terminals(): readonly unknown[] {
      return [...terminals];
    },
    get activeTerminal(): unknown {
      return active;
    },
    onDidOpenTerminal: onDidOpenTerminal.event,
    onDidCloseTerminal: onDidCloseTerminal.event,
    onDidChangeActiveTerminal: onDidChangeActiveTerminal.event,
    onDidChangeTerminalState: onDidChangeTerminalState.event,
    onDidChangeTerminalShellIntegration: onDidChangeTerminalShellIntegration.event,
    onDidStartTerminalShellExecution: onDidStartTerminalShellExecution.event,
    onDidEndTerminalShellExecution: onDidEndTerminalShellExecution.event,
  };
}
