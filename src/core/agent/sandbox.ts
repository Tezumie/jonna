// The command sandbox's policy (D336, Claude Code's sandboxed Bash): whether one run_command runs
// in the operating system's sandbox (src-tauri/src/exec/sandbox.rs: low integrity on Windows,
// sandbox-exec on macOS, bubblewrap on Linux), what the permission card and the result say, and
// whether a failure looks like the sandbox blocked it. DOM-free. What it may read and reach
// (D349, D350) is sandboxPolicy.ts.

import { type SandboxPolicy, shortList } from "./sandboxPolicy";

/** What the system's sandbox does (exec_sandbox_info). */
export interface SandboxInfo {
  /** "low-integrity", "sandbox-exec", "bubblewrap"; null: none on this system. */
  mechanism: string | null;
  limitsWrites: boolean;
  /** The system refuses connections but to localhost. */
  limitsNetwork: boolean;
  /** agent.sandbox.denyRead's secrets are hidden (D349). */
  limitsReads?: boolean;
  /**
   * "blocked": localhost only, allowed hosts through the filter; "proxy": only tools that use
   * the proxy settings are filtered (Windows, D348); "open": not limited.
   */
  network?: "blocked" | "proxy" | "open";
  /** One sentence: what it protects, or why there's none. */
  note: string;
}

/** How the network is limited for a command with these allowed hosts. */
export function networkMode(
  info: SandboxInfo,
  allowHosts: readonly string[] = [],
): "blocked" | "proxy" | "open" {
  const mode = info.network ?? (info.limitsNetwork ? "blocked" : "open");
  // bubblewrap's own network can't reach the filter: with hosts it shares the network (D350).
  if (mode === "blocked" && info.mechanism === "bubblewrap" && allowHosts.length) return "proxy";
  return mode;
}

/** agent.sandbox: "auto" runs commands in the sandbox where the system has one; "off" never. */
export type SandboxSetting = "auto" | "off";

export function readSandboxSetting(value: unknown): SandboxSetting {
  // Opt-in (D336): the first sandboxed command marks the folder low integrity for good.
  return value === "auto" ? "auto" : "off";
}

export interface SandboxPlan {
  /** The command runs in the sandbox. */
  sandboxed: boolean;
  /**
   * The model asked to run it outside (`sandbox: false`) where it would have been sandboxed:
   * the user is asked every time, whatever the mode and the allowlist.
   */
  outsideAsked: boolean;
  /** For the permission card: where it runs. Empty when there's nothing to say. */
  card: string;
  /** What it may read and reach (D349, D350), when it runs sandboxed. */
  policy?: SandboxPolicy;
}

/** execIpc.run's `sandbox`: false, or the policy it runs with. */
export function sandboxArg(plan: SandboxPlan): false | SandboxPolicy {
  if (!plan.sandboxed) return false;
  return plan.policy ?? { denyRead: [], allowWrite: [], allowHosts: [] };
}

/**
 * Where one command runs. `requested`: the model's `sandbox` argument (false: outside). A remote
 * or WSL folder has no sandbox (the command runs on the other side).
 */
export function planSandbox(opts: {
  setting: SandboxSetting;
  info: SandboxInfo | null;
  requested: unknown;
  remote: boolean;
  policy?: SandboxPolicy;
}): SandboxPlan {
  const { setting, info, requested, remote, policy } = opts;
  if (setting === "off") return { sandboxed: false, outsideAsked: false, card: "" };
  if (remote)
    return {
      sandboxed: false,
      outsideAsked: false,
      card: "Not sandboxed: the folder is on a remote or in WSL.",
    };
  if (!info?.mechanism)
    return {
      sandboxed: false,
      outsideAsked: false,
      card: info ? `Not sandboxed: ${info.note}` : "",
    };
  if (requested === false)
    return {
      sandboxed: false,
      outsideAsked: true,
      card: "Outside the sandbox, with your full rights (the agent asked for it).",
    };
  return {
    sandboxed: true,
    outsideAsked: false,
    card: `In the sandbox: ${sandboxScope(info, policy)}`,
    ...(policy && { policy }),
  };
}

