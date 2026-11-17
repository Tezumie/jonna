// The Sync tab's Team page: what the account's team shares (its library), which of it is on
// here, and, for a publisher, the way to publish. The library is the team extension's; this
// page reads its state (ide://team) and runs its commands through the dispatcher, and imports
// nothing from it. The state tree isn't reactive, so `TeamLibraryReader` reads it again when
// something says it may have moved (below) and the tab draws from the reader's signals. The
// words and the rows come from teamPage.model.ts. The page's parts about sharing projects
// (People, Shared projects, and a shared project opened in place of the page) are shareView.ts.
import { type Child, h, on } from "../../core/dom/index";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { effect, type Signal, signal } from "../../core/reactive/index";
import { activeTeam } from "../../core/team/source";
import { icon } from "../../ui/Icon";
import type { MenuItem } from "../../ui/Menu";
import type { WorkbenchServices } from "../../workbench/services";
import { teamOf } from "./model";
import { body, card, empty, item, manageTeam, type PageKit, section } from "./pages";
import type { SyncSession } from "./session";
import { sharePanel, sharingSections } from "./shareView";
import {
  emptyLibraryWords,
  filterGroups,
  hasFilter,
  lapsedLibraryLine,
  modeActions,
  modeTag,
  NO_LIBRARY,
  requiredWords,
  roleWords,
  rowFacts,
  TEAM_INVITED,
  TEAM_PRECEDENCE,
  TEAM_PURPOSE,
  TEAM_START,
  type TeamAbilities,
  type TeamLibrary,
  type TeamRow,
  teamAbilities,
  teamGroups,
  teamLibraryOf,
  toggleCommand,
} from "./teamPage.model";

/** While the Team page is the one shown, the state is read again this often (no network). */
const REREAD_MS = 3_000;
/** Enough for a library at its limit (500 items): the state is never cut short for the page. */
const STATE_BUDGET = 1_000_000;

/** An item's text for its preview: being read, read, or why it couldn't be. */
export type TeamPreview =
  | { state: "reading" }
  | { state: "read"; text: string }
  | { state: "failed"; why: string };

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The team's library as the Team page shows it: `ide://team` as last read, and the texts of the
 * items whose preview was opened. It reads the state again after a team command ran, when the
 * account or the applied library changed, when the Team page is shown, and every few seconds
 * while it is (the team extension also refreshes by itself, which nothing announces).
 */
export class TeamLibraryReader implements Disposable {
  readonly library: Signal<TeamLibrary> = signal<TeamLibrary>(NO_LIBRARY, sameJson);
  /** Moves when a preview's text arrived (or failed): the tab draws again. */
  readonly previews: Signal<number> = signal(0);
  /** What is typed in the page's filter box: kept through redraws, gone with the tab. */
  filter = "";
  private readonly store = new DisposableStore();
  /** By item id and version: a newer version is read again. */
  private readonly texts = new Map<string, TeamPreview>();
  private disposed = false;

  constructor(
    private readonly services: WorkbenchServices,
    session: SyncSession,
  ) {
    this.store.add(
      effect(() => {
        // The account (signed in or out, another team), what of the library applies here.
        void session.profile.value;
        void activeTeam.value;
        const shown = session.page.value === "team";
        void this.read();
        if (!shown) return undefined;
        const timer = setInterval(() => void this.read(), REREAD_MS);
        return () => clearInterval(timer);
      }),
    );
    this.store.add(
      services.events.on("command.executed", (event) => {
        const { id } = event;
        if (
          (id.startsWith("team.") && id !== "team.readItem") ||
          id === "accounts.signIn" ||
          id === "accounts.signOut" ||
          id === "sync.checkPlan"
        )
          void this.read();
      }),
    );
  }

  /** Whether the build has teams' libraries: the team extension is there. */
  available(): boolean {
    return this.services.dispatcher.has("team.refresh") && this.services.state.has("ide://team");
  }

