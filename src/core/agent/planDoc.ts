// Plan mode's plan as a document (D330, after Claude Code's plan file and ExitPlanMode): a Plan
// turn's answer is the plan; the IDE saves it as a Markdown file the user can open and edit, the
// chat shows it as a card (Open to edit / Build / Keep planning), and Build hands the file's text,
// as edited, to the agent that builds it. A plan edited by the user goes with the next message in
// Plan mode too, so a revised plan starts from their version. DOM-free and tested.

import type { Item } from "./conversation";

/**
 * The plan a Plan turn ended with (the turn before the "Plan ready" notice at `at`): its last
 * answer with a Markdown heading (a short closing line after it, say after wrap_up, isn't the
 * plan), else its longest answer.
 */
export function planAnswerBefore(items: readonly Item[], at: number): string | null {
  const texts: string[] = [];
  for (let i = Math.min(at, items.length) - 1; i >= 0; i--) {
    const it = items[i];
    if (!it) continue;
    // The turn's user message: where the turn began.
    if (it.type === "user" && !it.auto) break;
    if (it.type === "assistant" && it.text.trim()) texts.push(withoutWrappers(it.text).trim());
  }
  if (!texts.length) return null;
  return (
    texts.find((t) => /^#{1,3}\s+\S/m.test(t)) ??
    texts.reduce((a, b) => (b.length > a.length ? b : a))
  );
}

/** Tags some models wrap an answer in (`<result>`), and a title tag, left out of the document. */
function withoutWrappers(text: string): string {
  return text
    .replace(/^\s*<title>[^<\n]*<\/title>\s*/i, "")
    .replace(/^\s*<(result|answer|plan)>\s*/i, "")
    .replace(/\s*<\/(result|answer|plan)>\s*$/i, "");
}

/** The latest "Plan ready" notice (the one with Build), as its index, or -1. */
export function latestPlanNotice(items: readonly Item[]): number {
  return items.findLastIndex((i) => i.type === "notice" && !!i.actions?.includes("build"));
}

/** Whether the file differs from what the agent wrote (line endings and edges don't count). */
export function planEdited(fileText: string, answer: string): boolean {
  const norm = (t: string) => t.replace(/\r\n?/g, "\n").trim();
  return norm(fileText) !== norm(answer);
}

/** The plan's title: its first heading, else its first line (for the card and lists). */
export function planTitle(text: string): string {
  const heading = /^#{1,3}\s+(.+)$/m.exec(text)?.[1]?.trim();
  const line =
    heading ??
    text
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ??
    "";
  const plain = line.replace(/[*_`]/g, "");
  return plain.length > 80 ? `${plain.slice(0, 77).trimEnd()}…` : plain || "Plan";
}

/** How many steps it has: numbered or checklist lines, else bullets at the left margin. */
export function planSteps(text: string): number {
  const lines = text.split(/\r?\n/);
  const numbered = lines.filter((l) => /^\s{0,3}(\d+[.)]|[-*] \[[ x]\])\s+\S/.test(l)).length;
  return numbered || lines.filter((l) => /^[-*]\s+\S/.test(l)).length;
}

/** The message Build sends: the plan above, or the user's edited version from the file. */
export function buildMessage(
  path: string | null,
  fileText: string | null,
  edited: boolean,
): string {
  if (!path || fileText === null || !fileText.trim()) return "Build it: carry out the plan above.";
  if (!edited) return `Build it: carry out the plan above (saved as ${path}).`;
  return `Build it: carry out the plan as the user edited it (${path}); this version is the one to follow, where it differs from yours:\n\n${fileText.trim()}`;
}

/** What goes with a message in Plan mode when the user edited the plan file since it was written. */
export function editedPlanContext(path: string, fileText: string): string {
  return `The user edited the plan file (${path}). Its current text, to start from when you revise the plan:\n\n${fileText.trim()}`;
}

/** The file's name for a chat: its id (safe as a file name). */
export function planFileName(session: string): string {
  return `${session.replace(/[^\w-]/g, "_")}.md`;
}
