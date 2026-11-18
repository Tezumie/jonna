// The Team page's parts about sharing projects: "People" (each member, where their key stands,
// their fingerprint on demand, and marking one verified or accepting a changed key), "Shared
// projects" (what the team shares, and whether this account can read each), and, in place of
// the page, one shared project opened: its snapshots, and one snapshot's files in the same
// panel the Projects page uses (snapshotView.ts). Everything reads from the share book
// (core/team/shareBook.ts) and the session; every button runs a command (shareCommands.ts).
// Moving between the list, a share and a snapshot is the tab's own, like its pages. The words
// are core/team/shares.ts and shareView.model.ts.
import { type Child, h, on } from "../../core/dom/index";
import type {
  ShareAsk,
  SharedChat,
  SharedSnapshot,
  ShareInfo,
  ShareMember,
} from "../../core/ipc/share";
import { shareBook } from "../../core/team/shareBook";
import {
  askSentence,
  canRead,
  fingerprintGroups,
  memberActions,
  memberLine,
  memberTag,
  sharedChatTitle,
  shareStateLine,
  sortMembers,
  sortShares,
} from "../../core/team/shares";
import { icon } from "../../ui/Icon";
import type { MenuItem } from "../../ui/Menu";
import { groupByDay, teamOf, timeOfDay } from "./model";
import { body, card, empty, item, type PageKit } from "./pages";
import { latestFacts, type OpenedShare, sharedSnapshotFacts } from "./shareView.model";
import { drawSnapshot } from "./snapshotView";

const PEOPLE_NOTE =
  "What a teammate shares is sealed for each member's own key. Compare fingerprints once, by voice or in person, to be sure a key is theirs and not one put in its place.";
const SHARES_NOTE =
  "Projects your teammates share with the team. You can look at their snapshots and open a copy; nothing you do changes theirs.";

/** A fingerprint as a block of digits that can be selected and read out. */
function fingerprint(digits: string): HTMLElement {
  return h("div", { class: "sync-fingerprint" }, digits);
}

function memberRow(kit: PageKit, member: ShareMember): HTMLElement {
  const name = member.name.trim() || "A teammate";
  const known = fingerprintGroups(member.fingerprint);
  const pending = fingerprintGroups(member.pendingFingerprint);
  const below: Child[] = [];
  if (member.you) {
    // Your own: on show, since it is the one you read out; Copy is there for a note to yourself.
    below.push(
      known
        ? h(
            "div",
            { class: "sync-fingerprint-own" },
            h("span", { class: "sync-item-detail" }, "Your fingerprint"),
            h(
              "div",
              { class: "sync-fingerprint-line" },
              fingerprint(known),
              kit.button("Copy", () => kit.run("team.copyFingerprint"), "ghost", "copy"),
            ),
          )
        : h(
            "div",
            { class: "sync-item-detail" },
            "Your key for sharing isn't made yet. It is made the next time sync runs.",
          ),
    );
  } else if (known || pending) {
    below.push(
      kit.details(
        `fingerprint:${member.uid}`,
        [h("span", { class: "sync-details-label" }, "Fingerprint")],
        h(
          "div",
          { class: "sync-fingerprints" },
          known
            ? h(
                "div",
                {},
                pending
                  ? h("div", { class: "sync-item-detail" }, "The key this computer knows")
                  : null,
                fingerprint(known),
              )
            : null,
          pending
            ? h(
                "div",
                {},
                h("div", { class: "sync-item-detail" }, "The new key, not accepted"),
                fingerprint(pending),
              )
            : null,
        ),
      ),
    );
  }
  const actions = memberActions(member).map((action) => {
    if (action === "verify")
      return kit.button("Mark as verified…", () =>
        kit.run("team.member.verify", {
          uid: member.uid,
          fingerprint: member.fingerprint ?? "",
          verified: true,
        }),
      );
    if (action === "unmark")
      return kit.button(
        "Unmark",
        () =>
          kit.run("team.member.verify", {
            uid: member.uid,
            fingerprint: member.fingerprint ?? "",
            verified: false,
          }),
        "ghost",
      );
    return kit.button("Accept the new key…", () =>
      kit.run("team.member.acceptKey", {
        uid: member.uid,
        fingerprint: member.pendingFingerprint ?? "",
      }),
    );
  });
  // A note to them, nothing more: their app says that this account asked.
  if (!member.you)
    actions.push(
      kit.button(
        "Ask to share…",
        () => kit.run("team.member.askToShare", { uid: member.uid }),
        "ghost",
      ),
    );
  return item({
    title: name,
    tags: [member.you ? "You" : memberTag(member.state)],
    details: [memberLine(member)],
    below,
    actions,
    attrs: {
      class: "sync-item sync-team-item sync-member",
      "data-member": member.uid,
      "data-state": member.state,
      ...(member.you && { "data-you": "" }),
    },
  });
}

