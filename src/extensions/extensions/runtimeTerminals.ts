// An extension's terminals and task providers (D233, rpcTerminals.ts on the worker side).
// - Terminals: a pseudoterminal ("terminal" permission) is served through core/ipc/virtualPty.ts
//   and shown as an ordinary terminal tab (the tab's `pseudo` state); a shell it chooses
//   ("shell" and a trusted folder) is a terminal tab with a `shell` profile.
// - Task providers: their tasks join the tasks extension's list (extensionRegistries.ts), checked
//   here: shell and process tasks need "shell" (the runner asks for the folder's trust as for
//   any task), custom ones run in a pseudoterminal ("terminal").
// Everything goes when the extension stops; its pseudoterminals' tabs end with it.
import type { ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { ptyIpc } from "../../core/ipc/process";
import {
  registerVirtualPty,
  type VirtualPtyHandlers,
  type VirtualPtySession,
} from "../../core/ipc/virtualPty";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { effect, untracked } from "../../core/reactive/index";
import { type ContributedTask, withTimeout } from "../../workbench/extensionRegistries";
import type { WorkbenchServices } from "../../workbench/services";
import { typedText } from "../terminal/commandLine";
import type { TerminalInstance } from "../terminal/service";
import { UNHANDLED } from "./runtimeApi";
import { CommandOutputCapture } from "./terminalOutput";
import { checkEnv, checkTask } from "./workbenchChecks";
import type { ExtensionWorker } from "./workerHost";

const MAX_TERMINALS = 20;
const MAX_TASKS = 200;

const MAX_ENV_CHANGES = 100;
/** A variable's name: Windows' include parentheses and dots (ProgramFiles(x86)). */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_().]{0,99}$/;

export interface TerminalsHostDeps {
  manifest: ThirdPartyManifest;
  services: WorkbenchServices;
  need(permission: string, what: string): void;
  granted(permission: string): boolean;
  workspacePath(path: unknown): string;
  worker(): Promise<ExtensionWorker>;
  /** The worker if it runs (link providers never start it). */
  running(): ExtensionWorker | null;
  warn(message: string): void;
}

interface TerminalEntry {
  kind: "pseudoterminal" | "shell";
  tabId: string;
  /** The terminal's id once it has started (a pty id, or a virtual one). */
  readonly instanceId: Promise<number | null>;
  off: Disposable;
  /** Its events and commands' output, when the extension follows it. */
  followed?: FollowedTerminal;
  /** Made with hideFromUser (D388): hidden (no tab) until show(). */
  hidden?: boolean;
}

/** At most this many of the user's terminals are reported to one extension. */
const MAX_OTHER_TERMINALS = 50;

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** VS Code's TerminalExitReason: its process ended, the user closed it. */
const EXIT_PROCESS = 2;
const EXIT_USER = 3;

/**
 * What an extension hears about a terminal it made (rpcTerminals.ts' TerminalEvent): its process
 * id; the tab closing (by the user) or its process ending, once; being the terminal used last;
 * the user typing in it; and, for a shell with shell integration, its folder and each command's
 * start and end. Closing it from its code says nothing (the extension knows).
 */
interface FollowedTerminal extends Disposable {
  /** The running (or last) command's output so far; later output follows as "output" events. */
  read(): string | null;
}

/**
 * The terminal behind a dock tab. `create`: its view is made now if it isn't yet (an extension's
 * own terminal); else only once the user has shown it (a terminal of the user's).
 */
function terminalOf(
  services: WorkbenchServices,
  tabId: string,
  create: boolean,
): Promise<TerminalInstance> | undefined {
  const ref = services.dock.findTab(tabId);
  const tab = ref?.group.tabs[ref.index];
  if (!tab) return undefined;
  const view = create ? services.dock.view(tab) : services.dock.liveView(tabId);
  return (view as { ready?: Promise<TerminalInstance> } | undefined)?.ready;
}

