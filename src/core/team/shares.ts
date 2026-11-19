// Sharing a project with a team, in words and decisions. DOM-free.
//
// A member who syncs a project can share it: its snapshots are then also written to a share the
// team's members can read (one writer, many readers). Whether a member gets the share's keys
// depends on their own key: none published yet, pinned and not compared, verified, or changed
// since it was pinned. This file says how each of those reads, who is waiting and why, what a
// share sync came to, and what a refused call means. The calls are core/ipc/share.ts; what is
// read lives in shareBook.ts; the Sync tab draws it and the commands use it.
import type {
  ShareAsk,
  ShareChatsSynced,
  ShareCopy,
  SharedChat,
  ShareInfo,
  ShareLatest,
  ShareMember,
  ShareMemberState,
  ShareNews,
  ShareState,
  ShareSynced,
  ShareWaiting,
} from "../ipc/share";

/** What sharing a project means, under its switch. */
export const SHARE_PURPOSE =
  "Your team can see this project's snapshots and open a copy. They can't change it.";
/** What never leaves with a share, whatever the ignore files say. */
export const KEY_FILES_NOTE = "Key files (.env, keys and tokens) are left out of what is shared.";
/** The setting: keys are handed only to teammates whose fingerprint was compared. */
export const ONLY_VERIFIED_SETTING = "team.shareOnlyVerified";

/** The content source of a shared snapshot's files: `teamShare:<share id>/<snapshot id>`. */
export const TEAM_SHARE_SCHEME = "teamShare:";

export function teamShareScheme(share: string, snapshot: string): string {
  return `${TEAM_SHARE_SCHEME}${share}/${snapshot}`;
}

/** The share and snapshot a content scheme names; null when it isn't one. */
export function parseTeamShareScheme(scheme: string): { share: string; snapshot: string } | null {
  if (!scheme.startsWith(TEAM_SHARE_SCHEME)) return null;
  const spec = scheme.slice(TEAM_SHARE_SCHEME.length);
  // A snapshot's id has no "/"; a share's is `<account>.<project>`, and has none either.
  const at = spec.lastIndexOf("/");
  if (at <= 0 || at === spec.length - 1) return null;
  return { share: spec.slice(0, at), snapshot: spec.slice(at + 1) };
}

/**
 * A share's id is `<the sharer's account>.<project>`; a project's sync id has no dot, so the
 * last one parts them ("" for a part that is missing).
 */