/** A section's title with a button at its end. */
function titled(title: string, action: HTMLElement): HTMLElement {
  return h(
    "div",
    { class: "sync-section-head" },
    h("h2", { class: "settings-section-title" }, title),
    action,
  );
}

/** Reads the members and the shares again (one read gets both). */
function refreshButton(kit: PageKit, label: string): HTMLElement {
  const button = h(
    "button",
    { class: "icon-button", type: "button", title: label, "aria-label": label },
    icon("refresh-cw"),
  );
  button.disabled = kit.session.working.peek() !== null;
  kit.drawn.add(on(button, "click", () => void kit.run("team.shares.list")));
  return button;
}

function shareRow(kit: PageKit, share: ShareInfo, owner: boolean): HTMLElement {
  const latest = latestFacts(share.latest);
  const state = shareStateLine(share);
  const readable = canRead(share.state);
  const open = () => kit.run("team.share.view", { id: share.id });
  const menu: MenuItem[] = [];
  if (readable)
    menu.push({
      label: "Open a copy…",
      icon: "folder-plus",
      run: () => void kit.run("team.share.openCopy", { id: share.id }),
    });
  // The sharer stops their own; the team's owner may stop anyone's.
  if (share.mine || owner)
    menu.push({
      label: "Stop sharing…",
      icon: "trash-2",
      destructive: true,
      separatorBefore: menu.length > 0,
      run: () => void kit.run("sync.project.unshare", { id: share.id }),
    });
  return item({
    title: share.name,
    details: [
      share.mine ? state : `Shared by ${share.owner.name.trim() || "a teammate"}`,
      latest
        ? [
            latest.facts,
            latest.time === null ? null : " · ",
            latest.time === null ? null : kit.when(latest.time),
          ]
        : "No snapshot yet",
      // Why it can't be opened, in the row: waiting for its keys, or the sharer's key changed.
      share.mine ? null : state,
    ],
    actions: [
      readable ? kit.button("Open", open) : null,
      menu.length > 0 ? kit.menuButton(`More for ${share.name}`, menu, "Shared project") : null,
    ],
    attrs: { "data-share": share.id, "data-state": share.state },
  });
}

/** Who asked this account to share a project: said above the lists until answered. */
function asksCard(kit: PageKit, asks: readonly ShareAsk[]): HTMLElement | null {
  if (asks.length === 0) return null;
  return h(
    "section",
    { class: "sync-section", "data-team-asks": String(asks.length) },
    card(
      item({
        title: askSentence(asks),
        details: [
          "To share one, open the project's page under Projects and turn on Share with team. They aren't told what you have.",
        ],
        actions: [
          kit.button("Projects", () => kit.go("projects"), "secondary"),
          kit.button("Dismiss", () => kit.run("team.asks.dismiss"), "ghost"),
        ],
        attrs: { class: "sync-item sync-team-item sync-member" },
      }),
    ),
  );
}

/** A shared chat's row: its title and when, Read, and continuing a copy of one's own. */
function chatRow(kit: PageKit, share: ShareInfo, chat: SharedChat): HTMLElement {
  const read = () => kit.run("team.share.readChat", { id: share.id, chat: chat.id });
  return item({
    title: sharedChatTitle(chat),
    details: [
      [
        chat.updated > 0 ? kit.when(chat.updated) : "A chat",
        chat.images > 0 ? ` · ${chat.images} ${chat.images === 1 ? "image" : "images"}` : "",
      ],
    ],
    actions: [
      kit.button("Read", read, "secondary"),
      kit.menuButton(
        `More for ${sharedChatTitle(chat)}`,
        [
          { label: "Read", icon: "eye", run: () => void read() },
          {
            label: "Continue as my own chat",
            icon: "git-fork",
            run: () => void kit.run("team.share.continueChat", { id: share.id, chat: chat.id }),
          },
        ],
        "Shared chat",
      ),
    ],
    attrs: { class: "sync-item sync-member", "data-shared-chat": chat.id },
  });
}

