// Inside a snapshot: its facts, how its files stand against the open folder in one sentence, a
// filter when there are many, and the files as rows, what differs first. A row opens that file
// (beside the folder's in a diff tab, where there is a folder to compare with) and can restore
// that one file. Every button runs a command; typing in the filter redraws the rows only. The
// words, the order and the counts are in snapshotView.model.ts.
//
// The panel draws from a `SnapshotSource`: where the snapshot is from and what its buttons do.
// Two places use it: the Projects page, in place of the snapshot history, for a snapshot of the
// open project (`snapshotPanel`, below; snapshotView.commands.ts and commands.ts), and the Team
// page for a snapshot a teammate shared (shareView.ts), which is read only and is compared with
// the open folder only when that folder is the same project.
import { type Child, h, on } from "../../core/dom/index";
import type { SnapshotSummary } from "../../core/ipc/sync";
import { icon } from "../../ui/Icon";
import type { SnapshotRow } from "./controller";
import { formatSize, pinState, snapshotFacts } from "./model";
import { body, card, empty, item, type PageKit } from "./pages";
import {
  canRestore,
  FILTER_FROM,
  filterFiles,
  matchLine,
  moreLine,
  type OpenedSnapshot,
  plainLabel,
  type SnapshotFileRow,
  type SnapshotLook,
  shownFiles,
  skippedNote,
  splitPath,
  stateLabel,
  summaryLine,
  truncatedNote,
} from "./snapshotView.model";

/** Where a snapshot being looked at is from, and what the panel's buttons do. */
export interface SnapshotSource {
  /** The snapshot's id: the panel is marked with it. */
  id: string;
  summary: SnapshotSummary;
  /** What is kept of the snapshot while it is looked at: how far it is read, its files. */
  look: SnapshotLook;
  /** The head's title ("Snapshot from this computer") and its tags. */
  title: string;
  tags: readonly string[];
  /** The way back, above the head. */
  back: { label: string; go(): void };
  /** Reads the files again (and compares them again, where they are compared). */
  reload(): unknown;
  /** Opens one file. */
  open(path: string): unknown;
  /** Restores one file into the folder; null where nothing is restored (a teammate's share). */
  restoreFile: ((path: string) => unknown) | null;
  /** The head's buttons, after "again". */
  actions: readonly Child[];
  /** Lines under the list (what holds for the whole snapshot). */
  notes: readonly (string | null)[];
}

/** One file of the snapshot: its name and folder, how it stands, its size, and Restore. */
function fileRow(
  file: SnapshotFileRow,
  waiting: boolean,
  compared: boolean,
  restores: boolean,
): HTMLElement {
  const { name, dir } = splitPath(file.path);
  const words: Child[] = [
    h("span", { class: "sync-look-name" }, name),
    dir ? h("span", { class: "sync-look-dir" }, dir) : null,
  ];
  // Deleted in the snapshot and gone from the folder (or no folder to look in): nothing to show.
  const nothing = file.deleted && (!compared || file.state === "same");
  const restorable = restores && compared && canRestore(file);
  // There on every row, so the columns line up; hidden where the file can't be restored alone.
  const restore = restores
    ? h(
        "button",
        {
          class: `button button-ghost button-sm sync-look-restore${restorable ? "" : " is-none"}`,
          type: "button",
          ...(restorable
            ? { "data-restore": file.path, "aria-label": `Restore ${file.path}` }
            : { "aria-hidden": "true", tabindex: "-1" }),
        },
        "Restore",
      )
    : null;
  if (restore) restore.disabled = waiting || !restorable;
  const label = compared ? stateLabel(file) : plainLabel(file);
  return h(
    "div",
    {
      class: "sync-item sync-look-file",
      "data-path": file.path,
      // Uncompared rows have no standing: none is said, and none recedes.
      ...(compared && { "data-state": file.state }),
      ...(file.deleted && { "data-deleted": "" }),
    },
    nothing
      ? h("span", { class: "sync-look-open", title: file.path }, ...words)
      : h(
          "button",
          {
            class: "sync-look-open",
            type: "button",
            "data-open": file.path,
            title: `${file.path}\n${compared ? "Compare with this folder" : "Open, read only"}`,
          },
          ...words,
        ),
    label ? h("span", { class: "sync-look-state" }, label) : null,
    h("span", { class: "sync-file-size" }, file.deleted ? "" : formatSize(file.size)),
    restore,
  );
}

