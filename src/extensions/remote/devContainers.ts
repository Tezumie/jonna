// Dev containers (D266, VS Code's Dev Containers): Reopen in container brings up the folder's
// container (src/core/workspace/devContainer.ts plans it; docker or the devcontainers CLI runs
// it, src-tauri/src/remote/docker.rs) and this window then works inside it as a remote
// (`container:<user@id>`, the same server as SSH windows, started with `docker exec`). Also
// Rebuild container, Reopen folder locally, Attach to running container, the notice on opening
// a folder that has a configuration, and the containers' log.

import { fsIpc } from "../../core/ipc/fs";
import { execIpc } from "../../core/ipc/process";
import { remoteIpc } from "../../core/ipc/remote";
import type { DisposableStore } from "../../core/lifecycle/index";
import { joinPath } from "../../core/paths/index";
import { signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import {
  buildArgs,
  CONFIG_FILES,
  containerHost,
  containerLabels,
  type DevContainerConfig,
  execArgs,
  findArgs,
  imageName,
  LIST_ARGS,
  type LifecycleCommand,
  needsCli,
  parseCliUp,
  parseContainerList,
  parseDevContainer,
  parseFound,
  parseRunId,
  runArgs,
} from "../../core/workspace/devContainer";
import type { RemoteAuthority } from "../../core/workspace/remoteLocation";
import type { WorkbenchServices } from "../../workbench/services";

/** This window's container (once it's in one): what it was made from. */
export const devContainer = signal<{
  id: string;
  localFolder?: string;
  configFile?: string;
} | null>(null);

/** What a bring-up is doing now (the status bar shows it), null when nothing is. */
const step = signal<string | null>(null);

const MAX_LOG = 5000;
const log: string[] = [];
const addLog = (line: string) => {
  log.push(line);
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
};

/** Runs docker; a failure says the end of what it printed. */
async function docker(
  args: readonly string[],
  opts: { cwd?: string; tool?: "docker" | "devcontainer"; ok?: boolean } = {},
): Promise<{ code: number | null; stdout: string }> {
  const tool = opts.tool ?? "docker";
  addLog(`> ${tool} ${args.join(" ")}`);
  const tail: string[] = [];
  const r = await remoteIpc.docker(tool, args, opts.cwd ?? null, (line) => {
    addLog(line);
    tail.push(line);
    if (tail.length > 6) tail.shift();
  });
  if (opts.ok !== false && r.code !== 0)
    throw new Error(
      `${tool} ${args[0] ?? ""} failed${r.code === null ? "" : ` (exit code ${r.code})`}: ${tail.join(" ").slice(-500) || "no output"}`,
    );
  return r;
}

/** The folder's configuration file: the first VS Code looks for, or one under .devcontainer/<name>/. */
export async function findConfig(folder: string): Promise<string | null> {
  for (const rel of CONFIG_FILES) {
    const path = joinPath(folder, rel);
    if (
      await fsIpc.stat(path).then(
        (st) => st.kind === "file",
        () => false,
      )
    )
      return path;
  }
  const dir = joinPath(folder, ".devcontainer");
  const entries = await fsIpc.listDir(dir).catch(() => []);
  for (const e of entries) {
    if (e.kind !== "dir") continue;
    const path = joinPath(joinPath(dir, e.name), "devcontainer.json");
    if (
      await fsIpc.stat(path).then(
        (st) => st.kind === "file",
        () => false,
      )
    )
      return path;
  }
  return null;
}

async function readConfig(folder: string, file: string): Promise<DevContainerConfig> {
  const text = new TextDecoder().decode(await fsIpc.read(file));
  const env: Record<string, string> = {};
  const { config, errors } = parseDevContainer(text, {
    localWorkspaceFolder: folder,
    configFile: file,
    env,
  });
  if (!config) throw new Error(`${file}: ${errors.join(" ")}`);
  return config;
}

/** A lifecycle command's runs (several at once when it names them), as VS Code runs them. */
async function lifecycle(
  config: DevContainerConfig,
  id: string,
  name: string,
  command: LifecycleCommand | undefined,
): Promise<void> {
  if (!command) return;
  step.value = `Running ${name}`;
  await Promise.all(execArgs(config, id, command).map((args) => docker(args)));
}

/** Brings the folder's container up: found again by its labels, else built and started. */
async function up(
  folder: string,
  file: string,
  config: DevContainerConfig,
  rebuild: boolean,
): Promise<{ id: string; user?: string; workspaceFolder: string }> {
  const cliNeeded = needsCli(config);
  const [hasCli] = await execIpc.installed(["devcontainer"]).catch(() => [false]);
  if (cliNeeded && !hasCli)
    throw new Error(
      `${cliNeeded} need the devcontainers CLI: install it with "npm install -g @devcontainers/cli", then try again.`,
    );
  if (config.initializeCommand) {
    // On this machine, before anything else (VS Code's initializeCommand).
    step.value = "Running initializeCommand";
    const line =
      typeof config.initializeCommand === "string"
        ? config.initializeCommand
        : Array.isArray(config.initializeCommand)
          ? config.initializeCommand.join(" ")
          : Object.values(config.initializeCommand)
              .map((c) => (typeof c === "string" ? c : c.join(" ")))
              .join(" && ");
    addLog(`> ${line}`);
    const r = await execIpc.run(`devc-init-${Date.now()}`, line, { cwd: folder }, addLog);
    if (r.exitCode !== 0) throw new Error(`initializeCommand failed (exit code ${r.exitCode}).`);
  }
  if (hasCli) {
    // The devcontainers CLI (the spec's reference): features, Compose, the image's metadata.
    step.value = "Starting the dev container";
    const r = await docker(
      [
        "up",
        "--workspace-folder",
        folder,
        "--config",
        file,
        ...(rebuild ? ["--remove-existing-container"] : []),
      ],
      { tool: "devcontainer", ok: false },
    );
    const answer = parseCliUp(r.stdout);
    if ("error" in answer) throw new Error(answer.error);
    return {
      id: answer.containerId.slice(0, 12),
      ...((answer.remoteUser ?? config.remoteUser) && {
        user: answer.remoteUser ?? config.remoteUser,
      }),
      workspaceFolder: answer.remoteWorkspaceFolder ?? config.workspaceFolder,
    };
  }
  const labels = containerLabels(folder, file);
  step.value = "Looking for the folder's container";
  let found = parseFound((await docker(findArgs(labels))).stdout);
  if (found && rebuild) {
    step.value = "Removing the old container";
    await docker(["rm", "-f", found.id]);
    found = null;
  }
  const user = config.remoteUser ?? config.containerUser;
  // docker ps's short ids, whichever way the container was found.
  const result = (id: string) => ({
    id: id.slice(0, 12),
    ...(user && { user }),
    workspaceFolder: config.workspaceFolder,
  });
  if (found) {
    if (!found.running) {
      step.value = "Starting the container";
      await docker(["start", found.id]);
      await lifecycle(config, found.id, "postStartCommand", config.postStartCommand);
    }
    return result(found.id);
  }
  let image = config.image ?? "";
  const build = buildArgs(config, imageName(folder));
  if (build) {
    step.value = "Building the image";
    image = imageName(folder);
    await docker(build, { cwd: folder });
  }
  step.value = "Starting the container";
  const run = await docker(runArgs(config, image, labels), { cwd: folder });
  const id = parseRunId(run.stdout);
  if (!id) throw new Error("docker run didn't say which container it started.");
  await lifecycle(config, id, "onCreateCommand", config.onCreateCommand);
  await lifecycle(config, id, "updateContentCommand", config.updateContentCommand);
  await lifecycle(config, id, "postCreateCommand", config.postCreateCommand);
  await lifecycle(config, id, "postStartCommand", config.postStartCommand);
  return result(id);
}

/** The labels a container was made with (its local folder and configuration). */
async function containerOrigin(id: string): Promise<{ localFolder?: string; configFile?: string }> {
  const r = await docker(["inspect", "--format", "{{json .Config.Labels}}", id], { ok: false });
  try {
    const labels = JSON.parse(r.stdout.trim() || "{}") as Record<string, string> | null;
    return {
      ...(labels?.["devcontainer.local_folder"] && {
        localFolder: labels["devcontainer.local_folder"],
      }),
      ...(labels?.["devcontainer.config_file"] && {
        configFile: labels["devcontainer.config_file"],
      }),
    };
  } catch {
    return {};
  }
}

export function registerDevContainers(
  sub: DisposableStore,
  services: WorkbenchServices,
  deps: {
    /** Connects this window (no folder open) to a remote. */
    connect(authority: RemoteAuthority): Promise<unknown>;
    /** This window's remote, if it has one. */
    current(): RemoteAuthority | null;
    /** Closes the remote's folder and the connection (false: the user kept the folder). */
    disconnect(): Promise<boolean>;
  },
): void {
  const { dispatcher, notifications, workspace, statusBar, settings, quickInput } = services;
  const dockerPath = () => settings.peek<string>("remote.containers.dockerPath") || null;
  /** Each docker run uses the setting's program (the transport too). */
  const useSetting = () => remoteIpc.setDocker(dockerPath()).catch(() => {});

  /** Leaves the local folder and works in container `id`'s `folder`. */
  const enter = async (
    id: string,
    user: string | undefined,
    folder: string | null,
    origin: { localFolder?: string; configFile?: string },
  ) => {
    if (workspace.root.peek() && !(await workspace.close())) return false;
    step.value = "Connecting to the container";
    await deps.connect({ kind: "container", host: containerHost(id, user) });
    devContainer.value = { id, ...origin };
    if (folder) await workspace.open(folder);
    return true;
  };

  const reopen = async (folder: string, rebuild: boolean) => {
    await useSetting();
    const file = await findConfig(folder);
    if (!file)
      throw new Error(
        `${folder} has no dev container configuration (.devcontainer/devcontainer.json or .devcontainer.json).`,
      );
    const config = await readConfig(folder, file);
    // The configuration runs the folder's commands (initializeCommand on this computer, docker's
    // runArgs and mounts): only for a trusted folder, as tasks and VS Code's Dev Containers.
    await services.trust.require("The dev container configuration");
    addLog(`· ${rebuild ? "rebuilding" : "opening"} ${folder} in a container (${file})`);
    try {
      const c = await up(folder, file, config, rebuild);
      const entered = await enter(c.id, c.user, c.workspaceFolder, {
        localFolder: folder,
        configFile: file,
      });
      if (!entered) return { container: c.id, opened: null };
      // Its ports, and postAttachCommand once the window is in it.
      for (const port of config.forwardPorts)
        await dispatcher.execute("remote.forwardPort", { port }).catch(() => {});
      await lifecycle(config, c.id, "postAttachCommand", config.postAttachCommand).catch(
        (err: unknown) => addLog(`postAttachCommand: ${String(err)}`),
      );
      return { container: c.id, opened: c.workspaceFolder };
    } finally {
      step.value = null;
    }
  };

  sub.add(
    dispatcher.register({
      id: "remote.reopenInContainer",
      title: "Reopen in container",
      category: "Dev containers",
      description:
        "Opens the folder in its dev container (VS Code's Reopen in Container, D266): reads .devcontainer/devcontainer.json, finds the folder's container or builds (Dockerfile) and starts it (image), runs its lifecycle commands, then this window works inside it (files, terminals, git, tasks, language servers, the agent's commands) and forwards its forwardPorts. Needs Docker; Compose and features need the devcontainers CLI. `folder`: a local folder (default the open one); `rebuild`: a new container from scratch.",
      input: s.object({
        folder: s.string().describe("A local folder (default: the open folder)").optional(),
        rebuild: s.boolean().optional(),
      }),
      effects: ["exec"],
      agent: "hidden",
      run: async ({ folder, rebuild }) => {
        if (deps.current()) throw new Error("This window is already on a remote.");
        const local = folder ?? workspace.root.peek();
        if (!local) throw new Error("Open a folder with a dev container configuration first.");
        return reopen(local, !!rebuild);
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "remote.rebuildContainer",
      title: "Rebuild container",
      category: "Dev containers",
      description:
        "Builds the folder's dev container again from its configuration (after changing devcontainer.json or its Dockerfile) and reopens the window in the new one. Works from the container's window or the local folder's.",
      input: s.empty(),
      effects: ["exec"],
      agent: "hidden",
      run: async () => {
        const authority = deps.current();
        if (!authority) {
          const local = workspace.root.peek();
          if (!local) throw new Error("Open a folder with a dev container configuration first.");
          return reopen(local, true);
        }
        if (authority.kind !== "container") throw new Error("This window isn't in a container.");
        const origin = devContainer.peek() ?? { id: authority.host.split("@").pop() ?? "" };
        const localFolder = origin.localFolder ?? (await containerOrigin(origin.id)).localFolder;
        if (!localFolder)
          throw new Error("This container wasn't made from a local folder's configuration.");
        if (!(await deps.disconnect())) return { opened: null };
        devContainer.value = null;
        return reopen(localFolder, true);
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "remote.reopenLocally",
      title: "Reopen folder locally",
      category: "Dev containers",
      description:
        "Leaves the dev container: this window opens the local folder it was made from again (the container keeps running).",
      input: s.empty(),
      effects: [],
      when: "remoteName == container",
      agent: "hidden",
      run: async () => {
        const authority = deps.current();
        if (authority?.kind !== "container") throw new Error("This window isn't in a container.");
        const origin = devContainer.peek() ?? { id: authority.host.split("@").pop() ?? "" };
        const localFolder = origin.localFolder ?? (await containerOrigin(origin.id)).localFolder;
        if (!(await deps.disconnect())) return { opened: null };
        devContainer.value = null;
        if (localFolder) await workspace.open(localFolder);
        return { opened: localFolder ?? null };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "remote.attachToContainer",
      title: "Attach to running container…",
      category: "Dev containers",
      description:
        "Works inside a running container (VS Code's Attach to Running Container): `container` (an id or name; default: pick from docker ps), `folder` an absolute folder in it (default: pick one).",
      input: s.object({
        container: s.string().optional(),
        folder: s.string().describe("Absolute path in the container").optional(),
      }),
      effects: ["exec"],
      agent: "hidden",
      run: async ({ container, folder }) => {
        if (deps.current()) throw new Error("This window is already on a remote.");
        await useSetting();
        let id = container;
        if (!id) {
          const list = parseContainerList((await docker(LIST_ARGS)).stdout);
          if (!list.length) throw new Error("No container is running (docker ps lists none).");
          const picked = await quickInput.pick(
            list.map((c) => ({
              id: c.id,
              label: c.name,
              description: `${c.image} · ${c.status}`,
              ...(c.localFolder && { detail: c.localFolder }),
              icon: "box" as const,
            })),
            { placeholder: "Select a running container" },
          );
          if (!picked) return { attached: null };
          id = picked.id;
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`"${id}" isn't a container.`);
        try {
          const origin = await containerOrigin(id);
          if (!(await enter(id, undefined, folder ?? null, origin))) return { attached: null };
        } finally {
          step.value = null;
        }
        if (!folder) await dispatcher.execute("remote.openFolder", {}).catch(() => {});
        return { attached: id };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "remote.showContainerLog",
      title: "Show the dev containers log",
      category: "Dev containers",
      description:
        "What docker and the devcontainers CLI printed while bringing containers up (builds, lifecycle commands, errors).",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: async () => {
        const text = log.join("\n");
        await dispatcher
          .execute("workspace.newUntitledFile", { content: text, language: "log" })
          .catch(() =>
            notifications.show("info", text.slice(-2000) || "Nothing logged yet.", {
              title: "Dev containers",
            }),
          );
        return { lines: log.length };
      },
    }),
  );

  // What a bring-up is doing (it can take minutes the first time); a click shows the log.
  sub.add(
    statusBar.add({
      id: "remote.containerProgress",
      name: "Dev container progress",
      alignment: "left",
      priority: 100,
      text: () => (step.value ? `$(box) ${step.value}…` : ""),
      tooltip: () => (step.value ? "Dev container: show the log" : ""),
      command: "remote.showContainerLog",
    }),
  );

  // A local folder with a configuration: offered once per folder (VS Code's notice).
  const offered = new Set<string>();
  sub.add(
    workspace.onDidOpen((folder) => {
      if (deps.current() || offered.has(folder)) return;
      if (settings.peek<boolean>("remote.containers.showReopenNotice") === false) return;
      offered.add(folder);
      void (async () => {
        const file = await findConfig(folder);
        services.context.set("devContainerConfig", !!file);
        if (!file) return;
        const [hasDocker] = await execIpc.installed(["docker"]).catch(() => [false]);
        if (!hasDocker && !dockerPath()) return;
        notifications.show(
          "info",
          "This folder has a dev container configuration: reopen it to develop in the container.",
          {
            title: "Dev containers",
            actions: [
              {
                label: "Reopen in container",
                run: () =>
                  void dispatcher.execute("remote.reopenInContainer", {}).catch((err: unknown) =>
                    notifications.show(
                      "error",
                      `Couldn't open the dev container: ${err instanceof Error ? err.message : String(err)}`,
                      {
                        title: "Dev containers",
                        actions: [
                          {
                            label: "Show log",
                            run: () =>
                              void dispatcher.execute("remote.showContainerLog").catch(() => {}),
                          },
                        ],
                      },
                    ),
                  ),
              },
              {
                label: "Don't show again",
                run: () =>
                  void settings.update("remote.containers.showReopenNotice", false).catch(() => {}),
              },
            ],
          },
        );
      })().catch(() => {});
    }),
  );
}
