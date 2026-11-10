// What a sandboxed command may not read and what it may reach besides its folder (D349, D350):
// agent.sandbox.denyRead (the secrets to hide), the user's own allowances (agent.sandbox.allowWrite,
// agent.sandbox.allowHosts) and a project's (agent.sandbox.projects, keyed by folder: kept in the
// user's settings, never in the repository, so a cloned folder can't widen its own sandbox), and
// the suggest_sandbox_allowance card the agent shows when a command needed one. DOM-free.

import { product } from "../product";

/** What travels with a sandboxed command to src-tauri/src/exec/sandbox.rs (SandboxPolicy). */
export interface SandboxPolicy {
  denyRead: string[];
  allowWrite: string[];
  allowHosts: string[];
  /**
   * The IDE's own configuration folders (product.json), which the command may not write, as
   * the agents' (.claude, .codex…) and git's settings (D392, sandbox_protect.rs).
   */
  protectFolders?: string[];
}

/** The IDE's configuration folder names a project may hold. */
export const PROTECT_FOLDERS: readonly string[] = [
  product.workspaceFolderName,
  ...product.workspaceFolderAliases,
];

/**
 * agent.sandbox.denyRead's default (mirrors extension.json). `${…}` entries are expanded per
 * system by src-tauri/src/exec/sandbox_read.rs.
 */
export const DEFAULT_DENY_READ: readonly string[] = [
  "~/.ssh",
  "~/.aws",
  "~/.azure",
  "~/.config/gcloud",
  "~/.config/gh",
  "~/.docker/config.json",
  "~/.kube",
  "~/.gnupg",
  "~/.netrc",
  "~/.git-credentials",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder of the setting
  "${secrets}",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder of the setting
  "${keychains}",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder of the setting
  "${browserProfiles}",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a placeholder of the setting
  "${envFiles}",
];

const strings = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim())
    : [];

const unique = (list: readonly string[]): string[] => [...new Set(list)];

/**
 * A host as the filter matches it, from what the model or the user wrote: lower case, no scheme,
 * path or port ("https://Registry.npmjs.org/x" → "registry.npmjs.org"); `*.example.com` and `*`
 * stay patterns. Null when it isn't a host.
 */
export function cleanHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let h = raw.trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  h = h.replace(/[/?#].*$/, "");
  h = h.replace(/^[^@]*@/, "");
  h = h.replace(/:\d+$/, "").replace(/\.$/, "");
  if (h === "*") return h;
  if (h.length > 253) return null;
  return /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h)
    ? h
    : null;
}

/** agent.sandbox.projects' key for a folder: forward slashes, no trailing one, a drive in lower case. */
export function projectKey(folder: string): string {
  let k = folder.replace(/\\/g, "/");
  if (k.length > 1) k = k.replace(/\/+$/, "");
  return /^[a-z]:/i.test(k) ? k.toLowerCase() : k;
}

export interface ProjectAllowances {
  allowWrite?: string[];
  allowHosts?: string[];
}

/** The allowances agent.sandbox.projects keeps for `folder` (none without a folder). */
export function projectAllowances(
  projects: unknown,
  folder: string | null | undefined,
): { allowWrite: string[]; allowHosts: string[] } {
  const none = { allowWrite: [], allowHosts: [] };
  if (!folder || !projects || typeof projects !== "object") return none;
  const key = projectKey(folder);
  const entry = Object.entries(projects as Record<string, unknown>).find(
    ([k]) => projectKey(k) === key,
  )?.[1];
  if (!entry || typeof entry !== "object") return none;
  const e = entry as Record<string, unknown>;
  return { allowWrite: strings(e.allowWrite), allowHosts: strings(e.allowHosts) };
}

/** agent.sandbox.projects with `add` kept for `folder` (what's there already stays). */
export function withProjectAllowance(
  projects: unknown,
  folder: string,
  add: { hosts?: readonly string[]; folders?: readonly string[] },
): Record<string, ProjectAllowances> {
  const all: Record<string, ProjectAllowances> =
    projects && typeof projects === "object" && !Array.isArray(projects)
      ? { ...(projects as Record<string, ProjectAllowances>) }
      : {};
  const key = projectKey(folder);
  const existing = Object.keys(all).find((k) => projectKey(k) === key) ?? key;
  const now = projectAllowances(all, folder);
  const allowWrite = unique([...now.allowWrite, ...(add.folders ?? [])]);
  const allowHosts = unique([...now.allowHosts, ...(add.hosts ?? [])]);
  all[existing] = {
    ...(allowWrite.length && { allowWrite }),
    ...(allowHosts.length && { allowHosts }),
  };
  return all;
}

