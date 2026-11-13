// The control of workbench.defaultLayout (D424): one card per layout, each a small drawing of
// the window (sidebar, main area, the agent's column) over its name, in place of a dropdown.
import { h, on } from "../../core/dom/index";
import { START_LAYOUTS, type StartLayout, startLayoutOf } from "../../core/layout/startLayout";
import type { DisposableStore } from "../../core/lifecycle/index";
import { setTooltip } from "../../ui/Tooltip";

const NAMES: Record<StartLayout, string> = { default: "Default", agent: "Agent", code: "Code" };

/** The parts a layout's drawing shows, left to right ("chat" is the agent filling the window). */
const PARTS: Record<StartLayout, readonly string[]> = {
  default: ["side", "main", "agent"],
  agent: ["side", "chat"],
  code: ["main"],
};

export interface LayoutChoice {
  readonly element: HTMLElement;
  /** Marks the card of `value` (anything unknown: Default). */
  show(value: unknown): void;
}

export function layoutChoice(
  store: DisposableStore,
  id: string,
  label: string,
  descriptions: readonly string[] | undefined,
  pick: (value: StartLayout) => void,
): LayoutChoice {
  const cards = START_LAYOUTS.map((layout, i) => {
    const card = h(
      "button",
      { class: "layout-choice", type: "button", role: "radio", "data-layout": layout },
      h(
        "span",
        { class: "layout-choice-window", "aria-hidden": "true" },
        h("span", { class: "layout-choice-part is-bar" }),
        ...PARTS[layout].map((part) => h("span", { class: `layout-choice-part is-${part}` })),
      ),
      h("span", { class: "layout-choice-name" }, NAMES[layout]),
    );
    const detail = descriptions?.[i];
    if (detail) setTooltip(card, detail);
    store.add(on(card, "click", () => pick(layout)));
    return card;
  });
  // The id is the group's, not a card's: the row's title is a <label for=id>, and a click on
  // it would press the card it pointed at.
  const element = h(
    "div",
    { class: "layout-choices", id, role: "radiogroup", "aria-label": label },
    ...cards,
  );
  // A radio group's keys: one tab stop (the chosen card), arrows move and choose.
  store.add(
    on(element, "keydown", (e) => {
      const step =
        e.key === "ArrowRight" || e.key === "ArrowDown"
          ? 1
          : e.key === "ArrowLeft" || e.key === "ArrowUp"
            ? -1
            : 0;
      if (!step) return;
      const at = cards.indexOf(e.target as HTMLButtonElement);
      const next = cards[(at + step + cards.length) % cards.length];
      const layout = START_LAYOUTS[(at + step + cards.length) % cards.length];
      if (at < 0 || !next || !layout) return;
      e.preventDefault();
      next.focus();
      pick(layout);
    }),
  );
  return {
    element,
    show(value) {
      const current = startLayoutOf(value);
      for (const card of cards) {
        const chosen = card.dataset.layout === current;
        card.classList.toggle("is-selected", chosen);
        card.setAttribute("aria-checked", String(chosen));
        card.tabIndex = chosen ? 0 : -1;
      }
    },
  };
}
