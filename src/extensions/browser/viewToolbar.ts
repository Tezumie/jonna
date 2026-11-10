// The browser tab's toolbar (view.ts, split out in D247): back, forward, reload (turning while the page loads), the
// address field with "open in system browser" and "own window" inside it, the element picker,
// DevTools with its error / warning badges, More, and the progress line. It only builds the
// elements and wires them to the tab's actions; the tab keeps its own state.
import { h, on } from "../../core/dom/index";
import type { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";

export interface ToolbarActions {
  /** Enter in the address field. */
  go(text: string): void;
  /** Escape in the address field: what it should show again. */
  shownAddress(): string;
  back(): void;
  forward(): void;
  reload(): void;
  togglePick(): void;
  /** The DevTools button (it opens on Console when the page has errors). */
  devtools(): void;
  openInSystem(): void;
  toggleWindow(): void;
  more(anchor: HTMLElement): void;
  /** Whether the page is loading (the reload arrow turns). */
  loading(): boolean;
}

export interface Toolbar {
  bar: HTMLElement;
  input: HTMLInputElement;
  counts: HTMLElement;
  pickButton: HTMLButtonElement;
  devtoolsButton: HTMLButtonElement;
  popButton: HTMLElement;
  progress: HTMLElement;
}

export function buildToolbar(s: DisposableStore, actions: ToolbarActions): Toolbar {
  const button = (name: Parameters<typeof icon>[0], title: string, run: () => void) => {
    const b = h("button", { class: "icon-button", type: "button" }, icon(name));
    setTooltip(b, title);
    s.add(on(b, "click", run));
    return b;
  };
  const input = h("input", {
    class: "input browser-address",
    type: "text",
    spellcheck: "false",
    placeholder: "localhost:5173, index.html or a web address",
    "aria-label": "Address",
  });
  s.add(
    on(input, "keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        actions.go(input.value);
      } else if (e.key === "Escape") {
        input.value = actions.shownAddress();
        input.blur();
      }
    }),
  );
  s.add(on(input, "focus", () => input.select()));
  const counts = h("span", { class: "browser-devtools-badges" });
  const pickButton = button(
    "square-dashed-mouse-pointer",
    "Select an element in the page (Elements)",
    () => actions.togglePick(),
  );
  // DevTools carries the console's error / warning counts; with errors it opens on Console.
  const devtoolsButton = h(
    "button",
    { class: "icon-button browser-devtools-button", type: "button" },
    icon("terminal"),
    counts,
  ) as HTMLButtonElement;
  setTooltip(devtoolsButton, "DevTools (F12)");
  s.add(on(devtoolsButton, "click", () => actions.devtools()));
  // Page-level actions live inside the address field, on its right (like a browser's); device
  // mode is in DevTools' header (and the More menu).
  const systemButton = button("external-link", "Open in system browser", () =>
    actions.openInSystem(),
  );
  const popButton = button("picture-in-picture-2", "Open in its own window", () =>
    actions.toggleWindow(),
  );
  systemButton.classList.add("browser-address-action");
  popButton.classList.add("browser-address-action");
  const addressBox = h("div", { class: "browser-addressbox" }, input, systemButton, popButton);
  s.add(
    on(addressBox, "pointerdown", (e) => {
      if (e.target === addressBox) {
        e.preventDefault();
        input.focus();
      }
    }),
  );
  const more = button("ellipsis", "More", () => actions.more(more));
  const reloadButton = button("rotate-cw", "Reload (Shift: without cache)", () => actions.reload());
  reloadButton.classList.add("browser-reload");
  const progress = h("div", { class: "browser-progress", hidden: true });
  const bar = h(
    "div",
    { class: "browser-bar" },
    button("arrow-left", "Back", () => actions.back()),
    button("arrow-right", "Forward", () => actions.forward()),
    reloadButton,
    addressBox,
    pickButton,
    devtoolsButton,
    more,
    progress,
  );
  let spinStarted = 0;
  let spinTimer: ReturnType<typeof setTimeout> | undefined;
  s.add({ dispose: () => clearTimeout(spinTimer) });
  s.add(
    effect(() => {
      const loading = actions.loading();
      progress.hidden = !loading;
      // The reload arrow turns while the page loads (D123), for at least one full turn so a
      // fast reload still shows it happened.
      if (loading) {
        clearTimeout(spinTimer);
        spinStarted = Date.now();
        reloadButton.classList.add("is-loading");
      } else {
        const left = Math.max(0, 600 - (Date.now() - spinStarted));
        spinTimer = setTimeout(() => reloadButton.classList.remove("is-loading"), left);
      }
      return undefined;
    }),
  );
  return { bar, input, counts, pickButton, devtoolsButton, popButton, progress };
}
