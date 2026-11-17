// The Sync tab's pages while sync is on (D435): overview, projects, settings and files,
// computers, security and privacy, storage, activity. Each is a few cards built from the
// controller's signals; every button runs a command or moves within the tab through the kit the
// view hands over (view.ts). The words and the numbers come from model.ts.
import { type Child, h, on } from "../../core/dom/index";
import type { SyncDevice, SyncStatus } from "../../core/ipc/sync";
import type { DisposableStore } from "../../core/lifecycle/index";
import { hasPlanPage, hasTeamPage } from "../../core/ownServices";
import type { IncomingItem } from "../../core/sync/incoming";
import { type IconName, icon } from "../../ui/Icon";
import type { MenuItem } from "../../ui/Menu";
import type { WorkbenchServices } from "../../workbench/services";
import type { SnapshotRow, SyncController } from "./controller";
import {
  type AttentionItem,
  activityLine,
  attentionItems,
  changedOn,
  countOf,
  FILE_KINDS,
  fileKind,
  folderName,
  formatSize,
  groupByDay,
  heldSummary,
  lapsedReason,
  lapsedSentence,
  lapsedUntil,
  type OverviewProject,
  overviewTiles,
  pinState,
  platformLabel,
  projectCounts,
  retentionText,
  SERVICE_CAN_SEE,
  SERVICE_CANT_READ,
  type SyncEvent,
  type SyncPageId,
  type SyncTeam,
  serviceTime,
  snapshotFacts,
  snapshotSize,
  storageByProject,
  storageNotice,
  storageShare,
  teamLine,
  teamOf,
  teamRow,
  teamStorageNote,
  throughTeam,
  timeOfDay,
} from "./model";
import type { SyncSession } from "./session";
import { shareCard } from "./shareCard";
import { snapshotPanel } from "./snapshotView";
import { type TeamLibraryReader, teamPage } from "./teamPage";

/** What the pages need of the view: its builders, and the two ways a button acts. */
export interface PageKit {
  readonly services: WorkbenchServices;
  readonly controller: SyncController;
  readonly session: SyncSession;
  /** The team's library as last read (ide://team), for the Team page. */
  readonly team: TeamLibraryReader;
  /** The listeners of what is drawn now. */
  readonly drawn: DisposableStore;
  /**
   * The account's subscription ended: what writes to the account is disabled, with the reason.
   */
  readonly lapsed: boolean;
  /** Runs a command; a failure is shown as a notification. */
  run(id: string, input?: unknown): Promise<unknown>;
  /** Reads the account's plan again (`sync.checkPlan`) and says when nothing changed. */
  checkPlan(): Promise<void>;
  /** Shows another page of the tab (and, on Projects, a project's detail; null: the list). */
  go(page: SyncPageId, project?: string | null): void;
  button(
    label: string,
    click: () => unknown,
    kind?: "primary" | "secondary" | "danger" | "ghost",
    glyph?: IconName | null,
  ): HTMLButtonElement;
  link(label: string, click: () => unknown, glyph?: IconName | null, danger?: boolean): HTMLElement;
  text(words: string, quiet?: boolean): HTMLElement;
  /** A relative time that stays current. */
  when(time: number): HTMLElement;
  /** A part that opens and closes, and stays as it was left through redraws. */
  details(key: string, summary: Child[], ...children: Child[]): HTMLElement;
  /** A ⋯ button that opens a menu. */
  menuButton(label: string, items: MenuItem[], menuLabel: string): HTMLElement;
  /** A menu at a point (a right-click). */
  contextMenu(x: number, y: number, items: MenuItem[]): void;
}

/** The switches under "What this computer syncs": setting key and its words. */
export const SYNCED_KINDS: readonly (readonly [key: string, label: string])[] = [
  ["sync.settings", "Settings"],
  ["sync.keybindings", "Keyboard shortcuts"],
  ["sync.rules", "Your rules file"],
  ["sync.snippets", "Snippets"],
  ["sync.agents", "Your agents"],
  ["sync.commands", "Your commands"],
  ["sync.outputStyles", "Your output styles"],
  ["sync.skills", "Your skills"],
  ["sync.chats", "Chats"],
  ["sync.snapshots", "Snapshots of synced projects"],
];

export const RESET_NOTE =
  "If you lose every computer that syncs and this key, the synced copy can't be read by anyone, the service included. You would then reset sync on the account page and upload again from a computer that still has your data; the snapshot history is lost by a reset.";

const SCOPE_WORDS: Record<string, string> = {
  remote: "Only what the git remote doesn't have",
  everything: "The whole history too",
};

// ------------------------------------------------------------ small pieces

/** A group of cards under a small label (Settings' sections). */
export function section(title: string | null, ...children: Child[]): HTMLElement {
  return h(
    "section",
    { class: "sync-section" },
    title ? h("h2", { class: "settings-section-title" }, title) : null,
    ...children,
  );
}

export function card(...children: Child[]): HTMLElement {
  return h("div", { class: "settings-card sync-card" }, ...children);
}

/** Free content in a card, with the card's padding. */
export function body(...children: Child[]): HTMLElement {
  return h("div", { class: "sync-card-body" }, ...children);
}

/** What a card says when it has nothing to list, and what to do about it. */
export function empty(words: string): HTMLElement {
  return h("div", { class: "sync-card-body sync-empty" }, words);
}

export interface ItemParts {
  title: Child;
  tags?: readonly string[];
  details?: readonly Child[];
  actions?: readonly Child[];
  attrs?: Record<string, string>;
  /** Shown under the text, the row's whole width (a code to compare, a list that opens). */
  below?: readonly Child[];
}

