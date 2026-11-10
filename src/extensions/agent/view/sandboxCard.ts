// The chat's card for suggest_sandbox_allowance (D350): what the agent asks the project's sandbox
// to allow (hosts, folders) and why, with Allow (agent.allowSandboxSuggestion, the user's click).
// Drawn like the discovery cards (discoveryCards.ts), from its call's detail.

import { type AllowanceSuggestion, shortList } from "../../../core/agent/sandboxPolicy";
import { h, on } from "../../../core/dom/index";
import { icon } from "../../../ui/Icon";
import type { ToolCardHost } from "./toolCards";

const baseName = (folder: string) =>
  folder
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || folder;

export function sandboxAllowanceCard(s: AllowanceSuggestion, host: ToolCardHost): HTMLElement {
  const button = h(
    "button",
    {
      class: {
        button: true,
        "button-sm": true,
        "button-primary": !s.added,
        "button-secondary": !!s.added,
        "rb-discovery-action": true,
      },
      type: "button",
      ...((s.added || !host.run) && { disabled: "" }),
    },
    s.added ? "Allowed" : "Allow",
  );
  if (!s.added && host.run)
    on(button, "click", () =>
      host.run?.("agent.allowSandboxSuggestion", {
        ...(host.session && { session: host.session }),
        item: host.item ?? "",
      }),
    );
  const line = (kind: string, list: readonly string[]) =>
    list.length
      ? h("div", { class: "rb-discovery-description" }, `${kind}: ${shortList(list, 5)}`)
      : null;
  return h(
    "div",
    { class: "rb rb-discovery rb-sandbox-allow" },
    s.reason ? h("div", { class: "rb-discovery-reason" }, s.reason) : null,
    h(
      "div",
      { class: "rb-discovery-row" },
      h("span", { class: "rb-discovery-icon" }, icon("shield")),
      h(
        "div",
        { class: "rb-discovery-text" },
        h(
          "div",
          { class: "rb-discovery-title" },
          h("span", { class: "rb-discovery-name" }, "Sandboxed commands in this project"),
          h("span", { class: "rb-discovery-meta" }, baseName(s.folder)),
        ),
        line("Connect to", s.hosts),
        line("Write in", s.folders),
      ),
      button,
    ),
  );
}
