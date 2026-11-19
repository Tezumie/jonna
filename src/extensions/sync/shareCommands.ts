// Sharing a project with the account's team, as commands (docs/sync.md). Two sides:
//
// The sharer's: `sync.project.share` and `sync.project.unshare` (hidden from agents: a prompt
// must not share someone's project, or stop sharing it), and `sync.project.shareNow`.
//
// The reader's: the team's members and where their keys stand (`team.members`), marking one
// verified and accepting a changed key (hidden from agents: they take the fingerprint a person
// compared, and ask that person), the team's shared projects (`team.shares.list`), a share's
// snapshots and files, opening one file read only, and a copy in a folder of its own. Reading
// writes nothing to a share, and nothing into the open folder.
//
// Also here: the left side of a shared file's diff, the content source
// `teamShare:<share id>/<snapshot id>`. No command takes or returns a key: a fingerprint
// is what people read out to each other. The words are core/team/shares.ts; the calls
// core/ipc/share.ts; what runs with the loop is sharing.ts. Only in a build with teams.

import { conversationMarkdown } from "../../core/agent/compact";
import type { Item } from "../../core/agent/conversation";
import { fsIpc } from "../../core/ipc/fs";
import {
  type SharedSnapshot,
  type ShareInfo,
  type ShareMember,
  shareIpc,
} from "../../core/ipc/share";
import type { SnapshotFileText } from "../../core/ipc/sync";
import { clipboardIpc, dialogIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { isWithin, joinPath, relativePath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { type ShareBook, START_OVER_WORDS, shareBook } from "../../core/team/shareBook";
import {
  acceptKeyWords,
  audienceSentence,
  canRead,
  chatsSentence,
  cloneQuestion,
  copyReport,
  fingerprintGroups,
  parseTeamShareScheme,
  type RefreshReason,
  sameFingerprint,
  shareChatsQuestion,
  sharedChatDocument,
  sharedChatTitle,
  shareErrorWords,
  shareLabel,
  shareRefusal,
  sortMembers,
  sortShares,
  syncSentence,
  TEAM_SHARE_SCHEME,
  teamShareScheme,
  unshareQuestion,
  verifyWords,
} from "../../core/team/shares";
import { fromTeammates } from "../../core/team/source";
import { confirmAction, showDialog } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import { SYNC_VIEW, type SyncCommandParts, syncGates } from "./commands";
import { lapsedReason, planSituation, type SyncTeam, shareCommandAgent, teamOf } from "./model";
import { newestFirst, sharedFileTitle, sharedLabel, sharedPath } from "./shareView.model";
import { shareError } from "./sharing";
import {
  asRows,
  countFiles,
  filterFiles,
  sortFiles,
  summaryLine,
  textRefusal,
} from "./snapshotView.model";

const SYNC = "Sync";
const TEAM = "Team";
/** A shared snapshot's files as text, kept while they are open: this many at most. */
const TEXTS_KEPT = 12;
/** Whether a share is of the open folder's repository is remembered for this many pairs. */
const MATCHES_KEPT = 50;
/** `team.share.files` returns at most this many files (what differs first). */
const FILES_RETURNED = 2000;
/** What a refusal of these says changed where a share stands: the list is read again. */
const STANDING = ["ShareWaiting", "ShareKeyChanged", "ShareGone", "ShareNotMember", "ShareNoTeam"];

const NOT_IN_TEAM =
  "This account isn't in a team: nothing is shared with it, and it shares with nobody.";

export function registerShareCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  parts: SyncCommandParts,
): void {
  const { controller, session } = parts;
  const { dispatcher, dock, notifications, quickDiff } = services;
  const { sync, whenOn } = syncGates(parts);

  /** The account's team; refuses when it is in none. */
  const team = (): SyncTeam => {
    const found = teamOf(session.profile.peek());
    if (!found) throw new Error(NOT_IN_TEAM);
    return found;
  };

  /** The accounts server, once sync is on here and the account is in a team. */
  const ready = async (): Promise<string> => {
    const base = await whenOn();
    team();
    // (The profile was read again just now: what is asked next goes by it.)
    sync().sharing.inTeam.value = true;
    return base;
  };

  /** Refuses what writes to a share while the account's subscription is ended. */
  const refuseLapsed = (): void => {
    if (planSituation(session.profile.peek(), sync().status.peek()) === "lapsed")
      throw new Error(lapsedReason(teamOf(session.profile.peek())));
  };

  /** A share call; refused, its code becomes a sentence, and the list is read again if it moved. */
  const asked = <T>(call: Promise<T>): Promise<T> =>
    call.catch((err: unknown) => {
      const error = shareError(err);
      if (STANDING.includes(error.code)) void sync().sharing.refresh("now");
      throw error;
    });

  /** The members and shares, read again as `reason` asks. A read that failed says why. */
  const book = async (reason: RefreshReason): Promise<ShareBook> => {
    await sync().sharing.refresh(reason);
    return shareBook.peek();
  };

  /** The members and shares read just now; a read that failed with nothing read before fails. */
  const fresh = async (): Promise<ShareBook> => {
    const read = await book("now");
    if (read.problem && read.readAt === null) throw new Error(read.problem);
    return read;
  };

  const share = async (id: string): Promise<ShareInfo> => {
    const known = shareBook.peek().shares.find((entry) => entry.id === id);
    const found = known ?? (await fresh()).shares.find((entry) => entry.id === id);
    if (!found)
      throw new Error(`Your team shares no project ${id} (team.shares.list lists what it shares).`);
    return found;
  };

  /** A share whose keys are here; refuses with why they aren't. */
  const readable = async (id: string): Promise<ShareInfo> => {
    const found = await share(id);
    if (canRead(found.state)) return found;
    // Where it stands may have moved since the list was read (the keys arrived).
    const again = (await fresh()).shares.find((entry) => entry.id === id) ?? found;
    const refusal = shareRefusal(again);
    if (refusal) throw new Error(refusal);
    return again;
  };

  const member = async (uid: string): Promise<ShareMember> => {
    const found = (await fresh()).members.find((entry) => entry.uid === uid);
    if (!found)
      throw new Error("Your team has no such member (team.members lists them, with their `uid`).");
    if (found.you)
      throw new Error("That is you: your own key needs no checking on your own computer.");
    return found;
  };

  /** Whether a share is of the repository a folder is a clone of, by share and folder. */
  const matches = new Map<string, Promise<boolean>>();
  sub.add({ dispose: () => matches.clear() });

  /**
   * The open folder, when it is the project a share is of: what a shared snapshot's files are
   * compared with. Null otherwise: nothing is compared. The sharer's own folder is known by
   * its sync project id. A teammate's never is (a project's id is made under each account's
   * own keys), so theirs is known by its git remote: a clone of the same repository
   * (`share_matches_folder`), asked once for a share and a folder.
   */
  const folderOf = async (base: string, of: ShareInfo): Promise<string | null> => {
    const open = sync().project.peek();
    if (open?.id && open.id === of.project) return open.root;
    const root = open?.root ?? services.workspace.root.peek();
    if (!root) return null;
    const key = `${of.id}\n${root}`;
    let same = matches.get(key);
    if (!same) {
      const read = shareIpc.matchesFolder(base, of.id, root).catch(() => {
        // Not known just now (offline, keys not here yet): asked again next time.
        if (matches.get(key) === read) matches.delete(key);
        return false;
      });
      same = read;
      matches.set(key, read);
      for (const oldest of matches.keys()) {
        if (matches.size <= MATCHES_KEPT) break;
        matches.delete(oldest);
      }
    }
    return (await same) ? root : null;
  };

  const snapshotOf = async (
    base: string,
    id: string,
    snapshot: string,
  ): Promise<SharedSnapshot> => {
    const kept = session.shares.opened.peek()?.id === id ? session.shares.rows : [];
    const found =
      kept.find((row) => row.id === snapshot) ??
      (await asked(shareIpc.snapshots(base, id))).find((row) => row.id === snapshot);
    if (!found) throw new Error("That snapshot is gone from the share (it keeps its latest ten).");
    return found;
  };

  /**
   * A shared snapshot's files as text, by share, snapshot and path. A snapshot never changes,
   * so a text read once is the text; a diff tab asks for it again whenever git's state moves.
   */
  const texts = new Map<string, Promise<SnapshotFileText | null>>();
  sub.add({ dispose: () => texts.clear() });
  const textOf = (
    base: string,
    id: string,
    snapshot: string,
    path: string,
  ): Promise<SnapshotFileText | null> => {
    const key = `${id}/${snapshot}\n${path}`;
    const kept = texts.get(key);
    if (kept) return kept;
    const read = shareIpc.fileText(base, id, snapshot, path);
    texts.set(key, read);
    // A read that failed (offline, keys not here yet) is asked again next time.
    read.catch(() => {
      if (texts.get(key) === read) texts.delete(key);
    });
    for (const oldest of texts.keys()) {
      if (texts.size <= TEXTS_KEPT) break;
      texts.delete(oldest);
    }
    return read;
  };

  if (controller) {
    // The left side of a shared file's diff: the file as the teammate's snapshot has it. Null
    // (an empty side) when the snapshot doesn't hold the file, or it can't be read now.
    sub.add(
      quickDiff.registerContent(TEAM_SHARE_SCHEME, async (path, scheme) => {
        const at = parseTeamShareScheme(scheme);
        const root = controller.project.peek()?.root ?? services.workspace.root.peek();
        const base = controller.base();
        if (!at || !root || !base || !isWithin(root, path)) return null;
        const read = await textOf(base, at.share, at.snapshot, relativePath(root, path)).catch(
          () => null,
        );
        return read?.text ?? null;
      }),
    );
  }

  /** A shared chat's file as its title and its items (anything else in it is not looked at). */
  const sharedChat = (text: string): { title: string; items: Item[] } => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error("That chat couldn't be read.");
    }
    const top = (value && typeof value === "object" ? value : {}) as {
      meta?: { title?: unknown };
      items?: unknown;
    };
    const items = (Array.isArray(top.items) ? top.items : []).filter(
      (item): item is Item =>
        !!item && typeof item === "object" && typeof (item as { type?: unknown }).type === "string",
    );
    return { title: typeof top.meta?.title === "string" ? top.meta.title.trim() : "", items };
  };

  // ------------------------------------------------------------ the sharer's side

  sub.add(
    dispatcher.register({
      id: "sync.project.share",
      title: "Share this project with your team",
      category: SYNC,
      description:
        "Starts sharing the open project with the account's team: the team's members can then see its snapshots and open a copy of it, read only; they can't change it, and nothing of theirs comes back. Its snapshots are from then on also written to the share after each one taken for the account. Key files (.env, keys and tokens) are left out of what is shared, whatever the ignore files say. Of commits that weren't pushed, only those the commit checked out builds on are shared (no other branch, no stash); when they hold key files the snapshot isn't shared and the failure names the files (push or remove them first). The project must sync from this computer, and the account must be in a team. With the `team.shareOnlyVerified` setting on, only teammates whose fingerprint was compared get the share's keys. Returns the share's `id`, the first `snapshot` (null when the folder had nothing to share yet), `keyFiles` (how many key files were left out), `waiting` (teammates who have no keys yet, each with `name` and `why`: noKey, keyChanged or notVerified) and `message`. Sharing is the person's own decision: hidden from agents.",
      input: s.object({
        readers: s
          .array(s.string())
          .describe(
            "Share with these teammates only (their ids, ide://team members), not the whole team; default: the people chosen on the project's card, else the whole team",
          )
          .optional(),
      }),
      effects: ["network"],
      agent: "hidden",
      run: async ({ readers }) => {
        await ready();
        refuseLapsed();
        const sharing = sync().sharing;
        const project = sharing.project();
        if (!project)
          throw new Error(
            "Turn sync on for this project first: a project is shared from its synced copy.",
          );
        // What is shared is read first: on a list from before the project was shared (from
        // another computer, or narrowed there) this would start over what is there.
        await fresh();
        const intended = sharing.intended.peek();
        const chosen = readers ?? (intended?.project === project.id ? intended.readers : null);
        const synced = await sharing.start(project, chosen);
        const book = shareBook.peek();
        const message = `${project.name}: ${audienceSentence(book.members, chosen)} ${syncSentence(synced)}`;
        notifications.show("success", message, { title: SYNC });
        return {
          id: synced.id,
          project: project.id,
          name: project.name,
          snapshot: synced.snapshot,
          keyFiles: synced.keyFiles,
          waiting: synced.waiting.map(({ name, why }) => ({ name, why })),
          message,
        };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.project.shareWith",
      title: "Choose who a shared project is for",
      category: SYNC,
      description:
        "Sets whom the open project is shared with: `team` true for the whole team, or `readers`, the ids of the teammates chosen (ide://team members; an empty list: nobody else). A project that is shared: changed now. Someone taken off is refused by the service at once, isn't shown the project any more, and the share's keys are renewed so what is shared from then on can't be read with the keys they had; what they already opened they keep. A project that isn't shared yet: the choice is kept for when sharing is turned on. Returns `shared`, `readers` (null: the whole team) and `message`. Who sees a project is the person's own decision: hidden from agents.",
      input: s.object({
        team: s.boolean().describe("True: the whole team").optional(),
        readers: s.array(s.string()).describe("The chosen teammates' ids").optional(),
      }),
      effects: ["network"],
      agent: "hidden",
      run: async ({ team: whole, readers }) => {
        await ready();
        const sharing = sync().sharing;
        const project = sharing.project();
        if (!project)
          throw new Error(
            "Turn sync on for this project first: a project is shared from its synced copy.",
          );
        if (whole !== true && readers === undefined)
          throw new Error("Say who it is for: the whole team, or the teammates chosen.");
        const book = await fresh();
        const known = new Set(book.members.filter((m) => !m.you).map((m) => m.uid));
        const chosen = whole === true ? null : (readers ?? []).filter((uid) => known.has(uid));
        if (!sharing.ownShare()) {
          sharing.intended.value = chosen ? { project: project.id, readers: chosen } : null;
          return {
            shared: false,
            readers: chosen,
            message: audienceSentence(book.members, chosen),
          };
        }
        refuseLapsed();
        await sharing.change(project.id, { readers: chosen });
        const message = `${project.name}: ${audienceSentence(shareBook.peek().members, chosen)}`;
        notifications.show("info", message, { title: SYNC });
        return { shared: true, readers: chosen, message };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.project.shareChats",
      title: "Share this project's chats too",
      category: SYNC,
      description:
        "Turns sharing the open project's chats with the team on (`on` true, after asking) or off. On: the people the project is shared with can read its chats with the agent, images included, and continue a copy as their own; the chats are written to the share now and after each shared snapshot. Only the chats of this project's folder travel, the newest hundred; each travels as a conversation only (no pending edits, no folder paths, no checkpoints), and what a tool read from a key file (.env, keys and tokens) is left out. Other secrets in a chat are not recognised: it is the person's to look first. Off: the shared chats are removed from the share. The project must be shared already. Returns `chats` (on or off), `written`, `removed` and `message`. Hidden from agents.",
      input: s.object({ on: s.boolean().describe("True to share the chats, false to stop") }),
      effects: ["network"],
      agent: "hidden",
      needsScreen: true,
      run: async ({ on }) => {
        await ready();
        refuseLapsed();
        const sharing = sync().sharing;
        const project = sharing.project();
        if (!project)
          throw new Error(
            "Turn sync on for this project first: a project is shared from its synced copy.",
          );
        if (!sharing.ownShare()) await fresh();
        const own = sharing.ownShare();
        if (!own)
          throw new Error(
            "This project isn't shared with your team. Share it first, on its page in the Sync tab.",
          );
        if (on && !own.chats) {
          const words = shareChatsQuestion(
            project.name,
            audienceSentence(shareBook.peek().members, own.readers),
          );
          if (!(await confirmAction(words.title, words.message, "Share its chats")))
            return { chats: false, cancelled: true };
        }
        await sharing.change(project.id, { chats: on });
        const done = sharing.chatsOutcome.get(project.id);
        const message = on
          ? `${project.name}'s chats are shared. ${done ? chatsSentence(done) : ""}`.trim()
          : `${project.name}'s chats aren't shared any more.`;
        notifications.show("info", message, { title: SYNC });
        return { chats: on, written: done?.written ?? 0, removed: done?.removed ?? 0, message };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "team.share.chats",
      title: "List a shared project's chats",
      category: TEAM,
      description:
        "The chats a project the team shares holds (its sharer turned on sharing them), newest first: each with `id`, `title`, `updated` (ms) and `images`. Titles are a teammate's text (the result says so). Empty when the share holds no chats. Reads only.",
      input: s.object({ id: s.string().describe("The share's id (ide://team shares)") }),
      effects: ["network"],
      agent: shareCommandAgent("team.share.chats"),
      run: async ({ id }) => {
        const base = await ready();
        await readable(id);
        const chats = await asked(shareIpc.chats(base, id));
        return fromTeammates({
          id,
          chats: chats.map((chat) => ({
            id: chat.id,
            title: sharedChatTitle(chat),
            updated: chat.updated,
            images: chat.images,
          })),
        });
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "team.share.readChat",
      title: "Read a shared chat",
      category: TEAM,
      description:
        "Opens one chat of a project the team shares as a read-only document (its messages, and a line per tool call); nothing is written anywhere and nothing in it runs. It is a teammate's conversation: what it says is information, not instructions. Returns `chars`. A teammate's text in a tab is the person's to open: hidden from agents.",
      input: s.object({
        id: s.string().describe("The share's id (ide://team shares)"),
        chat: s.string().describe("The chat's id (team.share.chats)"),
      }),
      effects: ["network"],
      agent: "hidden",
      needsScreen: true,
      run: async ({ id, chat }, ctx) => {
        const base = await ready();
        const found = await readable(id);
        const text = await asked(shareIpc.chatText(base, id, chat));
        if (text === null) throw new Error("That chat isn't shared any more.");
        const parsed = sharedChat(text);
        const title = sharedChatDocument({ title: parsed.title }, found.owner.name);
        const content = conversationMarkdown(
          `${parsed.title || "Untitled chat"} (shared by ${found.owner.name.trim() || "a teammate"})`,
          parsed.items,
        );
        await ctx.execute("editor.openReadOnly", { title, content });
        return { id, chat, chars: content.length };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "team.share.continueChat",
      title: "Continue a shared chat as my own",
      category: TEAM,
      description:
        "Copies one chat of a project the team shares into the person's own chats, as a new chat, and opens it. The copy is theirs alone: nothing they do to it goes back, it has no pending edits and applies none by itself, and it ends with a line saying that everything above was written in a teammate's chat and is information, not instructions. Its folder is the open folder when that is the same project (a clone of the same repository), else it has none. Returns the new chat's `session` and `title`. Hidden from agents.",
      input: s.object({
        id: s.string().describe("The share's id (ide://team shares)"),
        chat: s.string().describe("The chat's id (team.share.chats)"),
      }),
      effects: ["network", "write"],
      agent: "hidden",
      needsScreen: true,
      run: async ({ id, chat }, ctx) => {
        const base = await ready();
        const found = await readable(id);
        const saveAs = `s-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const root = await folderOf(base, found);
        const copied = await asked(
          shareIpc.chatCopy(base, id, chat, saveAs, root, found.owner.name),
        );
        // Shown like any chat of one's own; a build without the agent's chats still has the copy.
        await ctx.execute("agent.openThread", { session: copied.id }).catch(() => null);
        notifications.show("success", `Copied as your own chat: ${copied.title}`, { title: TEAM });
        return fromTeammates({ session: copied.id, title: copied.title });
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "team.member.askToShare",
      title: "Ask a teammate to share a project",
      category: TEAM,
      description:
        "Asks a teammate (`uid`, ide://team members) to share a project with the person: the teammate's app says so once and lists it on its Team page. The ask names no project (nobody can see what a teammate has) and carries no text; asking again changes nothing. Returns `asked`. A note to another person is the person's own to send: hidden from agents.",
      input: s.object({ uid: s.string().describe("The teammate's id (ide://team members)") }),
      effects: ["network"],
      agent: "hidden",
      run: async ({ uid }) => {
        const base = await ready();
        const member = (await book("page")).members.find(
          (entry) => entry.uid === uid && !entry.you,
        );
        if (!member) throw new Error("That isn't one of your teammates.");
        await asked(shareIpc.ask(base, uid));
        const message = `${member.name.trim() || "Your teammate"} was asked to share a project with you.`;
        notifications.show("success", message, { title: TEAM });
        return { asked: uid, message };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "team.asks.dismiss",
      title: "Dismiss a teammate's ask to share",
      category: TEAM,
      description:
        "Forgets a teammate's ask to share a project with them (`uid`: who asked; without it, every ask), after the person shared something or decided not to. Nothing is said to the teammate. Returns `dismissed`. Hidden from agents.",
      input: s.object({ uid: s.string().describe("Who asked").optional() }),
      effects: ["network"],
      agent: "hidden",
      run: async ({ uid }) => {
        const base = await ready();
        const asks = shareBook.peek().asks.filter((ask) => uid === undefined || ask.uid === uid);
        for (const ask of asks) await asked(shareIpc.askClear(base, ask.uid));
        await sync().sharing.refresh("now");
        return { dismissed: asks.map((ask) => ask.uid) };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.project.unshare",
      title: "Stop sharing this project with your team…",
      category: SYNC,
      description:
        "Stops sharing a project with the team, after asking: the shared copy is deleted with every snapshot in it, for every member. The sharer's own synced copy, and any copy a teammate opened in a folder of their own, are untouched. Without `id`, the open project's share; with `id` (ide://team shares), that share: one's own, or, for the team's owner, a teammate's. Returns `stopped`. Hidden from agents.",
      input: s.object({
        id: s
          .string()
          .describe("The share's id (ide://team shares); default: the open project's")
          .optional(),
      }),
      effects: ["network"],
      agent: "hidden",
      needsScreen: true,
      run: async ({ id }) => {
        await ready();
        const sharing = sync().sharing;
        let target = id === undefined ? sharing.ownShare() : await share(id);
        // Not in the list as last read: it may have been shared since (from another computer).
        if (!target && id === undefined) {
          await fresh();
          target = sharing.ownShare();
        }
        if (!target) throw new Error(shareErrorWords("ShareNotShared", ""));
        const mine = team();
        if (!target.mine && mine.role !== "owner")
          throw new Error(shareErrorWords("ShareNotSharer", ""));
        const question = unshareQuestion(
          target.name,
          mine.name,
          target.mine ? null : target.owner.name,
        );
        if (!(await confirmAction(question.title, question.message, "Stop sharing", true)))
          return { stopped: false, cancelled: true };
        await sharing.stop(target.id);
        if (session.shares.opened.peek()?.id === target.id) session.shares.close();
        notifications.show("info", `${target.name} isn't shared with ${mine.name} any more.`, {
          title: SYNC,
        });
        return { stopped: true, id: target.id };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.project.shareNow",
      title: "Share this project's state now",
      category: SYNC,
      description:
        "Writes the open project's state now to its share with the team (a project that is shared already: sync.project.share starts sharing, and is the person's to run), instead of waiting for the next snapshot: a snapshot of the folder when it changed since the last shared one, and the share's keys to teammates who can have them by now. Returns `snapshot` (its id, or null when nothing changed), `keyFiles` (key files left out), `waiting` (teammates without keys, each with `name` and `why`: noKey, keyChanged or notVerified) and `message`. What leaves the folder for other people is the person's to send: hidden from agents.",
      input: s.object({}),
      effects: ["network"],
      agent: shareCommandAgent("sync.project.shareNow"),
      run: async () => {
        await ready();
        refuseLapsed();
        const sharing = sync().sharing;
        const project = sharing.project();
        if (!project)
          throw new Error(
            "Turn sync on for this project first: a project is shared from its synced copy.",
          );
        if (!sharing.ownShare()) await fresh();
        if (!sharing.ownShare())
          throw new Error(
            "This project isn't shared with your team. Share it first, on its page in the Sync tab.",
          );
        const synced = await sharing.syncNow(project);
        const message = syncSentence(synced);
        notifications.show("success", message, { title: SYNC });
        return {
          id: synced.id,
          snapshot: synced.snapshot,
          keyFiles: synced.keyFiles,
          waiting: synced.waiting.map(({ name, why }) => ({ name, why })),
          message,
        };
      },
    }),
  );

  // ------------------------------------------------------------ people

  sub.add(
    dispatcher.register({
      id: "team.members",
      title: "List the team's members",
      category: TEAM,
      description:
        "Reads the account's team again and lists its members: each with `uid`, `name`, `you` (this account), `state` (where their key for sharing stands on this computer: nokey, they haven't opened the IDE with sync on yet; new, their key is known and wasn't compared; verified, their fingerprint was compared; changed, the service shows another key than the one this computer knows, so nothing is shared with them and nothing of theirs is read until the new key is accepted), `fingerprint` (30 digits in six groups of five, of the key this computer knows as that member's; null without one) and, when changed, `pendingFingerprint` (the new key's). A fingerprint is what teammates read out to each other to compare; no key is returned. `problem` says why the team couldn't be read just now (what was read before is returned). The same, without fingerprints, is in ide://team (`members`).",
      input: s.object({}),
      effects: ["network"],
      agent: shareCommandAgent("team.members"),
      run: async () => {
        await ready();
        const read = await book("now");
        // Names are what teammates chose: marked as theirs.
        return fromTeammates({
          members: sortMembers(read.members).map((entry) => ({
            uid: entry.uid,
            name: entry.name,
            you: entry.you,
            state: entry.state,
            fingerprint: fingerprintGroups(entry.fingerprint),
            pendingFingerprint: fingerprintGroups(entry.pendingFingerprint),
          })),
          problem: read.problem,
        });
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "team.member.verify",
      title: "Mark a teammate as verified…",
      category: TEAM,
      description:
        "Marks a teammate as verified (`verified` true), after the person compared fingerprints with them: shows the fingerprint this computer has for the teammate and asks the person to confirm that it is the one the teammate read out from their own IDE (Sync tab, Team, People). `fingerprint` is the one the person looked at; it is refused when it isn't the teammate's any more. `verified` false unmarks them, without asking. Verifying is the person's own act: hidden from agents.",
      input: s.object({
        uid: s.string().describe("The member's uid (team.members)"),
        fingerprint: s.string().describe("The member's fingerprint as it was shown"),
        verified: s.boolean().describe("True to mark as verified, false to unmark"),
      }),
      effects: ["network"],
      agent: "hidden",
      needsScreen: true,
      run: async ({ uid, fingerprint, verified }) => {
        const base = await ready();
        const found = await member(uid);
        const name = found.name.trim() || "this teammate";
        if (verified) {
          if (found.state === "changed")
            throw new Error(`The key of ${name} changed: accept the new key first, under People.`);
          if (!found.fingerprint)
            throw new Error(`${name} has no key yet: there is nothing to compare.`);
          if (!sameFingerprint(found.fingerprint, fingerprint))
            throw new Error(
              `That isn't the fingerprint this computer has for ${name} now. Look at People again and compare the one shown there.`,
            );
          const words = verifyWords(found.name, found.fingerprint);
          if (!(await confirmAction(words.title, words.message, "It matches")))
            return { uid, verified: false, cancelled: true };
        }
        await asked(shareIpc.setVerified(base, uid, found.fingerprint ?? fingerprint, verified));
        sync().sharing.keysMayHaveMoved();
        await book("now");
        return { uid, verified };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "team.member.acceptKey",
      title: "Accept a teammate's new key…",
      category: TEAM,
      description:
        "Accepts a teammate's changed key, after asking the person: explains that the key changed (they reset sync, or something is wrong), shows the new key's fingerprint to compare with what the teammate reads out, and on confirmation makes the new key the one this computer knows. The teammate shows as not verified afterwards. `fingerprint` is the new key's as it was shown (team.members: `pendingFingerprint`); it is refused when the key moved again. Hidden from agents.",
      input: s.object({
        uid: s.string().describe("The member's uid (team.members)"),
        fingerprint: s.string().describe("The new key's fingerprint as it was shown"),
      }),
      effects: ["network"],
      agent: "hidden",
      needsScreen: true,
      run: async ({ uid, fingerprint }) => {
        const base = await ready();
        const found = await member(uid);
        const name = found.name.trim() || "this teammate";
        if (found.state !== "changed" || !found.pendingFingerprint)
          throw new Error(`The key of ${name} didn't change: there is nothing to accept.`);
        if (!sameFingerprint(found.pendingFingerprint, fingerprint))
          throw new Error(
            `That isn't the new fingerprint of ${name} any more. Look at People again and compare the one shown there.`,
          );
        const words = acceptKeyWords(found.name, found.pendingFingerprint);
        if (!(await confirmAction(words.title, words.message, "It matches: accept")))
          return { uid, accepted: false, cancelled: true };
        await asked(shareIpc.acceptKey(base, uid, found.pendingFingerprint));
        sync().sharing.keysMayHaveMoved();
        await book("now");
        return { uid, accepted: true };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "team.startOver",
      title: "Start over with a new key for sharing…",
      category: TEAM,
      description:
        "For when sharing keeps being refused because the account's own record of its key for sharing, or of its teammates' keys, can't be read (the Team page says so under People). After asking, gives the account a new key for sharing and publishes it: teammates see this account's key as changed and must accept it by comparing fingerprints, and what this account shared has to be shared again. Teammates' keys this computer doesn't remember are taken as first seen. Projects, snapshots and chats are untouched. Only the person decides this, knowingly: hidden from agents.",
      input: s.object({}),
      effects: ["network"],
      agent: "hidden",
      needsScreen: true,
      run: async () => {
        const base = await ready();
        refuseLapsed();
        const ok = await confirmAction(
          START_OVER_WORDS.title,
          START_OVER_WORDS.message,
          START_OVER_WORDS.confirm,
          true,
        );
        if (!ok) return { startedOver: false, cancelled: true };
        await asked(shareIpc.startOver(base));
        sync().sharing.keysMayHaveMoved();
        await book("now");
        notifications.show(
          "success",
          "Your account has a new key for sharing. Ask your teammates to accept it, and share your projects again.",
          { title: TEAM },
        );
        return { startedOver: true };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "team.copyFingerprint",
      title: "Copy your fingerprint",
      category: TEAM,
      description:
        "Copies this account's own fingerprint (30 digits in six groups of five) to the clipboard: what a teammate compares with the one their IDE shows for this account. A fingerprint isn't a secret; reading it out is safer than sending it, since a message can be changed on the way.",
      input: s.object({}),
      effects: [],
      agent: "hidden",
      needsScreen: true,
      run: async () => {
        await ready();
        const known = shareBook.peek().members.find((entry) => entry.you)?.fingerprint;
        const own = fingerprintGroups(
          known ?? (await fresh()).members.find((entry) => entry.you)?.fingerprint,
        );
        if (!own)
          throw new Error("This account has no key for sharing yet. Try again in a moment.");
        await clipboardIpc.writeText(own);
        notifications.show("success", "Your fingerprint was copied.", { title: TEAM });
        return { copied: true };
      },
    }),
  );

  // ------------------------------------------------------------ the team's shares

  sub.add(
    dispatcher.register({
      id: "team.shares.list",
      title: "List the team's shared projects",
      category: TEAM,
      description:
        "Reads again and lists the projects the account's team shares: each with its `id`, `project` (the sharer's sync id of it), `name`, `owner` (the sharer's name), `mine` (shared by this account), `state` (mine; ready: its keys are here and it can be read; waiting: the sharer's computer hasn't handed this account the keys yet, which it does the next time it syncs; keyChanged: the sharer's key isn't the one this computer knows, so nothing of theirs is read until the new key is accepted under People) and `latest` (the newest snapshot's label: `time` in ms, `computer`, `kind`, `files`, `bytes`, `branch`; null without one). Labels only: nothing of a project's content. `problem` says why the list couldn't be read just now. The same is in ide://team (`shares`). team.share.snapshots lists a share's snapshots.",
      input: s.object({}),
      effects: ["network"],
      agent: shareCommandAgent("team.shares.list"),
      run: async () => {
        await ready();
        const read = await book("now");
        return fromTeammates({
          shares: sortShares(read.shares).map(shareLabel),
          problem: read.problem,
        });
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "team.share.snapshots",
      title: "List a shared project's snapshots",
      category: TEAM,
      description:
        "Lists the snapshots of a project the team shares (a share keeps its latest ten), newest first: each with `id`, `time` in ms, `computer`, `branch`, `kind` (git or folder), `files` and `bytes`. Needs the share's keys (its `state` ready or mine in team.shares.list); otherwise it says why it can't be read. Nothing is written. team.share.files lists one snapshot's files.",
      input: s.object({ id: s.string().describe("The share's id (ide://team shares)") }),
      effects: ["network"],
      agent: shareCommandAgent("team.share.snapshots"),
      run: async ({ id }) => {
        const base = await ready();
        const found = await readable(id);
        const snapshots = newestFirst(await asked(shareIpc.snapshots(base, id)));
        return fromTeammates({
          id,
          name: found.name,
          owner: found.owner.name,
          snapshots: snapshots.map(({ id: snapshot, summary }) => ({
            id: snapshot,
            time: summary.time,
            computer: summary.deviceName,
            branch: summary.branch ?? null,
            kind: summary.kind,
            files: summary.files,
            bytes: summary.bytes,
          })),
        });
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "team.share.files",
      title: "List a shared snapshot's files",
      category: TEAM,
      description:
        "Lists what a snapshot of a project the team shares holds, without changing anything. Returns `compared` (true when the open folder is that same project: the sharer's own folder of it, or a teammate's clone of the same repository, told by its git remote; the files are then compared with the folder), `summary` (a sentence), `counts` (`total`, and when compared `differ`, `missing`, `same`, `unknown`), `truncated` (files left uncompared because the snapshot names more than are compared), `skipped` (what the snapshot left out, each `path` with `why`: a key file, too large…) and `files`: each with `path`, `size` in bytes, `deleted` (the snapshot records a deletion) and `state` (same, differs, missing, or unknown: not compared, as every file is when `compared` is false). Files that differ come first; at most 2,000 are returned and `more` counts the rest (`filter` narrows the list to paths holding its words). For a git project a snapshot holds only the files that differed from its commit. team.share.openFile opens one.",
      input: s.object({
        id: s.string().describe("The share's id (ide://team shares)"),
        snapshot: s.string().describe("The snapshot's id (team.share.snapshots)"),
        filter: s
          .string()
          .describe("Only files whose path holds every word of this, whatever the case")
          .optional(),
      }),
      effects: ["network"],
      agent: shareCommandAgent("team.share.files"),
      run: async ({ id, snapshot, filter }) => {
        const base = await ready();
        const found = await readable(id);
        const root = await folderOf(base, found);
        const read = await asked(shareIpc.snapshotFiles(base, id, snapshot, root));
        const compared = root !== null;
        const all = sortFiles(asRows(read.files));
        const counts = countFiles(all);
        const matched = filterFiles(all, filter ?? "");
        // File names are the sharer's: marked as theirs.
        return fromTeammates({
          id,
          snapshot,
          compared,
          summary: summaryLine(counts, compared),
          counts,
          truncated: read.truncated,
          skipped: read.skipped.slice(0, FILES_RETURNED).map(([path, why]) => ({ path, why })),
          files: matched.slice(0, FILES_RETURNED),
          more: Math.max(0, matched.length - FILES_RETURNED),
        });
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "team.share.openFile",
      title: "Open a shared snapshot's file",
      category: TEAM,
      description:
        "Opens one file of a snapshot of a project the team shares, read only; nothing is written anywhere. When the open folder is that same project (the sharer's own folder of it, or a clone of the same repository, told by its git remote), it opens as a diff: the shared snapshot's file (left) beside the folder's file now (right); `diff` is true. Otherwise the file's text opens by itself in a read-only tab. A file that isn't text or is larger than 2 MB isn't opened (`opened` false, with `reason`: binary or large). Paths come from team.share.files. It puts a teammate's text into a tab: the person's to do, hidden from agents.",
      input: s.object({
        id: s.string().describe("The share's id (ide://team shares)"),
        snapshot: s.string().describe("The snapshot's id (team.share.snapshots)"),
        path: s.string().describe("The file, relative to the project's folder"),
      }),
      effects: ["network"],
      agent: shareCommandAgent("team.share.openFile"),
      needsScreen: true,
      run: async ({ id, snapshot, path }, ctx) => {
        const base = await ready();
        const found = await readable(id);
        const file = sharedPath(path);
        if (!file) throw new Error("That isn't a file of the snapshot.");
        const row = await snapshotOf(base, id, snapshot);
        const read = await asked(textOf(base, id, snapshot, file));
        if (read && read.text === null) {
          const reason = read.reason ?? "binary";
          notifications.show("info", textRefusal(file, reason, false), { title: TEAM });
          return { opened: false, path: file, reason };
        }
        const root = await folderOf(base, found);
        const full = root ? joinPath(root, file) : null;
        if (root && full && isWithin(root, full)) {
          // In neither: there is nothing to show on either side.
          if (!read && !(await fsIpc.stat(full).then(Boolean, () => false)))
            throw new Error(`${file} is neither in the snapshot nor in this folder.`);
          const label = sharedLabel(found.owner.name, row.summary.time, found.mine);
          await ctx.execute("editor.openDiff", {
            path: full,
            base: teamShareScheme(id, snapshot),
            // Said in the tab's title when the left side is empty for want of the file.
            baseLabel: read ? label : `${label}, without this file`,
          });
          return { opened: true, path: file, diff: true, inSnapshot: read !== null };
        }
        if (!read || read.text === null) throw new Error(`${file} isn't in that snapshot.`);
        await ctx.execute("editor.openReadOnly", {
          title: sharedFileTitle(found.name, row.summary.time, file),
          content: read.text,
        });
        return { opened: true, path: file, diff: false, inSnapshot: true };
      },
    }),
  );

  /** Reads the files of the shared snapshot being looked at into the tab's list. */
  const loadFiles = async (base: string, of: ShareInfo, snapshot: string): Promise<void> => {
    const look = session.shares.snapshot;
    const root = await folderOf(base, of);
    const turn = look.begin(snapshot, root !== null);
    try {
      const read = await asked(shareIpc.snapshotFiles(base, of.id, snapshot, root));
      look.finish(turn, {
        files: asRows(read.files),
        truncated: read.truncated,
        skipped: read.skipped,
      });
    } catch (err) {
      look.fail(turn, err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

  sub.add(
    dispatcher.register({
      id: "team.share.view",
      title: "View a shared project",
      category: TEAM,
      description:
        "Opens the Sync tab's Team page on a project the team shares: its snapshots, newest first, or, with `snapshot`, that snapshot's files (compared with the open folder when the folder is that same project: a clone of the same repository counts). A file there opens read only (team.share.openFile), and a copy of a snapshot can be opened in a folder of its own. Nothing is changed. Needs the share's keys; otherwise it says why it can't be read. Returns how many `snapshots` the share has and, with `snapshot`, the files' `counts`.",
      input: s.object({
        id: s.string().describe("The share's id (ide://team shares)"),
        snapshot: s.string().describe("A snapshot of it to open (team.share.snapshots)").optional(),
      }),
      effects: ["network"],
      agent: shareCommandAgent("team.share.view"),
      needsScreen: true,
      run: async ({ id, snapshot }) => {
        const base = await ready();
        const found = await readable(id);
        const look = session.shares;
        session.look.close();
        session.page.value = "team";
        const tabId = dock.openView(SYNC_VIEW, null, "main", true);
        const listed = () =>
          look.opened.peek()?.id === id && look.rows.some((row) => row.id === snapshot);
        // The share's snapshots are read when it is opened, when it is asked for by itself, and
        // when the snapshot asked for isn't among the ones read before (it may be newer).
        if (snapshot === undefined || !listed()) {
          if (snapshot === undefined) look.snapshot.close();
          const turn = look.begin(id);
          try {
            const snapshots = await asked(shareIpc.snapshots(base, id));
            // Its chats, when it shares them. Not reading them doesn't hide the snapshots.
            const chats = found.chats ? await shareIpc.chats(base, id).catch(() => []) : [];
            look.finish(turn, snapshots, chats);
          } catch (err) {
            look.fail(turn, err instanceof Error ? err.message : String(err));
            throw err;
          }
        }
        if (snapshot === undefined)
          return { tabId, id, snapshots: look.rows.length, chats: look.chats.length };
        if (!listed())
          throw new Error("That snapshot is gone from the share (it keeps its latest ten).");
        await loadFiles(base, found, snapshot);
        const opened = look.snapshot.opened.peek();
        return {
          tabId,
          id,
          snapshots: look.rows.length,
          snapshot,
          compared: opened?.compared ?? false,
          counts: opened?.id === snapshot ? opened.counts : null,
        };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "team.share.openCopy",
      title: "Open a copy of a shared project…",
      category: TEAM,
      description:
        "Makes a copy of a snapshot of a project the team shares in a new or empty folder the person chooses (`target`, else the folder dialog). When the project has a git remote, its address is shown and the person is asked whether to clone from it first (it is the address the sharer works from): on yes the folder is cloned from it, with the access this computer already has, no sign-in prompt and a time limit; on no nothing reaches out to that address. Then the snapshot is put on top (its commit checked out, its changed files written). Then says what happened and offers to open the folder, which opens like any folder someone else made: not trusted until the person says so. Nothing goes back to the share. Without `snapshot`, the newest. Returns `copied`, the `path`, `cloned`, `note` (why it couldn't be cloned, when a clone was asked for), `files` written and `opened`. Needs the person: hidden from agents.",
      input: s.object({
        id: s.string().describe("The share's id (ide://team shares)"),
        snapshot: s.string().describe("The snapshot's id; default: the newest").optional(),
        target: s.string().describe("A new or empty folder, absolute; default: asks").optional(),
      }),
      effects: ["network", "write"],
      agent: "hidden",
      needsScreen: true,
      run: async ({ id, snapshot, target }, ctx) => {
        const base = await ready();
        const found = await readable(id);
        let from = snapshot;
        if (from === undefined) {
          from = newestFirst(await asked(shareIpc.snapshots(base, id)))[0]?.id;
          if (from === undefined) throw new Error(`${found.name} has no snapshot to copy yet.`);
        }
        const folder =
          target ??
          (await dialogIpc.pickFolder(`A new or empty folder for a copy of ${found.name}`));
        if (!folder) return { copied: false, cancelled: true };
        // The address is one the sharer chose: shown, and asked about, before this computer
        // reaches out to it. Only the address that was shown is ever cloned from.
        const plan = await asked(shareIpc.copyPlan(base, id, from));
        let cloneFrom: string | null = null;
        if (plan.remote) {
          const words = cloneQuestion(plan.remote, found.owner.name, found.name, found.mine);
          const answer = await showDialog<"clone" | "copy" | null>({
            title: words.title,
            message: words.message,
            actions: [
              { label: "No, copy without cloning", value: "copy" },
              { label: "Clone first", value: "clone", variant: "primary" },
            ],
            cancelValue: null,
          });
          if (answer === null) return { copied: false, cancelled: true };
          if (answer === "clone") cloneFrom = plan.remote;
        }
        const copy = await asked(shareIpc.openCopy(base, id, from, folder, cloneFrom));
        const report = copyReport(copy, found.name);
        const open = await showDialog<boolean>({
          title: report.title,
          message: report.lines.join("\n\n"),
          actions: [
            { label: "Close", value: false },
            { label: "Open the folder", value: true, variant: "primary" },
          ],
          cancelValue: false,
        });
        // Opened as any folder: nothing here marks it trusted.
        if (open) await ctx.execute("workspace.openFolder", { path: copy.path });
        return {
          copied: true,
          path: copy.path,
          cloned: copy.cloned,
          note: copy.note,
          files: copy.restored.files,
          opened: open,
        };
      },
    }),
  );
}