  /** Reads `ide://team` again; the signal moves only when something in it changed. */
  async read(): Promise<void> {
    if (this.disposed || !this.available()) return;
    const snap = await this.services.state
      .get("ide://team", { budget: STATE_BUDGET })
      .catch(() => null);
    if (this.disposed || !snap) return;
    const library = teamLibraryOf(snap.value);
    this.library.value = library;
    // Texts of versions that are gone aren't kept.
    const live = new Set(library.items.map((entry) => `${entry.id}@${entry.version}`));
    for (const key of [...this.texts.keys()]) if (!live.has(key)) this.texts.delete(key);
  }

  private keyOf(id: string): string | null {
    const found = this.library.peek().items.find((entry) => entry.id === id);
    return found ? `${id}@${found.version}` : null;
  }

  /** An item's text as far as it is known (undefined: not asked for yet). */
  preview(id: string): TeamPreview | undefined {
    const key = this.keyOf(id);
    return key === null ? undefined : this.texts.get(key);
  }

  /**
   * Reads an item's text for its preview (`team.readItem`: from this computer, no network).
   * `again`: one that couldn't be read is asked for again (the preview was opened again).
   */
  want(id: string, again = false): void {
    const key = this.keyOf(id);
    if (key === null || this.disposed) return;
    const known = this.texts.get(key);
    if (known && !(again && known.state === "failed")) return;
    this.texts.set(key, { state: "reading" });
    const done = (preview: TeamPreview) => {
      if (this.disposed || !this.texts.has(key)) return;
      this.texts.set(key, preview);
      this.previews.value = this.previews.peek() + 1;
    };
    this.services.dispatcher.execute("team.readItem", { id }).then(
      (result) => {
        const text =
          result && typeof result === "object" && "text" in result ? result.text : undefined;
        done(
          typeof text === "string"
            ? { state: "read", text }
            : { state: "failed", why: "Its text couldn't be read." },
        );
      },
      (err: unknown) =>
        done({ state: "failed", why: err instanceof Error ? err.message : String(err) }),
    );
  }

  /** Forgets what couldn't be read, so the next look asks again (after a refresh). */
  retryFailed(): void {
    for (const [key, preview] of [...this.texts])
      if (preview.state === "failed") this.texts.delete(key);
  }

  dispose(): void {
    this.disposed = true;
    this.store.dispose();
  }
}

// ------------------------------------------------------------ the page

function refresh(kit: PageKit): HTMLButtonElement {
  return kit.button(
    "Refresh",
    () => {
      kit.team.retryFailed();
      return kit.run("team.refresh");
    },
    "secondary",
    "refresh-cw",
  );
}

/** Not in a team: what one is for, and the way to one. */
function notInTeam(kit: PageKit): Child[] {
  // An account whose own subscription ended can't start a team: it can be invited to one.
  const subscriber = !kit.lapsed;
  return [
    section(
      null,
      h(
        "div",
        { class: "settings-card sync-card", "data-team-page": "none" },
        body(
          kit.text(TEAM_PURPOSE),
          kit.text(subscriber ? TEAM_START : TEAM_INVITED, true),
          subscriber ? h("div", { class: "sync-actions" }, manageTeam(kit)) : null,
        ),
      ),
    ),
  ];
}

/** The team's name, this account's part in it, when the library was read, and what to do. */
function headCard(kit: PageKit, library: TeamLibrary, abilities: TeamAbilities): HTMLElement {
  const team = library.team;
  if (!team) return card();
  return h(
    "div",
    {
      class: "settings-card sync-card sync-team-head",
      "data-team-page": team.role,
      "data-publisher": String(team.publisher),
      "data-library": library.state ?? "none",
    },
    item({
      title: team.name,
      details: [
        roleWords(team),
        library.lastRefresh === null
          ? "The library hasn't been read from the service yet."
          : ["Refreshed ", kit.when(library.lastRefresh)],
        // Said plainly, in the lines' own color: what is on this computer keeps applying.
        library.problem,
        abilities.lapsed ? lapsedLibraryLine(team.role === "owner") : null,
      ],
      actions: [
        abilities.publish
          ? kit.button("Publish…", () => kit.run("sync.team.publish"), "primary", "upload")
          : null,
        refresh(kit),
        manageTeam(kit),
      ],
    }),
  );
}

