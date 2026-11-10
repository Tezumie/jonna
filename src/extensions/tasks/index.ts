// Tasks (D93, D134): VS Code's tasks.json — `.vscode/tasks.json`, the IDE's own
// `<workspaceFolderName>/tasks.json` (wins for the same label) and the user's tasks.json — plus
// package.json scripts with the project's package manager. A task runs as its own process in a
// terminal tab (runner.ts), its output read by its problem matchers into Problems; dependencies
// first; `${input:…}` asked for. Run / terminate / restart, the running list, the default build
// and test tasks, and tasks that start when the folder opens (`runOptions.runOn`).
import type { BuiltinExtension } from "../../core/extensions/index";
import { fsIpc } from "../../core/ipc/fs";
import { basename, dirname, joinPath, pathKey, samePath } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { parseJsonc } from "../../core/settings/jsonc";
import type { TaskExecution, WorkbenchServices } from "../../workbench/services";
import type { WorkspaceFolder } from "../../workbench/workspace";
import {
  ensureWorkspaceFolder,
  findWorkspaceFile,
  workspaceFolderLabelsOf,
  workspaceFolderPaths,
} from "../../workbench/workspaceFolder";
import { activeFile, chooseFolder, editorFolder } from "./chooseFolder";
import { hasDefaultTask, setDefaultTask } from "./defaultTask";
import { detectDepth, detectSyntax } from "./detect";
import { detectedTasks } from "./detectFolders";
import manifest from "./extension.json";
import { fromContributed } from "./extensionTasks";
import { configFilesOf, findNamed, folderByInput, folderForFile, qualifiedName } from "./folders";
import { BUILT_IN_MATCHERS } from "./problemMatchers";
import { TaskRunner } from "./runner";
import {
  parseInputs,
  parseTasksJson,
  scriptTasks,
  type TaskDefinition,
  type TaskInput,
  taskPlatform,
  taskShellKind,
  type Variables,
} from "./tasks";

const TEMPLATE = `{
  // Tasks run in a terminal tab: "Run task…" (or Ctrl/Cmd+Shift+B for the default build task).
  // Same format as VS Code: \${workspaceFolder}, \${file}, \${input:…} are filled in; problem
  // matchers ($tsc, $eslint-stylish, $gcc…) put errors in Problems.
  "version": "2.0.0",
  "tasks": [
    {
      "label": "build",
      "type": "shell",
      "command": "npm run build",
      "group": { "kind": "build", "isDefault": true },
      "problemMatcher": []
    }
  ]
}
`;

const USER_TEMPLATE = `{
  // Your own tasks, in every folder (VS Code's user tasks). Same format as .vscode/tasks.json.
  "version": "2.0.0",
  "tasks": []
}
`;

