// What the agent may not see (D199): `.aiignore` and `.cursorignore` at the folder's root and in
// the IDE's own folder, the agent.ignoreFiles setting, and (agent.ignoreDefaults, on) secrets —
// .env files, private keys, credentials. The agent's read, list, find, search, edit and write
// tools and @-mentions skip or refuse those files (core/agent/ignore.ts matches them). Commands it
// runs in a terminal aren't filtered (a shell can read anything): the docs say so.
// In a multi-root workspace (D251) every folder has its own rules, read from its own files and
// matched relative to it (core/agent/workspaceFolders.ts `FolderIgnores`).
// State: ide://agent/ignore.
import { AgentIgnore, DEFAULT_AGENT_IGNORE } from "../../core/agent/ignore";
import {
  type AgentFolder,
  FolderIgnores,
  foldersOrPrimary,
  inputPathsIn,
} from "../../core/agent/workspaceFolders";
import { fsIpc } from "../../core/ipc/fs";
import type { DisposableStore } from "../../core/lifecycle/index";
import { basename, joinPath, relativePath, samePath } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { workspaceFolderPath } from "../../workbench/workspaceFolder";

const FILE_NAMES = [".aiignore", ".cursorignore"];

interface Source {
  source: string;
  patterns: string[];
  /** The folder the rules belong to (multi-root only). */
  folder?: string;
}

interface Loaded {
  /** The folders the rules were loaded for (their paths). */
  key: string;
  ignores: FolderIgnores;
  /** Where the rules came from, for the state and messages. */
  sources: Source[];
}

const loaded = new WeakMap<WorkbenchServices, Loaded>();
/** The rule files being read for the open folders (the defaults apply before). */
const reading = new WeakMap<WorkbenchServices, Promise<void>>();

/** The workspace's folders as the agent sees them (the first folder alone when only it is known). */
export function agentFolders(services: WorkbenchServices): readonly AgentFolder[] {
  return foldersOrPrimary(services.workspace.folders.peek(), services.workspace.root.peek());
}

/**
 * Once the folders' rule files (.aiignore…) are read: what sends files elsewhere (the codebase
 * index) waits for it, so a file excluded there doesn't leave before the rules are known.
 */
export function agentIgnoreReady(services: WorkbenchServices): Promise<void> {
  return reading.get(services) ?? Promise.resolve();
}

/**
 * Whether the agent may not see `path` (absolute), by the rules of the folder holding it. False
 * outside every folder (tools refuse that anyway).
 */
export function agentIgnored(services: WorkbenchServices, path: string, isDir = false): boolean {
  return loaded.get(services)?.ignores.ignored(path, isDir) === true;
}

/** Same, for a workspace-relative path ("src/x", or "api/src/x" with several folders). */
export function agentIgnoredRel(services: WorkbenchServices, rel: string, isDir = false): boolean {
  return loaded.get(services)?.ignores.ignoredRel(rel, isDir) === true;
}

/** Same, for a path relative to the first folder (a headless helper's worktree of it). */
export function agentIgnoredInFirst(
  services: WorkbenchServices,
  rel: string,
  isDir = false,
): boolean {
  return loaded.get(services)?.ignores.ignoredInFirst(rel, isDir) === true;
}

/** `.aiignore` / `.cursorignore` anywhere: the agent may read them but never change them (D199). */
export function isAgentRuleFile(path: string): boolean {
  return FILE_NAMES.includes(
    basename(path.replace(/\\/g, "/"))
      .toLowerCase()
      .replace(/[. ]+$/, ""),
  );
}

/** Why the agent may not write `path`, or null. */
export function agentWriteRefusal(
  services: WorkbenchServices,
  path: string,
  name: string,
): string | null {
  if (isAgentRuleFile(path))
    return `Error: ${name} decides what the agent may see, so the agent can't change it. Ask the user to edit it.`;
  return agentIgnored(services, path) ? ignoredMessage(name) : null;
}

/**
 * Paths named in a command's input (`path`, `paths`, `uri`, `file`, `files`) that the agent may
 * not see; call_command refuses those commands (D199). The name is as the workspace writes it.
 */
export function ignoredInInput(
  services: WorkbenchServices,
  root: string | null,
  input: unknown,
): string | null {
  if (!root) return null;
  for (const abs of workspaceInputPaths(services, input))
    if (agentIgnored(services, abs)) return services.workspace.relative(abs);
  return null;
}

/** The same against every folder of the workspace (a folder's name in front picks it). */
export function workspaceInputPaths(services: WorkbenchServices, input: unknown): string[] {
  return inputPathsIn(agentFolders(services), input);
}

