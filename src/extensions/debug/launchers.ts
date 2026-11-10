// Making a debug session for a configuration (D143, D196, D204): Node through its inspector (in a
// terminal tab, with the auto-attach bootloader for its child processes), a page in Chrome or Edge,
// DAP adapters over stdio or — Delve — over a local port, a package manager's script (npm, yarn,
// pnpm: its Node processes attach on their own), and the sessions found while debugging (a
// registered child process, a worker thread). The controller (controller.ts) owns what they do.

import { Emitter } from "../../core/events/index";
import { fsIpc } from "../../core/ipc/fs";
import { debugSocketIpc, startStdioProcess } from "../../core/ipc/process";
import { joinPath } from "../../core/paths/index";
import { trackedTransport } from "../../workbench/extensionRegistries";
import type { TaskExecution, WorkbenchServices } from "../../workbench/services";
import { workspaceFolderPath } from "../../workbench/workspaceFolder";
import { quoteTaskArg, type TaskShellKind, taskShellKind } from "../tasks/tasks";
import type { Registration } from "./autoAttach";
import {
  type PageMapping,
  pageScriptPath,
  pageUrlRegex,
  pickFrameTarget,
  pickPageTarget,
} from "./browser";
import { type CdpHost, CdpSession, inspectorPort, inspectorUrl, pathToUrl } from "./cdp";
import { type Adapter, dapLaunchArguments, type LaunchConfig } from "./launch";
import { captureProgramOutput, capturesOutput } from "./programOutput";
import { type ProgramRun, startPiped, terminalRun } from "./programProcess";
import {
  type ChildTarget,
  type ContinuedEvent,
  DapConnection,
  DapSession,
  type DebugSession,
  NO_CAPABILITIES,
  type OutputEvent,
  type SessionSetup,
  type StoppedEvent,
} from "./session";

let socketCounter = 0;
const nextId = () => `debug-${++socketCounter}`;
const never = new Promise<number>(() => {});

/**
 * Closes a browser through a page's debugging connection (`Browser.close`): for a browser whose
 * program handed off and exited (Edge's msedge.exe on Windows), killing that program ends nothing.
 */
