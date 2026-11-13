// Rendering of conversation items (DESIGN.md §13.2–13.4): user cards, assistant prose (Markdown,
// collapsible "Thought for 8s"), compact tool rows that expand into a sunken well, diff cards for
// proposed changes, notices. Elements are cached per item and only re-rendered when the item's
// signature changes, so streaming re-renders one message per frame.

import { reviewLine } from "../../../core/acp/display";
import type { AskAnswers } from "../../../core/agent/askUser";
import { isRecordingStop } from "../../../core/agent/browserRecording";
import type { Item } from "../../../core/agent/conversation";
import { cardFromTool, DISPLAY_TOOL_NAMES } from "../../../core/agent/displayCards";
import { parseSuggestion } from "../../../core/agent/extensionSuggest";
import { encodeFace } from "../../../core/agent/faces";
import { type GroupMember, isGroupContext } from "../../../core/agent/groupChat";
import { formatCost } from "../../../core/agent/prices";
import { ROOM_BRIEF_PREFIX, relativeAge, type ThreadRow } from "../../../core/agent/rooms";
import { withoutWrapperTags } from "../../../core/agent/title";
import { TURN_CARD_TOOLS } from "../../../core/agent/turnTools";
import { h, on } from "../../../core/dom/index";
import { basename } from "../../../core/paths/index";
import { agentFace, faceGroup } from "../../../ui/AgentFace";
import { fileIcon, type IconName, icon } from "../../../ui/Icon";
import { showContextMenu, showMenu } from "../../../ui/Menu";
import { renderMarkdown } from "../../../ui/markdown/render";
import { timeAttrs } from "../../../ui/relativeTimes";
import { setTooltip } from "../../../ui/Tooltip";
import { BATCH_TOOL, BROWSER_TOOLS, SCREENSHOT_TOOL } from "../browserTools";
import { codeBlockActions } from "../codeBlocks";
import { TOOL_SEARCH_ROW } from "../deferredTools";
import { DISPLAY_TOOLS } from "../displayTools";
import { EXPLORE_TOOL } from "../exploreTool";
import {
  handoffsOf,
  knownAgents,
  memberInfo,
  mentionTargets,
  soloSpeaker,
  speakerHeader,
} from "../groupChat";
import type { AgentSession } from "../session";
import { allModeRules } from "../sessionTypes";
import { installingFrom } from "../toolCardCommands";
import { CORE_TOOLS, PLAN_TOOL } from "../tools";
import { turnTools } from "../turnTools";
import { openableCards } from "./attachCards";
import { renderAutoNews } from "./autoNews";
import { loopTickRow, planCard, planCardKey } from "./chatFlowCards";
import { chatImageGallery, galleryKey, pendingImages } from "./chatImages";
import { DISCOVERY_CARDS, discoveryCard, discoveryCardState } from "./discoveryCards";
import { richCard } from "./displayCards";
import { markMentions } from "./mentionMarks";
import { recordingCard } from "./recordingCard";
import { type AttachmentData, attachmentActions, imageSrc } from "./shots";
import { extensionsCard } from "./toolCards";
import { turnCard } from "./turnCards";
import { widgetCard } from "./widgetCard";

const KNOWN_TOOLS = [
  ...CORE_TOOLS,
  PLAN_TOOL,
  EXPLORE_TOOL,
  ...DISPLAY_TOOLS,
  ...BROWSER_TOOLS,
  BATCH_TOOL,
  SCREENSHOT_TOOL,
  ...turnTools(() => []),
  TOOL_SEARCH_ROW,
];

export interface ItemHost {
  session: AgentSession;
  root(): string;
  /** A path as the workspace names it (relative; "api/…" in another folder, D251). */
  relative(path: string): string;
  run(command: string, input?: unknown): void;
  openLink(href: string): void;
  copy(text: string): void;
  /** Expanded tool rows / thoughts (kept across re-renders). */
  expanded: Set<string>;
  rerender(): void;
  /** The user message being edited in place, if any. */
  editing: string | null;
  /** Each turn's final answer → its actions: "latest" always shown, "older" on hover. */
  answers: Map<string, "latest" | "older">;
  idle(): boolean;
  /** The conversation's last item (only it can be retried or continued). */
  lastItemId(): string | undefined;
  /** The latest turn can be retried (not a one-off task like tidying up memory). */
  canRetry(): boolean;
  /** The threads started on a message (D238): its "N replies" row. */
  threadsFor(item: string): readonly ThreadRow[];
}

type ToolItem = Extract<Item, { type: "tool" }>;

const TOOL_ICONS: Record<string, IconName> = {
  read_file: "file-text",
  list_dir: "folder",
  find_files: "search",
  search: "search",
  edit_file: "pencil",
  write_file: "file-plus",
  run_command: "square-terminal",
  process_output: "scroll-text",
  kill_process: "square",
  get_state: "list-tree",
  find_commands: "search",
  call_command: "braces",
  update_plan: "list-tree",
  wrap_up: "list-checks",
  mark_chapter: "bookmark",
  propose_task: "message-square-plus",
  hand_off_task: "git-fork",
  schedule_wakeup: "refresh-cw",
  search_chats: "search",
  read_guide: "book-open",
  dismiss_task: "message-square",
  enter_plan_mode: "list-tree",
  notify: "bell",
  show_links: "link",
  ask_user: "message-circle-question",
  screenshot: "camera",
  browser_snapshot: "globe",
  browser_act: "globe",
  browser_inspect: "globe",
  browser_console: "globe",
  browser_eval: "braces",
  browser_batch: "globe",
  // External (ACP) agents' tool kinds.
  "acp:read": "file-text",
  "acp:edit": "pencil",
  "acp:delete": "trash-2",
  "acp:move": "arrow-left-right",
  "acp:search": "search",
  "acp:execute": "square-terminal",
  "acp:fetch": "globe",
  "acp:review": "shield",
};

