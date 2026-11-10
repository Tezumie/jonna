// External agents from the ACP agent registry (D215, agentclientprotocol/registry): the gallery
// on the Models page lists them; installing one makes it an external agent (`acp/<name>` in the
// model menu) like the four presets. The list is the bundled snapshot
// (src/assets/acp-registry, scripts/gen-acp-registry.mjs), then the copy fetched last time, then
// the registry's CDN when the gallery opens or on agent.registry.refresh (all through Rust).
// - npx / uvx agents run through npx / uvx (Node.js / uv must be there; nothing is downloaded
//   until the agent first starts, by npx / uvx themselves).
// - Binary agents are downloaded for this platform into the app data folder, checked against the
//   registry's SHA-256 when it gives one, and unpacked safely (src-tauri/src/acp_agents).
// - One whose program is already on PATH (cursor-agent, kimi, goose…) can use that instead.
// Installing always asks: the dialog (or, for the agent, a card in its chat that even full
// access doesn't skip) names where it comes from, its license and whether it's checksum-verified.
// Installed agents are kept in the global state (`acpAgents`), read by externalAgents().
// Commands: agent.registry.list / refresh / install / uninstall / cancelInstall / details / browse.
// State: ide://agent/registry.
import snapshot from "../../assets/acp-registry/registry.json";
import {
  agentDisplayName,
  allowedUrl,
  chooseRun,
  compareVersions,
  filterAgents,
  type InstalledAgent,
  type ParsedRegistry,
  PRESET_REGISTRY_IDS,
  packageLaunch,
  parseRegistry,
  pathProgram,
  REGISTRY_PLATFORMS,
  type RegistryAgent,
  type RegistryPlatform,
  type RunChoice,
  sanitizeSvg,
} from "../../core/acp/registry";
import type { Caller } from "../../core/dispatcher/types";
import { type AgentInstallProgress, acpAgentsIpc } from "../../core/ipc/acpAgents";
import { execIpc } from "../../core/ipc/process";
import type { DisposableStore } from "../../core/lifecycle/index";
import { signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { confirmAction } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import { ACP_PRESETS } from "./acpAgents";
import { openCustomize } from "./customize";
import type { SessionManager } from "./sessions";

export type RegistrySource = "bundled" | "cached" | "registry";

/** The registry's agents that are the built-in presets, by registry id → preset name. */
const PRESET_BY_ID = new Map(Object.entries(PRESET_REGISTRY_IDS).map(([name, id]) => [id, name]));

export function presetFor(id: string): string | undefined {
  return PRESET_BY_ID.get(id);
}

const BUNDLED: ParsedRegistry = (() => {
  try {
    return parseRegistry(snapshot);
  } catch {
    return { version: "", agents: [], skipped: [] };
  }
})();

const bundledIcon = (id: string) => BUNDLED.agents.find((a) => a.id === id)?.icon;

/** Agents installed from the registry (global state), by id. */
export function installedAgents(services: WorkbenchServices): Record<string, InstalledAgent> {
  return services.persistence.globalState().acpAgents ?? {};
}

const isLoopback = (url: string) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);

/** What the gallery and the commands share: the list, where it's from, installs under way. */
export class AcpRegistryState {
  readonly agents = signal<RegistryAgent[]>(BUNDLED.agents);
  readonly source = signal<RegistrySource>("bundled");
  readonly fetchedAt = signal<number | null>(null);
  readonly error = signal<string | null>(null);
  readonly skipped = signal<ParsedRegistry["skipped"]>(BUNDLED.skipped);
  readonly refreshing = signal(false);
  readonly platform = signal<RegistryPlatform | null>(null);
  /** npx and uvx found (null: not looked yet). */
  readonly runtimes = signal<{ npx: boolean; uvx: boolean } | null>(null);
  /** Programs of binary agents found on PATH. */
  readonly onPath = signal<ReadonlyMap<string, boolean>>(new Map());
  readonly installing = signal<ReadonlyMap<string, AgentInstallProgress>>(new Map());
  /** Bumped when the installed set changes (the global state isn't a signal). */
  readonly installedVersion = signal(0);
  /** Cards showing their details. */
  readonly expanded = signal<ReadonlySet<string>>(new Set());
  /** Asks the gallery to focus its search box (agent.registry.browse). */
  readonly focusSearch = signal(false);
  private loaded: Promise<void> | null = null;
  private refreshed: Promise<void> | null = null;
  private detected: Promise<void> | null = null;

