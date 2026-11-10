// The details panel's row for the pull request a chat watches (D323): its number and title (opens
// it on GitHub), where it stands, Check now and Stop watching. The panel's click handler runs the
// buttons' commands on this chat. D352: Auto-merge when ready (or off again).

import { h } from "../../../core/dom/index";
import { icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import type { PrWatchInfo } from "../prWatches";

/** "2 failing", "1 pending", "passing", "conflict", "error" (short, for the row's end). */
function shortState(pr: PrWatchInfo): string {
  if (pr.lastError) return "can't reach";
  const s = pr.status ?? "";
  if (/merge conflict/.test(s)) return "conflict";
  const failing = /(\d+) failing/.exec(s)?.[1];
  if (failing) return `${failing} failing`;
  if (/pending/.test(s)) return "pending";
  if (/passing/.test(s)) return "passing";
  return "watching";
}

export function pullRequestRow(pr: PrWatchInfo): HTMLElement {
  const button = (
    command: string,
    glyph: "refresh-cw" | "x" | "git-merge",
    label: string,
    off = false,
  ) => {
    const b = h(
      "button",
      {
        class: `icon-button agent-details-stop${glyph === "git-merge" && off ? " is-on" : ""}`,
        type: "button",
        "data-action": "run",
        "data-command": command,
        ...(off && { "data-off": "true", "aria-pressed": "true" }),
        "aria-label": `${label}: #${pr.number}`,
      },
      icon(glyph),
    );
    setTooltip(b, label, command);
    return b;
  };
  const label = h(
    pr.url ? "button" : "span",
    {
      class: "agent-details-label",
      ...(pr.url && { type: "button", "data-action": "url", "data-url": pr.url }),
    },
    `#${pr.number}${pr.title ? ` ${pr.title}` : ""}`,
  );
  setTooltip(
    label,
    [
      `Watching #${pr.number}${pr.title ? ` ${pr.title}` : ""}`,
      pr.status ?? "Not looked at yet",
      ...(pr.autoMerge ? [`Auto-merge: ${pr.autoMerge.status}`] : []),
      ...(pr.lastError ? [`Last look failed: ${pr.lastError}`] : []),
      "The agent is told when checks fail or pass, a conflict appears or comments come.",
    ].join("\n"),
  );
  return h(
    "div",
    { class: "agent-details-row is-task", "data-key": `pr:${pr.number}` },
    h("span", { class: "agent-details-lead" }, icon("git-pull-request")),
    label,
    h(
      "span",
      { class: "agent-details-num agent-details-muted" },
      pr.autoMerge ? `${shortState(pr)} · auto-merge` : shortState(pr),
    ),
    pr.autoMerge
      ? button("agent.autoMergePullRequest", "git-merge", "Turn auto-merge off", true)
      : button("agent.autoMergePullRequest", "git-merge", "Auto-merge when ready"),
    button("agent.checkPullRequestNow", "refresh-cw", "Check now"),
    button("agent.unwatchPullRequest", "x", "Stop watching"),
  );
}