/**
 * The short tags after a step's name (D208): the shell an external agent's command ran in, and
 * the agent's own review of the step ("Guardian: approved · low risk").
 */
export function toolTags(item: ToolItem): HTMLElement[] {
  const out: HTMLElement[] = [];
  const shell = (item.args as { shell?: unknown } | null)?.shell;
  if (typeof shell === "string" && shell) out.push(h("span", { class: "agent-tool-tag" }, shell));
  if (item.review)
    out.push(
      h(
        "span",
        {
          class: {
            "agent-tool-tag": true,
            "is-review": true,
            "is-denied": item.review.status !== "approved" && item.review.status !== "in progress",
          },
        },
        reviewLine(item.review),
      ),
    );
  return out;
}

/** A step's expanded text: its output, after its review's rationale when it has one (D208). */
export function toolDetail(item: ToolItem, output: string | undefined): string | undefined {
  const base = item.detail ?? output ?? (item.status === "error" ? item.result : undefined);
  const r = item.review;
  if (!r?.rationale) return base;
  return `${reviewLine(r)}: ${r.rationale}${base ? `\n\n${base}` : ""}`;
}

/** The row's tooltip: the step as shown (an external agent's raw arguments say nothing). */
export function toolTooltip(item: ToolItem, verb: string, target: string): string {
  if (!item.name.startsWith("acp:"))
    return `${item.name} ${JSON.stringify(item.args ?? {}).slice(0, 300)}`;
  const shell = (item.args as { shell?: unknown } | null)?.shell;
  return [
    [verb, target].filter(Boolean).join(" "),
    typeof shell === "string" && shell ? `Ran in ${shell}` : "",
    item.review ? reviewLine(item.review) : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** How an item is shown: on its own, or as a step inside a turn's work group (D104). */
export interface RenderOptions {
  /** Inside the work group: assistant text is narration, tools show no diff cards. */
  step?: boolean;
  /** The answer's thinking is shown in the work group instead. */
  hideThinking?: boolean;
  /** Only the thinking row (the answer's thinking inside the work group). */
  thinkingOnly?: boolean;
}

/** Who a reply's header names, and their face as drawn (it changes with the agent, D270). */
function speakerKey(session: AgentSession, item: Extract<Item, { type: "assistant" }>): string {
  const speaker = speakerHeader(session, item);
  return speaker ? `${speaker.label}:${encodeFace(speaker.face)}:${speaker.face.model ?? "-"}` : "";
}

export function signature(item: Item, host: ItemHost, options: RenderOptions = {}): string {
  const mode = `${options.step ? "s" : ""}${options.hideThinking ? "h" : ""}${options.thinkingOnly ? "t" : ""}`;
  switch (item.type) {
    case "assistant":
      return `${mode}|${item.text.length}|${item.thinking.length}|${galleryKey(item.media)}|${item.streaming}|${host.expanded.has(item.id)}|${host.answers.get(item.id) ?? ""}|${host.idle()}|${item.model ?? ""}|${host.canRetry()}|${options.step ? "" : speakerKey(host.session, item)}|${repliesKey(host, item.id)}`;
    case "user":
      return `${host.editing === item.id}|${host.idle()}|${repliesKey(host, item.id)}`;
    case "notice":
      if (item.aside) return `aside|${item.aside.pending ?? false}|${item.aside.answer.length}`;
      return `${item.text}|${host.idle()}|${item.detail ?? ""}|${host.lastItemId() === item.id}|${planCardKey(item, host.session, host.expanded.has(item.id))}`;
    case "tool": {
      const pending = (item.changes ?? [])
        .map((p) => (host.session.changeset.get(p) ? "p" : "x"))
        .join("");
      return `${mode}|${item.status}|${item.summary}|${host.expanded.has(item.id)}|${(host.session.outputs.get(item.id) ?? "").length}|${pending}|${(item.images ?? item.previews)?.length ?? 0}|${galleryKey(item.media)}|${waiting(item, host)}|${cardState(item)}`;
    }
    case "summary":
      return `${host.expanded.has(item.id)}|${item.text.length}`;
    default:
      return "static";
  }
}

export function renderItem(item: Item, host: ItemHost, options: RenderOptions = {}): HTMLElement {
  switch (item.type) {
    case "user":
      return renderUser(item, host);
    case "assistant":
      return renderAssistant(item, host, options);
    case "tool":
      return renderTool(item, host, options);
    case "summary": {
      const open = host.expanded.has(item.id);
      const row = h(
        "button",
        { class: "agent-summary-row", type: "button", "aria-expanded": String(open) },
        icon("history"),
        h(
          "span",
          null,
          `${item.auto ? "Context was getting full: summarized" : "Summarized"} ${item.count} earlier message${item.count === 1 ? "" : "s"}`,
        ),
        icon(open ? "chevron-down" : "chevron-right"),
      );
      on(row, "click", () => toggle(host, item.id));
      return h(
        "div",
        { class: "agent-summary" },
        row,
        open ? h("div", { class: "agent-thought-body agent-summary-body" }, item.text) : null,
      );
    }
    case "notice": {
      // A side question (/btw, D389): its answer, which isn't part of the conversation.
      if (item.aside) return renderAside(item.id, item.aside, host);
      // Plan mode's plan as its document's card (D330).
      const plan = item.actions?.includes("build")
        ? planCard(item, {
            session: host.session,
            run: (command, input) => host.run(command, input),
            openLink: (href) => host.openLink(href),
            copy: (text) => host.copy(text),
            open: host.expanded.has(item.id),
            toggle: () => toggle(host, item.id),
            live: host.idle() && host.lastItemId() === item.id,
          })
        : null;
      if (plan) return h("div", { class: "agent-display" }, plan);
      // Short text, the full error on hover, and Retry / Continue under errors (when idle).
      const text = h("span", { class: "agent-notice-text" }, item.text);
      if (item.detail) setTooltip(text, item.detail);
      const button = (label: string, command: string, input: Record<string, unknown> = {}) => {
        const b = h("button", { class: "button button-ghost button-sm", type: "button" }, label);
        on(b, "click", () => host.run(command, { session: host.session.id, ...input }));
        return b;
      };
      // The same chat saved by another window (D221): asked while the conflict lasts.
      if (item.actions?.includes("keepHere") && host.session.conflict.peek())
        return h(
          "div",
          { class: "agent-notice is-error" },
          icon("circle-alert"),
          text,
          h(
            "span",
            { class: "agent-notice-actions" },
            button("Keep this version", "agent.resolveChatConflict", { keep: "here" }),
            button("Reload the other", "agent.resolveChatConflict", { keep: "other" }),
          ),
        );
      // Only the latest notice acts (D159): Retry / Continue on an older one would redo the
      // newest turn instead of the failed one.
      const actions =
        item.actions?.length && host.idle() && host.lastItemId() === item.id
          ? h(
              "span",
              { class: "agent-notice-actions" },
              item.actions.includes("retry") ? button("Retry", "agent.retry") : null,
              item.actions.includes("continue") ? button("Continue", "agent.continue") : null,
              item.actions.includes("build") ? button("Build", "agent.build") : null,
            )
          : null;
      return h(
        "div",
        {
          class: {
            "agent-notice": true,
            "is-error": item.tone === "error",
            "is-progress": item.tone === "info" && !!item.detail,
          },
        },
        item.tone === "error"
          ? icon("circle-alert")
          : item.detail
            ? h("span", { class: "agent-spinner" })
            : null,
        text,
        actions,
      );
    }
  }
}

/** The faces of the agents who replied in a message's threads. */
function threadFaces(names: readonly string[]): HTMLElement {
  return faceGroup(
    names.map((n) => memberInfo(n).face),
    18,
  );
}

/** What the replies row shows, for the render cache. */
function repliesKey(host: ItemHost, item: string): string {
  const list = host.threadsFor(item);
  return list.length
    ? `${list.length}:${list.map((t) => `${t.updated}${t.running ? "r" : ""}${t.unread ? "u" : ""}`).join(",")}`
    : "";
}

/** Under a message with threads: who replied, how many, the newest, working or unread. */
export function repliesRow(host: ItemHost, item: string): HTMLElement | null {
  const list = host.threadsFor(item);
  if (!list.length) return null;
  const replies = list.reduce((n, t) => n + (t.replies ?? 0), 0);
  const newest = list[list.length - 1];
  const who = [...new Set(list.flatMap((t) => (t.lastBy ? [t.lastBy] : [])))].slice(0, 3);
  const working = list.some((t) => t.running);
  const unread = list.some((t) => t.unread);
  const row = h(
    "button",
    {
      class: { "agent-replies": true, "is-unread": unread },
      type: "button",
      "data-thread": newest?.id ?? "",
    },
    who.length ? threadFaces(who) : null,
    h(
      "span",
      { class: "agent-replies-count" },
      list.length > 1
        ? `${list.length} threads`
        : replies
          ? `${replies} ${replies === 1 ? "reply" : "replies"}`
          : "Thread started",
    ),
    working ? h("span", { class: "agent-replies-working" }, "working…") : null,
    // Kept current by the view's minute timer (ui/relativeTimes.ts), without a redraw.
    newest
      ? h(
          "span",
          { class: "agent-replies-age", ...timeAttrs(newest.updated) },
          relativeAge(newest.updated),
        )
      : null,
  );
  row.addEventListener("click", (e) => {
    const newTab = e.ctrlKey || e.metaKey;
    // Several threads on one message: pick which (D244: only the newest was reachable).
    if (list.length > 1) {
      const r = row.getBoundingClientRect();
      showContextMenu(
        r.left,
        r.bottom + 2,
        [...list].reverse().map((t) => ({
          label: t.title.replace(/^Thread: /, ""),
          keybinding: relativeAge(t.updated),
          run: () => host.run("agent.openThread", { session: t.id, ...(newTab && { newTab }) }),
        })),
      );
      return;
    }
    if (newest) host.run("agent.openThread", { session: newest.id, ...(newTab && { newTab }) });
  });
  return row;
}

// `data-key`: a row updated in place (morph) keeps a button's listener, so a button is only ever
// reused for the same action (D422: Retry's became Fork's when the row lost its Retry).
const actionButton = (glyph: IconName, label: string, run: () => void): HTMLElement => {
  const b = h(
    "button",
    { class: "icon-button", type: "button", "aria-label": label, "data-key": label },
    icon(glyph),
  );
  setTooltip(b, label);
  on(b, "click", run);
  return b;
};

/**
 * Fork (D422): a new chat from this message on, this one left as it is. Its menu opens at the
 * button: the chat's own agent first, then the others (the fork is handed to the one picked).
 */
function forkButton(host: ItemHost, item: string): HTMLElement {
  const b = h(
    "button",
    {
      class: "icon-button",
      type: "button",
      "aria-label": "Fork from here",
      "data-fork": item,
      "data-key": "fork",
    },
    icon("chat-fork"),
  );
  setTooltip(b, "Start a new chat from this point. This one stays as is.");
  on(b, "click", () => {
    const session = host.session;
    const fork = (agent?: string) =>
      host.run("agent.forkSession", { session: session.id, item, ...(agent && { agent }) });
    // A group chat's fork keeps its agents.
    const group = session.members.peek().length > 0;
    const current = soloSpeaker(session.chatMode.peek());
    const others = group ? [] : knownAgents().filter((a) => a.name !== current);
    showMenu(
      b,
      [
        {
          label: group ? "Fork from here" : `Fork with ${memberInfo(current).label}`,
          icon: "chat-fork",
          run: () => fork(),
        },
        ...others.map((a, i) => ({
          label: a.label,
          iconElement: () => agentFace(a.face, { size: 16 }),
          ...(i === 0 && { heading: "Fork and hand to" }),
          ...(a.description && { tooltip: a.description }),
          run: () => fork(a.name),
        })),
      ],
      "Fork",
    );
  });
  return b;
}

/** Your message: copy and edit (on hover); editing swaps the card for a box with Send / Cancel. */
function renderUser(item: Extract<Item, { type: "user" }>, host: ItemHost): HTMLElement {
  // The harness's own message (a failed check sent back, D127): a quiet line, not a bubble.
  if (item.auto === "verify") {
    const command = /`([^`]+)`/.exec(item.text)?.[1] ?? "The check";
    return h(
      "div",
      { class: "agent-msg agent-auto", "data-key": item.id },
      icon("circle-x"),
      h("span", null, `\`${command}\` failed — sent back to the agent to fix.`),
    );
  }
  // A loop's check (D332): its own quiet line.
  const tick = loopTickRow(item);
  if (tick) return tick;
  // A scheduled message, a background command that ended (D253) or a workflow's end (D338): a
  // quiet line; the whole message is in its tooltip.
  if (item.auto === "schedule" || item.auto === "process" || item.auto === "workflow") {
    const body = item.text.split("\n\n").slice(1).join("\n\n").trim();
    const line =
      item.auto === "schedule"
        ? `Scheduled message: ${body.split("\n")[0] ?? ""}`
        : (item.text.split("\n")[0] ?? "").replace(/ \(you asked to be told\)/, "");
    const row = h(
      "div",
      { class: "agent-msg agent-auto", "data-key": item.id },
      icon(item.auto === "schedule" ? "clock" : item.auto === "workflow" ? "git-fork" : "terminal"),
      h("span", null, line),
    );
    setTooltip(row, item.text.slice(0, 1200));
    return row;
  }
  // A monitor's events, a watched pull request's news, another chat's message (D322–D325).
  if (item.auto === "monitor" || item.auto === "pr" || item.auto === "chat")
    return renderAutoNews(item, item.auto, (command, input) => host.run(command, input));
  if (host.editing === item.id) {
    const box = h("textarea", { class: "agent-edit-input", rows: "1" }) as HTMLTextAreaElement;
    box.value = item.text;
    const grow = () => {
      box.style.height = "auto";
      box.style.height = `${Math.min(box.scrollHeight, 240)}px`;
    };
    const send = () => {
      const text = box.value.trim();
      if (text) host.run("agent.editMessage", { session: host.session.id, item: item.id, text });
    };
    const cancel = () =>
      host.run("agent.editMessage", { session: host.session.id, item: item.id, cancel: true });
    on(box, "input", grow);
    on(box, "keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });
    requestAnimationFrame(() => {
      grow();
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    });
    const button = (label: string, cls: string, run: () => void) => {
      const b = h("button", { class: `button ${cls} button-sm`, type: "button" }, label);
      on(b, "click", run);
      return b;
    };
    return h(
      "div",
      { class: "agent-msg agent-user is-editing", "data-key": `${item.id}:edit` },
      box,
      h(
        "div",
        { class: "agent-edit-actions" },
        h("span", { class: "agent-edit-hint" }, "Replaces the conversation after it"),
        button("Cancel", "button-ghost", cancel),
        button("Send", "button-accent", send),
      ),
    );
  }
  return h(
    "div",
    { class: "agent-msg agent-user-wrap", "data-key": item.id },
    // Attachments sit above the bubble as their own row of cards (D131).
    item.attachments?.length ? sentCards(item) : null,
    h(
      "div",
      { class: "agent-user" },
      // No chip for the mode a message was sent in (the owner's call): the composer shows the
      // mode, and the answer's turn shows what came of it.
      item.attachments?.length
        ? null
        : contextChips(item.context)?.length
          ? h(
              "div",
              { class: "agent-chips" },
              ...(contextChips(item.context) ?? []).map((c) =>
                h("span", { class: "agent-chip" }, c.split("\n")[0]?.slice(0, 60) ?? ""),
              ),
            )
          : null,
      !item.attachments?.length && (item.images ?? item.previews)?.length
        ? h(
            "div",
            { class: "agent-chips" },
            ...(item.images ?? item.previews ?? []).map((data) =>
              h(
                "span",
                { class: "agent-chip is-image" },
                h("img", { src: imageSrc(data), alt: "Attached image" }),
              ),
            ),
          )
        : null,
      clampedText(item.id, item.text, host.session),
    ),
    h(
      "div",
      { class: "agent-msg-actions is-user" },
      actionButton("copy", "Copy message", () => host.copy(item.text)),
      host.idle() && !item.sideTask
        ? actionButton("pencil", "Edit message", () =>
            host.run("agent.editMessage", { session: host.session.id, item: item.id }),
          )
        : null,
      // Restore checkpoint (D200): the chat and the agent's file changes back to before this.
      host.idle() && !item.sideTask && item.turn !== undefined
        ? actionButton("rotate-ccw", "Restore checkpoint", () =>
            host.run("agent.restoreToMessage", { session: host.session.id, item: item.id }),
          )
        : null,
    ),
    repliesRow(host, item.id),
  );
}

