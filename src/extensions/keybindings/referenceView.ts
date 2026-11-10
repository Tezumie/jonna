// The "Keyboard shortcuts reference" dock tab (Help → Keyboard shortcuts reference): VS Code's
// printable sheet, built from the keybinding table for this platform (reference.ts), in columns
// that reflow with the tab's width. Print copies the sheet to a page of its own for the print
// dialog (styles/reference.css hides the workbench while it prints).
import type { Json } from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { effectiveBindings } from "../../core/keybindings/index";
import { DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { icon } from "../../ui/Icon";
import type { DockView, DockViewDescriptor } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { buildReference, type ReferenceSection } from "./reference";

const PLATFORM_NAMES = { mac: "macOS", windows: "Windows", linux: "Linux" } as const;

export function shortcutsReference(services: WorkbenchServices): ReferenceSection[] {
  const { keyboard, dispatcher } = services;
  const titles = new Map(dispatcher.list().map((c) => [c.id, c.title]));
  return buildReference(
    effectiveBindings(keyboard.allRules, keyboard.platformName),
    keyboard.platformName,
    {
      title: (id) => titles.get(id),
      has: (id) => dispatcher.has(id),
    },
  );
}

export function referenceViewDescriptor(services: WorkbenchServices): DockViewDescriptor {
  return {
    type: "keybindingsReference",
    title: () => "Keyboard shortcuts reference",
    icon: () => "keyboard",
    singleton: true,
    defaultPlacement: "main",
    editorLike: true,
    create: () => new ReferenceView(services),
  };
}

/** The sheet's elements (the tab's, and the copy made for printing). */
export function referenceSheet(
  sections: readonly ReferenceSection[],
  platform: string,
): HTMLElement {
  return h(
    "div",
    { class: "shortcuts-sheet" },
    h(
      "div",
      { class: "shortcuts-sheet-head" },
      h("h1", { class: "shortcuts-sheet-title" }, "Keyboard shortcuts"),
      h("span", { class: "shortcuts-sheet-platform" }, `for ${platform}`),
    ),
    h(
      "div",
      { class: "shortcuts-columns" },
      ...sections.map((section) =>
        h(
          "section",
          { class: "shortcuts-section" },
          h("h2", { class: "shortcuts-section-title" }, section.title),
          h(
            "dl",
            { class: "shortcuts-list" },
            ...section.rows.flatMap((row) => [
              h(
                "dt",
                { class: "shortcuts-keys" },
                ...row.keys.flatMap((k, i) =>
                  i === 0
                    ? [h("kbd", null, k)]
                    : [h("span", { class: "shortcuts-or" }, "or"), h("kbd", null, k)],
                ),
              ),
              h("dd", { class: "shortcuts-label" }, row.label),
            ]),
          ),
        ),
      ),
    ),
  );
}

class ReferenceView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();

  constructor(services: WorkbenchServices) {
    const print = h(
      "button",
      { class: "button button-secondary button-sm shortcuts-print", type: "button" },
      icon("file-down"),
      "Print…",
    );
    this.store.add(
      on(print, "click", () => {
        void services.dispatcher.execute("keybindings.printReference", {}).catch(() => {});
      }),
    );
    const body = h("div", { class: "shortcuts-body" });
    this.element = h(
      "div",
      { class: "shortcuts-view", tabindex: "-1" },
      h("div", { class: "shortcuts-toolbar" }, print),
      body,
    );
    // Rebuilt when keybindings change (keybindings.json edited, an extension added keys).
    this.store.add(
      effect(() => {
        services.keyboard.rulesVersion.value;
        body.replaceChildren(
          referenceSheet(
            shortcutsReference(services),
            PLATFORM_NAMES[services.keyboard.platformName],
          ),
        );
        return undefined;
      }),
    );
  }

  focus(): void {
    this.element.focus();
  }

  serialize(): Json {
    return null;
  }

  dispose(): void {
    this.store.dispose();
  }
}

/**
 * Prints the sheet: a copy goes in a page-level container that is all the print shows, then the
 * window's print dialog opens; the copy goes when printing ends.
 */
export function printReference(services: WorkbenchServices): void {
  const page = h(
    "div",
    { class: "shortcuts-print-page" },
    referenceSheet(shortcutsReference(services), PLATFORM_NAMES[services.keyboard.platformName]),
  );
  document.body.appendChild(page);
  document.body.classList.add("is-printing-shortcuts");
  const store = new DisposableStore();
  const done = () => store.dispose();
  store.add(
    toDisposable(() => {
      page.remove();
      document.body.classList.remove("is-printing-shortcuts");
    }),
  );
  store.add(on(window, "afterprint", done));
  // Some webviews never fire afterprint: the copy goes after a while in any case.
  const timer = setTimeout(done, 60_000);
  store.add(toDisposable(() => clearTimeout(timer)));
  window.print();
}