/** A row of a card: a title with tags, muted lines under it, actions at the end. */
export function item(parts: ItemParts): HTMLElement {
  const title = typeof parts.title === "string" ? parts.title : null;
  const actions = (parts.actions ?? []).filter(Boolean);
  return h(
    "div",
    { class: "sync-item", ...parts.attrs },
    h(
      "div",
      { class: "sync-item-main" },
      h(
        "div",
        { class: "sync-item-title" },
        h("span", { class: "sync-item-name", ...(title && { title }) }, parts.title),
        ...(parts.tags ?? []).map((tag) => h("span", { class: "ai-tag" }, tag)),
      ),
      ...(parts.details ?? [])
        .filter(Boolean)
        .map((detail) => h("div", { class: "sync-item-detail" }, detail)),
      ...(parts.below ?? []),
    ),
    actions.length > 0 ? h("div", { class: "sync-item-actions" }, ...actions) : null,
  );
}

function meter(share: number, full: boolean): HTMLElement {
  const el = h("div", {
    class: `sync-meter${full ? " is-full" : ""}`,
    role: "meter",
    "aria-label": "Storage used",
    "aria-valuemin": "0",
    "aria-valuemax": "100",
    "aria-valuenow": String(Math.round(share * 100)),
  });
  el.append(h("div", { class: "sync-meter-fill", style: { width: `${share * 100}%` } }));
  return el;
}

function storageLimit(kit: PageKit, status: SyncStatus): number {
  return status.storageLimit || kit.session.profile.peek()?.storageLimit || 0;
}

/** The team the account is in; null in none, or when the build's service has no teams. */
function teamIn(kit: PageKit): SyncTeam | null {
  return teamOf(kit.session.profile.peek());
}

/** Opens the team page in the browser: teams are managed there, never here. */
export function manageTeam(kit: PageKit): HTMLButtonElement {
  return kit.button("Manage team", () => kit.run("sync.manageTeam"), "secondary", "external-link");
}

function logRows(kit: PageKit, log: readonly SyncEvent[]): HTMLElement[] {
  return log.map((event) =>
    h(
      "div",
      { class: `sync-item sync-log-row${event.error ? " is-error" : ""}` },
      h("span", { class: "sync-log-time" }, kit.when(event.at)),
      h("span", { class: "sync-log-text" }, event.text),
    ),
  );
}

/**
 * A button for something that writes to the account: while the subscription is ended it is
 * there and disabled, and says why.
 */
export function writeButton(
  kit: PageKit,
  label: string,
  click: () => unknown,
  kind: "primary" | "secondary" | "danger" | "ghost" = "secondary",
  glyph: IconName | null = null,
): HTMLButtonElement {
  const el = kit.button(label, click, kind, glyph);
  if (kit.lapsed) {
    el.disabled = true;
    el.title = lapsedReason(teamIn(kit));
  }
  return el;
}

/**
 * The subscription ended: what that means, until when what is synced can be read, and the two
 * things to do about it. `until`: when the synced copy is deleted, in ms (null: not known).
 * A team's member is told it was the team's subscription and isn't offered Renew: the plan is
 * the owner's.
 */
export function lapsedCallout(kit: PageKit, until: number | null): HTMLElement {
  const team = teamIn(kit);
  const member = throughTeam(team);
  return h(
    "div",
    {
      class: "settings-card sync-card sync-callout sync-lapsed",
      role: "status",
      "data-lapsed": member ? "team" : "own",
    },
    h("div", { class: "sync-item-main" }, kit.text(lapsedSentence(until, Date.now(), team))),
    h(
      "div",
      { class: "sync-item-actions" },
      member
        ? manageTeam(kit)
        : hasPlanPage()
          ? kit.button("Renew", () => kit.run("sync.managePlan"), "primary")
          : null,
      kit.button("Check again", () => kit.checkPlan()),
    ),
  );
}

/** "Continue from <computer>": another computer has newer work on the open project. */
function continueCallout(kit: PageKit): HTMLElement | null {
  const other = kit.controller.continueFrom();
  if (!other) return null;
  return section(
    null,
    h(
      "div",
      { class: "settings-card sync-card sync-callout" },
      h(
        "div",
        { class: "sync-item-main" },
        h(
          "div",
          { class: "sync-item-title" },
          h("span", { class: "sync-item-name" }, `Continue from ${other.summary.deviceName}`),
        ),
        h(
          "div",
          { class: "sync-item-detail" },
          "It has newer work on this project, from ",
          kit.when(other.summary.time),
          ".",
        ),
      ),
      kit.button("Continue", () => kit.run("sync.snapshot.continue"), "primary"),
    ),
  );
}

// ------------------------------------------------------------ overview

/** Is it working: the state, when it last synced, and Sync now (Retry after an error). */
function statusCard(kit: PageKit): HTMLElement {
  const activity = kit.controller.activity.peek();
  const failed = activity.state === "error";
  const team = teamIn(kit);
  const line = activityLine(activity, throughTeam(team));
  const glyph: IconName = failed
    ? "circle-alert"
    : activity.state === "syncing"
      ? "refresh-cw"
      : activity.state === "idle" && activity.at !== null
        ? "circle-check"
        : activity.state === "blocked"
          ? "key-round"
          : "cloud";
  // While the subscription is ended a pass only reads: the callout above has what to do.
  const lapsed = kit.lapsed || activity.state === "lapsed";
  // The time of the last good pass stays in sight while something else is said.
  const earlier = line.time === null && activity.at !== null ? activity.at : null;
  return h(
    "div",
    {
      class: `settings-card sync-card sync-status${failed ? " is-error" : ""}`,
      "data-state": activity.state,
    },
    h("div", { class: "sync-status-icon" }, icon(glyph)),
    h(
      "div",
      { class: "sync-item-main", role: "status" },
      h(
        "div",
        { class: "sync-status-text" },
        failed ? "Sync ran into a problem" : line.text,
        line.time === null ? null : " ",
        line.time === null ? null : kit.when(line.time),
      ),
      failed ? h("div", { class: "sync-status-reason" }, line.text) : null,
      earlier === null
        ? null
        : h("div", { class: "sync-item-detail" }, "Last synced ", kit.when(earlier)),
      // In a team: whose it is, or that sync comes through it, and the way to its page.
      team === null
        ? null
        : h(
            "div",
            { class: "sync-item-detail sync-team-line", "data-team": team.role },
            h("span", { class: "sync-team-name" }, teamLine(team)),
            // What the team shares is a page of this tab (in a build with teams' libraries).
            kit.team.available() ? kit.link("Team library", () => kit.go("team")) : null,
            kit.link("Manage team", () => kit.run("sync.manageTeam"), "external-link"),
          ),
    ),
    lapsed
      ? null
      : kit.button(
          failed ? "Retry" : "Sync now",
          () => kit.run("sync.syncNow"),
          "secondary",
          "refresh-cw",
        ),
  );
}

