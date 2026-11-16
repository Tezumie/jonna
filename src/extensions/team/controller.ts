// The team's library on this computer: who the account's team is, what its library lists, which
// items are on here, and keeping the cache and the folder the loaders read up to date. No view
// code: the commands (commands.ts) and ide://team read it, and a page can be built on those.
//
// One thing at a time: a refresh, and a change of what is on, run one after the other, so the
// folder the loaders read is never written by two of them at once.
import { type AccountTeam, accountsIpc } from "../../core/ipc/accounts";
import { type TeamLibrary, teamIpc } from "../../core/ipc/team";
import type { Disposable } from "../../core/lifecycle/index";
import { accountsServer } from "../../core/ownServices";
import { joinPath } from "../../core/paths/index";
import { batch, signal } from "../../core/reactive/index";
import {
  activeIds,
  choiceIds,
  itemsToFetch,
  type TeamChoices,
  type TeamItem,
  teamItems,
} from "../../core/team/items";
import { activeTeam } from "../../core/team/source";
import type { WorkbenchServices } from "../../workbench/services";

/** The settings that hold what this person added and turned off (never synced). */
export const ADDED_SETTING = "team.added";
export const OFF_SETTING = "team.off";

/** The account's team as the app shows it: never its members. */
export interface TeamInfo {
  id: string;
  name: string;
  role: "owner" | "member";
  /** May change the library. */
  publisher: boolean;
}

export interface RefreshResult {
  /** The team's name; null when the account is in no team (or signed out). */
  team: string | null;
  items: number;
  active: number;
  /** Texts downloaded by this refresh, and ones that couldn't be had (tried again later). */
  fetched: number;
  failed: number;
  /** Why the library couldn't be read from the service (the cache keeps applying), else null. */
  problem: string | null;
}

/** An error's code, when it has one (an IPC error's). */
export function codeOf(err: unknown): string {
  return err && typeof err === "object" && "code" in err
    ? String((err as { code: unknown }).code)
    : "";
}

/** Not reachable, or signed out: nothing to say loudly, the cache keeps applying. */
function quiet(code: string): boolean {
  return code.endsWith("Offline") || code.endsWith("SignedOut");
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  // An IPC error is a plain object with a message.
  return err && typeof err === "object" && "message" in err
    ? String((err as { message: unknown }).message)
    : String(err);
}

/** The team a profile names, when it is one this code can read. */
function teamOf(team: AccountTeam | null | undefined): (TeamInfo & { rev: number | null }) | null {
  if (!team || typeof team.id !== "string" || !team.id) return null;
  return {
    id: team.id,
    name: typeof team.name === "string" ? team.name.trim() : "",
    role: team.role === "owner" ? "owner" : "member",
    publisher: team.publisher === true,
    rev: typeof team.libraryRev === "number" ? team.libraryRev : null,
  };
}

export class TeamController implements Disposable {
  /** The account's team; null in none, or signed out. */
  readonly team = signal<TeamInfo | null>(null);
  /** "lapsed": the team's subscription ended (the library is read, not changed). */
  readonly state = signal<"on" | "lapsed" | null>(null);
  readonly items = signal<readonly TeamItem[]>([]);
  /** The ids of the items that are on here. */
  readonly active = signal<ReadonlySet<string>>(new Set());
  /** When the library was last read from the service, in ms. */
  readonly lastRefresh = signal<number | null>(null);
  /** Why the last try to read it failed, in a sentence; null when it worked. */
  readonly problem = signal<string | null>(null);

  /** Item id → the version whose text is on this computer. */
  private cached: Record<string, number> = {};
  /** The profile's `libraryRev` the cached list was read at. */
  private rev: number | null = null;
  private stamp = 0;
  private disposed = false;
  /** Everything that touches the cache, one after the other. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The last refresh failed on this computer (not for want of a connection): the next asks again. */
  private retry = false;
  /** The refresh under way: asked again meanwhile, it is the one returned. */
  private refreshing: Promise<RefreshResult> | null = null;

  constructor(private readonly services: WorkbenchServices) {}

  dispose(): void {
    this.disposed = true;
    // The loaders stop reading the team's folder when the extension goes.
    activeTeam.value = null;
    void this.services.settings.loadTeam(null);
  }

