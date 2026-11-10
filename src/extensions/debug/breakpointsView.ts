// The Breakpoints section of "Run and debug" (D143, D145, D204), VS Code's: exception settings
// first — the focused debugger's own filters (debugpy's "Raised exceptions", GDB's "C++: on
// throw"…, with a condition where it takes one) or, for Node and browsers, caught and uncaught —
// then function breakpoints, data breakpoints ("Break on value change" in Variables), instruction
// breakpoints (the disassembly view's) and the line breakpoints (a triggered one says which it
// waits for, and looks pending until that one is hit). Every row's action is a command.
import { h, on, replaceChildren } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { basename } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { icon } from "../../ui/Icon";
import { showContextMenu } from "../../ui/Menu";
import { setTooltip } from "../../ui/Tooltip";
import type { DebugController } from "./controller";
import { isWaiting } from "./triggers";

export function breakpointsList(
  store: DisposableStore,
  debug: DebugController,
  run: (command: string, input?: unknown) => void,
): HTMLElement {
  const bps = h("div", {
    class: "debug-list debug-breakpoints",
    role: "list",
    "aria-label": "Breakpoints",
  });
  const rows = store.add(new DisposableStore());
  const check = (checked: boolean, label: string, onChange: () => void) => {
    const box = h("input", { type: "checkbox", class: "debug-check", "aria-label": label });
    box.checked = checked;
    rows.add(on(box, "change", onChange));
    return box;
  };
  const removeButton = (title: string, command: string, input: unknown) => {
    const b = h(
      "button",
      { class: "icon-button debug-row-action", type: "button", "aria-label": title },
      icon("x"),
    );
    rows.add(
      on(b, "click", (e) => {
        e.stopPropagation();
        run(command, input);
      }),
    );
    return b;
  };
  const menu = (row: HTMLElement, items: Parameters<typeof showContextMenu>[2]) =>
    rows.add(
      on(row, "contextmenu", (e) => {
        e.preventDefault();
        rows.add(showContextMenu(e.clientX, e.clientY, items));
      }),
    );

  store.add(
    effect(() => {
      rows.clear();
      const list = debug.breakpoints.list.value;
      const uncaught = debug.breakpoints.uncaught.value;
      const caught = debug.breakpoints.caught.value;
      const functions = debug.other.functions.value;
      const data = debug.other.data.value;
      const instructions = debug.other.instructions.value;
      const choices = debug.other.filterChoices.value;
      const savedFilters = debug.other.filters.value;
      const savedType = debug.other.filtersType.value;
      const focused = debug.focused.value;
      const caps = focused?.capabilities.value;
      const session = debug.sessions.value.length > 0;

      // Exception settings: the focused adapter's filters, else Node's two (and, with no
      // session, the last adapter's filters so they can be set before starting).
      const filterRow = (f: (typeof savedFilters)[number], suffix: string) => {
        const choice = choices[f.filter];
        const on_ = choice?.enabled ?? f.default;
        const row = h(
          "label",
          { class: "debug-row", role: "listitem", "data-filter": f.filter },
          check(on_, f.label, () =>
            run("debug.setExceptionFilter", { filter: f.filter, enabled: !on_ }),
          ),
          h("span", { class: "debug-row-main" }, `${f.label}${suffix}`),
          choice?.condition
            ? h("span", { class: "debug-row-detail" }, `when ${choice.condition}`)
            : null,
        );
        if (f.description) setTooltip(row, f.description);
        if (f.supportsCondition)
          menu(row, [
            {
              label: "Edit condition…",
              icon: "pencil",
              run: () => run("debug.setExceptionFilter", { filter: f.filter, editCondition: true }),
            },
          ]);
        return row;
      };
      const exception = (value: boolean, label: string, command: string) =>
        h(
          "label",
          { class: "debug-row", role: "listitem" },
          check(value, label, () => run(command)),
          h("span", { class: "debug-row-main" }, label),
        );
      const exceptionRows = caps?.exceptionFilters.length
        ? caps.exceptionFilters.map((f) => filterRow(f, ""))
        : [
            exception(caught, "Caught exceptions", "debug.toggleCaughtExceptions"),
            exception(uncaught, "Uncaught exceptions", "debug.toggleUncaughtExceptions"),
            ...(!session && savedFilters.length
              ? savedFilters.map((f) => filterRow(f, savedType ? ` (${savedType})` : ""))
              : []),
          ];

      const functionRows = functions.map((f) => {
        const unplaced = session && f.enabled && f.verified === false;
        const row = h(
          "div",
          {
            class: `debug-row${unplaced ? " is-unverified" : ""}`,
            role: "listitem",
            "data-function": f.name,
          },
          check(f.enabled, `Function breakpoint ${f.name}`, () =>
            run("debug.setFunctionBreakpointEnabled", { name: f.name, enabled: !f.enabled }),
          ),
          h("span", { class: "debug-bp-dot is-function" }),
          h("span", { class: "debug-row-main" }, f.name),
          h(
            "span",
            { class: "debug-row-detail" },
            [
              f.condition ? `when ${f.condition}` : "",
              f.hitCondition ? `hit ${f.hitCondition}` : "",
              "function",
            ]
              .filter(Boolean)
              .join(" · "),
          ),
          removeButton("Remove function breakpoint", "debug.removeFunctionBreakpoint", {
            name: f.name,
          }),
        );
        if (unplaced) setTooltip(row, "No function by this name was found in the loaded code.");
        menu(row, [
          {
            label: "Edit condition…",
            icon: "pencil",
            run: () => run("debug.addFunctionBreakpoint", { name: f.name, edit: "condition" }),
          },
          {
            label: "Edit hit count…",
            icon: "pencil",
            run: () => run("debug.addFunctionBreakpoint", { name: f.name, edit: "hitCondition" }),
          },
          {
            label: "Remove",
            icon: "trash-2",
            separatorBefore: true,
            run: () => run("debug.removeFunctionBreakpoint", { name: f.name }),
          },
        ]);
        return row;
      });

      const dataRows = data.map((d) =>
        h(
          "div",
          {
            class: `debug-row${d.enabled && d.verified === false ? " is-unverified" : ""}`,
            role: "listitem",
            "data-data-breakpoint": String(d.id),
          },
          check(d.enabled, `Data breakpoint ${d.description}`, () =>
            run("debug.setDataBreakpointEnabled", { id: d.id, enabled: !d.enabled }),
          ),
          h("span", { class: "debug-bp-dot is-data" }),
          h("span", { class: "debug-row-main" }, d.description),
          h(
            "span",
            { class: "debug-row-detail" },
            d.accessType === "write"
              ? "on change"
              : d.accessType === "read"
                ? "on read"
                : "on access",
          ),
          removeButton("Remove data breakpoint", "debug.removeDataBreakpoint", { id: d.id }),
        ),
      );

      const instructionRows = instructions.map((b) =>
        h(
          "div",
          {
            class: `debug-row${b.enabled && b.verified === false ? " is-unverified" : ""}`,
            role: "listitem",
            "data-instruction-breakpoint": b.address,
          },
          check(b.enabled, `Instruction breakpoint ${b.address}`, () =>
            run("debug.setInstructionBreakpointEnabled", {
              address: b.address,
              enabled: !b.enabled,
            }),
          ),
          h("span", { class: "debug-bp-dot" }),
          h("span", { class: "debug-row-main" }, b.address),
          h("span", { class: "debug-row-detail" }, "Instruction"),
          removeButton("Remove instruction breakpoint", "debug.toggleInstructionBreakpoint", {
            address: b.address,
          }),
        ),
      );

      const lineRows = list.map((b) => {
        // A triggered breakpoint waiting for its trigger: set nowhere yet (VS Code's pending icon).
        const pending = session && isWaiting(b);
        const unplaced = !pending && session && b.enabled && b.verified === false;
        const trigger =
          b.triggeredBy === undefined ? undefined : list.find((t) => t.id === b.triggeredBy);
        const triggerName = trigger ? `${basename(trigger.path)}:${trigger.line}` : "";
        const row = h(
          "div",
          {
            class: `debug-row${unplaced ? " is-unverified" : ""}${pending ? " is-pending" : ""}`,
            role: "listitem",
            "data-breakpoint": String(b.id),
          },
          check(b.enabled, `Breakpoint ${basename(b.path)}:${b.line}`, () =>
            run("debug.setBreakpointEnabled", { id: b.id, enabled: !b.enabled }),
          ),
          h("span", {
            class: `debug-bp-dot${b.condition || b.hitCondition || trigger ? " is-conditional" : ""}${b.logMessage ? " is-log" : ""}`,
          }),
          h("span", { class: "debug-row-main" }, basename(b.path)),
          h(
            "span",
            { class: "debug-row-detail" },
            [
              String(b.line),
              b.condition ? `when ${b.condition}` : "",
              b.hitCondition ? `hit ${b.hitCondition}` : "",
              b.logMessage ? `log "${b.logMessage}"` : "",
              trigger ? `after ${triggerName}` : "",
            ]
              .filter(Boolean)
              .join(" · "),
          ),
          removeButton("Remove breakpoint", "debug.removeBreakpoint", { id: b.id }),
        );
        if (unplaced)
          setTooltip(
            row,
            b.message ?? "Not placed: no code on this line, or the file wasn't loaded.",
          );
        else if (pending) setTooltip(row, `Waiting for breakpoint ${triggerName} to be hit`);
        else if (trigger) setTooltip(row, `Hit after breakpoint ${triggerName}`);
        rows.add(
          on(row, "click", (e) => {
            if ((e.target as HTMLElement).closest("input,button")) return;
            run("editor.openFile", { path: b.path, line: b.line });
          }),
        );
        menu(row, [
          {
            label: "Edit condition…",
            icon: "pencil",
            run: () => run("debug.editBreakpoint", { id: b.id, what: "condition" }),
          },
          {
            label: "Edit hit count…",
            icon: "pencil",
            run: () => run("debug.editBreakpoint", { id: b.id, what: "hitCondition" }),
          },
          {
            label: "Edit log message…",
            icon: "pencil",
            run: () => run("debug.editBreakpoint", { id: b.id, what: "logMessage" }),
          },
          {
            label: "Wait for breakpoint…",
            icon: "pencil",
            run: () => run("debug.editBreakpoint", { id: b.id, what: "triggeredBy" }),
          },
          {
            label: b.enabled ? "Disable" : "Enable",
            run: () => run("debug.setBreakpointEnabled", { id: b.id, enabled: !b.enabled }),
          },
          {
            label: "Remove",
            icon: "trash-2",
            separatorBefore: true,
            run: () => run("debug.removeBreakpoint", { id: b.id }),
          },
        ]);
        return row;
      });
      replaceChildren(
        bps,
        ...exceptionRows,
        ...functionRows,
        ...dataRows,
        ...instructionRows,
        ...lineRows,
      );
      return undefined;
    }),
  );
  return bps;
}
