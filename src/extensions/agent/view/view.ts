// The agent panel (DESIGN.md §13): one dock tab per session. Header (title → history, new
// session, more), the conversation (72ch column, auto-scroll that respects the reader, "Jump to
// latest"), inline permission cards (permissionCards.ts), the changeset bar, the composer.

import { collapseQuietTicks } from "../../../core/agent/chatLoop";
import type { Item } from "../../../core/agent/conversation";
import { agentFace as faceOf } from "../../../core/agent/faces";
import { findMentions } from "../../../core/agent/groupChat";
import { planBeforeLastMessage } from "../../../core/agent/plan";
import { relativeAge, threadRoom, threadsByMessage } from "../../../core/agent/rooms";
import { latestWrapUp } from "../../../core/agent/turnTools";
import type { Json } from "../../../core/dock/index";
import { h, morph, on, replaceChildren } from "../../../core/dom/index";
import { Emitter } from "../../../core/events/index";
import { dragDropIpc } from "../../../core/ipc/fs";
import { type Disposable, DisposableStore } from "../../../core/lifecycle/index";
import { effect, type ReadonlySignal } from "../../../core/reactive/index";
import { agentFace } from "../../../ui/AgentFace";
import { HoverCards } from "../../../ui/HoverCard";
import { icon } from "../../../ui/Icon";
import { keepTimesCurrent, refreshTimes } from "../../../ui/relativeTimes";
import { setTooltip } from "../../../ui/Tooltip";
import type { DockView, DockViewContext } from "../../../workbench/dock/views";
import { locationLabel } from "../../../workbench/workspace";
import { chatModelKey } from "../chatAgentModel";
import type { DetailsHost } from "../chatDetails";
import { customModes } from "../customModes";
import { knownAgents, memberInfo, showGroupFaces } from "../groupChat";
import { mainAgent } from "../mainAgent";
import { rooms, roomTitle } from "../roomService";
import type { AgentSession, PermissionRequest, QueuedMessage } from "../session";
import { liveRow, threads } from "../threadList";
import { messageReveal } from "../threadTabs";
import { helperRootOf } from "../toolRoots";
import { BackgroundChip } from "./backgroundChip";
import { changesSignature, renderChanges } from "./changes";
import { LoopStrip } from "./chatFlowCards";
import { chatImageGallery, galleryKey, pendingImages } from "./chatImages";
import { Composer } from "./composer";
import { ChatDetails } from "./details";
import { type ItemHost, type RenderOptions, renderItem, signature, toolLabel } from "./items";
import { folderCard, permissionCard } from "./permissionCards";
import { shotPreview } from "./shots";
import { renderRow, rowSignature } from "./steps";
import { ChapterMenu, wrapUpBox } from "./turnCards";
import {
  draftActivity,
  layoutTurns,
  type Segment,
  type WorkEntry,
  type WorkRow,
  workActivity,
  workRows,
  workSummary,
} from "./turns";
import type { Recording } from "./voice";
import { disposeWidgetCards, streamingWidget, widgetDraftCard } from "./widgetCard";
import { formatDuration, WorkGroup } from "./work";
import { WorkflowCards } from "./workflows";
import { WorktreeChip } from "./worktreeChip";

export interface AgentViewHost {
  session(state: Json): AgentSession;
  /** Speech to text for the composer's voice input (D180). */
  transcribe(recording: Recording): Promise<string>;
  /** Whether a recording can start: false after showing dictation's setup (D384). */
  prepareVoice(): Promise<boolean>;
  /** The chat's external agent when its program isn't installed (reactive, D190), else null. */
  missingAgent(
    session: AgentSession,
  ): { name: string; program: string; install: string; failed?: boolean; signIn?: string } | null;
  run(command: string, input?: unknown): void;
  /** A command's result (the composer's inline / and @ lists, D389). */
  query(command: string, input?: unknown): Promise<unknown>;
  openLink(href: string): void;
  copy(text: string): void;
  root(): string;
  /** A path as the workspace names it (relative; "api/…" in another folder, D251). */
  relative(path: string): string;
  /** The folder open now (the chat may belong to another, D126). */
  readonly openFolder: ReadonlySignal<string | null>;
  /**
   * Whether a chat stored with `stored` (its `meta.workspace`) is this window's (D251: its first
   * folder, or a multi-root workspace's file); reactive.
   */
  isThisWorkspace(stored: string | null | undefined): boolean;
  /** The system folder picker (the folder card's "Change…"). */
  pickFolder(title: string): Promise<string | null>;
  modelLabel(session: AgentSession): string;
  /** The session's model's provider or agent logo (reactive), or null. */
  modelMark(session: AgentSession): HTMLElement | null;
  showModelMenu(session: AgentSession, anchor: HTMLElement): void;
  showModeMenu(session: AgentSession, anchor: HTMLElement): void;
  /** A group chat's effort pill: each agent's effort (D273). */
  showMembersEffort(session: AgentSession, anchor: HTMLElement): void;
  /** Terminal commands run without asking (agent.runCommands "auto"); reactive. */
  autoRunCommands(): boolean;
  /** Full access: nothing asks (agent.runCommands "full", D163); reactive. */
  fullAccess(): boolean;
  showMoreMenu(session: AgentSession, anchor: HTMLElement): void;
  /** Empty-state text: which model will answer, or how to get one. */
  emptyState(session: AgentSession): HTMLElement;
  activated(session: AgentSession): void;
  /** agent.streamText: show answers while they arrive (else when complete). */
  streamText(): boolean;
  /** Explorer files dropped on `element` (see WorkbenchServices.fileDropTarget). */
  fileDropTarget(element: HTMLElement, drop: (path: string) => void): Disposable;
  /** A setting's value (reactive read). */
  setting(key: string): unknown;
  warn(message: string): void;
  /** The details panel's data, folds and agent.toggleDetails (D231, chatDetails.ts). */
  readonly details: DetailsHost;
  /** The channel or direct message whose conversation this is (the channel tab, D238). */
  readonly room?: string;
  /** The conversation was on screen as it changed (unread, D238). */
  seen?(session: AgentSession): void;
}

