// Auto-attach to Node processes (D204), js-debug's way: NODE_OPTIONS=--require <bootloader>
// (src-tauri/src/debug/bootloader.js) in the environment of a debugged Node program and of a
// JavaScript debug terminal. Every Node process started there — `child_process.fork` / `spawn`
// children, `npm run dev`'s server, Jest's workers — opens its inspector, registers in a folder
// the IDE polls (Rust: autoattach.rs) and waits until the IDE has attached and set breakpoints.
// Worker threads come through their parent's inspector instead (cdp.ts, NodeWorker). This file:
// the environment and the registrations, DOM-free and tested.

/** One registered process. */
export interface Registration {
  pid: number;
  ppid: number;
  /** Its inspector's ws:// address. */
  url: string;
  /** The script it runs (process.argv[1]). */
  script: string;
  cwd: string;
  args: string[];
}

export function parseRegistration(text: string): Registration | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = raw as Record<string, unknown> | null;
  if (
    !r ||
    typeof r.url !== "string" ||
    !/^ws:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(r.url)
  )
    return null;
  const pid = Number(r.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return {
    pid,
    ppid: Number(r.ppid) || 0,
    url: r.url,
    script: typeof r.script === "string" ? r.script : "",
    cwd: typeof r.cwd === "string" ? r.cwd : "",
    args: Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === "string") : [],
  };
}

/** A session name for a registered process: its script's file name and pid. */
export function registrationName(r: Registration): string {
  const base = r.script.split(/[\\/]/).pop() || "node";
  return `${base} [${r.pid}]`;
}

/**
 * NODE_OPTIONS with the bootloader required first (a value already there is kept). The path is
 * quoted, with backslashes and quotes escaped, as Node parses NODE_OPTIONS (Windows paths, spaces).
 */
export function nodeOptionsWith(existing: string | undefined, bootloader: string): string {
  const quoted = `"${bootloader.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const own = `--require ${quoted}`;
  const rest = (existing ?? "").trim();
  if (rest.includes(own)) return rest;
  return rest ? `${own} ${rest}` : own;
}

/**
 * The environment that makes Node processes register in `dir`. NODE_OPTIONS keeps what the
 * configuration set, else the IDE's own (`${env:NODE_OPTIONS}`, filled in when the program or
 * terminal starts).
 */
export function autoAttachEnv(
  base: Record<string, string>,
  prepared: { dir: string; bootloader: string },
  mode: "smart" | "always" = "smart",
): Record<string, string> {
  return {
    ...base,
    NODE_OPTIONS: nodeOptionsWith(base.NODE_OPTIONS ?? `\${env:NODE_OPTIONS}`, prepared.bootloader),
    IDE_DEBUG_ATTACH: prepared.dir,
    ...(mode === "always" ? { IDE_DEBUG_ATTACH_MODE: "always" } : {}),
  };
}

/**
 * Which session a registered process belongs under: the session of its parent process (by pid),
 * else the session that owns the registration folder (a launched program's), else none (a debug
 * terminal's top-level program).
 */
export function parentFor(
  r: Registration,
  sessions: readonly { id: string; pid?: number }[],
  owner: string | null,
): string | null {
  return sessions.find((s) => s.pid !== undefined && s.pid === r.ppid)?.id ?? owner;
}

/** Whether a launch configuration's Node runs with auto-attach (`autoAttachChildProcesses`). */
export function wantsChildAttach(
  raw: Record<string, unknown>,
  runtime: string | undefined,
): boolean {
  if (raw.autoAttachChildProcesses === false) return false;
  // bun / deno ignore NODE_OPTIONS' --require.
  const exe = (runtime ?? "node").split(/[\\/]/).pop()?.toLowerCase() ?? "node";
  return /^(node|nodejs)(\.exe|\.cmd)?$/.test(exe);
}