/** Characters past which a sent message starts folded (also checked by height once shown). */
const CLAMP_CHARS = 600;
const CLAMP_LINES = 8;

/**
 * Your message's text; a long one shows its start with "Show more" (modern chats' fold, D143).
 * Decided from the text (no layout read), so history renders without measuring.
 */
/** Messages opened with "Show more" (kept across re-renders while the chat streams). */
const unfolded = new Set<string>();

function clampedText(id: string, text: string, session: AgentSession): HTMLElement {
  const body = h("div", { class: "agent-user-text" }, text);
  markMentions(body, mentionTargets(session));
  if (text.length <= CLAMP_CHARS && text.split("\n").length <= CLAMP_LINES) return body;
  const open = unfolded.has(id);
  body.classList.toggle("is-clamped", !open);
  const more = h(
    "button",
    { class: "agent-user-more", type: "button" },
    open ? "Show less" : "Show more",
  );
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    const folded = body.classList.toggle("is-clamped");
    if (folded) unfolded.delete(id);
    else unfolded.add(id);
    more.textContent = folded ? "Show more" : "Show less";
  });
  return h("div", { class: "agent-user-body" }, body, more);
}

/** A sent message's attachments as cards (images matched to `images` in order). */
function sentCards(item: Extract<Item, { type: "user" }>): HTMLElement {
  let image = 0;
  // Each card opens the viewer on itself, paging through the message's others (D158).
  const list = (item.attachments ?? []).map((a) => {
    const data = a.kind === "image" ? (item.images ?? item.previews)?.[image++] : undefined;
    return {
      ...a,
      ...(data && { image: data }),
      ...(a.kind === "mention" && {
        icon: a.widget ? ("app-window" as const) : ("at-sign" as const),
      }),
    };
  });
  // Download and "Add to project" on hover (D211), for what was kept: an image (or its saved
  // preview) or a text.
  const data = (i: number): AttachmentData | null => {
    const a = list[i];
    if (!a) return null;
    if (a.kind === "image") return a.image ? { name: a.name, kind: "image", data: a.image } : null;
    const text = a.text ?? undefined;
    return text ? { name: a.pasted ? "pasted.txt" : a.name, kind: "text", data: text } : null;
  };
  const run = (i: number, how: "save" | "addToProject") => {
    const d = data(i);
    const act = attachmentActions();
    if (d && act) act[how](d);
  };
  const can = (i: number) => attachmentActions() !== null && data(i) !== null;
  const cards = openableCards(
    list,
    undefined,
    undefined,
    (i) => run(i, "addToProject"),
    (i) => run(i, "save"),
  );
  // Cards with nothing kept (an image from before previews) get no buttons.
  cards.forEach((card, i) => {
    if (!can(i)) card.querySelector(".agent-card-actions")?.remove();
  });
  return h("div", { class: "agent-sent-cards" }, ...cards);
}

