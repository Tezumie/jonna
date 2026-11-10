// A turn's file changes as one card (D154), instead of a card per file stacking up under the
// work line. The header says what happened ("Changed 10 files +412 −8", or "3 files to review")
// and holds Accept all / Reject all while something waits for review; it opens to one quiet row
// per file (its stats, "new" / "deleted", Open diff, and Accept / Reject while pending). Few
// files waiting for review start open; everything else starts closed.
import { h, on } from "../../../core/dom/index";
import { basename, dirname } from "../../../core/paths/index";
import { fileIcon, icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import type { AgentSession } from "../session";

/** Files waiting for review up to which the card starts open. */
const OPEN_UP_TO = 3;

export interface ChangesHost {
  session: AgentSession;
  root(): string;
  /** A path as the workspace names it (relative; "api/…" in another folder, D251). */
  relative(path: string): string;
  run(command: string, input?: unknown): void;
  /** Open / closed as the user left it (by card id); absent: the default. */
  opened: Map<string, boolean>;
  /** The turn the card is for: a newer turn's proposal of the same file isn't its to accept. */
  turn?: number | undefined;
  rerender(): void;
}

interface Row {
  path: string;
  pending: boolean;
  added: number;
  removed: number;
  created: boolean;
  deleted: boolean;
  /** Its proposal was rejected: nothing was written (no diff to show). */
  rejected?: boolean;
  /** A later turn changed it again (its proposal is reviewed on that turn's card). */
  later?: boolean;
}

/** Line counts per proposal (a full diff: computed once per proposed text, not every frame). */
const stats = new WeakMap<object, { added: number; removed: number }>();

function rows(paths: readonly string[], host: ChangesHost): Row[] {
  const cs = host.session.changeset;
  return paths.map((path) => {
    const file = cs.get(path);
    if (file && host.turn !== undefined && file.turn > host.turn)
      return {
        path,
        pending: false,
        added: 0,
        removed: 0,
        created: false,
        deleted: false,
        later: true,
      };
    if (file) {
      let stat = stats.get(file);
      if (!stat) {
        stat = cs.stat(file);
        stats.set(file, stat);
      }
      return {
        path,
        pending: true,
        ...stat,
        created: file.original === null,
        deleted: file.deleted === true,
      };
    }
    const applied = cs.appliedStat(path, host.turn);
    // Rejected in this card's turn, with nothing of it applied (D160).
    if (!applied && cs.wasRejected(path, host.turn))
      return {
        path,
        pending: false,
        added: 0,
        removed: 0,
        created: false,
        deleted: false,
        rejected: true,
      };
    return {
      path,
      pending: false,
      added: applied?.added ?? 0,
      removed: applied?.removed ?? 0,
      created: applied?.created ?? false,
      deleted: applied?.deleted ?? false,
    };
  });
}

/** What the card depends on (re-rendered only when it changes). */
export function changesSignature(id: string, paths: readonly string[], host: ChangesHost): string {
  const open = host.opened.get(id);
  return `${open ?? ""}|${rows(paths, host)
    .map(
      (r) =>
        `${r.path}:${r.pending ? "p" : r.rejected ? "r" : r.later ? "l" : "a"}:${r.added}/${r.removed}:${r.created}${r.deleted}`,
    )
    .join("|")}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function stat(added: number, removed: number): HTMLElement {
  return h(
    "span",
    { class: "agent-changes-stat" },
    added ? h("span", { class: "is-added" }, `+${added}`) : null,
    added && removed ? " " : null,
    removed ? h("span", { class: "is-removed" }, `−${removed}`) : null,
  );
}

export function renderChanges(
  id: string,
  paths: readonly string[],
  host: ChangesHost,
): HTMLElement {
  const list = rows(paths, host);
  const pending = list.filter((r) => r.pending);
  const added = list.reduce((n, r) => n + r.added, 0);
  const removed = list.reduce((n, r) => n + r.removed, 0);
  const open = host.opened.get(id) ?? (pending.length > 0 && list.length <= OPEN_UP_TO);
  const session = host.session.id;
  // Rejected files are listed (the card doesn't just shrink) but don't count as changed. New
  // files read as created, not changed (D160).
  const done = list.filter((r) => !r.rejected && !r.pending);
  const created = done.filter((r) => r.created).length;
  const edited = done.length - created;
  const rejected = list.filter((r) => r.rejected).length;
  const what = [
    created ? `${edited ? "created" : "Created"} ${plural(created, "file")}` : "",
    edited ? `changed ${plural(edited, "file")}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const did = what ? what.charAt(0).toUpperCase() + what.slice(1) : "";
  const label = pending.length
    ? did
      ? `${did} · ${pending.length} to review`
      : `${plural(pending.length, "file")} to review`
    : did
      ? `${did}${rejected ? ` · ${rejected} rejected` : ""}`
      : `Rejected ${plural(rejected, "change")}`;
  const toggle = h(
    "button",
    { class: "agent-changes-toggle", type: "button", "aria-expanded": String(open) },
    icon("file-diff"),
    h("span", { class: "agent-changes-label" }, label),
    stat(added, removed),
    h("span", { class: "agent-changes-chevron" }, icon(open ? "chevron-down" : "chevron-right")),
  );
  on(toggle, "click", () => {
    host.opened.set(id, !open);
    host.rerender();
  });
  const button = (text: string, cls: string, run: () => void) => {
    const b = h("button", { class: `button ${cls} button-sm`, type: "button" }, text);
    on(b, "click", run);
    return b;
  };
  const pendingPaths = pending.map((r) => r.path);
  const head = h(
    "div",
    { class: "agent-changes-head" },
    toggle,
    pending.length
      ? h(
          "span",
          { class: "agent-changes-actions" },
          button(pending.length > 1 ? "Reject all" : "Reject", "button-ghost", () =>
            host.run("agent.rejectAll", { session, paths: pendingPaths }),
          ),
          button(pending.length > 1 ? "Accept all" : "Accept", "button-accent", () =>
            host.run("agent.acceptAll", { session, paths: pendingPaths }),
          ),
        )
      : null,
  );
  return h(
    "div",
    { class: { "agent-changes-card": true, "is-open": open, "has-pending": pending.length > 0 } },
    head,
    open ? h("div", { class: "agent-changes-list" }, ...list.map((r) => fileRow(r, host))) : null,
  );
}

function fileRow(r: Row, host: ChangesHost): HTMLElement {
  const session = host.session.id;
  const rel = host.relative(r.path) || r.path;
  const dir = dirname(rel);
  // A file a later turn changed again: its current proposal (reviewed on that turn's card).
  const openDiff = () =>
    r.pending || r.later
      ? host.run("agent.openReviewDiff", { path: r.path, session })
      : host.run("agent.openAppliedDiff", { session, path: r.path });
  const name = h(
    "button",
    { class: "agent-changes-file", type: "button" },
    icon(fileIcon(basename(r.path))),
    h("span", { class: "agent-changes-name" }, basename(r.path)),
    dir && dir !== "." ? h("span", { class: "agent-changes-dir" }, dir) : null,
  );
  if (r.rejected) {
    name.setAttribute("disabled", "");
    setTooltip(name, `${rel}: the change was rejected, nothing was written`);
  } else {
    setTooltip(name, r.pending ? `Review the change to ${rel}` : `Show what changed in ${rel}`);
    on(name, "click", openDiff);
  }
  const iconButton = (glyph: "check" | "x", label: string, run: () => void) => {
    const b = h(
      "button",
      { class: "icon-button agent-changes-act", type: "button", "aria-label": label },
      icon(glyph),
    );
    setTooltip(b, label);
    on(b, "click", run);
    return b;
  };
  return h(
    "div",
    { class: { "agent-changes-row": true, "is-pending": r.pending } },
    name,
    r.created ? h("span", { class: "agent-changes-tag" }, "new") : null,
    r.deleted ? h("span", { class: "agent-changes-tag is-deleted" }, "deleted") : null,
    r.rejected ? h("span", { class: "agent-changes-tag" }, "rejected") : null,
    r.later ? h("span", { class: "agent-changes-tag" }, "changed again later") : null,
    stat(r.added, r.removed),
    r.pending
      ? h(
          "span",
          { class: "agent-changes-row-actions" },
          iconButton("x", "Reject", () =>
            host.run("agent.reviewChange", { session, path: r.path, action: "reject" }),
          ),
          iconButton("check", "Accept", () =>
            host.run("agent.reviewChange", { session, path: r.path, action: "accept" }),
          ),
        )
      : null,
  );
}