function followTerminal(
  services: WorkbenchServices,
  tabId: string,
  /** Its terminal (none for a pseudoterminal); asked again until there is one. */
  ready: (() => Promise<TerminalInstance> | undefined) | undefined,
  send: (event: Record<string, unknown>) => void,
): FollowedTerminal {
  const { dock } = services;
  const sub = new DisposableStore();
  let closed = false;
  let exitCode: number | undefined;
  // What its commands print (VS Code's TerminalShellExecution.read()).
  const capture = new CommandOutputCapture((text) => send({ kind: "output", text }));
  const close = (reason: number) => {
    if (closed) return;
    closed = true;
    send({ kind: "closed", reason, ...(exitCode !== undefined && { code: exitCode }) });
  };
  let active = false;
  let attached = false;
  const attach = () => {
    const pending = ready?.();
    if (!pending) return;
    attached = true;
    void pending.then(
      (terminal) => started(terminal),
      () => {},
    );
  };
  sub.add(
    effect(() => {
      dock.root.value;
      dock.focusedGroupId.value;
      if (closed) return undefined;
      if (!dock.findTab(tabId)) {
        close(EXIT_USER);
        return undefined;
      }
      // The terminal used last (VS Code's activeTerminal: the panel's current one).
      const now = dock.recentTab((t) => t.viewType === "terminal")?.id === tabId;
      if (now !== active) {
        active = now;
        send({ kind: "active", active });
      }
      // A tab opened in the background has its terminal once it's first shown.
      if (!attached) untracked(attach);
      return undefined;
    }),
  );
  const started = (terminal: TerminalInstance) => {
    if (closed || sub.isDisposed) return;
    send({ kind: "started", pid: terminal.info.pid });
    sub.add(terminal.onDidWrite((text) => capture.write(text)));
    let integrated = false;
    sub.add(
      effect(() => {
        const cwd = terminal.cwd.value;
        if (terminal.promptReady.value && !integrated) {
          integrated = true;
          send({ kind: "shellIntegration", cwd });
        } else if (integrated) send({ kind: "cwd", cwd });
        return undefined;
      }),
    );
    sub.add(
      terminal.onDidStartCommand(() => {
        capture.started();
        send({
          kind: "commandStart",
          commandLine: terminal.renderer.lastCommand()?.command ?? "",
          cwd: terminal.cwd.peek(),
        });
      }),
    );
    sub.add(
      terminal.onDidFinishCommand((code) => {
        capture.ended();
        send({
          kind: "commandEnd",
          commandLine: terminal.renderer.lastCommand()?.command ?? "",
          ...(code !== undefined && { exitCode: code }),
        });
      }),
    );
    let interacted = false;
    sub.add(
      terminal.renderer.onInput(() => {
        if (interacted) return;
        interacted = true;
        send({ kind: "interacted" });
      }),
    );
    sub.add(
      effect(() => {
        const code = terminal.exitCode.value;
        if (code === null) return undefined;
        exitCode = code;
        close(EXIT_PROCESS);
        return undefined;
      }),
    );
  };
  return { read: () => capture.read(), dispose: () => sub.dispose() };
}

export class ExtensionTerminalsHost implements Disposable {
  private readonly store = new DisposableStore();
  private readonly terminals = new Map<string, TerminalEntry>();
  /** Open pseudoterminals (theirs), by our pty id: where their output goes. */
  private readonly ptys = new Map<string, VirtualPtyHandlers>();
  private readonly taskProviders = new Map<string, Disposable>();
  /** Custom executions' pseudoterminals, registered once per task key. */
  private readonly customKeys = new Map<string, string>();
  private seq = 0;
  private disposed = false;
  /** Bumped when the worker goes: a terminal its code asked for before then isn't made after. */
  private workerGeneration = 0;

  constructor(private readonly deps: TerminalsHostDeps) {}

