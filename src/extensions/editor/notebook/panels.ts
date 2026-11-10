// Two small pieces of the notebook view (D188): the kernel's variables in the side panel, and the
// field a running cell shows when its code asks for input (Python's input(), getpass).
import { h, on } from "../../../core/dom/index";
import type { Variable } from "../../../core/notebook/types";
import type { CellView } from "./cell";

/** The Variables panel's content: a note, or the table of the kernel's variables. */
export function variablesContent(hasKernel: boolean, vars: readonly Variable[] | null): Node[] {
  return [
    h("div", { class: "nb-side-title" }, "Variables"),
    !hasKernel
      ? h("p", { class: "nb-side-note" }, "Run a cell to start the kernel.")
      : vars === null
        ? h("p", { class: "nb-side-note" }, "This kernel doesn't list its variables.")
        : !vars.length
          ? h("p", { class: "nb-side-note" }, "No variables yet.")
          : h(
              "table",
              { class: "nb-vars" },
              h(
                "thead",
                null,
                h(
                  "tr",
                  null,
                  h("th", null, "Name"),
                  h("th", null, "Type"),
                  h("th", null, "Size"),
                  h("th", null, "Value"),
                ),
              ),
              h(
                "tbody",
                null,
                ...vars.map((v) =>
                  h(
                    "tr",
                    null,
                    h("td", null, v.name),
                    h("td", null, v.type),
                    h("td", null, v.size),
                    h("td", { title: v.value }, v.value),
                  ),
                ),
              ),
            ),
  ];
}

/**
 * Shows the input field under `cell` for a kernel's input request; Enter sends the value (the
 * prompt and the answer, or dots for a password, are added to the cell's output).
 */
export function askInput(
  cell: CellView,
  r: { prompt: string; password: boolean },
  send: (value: string) => void,
): void {
  const field = h("input", {
    class: "nb-input",
    type: r.password ? "password" : "text",
    placeholder: "Type and press Enter",
  }) as HTMLInputElement;
  cell.inputRow.replaceChildren(
    h("span", { class: "nb-input-prompt" }, r.prompt || "Input:"),
    field,
  );
  cell.inputRow.hidden = false;
  on(field, "keydown", (e) => {
    e.stopPropagation();
    if (e.key !== "Enter") return;
    const value = field.value;
    cell.inputRow.hidden = true;
    cell.cell.outputs.push({
      output_type: "stream",
      name: "stdout",
      text: `${r.prompt}${r.password ? "••••" : value}\n`,
    });
    cell.renderOutputs();
    send(value);
  });
  requestAnimationFrame(() => field.focus());
}
