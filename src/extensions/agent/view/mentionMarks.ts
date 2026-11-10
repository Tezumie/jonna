// @mentions in shown messages (D273): an agent's name or @channel stands out in the user's
// messages and the agents' replies, as Slack and Discord color them; hovering an agent's names it,
// its role and what it does. Code (inline or blocks) and links are left as they are.

import { type GroupMember, mentionRanges } from "../../../core/agent/groupChat";
import { h } from "../../../core/dom/index";
import { setTooltip } from "../../../ui/Tooltip";

/** Elements whose text isn't prose: their "@" stays plain. */
const SKIP = "code, pre, a, .agent-mention";

/** Wraps each mention under `root` in a colored span (agents by label or name; @channel). */
export function markMentions(root: HTMLElement, members: readonly GroupMember[]): void {
  // Cheap first: most messages have no "@".
  if (!root.textContent?.includes("@")) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode())
    if (n instanceof Text && n.data.includes("@") && !n.parentElement?.closest(SKIP)) nodes.push(n);
  for (const node of nodes) {
    const ranges = mentionRanges(node.data, members);
    if (!ranges.length) continue;
    const parts: (string | HTMLElement)[] = [];
    let at = 0;
    for (const r of ranges) {
      if (r.start > at) parts.push(node.data.slice(at, r.start));
      parts.push(mentionChip(node.data.slice(r.start, r.end), r.name, members));
      at = r.end;
    }
    if (at < node.data.length) parts.push(node.data.slice(at));
    node.replaceWith(...parts);
  }
}

function mentionChip(
  text: string,
  name: string | null,
  members: readonly GroupMember[],
): HTMLElement {
  const chip = h(
    "span",
    {
      class: name ? "agent-mention" : "agent-mention is-everyone",
      ...(name && { "data-member": name }),
    },
    text,
  );
  const member = name ? members.find((m) => m.name === name) : undefined;
  setTooltip(
    chip,
    member
      ? [member.role ? `${member.label} · ${member.role}` : member.label, member.description]
          .filter(Boolean)
          .join(": ")
      : "Everyone in the chat answers",
  );
  return chip;
}
