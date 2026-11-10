// The chip under the conversation (D326, Claude Code's "12 background commands completed, 1
// failed, 3 running"): an icon, two lines (what they are; how they stand), a chevron. Shown
// while the chat has background tasks (running, or finished and not cleared); a click opens the
// Background tasks view (agent.showBackgroundTasks). It replaces the strip of background
// commands that sat above the message box (D201, D286): the view lists them, with their output.

import { chipLines } from "../../../core/agent/backgroundTasks";
import { h, on } from "../../../core/dom/index";
import { type Disposable, DisposableStore } from "../../../core/lifecycle/index";
import { effect } from "../../../core/reactive/index";
import { icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import { backgroundTaskSource } from "../backgroundTasks";

export class BackgroundChip implements Disposable {
  readonly element: HTMLElement;
  /** There is something to show (the conversation puts the chip in its column). */
  visible = false;
  private readonly store = new DisposableStore();
  private readonly title = h("span", { class: "agent-bgchip-title" });
  private readonly detail = h("span", { class: "agent-bgchip-detail" });
  private readonly status = h("span", { class: "agent-bgchip-icon" });

  constructor(
    session: string,
    run: (command: string, input?: unknown) => void,
    /** Visibility changed: the conversation redraws. */
    changed: () => void,
  ) {
    this.element = h(
      "button",
      { class: "agent-bgchip", type: "button", "data-session": session },
      this.status,
      h("span", { class: "agent-bgchip-text" }, this.title, this.detail),
      h("span", { class: "agent-bgchip-chevron" }, icon("chevron-right")),
    );
    setTooltip(this.element, "Background tasks", "agent.showBackgroundTasks");
    this.store.add(on(this.element, "click", () => run("agent.showBackgroundTasks", { session })));
    let shownIcon: "working" | "serving" | "idle" | null = null;
    this.store.add(
      effect(() => {
        const tasks = backgroundTaskSource.value?.tasks(session) ?? [];
        const lines = chipLines(tasks);
        const running = tasks.some((t) => t.status === "running");
        // A spinner only while something works; servers that are up show a server (D367).
        const look = tasks.some((t) => t.status === "running" && !t.serving)
          ? "working"
          : running
            ? "serving"
            : "idle";
        this.title.textContent = lines?.title ?? "";
        this.detail.textContent = lines?.detail ?? "";
        this.element.classList.toggle("is-running", running);
        this.element.classList.toggle(
          "has-failed",
          tasks.some((t) => t.status === "failed"),
        );
        if (shownIcon !== look) {
          shownIcon = look;
          this.status.replaceChildren(
            look === "working"
              ? h("span", { class: "agent-spinner" })
              : icon(look === "serving" ? "server" : "list-checks"),
          );
        }
        if (this.visible !== !!lines) {
          this.visible = !!lines;
          changed();
        }
        return undefined;
      }),
    );
  }

  dispose(): void {
    this.store.dispose();
  }
}