/** What a row's preview shows: the item's text, and a skill's other files by name. */
function previewOf(kit: PageKit, row: TeamRow): HTMLElement {
  const preview = kit.team.preview(row.id);
  const text =
    preview?.state === "read"
      ? h(
          "pre",
          // Focusable, so its own scroll is reachable from the keyboard.
          { class: "sync-team-text", tabindex: "0", "aria-label": `${row.path}, read only` },
          preview.text,
        )
      : h(
          "div",
          { class: "sync-item-detail" },
          preview?.state === "failed" ? preview.why : "Reading…",
        );
  return h(
    "div",
    { class: "sync-team-preview" },
    row.kind === "skills" ? h("div", { class: "sync-item-detail" }, row.path) : null,
    text,
    row.others.length === 0
      ? null
      : h(
          "div",
          { class: "sync-team-others" },
          h("div", { class: "sync-item-detail" }, "Also in this skill"),
          h(
            "div",
            { class: "sync-files" },
            ...row.others.map((name) =>
              h(
                "div",
                { class: "sync-file" },
                h("span", { class: "sync-file-path", title: name }, name),
              ),
            ),
          ),
        ),
  );
}

/** A required row has no switch: a lock, and why, in its place. */
function alwaysOn(row: TeamRow): HTMLElement {
  const why = requiredWords(row.kind);
  return h(
    "span",
    {
      class: "sync-team-switch sync-team-locked",
      role: "note",
      title: why,
      "aria-label": `Always on. ${why}`,
      "data-team-locked": "",
    },
    icon("lock"),
    h("span", { class: "sync-check-label" }, "Always on"),
  );
}

function libraryRow(kit: PageKit, row: TeamRow, abilities: TeamAbilities): HTMLElement {
  const working = kit.session.working.peek() !== null;
  let state: HTMLElement;
  if (row.mode === "required" && row.switchable) state = alwaysOn(row);
  else {
    const box = h("input", {
      class: "checkbox",
      type: "checkbox",
      "aria-label": `${row.name}: on for you on this computer`,
    });
    box.checked = row.on;
    box.disabled = working || !row.switchable || !abilities.choose;
    kit.drawn.add(
      on(box, "change", () => void kit.run(toggleCommand(row, box.checked), { id: row.id })),
    );
    state = h(
      "label",
      { class: "sync-check sync-team-switch" },
      box,
      h("span", { class: "sync-check-label" }, row.on ? "On" : "Off"),
    );
  }

  const menu: MenuItem[] = [];
  // Who it is on for is the owner's to say; a member who can publish only removes.
  if (abilities.decide && row.switchable)
    for (const action of modeActions(row.mode))
      menu.push({
        label: action.label,
        ...(action.mode === "required" && { icon: "lock" as const }),
        run: () => void kit.run("team.setMode", { id: row.id, mode: action.mode }),
      });
  if (abilities.publish) {
    menu.push({
      label: "Remove from the library…",
      icon: "trash-2",
      destructive: true,
      separatorBefore: menu.length > 0,
      run: () => void kit.run("team.unpublish", { id: row.id }),
    });
  }

  const details = kit.details(
    `team:${row.id}`,
    [h("span", { class: "sync-details-label" }, "Preview")],
    previewOf(kit, row),
  );
  // Open (now, or left open before a redraw): its text is read once.
  const isOpen = () => details instanceof HTMLDetailsElement && details.open;
  if (isOpen()) kit.team.want(row.id);
  kit.drawn.add(
    on(details, "toggle", () => {
      if (isOpen()) kit.team.want(row.id, true);
    }),
  );

  const tag = modeTag(row.mode);
  return item({
    title: row.name,
    tags: row.switchable ? (tag === null ? [] : [tag]) : ["No SKILL.md"],
    details: [
      [
        rowFacts(row),
        row.updatedAt === null ? null : " · ",
        row.updatedAt === null ? null : kit.when(row.updatedAt),
      ],
      row.switchable
        ? null
        : "Without a SKILL.md in the library these files aren't a skill: they are never on.",
    ],
    attrs: {
      class: "sync-item sync-team-item",
      "data-team-item": row.id,
      "data-kind": row.kind,
      "data-on": String(row.on),
      "data-mode": row.mode,
    },
    below: [details],
    actions: [
      state,
      menu.length > 0 ? kit.menuButton(`More for ${row.name}`, menu, "Library item") : null,
    ],
  });
}

