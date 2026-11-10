// Sessions that start under another one (D204): Node child processes that registered through
// the auto-attach bootloader, worker threads, a JavaScript debug terminal's programs, the browser
// or configuration a `serverReadyAction` starts, and the child sessions a debug adapter asks for
// with DAP's `startDebugging` reverse request (debugpy's subprocesses). Each is a session of its
// own in the call stack, under its parent, and ends with it. The controller (controller.ts) owns
// the sessions; this file decides when and how the children start.
import { debugAttachIpc } from "../../core/ipc/process";
import type { DisposableStore } from "../../core/lifecycle/index";
import type { ReadonlySignal } from "../../core/reactive/index";
import type { TaskExecution, WorkbenchServices } from "../../workbench/services";
import type { Variables } from "../tasks/tasks";
import {
  autoAttachEnv,
  parentFor,
  parseRegistration,
  type Registration,
  registrationName,
} from "./autoAttach";
import type { ConsoleLine } from "./consoleSessions";
import { childLaunchConfig, type LaunchConfig, toConfig } from "./launch";
import type { SessionLaunchers } from "./launchers";
import type { RunningSession, SessionKind } from "./runningSession";
import { feedServerReady, parseServerReady } from "./serverReady";
import type { ChildTarget, DebugSession, SessionSetup } from "./session";

/** What the controller asks of the rest of the IDE (index.ts sets these). */
export interface ControllerHooks {
  /** Runs a task by label, looked up in `folder` (the configuration's) first (D251). */
  runTask(label: string, folder?: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** Starts the launch configuration `name` as a child of `parentId` (serverReadyAction). */
  startByName(name: string, parentId: string): Promise<void>;
  /**
   * The variables a configuration of `folder` is filled in with (after extensions' resolvers
   * ran on it as written, D295); null without a folder.
   */
  variables?(folder?: string): Promise<Variables | null>;
}

/** The controller as the child sessions see it. */
export interface SessionHost {
  readonly services: WorkbenchServices;
  readonly sessions: ReadonlySignal<readonly RunningSession[]>;
  readonly launchers: SessionLaunchers;
  readonly hooks: ControllerHooks;
  session(id: string): RunningSession | undefined;
  newSession(
    config: LaunchConfig,
    opts: {
      parentId?: string | null;
      compound?: string | null;
      noDebug?: boolean;
      kind?: SessionKind;
      name?: string;
    },
  ): RunningSession;
  add(rs: RunningSession, focus: boolean): void;
  run(rs: RunningSession, session: DebugSession): Promise<void>;
  ended(rs: RunningSession, failed?: boolean): void;
  start(
    config: LaunchConfig,
    noDebug?: boolean,
    opts?: {
      parentId?: string;
      compound?: string;
      keepWhenParentEnds?: boolean;
      kind?: SessionKind;
    },
  ): Promise<RunningSession | null>;
  printFor(rs: RunningSession, line: ConsoleLine): void;
  setupFor(rs: RunningSession): SessionSetup;
}

export class ChildSessions {
  private readonly serverReadyFeed = new Map<string, (text: string) => void>();

  constructor(private readonly host: SessionHost) {}

  /** Variables for a configuration made for `rs` (its own folder's, D251). */
  private vars(rs?: RunningSession) {
    const { workspace } = this.host.services;
    return {
      workspaceFolder: rs?.config.workspaceFolder ?? workspace.root.peek() ?? "",
      folders: workspace.folders.peek(),
      pathSeparator: "/",
    };
  }

  // ---- Auto-attach (Node child processes, a package manager's scripts, debug terminals) ----

  /**
   * A registration folder for `rs`'s program (its child processes, or a package manager's
   * scripts' Node processes), polled while it runs. Returns the program's environment.
   */
  async watchRegistrations(
    rs: RunningSession | null,
    owner: string | null,
    alive: () => boolean = () => !rs?.ended,
    store: DisposableStore | null = rs?.store ?? null,
    base: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const prepared = await debugAttachIpc.prepare();
    const mode =
      this.host.services.settings.peek<string>("debug.javascript.autoAttachFilter") === "always"
        ? "always"
        : "smart";
    let busy = false;
    const stop = {
      dispose: () => {
        clearInterval(timer);
        void debugAttachIpc.dispose(prepared.id).catch(() => {});
      },
    };
    const timer = setInterval(() => {
      if (busy) return;
      if (!alive()) {
        // Gone (a closed debug terminal): stop, and leave nothing behind in the store.
        if (store) store.delete(stop);
        else stop.dispose();
        return;
      }
      busy = true;
      void debugAttachIpc
        .take(prepared.id)
        .then((texts) => {
          for (const text of texts) {
            const reg = parseRegistration(text);
            if (reg) void this.startRegistered(reg, owner).catch(() => {});
          }
        })
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    }, 250);
    store?.add(stop);
    return autoAttachEnv(base, prepared, mode);
  }

