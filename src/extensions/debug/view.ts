// "Run and debug" (D143, D145, D204), VS Code's debug sidebar: the configuration (or compound) to
// start and its button — still there while sessions run, to start another — with the debug
// toolbar when docked, then Variables (a lazy tree of the selected frame's scopes), Watch, Call
// stack (sessions and threads, callStack.ts), Loaded scripts and Breakpoints (breakpointsView.ts).
// Everything a row does is a command; the view only reads the controller.
import { h, on, replaceChildren } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { type IconName, icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import type { Tree } from "../../ui/Tree";
import type { WorkbenchServices } from "../../workbench/services";
import type { ViewInstance } from "../../workbench/views";
import { breakpointsList } from "./breakpointsView";
import { callStackSection } from "./callStack";
import type { DebugController } from "./controller";
import { loadedScriptsSection } from "./loadedScripts";
import { debugToolbar } from "./toolbar";
import { type ValueNode, valueTree } from "./valueTree";
import type { Watches } from "./watches";

/** The picker's value for a compound (D204): its name after this. */
export const COMPOUND_PREFIX = "compound:";

export interface ConfigChoice {
  /** The configuration's name; "" for the active file; COMPOUND_PREFIX + name for a compound. */
  name: string;
  label: string;
  detail: string;
  /** A line above it: another launch.json `presentation.group` starts (D207). */
  separatorBefore?: boolean;
}

export class DebugView implements ViewInstance {
  private readonly store = new DisposableStore();
  private readonly element: HTMLElement;
  private readonly tree: Tree<ValueNode>;
  private readonly configSelect: HTMLSelectElement;
  /** Re-reads the configurations (launch.json changed, the active file changed). */
  reload: () => Promise<void> = async () => {};

  constructor(
    host: HTMLElement,
    services: WorkbenchServices,
    debug: DebugController,
    private readonly choices: () => Promise<ConfigChoice[]>,
    watches: Watches,
  ) {
    const run = (command: string, input: unknown = {}) =>
      void services.dispatcher.execute(command, input).catch((err: unknown) => {
        services.notifications.show("error", err instanceof Error ? err.message : String(err));
      });
    const button = (name: IconName, title: string, command: string, cls = "") => {
      const b = h(
        "button",
        { class: `icon-button debug-tool ${cls}`, type: "button", "aria-label": title },
        icon(name),
      );
      const key = services.keyboard.labelFor(command);
      setTooltip(b, key ? `${title} (${key})` : title);
      this.store.add(on(b, "click", () => run(command)));
      return b;
    };

    // Start row: configuration + play, or the toolbar while a session runs.
    this.configSelect = h("select", {
      class: "input debug-config",
      "aria-label": "Launch configuration",
    });
    const start = h(
      "button",
      { class: "button button-primary debug-start", type: "button" },
      icon("play"),
      "Run and debug",
    );
    this.store.add(
      on(start, "click", () => {
        const v = this.configSelect.value;
        run(
          "debug.start",
          v.startsWith(COMPOUND_PREFIX)
            ? { compound: v.slice(COMPOUND_PREFIX.length) }
            : v
              ? { name: v }
              : {},
        );
      }),
    );
    const gear = button("settings", "Open launch.json", "debug.openLaunchJson");
    const startRow = h(
      "div",
      { class: "debug-start-row" },
      start,
      h("div", { class: "debug-config-row" }, this.configSelect, gear),
    );
    // The toolbar shows here when docked (debug.toolBarLocation); it floats otherwise.
    const toolbar = debugToolbar(this.store, services, debug, (c) => run(c));
    const status = h("div", { class: "debug-status" });
    const top = h("div", { class: "debug-top" });

    // Variables and Watch (valueTree.ts).
    const varsBody = h("div", { class: "debug-vars" });
    this.tree = valueTree(
      varsBody,
      this.store,
      debug,
      () =>
        debug.scopes
          .peek()
          .map((sc) => ({ kind: "scope" as const, ...sc, id: `scope:${sc.name}` })),
      "Variables",
      run,
    );
    const watchBody = h("div", { class: "debug-vars debug-watch" });
    const watchTree = valueTree(
      watchBody,
      this.store,
      debug,
      () =>
        watches.expressions.peek().map((expression) => ({
          kind: "watch" as const,
          expression,
          result: watches.values.peek().get(expression) ?? null,
          id: `watch:${expression}`,
        })),
      "Watch",
      run,
    );
    const watchEmpty = h("div", { class: "debug-empty" }, "Add an expression with +");
    watchBody.append(watchEmpty);
    this.store.add(
      effect(() => {
        const count = watches.expressions.value.length;
        watches.values.value;
        // The tree draws only what fits its height: room for the expressions (more scroll).
        watchBody.style.height = count ? `${Math.min(count + 2, 8) * 22}px` : "";
        watchEmpty.hidden = count > 0;
        void watchTree.setRoot({ kind: "root" });
        return undefined;
      }),
    );

    const section = (title: string, body: HTMLElement, actions: HTMLElement[] = []) =>
      h(
        "section",
        { class: "debug-section" },
        h(
          "div",
          { class: "debug-section-title" },
          h("span", {}, title),
          h("span", { class: "debug-section-actions" }, ...actions),
        ),
        body,
      );
    const varsSection = section("Variables", varsBody);
    const watchSection = section("Watch", watchBody, [
      button("plus", "Add expression", "debug.addWatch"),
      button("list-x", "Remove all expressions", "debug.removeAllWatches"),
    ]);
    const stackSection = section("Call stack", callStackSection(this.store, debug, run));
    const bpSection = section("Breakpoints", breakpointsList(this.store, debug, run), [
      button("plus", "Add function breakpoint", "debug.addFunctionBreakpoint"),
      button("circle-check", "Enable or disable all breakpoints", "debug.toggleAllBreakpoints"),
      button("list-x", "Remove all breakpoints", "debug.removeAllBreakpoints"),
    ]);
    const loaded = loadedScriptsSection(this.store, services, debug, run);
    this.element = h(
      "div",
      { class: "debug-view" },
      top,
      varsSection,
      watchSection,
      stackSection,
      loaded,
      bpSection,
    );
    host.append(this.element);

    // Top: start row or toolbar; status line.
    this.store.add(
      effect(() => {
        const state = debug.state.value;
        const info = debug.stopInfo.value;
        const config = debug.config.value;
        services.settings.version.value;
        const docked = services.settings.peek<string>("debug.toolBarLocation") === "docked";
        const name = debug.focused.value?.name ?? config?.name ?? "";
        const count = debug.sessions.value.length;
        // The configuration picker stays while debugging: another session can start beside it.
        if (state === "inactive") replaceChildren(top, startRow);
        else replaceChildren(top, startRow, ...(docked ? [toolbar] : []), status);
        status.textContent =
          (state === "starting"
            ? `Starting ${name}…`
            : state === "stopped"
              ? `Paused on ${info?.reason ?? "pause"}${info?.text ? `: ${info.text}` : ""}`
              : state === "running"
                ? `Running ${name}`
                : "") + (count > 1 ? ` · ${count} sessions` : "");
        varsSection.hidden = state === "inactive";
        stackSection.hidden = state === "inactive";
        return undefined;
      }),
    );
    // Configurations: refreshed when the view is shown or a file opens.
    const loadChoices = async () => {
      const list = await this.choices().catch(() => []);
      const keep = this.configSelect.value;
      replaceChildren(
        this.configSelect,
        ...list.flatMap((c) => [
          // VS Code's separator in this list: a disabled row of box-drawing dashes.
          ...(c.separatorBefore
            ? [h("option", { disabled: true, class: "debug-config-separator" }, "─".repeat(9))]
            : []),
          h("option", { value: c.name, title: c.detail }, c.label),
        ]),
      );
      if (list.some((c) => c.name === keep)) this.configSelect.value = keep;
      if (!list.length)
        this.configSelect.append(h("option", { value: "" }, "Open a file or add launch.json"));
      this.configSelect.disabled = !list.length;
    };
    void loadChoices();
    this.store.add(on(this.configSelect, "focus", () => void loadChoices()));
    // The active file can change while the view is open: refresh when the pointer comes back.
    this.store.add(on(top, "pointerenter", () => void loadChoices()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.store.add(
      effect(() => {
        services.dock.root.value;
        clearTimeout(timer);
        timer = setTimeout(() => void loadChoices(), 250);
        return undefined;
      }),
    );
    this.store.add({ dispose: () => clearTimeout(timer) });
    this.reload = loadChoices;

    // Variables follow the frame's scopes.
    this.store.add(
      effect(() => {
        const scopes = debug.scopes.value;
        void this.tree.setRoot(
          { kind: "root" },
          scopes
            .filter((s) => !s.expensive)
            .slice(0, 1)
            .map((s) => `scope:${s.name}`),
        );
        return undefined;
      }),
    );
  }

  /** The configuration picked in the view ("" = the active file), if the list was loaded. */
  selectedConfig(): string | undefined {
    return this.configSelect.disabled ? undefined : this.configSelect.value;
  }

  focus(): void {
    void this.reload();
    (
      this.element.querySelector<HTMLElement>(".debug-start, .debug-tool:not([hidden])") ??
      this.element
    ).focus();
  }

  dispose(): void {
    this.store.dispose();
    this.element.remove();
  }
}
