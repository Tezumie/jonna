// The Sync tab's pages while sync is on (D435): overview, projects, settings and files,
// computers, security and privacy, storage, activity. Each is a few cards built from the
// controller's signals; every button runs a command or moves within the tab through the kit the
// view hands over (view.ts). The words and the numbers come from model.ts.
import { type Child, h, on } from "../../core/dom/index";
import type { SyncDevice, SyncStatus } from "../../core/ipc/sync";
import type { DisposableStore } from "../../core/lifecycle/index";
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
  type OverviewProject,
  overviewTiles,
  platformLabel,
  projectCounts,
  retentionText,
  SERVICE_CAN_SEE,
  SERVICE_CANT_READ,
  type SyncEvent,
  type SyncPageId,
  serviceTime,
  snapshotFacts,
  snapshotSize,
  storageByProject,
  storageNotice,
  storageShare,
  timeOfDay,
} from "./model";
import type { SyncSession } from "./session";

/** What the pages need of the view: its builders, and the two ways a button acts. */
export interface PageKit {
  readonly services: WorkbenchServices;
  readonly controller: SyncController;
  readonly session: SyncSession;
  /** The listeners of what is drawn now. */
  readonly drawn: DisposableStore;
  /** Runs a command; a failure is shown as a notification. */
  run(id: string, input?: unknown): Promise<unknown>;
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
function section(title: string | null, ...children: Child[]): HTMLElement {
  return h(
    "section",
    { class: "sync-section" },
    title ? h("h2", { class: "settings-section-title" }, title) : null,
    ...children,
  );
}

function card(...children: Child[]): HTMLElement {
  return h("div", { class: "settings-card sync-card" }, ...children);
}

/** Free content in a card, with the card's padding. */
function body(...children: Child[]): HTMLElement {
  return h("div", { class: "sync-card-body" }, ...children);
}

/** What a card says when it has nothing to list, and what to do about it. */
function empty(words: string): HTMLElement {
  return h("div", { class: "sync-card-body sync-empty" }, words);
}

interface ItemParts {
  title: Child;
  tags?: readonly string[];
  details?: readonly Child[];
  actions?: readonly Child[];
  attrs?: Record<string, string>;
  /** Shown under the text, the row's whole width (a code to compare, a list that opens). */
  below?: readonly Child[];
}

/** A row of a card: a title with tags, muted lines under it, actions at the end. */
function item(parts: ItemParts): HTMLElement {
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
  const line = activityLine(activity);
  const glyph: IconName = failed
    ? "circle-alert"
    : activity.state === "syncing"
      ? "refresh-cw"
      : activity.state === "idle" && activity.at !== null
        ? "circle-check"
        : activity.state === "blocked"
          ? "key-round"
          : "cloud";
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
    ),
    kit.button(
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
      h("span", { class: "sync-stat-label" }, "Storage"),
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
        linkable
          ? kit.link("This folder is one of my synced projects…", () =>
              kit.run("sync.project.link"),
            )
          : null,
      ],
      attrs: { "data-open-project": "off" },
      actions: [kit.button("Sync this project", () => kit.run("sync.project.enable"), "primary")],
    }),
  );
}