  /** The accounts server; empty in a build without one. */
  base(): string {
    return accountsServer(this.services.settings.peek<string | undefined>("accounts.serverUrl"));
  }

  /** What this person added and turned off, on this computer. */
  choices(): TeamChoices {
    const { settings } = this.services;
    return {
      added: choiceIds(settings.peek<unknown>(ADDED_SETTING)),
      off: choiceIds(settings.peek<unknown>(OFF_SETTING)),
    };
  }

  /** The version of an item's text kept here (undefined: not downloaded yet). */
  cachedVersion(id: string): number | undefined {
    return Object.hasOwn(this.cached, id) ? this.cached[id] : undefined;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  /**
   * Reads who the account's team is and brings the library up to date: `fromServer` asks the
   * accounts server for the profile (else the saved one is read), `force` reads the library's
   * list even when its number didn't move. Never two at once: a second call gets the first's
   * result. Offline or refused, the cache keeps applying and `problem` says why.
   */
  refresh(options: { fromServer: boolean; force: boolean }): Promise<RefreshResult> {
    if (this.refreshing) {
      // The one under way may have nothing to read (its number didn't move): a forced one
      // waits for it, then runs.
      if (!options.force || this.refreshingForced) return this.refreshing;
      return this.refreshing.then(
        () => this.refresh(options),
        () => this.refresh(options),
      );
    }
    this.refreshingForced = options.force;
    const run = this.enqueue(() => this.runRefresh(options)).finally(() => {
      if (this.refreshing === run) this.refreshing = null;
    });
    this.refreshing = run;
    return run;
  }
  private refreshingForced = false;

  private result(fetched = 0, failed = 0): RefreshResult {
    return {
      team: this.team.peek()?.name ?? null,
      items: this.items.peek().length,
      active: this.active.peek().size,
      fetched,
      failed,
      problem: this.problem.peek(),
    };
  }

  private async runRefresh(options: {
    fromServer: boolean;
    force: boolean;
  }): Promise<RefreshResult> {
    if (this.disposed) return this.result();
    const base = this.base();
    const saved = () => accountsIpc.profile(base).catch(() => null);
    const profile = !base
      ? null
      : options.fromServer
        ? await accountsIpc.check(base).catch(saved)
        : await saved();
    const team = teamOf(profile?.team);
    if (this.disposed) return this.result();
    if (!team) {
      // Signed out, or in no team: nothing of a team's stays on, or on this computer.
      await this.leave();
      return this.result();
    }
    // Another team's cache (the account moved): gone before this one's is read.
    if (this.team.peek()?.id !== team.id) {
      await teamIpc.clear(team.id).catch(() => {});
      this.deactivate();
    }
    this.team.value = { id: team.id, name: team.name, role: team.role, publisher: team.publisher };
    let fetched = 0;
    let failed = 0;
    /** Why what is on this computer couldn't be applied (null: it was). */
    let applyFailure: unknown = null;
    try {
      // What is here applies first, before the service is asked (and when it can't be). Inside
      // the try: a cache that can't be read or applied is a stated problem, not a refresh
      // that fails with nothing said, time after time.
      const kept = await teamIpc.cache(team.id);
      this.take(kept);
      try {
        await this.materialize(team.id);
      } catch (err) {
        // The service is still asked: a fresh copy of the library may be what mends it, and
        // applying that one says what is wrong if it fails too.
        applyFailure = err;
      }

      const wanted = itemsToFetch(this.items.peek(), this.cached).length > 0;
      const moved = team.rev !== this.rev || kept.fetchedAt === 0;
      // (After a refresh that failed on this computer, the service is asked again though
      // nothing moved: what it stated stays stated until a refresh goes through.)
      if (!options.force && !moved && !wanted && !applyFailure && !this.retry) return this.result();

      const listed = await teamIpc.library(base, team.rev);
      if (!listed) {
        // The service says the account is in no team (the profile here is older).
        await this.leave();
        return this.result();
      }
      // The service's word on which team this is (the profile here may be older): its cache is
      // the one the list was kept in.
      const id = listed.team?.id || team.id;
      if (id !== team.id) {
        await teamIpc.clear(id).catch(() => {});
        this.team.value = { id, name: team.name, role: team.role, publisher: team.publisher };
      }
      this.take(listed);
      const ids = itemsToFetch(this.items.peek(), this.cached);
      if (ids.length) {
        const got = await teamIpc.fetch(base, id, ids);
        fetched = got.fetched.length;
        failed = got.failed.length;
        this.take(await teamIpc.cache(id));
      }
      await this.materialize(id);
      this.retry = false;
      batch(() => {
        this.lastRefresh.value = Date.now();
        this.problem.value = failed
          ? `${failed} item${failed === 1 ? "" : "s"} of the library couldn't be downloaded yet.`
          : null;
      });
    } catch (err) {
      const code = codeOf(err);
      if (code === "TeamNone") {
        await this.leave();
        return this.result();
      }
      if (applyFailure && quiet(code)) {
        // Not reachable, and what is here couldn't be applied either: that is the thing to say.
        this.retry = true;
        this.problem.value = `The team's library couldn't be applied on this computer: ${messageOf(applyFailure)}`;
        return this.result(fetched, failed);
      }
      // Kept quiet: the cache keeps applying, and the next refresh tries again.
      this.retry = !quiet(code);
      this.problem.value = quiet(code)
        ? code.endsWith("SignedOut")
          ? "Sign in again to read your team's library; what is on this computer keeps applying."
          : "The team's library can't be reached; what is on this computer keeps applying."
        : messageOf(err);
    }
    return this.result(fetched, failed);
  }

  /** Takes a list (from the service or the cache) as the one this window shows. */
  private take(library: TeamLibrary): void {
    this.cached = { ...library.cached };
    this.rev = library.rev;
    batch(() => {
      this.items.value = teamItems(library.items);
      this.state.value = library.state === "lapsed" ? "lapsed" : library.team ? "on" : null;
      if (library.fetchedAt) this.lastRefresh.value = library.fetchedAt;
    });
  }

  /**
   * Makes the folder the loaders read hold the items that are on, and tells the loaders when
   * something in it changed (they don't watch it).
   */
  private async materialize(teamId: string): Promise<void> {
    const team = this.team.peek();
    if (!team || team.id !== teamId || this.disposed) return;
    const on = activeIds(this.items.peek(), this.choices());
    const applied = await teamIpc.apply(teamId, [...on]);
    if (this.disposed) return;
    this.active.value = on;
    const before = activeTeam.peek();
    const changed =
      !before ||
      before.id !== team.id ||
      before.name !== team.name ||
      before.dir !== applied.dir ||
      applied.written > 0 ||
      applied.removed > 0;
    if (!changed) return;
    activeTeam.value = { id: team.id, name: team.name, dir: applied.dir, stamp: ++this.stamp };
    await this.services.settings.loadTeam(joinPath(applied.dir, "settings.json"));
  }

  /** Applies a change of what is on (the settings changed): no network. */
  apply(): Promise<void> {
    return this.enqueue(async () => {
      const team = this.team.peek();
      if (team) await this.materialize(team.id);
    });
  }

  /** Nothing of a team is on in this window (its cache stays where it is). */
  private deactivate(): void {
    this.cached = {};
    this.rev = null;
    batch(() => {
      this.team.value = null;
      this.state.value = null;
      this.items.value = [];
      this.active.value = new Set();
      this.lastRefresh.value = null;
      this.problem.value = null;
    });
    if (activeTeam.peek()) activeTeam.value = null;
    void this.services.settings.loadTeam(null);
  }

  /** The account is in no team any more (or signed out): every team's cache goes. */
  private async leave(): Promise<void> {
    this.deactivate();
    await teamIpc.clear(null).catch(() => {});
  }

  /** Saves what this person added and turned off, then applies it. */
  async setChoices(next: TeamChoices): Promise<void> {
    const { settings } = this.services;
    const now = this.choices();
    const same = (a: readonly string[], b: readonly string[]) =>
      a.length === b.length && a.every((id) => b.includes(id));
    // An empty list is taken out of the file again: nothing chosen is nothing written.
    if (!same(now.added, next.added))
      await settings.update(ADDED_SETTING, next.added.length ? [...next.added] : undefined, "user");
    if (!same(now.off, next.off))
      await settings.update(OFF_SETTING, next.off.length ? [...next.off] : undefined, "user");
    await this.apply();
  }

  /** An item's text from the cache; null when it isn't downloaded yet. */
  async text(id: string): Promise<string | null> {
    const team = this.team.peek();
    return team ? teamIpc.itemText(team.id, id) : null;
  }
}