function attentionRow(kit: PageKit, entry: AttentionItem): HTMLElement {
  const act = () => {
    if (entry.command) return kit.run(entry.command);
    if (entry.page) kit.go(entry.page);
    return undefined;
  };
  return h(
    "div",
    { class: "sync-item", "data-attention": entry.kind },
    h("div", { class: "sync-item-main" }, h("div", { class: "sync-attention-text" }, entry.text)),
    h("div", { class: "sync-item-actions" }, kit.button(entry.action, act)),
  );
}

const INCOMING_TAGS: Record<IncomingItem["kind"], string> = {
  skill: "Skill",
  command: "Command",
  keybindings: "Shortcuts",
  rules: "Rules",
};

/**
 * What another of the account's computers synced here and the person hasn't accepted on this
 * one (`core/sync/incoming.ts`): each with Accept, and all at once. Null when nothing waits.
 */
function incomingSection(kit: PageKit): HTMLElement | null {
  const items = kit.controller.incoming.peek();
  if (items.length === 0) return null;
  const running = items.filter((entry) => entry.runs).length;
  return section(
    "From your other computers",
    card(
      body(
        kit.text(
          running > 0
            ? "These arrived by sync and can run commands. Until you accept them here, their tools ask before they run and their shortcuts aren't in use."
            : "These arrived by sync. They steer the agent and run nothing by themselves; accept them once you have looked.",
          true,
        ),
      ),
      ...items.map((entry) =>
        item({
          title: entry.name,
          tags: [INCOMING_TAGS[entry.kind], ...(entry.runs ? ["Can run commands"] : [])],
          details: [entry.detail],
          attrs: { "data-incoming": entry.id },
          actions: [kit.button("Accept", () => kit.run("sync.acceptIncoming", { id: entry.id }))],
        }),
      ),
    ),
    items.length > 1
      ? h(
          "div",
          { class: "sync-section-foot" },
          kit.link("Accept all", () => kit.run("sync.acceptIncoming")),
        )
      : null,
  );
}

interface Stat {
  key: string;
  /** The number (or a time), large. */
  value: Child;
  label: Child;
  /** Where it leads, when it is a button. */
  go?: () => void;
}

/** A row of equal stats with hairlines between them: a number, and under it what it counts. */
function stats(kit: PageKit, entries: readonly Stat[]): HTMLElement {
  return h(
    "div",
    { class: "sync-stats", "data-count": String(entries.length) },
    ...entries.map((entry) => {
      const inner = [
        h("span", { class: "sync-stat-value" }, entry.value),
        h("span", { class: "sync-stat-label" }, entry.label),
      ];
      const go = entry.go;
      if (!go) return h("div", { class: "sync-stat", "data-stat": entry.key }, ...inner);
      const el = h(
        "button",
        { class: "sync-stat is-button", type: "button", "data-stat": entry.key },
        ...inner,
      );
      kit.drawn.add(on(el, "click", go));
      return el;
    }),
  );
}

function overviewPage(kit: PageKit, status: SyncStatus): Child[] {
  const { controller } = kit;
  const overview = controller.overview.peek();
  const limit = storageLimit(kit, status);
  const share = storageShare(status.usageBytes, limit);
  const project = controller.project.peek();
  const attention = attentionItems({
    waiting: status.devices.filter((d) => d.status === "pending"),
    usage: status.usageBytes,
    limit,
    activity: controller.activity.peek(),
    project: project ? { name: folderName(project.root), on: project.on } : null,
    lapsed: kit.lapsed,
    // The status card right above says an error, with Retry: not said twice.
  }).filter((entry) => entry.kind !== "error");

  // Status, counts and storage: three cards of one width, one under the other.
  const counts = h(
    "div",
    { class: "settings-card sync-card" },
    stats(
      kit,
      overviewTiles(overview, status.devices).map((tile) => ({
        key: tile.label.toLowerCase(),
        value: tile.value,
        label: tile.label,
        go: () => kit.go(tile.page),
      })),
    ),
  );
  const storage = h(
    "button",
    { class: "settings-card sync-card sync-storage-card", type: "button", "data-stat": "storage" },
    h(
      "span",
      { class: "sync-storage-card-line" },
      // In a team the storage is the team's pool, not the account's own.
      h(
        "span",
        { class: "sync-stat-label" },
        teamIn(kit) === null ? "Storage" : "Storage, shared by your team",
      ),
      h(
        "span",
        { class: "sync-storage-card-value" },
        limit > 0
          ? `${formatSize(status.usageBytes)} of ${formatSize(limit)}`
          : `${formatSize(status.usageBytes)} used`,
      ),
    ),
    limit > 0 ? meter(share, storageNotice(status.usageBytes, limit) !== null) : null,
  );
  kit.drawn.add(on(storage, "click", () => kit.go("storage")));

  const log = controller.log.peek();
  return [
    h("div", { class: "sync-stack" }, statusCard(kit), counts, storage),
    continueCallout(kit),
    incomingSection(kit),
    attention.length === 0
      ? null
      : section("Needs attention", card(...attention.map((entry) => attentionRow(kit, entry)))),
    section(
      "Recent activity",
      log.length === 0
        ? card(empty("Nothing yet. What sync does shows here."))
        : card(...logRows(kit, log.slice(0, 5))),
      log.length > 5
        ? h(
            "div",
            { class: "sync-section-foot" },
            kit.link("Show all", () => kit.go("activity")),
          )
        : null,
    ),
  ];
}

