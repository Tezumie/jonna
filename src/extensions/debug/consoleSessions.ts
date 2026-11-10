// The debug console per session (D209, VS Code's console picker): every line is kept with the
// console it belongs to; the console shows one session's lines (and the lines that belong to
// none, like "Running …"). A Node program's child processes and workers write into their
// parent's console (js-debug's "merge with parent"); every other session — each of a compound's,
// a serverReadyAction's browser — has its own. DOM-free and tested; the controller holds one.
import { computed, type ReadonlySignal, type Signal, signal } from "../../core/reactive/index";
import { drawn } from "./programOutput";

export interface ConsoleLine {
  kind: "output" | "input" | "result" | "error" | "info";
  text: string;
  /** Output from the program's stderr. */
  stderr?: boolean;
  /** A result that expands (an object), while the program stays paused. */
  ref?: number;
  /** The name of the session it came from (several run at once). */
  session?: string;
  /** The console it's in (a session id; consoleKeyOf). None: it shows in every console. */
  sessionId?: string;
  /** The session that answered (`ref` is resolved there; a child's, in its parent's console). */
  source?: string;
}

export interface ConsoleSessionInfo {
  id: string;
  name: string;
  parentId: string | null;
  /** "launch", "launcher", "child", "worker" (controller.ts SessionKind). */
  kind: string;
  compound: string | null;
}

/** The console session `id` writes to: its own, or (a child process, a worker) its parent's. */
export function consoleKeyOf(id: string, sessions: readonly ConsoleSessionInfo[]): string {
  let current = sessions.find((s) => s.id === id);
  const seen = new Set<string>();
  while (current && (current.kind === "child" || current.kind === "worker") && current.parentId) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    const parent = sessions.find((s) => s.id === current?.parentId);
    if (!parent) break;
    current = parent;
  }
  return current?.id ?? id;
}

export interface ConsoleChoice {
  /** The console's key (a session id). */
  id: string;
  name: string;
  /** Under another console's session (a serverReadyAction's browser). */
  depth: number;
  /** Its session still runs. */
  live: boolean;
  /** The compound it was started with, if any. */
  compound?: string;
}

/**
 * The consoles to pick from: the running sessions' (parents first, each child under it; merged
 * children don't have one), then ended sessions whose lines are still there.
 */
export function consoleChoices(
  sessions: readonly ConsoleSessionInfo[],
  lines: readonly ConsoleLine[],
  /** A compound's name from its id (the sessions keep the id). */
  compoundName: (id: string) => string = (id) => id,
): ConsoleChoice[] {
  const out: ConsoleChoice[] = [];
  const own = sessions.filter((s) => consoleKeyOf(s.id, sessions) === s.id);
  const ids = new Set(own.map((s) => s.id));
  const visit = (s: ConsoleSessionInfo, depth: number) => {
    out.push({
      id: s.id,
      name: s.name,
      depth,
      live: true,
      ...(s.compound ? { compound: compoundName(s.compound) } : {}),
    });
    for (const c of own) if (c.parentId === s.id) visit(c, depth + 1);
  };
  for (const s of own) if (!s.parentId || !ids.has(s.parentId)) visit(s, 0);
  for (const line of lines) {
    const id = line.sessionId;
    if (!id || out.some((c) => c.id === id)) continue;
    out.push({ id, name: line.session ?? id, depth: 0, live: false });
  }
  return out;
}

/** The lines console `key` shows: its own and those of no session (null: every line). */
export function linesForConsole(
  lines: readonly ConsoleLine[],
  key: string | null,
): readonly ConsoleLine[] {
  if (key === null) return lines;
  return lines.filter((l) => !l.sessionId || l.sessionId === key);
}

/** The lines left after clearing console `key` (null: all of them). */
export function clearConsoleLines(
  lines: readonly ConsoleLine[],
  key: string | null,
): ConsoleLine[] {
  if (key === null) return [];
  return lines.filter((l) => l.sessionId !== undefined && l.sessionId !== key);
}

/** The longest unfinished output line joined with what follows; past it, a new entry. */
const MAX_JOINED = 100_000;

/**
 * Output that continues an unfinished line (VS Code's debug console): the same session's output
 * of the same stream after text without a final line break ("Name? ", "Loading…") is joined to
 * it, carriage returns redrawing its last line ("10%" then "\r50%" shows "50%"). A new entry
 * (null) otherwise.
 */
export function continueOutput(
  last: ConsoleLine | undefined,
  line: ConsoleLine,
): ConsoleLine | null {
  if (
    last?.kind !== "output" ||
    line.kind !== "output" ||
    last.text.endsWith("\n") ||
    last.text.length > MAX_JOINED ||
    last.sessionId !== line.sessionId ||
    last.source !== line.source ||
    (last.stderr ?? false) !== (line.stderr ?? false)
  )
    return null;
  const start = last.text.lastIndexOf("\n") + 1;
  const [first = "", ...rest] = (last.text.slice(start) + line.text).split("\n");
  const text = [drawn(first), ...rest].join("\n");
  return { ...last, text: last.text.slice(0, start) + text };
}

/** All the console's lines (capped), which console is shown, and what it shows. */
export class DebugConsoles {
  readonly lines: Signal<readonly ConsoleLine[]> = signal([]);
  /** The console on screen: a session id (consoleKeyOf), null before any session. */
  readonly selected: Signal<string | null> = signal(null);
  /** The shown console's lines. */
  readonly shown: ReadonlySignal<readonly ConsoleLine[]> = computed(() =>
    linesForConsole(this.lines.value, this.selected.value),
  );

  constructor(private readonly limit = 5000) {}

  print(line: ConsoleLine): void {
    const lines = this.lines.peek();
    const joined = continueOutput(lines[lines.length - 1], line);
    const next = joined ? [...lines.slice(0, -1), joined] : [...lines, line];
    this.lines.value = next.length > this.limit ? next.slice(-this.limit) : next;
  }

  /** Clears the shown console (VS Code's "Clear console"); `all` empties every one. */
  clear(all = false): void {
    this.lines.value = clearConsoleLines(this.lines.peek(), all ? null : this.selected.peek());
  }
}
