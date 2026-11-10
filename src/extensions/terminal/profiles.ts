// Terminal profiles (VS Code's `terminal.integrated.profiles.<platform>` and `defaultProfile`):
// the shells Rust found on this machine merged with the user's own entries, in VS Code's shape —
// { path (or a list of paths), source ("PowerShell" | "Git Bash"), args, env, icon, color,
// overrideName }, and `null` to hide a detected one. DOM-free and tested.
import type { DetectedProfile, ProfileSpec } from "../../core/ipc/process";

export type ProfilePlatform = "windows" | "osx" | "linux";

export interface ResolvedProfile {
  name: string;
  /** Candidate programs; the first that exists starts (Rust resolves them). */
  path: string[];
  /** Omitted: the IDE's usual arguments (shell integration, login flags). */
  args?: string[];
  env?: Record<string, string | null>;
  /** The tab icon (one of the terminal icons), when the profile names one we have. */
  icon?: string;
  /** The tab color (VS Code's "terminal.ansiRed" → "red"). */
  color?: string;
  /** The profile's name stays the tab title (VS Code's overrideName). */
  overrideName: boolean;
  /** Found on this machine (not only in settings). */
  detected: boolean;
  /** The detected profile's icon hint ("powershell", "bash", "cmd", "linux", "terminal"). */
  kind: string;
}

export function profilePlatform(platform: string): ProfilePlatform {
  return platform === "windows" ? "windows" : platform === "mac" ? "osx" : "linux";
}

const COLORS = ["red", "green", "yellow", "blue", "magenta", "cyan"] as const;

/** VS Code's `color` ("terminal.ansiBrightRed") as one of the tab colors. */
export function profileColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^terminal\.ansi(?:Bright)?([A-Za-z]+)$/.exec(value.trim());
  const name = (m?.[1] ?? value).toLowerCase();
  return COLORS.find((c) => c === name);
}

const stringList = (v: unknown): string[] | undefined =>
  typeof v === "string"
    ? [v]
    : Array.isArray(v) && v.every((x) => typeof x === "string")
      ? (v as string[])
      : undefined;

function envOf(v: unknown): Record<string, string | null> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string | null> = {};
  for (const [k, value] of Object.entries(v as Record<string, unknown>))
    if (typeof value === "string" || value === null) out[k] = value;
  return Object.keys(out).length ? out : undefined;
}

/**
 * The profiles to offer, in order: the detected ones (VS Code's order), each replaced or adjusted
 * by a settings entry of the same name, then the settings' own. A `null` entry hides the detected
 * profile of that name; an entry with `source` takes the detected profile answering to it (its
 * path and, unless given, its arguments); an entry without `path` or `source` adjusts the
 * detected profile of its name. Entries that name nothing to start are left out.
 */
export function resolveProfiles(
  configured: unknown,
  detected: readonly DetectedProfile[],
  icons: readonly string[] = [],
): ResolvedProfile[] {
  const entries =
    configured && typeof configured === "object" && !Array.isArray(configured)
      ? Object.entries(configured as Record<string, unknown>)
      : [];
  const byName = new Map(entries);
  const out: ResolvedProfile[] = [];
  const fromDetected = (d: DetectedProfile): ResolvedProfile => ({
    name: d.name,
    path: [d.path],
    ...(d.args.length && { args: d.args }),
    overrideName: false,
    detected: true,
    kind: d.icon,
  });
  const apply = (name: string, raw: unknown, base: ResolvedProfile | undefined) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
    const o = raw as Record<string, unknown>;
    const source =
      typeof o.source === "string" ? detected.find((d) => d.source === o.source) : undefined;
    const paths = stringList(o.path)?.filter((p) => p.trim());
    const start = paths?.length
      ? { path: paths, detected: false }
      : source
        ? { path: [source.path], detected: true }
        : base
          ? { path: base.path, detected: base.detected }
          : null;
    if (!start) return undefined;
    // A detected profile's arguments come along with its path, unless the entry has its own.
    const inherited = !paths?.length ? (source ? source.args : base?.args) : undefined;
    const args = stringList(o.args) ?? (inherited?.length ? inherited : undefined);
    const env = envOf(o.env);
    const icon = typeof o.icon === "string" && icons.includes(o.icon) ? o.icon : undefined;
    const color = profileColor(o.color);
    return {
      name,
      path: start.path,
      ...(args && { args }),
      ...(env && { env }),
      ...(icon && { icon }),
      ...(color && { color }),
      overrideName: o.overrideName === true,
      detected: start.detected,
      kind: source?.icon ?? base?.kind ?? "terminal",
    } satisfies ResolvedProfile;
  };
  for (const d of detected) {
    if (out.some((p) => p.name === d.name)) continue;
    if (!byName.has(d.name)) {
      out.push(fromDetected(d));
      continue;
    }
    const raw = byName.get(d.name);
    if (raw === null) continue; // hidden
    const p = apply(d.name, raw, fromDetected(d));
    if (p) out.push(p);
  }
  for (const [name, raw] of entries) {
    if (out.some((p) => p.name === name) || detected.some((d) => d.name === name)) continue;
    const p = apply(name, raw, undefined);
    if (p) out.push(p);
  }
  return out;
}

