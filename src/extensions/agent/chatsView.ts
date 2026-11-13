// The Chats sidebar view (D291, the plain chat panel), laid out as chat apps' side bars: a search
// field, the pages as rows (New chat, Usage, Customize; Agents is in Customize, D406), then the chats by folder:
// this folder's first, then each other folder's saved chats under its name, newest first. A row
// shows who's in it (an agent's face, or a group's), its age, and whether it's working or waiting
// for you. A click opens it in the chat panel. Who answers is picked in the composer, and
// @mentions bring other agents into a chat. D377: Ctrl/Cmd+click and Shift+click select several,
// as in the explorer (Delete, Archive or Open them together from the right-click menu, Delete
// and Escape keys too); rows drag onto the dock to open where they're dropped.

import { forkOrder } from "../../core/agent/forks";
import { MAIN_MEMBER } from "../../core/agent/groupChat";
import { relativeAge, shortAge, type ThreadRow } from "../../core/agent/rooms";
import { allGroups } from "../../core/dock/tree";
import { h, on } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { basename } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { agentFace, faceGroup } from "../../ui/AgentFace";
import { keepFocus } from "../../ui/focusKeep";
import { type IconName, icon } from "../../ui/Icon";
import { type MenuItem, showContextMenu } from "../../ui/Menu";
import { keepTimesCurrent, timeAttrs } from "../../ui/relativeTimes";
import { setTooltip } from "../../ui/Tooltip";
import type { WorkbenchServices } from "../../workbench/services";
import type { ViewInstance } from "../../workbench/views";
import { customizeSections } from "./customize";
import { customModes } from "./customModes";
import { knownAgents, memberInfo } from "./groupChat";
import { mainAgent } from "./mainAgent";
import { type OtherChat, otherChats, threads } from "./threadList";
import { ROOM_VIEW, THREAD_VIEW } from "./threadTabs";

/** About how many chats show unfolded: folders further down start folded (none are hidden). */
const OPEN_CHATS = 20;
/** Forks deeper than this are indented no further (the row keeps room for its title). */
const MAX_FORK_INDENT = 4;
/** A fork's row (D422): how deep it sits, and its indent (CSS), no deeper than MAX_FORK_INDENT. */
const forkAttrs = (depth: number): Record<string, string> =>
  depth > 0
    ? {
        "data-fork-depth": String(depth),
        "data-fork-indent": String(Math.min(depth, MAX_FORK_INDENT)),
      }
    : {};
/** A fork's place in the tree: an elbow from the chat above it. */
const forkElbow = (depth: number): HTMLElement | null =>
  depth > 0 ? h("span", { class: "ch-fork-elbow", "aria-hidden": "true" }) : null;
/** The Pinned and Archived sections' keys in `folded` (no folder's path starts with a NUL). */
const PINNED = "\0pinned";
const ARCHIVED = "\0archived";

/** The one changed last first. */
const byAge = (a: { updated: number }, b: { updated: number }) => b.updated - a.updated;

export class ChatsView implements ViewInstance {
  private readonly store = new DisposableStore();
  private readonly body = h("nav", { class: "ch-body", "aria-label": "Chats", tabindex: "-1" });
  private readonly search: HTMLInputElement;
  /** Folders you folded (true) or unfolded (false), by path, for the window; the rest fold by
   * default once OPEN_CHATS chats show above them. */
  private static folded = new Map<string, boolean>();
  /** The sections drawn last (Collapse all / Expand all). */
  private sections: string[] = [];
  private frame = 0;
  private drawn = false;

