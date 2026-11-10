// The worker side of `ide.terminals` and `ide.tasks` (D233): terminals an extension makes (a
// shell it chooses, or a pseudoterminal it serves: output it writes, the user's input, the size,
// closing), and task providers whose tasks join the tasks extension's list (shell, process or
// custom executions, a custom one served by a pseudoterminal). The host calls back through the
// existing "provider" call kind, so the RPC protocol is unchanged. DOM-free, unit-tested.
import type { Disposable } from "./rpc";

export type Request = <T>(method: string, params?: unknown) => Promise<T>;
/** Registers a host → worker callback under `key` ("provider" calls); returns the removal. */
export type OnCall = (key: string, handler: (args: never) => unknown) => () => void;

export interface TerminalDimensions {
  columns: number;
  rows: number;
}

/** What a pseudoterminal writes with: text (ANSI sequences allowed; "\r\n" for a new line). */
export interface PseudoterminalIo {
  write(text: string): void;
  /** Ends the terminal (VS Code's onDidClose); `code` is its exit code. */
  exit(code?: number): void;
}

/** VS Code's Pseudoterminal, as functions. */
export interface Pseudoterminal {
  /** The terminal is shown: start writing. */
  open(dimensions: TerminalDimensions, io: PseudoterminalIo): void | Promise<void>;
  /** What the user typed (keys as the terminal sends them: "\r" for Enter). */
  input?(data: string): void;
  resize?(dimensions: TerminalDimensions): void;
  /** The user (or the IDE) closed it. */
  close?(): void;
}

export interface TerminalOptions {
  /** The tab's title. */
  name?: string;
  /** A pseudoterminal ("terminal" permission); without it, a shell ("shell" and a trusted folder). */
  pty?: Pseudoterminal;
  /** The shell to start (default: the user's default profile). */
  shellPath?: string;
  shellArgs?: string[];
  /** Inside the open folder. */
  cwd?: string;
  env?: Record<string, string>;
  /** Take the focus (default false); the tab is always shown. */
  focus?: boolean;
  /**
   * Open the tab behind the panel's active one, not shown until `show()` (VS Code's
   * createTerminal); the shell starts anyway.
   */
  background?: boolean;
  /** No tab at all (VS Code's hideFromUser, D388): hidden until `show()`, never saved. */
  hidden?: boolean;
  /** Not saved with the folder (VS Code's isTransient, D388). */
  transient?: boolean;
  /** What happens to it (TerminalEvent), from the moment it's created. */
  onEvent?(event: TerminalEvent): void;
}

/**
 * What the host reports about a terminal an extension made ("provider" calls on
 * `terminal.<id>`): its process id, closing (TerminalExitReason: 2 its process ended, 3 the
 * user closed it), being the active terminal, the user typing in it, and shell integration (its
 * folder, and each command's start and end).
 */
export type TerminalEvent =
  | { kind: "started"; pid: number | null }
  | { kind: "closed"; code?: number; reason: number }
  | { kind: "active"; active: boolean }
  | { kind: "interacted" }
  | { kind: "shellIntegration"; cwd: string }
  | { kind: "cwd"; cwd: string }
  | { kind: "commandStart"; commandLine: string; cwd: string }
  | { kind: "commandEnd"; commandLine: string; exitCode?: number }
  /** The running command's output, once the extension asked to read it (`readOutput`). */
  | { kind: "output"; text: string };

/** A host event as a typed one (null: not one). */
export function toTerminalEvent(raw: unknown): TerminalEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : undefined);
  switch (e.kind) {
    case "started":
      return { kind: "started", pid: int(e.pid) ?? null };
    case "closed": {
      const code = int(e.code);
      return { kind: "closed", reason: int(e.reason) ?? 0, ...(code !== undefined && { code }) };
    }
    case "active":
      return { kind: "active", active: e.active === true };
    case "interacted":
      return { kind: "interacted" };
    case "shellIntegration":
    case "cwd":
      return { kind: e.kind, cwd: text(e.cwd) };
    case "commandStart":
      return { kind: "commandStart", commandLine: text(e.commandLine), cwd: text(e.cwd) };
    case "output":
      return { kind: "output", text: text(e.text) };
    case "commandEnd": {
      const exitCode = int(e.exitCode);
      return {
        kind: "commandEnd",
        commandLine: text(e.commandLine),
        ...(exitCode !== undefined && { exitCode }),
      };
    }
    default:
      return null;
  }
}