function renderAssistant(
  item: Extract<Item, { type: "assistant" }>,
  host: ItemHost,
  options: RenderOptions,
): HTMLElement {
  const el = h("div", {
    class: { "agent-msg": true, "agent-assistant": true, "is-step": !!options.step },
  });
  // Who wrote it (D231): in a group chat when the speaker changes, and after a handoff.
  const speaker = options.step || options.thinkingOnly ? null : speakerHeader(host.session, item);
  if (speaker)
    el.append(
      h(
        "div",
        { class: "agent-speaker", "data-speaker": speaker.name },
        agentFace(speaker.face, { size: 18 }),
        h("span", { class: "agent-speaker-name" }, speaker.label),
        speaker.role ? h("span", { class: "agent-speaker-role" }, speaker.role) : null,
      ),
    );
  if (options.hideThinking) {
    // The work group shows the thinking (and "Thinking…" while nothing else has come).
  } else if (options.thinkingOnly) {
    // Inside an open work group: the group's own header is the toggle (and says "Thinking…"),
    // so the thought shows as is, without a second header.
    if (item.thinking.trim())
      el.append(h("div", { class: "agent-thought-body" }, item.thinking.trim()));
  } else if (item.thinking) {
    const open = host.expanded.has(item.id);
    const secs =
      item.thinkingMs !== undefined ? Math.max(1, Math.round(item.thinkingMs / 1000)) : null;
    const label = secs === null && item.streaming ? "Working on it…" : `Thought for ${secs ?? 1}s`;
    const row = h(
      "button",
      {
        class: { "agent-thought": true, "is-shimmer": secs === null && item.streaming },
        type: "button",
        "aria-expanded": String(open),
      },
      h("span", null, label),
      icon(open ? "chevron-down" : "chevron-right"),
    );
    on(row, "click", () => toggle(host, item.id));
    el.append(row);
    if (open) el.append(h("div", { class: "agent-thought-body" }, item.thinking.trim()));
  } else if (item.streaming && !item.text && !item.media?.length && !options.thinkingOnly) {
    el.append(h("div", { class: "agent-thought is-shimmer" }, "Working on it…"));
  }
  // Images the model drew (D381): under its text, above the reply's actions.
  const gallery =
    options.thinkingOnly || !item.media?.length
      ? null
      : chatImageGallery(host.session.id, item.media);
  if (item.text && !options.thinkingOnly) {
    const body = h("div", {
      class: { md: true, "agent-prose": true, "agent-narration": !!options.step },
    });
    renderReply(
      body,
      item.text,
      {
        openLink: host.openLink,
        copy: host.copy,
        codeActions: (b) => codeBlockActions(host.run, host.session.id, b),
      },
      mentionTargets(host.session),
    );
    if (item.streaming)
      (body.lastElementChild ?? body).append(
        h("span", { class: "agent-caret", "aria-hidden": "true" }),
      );
    el.append(body);
    if (gallery) el.append(gallery);
    // A turn's final answer: copy, retry (the latest, when idle) and the model that wrote it.
    // While the agent works, its latest text may be a note before its next step: no actions
    // until the turn is done (D160).
    const answer = options.step ? undefined : host.answers.get(item.id);
    if (!item.streaming && answer && (answer === "older" || host.idle())) {
      el.append(
        h(
          "div",
          { class: { "agent-msg-actions": true, "is-latest": answer === "latest" } },
          actionButton("copy", "Copy message", () => host.copy(item.text)),
          // A new chat from this point, with this agent or another one (D422; it took the
          // place of "Hand to another agent…", D231). Before Retry, which comes and goes: the
          // row is updated in place (morph), where a button keeps its listener, so one that
          // moved into another's place would do the other's work.
          forkButton(host, item.id),
          answer === "latest" && host.idle() && host.canRetry()
            ? actionButton("refresh-ccw", "Retry", () =>
                host.run("agent.retry", { session: host.session.id }),
              )
            : null,
          item.model ? h("span", { class: "agent-msg-model" }, item.model) : null,
          item.cost ? h("span", { class: "agent-msg-cost" }, formatCost(item.cost)) : null,
        ),
      );
      const replies = repliesRow(host, item.id);
      if (replies) el.append(replies);
      // The agent's own handoffs (its file's `handoffs:`), under its latest reply.
      const handoffs = answer === "latest" && host.idle() ? handoffsOf(item.speaker) : [];
      if (handoffs.length)
        el.append(
          h(
            "div",
            { class: "agent-handoffs" },
            ...handoffs.map((hand) => {
              const b = h(
                "button",
                { class: "button button-ghost button-sm agent-handoff", type: "button" },
                h("span", null, hand.label),
                icon("arrow-right"),
              );
              setTooltip(
                b,
                `${hand.send ? "Sends" : "Moves the chat to"} ${hand.agent}${hand.prompt ? `: ${hand.prompt.slice(0, 200)}` : ""}`,
              );
              on(b, "click", () =>
                host.run("agent.handoff", {
                  session: host.session.id,
                  to: hand.agent,
                  ...(hand.prompt && { prompt: hand.prompt }),
                  ...(hand.send && { send: true }),
                }),
              );
              return b;
            }),
          ),
        );
    }
  }
  if (gallery && gallery.parentNode !== el) el.append(gallery);
  return el;
}