/** The policy one command runs with: the user's lists and the project's allowances. */
export function sandboxPolicy(opts: {
  denyRead: unknown;
  allowWrite: unknown;
  allowHosts: unknown;
  projects: unknown;
  folder: string | null | undefined;
}): SandboxPolicy {
  const project = projectAllowances(opts.projects, opts.folder);
  return {
    denyRead: Array.isArray(opts.denyRead) ? strings(opts.denyRead) : [...DEFAULT_DENY_READ],
    allowWrite: unique([...strings(opts.allowWrite), ...project.allowWrite]),
    allowHosts: unique(
      [...strings(opts.allowHosts), ...project.allowHosts]
        .map(cleanHost)
        .filter((h): h is string => h !== null),
    ),
    protectFolders: [...PROTECT_FOLDERS],
  };
}

/** "a, b and 2 more". */
export function shortList(list: readonly string[], max = 3): string {
  if (list.length <= max) return list.join(", ");
  return `${list.slice(0, max).join(", ")} and ${list.length - max} more`;
}

// ---- suggest_sandbox_allowance ---------------------------------------------------------------

/** The card's data (its call's detail). */
export interface AllowanceSuggestion {
  /** The project (its folder) the allowance is kept for. */
  folder: string;
  hosts: string[];
  folders: string[];
  reason?: string;
  /** The user allowed it. */
  added?: boolean;
}

const MAX_SUGGESTED = 5;

/** A folder that may not be allowed: a drive's or the system's root, or inside the project. */
function folderRefusal(path: string, project: string): string | null {
  const p = projectKey(path);
  if (!/^([a-z]:\/|\/|~\/)/i.test(`${p}/`)) return `${path} isn't an absolute path`;
  // `C:/Windows/..` is the drive's root: the checks below read the path as written.
  if (p.split("/").some((part) => part === ".." || part === "."))
    return `${path} has . or .. in it: name the folder itself`;
  if (/^[a-z]:$/i.test(p) || p === "/" || p === "" || p === "~")
    return `${path} is too wide: name the folder the command writes`;
  const root = projectKey(project);
  if (p === root || p.startsWith(`${root}/`)) return `${path} is in the project, writable already`;
  return null;
}

/** The card from the tool's arguments, or an error for the model. */
export function parseAllowanceArgs(
  args: Record<string, unknown>,
  project: string | null,
): AllowanceSuggestion | { error: string } {
  if (!project) return { error: "no folder is open, so there's no project to allow it for" };
  const rawHosts = Array.isArray(args.hosts) ? args.hosts : [];
  const rawFolders = Array.isArray(args.folders) ? args.folders : [];
  const hosts: string[] = [];
  for (const h of rawHosts) {
    const clean = cleanHost(h);
    if (!clean) return { error: `${String(h)} isn't a host name` };
    if (clean === "*") return { error: "* would turn the network filter off: name the hosts" };
    hosts.push(clean);
  }
  const folders: string[] = [];
  for (const f of rawFolders) {
    if (typeof f !== "string" || !f.trim()) return { error: "a folder must be a path" };
    const refusal = folderRefusal(f.trim(), project);
    if (refusal) return { error: refusal };
    folders.push(f.trim());
  }
  if (!hosts.length && !folders.length) return { error: "give hosts or folders to allow" };
  if (hosts.length + folders.length > MAX_SUGGESTED)
    return { error: `at most ${MAX_SUGGESTED} at once` };
  const reason = typeof args.reason === "string" ? args.reason.trim().slice(0, 200) : "";
  return {
    folder: project,
    hosts: unique(hosts),
    folders: unique(folders),
    ...(reason && { reason }),
  };
}

export function parseAllowanceSuggestion(detail: unknown): AllowanceSuggestion | null {
  if (typeof detail !== "string") return null;
  try {
    const v = JSON.parse(detail) as Partial<AllowanceSuggestion>;
    if (typeof v?.folder !== "string") return null;
    return {
      folder: v.folder,
      hosts: strings(v.hosts),
      folders: strings(v.folders),
      ...(typeof v.reason === "string" && v.reason && { reason: v.reason }),
      ...(v.added === true && { added: true }),
    };
  } catch {
    return null;
  }
}

/** What the card asks, in a line: "Allow registry.npmjs.org and writes in ~/.cache/x". */
export function allowanceText(s: Pick<AllowanceSuggestion, "hosts" | "folders">): string {
  const parts = [
    ...(s.hosts.length ? [`connections to ${shortList(s.hosts)}`] : []),
    ...(s.folders.length ? [`writes in ${shortList(s.folders)}`] : []),
  ];
  return parts.join(" and ");
}

/** The tool's result for the model. */
export function allowanceResult(s: AllowanceSuggestion): string {
  return `Shown to the user as a card: allow ${allowanceText(s)} in this project's sandbox. They decide; if they allow it, it applies to the next sandboxed commands, so run the command again then. Don't run it with sandbox: false meanwhile unless they ask.`;
}