async function closeBrowserAt(pageSocket: string): Promise<void> {
  const id = `close-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await debugSocketIpc.connect(id, pageSocket, () => {});
    await debugSocketIpc.send(id, JSON.stringify({ id: 1, method: "Browser.close" }));
    await new Promise((r) => setTimeout(r, 500));
  } catch {
    // Already gone.
  } finally {
    void debugSocketIpc.close(id).catch(() => {});
  }
}

/** What a launcher tells the session it's making for. */
export interface LaunchTarget {
  /** The terminal the program runs in (kept for Stop and the console). */
  setTerminal(t: TaskExecution): void;
  /** Variables for the program (auto-attach's NODE_OPTIONS), when a launcher runs one. */
  env: Record<string, string>;
  /**
   * The adapter asked for a child session (DAP `startDebugging`): the controller starts it under
   * this session (childSessions.ts). Absent: the adapter is told the IDE can't.
   */
  startDebugging?(
    configuration: Record<string, unknown>,
    request: "launch" | "attach",
  ): Promise<void>;
}

const readText = (path: string) =>
  fsIpc.read(path).then(
    (bytes) => new TextDecoder().decode(bytes),
    () => null,
  );

/** The socket host part shared by Node and browser sessions. */
function socketConnect(id: string): CdpHost["connect"] {
  return async (url, onMessage, onClose) => {
    await debugSocketIpc.connect(id, url, (e) => {
      if (e.kind === "message") onMessage(e.body);
      else onClose(e.reason);
    });
    return {
      send: (body) => void debugSocketIpc.send(id, body).catch(() => {}),
      close: () => void debugSocketIpc.close(id).catch(() => {}),
    };
  };
}

/** A program run by a package manager (npm run dev): `npm`, `npx`, `yarn`, `pnpm`. */
export function isPackageManager(runtime: string | undefined): boolean {
  const exe = (runtime ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return /^(npm|npx|yarn|pnpm|pnpx)(\.cmd|\.exe|\.ps1)?$/.test(exe);
}

/**
 * One shell word, quoted when it has anything but plain characters: single quotes, since in
 * double quotes sh and PowerShell still expand `$x`, `$(…)` and backticks (a Remix route
 * "posts.$id.tsx" from ${file} would lose its "$id", a file named "$(calc).js" would run it).
 * Windows: PowerShell's quoting (the task shell there).
 */
export const shellWord = (w: string, windows: boolean, kind?: TaskShellKind) =>
  quoteTaskArg(w, kind ?? (windows ? "pwsh" : "posix"));

/**
 * A command line of words; PowerShell runs a quoted program only after `&`. `kind`: the shell's
 * quoting when it isn't the default one (the automation profile's, D209).
 */
export function shellLine(
  words: readonly string[],
  windows: boolean,
  kind?: TaskShellKind,
): string {
  const as = kind ?? (windows ? "pwsh" : "posix");
  const line = words.map((w) => shellWord(w, windows, as)).join(" ");
  return as === "pwsh" && line.startsWith("'") ? `& ${line}` : line;
}

export class SessionLaunchers {
  constructor(private readonly services: WorkbenchServices) {}

  async runInTerminal(
    config: LaunchConfig,
    cmd: { command: string; args: string[]; shell?: boolean },
    env: Record<string, string>,
    cwd?: string,
    /** "never": the terminal isn't brought forward (its output goes to the debug console). */
    reveal: "always" | "never" = "always",
  ): Promise<TaskExecution> {
    return this.services.taskTerminals.run({
      label: `Debug: ${config.name}`,
      spec: cmd.shell
        ? {
            kind: "shell",
            command: shellLine(
              [cmd.command, ...cmd.args],
              this.services.platform === "windows",
              taskShellKind(
                this.services.taskTerminals.automationShell?.(config.workspaceFolder) ?? undefined,
                this.services.platform,
              ),
            ),
            env,
          }
        : { kind: "process", command: cmd.command, args: cmd.args, env },
      // The configuration's folder by default (D251).
      cwd:
        cwd ??
        config.cwd ??
        config.workspaceFolder ??
        this.services.workspace.root.peek() ??
        undefined,
      presentation: {
        reveal,
        focus: false,
        panel: "dedicated",
        clear: true,
        close: false,
      },
    });
  }

  nodeCommand(config: LaunchConfig, inspect: boolean): { command: string; args: string[] } {
    if (!config.program) throw new Error(`“${config.name}” has no "program" to run.`);
    return {
      command: config.runtimeExecutable ?? "node",
      args: [
        ...config.runtimeArgs,
        ...(inspect ? ["--inspect-brk=127.0.0.1:0"] : []),
        config.program,
        ...config.args,
      ],
    };
  }

  /** A running Node's inspector address: `websocketAddress`, or asked of `address`:`port`. */
  async attachTarget(config: LaunchConfig): Promise<{ url: string }> {
    const ws = config.raw.websocketAddress;
    if (typeof ws === "string" && ws) return { url: ws };
    const address =
      typeof config.raw.address === "string" && config.raw.address
        ? config.raw.address
        : "127.0.0.1";
    const port = typeof config.raw.port === "number" ? config.raw.port : 9229;
    const pid = Number(config.raw.processId);
    // Attach to a process by id (the process picker): Node opens its inspector when asked.
    if (Number.isInteger(pid) && pid > 0) await this.openInspector(pid, config);
    let targets: { webSocketDebuggerUrl?: string; type?: string }[] = [];
    const deadline = Date.now() + (pid > 0 ? 5000 : 0);
    for (;;) {
      try {
        targets = JSON.parse(await debugSocketIpc.targets(address, port));
        break;
      } catch (err) {
        if (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        throw new Error(
          `Couldn't attach to ${address}:${port}: ${err instanceof Error ? err.message : String(err)}. Start the program with node --inspect=${port}.`,
        );
      }
    }
    const target =
      targets.find((t) => t.webSocketDebuggerUrl && (t.type ?? "node") === "node") ??
      targets.find((t) => t.webSocketDebuggerUrl);
    if (!target?.webSocketDebuggerUrl)
      throw new Error(`No Node program to attach to at ${address}:${port}.`);
    return { url: target.webSocketDebuggerUrl };
  }

  /**
   * Asks a running Node process to open its inspector (port 9229 by default): Node's own
   * `process._debugProcess`, which signals it on macOS and Linux and uses a remote thread on
   * Windows — what VS Code does for "Attach to Node process".
   */
  private async openInspector(pid: number, config: LaunchConfig): Promise<void> {
    const node = config.runtimeExecutable ?? "node";
    const proc = await startStdioProcess(
      nextId(),
      {
        command: node,
        args: ["-e", `process._debugProcess(${pid})`],
        cwd: config.workspaceFolder ?? this.services.workspace.root.peek() ?? "",
      },
      {},
    ).catch((err: unknown) => {
      throw new Error(
        `Couldn't ask process ${pid} to open its debugger: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    // It's done at once; give the target a moment to open the port.
    await new Promise((r) => setTimeout(r, 500));
    await proc.stop();
  }

  node(config: LaunchConfig, setup: SessionSetup, target: LaunchTarget): DebugSession {
    const { platform } = this.services;
    const id = nextId();
    return new CdpSession(
      {
        windows: platform === "windows",
        caseInsensitive: platform !== "linux",
        stopOnEntry: config.stopOnEntry,
        readFile: readText,
        launch: async () => {
          if (config.request === "attach")
            return { ...(await this.attachTarget(config)), kill: () => {}, exited: never };
          // "internalConsole" / outputCapture "std": run with pipes, its stdout and stderr in the
          // debug console (programProcess.ts), as js-debug does; otherwise in a terminal tab.
          const capture = capturesOutput(config);
          const env = { ...config.env, ...target.env };
          const execution = capture
            ? await this.runPiped(config, this.nodeCommand(config, true), env)
            : terminalRun(
                await this.runInTerminal(config, this.nodeCommand(config, true), env).then((t) => {
                  target.setTerminal(t);
                  return t;
                }),
              );
          const url = await new Promise<string>((resolve, reject) => {
            let text = "";
            let settled = false;
            // The listener gets the output so far right away (it may hold the line already),
            // so it can run before `sub` exists: dispose only once both are there.
            let sub: { dispose(): void } | undefined;
            const settle = (result: () => void) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              queueMicrotask(() => sub?.dispose());
              result();
            };
            const timer = setTimeout(() => {
              settle(() => {
                execution.kill();
                reject(new Error("Node didn't start its debugger (no “Debugger listening” line)."));
              });
            }, 15_000);
            /** The port whose targets list was asked for (once). */
            let asked: number | null = null;
            sub = execution.onOutput((chunk) => {
              text = (text + chunk).slice(-65_536);
              const found = inspectorUrl(text);
              if (found) {
                settle(() => resolve(found));
                return;
              }
              // The line came garbled (a terminal's wrap, D253) but its port is there: Node's
              // targets list has the address.
              const port = inspectorPort(text);
              if (port === null || port === asked) return;
              asked = port;
              setTimeout(() => {
                if (settled) return;
                void debugSocketIpc
                  .targets("127.0.0.1", port)
                  .then((json) => {
                    const list = JSON.parse(json) as { webSocketDebuggerUrl?: string }[];
                    const ws = list.find((t) => t.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
                    if (ws) settle(() => resolve(ws));
                  })
                  .catch(() => {});
              }, 1000);
            });
            if (settled) sub.dispose();
            void execution.exited.then((code) =>
              settle(() =>
                reject(
                  new Error(
                    `The program ended (exit code ${code}) before the debugger connected.${capture ? ` ${text.trim().split("\n").slice(-3).join("\n")}` : " See its terminal."}`,
                  ),
                ),
              ),
            );
          });
          return {
            url,
            kill: () => execution.kill(),
            exited: execution.exited,
            ...(capture && {
              output: (listener: (chunk: string, stderr: boolean) => void) =>
                execution.onOutput(listener),
            }),
          };
        },
        connect: socketConnect(id),
      },
      setup,
    );
  }

  /** A Node process that registered through the bootloader (a child process, a terminal's). */
  registered(reg: Registration, setup: SessionSetup): DebugSession {
    const { platform } = this.services;
    return new CdpSession(
      {
        windows: platform === "windows",
        caseInsensitive: platform !== "linux",
        stopOnEntry: false,
        exitOnStop: true,
        readFile: readText,
        launch: async () => ({ url: reg.url, kill: () => {}, exited: never }),
        connect: socketConnect(nextId()),
      },
      setup,
    );
  }

  /** A worker thread, through its parent's inspector. */
  worker(child: ChildTarget, setup: SessionSetup): DebugSession {
    const { platform } = this.services;
    return new CdpSession(
      {
        windows: platform === "windows",
        caseInsensitive: platform !== "linux",
        stopOnEntry: false,
        worker: true,
        readFile: readText,
        launch: async () => ({ url: "worker", kill: () => {}, exited: never }),
        connect: async (_url, onMessage, onClose) => child.connect(onMessage, onClose),
      },
      setup,
    );
  }

  /**
   * A package manager's script (`"runtimeExecutable": "npm"`): run in a terminal with the
   * auto-attach environment; the session itself has nothing to inspect — the Node processes the
   * script starts attach as its children — and ends with the script.
   */
  launcher(config: LaunchConfig, target: LaunchTarget): DebugSession {
    const capture = capturesOutput(config);
    return new ProcessSession(async () => {
      const runtime = config.runtimeExecutable ?? "npm";
      const cmd = {
        command: runtime,
        args: [...config.runtimeArgs, ...(config.program ? [config.program] : []), ...config.args],
      };
      const env = { ...config.env, ...target.env };
      // "internalConsole": the script's output (npm's and its programs') in the debug console,
      // with pipes, as js-debug runs it.
      if (capture) return this.runPiped(config, cmd, env);
      // npm.cmd and friends need a shell on Windows.
      const execution = await this.runInTerminal(config, { ...cmd, shell: true }, env);
      target.setTerminal(execution);
      return terminalRun(execution);
    }, capture);
  }

  /**
   * Node without debugging (Run without debugging, Ctrl+F5): a session with the program's output,
   * Stop and Restart and nothing to inspect, as VS Code's. In its terminal tab, or with pipes and
   * its output in the debug console ("internalConsole").
   */
  process(config: LaunchConfig, target: LaunchTarget): DebugSession {
    const capture = capturesOutput(config);
    return new ProcessSession(async () => {
      const cmd = this.nodeCommand(config, false);
      const env = { ...config.env, ...target.env };
      if (capture) return this.runPiped(config, cmd, env);
      const execution = await this.runInTerminal(config, cmd, env);
      target.setTerminal(execution);
      return terminalRun(execution);
    }, capture);
  }

  /** A program with pipes (its output captured), started where the configuration says. */
  private runPiped(
    config: LaunchConfig,
    cmd: { command: string; args: string[] },
    env: Record<string, string>,
  ): Promise<ProgramRun> {
    const cwd = config.cwd ?? config.workspaceFolder ?? this.services.workspace.root.peek() ?? "";
    return startPiped({ ...cmd, cwd, env }).catch((err: unknown) => {
      throw new Error(
        `Couldn't start ${cmd.command}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * A page in Chrome or Edge (D196, browser.ts): launched with a debugging port and a profile of
   * its own in a terminal tab (closing it ends the session), or attached on `port`. With
   * `"browserPane": true` (D204, Windows), the IDE's own browser pane on its WebView2 port: the
   * frame whose address starts with `url`.
   */
  browser(
    config: LaunchConfig,
    setup: SessionSetup,
    root: string,
    target: LaunchTarget,
  ): DebugSession {
    const { platform } = this.services;
    const raw = config.raw;
    const windows = platform === "windows";
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const mapping: PageMapping = {
      webRoot: text(raw.webRoot) ?? root,
      pathMapping: Object.fromEntries(
        Object.entries((raw.pathMapping as Record<string, unknown> | undefined) ?? {}).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      ),
      windows,
      caseInsensitive: platform !== "linux",
    };
    const url =
      text(raw.url) ?? (text(raw.file) ? pathToUrl(text(raw.file) as string, windows) : undefined);
    const attach = config.request === "attach";
    const pane = raw.browserPane === true;
    const port =
      typeof raw.port === "number"
        ? raw.port
        : attach
          ? 9222
          : 20000 + Math.floor(Math.random() * 20000);
    const targets = async () =>
      JSON.parse(await debugSocketIpc.targets("127.0.0.1", port)) as {
        type?: string;
        url?: string;
        webSocketDebuggerUrl?: string;
      }[];
    return new CdpSession(
      {
        windows,
        caseInsensitive: mapping.caseInsensitive,
        stopOnEntry: false,
        readFile: readText,
        page: {
          scriptPath: (u) => pageScriptPath(u, mapping),
          urlRegex: (p) => pageUrlRegex(p, mapping),
          fetchText: (u) => debugSocketIpc.get(u).catch(() => null),
          afterStart: async (send) => {
            if (attach || !url) return;
            await send("Page.enable").catch(() => {});
            await send("Page.navigate", { url });
          },
        },
        launch: async () => {
          if (attach) {
            let ws: string | null = null;
            try {
              const list = await targets();
              ws = pane ? pickFrameTarget(list, url ?? "") : pickPageTarget(list, url);
            } catch (err) {
              throw new Error(
                pane
                  ? `The browser pane has no debugging port open (${port}): set debug.browserPane.debuggingPort and restart the IDE (Windows only).`
                  : `Couldn't attach to a browser on port ${port}: ${err instanceof Error ? err.message : String(err)}. Start Chrome or Edge with --remote-debugging-port=${port}.`,
              );
            }
            if (!ws)
              throw new Error(
                pane
                  ? "No page is open in the browser pane."
                  : `No page to attach to on port ${port}${url ? ` at ${url}` : ""}.`,
              );
            return { url: ws, kill: () => {}, exited: never };
          }
          // The browser: runtimeExecutable, else where Chrome or Edge usually is.
          const given = text(raw.runtimeExecutable);
          const name = /edge/i.test(config.type) ? "Edge" : "Chrome";
          const exe =
            given && given !== "stable" && given !== "canary"
              ? given
              : ((await debugSocketIpc
                  .findBrowser(name === "Edge" ? "edge" : "chrome")
                  .catch(() => null)) ?? undefined);
          if (!exe)
            throw new Error(
              `${name} wasn't found. Install it, or set "runtimeExecutable" in the configuration to the browser's path.`,
            );
          // Its own profile (a running browser with yours would ignore the debugging port), in
          // the IDE's folder, kept out of git.
          let profile: string | null = null;
          if (raw.userDataDir !== false) {
            profile = text(raw.userDataDir) ?? workspaceFolderPath(root, "browser-profile");
            if (!text(raw.userDataDir)) {
              await fsIpc.createDir(workspaceFolderPath(root), "browser-profile").catch(() => {});
              await fsIpc
                .write(joinPath(profile, ".gitignore"), new TextEncoder().encode("*\n"))
                .catch(() => {});
            }
          }
          const runtimeArgs = Array.isArray(raw.runtimeArgs)
            ? raw.runtimeArgs.filter((a): a is string => typeof a === "string")
            : [];
          const execution = await this.runInTerminal(
            config,
            {
              command: exe,
              args: [
                `--remote-debugging-port=${port}`,
                ...(profile ? [`--user-data-dir=${profile}`] : []),
                "--no-first-run",
                "--no-default-browser-check",
                ...runtimeArgs,
                "about:blank",
              ],
            },
            config.env,
          );
          target.setTerminal(execution);
          let endedAt: number | null = null;
          void execution.exited.then(() => (endedAt = Date.now()));
          // Its page, once the port answers.
          const deadline = Date.now() + 20_000;
          for (;;) {
            const ws = await targets()
              .then((list) => pickPageTarget(list))
              .catch(() => null);
            if (ws) {
              // Handed off: the browser outlives the program started. Its end is its debugging
              // connection closing, and stopping closes it through the port.
              const answers = () =>
                targets().then(
                  () => true,
                  () => false,
                );
              return {
                url: ws,
                kill: () => {
                  execution.kill();
                  if (endedAt !== null) void closeBrowserAt(ws);
                },
                exited: execution.exited.then(async (code) => ((await answers()) ? never : code)),
              };
            }
            // The program started can hand off to the browser and exit (Edge's msedge.exe on
            // Windows does): its port is still watched a few seconds before it counts as closed.
            if (endedAt !== null && Date.now() - endedAt > 5000)
              throw new Error(`${name} closed before the debugger connected. See its terminal.`);
            if (Date.now() > deadline) {
              execution.kill();
              throw new Error(`${name} didn't open its debugging port (${port}).`);
            }
            await new Promise((r) => setTimeout(r, 250));
          }
        },
        connect: socketConnect(nextId()),
      },
      setup,
    );
  }

  async dap(
    config: LaunchConfig,
    adapter: Extract<Adapter, { kind: "dap" }>,
    setup: SessionSetup,
    root: string,
    noDebug: boolean,
    target: LaunchTarget,
    sessionId = "",
  ): Promise<DebugSession> {
    const stderr: string[] = [];
    let exited = false;
    let session: DapSession | null = null;
    const describeFailure = () => {
      const tail = stderr.slice(-4).join("\n").trim();
      return `${adapter.command} ${adapter.args.join(" ")} stopped${tail ? `:\n${tail}` : "."}${adapter.install ? `\n\nTo debug ${config.type}, ${adapter.install}.` : ""}`;
    };
    let transport: ConstructorParameters<typeof DapConnection>[0];
    let kill: () => Promise<void>;
    // Extensions' debug adapter trackers see the adapter's exit (set below). Declared before the
    // adapter starts: an adapter that exits at once reports it before the start resolves, and
    // calling a `let` not reached yet threw there.
    let exitTrackers = () => {};
    if (adapter.connect) {
      // An extension's adapter (D233): its executable, port or inline adapter, connected by the
      // extensions host.
      ({ transport, kill } = await adapter.connect(() => {
        exited = true;
        exitTrackers();
        session?.adapterExited();
      }, sessionId));
    } else if (adapter.listen) {
      // Delve: `dlv dap --listen=127.0.0.1:<port>` in a terminal (its output and the program's
      // show there), then DAP over that port.
      const port = 20000 + Math.floor(Math.random() * 20000);
      const execution = await this.runInTerminal(
        config,
        {
          command: adapter.command,
          args: adapter.args.map((a) => a.replace("{port}", String(port))),
        },
        config.env,
        config.cwd ?? root,
      ).catch((err: unknown) => {
        throw new Error(
          `Couldn't start the debugger (${adapter.command}): ${err instanceof Error ? err.message : String(err)}${adapter.install ? `. To debug ${config.type}, ${adapter.install}.` : ""}`,
        );
      });
      target.setTerminal(execution);
      void execution.exited.then(() => {
        exited = true;
        session?.adapterExited();
      });
      const id = nextId();
      const messages = new Emitter<string>();
      const deadline = Date.now() + 15_000;
      for (;;) {
        try {
          await debugSocketIpc.dapConnect(id, "127.0.0.1", port, (e) => {
            if (e.kind === "message") messages.fire(e.body);
            else session?.adapterExited();
          });
          break;
        } catch (err) {
          if (exited || Date.now() > deadline) {
            execution.kill();
            throw new Error(
              exited
                ? `${adapter.command} ended before the debugger connected (is it installed? ${adapter.install ?? ""}). See its terminal.`
                : `${adapter.command} didn't open port ${port}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      transport = {
        send: (body) => void debugSocketIpc.send(id, body).catch(() => {}),
        onMessage: messages.event,
      };
      kill = async () => {
        await debugSocketIpc.close(id).catch(() => {});
        execution.kill();
        messages.dispose();
      };
    } else {
      let process: Awaited<ReturnType<typeof startStdioProcess>>;
      try {
        process = await startStdioProcess(
          nextId(),
          {
            command: adapter.command,
            args: adapter.args,
            cwd: root,
            ...(adapter.env && { env: adapter.env }),
          },
          {
            stderr: (line) => {
              stderr.push(line);
              if (stderr.length > 50) stderr.shift();
            },
            exit: () => {
              exited = true;
              exitTrackers();
              session?.adapterExited();
            },
          },
        );
      } catch (err) {
        throw new Error(
          `Couldn't start the debugger (${adapter.command}): ${err instanceof Error ? err.message : String(err)}${adapter.install ? `. To debug ${config.type}, ${adapter.install}.` : ""}`,
        );
      }
      transport = process.transport;
      kill = () => process.stop();
    }
    // Extensions' debug adapter trackers see its messages (D258).
    const trackers = await this.services.extensionFeatures.debugTrackers.start({
      id: sessionId,
      type: config.type,
      name: config.name,
    });
    if (trackers.length) {
      transport = trackedTransport(transport, trackers);
      const stop = kill;
      kill = async () => {
        for (const t of trackers) t.willStop();
        await stop();
      };
      exitTrackers = () => {
        for (const t of trackers) t.exit();
      };
    }
    const dap = new DapConnection(transport, async (command, args) => {
      if (command === "startDebugging" && target.startDebugging) {
        const configuration = args.configuration;
        if (!configuration || typeof configuration !== "object" || Array.isArray(configuration))
          throw new Error("startDebugging needs a configuration.");
        await target.startDebugging(
          configuration as Record<string, unknown>,
          args.request === "attach" ? "attach" : "launch",
        );
        return {};
      }
      if (command !== "runInTerminal") throw new Error(`${command} isn't supported`);
      const argv = (args.args as string[] | undefined) ?? [];
      const [program, ...rest] = argv;
      if (!program) throw new Error("Nothing to run.");
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries((args.env as Record<string, unknown>) ?? {}))
        if (typeof v === "string") env[k] = v;
      const execution = await this.runInTerminal(
        config,
        { command: program, args: rest },
        env,
        typeof args.cwd === "string" && args.cwd ? args.cwd : undefined,
      );
      target.setTerminal(execution);
      return {};
    });
    session = new DapSession(dap, {
      adapterId: adapter.adapterId,
      request: config.request,
      // An extension's adapter gets its configuration as resolved, without the IDE's defaults
      // (args, stopOnEntry, console), as VS Code sends it.
      arguments: {
        ...dapLaunchArguments(adapter.connect ? { ...config, verbatim: true } : config),
        ...(noDebug ? { noDebug: true } : {}),
        // VS Code's: the session the request belongs to (js-debug and others read it).
        ...(sessionId ? { __sessionId: sessionId } : {}),
      },
      setup,
      kill,
      startDebugging: target.startDebugging !== undefined,
    });
    const s = session;
    // A start that fails because the adapter died says why.
    const start = s.start.bind(s);
    s.start = () =>
      start().catch((err: unknown) => {
        throw stderr.length || exited
          ? new Error(describeFailure())
          : err instanceof Error
            ? err
            : new Error(String(err));
      });
    return s;
  }
}

/**
 * A session for a process that isn't debugged itself (a package manager's script, a program run
 * without debugging): it runs, a script's Node processes attach as child sessions, its output
 * goes to the debug console when captured, and it ends when the process does.
 */
export class ProcessSession implements DebugSession {
  private readonly stoppedEmitter = new Emitter<StoppedEvent>();
  readonly onStopped = this.stoppedEmitter.event;
  private readonly continuedEmitter = new Emitter<ContinuedEvent>();
  readonly onContinued = this.continuedEmitter.event;
  private readonly outputEmitter = new Emitter<OutputEvent>();
  readonly onOutput = this.outputEmitter.event;
  private readonly terminatedEmitter = new Emitter<void>();
  readonly onTerminated = this.terminatedEmitter.event;
  private readonly bpEmitter = new Emitter<{ path: string; results: { verified: boolean }[] }>();
  readonly onBreakpoints = this.bpEmitter.event;
  private execution: ProgramRun | null = null;
  private ended = false;

  constructor(
    private readonly run: () => Promise<ProgramRun>,
    /** Its output goes to the debug console (stdout and stderr apart). */
    private readonly capture = false,
  ) {}

  async start(): Promise<void> {
    const execution = await this.run();
    this.execution = execution;
    // Stopped while starting.
    if (this.ended) {
      execution.kill();
      return;
    }
    if (this.capture)
      captureProgramOutput(
        (l) => execution.onOutput(l),
        execution.exited,
        (text, stderr) => this.outputEmitter.fire({ category: stderr ? "stderr" : "stdout", text }),
      );
    void execution.exited.then((code) => {
      if (this.capture)
        this.outputEmitter.fire({ category: "console", text: `Exited with code ${code}\n` });
      this.end();
    });
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.terminatedEmitter.fire();
  }

  capabilities() {
    return NO_CAPABILITIES;
  }
  async setBreakpoints(_path: string, list: unknown[]) {
    return list.map(() => ({ verified: false }));
  }
  async setExceptionStops() {}
  async threads() {
    return [];
  }
  async stackTrace() {
    return [];
  }
  async scopes() {
    return [];
  }
  async variables() {
    return [];
  }
  async setVariable(): Promise<{ value: string; ref: number }> {
    throw new Error("This session runs a script; its Node processes are debugged as its children.");
  }
  async evaluate(): Promise<{ value: string; ref: number }> {
    throw new Error("This session runs a script; select one of its Node processes to evaluate.");
  }
  async resume() {}
  async next() {}
  async stepIn() {}
  async stepOut() {}
  async pause() {}
  async stop(): Promise<void> {
    this.execution?.kill();
    this.end();
  }
}
