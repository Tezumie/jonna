// The agent's background commands (D201, Claude Code's BashOutput / KillShell): run_command with
// `background: true` starts one (runInBackground, after run_command's permission check) and gets
// its id; process_output reads what it printed since the last read (only the lines matching
// `filter`, if given); kill_process ends it. See backgroundProcesses.ts for their lifetime.
import type { ToolOutcome } from "../../core/agent/loop";
import { readSaved, savedOutputs } from "../../core/agent/savedOutput";
import type { ExecSandboxPolicy } from "../../core/ipc/process";
import {
  type BackgroundProcess,
  backgroundProcesses,
  describeProcess,
} from "./backgroundProcesses";
import { outputFilter } from "./processOutput";
import { helperEnvOf } from "./toolRoots";
import type { AgentTool, ToolHost } from "./tools";

/** How long run_command waits for a background command's first output (or its address). */
const START_WAIT_MS = 12_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mine(host: ToolHost, id: unknown): BackgroundProcess {
  if (typeof id !== "string" || !id.trim()) throw new Error('"id" is required (e.g. "bg1").');
  const p = backgroundProcesses.get(id);
  // Another chat's process isn't this one's to read or kill.
  if (!p || p.session !== host.session) {
    const ids = backgroundProcesses
      .list(host.session)
      .map((x) => x.id)
      .join(", ");
    throw new Error(
      `No background command "${id}" in this chat.${ids ? ` Its background commands: ${ids}.` : ""}`,
    );
  }
  return p;
}

/** The end of a status line for the model: still running, or how it ended. */
function statusLine(p: BackgroundProcess): string {
  return `[${describeProcess(p)}]`;
}

/**
 * Starts an approved command in the background and waits a little for its first output: until it
 * prints a server address and goes quiet, its output settles, it ends, or START_WAIT_MS.
 */
export async function runInBackground(
  host: ToolHost,
  itemId: string,
  command: string,
  cwd: string,
  cwdLabel: string,
  /** Tell the agent when it ends (run_command's notify_on_exit, D253). */
  notify = false,
  /** In the command sandbox (D336), with its policy (D349, D350). */
  sandbox: boolean | ExecSandboxPolicy = false,
): Promise<ToolOutcome & { urls: string[]; running: boolean }> {
  const again = backgroundProcesses.findRunning(host.session, command, cwdLabel);
  if (again) {
    if (notify) again.notify = true;
    const read = again.output.read();
    return {
      result: `$ ${command}\nAlready running as ${again.id} (started earlier); not started again.\n${read.text ? `New output:\n${read.text}` : ""}${statusLine(again)}`,
      summary: `already running · ${again.id}`,
      urls: again.urls,
      running: true,
    };
  }
  // A headless helper's servers get its worktree's PORT, as its window's would (D207).
  const p = backgroundProcesses.start(
    host.session,
    command,
    cwd,
    cwdLabel,
    helperEnvOf(host.session),
    sandbox,
  );
  const start = Date.now();
  while (Date.now() - start < START_WAIT_MS) {
    await sleep(200);
    if (p.status !== "running" || host.cancelled()) break;
    const quiet = Date.now() - p.lastOutputAt > 1500;
    if (p.urls.length && quiet) break;
    if (quiet && Date.now() - start > 4000 && p.output.total > 0) break;
  }
  // Stopped while it came up: it goes (a dev server doesn't keep running after Stop, D161).
  if (host.cancelled()) {
    await backgroundProcesses.kill(p.id);
    return { result: "Stopped by the user.", isError: true, urls: [], running: false };
  }
  const read = p.output.read();
  host.output(itemId, read.text);
  const running = p.status === "running";
  // Ended while it came up: this result says so, no message later.
  if (notify && running) p.notify = true;
  const how = running
    ? `\nIt keeps running in the background as ${p.id}: read its new output with process_output { id: "${p.id}" } (filter: a pattern for the lines you need; wait_for: wait until a line matches), stop it with kill_process { id: "${p.id}" }. Don't start it again.${p.notify ? " You'll get a message when it ends." : ""}`
    : "\nIt already ended: check the output for errors.";
  return {
    result: `$ ${command}\n${read.text || "(no output yet)"}${read.more ? "\n[more output: read it with process_output]" : ""}\n${statusLine(p)}${how}`,
    isError: !running && p.exitCode !== 0,
    summary: running
      ? `running · ${p.id}${p.urls[0] ? ` · ${p.urls[0]}` : ""}`
      : p.status === "failed"
        ? "failed to start"
        : `exit ${p.exitCode ?? "?"}`,
    detail: p.output.tail(4000),
    urls: p.urls,
    running,
  };
}

