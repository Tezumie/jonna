// Acting on problems (D129): copy them as text (to paste into a chat, an issue, a search) or send
// them to the agent. Shared by the problems tab and the per-file problems list: the same context
// menu and the same text format, `path:line:column - severity source(code): message`, which is
// what compilers print and what agents and people both read without explanation.
import type { MenuItem } from "../../ui/Menu";
import type { Diagnostic } from "./engine";

/** Which problems a command acts on: all, one file's, or the ones at one position. */
export interface ProblemTarget {
  path?: string;
  line?: number;
  column?: number;
  message?: string;
}

export function formatProblem(d: Diagnostic, rel: (path: string) => string): string {
  const origin = `${d.source ?? ""}${d.code ? `(${d.code})` : ""}`;
  // A notebook's problem names its cell (D204): line and column are the cell's.
  const where = d.cell ? ` (cell ${d.cell.index + 1})` : "";
  return `${rel(d.path)}:${d.line}:${d.column}${where} - ${d.severity}${origin ? ` ${origin}` : ""}: ${d.message}`;
}

/** The problems a target names (paths compared with either separator, relative or absolute). */
export function matchProblems(
  all: readonly Diagnostic[],
  target: ProblemTarget,
  rel: (path: string) => string,
): Diagnostic[] {
  const wanted = target.path?.replaceAll("\\", "/");
  return all.filter(
    (d) =>
      (!wanted || rel(d.path) === wanted || d.path.replaceAll("\\", "/") === wanted) &&
      (target.line === undefined || d.line === target.line) &&
      (target.column === undefined || d.column === target.column) &&
      (target.message === undefined || d.message === target.message),
  );
}

/** The agent prompt for fixing problems: the list in a fence, then the ask. */
export function fixPrompt(items: readonly Diagnostic[], rel: (path: string) => string): string {
  const text = items.map((d) => formatProblem(d, rel)).join("\n");
  const fence = "`".repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((m) => m.length + 1)));
  const what = items.length === 1 ? "this problem" : `these ${items.length} problems`;
  return `The language service reports ${what}:\n\n${fence}\n${text}\n${fence}\n\nFix ${items.length === 1 ? "it" : "them"}.`;
}

/** The target of one diagnostic (exact position and message). */
export const targetOf = (d: Diagnostic): Required<ProblemTarget> => ({
  path: d.path,
  line: d.line,
  column: d.column,
  message: d.message,
});

/**
 * The context menu of a problem row. The per-file list (`inFileList`) leaves out "Copy all
 * problems": it only shows one file.
 */
export function problemMenu(
  d: Diagnostic,
  run: (command: string, input?: unknown) => void,
  options: { goTo: () => void; inFileList?: boolean },
): MenuItem[] {
  const one = targetOf(d);
  const items: MenuItem[] = [
    { label: "Go to problem", icon: "arrow-right", run: options.goTo },
    {
      label: "Copy",
      icon: "copy",
      separatorBefore: true,
      run: () => run("problems.copy", one),
    },
    { label: "Copy message", run: () => run("problems.copy", { ...one, format: "message" }) },
    { label: "Copy problems in this file", run: () => run("problems.copy", { path: d.path }) },
  ];
  if (!options.inFileList)
    items.push({ label: "Copy all problems", run: () => run("problems.copy", {}) });
  items.push(
    {
      label: "Fix with agent",
      icon: "agent",
      separatorBefore: true,
      run: () => run("problems.fixWithAgent", one),
    },
    {
      label: "Fix all in this file with agent",
      run: () => run("problems.fixWithAgent", { path: d.path }),
    },
  );
  return items;
}