function statusIcon(item: ToolItem, pending: boolean): Element {
  if (item.status === "running")
    return h("span", { class: "agent-spinner", "aria-label": "Running" });
  if (pending)
    return h("span", { class: "agent-dot is-pending", "aria-label": "Waiting for review" });
  const name: IconName =
    item.status === "done" ? "check" : item.status === "denied" ? "minus" : "x";
  const el = icon(name);
  el.classList.add(`is-${item.status}`);
  return el;
}

/** A tool call's verb and target as rows show them ("Read", "src/App.tsx"). */
export function toolLabel(
  item: ToolItem,
  relative: (path: string) => string,
): { verb: string; target: string } {
  // The verify step's run (D127).
  if (item.check)
    return {
      verb: item.status === "running" ? "Checking with" : "Checked with",
      target: String((item.args as { command?: unknown } | null)?.command ?? ""),
    };
  const tool = KNOWN_TOOLS.find((t) => t.spec.name === item.name);
  const args = (item.args ?? {}) as Record<string, unknown>;
  const external = item.name.startsWith("acp:");
  // A failed step doesn't say it happened ("Edited" → "Edit … · edit failed").
  const FAILED: Record<string, string> = { Edited: "Edit", Wrote: "Write", Ran: "Run" };
  const verb =
    (item.status === "error" && tool ? FAILED[tool.verb] : undefined) ??
    tool?.verb ??
    (external
      ? String(args.title ?? item.name.slice(4))
      : item.name.replace(/^mcp__([^_]+)__/, "$1: "));
  const target =
    tool?.target(args) ??
    (external && typeof args.path === "string" ? relative(args.path) || args.path : "");
  return { verb, target };
}

