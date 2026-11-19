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
  AUDIENCE_CHOSEN,
  AUDIENCE_NOTE,
  AUDIENCE_TEAM,
  AUDIENCE_UNKNOWN,
  KEY_FILES_NOTE,
  keyFilesLine,
  ONLY_VERIFIED_SETTING,
  ownShareOf,
  readerChoices,
  readersLine,
  SHARE_CHATS_LABEL,
  SHARE_CHATS_NOTE,
  SHARE_PURPOSE,
  shareAudience,
  toggledReaders,
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
  const onlyVerified = kit.services.settings.peek<boolean>(ONLY_VERIFIED_SETTING) === true;
  // Whom it is for (D453): the share's own list, or, before sharing is on, the choice kept
  // for when it is. Null: the whole team.
  const intended = sharing.intended.peek();
  const chosen: string[] | null = share
    ? share.readers
    : intended?.project === project.id
      ? intended.readers
      : null;
  // Who it is for and its chats are changed from the project's own folder (the commands act
  // on the open project), by an account that can write.
  const locked = working || busy || unread || !isOpen || kit.lapsed;
  const audienceBlock = (): HTMLElement | null => {
    if (unread || (!share && !isOpen)) return null;
    const select = h(
      "select",
      { class: "input sync-share-audience", "aria-label": "Who can see this project" },
      h("option", { value: "team" }, AUDIENCE_TEAM),
      h("option", { value: "chosen" }, AUDIENCE_CHOSEN),
    );
    select.value = chosen === null ? "team" : "chosen";
    select.disabled = locked;
    kit.drawn.add(
      on(select, "change", () => {
        void kit.run(
          "sync.project.shareWith",
          select.value === "team"
            ? { team: true }
            : // Everyone stays ticked until one is unticked: choosing people takes nobody off.
              { readers: toggledReaders(book.members, null, "", false) },
        );
      }),
    );
    const rows =
      chosen === null
        ? []
        : readerChoices(book.members, chosen, onlyVerified).map((choice) => {
            const tick = h("input", { class: "checkbox", type: "checkbox" });
            tick.checked = choice.picked;
            tick.disabled = locked;
            kit.drawn.add(
              on(tick, "change", () => {
                void kit.run("sync.project.shareWith", {
                  readers: toggledReaders(book.members, chosen, choice.uid, tick.checked),
                });
              }),
            );
            return h(
              "label",
              { class: "sync-check sync-share-reader", "data-reader": choice.uid },
              tick,
              h("span", { class: "sync-check-label" }, choice.name),
              choice.note ? h("span", { class: "sync-held" }, choice.note) : null,
            );
          });
    return h(
      "div",
      { class: "sync-share-who" },
      h("label", { class: "sync-share-who-row" }, h("span", {}, "Share with"), select),
      ...(chosen === null
        ? []
        : [
            rows.length > 0
              ? h(
                  "div",
                  { class: "sync-share-readers", role: "group", "aria-label": "People" },
                  ...rows,
                )
              : h("div", { class: "sync-held" }, "Nobody else is in your team yet."),
            h("div", { class: "sync-held" }, AUDIENCE_NOTE),
          ]),
    );
  };
  /** The second switch (D454): the project's chats too. Only on a project that is shared. */
  const chatsBlock = (): HTMLElement | null => {
    if (!share) return null;
    const tick = h("input", { class: "checkbox", type: "checkbox" });
    tick.checked = share.chats;
    tick.disabled = locked;
    kit.drawn.add(
      on(tick, "change", () => {
        void kit.run("sync.project.shareChats", { on: tick.checked });
      }),
    );
    return h(
      "div",
      { class: "sync-share-chats" },
      h(
        "label",
        { class: "sync-check sync-share-reader", "data-share-chats": share.chats ? "on" : "off" },
        tick,
        h("span", { class: "sync-check-label" }, SHARE_CHATS_LABEL),
      ),
      h("div", { class: "sync-held" }, SHARE_CHATS_NOTE),
    );
  };
  if (unread) details.push(book.problem ?? "Reading what your team shares…");
  else if (!share && book.problem) details.push(book.problem);
  if (share) {
    const outcome = sharing.outcome.peek();
    const last = outcome?.project === project.id ? outcome : null;
    const audience = shareAudience(
      book.members,
      onlyVerified,
      last?.synced.waiting ?? null,
      share.readers,
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
      last?.synced.audienceUnknown
        ? h("span", { class: "sync-share-problem", role: "alert" }, AUDIENCE_UNKNOWN)
        : null,
      // Why the last try failed: said in the line's own place, as a failure.
      failure?.project === project.id
        ? h("span", { class: "sync-share-problem", role: "alert" }, failure.message)
        : null,
      isOpen ? null : "Open its folder on this computer to share new snapshots of it.",
    );
    const who = audienceBlock();
    if (who) below.push(who);
    const chats = chatsBlock();
    if (chats) below.push(chats);
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

  if (!share) {
    const who = audienceBlock();
    if (who) below.push(who);
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