// ------------------------------------------------------------ projects

/** The open folder while it doesn't sync yet: what syncing it does, and the way in. */
function notSyncedCard(kit: PageKit, root: string, known: boolean): HTMLElement {
  const name = folderName(root) || root;
  // A folder the account doesn't know, while the account has projects that aren't here: it
  // may be one of them (a copy made by hand, a clone without its remote).
  const linkable = !known && kit.controller.overview.peek().projects.some((p) => !p.here);
  return card(
    item({
      title: name,
      tags: ["Not synced"],
      details: [
        `When it syncs, its chats travel with you, and snapshots of unfinished work are taken automatically, with a history.${known ? " Another of your computers already syncs it." : ""}`,
        linkable && !kit.lapsed
          ? kit.link("This folder is one of my synced projects…", () =>
              kit.run("sync.project.link"),
            )
          : null,
      ],
      attrs: { "data-open-project": "off" },
      actions: [
        writeButton(kit, "Sync this project", () => kit.run("sync.project.enable"), "primary"),
      ],
    }),
  );
}

function snapshotRow(kit: PageKit, row: SnapshotRow, deviceId: string | null): HTMLElement {
  const { summary } = row;
  const name = summary.pinned;
  // Pinned under a name on a computer, from the account page, or both: history keeps it.
  const pinned = pinState(name, row.keep);
  const pin = h(
    "button",
    {
      class: `icon-button sync-pin${pinned.on ? " is-on" : ""}`,
      type: "button",
      "aria-pressed": pinned.on ? "true" : "false",
      "aria-label": pinned.on ? `Unpin ${name ?? "this snapshot"}` : "Pin this snapshot",
      title: pinned.on ? `${pinned.why}\nUnpin` : "Pin: keep it whatever its age",
    },
    icon(pinned.on ? "pin-off" : "pin"),
  );
  const togglePin = () =>
    kit.run("sync.snapshot.pin", pinned.on ? { id: row.id, name: null } : { id: row.id });
  // Pinning and deleting write to the account; restoring and listing files only read.
  const { lapsed } = kit;
  if (lapsed) {
    pin.disabled = true;
    pin.title = lapsedReason(teamIn(kit));
  }
  kit.drawn.add(on(pin, "click", () => void togglePin()));
  // Looking inside it first: its files against this folder (snapshotView.ts).
  const view = () => void kit.run("sync.snapshot.view", { id: row.id });
  const items: MenuItem[] = [
    { label: "View changes", icon: "file-diff", run: view },
    {
      label: "Restore…",
      icon: "archive-restore",
      run: () => void kit.run("sync.snapshot.restore", { id: row.id }),
    },
    {
      label: "Restore a file…",
      icon: "files",
      run: () => void kit.run("sync.snapshot.restoreFile", { id: row.id }),
    },
    {
      label: pinned.on ? "Unpin" : "Pin…",
      icon: pinned.on ? "pin-off" : "pin",
      disabled: lapsed,
      run: () => void togglePin(),
    },
    {
      label: "Delete…",
      icon: "trash-2",
      destructive: true,
      separatorBefore: true,
      disabled: lapsed,
      run: () => void kit.run("sync.snapshot.delete", { id: row.id }),
    },
  ];
  const computer = summary.device === deviceId ? "This computer" : summary.deviceName;
  const facts = `${computer} · ${snapshotFacts(summary.files, summary.bytes)}`;
  const full = [new Date(summary.time).toLocaleString(), summary.branch, facts]
    .filter(Boolean)
    .join(" · ");
  // The time and the facts are one button: it opens the snapshot.
  const open = h(
    "button",
    { class: "sync-snapshot-open", type: "button", title: `${full}\nView changes` },
    h("span", { class: "sync-snapshot-time" }, timeOfDay(summary.time)),
    h(
      "span",
      { class: "sync-snapshot-main" },
      h("span", { class: "sync-snapshot-facts" }, facts),
      pinned.tag
        ? h("span", { class: "ai-tag sync-pin-name", title: pinned.why }, pinned.tag)
        : null,
    ),
  );
  kit.drawn.add(on(open, "click", view));
  return h(
    "div",
    {
      class: "sync-item sync-snapshot",
      "data-snapshot": row.id,
      ...(row.keep && { "data-kept": "" }),
    },
    open,
    h(
      "div",
      { class: "sync-item-actions" },
      pin,
      kit.menuButton("More for this snapshot", items, "Snapshot"),
    ),
  );
}

/** Where a project is, as its one tag. */
function placeTag(project: OverviewProject): string {
  if (project.folderMissing) return "Folder not found on this computer";
  return project.here ? "This computer" : "Not on this computer";
}

