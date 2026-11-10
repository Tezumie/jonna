// Follow the agent (D383, Zed's): with agent.followEdits on, each file the chat you're looking at
// edits opens in a preview tab at the first changed line, as it happens, so you can watch the
// work without hunting for it. A setting only, off by default (the owner wanted no new chat UI):
// jumping the editor around is disruptive. It never takes focus from the chat, and it waits while
// you're typing in an editor, so it never pulls a file from under you.
import type { DisposableStore } from "../../core/lifecycle/index";
import type { WorkbenchServices } from "../../workbench/services";

const SETTING = "agent.followEdits";
/** Edits closer together than this open once, the last one (a burst of edits to several files). */
const SETTLE_MS = 150;
/** Typing in an editor this recently counts as working there. */
const TYPING_MS = 3000;

/**
 * The 1-based line where `after` first differs from `before` (the edit's start), or 1 for a new
 * file. An edit that only removes lines at the end lands on the last line that's left.
 */
export function firstChangedLine(before: string | null, after: string): number {
  if (before === null || before === after) return 1;
  const end = Math.min(before.length, after.length);
  let line = 1;
  for (let i = 0; i < end; i++) {
    if (before.charCodeAt(i) !== after.charCodeAt(i)) return line;
    if (after.charCodeAt(i) === 10) line++;
  }
  // One is a prefix of the other: the change starts where the shorter one ends; added lines
  // ("\nmore") start on the next line. Removed text at the end leaves the last line there is.
  if (after.length > end && after.charCodeAt(end) === 10) line++;
  return Math.min(line, after.split("\n").length);
}

export function registerFollowAgent(
  sub: DisposableStore,
  services: WorkbenchServices,
  activeSession: () => string | null,
): void {
  const { events, settings, dispatcher } = services;
  let pending: { path: string; line: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let typedAt = 0;
  sub.add({ dispose: () => clearTimeout(timer) });
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as Element | null)?.closest?.(".monaco-editor")) typedAt = Date.now();
  };
  document.addEventListener("keydown", onKey, true);
  sub.add({ dispose: () => document.removeEventListener("keydown", onKey, true) });

  const open = () => {
    timer = undefined;
    const next = pending;
    pending = null;
    if (!next || settings.peek<boolean>(SETTING) !== true) return;
    // The user is working in an editor: leave it alone.
    const inEditor = !!document.activeElement?.closest(".monaco-editor");
    if (inEditor && Date.now() - typedAt < TYPING_MS) return;
    void dispatcher
      .execute("editor.openFile", {
        path: next.path,
        line: next.line,
        preview: true,
        preserveFocus: true,
      })
      .catch(() => {});
  };

  sub.add(
    events.on("agent.didEdit", ({ session, path, line }) => {
      if (settings.peek<boolean>(SETTING) !== true || session !== activeSession()) return;
      pending = { path, line };
      clearTimeout(timer);
      timer = setTimeout(open, SETTLE_MS);
    }),
  );
}
