// An extension's source control in the Source control view (D233): a section below git's
// changes, with its input box and accept button, then its resource groups and their resources
// (letter, color, strike-through, a click runs its command or opens the file). Typing, accepting
// and clicking run the extensions' scm commands (workbenchCommands.ts), never the logic directly.
import { h } from "../../core/dom/index";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import type { ScmProviderEntry } from "../../workbench/extensionRegistries";
import { ExtensionTreeView } from "./treeView";
import { scmRows } from "./workbenchChecks";

export class ScmSection implements Disposable {
  private readonly store = new DisposableStore();
  private readonly tree: ExtensionTreeView;
  private readonly input: HTMLTextAreaElement;
  private readonly accept: HTMLButtonElement;
  private readonly form: HTMLElement;
  /** Groups shown so far: a new one opens expanded, one the user closed stays closed. */
  private readonly seen = new Set<string>();
  private typing = 0;

  constructor(
    host: HTMLElement,
    private readonly entry: ScmProviderEntry,
    private readonly run: (command: string, input: unknown) => void,
  ) {
    this.input = h("textarea", {
      class: "ext-scm-input",
      rows: 1,
      "aria-label": `${entry.label} message`,
    }) as HTMLTextAreaElement;
    this.accept = h("button", {
      class: "button button-primary",
      type: "button",
    }) as HTMLButtonElement;
    this.form = h("div", { class: "ext-scm-form" }, this.input, this.accept);
    this.tree = this.store.add(
      new ExtensionTreeView(
        {
          children: async (parent) => scmRows(entry, parent),
          run: (command) => this.run(command.id, command.input),
          ready: () => true,
          expand: () => {
            const fresh = entry.state
              .peek()
              .groups.map((g) => `g:${g.id}`)
              .filter((id) => !this.seen.has(id));
            for (const id of fresh) this.seen.add(id);
            return fresh;
          },
        },
        entry.label,
      ),
    );
    const element = h(
      "div",
      { class: "ext-scm", "data-scm": entry.key },
      this.form,
      this.tree.element,
    );
    host.append(element);
    this.store.add({ dispose: () => element.remove() });
    this.input.oninput = () => {
      window.clearTimeout(this.typing);
      this.typing = window.setTimeout(() => this.sendInput(), 250);
    };
    this.input.onkeydown = (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.acceptNow();
      }
    };
    this.accept.onclick = () => this.acceptNow();
    this.store.add({
      dispose: () => {
        window.clearTimeout(this.typing);
        this.input.oninput = null;
        this.input.onkeydown = null;
        this.accept.onclick = null;
      },
    });
    this.store.add(
      effect(() => {
        const state = entry.state.value;
        this.form.hidden = !state.input.visible && !state.accept;
        this.input.hidden = !state.input.visible;
        this.input.placeholder =
          state.input.placeholder || `Message (Ctrl+Enter to ${state.accept?.title ?? "accept"})`;
        // The extension's value, unless the user is typing in the box.
        if (document.activeElement !== this.input && this.input.value !== state.input.value)
          this.input.value = state.input.value;
        this.accept.hidden = !state.accept;
        this.accept.textContent = state.accept?.title ?? "";
        void this.tree.refresh();
        return undefined;
      }),
    );
  }

  private sendInput(): void {
    this.run("extensions.scmSetInput", { key: this.entry.key, value: this.input.value });
  }

  private acceptNow(): void {
    window.clearTimeout(this.typing);
    this.run("extensions.scmAccept", { key: this.entry.key, value: this.input.value });
  }

  focus(): void {
    if (!this.input.hidden) this.input.focus();
    else this.tree.focus();
  }

  dispose(): void {
    this.store.dispose();
  }
}