export const tasksExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dispatcher, workspace, quickInput, notifications, settings, statusBar, state } =
      services;
    const register: typeof dispatcher.register = (c) =>
      sub.add(dispatcher.register({ category: "Terminal", ...c }));
    const runner = new TaskRunner(services, sub);

    const readJson = async (path: string): Promise<unknown> => {
      try {
        const parsed = parseJsonc(new TextDecoder().decode(await fsIpc.read(path)));
        return parsed.ok ? parsed.value : null;
      } catch {
        return null;
      }
    };
    const userTasksPath = () => {
      const user = settings.filePath("user");
      return user ? joinPath(dirname(user), "tasks.json") : null;
    };

    /** A folder's tasks.json files, highest precedence first, with the `source` their tasks get. */
    const folderTaskFiles = (folder: string): [string, string][] => {
      // D189: the IDE's own, then .vscode, the legacy folder name.
      const labels = workspaceFolderLabelsOf(folder, "tasks.json");
      return workspaceFolderPaths(folder, "tasks.json").map(
        (path, i) => [path, labels[i] ?? path] as [string, string],
      );
    };
    /** The tasks.json files a folder's tasks may come from: its own, then the user's. */
    const taskFiles = (folder: string): [string | null, string][] => [
      ...folderTaskFiles(folder),
      [userTasksPath(), "user tasks"],
    ];
    /** The open folders (the root alone while a workspace is still being set up). */
    const openFolders = (): readonly WorkspaceFolder[] => {
      const folders = workspace.folders.peek();
      const root = workspace.root.peek();
      if (folders.length || !root) return folders;
      return [{ path: root, name: basename(root) || root, index: 0 }];
    };

    /**
     * Every task: each folder's tasks.json files (the IDE's, .vscode), the workspace file's, the
     * user's, then each folder's package.json scripts and build files, then extensions' (first
     * label wins). In a multi-root workspace (D251) a folder's tasks are labelled with its name
     * ("build (api)") and their variables, cwd and problem matchers are that folder's.
     */
    const load = async (): Promise<TaskDefinition[]> => {
      const root = workspace.root.peek();
      if (!root) return [];
      const folders = openFolders();
      const multi = folders.length > 1;
      const file = activeFile(services);
      // User and workspace-file tasks run for the active file's folder (else the first).
      const activeFolder = folderForFile(folders, file, folders[0]) ?? folders[0];
      if (!activeFolder) return [];
      const vars = (folder: string): Variables => ({
        workspaceFolder: folder,
        folders,
        ...(file && { file }),
        pathSeparator: services.platform === "windows" ? "\\" : "/",
        config: (key: string) => settings.peekAt(key, folder),
      });
      const out: TaskDefinition[] = [];
      const add = (t: TaskDefinition) => {
        if (!out.some((x) => x.label === t.label)) out.push(t);
      };
      /** A task as its folder's: the folder's name on its label in a multi-root workspace. */
      const own = (
        t: TaskDefinition,
        folder: WorkspaceFolder,
        owned: boolean,
        extra: Partial<TaskDefinition> = {},
      ): TaskDefinition => ({
        ...t,
        ...extra,
        workspaceFolder: folder.path,
        ...(owned && { folderName: folder.name }),
        ...(owned && multi && { label: qualifiedName(t.label, folder, true), name: t.label }),
      });
      // Built aside and swapped in at the end: a load running alongside a task that is asking
      // for its inputs mustn't empty the list under it.
      const inputs: TaskInput[] = [];
      // Each file's JSON, for extensions' task providers to resolve entries of their types (D233).
      const taskJsons: unknown[] = [];
      const fromJson = (
        json: unknown,
        path: string,
        source: string,
        folder: WorkspaceFolder,
        owned: boolean,
      ) => {
        taskJsons.push(json);
        const fileInputs = parseInputs(json);
        inputs.push(...fileInputs.filter((i) => !inputs.some((x) => x.id === i.id)));
        for (const t of parseTasksJson(
          json,
          source,
          vars(folder.path),
          // A WSL folder's tasks run in Linux: its `linux` blocks apply (m7.12, VS Code's WSL).
          taskPlatform(services.platform, folder.path),
          services.taskTerminals.automationShell?.(folder.path),
        ))
          add(
            own(t, folder, owned, { file: path, ...(fileInputs.length && { inputs: fileInputs }) }),
          );
      };
      for (const f of configFilesOf(folders, folderTaskFiles))
        fromJson(await readJson(f.path), f.path, f.source, f.folder, true);
      // The workspace file's own tasks (`"tasks": { "tasks": [...] }`, D251).
      const workspaceFile = workspace.file.peek();
      const workspaceTasks = workspace.fileData.peek()?.tasks;
      if (workspaceFile && workspaceTasks)
        fromJson(workspaceTasks, workspaceFile, basename(workspaceFile), activeFolder, false);
      const user = userTasksPath();
      if (user) fromJson(await readJson(user), user, "user tasks", activeFolder, false);
      for (const folder of folders) {
        const entries = await fsIpc.listDir(folder.path).catch(() => []);
        const pkg = await readJson(joinPath(folder.path, "package.json"));
        if (pkg) {
          const names = entries.map((e) => e.name);
          for (const t of scriptTasks(pkg, names)) add(own(t, folder, true));
        }
        // Build files (tsc, Make, Cargo, Gradle, Maven, gulp, grunt; detectFolders.ts). Make
        // reads a Makefile (`make -p`, which may run its `$(shell …)`) only in a trusted folder.
        if (settings.peekAt<string>("task.autoDetect", folder.path) === "off") continue;
        const platform = taskPlatform(services.platform, folder.path);
        for (const t of await detectedTasks(
          folder.path,
          entries,
          detectSyntax(
            platform,
            taskShellKind(
              services.taskTerminals.automationShell?.(folder.path) ?? undefined,
              services.platform,
            ),
          ),
          detectDepth(settings.peekAt<number>("task.autoDetectDepth", folder.path)),
          services.trust.state.value === "trusted",
        ))
          add(own(t, folder, true));
      }
      // Extensions' task providers (D233), after the folders' own tasks.
      for (const t of await services.extensionFeatures.tasks.tasks(taskJsons))
        add(fromContributed(t));
      runner.inputs = inputs;
      return out;
    };
    /**
     * A task by label (`findNamed`: "build (api)", or "build" when that's clear): `folder`'s
     * first (a launch configuration's preLaunchTask), else for the user the editor's folder's.
     */
    const byLabel = (
      all: readonly TaskDefinition[],
      label: string,
      user: boolean,
      folder?: string,
    ) =>
      findNamed(
        all,
        label,
        folder?.trim()
          ? folderByInput(openFolders(), folder).path
          : user
            ? editorFolder(services)
            : undefined,
      );

    // A task's terminal taken back after Developer: Reload window: linked to its task again once
    // the folder's tasks are read (the folder may still be opening).
    const relink = async (label: string, execution: TaskExecution, tries = 40): Promise<void> => {
      if (sub.isDisposed) return;
      if (!workspace.root.peek() && tries > 0) {
        await new Promise((r) => setTimeout(r, 250));
        return relink(label, execution, tries - 1);
      }
      const task = (await load()).find((t) => t.label === label);
      if (task && !sub.isDisposed) runner.adopt(task, execution);
    };
    const reattached = services.taskTerminals.onDidReattach;
    if (reattached)
      sub.add(reattached(({ label, execution }) => void relink(label, execution).catch(() => {})));

    const pick = async (
      tasks: TaskDefinition[],
      placeholder: string,
    ): Promise<TaskDefinition | undefined> => {
      if (!tasks.length) {
        notifications.show(
          "info",
          "No tasks found. Add .vscode/tasks.json, package.json scripts or a build file (Makefile, Cargo.toml, tsconfig.json…).",
          {
            actions: [
              {
                label: "Configure tasks",
                run: () => void dispatcher.execute("tasks.configure", {}).catch(() => {}),
              },
            ],
          },
        );
        return undefined;
      }
      const running = runner.running.peek();
      const rank = (t: TaskDefinition) => {
        const r = runner.recent.indexOf(t.label);
        return r < 0 ? 1e9 : r;
      };
      const ordered = [...tasks].sort((a, b) => rank(a) - rank(b));
      const chosen = await quickInput.pick(
        ordered.map((t) => ({
          id: t.label,
          label: t.label,
          description: [
            running.has(t.label)
              ? "running"
              : runner.recent.includes(t.label)
                ? "recently used"
                : "",
            t.source,
            t.detail ?? t.command,
          ]
            .filter(Boolean)
            .join(" · "),
          icon: (t.background ? "globe" : "square-terminal") as "globe" | "square-terminal",
        })),
        { placeholder, matchOn: (i) => `${i.label} ${i.description ?? ""}` },
      );
      return tasks.find((t) => t.label === chosen?.id);
    };
    /** A running task by label, or picked among them. */
    const pickRunning = async (label: string | undefined, placeholder: string) => {
      const running = [...runner.running.peek().keys()];
      if (label) return running.includes(label) ? label : undefined;
      if (running.length === 0) {
        notifications.show("info", "No task is running.");
        return undefined;
      }
      if (running.length === 1) return running[0];
      return (
        await quickInput.pick(
          running.map((l) => ({ id: l, label: l })),
          { placeholder },
        )
      )?.id;
    };

    register({
      id: "tasks.run",
      title: "Run task…",
      description:
        "Runs a task (from .vscode/tasks.json, the IDE's or the user's tasks.json, package.json scripts, or detected from build files: 'tsc: build - tsconfig.json', 'make: test', 'cargo: build', 'gradle: test', 'maven: package', 'gulp: build') in its own terminal tab; without `label`, asks. In a multi-root workspace a folder's tasks are labelled with the folder's name ('build (api)'; tasks.list shows them). Waits until it ends (or, for a background task such as a dev server or watcher, until it's ready) and returns its exit code, problem count and the end of its output. Problems its problem matcher finds go to the Problems view.",
      input: s.object({
        label: s.string().describe("Task label, e.g. 'npm: dev' or 'build'").optional(),
        wait: s.boolean().describe("Wait for it to end or be ready (default true)").optional(),
        folder: s
          .string()
          .describe(
            "Multi-root: the folder (name or path) whose task `label` names, when several have one",
          )
          .optional(),
      }),
      effects: ["exec"],
      when: "workspaceOpen",
      agent: "discoverable",
      run: async ({ label, wait, folder }, ctx) => {
        const all = await load();
        const task = label
          ? byLabel(all, label, ctx.caller.kind === "user", folder)
          : await pick(
              all.filter((t) => !t.hide),
              "Select the task to run",
            );
        if (!task) {
          if (label) throw new Error(`No task "${label}" (tasks.list shows them).`);
          return { ran: null };
        }
        return runner.run(task, all, ctx.caller, wait ?? ctx.caller.kind !== "user");
      },
    });
    for (const [id, kind, title] of [
      ["tasks.runBuild", "build", "Run build task"],
      ["tasks.runTest", "test", "Run test task"],
    ] as const)
      register({
        id,
        title,
        description: `Runs the default ${kind} task (or asks among the ${kind} tasks).`,
        input: s.empty(),
        effects: ["exec"],
        when: "workspaceOpen",
        agent: "discoverable",
        run: async (_input, ctx) => {
          const all = await load();
          const group = all.filter((t) => t.group?.kind === kind);
          const task =
            group.find((t) => t.group?.isDefault) ??
            (group.length === 1
              ? group[0]
              : await pick(group.length ? group : all, `Select the ${kind} task to run`));
          return task
            ? runner.run(task, all, ctx.caller, ctx.caller.kind !== "user")
            : { ran: null };
        },
      });
    register({
      id: "tasks.rerun",
      title: "Rerun last task",
      description: "Runs the last task again.",
      input: s.empty(),
      effects: ["exec"],
      when: "workspaceOpen",
      run: async (_input, ctx) => {
        const all = await load();
        const last = runner.recent[0];
        // A folder added since (D251): "build" is labelled "build (app)" now, found by its name.
        const task =
          last === undefined
            ? undefined
            : (all.find((t) => t.label === last) ??
              (() => {
                try {
                  return byLabel(all, last, true);
                } catch {
                  return undefined; // several folders have one: none is "the last"
                }
              })());
        if (!task) throw new Error("No task has run yet.");
        return runner.run(task, all, ctx.caller, ctx.caller.kind !== "user");
      },
    });
    register({
      id: "tasks.terminate",
      title: "Terminate task…",
      description:
        "Ends a running task (its terminal stays with the exit code). Without `label`, asks when several run; `all` ends every one.",
      input: s.object({ label: s.string().optional(), all: s.boolean().optional() }),
      effects: ["exec"],
      agent: "discoverable",
      run: async ({ label, all }) => {
        if (all) {
          const labels = [...runner.running.peek().keys()];
          await Promise.all(labels.map((l) => runner.terminate(l)));
          return { terminated: labels };
        }
        const chosen = await pickRunning(label, "Select the task to terminate");
        if (!chosen) {
          if (label) throw new Error(`The task "${label}" isn't running.`);
          return { terminated: [] };
        }
        await runner.terminate(chosen);
        return { terminated: [chosen] };
      },
    });
    register({
      id: "tasks.restart",
      title: "Restart running task…",
      description: "Ends a running task and runs it again.",
      input: s.object({ label: s.string().optional() }),
      effects: ["exec"],
      agent: "discoverable",
      run: async ({ label }, ctx) => {
        const chosen = await pickRunning(label, "Select the task to restart");
        if (!chosen) {
          if (label) throw new Error(`The task "${label}" isn't running.`);
          return { restarted: null };
        }
        await runner.terminate(chosen);
        const all = await load();
        const task = all.find((t) => t.label === chosen);
        if (!task) throw new Error(`The task "${chosen}" is gone from tasks.json.`);
        return runner.run(task, all, ctx.caller, false);
      },
    });
    register({
      id: "tasks.showRunning",
      title: "Show running tasks…",
      description: "Picks a running task and shows its terminal.",
      input: s.empty(),
      effects: [],
      run: async () => {
        const chosen = await pickRunning(undefined, "Select the task to show");
        const entry = chosen ? runner.running.peek().get(chosen) : undefined;
        entry?.execution.reveal(true);
        return { shown: chosen ?? null };
      },
    });
    register({
      id: "tasks.list",
      title: "List tasks",
      description:
        "The workspace's tasks: label, command, source, group, whether it keeps running, whether it's running now, its problem matcher; in a multi-root workspace, the folder it belongs to (its label ends in ' (folder)'). Built-in problem matchers are listed too.",
      input: s.empty(),
      effects: ["read"],
      when: "workspaceOpen",
      agent: "discoverable",
      run: async () => {
        const multi = workspace.folders.peek().length > 1;
        const running = runner.running.peek();
        return {
          tasks: (await load()).map((t) => ({
            label: t.label,
            ...(multi && t.folderName && { folder: t.folderName }),
            command: t.command,
            ...(t.spec.kind === "process" && { type: "process" }),
            source: t.source,
            ...(t.group && { group: t.group.kind, default: t.group.isDefault }),
            background: t.background,
            running: running.has(t.label),
            ...(t.cwd && { cwd: workspace.relative(t.cwd) || "." }),
            ...(t.dependsOn.length && { dependsOn: t.dependsOn, dependsOrder: t.dependsOrder }),
            ...(t.problemMatcher !== undefined && { problemMatcher: t.problemMatcher }),
            ...(t.runOnFolderOpen && { runOn: "folderOpen" }),
            ...(t.hide && { hide: true }),
          })),
          problemMatchers: BUILT_IN_MATCHERS,
        };
      },
    });
    const openOrCreate = async (path: string, template: string) => {
      const exists = await fsIpc.stat(path).catch(() => null);
      if (!exists) await fsIpc.write(path, new TextEncoder().encode(template), "save");
      await dispatcher.execute("editor.openFile", { path });
      return { path };
    };
    register({
      id: "tasks.configure",
      title: "Configure tasks",
      description:
        "Opens a folder's tasks.json (<workspace folder>/tasks.json, or .vscode's), creating it from a template if needed. In a multi-root workspace `folder` (a folder's name or path) says which; without it, the active editor's folder, else asks.",
      input: s.object({
        folder: s.string().describe("Workspace folder (name or path; multi-root)").optional(),
      }),
      effects: ["write"],
      when: "workspaceOpen",
      run: async ({ folder }) => {
        const root = await chooseFolder(services, folder, {
          placeholder: "Select the workspace folder to configure tasks in",
        });
        if (!root) return { path: null };
        const existing = await findWorkspaceFile(root, "tasks.json");
        if (await fsIpc.stat(existing).catch(() => null)) return openOrCreate(existing, TEMPLATE);
        return openOrCreate(joinPath(await ensureWorkspaceFolder(root), "tasks.json"), TEMPLATE);
      },
    });
    register({
      id: "tasks.openUserTasks",
      title: "Open user tasks",
      category: "Preferences",
      description:
        "Opens your own tasks.json (tasks available in every folder), creating it if needed.",
      input: s.empty(),
      effects: ["write"],
      run: async () => {
        const path = userTasksPath();
        if (!path) throw new Error("The user settings folder isn't known yet.");
        return openOrCreate(path, USER_TEMPLATE);
      },
    });

    // VS Code's "Configure default build task" / "… test task": the picked task gets
    // `"group": { "kind", "isDefault": true }` in its tasks.json (defaultTask.ts).
    const readText = async (path: string) => {
      try {
        return new TextDecoder().decode(await fsIpc.read(path));
      } catch {
        return null;
      }
    };
    for (const [id, kind, title, runs] of [
      ["tasks.configureDefaultBuild", "build", "Configure default build task", "Ctrl/Cmd+Shift+B"],
      ["tasks.configureDefaultTest", "test", "Configure default test task", "Run test task"],
    ] as const)
      register({
        id,
        title,
        description: `Makes a task the default ${kind} task (what ${runs} runs): writes "group": { "kind": "${kind}", "isDefault": true } into the tasks.json it comes from, and adds an entry to the project's tasks.json for a task detected from package.json. Other ${kind} tasks stay in the group. Without \`label\`, asks.`,
        input: s.object({
          label: s.string().describe("Task label, e.g. 'npm: build' (see tasks.list)").optional(),
        }),
        effects: ["write"],
        when: "workspaceOpen",
        agent: "discoverable",
        run: async ({ label }, ctx) => {
          if (!workspace.root.peek()) throw new Error("Open a folder first.");
          const all = await load();
          let task: TaskDefinition | undefined;
          if (label) {
            task = byLabel(all, label, ctx.caller.kind === "user");
            if (!task) throw new Error(`No task "${label}" (tasks.list shows them).`);
          } else {
            // The group's tasks first, the current default marked (VS Code lists them all).
            const listed = all
              .filter((t) => !t.hide)
              .sort((a, b) => Number(b.group?.kind === kind) - Number(a.group?.kind === kind));
            if (!listed.length) {
              await pick([], "");
              return { label: null };
            }
            const chosen = await quickInput.pick(
              listed.map((t) => ({
                id: t.label,
                label: t.label,
                description: [
                  t.group?.kind === kind && t.group.isDefault ? `default ${kind} task` : "",
                  t.source,
                  t.detail ?? t.command,
                ]
                  .filter(Boolean)
                  .join(" · "),
                icon: "square-terminal" as const,
              })),
              {
                placeholder: `Select the task to be used as the default ${kind} task`,
                matchOn: (i) => `${i.label} ${i.description ?? ""}`,
              },
            );
            task = listed.find((t) => t.label === chosen?.id);
          }
          if (!task) return { label: null };
          // The task's own folder's files (D251).
          const root = task.workspaceFolder ?? workspace.root.peek() ?? "";
          const files = taskFiles(root);
          const workspaceFile = workspace.file.peek();
          if (task.file && workspaceFile && samePath(task.file, workspaceFile))
            throw new Error(`"${task.label}" is in the workspace file: set its "group" there.`);
          // The task's own file; a detected task goes into its folder's tasks.json (the first
          // that exists, else a new one in .vscode when the folder has one, else the IDE's).
          let target = task.file ?? null;
          if (!target) {
            target = await findWorkspaceFile(root, "tasks.json");
            if (!(await fsIpc.stat(target).catch(() => null))) {
              const vscode = await fsIpc.stat(joinPath(root, ".vscode")).catch(() => null);
              target =
                vscode?.kind === "dir"
                  ? joinPath(joinPath(root, ".vscode"), "tasks.json")
                  : joinPath(await ensureWorkspaceFolder(root), "tasks.json");
            }
          }
          const text = (await readText(target)) ?? "";
          // The file has the task under its own name ("build", not "build (api)").
          const next = setDefaultTask(text, kind, task.name ? { ...task, label: task.name } : task);
          if (next === null)
            throw new Error(`${workspace.relative(target)} isn't valid JSON; fix it first.`);
          await fsIpc.write(target, new TextEncoder().encode(next), "save");
          // A default in another of the folder's files would still win: it stops being one.
          for (const [path] of files) {
            if (!path || path === target) continue;
            const other = await readText(path);
            if (!other || !hasDefaultTask(other, kind)) continue;
            const cleared = setDefaultTask(other, kind, null);
            if (cleared !== null)
              await fsIpc.write(path, new TextEncoder().encode(cleared), "save");
          }
          if (ctx.caller.kind === "user")
            await dispatcher.execute("editor.openFile", { path: target });
          return { label: task.label, path: workspace.relative(target) || target };
        },
      });

    // Status bar: running tasks (click: show one), like VS Code's.
    sub.add(
      statusBar.add({
        id: "tasks.running",
        name: "Running tasks",
        alignment: "left",
        priority: 40,
        text: () => {
          const n = runner.running.value.size;
          return n === 0
            ? ""
            : `$(refresh-cw) ${n === 1 ? [...runner.running.value.keys()][0] : `${n} tasks`}`;
        },
        tooltip: () =>
          `Running: ${[...runner.running.value.keys()].join(", ")}. Click to show one.`,
        command: "tasks.showRunning",
      }),
    );
    sub.add(
      state.register("ide://tasks", {
        description:
          "Running tasks: label, terminal id, seconds running, problems found, whether it keeps running, the folder it belongs to (multi-root); plus the most recently run labels.",
        get: () => ({
          running: [...runner.running.peek().values()].map((r) => ({
            label: r.task.label,
            ...(workspace.folders.peek().length > 1 &&
              r.task.folderName && { folder: r.task.folderName }),
            terminalId: r.execution.terminalId,
            seconds: Math.round((Date.now() - r.started) / 1000),
            problems: r.problems(),
            background: r.task.background,
          })),
          recent: runner.recent.slice(0, 10),
        }),
      }),
    );

    // Tasks with runOptions.runOn "folderOpen": when a trusted folder opens
    // (task.allowAutomaticTasks), and for each folder added to the workspace later (D251; the
    // workspace is trusted only when every folder is). User tasks run with the first folder.
    let ranRoot: string | null = null;
    const ranFolders = new Set<string>();
    sub.add(
      effect(() => {
        const root = workspace.root.value;
        // Read for its changes: a folder added later runs its own.
        void workspace.folders.value;
        const trusted = services.trust.state.value === "trusted";
        if (!root || !trusted) return undefined;
        if (settings.peek<string>("task.allowAutomaticTasks") === "off") return undefined;
        if (ranRoot !== root) {
          ranRoot = root;
          ranFolders.clear();
        }
        const folders = openFolders();
        // A folder taken out and added again runs its tasks again.
        const keys = new Set(folders.map((f) => pathKey(f.path)));
        for (const k of [...ranFolders]) if (!keys.has(k)) ranFolders.delete(k);
        const fresh = folders.filter((f) => !ranFolders.has(pathKey(f.path)));
        if (!fresh.length) return undefined;
        const first = ranFolders.size === 0;
        for (const f of fresh) ranFolders.add(pathKey(f.path));
        const isFresh = (t: TaskDefinition) =>
          t.folderName === undefined
            ? first
            : fresh.some((f) => !!t.workspaceFolder && samePath(f.path, t.workspaceFolder));
        void load()
          .then(async (all) => {
            for (const t of all.filter((x) => x.runOnFolderOpen && isFresh(x)))
              await runner
                .run(t, all, { kind: "user" }, false)
                .catch((err: unknown) =>
                  notifications.show(
                    "error",
                    `Task "${t.label}" didn't start: ${err instanceof Error ? err.message : String(err)}`,
                  ),
                );
          })
          .catch(() => {});
        return undefined;
      }),
    );
  },
};