export const PROCESS_TOOLS: AgentTool[] = [
  {
    spec: {
      name: "process_output",
      description:
        'Reads what a background command (started by run_command with background: true; its id is "bg1"…) printed since you last read it, and whether it still runs. `filter`: only the lines matching this regular expression (e.g. "error|warn"); the other new lines are skipped, not kept for later. `wait_for`: first wait (up to `timeout_seconds`, default 120, at most 600) until a new line matches this regular expression or the command ends, e.g. "ready|listening" for a server, "passed|failed" for tests. Also reads the whole output of a run_command whose result was cut (id "out1"…, named in that result): `offset` / `limit` in lines, `filter` for the lines you need. Without an id, lists this chat\'s background commands and kept outputs.',
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: 'The id, e.g. "bg1", or "out1" for a kept output' },
          offset: { type: "integer", description: "A kept output: first line (1-based)" },
          limit: { type: "integer", description: "A kept output: lines to read (default 300)" },
          filter: { type: "string", description: "Regular expression for the lines to return" },
          wait_for: {
            type: "string",
            description: "Wait until a new line matches this regular expression (or it ends)",
          },
          timeout_seconds: {
            type: "integer",
            description: "How long wait_for waits (default 120, at most 600)",
          },
        },
        required: [],
      },
    },
    readOnly: true,
    verb: "Read output of",
    target: (a) => String(a.id ?? "background commands"),
    async run(args, host) {
      if (args.id === undefined || args.id === "") {
        const list = backgroundProcesses.list(host.session);
        const kept = savedOutputs.ids(host.session);
        return {
          result: `${
            list.length
              ? list.map(describeProcess).join("\n")
              : "No background commands in this chat."
          }${kept.length ? `\nKept outputs of cut run_command results: ${kept.join(", ")}.` : ""}`,
          summary: `${list.length} background`,
        };
      }
      // The whole output of a cut foreground run (D311).
      if (typeof args.id === "string" && /^out\d+$/.test(args.id.trim())) {
        const id = args.id.trim();
        const saved = savedOutputs.get(host.session, id);
        if (!saved) {
          const kept = savedOutputs.ids(host.session);
          return {
            result: `Error: no kept output "${id}" in this chat (a chat keeps its last 5 until the window reloads).${kept.length ? ` Kept: ${kept.join(", ")}.` : ""} Run the command again if you need its output.`,
            isError: true,
            summary: "not kept",
          };
        }
        const filter = outputFilter(typeof args.filter === "string" ? args.filter : undefined);
        const text = readSaved(saved, args, filter);
        return { result: text, summary: `${id}`, detail: text.slice(0, 4000) };
      }
      const p = mine(host, args.id);
      const filter = outputFilter(typeof args.filter === "string" ? args.filter : undefined);
      const waited = typeof args.wait_for === "string" ? await waitFor(host, p, args) : null;
      const r = p.output.read(filter);
      const notes = [
        ...(waited ? [waited] : []),
        ...(r.dropped
          ? [`[${r.dropped} characters of older output were dropped before this read]`]
          : []),
        ...(r.lines
          ? [`[${r.lines.matched} of ${r.lines.seen} new lines matched the filter]`]
          : []),
        ...(r.more ? ["[more output is waiting: read again]"] : []),
      ];
      return {
        result: `${r.text || (filter ? "(no matching lines)" : "(no new output)")}${notes.length ? `\n${notes.join("\n")}` : ""}\n${statusLine(p)}`,
        summary: `${p.id} · ${p.status}${r.text ? ` · ${r.text.split("\n").length - 1} lines` : ""}`,
        detail: r.text.slice(-4000),
      };
    },
  },
  {
    spec: {
      name: "kill_process",
      description:
        'Stops a background command started by run_command with background: true (and what it started), by its id ("bg1"). Its last output can still be read with process_output.',
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: 'e.g. "bg1"' } },
        required: ["id"],
      },
    },
    readOnly: false,
    verb: "Stopped",
    target: (a) => String(a.id ?? ""),
    async run(args, host) {
      const p = mine(host, args.id);
      const killed = await backgroundProcesses.kill(p.id);
      return {
        result: killed
          ? `Stopped ${p.id} (${p.command}).`
          : `${p.id} wasn't running any more (${describeProcess(p)}).`,
        summary: killed ? `stopped ${p.id}` : "not running",
      };
    },
  },
];