/** What can be done with a project: the same from its folder (right-click) and inside it. */
function projectMenu(kit: PageKit, project: OverviewProject, inside: boolean): MenuItem[] {
  const open = kit.controller.project.peek();
  const isOpen = !!open?.on && open.id === project.id;
  // What writes to the account is there and disabled while the subscription is ended.
  const { lapsed } = kit;
  return [
    ...(inside
      ? []
      : [
          {
            label: "Open",
            icon: "folder-open" as const,
            run: () => kit.go("projects", project.id),
          },
        ]),
    ...(isOpen
      ? [
          {
            label: "Snapshot now",
            icon: "camera" as const,
            disabled: lapsed,
            run: () => void kit.run("sync.snapshot.create"),
          },
        ]
      : []),
    {
      label: "Rename…",
      separatorBefore: !inside || isOpen,
      disabled: lapsed,
      run: () => void kit.run("sync.project.rename", { id: project.id }),
    },
    ...(isOpen
      ? [
          {
            label: "Choose what snapshots leave out…",
            run: () => void kit.run("sync.project.editIgnore"),
          },
          {
            label: "Stop syncing this project",
            run: () => void kit.run("sync.project.disable"),
          },
        ]
      : []),
    ...(!isOpen && project.here && project.folder
      ? [
          {
            label: "Stop syncing from this computer",
            run: () => void kit.run("sync.project.forgetFolder", { folder: project.folder }),
          },
        ]
      : []),
    {
      label: "Delete from the account…",
      icon: "trash-2",
      destructive: true,
      separatorBefore: true,
      disabled: lapsed,
      run: () => void kit.run("sync.project.deleteFromAccount", { id: project.id }),
    },
  ];
}

/** One project: its name and folder, its numbers, and (the open folder's) its history. */
function projectDetail(kit: PageKit, project: OverviewProject, status: SyncStatus): HTMLElement {
  const { controller, services } = kit;
  const open = controller.project.peek();
  const isOpen = !!open?.on && open.id === project.id;
  const menu = projectMenu(kit, project, true);
  const where = changedOn(project);
  const head = h(
    "div",
    { class: "settings-card sync-card" },
    h(
      "div",
      { class: "sync-detail-head" },
      folderGlyph(project),
      h(
        "div",
        { class: "sync-item-main" },
        h(
          "div",
          { class: "sync-item-title" },
          h("h2", { class: "sync-detail-title", title: project.name }, project.name),
          h("span", { class: "ai-tag" }, placeTag(project)),
        ),
        project.folder
          ? h("div", { class: "sync-item-detail sync-path", title: project.folder }, project.folder)
          : h("div", { class: "sync-item-detail" }, "In your account, from another computer"),
      ),
      h(
        "div",
        { class: "sync-item-actions" },
        isOpen
          ? writeButton(
              kit,
              "Snapshot now",
              () => kit.run("sync.snapshot.create"),
              // Continue is the page's one primary button when it is on offer.
              controller.continueFrom() === null ? "primary" : "secondary",
              "camera",
            )
          : null,
        kit.menuButton(`More for ${project.name}`, menu, "Project"),
      ),
    ),
    stats(kit, [
      { key: "chats", value: String(project.chats), label: project.chats === 1 ? "Chat" : "Chats" },
      {
        key: "snapshots",
        value: String(project.snapshots),
        label: project.snapshots === 1 ? "Snapshot" : "Snapshots",
      },
      {
        key: "changed",
        value: project.lastChange === null ? "–" : kit.when(project.lastChange),
        label: where ? `Last change, ${where}` : "Last change",
      },
    ]),
  );

  let rest: Child[];
  if (isOpen) {
    const rows = controller.snapshots.peek();
    const days = services.settings.peek<number | undefined>("sync.historyDays") ?? 30;
    // A snapshot being looked at shows in place of the history, while it still exists.
    const looked = kit.session.look.opened.peek();
    const lookedRow = looked ? rows.find((row) => row.id === looked.id) : undefined;
    if (looked && lookedRow)
      return h(
        "div",
        { class: "sync-detail", "data-project-detail": project.id },
        head,
        ...snapshotPanel(kit, lookedRow, looked, status.deviceId),
      );
    rest = [
      h(
        "div",
        { class: "sync-subhead" },
        h("h3", { class: "sync-subtitle" }, "Snapshot history"),
        h(
          "p",
          { class: "sync-subhead-note" },
          `${retentionText(days)}. `,
          kit.link("Change", () => kit.run("settings.open", { query: "@id:sync.historyDays" })),
        ),
      ),
      rows.length === 0
        ? card(empty("No snapshots yet. One is taken when there is unfinished work."))
        : groupByDay(rows, (row) => row.summary.time).map((group) =>
            h(
              "div",
              { class: "sync-day" },
              h("div", { class: "sync-day-label" }, group.label),
              card(...group.rows.map((row) => snapshotRow(kit, row, status.deviceId))),
            ),
          ),
    ];
  } else if (project.folderMissing && project.folder) {
    const folder = project.folder;
    rest = [
      kit.text(
        "The folder it synced from isn't on this computer any more (moved or deleted). Its chats and snapshots are still in your account. If the folder moved, open it where it is now and say it is this project.",
        true,
      ),
      h(
        "div",
        { class: "sync-actions" },
        kit.button("Forget this folder", () => kit.run("sync.project.forgetFolder", { folder })),
      ),
    ];
  } else if (project.here) {
    rest = [
      kit.text(
        "It syncs from the folder above. Open that folder to see and restore its snapshots.",
        true,
      ),
    ];
  } else {
    // The open folder can become this project when it doesn't sync as another.
    const canLink = !!open && !open.on;
    rest = [
      kit.text(
        "Its chats and snapshots are in your account. To get it on this computer, open its folder here (clone or copy the project first), then say that the folder is this project: its chats arrive, and you can continue from its latest snapshot.",
        true,
      ),
      canLink
        ? h(
            "div",
            { class: "sync-actions" },
            writeButton(kit, `The open folder is ${project.name}`, () =>
              kit.run("sync.project.link", { id: project.id }),
            ),
          )
        : null,
    ];
  }

  return h(
    "div",
    { class: "sync-detail", "data-project-detail": project.id },
    head,
    // Sharing it with the account's team (shareCard.ts): for an account in one.
    shareCard(kit, project, isOpen),
    ...rest,
  );
}