/** What redraws a card besides its status: its detail (answers, installed) and installs now (D314). */
function cardState(item: ToolItem): string {
  if (DISCOVERY_CARDS.has(item.name)) return discoveryCardState(item);
  if (item.name !== "suggest_extension" && item.name !== "ask_user") return "";
  return `${item.detail ?? ""}${[...installingFrom(item.id)].join()}`;
}

/** The agent waits on this ask_user call's answer (D171). */
function waiting(item: ToolItem, host: ItemHost): boolean {
  return host.session.questions.peek().some((q) => q.itemId === item.id);
}

/** A display tool's call as its card (D171), or null (it failed: shown as a row). */
function renderDisplay(item: ToolItem, host: ItemHost): HTMLElement | null {
  if (item.status === "error") return null;
  const session = host.session.id;
  const base = {
    openLink: (href: string) => host.openLink(href),
    run: (command: string, input?: unknown) => host.run(command, input),
    session,
    item: item.id,
  };
  // An install card (D314): drawn from the call's detail, which its Install updates.
  if (item.name === "suggest_extension") {
    const data = parseSuggestion(item.detail);
    if (!data) return null;
    const installing = installingFrom(item.id);
    const card = extensionsCard(data, { ...base, installing });
    card.dataset.key = `rb-tool-${item.id}-${item.detail ?? ""}-${[...installing].join()}`;
    return card;
  }
  // Skills and MCP servers to add, MCP servers' state (D342, D343): from the call's detail.
  if (DISCOVERY_CARDS.has(item.name)) return discoveryCard(item, base);
  const block = cardFromTool(item.name, item.args);
  if (!block) return null;
  const open = waiting(item, host);
  const done = item.name === "ask_user" && item.status === "done";
  const chosen = done ? item.summary : undefined;
  // Several questions' answers, by question (D312).
  const answers = done && item.detail?.startsWith("{") ? parseAnswers(item.detail) : undefined;
  return richCard(
    block,
    {
      ...base,
      ...(open && {
        choose: (text: string) => host.run("agent.answer", { session, item: item.id, text }),
        answer: (a: AskAnswers) => host.run("agent.answer", { session, item: item.id, answers: a }),
      }),
      ...(chosen !== undefined && { chosen }),
      ...(answers && { answers }),
    },
    `rb-tool-${item.id}-${open ? 1 : 0}-${chosen ?? ""}-${item.detail ?? ""}`,
  );
}