function snapshotRow(kit: PageKit, row: SnapshotRow, deviceId: string | null): HTMLElement {
  const { summary } = row;
  const pinned = summary.pinned;
  const pin = h(
    "button",
    {
      class: `icon-button sync-pin${pinned ? " is-on" : ""}`,
      type: "button",
      "aria-pressed": pinned ? "true" : "false",
      "aria-label": pinned ? `Unpin ${pinned}` : "Pin this snapshot",
      title: pinned ? "Unpin" : "Pin: keep it whatever its age",
    },
    icon(pinned ? "pin-off" : "pin"),
  );
  const togglePin = () =>
    kit.run("sync.snapshot.pin", pinned ? { id: row.id, name: null } : { id: row.id });
  kit.drawn.add(on(pin, "click", () => void togglePin()));
  const items: MenuItem[] = [
    {
      label: "Restore…",
      icon: "archive-restore",
      run: () => void kit.run("sync.snapshot.restore", { id: row.id }),
    },
    {
      label: "Show files…",
      icon: "files",
      run: () => void kit.run("sync.snapshot.restoreFile", { id: row.id }),
    },
    {
      label: pinned ? "Unpin" : "Pin…",
      icon: pinned ? "pin-off" : "pin",
      run: () => void togglePin(),
    },
    {
      label: "Delete…",
      icon: "trash-2",
      destructive: true,
      separatorBefore: true,
      run: () => void kit.run("sync.snapshot.delete", { id: row.id }),
    },
  ];
  const computer = summary.device === deviceId ? "This computer" : summary.deviceName;
  const facts = `${computer} · ${snapshotFacts(summary.files, summary.bytes)}`;
  const full = [new Date(summary.time).toLocaleString(), summary.branch, facts]
    .filter(Boolean)
    .join(" · ");
  return h(
    "div",
    { class: "sync-item sync-snapshot", "data-snapshot": row.id },
    h("span", { class: "sync-snapshot-time", title: full }, timeOfDay(summary.time)),
    h(
      "div",
      { class: "sync-snapshot-main" },
      h("span", { class: "sync-snapshot-facts", title: full }, facts),
      pinned ? h("span", { class: "ai-tag sync-pin-name", title: pinned }, pinned) : null,
    ),
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

/** One project: its name and folder, its numbers, and (the open folder's) its history. */
function projectDetail(kit: PageKit, project: OverviewProject, status: SyncStatus): HTMLElement {
  const { controller, services } = kit;
  const open = controller.project.peek();
  const isOpen = !!open?.on && open.id === project.id;
  const menu: MenuItem[] = [
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
    {
      label: "Delete from the account…",
      icon: "trash-2",
      destructive: true,
      separatorBefore: isOpen,
      run: () => void kit.run("sync.project.deleteFromAccount", { id: project.id }),
    },
  ];
  const where = changedOn(project);
  const head = h(
    "div",
    { class: "settings-card sync-card" },
    h(
      "div",
      { class: "sync-detail-head" },
      h(
        "div",
        { class: "sync-item-main" },
        h(
          "div",
          { class: "sync-item-title" },
          h("h3", { class: "sync-detail-title", title: project.name }, project.name),
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
          ? kit.button(
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
            kit.button(`The open folder is ${project.name}`, () =>
              kit.run("sync.project.link", { id: project.id }),
            ),
          )
        : null,
    ];
  }

  return h(
    "div",
    { class: "sync-detail", "data-project-detail": project.id },
    backLink(kit),
    head,
    ...rest,
  );
}

/** Back to the list, where the detail takes the list's place (a narrow tab). */
function backLink(kit: PageKit): HTMLElement {
  const el = h(
    "button",
    { class: "ai-link sync-back", type: "button" },
    icon("arrow-left"),
    "All projects",
  );
  kit.drawn.add(on(el, "click", () => kit.go("projects", null)));
  return el;
}

function projectsPage(kit: PageKit, status: SyncStatus): Child[] {
  const { controller, session } = kit;
  const projects = controller.overview.peek().projects;
  const open = controller.project.peek();
  // The open folder's project is a row of the list (marked, and the one shown at first); the
  // folder gets a card of its own only while it doesn't sync.
  const openId = open?.on ? open.id : null;
  const chosen = projects.find((p) => p.id === session.projectId.peek()) ?? null;
  const shown = chosen ?? projects.find((p) => p.id === openId) ?? projects[0] ?? null;

  const rows = projects.map((project) => {
    const el = h(
      "button",
      {
        class: `sync-item sync-pick sync-project-row${project === shown ? " is-selected" : ""}`,
        type: "button",
        "data-project": project.id,
        ...(project === shown && { "aria-current": "true" }),
      },
      h(
        "div",
        { class: "sync-item-main" },
        h(
          "div",
          { class: "sync-item-title" },
          h("span", { class: "sync-item-name", title: project.name }, project.name),
          h("span", { class: "ai-tag" }, placeTag(project)),
        ),
        h(
          "div",
          { class: "sync-item-detail sync-one-line" },
          projectCounts(project),
          project.lastChange === null ? null : " · changed ",
          project.lastChange === null ? null : kit.when(project.lastChange),
        ),
      ),
      project.id === openId ? h("span", { class: "sync-open-here" }, "Open here") : null,
      icon("chevron-right"),
    );
    kit.drawn.add(on(el, "click", () => kit.go("projects", project.id)));
    return el;
  });

  return [
    open && !open.on ? section("This folder", notSyncedCard(kit, open.root, open.known)) : null,
    continueCallout(kit),
    section(
      "All projects",
      projects.length === 0
        ? card(
            empty(
              open
                ? "No projects yet. A project syncs once you choose Sync this project."
                : "No projects yet. Open a folder and choose Sync this project: its chats travel with you, and snapshots of unfinished work are taken automatically.",
            ),
          )
        : h(
            "div",
            { class: `sync-md${chosen ? " is-chosen" : ""}` },
            h("div", { class: "settings-card sync-card sync-md-list" }, ...rows),
            shown ? projectDetail(kit, shown, status) : null,
          ),
    ),
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
            "Settings that run programs or point at paths on this computer don't sync.",
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
        ? kit.button(
            "Check code",
            () => kit.run("sync.reviewDevice", { device: device.id }),
            "primary",
          )
        : null,
      checking
        ? kit.button(
            "Approve",
            () => kit.run("sync.approveDevice", { device: device.id }),
            "primary",
          )
        : null,
      device.current
        ? null
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
          actions: [kit.button("Make a new recovery key", () => kit.run("sync.newRecoveryKey"))],
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
        ),
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

/** A page's content: sections of cards under the page's title. */
export function drawPage(kit: PageKit, page: SyncPageId, status: SyncStatus): Child[] {
  switch (page) {
    case "projects":
      return projectsPage(kit, status);
    case "content":
      return contentPage(kit);
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