/** A reply quiet this long while the turn runs shows the work line under it (D163). */
const QUIET_MS = 1500;
/** Past this many characters a streaming reply re-renders at most every LONG_EVERY_MS. */
const LONG_STREAM = 20_000;
const LONG_EVERY_MS = 250;
/** How long a "show this message" waits for its conversation to load and its tab to lay out. */
const REVEAL_WAIT_MS = 5000;
/** How long the shown message stays lit, then how long its fade (--motion-deliberate) may take. */
const REVEAL_HOLD_MS = 1200;
const REVEAL_FADE_MS = 400;

export class AgentView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly changed = this.store.add(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  readonly session: AgentSession;
  private readonly log: HTMLElement;
  private readonly column: HTMLElement;
  private readonly cards: HTMLElement;
  private readonly jump: HTMLElement;
  private readonly composer: Composer;
  /** The chat's table of contents in the header (D302). */
  private readonly chapters: ChapterMenu;
  /** The chat's workflow runs (D338), under the plan. */
  private readonly workflows: WorkflowCards;
  private readonly cache = new Map<string, { el: HTMLElement; sig: string; at?: number }>();
  private readonly itemHost: ItemHost;
  private readonly bgChip: BackgroundChip;
  private frame = 0;
  private stick = true;
  /** Where the reader last scrolled to, and whether the log was hidden since (D370). */
  private readerTop = 0;
  private wasHidden = false;
  /** This chat's threads by the message they answer, for the current list of threads. */
  private threadsMemo: {
    rows: readonly import("../../../core/agent/rooms").ThreadRow[];
    map: Map<string, import("../../../core/agent/rooms").ThreadRow[]>;
  } | null = null;

  constructor(
    state: Json,
    ctx: DockViewContext,
    private readonly host: AgentViewHost,
  ) {
    const session = host.session(state);
    this.session = session;
    // The channel tab's state is its room (its conversation can be started over, D238).
    if (!host.room && (state as { session?: string } | null)?.session !== session.id)
      ctx.updateState({ session: session.id });
    this.itemHost = {
      session,
      root: host.root,
      relative: host.relative,
      run: host.run,
      openLink: host.openLink,
      copy: host.copy,
      expanded: new Set(),
      rerender: () => this.schedule(),
      get editing() {
        return session.editing.peek();
      },
      answers: new Map(),
      idle: () => session.status.peek() === "idle",
      lastItemId: () => session.items[session.items.length - 1]?.id,
      canRetry: () => {
        const last = session.items.findLast((i) => i.type === "user" && !i.auto);
        return last?.type === "user" && !last.sideTask;
      },
      // Worked out once per list of threads, not for every message on every redraw (D244).
      threadsFor: (item) => {
        const rows = threads.peek();
        if (this.threadsMemo?.rows !== rows)
          this.threadsMemo = { rows, map: threadsByMessage(rows, session.id) };
        return this.threadsMemo.map.get(item) ?? [];
      },
    };
    const title = h("button", { class: "agent-title", type: "button" });
    // The thread's channel (D237): "#general ›" before the title, back to the channel.
    const roomLink = h("button", { class: "agent-room-link", type: "button" });
    // Who the chat is with (D230): the agent's face, in its state (working, waiting for you).
    const face = h("span", { class: "agent-header-face" });
    const more = h(
      "button",
      { class: "icon-button", type: "button", "aria-label": "More" },
      icon("ellipsis"),
    );
    const fresh = h(
      "button",
      { class: "icon-button", type: "button", "aria-label": "New chat" },
      icon("plus"),
    );
    // "+ ▾" (D236): which agent the new chat is with, a group chat, this chat's agents again.
    const freshWith = h(
      "button",
      {
        class: "icon-button agent-header-dropdown",
        type: "button",
        "aria-label": "Talk to…",
        "aria-haspopup": "menu",
      },
      icon("chevron-down"),
    );
    setTooltip(freshWith, "Talk to…");
    // Who a new chat is with is picked in its composer (D291): no ▾ beside +.
    freshWith.hidden = true;
    const history = h(
      "button",
      { class: "icon-button", type: "button", "aria-label": "Sessions" },
      icon("history"),
    );
    setTooltip(history, "Sessions", "agent.showHistory");
    setTooltip(more, "More");
    const progress = h("div", { class: "progress-line", hidden: true });
    this.column = h("div", { class: "agent-column" });
    this.cards = h("div", { class: "agent-cards" });
    this.log = h(
      "div",
      { class: "agent-log", role: "log", "aria-live": "polite", tabindex: "-1" },
      this.column,
      this.cards,
    );
    this.jump = h(
      "button",
      { class: "agent-jump", type: "button", hidden: true },
      icon("arrow-down"),
      "Jump to latest",
      // While the agent works below the fold, three dots pulse after the label (D273).
      h(
        "span",
        { class: "agent-jump-dots", "aria-hidden": "true" },
        h("span", null),
        h("span", null),
        h("span", null),
      ),
    );
    this.store.add(
      effect(() => {
        const working = session.status.value !== "idle";
        this.jump.classList.toggle("is-working", working);
        this.jump.setAttribute(
          "aria-label",
          working ? "Jump to latest (working)" : "Jump to latest",
        );
        return undefined;
      }),
    );
    // A chat started in another folder: say so, and offer to go there or carry on here (D126).
    const elsewhere = h("div", { class: "agent-elsewhere", hidden: true });
    let shownFor = "";
    this.store.add(
      effect(() => {
        const folder = session.folder.value;
        const open = host.openFolder.value;
        session.version.value;
        // A multi-root workspace's chat may be stored with its first folder or its file (D251).
        const away = !!folder && session.items.length > 0 && !host.isThisWorkspace(folder);
        elsewhere.hidden = !away;
        if (!away || !folder) {
          shownFor = "";
          return undefined;
        }
        // Built once per folder pair, not on every streamed token (`version` changes then).
        const key = `${folder}\n${open ?? ""}`;
        if (key === shownFor) return undefined;
        shownFor = key;
        // A folder by its name, a workspace file as "x (Workspace)".
        const name = locationLabel(folder);
        // As the wrap-up box's buttons (D345): the suggested one primary, the other secondary.
        const go = h(
          "button",
          { class: "button button-primary button-sm", type: "button" },
          `Open ${name}`,
        );
        const here = h(
          "button",
          { class: "button button-secondary button-sm", type: "button" },
          "Continue here",
        );
        setTooltip(go, `Open ${folder} and continue the chat there`);
        setTooltip(
          here,
          open
            ? `Tie this chat to ${locationLabel(open)}: its tools work on the open folder`
            : "Open a folder first",
        );
        here.toggleAttribute("disabled", !open);
        // A helper's chat works in its worktree (D246): it can't move to the open folder.
        here.hidden = !!helperRootOf(session.id);
        go.addEventListener("click", () =>
          host.run("agent.openChatFolder", { session: session.id }),
        );
        here.addEventListener("click", () =>
          host.run("agent.moveChatHere", { session: session.id }),
        );
        replaceChildren(
          elsewhere,
          icon("folder"),
          h(
            "span",
            { class: "agent-elsewhere-text" },
            "Started in ",
            h("strong", null, name),
            open ? ". Tools work on the open folder." : ".",
          ),
          // Together, at the right: in a narrow panel they wrap as a pair under the text (D166).
          h("div", { class: "agent-elsewhere-actions" }, go, here),
        );
        return undefined;
      }),
    );
    const changes = h("div", { class: "agent-changes", hidden: true });
    // A loop running in this chat (D332): its pace, next check and Stop.
    const loop = this.store.add(new LoopStrip(session.id, host.run));
    // What the chat has working in the background (D326): a chip under the conversation.
    this.bgChip = this.store.add(new BackgroundChip(session.id, host.run, () => this.schedule()));
    this.chapters = this.store.add(new ChapterMenu(session, host.run));
    this.workflows = this.store.add(new WorkflowCards(session.id, host.run));
    // The branch of the worktree the chat works in (D337).
    const worktreeChip = this.store.add(new WorktreeChip(session.id, host.run));
    this.composer = this.store.add(
      new Composer({
        session,
        send: (text) => {
          this.stick = true;
          host.run("agent.send", { session: session.id, message: text });
        },
        stop: () => host.run("agent.stop", { session: session.id }),
        showModelMenu: (a) => host.showModelMenu(session, a),
        showModeMenu: (a) => host.showModeMenu(session, a),
        showMembersEffort: (a) => host.showMembersEffort(session, a),
        autoRunCommands: () => host.autoRunCommands(),
        fullAccess: () => host.fullAccess(),
        modelLabel: () => host.modelLabel(session),
        modelMark: () => host.modelMark(session),
        mention: () => host.run("agent.mention", { session: session.id }),
        slash: () => host.run("agent.slash", { session: session.id }),
        run: (command, input) => host.run(command, input),
        query: (command, input) => host.query(command, input),
        setting: (key) => host.setting(key),
        warn: (message) => host.warn(message),
        transcribe: (recording) => host.transcribe(recording),
        prepareVoice: () => host.prepareVoice(),
        missingAgent: () => host.missingAgent(session),
      }),
    );
    // The details panel (D231): beside the conversation when the tab is wide, else a sheet.
    const details = this.store.add(
      new ChatDetails({
        session,
        host: host.details,
        run: host.run,
        setting: host.setting,
        openFolder: host.openFolder,
        isThisWorkspace: (stored) => host.isThisWorkspace(stored),
        showModelMenu: (anchor) => host.showModelMenu(session, anchor),
      }),
    );
    this.element = h(
      "div",
      // data-os-drop: files dropped here from the system are ours (the explorer leaves them).
      {
        class: "agent-view",
        tabindex: "-1",
        "data-os-drop": "agent",
        // Lets the session tell whether it's on screen (no "needs your answer" toast then).
        "data-session": session.id,
      },
      h(
        "div",
        { class: "agent-main" },
        h(
          "div",
          { class: "agent-header" },
          face,
          roomLink,
          title,
          worktreeChip.element,
          h("span", { class: "diff-spacer" }),
          this.chapters.button,
          fresh,
          freshWith,
          history,
          details.button,
          more,
        ),
        progress,
        elsewhere,
        this.log,
        this.jump,
        loop.element,
        changes,
        this.composer.element,
      ),
      details.element,
    );
    details.attachTo(this.element);
    // Chat text size and code wrapping (agent.textSize, agent.codeBlockWordWrap; D179).
    this.store.add(
      effect(() => {
        const size = host.setting("agent.textSize");
        this.element.dataset.textSize = size === "small" || size === "large" ? size : "default";
        this.element.classList.toggle(
          "is-wrap-code",
          host.setting("agent.codeBlockWordWrap") === true,
        );
        return undefined;
      }),
    );
    // Resting on a screenshot's thumbnail shows it large (D156), like Claude's chat.
    this.store.add(
      new HoverCards(this.element, ".agent-shots-thumb", (thumb) => shotPreview(thumb), {
        delay: 250,
        label: "Screenshot",
      }),
    );
    this.attachDrops(session);
    this.store.add(on(title, "click", () => host.run("agent.showHistory")));
    const roomOf = () => host.room ?? threadRoom(liveRow(session), rooms.peek());
    // + starts this channel's or direct message's conversation over (the old one stays in
    // Sessions…); a thread has none: reply in it, or start another from the channel.
    fresh.hidden = !!session.parent;
    this.store.add(
      on(fresh, "click", () =>
        host.room
          ? host.run("agent.newConversation", { channel: host.room })
          : host.run("agent.newSession"),
      ),
    );
    const freshLabel = host.room ? "New conversation" : "New chat";
    fresh.setAttribute("aria-label", freshLabel);
    setTooltip(fresh, freshLabel);
    this.store.add(
      on(roomLink, "click", () =>
        session.parent
          ? host.run("agent.openThread", { session: session.parent.session })
          : host.run("agent.openChannel", { channel: roomOf() }),
      ),
    );
    // A chat is just a chat (D291): only a thread says where it belongs, "Thread ›" back to the
    // chat it came from. The channel tab (the Inbox's) keeps its own title.
    roomLink.hidden = !!host.room || !session.parent;
    if (host.room) this.element.dataset.room = host.room;
    roomLink.textContent = "Thread ›";
    setTooltip(roomLink, "Back to the chat it came from");
    // A thread: the message it answers, above its replies (Slack's thread panel).
    const parent = session.parent;
    if (parent) {
      const quote = h(
        "button",
        { class: "agent-thread-parent", type: "button" },
        h("span", { class: "agent-thread-parent-author" }, parent.author),
        h("span", { class: "agent-thread-parent-text" }, parent.text),
      );
      setTooltip(quote, "Show it in the conversation");
      this.store.add(
        on(quote, "click", () =>
          host.run("agent.showMessage", { session: parent.session, item: parent.item }),
        ),
      );
      this.log.prepend(quote);
    }
    // A message's replies row follows its threads as they work (D238).
    this.store.add(
      effect(() => {
        threads.value;
        this.schedule();
        return undefined;
      }),
    );
    // Its "2 min ago" stays current between redraws.
    this.store.add(keepTimesCurrent(this.log, relativeAge));
    // "Show it in the conversation" from a thread: this conversation's message, in view.
    this.store.add(
      effect(() => {
        const ask = messageReveal.value;
        if (ask?.session !== session.id || Date.now() - ask.at > REVEAL_WAIT_MS) return undefined;
        this.reveal = { item: ask.item, until: ask.at + REVEAL_WAIT_MS };
        this.schedule();
        return undefined;
      }),
    );
    // Seen while it's on screen (unread, D238).
    this.store.add(
      effect(() => {
        session.version.value;
        session.status.value;
        this.markSeen();
        return undefined;
      }),
    );
    this.store.add(
      on(freshWith, "click", () => {
        const r = freshWith.getBoundingClientRect();
        host.run("agent.newChatMenu", {
          x: Math.round(r.left),
          y: Math.round(r.bottom + 2),
          session: session.id,
        });
      }),
    );
    this.store.add(on(history, "click", () => host.run("agent.showHistory")));
    this.store.add(on(more, "click", () => host.showMoreMenu(session, more)));
    this.store.add(on(this.element, "focusin", () => host.activated(session)));
    this.store.add(
      on(this.log, "scroll", () => {
        // Our own scrolling to the bottom (and the clamp when content shrinks) isn't the reader
        // scrolling away. A scroll up from where we put it, away from the end, is: while a reply
        // streams we scroll every frame, so the reader's scroll always lands in that window and
        // the next frame pulled them back to the end.
        if (
          this.autoScrolling &&
          !(this.log.scrollTop < this.autoTop - 1 && this.distanceToEnd() >= 40)
        )
          return;
        // A hidden tab (another tab of its group in front) has no size: not the reader scrolling.
        // Nor the dock putting the offset back as it shows again: the resize observer settles
        // that (following the end, or back where the reader was).
        if (this.log.clientHeight === 0 || this.wasHidden) return;
        this.stick = this.distanceToEnd() < 40;
        this.readerTop = this.log.scrollTop;
        this.updateJump();
      }),
    );
    this.store.add(
      on(this.jump, "click", () => {
        this.stick = true;
        this.scrollToEnd();
        // Our own scroll is ignored by the scroll handler, so hide the button here.
        this.updateJump();
      }),
    );
    const resize = new ResizeObserver(() => {
      // Hidden behind another tab: keep where the reader was (D370). Chromium drops a hidden
      // box's scroll offset, so it comes back from readerTop when the tab shows again.
      if (this.log.clientHeight === 0) {
        this.wasHidden = true;
        return;
      }
      if (this.stick) this.scrollToEnd();
      else if (this.wasHidden) {
        this.autoScrolling = true;
        this.log.scrollTop = this.readerTop;
        this.autoTop = this.log.scrollTop;
        requestAnimationFrame(() => {
          this.autoScrolling = false;
        });
      }
      this.wasHidden = false;
      this.updateJump();
    });
    resize.observe(this.log);
    this.store.add({ dispose: () => resize.disconnect() });
    this.store.add(
      effect(() => {
        const mode = session.chatMode.value;
        const status = session.status.value;
        const failed = !!session.error.value;
        const name = mode.startsWith("custom:") ? mode.slice("custom:".length) : null;
        // Read always: a group chat's faces come from the agents list too, which reloads when
        // an agent is added or edited (otherwise a member could keep a stand-in face).
        const modes = customModes.value;
        const agent = name ? modes.find((m) => m.name === name && m.agent) : undefined;
        const me = mainAgent.value;
        const spec = agent
          ? faceOf(agent.agent?.icon, agent.name, chatModelKey(session, true))
          : me.face.model !== undefined
            ? { ...me.face, model: chatModelKey(session, true) ?? "" }
            : me.face;
        const label = agent?.agent?.label ?? me.label;
        face.replaceChildren(
          agentFace(spec, {
            // The tab's size (the owner: 20 looked too big beside the breadcrumb).
            size: 16,
            label,
            state:
              status === "waiting"
                ? "waiting"
                : status === "running"
                  ? "working"
                  : failed
                    ? "failed"
                    : "idle",
          }),
        );
        setTooltip(face, agent?.agent?.role ? `${label} · ${agent.agent.role}` : label);
        // A group chat (D231): its agents' faces instead.
        if (session.members.value.length) showGroupFaces(face, session.members.value);
        // The tab shows the same faces (D234).
        this.changed.fire();
        return undefined;
      }),
    );
    this.store.add(
      effect(() => {
        rooms.value;
        mainAgent.value;
        const text = host.room ? roomTitle(host.room) : session.title.value;
        title.textContent = text;
        setTooltip(title, `${text} · Sessions`);
        this.changed.fire();
        return undefined;
      }),
    );
    this.store.add(
      effect(() => {
        progress.hidden = session.status.value === "idle";
        return undefined;
      }),
    );
    this.store.add(
      effect(() => {
        session.version.value;
        session.status.value;
        session.editing.value;
        session.folderRequest.value;
        // Replies' headers show their agents' faces (an agent's icon changed, D270).
        customModes.value;
        mainAgent.value;
        // The empty state names the model (or how to get one): follow the model list too.
        host.modelLabel(session);
        this.schedule();
        return undefined;
      }),
    );
    this.store.add(
      effect(() => {
        session.folderRequest.value;
        return this.renderCards(session.permissions.value);
      }),
    );
    this.store.add(
      effect(() => {
        const files = session.changeset.files.value;
        // Still being gathered (an external agent's turn just ended): shown, not yet actionable.
        const gathering = session.gathering.value;
        changes.hidden = files.length === 0;
        if (files.length) {
          const t = session.changeset.totals();
          const button = (label: string, cls: string, command: string) => {
            const b = h("button", { class: `button ${cls} button-sm`, type: "button" }, label);
            if (gathering) {
              b.setAttribute("disabled", "");
              setTooltip(b, "Gathering the agent's changes: wait a moment, or Stop.");
            }
            b.addEventListener("click", () => host.run(command, { session: session.id }));
            return b;
          };
          replaceChildren(
            changes,
            h(
              "span",
              { class: "agent-changes-text" },
              gathering
                ? `Gathering changes… ${t.files} file${t.files === 1 ? "" : "s"} · `
                : `${t.files} file${t.files === 1 ? "" : "s"} changed · `,
              h("span", { class: "is-added" }, `+${t.added}`),
              " ",
              h("span", { class: "is-removed" }, `−${t.removed}`),
            ),
            h(
              "span",
              { class: "agent-actions" },
              button("Review", "button-ghost", "agent.review"),
              button("Reject all", "button-ghost", "agent.rejectAll"),
              button("Accept all", "button-accent", "agent.acceptAll"),
            ),
          );
        }
        this.schedule();
        return undefined;
      }),
    );
    this.store.add({ dispose: () => cancelAnimationFrame(this.frame) });
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    const items = this.session.items;
    // Each turn's final answer gets the message actions; the newest one keeps them visible.
    const answers = this.itemHost.answers;
    answers.clear();
    let candidate: string | undefined;
    for (const item of items) {
      if (item.type === "user") {
        if (candidate) answers.set(candidate, "older");
        candidate = undefined;
      } else if (item.type === "assistant" && item.text) candidate = item.id;
    }
    if (candidate) answers.set(candidate, "latest");
    const nodes: HTMLElement[] = [];
    const seen = new Set<string>();
    /** An item's element, re-rendered in place only when its signature changes. */
    const element = (item: Item, options: RenderOptions = {}): HTMLElement => {
      const key = `${item.id}|${options.step ? "s" : ""}${options.hideThinking ? "h" : ""}${options.thinkingOnly ? "t" : ""}`;
      seen.add(key);
      const sig = signature(item, this.itemHost, options);
      let entry = this.cache.get(key);
      if (!entry) {
        entry = { el: renderItem(item, this.itemHost, options), sig };
        this.cache.set(key, entry);
      } else if (entry.sig !== sig) {
        // A long reply still streaming is parsed and diffed whole: at most every LONG_EVERY_MS
        // past LONG_STREAM chars (a 10 000-line answer made every frame slower, D163).
        const long = item.type === "assistant" && item.streaming && item.text.length > LONG_STREAM;
        const since = Date.now() - (entry.at ?? 0);
        if (long && since < LONG_EVERY_MS) {
          clearTimeout(this.longTimer);
          this.longTimer = setTimeout(() => this.schedule(), LONG_EVERY_MS - since);
          return entry.el;
        }
        // Update in place: streaming tokens must not recreate rows (hover, clicks, shimmer).
        entry.el = morph(entry.el, renderItem(item, this.itemHost, options)) as HTMLElement;
        entry.sig = sig;
        entry.at = Date.now();
      }
      return entry.el;
    };
    /** A work group's row, cached like items (D151). */
    const rowElement = (row: WorkRow, only: boolean): HTMLElement => {
      const key = `row|${row.id}`;
      seen.add(key);
      const sig = rowSignature(row, this.itemHost, only);
      let entry = this.cache.get(key);
      if (!entry) {
        entry = { el: renderRow(row, this.itemHost, only), sig };
        this.cache.set(key, entry);
      } else if (entry.sig !== sig) {
        entry.el = morph(entry.el, renderRow(row, this.itemHost, only)) as HTMLElement;
        entry.sig = sig;
      }
      return entry.el;
    };
    const running = this.session.status.peek() !== "idle";
    const streamText = this.host.streamText();
    // A loop's quiet checks fold into one line (D332).
    const segments = layoutTurns(collapseQuietTicks(items));
    const lastUser = segments.reduce(
      (at, seg, i) => (seg.kind === "item" && seg.item.type === "user" ? i : at),
      -1,
    );
    const groups = new Set<string>();
    // Only the latest group of the running turn may say "Working…" (earlier ones are done, D159).
    const lastWork = segments.reduce((at, seg, i) => (seg.kind === "work" ? i : at), -1);
    // Each segment's next answer, in one pass from the end (D379: a slice and a find per work
    // group, every frame while a long chat streams).
    const nextAnswer: (Segment | undefined)[] = new Array(segments.length);
    for (let i = segments.length - 1, next: Segment | undefined; i >= 0; i--) {
      nextAnswer[i] = next;
      const seg = segments[i];
      if (seg?.kind === "item" && seg.item.type === "assistant") next = seg;
    }
    segments.forEach((seg, index) => {
      const current = index > lastUser;
      if (seg.kind === "item") {
        const it = seg.item;
        if (it.type === "assistant" && it.streaming && !streamText) {
          // The answer appears when complete; until then the work line (or this one) says so.
          if (!segments.some((x, i) => i > lastUser && x.kind === "work"))
            nodes.push(this.placeholder("Writing the answer"));
          return;
        }
        nodes.push(element(it, { hideThinking: !!seg.hideThinking }));
        return;
      }
      groups.add(seg.id);
      let group = this.groups.get(seg.id);
      if (!group) {
        const id = seg.id;
        group = new WorkGroup(() => {
          if (this.itemHost.expanded.has(id)) this.itemHost.expanded.delete(id);
          else this.itemHost.expanded.add(id);
          this.schedule();
        });
        this.groups.set(seg.id, group);
      }
      const answer = nextAnswer[index];
      const answering =
        answer?.kind === "item" && answer.item.type === "assistant" && answer.item.streaming;
      let activity = workActivity(seg.entries, (t) => toolLabel(t, this.host.relative));
      if (!activity && current && running && index === lastWork)
        activity = answering
          ? streamText
            ? null
            : "Writing the answer"
          : // Waiting on the user (a question card, a permission): not "Working" with a clock.
            this.session.status.peek() === "waiting"
            ? null
            : "Working";
      // Timing: from the first time the group is seen working until it stops.
      let time = this.timing.get(seg.id);
      if (activity && !time) {
        time = { start: Date.now() };
        this.timing.set(seg.id, time);
      } else if (!activity && time && time.end === undefined) time.end = Date.now();
      // Working again (Continue on the same group): the time runs on (D160).
      else if (activity && time?.end !== undefined) delete time.end;
      const open = this.itemHost.expanded.has(seg.id);
      const rows = open ? workRows(seg.entries) : [];
      group.update({
        label: activity ?? workSummary(seg.entries),
        working: activity !== null,
        open,
        // "Thought for 4s" already says how long.
        duration:
          !activity && time?.end !== undefined && seg.entries.some((e) => e.item.type === "tool")
            ? formatDuration(time.end - time.start)
            : null,
        steps: rows.map((r) => rowElement(r, rows.length === 1)),
        shots: seg.entries.flatMap((e) => {
          // A tool's own images show in the gallery instead (D381).
          if (e.kind !== "item" || e.item.type !== "tool" || e.item.media?.length) return [];
          const tool = e.item;
          const { verb, target } = toolLabel(tool, this.host.relative);
          const caption = target ? `${verb} · ${target}` : verb;
          return (tool.images ?? tool.previews ?? []).map((image) => ({ image, caption }));
        }),
      });
      nodes.push(group.el);
      // Images its tools made (D381): the result, so shown under the line even when closed.
      const gallery = this.workGallery(seg.id, seg.entries);
      if (gallery) nodes.push(gallery);
      if (seg.changes.length) nodes.push(this.changeCards(seg.id, seg.changes, seg.turn));
    });
    // Text that stopped growing while the turn runs (the model writes a tool call it doesn't
    // stream, or the provider is slow): a caret alone looks stuck, so the work line shows (D163).
    const tail = segments[segments.length - 1];
    let working: HTMLElement | null = null;
    if (running && streamText && tail?.kind === "item" && tail.item.type === "assistant") {
      const it = tail.item;
      const size = it.text.length + (it.toolDraft?.chars ?? 0);
      if (this.growth?.id !== it.id || this.growth.size !== size)
        this.growth = { id: it.id, size, at: Date.now() };
      const quiet = Date.now() - this.growth.at;
      if (!it.streaming || quiet >= QUIET_MS)
        working = this.placeholder(it.toolDraft ? draftActivity(it.toolDraft) : "Working");
      else {
        clearTimeout(this.quietTimer);
        this.quietTimer = setTimeout(() => this.schedule(), QUIET_MS - quiet + 50);
      }
    }
    // A widget drawn while it's written (D355): where its finished card will be.
    const drawing = running ? streamingWidget(items) : null;
    const drawn =
      drawing &&
      widgetDraftCard(this.itemHost, drawing, {
        session: this.session.id,
        run: (command, input) => this.itemHost.run(command, input),
        openLink: (href) => this.itemHost.openLink(href),
      });
    if (drawn) nodes.push(drawn);
    // Messages sent while it works (D151): under the conversation until the next step reads them.
    const queued = this.session.queued.peek();
    for (const q of queued) nodes.push(this.queuedElement(q));
    // The plan under the latest message (D300), then what it's doing now, as Claude Code's app.
    const plan = this.planCard(items);
    if (plan) nodes.push(plan);
    const workflows = this.workflows.update(items);
    if (workflows) nodes.push(workflows);
    // The latest turn's wrap-up box (D301): its recap, question and buttons, after the plan.
    const wrapUp = this.wrapUpCard(items, running);
    if (wrapUp) nodes.push(wrapUp);
    if (this.bgChip.visible) nodes.push(this.bgChip.element);
    this.chapters.update(items);
    if (working) nodes.push(working);
    for (const id of [...this.queuedEls.keys()])
      if (!queued.some((q) => q.id === id)) this.queuedEls.delete(id);
    for (const id of [...this.groups.keys()])
      if (!groups.has(id)) {
        this.groups.get(id)?.dispose();
        this.groups.delete(id);
        this.galleries.delete(id);
        this.timing.delete(id);
        this.cardCache.delete(id);
        this.changesOpen.delete(id);
      }
    for (const id of [...this.cache.keys()]) if (!seen.has(id)) this.cache.delete(id);
    // Waiting for a folder (D121): the request itself, not the empty-state help, sits above the
    // folder card so the card fits on screen.
    const pending = this.session.folderRequest.peek();
    if (nodes.length === 0)
      nodes.push(
        pending
          ? h(
              "div",
              { class: "agent-msg agent-user-wrap" },
              h(
                "div",
                { class: "agent-user" },
                h("div", { class: "agent-user-text" }, pending.message),
              ),
            )
          : this.host.emptyState(this.session),
      );
    // Only touch the DOM where the list differs (keeps text selection in unchanged messages).
    // Node by node, not replaceChildren: emptying the column for a moment clamped the scroll
    // position to the top (opening a changes card jumped the chat to its start).
    // A node on its way out is removed rather than the next one moved in front of it: a moved
    // frame reloads (a widget drawn while it was written keeps its frame, D355).
    const keep = new Set<Element>(nodes);
    nodes.forEach((node, i) => {
      let at = this.column.children[i];
      while (at && at !== node && !keep.has(at)) {
        at.remove();
        at = this.column.children[i];
      }
      if (at !== node) this.column.insertBefore(node, at ?? null);
    });
    while (this.column.children.length > nodes.length) this.column.lastElementChild?.remove();
    if (this.stick) this.scrollToEnd();
    this.updateJump();
    if (this.reveal) this.showReveal();
  }

  /** The plan card's element, kept so a redraw only changes what changed. */
  private planEl: HTMLElement | null = null;
  private planShown = "";

  /**
   * The agent's plan (D300) under the conversation's latest message, as Claude Code's app shows
   * its own: a step done is checked and dimmed, the step in progress spins, the rest wait. A plan
   * written before the user's latest message says so over it.
   */
  private planCard(items: readonly Item[]): HTMLElement | null {
    const steps = this.session.plan.peek();
    if (!steps.length) return null;
    const before = planBeforeLastMessage(items) && steps.some((s) => s.status !== "done");
    const key = JSON.stringify([before, steps]);
    if (this.planEl && key === this.planShown) return this.planEl;
    this.planShown = key;
    const done = steps.filter((s) => s.status === "done").length;
    this.planEl ??= h("div", { class: "agent-plan", role: "group" });
    this.planEl.setAttribute("aria-label", `Plan, ${done} of ${steps.length} done`);
    replaceChildren(
      this.planEl,
      before
        ? h("div", { class: "agent-plan-before" }, "Plan from before your last message")
        : null,
      h(
        "ol",
        { class: "agent-plan-steps" },
        ...steps.map((s) =>
          h(
            "li",
            { class: `is-${s.status}` },
            s.status === "done"
              ? h("span", { class: "agent-plan-mark" }, icon("check"))
              : s.status === "in_progress"
                ? h("span", {
                    class: "agent-plan-mark agent-plan-spin",
                    "aria-label": "In progress",
                  })
                : h("span", { class: "agent-plan-mark agent-plan-wait" }),
            h("span", { class: "agent-plan-text" }, s.text),
          ),
        ),
      ),
    );
    return this.planEl;
  }

  private wrapUpEl: { key: string; el: HTMLElement | null } | null = null;

  /** The latest turn's wrap-up box (D301), drawn anew only when it or its liveness changes. */
  private wrapUpCard(items: readonly Item[], running: boolean): HTMLElement | null {
    const latest = latestWrapUp(items);
    if (!latest) return null;
    const live = !running;
    const key = JSON.stringify([latest.itemId, live, latest.wrapUp]);
    if (this.wrapUpEl?.key !== key)
      this.wrapUpEl = { key, el: wrapUpBox(latest.wrapUp, this.itemHost, live) };
    return this.wrapUpEl.el;
  }

  /** The message to bring into view (agent.showMessage), until it's shown or it's too late. */
  private reveal: { item: string; until: number } | null = null;
  private revealTimer: ReturnType<typeof setTimeout> | undefined;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Scrolls the message asked for to the middle of the conversation and lights it for a moment.
   * A conversation still loading, or a tab not laid out yet, is tried again shortly.
   */
  private showReveal(): void {
    const want = this.reveal;
    if (!want) return;
    if (Date.now() > want.until) {
      this.reveal = null;
      return;
    }
    const el = this.messageElement(want.item);
    if (!el || !this.log.clientHeight) {
      // A message that's there but not shown on its own (inside a folded work group): stop.
      if (!el && this.session.items.some((i) => i.id === want.item) && this.log.clientHeight) {
        this.reveal = null;
        return;
      }
      clearTimeout(this.revealTimer);
      this.revealTimer = setTimeout(() => this.schedule(), 100);
      return;
    }
    this.reveal = null;
    if (messageReveal.peek()?.item === want.item) messageReveal.value = null;
    // The reader is somewhere else now: new content doesn't pull the conversation to its end.
    this.stick = false;
    const box = this.log.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    // Centered; a message taller than the conversation shows from its start.
    this.log.scrollTop += r.top - box.top - Math.max(0, (box.height - r.height) / 2);
    // Kept here too: the scroll handler skips this scroll when a scroll to the end ran in the
    // same frame, and a tab switch would bring back the old place (D379).
    this.readerTop = this.log.scrollTop;
    this.updateJump();
    // Lit at once, then fading out (DESIGN.md motion tokens: no fade with reduced motion).
    clearTimeout(this.flashTimer);
    for (const lit of this.column.querySelectorAll(".is-revealed"))
      lit.classList.remove("is-revealed", "is-lit");
    el.classList.add("is-revealed", "is-lit");
    this.flashTimer = setTimeout(() => {
      el.classList.remove("is-lit");
      this.flashTimer = setTimeout(() => el.classList.remove("is-revealed"), REVEAL_FADE_MS);
    }, REVEAL_HOLD_MS);
  }

  /** A message's element in the conversation, as rendered now. */
  private messageElement(item: string): HTMLElement | null {
    for (const [key, entry] of this.cache)
      if (key.startsWith(`${item}|`) && entry.el.parentElement === this.column) return entry.el;
    return null;
  }

  private autoScrolling = false;
  /** Where our own scroll left the log (a reader's scroll up from it is theirs). */
  private autoTop = 0;
  private readonly groups = new Map<string, WorkGroup>();
  /** Each work group's image gallery and what it shows (rebuilt only when that changes). */
  private readonly galleries = new Map<string, { key: string; el: HTMLElement | null }>();
  private readonly timing = new Map<string, { start: number; end?: number }>();
  private readonly cardCache = new Map<string, { el: HTMLElement; sig: string }>();
  private placeholderEl: HTMLElement | null = null;
  private readonly queuedEls = new Map<string, HTMLElement>();

  /** A message waiting for the agent's next step: your bubble, quieter, Send now and Take back. */
  private queuedElement(q: QueuedMessage): HTMLElement {
    let el = this.queuedEls.get(q.id);
    if (el) return el;
    const back = h("button", { class: "agent-queued-back", type: "button" }, "Take back");
    on(back, "click", () =>
      this.itemHost.run("agent.unqueue", { session: this.session.id, id: q.id }),
    );
    // Send now (D363): not for one that waits for another member's round anyway.
    const now =
      this.session.canSendNow() && !this.waitsForOtherMember(q.text)
        ? h("button", { class: "agent-queued-now", type: "button" }, "Send now")
        : null;
    if (now)
      on(now, "click", () => {
        now.setAttribute("disabled", "");
        this.itemHost.run("agent.sendNow", { session: this.session.id });
      });
    el = h(
      "div",
      { class: "agent-msg agent-user-wrap is-queued", "data-key": q.id },
      h("div", { class: "agent-user" }, h("div", { class: "agent-user-text" }, q.text)),
      h("div", { class: "agent-queued-note" }, h("span", null, this.queuedNote(q.text)), now, back),
    );
    this.queuedEls.set(q.id, el);
    return el;
  }

  /** What happens to a message sent while the agent works (D151, D243). */
  private queuedNote(text: string): string {
    if (!this.session.joinsTurn()) return "Sends as soon as the agent finishes what it's doing";
    // A group chat: one that calls on another agent starts that agent's turn afterwards.
    const other = this.waitsForOtherMember(text);
    if (other) return `${memberInfo(other).label} answers when this turn ends`;
    return "The agent reads this at its next step";
  }

  /** In a group chat, the other member a message calls on (it waits for that one's round). */
  private waitsForOtherMember(text: string): string | undefined {
    if (!this.session.members.peek().length) return undefined;
    const speaker = this.session.turnSpeaker;
    return findMentions(text, knownAgents()).find((n) => n !== speaker);
  }

  /** The last streaming reply's size and when it last grew (D163). */
  private growth: { id: string; size: number; at: number } | undefined;
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  private longTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * The images a work group's tools made (D381), and a placeholder for each one being made; kept
   * while they stay the same.
   */
  private workGallery(id: string, entries: readonly WorkEntry[]): HTMLElement | null {
    const tools = entries.flatMap((e) =>
      e.kind === "item" && e.item.type === "tool" ? [e.item] : [],
    );
    const media = tools.flatMap((t) => t.media ?? []);
    const pending = tools.flatMap(pendingImages);
    const key = galleryKey(media, pending);
    const cached = this.galleries.get(id);
    if (cached?.key === key) return cached.el;
    const el = chatImageGallery(this.session.id, media, pending);
    this.galleries.set(id, { key, el });
    return el;
  }

  private placeholder(text: string): HTMLElement {
    this.placeholderEl ??= h("div", { class: "agent-thought is-shimmer" });
    this.placeholderEl.textContent = `${text}…`;
    return this.placeholderEl;
  }

  /** Changes cards open / closed as the user left them (D154). */
  private readonly changesOpen = new Map<string, boolean>();

  /** A work group's file changes as one card (D154). */
  private changeCards(id: string, paths: readonly string[], turn?: number): HTMLElement {
    const host = {
      turn,
      session: this.session,
      root: () => this.host.root(),
      relative: (path: string) => this.host.relative(path),
      run: (command: string, input?: unknown) => this.itemHost.run(command, input),
      opened: this.changesOpen,
      rerender: () => this.schedule(),
    };
    const sig = changesSignature(id, paths, host);
    let entry = this.cardCache.get(id);
    if (!entry || entry.sig !== sig) {
      // Replaced, not morphed: morphing keeps the first render's click handlers, whose list of
      // files was stale ("Accept all" accepted only the files known then, D160).
      entry = { el: renderChanges(id, paths, host), sig };
      this.cardCache.set(id, entry);
    }
    return entry.el;
  }

  /**
   * Dropping onto the chat attaches (D131): files from the system's file manager (Tauri's drop
   * events, read through Rust), files dragged from the explorer, and files the webview itself
   * receives (a browser drag). The composer shows a dashed outline while something is over it.
   */
  private attachDrops(session: AgentSession): void {
    const over = (on: boolean) => this.composer.element.classList.toggle("is-drop-over", on);
    const inside = (x: number, y: number) => {
      if (!this.element.offsetParent) return false;
      const r = this.element.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    void dragDropIpc
      .listen((e) => {
        if (e.kind === "leave" || !inside(e.x, e.y)) return over(false);
        if (e.kind === "over") return over(true);
        over(false);
        this.host.run("agent.attachDropped", { session: session.id });
      })
      .then((d) => {
        if (this.store.isDisposed) d.dispose();
        else this.store.add(d);
      });
    this.store.add(
      this.host.fileDropTarget(this.element, (path) =>
        this.host.run("agent.addContext", { paths: [path], session: session.id }),
      ),
    );
    this.store.add(
      on(this.element, "dragover", (e) => {
        if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
        e.preventDefault();
        over(true);
      }),
    );
    this.store.add(
      on(this.element, "dragleave", (e) => {
        if (!this.element.contains(e.relatedTarget as Node | null)) over(false);
      }),
    );
    this.store.add(
      on(this.element, "drop", (e) => {
        const files = [...(e.dataTransfer?.files ?? [])];
        over(false);
        if (!files.length) return;
        e.preventDefault();
        void this.composer.addFiles(files);
      }),
    );
  }

  private distanceToEnd(): number {
    return this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight;
  }

  private scrollToEnd(): void {
    this.autoScrolling = true;
    this.log.scrollTop = this.log.scrollHeight;
    this.autoTop = this.log.scrollTop;
    requestAnimationFrame(() => {
      this.autoScrolling = false;
    });
  }

  /** "Jump to latest" only when there is more below and the reader isn't following the end. */
  private updateJump(): void {
    const scrollable =
      this.log.clientHeight > 0 && this.log.scrollHeight > this.log.clientHeight + 4;
    if (!scrollable && this.log.clientHeight > 0) this.stick = true;
    this.jump.hidden = !scrollable || this.stick || this.distanceToEnd() < 40;
  }

  private renderCards(requests: readonly PermissionRequest[]): undefined {
    const folder = this.session.folderRequest.peek();
    replaceChildren(
      this.cards,
      ...(folder ? [folderCard(this.session.id, folder, this.host)] : []),
      ...requests.map((r, i) => permissionCard(r, i === 0 && !folder)),
    );
    // A folder card always comes into view (it's the next step); permission cards when following.
    if (folder || (requests.length && this.stick)) {
      this.stick = true;
      requestAnimationFrame(() => requestAnimationFrame(() => this.scrollToEnd()));
    }
    return undefined;
  }

  title(): string {
    return this.host.room ? roomTitle(this.host.room) : this.session.title.peek();
  }

  focus(): void {
    this.composer.focus();
    this.host.activated(this.session);
  }

  onShow(): void {
    this.schedule();
    this.markSeen();
    refreshTimes(this.log);
  }

  /** Tells the host the conversation is seen, when it's on screen (at most once a second). */
  private seenTimer: ReturnType<typeof setTimeout> | undefined;
  private markSeen(): void {
    if (this.seenTimer !== undefined) return;
    this.seenTimer = setTimeout(() => {
      this.seenTimer = undefined;
      if (
        this.element.isConnected &&
        !this.element.hidden &&
        document.visibilityState === "visible"
      )
        this.host.seen?.(this.session);
    }, 1000);
  }

  serialize(): Json {
    return this.host.room ? { room: this.host.room } : { session: this.session.id };
  }

  dispose(): void {
    clearTimeout(this.seenTimer);
    clearTimeout(this.quietTimer);
    clearTimeout(this.longTimer);
    clearTimeout(this.revealTimer);
    clearTimeout(this.flashTimer);
    for (const g of this.groups.values()) g.dispose();
    disposeWidgetCards(this.itemHost);
    this.store.dispose();
  }
}