/** ask_user's answers kept in its detail, if that's what it holds. */
function parseAnswers(detail: string): AskAnswers | undefined {
  try {
    const v = JSON.parse(detail) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as AskAnswers) : undefined;
  } catch {
    return undefined;
  }
}

function renderTool(item: ToolItem, host: ItemHost, options: RenderOptions): HTMLElement {
  // An inline widget (D334): the same element every time, so its frame doesn't reload.
  if (!options.step && item.name === "show_widget") {
    const card = widgetCard(host, item.args, item.status === "error", {
      session: host.session.id,
      item: item.id,
      callId: item.callId,
      run: (command, input) => host.run(command, input),
      openLink: (href) => host.openLink(href),
    });
    if (card) return card;
  }
  if (!options.step && DISPLAY_TOOL_NAMES.has(item.name)) {
    const card = renderDisplay(item, host);
    if (card) return h("div", { class: "agent-display" }, card);
  }
  // A chapter's divider, a proposed task, the Plan mode question (D302–D304).
  if (!options.step && TURN_CARD_TOOLS.has(item.name)) {
    const card = turnCard(item, host);
    if (card) return h("div", { class: "agent-display" }, card);
  }
  // A browser recording's GIF with Save (D340).
  const recorded = !options.step && item.status === "done" && isRecordingStop(item.name, item.args);
  if (recorded && item.name === "browser_act")
    return h(
      "div",
      { class: "agent-display" },
      recordingCard(item.id, (c, i) => host.run(c, i)),
    );
  const args = (item.args ?? {}) as Record<string, unknown>;
  const { verb, target } = toolLabel(item, host.relative);
  const pendingPaths = (item.changes ?? []).filter((p) => host.session.changeset.get(p));
  const open = host.expanded.has(item.id);
  const output = host.session.outputs.get(item.id);
  const detail = toolDetail(item, output);
  const row = h(
    "button",
    {
      class: { "agent-tool": true, [`is-${item.status}`]: true },
      type: "button",
      "aria-expanded": detail ? String(open) : undefined,
    },
    icon(TOOL_ICONS[item.name] ?? "braces"),
    h("span", { class: "agent-tool-verb" }, verb),
    h("span", { class: "agent-tool-target" }, target),
    ...toolTags(item),
    item.summary ? h("span", { class: "agent-tool-meta" }, `· ${item.summary}`) : null,
    h("span", { class: "agent-tool-status" }, statusIcon(item, pendingPaths.length > 0)),
    detail ? icon(open ? "chevron-down" : "chevron-right") : null,
  );
  setTooltip(row, toolTooltip(item, verb, target));
  on(row, "click", (e) => {
    // The target opens the file; the rest toggles the details.
    if ((e.target as Element).closest(".agent-tool-target") && typeof args.path === "string") {
      host.run("editor.openFile", { path: args.path });
      return;
    }
    // Read at click time: the row is updated in place, this handler stays from the first render.
    if (toolDetail(item, host.session.outputs.get(item.id))) toggle(host, item.id);
  });
  const el = h("div", { class: "agent-tool-wrap" }, row);
  if (open && detail) el.append(h("pre", { class: "agent-well" }, detail));
  // Screenshots: a thumbnail; click shows it full size in the chat. (A tool's own images, D381,
  // are in its gallery.)
  for (const png of item.media?.length ? [] : (item.images ?? item.previews ?? [])) {
    const img = h("img", {
      class: "agent-shot",
      src: imageSrc(png),
      alt: "Screenshot",
    });
    on(img, "click", () => img.classList.toggle("is-expanded"));
    el.append(img);
  }
  // A tool's images (D381), or the placeholder while it makes one; in a work group they show
  // under the group instead.
  const gallery = options.step
    ? null
    : chatImageGallery(host.session.id, item.media ?? [], pendingImages(item));
  if (gallery) el.append(gallery);
  // In a work group the diff cards show under the group instead (they need a decision).
  if (!options.step) for (const path of item.changes ?? []) el.append(diffCard(path, host));
  // A batch that ended a recording: its row, then the recording (D340).
  if (recorded) el.append(recordingCard(item.id, (c, i) => host.run(c, i)));
  return el;
}