/** "People" and "Shared projects", for an account in a team. */
export function sharingSections(kit: PageKit): Child[] {
  const team = teamOf(kit.session.profile.peek());
  if (!team) return [];
  const book = shareBook.peek();
  const members = sortMembers(book.members);
  const shares = sortShares(book.shares);
  // Before the first read there is nothing to list, and that is said (with why, if it failed).
  const unread = book.readAt === null;
  const waiting = book.problem ?? "Reading what your team shares…";
  const refresh = () => refreshButton(kit, "Read your team and what it shares again");

  const sharesPart = h(
    "section",
    { class: "sync-section", "data-team-shares": String(shares.length) },
    titled("Shared projects", refresh()),
    h("p", { class: "sync-section-note" }, SHARES_NOTE),
    // Read before, and not just now: what is listed may be older.
    !unread && book.problem ? h("p", { class: "sync-section-note" }, book.problem) : null,
    shares.length === 0
      ? card(
          empty(
            unread
              ? waiting
              : "Nobody in your team shares a project yet. To share one of yours, open its page under Projects.",
          ),
        )
      : card(...shares.map((share) => shareRow(kit, share, team.role === "owner"))),
  );
  const peoplePart = h(
    "section",
    { class: "sync-section", "data-team-people": String(members.length) },
    h("h2", { class: "settings-section-title" }, "People"),
    h("p", { class: "sync-section-note" }, PEOPLE_NOTE),
    // The account's own record of its keys couldn't be read: the way out, the person's to take.
    book.problem && book.startOver
      ? card(
          h("p", { class: "sync-text" }, book.problem),
          h(
            "div",
            { class: "sync-actions" },
            kit.button("Try again", () => kit.run("team.shares.list"), "ghost", "refresh-cw"),
            kit.button("Start over with a new key…", () => kit.run("team.startOver"), "ghost"),
          ),
        )
      : null,
    members.length === 0
      ? card(empty(unread ? waiting : "Your team's members couldn't be listed."))
      : card(...members.map((member) => memberRow(kit, member))),
  );
  return [asksCard(kit, book.asks), sharesPart, peoplePart];
}

function snapshotRow(kit: PageKit, share: ShareInfo, snapshot: SharedSnapshot): HTMLElement {
  const { summary } = snapshot;
  const facts = sharedSnapshotFacts(snapshot);
  const view = () => void kit.run("team.share.view", { id: share.id, snapshot: snapshot.id });
  const full = [new Date(summary.time).toLocaleString(), facts].join(" · ");
  const open = h(
    "button",
    { class: "sync-snapshot-open", type: "button", title: `${full}\nView files` },
    h("span", { class: "sync-snapshot-time" }, timeOfDay(summary.time)),
    h("span", { class: "sync-snapshot-main" }, h("span", { class: "sync-snapshot-facts" }, facts)),
  );
  kit.drawn.add(on(open, "click", view));
  const items: MenuItem[] = [
    { label: "View files", icon: "files", run: view },
    {
      label: "Open a copy…",
      icon: "folder-plus",
      run: () => void kit.run("team.share.openCopy", { id: share.id, snapshot: snapshot.id }),
    },
  ];
  return h(
    "div",
    { class: "sync-item sync-snapshot", "data-shared-snapshot": snapshot.id },
    open,
    h(
      "div",
      { class: "sync-item-actions" },
      kit.menuButton("More for this snapshot", items, "Shared snapshot"),
    ),
  );
}

/** The link above an opened share, or an opened snapshot of it. */
function backLink(kit: PageKit, label: string, go: () => void): HTMLElement {
  const back = h(
    "button",
    { class: "ai-link sync-look-back", type: "button" },
    icon("arrow-left"),
    label,
  );
  kit.drawn.add(on(back, "click", go));
  return h("div", { class: "sync-look-nav" }, back);
}

/**
 * One shared project, opened: what the Team page shows in place of the team. Its snapshots,
 * newest first; or, when one of them is being looked at, that snapshot's files.
 */
