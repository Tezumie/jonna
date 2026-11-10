// Automatic messages that bring news into a chat (D322–D325): a monitor's events, a watched pull
// request's change, another chat's message or its "idle now" note. A monitor's and a pull
// request's are a quiet line (the whole message in its tooltip, as a scheduled message's is); a
// message from another chat shows its text too (the user sees what the other agent asked), with
// the sender chat's name opening it.

import { readChatMessage } from "../../../core/agent/chatMessages";
import type { Item } from "../../../core/agent/conversation";
import { h, on } from "../../../core/dom/index";
import { icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";

const firstLine = (text: string) => text.split("\n")[0] ?? "";

export function renderAutoNews(
  item: Extract<Item, { type: "user" }>,
  kind: "monitor" | "pr" | "chat",
  run: (command: string, input?: unknown) => void,
): HTMLElement {
  if (kind === "chat") {
    const message = readChatMessage(item.text);
    if (message?.window !== undefined) {
      // D359: a chat in another window works there; it isn't opened here too.
      return h(
        "div",
        { class: "agent-msg agent-news is-chat", "data-key": item.id },
        h(
          "div",
          { class: "agent-auto is-news" },
          icon("messages-square"),
          h("span", null, `Message from chat ${message.title} (window ${message.window})`),
        ),
        h("div", { class: "agent-news-body" }, message.body),
      );
    }
    if (message) {
      const from = h("button", { class: "agent-news-link", type: "button" }, message.title);
      setTooltip(from, "Open that chat");
      on(from, "click", () => run("agent.openThread", { session: message.id }));
      return h(
        "div",
        { class: "agent-msg agent-news is-chat", "data-key": item.id },
        h(
          "div",
          { class: "agent-auto is-news" },
          icon("messages-square"),
          h("span", null, "Message from chat "),
          from,
        ),
        h("div", { class: "agent-news-body" }, message.body),
      );
    }
  }
  const row = h(
    "div",
    { class: "agent-msg agent-auto is-news", "data-key": item.id },
    icon(
      kind === "monitor" ? "radio-tower" : kind === "pr" ? "git-pull-request" : "messages-square",
    ),
    h("span", { class: "agent-news-line" }, firstLine(item.text)),
  );
  setTooltip(row, item.text.slice(0, 1200));
  return row;
}