  constructor(private readonly services: WorkbenchServices) {}

  /** The copy fetched last time, once per window (the bundled list until then). */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      const text = await acpAgentsIpc.cachedRegistry().catch(() => null);
      if (!text || this.source.peek() === "registry") return;
      try {
        this.apply(parseRegistry(JSON.parse(text)), "cached");
      } catch {
        // A damaged cache: the bundled list stays.
      }
    })();
    return this.loaded;
  }

  /** The gallery opened: fetched once per window, unless asked again (agent.registry.refresh). */
  refreshOnce(): Promise<void> {
    this.refreshed ??= this.refresh().catch(() => {});
    return this.refreshed;
  }

  async refresh(url?: string): Promise<void> {
    // Asked for (a command): the gallery opening later doesn't fetch it again.
    this.refreshed ??= Promise.resolve();
    this.refreshing.value = true;
    try {
      const text = await acpAgentsIpc.fetchRegistry(url);
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error("The registry's answer isn't JSON.");
      }
      // A local registry (test builds' only) may list local downloads.
      this.apply(parseRegistry(raw, { allowLoopback: !!url && isLoopback(url) }), "registry");
      this.error.value = null;
      this.fetchedAt.value = Date.now();
      void this.fetchIcons();
    } catch (err) {
      await this.load();
      this.error.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.refreshing.value = false;
    }
  }

  private apply(parsed: ParsedRegistry, source: RegistrySource): void {
    // The published registry links its icons: the bundled one is used when there is one.
    this.agents.value = parsed.agents.map((a) => {
      const icon = a.icon ?? bundledIcon(a.id);
      return icon ? { ...a, icon } : a;
    });
    this.skipped.value = parsed.skipped;
    this.source.value = source;
  }

  /** Icons of agents the bundled list doesn't have, fetched (and cached) by the native side. */
  private async fetchIcons(): Promise<void> {
    for (const agent of this.agents.peek()) {
      if (agent.icon || !agent.iconUrl || !allowedUrl(agent.iconUrl, isLoopback(agent.iconUrl)))
        continue;
      const svg = await acpAgentsIpc.icon(agent.id, agent.iconUrl).catch(() => null);
      const icon = svg ? sanitizeSvg(svg) : null;
      if (!icon) continue;
      this.agents.value = this.agents.peek().map((a) => (a.id === agent.id ? { ...a, icon } : a));
    }
  }

  /** The platform, npx / uvx, and the binary agents' programs on PATH; once, or again. */
  detect(again = false): Promise<void> {
    if (again || !this.detected)
      this.detected = (async () => {
        const platform = await acpAgentsIpc.platform().catch(() => null);
        this.platform.value = (REGISTRY_PLATFORMS as readonly string[]).includes(platform ?? "")
          ? (platform as RegistryPlatform)
          : null;
        const here = this.platform.peek();
        const programs = [
          ...new Set(
            this.agents
              .peek()
              .map((a) => {
                const t = here ? a.distribution.binary?.[here] : undefined;
                return t ? pathProgram(t) : null;
              })
              .filter((p): p is string => !!p),
          ),
        ].slice(0, 62);
        const names = ["npx", "uvx", ...programs];
        // Sixteen at most per call (the native side's limit).
        const found: boolean[] = [];
        for (let i = 0; i < names.length; i += 16) {
          const part = names.slice(i, i + 16);
          found.push(...(await execIpc.installed(part).catch(() => part.map(() => false))));
        }
        this.runtimes.value = { npx: found[0] === true, uvx: found[1] === true };
        this.onPath.value = new Map(programs.map((p, i) => [p, found[i + 2] === true]));
      })();
    return this.detected;
  }

  find(id: string): RegistryAgent | undefined {
    return this.agents.peek().find((a) => a.id === id);
  }

  /** How it would run here (binary for this platform first; see chooseRun). */
  choice(agent: RegistryAgent): RunChoice | null {
    const have = this.runtimes.peek() ?? { npx: true, uvx: true };
    return chooseRun(agent, this.platform.peek(), have);
  }

  /** The binary agent's program found on PATH, if it is. */
  pathProgramFor(agent: RegistryAgent): string | null {
    const platform = this.platform.peek();
    const target = platform ? agent.distribution.binary?.[platform] : undefined;
    const program = target ? pathProgram(target) : null;
    return program && this.onPath.peek().get(program) ? program : null;
  }

  /** What a card or the list says about one agent here. */
  describe(agent: RegistryAgent) {
    const installed = installedAgents(this.services)[agent.id] ?? null;
    const preset = presetFor(agent.id);
    const choice = this.choice(agent);
    const runtimes = this.runtimes.peek();
    const needs =
      choice?.kind === "npx" && runtimes && !runtimes.npx
        ? "Node.js"
        : choice?.kind === "uvx" && runtimes && !runtimes.uvx
          ? "uv"
          : null;
    return {
      installed,
      preset,
      choice,
      needs,
      onPath: this.pathProgramFor(agent),
      update: !!installed && compareVersions(agent.version, installed.version) > 0,
      progress: this.installing.peek().get(agent.id) ?? null,
    };
  }
}