  private renderSoon(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /** Chats selected together (D377), and where a Shift+click range starts. */
  private readonly selected = new Set<string>();
  private anchor: string | null = null;

  constructor(
    host: HTMLElement,
    private readonly services: WorkbenchServices,
  ) {
    this.search = h("input", {
      class: "input ch-search",
      type: "search",
      placeholder: "Search chats",
      "aria-label": "Search chats",
    }) as HTMLInputElement;
    // The pages are rows; the title bar keeps ⋯ (Sessions… and the rest).
    const newChat = this.action("plus", "New chat", "agent.newSession");
    // Right-click New chat: where it opens, or who it's with.
    this.store.add(
      on(newChat, "contextmenu", (e) => {
        const m = e as MouseEvent;
        m.preventDefault();
        showContextMenu(m.clientX, m.clientY, [
          { label: "New chat", icon: "plus", run: () => this.run("agent.newSession") },
          {
            label: "Open to the side",
            icon: "columns-2",
            run: () => this.run("agent.newSession", { side: true }),
          },
          {
            label: "Open in new tab",
            icon: "plus",
            run: () => this.run("agent.newSession", { newTab: true }),
          },
          ...knownAgents().map((a, i) => ({
            label: `New chat with ${a.label}`,
            iconElement: () => agentFace(a.face, { size: 16 }),
            ...(i === 0 && { separatorBefore: true }),
            run: () => this.run("agent.chatWith", { agent: a.name }),
          })),
          {
            label: "New group chat…",
            icon: "users",
            separatorBefore: true,
            run: () => this.run("agent.newGroupChat"),
          },
        ]);
      }),
    );
    // Right-click Usage: Open; Customize: Open, then each of its tabs (D409).
    const usage = this.action("chart-column", "Usage", "agent.showUsage");
    this.store.add(
      on(usage, "contextmenu", (e) => {
        const m = e as MouseEvent;
        m.preventDefault();
        showContextMenu(m.clientX, m.clientY, [
          { label: "Open", icon: "chart-column", run: () => this.run("agent.showUsage") },
        ]);
      }),
    );
    const customize = this.action("sliders-horizontal", "Customize", "agent.customize");
    this.store.add(
      on(customize, "contextmenu", (e) => {
        const m = e as MouseEvent;
        m.preventDefault();
        showContextMenu(m.clientX, m.clientY, [
          { label: "Open", icon: "sliders-horizontal", run: () => this.run("agent.customize") },
          ...customizeSections().map((section, i) => ({
            label: section.label,
            icon: section.icon,
            ...(i === 0 && { separatorBefore: true }),
            run: () => this.run("agent.customize", { section: section.id }),
          })),
        ]);
      }),
    );
    const actions = h(
      "div",
      { class: "ch-actions", role: "group", "aria-label": "Chat pages" },
      newChat,
      usage,
      customize,
    );
    host.append(
      h(
        "div",
        { class: "ch-view" },
        h("div", { class: "ch-top" }, this.search),
        actions,
        this.body,
      ),
    );
    this.store.add(on(this.search, "input", () => this.renderSoon()));
    this.store.add({ dispose: () => cancelAnimationFrame(this.frame) });
    this.store.add(
      on(this.search, "keydown", (e) => {
        if ((e as KeyboardEvent).key !== "Escape" || !this.search.value) return;
        this.search.value = "";
        this.render();
      }),
    );
    // Selected chats (D377): Escape lets go, Delete deletes them.
    this.store.add(
      on(this.body, "keydown", (e) => {
        const key = (e as KeyboardEvent).key;
        if (key === "Escape" && this.selected.size) {
          this.clearSelection();
          e.preventDefault();
        } else if (key === "Delete" && this.selected.size) {
          this.deleteSelected();
          e.preventDefault();
        }
      }),
    );
    // The ages ("5 min") stay current between redraws.
    this.store.add(keepTimesCurrent(this.body, shortAge));
    this.store.add(
      effect(() => {
        threads.value;
        otherChats.value;
        mainAgent.value;
        customModes.value;
        services.workspace.root.value;
        // Which chats are on screen (their rows are selected).
        services.dock.root.value;
        // Once at once, then at most once a frame (D379): every tab change and every chat's
        // update rebuilt every row.
        if (this.drawn) this.renderSoon();
        else {
          this.drawn = true;
          this.render();
        }
        return undefined;
      }),
    );
  }

  private run(command: string, input: unknown = {}): void {
    void this.services.dispatcher.execute(command, input).catch(() => {});
  }

  /** A row at the top: it runs a command. */
  private action(glyph: IconName, label: string, command: string): HTMLElement {
    const row = h(
      "button",
      { class: "ch-row ch-action", type: "button", "data-command": command },
      h("span", { class: "ch-row-lead" }, icon(glyph)),
      h("span", { class: "ch-row-label" }, label),
    );
    this.store.add(on(row, "click", () => this.run(command)));
    return row;
  }

  /** The chats on screen now: the front tab of each group that shows one. */
  private onScreen(): Set<string> {
    const out = new Set<string>();
    for (const g of allGroups(this.services.dock.root.peek())) {
      const tab = g.tabs.find((t) => t.id === g.activeTabId);
      const session = (tab?.viewState as { session?: string } | null)?.session;
      // The chat tab, or a channel tab saved before D291 (it shows a chat too).
      if ((tab?.viewType === THREAD_VIEW || tab?.viewType === ROOM_VIEW) && session)
        out.add(session);
    }
    return out;
  }

  private render(): void {
    const query = this.search.value.trim().toLowerCase();
    const matches = (...texts: string[]) =>
      !query || texts.some((t) => t.toLowerCase().includes(query));
    // Conversations, not replies in a thread (those open from their message).
    const conversations = threads
      .peek()
      .filter((r) => !r.parent && matches(r.title, r.first ?? "", r.last ?? ""));
    // Pinned and archived chats have sections of their own (every folder's).
    const mine = conversations.filter((r) => !r.archived && !r.pinned).sort(byAge);
    const others = [...otherChats.peek()].filter((o) => matches(o.title)).sort(byAge);
    const visible = this.onScreen();
    // A thread (replies to a message) isn't listed: what it's doing shows on its chat's row.
    const threadState = new Map<string, { waiting: boolean; running: boolean; unread: boolean }>();
    for (const t of threads.peek()) {
      const parent = t.parent?.session;
      if (!parent) continue;
      const s = threadState.get(parent) ?? { waiting: false, running: false, unread: false };
      threadState.set(parent, {
        waiting: s.waiting || !!t.waiting,
        running: s.running || !!t.running,
        unread: s.unread || !!t.unread,
      });
    }
    const withThreads = (r: ThreadRow): ThreadRow => {
      const s = threadState.get(r.id);
      return s
        ? {
            ...r,
            waiting: !!r.waiting || s.waiting,
            running: !!r.running || s.running,
            unread: !!r.unread || s.unread,
          }
        : r;
    };
    const nodes: HTMLElement[] = [];
    this.sections = [];
    /** Chats in unfolded folders so far. */
    let open = 0;
    // Rows for the chats `keep` takes, this folder's and others', the one changed last first.
    // Forks under their chats here too (D422), when both are in the section.
    const gathered = (keep: (c: { pinned?: boolean; archived?: boolean }) => boolean) =>
      forkOrder(
        [
          ...conversations.filter(keep).map((r) => ({
            id: r.id,
            ...(r.forkOf && { forkOf: r.forkOf }),
            updated: r.updated,
            row: (depth: number) => this.chatRow(withThreads(r), visible.has(r.id), depth),
          })),
          ...others.filter(keep).map((o) => ({
            id: o.id,
            ...(o.forkOf && { forkOf: o.forkOf }),
            updated: o.updated,
            row: (depth: number) => this.otherRow(o, visible.has(o.id), depth),
          })),
        ].sort(byAge),
      ).map(({ row, depth }) => row.row(depth));
    // Pinned chats, every folder's, first.
    const pinned = gathered((c) => !!c.pinned && !c.archived);
    if (pinned.length) {
      const folded = ChatsView.folded.get(PINNED) ?? false;
      if (!folded) open += pinned.length;
      nodes.push(
        this.gatheredSection(PINNED, "Pinned", pinned, folded, "Pinned chats, every folder's"),
      );
    }
    const root = this.services.workspace.root.peek();
    // This folder's chats, all of them (only folding a folder hides any); with no folder open,
    // the chats started without one (D164).
    if (root || mine.length) {
      // A fork sits under the chat it came from (D422), forks of forks under those.
      const rows = forkOrder(mine).map(({ row, depth }) =>
        this.chatRow(withThreads(row), visible.has(row.id), depth),
      );
      if (!rows.length)
        rows.push(h("div", { class: "ch-empty" }, query ? "No chats match." : "No chats yet."));
      const folded = ChatsView.folded.get(root ?? "") ?? false;
      if (!folded) open += mine.length;
      nodes.push(
        this.folder(
          root ?? "",
          rows,
          mine.map((r) => r.id),
          true,
          folded,
          root ? undefined : "No folder",
        ),
      );
    }
    // Other folders, each under its name, the one changed last first.
    const byFolder = new Map<string, OtherChat[]>();
    for (const o of others) {
      if (o.archived || o.pinned) continue;
      const list = byFolder.get(o.workspace) ?? [];
      list.push(o);
      byFolder.set(o.workspace, list);
    }
    for (const [folder, list] of byFolder) {
      // Past the first OPEN_CHATS, a folder starts folded, unless searching or one of its chats
      // is on screen.
      const folded =
        ChatsView.folded.get(folder) ??
        (!query && open >= OPEN_CHATS && !list.some((o) => visible.has(o.id)));
      if (!folded) open += list.length;
      // Forks under their chats here too (D422).
      const ordered = forkOrder(list);
      nodes.push(
        this.folder(
          folder,
          ordered.map(({ row, depth }) => this.otherRow(row, visible.has(row.id), depth)),
          ordered.map(({ row }) => row.id),
          false,
          folded,
        ),
      );
    }
    // Archived chats, every folder's, last and folded until opened.
    const archived = gathered((c) => !!c.archived);
    if (archived.length)
      nodes.push(
        this.gatheredSection(
          ARCHIVED,
          `Archived (${archived.length})`,
          archived,
          ChatsView.folded.get(ARCHIVED) ?? !query,
          "Archived chats (right-click one to unarchive it)",
        ),
      );
    if (!nodes.length)
      nodes.push(h("div", { class: "ch-empty" }, query ? "No chats match." : "No chats yet."));
    // Agents' work redraws the list: the row that had focus keeps it (D244).
    keepFocus(this.body, () => this.body.replaceChildren(...nodes));
    // A selected chat that's gone (deleted, filtered out) leaves the selection.
    const shown = new Set(this.rowIds());
    for (const id of [...this.selected]) if (!shown.has(id)) this.selected.delete(id);
    this.paintSelection();
  }

  /** The chats' ids in the order they're listed (each once). */
  private rowIds(): string[] {
    const ids = [...this.body.querySelectorAll<HTMLElement>(".ch-recent[data-session]")].map(
      (r) => r.dataset.session ?? "",
    );
    return [...new Set(ids.filter(Boolean))];
  }

  private paintSelection(): void {
    for (const row of this.body.querySelectorAll<HTMLElement>(".ch-recent[data-session]")) {
      const on = this.selected.has(row.dataset.session ?? "");
      row.classList.toggle("is-selected", on);
      row.setAttribute("aria-selected", String(on));
    }
  }

  /** Ctrl/Cmd+click: in or out of the selection (the chat open now counts as picked first). */
  private toggle(id: string): void {
    if (!this.selected.size) {
      const current =
        this.body.querySelector<HTMLElement>(".ch-recent.is-current")?.dataset.session;
      if (current && current !== id) this.selected.add(current);
    }
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.anchor = id;
    this.paintSelection();
  }

  /** Shift+click: everything listed from the anchor to `id`. */
  private selectRange(id: string): void {
    const ids = this.rowIds();
    const from =
      this.anchor ?? this.body.querySelector<HTMLElement>(".ch-recent.is-current")?.dataset.session;
    const a = from ? ids.indexOf(from) : -1;
    const b = ids.indexOf(id);
    this.selected.clear();
    if (a < 0 || b < 0) this.selected.add(id);
    else for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) this.selected.add(x);
    this.paintSelection();
  }

