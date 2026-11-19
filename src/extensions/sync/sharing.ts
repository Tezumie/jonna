// Sharing synced projects with the account's team, as the app runs it: what the team shares is
// read into the share book (core/team/shareBook.ts), and a project of this account's that is
// shared is written to its share after each snapshot the loop takes of it. No view code: the
// Sync tab's share card and Team page draw from the book and from the signals here, and the
// commands (shareCommands.ts) go through this.
//
// The controller owns it and calls it at two points of the loop (after a snapshot, and once a
// pass); everything it needs of the controller comes through `SharingHost`, so nothing here
// reaches into the loop. Only in a build with teams (`hasTeams`): otherwise it does nothing.
import {
  type ShareChatsSynced,
  type ShareInfo,
  type ShareSynced,
  shareIpc,
} from "../../core/ipc/share";
import type { Disposable } from "../../core/lifecycle/index";
import { hasTeams } from "../../core/ownServices";
import { type Signal, signal } from "../../core/reactive/index";
import { codeOf, messageOf } from "../../core/sync/errors";
import { EMPTY_SHARE_BOOK, settledByStartingOver, shareBook } from "../../core/team/shareBook";
import {
  ASK_LOG,
  askSentence,
  chatsSentence,
  keyFilesLine,
  keysDue,
  NEWS_LOG,
  newsSentence,
  noTeamCode,
  ownShareOf,
  type RefreshReason,
  refreshDue,
  shareErrorWords,
  splitShareId,
} from "../../core/team/shares";

/** What sharing needs of the sync controller. */
export interface SharingHost {
  /** The accounts server ("" when the build has none). */
  base(): string;
  /** Sync is on for this computer. */
  on(): boolean;
  /** The account's subscription ended: nothing is written. */
  lapsed(): boolean;
  /** The open folder as a project that syncs from here; null when it doesn't. */
  project(): { root: string; id: string; name: string } | null;
  /** The `team.shareOnlyVerified` setting. */
  onlyVerified(): boolean;
  /** Runs `work` once the snapshot under way is done: a folder is never read by two at once. */
  afterSnapshots<T>(work: () => Promise<T>): Promise<T>;
  /** A line in the sync activity. */
  note(text: string, failure?: boolean): void;
  /**
   * The chats of the project in `root` to share, newest first (D454), and the ones being
   * written right now (`busy`: left as they are in the share).
   */
  projectChats(root: string): Promise<{ chats: string[]; busy: string[] }>;
  /** Whether teammates' new shares are announced here (the `team.shareNotices` setting). */
  notices(): boolean;
  /**
   * Says something new of the team once, quietly, with a way to the Team page (D455).
   * `log` is what the activity keeps of it: fixed words, since agents read the activity and
   * `message` names a teammate and a project (D457).
   */
  announce(message: string, share: string | null, log: string): void;
}

/** What the last share sync of a project came to, in this window. */
export interface ShareOutcome {
  /** The project's sync id. */
  project: string;
  /** When, in ms. */
  at: number;
  synced: ShareSynced;
}

/** A refused share call as an error with a sentence (and its code kept). */
export function shareError(err: unknown): Error & { code: string } {
  const code = codeOf(err);
  return Object.assign(new Error(shareErrorWords(code, messageOf(err))), { code });
}

export class ProjectSharing implements Disposable {
  /** Whether the account is in a team (the profile says so): set by the extension. */
  readonly inTeam: Signal<boolean> = signal(false);
  /** The last share sync of a project in this window; null: none yet. */
  readonly outcome: Signal<ShareOutcome | null> = signal<ShareOutcome | null>(null);
  /** Why the last share sync of a project failed; null once one went through. */
  readonly failure: Signal<{ project: string; message: string } | null> = signal<{
    project: string;
    message: string;
  } | null>(null);
  /** The project being shared right now (its sync id); null: none. */
  readonly busy: Signal<string | null> = signal<string | null>(null);
  /**
   * Whom a project that isn't shared yet would be shared with, as chosen on its card (D453):
   * the project's sync id and the chosen teammates' ids. Null: the whole team.
   */
  readonly intended: Signal<{ project: string; readers: string[] } | null> = signal<{
    project: string;
    readers: string[];
  } | null>(null);