export function splitShareId(id: string): { owner: string; project: string } {
  const at = id.lastIndexOf(".");
  return at < 0
    ? { owner: "", project: id }
    : { owner: id.slice(0, at), project: id.slice(at + 1) };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Ana", "Ana and Sam", "Ana, Sam and Kim"; past `max` names, "Ana, Sam and 3 more". */
export function nameList(names: readonly string[], max = 6): string {
  const shown = names.map((name) => name.trim() || "A teammate");
  if (shown.length <= 1) return shown[0] ?? "";
  if (shown.length > max)
    return `${shown.slice(0, max - 1).join(", ")} and ${shown.length - (max - 1)} more`;
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

/** Whose: "Ana's", "Ana's and Sam's". */
function possessive(names: readonly string[]): string {
  return nameList(names.map((name) => `${name.trim() || "A teammate"}'s`));
}

// ------------------------------------------------------------ members

/** A member's state as the quiet tag in their row. */
export function memberTag(state: ShareMemberState): string {
  switch (state) {
    case "verified":
      return "Verified";
    case "new":
      return "Not verified";
    case "changed":
      return "Key changed";
    default:
      return "No key yet";
  }
}

/** What a member's state means, in one line under their name. */
export function memberLine(member: Pick<ShareMember, "state" | "you">): string {
  if (member.you) return "This is you. Teammates compare this fingerprint with what you read out.";
  switch (member.state) {
    case "verified":
      return "You compared their fingerprint. What you share reaches them, and theirs is read.";
    case "new":
      return "Their key is the one this computer first saw. Compare fingerprints to be sure it is theirs.";
    case "changed":
      return "Their key isn't the one this computer knows. Nothing is shared with them, and nothing of theirs is read, until you accept the new key.";
    default:
      return "They haven't opened the IDE with sync on yet, so there is no key to share with.";
  }
}

export type MemberAction = "verify" | "unmark" | "accept";

/** What can be done about a teammate: nothing for yourself, or while they have no key. */
export function memberActions(member: Pick<ShareMember, "state" | "you">): MemberAction[] {
  if (member.you) return [];
  switch (member.state) {
    case "new":
      return ["verify"];
    case "verified":
      return ["unmark"];
    case "changed":
      return ["accept"];
    default:
      return [];
  }
}

/**
 * A fingerprint as it is read out: its thirty digits in six groups of five
 * ("12345 67890 …"); null: none.
 */
export function fingerprintGroups(fingerprint: string | null | undefined): string | null {
  const digits = (fingerprint ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return digits.match(/.{1,5}/g)?.join(" ") ?? digits;
}

/** What asking before a copy is cloned says: where from, and whose address it is. */
export function cloneQuestion(
  remote: string,
  sharer: string,
  name: string,
  mine = false,
): { title: string; message: string } {
  const who = sharer.trim() || "the teammate who shares it";
  return {
    title: `Clone ${name.trim() || "the project"} first?`,
    message: [
      `Clone from ${remote} first? It is the address ${mine ? "you work" : `${who} works`} from.`,
      "Your computer then asks that address for the repository, with the access to it you already have: nothing asks you to sign in, and it gives up when the address doesn't answer. Choose No to copy without cloning: the copy then holds only what the snapshot itself carries.",
    ].join("\n\n"),
  };
}

/** Whether two fingerprints are the same digits, however they are grouped. */
export function sameFingerprint(a: string | null | undefined, b: string | null | undefined) {
  const digits = (text: string | null | undefined) => (text ?? "").replace(/\D/g, "");
  return digits(a) !== "" && digits(a) === digits(b);
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

/** You first, then whoever needs a look (a changed key), then by name. */
export function sortMembers<T extends Pick<ShareMember, "uid" | "name" | "you" | "state">>(
  members: readonly T[],
): T[] {
  const rank = (member: T) => (member.you ? 0 : member.state === "changed" ? 1 : 2);
  return [...members].sort(
    (a, b) => rank(a) - rank(b) || byName(a.name, b.name) || (a.uid < b.uid ? -1 : 1),
  );
}

/** What the dialog says before a teammate is marked as verified. */
export function verifyWords(name: string, fingerprint: string): { title: string; message: string } {
  const who = name.trim() || "this teammate";
  return {
    title: `Mark ${who} as verified?`,
    message: [
      `The fingerprint this computer has for ${who}:`,
      fingerprintGroups(fingerprint) ?? fingerprint,
      `Ask ${who} to read out the fingerprint their own IDE shows under Sync, Team, People ("Your fingerprint"), by voice or in person. Confirm only if every digit matches.`,
    ].join("\n\n"),
  };
}

/** What the dialog says before a teammate's changed key is accepted. */
export function acceptKeyWords(
  name: string,
  fingerprint: string,
): { title: string; message: string } {
  const who = name.trim() || "this teammate";
  return {
    title: `Accept the new key of ${who}?`,
    message: [
      `The key of ${who} changed. That happens when they reset sync; it also happens when something is wrong and the key isn't theirs. Until you accept it, nothing is shared with them and nothing of theirs is read.`,
      "Their new fingerprint:",
      fingerprintGroups(fingerprint) ?? fingerprint,
      `Ask ${who} to read out the fingerprint their own IDE shows under Sync, Team, People ("Your fingerprint"), by voice or in person. Accept only if every digit matches. They show as not verified afterwards, until you mark them.`,
    ].join("\n\n"),
  };
}

// ------------------------------------------------------------ who a share reaches

/** Why a member has no keys, as a clause after their name. */
export function waitingWhy(why: ShareWaiting["why"], many = false): string {
  switch (why) {
    case "keyChanged":
      return many ? "keys changed" : "key changed";
    case "notVerified":
      return many ? "aren't verified" : "isn't verified";
    default:
      return many
        ? "haven't opened the IDE with sync on yet"
        : "hasn't opened the IDE with sync on yet";
  }
}

/**
 * Who is waiting for a share's keys, a line a reason: "Waiting for keys: Sam hasn't opened the
 * IDE with sync on yet", "Ana isn't verified…", "Kim's key changed…".
 */
export function waitingLines(waiting: readonly ShareWaiting[]): string[] {
  const of = (why: ShareWaiting["why"]) =>
    waiting.filter((entry) => entry.why === why).map((entry) => entry.name);
  const lines: string[] = [];
  const noKey = of("noKey");
  if (noKey.length > 0)
    lines.push(
      `Waiting for keys: ${nameList(noKey)} ${waitingWhy("noKey", noKey.length > 1)}. They get the keys the next time this computer syncs after that.`,
    );
  const unverified = of("notVerified");
  if (unverified.length > 0)
    lines.push(
      `${nameList(unverified)} ${waitingWhy("notVerified", unverified.length > 1)}, and you share only with verified teammates: compare fingerprints under Team, People.`,
    );
  const changed = of("keyChanged");
  if (changed.length > 0)
    lines.push(
      `${possessive(changed)} ${waitingWhy("keyChanged", changed.length > 1)}, so nothing is shared with them: check Team, People.`,
    );
  return lines;
}

export interface ShareAudience {
  /** The teammates who can read the share, by name. */
  readers: string[];
  waiting: ShareWaiting[];
}

/**
 * Who a share of this account's reaches. `known` is what the last share sync said (who has no
 * keys, and why): the word of the computer that hands the keys out. Without one (nothing was
 * shared since the window opened) it is worked out from where each teammate's key stands.
 */
export function shareAudience(
  members: readonly ShareMember[],
  onlyVerified: boolean,
  known: readonly ShareWaiting[] | null = null,
  chosen: readonly string[] | null = null,
): ShareAudience {
  // Shared with chosen people (D453): nobody else is a reader, or waited for.
  const picked = chosen ? new Set(chosen) : null;
  const others = sortMembers(
    members.filter((member) => !member.you && (!picked || picked.has(member.uid))),
  );
  const waiting: ShareWaiting[] = known
    ? known.filter((entry) => !picked || picked.has(entry.uid))
    : others.flatMap((member): ShareWaiting[] => {
        const why: ShareWaiting["why"] | null =
          member.state === "nokey"
            ? "noKey"
            : member.state === "changed"
              ? "keyChanged"
              : member.state === "new" && onlyVerified
                ? "notVerified"
                : null;
        return why ? [{ uid: member.uid, name: member.name, why }] : [];
      });
  const held = new Set(waiting.map((entry) => entry.uid));
  return {
    readers: others.filter((member) => !held.has(member.uid)).map((member) => member.name),
    waiting,
  };
}

/** "2 teammates can read it: Ana and Sam." */
export function readersLine(readers: readonly string[]): string {
  if (readers.length === 0) return "Nobody else in your team can read it yet.";
  return `${plural(readers.length, "teammate")} can read it: ${nameList(readers)}.`;
}

/** Whether teammates' new shares are announced on this computer (D455). */
export const SHARE_NOTICES_SETTING = "team.shareNotices";

/** The most chats a share holds: the project's newest. */
export const MAX_SHARED_CHATS = 100;

/**
 * The chats of the project in `root` that are shared, newest first: the ones whose folder is
 * that folder, without those being written right now (`busy`; they go the next time).
 * `sameFolder` compares two paths as this computer spells them.
 */
export function chatsToShare(
  chats: readonly { id: string; workspace: string | null; updated: number }[],
  root: string,
  sameFolder: (a: string, b: string) => boolean,
  busy: (id: string) => boolean = () => false,
): string[] {
  return chats
    .filter((chat) => chat.workspace !== null && sameFolder(chat.workspace, root) && !busy(chat.id))
    .sort((a, b) => b.updated - a.updated || (a.id < b.id ? -1 : 1))
    .slice(0, MAX_SHARED_CHATS)
    .map((chat) => chat.id);
}

/** "3 chats were shared." and what else a pass over a share's chats did ("" when nothing). */
export function chatsSentence(result: ShareChatsSynced): string {
  return [
    result.written > 0 ? `${plural(result.written, "chat")} shared.` : "",
    result.removed > 0 ? `${plural(result.removed, "chat")} taken out of what is shared.` : "",
    result.keyFiles > 0
      ? `Tool calls that named key files were left out (${result.keyFiles}).`
      : "",
    result.skipped > 0 ? `${plural(result.skipped, "chat")} will follow.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The question before a project's chats are shared too. */
export function shareChatsQuestion(
  name: string,
  audience: string,
): { title: string; message: string } {
  return {
    title: `Share ${name}'s chats too?`,
    message: `${audience}\n\nThey will be able to read this project's chats with the agent and continue a copy as their own.\n\nLeft out: what you attached to a message (files, images, the editor's state), any tool call that names a key file (.env, keys and tokens) with its result, text that has the shape of a key or token, and this folder's path.\n\nNot left out: what you typed, what the agent wrote and thought, and the results of other tool calls. A secret written out in words, or read from a file with an ordinary name, travels. Look through the chats first.\n\nChats in other folders, and chats with no folder, are never shared. Turning this off removes the shared chats.`,
  };
}

/** A shared chat as its row says it. */
export function sharedChatTitle(chat: Pick<SharedChat, "title">): string {
  return chat.title.trim() || "Untitled chat";
}

/** The file name a shared chat opens under, read only. */
export function sharedChatDocument(chat: Pick<SharedChat, "title">, owner: string): string {
  const who = owner.trim() || "a teammate";
  return `${sharedChatTitle(chat).slice(0, 40)} (${who}, shared).txt`;
}

/** What a notice says of something new among the teammates' shares; null: nothing to say. */
export function newsSentence(
  news: readonly ShareNews[],
  shares: readonly Pick<ShareInfo, "id" | "name" | "owner" | "mine">[],
): { message: string; share: string | null } | null {
  const told = news.flatMap((entry) => {
    const share = shares.find((s) => s.id === entry.id && !s.mine);
    if (!share) return [];
    const who = share.owner.name.trim() || "A teammate";
    return [
      {
        id: share.id,
        text:
          entry.kind === "chats"
            ? `${who} shared the chats of ${share.name}.`
            : `${who} shared a project: ${share.name}.`,
      },
    ];
  });
  const first = told[0];
  if (!first) return null;
  if (told.length === 1) return { message: first.text, share: first.id };
  return { message: `Your team shared ${told.length} new things.`, share: null };
}

/** "Sam asked you to share a project." */
export function askSentence(asks: readonly Pick<ShareAsk, "name">[]): string {
  const names = asks.map((ask) => ask.name.trim() || "A teammate");
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} asked you to share a project.`;
  return `${nameList(names)} asked you to share a project.`;
}

/** The second switch on a shared project (D454). */
export const SHARE_CHATS_LABEL = "Share its chats too";
export const SHARE_CHATS_NOTE =
  "The same people can then read this project's chats with the agent and continue a copy as their own. Attachments, and tool calls that name a key file, are left out; what was typed and what the agent wrote is not.";

/** Said on the card when this account has no record of whom a chosen share is for (D457). */
export const AUDIENCE_UNKNOWN =
  "This account's record of who this project is shared with can't be found, so nobody is handed its keys. Choose who it is for again.";

/** What the activity says of news from the team: no teammate's words in it (D457). */
export const NEWS_LOG = "A teammate shared something with you (Sync, Team).";
export const ASK_LOG = "A teammate asked you to share a project (Sync, Team).";

/** The two ways a project is shared (D453). */
export const AUDIENCE_TEAM = "The whole team";
export const AUDIENCE_CHOSEN = "Chosen people";
/** Said under the choice when people are chosen. */
export const AUDIENCE_NOTE =
  "Only the people ticked can see this project. Taking someone off stops them reading what is shared from then on; what they already opened they keep.";

/** A teammate as the card's list of people to choose shows them. */
export interface ReaderChoice {
  uid: string;
  name: string;
  picked: boolean;
  /** Why they can't read it yet although picked ("" when they can, or aren't picked). */
  note: string;
}

/**
 * The teammates a share can be for, each with whether they are chosen (`chosen` null: the
 * whole team, so everyone is). Someone chosen who left the team isn't listed.
 */
export function readerChoices(
  members: readonly ShareMember[],
  chosen: readonly string[] | null,
  onlyVerified: boolean,
): ReaderChoice[] {
  const picked = chosen ? new Set(chosen) : null;
  return sortMembers(members.filter((member) => !member.you)).map((member) => {
    const on = !picked || picked.has(member.uid);
    const why: ShareWaiting["why"] | null =
      member.state === "nokey"
        ? "noKey"
        : member.state === "changed"
          ? "keyChanged"
          : member.state === "new" && onlyVerified
            ? "notVerified"
            : null;
    return {
      uid: member.uid,
      name: member.name,
      picked: on,
      note: on && why ? waitingWhy(why) : "",
    };
  });
}

/** The chosen people after one of them is ticked or unticked (ids of current teammates only). */
export function toggledReaders(
  members: readonly ShareMember[],
  chosen: readonly string[] | null,
  uid: string,
  on: boolean,
): string[] {
  const team = members.filter((member) => !member.you).map((member) => member.uid);
  const now = new Set(chosen ? chosen.filter((id) => team.includes(id)) : team);
  if (on && team.includes(uid)) now.add(uid);
  else now.delete(uid);
  return team.filter((id) => now.has(id));
}

/** Whether two choices of people are the same (null: the whole team). */
export function sameReaders(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}

/** "Shared with Ana and Sam only." / "Shared with your whole team." */
export function audienceSentence(
  members: readonly ShareMember[],
  chosen: readonly string[] | null,
): string {
  if (chosen === null) return "Shared with your whole team.";
  const names = sortMembers(members.filter((m) => !m.you && chosen.includes(m.uid))).map(
    (m) => m.name,
  );
  return names.length ? `Shared with ${nameList(names)} only.` : "Shared with nobody else yet.";
}

/** "3 key files were left out." ("" when none was). */
export function keyFilesLine(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? "1 key file was left out." : `${count} key files were left out.`;
}

/** What a share sync came to, in sentences: what was shared, what was left out, who waits. */
export function syncSentence(result: ShareSynced): string {
  return [
    result.snapshot
      ? "A snapshot was shared with your team."
      : "Nothing changed since the last shared snapshot.",
    keyFilesLine(result.keyFiles),
    result.renewed ? "The share's keys were renewed." : "",
    result.wrapsAdded > 0 ? `${plural(result.wrapsAdded, "teammate")} got the keys.` : "",
    ...waitingLines(result.waiting),
  ]
    .filter(Boolean)
    .join(" ");
}

/** The question before a share is stopped. */
export function unshareQuestion(
  name: string,
  team: string,
  /** The sharer, when it isn't this account (the team's owner stops a teammate's share). */
  sharer: string | null = null,
): { title: string; message: string } {
  const project = name.trim() || "this project";
  const whose = sharer === null ? "your own" : `${sharer.trim() || "the sharer"}'s own`;
  return {
    title: `Stop sharing ${project}?`,
    message: `Stop sharing ${project} with ${team.trim() || "your team"}? The shared copy is deleted; ${whose} synced copy is untouched.`,
  };
}

// ------------------------------------------------------------ the team's shares

/** Whether a share can be opened: its keys are here. */
export function canRead(state: ShareState): boolean {
  return state === "ready" || state === "mine";
}

/** How a share stands for this account, as the line in its row; null when it can just be read. */
export function shareStateLine(share: Pick<ShareInfo, "state" | "owner">): string | null {
  const who = share.owner.name.trim() || "the sharer";
  switch (share.state) {
    case "mine":
      return "Shared by you";
    case "waiting":
      return `Waiting for keys from ${who}`;
    case "keyChanged":
      return `${who}'s key changed: check People`;
    default:
      return null;
  }
}

/** Why a share can't be opened yet, as a sentence; null when it can. */
export function shareRefusal(share: Pick<ShareInfo, "state" | "owner" | "name">): string | null {
  const who = share.owner.name.trim() || "the sharer";
  if (share.state === "waiting")
    return `The keys for ${share.name} haven't reached you yet: ${who}'s computer hands them over the next time it syncs.`;
  if (share.state === "keyChanged")
    return `${who}'s key isn't the one this computer knows, so ${share.name} isn't read. Check ${who} under People: compare the new fingerprint and accept it if it matches.`;
  return null;
}

/** By name, then by whose it is; two of one name keep one order. */
export function sortShares<T extends Pick<ShareInfo, "id" | "name" | "owner">>(
  shares: readonly T[],
): T[] {
  return [...shares].sort(
    (a, b) =>
      byName(a.name, b.name) || byName(a.owner.name, b.owner.name) || (a.id < b.id ? -1 : 1),
  );
}

/** This account's own share of a project (by the project's sync id); undefined: not shared. */
export function ownShareOf<T extends Pick<ShareInfo, "project" | "mine">>(
  shares: readonly T[],
  project: string | null | undefined,
): T | undefined {
  return project ? shares.find((share) => share.mine && share.project === project) : undefined;
}

/** A share as state and commands report it: labels only, never a key. */
export interface ShareLabel {
  id: string;
  project: string;
  name: string;
  /** The sharer's name. */
  owner: string;
  mine: boolean;
  state: ShareState;
  latest: ShareLatest | null;
  /** Its chats are shared too (D454). */
  chats: boolean;
  /** Shared with chosen people, not the whole team (D453). */
  chosen: boolean;
}

export function shareLabel(share: ShareInfo): ShareLabel {
  return {
    id: share.id,
    project: share.project,
    name: share.name,
    owner: share.owner.name,
    mine: share.mine,
    state: share.state,
    latest: share.latest,
    chats: share.chats === true,
    chosen: share.chosen === true,
  };
}

/** A member as state reports them: who, and where their key stands. Never a key. */
export interface MemberLabel {
  uid: string;
  name: string;
  you: boolean;
  state: ShareMemberState;
}

export function memberLabel(member: ShareMember): MemberLabel {
  return { uid: member.uid, name: member.name, you: member.you, state: member.state };
}

/** What opening a copy came to: a title, and what to say under it. */
export function copyReport(copy: ShareCopy, name: string): { title: string; lines: string[] } {
  const files = plural(copy.restored.files, "file");
  const removed = copy.restored.deleted > 0 ? ` and removed ${copy.restored.deleted}` : "";
  const where = copy.restored.branch ? ` on ${copy.restored.branch}` : "";
  return {
    title: `A copy of ${name.trim() || "the project"} is ready`,
    lines: [
      copy.cloned
        ? `The folder was cloned from the project's remote, then brought to the snapshot: ${files} written${removed}${where}.`
        : `The snapshot's ${files} ${copy.restored.files === 1 ? "was" : "were"} written into the folder${where}. It wasn't cloned from a remote.`,
      ...(copy.note ? [copy.note] : []),
      ...copy.restored.notes,
      copy.path,
      "The folder opens like any folder someone else made: not trusted until you say so. Dependencies never travel with a snapshot: install them again if the project needs them.",
    ],
  };
}

// ------------------------------------------------------------ refusals

const REFUSALS: Readonly<Record<string, string>> = {
  ShareNoTeam: "This account isn't in a team: there is nobody to share with.",
  ShareNotMember: "This account isn't a member of that team any more.",
  ShareWaiting:
    "The keys for this project haven't reached you yet. They arrive the next time the sharer's computer syncs.",
  ShareKeyChanged:
    "A teammate's key isn't the one this computer knows. Check People on the Team page: compare the new fingerprint and accept it if it matches.",
  ShareNoMemberKey:
    "A key for sharing isn't published yet (yours, or a teammate's). It is published when sync next runs; try again in a moment.",
  ShareNotSharer: "Only the person who shares a project, or the team's owner, can do that.",
  ShareGone: "That project isn't shared any more.",
  ShareNotShared: "This project isn't shared with your team.",
  ShareNeedsService:
    "Sharing with chosen people isn't available from your account's sync service yet, so nothing was changed. You can share with the whole team.",
  ShareTooMany:
    "You share as many projects as an account can (20). Stop sharing one of them first.",
  ShareKeys:
    "The keys of this share don't fit what this computer knows, so they were refused and nothing was read. Ask the sharer to stop sharing the project and share it again.",
  ShareTargetNotEmpty: "That folder isn't empty. Choose a new or an empty folder for the copy.",
  SyncLapsed:
    "The subscription ended: what is shared can still be read, and nothing new is shared until it is renewed.",
  SyncFull: "Storage is full, so the snapshot wasn't shared. Free some room, then share again.",
  SyncOff: "Sync is off on this computer. Turn it on in the Sync tab first.",
  SyncSignedOut: "Sign in to your account to use sync.",
  SyncOffline:
    "The service can't be reached. What was read before stays; try again when you are online.",
};

/** A refused call as a sentence: the code's own when it has one, else what the call said. */
export function shareErrorWords(code: string, message: string): string {
  return REFUSALS[code] ?? (message.trim() || "Sharing failed.");
}

/** Whether a refusal says the account has nothing to list (no team, or not in it any more). */
export function noTeamCode(code: string): boolean {
  return code === "ShareNoTeam" || code === "ShareNotMember";
}

// ------------------------------------------------------------ when

/** The loop reads the team's members and shares at most this often. */
export const SHARE_REFRESH_MS = 5 * 60_000;
/** Opening a page of the Sync tab reads them again, unless they were read this recently. */
export const SHARE_PAGE_MS = 30_000;
/**
 * A shared project whose folder didn't change is still seen to this often: a teammate who
 * published a key since gets the share's keys without waiting for the next snapshot.
 */
export const SHARE_KEYS_MS = 10 * 60_000;
/** A share whose keys the service wants renewed is tried again this often. */
export const SHARE_RENEW_MS = 2 * 60_000;

/** Why the members and shares are read: the loop's pass, a page being shown, or asked for. */
export type RefreshReason = "loop" | "page" | "now";

/** Whether to read the members and shares again, last read at `readAt` (0: never). */
export function refreshDue(reason: RefreshReason, readAt: number, now: number): boolean {
  if (reason === "now" || readAt <= 0) return true;
  return now - readAt >= (reason === "page" ? SHARE_PAGE_MS : SHARE_REFRESH_MS);
}

/**
 * Whether the loop sees to a share's keys now though no snapshot was taken: the service says
 * its keys need renewing (someone left the team, a key changed), or it wasn't looked at for a
 * while. `syncedAt`: when this window last synced the share (0: not yet).
 */
export function keysDue(rotationNeeded: boolean, syncedAt: number, now: number): boolean {
  if (syncedAt <= 0) return true;
  // Asked for by the service, but not on every pass while it can't be done (a member's key
  // is missing): a minute's pass is too often to walk the folder for it.
  if (rotationNeeded) return now - syncedAt >= SHARE_RENEW_MS;
  return now - syncedAt >= SHARE_KEYS_MS;
}