/** The Team page: the team, then its library by kind. */
export function teamPage(kit: PageKit): Child[] {
  const library = kit.team.library.peek();
  const inTeam = teamOf(kit.session.profile.peek()) !== null;
  // A teammate's shared project, opened: it takes the page until it is left.
  const opened = kit.session.shares.opened.peek();
  if (opened && inTeam) return sharePanel(kit, opened);
  // What the team's members share, and the members: above the library, which can be long.
  const sharing = sharingSections(kit);
  if (!library.team) {
    // The account says it is in a team and the library isn't read yet (or couldn't be).
    if (inTeam)
      return [
        section(
          null,
          h(
            "div",
            { class: "settings-card sync-card", "data-team-page": "reading" },
            item({
              title: "Your team's library",
              details: [library.problem ?? "It hasn't been read on this computer yet."],
              actions: [refresh(kit), manageTeam(kit)],
            }),
          ),
        ),
        ...sharing,
      ];
    return notInTeam(kit);
  }
  const abilities = teamAbilities(library, kit.lapsed);
  const groups = teamGroups(library.items);
  const head = section(
    null,
    h("p", { class: "sync-section-note", "data-team-precedence": "" }, TEAM_PRECEDENCE),
    headCard(kit, library, abilities),
  );
  if (groups.length === 0)
    return [
      head,
      ...sharing,
      section("Library", card(empty(emptyLibraryWords(abilities.publish)))),
    ];

  // Every row is built once; the filter only chooses which of them their cards hold, so a
  // preview left open and the box being typed in stay as they are.
  const parts = groups.map((group) => {
    const rows = new Map(group.rows.map((row) => [row.id, libraryRow(kit, row, abilities)]));
    const list = card();
    const el = h(
      "section",
      { class: "sync-section", "data-team-kind": group.kind },
      h("h2", { class: "settings-section-title" }, group.heading),
      group.note ? h("p", { class: "sync-section-note" }, group.note) : null,
      list,
    );
    return { kind: group.kind, rows, list, el };
  });
  const none = section(null, card(empty("Nothing matches. Clear the filter to see everything.")));
  none.setAttribute("data-team-filter", "none");
  const filtered = hasFilter(groups);
  const show = () => {
    const shown = filterGroups(groups, filtered ? kit.team.filter : "");
    for (const part of parts) {
      const rows = shown.find((group) => group.kind === part.kind)?.rows ?? [];
      part.list.replaceChildren(...rows.flatMap((row) => part.rows.get(row.id) ?? []));
      part.el.hidden = rows.length === 0;
    }
    none.hidden = shown.length > 0;
  };
  show();
  return [
    head,
    ...sharing,
    filtered ? filterBox(kit, show) : null,
    ...parts.map((part) => part.el),
    none,
  ];
}

/** The filter above a long library: by name and kind, as it is typed. */
function filterBox(kit: PageKit, changed: () => void): HTMLElement {
  const input = h("input", {
    class: "input settings-search-input",
    type: "search",
    placeholder: "Filter by name or kind",
    "aria-label": "Filter the team's library by name or kind",
    spellcheck: "false",
    autocomplete: "off",
    // The view keeps the caret of a field so named through a redraw.
    "data-field": "team-filter",
  });
  input.value = kit.team.filter;
  kit.drawn.add(
    on(input, "input", () => {
      kit.team.filter = input.value;
      changed();
    }),
  );
  kit.drawn.add(
    on(input, "keydown", (event) => {
      if (event.key !== "Escape" || input.value === "") return;
      event.stopPropagation();
      input.value = "";
      kit.team.filter = "";
      changed();
    }),
  );
  return h("div", { class: "settings-search sync-team-filter" }, icon("search"), input);
}