  private readonly enabled = hasTeams();
  private disposed = false;
  private readAt = 0;
  private reading: Promise<void> | null = null;
  /** The read that follows the one under way, when one was asked for meanwhile. */
  private readAgain: Promise<void> | null = null;
  /** Whether this account's own key is known to be published (asked once a window). */
  private published = false;
  /** When each project's share was last synced from this window (project id to ms). */
  private readonly syncedAt = new Map<string, number>();
  /** The failure last said in the activity (said once, until a sync goes through). */
  private saidFailure = "";
  /** What the last pass over each project's shared chats came to (project id). */
  readonly chatsOutcome = new Map<string, ShareChatsSynced>();
  /** The projects whose chats switch is off and whose shared chats were seen to be gone. */
  private readonly chatsCleared = new Set<string>();

  constructor(private readonly host: SharingHost) {}

  dispose(): void {
    this.disposed = true;
    shareBook.value = EMPTY_SHARE_BOOK;
  }

  /** Whether anything about sharing can be asked of the service now. */
  private available(): boolean {
    return (
      this.enabled && !this.disposed && !!this.host.base() && this.host.on() && this.inTeam.peek()
    );
  }

  /** Nothing of a team's is known any more (signed out, left the team, sync turned off). */
  clear(): void {
    this.readAt = 0;
    this.published = false;
    this.syncedAt.clear();
    this.chatsOutcome.clear();
    this.chatsCleared.clear();
    this.saidFailure = "";
    shareBook.value = EMPTY_SHARE_BOOK;
    this.outcome.value = null;
    this.failure.value = null;
    this.intended.value = null;
  }

  /**
   * Reads the team's members and shares into the share book. `reason` says how fresh they must
   * be: the loop's pass reads at most every few minutes, a page being shown a little more
   * often, "now" always. Never two reads at once, and never a failure thrown: the book keeps
   * what was read and says why the read failed.
   */
  refresh(reason: RefreshReason): Promise<void> {
    if (!this.available()) {
      if (this.enabled && !this.disposed && shareBook.peek() !== EMPTY_SHARE_BOOK) this.clear();
      return Promise.resolve();
    }
    if (this.reading) {
      if (reason !== "now") return this.reading;
      // Asked for after something changed: the read under way may be from before it, so
      // another follows it (one, however many ask meanwhile).
      this.readAgain ??= this.reading
        .then(() => {
          this.readAgain = null;
          return this.available() ? (this.reading ?? this.startRead()) : undefined;
        })
        .catch(() => {
          this.readAgain = null;
        });
      return this.readAgain;
    }
    if (!refreshDue(reason, this.readAt, Date.now())) return Promise.resolve();
    return this.startRead();
  }

  private startRead(): Promise<void> {
    const run = this.read().finally(() => {
      if (this.reading === run) this.reading = null;
    });
    this.reading = run;
    return run;
  }

  private async read(): Promise<void> {
    const base = this.host.base();
    this.readAt = Date.now();
    try {
      // This account's own key first: made and published when it wasn't, so teammates can
      // share with it. Not while the subscription is ended: the service takes none then, and
      // what the team shares is only read.
      if (!this.published && !this.host.lapsed())
        this.published = await shareIpc.me(base).then(
          (me) => me.published,
          () => false,
        );
      const members = await shareIpc.members(base);
      const shares = await shareIpc.list(base);
      // Who asked this account to share something; a service without asks has none.
      const asks = await shareIpc.asks(base).catch(() => []);
      if (this.disposed || !this.available()) return;
      shareBook.value = { members, shares, asks, readAt: Date.now(), problem: null };
      void this.tell(base, shares, asks);
    } catch (err) {
      if (this.disposed) return;
      const code = codeOf(err);
      // In no team (the profile here is older): nothing to list.
      if (noTeamCode(code)) {
        shareBook.value = { ...EMPTY_SHARE_BOOK, readAt: Date.now() };
        return;
      }
      // What was read before stays, and why this read failed is said. Asked again when it is
      // next due, like any read: a failure that lasts isn't asked about every pass.
      shareBook.value = {
        ...shareBook.peek(),
        problem: shareErrorWords(code, messageOf(err)),
        startOver: settledByStartingOver(code),
      };
    }
  }

  /**
   * What is new for this computer among what teammates share, and who newly asked for a
   * share: said once each (both are remembered on this computer, across restarts), unless
   * notices are off. Never throws.
   */
  private async tell(
    base: string,
    shares: readonly ShareInfo[],
    asks: readonly { uid: string; name: string; at: number }[],
  ): Promise<void> {
    try {
      // Remembered whether or not it is said: turning notices on later doesn't replay the past.
      const news = await shareIpc.news(
        base,
        shares
          .filter((share) => !share.mine)
          .map((share) => ({ id: share.id, chats: share.chats })),
        asks.map((ask) => ({ uid: ask.uid, at: ask.at })),
      );
      if (this.disposed || !this.host.notices()) return;
      const told = newsSentence(news.shares, shares);
      if (told) this.host.announce(told.message, told.share, NEWS_LOG);
      const fresh = asks.filter((ask) => news.asks.includes(ask.uid));
      if (fresh.length > 0) this.host.announce(askSentence(fresh), null, ASK_LOG);
    } catch {
      // Nothing to say then.
    }
  }

