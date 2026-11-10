// Dev containers (D266, VS Code's Dev Containers and the containers.dev spec): a folder's
// `.devcontainer/devcontainer.json` says which container to develop in. This reads it (JSONC,
// `${localWorkspaceFolder}`-style variables) and plans the docker commands that bring the
// container up: find the folder's container by label, build its Dockerfile, run it with the
// folder mounted, its lifecycle commands. The window then works inside it like an SSH remote
// (`container:<user@id>`). Docker Compose and features need the devcontainers CLI, which is used
// when it's installed. DOM-free and unit-tested.

import { basename, dirname, isAbsolute, joinPath } from "../paths/index";
import { parseJsonc } from "../settings/jsonc";

/** Where a folder's configuration can be, relative to it (VS Code's order). */
export const CONFIG_FILES = [".devcontainer/devcontainer.json", ".devcontainer.json"] as const;

/** A lifecycle command: a shell line, an argv, or several run in parallel by name. */
export type LifecycleCommand = string | string[] | Record<string, string | string[]>;

export interface DevContainerConfig {
  name?: string;
  image?: string;
  build?: {
    dockerfile: string;
    context: string;
    args: Record<string, string>;
    target?: string;
  };
  dockerComposeFile?: string[];
  service?: string;
  /** The folder in the container (default `/workspaces/<folder name>`). */
  workspaceFolder: string;
  /** `--mount` for the folder (default: a bind mount of it on workspaceFolder). */
  workspaceMount: string;
  mounts: string[];
  forwardPorts: number[];
  containerEnv: Record<string, string>;
  remoteEnv: Record<string, string>;
  /** Who the IDE's server, terminals and commands run as (default: the image's user). */
  remoteUser?: string;
  containerUser?: string;
  runArgs: string[];
  /** Keep it running with a sleep loop instead of its own command (default true). */
  overrideCommand: boolean;
  features: Record<string, unknown>;
  initializeCommand?: LifecycleCommand;
  onCreateCommand?: LifecycleCommand;
  updateContentCommand?: LifecycleCommand;
  postCreateCommand?: LifecycleCommand;
  postStartCommand?: LifecycleCommand;
  postAttachCommand?: LifecycleCommand;
}

/** Values `${…}` in the configuration stands for. */
export interface ConfigContext {
  /** The local folder (absolute). */
  localWorkspaceFolder: string;
  /** The configuration file (absolute), for relative Dockerfile and context paths. */
  configFile: string;
  /** This machine's environment (`${localEnv:NAME}`). */
  env: Record<string, string | undefined>;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const stringMap = (v: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(obj(v)).flatMap(([k, x]) =>
      typeof x === "string" || typeof x === "number" || typeof x === "boolean"
        ? [[k, String(x)]]
        : [],
    ),
  );

function lifecycle(v: unknown): LifecycleCommand | undefined {
  if (typeof v === "string") return v.trim() ? v : undefined;
  if (Array.isArray(v)) return strings(v).length ? strings(v) : undefined;
  const named = Object.entries(obj(v)).flatMap(([k, x]) =>
    typeof x === "string" || Array.isArray(x) ? [[k, typeof x === "string" ? x : strings(x)]] : [],
  );
  return named.length
    ? (Object.fromEntries(named) as Record<string, string | string[]>)
    : undefined;
}

/** `${localWorkspaceFolder}`, `${localWorkspaceFolderBasename}`, `${containerWorkspaceFolder}`… */
export function substitute(
  text: string,
  ctx: ConfigContext,
  containerWorkspaceFolder = "",
): string {
  return text.replace(/\$\{([^}]+)\}/g, (all, name: string) => {
    if (name === "localWorkspaceFolder") return ctx.localWorkspaceFolder;
    if (name === "localWorkspaceFolderBasename") return basename(ctx.localWorkspaceFolder);
    if (name === "containerWorkspaceFolder") return containerWorkspaceFolder;
    if (name === "containerWorkspaceFolderBasename")
      return containerWorkspaceFolder.split("/").filter(Boolean).pop() ?? "";
    const env = /^localEnv:([^:]+)(?::(.*))?$/.exec(name);
    if (env?.[1]) return ctx.env[env[1]] ?? env[2] ?? "";
    // `${containerEnv:…}` is the container's: left for the container to read.
    return all;
  });
}

/** Every string in `v` with its variables filled in. */
function deep<T>(v: T, fill: (s: string) => string): T {
  if (typeof v === "string") return fill(v) as T;
  if (Array.isArray(v)) return v.map((x) => deep(x, fill)) as T;
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, deep(x, fill)]),
    ) as T;
  return v;
}

/** A path from the configuration: relative ones are to the configuration file's folder. */
function fromConfig(path: string, ctx: ConfigContext): string {
  if (isAbsolute(path)) return path;
  const base = dirname(ctx.configFile);
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  const parts = joinPath(base, path).split(/[\\/]/);
  const out: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    // Never above the root ("C:" or "" before the first separator).
    if (part === ".." && out.length > 1) out.pop();
    else if (part !== "..") out.push(part);
  }
  return out.join(sep);
}

