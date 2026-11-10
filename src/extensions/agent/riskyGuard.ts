// Agents and risky folders (D213). Files the browser saves into Downloads can hold instructions
// written for AI agents, so:
//
// - An agent asks before it works in a risky folder: the built-in agent's first tool call that
//   touches the open folder when that folder is risky (Downloads or in it, home, Desktop,
//   temp, a drive root), and any call whose path, working folder or command line is inside a Downloads folder;
//   an external agent (ACP) before it starts there, and its file and terminal requests into
//   Downloads. The question comes even with full access; "Allow" counts for that chat and that
//   folder until the folder closes. Asking (rather than refusing unless the user's message names
//   the folder) is the safer choice that stays usable: a question is visible and can't be talked
//   around by text in a file, and wording ("fix the downloads page") can't open it by accident.
// - Search and find results and folder listings leave out files in a Downloads folder the chat
//   wasn't allowed into.
// - Writes to other agents' configuration and startup files (core/security/agentConfigFiles.ts)
//   always ask, each time, even with full access, with the reason.
//
// The project's instruction files aren't loaded from a risky folder at all (rules.ts, skills.ts,
// subagents.ts: `projectInstructionsBlocked`). State: ide://agent/riskyFolders.

import type { ToolOutcome } from "../../core/agent/loop";
import { pathPatternMatches } from "../../core/agent/toolRules";
import { inputPathIn, inputPathsIn } from "../../core/agent/workspaceFolders";
import { appIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { basename, dirname, isWindowsPath, joinPath, relativePath } from "../../core/paths/index";
import { product } from "../../core/product";
import {
  commandTouchesConfig,
  configQuestionDetail,
  type ProtectedConfig,
  protectedConfig,
} from "../../core/security/agentConfigFiles";
import { mentionsFolder, riskyLabel, riskyReason } from "../../core/security/riskyFolders";
import type { RiskyMatch } from "../../workbench/riskyFolders";
import type { WorkbenchServices } from "../../workbench/services";
import { agentFolders, workspaceInputPaths } from "./ignore";
import { cleanPathArg } from "./pathArg";
import { addToolGate, type ToolGateContext } from "./toolGate";

type Ask = ToolGateContext["ask"];

/** Chat id → risky folders (keys) it was allowed into. Cleared when the folder closes. */
const grants = new WeakMap<WorkbenchServices, Map<string, Set<string>>>();

function grantsOf(services: WorkbenchServices): Map<string, Set<string>> {
  let map = grants.get(services);
  if (!map) {
    map = new Map();
    grants.set(services, map);
  }
  return map;
}

export function riskyGranted(
  services: WorkbenchServices,
  session: string,
  folder: string,
): boolean {
  return grantsOf(services).get(session)?.has(services.trust.risky.key(folder)) === true;
}

function grant(services: WorkbenchServices, session: string, folder: string): void {
  const map = grantsOf(services);
  const set = map.get(session) ?? new Set<string>();
  set.add(services.trust.risky.key(folder));
  map.set(session, set);
}

/**
 * Whether the project's own instruction files (AGENTS.md, CLAUDE.md, rules, skills, subagents)
 * stay unloaded: in restricted mode, and always in a risky folder (D213). Null when they load.
 * `folder`: the workspace folder whose files are meant (D251: each is judged on its own); the
 * first folder by default.
 */
export function projectInstructionsBlocked(
  services: WorkbenchServices,
  folder?: string | null,
): string | null {
  const root = folder ?? services.workspace.root.peek();
  if (!root) return null;
  const match = services.trust.risky.riskOf(root);
  if (match) {
    const nested = services.trust.risky.key(root) !== services.trust.risky.key(match.folder);
    return `This folder is ${nested ? "in " : ""}${riskyLabel(match.kind)}: its instruction files aren't loaded automatically (mention one with @ to use it).`;
  }
  if (services.trust.state.peek() === "restricted")
    return "This folder is in restricted mode: its instruction files aren't loaded (Manage workspace trust to change it).";
  return null;
}

/** Whether a project file (absolute) is one an agent shouldn't load: inside a Downloads folder. */
export function inDownloads(services: WorkbenchServices, abs: string): boolean {
  return services.trust.risky.downloadsOf(abs) !== null;
}

/**
 * A folder-relative path in a Downloads folder this chat wasn't allowed into: left out of search
 * and find results and folder listings.
 */
export function hiddenInDownloads(
  services: WorkbenchServices,
  session: string,
  rel: string,
): boolean {
  if (!services.workspace.root.peek()) return false;
  const folder = services.trust.risky.downloadsOf(services.workspace.resolve(rel));
  return folder !== null && !riskyGranted(services, session, folder);
}

/**
 * Asks whether this chat may work in `match.folder` (once per chat and folder). True when it
 * may. `who`: an external agent's name ("Codex"); the built-in agent otherwise.
 */
export async function askRiskyAccess(
  services: WorkbenchServices,
  session: string,
  ask: Ask,
  match: RiskyMatch,
  what: string,
  who?: string,
): Promise<boolean> {
  if (riskyGranted(services, session, match.folder)) return true;
  const label = riskyLabel(match.kind);
  const answer = await ask({
    title: `${who ? `${who}: ` : ""}work in ${label}`,
    heading: who ? `Start ${who} in ${label}?` : `Let the agent work in ${label}?`,
    code: `${what}\n${match.folder}`,
    kind: "tool",
    detail: `${riskyReason(match.kind)} Allow only if you asked for this. Your answer counts for this chat.`,
    evenWithFullAccess: true,
  });
  if (answer === "deny") return false;
  grant(services, session, match.folder);
  return true;
}

/** The outcome a tool gets when the user said no. */
function refused(match: RiskyMatch): ToolOutcome {
  return {
    result: `The user didn't allow working in ${riskyLabel(match.kind)} (${match.folder}): files there may come from the web. Don't try again or work around it (no other tool or command); tell the user what you need from there and let them decide.`,
    denied: true,
    summary: "denied",
  };
}

/** Tools that work in the open folder (the question for a risky folder comes with the first). */
const FOLDER_TOOLS = new Set([
  "read_file",
  "list_dir",
  "find_files",
  "search",
  "edit_file",
  "write_file",
  "run_command",
]);

/** Tools that work across the whole workspace without a path (every folder's files). */
const WORKSPACE_TOOLS = new Set(["find_files", "search"]);

/**
 * Every risky folder a built-in tool call would work in (D213; D251: each workspace folder on its
 * own — the one a path is in, the first for a command without a folder, all of them for search
 * and find). With one folder only the first match, as it always was.
 */
export function riskyTargets(
  services: WorkbenchServices,
  name: string,
  args: Record<string, unknown>,
): { match: RiskyMatch; what: string }[] {
  const root = services.workspace.root.peek();
  if (!root) return [];
  const risky = services.trust.risky;
  const abs = (p: unknown) =>
    typeof p === "string" && p ? services.workspace.resolve(cleanPathArg(p)) : null;
  const downloads = (p: string | null) => {
    const folder = p ? risky.downloadsOf(p) : null;
    return folder ? { kind: "downloads" as const, folder } : null;
  };
  const what =
    `${name} ${String(args.path ?? args.command ?? args.query ?? args.pattern ?? args.id ?? "")}`.trim();
  const out: { match: RiskyMatch; what: string }[] = [];
  const add = (match: RiskyMatch | null) => {
    if (match && !out.some((t) => risky.key(t.match.folder) === risky.key(match.folder)))
      out.push({ match, what });
  };
  // A path or working folder in Downloads (the open folder may be the home folder).
  const target =
    name === "run_command" ? abs(args.cwd) : name === "call_command" ? null : abs(args.path);
  add(downloads(target));
  const inputs = name === "call_command" ? workspaceInputPaths(services, args.input) : [];
  for (const p of inputs) add(downloads(p));
  if (name === "run_command" && typeof args.command === "string") {
    const cwd = abs(args.cwd) ?? root;
    for (const folder of risky.downloadFolders())
      if (mentionsFolder(args.command, folder, risky.home, risky.os, cwd))
        add({ kind: "downloads", folder });
  }
  // A workspace folder that is itself risky: the first tool working in it asks.
  const folderOf = (p: string | null) => (p && services.workspace.folderOf(p)?.path) || null;
  const touched: string[] = [];
  if (WORKSPACE_TOOLS.has(name) || (name === "list_dir" && !args.path))
    touched.push(...agentFolders(services).map((f) => f.path));
  else if (FOLDER_TOOLS.has(name)) touched.push(folderOf(target) ?? root);
  else if (name === "call_command") for (const p of inputs) touched.push(folderOf(p) ?? root);
  for (const folder of touched) add(risky.riskOf(folder));
  // One folder asks once, as before D251: a path in ~/Downloads with the home folder open is
  // asked about as the Downloads folder only (the first match), not the home folder after it.
  return services.workspace.folders.peek().length > 1 ? out : out.slice(0, 1);
}

/** A protected configuration file a tool call would write, if any. */
export function protectedTarget(
  services: WorkbenchServices,
  name: string,
  args: Record<string, unknown>,
): { subject: string; found: ProtectedConfig } | null {
  const root = services.workspace.root.peek();
  const folder = product.workspaceFolderName;
  const check = (p: string) => {
    const abs = root ? services.workspace.resolve(cleanPathArg(p)) : p;
    // Relative to the workspace folder holding it (`.claude/settings.json`: every folder's own
    // config, D251) and as the absolute path (`~/.codex/…` when the folder is the home folder).
    const owner = root ? services.workspace.folderOf(abs) : undefined;
    const inFolder = owner ? relativePath(owner.path, abs) : abs;
    const shown = owner ? services.workspace.relative(abs) : abs;
    const found = protectedConfig(inFolder, folder) ?? protectedConfig(abs, folder);
    return found ? { subject: shown, found } : null;
  };
  if ((name === "edit_file" || name === "write_file") && typeof args.path === "string")
    return check(args.path);
  if (name === "run_command" && typeof args.command === "string") {
    const hit = commandTouchesConfig(args.command, folder);
    return hit ? { subject: hit.subject, found: hit } : null;
  }
  if (name === "call_command" && root && typeof args.id === "string") {
    const command = services.dispatcher.list().find((c) => c.id === args.id);
    if (!command || command.effects.every((e) => e === "read")) return null;
    for (const p of workspaceInputPaths(services, args.input)) {
      const hit = check(p);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Paths the agent may read but never write (D227, agent.readOnlyPaths, gitignore-style patterns
 * relative to the folder, `~/` for home): its file tools and file-writing commands are refused
 * without a question, and it's told why, so it doesn't try another way. Unset: the defaults
 * (git's own folder, editor settings).
 */
export function readOnlyTarget(
  services: WorkbenchServices,
  name: string,
  args: Record<string, unknown>,
  home: string | null,
): { path: string; pattern: string } | null {
  const root = services.workspace.root.peek();
  const set = services.settings.peek<unknown>("agent.readOnlyPaths");
  // The IDE's own folder settings are always read-only to it (they'd change the IDE's behavior).
  const patterns = [
    ...(Array.isArray(set) ? set : DEFAULT_READ_ONLY),
    `/${product.workspaceFolderName}/settings.json`,
  ];
  const paths: string[] = [];
  if ((name === "edit_file" || name === "write_file") && typeof args.path === "string")
    paths.push(args.path);
  else if (name === "call_command" && root && typeof args.id === "string") {
    const command = services.dispatcher.list().find((c) => c.id === args.id);
    if (command && !command.effects.every((e) => e === "read"))
      paths.push(
        ...workspaceInputPaths(services, args.input),
        ...destinations(services, root, args.input),
      );
  }
  for (const p of paths) {
    const abs = root ? services.workspace.resolve(cleanPathArg(p)) : cleanPathArg(p);
    // The patterns are relative to the workspace folder holding the file (D251: each folder's
    // `/.git`), the first folder for anything outside them.
    const base = (root && services.workspace.folderOf(abs)?.path) || root;
    // Windows spellings of the same file (`.git./hooks`, `settings.json `, `x::$DATA`) are the
    // file itself: matched as such (as the ignore rules do). A drive's `C:` keeps its colon.
    const plain = abs
      .replaceAll("\\", "/")
      .split("/")
      .map((s, i) =>
        i === 0 && /^[A-Za-z]:$/.test(s) ? s : s.replace(/:.*$/, "").replace(/[. ]+$/, "") || s,
      )
      .join("/");
    // An 8.3 short name (`GIT~1` for `.git`) is another spelling the patterns can't see: refused.
    const shortName = isWindowsPath(abs) && plain.split("/").some((s) => /~\d+$/.test(s));
    const pattern = shortName
      ? "an 8.3 short name (GIT~1): use the full name"
      : patterns.find(
          (x) => typeof x === "string" && pathPatternMatches(x, plain, { root: base, home }),
        );
    if (pattern)
      return {
        path: root && services.workspace.contains(abs) ? services.workspace.relative(abs) : abs,
        pattern,
      };
  }
  return null;
}

/**
 * agent.readOnlyPaths' default (also in extension.json): git's folder and editor settings. The
 * folders themselves too: `.git` is a file in a worktree (`gitdir: …`), and a rename or delete
 * names the folder.
 */
const DEFAULT_READ_ONLY = ["/.git", "/.git/**", "/.vscode/settings.json", "/.idea", "/.idea/**"];

/**
 * Where a command's input puts files, beyond the paths it names: a move or paste's `dest`
 * (each moved file's name under it) and a rename's `newName` (beside the old one).
 */
function destinations(services: WorkbenchServices, root: string, input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const o = input as Record<string, unknown>;
  const out: string[] = [];
  const folders = agentFolders(services);
  const sources = inputPathsIn(folders, input);
  if (typeof o.dest === "string" && o.dest) {
    const dest = folders.length ? inputPathIn(folders, o.dest) : joinPath(root, o.dest);
    out.push(dest, ...sources.map((s) => joinPath(dest, basename(s))));
  }
  if (typeof o.newName === "string" && o.newName)
    out.push(...sources.map((s) => joinPath(dirname(s), o.newName as string)));
  return out;
}

/** Asks before a write to a protected configuration file; true when the user allowed it. */
export async function askProtectedWrite(
  ask: Ask,
  subject: string,
  found: ProtectedConfig,
  who?: string,
): Promise<boolean> {
  const answer = await ask({
    title: `${who ? `${who}: ` : ""}change ${subject}`,
    heading: "Change an agent or startup configuration file?",
    code: subject,
    kind: "tool",
    detail: configQuestionDetail(found),
    evenWithFullAccess: true,
  });
  return answer !== "deny";
}

/** The home folder (for `~/` patterns), asked once. */
let home: Promise<string | null> | null = null;
function homeDir(): Promise<string | null> {
  if (!home)
    home = appIpc.info().then(
      (i) => i.homeDir ?? null,
      () => null,
    );
  return home;
}

export function registerRiskyGuard(sub: DisposableStore, services: WorkbenchServices): void {
  const { workspace, state } = services;
  const gate = async (
    session: string,
    name: string,
    args: Record<string, unknown>,
    ask: Ask,
  ): Promise<ToolOutcome | null> => {
    // Each risky folder the call works in asks on its own (a search spans every folder).
    for (const target of riskyTargets(services, name, args))
      if (!(await askRiskyAccess(services, session, ask, target.match, target.what)))
        return refused(target.match);
    const readOnly = readOnlyTarget(services, name, args, await homeDir());
    if (readOnly)
      return {
        result: `${readOnly.path} is read-only to the agent (agent.readOnlyPaths: ${readOnly.pattern}). Nothing was written. Don't change it another way (a command, another tool); tell the user what you wanted to change there and why.`,
        isError: true,
        summary: "read-only path",
      };
    const config = protectedTarget(services, name, args);
    if (config && !(await askProtectedWrite(ask, config.subject, config.found)))
      return {
        result: `The user didn't allow changing ${config.subject}. ${config.found.reason} Don't change it another way; tell the user what you wanted to change and why.`,
        denied: true,
        summary: "denied",
      };
    return null;
  };
  sub.add(
    addToolGate(async ({ session, name, args, ask }) => {
      // A failure here refuses the call rather than letting it through.
      try {
        return await gate(session, name, args, ask);
      } catch (err) {
        return {
          result: `Error: the call couldn't be checked (${err instanceof Error ? err.message : String(err)}), so it didn't run.`,
          isError: true,
          summary: "not checked",
        };
      }
    }, "first"),
  );
  // A new folder: no chat has been allowed anywhere in it yet.
  sub.add(workspace.onDidClose(() => grantsOf(services).clear()));
  sub.add(
    state.register("ide://agent/riskyFolders", {
      description:
        "The agent and risky folders (D213): the open folder's risk (downloads, home, desktop, temp, root or null), why its instruction files aren't loaded (null when they are), and the risky folders each chat was allowed into. In a multi-root workspace, `folders` gives each folder's own (name, path, risk, instructionsBlocked); `open` is the first folder's.",
      get: () => ({
        open: services.trust.risky.riskOf(workspace.root.peek()),
        instructionsBlocked: projectInstructionsBlocked(services),
        ...(workspace.isMultiRoot() && {
          folders: workspace.folders.peek().map((f) => ({
            name: f.name,
            path: f.path,
            risk: services.trust.risky.riskOf(f.path),
            instructionsBlocked: projectInstructionsBlocked(services, f.path),
          })),
        }),
        allowed: Object.fromEntries(
          [...grantsOf(services).entries()].map(([chat, folders]) => [chat, [...folders]]),
        ),
      }),
    }),
  );
}