  /** The open folder as a project that syncs from here; null when it doesn't. */
  project(): { root: string; id: string; name: string } | null {
    return this.host.project();
  }

  /**
   * Who may have the keys may have changed (a teammate was verified, a new key accepted): the
   * next pass sees to the open project's share instead of waiting its while.
   */
  keysMayHaveMoved(): void {
    this.syncedAt.clear();
  }

  /** This account's share of the open project; undefined when it isn't shared. */
  ownShare(): ShareInfo | undefined {
    return ownShareOf(shareBook.peek().shares, this.host.project()?.id);
  }

  /** Whether a share sync may run: the account can write, and the open project is shared. */
  private writable(): { root: string; id: string; name: string } | null {
    if (!this.available() || this.host.lapsed()) return null;
    const project = this.host.project();
    return project && ownShareOf(shareBook.peek().shares, project.id) ? project : null;
  }

  /**
   * The loop took a snapshot of the open project for the account: when the project is shared,
   * the same goes to its share. Called from inside the snapshot's own turn, so it runs after
   * that snapshot and before the next. Never throws.
   */
  async afterSnapshot(): Promise<void> {
    const project = this.writable();
    if (project) await this.run(project).catch(() => null);
  }

  /**
   * Once a pass: reads the members and shares when they are due, and sees to the open
   * project's share when no snapshot did for a while (a teammate who published a key since
   * gets the share's keys). Never throws.
   */
  async tend(): Promise<void> {
    if (!this.available() || this.host.lapsed()) return;
    await this.refresh("loop");
    const project = this.writable();
    if (!project) return;
    const share = ownShareOf(shareBook.peek().shares, project.id);
    if (!keysDue(share?.rotationNeeded === true, this.syncedAt.get(project.id) ?? 0, Date.now()))
      return;
    await this.host.afterSnapshots(() => this.run(project)).catch(() => null);
  }

  /** One share sync of `project`; the outcome (or the failure) is kept for the card. */
  private async run(project: { root: string; id: string }): Promise<ShareSynced> {
    this.busy.value = project.id;
    this.syncedAt.set(project.id, Date.now());
    try {
      const synced = await shareIpc.sync(
        this.host.base(),
        project.root,
        project.id,
        this.host.onlyVerified(),
      );
      // Its chats too, when that switch is on. A failure there doesn't undo the snapshot.
      await this.chats(project).catch(() => null);
      this.took(project.id, synced);
      return synced;
    } catch (err) {
      throw this.failed(project.id, err);
    } finally {
      if (this.busy.peek() === project.id) this.busy.value = null;
    }
  }

  private took(project: string, synced: ShareSynced): void {
    if (this.disposed) return;
    this.outcome.value = { project, at: Date.now(), synced };
    this.failure.value = null;
    this.saidFailure = "";
    if (synced.snapshot)
      this.host.note(
        ["Shared a snapshot with your team.", keyFilesLine(synced.keyFiles)]
          .filter(Boolean)
          .join(" "),
      );
    // The list says when the share last changed and who holds it: read again, quietly.
    void this.refresh("now");
  }

  private failed(project: string, err: unknown): Error {
    const error = shareError(err);
    if (this.disposed) return error;
    this.failure.value = { project, message: error.message };
    // Said once in the activity, not every few minutes while it lasts.
    if (this.saidFailure !== error.message) {
      this.saidFailure = error.message;
      this.host.note(`Sharing with your team failed: ${error.message}`, true);
    }
    // Not shared any more (stopped from another computer, the team ended): the list says so.
    if (error.code === "ShareNotShared" || error.code === "ShareGone" || noTeamCode(error.code)) {
      this.readAt = 0;
      void this.refresh("now");
    }
    return error;
  }