/** The default profile: the one `name` names (case-insensitive), else null (the IDE's own). */
export function defaultProfile(
  name: unknown,
  profiles: readonly ResolvedProfile[],
): ResolvedProfile | null {
  if (typeof name !== "string" || !name.trim()) return null;
  const wanted = name.trim().toLowerCase();
  return profiles.find((p) => p.name.toLowerCase() === wanted) ?? null;
}

/** What Rust starts for a profile. */
export function profileSpec(p: ResolvedProfile): ProfileSpec {
  return {
    path: p.path,
    ...(p.args && { args: p.args }),
    ...(p.env && { env: p.env }),
  };
}

/** A Windows path as Git Bash writes it: `C:\Users\me` → `/c/Users/me`. */
export function windowsToMsys(path: string): string {
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(path);
  if (!m) return path.replace(/\\/g, "/");
  return `/${(m[1] ?? "").toLowerCase()}/${(m[2] ?? "").replace(/\\/g, "/")}`.replace(/\/$/, "");
}

/** Git Bash's folder as a Windows path: `/c/Users/me` → `C:\Users\me` (others unchanged). */
export function msysToWindows(path: string): string {
  const m = /^(?:\/cygdrive)?\/([A-Za-z])(\/.*)?$/.exec(path);
  if (!m) return path;
  return `${(m[1] ?? "").toUpperCase()}:\\${(m[2] ?? "").replace(/^\//, "").replace(/\//g, "\\")}`;
}

/**
 * A path typed into a shell (a file dropped on the terminal): quoted the shell's way when it has
 * spaces or special characters. Git Bash gets the POSIX form (`/c/…`), as VS Code types it.
 */
export function quotePathForShell(path: string, shell: string, msys = false): string {
  const p = msys ? windowsToMsys(path) : path;
  // PowerShell also reads typographic quotes and dashes as ' " - (a file "John’s; x.txt").
  if (!/[\s'"$`&|;()<>*?!#~^%,{}[\]@–-―‘-„]/.test(p)) return p;
  if (!msys && /powershell|pwsh/i.test(shell)) return `'${p.replace(/['‘’‚‛]/g, "$&$&")}'`;
  if (!msys && /cmd(\.exe)?$/i.test(shell)) return `"${p}"`;
  return `'${p.replace(/'/g, "'\\''")}'`;
}

/** The shell tasks and debug launches use (VS Code's `terminal.integrated.automationProfile.*`). */
export interface AutomationShell {
  executable: string;
  /** The profile's arguments, then the flags that make the shell run one command line. */
  args: string[];
  /** Variables for the task's process; null removes one the IDE has (VS Code's semantics). */
  env: Record<string, string | null>;
}

/**
 * The flags that make `program` run one command line and exit, as Rust adds them for a task's
 * default shell (pty/mod.rs `shell_run_flags`): cmd `/d /c`, PowerShell `-NoLogo -Command`,
 * bash / zsh / fish `-l -c`, other shells `-c`.
 */
export function shellRunFlags(program: string): string[] {
  const file = (program.split(/[\\/]/).pop() ?? program).toLowerCase().replace(/\.exe$/, "");
  if (file === "cmd") return ["/d", "/c"];
  if (file === "pwsh" || file === "powershell") return ["-NoLogo", "-Command"];
  if (file === "bash" || file === "zsh" || file === "fish") return ["-l", "-c"];
  return ["-c"];
}

/**
 * `terminal.automationProfile.<platform>` as the shell a task runs in: `{ path, args, env }`
 * (`path` may be a list: the first is used). The run flags are added after the profile's own
 * arguments unless they're already there (VS Code does the same). Null when unset or invalid.
 */
export function parseAutomationProfile(value: unknown): AutomationShell | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const executable = stringList(o.path)
    ?.find((p) => p.trim())
    ?.trim();
  if (!executable) return null;
  return withRunFlags(executable, stringList(o.args) ?? [], envOf(o.env) ?? {});
}

function withRunFlags(
  executable: string,
  own: readonly string[],
  env: Record<string, string | null>,
): AutomationShell {
  const lower = own.map((a) => a.toLowerCase());
  const flags = shellRunFlags(executable).filter((f) => !lower.includes(f.toLowerCase()));
  return { executable, args: [...own, ...flags], env };
}

/**
 * The default terminal profile as the shell of tasks without an automation profile (VS Code's
 * rule: the default profile's path, arguments and env, plus the run flags). Null when it can't
 * be one: several candidate paths (Rust picks the one that exists when a terminal starts) or
 * `wsl.exe`, which takes a program, not a command line, after its own arguments.
 */
export function profileTaskShell(p: ResolvedProfile | null): AutomationShell | null {
  if (p?.path.length !== 1) return null;
  const executable = p.path[0]?.trim();
  if (!executable) return null;
  const file = (executable.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
  if (file === "wsl") return null;
  return withRunFlags(executable, p.args ?? [], p.env ?? {});
}
