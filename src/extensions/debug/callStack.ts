// The call stack section (D143; sessions and threads since D204), VS Code's: with one session of
// one thread, just its frames (runtime internals after the program's own folded into one row);
// with more, a tree — each session (child sessions under their parent: Node child processes,
// workers), its threads with their state and pause / continue buttons, and the frames of stopped
// threads. A click focuses the session, selects the thread or the frame; a frame's menu and its
// row's button restart it where the debugger can; everything goes through commands.
import { h, on, replaceChildren } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { basename } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { type IconName, icon } from "../../ui/Icon";
import { showContextMenu } from "../../ui/Menu";
import { setTooltip } from "../../ui/Tooltip";
import type { DebugController, RunningSession } from "./controller";
import type { StackFrame } from "./session";
import { sessionTree } from "./sessionModel";

const stateLabel = (rs: RunningSession): string => {
  const st = rs.state.value;
  if (st === "starting") return "Starting";
  if (st === "running") return rs.kind === "launcher" ? "Running" : "Running";
  const info = rs.stopInfo.value;
  return `Paused on ${info?.reason ?? "pause"}`;
};

export function callStackSection(
  store: DisposableStore,
  debug: DebugController,
  run: (command: string, input?: unknown) => void,
): HTMLElement {
  const list = h("div", {
    class: "debug-list debug-stack",
    role: "tree",
    "aria-label": "Call stack",
  });
  const rows = store.add(new DisposableStore());
  /** Threads whose internal frames are shown (by "session:thread"). */
  const showInternal = new Set<string>();

  const action = (name: IconName, title: string, command: string, input: unknown) => {
    const b = h(
      "button",
      { class: "icon-button debug-row-action", type: "button", "aria-label": title },
      icon(name),
    );
    setTooltip(b, title);
    rows.add(
      on(b, "click", (e) => {
        e.stopPropagation();
        run(command, input);
      }),
    );
    return b;
  };

  const frameRows = (
    rs: RunningSession,
    threadId: number,
    frames: readonly StackFrame[],
    depth: number,
    selected: number | null,
  ): HTMLElement[] => {
    const key = `${rs.id}:${threadId}`;
    const lastOwn = frames.reduce((last, f, i) => (f.path ? i : last), -1);
    const hidden = showInternal.has(key) ? 0 : frames.length - lastOwn - 1;
    // Restart frame (VS Code's, in the frame's menu and on its row) where the debugger can.
    const restartable = rs.capabilities.value.restartFrame;
    const out: HTMLElement[] = frames.slice(0, frames.length - hidden).map((f, i) => {
      const canRestart = restartable && f.canRestart !== false;
      const restart = { index: i, session: rs.id, threadId };
      const select = () => run("debug.selectFrame", { index: i, session: rs.id, threadId });
      const row = h(
        "div",
        {
          class: `debug-row${i === selected ? " is-selected" : ""}${f.path ? "" : " is-internal"}`,
          role: "treeitem",
          tabindex: "0",
          style: { "--depth": String(depth) },
          "data-frame": String(i),
        },
        h("span", { class: "debug-row-main" }, f.name),
        h(
          "span",
          { class: "debug-row-detail" },
          f.path ? `${basename(f.path)}:${f.line}` : "internal",
        ),
        canRestart ? action("rotate-ccw", "Restart frame", "debug.restartFrame", restart) : null,
      );
      rows.add(on(row, "click", select));
      rows.add(
        on(row, "keydown", (e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          select();
        }),
      );
      if (canRestart)
        rows.add(
          on(row, "contextmenu", (e) => {
            e.preventDefault();
            rows.add(
              showContextMenu(e.clientX, e.clientY, [
                {
                  label: "Restart frame",
                  icon: "rotate-ccw",
                  run: () => run("debug.restartFrame", restart),
                },
              ]),
            );
          }),
        );
      return row;
    });
    if (hidden > 0) {
      const more = h(
        "button",
        {
          class: "debug-row is-internal debug-more",
          type: "button",
          role: "treeitem",
          style: { "--depth": String(depth) },
        },
        h(
          "span",
          { class: "debug-row-main" },
          `Show ${hidden} internal frame${hidden === 1 ? "" : "s"}`,
        ),
      );
      rows.add(
        on(more, "click", () => {
          showInternal.add(key);
          render();
        }),
      );
      out.push(more);
    }
    return out;
  };

  const render = () => {
    rows.clear();
    const sessions = debug.sessions.value;
    const focused = debug.focusedId.value;
    const out: HTMLElement[] = [];
    // One session with one thread: its frames, as before (VS Code shows no tree either).
    const single =
      sessions.length === 1 && (sessions[0]?.threads.value.length ?? 0) <= 1 ? sessions[0] : null;
    if (single) {
      const threadId = single.threadId.value ?? single.stopInfo.value?.threadId ?? 1;
      out.push(...frameRows(single, threadId, single.frames.value, 0, single.frameIndex.value));
      replaceChildren(list, ...out);
      return;
    }
    for (const { session: rs, depth } of sessionTree(sessions)) {
      const isFocused = rs.id === focused;
      const st = rs.state.value;
      const row = h(
        "div",
        {
          class: `debug-row debug-session-row${isFocused ? " is-focused" : ""}`,
          role: "treeitem",
          tabindex: "0",
          style: { "--depth": String(depth) },
          "data-session": rs.id,
        },
        icon(rs.kind === "worker" ? "cpu" : st === "stopped" ? "pause" : "bug-play"),
        h("span", { class: "debug-row-main" }, rs.name),
        h("span", { class: "debug-row-detail" }, stateLabel(rs)),
        st === "running"
          ? action("pause", "Pause", "debug.pause", { session: rs.id })
          : st === "stopped"
            ? action("play", "Continue", "debug.continue", { session: rs.id })
            : null,
        action("square", "Stop", "debug.stop", { session: rs.id }),
      );
      rows.add(on(row, "click", () => run("debug.focusSession", { session: rs.id })));
      out.push(row);
      const threads = rs.threads.value;
      const showThreads = threads.length > 1;
      for (const t of threads) {
        const current = rs.threadId.value === t.id;
        if (showThreads) {
          const trow = h(
            "div",
            {
              class: `debug-row debug-thread-row${isFocused && current ? " is-focused" : ""}`,
              role: "treeitem",
              tabindex: "0",
              style: { "--depth": String(depth + 1) },
              "data-thread": String(t.id),
            },
            h("span", { class: "debug-row-main" }, t.name),
            h(
              "span",
              { class: "debug-row-detail" },
              t.stopped ? `Paused on ${t.reason ?? "pause"}` : "Running",
            ),
            t.stopped
              ? action("play", "Continue", "debug.continue", { session: rs.id, threadId: t.id })
              : action("pause", "Pause", "debug.pause", { session: rs.id, threadId: t.id }),
          );
          rows.add(
            on(trow, "click", () => run("debug.selectThread", { session: rs.id, threadId: t.id })),
          );
          out.push(trow);
        }
        if (!t.stopped) continue;
        const frames = current ? rs.frames.value : (t.frames ?? []);
        if (!current && !t.frames) void debug.loadThreadFrames(rs.id, t.id);
        out.push(
          ...frameRows(
            rs,
            t.id,
            frames,
            depth + (showThreads ? 2 : 1),
            isFocused && current ? rs.frameIndex.value : null,
          ),
        );
      }
    }
    replaceChildren(list, ...out);
  };

  store.add(
    effect(() => {
      const sessions = debug.sessions.value;
      debug.focusedId.value;
      for (const rs of sessions) {
        rs.state.value;
        rs.threads.value;
        rs.threadId.value;
        rs.frames.value;
        rs.frameIndex.value;
        rs.stopInfo.value;
        rs.capabilities.value;
      }
      // Internal frames fold again once nothing is stopped.
      if (!sessions.some((s) => s.state.peek() === "stopped")) showInternal.clear();
      render();
      return undefined;
    }),
  );
  return list;
}