/** A folder, as the Projects page draws a project: quieter when it isn't on this computer. */
function folderGlyph(project: OverviewProject): HTMLElement {
  const away = !project.here || project.folderMissing;
  return h(
    "span",
    { class: `sync-folder-glyph${away ? " is-away" : ""}`, "aria-hidden": "true" },
    icon(project.folderMissing ? "folder-x" : "folder"),
  );
}

/**
 * Where the Projects page is, as a file manager's address bar: a way back, then the path from
 * "Projects" to the project shown. Every part but the last is a button.
 */
function addressBar(kit: PageKit, project: OverviewProject | null): HTMLElement {
  const back = h(
    "button",
    {
      class: "icon-button sync-address-back",
      type: "button",
      title: "Back to all projects",
      "aria-label": "Back to all projects",
      ...(project === null && { disabled: "" }),
    },
    icon("arrow-left"),
  );
  if (project !== null) kit.drawn.add(on(back, "click", () => kit.go("projects", null)));
  const crumbs: Child[] = [];
  if (project === null) {
    crumbs.push(h("span", { class: "sync-crumb is-current", "aria-current": "page" }, "Projects"));
  } else {
    const up = h("button", { class: "sync-crumb", type: "button" }, "Projects");
    kit.drawn.add(on(up, "click", () => kit.go("projects", null)));
    crumbs.push(
      up,
      h("span", { class: "sync-crumb-sep", "aria-hidden": "true" }, icon("chevron-right")),
      h(
        "span",
        { class: "sync-crumb is-current", "aria-current": "page", title: project.name },
        project.name,
      ),
    );
  }
  return h(
    "nav",
    { class: "sync-address", "aria-label": "Where you are in Projects" },
    back,
    h("div", { class: "sync-crumbs" }, icon("folder"), ...crumbs),
  );
}

function projectsPage(kit: PageKit, status: SyncStatus): Child[] {
  const { controller, session } = kit;
  const projects = controller.overview.peek().projects;
  const open = controller.project.peek();
  const openId = open?.on ? open.id : null;
  // Inside one project, or the folders themselves.
  const chosen = projects.find((p) => p.id === session.projectId.peek()) ?? null;
  if (chosen) return [addressBar(kit, chosen), projectDetail(kit, chosen, status)];

  const folders = projects.map((project) => {
    const el = h(
      "button",
      {
        class: "sync-folder",
        type: "button",
        "data-project": project.id,
        title: project.folder ?? project.name,
      },
      folderGlyph(project),
      h(
        "span",
        { class: "sync-folder-main" },
        h("span", { class: "sync-folder-name" }, project.name),
        h(
          "span",
          { class: "sync-folder-line" },
          project.id === openId ? "Open here" : placeTag(project),
        ),
        h(
          "span",
          { class: "sync-folder-line" },
          projectCounts(project),
          project.lastChange === null ? null : " · ",
          project.lastChange === null ? null : kit.when(project.lastChange),
        ),
      ),
    );
    kit.drawn.add(on(el, "click", () => kit.go("projects", project.id)));
    kit.drawn.add(
      on(el, "contextmenu", (event) => {
        event.preventDefault();
        kit.contextMenu(event.clientX, event.clientY, projectMenu(kit, project, false));
      }),
    );
    return el;
  });

  return [
    addressBar(kit, null),
    open && !open.on ? section("This folder", notSyncedCard(kit, open.root, open.known)) : null,
    continueCallout(kit),
    projects.length === 0
      ? card(
          empty(
            open
              ? "No projects yet. A project syncs once you choose Sync this project."
              : "No projects yet. Open a folder and choose Sync this project: its chats travel with you, and snapshots of unfinished work are taken automatically.",
          ),
        )
      : h("div", { class: "sync-folders", role: "list" }, ...folders),
  ];
}

// ------------------------------------------------------------ settings and files

function contentPage(kit: PageKit): Child[] {
  const { controller, services } = kit;
  const overview = controller.overview.peek();
  const rows = SYNCED_KINDS.map(([key, label]) => {
    const kind = key.replace(/^sync\./, "");
    const box = h("input", { class: "checkbox", type: "checkbox" });
    box.checked = services.settings.peek<boolean | undefined>(key) !== false;
    kit.drawn.add(
      on(box, "change", () => void kit.run("settings.set", { key, value: box.checked })),
    );
    const held: Child[] = [heldSummary(key, overview)];
    if (kind === "settings" && overview.settings?.updatedAt != null)
      held.push(" · changed ", kit.when(overview.settings.updatedAt));
    const files = FILE_KINDS.some(([k]) => k === kind)
      ? overview.files.filter((f) => fileKind(f.path) === kind)
      : [];
    return h(
      "div",
      { class: "sync-item sync-toggle", "data-kind": kind },
      h(
        "div",
        { class: "sync-toggle-line" },
        h("label", { class: "sync-check" }, box, h("span", { class: "sync-check-label" }, label)),
        h("span", { class: "sync-held" }, ...held),
      ),
      files.length === 0
        ? null
        : kit.details(
            `files:${kind}`,
            [h("span", { class: "sync-details-label" }, "Names")],
            h(
              "div",
              { class: "sync-files" },
              ...files.map((file) =>
                h(
                  "div",
                  { class: "sync-file" },
                  h("span", { class: "sync-file-path", title: file.path }, file.path),
                  h("span", { class: "sync-file-size" }, formatSize(file.bytes)),
                ),
              ),
            ),
          ),
    );
  });
  const ignored = services.settings.peek<unknown>("sync.ignoredSettings");
  const kept = Array.isArray(ignored) ? ignored.length : 0;
  return [
    section(
      "What this computer syncs",
      card(...rows),
      h(
        "div",
        { class: "sync-section-foot" },
        "Each computer has its own choice. Beside each: what the account holds now.",
      ),
    ),
    section(
      "Exceptions",
      card(
        item({
          title: "Settings that stay on this computer",
          details: [
            kept === 0 ? "None of your choice." : `${countOf(kept, "setting")} of your choice.`,
            "Settings that run programs, point somewhere, choose a model or loosen a protection don't sync, nor do settings this computer doesn't know.",
          ],
          actions: [
            kit.button("Change", () =>
              kit.run("settings.open", { query: "@id:sync.ignoredSettings" }),
            ),
          ],
        }),
      ),
      h(
        "div",
        { class: "sync-section-foot" },
        "Keys for model providers and other services never sync.",
      ),
    ),
  ];
}