/** The configuration, with defaults and variables filled in; `errors` say what's wrong. */
export function parseDevContainer(
  text: string,
  ctx: ConfigContext,
): { config: DevContainerConfig | null; errors: string[] } {
  const parsed = parseJsonc(text);
  if (!parsed.ok)
    return {
      config: null,
      errors: [
        `${parsed.error.message} (line ${parsed.error.line}, column ${parsed.error.column})`,
      ],
    };
  const raw = obj(parsed.value);
  const errors: string[] = [];
  const folderName = basename(ctx.localWorkspaceFolder);
  // The container's folder first: other values may name it.
  const workspaceFolder = substitute(str(raw.workspaceFolder) ?? `/workspaces/${folderName}`, ctx);
  const fill = (s: string) => substitute(s, ctx, workspaceFolder);
  const r = deep(raw, fill);
  const build = obj(r.build);
  const dockerfile = str(build.dockerfile) ?? str(r.dockerFile);
  const compose = r.dockerComposeFile;
  const config: DevContainerConfig = {
    ...(str(r.name) && { name: str(r.name) }),
    ...(str(r.image) && { image: str(r.image) }),
    ...(dockerfile && {
      build: {
        dockerfile: fromConfig(dockerfile, ctx),
        context: fromConfig(str(build.context) ?? str(r.context) ?? ".", ctx),
        args: stringMap(build.args),
        ...(str(build.target) && { target: str(build.target) }),
      },
    }),
    ...(compose !== undefined && {
      dockerComposeFile: (typeof compose === "string" ? [compose] : strings(compose)).map((f) =>
        fromConfig(f, ctx),
      ),
    }),
    ...(str(r.service) && { service: str(r.service) }),
    workspaceFolder,
    workspaceMount:
      str(r.workspaceMount) ??
      `type=bind,source=${ctx.localWorkspaceFolder},target=${workspaceFolder},consistency=cached`,
    mounts: (Array.isArray(r.mounts) ? r.mounts : []).flatMap((m) => {
      if (typeof m === "string") return [m];
      const o = obj(m);
      const target = str(o.target);
      if (!target) return [];
      return [
        [
          `type=${str(o.type) ?? "volume"}`,
          str(o.source) && `source=${str(o.source)}`,
          `target=${target}`,
        ]
          .filter(Boolean)
          .join(","),
      ];
    }),
    forwardPorts: (Array.isArray(r.forwardPorts) ? r.forwardPorts : []).flatMap((p) => {
      // "db:5432" (a Compose service's port) is the CLI's business; a number is forwarded here.
      const n = typeof p === "number" ? p : Number(String(p).split(":").pop());
      return Number.isInteger(n) && n > 0 && n < 65536 ? [n] : [];
    }),
    containerEnv: stringMap(r.containerEnv),
    remoteEnv: stringMap(r.remoteEnv),
    ...(str(r.remoteUser) && { remoteUser: str(r.remoteUser) }),
    ...(str(r.containerUser) && { containerUser: str(r.containerUser) }),
    runArgs: strings(r.runArgs),
    overrideCommand: r.overrideCommand !== false,
    features: obj(r.features),
  };
  for (const key of [
    "initializeCommand",
    "onCreateCommand",
    "updateContentCommand",
    "postCreateCommand",
    "postStartCommand",
    "postAttachCommand",
  ] as const) {
    const c = lifecycle(r[key]);
    if (c) config[key] = c;
  }
  if (!config.image && !config.build && !config.dockerComposeFile)
    errors.push(
      'It names no container: add "image", "build": { "dockerfile" } or "dockerComposeFile".',
    );
  if (!config.workspaceFolder.startsWith("/"))
    errors.push(
      `"workspaceFolder" must be an absolute path in the container (${config.workspaceFolder}).`,
    );
  return { config: errors.length ? null : config, errors };
}

/** Why the devcontainers CLI is needed (Compose, features), or null when docker alone does. */
export function needsCli(config: DevContainerConfig): string | null {
  if (config.dockerComposeFile?.length) return "Docker Compose configurations";
  if (Object.keys(config.features).length) return "features";
  return null;
}

/** The labels that find a folder's container again (VS Code's names, so either finds it). */
export function containerLabels(localFolder: string, configFile: string): string[] {
  return [`devcontainer.local_folder=${localFolder}`, `devcontainer.config_file=${configFile}`];
}

/** A short stable hash (FNV-1a) of a local folder: its image's name. */
function folderHash(path: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The image a Dockerfile configuration builds (`vsc-<folder>-<hash>`, as VS Code names them). */
export function imageName(localFolder: string): string {
  const name =
    basename(localFolder)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "") || "folder";
  return `vsc-${name.slice(0, 60)}-${folderHash(localFolder)}`;
}

