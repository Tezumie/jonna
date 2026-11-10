// The debug console (D143): a bottom-panel tab with what the debugger and the program write
// (adapters that don't use a terminal), the session's start and end, and a line to evaluate
// expressions in the selected frame (Enter; Up / Down for earlier ones, each console its own:
// consoleHistory.ts), like VS Code's. One session's console at a time (D209): a picker above the
// lines when there are several (debug.selectConsole; consoleSessions.ts).
import { h, on, replaceChildren } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { icon } from "../../ui/Icon";
import type { DockView, DockViewDescriptor } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { consoleDiff } from "./consoleDiff";
import { ConsoleHistory } from "./consoleHistory";
import { consoleLabel } from "./consolePicker";
import type { ConsoleLine, DebugController } from "./controller";

export function debugConsoleDescriptor(
  services: WorkbenchServices,
  debug: DebugController,
): DockViewDescriptor {
  return {
    type: "debugConsole",
    title: () => "Debug console",
    icon: () => "bug-play",
    singleton: true,
    defaultPlacement: "bottom",
    create: () => new DebugConsoleView(services, debug),
  };
}

/**
 * A value that opens to its properties (each opening further), loaded when first opened, like
 * VS Code's debug console. The program must still be paused where it was evaluated.
 */
function expandable(
  store: DisposableStore,
  debug: DebugController,
  name: string | null,
  value: string,
  ref: number,
  /** The session that produced the value (its console may be a parent's, D209). */
  source: string | undefined,
): HTMLElement {
  const children = h("div", { class: "debug-console-children" });
  const head = h(
    "button",
    { class: "debug-console-toggle", type: "button", "aria-expanded": "false" },
    h("span", { class: "debug-console-caret" }, "›"),
    name !== null ? h("span", { class: "debug-var-name" }, name) : null,
    name !== null ? h("span", { class: "debug-var-sep" }, ": ") : null,
    h("span", { class: "debug-var-value" }, value),
  );
  let loaded = false;
  store.add(
    on(head, "click", () => {
      const open = head.getAttribute("aria-expanded") !== "true";
      head.setAttribute("aria-expanded", String(open));
      children.hidden = !open;
      if (!open || loaded) return;
      loaded = true;
      const session = (source ? debug.session(source)?.session : undefined) ?? debug.active;
      if (!session) {
        children.append(
          h("div", { class: "debug-console-leaf is-info" }, "Not available: the session ended."),
        );
        return;
      }
      void session.variables(ref).then(
        (vars) => {
          for (const v of vars)
            children.append(
              v.ref > 0
                ? expandable(store, debug, v.name, v.value, v.ref, source)
                : h(
                    "div",
                    { class: "debug-console-leaf" },
                    h("span", { class: "debug-var-name" }, v.name),
                    h("span", { class: "debug-var-sep" }, ": "),
                    h("span", { class: `debug-var-value is-${v.type ?? "other"}` }, v.value),
                  ),
            );
          if (!vars.length)
            children.append(
              h(
                "div",
                { class: "debug-console-leaf is-info" },
                "Not available (the program moved on).",
              ),
            );
        },
        () => children.append(h("div", { class: "debug-console-leaf is-info" }, "Not available.")),
      );
    }),
  );
  children.hidden = true;
  return h("div", { class: "debug-console-node" }, head, children);
}

