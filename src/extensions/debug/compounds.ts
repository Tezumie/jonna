// launch.json `compounds` (D204), VS Code's: several configurations started together (a server
// and its client), each its own debug session. `stopAll` stops every session of the compound when
// one is stopped; `preLaunchTask` runs once before any starts (each configuration's own
// preLaunchTask still runs before it). Entries name configurations: a string, or
// { "name": …, "folder": … } naming another workspace folder's (D251: multi-root; "Name (folder)"
// works too); a plain name is looked up in the compound's own folder first. DOM-free and tested.
import { samePath } from "../../core/paths/index";
import { findNamed, qualifiedName } from "../tasks/folders";
import type { Variables } from "../tasks/tasks";
import { substitute } from "../tasks/tasks";
import type { LaunchConfig } from "./launch";
import { type Presentation, parsePresentation } from "./presentation";

/** A compound's entry: a configuration's name as written, and the folder it names (if any). */
export interface CompoundRef {
  name: string;
  folder?: string;
}

export interface Compound {
  name: string;
  /** Configuration names, in order (as written). */
  configurations: string[];
  /** The same entries with the folder each names (D251). */
  refs?: CompoundRef[];
  preLaunchTask?: string;
  stopAll: boolean;
  /** "launch.json", ".vscode/launch.json"… */
  source: string;
  /** Where the configuration picker shows it (D207). */
  presentation?: Presentation;
  /** The workspace folder whose launch.json has it (D251). */
  workspaceFolder?: string;
  /** Its name as written, when `name` has the folder's name added. */
  plainName?: string;
}

/** launch.json's `compounds` (entries without a name or configurations skipped). */
export function parseCompounds(json: unknown, source: string, v?: Variables): Compound[] {
  const list = (json as { compounds?: unknown } | null)?.compounds;
  if (!Array.isArray(list)) return [];
  const text = (x: unknown): string | undefined =>
    typeof x === "string" && x.trim() ? (v ? substitute(x, v) : x).trim() : undefined;
  const out: Compound[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const name = text(c.name);
    if (!name || !Array.isArray(c.configurations)) continue;
    const refs = c.configurations.flatMap((e): CompoundRef[] => {
      if (typeof e === "string") {
        const n = text(e);
        return n ? [{ name: n }] : [];
      }
      const entry = e as { name?: unknown; folder?: unknown } | null;
      const n = text(entry?.name);
      const folder = text(entry?.folder);
      return n ? [{ name: n, ...(folder && { folder }) }] : [];
    });
    if (!refs.length) continue;
    const preLaunchTask = text(c.preLaunchTask);
    const presentation = parsePresentation(c.presentation);
    out.push({
      name,
      configurations: refs.map((r) => r.name),
      refs,
      ...(preLaunchTask ? { preLaunchTask } : {}),
      stopAll: c.stopAll === true,
      source,
      ...(presentation && { presentation }),
    });
  }
  return out;
}

/** How a compound's entry reads in messages and lists: "Server", "Client (web)". */
export const refLabel = (r: CompoundRef): string => (r.folder ? `${r.name} (${r.folder})` : r.name);

/**
 * The configuration a compound's entry names (D251): the named folder's, else one labelled
 * exactly so ("Server", "Server (api)"), else the one of that name in the compound's own folder,
 * else the only one of that name.
 */
export function compoundMember(
  ref: CompoundRef,
  configs: readonly LaunchConfig[],
  near?: string,
): LaunchConfig | undefined {
  const named = configs.filter((c) => (c.plainName ?? c.name) === ref.name);
  if (ref.folder) {
    const inFolder =
      named.find((c) => c.folderName === ref.folder) ??
      configs.find((c) => c.name === refLabel(ref));
    // With one folder (no folder names on configurations) the folder doesn't matter.
    if (inFolder || named.some((c) => c.folderName !== undefined)) return inFolder;
  }
  if (near) {
    const own = named.find((c) => c.workspaceFolder && samePath(c.workspaceFolder, near));
    if (own) return own;
  }
  return configs.find((c) => c.name === ref.name) ?? (named.length === 1 ? named[0] : undefined);
}

/**
 * The configurations a compound starts, in its order; throws naming what's missing (VS Code
 * refuses to start a compound with an unknown configuration) or a compound that names one twice.
 */