export function sharePanel(kit: PageKit, opened: OpenedShare): Child[] {
  const look = kit.session.shares;
  const share = shareBook.peek().shares.find((entry) => entry.id === opened.id);
  const toTeam = backLink(kit, "Team", () => look.close());
  if (!share)
    return [
      h(
        "div",
        { class: "sync-look", "data-share-look": opened.id, "data-phase": "gone" },
        toTeam,
        card(empty("That project isn't shared with your team any more.")),
      ),
    ];
  const whose = share.mine
    ? "Shared by you"
    : `Shared by ${share.owner.name.trim() || "a teammate"}`;

  // A snapshot of it being looked at: the panel the Projects page uses, read only.
  const looked = look.snapshot.opened.peek();
  const row = looked ? look.rows.find((entry) => entry.id === looked.id) : undefined;
  if (looked && row) {
    const computer = row.summary.deviceName.trim();
    return drawSnapshot(
      kit,
      {
        id: row.id,
        summary: row.summary,
        look: look.snapshot,
        title: computer ? `Snapshot from ${computer}` : "Snapshot",
        tags: [whose],
        back: { label: share.name, go: () => look.snapshot.close() },
        reload: () => kit.run("team.share.view", { id: share.id, snapshot: row.id }),
        open: (path) => kit.run("team.share.openFile", { id: share.id, snapshot: row.id, path }),
        // A teammate's snapshot is read: nothing of it is restored into the open folder.
        restoreFile: null,
        actions: [
          kit.button(
            "Open a copy…",
            () => kit.run("team.share.openCopy", { id: share.id, snapshot: row.id }),
            "secondary",
            "folder-plus",
          ),
        ],
        notes: [
          looked.compared
            ? "The open folder is this project: a file opens beside the folder's own. Nothing is written to the folder."
            : "A file opens read only. The open folder isn't this project, so nothing is compared with it.",
          row.summary.kind === "git" && (looked.counts?.total ?? 0) > 0
            ? "A git project's snapshot lists the files that differed from its commit. A copy is cloned from the project's remote first, when it has one."
            : null,
        ],
      },
      looked,
    );
  }

  const waiting = kit.session.working.peek() !== null;
  const again = h(
    "button",
    {
      class: "icon-button",
      type: "button",
      title: "Read its snapshots again",
      "aria-label": "Read its snapshots again",
    },
    icon("refresh-cw"),
  );
  again.disabled = waiting || opened.refreshing || opened.phase === "loading";
  kit.drawn.add(on(again, "click", () => void kit.run("team.share.view", { id: share.id })));
  const head = card(
    item({
      title: share.name,
      tags: [whose],
      details: [
        opened.phase === "ready"
          ? opened.snapshots === 0
            ? "No snapshot yet"
            : `${opened.snapshots} ${opened.snapshots === 1 ? "snapshot" : "snapshots"}${opened.refreshing ? " · reading again…" : ""}. A share keeps its latest ten.`
          : opened.phase === "loading"
            ? "Reading its snapshots…"
            : null,
        "You can look at a snapshot's files and open a copy in a folder of its own. Nothing you do changes the shared project.",
      ],
      attrs: { "data-share-head": opened.phase },
      actions: [
        again,
        opened.phase === "ready" && opened.snapshots > 0
          ? kit.button(
              "Open a copy…",
              () => kit.run("team.share.openCopy", { id: share.id }),
              "secondary",
              "folder-plus",
            )
          : null,
      ],
    }),
  );
  let content: Child[];
  if (opened.phase === "error")
    content = [
      card(
        body(
          h(
            "p",
            { class: "sync-text", role: "alert" },
            `Its snapshots couldn't be read. ${opened.error ?? ""}`.trim(),
          ),
          h(
            "div",
            { class: "sync-actions" },
            kit.button("Try again", () => kit.run("team.share.view", { id: share.id })),
          ),
        ),
      ),
    ];
  else if (opened.phase === "loading") content = [card(empty("Reading its snapshots…"))];
  else if (look.rows.length === 0)
    content = [
      card(
        empty("Nothing was shared yet. A snapshot arrives when the sharer's computer takes one."),
      ),
    ];
  else
    content = groupByDay(look.rows, (entry) => entry.summary.time).map((group) =>
      h(
        "div",
        { class: "sync-day" },
        h("div", { class: "sync-day-label" }, group.label),
        card(...group.rows.map((entry) => snapshotRow(kit, share, entry))),
      ),
    );
  // Its chats, when the sharer shares them: read only here, or copied to continue.
  const chats: Child[] =
    opened.phase === "ready" && share.chats
      ? [
          h(
            "section",
            { class: "sync-section", "data-shared-chats": String(look.chats.length) },
            h("h2", { class: "settings-section-title" }, "Chats"),
            h(
              "p",
              { class: "sync-section-note" },
              "This project's chats with the agent, as shared. Reading one changes nothing; continuing one makes a copy that is yours.",
            ),
            look.chats.length === 0
              ? card(empty("No chat was shared yet."))
              : card(...look.chats.map((chat) => chatRow(kit, share, chat))),
          ),
        ]
      : [];
  return [
    h(
      "div",
      { class: "sync-look", "data-share-look": share.id, "data-phase": opened.phase },
      toTeam,
      head,
      ...content,
      ...chats,
    ),
  ];
}
