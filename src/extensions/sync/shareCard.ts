// "Share with team", on a project's page in the Sync tab: a switch (off until the person turns
// it on) and, while the project is shared, who can read it, who is waiting for its keys and
// why, what is left out, when it was last shared, and Share now. Only for an account in a team,
// in a build with teams. The switch and the button run commands (shareCommands.ts); what is
// shown comes from the share book (core/team/shareBook.ts) and from what the loop last did
// (sharing.ts); the words are core/team/shares.ts.
import { type Child, h, on } from "../../core/dom/index";
import { hasTeams } from "../../core/ownServices";
import { shareBook } from "../../core/team/shareBook";
import {
  KEY_FILES_NOTE,
  keyFilesLine,
  ONLY_VERIFIED_SETTING,
  ownShareOf,
  readersLine,
  SHARE_PURPOSE,
  shareAudience,
  waitingLines,
} from "../../core/team/shares";
import { lapsedReason, type OverviewProject, serviceTime, teamOf } from "./model";
import { item, type PageKit, writeButton } from "./pages";

/**
 * The card for `project`; null when there is nothing to say (the build has no teams, the
 * account is in none, or the project is neither open here nor shared). `isOpen`: it is the
 * open folder, syncing from this computer: only then can it be shared, or shared again.
 */
export function shareCard(
  kit: PageKit,
  project: OverviewProject,
  isOpen: boolean,
): HTMLElement | null {
  if (!hasTeams()) return null;
  const team = teamOf(kit.session.profile.peek());
  if (!team) return null;
  const book = shareBook.peek();
  const share = ownShareOf(book.shares, project.id);
  if (!isOpen && !share) return null;

  const sharing = kit.controller.sharing;
  const working = kit.session.working.peek() !== null;
  const busy = sharing.busy.peek() === project.id;
  // Not read yet: whether it is shared isn't known, so the switch waits.
  const unread = book.readAt === null;

  const box = h("input", {
    class: "checkbox",
    type: "checkbox",
    "aria-label": `Share ${project.name} with ${team.name}`,
  });
  box.checked = !!share;
  // Turning it on needs the folder (its first snapshot is taken from it) and an account that
  // can write; turning it off only needs the share.
  const cantStart = !share && (!isOpen || kit.lapsed);
  box.disabled = working || busy || unread || cantStart;
  if (!share && kit.lapsed) box.title = lapsedReason(team);
  kit.drawn.add(
    on(box, "change", () => {
      // Drawn again from what is shared once the command is done (or was cancelled).
      void kit.run(
        box.checked ? "sync.project.share" : "sync.project.unshare",
        box.checked || !share ? {} : { id: share.id },
      );
    }),
  );
  const toggle = h(
    "label",
    { class: "sync-check sync-team-switch" },
    box,
    h("span", { class: "sync-check-label" }, share ? "On" : "Off"),
  );

  const details: Child[] = [SHARE_PURPOSE];
  const below: Child[] = [];
  if (unread) details.push(book.problem ?? "Reading what your team shares…");
  else if (!share && book.problem) details.push(book.problem);
  if (share) {
    const outcome = sharing.outcome.peek();
    const last = outcome?.project === project.id ? outcome : null;
    const audience = shareAudience(
      book.members,
      kit.services.settings.peek<boolean>(ONLY_VERIFIED_SETTING) === true,
      last?.synced.waiting ?? null,
    );
    const latest = serviceTime(share.latest?.time ?? null);
    const failure = sharing.failure.peek();
    details.push(
      readersLine(audience.readers),
      ...waitingLines(audience.waiting),
      KEY_FILES_NOTE,
      busy
        ? "Sharing…"
        : last
          ? [
              last.synced.snapshot ? "Last shared " : "Nothing new to share, checked ",
              kit.when(last.at),
              last.synced.keyFiles > 0 ? ` · ${keyFilesLine(last.synced.keyFiles)}` : "",
            ]
          : latest !== null
            ? ["Latest shared snapshot ", kit.when(latest)]
            : "Nothing was shared yet: the first snapshot goes with the next one taken.",
      kit.lapsed ? "Nothing new is shared until the subscription is renewed." : null,
      // Why the last try failed: said in the line's own place, as a failure.
      failure?.project === project.id
        ? h("span", { class: "sync-share-problem", role: "alert" }, failure.message)
        : null,
      isOpen ? null : "Open its folder on this computer to share new snapshots of it.",
    );
    if (isOpen)
      below.push(
        h(
          "div",
          { class: "sync-actions sync-share-actions" },
          writeButton(
            kit,
            "Share now",
            () => kit.run("sync.project.shareNow"),
            "secondary",
            "upload",
          ),
          kit.link("Who is in your team", () => kit.go("team")),
        ),
      );
  }

  const card = h(
    "div",
    {
      class: "settings-card sync-card sync-share-card",
      "data-share-card": share ? "on" : "off",
    },
    item({
      title: "Share with team",
      tags: share ? [team.name] : [],
      details,
      below,
      actions: [toggle],
      attrs: { class: "sync-item sync-share-item" },
    }),
  );
  return card;
}