export interface ExtensionTerminal {
  readonly id: string;
  readonly name: string;
  /** Types `text` into a shell terminal (with Enter unless `addNewLine` is false). */
  sendText(text: string, addNewLine?: boolean): Promise<void>;
  /** Writes to a pseudoterminal's screen (kept until it has opened). */
  write(text: string): void;
  show(focus?: boolean): Promise<void>;
  /** Closes it. */
  dispose(): void;
}

/**
 * A change an extension makes to new terminals' environment (VS Code's
 * EnvironmentVariableCollection, D264): `value` replaces the variable, or goes after or before
 * its value.
 */
export interface TerminalEnvChange {
  variable: string;
  value: string;
  type: "replace" | "append" | "prepend";
}

/** A link an extension finds in a terminal line (VS Code's TerminalLink, D264). */
export interface TerminalLink {
  /** Where it starts in the line (0-based) and how long it is. */
  startIndex: number;
  length: number;
  tooltip?: string;
}

/** VS Code's TerminalLinkProvider: links in a line the user points at, and what a click does. */
export interface TerminalLinkProvider<L extends TerminalLink = TerminalLink> {
  provideTerminalLinks(context: { line: string; terminal: { name: string } }): L[] | Promise<L[]>;
  handleTerminalLink(link: L): unknown;
}

/** A terminal the extension didn't make (the user's, another extension's). */
export interface OtherTerminal {
  id: string;
  name: string;
}

export interface TerminalsApi {
  create(options: TerminalOptions): Promise<ExtensionTerminal>;
  /**
   * The terminals it didn't make (VS Code lists them all: window.terminals, onDidOpenTerminal),
   * those open now and, through `listener`, those opened later. Needs "terminal".
   */
  watchOthers(listener: (terminal: OtherTerminal) => void): Promise<OtherTerminal[]>;
  /** One of those: its events (as `create`'s onEvent) and what it can do. */
  attach(terminal: OtherTerminal, onEvent: (event: TerminalEvent) => void): ExtensionTerminal;
  /**
   * The running command's output so far in terminal `id` (VS Code's TerminalShellExecution.read());
   * the rest comes as "output" events until it ends. Null: nothing to read.
   */
  readOutput(id: string): Promise<string | null>;
  /** Links in terminal lines ("terminal": the line's text goes to the extension, D264). */
  registerLinkProvider(provider: TerminalLinkProvider): Disposable;
  /**
   * A terminal profile its manifest declares (D264): when the user picks it, `open` makes the
   * terminal (with `create`, or VS Code's provider's options).
   */
  registerProfileProvider(id: string, provider: { open(): unknown }): Disposable;
  /** Sets all of the extension's changes to new terminals' environment ([] clears them). */
  setEnvironment(changes: readonly TerminalEnvChange[]): Promise<void>;
}

export type TaskExecution =
  | {
      kind: "shell";
      commandLine: string;
      cwd?: string;
      env?: Record<string, string>;
      /** A shell other than the default (VS Code's `options.executable` / `shellArgs`, D261). */
      shell?: { executable: string; args?: string[] };
    }
  | {
      kind: "process";
      process: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
    }
  /** VS Code's CustomExecution: `start` returns the pseudoterminal the task runs in. */
  | {
      kind: "custom";
      start(definition: Record<string, unknown>): Pseudoterminal | Promise<Pseudoterminal>;
    };

/** A task a provider offers (VS Code's Task). */
export interface ProvidedTask {
  /** Listed as "<type>: <name>". */
  name: string;
  /** Its tasks.json shape; `type` is the provider's. */
  definition?: Record<string, unknown>;
  detail?: string;
  group?: "build" | "test" | { kind: "build" | "test"; isDefault?: boolean };
  isBackground?: boolean;
  /** "$tsc", a matcher object, or a list (tasks.json's `problemMatcher`). */
  problemMatchers?: unknown;
  presentation?: {
    reveal?: "always" | "silent" | "never";
    focus?: boolean;
    panel?: "shared" | "dedicated" | "new";
    clear?: boolean;
    close?: boolean;
  };
  execution: TaskExecution;
}