  private clearSelection(): void {
    if (!this.selected.size) return;
    this.selected.clear();
    this.paintSelection();
  }

  /** Deletes the selected chats, asked once. */
  private deleteSelected(): void {
    const ids = [...this.selected];
    if (!ids.length) return;
    if (ids.length === 1) this.run("agent.deleteSession", { session: ids[0] });
    else this.run("agent.deleteSessions", { sessions: ids });
  }

  /** What dragging these chats onto the dock does: an open one's tab moves, the others open. */
  private dragItems(ids: string[]): ({ tabId: string } | { viewType: string; state: unknown })[] {
    const tabs = this.services.dock.tabs(THREAD_VIEW);
    return ids.map((session) => {
      const open = tabs.find(
        (t) => (t.viewState as { session?: string } | null)?.session === session,
      );
      return open ? { tabId: open.id } : { viewType: THREAD_VIEW, state: { session } };
    });
  }

  /** A section's name, which folds it (the whole row). */
  private sectionToggle(key: string, name: string, folded: boolean): HTMLElement {
    this.sections.push(key);
    const toggle = h(
      "button",
      { class: "ch-section-toggle", type: "button", "aria-expanded": String(!folded) },
      h("span", null, name),
      icon(folded ? "chevron-right" : "chevron-down"),
    );
    toggle.addEventListener("click", () => {
      ChatsView.folded.set(key, !folded);
      this.render();
    });
    return toggle;
  }