/** `docker build` for a Dockerfile configuration. */
export function buildArgs(config: DevContainerConfig, image: string): string[] | null {
  const b = config.build;
  if (!b) return null;
  return [
    "build",
    "-f",
    b.dockerfile,
    "-t",
    image,
    ...Object.entries(b.args).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]),
    ...(b.target ? ["--target", b.target] : []),
    b.context,
  ];
}

/** The sleep loop that keeps a container up when its own command is overridden (VS Code's). */
const KEEP_ALIVE =
  'echo Container started; trap "exit 0" 15; while sleep 1000 & wait $!; do :; done';

/** `docker run` for the folder's new container (detached, labelled, the folder mounted). */
export function runArgs(
  config: DevContainerConfig,
  image: string,
  labels: readonly string[],
): string[] {
  return [
    "run",
    "-d",
    ...labels.flatMap((l) => ["--label", l]),
    "--mount",
    config.workspaceMount,
    ...config.mounts.flatMap((m) => ["--mount", m]),
    ...Object.entries(config.containerEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...(config.containerUser ? ["-u", config.containerUser] : []),
    ...config.runArgs,
    ...(config.overrideCommand ? ["--entrypoint", "/bin/sh", image, "-c", KEEP_ALIVE] : [image]),
  ];
}

/** `docker exec` arguments that run a lifecycle command in the folder, as the remote user. */
export function execArgs(
  config: DevContainerConfig,
  container: string,
  command: LifecycleCommand,
): string[][] {
  const base = [
    "exec",
    ...(config.remoteUser ? ["-u", config.remoteUser] : []),
    "-w",
    config.workspaceFolder,
    ...Object.entries(config.remoteEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    container,
  ];
  const one = (c: string | string[]) =>
    typeof c === "string" ? [...base, "/bin/sh", "-c", c] : [...base, ...c];
  if (typeof command === "string" || Array.isArray(command)) return [one(command)];
  return Object.values(command).map(one);
}

/** `docker ps` that lists the folder's container: `<id>\t<state>`. */
export function findArgs(labels: readonly string[]): string[] {
  return [
    "ps",
    "-a",
    ...labels.flatMap((l) => ["--filter", `label=${l}`]),
    "--format",
    "{{.ID}}\t{{.State}}",
  ];
}

/** The first container `docker ps` (findArgs) listed. */
export function parseFound(stdout: string): { id: string; running: boolean } | null {
  for (const line of stdout.split(/\r?\n/)) {
    const [id, state] = line.trim().split("\t");
    if (id && /^[0-9a-f]{6,64}$/i.test(id)) return { id, running: state === "running" };
  }
  return null;
}

/** The container id `docker run -d` printed (its last line). */
export function parseRunId(stdout: string): string | null {
  const last = stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
  return /^[0-9a-f]{12,64}$/i.test(last) ? last : null;
}

/** What `devcontainer up` (the devcontainers CLI) answered: its last JSON line. */
export function parseCliUp(
  stdout: string,
):
  | { containerId: string; remoteUser?: string; remoteWorkspaceFolder?: string }
  | { error: string } {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      if (o.outcome === "success" && typeof o.containerId === "string")
        return {
          containerId: o.containerId,
          ...(typeof o.remoteUser === "string" && { remoteUser: o.remoteUser }),
          ...(typeof o.remoteWorkspaceFolder === "string" && {
            remoteWorkspaceFolder: o.remoteWorkspaceFolder,
          }),
        };
      if (o.outcome === "error")
        return { error: String(o.message ?? o.description ?? "devcontainer up failed.") };
    } catch {
      // Not its answer: build output that looks like JSON.
    }
  }
  return { error: "devcontainer up didn't say which container it started." };
}

/** The window's remote for a container: `container:<user@id>` (the host part). */
export function containerHost(id: string, user?: string): string {
  const short = id.slice(0, 12);
  return user && /^[A-Za-z0-9._-]+$/.test(user) ? `${user}@${short}` : short;
}

/** A running container `docker ps` listed, for Attach to running container. */
export interface RunningContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  /** The local folder it was made for (its devcontainer.local_folder label), if any. */
  localFolder?: string;
}

/** `docker ps` for Attach: one JSON object per line. */
export const LIST_ARGS = ["ps", "--format", "{{json .}}"];

export function parseContainerList(stdout: string): RunningContainer[] {
  const out: RunningContainer[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const id = str(o.ID);
      if (!id || !/^[0-9a-f]{6,64}$/i.test(id)) continue;
      const labels = str(o.Labels) ?? "";
      const local = /(?:^|,)devcontainer\.local_folder=([^,]*)/.exec(labels)?.[1];
      out.push({
        id,
        name: (str(o.Names) ?? id).split(",")[0] ?? id,
        image: str(o.Image) ?? "",
        status: str(o.Status) ?? "",
        ...(local && { localFolder: local }),
      });
    } catch {
      // A line docker didn't write as JSON.
    }
  }
  return out;
}