class DebugConsoleView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly input: HTMLInputElement;
  /** One input history per console (consoleHistory.ts). */
  private readonly history = new ConsoleHistory();

  constructor(services: WorkbenchServices, debug: DebugController) {
    const log = h("div", { class: "debug-console-log", role: "log", "aria-live": "polite" });
    this.input = h("input", {
      class: "debug-console-input",
      type: "text",
      spellcheck: "false",
      placeholder: "Evaluate an expression (while debugging)",
      "aria-label": "Debug console input",
    });
    // The session picker (VS Code's): shown when more than one console has something.
    const pickerLabel = h("span", { class: "debug-console-session-name" });
    const picker = h(
      "button",
      {
        class: "debug-console-session",
        type: "button",
        "aria-label": "Debug console of session",
        "aria-haspopup": "menu",
      },
      icon("bug-play"),
      pickerLabel,
      icon("chevron-down"),
    );
    const bar = h("div", { class: "debug-console-bar" }, picker);
    this.store.add(
      on(picker, "click", () => {
        const box = picker.getBoundingClientRect();
        void services.dispatcher
          .execute("debug.selectConsole", { x: box.left, y: box.bottom })
          .catch(() => {});
      }),
    );
    this.store.add(
      effect(() => {
        const all = debug.consoleList();
        const current = debug.consoles.selected.value;
        const shown = all.find((c) => c.id === current);
        bar.hidden = all.length < 2;
        pickerLabel.textContent = shown ? consoleLabel(shown) : "All sessions";
        return undefined;
      }),
    );
    this.element = h(
      "div",
      { class: "debug-console", tabindex: "-1" },
      bar,
      log,
      h("div", { class: "debug-console-prompt" }, icon("chevron-right"), this.input),
    );
    /**
     * The lines shown, in DOM order, each with the listeners of its expandable value (if any) so
     * a line dropped off the top takes its listeners with it.
     */
    let shown: { line: ConsoleLine; store: DisposableStore | null }[] = [];
    const lineStore = this.store.add(new DisposableStore());
    // Rows as the browser DevTools console's: a glyph for the kind, then the text.
    const glyph = (line: ConsoleLine): Element =>
      line.kind === "input"
        ? icon("chevron-right")
        : line.kind === "result"
          ? icon("arrow-left")
          : line.kind === "error" || line.stderr
            ? icon("circle-x")
            : line.kind === "info"
              ? icon("info")
              : h("span", { class: "debug-console-dot" });
    const render = (line: ConsoleLine): { el: HTMLElement; store: DisposableStore | null } => {
      const kind = `debug-console-line is-${line.kind}${line.stderr ? " is-stderr" : ""}`;
      if (line.ref) {
        const store = lineStore.add(new DisposableStore());
        return {
          el: h(
            "div",
            { class: kind },
            glyph(line),
            h(
              "span",
              { class: "debug-console-text" },
              expandable(store, debug, null, line.text, line.ref, line.source),
            ),
          ),
          store,
        };
      }
      return {
        el: h(
          "div",
          { class: kind },
          glyph(line),
          h("span", { class: "debug-console-text" }, line.text.replace(/\n$/, "")),
        ),
        store: null,
      };
    };
    this.store.add(
      effect(() => {
        const lines = debug.consoles.shown.value;
        const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
        // The controller caps the list (dropping the oldest), so its length stops growing once
        // full: diff by the last line shown, not by count, or nothing new would ever appear.
        let plan = consoleDiff(
          shown.map((s) => s.line),
          lines,
        );
        if (plan && log.childElementCount !== shown.length) plan = null;
        if (!plan) {
          replaceChildren(log);
          lineStore.clear();
          shown = [];
          plan = { drop: 0, appendFrom: 0 };
        }
        for (const dropped of shown.splice(0, plan.drop)) {
          log.firstElementChild?.remove();
          if (dropped.store) lineStore.delete(dropped.store);
        }
        // An unfinished line the next output continued: drawn again with its new text.
        if (plan.redrawLast) {
          const continued = shown.pop();
          log.lastElementChild?.remove();
          if (continued?.store) lineStore.delete(continued.store);
        }
        for (const line of lines.slice(plan.appendFrom)) {
          const { el, store } = render(line);
          log.append(el);
          shown.push({ line, store });
        }
        if (stick) log.scrollTop = log.scrollHeight;
        return undefined;
      }),
    );
    // The shown console's history: by its session's name (a restarted session keeps it); the
    // lines of no session ("All sessions") have one of their own.
    const historyKey = () => {
      const current = debug.consoles.selected.peek();
      return debug.consoleList().find((c) => c.id === current)?.name ?? "";
    };
    this.store.add(
      on(this.input, "keydown", (e) => {
        if (e.key === "Enter") {
          const expression = this.input.value.trim();
          if (!expression) return;
          e.preventDefault();
          this.history.add(historyKey(), expression);
          this.input.value = "";
          void services.dispatcher.execute("debug.evaluate", { expression }).catch(() => {});
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          const line = this.history.move(
            historyKey(),
            e.key === "ArrowUp" ? -1 : 1,
            this.input.value,
          );
          if (line === null) return;
          e.preventDefault();
          this.input.value = line;
        }
      }),
    );
  }

  focus(): void {
    this.input.focus();
  }

  serialize(): null {
    return null;
  }

  dispose(): void {
    this.store.dispose();
    this.element.remove();
  }
}