  private get owner(): string {
    return this.deps.manifest.id;
  }

  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    switch (method) {
      case "terminals.create":
        return this.create(p);
      case "terminals.write": {
        const out = this.ptys.get(String(p.ptyId));
        out?.onData(new TextEncoder().encode(str(p.text, 1_000_000)));
        return Promise.resolve(undefined);
      }
      case "terminals.exit": {
        const ptyId = String(p.ptyId);
        const out = this.ptys.get(ptyId);
        this.ptys.delete(ptyId);
        out?.onExit(typeof p.code === "number" ? Math.trunc(p.code) : 0);
        return Promise.resolve(undefined);
      }
      case "terminals.sendText":
        return this.sendText(p);
      case "terminals.show":
        return this.show(p);
      case "terminals.dispose":
        this.close(String(p.id));
        return Promise.resolve(undefined);
      case "terminals.watchOthers":
        return Promise.resolve(this.watchOthers());
      case "terminals.read": {
        // A command's output (VS Code's TerminalShellExecution.read()): what it printed so far;
        // the rest follows as "output" events until it ends.
        this.deps.need("terminal", "read terminals' output");
        const entry = this.terminals.get(String(p.id)) ?? this.others.get(String(p.id));
        return Promise.resolve(entry?.followed?.read() ?? null);
      }
      case "terminals.setEnvironment":
        return Promise.resolve(this.setEnvironment(p));
      case "terminals.registerProfileProvider": {
        // Its code answers for a profile its manifest declares (listed already, `contribute`).
        const id = String(p.id ?? "");
        if (!(this.deps.manifest.contributes.terminalProfiles ?? []).some((t) => t.id === id))
          throw new Error(
            `Terminal profile "${id}" isn't declared in the extension's manifest (contributes.terminal.profiles).`,
          );
        this.profileKeys.set(id, String(p.key ?? ""));
        return Promise.resolve(undefined);
      }
      case "terminals.unregisterProfileProvider":
        this.profileKeys.delete(String(p.id ?? ""));
        return Promise.resolve(undefined);
      case "terminals.registerLinkProvider":
        return Promise.resolve(this.registerLinkProvider(p));
      case "terminals.unregisterLinkProvider":
        this.linkProviders.get(String(p.id))?.dispose();
        this.linkProviders.delete(String(p.id));
        return Promise.resolve(undefined);
      case "tasks.register":
        return Promise.resolve(this.registerTaskProvider(p));
      case "tasks.unregister":
        this.taskProviders.get(String(p.id))?.dispose();
        this.taskProviders.delete(String(p.id));
        return Promise.resolve(undefined);
      default:
        return UNHANDLED;
    }
  }

  // ---- Terminals ---------------------------------------------------------------------------

  /** Opens a session of the extension's pseudoterminal (`source`: its terminal or task). */
  private async openPty(
    source: { terminal: string } | { task: string },
    size: { cols: number; rows: number },
    handlers: VirtualPtyHandlers,
  ): Promise<VirtualPtySession> {
    if (this.disposed) throw new Error(`${this.deps.manifest.displayName} has stopped.`);
    const ptyId = `x${++this.seq}`;
    this.ptys.set(ptyId, handlers);
    let worker: ExtensionWorker;
    try {
      // Its code may not start (stopped, crashed): the session isn't kept then either.
      worker = await this.deps.worker();
      await worker.call("provider", "pty.open", {
        ptyId,
        ...source,
        columns: size.cols,
        rows: size.rows,
      });
    } catch (err) {
      this.ptys.delete(ptyId);
      throw err;
    }
    // The terminal this session is (a later worker may reuse its id for another one).
    const owner = "terminal" in source ? this.terminals.get(source.terminal) : undefined;
    return {
      input: (data) => worker.notify("provider", "pty.input", { ptyId, data }),
      resize: (cols, rows) =>
        worker.notify("provider", "pty.resize", { ptyId, columns: cols, rows }),
      close: () => {
        // Its tab closed: the extension's terminal is gone too (a task's pty has none).
        if ("terminal" in source && owner && this.terminals.get(source.terminal) === owner) {
          this.terminals.delete(source.terminal);
          owner.off.dispose();
        }
        if (!this.ptys.delete(ptyId)) return;
        worker.notify("provider", "pty.close", { ptyId });
      },
    };
  }

  private async create(p: Record<string, unknown>): Promise<void> {
    const { services, manifest } = this.deps;
    const id = String(p.id ?? "");
    if (!/^t\d{1,9}$/.test(id) || this.terminals.has(id)) throw new Error("Bad terminal id.");
    if (this.terminals.size >= MAX_TERMINALS)
      throw new Error(`An extension can have at most ${MAX_TERMINALS} terminals.`);
    const name = str(p.name, 100) || manifest.displayName;
    const pseudo = p.pseudo === true;
    // VS Code's hideFromUser (D388): no tab, and like isTransient never saved with the folder
    // (the Python extension makes several such terminals each session: shell-integration probes,
    // environment scripts; shown as tabs and restored, they piled up as "Python" tabs).
    const hidden = p.hidden === true;
    const transient = hidden || p.transient === true;
    const store = new DisposableStore();
    let state: Record<string, unknown>;
    if (pseudo) {
      this.deps.need("terminal", "make terminals");
      const key = `ext:${this.owner}:${id}:${++this.seq}`;
      store.add(
        registerVirtualPty(
          key,
          (size, handlers) => this.openPty({ terminal: id }, size, handlers),
          name,
        ),
      );
      state = { name, pseudo: key, ...(transient && { transient: true }) };
    } else {
      this.deps.need("shell", "start shells");
      const root = services.workspace.root.peek();
      if (!root) throw new Error("Open a folder first: an extension's terminals start in it.");
      const generation = this.workerGeneration;
      await services.trust.require(`${manifest.displayName}'s terminal`);
      if (this.disposed || generation !== this.workerGeneration)
        throw new Error(`${manifest.displayName} has stopped.`);
      const shellPath = str(p.shellPath, 1000).trim();
      const shellArgs = Array.isArray(p.shellArgs)
        ? p.shellArgs.filter((a): a is string => typeof a === "string").slice(0, 100)
        : undefined;
      const env = checkEnv(p.env);
      state = {
        name,
        cwd: p.cwd !== undefined ? this.deps.workspacePath(p.cwd) : root,
        ...(env && { env }),
        ...(shellPath && { shell: { path: shellPath, ...(shellArgs && { args: shellArgs }) } }),
        ...(transient && { transient: true }),
      };
    }
    // VS Code's createTerminal doesn't show the terminal: `show()` does (`background`).
    const background = p.background === true || hidden;
    const tabId = services.dock.openView(
      "terminal",
      state as never,
      "bottom",
      p.focus === true && !background,
      background ? { background: true } : {},
    );
    const ready = terminalOf(services, tabId, true);
    const instanceId = (ready ?? Promise.resolve(null)).then(
      (t) => t?.id ?? null,
      () => null,
    );
    const followed =
      p.events === true
        ? store.add(
            followTerminal(
              services,
              tabId,
              pseudo ? undefined : () => terminalOf(services, tabId, true),
              (event) => this.deps.running()?.notify("provider", `terminal.${id}`, event),
            ),
          )
        : undefined;
    store.add(
      services.extensionFeatures.terminals.add({
        owner: this.owner,
        id,
        name,
        kind: pseudo ? "pseudoterminal" : "shell",
      }),
    );
    this.terminals.set(id, {
      kind: pseudo ? "pseudoterminal" : "shell",
      tabId,
      instanceId,
      off: store,
      ...(followed && { followed }),
      ...(hidden && { hidden }),
    });
    // Hidden once its shell runs (its tab goes; the terminal keeps running, by id).
    if (hidden)
      void instanceId.then((n) => {
        if (n === null || !this.terminals.has(id)) return;
        void services.dispatcher.execute("terminal.hide", { id: n }).catch(() => {});
      });
  }

  private entry(id: unknown): TerminalEntry {
    const entry = this.terminals.get(String(id)) ?? this.others.get(String(id));
    if (!entry) throw new Error("That terminal was disposed.");
    return entry;
  }

  // ---- Terminals the user (or another extension) opened -------------------------------------

  /** The other terminals, by the id the extension knows them by ("u1"…). */
  private readonly others = new Map<string, TerminalEntry>();
  private watchingOthers = false;

  /**
   * VS Code lists every terminal to every extension (window.terminals, onDidOpenTerminal): the
   * terminal tabs it didn't make are reported as they open ("opened" on `terminals.others`), and
   * followed like its own (`terminal.<id>`: pid, shell integration, commands, closing). Needs
   * "terminal" (reading terminals); without it, nothing is reported.
   */
  private watchOthers(): { id: string; name: string }[] {
    if (!this.deps.granted("terminal")) return [];
    const { services } = this.deps;
    const listed: { id: string; name: string }[] = [];
    const scan = (announce: boolean) => {
      const own = new Set([...this.terminals.values()].map((t) => t.tabId));
      const known = new Set([...this.others.values()].map((t) => t.tabId));
      const descriptor = services.dock.views.get("terminal");
      for (const tab of services.dock.tabs("terminal")) {
        if (own.has(tab.id) || known.has(tab.id)) continue;
        if (this.others.size >= MAX_OTHER_TERMINALS) return;
        const id = `u${++this.seq}`;
        const name = (descriptor?.title(tab.viewState) ?? "").slice(0, 100) || "Terminal";
        const tabId = tab.id;
        const followed = followTerminal(
          services,
          tabId,
          () => terminalOf(services, tabId, false),
          (event) => {
            this.deps.running()?.notify("provider", `terminal.${id}`, event);
            // Closed: it's forgotten (the extension heard it).
            if (event.kind === "closed") queueMicrotask(() => this.forgetOther(id));
          },
        );
        this.others.set(id, {
          kind: "shell",
          tabId,
          // Asked when used: typing into a tab never shown starts its terminal then.
          get instanceId() {
            return (terminalOf(services, tabId, true) ?? Promise.resolve(null)).then(
              (t) => t?.id ?? null,
              () => null,
            );
          },
          off: followed,
          followed,
        });
        if (announce) this.deps.running()?.notify("provider", "terminals.others", { id, name });
        else listed.push({ id, name });
      }
    };
    if (!this.watchingOthers) {
      this.watchingOthers = true;
      scan(false);
      // A terminal opened later: reported once its tab is there.
      this.store.add(
        effect(() => {
          services.dock.root.value;
          untracked(() => scan(true));
          return undefined;
        }),
      );
      return listed;
    }
    // Asked again (its code restarted): what's open now.
    for (const [id, entry] of this.others) {
      const tab = services.dock.findTab(entry.tabId);
      const ref = tab?.group.tabs[tab.index];
      const name = ref ? (services.dock.views.get("terminal")?.title(ref.viewState) ?? "") : "";
      listed.push({ id, name: name.slice(0, 100) || "Terminal" });
    }
    return listed;
  }

  private forgetOther(id: string): void {
    const entry = this.others.get(id);
    if (!entry) return;
    this.others.delete(id);
    entry.off.dispose();
  }

  private async sendText(p: Record<string, unknown>): Promise<void> {
    const entry = this.entry(p.id);
    // Typed into a shell runs commands; into its own pseudoterminal, it's its input.
    if (entry.kind === "shell") this.deps.need("shell", "type into terminals");
    const id = await entry.instanceId;
    if (id === null) throw new Error("The terminal didn't start.");
    // Line breaks as Enter, as VS Code types them (D261).
    await ptyIpc.write(id, typedText(str(p.text, 100_000), p.addNewLine !== false));
  }

  private async show(p: Record<string, unknown>): Promise<void> {
    const { dock, dispatcher } = this.deps.services;
    const entry = this.entry(p.id);
    // A hidden one (hideFromUser, D388) gets its tab back.
    if (entry.hidden && !dock.findTab(entry.tabId)) {
      const n = await entry.instanceId;
      if (n === null) throw new Error("The terminal didn't start.");
      const result = (await dispatcher.execute("terminal.showHidden", { id: n })) as {
        shown?: { tabId: string | null }[];
      };
      entry.hidden = false;
      const tabId = result?.shown?.[0]?.tabId;
      if (tabId) {
        entry.tabId = tabId;
        dock.activateTab(tabId, p.focus === true);
      }
      return;
    }
    const group = dock.findTab(entry.tabId)?.group;
    if (!group) throw new Error("The terminal's tab was closed.");
    if (group.hidden) dock.setGroupsHidden([group.id], false);
    dock.activateTab(entry.tabId, p.focus === true);
  }

  private close(id: string): void {
    const other = this.others.get(id);
    if (other) {
      // One of the user's: its code closed it (VS Code's Terminal.dispose()), as closing its tab.
      this.forgetOther(id);
      if (this.deps.services.dock.findTab(other.tabId))
        void this.deps.services.dock.closeTab(other.tabId).catch(() => {});
      return;
    }
    const entry = this.terminals.get(id);
    if (!entry) return;
    this.terminals.delete(id);
    entry.off.dispose();
    void entry.instanceId.then((n) => {
      if (n !== null) void ptyIpc.kill(n).catch(() => {});
    });
    if (this.deps.services.dock.findTab(entry.tabId))
      void this.deps.services.dock.closeTab(entry.tabId, true).catch(() => {});
    // A hidden one (D388) has no tab: ending it by id takes it off the hidden list too.
    else if (entry.hidden)
      void entry.instanceId.then((n) => {
        if (n !== null)
          void this.deps.services.dispatcher.execute("terminal.kill", { id: n }).catch(() => {});
      });
  }

  // ---- Task providers -----------------------------------------------------------------------

  private registerTaskProvider(p: Record<string, unknown>): void {
    const { manifest, services } = this.deps;
    const id = String(p.id ?? "");
    const type = String(p.type ?? "");
    if (!manifest.contributes.taskDefinitions.some((d) => d.type === type))
      throw new Error(
        `Task type "${type}" isn't declared in the extension's manifest (contributes.taskDefinitions).`,
      );
    if ([...this.taskProviders.keys()].length >= 10)
      throw new Error("An extension can have at most 10 task providers.");
    for (const entry of services.extensionFeatures.tasks.all.peek())
      if (entry.type === type && entry.owner !== this.owner)
        throw new Error(`Another extension provides "${type}" tasks.`);
    this.taskProviders.get(id)?.dispose();
    const check = (raw: unknown): ContributedTask | null => {
      const task = checkTask(raw, type, {
        source: manifest.displayName,
        owner: this.owner,
        granted: (permission) => this.deps.granted(permission),
        cwd: (path) => this.deps.workspacePath(path),
        custom: (key) => this.customKey(key),
      });
      if (typeof task === "string") {
        this.deps.warn(`Task skipped: ${task}.`);
        return null;
      }
      return task;
    };
    const off = services.extensionFeatures.tasks.add({
      owner: this.owner,
      type,
      provide: async () => {
        const list = await (await this.deps.worker()).call<unknown>("provider", id, {});
        return (Array.isArray(list) ? list : [])
          .slice(0, MAX_TASKS)
          .map(check)
          .filter((t): t is ContributedTask => t !== null);
      },
      ...(p.resolve === true && {
        resolve: async (definition: Record<string, unknown>) =>
          check(
            await (await this.deps.worker()).call<unknown>("provider", `${id}.resolve`, {
              definition,
            }),
          ),
      }),
    });
    this.taskProviders.set(id, off);
  }

  /** The virtual pty key of custom task `key` (registered once; the worker finds the latest). */
  private customKey(key: string): string {
    const known = this.customKeys.get(key);
    if (known) return known;
    const virtual = `ext:${this.owner}:task:${key}`;
    this.customKeys.set(key, virtual);
    this.store.add(
      registerVirtualPty(virtual, (size, handlers) => this.openPty({ task: key }, size, handlers)),
    );
    return virtual;
  }

  private readonly linkProviders = new Map<string, Disposable>();
  /** Profiles whose provider its code registered: their call keys. */
  private readonly profileKeys = new Map<string, string>();

  /**
   * Its manifest's terminal profiles in the profile menu (D264), there before its code runs:
   * picking one starts its code (`onTerminalProfile:<id>`), waits for the provider, asks it.
   */
  contributeProfiles(): void {
    const { manifest, services } = this.deps;
    for (const profile of manifest.contributes.terminalProfiles ?? [])
      this.store.add(
        services.extensionFeatures.terminalProfiles.add({
          owner: this.owner,
          id: profile.id,
          title: profile.title,
          ...(profile.icon && { icon: profile.icon }),
          open: async () => {
            this.deps.need("terminal", "open its terminal profile");
            const worker = await this.deps.worker();
            for (let i = 0; i < 100 && !this.profileKeys.has(profile.id); i++)
              await new Promise((r) => setTimeout(r, 50));
            const key = this.profileKeys.get(profile.id);
            if (!key)
              throw new Error(
                `${manifest.displayName} didn't provide its "${profile.title}" profile.`,
              );
            await worker.call("provider", key, {});
          },
        }),
      );
  }

  /**
   * Links in terminal lines (VS Code's TerminalLinkProvider, D264): the line the user points at
   * goes to the extension ("terminal", as reading a terminal does), which answers within half a
   * second; a click runs its handler.
   */
  private registerLinkProvider(p: Record<string, unknown>): undefined {
    this.deps.need("terminal", "find links in terminals");
    const id = String(p.id ?? "");
    if (this.linkProviders.size >= 5 && !this.linkProviders.has(id))
      throw new Error("An extension can have at most 5 terminal link providers.");
    this.linkProviders.get(id)?.dispose();
    const off = this.deps.services.extensionFeatures.terminalLinks.add({
      owner: this.owner,
      provide: async (line, terminal) => {
        const worker = this.deps.running();
        if (!worker) return [];
        const answer = await withTimeout(
          worker.call<unknown>("provider", id, { line: line.slice(0, 2000), terminal }),
          500,
          "A terminal link provider",
        ).catch(() => []);
        return (Array.isArray(answer) ? answer : []).slice(0, 50).flatMap((raw) => {
          const x = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
          const start = Number(x.startIndex);
          const length = Number(x.length);
          if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length < 1)
            return [];
          if (start + length > line.length) return [];
          const key = String(x.key ?? "");
          return [
            {
              startIndex: start,
              length,
              ...(typeof x.tooltip === "string" && { tooltip: x.tooltip.slice(0, 200) }),
              activate: () =>
                void this.deps
                  .running()
                  ?.call("provider", `${id}.handle`, { key })
                  .catch(() => {}),
            },
          ];
        });
      },
    });
    this.linkProviders.set(id, off);
    return undefined;
  }

  /**
   * New terminals' environment (VS Code's EnvironmentVariableCollection, D264). It changes what
   * every program started there does (NODE_OPTIONS, PATH): "shell", as starting programs is.
   */
  private setEnvironment(p: Record<string, unknown>): undefined {
    this.deps.need("shell", "change new terminals' environment");
    const raw = Array.isArray(p.changes) ? p.changes : [];
    if (raw.length > MAX_ENV_CHANGES)
      throw new Error(`At most ${MAX_ENV_CHANGES} terminal environment changes.`);
    const changes = raw.map((c) => {
      const x = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
      const variable = typeof x.variable === "string" ? x.variable : "";
      if (!ENV_NAME.test(variable)) throw new Error(`Not a variable name: ${String(x.variable)}`);
      const type = x.type === "append" || x.type === "prepend" ? x.type : "replace";
      return { variable, value: str(x.value, 32_767), type } as const;
    });
    this.deps.services.extensionFeatures.setTerminalEnv(this.owner, changes);
    return undefined;
  }

  /** The worker went away: its pseudoterminals end (their tabs say so). */
  workerGone(): void {
    // What its code set for new terminals goes with it (a port its server no longer answers).
    this.deps.services.extensionFeatures.setTerminalEnv(this.owner, []);
    this.profileKeys.clear();
    for (const off of this.linkProviders.values()) off.dispose();
    this.linkProviders.clear();
    for (const [ptyId, out] of [...this.ptys]) {
      this.ptys.delete(ptyId);
      out.onExit(1);
    }
    // A new worker counts its terminal ids from t1 again: its terminals aren't these (a shell
    // keeps running in its tab, a pseudoterminal's tab says it ended), and these ids are free.
    for (const entry of this.terminals.values()) entry.off.dispose();
    this.terminals.clear();
    this.workerGeneration++;
  }

  dispose(): void {
    this.disposed = true;
    // Its pseudoterminals' tabs close with it (before workerGone() forgets them).
    for (const [id, entry] of [...this.terminals])
      if (entry.kind === "pseudoterminal") this.close(id);
    this.workerGone();
    for (const id of [...this.others.keys()]) this.forgetOther(id);
    for (const off of this.taskProviders.values()) off.dispose();
    this.taskProviders.clear();
    for (const off of this.linkProviders.values()) off.dispose();
    this.linkProviders.clear();
    this.store.dispose();
  }
}