export function diffCard(path: string, host: ItemHost): HTMLElement {
  const pending = host.session.changeset.get(path);
  const name = basename(path);
  const glyph = icon(fileIcon(name));
  const session = host.session.id;
  const button = (label: string, cls: string, run: () => void) => {
    const b = h("button", { class: `button ${cls} button-sm`, type: "button" }, label);
    on(b, "click", run);
    return b;
  };
  const stat = pending ? host.session.changeset.stat(pending) : null;
  return h(
    "div",
    { class: { "agent-diff-card": true, "is-done": !pending }, "data-key": path },
    glyph,
    h("span", { class: "agent-diff-path" }, host.relative(path)),
    stat
      ? h(
          "span",
          { class: "agent-diff-stat" },
          h("span", { class: "is-added" }, `+${stat.added}`),
          " ",
          h("span", { class: "is-removed" }, `−${stat.removed}`),
        )
      : h("span", { class: "agent-diff-stat" }, "reviewed"),
    h(
      "span",
      { class: "agent-actions" },
      // Asked at click time: the card is updated in place (morph keeps this first handler), so
      // after Accept it still opened the review diff of a change no longer under review.
      button("Open diff", "button-ghost", () =>
        host.session.changeset.get(path)
          ? host.run("agent.openReviewDiff", { path, session })
          : // Already written (auto-apply / accepted): before ↔ now from local history (D119).
            host.run("agent.openAppliedDiff", { session, path }),
      ),
      pending
        ? button("Reject", "button-ghost", () =>
            host.run("agent.reviewChange", { session, path, action: "reject" }),
          )
        : null,
      pending
        ? button("Accept", "button-accent", () =>
            host.run("agent.reviewChange", { session, path, action: "accept" }),
          )
        : null,
    ),
  );
}

function toggle(host: ItemHost, id: string): void {
  if (host.expanded.has(id)) host.expanded.delete(id);
  else host.expanded.add(id);
  host.rerender();
}

/**
 * A reply's Markdown (answers and notes): wrapper tags some models add (`<result>`) are left out,
 * and if rendering ever throws (a pathological input), the text shows plain instead of the chat
 * freezing on every frame (D163).
 */
export function renderReply(
  body: HTMLElement,
  text: string,
  options: Parameters<typeof renderMarkdown>[2],
  /** Who its @mentions can name (`mentionTargets`). */
  members: readonly GroupMember[],
): void {
  const shown = withoutWrapperTags(text);
  try {
    renderMarkdown(body, shown, options);
    // @mentions stand out (D273): a handoff to @Jonna as much as the user's @Gabby.
    markMentions(body, members);
  } catch {
    body.replaceChildren(h("p", { class: "agent-plain" }, shown));
  }
}

/** /btw's card (D389): the question, its answer (Markdown) and a close button. */
function renderAside(
  id: string,
  aside: { question: string; answer: string; pending?: boolean },
  host: ItemHost,
): HTMLElement {
  const close = h(
    "button",
    { class: "icon-button agent-aside-close", type: "button", "aria-label": "Close" },
    icon("x"),
  );
  setTooltip(close, "Close (it isn't part of the conversation)");
  on(close, "click", () => host.run("agent.dismissNotice", { session: host.session.id, item: id }));
  const body = h("div", { class: { md: true, "agent-prose": true, "agent-aside-answer": true } });
  if (aside.pending && !aside.answer)
    body.replaceChildren(h("span", { class: "agent-aside-pending" }, "Thinking…"));
  else
    renderReply(
      body,
      aside.answer,
      { openLink: host.openLink, copy: host.copy },
      mentionTargets(host.session),
    );
  return h(
    "div",
    { class: "agent-aside", role: "note" },
    h(
      "div",
      { class: "agent-aside-head" },
      icon("message-circle-question"),
      h("span", { class: "agent-aside-label" }, "Side question"),
      h("span", { class: "agent-aside-question" }, aside.question),
      close,
    ),
    body,
  );
}

/** A message's context as chips: the mode's rules (D180) show as the mode chip instead. */
function contextChips(context: readonly string[] | undefined): string[] | undefined {
  const rules = allModeRules();
  // The group's brief and the thread's channel line (D231, D237) are for the agent, not shown.
  return context?.filter(
    (c) => !rules.has(c) && !isGroupContext(c) && !c.startsWith(ROOM_BRIEF_PREFIX),
  );
}
