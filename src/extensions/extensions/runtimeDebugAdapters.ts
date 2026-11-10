// An extension's debug adapters (D233, rpcScmDebug.ts on the worker side; VS Code's
// DebugAdapterDescriptorFactory). Each debug type of the manifest's `debuggers` is in the debug
// extension's registry from the start (extensionRegistries.ts): a launch of that type starts the
// worker if it isn't running, asks the extension's factory, and connects:
// - an executable: started on the stdio host like a language server ("shell", trusted folder);
// - a server port: a DAP connection to a port of this computer (as for Delve);
// - inline: the extension's own adapter in its worker, its DAP messages crossing the RPC.
// The factory is asked with the debugger's own session (its id and resolved configuration).
// Every extension with code also joins `debugResolvers` (D295): activated on onDebug /
// onDebugResolve:<type> before a launch, and asked for its configuration providers' resolve
// steps whatever debugger then runs the session (debug/resolution.ts has VS Code's order).

import { Emitter } from "../../core/events/index";
import type { ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { debugSocketIpc, startStdioProcess } from "../../core/ipc/process";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import type {
  DebugAdapterConnection,
  DebugAdapterSessionInfo,
  DebugConfigResolver,
} from "../../workbench/extensionRegistries";
import type { WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";

import { checkDescriptor, checkProvidedConfigurations } from "./workbenchChecks";
import type { ExtensionWorker } from "./workerHost";

/** How long a launch waits for a just-started extension to register its factory. */
const FACTORY_WAIT_MS = 5000;
/** How long "Add configuration…" waits for a just-started extension, and for each provider. */
const PROVIDE_WAIT_MS = 1500;
const PROVIDE_CALL_MS = 5000;
/** How long a launch waits for an extension that activates on its debug event (VS Code: no limit). */
const ACTIVATE_WAIT_MS = 30_000;

export interface DebugHostDeps {
  manifest: ThirdPartyManifest;
  services: WorkbenchServices;
  need(permission: string, what: string): void;
  workspacePath(path: unknown): string;
  worker(): Promise<ExtensionWorker>;
  /** The worker if it runs (not started by asking). */
  running?(): ExtensionWorker | null;
}

export class ExtensionDebugHost implements Disposable {
  private readonly store = new DisposableStore();
  /** Factories the worker registered, by debug type. */
  private readonly factories = new Map<string, string>();
  /**
   * Configuration providers' resolve steps (D234, D295), by provider id in the order they were
   * registered: their type ("*" for every type) and which steps they have.
   */
  private readonly resolvers = new Map<
    string,
    { type: string; resolve: boolean; substituted: boolean }
  >();
  /** Providers with provideDebugConfigurations, by their id (several per type). */
  private readonly providers = new Map<string, { type: string; trigger: "initial" | "dynamic" }>();
  private readonly registered = new Emitter<void>();
  /** Inline adapters' sessions: where their messages go. */
  private readonly inline = new Map<string, { emit(body: string): void; exited(): void }>();
  private seq = 0;
  private disposed = false;

  constructor(private readonly deps: DebugHostDeps) {}

  /** Each declared debug type joins the debug extension's registry (the worker starts on launch). */
  contribute(): void {
    const { manifest, services } = this.deps;
    // Every extension with code takes part in starting sessions, whatever debugger runs them
    // (VS Code's activateDebuggers and resolvers for any type, D295): activated on onDebug /
    // onDebugResolve:<type> before the launch, its providers' resolve steps asked in turn.
    if (manifest.main)
      this.store.add(
        services.extensionFeatures.debugResolvers.add({
          owner: manifest.id,
          activate: (event) => this.activate(event),
          resolvers: (step, type) => this.resolveSteps(step, type),
        }),
      );
    for (const d of manifest.contributes.debuggers)
      this.store.add(
        services.extensionFeatures.debugAdapters.add({
          owner: manifest.id,
          type: d.type,
          label: d.label,
          snippets: d.snippets,
          connect: (configuration, exited, session) =>
            this.connect(d.type, configuration, exited, session),
          ready: () =>
            this.disposed
              ? Promise.resolve(false)
              : this.factory(d.type).then(
                  () => true,
                  () => false,
                ),
          provideConfigurations: (folder) => this.provideConfigurations(d.type, folder),
        }),
      );
  }

  /** Its debug adapter trackers (D258), by registration id. */
  private readonly trackers = new Map<string, Disposable>();

  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    switch (method) {
      case "debug.registerTracker": {
        const id = String(p.id ?? "");
        const type = String(p.type ?? "*");
        this.trackers.get(id)?.dispose();
        this.trackers.set(
          id,
          this.deps.services.extensionFeatures.debugTrackers.add({
            owner: this.deps.manifest.id,
            type,
            create: async (session) => {
              const w = this.deps.running?.();
              if (!w) return null;
              const tracker = await w.call<string | null>("provider", `debugTracker.${id}`, {
                session,
              });
              if (typeof tracker !== "string") return null;
              const tell = (kind: string, extra: Record<string, unknown> = {}) => {
                const running = this.deps.running?.();
                if (running)
                  void running
                    .call("provider", `debugTracker.${id}.event`, { tracker, kind, ...extra })
                    .catch(() => {});
              };
              return {
                willReceive: (message) => tell("willReceive", { message }),
                didSend: (message) => tell("didSend", { message }),
                willStop: () => tell("willStop"),
                exit: (code) => tell("exit", code === undefined ? {} : { code }),
              };
            },
          }),
        );
        return Promise.resolve(undefined);
      }
      case "debug.unregisterTracker": {
        const id = String(p.id ?? "");
        this.trackers.get(id)?.dispose();
        this.trackers.delete(id);
        return Promise.resolve(undefined);
      }
      case "debug.register": {
        const type = String(p.type ?? "");
        if (!this.deps.manifest.contributes.debuggers.some((d) => d.type === type))
          throw new Error(
            `Debug type "${type}" isn't declared in the extension's manifest (contributes.debuggers).`,
          );
        this.factories.set(type, String(p.id));
        this.registered.fire();
        return Promise.resolve(undefined);
      }
      case "debug.registerConfigurationProvider": {
        const type = String(p.type ?? "");
        // Any type, or "*", as VS Code allows (only an adapter factory must be for its own type);
        // they're asked for this extension's own sessions.
        if (!/^(\*|[A-Za-z][\w. -]{0,59})$/.test(type))
          throw new Error(`"${type}" isn't a debug type.`);
        // Older workers sent neither flag: they always had a resolve step.
        const resolve = p.resolves !== false;
        const substituted = p.resolvesSubstituted === true;
        if (resolve || substituted)
          this.resolvers.set(String(p.id), { type, resolve, substituted });
        if (p.provides === true)
          this.providers.set(String(p.id), {
            type,
            trigger: p.trigger === "dynamic" ? "dynamic" : "initial",
          });
        this.registered.fire();
        return Promise.resolve(undefined);
      }
      case "debug.unregister":
        for (const [type, id] of [...this.factories]) if (id === p.id) this.factories.delete(type);
        this.resolvers.delete(String(p.id));
        this.providers.delete(String(p.id));
        return Promise.resolve(undefined);
      case "debug.send": {
        const message = p.message;
        if (message && typeof message === "object")
          this.inline.get(String(p.sessionId))?.emit(JSON.stringify(message));
        return Promise.resolve(undefined);
      }
      default:
        return UNHANDLED;
    }
  }

  /** The factory of `type`, once the worker has registered it (started on demand). */
  private async factory(type: string): Promise<string> {
    await this.deps.worker();
    const known = this.factories.get(type);
    if (known) return known;
    return new Promise<string>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        sub.dispose();
        reject(
          new Error(
            `${this.deps.manifest.displayName} didn't register a debug adapter for "${type}".`,
          ),
        );
      }, FACTORY_WAIT_MS);
      const sub = this.registered.event(() => {
        const id = this.factories.get(type);
        if (!id) return;
        window.clearTimeout(timer);
        sub.dispose();
        resolve(id);
      });
    });
  }

  private async connect(
    type: string,
    configuration: Record<string, unknown>,
    exited: () => void,
    session?: DebugAdapterSessionInfo,
  ): Promise<DebugAdapterConnection> {
    const { manifest, services } = this.deps;
    if (this.disposed) throw new Error(`${manifest.displayName} has stopped.`);
    const factoryId = await this.factory(type);
    const worker = await this.deps.worker();
    // The debugger's own session id (D295): the extension's DebugSession is the one its
    // customRequest, the session events and activeDebugSession name. (Resolvers ran already,
    // every extension's, before the launch: resolution.ts.)
    const sessionId = session?.id || `d${++this.seq}`;
    if (this.inline.has(sessionId)) throw new Error(`Debug session ${sessionId} is running.`);
    const raw = await worker.call("provider", factoryId, {
      sessionId,
      session: {
        id: sessionId,
        type,
        name: session?.name ?? (typeof configuration.name === "string" ? configuration.name : type),
        configuration,
        ...(session?.parentId && { parentSession: session.parentId }),
      },
    });
    if (raw === null || raw === undefined)
      throw new Error(`${manifest.displayName} has no debug adapter for this configuration.`);
    const descriptor = checkDescriptor(raw);
    if (descriptor.kind === "inline") return this.inlineConnection(worker, sessionId, exited);
    if (descriptor.kind === "server") {
      const id = `ext-dap:${manifest.id}:${sessionId}`;
      const messages = new Emitter<string>();
      await debugSocketIpc.dapConnect(id, descriptor.host ?? "127.0.0.1", descriptor.port, (e) => {
        if (e.kind === "message") messages.fire(e.body);
        else exited();
      });
      return {
        transport: {
          send: (body) => void debugSocketIpc.send(id, body).catch(() => {}),
          onMessage: messages.event,
        },
        kill: async () => {
          await debugSocketIpc.close(id).catch(() => {});
          messages.dispose();
        },
      };
    }
    // An executable runs a program: as the extension's own processes, "shell" and trust.
    this.deps.need("shell", "run its debug adapter");
    const root = services.workspace.root.peek();
    if (!root) throw new Error("Open a folder first.");
    await services.trust.require(`${manifest.displayName}'s debug adapter`);
    const process = await startStdioProcess(
      `ext-dap:${manifest.id}:${sessionId}`,
      {
        command: descriptor.command,
        args: descriptor.args ?? [],
        cwd: descriptor.cwd !== undefined ? this.deps.workspacePath(descriptor.cwd) : root,
        ...(descriptor.env && { env: descriptor.env }),
      },
      { exit: exited },
    );
    return { transport: process.transport, kill: () => process.stop() };
  }

  /**
   * VS Code's activation for a debug event: the extension starts when its manifest lists
   * `event` ("onDebug", "onDebugResolve:python"…) and the launch waits until it has activated
   * (its providers registered), at most ACTIVATE_WAIT_MS. A running one is ready already.
   */
  private async activate(event: string): Promise<void> {
    const { manifest } = this.deps;
    if (this.disposed || !manifest.main || this.deps.running?.()) return;
    if (!manifest.activation.includes(event)) return;
    await Promise.race([
      this.deps.worker().then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => window.setTimeout(resolve, ACTIVATE_WAIT_MS)),
    ]);
  }

  /**
   * Its providers' steps of `step` for exactly `type`, in order (VS Code's resolveDebugConfiguration
   * and resolveDebugConfigurationWithSubstitutedVariables, D234, D295): the answer is the
   * configuration to go on with; null / undefined cancels the launch.
   */
  private resolveSteps(step: "resolve" | "substituted", type: string): DebugConfigResolver[] {
    const worker = this.deps.running?.();
    if (!worker || this.disposed) return [];
    return [...this.resolvers]
      .filter(([, r]) => r.type === type && (step === "resolve" ? r.resolve : r.substituted))
      .map(([id]) => async (folder, configuration) => {
        const answer = await worker.call(
          "provider",
          id,
          { op: step === "resolve" ? "resolve" : "resolveSubstituted", configuration, folder },
          undefined,
          0,
        );
        if (
          answer !== null &&
          answer !== undefined &&
          (typeof answer !== "object" || Array.isArray(answer))
        )
          throw new Error(
            `${this.deps.manifest.displayName} answered a configuration that isn't an object.`,
          );
        return answer;
      });
  }

  private inlineConnection(
    worker: ExtensionWorker,
    sessionId: string,
    exited: () => void,
  ): DebugAdapterConnection {
    const messages = new Emitter<string>();
    this.inline.set(sessionId, { emit: (body) => messages.fire(body), exited });
    return {
      transport: {
        send: (body) => {
          let message: unknown;
          try {
            message = JSON.parse(body);
          } catch {
            return;
          }
          worker.notify("provider", "debug.message", { sessionId, message });
        },
        onMessage: messages.event,
      },
      kill: async () => {
        if (!this.inline.delete(sessionId)) return;
        worker.notify("provider", "debug.dispose", { sessionId });
        messages.dispose();
      },
    };
  }

  /**
   * "Add configuration…" (VS Code's provideDebugConfigurations): what the extension's providers of
   * `type` offer. A stopped extension that activates on onDebugInitialConfigurations,
   * onDebugDynamicConfigurations or onDebug is started first; one that fails or is slow adds none.
   */
  private async provideConfigurations(
    type: string,
    folder: string | null,
  ): Promise<{ label: string; description: string; body: Record<string, unknown> }[]> {
    const { manifest } = this.deps;
    if (this.disposed || !manifest.main) return [];
    let worker = this.deps.running?.() ?? null;
    if (!worker) {
      const wakes = manifest.activation.some(
        (a) =>
          a === "onDebug" ||
          a === "onDebugInitialConfigurations" ||
          a === "onDebugDynamicConfigurations" ||
          a === `onDebugDynamicConfigurations:${type}`,
      );
      if (!wakes) return [];
      worker = await this.deps.worker().catch(() => null);
      if (!worker) return [];
      if (!this.providersOf(type).length) await this.registration(PROVIDE_WAIT_MS);
    }
    const out: { label: string; description: string; body: Record<string, unknown> }[] = [];
    for (const [id] of this.providersOf(type)) {
      const raw = await worker
        .call("provider", id, { op: "provide", folder }, undefined, PROVIDE_CALL_MS)
        .catch(() => null);
      out.push(...checkProvidedConfigurations(raw, type, manifest.displayName));
    }
    return out;
  }

  private providersOf(type: string): [string, { type: string }][] {
    return [...this.providers].filter(([, p]) => p.type === type);
  }

  /** Resolves on the next registration, or after `ms`. */
  private registration(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        sub.dispose();
        resolve();
      }, ms);
      const sub = this.registered.event(() => {
        window.clearTimeout(timer);
        sub.dispose();
        resolve();
      });
    });
  }

  /** The worker went away: its inline adapters are gone. */
  workerGone(): void {
    for (const t of this.trackers.values()) t.dispose();
    this.trackers.clear();
    this.factories.clear();
    this.resolvers.clear();
    this.providers.clear();
    for (const [id, s] of [...this.inline]) {
      this.inline.delete(id);
      s.exited();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.workerGone();
    this.registered.dispose();
    this.store.dispose();
  }
}
