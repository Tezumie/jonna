// The agent's edits reviewed in the editor itself (D199, Cursor's way): in a file the agent
// changed, each change under review is tinted with a bar in the margin and a hint after it; keys,
// the editor's context menu and its title bar keep or undo the change at the cursor, or the whole
// file, and jump between changes. Everything goes through the changeset (changeset.ts), so the
// chat's cards, the diff tabs and the inline view agree. Commands: agent.acceptHunk,
// agent.rejectHunk, agent.nextHunk, agent.previousHunk, agent.acceptFile, agent.rejectFile.
// State: ide://agent/review (the files under review and their changes).
import type { DisposableStore } from "../../core/lifecycle/index";
import { pathKey, samePath } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { stateField } from "../../workbench/dock/views";
import type { GutterMark } from "../../workbench/gutterMarks";
import type { WorkbenchServices } from "../../workbench/services";
import type { ReviewHunk } from "./changeset";
import type { AgentSession } from "./session";
import type { SessionManager } from "./sessions";

const OWNER = "agent-review";
const HINT = "Agent edit · Ctrl+Alt+Y keep · Ctrl+Alt+N undo";

export function registerInlineReview(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): void {
  const { dispatcher, extensionFeatures, gutterMarks, state, workspace, context, events, dock } =
    services;
  /** The files under review now, with their changes in current lines (by pathKey). */
  let shown = new Map<string, { path: string; session: AgentSession; hunks: ReviewHunk[] }>();

  /** The session reviewing `path`, if any. */
  const owner = (path: string): AgentSession | undefined =>
    sessions.all().find((s) => s.changeset.get(path) !== undefined);

  const activePath = (): string | null => {
    const tab = dock.activeTab();
    if (tab?.viewType !== "editor") return null;
    const p = stateField(tab.viewState, "path");
    return typeof p === "string" && !p.startsWith("virtual:") ? p : null;
  };

  let seq = 0;
  /** Recomputes every file's changes and draws them (margin bars, tint, hint). */
  const refresh = async () => {
    const mine = ++seq;
    const next = new Map<string, { path: string; session: AgentSession; hunks: ReviewHunk[] }>();
    for (const session of sessions.all())
      for (const f of session.changeset.files.peek()) {
        if (f.deleted) continue;
        const hunks = await session.changeset.hunks(f.path).catch(() => []);
        if (mine !== seq) return;
        if (hunks.length) next.set(pathKey(f.path), { path: f.path, session, hunks });
      }
    // What was drawn for files no longer under review goes.
    for (const [key, old] of shown)
      if (!next.has(key))
        extensionFeatures.setDecorations({
          owner: OWNER,
          key: "changes",
          path: old.path,
          style: "highlight",
          ranges: [],
        });
    const marks = new Map<string, GutterMark[]>();
    for (const [key, f] of next) {
      extensionFeatures.setDecorations({
        owner: OWNER,
        key: "changes",
        path: f.path,
        style: "highlight",
        ranges: f.hunks.map((h) => ({
          startLine: h.startLine,
          // A pure deletion marks the line after it (there are no lines of its own).
          endLine: h.startLine + Math.max(h.lines, 1) - 1,
          hover: `**Agent edit** (+${h.added} −${h.removed}). Keep it: Ctrl+Alt+Y; undo it: Ctrl+Alt+N; next change: Alt+F5.`,
        })),
        after: HINT,
        // On the scrollbar and the minimap too, as git's changes are (D273).
        mapped: true,
      });
      marks.set(
        key,
        f.hunks.flatMap((h) =>
          Array.from({ length: Math.max(h.lines, 1) }, (_, i) => ({
            line: h.startLine + i,
            className: h.lines === 0 ? "agent-review-glyph is-deleted" : "agent-review-glyph",
            hover: "Agent edit under review",
          })),
        ),
      );
    }
    gutterMarks.set(OWNER, marks);
    shown = next;
    updateContext();
    // The editor's title bar buttons follow (they're computed with the tab's actions).
    dock.decorations.value = dock.decorations.peek() + 1;
  };

  const updateContext = () => {
    const p = activePath();
    context.set("agentReviewActive", !!p && shown.has(pathKey(p)));
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 150);
  };
  sub.add({
    dispose: () => {
      clearTimeout(timer);
      extensionFeatures.clearDecorations(OWNER);
      gutterMarks.set(OWNER, new Map());
    },
  });
  // Any changeset changing, a session coming or going.
  sub.add(
    effect(() => {
      sessions.listVersion.value;
      sessions.members.value;
      for (const s of sessions.all()) s.changeset.files.value;
      soon();
      return undefined;
    }),
  );
  // Typing in, saving or changing a file under review moves its changes.
  sub.add(
    services.documents.onDidChange((path) => (shown.has(pathKey(path)) ? soon() : undefined)),
  );
  for (const name of ["files.didSave", "files.didChange"] as const)
    sub.add(events.on(name, ({ path }) => (shown.has(pathKey(path)) ? soon() : undefined)));
  sub.add(
    effect(() => {
      dock.root.value;
      dock.focusedGroupId.value;
      updateContext();
      return undefined;
    }),
  );
  sub.add(
    extensionFeatures.addMenus([
      {
        owner: OWNER,
        location: "editor/title",
        command: "agent.acceptFile",
        title: "Keep the agent's changes in this file",
        icon: "check",
        when: "agentReviewActive",
      },
      {
        owner: OWNER,
        location: "editor/title",
        command: "agent.rejectFile",
        title: "Undo the agent's changes in this file",
        icon: "x",
        when: "agentReviewActive",
      },
      {
        owner: OWNER,
        location: "editor/context",
        command: "agent.acceptHunk",
        title: "Keep this agent change",
        when: "agentReviewActive",
      },
      {
        owner: OWNER,
        location: "editor/context",
        command: "agent.rejectHunk",
        title: "Undo this agent change",
        when: "agentReviewActive",
      },
    ]),
  );

  /** The active editor's file and cursor line (from its state). */
  const cursor = async (): Promise<{ path: string; line: number } | null> => {
    const snap = await state.get("ide://editors/active").catch(() => null);
    const v = snap?.value as { absolutePath?: string | null; cursor?: { line: number } } | null;
    return v?.absolutePath ? { path: v.absolutePath, line: v.cursor?.line ?? 1 } : null;
  };
  const resolve = (p: string) => workspace.resolve(p);

  /** The file and change a command acts on: `path` + `index` / `line`, else the cursor's. */
  const target = async (input: { path?: string; line?: number; index?: number }) => {
    const at = input.path ? null : await cursor();
    const path = input.path ? resolve(input.path) : at?.path;
    if (!path) throw new Error("No file: open one the agent changed, or pass `path`.");
    const session = owner(path);
    if (!session) throw new Error("The agent has no changes under review in this file.");
    const hunks = await session.changeset.hunks(path);
    if (!hunks.length) throw new Error("No change under review in this file.");
    let hunk: ReviewHunk | undefined;
    if (input.index !== undefined) hunk = hunks[input.index];
    else {
      const line = input.line ?? at?.line ?? 1;
      hunk = hunks.find((h) => line >= h.startLine && line < h.startLine + Math.max(h.lines, 1));
    }
    return { path, session, hunks, hunk };
  };
  const done = async (path: string, session: AgentSession) => {
    await refresh();
    return {
      path,
      remaining: shown.get(pathKey(path))?.hunks.length ?? 0,
      pending: session.changeset.files.peek().length,
    };
  };
  const hunkInput = s.object({
    path: s.string().describe("File (default: the active editor's)").optional(),
    index: s.integer({ min: 0 }).describe("Which change, 0-based (ide://agent/review)").optional(),
    line: s.integer({ min: 1 }).describe("A line of the change (default: the cursor's)").optional(),
  });
  const actOnHunk =
    (action: "accept" | "reject") =>
    async (input: { path?: string; index?: number; line?: number }) => {
      const t = await target(input);
      if (!t.hunk) throw new Error("No agent change at that line (agent.nextHunk goes to one).");
      await t.session.changeset.hunk(t.path, t.hunk.startLine, action);
      return done(t.path, t.session);
    };
  sub.add(
    dispatcher.register({
      id: "agent.acceptHunk",
      title: "Keep this agent change",
      category: "Agent",
      description:
        "Keeps one change the agent made to a file under review (default: the one at the active editor's cursor): it stays and leaves the review. Returns how many changes are left.",
      input: hunkInput,
      effects: ["write"],
      agent: "hidden",
      run: actOnHunk("accept"),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.rejectHunk",
      title: "Undo this agent change",
      category: "Agent",
      description:
        "Undoes one change the agent made to a file under review (default: the one at the active editor's cursor): those lines get back what they held. Returns how many changes are left.",
      input: hunkInput,
      effects: ["write"],
      agent: "hidden",
      run: actOnHunk("reject"),
    }),
  );
  const jump = (step: 1 | -1) => async () => {
    const at = await cursor();
    const files = [...shown.values()];
    if (!files.length) throw new Error("No agent changes under review.");
    // Within the active file first, then the next file under review.
    const here = at ? files.find((f) => samePath(f.path, at.path)) : undefined;
    const line = at?.line ?? 0;
    let path: string | undefined;
    let to: number | undefined;
    if (here) {
      const list = here.hunks.map((h) => h.startLine);
      to = step === 1 ? list.find((l) => l > line) : [...list].reverse().find((l) => l < line);
      if (to !== undefined) path = here.path;
    }
    if (path === undefined) {
      const i = here ? files.indexOf(here) : -1;
      const other = files[(i + step + files.length) % files.length] ?? files[0];
      if (!other) throw new Error("No agent changes under review.");
      path = other.path;
      to = step === 1 ? other.hunks[0]?.startLine : other.hunks[other.hunks.length - 1]?.startLine;
    }
    await dispatcher.execute("editor.openFile", { path, line: to ?? 1 });
    return { path, line: to ?? 1 };
  };
  sub.add(
    dispatcher.register({
      id: "agent.nextHunk",
      title: "Go to the next agent change",
      category: "Agent",
      description:
        "Moves the cursor to the next change of the agent's under review: in the active file, then the next file.",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: jump(1),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.previousHunk",
      title: "Go to the previous agent change",
      category: "Agent",
      description: "Moves the cursor to the previous change of the agent's under review.",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: jump(-1),
    }),
  );
  const actOnFile = (action: "accept" | "reject") => async (input: { path?: string }) => {
    const path = input.path ? resolve(input.path) : (activePath() ?? undefined);
    if (!path) throw new Error("No file: open one the agent changed, or pass `path`.");
    const session = owner(path);
    if (!session) throw new Error("The agent has no changes under review in this file.");
    await dispatcher.execute("agent.reviewChange", { session: session.id, path, action });
    return done(path, session);
  };
  sub.add(
    dispatcher.register({
      id: "agent.acceptFile",
      title: "Keep the agent's changes in this file",
      category: "Agent",
      description:
        "Keeps every change the agent made to a file under review (default: the active editor's).",
      input: s.object({ path: s.string().optional() }),
      effects: ["write"],
      agent: "hidden",
      run: actOnFile("accept"),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.rejectFile",
      title: "Undo the agent's changes in this file",
      category: "Agent",
      description:
        "Undoes every change the agent made to a file under review (default: the active editor's): it gets back what it held before, on top of anything typed since.",
      input: s.object({ path: s.string().optional() }),
      effects: ["write"],
      agent: "hidden",
      run: actOnFile("reject"),
    }),
  );
  sub.add(
    state.register("ide://agent/review", {
      description:
        "The agent's changes under review, by file (D199): each change's first line in the file as it is now, its line count (0: lines removed), and lines added / removed. agent.acceptHunk / agent.rejectHunk take `path` and `index`.",
      get: () => ({
        files: [...shown.values()].map((f) => ({
          path: f.path,
          session: f.session.id,
          changes: f.hunks,
        })),
      }),
    }),
  );
}