/** A snapshot, opened (`opened` says how far its files are read), as `source` describes it. */
export function drawSnapshot(
  kit: PageKit,
  source: SnapshotSource,
  opened: OpenedSnapshot,
): Child[] {
  const { summary, look } = source;
  const { compared } = opened;
  const waiting = kit.session.working.peek() !== null;

  const back = h(
    "button",
    { class: "ai-link sync-look-back", type: "button" },
    icon("arrow-left"),
    source.back.label,
  );
  kit.drawn.add(on(back, "click", () => source.back.go()));

  const againLabel = compared ? "Compare with this folder again" : "Read the snapshot again";
  const again = h(
    "button",
    { class: "icon-button", type: "button", title: againLabel, "aria-label": againLabel },
    icon("refresh-cw"),
  );
  again.disabled = waiting || opened.refreshing || opened.phase === "loading";
  kit.drawn.add(on(again, "click", () => void source.reload()));

  const counts = opened.counts;
  const reading = compared ? "Comparing with this folder…" : "Reading the snapshot…";
  const standing =
    opened.phase === "error"
      ? null
      : counts === null
        ? reading
        : `${summaryLine(counts, compared)}${opened.refreshing ? (compared ? " · comparing again…" : " · reading again…") : ""}`;
  const head = card(
    item({
      title: source.title,
      tags: source.tags,
      details: [
        [new Date(summary.time).toLocaleString(), summary.branch]
          .filter(Boolean)
          .concat(snapshotFacts(summary.files, summary.bytes))
          .join(" · "),
        standing === null ? null : h("span", { class: "sync-look-summary" }, standing),
        counts === null || !compared ? null : truncatedNote(counts, opened.truncated),
      ],
      attrs: { "data-look-head": opened.phase },
      actions: [again, ...source.actions],
    }),
  );

  let content: Child[];
  if (opened.phase === "error") {
    content = [
      card(
        body(
          h(
            "p",
            { class: "sync-text", role: "alert" },
            `The snapshot's files couldn't be read. ${opened.error ?? ""}`.trim(),
          ),
          h(
            "div",
            { class: "sync-actions" },
            kit.button("Try again", () => source.reload()),
          ),
        ),
      ),
    ];
  } else if (counts === null) {
    content = [
      card(
        empty(
          compared
            ? "Reading the snapshot and comparing it with this folder…"
            : "Reading the snapshot…",
        ),
      ),
    ];
  } else if (counts.total === 0) {
    content = [card(empty(summaryLine(counts, compared)))];
  } else {
    const total = counts.total;
    const list = h("div", { class: "settings-card sync-card sync-look-files", role: "list" });
    const foot = h("div", { class: "sync-section-foot sync-look-foot", role: "status" });
    const restores = source.restoreFile !== null;
    const fill = () => {
      const filtering = look.filter.trim() !== "";
      const matched = filterFiles(look.files, look.filter);
      const { rows, more } = shownFiles(matched);
      list.replaceChildren(
        ...(rows.length === 0
          ? [empty(matchLine(0, total))]
          : rows.map((file) => fileRow(file, waiting, compared, restores))),
      );
      const words = [
        filtering && matched.length > 0 ? matchLine(matched.length, total) : null,
        more > 0 ? moreLine(more) : null,
      ].filter(Boolean);
      foot.textContent = words.join(" · ");
      foot.hidden = words.length === 0;
    };
    fill();
    // One listener for every row: the rows are drawn again as the filter is typed.
    kit.drawn.add(
      on(list, "click", (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const restore = target?.closest<HTMLButtonElement>("[data-restore]");
        if (restore) {
          const path = restore.dataset.restore;
          if (!restore.disabled && path) void source.restoreFile?.(path);
          return;
        }
        const path = target?.closest<HTMLElement>("[data-open]")?.dataset.open;
        if (path) void source.open(path);
      }),
    );
    let filter: HTMLInputElement | null = null;
    if (total > FILTER_FROM) {
      const box = h("input", {
        class: "input sync-look-filter",
        type: "text",
        placeholder: "Filter files",
        "aria-label": "Filter the snapshot's files",
        spellcheck: "false",
        autocomplete: "off",
        // The tab gives a field with this its caret back after a redraw.
        "data-field": "snapshot-filter",
      });
      box.value = look.filter;
      kit.drawn.add(
        on(box, "input", () => {
          look.filter = box.value;
          fill();
        }),
      );
      filter = box;
    }
    content = [filter, list, foot];
  }
  const notes =
    opened.phase === "ready"
      ? [skippedNote(look.skipped), ...source.notes]
          .filter(Boolean)
          .map((note) => h("div", { class: "sync-section-foot" }, note))
      : [];

  return [
    h(
      "div",
      {
        class: "sync-look",
        "data-snapshot-look": source.id,
        "data-phase": opened.phase,
        "data-compared": String(compared),
      },
      h("div", { class: "sync-look-nav" }, back),
      head,
      ...content,
      ...notes,
    ),
  ];
}

/**
 * A snapshot of the open project, opened: what the Projects page shows under the project's head
 * instead of the snapshot history. Its files stand against the open folder; a row opens the
 * file's diff and can restore that one file, and Restore all brings the folder to the snapshot.
 */
export function snapshotPanel(
  kit: PageKit,
  row: SnapshotRow,
  opened: OpenedSnapshot,
  deviceId: string | null,
): Child[] {
  const { summary } = row;
  const look = kit.session.look;
  const computer = summary.device === deviceId ? "this computer" : summary.deviceName;
  const pinned = pinState(summary.pinned, row.keep);
  return drawSnapshot(
    kit,
    {
      id: row.id,
      summary,
      look,
      title: `Snapshot from ${computer}`,
      tags: pinned.tag ? [pinned.tag] : [],
      back: { label: "Snapshot history", go: () => look.close() },
      reload: () => kit.run("sync.snapshot.view", { id: row.id }),
      open: (path) => kit.run("sync.snapshot.openDiff", { id: row.id, path }),
      restoreFile: (path) => kit.run("sync.snapshot.restoreFile", { id: row.id, path }),
      actions: [
        kit.button(
          "Restore all…",
          () => kit.run("sync.snapshot.restore", { id: row.id }),
          "secondary",
          "archive-restore",
        ),
      ],
      notes: [
        summary.kind === "git" && (opened.counts?.total ?? 0) > 0
          ? "A git project's snapshot lists the files that differed from its commit. Restore all also checks out that commit and its branch."
          : null,
      ],
    },
    opened,
  );
}
