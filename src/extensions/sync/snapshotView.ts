// Inside a snapshot, on the Projects page in place of the snapshot history: its facts, how its
// files stand against the open folder in one sentence, a filter when there are many, and the
// files as rows, what differs first. A row opens that file beside the folder's in a diff tab and
// can restore that one file; Restore all brings the folder to the snapshot. Every button runs a
// command (snapshotView.commands.ts and commands.ts); typing in the filter redraws the rows
// only. The words, the order and the counts are in snapshotView.model.ts.
import { type Child, h, on } from "../../core/dom/index";
import { icon } from "../../ui/Icon";
import type { SnapshotRow } from "./controller";
import { formatSize, snapshotFacts } from "./model";
import { body, card, empty, item, type PageKit } from "./pages";
import {
  canRestore,
  FILTER_FROM,
  filterFiles,
  matchLine,
  moreLine,
  type OpenedSnapshot,
  type SnapshotFileRow,
  shownFiles,
  splitPath,
  stateLabel,
  summaryLine,
  truncatedNote,
} from "./snapshotView.model";

/** One file of the snapshot: its name and folder, how it stands, its size, and Restore. */
function fileRow(file: SnapshotFileRow, waiting: boolean): HTMLElement {
  const { name, dir } = splitPath(file.path);
  const words: Child[] = [
    h("span", { class: "sync-look-name" }, name),
    dir ? h("span", { class: "sync-look-dir" }, dir) : null,
  ];
  // Deleted in the snapshot and gone from the folder: nothing to show on either side.
  const nothing = file.deleted && file.state === "same";
  const restorable = canRestore(file);
  // There on every row, so the columns line up; hidden where the file can't be restored alone.
  const restore = h(
    "button",
    {
      class: `button button-ghost button-sm sync-look-restore${restorable ? "" : " is-none"}`,
      type: "button",
      ...(restorable
        ? { "data-restore": file.path, "aria-label": `Restore ${file.path}` }
        : { "aria-hidden": "true", tabindex: "-1" }),
    },
    "Restore",
  );
  restore.disabled = waiting || !restorable;
  return h(
    "div",
    {
      class: "sync-item sync-look-file",
      "data-path": file.path,
      "data-state": file.state,
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
            title: `${file.path}\nCompare with this folder`,
          },
          ...words,
        ),
    h("span", { class: "sync-look-state" }, stateLabel(file)),
    h("span", { class: "sync-file-size" }, file.deleted ? "" : formatSize(file.size)),
    restore,
  );
}

/**
 * The snapshot `row`, opened (`opened` says how far its files are read): what the Projects page
 * shows under the project's head instead of the snapshot history.
 */
export function snapshotPanel(
  kit: PageKit,
  row: SnapshotRow,
  opened: OpenedSnapshot,
  deviceId: string | null,
): Child[] {
  const { summary } = row;
  const look = kit.session.look;
  const waiting = kit.session.working.peek() !== null;
  const view = () => kit.run("sync.snapshot.view", { id: row.id });

  const back = h(
    "button",
    { class: "ai-link sync-look-back", type: "button" },
    icon("arrow-left"),
    "Snapshot history",
  );
  kit.drawn.add(on(back, "click", () => look.close()));

  const again = h(
    "button",
    {
      class: "icon-button",
      type: "button",
      title: "Compare with this folder again",
      "aria-label": "Compare with this folder again",
    },
    icon("refresh-cw"),
  );
  again.disabled = waiting || opened.refreshing || opened.phase === "loading";
  kit.drawn.add(on(again, "click", () => void view()));

  const computer = summary.device === deviceId ? "this computer" : summary.deviceName;
  const counts = opened.counts;
  const standing =
    opened.phase === "error"
      ? null
      : counts === null
        ? "Comparing with this folder…"
        : `${summaryLine(counts)}${opened.refreshing ? " · comparing again…" : ""}`;
  const head = card(
    item({
      title: `Snapshot from ${computer}`,
      tags: summary.pinned ? [summary.pinned] : [],
      details: [
        [new Date(summary.time).toLocaleString(), summary.branch]
          .filter(Boolean)
          .concat(snapshotFacts(summary.files, summary.bytes))
          .join(" · "),
        standing === null ? null : h("span", { class: "sync-look-summary" }, standing),
        counts === null ? null : truncatedNote(counts, opened.truncated),
      ],
      attrs: { "data-look-head": opened.phase },
      actions: [
        again,
        kit.button(
          "Restore all…",
          () => kit.run("sync.snapshot.restore", { id: row.id }),
          "secondary",
          "archive-restore",
        ),
      ],
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
          h("div", { class: "sync-actions" }, kit.button("Try again", view)),
        ),
      ),
    ];
  } else if (counts === null) {
    content = [card(empty("Reading the snapshot and comparing it with this folder…"))];
  } else if (counts.total === 0) {
    content = [card(empty(summaryLine(counts)))];
  } else {
    const total = counts.total;
    const list = h("div", { class: "settings-card sync-card sync-look-files", role: "list" });
    const foot = h("div", { class: "sync-section-foot sync-look-foot", role: "status" });
    const fill = () => {
      const filtering = look.filter.trim() !== "";
      const matched = filterFiles(look.files, look.filter);
      const { rows, more } = shownFiles(matched);
      list.replaceChildren(
        ...(rows.length === 0
          ? [empty(matchLine(0, total))]
          : rows.map((file) => fileRow(file, waiting))),
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
          if (!restore.disabled)
            void kit.run("sync.snapshot.restoreFile", {
              id: row.id,
              path: restore.dataset.restore,
            });
          return;
        }
        const open = target?.closest<HTMLElement>("[data-open]");
        if (open) void kit.run("sync.snapshot.openDiff", { id: row.id, path: open.dataset.open });
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
    content = [
      filter,
      list,
      foot,
      summary.kind === "git"
        ? h(
            "div",
            { class: "sync-section-foot" },
            "A git project's snapshot lists the files that differed from its commit. Restore all also checks out that commit and its branch.",
          )
        : null,
    ];
  }

  return [
    h(
      "div",
      { class: "sync-look", "data-snapshot-look": row.id, "data-phase": opened.phase },
      h("div", { class: "sync-look-nav" }, back),
      head,
      ...content,
    ),
  ];
}