/**
 * Keeps the whole output of a foreground run_command whose result was cut (D311) and returns the
 * line for the result naming its id and how to read it.
 */
export function keepCutOutput(
  session: string,
  command: string,
  output: string,
  dropped: number,
): string {
  const id = savedOutputs.save(session, command, output, dropped);
  const lines = output.split("\n").length;
  return `\n[The output was cut. All ${lines} lines are kept as ${id}: read any part with process_output {"id": "${id}", "offset": 1, "limit": 300}, or only the lines you need with {"id": "${id}", "filter": "error|warn"}.]`;
}

/** The longest process_output's wait_for waits. */
const MAX_WAIT_SECONDS = 600;

/**
 * Waits until the unread output has a line matching `wait_for`, the command ends, the timeout
 * passes or the turn is stopped (D253, Claude Code's Monitor). Returns a note for the result.
 */
async function waitFor(
  host: ToolHost,
  p: BackgroundProcess,
  args: Record<string, unknown>,
): Promise<string> {
  const pattern = outputFilter(String(args.wait_for));
  if (!pattern) throw new Error(`wait_for isn't a regular expression: ${String(args.wait_for)}`);
  const seconds = Math.min(
    MAX_WAIT_SECONDS,
    Math.max(1, typeof args.timeout_seconds === "number" ? args.timeout_seconds : 120),
  );
  const start = Date.now();
  const waited = () => `${Math.round((Date.now() - start) / 1000)}s`;
  // Only what wasn't read yet: a line the agent already saw ("ready" at start) isn't news.
  const matches = () =>
    p.output.unread > 0 &&
    p.output
      .tail(Math.min(p.output.unread, 200_000))
      .split("\n")
      .some((line) => {
        pattern.lastIndex = 0;
        return pattern.test(line);
      });
  while (true) {
    if (matches()) return `[waited ${waited()}: a line matched wait_for]`;
    if (p.status !== "running") return `[waited ${waited()}: it ended]`;
    if (host.cancelled()) return "[stopped while waiting]";
    if (Date.now() - start >= seconds * 1000)
      return `[waited ${seconds}s: no line matched wait_for yet; it still runs]`;
    await sleep(300);
  }
}

/**
 * The message for a command started with notify_on_exit that ended on its own (D253): how it
 * ended and its last lines. Null when there's nothing to tell (not asked, killed, running).
 */
export function exitNotice(p: BackgroundProcess): string | null {
  if (!p.notify || p.status === "killed" || p.status === "running") return null;
  const tail = p.output.tail(3000).split("\n").slice(-40).join("\n").trim();
  const output = tail ? `\nIts last output:\n\`\`\`\n${tail}\n\`\`\`` : "\nIt printed nothing.";
  return `Background command ${p.id} ended (you asked to be told): \`${p.command}\`, ${describeProcess(p)}.${output}\nRead more with process_output { id: "${p.id}" }.`;
}