/** The message a tool returns for an excluded file. */
export function ignoredMessage(name: string): string {
  return `Error: ${name} is excluded from the agent (.aiignore, .cursorignore, agent.ignoreFiles or the default secret files like .env). Ask the user if you need what's in it.`;
}

export function registerAgentIgnore(sub: DisposableStore, services: WorkbenchServices): void {
  const { settings, workspace, events, state } = services;
  const candidates = (root: string) => [
    ...FILE_NAMES.map((n) => joinPath(root, n)),
    ...FILE_NAMES.map((n) => workspaceFolderPath(root, n)),
  ];
  // Names too: workspace-relative paths ("api/src/x") pick a folder by its name, so a rename
  // must give the rules the new name at once.
  const keyOf = (folders: readonly AgentFolder[]) =>
    folders.map((f) => `${f.path}\u0001${f.name}`).join("\0");
  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    const folders = agentFolders(services);
    const multi = folders.length > 1;
    const key = keyOf(folders);
    const defaults: Source[] =
      settings.peek<boolean>("agent.ignoreDefaults") !== false
        ? [{ source: "defaults (agent.ignoreDefaults)", patterns: [...DEFAULT_AGENT_IGNORE] }]
        : [];
    const defaultPatterns = defaults.flatMap((s) => s.patterns);
    // Until the rule files are read: a folder that stays keeps the rules it had (a running
    // agent mustn't see, even briefly, what its .aiignore hides when another folder is added);
    // a new folder gets the defaults.
    const prev = loaded.get(services);
    if (prev?.key !== key || !prev.ignores.size) {
      const before = (folder: AgentFolder) =>
        prev?.ignores.entries.find((e) => samePath(e.folder.path, folder.path));
      const names = new Set(folders.map((f) => f.name));
      loaded.set(services, {
        key,
        ignores: new FolderIgnores(
          folders.map((folder) => ({
            folder,
            matcher: before(folder)?.matcher ?? new AgentIgnore(defaultPatterns),
          })),
        ),
        sources: prev
          ? prev.sources.filter((s) => s.folder === undefined || names.has(s.folder))
          : [...defaults],
      });
    }
    const sources: Source[] = [...defaults];
    const entries = await Promise.all(
      folders.map(async (folder) => {
        const own: Source[] = [];
        for (const file of candidates(folder.path)) {
          const text = await fsIpc
            .read(file)
            .then((b) => new TextDecoder().decode(b))
            .catch(() => null);
          if (text !== null)
            own.push({
              source: multi
                ? `${folder.name}/${relativePath(folder.path, file)}`
                : relativePath(folder.path, file),
              patterns: text.split(/\r?\n/),
              ...(multi && { folder: folder.name }),
            });
        }
        // The folder's own value (its settings in multi-root; the one value with one folder).
        const setting = settings.peekAt<unknown>("agent.ignoreFiles", folder.path);
        if (Array.isArray(setting))
          own.push({
            source: "agent.ignoreFiles",
            patterns: setting.filter((x): x is string => typeof x === "string"),
            ...(multi && { folder: folder.name }),
          });
        return { folder, own };
      }),
    );
    if (mine !== seq) return;
    for (const e of entries) sources.push(...e.own);
    loaded.set(services, {
      key,
      ignores: new FolderIgnores(
        entries.map((e) => ({
          folder: e.folder,
          matcher: new AgentIgnore([...defaultPatterns, ...e.own.flatMap((s) => s.patterns)]),
        })),
      ),
      sources,
    });
  };
  const reload = () => {
    reading.set(
      services,
      load().catch(() => {}),
    );
  };
  sub.add(
    effect(() => {
      workspace.root.value;
      // Folders added or taken out (onDidChangeFolders) change this signal: their rules load.
      workspace.folders.value;
      settings.version.value;
      reload();
      return undefined;
    }),
  );
  const isRuleFile = (path: string) => FILE_NAMES.includes(basename(path));
  for (const name of [
    "files.didSave",
    "files.didCreate",
    "files.didDelete",
    "files.didChange",
  ] as const)
    sub.add(events.on(name, ({ path }) => (isRuleFile(path) ? reload() : undefined)));
  sub.add(
    state.register("ide://agent/ignore", {
      description:
        "What the agent may not see (D199): the rules from .aiignore / .cursorignore (each folder's root and its IDE folder), agent.ignoreFiles and the default secret files (agent.ignoreDefaults). In a multi-root workspace each source names its `folder`; a folder's rules apply to its own files. Its terminal commands aren't filtered.",
      get: () => {
        const l = loaded.get(services);
        return {
          sources: (l?.sources ?? []).map((s) => ({
            source: s.source,
            patterns: s.patterns.filter((p) => p.trim() && !p.trim().startsWith("#")),
            ...(s.folder !== undefined && { folder: s.folder }),
          })),
        };
      },
    }),
  );
}
