// The `vscode` shim's `tasks`, `scm` and `authentication` (D257) on the IDE's `ide.tasks`,
// `ide.scm` and `ide.authentication`: VS Code's Task objects as the IDE's provided tasks (shell,
// process and custom executions), source controls with their input box, groups, resource states
// and quick diff (an original's text from its file or the extension's own content provider), and
// sign-ins. DOM-free and unit-tested.

import type { WorkerApi } from "../rpc";
import type { ShimCommands } from "./commands";
import { decodeText, markdownOf, pathOf } from "./convert";
import {
  Disposable,
  EventEmitter,
  NONE_TOKEN,
  TaskPanelKind,
  TaskRevealKind,
  TaskScope,
  Uri,
} from "./types";
import { toIdePty, type VsPseudoterminal } from "./views";
import {
  CustomExecution,
  ProcessExecution,
  ShellExecution,
  Task,
  TaskGroup,
} from "./workbenchTypes";

/** Content providers the extension registered, by scheme (quick diff and openTextDocument use them). */
export type ContentProviders = Map<
  string,
  {
    provideTextDocumentContent(
      uri: Uri,
      token: unknown,
    ): string | null | undefined | Promise<string | null | undefined>;
  }
>;

type IdeTask = NonNullable<
  Awaited<ReturnType<Parameters<WorkerApi["tasks"]["registerTaskProvider"]>[1]["provideTasks"]>>
>[number];

type ShellFamily = "powershell" | "cmd" | "posix";

/** Which shell runs a task: its `executable`, else the IDE's default (PowerShell on Windows). */
export function shellFamily(executable: string | undefined, platform: string): ShellFamily {
  const file =
    (executable ?? "")
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase()
      .replace(/\.exe$/, "") ?? "";
  if (file === "pwsh" || file === "powershell") return "powershell";
  if (file === "cmd") return "cmd";
  if (file) return "posix";
  return platform === "win32" ? "powershell" : "posix";
}

/**
 * VS Code's ShellExecution(command, args) as one command line for `family` (D261): each part
 * quoted the way that shell reads it, and in PowerShell a quoted command run with `&` (else it
 * is only a string).
 */
