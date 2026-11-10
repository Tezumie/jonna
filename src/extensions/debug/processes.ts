// The process picker for attaching (D204, VS Code's `${command:pickProcess}`): the machine's
// processes as `ps -A -o pid=,ppid=,args=` (macOS, Linux) or PowerShell's Win32_Process JSON
// (Windows) print them (Rust: src-tauri/src/debug/processes.rs), parsed here, with the inspector
// port a Node process was started with (`--inspect=9230`) shown and used for attaching. DOM-free
// and tested.

export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** The program's file name ("node", "python3.exe"). */
  name: string;
  /** The whole command line. */
  command: string;
}

/** `ps` lines: "  pid  ppid args…" (headers and garbage skipped). */
export function parsePs(text: string): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!m) continue;
    const command = m[3] ?? "";
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), name: programName(command), command });
  }
  return out;
}

/** PowerShell's `ConvertTo-Json` of ProcessId, ParentProcessId, Name, CommandLine. */
export function parseWindowsProcesses(text: string): ProcessEntry[] {
  let json: unknown;
  try {
    json = JSON.parse(text.trim() || "[]");
  } catch {
    return [];
  }
  // One process comes as an object, not a list.
  const list = Array.isArray(json) ? json : [json];
  return list.flatMap((raw): ProcessEntry[] => {
    const p = raw as Record<string, unknown> | null;
    const pid = Number(p?.ProcessId);
    if (!p || !Number.isFinite(pid) || pid <= 0) return [];
    const name = typeof p.Name === "string" ? p.Name : "";
    const command = typeof p.CommandLine === "string" && p.CommandLine ? p.CommandLine : name;
    return [
      { pid, ppid: Number(p.ParentProcessId) || 0, name: name || programName(command), command },
    ];
  });
}

export function parseProcesses(format: "ps" | "windows", text: string): ProcessEntry[] {
  return format === "windows" ? parseWindowsProcesses(text) : parsePs(text);
}

/** The program's file name from a command line (quoted paths, both slashes). */
export function programName(command: string): string {
  // Kernel threads ("[kworker/0:1]") have no program file.
  if (command.startsWith("[")) return command;
  const first = command.startsWith('"')
    ? command.slice(1, command.indexOf('"', 1) > 0 ? command.indexOf('"', 1) : undefined)
    : (command.split(/\s+/)[0] ?? "");
  return first.split(/[\\/]/).pop() ?? first;
}

/** Whether the process runs Node (node, node.exe, nodejs, or a path to one). */
export function isNodeProcess(p: ProcessEntry): boolean {
  return (
    /^(node|nodejs)(\.exe)?$/i.test(p.name) ||
    /^(node|nodejs)(\.exe)?$/i.test(programName(p.command))
  );
}

/**
 * The inspector port on the command line: `--inspect`, `--inspect-brk`, `--inspect-wait` (9229
 * by default), `=port`, `=host:port`, or `--inspect-port=port`. Null when there's none.
 */
export function inspectPort(command: string): number | null {
  const port = /--inspect-port=(?:[^\s:]*:)?(\d+)/.exec(command);
  if (port) return Number(port[1]);
  const m = /--inspect(?:-brk|-wait)?(?:=(?:([^\s:]*):)?(\d+))?(?=\s|$)/.exec(command);
  if (!m) return null;
  return m[2] ? Number(m[2]) : 9229;
}

/** The picker's rows: Node processes first, the IDE's own and system noise left out. */
export function processChoices(
  list: readonly ProcessEntry[],
  ownPid?: number,
): { pid: number; label: string; description: string; port: number | null; node: boolean }[] {
  return (
    list
      .filter((p) => p.pid !== ownPid && p.pid > 0)
      // Kernel threads on Linux show as "[kworker/0:1]".
      .filter((p) => !/^\[.*\]$/.test(p.command))
      .map((p) => {
        const port = inspectPort(p.command);
        const node = isNodeProcess(p);
        return {
          pid: p.pid,
          label: `${p.name} (${p.pid})`,
          description: `${port !== null ? `inspector :${port} · ` : ""}${p.command.length > 160 ? `${p.command.slice(0, 159)}…` : p.command}`,
          port,
          node,
        };
      })
      .sort(
        (a, b) =>
          Number(b.port !== null) - Number(a.port !== null) ||
          Number(b.node) - Number(a.node) ||
          a.pid - b.pid,
      )
  );
}
