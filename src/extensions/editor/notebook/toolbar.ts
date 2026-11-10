// The notebook's toolbar (D188, VS Code's layout): + Code, + Markdown, Run all, Interrupt,
// Restart, Clear outputs, Variables, Export, extensions' buttons (`menus` "notebook/toolbar",
// D204), and the kernel picker on the right. Every button runs a command.

import { matchesWhen } from "../../../core/context/index";
import { h, on } from "../../../core/dom/index";
import { whenKeys } from "../../../core/extensions/vscodePackage";
import { NOTEBOOK_CONTEXT_KEYS } from "../../../core/notebook/contextKeys";
import type { KernelStatus } from "../../../core/notebook/types";
import { icon, knownIcon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import type { WorkbenchServices } from "../../../workbench/services";

export interface ToolbarState {
  /** The kernel's name, or the remembered one's, or null (none picked). */
  kernelLabel: string | null;
  kernelDetail: string | null;
  status: KernelStatus;
  showVariables: boolean;
  notebookType: string;
  /** The kernel's source ("<extension>/<controller>", VS Code's notebookKernel), or null. */
  kernelSource?: string | null;
}

/** The context keys a notebook's `when` clauses see (`notebookType`, plus the IDE's). */
export const notebookWhen =
  (services: WorkbenchServices, keys: Record<string, unknown>) =>
  (when: string | undefined): boolean =>
    matchesWhen(when, (k: string) => (k in keys ? keys[k] : services.context.get(k)));

let menuKeys: { menus: unknown; keys: Set<string> } | null = null;
const OWN_KEYS = new Set(NOTEBOOK_CONTEXT_KEYS);

/**
 * The context keys extensions' notebook menu items test, besides the notebook's own (which the
 * notebook passes itself): when one changes, the toolbar and cell buttons are drawn again.
 */
export function notebookMenuKeys(services: WorkbenchServices): ReadonlySet<string> {
  const menus = services.extensionFeatures.menus.peek();
  if (menuKeys?.menus !== menus) {
    const keys = new Set<string>();
    for (const m of menus)
      if (String(m.location).startsWith("notebook/") && m.when)
        for (const k of whenKeys(m.when)) if (!OWN_KEYS.has(k)) keys.add(k);
    menuKeys = { menus, keys };
  }
  return menuKeys.keys;
}

export class NotebookToolbar {
  readonly element = h("div", { class: "nb-toolbar", role: "toolbar" });
  private readonly kernelButton = h("button", { class: "nb-kernel", type: "button" });

  constructor(
    private readonly services: WorkbenchServices,
    private readonly run: (command: string, input?: Record<string, unknown>) => void,
  ) {
    on(this.kernelButton, "click", () => this.run("notebook.selectKernel"));
  }

  private button(glyph: Parameters<typeof icon>[0], label: string, command: string, tip: string) {
    const b = h(
      "button",
      { class: "nb-tool", type: "button", "aria-label": label || tip },
      icon(glyph),
      label ? h("span", null, label) : null,
    );
    setTooltip(b, tip);
    on(b, "click", () => this.run(command));
    return b;
  }

  render(state: ToolbarState): void {
    const { status } = state;
    this.kernelButton.replaceChildren(
      h("span", { class: `nb-kernel-dot is-${status}` }),
      h("span", { class: "nb-kernel-name" }, state.kernelLabel ?? "Select kernel"),
      h("span", { class: "nb-kernel-state" }, status === "stopped" ? "" : status),
    );
    setTooltip(
      this.kernelButton,
      state.kernelDetail
        ? `${state.kernelDetail}: change the kernel`
        : "Choose what runs this notebook",
    );
    const variables = this.button(
      "variable",
      "Variables",
      "notebook.toggleVariables",
      "Show the kernel's variables",
    );
    variables.classList.toggle("is-on", state.showVariables);
    // Extensions' buttons (VS Code's notebook/toolbar menu), with their `when`.
    const contributed = this.services.extensionFeatures
      .menuItems(
        "notebook/toolbar",
        notebookWhen(this.services, {
          notebookType: state.notebookType,
          // This notebook's (another one may own the context keys now).
          notebookKernel: state.kernelSource ?? undefined,
          notebookKernelSelected: !!state.kernelSource,
        }),
      )
      .slice(0, 6)
      .map((m) =>
        this.button(knownIcon(m.icon, "circle-dot"), m.icon ? "" : m.title, m.command, m.title),
      );
    this.element.replaceChildren(
      this.button("plus", "Code", "notebook.insertCell", "Add a code cell below (B)"),
      this.button("plus", "Markdown", "notebook.insertMarkdown", "Add a Markdown cell below"),
      h("span", { class: "nb-sep" }),
      this.button("play", "Run all", "notebook.runAll", "Run every cell"),
      this.button("square", "", "notebook.interrupt", "Interrupt the kernel (I I)"),
      this.button("rotate-ccw", "Restart", "notebook.restart", "Restart the kernel (0 0)"),
      this.button("ban", "Clear outputs", "notebook.clearAllOutputs", "Clear every output"),
      h("span", { class: "nb-sep" }),
      variables,
      this.button("file-output", "", "notebook.exportScript", "Export as a script (# %% cells)"),
      ...(contributed.length ? [h("span", { class: "nb-sep" }), ...contributed] : []),
      h("span", { class: "nb-spacer" }),
      this.kernelButton,
    );
  }
}
