// The debug toolbar (D145), as in VS Code: while a session runs, continue / pause, step over,
// into, out, restart and stop. `debug.toolBarLocation` puts it floating over the top of the
// window ("floating", the default; drag its grip to move it along), in the Run and debug view
// ("docked") or nowhere ("hidden"). Each button runs a command.
import { h, on } from "../../core/dom/index";
import { type DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { type IconName, icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import type { WorkbenchServices } from "../../workbench/services";
import type { DebugController } from "./controller";

export type ToolbarLocation = "floating" | "docked" | "hidden";

/** The toolbar's buttons (the view builds its docked copy with the same function). */
export function debugToolbar(
  store: DisposableStore,
  services: WorkbenchServices,
  debug: DebugController,
  run: (command: string) => void,
): HTMLElement {
  const button = (name: IconName, title: string, command: string, cls = "") => {
    const b = h(
      "button",
      { class: `icon-button debug-tool ${cls}`, type: "button", "aria-label": title },
      icon(name),
    );
    const key = services.keyboard.labelFor(command);
    setTooltip(b, key ? `${title} (${key})` : title);
    store.add(on(b, "click", () => run(command)));
    return b;
  };
  const cont = button("play", "Continue", "debug.continue", "is-continue");
  const pause = button("pause", "Pause", "debug.pause");
  // Several sessions (D204): which one the buttons act on, as in VS Code's toolbar.
  const sessions = h("select", {
    class: "input debug-session-select",
    "aria-label": "Debug session",
  });
  setTooltip(sessions, "The session the toolbar acts on");
  store.add(
    on(sessions, "change", () =>
      services.dispatcher
        .execute("debug.focusSession", { session: sessions.value })
        .catch(() => {}),
    ),
  );
  store.add(
    effect(() => {
      const stopped = debug.state.value === "stopped";
      cont.hidden = !stopped;
      pause.hidden = stopped;
      const list = debug.sessions.value;
      const focused = debug.focusedId.value;
      sessions.hidden = list.length < 2;
      sessions.replaceChildren(...list.map((rs) => h("option", { value: rs.id }, rs.name)));
      if (focused) sessions.value = focused;
      return undefined;
    }),
  );
  return h(
    "div",
    { class: "debug-toolbar", role: "toolbar", "aria-label": "Debug" },
    sessions,
    cont,
    pause,
    button("redo-dot", "Step over", "debug.stepOver"),
    button("arrow-down-to-dot", "Step into", "debug.stepInto"),
    button("arrow-up-from-dot", "Step out", "debug.stepOut"),
    button("rotate-cw", "Restart", "debug.restart"),
    button("square", "Stop", "debug.stop", "is-stop"),
  );
}

/** The floating toolbar over the window, while a session runs and the setting says so. */
export function registerFloatingToolbar(
  store: DisposableStore,
  services: WorkbenchServices,
  debug: DebugController,
  run: (command: string) => void,
): void {
  const grip = h(
    "span",
    { class: "debug-float-grip", "aria-hidden": "true" },
    icon("grip-vertical"),
  );
  const bar = h("div", { class: "debug-float" }, grip, debugToolbar(store, services, debug, run));
  bar.hidden = true;
  document.body.append(bar);
  store.add(toDisposable(() => bar.remove()));
  /** Left edge as a share of the window's width (kept while the IDE runs, like VS Code). */
  let at: number | null = null;
  const place = () => {
    if (at === null) {
      bar.style.left = "50%";
      bar.style.transform = "translateX(-50%)";
      return;
    }
    const max = window.innerWidth - bar.offsetWidth - 8;
    bar.style.left = `${Math.max(8, Math.min(max, at * window.innerWidth))}px`;
    bar.style.transform = "none";
  };
  store.add(on(window, "resize", place));
  store.add(
    on(grip, "pointerdown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startLeft = bar.getBoundingClientRect().left;
      grip.setPointerCapture(e.pointerId);
      const move = on(grip, "pointermove", (m) => {
        at = (startLeft + m.clientX - startX) / window.innerWidth;
        place();
      });
      const end = () => {
        store.delete(move);
        store.delete(up);
        store.delete(cancel);
      };
      const up = on(grip, "pointerup", end);
      const cancel = on(grip, "pointercancel", end);
      store.add(move);
      store.add(up);
      store.add(cancel);
    }),
  );
  store.add(
    effect(() => {
      services.settings.version.value;
      const location =
        services.settings.peek<ToolbarLocation>("debug.toolBarLocation") ?? "floating";
      bar.hidden = debug.state.value === "inactive" || location !== "floating";
      if (!bar.hidden) place();
      return undefined;
    }),
  );
}
