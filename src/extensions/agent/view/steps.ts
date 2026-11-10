// The rows of an open work group (D151): a card with one row per thing that happened, divided
// by hairlines, the way modern chats show an agent's steps. A tool row reads as a sentence
// ("Read README.md · 4 lines") and opens to its output (and the thinking that led to it); a note
// is what the agent said between steps; a thought row is the first step's headline; "Thought
// process" holds the answer's thinking. Nothing is darker than the chat.

import { h, on } from "../../../core/dom/index";
import { icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import { codeBlockActions } from "../codeBlocks";
import { mentionTargets } from "../groupChat";
import { type ItemHost, renderReply, toolDetail, toolLabel, toolTags, toolTooltip } from "./items";
import { imageSrc } from "./shots";
import type { WorkRow } from "./turns";

/** What a row's element depends on (re-rendered only when it changes). */
export function rowSignature(row: WorkRow, host: ItemHost, only: boolean): string {
  const open = host.expanded.has(row.id);
  switch (row.kind) {
    case "note":
      return `n|${row.text.length}|${row.item.thinking.length}|${row.item.streaming}|${open}`;
    case "thought":
      return `t|${row.text}|${row.item.thinking.length}|${row.item.streaming}|${open}`;
    case "thoughts":
      return `T|${row.item.thinking.length}|${row.item.thinkingMs ?? ""}|${open}|${only}`;
    case "tool": {
      const it = row.item;
      const pending = (it.changes ?? [])
        .map((p) => (host.session.changeset.get(p) ? "p" : "x"))
        .join("");
      return `x|${it.status}|${it.summary}|${open}|${(host.session.outputs.get(it.id) ?? "").length}|${pending}|${(it.images ?? it.previews)?.length ?? 0}|${row.thinking?.thinking.length ?? 0}`;
    }
  }
}

/** `only`: the group's single row (a turn that only thought): its thinking shows as is. */
export function renderRow(row: WorkRow, host: ItemHost, only = false): HTMLElement {
  switch (row.kind) {
    case "note":
      return noteRow(row, host);
    case "thought":
      return thoughtRow(row.id, row.text, row.item.thinking, host, row.item.streaming);
    case "thoughts":
      if (only) return h("div", { class: "agent-step is-plain" }, thinkingBody(row.item.thinking));
      return thoughtRow(row.id, "Thought process", row.item.thinking, host, false);
    case "tool":
      return toolRow(row, host);
  }
}

const thinkingBody = (text: string) => h("div", { class: "agent-step-thinking" }, text.trim());

function chevron(open: boolean): HTMLElement {
  return h("span", { class: "agent-step-chevron" }, icon(open ? "chevron-down" : "chevron-right"));
}

function toggle(host: ItemHost, id: string): void {
  if (host.expanded.has(id)) host.expanded.delete(id);
  else host.expanded.add(id);
  host.rerender();
}

/** A headline that opens to the whole thought. */
function thoughtRow(
  id: string,
  label: string,
  thinking: string,
  host: ItemHost,
  live: boolean,
): HTMLElement {
  const open = host.expanded.has(id);
  const head = h(
    "button",
    { class: "agent-step-row", type: "button", "aria-expanded": String(open) },
    h("span", { class: { "agent-step-text": true, "is-shimmer": live } }, label),
    chevron(open),
  );
  on(head, "click", () => toggle(host, id));
  return h(
    "div",
    { class: { "agent-step": true, "is-thought": true, "is-open": open } },
    head,
    open ? h("div", { class: "agent-step-detail" }, thinkingBody(thinking)) : null,
  );
}

/** What the agent said between steps (Markdown, quiet); its thinking opens under it. */
function noteRow(row: Extract<WorkRow, { kind: "note" }>, host: ItemHost): HTMLElement {
  const body = h("div", { class: "md agent-prose agent-step-note" });
  renderReply(
    body,
    row.text,
    {
      openLink: host.openLink,
      copy: host.copy,
      codeActions: (b) => codeBlockActions(host.run, host.session.id, b),
    },
    mentionTargets(host.session),
  );
  const thinking = row.item.thinking.trim();
  if (!thinking) return h("div", { class: "agent-step is-note" }, body);
  const open = host.expanded.has(row.id);
  const more = h(
    "button",
    {
      class: "agent-step-more",
      type: "button",
      "aria-expanded": String(open),
      "aria-label": open ? "Hide thinking" : "Show thinking",
    },
    chevron(open),
  );
  setTooltip(more, open ? "Hide thinking" : "Show thinking");
  on(more, "click", () => toggle(host, row.id));
  return h(
    "div",
    { class: { "agent-step": true, "is-note": true, "is-open": open } },
    h("div", { class: "agent-step-note-row" }, body, more),
    open ? h("div", { class: "agent-step-detail" }, thinkingBody(thinking)) : null,
  );
}

/** The background command a run_command step started (its summary: "running · bg3"). */
function backgroundId(item: Extract<WorkRow, { kind: "tool" }>["item"]): string | null {
  if (item.name !== "run_command" && item.name !== "process_output") return null;
  return /\b(bg\d+)\b/.exec(item.summary ?? "")?.[1] ?? null;
}

/** "Read README.md · 4 lines": opens to the output and the thinking that led to it. */
function toolRow(row: Extract<WorkRow, { kind: "tool" }>, host: ItemHost): HTMLElement {
  const item = row.item;
  const args = (item.args ?? {}) as Record<string, unknown>;
  const { verb, target } = toolLabel(item, host.relative);
  const open = host.expanded.has(row.id);
  const output = host.session.outputs.get(item.id);
  const detail = toolDetail(item, output);
  const thinking = row.thinking?.thinking.trim() ?? "";
  const expandable = !!(detail || thinking);
  const pendingReview = (item.changes ?? []).some((p) => host.session.changeset.get(p));
  const meta =
    item.status === "pending"
      ? "waiting for you"
      : item.status === "denied"
        ? "denied"
        : item.summary;
  const head = h(
    "button",
    {
      class: "agent-step-row",
      type: "button",
      ...(expandable && { "aria-expanded": String(open) }),
    },
    h(
      "span",
      { class: { "agent-step-text": true, "is-shimmer": item.status === "running" } },
      h("span", { class: "agent-step-verb" }, verb),
      target ? " " : null,
      target ? h("span", { class: "agent-step-target" }, target) : null,
    ),
    ...toolTags(item),
    meta ? h("span", { class: "agent-step-meta" }, meta) : null,
    pendingReview
      ? h("span", { class: "agent-dot is-pending", "aria-label": "Waiting for review" })
      : null,
    item.status === "error" ? h("span", { class: "agent-step-failed" }, icon("x")) : null,
    expandable ? chevron(open) : null,
  );
  setTooltip(head, toolTooltip(item, verb, target));
  on(head, "click", (e) => {
    // The target opens the file; the rest toggles the details.
    if ((e.target as Element).closest(".agent-step-target") && typeof args.path === "string") {
      host.run("editor.openFile", { path: args.path });
      return;
    }
    // Read at click time: the row is updated in place, this handler stays from the first render.
    if (row.thinking?.thinking.trim() || toolDetail(item, host.session.outputs.get(item.id)))
      toggle(host, row.id);
  });
  const el = h(
    "div",
    {
      class: {
        "agent-step": true,
        "is-tool": true,
        "is-open": open && expandable,
        [`is-${item.status}`]: true,
      },
    },
    head,
  );
  // A command it left running in the background (D286, Claude Code's "View live output"): its
  // output, live, in a panel tab.
  const bg = backgroundId(item);
  if (bg) {
    const link = h(
      "button",
      { class: "link-button agent-step-output", type: "button" },
      icon("square-terminal"),
      "View output",
    );
    setTooltip(link, `What ${bg} prints, live`, "agent.showProcessOutput");
    on(link, "click", () => host.run("agent.showProcessOutput", { id: bg }));
    el.append(link);
  }
  if (open && expandable)
    el.append(
      h(
        "div",
        { class: "agent-step-detail" },
        thinking ? thinkingBody(thinking) : null,
        detail ? h("pre", { class: "agent-well" }, detail) : null,
      ),
    );
  // Screenshots: a thumbnail; click shows it full size. (A tool's own images are under the
  // group, D381.)
  for (const png of item.media?.length ? [] : (item.images ?? item.previews ?? [])) {
    const img = h("img", {
      class: "agent-shot",
      src: imageSrc(png),
      alt: "Screenshot",
    });
    on(img, "click", () => img.classList.toggle("is-expanded"));
    el.append(img);
  }
  return el;
}
