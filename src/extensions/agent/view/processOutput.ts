// A background command's output, live (D286, Claude Code's "View live output"): the command, its
// status and how long it has run, Stop while it runs, and what it printed, following new output
// while it runs (unless you scrolled up). A panel tab (`agent.processOutput`, opened by
// agent.showProcessOutput); not restored after a restart (the command is gone by then).

import type { Json } from "../../../core/dock/index";
import { h, on, replaceChildren } from "../../../core/dom/index";
import { DisposableStore, toDisposable } from "../../../core/lifecycle/index";
import { effect } from "../../../core/reactive/index";
import { icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import type { DockView, DockViewDescriptor } from "../../../workbench/dock/views";
import { stateField } from "../../../workbench/dock/views";
import type { WorkbenchServices } from "../../../workbench/services";
import { type BackgroundProcess, backgroundProcesses, runningFor } from "../backgroundProcesses";

export const PROCESS_OUTPUT_VIEW = "agent.processOutput";

/** What the view shows of the output (the buffer keeps up to 1 MB). */
const SHOWN = 400_000;
/** How often it looks for new output while the command runs. */
const POLL_MS = 400;

class ProcessOutputView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly head = h("div", { class: "agent-procout-head" });
  /** The head's buttons' listeners, cleared on each redraw. */
  private readonly headStore = this.store.add(new DisposableStore());
  private readonly pre = h("pre", { class: "agent-procout-text" });
  private shownTotal = -1;

  constructor(
    private readonly id: string,
    private readonly services: WorkbenchServices,
  ) {
    this.element = h(
      "div",
      { class: "agent-procout", tabindex: "-1" },
      this.head,
      h("div", { class: "agent-procout-scroll" }, this.pre),
    );
    // Its status (started, ended, a server address): the head; its output: polled while it runs.
    this.store.add(
      effect(() => {
        backgroundProcesses.version.value;
        this.drawHead();
        this.drawOutput();
        return undefined;
      }),
    );
    const timer = window.setInterval(() => {
      if (this.process()?.status === "running") this.drawOutput();
    }, POLL_MS);
    this.store.add(toDisposable(() => window.clearInterval(timer)));
  }

  private process(): BackgroundProcess | undefined {
    return backgroundProcesses.get(this.id);
  }

  private drawHead(): void {
    this.headStore.clear();
    const p = this.process();
    if (!p) {
      replaceChildren(
        this.head,
        h(
          "span",
          { class: "agent-procout-gone" },
          `${this.id} is gone (it ended a while ago, or the IDE restarted).`,
        ),
      );
      return;
    }
    const running = p.status === "running";
    const status = running
      ? `running · ${runningFor(p)}`
      : `${p.status === "exited" ? `exit ${p.exitCode ?? "?"}` : p.status} · ran ${runningFor(p)}`;
    const stop = running
      ? h(
          "button",
          { class: "button button-secondary button-sm", type: "button" },
          icon("square"),
          "Stop",
        )
      : null;
    if (stop) {
      setTooltip(stop, "Stop it and what it started");
      this.headStore.add(
        on(
          stop,
          "click",
          () =>
            void this.services.dispatcher
              .execute("agent.killProcess", { id: p.id })
              .catch(() => {}),
        ),
      );
    }
    replaceChildren(
      this.head,
      h("span", {
        class: {
          "agent-dot": true,
          "is-running": running,
          "is-failed": !running && p.exitCode !== 0,
        },
      }),
      h("code", { class: "agent-procout-cmd" }, `$ ${p.command}`),
      h(
        "span",
        { class: "agent-procout-status" },
        `${p.id} · ${status}${p.cwd !== "." ? ` · in ${p.cwd}` : ""}`,
      ),
      ...p.urls.slice(0, 2).map((url) => {
        const a = h("button", { class: "link-button agent-procout-url", type: "button" }, url);
        this.headStore.add(
          on(
            a,
            "click",
            () => void this.services.dispatcher.execute("browser.open", { url }).catch(() => {}),
          ),
        );
        return a;
      }),
      h("span", { class: "agent-procout-spacer" }),
      stop,
    );
  }

  /** New output: the text again, following the end unless the user scrolled up. */
  private drawOutput(): void {
    const p = this.process();
    if (!p) return;
    const total = p.output.total;
    if (total === this.shownTotal) return;
    this.shownTotal = total;
    const scroller = this.pre.parentElement;
    const atEnd =
      !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
    const text = p.output.tail(SHOWN);
    this.pre.textContent =
      text || (p.status === "running" ? "Nothing printed yet." : "It printed nothing.");
    if (atEnd && scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  focus(): void {
    this.element.focus();
  }

  serialize(): Json {
    return { id: this.id };
  }

  dispose(): void {
    this.store.dispose();
  }
}

export function processOutputView(services: WorkbenchServices): DockViewDescriptor {
  return {
    type: PROCESS_OUTPUT_VIEW,
    title: (st) => {
      const id = stateField(st, "id");
      const p = typeof id === "string" ? backgroundProcesses.get(id) : undefined;
      return p ? `${p.id} · ${p.command.slice(0, 40)}` : typeof id === "string" ? id : "Output";
    },
    icon: () => "square-terminal",
    defaultPlacement: "bottom",
    create: (st) => {
      const id = stateField(st, "id");
      return new ProcessOutputView(typeof id === "string" ? id : "", services);
    },
  };
}