/** One agent for agent.registry.list / the state tree. */
function summary(state: AcpRegistryState, a: RegistryAgent) {
  const d = state.describe(a);
  return {
    id: a.id,
    name: a.name,
    version: a.version,
    description: a.description,
    license: a.license,
    authors: a.authors,
    ...(a.repository && { repository: a.repository }),
    ...(a.website && { website: a.website }),
    ...(a.licenseUrl && { licenseUrl: a.licenseUrl }),
    distributions: [
      ...(a.distribution.binary ? ["binary"] : []),
      ...(a.distribution.npx ? ["npx"] : []),
      ...(a.distribution.uvx ? ["uvx"] : []),
    ],
    runsHere: d.choice?.kind ?? null,
    ...(d.choice?.kind === "binary" && { checksumVerified: !!d.choice.target.sha256 }),
    ...(d.needs && { needs: d.needs }),
    ...(d.onPath && { onPath: d.onPath }),
    ...(d.preset && { preset: d.preset, model: `acp/${d.preset}` }),
    installed: d.installed
      ? {
          version: d.installed.version,
          kind: d.installed.kind,
          model: `acp/${d.installed.name}`,
          ...(d.installed.kind === "binary" && { verified: d.installed.verified === true }),
        }
      : null,
    ...(d.update && { updateAvailable: true }),
    ...(d.progress && { installing: d.progress }),
  };
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The person says yes before anything is installed or removed: a dialog for their own clicks, a
 * card in the agent's chat (even with full access) when an agent asks; tests don't ask.
 */
async function confirm(
  sessions: SessionManager,
  caller: Caller,
  title: string,
  detail: string,
  code: string,
  label: string,
  destructive = false,
): Promise<boolean> {
  if (caller.kind === "test") return true;
  if (caller.kind === "agent" || caller.kind === "acp") {
    const session = sessions.find(caller.session);
    if (session) {
      const answer = await session.ask({
        title,
        heading: title,
        detail,
        code,
        kind: "tool",
        danger: true,
        evenWithFullAccess: true,
      });
      return answer !== "deny";
    }
  }
  return confirmAction(title, `${detail}\n\n${code}`, label, destructive);
}

export function registerAcpRegistry(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): AcpRegistryState {
  const state = new AcpRegistryState(services);
  const { dispatcher } = services;
  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "Agent", ...c }));
  void state.load();

  const saveInstalled = async (id: string, entry: InstalledAgent | null) => {
    await services.persistence.saveGlobal((current) => {
      const all = { ...(current.acpAgents ?? {}) };
      if (entry) all[id] = entry;
      else delete all[id];
      return { acpAgents: all };
    });
    state.installedVersion.value++;
  };

  /** The names other external agents have (an installed one's name must not shadow them). */
  const takenNames = (except: string): Set<string> => {
    const custom = services.settings.peek<Record<string, unknown>>("agent.externalAgents") ?? {};
    return new Set([
      ...ACP_PRESETS.map((p) => p.name),
      // The old OpenCode preset's name (D401): chats set to `acp/OpenCode` mustn't quietly run
      // the registry's OpenCode 1 instead (D407); it installs as "OpenCode (opencode)".
      "OpenCode",
      ...services.extensionFeatures.agents.peek().map((a) => a.name),
      ...Object.keys(typeof custom === "object" ? custom : {}),
      ...Object.values(installedAgents(services))
        .filter((a) => a.id !== except)
        .map((a) => a.name),
    ]);
  };

  const requireAgent = (id: string): RegistryAgent => {
    const agent = state.find(id);
    if (!agent)
      throw new Error(
        `No agent ${id} in the ACP registry (agent.registry.list lists them: ${state.agents
          .peek()
          .map((a) => a.id)
          .slice(0, 50)
          .join(", ")}).`,
      );
    return agent;
  };

  register({
    id: "agent.registry.list",
    title: "List agents from the ACP registry",
    description:
      "The external agents of the ACP agent registry (Cursor, Gemini CLI, Claude Agent, Copilot, goose, OpenCode, Kimi, Qwen Code…): id, name, version, description, license, how each runs here (binary download, npx or uvx; `checksumVerified` for downloads with a SHA-256), what's missing (`needs` Node.js or uv), whether its program is already on PATH, and whether it's installed (with its `model`, acp/<name>, for agent.selectModel). `query` filters by name. `source` says where the list is from (bundled snapshot, the copy cached last time, or the registry just now).",
    input: s.object({
      query: s.string().describe("Words to match in name or description").optional(),
    }),
    effects: ["read"],
    run: async ({ query }) => {
      await state.load();
      await state.detect();
      return {
        source: state.source.peek(),
        fetchedAt: state.fetchedAt.peek(),
        platform: state.platform.peek(),
        ...(state.error.peek() && { error: state.error.peek() }),
        agents: filterAgents(state.agents.peek(), query ?? "").map((a) => summary(state, a)),
      };
    },
  });

  register({
    id: "agent.registry.refresh",
    title: "Refresh the ACP agent registry",
    description:
      "Fetches the ACP agent registry again (cdn.agentclientprotocol.com) and keeps a copy for next time; when it can't be reached the list stays the cached or bundled one and `error` says why. `url` is for test builds only (others refuse it).",
    input: s.object({ url: s.string().optional() }),
    effects: ["network"],
    run: async ({ url }) => {
      try {
        await state.refresh(url);
        await state.detect(true);
        return { ok: true, source: state.source.peek(), agents: state.agents.peek().length };
      } catch (err) {
        return {
          ok: false,
          source: state.source.peek(),
          agents: state.agents.peek().length,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  register({
    id: "agent.registry.install",
    title: "Install an agent from the ACP registry…",
    description:
      "Installs an external agent from the ACP registry by `id` (agent.registry.list): a binary is downloaded for this platform into the IDE's data folder (checked against the registry's SHA-256 when it lists one), an npx or uvx agent is set up to run through npx / uvx. `from: path` uses its program already on PATH instead of downloading. The user always confirms first (even with full access). Then it's `acp/<name>` in the model menu (agent.selectModel). The built-in four (Claude Code, Codex, Gemini CLI, GitHub Copilot) install with agent.installAgent instead.",
    input: s.object({
      id: s.string().describe("The registry id; omitted: the user picks one").optional(),
      from: s.enum(["download", "path"] as const).optional(),
    }),
    effects: ["network", "write", "exec"],
    run: async ({ id: given, from }, ctx) => {
      await state.load();
      let id = given;
      if (!id) {
        if (ctx.caller.kind !== "user")
          throw new Error("Name the agent's `id` (agent.registry.list).");
        const picked = await services.quickInput.pick(
          state.agents
            .peek()
            .filter((a) => !installedAgents(services)[a.id])
            .map((a) => ({
              id: a.id,
              label: a.name,
              description: `${a.version} · ${a.license}`,
              detail: a.description,
            })),
          { placeholder: "Install an agent from the ACP registry" },
        );
        if (!picked) return { installed: false };
        id = picked.id;
      }
      const agent = requireAgent(id);
      const preset = presetFor(id);
      if (preset) return ctx.execute("agent.installAgent", { name: preset });
      if (state.installing.peek().has(id))
        return { installed: false, reason: "Installing already." };
      await state.detect();
      const program = state.pathProgramFor(agent);
      const choice = state.choice(agent);
      const usePath = program && from !== "download";
      if (from === "path" && !program)
        throw new Error(`${agent.name}'s program isn't on PATH here.`);
      if (!choice && !usePath)
        throw new Error(
          `${agent.name} has no build for this computer (${state.platform.peek() ?? "unknown platform"}).`,
        );
      const runtimes = state.runtimes.peek();
      if (!usePath && choice?.kind === "npx" && runtimes && !runtimes.npx)
        throw new Error(
          `${agent.name} runs with npx, which comes with Node.js: install Node.js (nodejs.org), then try again.`,
        );
      if (!usePath && choice?.kind === "uvx" && runtimes && !runtimes.uvx)
        throw new Error(
          `${agent.name} runs with uvx: install uv (docs.astral.sh/uv), then try again.`,
        );
      const license = `${agent.license}${agent.licenseUrl ? ` (${agent.licenseUrl})` : ""}`;
      let detail: string;
      let code: string;
      const platform = state.platform.peek();
      const target = platform ? agent.distribution.binary?.[platform] : undefined;
      if (usePath && target) {
        code = [program, ...target.args].join(" ");
        detail = `Uses ${program}, already on your PATH. License: ${license}.`;
      } else if (choice?.kind === "binary") {
        code = choice.target.archive;
        detail = `Downloads ${agent.name} ${agent.version} from ${host(choice.target.archive)} into the IDE's data folder, then runs ${choice.target.cmd}. License: ${license}. ${
          choice.target.sha256
            ? "The download is checked against the registry's SHA-256."
            : "Not checksum-verified: the registry lists no SHA-256 for this download."
        } It runs with your permissions; the IDE doesn't review registry agents.`;
      } else if (choice) {
        const launch = packageLaunch(choice.kind, choice.dist);
        code = [launch.command, ...launch.args].join(" ");
        detail = `Runs ${agent.name} with ${choice.kind} (${choice.kind === "npx" ? "npm" : "PyPI"} package ${choice.dist.package}, fetched when it first starts). License: ${license}. It runs with your permissions; the IDE doesn't review registry agents.`;
      } else throw new Error(`${agent.name} can't run here.`);
      if (
        !(await confirm(
          sessions,
          ctx.caller,
          `Install ${agent.name} from the ACP registry?`,
          detail,
          code,
          "Install",
        ))
      )
        return { installed: false, reason: "The user declined." };
      const name = agentDisplayName(agent, state.agents.peek(), takenNames(id));
      let entry: InstalledAgent;
      if (usePath && target && program) {
        entry = {
          id,
          name,
          version: agent.version,
          kind: "path",
          command: program,
          args: [...target.args],
          env: { ...target.env },
          license: agent.license,
          installedAt: Date.now(),
        };
      } else if (choice?.kind === "binary") {
        const t = choice.target;
        const progress = (p: AgentInstallProgress) => {
          const next = new Map(state.installing.peek());
          next.set(id, p);
          state.installing.value = next;
        };
        progress({ phase: "download", received: 0, total: null });
        try {
          const done = await acpAgentsIpc.install(
            {
              id,
              version: agent.version,
              archive: t.archive,
              ...(t.sha256 && { sha256: t.sha256 }),
              cmd: t.cmd,
            },
            progress,
          );
          entry = {
            id,
            name,
            version: agent.version,
            kind: "binary",
            command: done.command,
            args: [...t.args],
            env: { ...t.env },
            verified: done.verified,
            source: t.archive,
            license: agent.license,
            installedAt: Date.now(),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/cancelled/i.test(message)) return { installed: false, reason: "Cancelled." };
          throw new Error(`${agent.name} wasn't installed: ${message}`);
        } finally {
          const next = new Map(state.installing.peek());
          next.delete(id);
          state.installing.value = next;
        }
      } else {
        if (!choice) throw new Error(`${agent.name} can't run here.`);
        const launch = packageLaunch(choice.kind, choice.dist);
        entry = {
          id,
          name,
          version: agent.version,
          kind: choice.kind,
          command: launch.command,
          args: launch.args,
          env: launch.env,
          license: agent.license,
          installedAt: Date.now(),
        };
      }
      await saveInstalled(id, entry);
      return {
        installed: true,
        id,
        name,
        model: `acp/${name}`,
        kind: entry.kind,
        ...(entry.kind === "binary" && { verified: entry.verified === true }),
      };
    },
  });

  register({
    id: "agent.registry.cancelInstall",
    title: "Cancel an agent download",
    description: "Stops downloading an agent from the ACP registry (agent.registry.install).",
    input: s.object({ id: s.string() }),
    effects: [],
    palette: false,
    run: async ({ id }) => ({ cancelled: await acpAgentsIpc.cancel(id) }),
  });

  register({
    id: "agent.registry.uninstall",
    title: "Remove an agent installed from the ACP registry…",
    description:
      "Removes an agent installed with agent.registry.install (`id`): it leaves the model menu and a downloaded one's files are deleted. Asks the user first.",
    input: s.object({
      id: s.string().describe("The registry id; omitted: the user picks one").optional(),
    }),
    effects: ["write", "destructive"],
    run: async ({ id: given }, ctx) => {
      let id = given;
      if (!id) {
        if (ctx.caller.kind !== "user") throw new Error("Name the agent's `id`.");
        const picked = await services.quickInput.pick(
          Object.values(installedAgents(services)).map((a) => ({
            id: a.id,
            label: a.name,
            description: `${a.version} · ${a.kind}`,
          })),
          { placeholder: "Remove an agent installed from the ACP registry" },
        );
        if (!picked) return { removed: false };
        id = picked.id;
      }
      const entry = installedAgents(services)[id];
      if (!entry) throw new Error(`${id} isn't installed from the ACP registry.`);
      const what =
        entry.kind === "binary"
          ? `Deletes its downloaded files (${entry.command.replace(/[\\/][^\\/]*$/, "")}).`
          : `It leaves the model menu (${entry.kind === "path" ? "the program on your PATH stays" : `${entry.kind}'s cache stays`}).`;
      if (
        !(await confirm(
          sessions,
          ctx.caller,
          `Remove ${entry.name}?`,
          what,
          `acp/${entry.name}`,
          "Remove",
          true,
        ))
      )
        return { removed: false, reason: "The user declined." };
      if (entry.kind === "binary") await acpAgentsIpc.remove(id);
      await saveInstalled(id, null);
      return { removed: true, id };
    },
  });

  register({
    id: "agent.registry.details",
    title: "Show an ACP registry agent's details",
    description:
      "Shows (or hides, `show: false`) one gallery card's details on the Models page: repository, website, license, authors and how it's distributed. Returns them.",
    input: s.object({ id: s.string(), show: s.boolean().optional() }),
    effects: [],
    palette: false,
    run: ({ id, show }) => {
      const agent = requireAgent(id);
      const open = new Set(state.expanded.peek());
      const want = show ?? !open.has(id);
      if (want) open.add(id);
      else open.delete(id);
      state.expanded.value = open;
      return { shown: want, ...summary(state, agent) };
    },
  });

  register({
    id: "agent.registry.browse",
    title: "Browse agents from the ACP registry",
    description:
      "Opens the Models page at the gallery of external agents from the ACP registry (search, install, use, remove, details).",
    input: s.empty(),
    effects: [],
    agent: "hidden",
    run: () => {
      const opened = openCustomize(services, "models");
      state.focusSearch.value = true;
      return opened;
    },
  });

  sub.add(
    services.state.register("ide://agent/registry", {
      description:
        "The ACP agent registry (D215): where the list is from (bundled, cached, registry), when it was fetched, the last error, this platform, npx / uvx found, and each agent with its version, license, how it runs here, whether it's installed (and as which acp/<name> model) and any install under way.",
      get: () => ({
        source: state.source.peek(),
        fetchedAt: state.fetchedAt.peek(),
        refreshing: state.refreshing.peek(),
        error: state.error.peek(),
        platform: state.platform.peek(),
        runtimes: state.runtimes.peek(),
        skipped: state.skipped.peek(),
        installed: Object.values(installedAgents(services)).map((a) => ({
          id: a.id,
          name: a.name,
          version: a.version,
          kind: a.kind,
          model: `acp/${a.name}`,
          ...(a.kind === "binary" && { verified: a.verified === true }),
        })),
        agents: state.agents.peek().map((a) => summary(state, a)),
      }),
    }),
  );
  return state;
}

export { formatBytes, host };