/**
 * "writes only in the folder and a temp folder; secrets hidden (~/.ssh, ~/.aws and 9 more); no
 * network except localhost", with the allowances the policy adds.
 */
export function sandboxScope(info: SandboxInfo, policy?: SandboxPolicy): string {
  const extra = policy?.allowWrite ?? [];
  const writes = info.limitsWrites
    ? `writes only in the folder${extra.length ? `, ${shortList(extra)}` : ""} and a temp folder`
    : "writes not limited";
  const hidden = policy?.denyRead ?? [];
  const reads =
    info.limitsReads && hidden.length ? `; secrets hidden (${shortList(hidden, 2)})` : "";
  const hosts = policy?.allowHosts ?? [];
  const to = `localhost${hosts.length ? ` and ${shortList(hosts)}` : ""}`;
  const mode = networkMode(info, hosts);
  const network =
    mode === "blocked"
      ? `no network except ${to}`
      : mode === "proxy"
        ? `tools that use the proxy settings reach only ${to}; other programs' connections aren't limited`
        : "the network isn't limited";
  return `${writes}${reads}; ${network}.`;
}

// What a write or a connection the sandbox refused looks like, in the shells and tools the agent
// runs (PowerShell, cmd, Node, Python, git, POSIX tools, bubblewrap, sandbox-exec).
const BLOCKED = [
  /access to the path .* is denied/i,
  /\baccess is denied\b/i,
  /unauthorizedaccessexception/i,
  /\bEACCES\b|\bEPERM\b|\bEROFS\b/,
  /operation not permitted/i,
  /read-only file system/i,
  /permission denied/i,
  /PermissionError/,
  /could not resolve host|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)|network is unreachable|temporary failure in name resolution/i,
  /sandbox-exec|bwrap:/i,
  // The network filter (D348): its refusal, as curl, git, npm and pip report it.
  /blocked by the command sandbox|CONNECT tunnel failed|tunneling socket could not be established|proxy.*\b403\b|\b403\b.*proxy/i,
];

/** Whether a failed sandboxed command's output looks like the sandbox stopped it. */
export function looksSandboxBlocked(output: string): boolean {
  const tail = output.slice(-8000);
  return BLOCKED.some((re) => re.test(tail));
}

/**
 * What a sandboxed command's result ends with: that it ran in the sandbox, and when it failed in
 * a way the sandbox may have caused, how to run it outside (which asks the user).
 */
export function sandboxResultNote(opts: {
  info: SandboxInfo;
  failed: boolean;
  output: string;
  policy?: SandboxPolicy;
  /** Hosts the network filter refused (D350). */
  blockedHosts?: readonly string[];
  /** What the sandbox couldn't set up (a secret it couldn't hide). */
  notes?: readonly string[];
}): string {
  const base = `\n[sandboxed: ${sandboxScope(opts.info, opts.policy)}]`;
  const notes = opts.notes?.length ? `\n[sandbox: ${opts.notes.join("; ")}]` : "";
  const hosts = opts.blockedHosts ?? [];
  const refused = hosts.length
    ? `\nThe sandbox's network filter refused ${shortList(hosts, 5)}. If the task needs ${hosts.length > 1 ? "them" : "it"}, call suggest_sandbox_allowance with ${hosts.length > 1 ? "those hosts" : "that host"} so the user can allow ${hosts.length > 1 ? "them" : "it"} for this project.`
    : "";
  if (!opts.failed || (!hosts.length && !looksSandboxBlocked(opts.output)))
    return `${base}${notes}${refused}`;
  const network = opts.info.limitsNetwork || networkMode(opts.info) === "proxy";
  return `${base}${notes}${refused}\nThis may have failed because of the sandbox (a write outside the folder${network ? ", or the network" : ""}${opts.info.limitsReads ? ", or a hidden secret" : ""}). A folder or host the project needs for good: suggest_sandbox_allowance (the user decides). For this once, run it again with sandbox: false — the user is asked first; don't use it for other reasons.`;
}

/** A sandbox that couldn't start (the command never ran). */
export function sandboxStartError(message: string): string {
  return `The sandbox couldn't start, so the command didn't run: ${message}\nIf the command needs to run anyway, call run_command again with sandbox: false — the user is asked first.`;
}