export function resolveCompound(
  compound: Compound,
  configs: readonly LaunchConfig[],
): LaunchConfig[] {
  const refs = compound.refs ?? compound.configurations.map((name) => ({ name }));
  const found = refs.map((r) => ({ r, c: compoundMember(r, configs, compound.workspaceFolder) }));
  // With one folder no configuration has a folder name: an entry is named as before D251, its
  // `folder` left out (it doesn't matter there).
  const multi = configs.some((c) => c.folderName !== undefined);
  const missing = found.filter((x) => !x.c).map((x) => (multi ? refLabel(x.r) : x.r.name));
  if (missing.length)
    throw new Error(
      `The compound "${compound.name}" names ${missing.length === 1 ? "a configuration" : "configurations"} that ${missing.length === 1 ? "doesn't" : "don't"} exist: ${missing.map((m) => `"${m}"`).join(", ")}.`,
    );
  const out: LaunchConfig[] = [];
  for (const { c } of found) if (c && !out.includes(c)) out.push(c);
  return out;
}

/** What a multi-root workspace's own (workspace-file) configurations are named with. */
const WORKSPACE_SUFFIX = { name: "workspace", path: "" };

/**
 * Configurations and compounds of one launch file (D251): their folder recorded and, in a
 * multi-root workspace, their names qualified ("Launch (api)"). `folder` undefined: the workspace
 * file's.
 */
export function ownLaunchEntries(
  configs: readonly LaunchConfig[],
  compounds: readonly Compound[],
  folderPath: string,
  folderName: string | undefined,
  multi: boolean,
): { configs: LaunchConfig[]; compounds: Compound[] } {
  const suffix =
    folderName !== undefined ? { name: folderName, path: folderPath } : WORKSPACE_SUFFIX;
  const name = (n: string) => qualifiedName(n, suffix, multi);
  return {
    configs: configs.map((c) => ({
      ...c,
      workspaceFolder: folderPath,
      ...(multi && {
        name: name(c.name),
        plainName: c.name,
        ...(folderName !== undefined && { folderName }),
      }),
    })),
    compounds: compounds.map((c) => ({
      ...c,
      workspaceFolder: folderPath,
      ...(multi && { name: name(c.name), plainName: c.name }),
    })),
  };
}

/** A configuration by name: "Launch (api)", or "Launch" when that's clear (`near`'s first). */
export function findConfig(
  list: readonly LaunchConfig[],
  name: string,
  near?: string,
): LaunchConfig | undefined {
  const found = findNamed(
    list.map((c) => ({
      label: c.name,
      ...(c.plainName !== undefined && { name: c.plainName }),
      ...(c.workspaceFolder !== undefined && { workspaceFolder: c.workspaceFolder }),
      c,
    })),
    name,
    near,
  );
  return found?.c;
}

/** A compound by name: "Both (api)", or "Both" when that's clear (`near`'s first). */
export function findCompound(
  compounds: readonly Compound[],
  name: string,
  near?: string,
): Compound | undefined {
  const found = findNamed(
    compounds.map((c) => ({
      label: c.name,
      ...(c.plainName !== undefined && { name: c.plainName }),
      ...(c.workspaceFolder !== undefined && { workspaceFolder: c.workspaceFolder }),
      c,
    })),
    name,
    near,
  );
  return found?.c;
}

/**
 * The sessions to stop when the user stops `id`: with `stopAll`, every session the compound
 * started (and their child sessions); else `id` and its children.
 */
export function sessionsToStop(
  id: string,
  sessions: readonly { id: string; parentId: string | null; compound: string | null }[],
  stopAll: (compound: string) => boolean,
): string[] {
  const start = sessions.find((s) => s.id === id);
  if (!start) return [];
  // The compound of the top-level session it belongs to.
  let top = start;
  for (;;) {
    const parent = top.parentId ? sessions.find((s) => s.id === top.parentId) : undefined;
    if (!parent) break;
    top = parent;
  }
  const roots =
    top.compound && stopAll(top.compound)
      ? sessions.filter((s) => s.compound === top.compound && !s.parentId)
      : [start];
  const out: string[] = [];
  const add = (s: { id: string }) => {
    if (out.includes(s.id)) return;
    out.push(s.id);
    for (const child of sessions.filter((c) => c.parentId === s.id)) add(child);
  };
  for (const r of roots) add(r);
  return out;
}
