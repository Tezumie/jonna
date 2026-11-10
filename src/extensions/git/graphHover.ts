// The Graph's ref badges and commit hover card (D148), like VS Code's: the current branch, other
// branches, remote branches and tags as colored pills with their icons (a remote branch beside
// its local one as the cloud alone); the card shows the author, when (relative and the date),
// the whole message, files and lines changed, the refs, the hash to copy and the commit on its
// hosting site.
import { h, on } from "../../core/dom/index";
import type { Commit, CommitDetail } from "../../core/ipc/git";
import type { DisposableStore } from "../../core/lifecycle/index";
import { type IconName, icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import { blameAge } from "./cloneBlame";
import { commitUrl, initials, personColor, type RefBadge, type RefKind, siteName } from "./refs";

const REF_ICON: Record<RefKind, IconName> = {
  head: "target",
  detached: "target",
  branch: "git-branch",
  remote: "cloud",
  tag: "tag",
};

const REF_LABEL: Record<RefKind, string> = {
  head: "Current branch",
  detached: "Detached HEAD",
  branch: "Branch",
  remote: "Remote branch",
  tag: "Tag",
};

/**
 * Badges for a row (compact remotes as icons) or for the card (`full`: every name). `color`: a
 * lane color for a chip (D220: the base branch, every ref in All branches mode), else by kind.
 */
export function refBadges(
  refs: readonly RefBadge[],
  full = false,
  color?: (ref: RefBadge) => string | null,
): HTMLElement[] {
  return refs.map((r) => {
    const compact = r.compact && !full;
    const tint = color?.(r);
    const el = h(
      "span",
      {
        class: `scm-ref is-${r.kind}${compact ? " is-compact" : ""}${tint ? ` scm-chip scm-chip-${tint}` : ""}`,
      },
      icon(REF_ICON[r.kind]),
      compact ? null : h("span", { class: "scm-ref-name" }, r.name),
    );
    if (!full) setTooltip(el, `${REF_LABEL[r.kind]}: ${r.name}`);
    return el;
  });
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" });

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

export interface CommitCardInput {
  commit: Commit;
  detail: Promise<CommitDetail | null>;
  refs: readonly RefBadge[];
  /** The repository's page on its hosting site, if known. */
  web: string | null;
  incoming: boolean;
  outgoing: boolean;
  head: boolean;
  run(command: string, input?: unknown): void;
  copy(text: string): void;
}

/** The hover card of a commit. Waits for its detail (message, counts) so it opens complete. */
export async function commitHoverCard(
  store: DisposableStore,
  input: CommitCardInput,
): Promise<HTMLElement> {
  const c = input.commit;
  const detail = await input.detail;
  const when = new Date(c.time * 1000);
  const message = (detail?.message ?? c.subject).trim() || "(no message)";
  const [subject, ...rest] = message.split("\n");
  const body = rest.join("\n").trim();
  const button = (label: string, name: IconName, title: string, run: () => void) => {
    const b = h("button", { class: "scm-card-link", type: "button" }, icon(name), label);
    setTooltip(b, title);
    store.add(on(b, "click", run));
    return b;
  };
  const short = c.hash.slice(0, 7);
  const foot: HTMLElement[] = [
    button(short, "git-commit-horizontal", "Copy the commit hash", () => input.copy(c.hash)),
  ];
  if (input.web) {
    const web = input.web;
    foot.push(
      button(`Open on ${siteName(web)}`, "external-link", commitUrl(web, c.hash), () =>
        input.run("ui.openLink", { url: commitUrl(web, c.hash) }),
      ),
    );
  }
  foot.push(
    button("Show changes", "git-compare", "Show the commit's files and diff", () =>
      input.run("git.showCommit", { commit: c.hash }),
    ),
  );
  const state = input.incoming
    ? "Incoming: on the upstream, not pulled yet"
    : input.outgoing
      ? "Outgoing: not pushed yet"
      : input.head
        ? "You are here (HEAD)"
        : "";
  return h(
    "div",
    { class: "scm-card" },
    h(
      "div",
      { class: "scm-card-head" },
      h(
        "span",
        {
          class: `scm-avatar scm-avatar-${personColor(c.email || c.author)}`,
          "aria-hidden": "true",
        },
        initials(c.author),
      ),
      h("strong", { class: "scm-card-author" }, c.author),
      h(
        "span",
        { class: "scm-card-when" },
        icon("history"),
        `${blameAge(c.time)} (${dateFormat.format(when)})`,
      ),
    ),
    h(
      "div",
      { class: "scm-card-message" },
      h("div", { class: "scm-card-subject" }, subject ?? ""),
      body ? h("div", { class: "scm-card-body" }, body) : null,
    ),
    detail
      ? h(
          "div",
          { class: "scm-card-stats" },
          count(detail.files.length, "file changed", "files changed"),
          detail.insertions ? ", " : null,
          detail.insertions
            ? h(
                "span",
                { class: "is-added" },
                count(detail.insertions, "insertion(+)", "insertions(+)"),
              )
            : null,
          detail.deletions ? ", " : null,
          detail.deletions
            ? h(
                "span",
                { class: "is-removed" },
                count(detail.deletions, "deletion(-)", "deletions(-)"),
              )
            : null,
        )
      : null,
    input.refs.length ? h("div", { class: "scm-card-refs" }, ...refBadges(input.refs, true)) : null,
    state ? h("div", { class: "scm-card-state" }, state) : null,
    h("div", { class: "scm-card-foot" }, ...foot),
  );
}