type Answer<T> = T | null | undefined | Promise<T | null | undefined>;

export interface TaskProvider {
  provideTasks(): Answer<ProvidedTask[]>;
  /** A tasks.json entry of the provider's type (VS Code's resolveTask); nothing drops it. */
  resolveTask?(definition: Record<string, unknown>): Answer<ProvidedTask>;
}

export interface TasksApi {
  /** `type` must be in the manifest's `taskDefinitions`. */
  registerTaskProvider(type: string, provider: TaskProvider): Disposable;
}

/** A provided task as it crosses to the host (a custom execution by its key). */
export interface TaskWire extends Omit<ProvidedTask, "execution"> {
  execution: Exclude<TaskExecution, { kind: "custom" }> | { kind: "custom"; key: string };
}

/** A pseudoterminal serving one tab, by the host's id for it. */
interface OpenPty {
  pty: Pseudoterminal;
  ended: boolean;
}

export function createTerminalApis(
  request: Request,
  on: OnCall,
): { terminals: TerminalsApi; tasks: TasksApi } {
  /** Pseudoterminals of ide.terminals.create, by terminal id, until they open. */
  const created = new Map<string, { pty: Pseudoterminal; early: string[]; ptyId?: string }>();
  /** Open pseudoterminals, by the host's pty id. */
  const open = new Map<string, OpenPty>();
  /** Custom executions, by "<provider id>/<task name>" (the latest list's). */
  const customs = new Map<string, TaskExecution & { kind: "custom" }>();
  const definitions = new Map<string, Record<string, unknown>>();
  let seq = 0;

  const ioFor = (ptyId: string): PseudoterminalIo => ({
    write: (text) => {
      if (open.get(ptyId)?.ended !== false) return;
      void request("terminals.write", { ptyId, text: String(text) }).catch(() => {});
    },
    exit: (code) => {
      const entry = open.get(ptyId);
      if (!entry || entry.ended) return;
      entry.ended = true;
      open.delete(ptyId);
      void request("terminals.exit", {
        ptyId,
        code: typeof code === "number" && Number.isFinite(code) ? Math.trunc(code) : 0,
      }).catch(() => {});
    },
  });

  const dims = (args: { columns?: unknown; rows?: unknown }): TerminalDimensions => ({
    columns: typeof args.columns === "number" ? args.columns : 80,
    rows: typeof args.rows === "number" ? args.rows : 24,
  });

  on(
    "pty.open",
    async (args: {
      ptyId?: unknown;
      terminal?: unknown;
      task?: unknown;
      columns?: unknown;
      rows?: unknown;
    }) => {
      const ptyId = String(args?.ptyId ?? "");
      let pty: Pseudoterminal | undefined;
      let early: string[] = [];
      if (typeof args?.terminal === "string") {
        const entry = created.get(args.terminal);
        if (!entry) throw new Error("That terminal was disposed.");
        if (entry.ptyId) throw new Error("A pseudoterminal is shown in one terminal only.");
        entry.ptyId = ptyId;
        pty = entry.pty;
        early = entry.early.splice(0);
      } else if (typeof args?.task === "string") {
        const custom = customs.get(args.task);
        if (!custom) throw new Error("The task provider no longer offers that task.");
        pty = await custom.start({ ...(definitions.get(args.task) ?? {}) });
      }
      if (!pty || typeof pty.open !== "function")
        throw new Error("A pseudoterminal needs an open() function.");
      open.set(ptyId, { pty, ended: false });
      const io = ioFor(ptyId);
      await pty.open(dims(args), io);
      for (const text of early) io.write(text);
      return null;
    },
  );
  on("pty.input", (args: { ptyId?: unknown; data?: unknown }) => {
    const entry = open.get(String(args?.ptyId));
    if (entry && !entry.ended) entry.pty.input?.(String(args?.data ?? ""));
    return null;
  });
  on("pty.resize", (args: { ptyId?: unknown; columns?: unknown; rows?: unknown }) => {
    const entry = open.get(String(args?.ptyId));
    if (entry && !entry.ended) entry.pty.resize?.(dims(args));
    return null;
  });
  on("pty.close", (args: { ptyId?: unknown }) => {
    const ptyId = String(args?.ptyId);
    const entry = open.get(ptyId);
    open.delete(ptyId);
    for (const [id, c] of created) if (c.ptyId === ptyId) created.delete(id);
    if (entry && !entry.ended) {
      entry.ended = true;
      entry.pty.close?.();
    }
    return null;
  });

  let linkSeq = 0;
  const terminals: TerminalsApi = {
    registerProfileProvider(profileId, provider) {
      const key = `profile:${String(profileId)}`;
      const off = on(key, async () => {
        await provider.open();
        return null;
      });
      void request("terminals.registerProfileProvider", { id: String(profileId), key }).catch(
        (err: unknown) => {
          off();
          console.error(err instanceof Error ? err.message : String(err));
        },
      );
      return {
        dispose: () => {
          off();
          void request("terminals.unregisterProfileProvider", { id: String(profileId) }).catch(
            () => {},
          );
        },
      };
    },
    registerLinkProvider(provider) {
      const id = `links${++linkSeq}`;
      // The links of the lines asked about lately, by key, for a click on one of them.
      const given = new Map<string, TerminalLink>();
      let seqOfLink = 0;
      const offProvide = on(id, async (args: { line?: unknown; terminal?: unknown }) => {
        const line = typeof args?.line === "string" ? args.line : "";
        const name = String((args?.terminal as { name?: unknown } | undefined)?.name ?? "");
        const links = await provider.provideTerminalLinks({ line, terminal: { name } });
        return (Array.isArray(links) ? links : []).slice(0, 50).map((link) => {
          const key = `${++seqOfLink}`;
          given.set(key, link);
          if (given.size > 500) given.delete(given.keys().next().value as string);
          return {
            key,
            startIndex: Number(link.startIndex) || 0,
            length: Number(link.length) || 0,
            ...(typeof link.tooltip === "string" && { tooltip: link.tooltip.slice(0, 200) }),
          };
        });
      });
      const offHandle = on(`${id}.handle`, async (args: { key?: unknown }) => {
        const link = given.get(String(args?.key ?? ""));
        if (link) await provider.handleTerminalLink(link);
        return null;
      });
      const forget = () => {
        offProvide();
        offHandle();
        given.clear();
      };
      void request("terminals.registerLinkProvider", { id }).catch((err: unknown) => {
        forget();
        console.error(err instanceof Error ? err.message : String(err));
      });
      return {
        dispose: () => {
          forget();
          void request("terminals.unregisterLinkProvider", { id }).catch(() => {});
        },
      };
    },
    setEnvironment: (changes) =>
      request("terminals.setEnvironment", { changes: [...changes] }).then(() => {}),
    async watchOthers(listener) {
      const valid = (t: unknown): t is OtherTerminal =>
        !!t &&
        typeof (t as OtherTerminal).id === "string" &&
        /^u\d{1,9}$/.test((t as OtherTerminal).id);
      on("terminals.others", (t: unknown) => {
        if (valid(t)) listener({ id: t.id, name: String(t.name ?? "") });
        return null;
      });
      const now = await request<unknown>("terminals.watchOthers", {});
      return (Array.isArray(now) ? now : [])
        .filter(valid)
        .map((t) => ({ id: t.id, name: String(t.name ?? "") }));
    },
    attach(terminal, onEvent) {
      const { id, name } = terminal;
      const offEvents = on(`terminal.${id}`, (raw: unknown) => {
        const event = toTerminalEvent(raw);
        if (event) onEvent(event);
        if (event?.kind === "closed") offEvents();
        return null;
      });
      return {
        id,
        name,
        sendText: (text, addNewLine = true) =>
          request("terminals.sendText", { id, text: String(text), addNewLine }),
        write: () => {},
        show: (focus = false) => request("terminals.show", { id, focus }),
        dispose: () => {
          offEvents();
          void request("terminals.dispose", { id }).catch(() => {});
        },
      };
    },
    readOutput: (id) =>
      request<unknown>("terminals.read", { id }).then((text) =>
        typeof text === "string" ? text : null,
      ),
    async create(options) {
      const id = `t${++seq}`;
      const pty = options?.pty;
      const name = String(options?.name ?? "").slice(0, 100);
      const entry = { pty: pty as Pseudoterminal, early: [] as string[] };
      if (pty) created.set(id, entry);
      const listener = options?.onEvent;
      const offEvents = listener
        ? on(`terminal.${id}`, (raw: unknown) => {
            const event = toTerminalEvent(raw);
            if (event) listener(event);
            if (event?.kind === "closed") offEvents?.();
            return null;
          })
        : undefined;
      try {
        await request("terminals.create", {
          id,
          name,
          pseudo: pty !== undefined,
          ...(options?.shellPath !== undefined && { shellPath: options.shellPath }),
          ...(options?.shellArgs !== undefined && { shellArgs: options.shellArgs }),
          ...(options?.cwd !== undefined && { cwd: options.cwd }),
          ...(options?.env !== undefined && { env: options.env }),
          focus: options?.focus === true,
          ...(options?.background === true && { background: true }),
          ...(options?.hidden === true && { hidden: true }),
          ...(options?.transient === true && { transient: true }),
          ...(listener && { events: true }),
        });
      } catch (err) {
        created.delete(id);
        offEvents?.();
        throw err;
      }
      return {
        id,
        name,
        sendText: (text, addNewLine = true) =>
          request("terminals.sendText", { id, text: String(text), addNewLine }),
        write: (text) => {
          const c = created.get(id);
          if (!c) return;
          if (c.ptyId) ioFor(c.ptyId).write(text);
          else if (c.early.length < 1000) c.early.push(String(text));
        },
        show: (focus = false) => request("terminals.show", { id, focus }),
        dispose: () => {
          created.delete(id);
          offEvents?.();
          void request("terminals.dispose", { id }).catch(() => {});
        },
      };
    },
  };

  let providerSeq = 0;
  const tasks: TasksApi = {
    registerTaskProvider(type, provider) {
      const id = `tasks${++providerSeq}`;
      const wire = (task: ProvidedTask | null | undefined): TaskWire | null => {
        if (!task || typeof task !== "object" || !task.execution) return null;
        const { execution, ...rest } = task;
        const definition = { ...(task.definition ?? {}), type };
        if (execution.kind !== "custom") return { ...rest, definition, execution };
        if (typeof execution.start !== "function") return null;
        const key = `${id}/${String(task.name)}`;
        customs.set(key, execution);
        definitions.set(key, definition);
        return { ...rest, definition, execution: { kind: "custom", key } };
      };
      const offProvide = on(id, async () => {
        const list = await provider.provideTasks();
        return Array.isArray(list) ? list.map(wire).filter((t) => t !== null) : [];
      });
      const offResolve = on(`${id}.resolve`, async (args: { definition?: unknown }) => {
        if (typeof provider.resolveTask !== "function") return null;
        const definition =
          args?.definition && typeof args.definition === "object"
            ? (args.definition as Record<string, unknown>)
            : { type };
        return wire(await provider.resolveTask(definition));
      });
      const forget = () => {
        offProvide();
        offResolve();
        for (const key of [...customs.keys()])
          if (key.startsWith(`${id}/`)) {
            customs.delete(key);
            definitions.delete(key);
          }
      };
      void request("tasks.register", {
        id,
        type: String(type),
        resolve: typeof provider?.resolveTask === "function",
      }).catch((err: unknown) => {
        forget();
        console.error(err instanceof Error ? err.message : String(err));
      });
      return {
        dispose: () => {
          forget();
          void request("tasks.unregister", { id }).catch(() => {});
        },
      };
    },
  };

  return { terminals, tasks };
}