  /**
   * Starts sharing the open project (or, shared already, sets its name), hands its keys to the
   * teammates who may have them, and takes its first snapshot. After the snapshot under way.
   */
  start(
    project: { root: string; id: string; name: string },
    readers: string[] | null = null,
  ): Promise<ShareSynced> {
    return this.host.afterSnapshots(async () => {
      this.busy.value = project.id;
      this.syncedAt.set(project.id, Date.now());
      try {
        const now = ownShareOf(shareBook.peek().shares, project.id);
        const synced = await shareIpc.start(this.host.base(), {
          root: project.root,
          project: project.id,
          name: project.name,
          // Its chats are a switch of their own, off until the person turns it on (D454).
          chats: now?.chats === true,
          onlyVerified: this.host.onlyVerified(),
          // A new share: the people chosen, or the whole team. One that exists stays as it is.
          ...(now ? {} : readers ? { readers } : { wholeTeam: true }),
        });
        if (this.intended.peek()?.project === project.id) this.intended.value = null;
        this.took(project.id, synced);
        // (`took` asked for the list again: the switch shows on once it is read.)
        await (this.readAgain ?? this.reading);
        return synced;
      } catch (err) {
        throw this.failed(project.id, err);
      } finally {
        if (this.busy.peek() === project.id) this.busy.value = null;
      }
    });
  }

  /**
   * Changes whom this account's share of `project` is for (`readers` null: the whole team),
   * or whether its chats are shared too. Someone taken off is refused at once, and the keys
   * are renewed. The share as it is afterwards.
   */
  async change(
    project: string,
    to: { readers?: string[] | null; chats?: boolean },
  ): Promise<ShareInfo> {
    const now = ownShareOf(shareBook.peek().shares, project);
    if (!now) throw shareError({ code: "ShareNotShared", message: "" });
    this.busy.value = project;
    try {
      const info = await shareIpc.update(
        this.host.base(),
        project,
        now.name,
        to.chats ?? now.chats,
        {
          onlyVerified: this.host.onlyVerified(),
          ...(to.readers === undefined
            ? {}
            : to.readers === null
              ? { wholeTeam: true }
              : { readers: to.readers }),
        },
      );
      this.failure.value = null;
      this.syncedAt.delete(project);
      this.chatsOutcome.delete(project);
      this.chatsCleared.delete(project);
      this.readAt = 0;
      await this.refresh("now");
      // The chats follow the switch at once: written when it went on, taken out when off.
      if (to.chats !== undefined) {
        const open = this.host.project();
        if (open?.id === project) await this.chats(open);
        else if (!to.chats) await shareIpc.chatsSync(this.host.base(), project, null, []);
      }
      return info;
    } catch (err) {
      throw this.failed(project, err);
    } finally {
      if (this.busy.peek() === project) this.busy.value = null;
    }
  }

  /**
   * Makes the share's chats the project's chats (D454): written when the share's chats switch
   * is on, taken out when it is off. Null when the project isn't shared, or its switch is off
   * and that was seen to already in this window. Throws what the service refused.
   */
  async chats(project: { root: string; id: string }): Promise<ShareChatsSynced | null> {
    const share = ownShareOf(shareBook.peek().shares, project.id);
    if (!share) return null;
    // Off: what the share may still hold of chats (the switch was turned off on another
    // computer) is taken out once a window, not asked about every pass.
    if (!share.chats && this.chatsCleared.has(project.id)) return null;
    try {
      const listed = share.chats
        ? await this.host.projectChats(project.root)
        : { chats: [], busy: [] };
      const done = await shareIpc.chatsSync(
        this.host.base(),
        project.id,
        project.root,
        listed.chats,
        listed.busy,
      );
      this.chatsOutcome.set(project.id, done);
      if (share.chats) this.chatsCleared.delete(project.id);
      else this.chatsCleared.add(project.id);
      const said = chatsSentence(done);
      if (said) this.host.note(said);
      return done;
    } catch (err) {
      throw shareError(err);
    }
  }

  /** Shares the open project's state now (after the snapshot under way). */
  syncNow(project: { root: string; id: string }): Promise<ShareSynced> {
    return this.host.afterSnapshots(() => this.run(project));
  }

  /** Stops a share: it is deleted with all it holds. */
  async stop(id: string): Promise<void> {
    // (The team's owner may stop a teammate's share: only this account's own has an outcome here.)
    const mine = shareBook.peek().shares.some((share) => share.id === id && share.mine);
    try {
      await shareIpc.stop(this.host.base(), id);
    } catch (err) {
      // Gone already is what was asked for.
      if (codeOf(err) !== "ShareGone") throw shareError(err);
    }
    if (mine) {
      const { project } = splitShareId(id);
      if (this.outcome.peek()?.project === project) this.outcome.value = null;
      if (this.failure.peek()?.project === project) this.failure.value = null;
      this.syncedAt.delete(project);
    }
    this.readAt = 0;
    await this.refresh("now");
  }
}