  /** A Node process that registered: a child session (of its parent process's, or `owner`'s). */
  private async startRegistered(reg: Registration, owner: string | null): Promise<void> {
    const live = this.host.sessions.peek().filter((s) => !s.ended);
    const ownerAlive = owner !== null && live.some((s) => s.id === owner) ? owner : null;
    const parentId = parentFor(reg, live, ownerAlive);
    const parent = parentId ? this.host.session(parentId) : undefined;
    const config =
      toConfig(
        {
          name: registrationName(reg),
          type: "node",
          request: "attach",
          ...(reg.cwd ? { cwd: reg.cwd } : {}),
        },
        "auto-attach",
        this.vars(parent),
      ) ?? parent?.config;
    if (!config) return;
    const rs = this.host.newSession(config, {
      parentId,
      compound: parent?.compound ?? null,
      kind: "child",
      name: registrationName(reg),
    });
    rs.pid = reg.pid;
    this.host.add(rs, false);
    try {
      await this.host.run(rs, this.host.launchers.registered(reg, this.host.setupFor(rs)));
    } catch {
      this.host.ended(rs, true);
    }
  }

  async startWorker(parent: RunningSession, child: ChildTarget): Promise<void> {
    if (parent.ended) return;
    const rs = this.host.newSession(parent.config, {
      parentId: parent.id,
      compound: parent.compound,
      kind: "worker",
      name: `Worker: ${child.name}`,
    });
    this.host.add(rs, false);
    try {
      await this.host.run(rs, this.host.launchers.worker(child, this.host.setupFor(rs)));
    } catch {
      this.host.ended(rs, true);
    }
  }

  // ---- DAP startDebugging ----

  /**
   * The debug adapter of `parent` asked for a child session (DAP `startDebugging`, VS Code's
   * behavior): the same debugger type, the adapter's configuration passed on as it is, under
   * `parent` in the call stack, stopped with it. Resolves once the child runs; a failure goes
   * back to the adapter as the request's error.
   */
  async startDebugging(
    parent: RunningSession,
    configuration: Record<string, unknown>,
    request: "launch" | "attach",
  ): Promise<void> {
    if (parent.ended) throw new Error("The parent session ended.");
    const config = childLaunchConfig(parent.config, configuration, request);
    await this.host.start(config, parent.noDebug, {
      parentId: parent.id,
      ...(parent.compound ? { compound: parent.compound } : {}),
      kind: "adapterChild",
    });
  }

  // ---- serverReadyAction ----

  watchServerReady(rs: RunningSession, terminal: TaskExecution | null): void {
    const ready = parseServerReady(rs.config.raw.serverReadyAction);
    if (!ready || rs.noDebug) return;
    if (!this.serverReadyFeed.has(rs.id)) {
      let tail = "";
      let done = false;
      const feed = (text: string) => {
        if (done) return;
        const r = feedServerReady(tail, text, ready);
        tail = r.tail;
        if (!r.uri) return;
        done = true;
        void this.serverReady(rs, r.uri, ready).catch((err: unknown) =>
          this.host.printFor(rs, {
            kind: "error",
            text: `serverReadyAction: ${err instanceof Error ? err.message : String(err)}`,
          }),
        );
      };
      this.serverReadyFeed.set(rs.id, feed);
      rs.store.add({ dispose: () => this.serverReadyFeed.delete(rs.id) });
    }
    if (terminal) {
      const feed = this.serverReadyFeed.get(rs.id);
      rs.store.add(terminal.onOutput((chunk) => feed?.(chunk)));
    }
  }

  /** The program's output from the debugger (DAP `output`): serverReadyAction reads it too. */
  feedOutput(rs: RunningSession, text: string): void {
    this.serverReadyFeed.get(rs.id)?.(text);
  }

  private async serverReady(
    rs: RunningSession,
    uri: string,
    ready: NonNullable<ReturnType<typeof parseServerReady>>,
  ): Promise<void> {
    if (rs.ended) return;
    this.host.printFor(rs, { kind: "info", text: `Server ready: ${uri}` });
    if (ready.action === "openExternally") return this.host.hooks.openExternal(uri);
    if (ready.action === "startDebugging") {
      if (!ready.name) throw new Error('"startDebugging" needs a configuration "name".');
      return this.host.hooks.startByName(ready.name, rs.id);
    }
    // The address comes from the program's output: only a web page goes to the browser (as
    // openExternally only opens http(s) links), not file: or javascript: addresses.
    if (!/^https?:\/\//i.test(uri)) throw new Error(`Not a web address: ${uri}`);
    const type = ready.action === "debugWithEdge" ? "msedge" : "chrome";
    const config = toConfig(
      {
        name: `${type === "msedge" ? "Edge" : "Chrome"}: ${uri}`,
        type,
        request: "launch",
        url: uri,
        webRoot:
          ready.webRoot ??
          rs.config.raw.webRoot ??
          rs.config.workspaceFolder ??
          this.host.services.workspace.root.peek() ??
          "",
      },
      "serverReadyAction",
      this.vars(rs),
    );
    if (config)
      await this.host.start({ ...config, workspaceFolder: rs.config.workspaceFolder }, false, {
        parentId: rs.id,
        ...(rs.compound ? { compound: rs.compound } : {}),
        keepWhenParentEnds: !ready.killOnServerStop,
      });
  }
}