// ------------------------------------------------------------ computers

function deviceRow(kit: PageKit, device: SyncDevice): HTMLElement {
  const seen = serviceTime(device.lastSeenAt);
  const waiting = device.status === "pending";
  const checking = waiting && device.code !== null;
  // Asked for its code, which comes once the waiting computer has answered.
  const asked =
    waiting &&
    !checking &&
    (device.checking === true || kit.controller.reviewing.peek().includes(device.id));
  const detail: Child[] = [platformLabel(device.platform)];
  if (asked) detail.push(" · waiting for the other computer…");
  else if (waiting) detail.push(" · wants to join");
  else if (seen !== null) detail.push(" · last seen ", kit.when(seen));
  return item({
    title: device.name,
    tags: device.current ? ["This computer"] : [],
    details: [detail],
    attrs: { "data-device": device.id },
    below: checking
      ? [
          h("div", { class: "sync-code is-row", "aria-label": "Verification code" }, device.code),
          h(
            "div",
            { class: "sync-item-detail" },
            "Approve only if that computer shows the same code.",
          ),
        ]
      : [],
    actions: [
      waiting && !checking && !asked
        ? writeButton(
            kit,
            "Check code",
            () => kit.run("sync.reviewDevice", { device: device.id }),
            "primary",
          )
        : null,
      checking
        ? writeButton(
            kit,
            "Approve",
            () => kit.run("sync.approveDevice", { device: device.id }),
            "primary",
          )
        : null,
      device.current
        ? writeButton(kit, "Rename", () => kit.run("sync.renameDevice"))
        : kit.button("Remove", () => kit.run("sync.removeDevice", { device: device.id })),
    ],
  });
}

function computersPage(kit: PageKit, status: SyncStatus): Child[] {
  const waiting = status.devices.filter((d) => d.status === "pending");
  const approved = status.devices
    .filter((d) => d.status !== "pending")
    .sort((a, b) => Number(b.current) - Number(a.current));
  const step = (words: string) => h("li", null, words);
  return [
    waiting.length === 0
      ? null
      : section("Waiting to join", card(...waiting.map((d) => deviceRow(kit, d)))),
    section("Your computers", card(...approved.map((d) => deviceRow(kit, d)))),
    section(
      "Add a computer",
      card(
        body(
          h(
            "ol",
            { class: "sync-steps" },
            step("Install the IDE on the other computer and sign in to this account there."),
            step("Open Sync there and choose Join."),
            step(
              "Back here, choose Check code for it under Waiting to join. When both computers show the same code, approve it.",
            ),
          ),
          kit.text(
            "No computer at hand that syncs? Join with the recovery key instead: no approval is needed.",
            true,
          ),
        ),
      ),
    ),
    h(
      "div",
      { class: "sync-page-foot" },
      kit.link("Turn off sync on this computer…", () => kit.run("sync.turnOff"), null, true),
    ),
  ];
}

// ------------------------------------------------------------ security and privacy

function securityPage(kit: PageKit, status: SyncStatus): Child[] {
  const made = serviceTime(status.recoveryCreatedAt);
  const list = (title: string, glyph: IconName, entries: readonly string[]) =>
    h(
      "div",
      { class: "sync-seen" },
      h("div", { class: "sync-seen-title" }, icon(glyph), title),
      h("ul", { class: "sync-seen-list" }, ...entries.map((entry) => h("li", null, entry))),
    );
  return [
    section(
      "Recovery key",
      card(
        item({
          title: "Your recovery key",
          details: [
            "Lets a new computer join without another computer's approval, and is the only way back to the synced copy when no computer that syncs is left. It is shown once, when it is made.",
            made === null ? null : ["Made ", kit.when(made), "."],
          ],
          actions: [
            writeButton(kit, "Make a new recovery key", () => kit.run("sync.newRecoveryKey")),
          ],
        }),
      ),
    ),
    section(
      "What the service can see",
      card(
        body(
          kit.text(
            "Everything is encrypted on this computer before it leaves, with keys the service never has.",
          ),
          h(
            "div",
            { class: "sync-seen-columns" },
            list("The service can see", "eye", SERVICE_CAN_SEE),
            list("The service can't read", "lock", SERVICE_CANT_READ),
          ),
        ),
      ),
    ),
    section(
      "If you lose everything",
      card(
        body(
          kit.text(RESET_NOTE, true),
          h(
            "div",
            { class: "sync-actions" },
            kit.link(
              "Reset sync, or manage devices and storage, on the account page",
              () => kit.run("sync.openAccountPage"),
              "external-link",
            ),
          ),
        ),
      ),
    ),
  ];
}

// ------------------------------------------------------------ storage