export function shellCommandLine(
  parts: readonly (string | { value: string })[],
  family: ShellFamily,
): string {
  const values = parts.map((a) => (typeof a === "string" ? a : a.value)).filter((v) => v !== "");
  const needs = (v: string) => /[\s"'`$&|;<>()^%!,{}]/.test(v);
  const quote = (v: string) =>
    !needs(v)
      ? v
      : family === "powershell"
        ? `'${v.replace(/'/g, "''")}'`
        : family === "cmd"
          ? `"${v.replace(/"/g, '""')}"`
          : `'${v.replace(/'/g, "'\\''")}'`;
  const [command, ...args] = values.map(quote);
  if (command === undefined) return "";
  const first = family === "powershell" && command.startsWith("'") ? `& ${command}` : command;
  return [first, ...args].join(" ");
}

/** One of VS Code's Tasks as the IDE's provided task; undefined without an execution. */
export function toIdeTask(task: Task, platform = "linux"): IdeTask | undefined {
  const exec = task.execution;
  let execution: IdeTask["execution"];
  if (exec instanceof ShellExecution) {
    const executable = exec.options?.executable;
    const commandLine =
      exec.commandLine ??
      shellCommandLine(
        [exec.command ?? "", ...(exec.args ?? [])],
        shellFamily(executable, platform),
      );
    execution = {
      kind: "shell",
      commandLine,
      ...(exec.options?.cwd && { cwd: exec.options.cwd }),
      ...(exec.options?.env && { env: exec.options.env }),
      // Its own shell (D261: a task written for cmd.exe ran in PowerShell).
      ...(executable && {
        shell: { executable, ...(exec.options?.shellArgs && { args: exec.options.shellArgs }) },
      }),
    };
  } else if (exec instanceof ProcessExecution) {
    execution = {
      kind: "process",
      process: exec.process,
      args: exec.args,
      ...(exec.options?.cwd && { cwd: exec.options.cwd }),
      ...(exec.options?.env && { env: exec.options.env }),
    };
  } else if (exec instanceof CustomExecution) {
    execution = {
      kind: "custom",
      start: async (definition) => toIdePty((await exec.callback(definition)) as VsPseudoterminal),
    };
  } else return undefined;
  const group =
    task.group instanceof TaskGroup && (task.group.id === "build" || task.group.id === "test")
      ? task.group.isDefault
        ? { kind: task.group.id, isDefault: true }
        : task.group.id
      : undefined;
  const p = task.presentationOptions;
  const reveal = {
    [TaskRevealKind.Always]: "always",
    [TaskRevealKind.Silent]: "silent",
    [TaskRevealKind.Never]: "never",
  } as const;
  const panel = {
    [TaskPanelKind.Shared]: "shared",
    [TaskPanelKind.Dedicated]: "dedicated",
    [TaskPanelKind.New]: "new",
  } as const;
  return {
    name: task.name,
    definition: task.definition,
    ...(task.detail && { detail: task.detail }),
    ...(group && { group }),
    ...(task.isBackground && { isBackground: true }),
    ...(task.problemMatchers.length && { problemMatchers: task.problemMatchers }),
    presentation: {
      ...(p.reveal !== undefined && { reveal: reveal[p.reveal as TaskRevealKind] }),
      ...(p.panel !== undefined && { panel: panel[p.panel as TaskPanelKind] }),
      ...(p.focus !== undefined && { focus: p.focus }),
      ...(p.clear !== undefined && { clear: p.clear }),
      ...(p.close !== undefined && { close: p.close }),
    },
    execution,
  } as IdeTask;
}

export function createWorkbench(
  ide: WorkerApi,
  commands: ShimCommands,
  contentProviders: ContentProviders,
  readFile: (path: string) => Promise<Uint8Array>,
  unsupported: (name: string) => void,
) {
  /** An original's text for quick diff: its file, or the extension's content provider. */
  const textOf = async (uri: Uri): Promise<string | null> => {
    if (uri.scheme === "file") return decodeText(await readFile(uri.fsPath));
    const provider = contentProviders.get(uri.scheme);
    return provider ? ((await provider.provideTextDocumentContent(uri, NONE_TOKEN)) ?? null) : null;
  };

  const onDidStartTask = new EventEmitter<unknown>();
  const onDidEndTask = new EventEmitter<unknown>();
  const executions: unknown[] = [];

  const tasks = {
    get taskExecutions() {
      return [...executions];
    },
    registerTaskProvider: (
      type: string,
      provider: {
        provideTasks(
          token: unknown,
        ): Task[] | null | undefined | Promise<Task[] | null | undefined>;
        resolveTask?(
          task: Task,
          token: unknown,
        ): Task | null | undefined | Promise<Task | null | undefined>;
      },
    ) => {
      // Node's name for the platform, which picks how arguments are quoted (toIdeTask).
      const osName = ide.env.platform === "windows" ? "win32" : ide.env.platform;
      const handle = ide.tasks.registerTaskProvider(type, {
        provideTasks: async () =>
          ((await provider.provideTasks(NONE_TOKEN)) ?? []).flatMap(
            (t) => toIdeTask(t, osName) ?? [],
          ),
        ...(provider.resolveTask && {
          resolveTask: async (definition: Record<string, unknown>) => {
            const name = typeof definition.label === "string" ? definition.label : type;
            const t = await provider.resolveTask?.(
              new Task(definition, TaskScope.Workspace, name, type),
              NONE_TOKEN,
            );
            return t ? toIdeTask(t, osName) : undefined;
          },
        }),
      });
      return new Disposable(() => handle.dispose());
    },
    fetchTasks: async (filter?: { type?: string }) => {
      const listed = (await ide.commands
        .execute<unknown>("tasks.list", {})
        .catch(() => [])) as unknown;
      const list = Array.isArray(listed)
        ? listed
        : Array.isArray((listed as { tasks?: unknown[] })?.tasks)
          ? (listed as { tasks: unknown[] }).tasks
          : [];
      return list.flatMap((raw) => {
        const label = typeof raw === "string" ? raw : (raw as { label?: unknown })?.label;
        if (typeof label !== "string") return [];
        const [source, ...rest] = label.split(": ");
        const type = rest.length ? (source ?? "shell") : "shell";
        if (filter?.type && filter.type !== type) return [];
        return [
          new Task(
            { type, label },
            TaskScope.Workspace,
            rest.join(": ") || label,
            rest.length ? (source ?? "") : "Workspace",
          ),
        ];
      });
    },
    executeTask: async (task: Task) => {
      const label =
        typeof task.definition.label === "string" && !task.source
          ? task.definition.label
          : `${String(task.definition.type ?? task.source)}: ${task.name}`;
      const execution = {
        task,
        terminate: () => unsupported("TaskExecution.terminate"),
      };
      executions.push(execution);
      onDidStartTask.fire({ execution });
      void ide.commands
        .execute("tasks.run", { label, wait: true })
        .catch(() => undefined)
        .finally(() => {
          executions.splice(executions.indexOf(execution), 1);
          onDidEndTask.fire({ execution });
        });
      return execution;
    },
    onDidStartTask: onDidStartTask.event,
    onDidEndTask: onDidEndTask.event,
    onDidStartTaskProcess: new EventEmitter<unknown>().event,
    onDidEndTaskProcess: new EventEmitter<unknown>().event,
  };

  const scm = {
    inputBox: undefined,
    createSourceControl: (id: string, label: string, rootUri?: Uri) => {
      const sc = ide.scm.createSourceControl({
        id,
        label,
        ...(rootUri && { rootPath: pathOf(rootUri) }),
      });
      let acceptInputCommand: unknown;
      let quickDiffProvider: unknown;
      const shim = {
        id,
        label,
        rootUri,
        inputBox: {
          get value() {
            return sc.inputBox.value;
          },
          set value(v: string) {
            sc.inputBox.value = v;
          },
          get placeholder() {
            return sc.inputBox.placeholder;
          },
          set placeholder(v: string) {
            sc.inputBox.placeholder = v;
          },
          get visible() {
            return sc.inputBox.visible;
          },
          set visible(v: boolean) {
            sc.inputBox.visible = v;
          },
          enabled: true,
          validateInput: undefined,
        },
        get count() {
          return sc.count;
        },
        set count(v: number | undefined) {
          sc.count = v;
        },
        get acceptInputCommand() {
          return acceptInputCommand;
        },
        set acceptInputCommand(c: unknown) {
          acceptInputCommand = c;
          const r = commands.ref(c as Parameters<ShimCommands["ref"]>[0]);
          sc.acceptInputCommand = r
            ? {
                command: r.command,
                ...(typeof (c as { title?: unknown })?.title === "string" && {
                  title: (c as { title: string }).title,
                }),
                ...(r.input !== undefined && { input: r.input }),
              }
            : undefined;
        },
        get quickDiffProvider() {
          return quickDiffProvider;
        },
        set quickDiffProvider(p: unknown) {
          quickDiffProvider = p;
          const provider = p as
            | { provideOriginalResource?(uri: Uri, token: unknown): unknown }
            | undefined;
          sc.quickDiffProvider = provider?.provideOriginalResource
            ? {
                provideOriginal: async (path) => {
                  const uri = Uri.revive(
                    await provider.provideOriginalResource?.(Uri.file(path), NONE_TOKEN),
                  );
                  return uri ? textOf(uri) : null;
                },
              }
            : undefined;
        },
        commitTemplate: undefined as string | undefined,
        statusBarCommands: undefined as unknown,
        actionButton: undefined as unknown,
        createResourceGroup: (groupId: string, groupLabel: string) => {
          const g = sc.createResourceGroup(groupId, groupLabel);
          let states: readonly unknown[] = [];
          return {
            id: groupId,
            get label() {
              return g.label;
            },
            set label(v: string) {
              g.label = v;
            },
            get hideWhenEmpty() {
              return g.hideWhenEmpty;
            },
            set hideWhenEmpty(v: boolean) {
              g.hideWhenEmpty = v;
            },
            contextValue: undefined as string | undefined,
            get resourceStates() {
              return states;
            },
            set resourceStates(list: readonly unknown[]) {
              states = list;
              g.resourceStates = list.flatMap((raw) => {
                const s = raw as {
                  resourceUri?: Uri;
                  command?: Parameters<ShimCommands["ref"]>[0];
                  decorations?: { strikeThrough?: boolean; faded?: boolean; tooltip?: unknown };
                };
                if (!s.resourceUri) return [];
                const r = commands.ref(s.command);
                const tooltip = markdownOf(s.decorations?.tooltip);
                return [
                  {
                    path: pathOf(s.resourceUri),
                    decorations: {
                      ...(s.decorations?.strikeThrough && { strikeThrough: true }),
                      ...(s.decorations?.faded && { faded: true }),
                      ...(tooltip && { tooltip }),
                    },
                    ...(r && {
                      command: {
                        command: r.command,
                        ...(r.input !== undefined && { input: r.input }),
                      },
                    }),
                  },
                ];
              });
            },
            dispose: () => g.dispose(),
          };
        },
        dispose: () => sc.dispose(),
      };
      return shim;
    },
  };

  const onDidChangeSessions = new EventEmitter<{ provider: { id: string; label: string } }>();
  ide.authentication.onDidChangeSessions((e) =>
    onDidChangeSessions.fire({ provider: { id: e.providerId, label: e.providerId } }),
  );
  type VsAuthProvider = {
    onDidChangeSessions?: (listener: () => void) => { dispose(): unknown };
    getSessions(scopes?: readonly string[], options?: unknown): unknown;
    createSession(scopes: readonly string[], options?: unknown): unknown;
    removeSession(sessionId: string): unknown;
  };
  const authentication = {
    getSession: (
      providerId: string,
      scopes: readonly string[],
      options?: {
        createIfNone?: boolean | object;
        forceNewSession?: boolean | object;
        silent?: boolean;
      },
    ) =>
      ide.authentication.getSession(providerId, [...scopes], {
        ...(options?.createIfNone && { createIfNone: true }),
        ...(options?.forceNewSession && { forceNewSession: true }),
        ...(options?.silent && { silent: true }),
      }),
    getAccounts: () => {
      unsupported("authentication.getAccounts");
      return Promise.resolve([]);
    },
    registerAuthenticationProvider: (
      id: string,
      label: string,
      provider: VsAuthProvider,
      options?: { supportsMultipleAccounts?: boolean },
    ) => {
      const handle = ide.authentication.registerAuthenticationProvider(
        id,
        label,
        {
          getSessions: async (scopes) => (await provider.getSessions(scopes, {})) as never,
          createSession: async (scopes) => (await provider.createSession(scopes, {})) as never,
          removeSession: async (sessionId) => {
            await provider.removeSession(sessionId);
          },
        },
        options,
      );
      const sub = provider.onDidChangeSessions?.(() => handle.fireDidChangeSessions());
      return new Disposable(() => {
        sub?.dispose();
        handle.dispose();
      });
    },
    onDidChangeSessions: onDidChangeSessions.event,
  };

  return { tasks, scm, authentication, textOf };
}
