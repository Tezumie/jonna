// Cards for the agent's display tools (D171): link / file cards here; questions, review findings
// and extension suggestions in toolCards.ts (D312–D314). Plain DOM with tokens. Charts and
// diagrams aren't cards: they're ```mermaid in the answer, drawn by the Markdown renderer (D172).
import type { DisplayCard } from "../../../core/agent/displayCards";
import { h, on } from "../../../core/dom/index";
import { icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import { askCard, findingsCard, type ToolCardHost } from "./toolCards";

/** What a card can do: open links, answer a question, run its commands (toolCards.ts). */
export type RichHost = ToolCardHost;

/** A display tool call's card; `key` changes when it must be drawn anew (answerable, answered). */
export function richCard(b: DisplayCard, host: RichHost, key: string): HTMLElement {
  const el =
    b.kind === "links"
      ? links(b, host)
      : b.kind === "ask"
        ? askCard(b, host)
        : findingsCard(b, host);
  el.dataset.key = key;
  return el;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function links(b: Extract<DisplayCard, { kind: "links" }>, host: RichHost): HTMLElement {
  return h(
    "div",
    { class: "rb rb-cards" },
    ...b.items.map((it) => {
      const card = h(
        "button",
        { class: "rb-card", type: "button" },
        h("span", { class: "rb-card-icon" }, icon(it.file ? "file-code" : "globe")),
        h(
          "span",
          { class: "rb-card-text" },
          h("span", { class: "rb-card-title" }, it.title),
          h("span", { class: "rb-card-meta" }, it.note ?? (it.file ? it.url : hostOf(it.url))),
        ),
        icon(it.file ? "chevron-right" : "external-link"),
      );
      setTooltip(card, it.url);
      on(card, "click", () => host.openLink(it.url));
      return card;
    }),
  );
}