  /**
   * A folder's section: its name (folds), then its chats. Hovering it shows + (a new chat in that
   * folder); right-click its name for the folder's menu.
   */
  private folder(
    path: string,
    rows: HTMLElement[],
    ids: readonly string[],
    here: boolean,
    folded: boolean,
    label?: string,
  ): HTMLElement {
    const name = label ?? (basename(path) || path);
    const toggle = this.sectionToggle(path, name, folded);
    const newChat = () => {
      if (here) this.run("agent.newSession");
      // Another folder's: it opens as the workspace first (as its chats do, agent.openChatFolder).
      else
        void this.services.dispatcher
          .execute("workspace.openFolder", { path })
          .then(() => this.services.dispatcher.execute("agent.newSession", {}))
          .catch(() => {});
    };
    const add = h(
      "button",
      { class: "icon-button ch-section-add", type: "button", "aria-label": `New chat in ${name}` },
      icon("plus"),
    );
    setTooltip(add, here ? "New chat" : `New chat in ${name} (opens the folder)`);
    add.addEventListener("click", newChat);
    const head = h("div", { class: "ch-section-head" }, toggle, add);
    // On the row, not the name: beside the name it covered the + button.
    setTooltip(
      head,
      label ? "Chats started with no folder open" : here ? `${path} (this folder)` : path,
      undefined,
      { placement: "right", ariaLabel: false },
    );
    head.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const items: MenuItem[] = [
        { label: here ? "New chat" : "New chat (opens the folder)", icon: "plus", run: newChat },
      ];
      if (!here && path)
        items.push({
          label: "Open folder",
          icon: "folder-open",
          run: () => this.run("workspace.openFolder", { path }),
        });
      items.push(
        {
          label: "Collapse all",
          icon: "list-collapse",
          separatorBefore: true,
          run: () => this.foldAll(true),
        },
        { label: "Expand all", icon: "list-chevrons-up-down", run: () => this.foldAll(false) },
      );
      if (ids.length)
        items.push({
          label: `Archive all (${ids.length})`,
          icon: "archive",
          separatorBefore: true,
          run: () => {
            for (const id of ids) this.run("agent.archiveSession", { session: id, archived: true });
          },
        });
      showContextMenu(e.clientX, e.clientY, items);
    });
    return h(
      "div",
      { class: "ch-section ch-folder", "data-folder": here ? "here" : "other", role: "group" },
      head,
      folded ? null : h("div", { class: "ch-section-rows" }, ...rows),
    );
  }

  /** Pinned or archived chats, every folder's, under a name that folds them. */
  private gatheredSection(
    key: string,
    name: string,
    rows: HTMLElement[],
    folded: boolean,
    tip: string,
  ): HTMLElement {
    const head = h("div", { class: "ch-section-head" }, this.sectionToggle(key, name, folded));
    setTooltip(head, tip, undefined, { placement: "right", ariaLabel: false });
    return h(
      "div",
      { class: "ch-section ch-folder", "data-folder": key.slice(1), role: "group" },
      head,
      folded ? null : h("div", { class: "ch-section-rows" }, ...rows),
    );
  }

  private foldAll(folded: boolean): void {
    for (const key of this.sections) ChatsView.folded.set(key, folded);
    this.render();
  }

  /** Who's in a chat: its agent's face, or a group's faces. */
  private lead(r: Pick<ThreadRow, "members" | "speaker" | "usedModel">): Element {
    const members = r.members ?? [];
    if (members.length > 1)
      return faceGroup(
        members.map((m) => memberInfo(m).face),
        16,
      );
    const face = memberInfo(members[0] ?? r.speaker ?? MAIN_MEMBER).face;
    // A face that shows its model's logo: the model this chat used, not today's default (D364).
    return agentFace(
      face.model !== undefined && r.usedModel ? { ...face, model: r.usedModel } : face,
      {
        size: 16,
      },
    );
  }

  private chatRow(r: ThreadRow, current: boolean, depth = 0): HTMLElement {
    const busy = !!r.running && !r.waiting;
    const who = (r.members?.length ? r.members : [r.speaker ?? MAIN_MEMBER])
      .map((m) => memberInfo(m).label)
      .join(", ");
    const row = h(
      "button",
      {
        class: {
          "ch-row": true,
          "ch-recent": true,
          "is-current": current,
          "is-busy": busy,
          "has-news": !!r.unread || !!r.waiting,
          "is-fork": depth > 0,
        },
        type: "button",
        "data-session": r.id,
        ...forkAttrs(depth),
      },
      forkElbow(depth),
      h("span", { class: "ch-row-lead" }, this.lead(r)),
      h("span", { class: "ch-row-label" }, r.title),
      r.waiting
        ? h("span", { class: "ch-badge", "aria-label": "Needs you" }, "1")
        : busy
          ? h("span", { class: "ch-row-working", "aria-label": "Working" })
          : r.updated
            ? h("span", { class: "ch-row-detail", ...timeAttrs(r.updated) }, shortAge(r.updated))
            : h("span", { class: "ch-row-detail" }),
    );
    setTooltip(
      row,
      [
        r.title,
        depth > 0 ? "A fork of the chat above it" : "",
        // Where it stands: the agent's last wrap-up (D301).
        r.recap ?? "",
        `${who}${r.waiting ? " · needs you" : busy ? " · working" : ""}`,
        r.updated ? relativeAge(r.updated) : "",
      ]
        .filter(Boolean)
        .join("\n"),
      undefined,
      { placement: "right" },
    );
    this.wire(row, r.id, r);
    return row;
  }

  /** Another folder's chat: it opens here, offering its folder (agent.openChatFolder). */
  private otherRow(o: OtherChat, current: boolean, depth = 0): HTMLElement {
    const row = h(
      "button",
      {
        class: { "ch-row": true, "ch-recent": true, "is-current": current, "is-fork": depth > 0 },
        type: "button",
        "data-session": o.id,
        ...forkAttrs(depth),
      },
      forkElbow(depth),
      h("span", { class: "ch-row-lead" }, this.lead(o)),
      h("span", { class: "ch-row-label" }, o.title),
      o.updated
        ? h("span", { class: "ch-row-detail", ...timeAttrs(o.updated) }, shortAge(o.updated))
        : h("span", { class: "ch-row-detail" }),
    );
    const who = (o.members?.length ? o.members : [o.speaker])
      .map((m) => memberInfo(m).label)
      .join(", ");
    setTooltip(
      row,
      [
        o.title,
        who,
        `In ${basename(o.workspace)} (${o.workspace})`,
        o.updated ? relativeAge(o.updated) : "",
      ]
        .filter(Boolean)
        .join("\n"),
      undefined,
      { placement: "right" },
    );
    this.wire(row, o.id, o);
    return row;
  }

  /**
   * A click opens the chat; Ctrl/Cmd+click and Shift+click select (D377); the middle button opens
   * a tab of its own; dragged onto the dock it opens there; right-click a menu.
   */
  private wire(
    row: HTMLElement,
    id: string,
    state: { pinned?: boolean; archived?: boolean },
  ): void {
    const open = (how: { newTab?: boolean; side?: boolean } = {}) =>
      this.run("agent.openThread", { session: id, ...how });
    row.setAttribute("aria-selected", String(this.selected.has(id)));
    row.classList.toggle("is-selected", this.selected.has(id));
    row.addEventListener("click", (e) => {
      if (e.shiftKey) return this.selectRange(id);
      if (e.ctrlKey || e.metaKey) return this.toggle(id);
      this.clearSelection();
      this.anchor = id;
      open();
    });
    row.addEventListener("auxclick", (e) => {
      if (e.button === 1) open({ newTab: true });
    });
    // Onto the dock (D377): the selection when this row is part of it, else this chat.
    row.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey) return;
      const ids = this.selected.has(id) ? [...this.selected] : [id];
      const title = row.querySelector(".ch-row-label")?.textContent ?? "Chat";
      this.services.dragViews(
        e,
        row,
        this.dragItems(ids),
        ids.length > 1 ? `${ids.length} chats` : title,
      );
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      // Right-click in a selection of several: what to do with all of them.
      if (this.selected.size > 1 && this.selected.has(id)) {
        const ids = [...this.selected];
        showContextMenu(e.clientX, e.clientY, [
          {
            label: `Open ${ids.length} chats`,
            icon: "message-square",
            run: () => {
              for (const s of ids) this.run("agent.openThread", { session: s, newTab: true });
            },
          },
          {
            label: `Archive ${ids.length} chats`,
            icon: "archive",
            separatorBefore: true,
            run: () => {
              for (const s of ids) this.run("agent.archiveSession", { session: s, archived: true });
              this.clearSelection();
            },
          },
          {
            label: `Delete ${ids.length} chats…`,
            icon: "trash-2",
            destructive: true,
            run: () => this.deleteSelected(),
          },
          { label: "Clear selection", separatorBefore: true, run: () => this.clearSelection() },
        ]);
        return;
      }
      const items: MenuItem[] = [
        { label: "Open", icon: "message-square", run: () => open() },
        { label: "Open to the side", icon: "columns-2", run: () => open({ side: true }) },
        { label: "Open in new tab", icon: "plus", run: () => open({ newTab: true }) },
      ];
      if (!state.archived)
        items.push({
          label: state.pinned ? "Unpin" : "Pin",
          icon: state.pinned ? "pin-off" : "pin",
          separatorBefore: true,
          run: () => this.run("agent.pinSession", { session: id, pinned: !state.pinned }),
        });
      items.push(
        {
          label: "Rename…",
          icon: "pencil",
          separatorBefore: !!state.archived,
          run: () => this.run("agent.renameSession", { session: id }),
        },
        {
          label: "Fork",
          icon: "chat-fork",
          run: () => this.run("agent.forkSession", { session: id }),
        },
        {
          label: state.archived ? "Unarchive" : "Archive",
          icon: state.archived ? "archive-restore" : "archive",
          separatorBefore: true,
          run: () => this.run("agent.archiveSession", { session: id, archived: !state.archived }),
        },
        {
          label: "Delete",
          icon: "trash-2",
          destructive: true,
          run: () => this.run("agent.deleteSession", { session: id }),
        },
      );
      showContextMenu(e.clientX, e.clientY, items);
    });
  }

  dispose(): void {
    this.store.dispose();
  }
}