function storagePage(kit: PageKit, status: SyncStatus): Child[] {
  const { controller, services } = kit;
  const used = status.usageBytes;
  const limit = storageLimit(kit, status);
  const notice = storageNotice(used, limit);
  const byProject = storageByProject(controller.overview.peek());
  const days = services.settings.peek<number | undefined>("sync.historyDays") ?? 30;
  const scope = services.settings.peek<string | undefined>("sync.snapshotScope") ?? "remote";
  const hasSync = kit.session.profile.peek()?.sync === true;
  const team = teamIn(kit);
  // A member's sync is the team's: there is no plan of its own to manage.
  const ownPlan = hasSync && hasPlanPage() && !throughTeam(team);
  // The team's row: for an account in a team, and (so teams can be found) for a subscriber in
  // none, while the service has teams. Never for an account whose subscription ended.
  const teams = team !== null || (hasSync && !kit.lapsed && hasTeamPage());
  const row = teamRow(team);
  return [
    section(
      null,
      card(
        body(
          h(
            "div",
            { class: "sync-storage-used" },
            h("span", { class: "sync-storage-number" }, formatSize(used)),
            limit > 0
              ? h("span", { class: "sync-storage-of" }, `used of ${formatSize(limit)}`)
              : h("span", { class: "sync-storage-of" }, "used"),
          ),
          limit > 0 ? meter(storageShare(used, limit), notice !== null) : null,
          notice ? h("p", { class: "sync-text sync-storage-notice" }, notice.text) : null,
          team === null
            ? null
            : h(
                "p",
                { class: "sync-text is-quiet", "data-team-storage": team.role },
                teamStorageNote(team, limit > 0),
              ),
        ),
        // Only for an account that has sync: the plan is where storage comes from.
        ownPlan
          ? item({
              title: "Your plan",
              details: [
                "More storage, billing, invoices and cancelling are on your account page, which opens in the browser.",
              ],
              attrs: { "data-plan": "manage" },
              actions: [
                kit.button(
                  "Manage plan",
                  () => kit.run("sync.managePlan"),
                  "secondary",
                  "external-link",
                ),
              ],
            })
          : null,
        teams
          ? item({
              title: row.title,
              details: [row.detail],
              attrs: { "data-team-row": team?.role ?? "none" },
              actions: [manageTeam(kit)],
            })
          : null,
      ),
    ),
    section(
      "Latest snapshot of each project",
      byProject.length === 0
        ? card(empty("No snapshots yet. They are taken in the projects that sync."))
        : card(
            ...byProject.map((p) => {
              const el = h(
                "button",
                { class: "sync-item sync-pick sync-size-row", type: "button" },
                h("span", { class: "sync-item-name", title: p.name }, p.name),
                h("span", { class: "sync-held" }, countOf(p.snapshots, "snapshot")),
                h("span", { class: "sync-size" }, snapshotSize(p.bytes)),
              );
              kit.drawn.add(on(el, "click", () => kit.go("projects", p.id)));
              return el;
            }),
          ),
      h(
        "div",
        { class: "sync-section-foot" },
        "Snapshots share what didn't change between them, so these sizes don't add up to the total. Chats, settings and your files are counted in the total too.",
      ),
    ),
    section(
      "History",
      card(
        item({
          title: "How long snapshots are kept",
          details: [`${retentionText(days)}. Pinned snapshots are always kept.`],
          actions: [
            kit.button("Change", () => kit.run("settings.open", { query: "@id:sync.historyDays" })),
          ],
        }),
        item({
          title: "What a snapshot holds",
          details: [
            `${SCOPE_WORDS[scope] ?? scope} (for a project with a git remote; without one, all of its files).`,
          ],
          actions: [
            kit.button("Change", () =>
              kit.run("settings.open", { query: "@id:sync.snapshotScope" }),
            ),
          ],
        }),
      ),
    ),
    section(
      "Free space",
      card(
        body(
          kit.text(
            "Delete snapshots you no longer need from a project's history, keep fewer days of history, or delete a whole project from the account. Space is freed once nothing refers to the content any more.",
            true,
          ),
          h(
            "div",
            { class: "sync-actions" },
            kit.button("Open projects", () => kit.go("projects")),
          ),
        ),
      ),
    ),
  ];
}

// ------------------------------------------------------------ activity

function activityPage(kit: PageKit): Child[] {
  const log = kit.controller.log.peek();
  return [
    section(
      null,
      log.length === 0
        ? card(
            empty(
              "Nothing yet. What sync does shows here: passes that changed something, snapshots, restores, computers joining, and errors. The list starts again when the window is opened.",
            ),
          )
        : card(...logRows(kit, log)),
    ),
  ];
}

/** The pages with something that writes to the account: they say why it can't be done. */
const LAPSED_PAGES: readonly SyncPageId[] = [
  "overview",
  "projects",
  "computers",
  "security",
  "storage",
];

/** A page's content: sections of cards under the page's title. */
export function drawPage(kit: PageKit, page: SyncPageId, status: SyncStatus): Child[] {
  const content = pageContent(kit, page, status);
  if (!kit.lapsed || !LAPSED_PAGES.includes(page)) return content;
  const until = lapsedUntil(kit.session.profile.peek(), status);
  return [section(null, lapsedCallout(kit, until)), ...content];
}

function pageContent(kit: PageKit, page: SyncPageId, status: SyncStatus): Child[] {
  switch (page) {
    case "projects":
      return projectsPage(kit, status);
    case "content":
      return contentPage(kit);
    case "team":
      return teamPage(kit);
    case "computers":
      return computersPage(kit, status);
    case "security":
      return securityPage(kit, status);
    case "storage":
      return storagePage(kit, status);
    case "activity":
      return activityPage(kit);
    default:
      return overviewPage(kit, status);
  }
}
