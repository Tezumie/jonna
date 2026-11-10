// A chat watching a pull request (D323, after Claude Code's app binding a PR to a session): the
// IDE looks at it through the user's GitHub CLI every minute (backing off on errors) — the model
// never polls — and posts an automatic message to the chat (`auto: "pr"`) when there's something
// to act on: a check failed, all checks passed, a merge conflict appeared or went, new comments
// (with their text). Merged or closed ends the watch. One pull request per chat; the watches are
// kept with the folder and resume when it opens. The agent's watch_pr tool, the commands
// (agent.watchPullRequest, agent.unwatchPullRequest, agent.checkPullRequestNow), the details
// panel's row and ide://agent/prWatches. What counts as news is in core/agent/prWatch.ts.
// D352: auto-merge, opt-in per pull request (watch_pr's auto_merge, agent.autoMergePullRequest):
// GitHub's own where the repository allows it, else the IDE merges at a look where it's ready
// (core/agent/prAutoMerge.ts decides) and says so in the chat.

import type { ToolOutcome } from "../../core/agent/loop";
import {
  type AutoMergeState,
  autoMergeAllowed,
  autoMergeLine,
  type MergeMethod,
  mergeDecision,
  mergedByIdeText,
  mergeFailedText,
  mergeMethod,
} from "../../core/agent/prAutoMerge";
import {
  diffPr,
  endsWatch,
  nextPollDelay,
  type PrSnapshot,
  prEventText,
  prSnapshot,
  prStatusLine,
} from "../../core/agent/prWatch";
import { agentStoreIpc } from "../../core/ipc/agent";
import { createGithubIpc } from "../../core/ipc/git";
import type { DisposableStore } from "../../core/lifecycle/index";
import { type ReadonlySignal, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { deliverAutoMessage } from "./sessionSubagents";
import type { SessionManager } from "./sessions";
import type { AgentTool, ToolHost } from "./tools";

/** A watch as the panel and the state show it. */
export interface PrWatchInfo {
  session: string;
  number: number;
  title: string;
  url: string;
  /** "checks: 1 failing, 2 passing; mergeable; 3 comments", once looked at. */
  status: string | null;
  checkedAt: number | null;
  /** The last look failed (it backs off and tries again). */
  lastError: string | null;
  /** D352: auto-merge when it's on: how, by whom, and where it stands. */
  autoMerge: { method: MergeMethod; by: "github" | "ide"; status: string } | null;
}

interface Watch {
  session: string;
  number: number;
  /** The repository it was watched in (gh runs there). */
  repo: string | null;
  last: PrSnapshot | null;
  failures: number;
  lastError: string | null;
  checkedAt: number | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  polling: Promise<void> | null;
  /** D352: merged automatically when ready (the user asked). */
  autoMerge: AutoMergeState | null;
}

/** What's saved with the folder: comment bodies aren't needed to tell new ones apart. */
interface SavedWatch {
  session: string;
  number: number;
  repo: string | null;
  last: PrSnapshot | null;
  autoMerge?: AutoMergeState | null;
}

const validAutoMerge = (raw: unknown): AutoMergeState | null => {
  const a = raw as Partial<AutoMergeState> | null;
  if (!a || typeof a !== "object" || (a.mode !== "github" && a.mode !== "ide")) return null;
  return {
    method: mergeMethod(a.method),
    mode: a.mode,
    since: typeof a.since === "number" ? a.since : Date.now(),
  };
};

const info = signal<readonly PrWatchInfo[]>([]);
/** This window's watches (the details panel shows a chat's). */
export const prWatches: ReadonlySignal<readonly PrWatchInfo[]> = info;

export function prWatchOf(session: string): PrWatchInfo | null {
  return info.peek().find((w) => w.session === session) ?? null;
}

export class PrWatchService {
  private readonly watches = new Map<string, Watch>();
  private disposed = false;
  /** D352: pull requests ("<repo>#<n>") the user confirmed auto-merge for (the card shows once). */
  readonly confirmed = new Set<string>();

  constructor(
    private readonly services: WorkbenchServices,
    private readonly sessions: SessionManager,
  ) {}

  /**
   * Starts watching for chat `session` (replacing its earlier watch): pull request `number`, else
   * the chat's own (the one its agent opened), else the current branch's. Looks at it once now:
   * that's the baseline the next looks are compared with.
   */
  async watch(
    session: string,
    number?: number,
  ): Promise<{ info: PrWatchInfo; snapshot: PrSnapshot }> {
    const repo = this.services.workspace.root.peek();
    if (!repo) throw new Error("No folder is open.");
    const own = this.sessions.find(session)?.pullRequest.peek()?.number ?? undefined;
    const gh = createGithubIpc(repo);
    const view = await gh.json<unknown>("prView", {
      ...((number ?? own) !== undefined && { number: number ?? own }),
    });
    const threads = await this.threads(gh, (view as { number?: number }).number ?? 0);
    const snapshot = prSnapshot(view, threads);
    if (!snapshot.number) throw new Error("The GitHub CLI didn't name a pull request.");
    if (snapshot.state !== "OPEN")
      throw new Error(`#${snapshot.number} is ${snapshot.state.toLowerCase()} already.`);
    this.stop(session);
    const w: Watch = {
      session,
      number: snapshot.number,
      repo,
      last: snapshot,
      failures: 0,
      lastError: null,
      checkedAt: Date.now(),
      timer: undefined,
      polling: null,
      autoMerge: null,
    };
    this.watches.set(session, w);
    this.services.persistence.scheduleSave();
    this.arm(w);
    this.publish();
    return { info: this.infoOf(w), snapshot };
  }

  /** Stops chat `session`'s watch. The pull request it watched, or null. */
  unwatch(session: string): number | null {
    const w = this.watches.get(session);
    if (!w) return null;
    this.stop(session);
    this.publish();
    return w.number;
  }

  /** The pull request chat `session` watches ("<repo>#<n>", the key auto-merge is confirmed by). */
  watchedKey(session: string): string | null {
    const w = this.watches.get(session);
    return w ? `${w.repo ?? ""}#${w.number}` : null;
  }

  /**
   * D352: merges chat `session`'s watched pull request when it's ready (watching it first when
   * it isn't). GitHub's auto-merge where the repository allows it; else (or when turning that on
   * fails) the IDE merges it at a look where every check passed, it's approved and mergeable.
   * The user asked: the caller made sure.
   */
  async setAutoMerge(
    session: string,
    method: MergeMethod,
    number?: number,
  ): Promise<{ info: PrWatchInfo; note: string }> {
    let w = this.watches.get(session);
    if (!w || (number !== undefined && w.number !== number)) {
      await this.watch(session, number);
      w = this.watches.get(session);
    }
    if (!w) throw new Error("The pull request isn't watched.");
    const gh = createGithubIpc(w.repo ?? undefined);
    let mode: AutoMergeState["mode"] = "ide";
    let note = "";
    const allowed = await gh.json<unknown>("repoAutoMerge").then(autoMergeAllowed, () => false);
    if (allowed)
      try {
        await gh.run("prAutoMerge", { number: w.number, method });
        mode = "github";
      } catch (err) {
        note = ` GitHub's auto-merge couldn't be turned on (${err instanceof Error ? err.message : String(err)}), so the IDE merges it when it's ready.`;
      }
    w.autoMerge = { method, mode, since: Date.now() };
    this.services.persistence.scheduleSave();
    this.publish();
    // The IDE's own: it may be ready already.
    if (mode === "ide") {
      clearTimeout(w.timer);
      void this.poll(w);
    }
    return { info: this.infoOf(w), note };
  }

  /** D352: turns auto-merge off (GitHub's too). The pull request, or null when it wasn't on. */
  async clearAutoMerge(session: string): Promise<number | null> {
    const w = this.watches.get(session);
    if (!w?.autoMerge) return null;
    const was = w.autoMerge;
    w.autoMerge = null;
    this.services.persistence.scheduleSave();
    this.publish();
    if (was.mode === "github")
      await createGithubIpc(w.repo ?? undefined).run("prAutoMergeOff", { number: w.number });
    return w.number;
  }

  /** Looks now instead of at the next tick. */
  async checkNow(session: string): Promise<PrWatchInfo> {
    const w = this.watches.get(session);
    if (!w) throw new Error("This chat isn't watching a pull request.");
    // A look already running began before this ask (the checks may have finished since, D379):
    // let it end, then look again.
    if (w.polling) await w.polling.catch(() => {});
    clearTimeout(w.timer);
    await this.poll(w);
    return this.infoOf(w);
  }

  list(): PrWatchInfo[] {
    return [...this.watches.values()].map((w) => this.infoOf(w));
  }

  save(): SavedWatch[] {
    return [...this.watches.values()].map((w) => ({
      session: w.session,
      number: w.number,
      repo: w.repo,
      last: w.last && {
        ...w.last,
        comments: w.last.comments.map((c) => ({ id: c.id, author: c.author, body: "" })),
      },
      autoMerge: w.autoMerge,
    }));
  }

  /** The folder's saved watches: they go on (the first look is compared with the saved one). */
  restore(data: unknown): void {
    this.clear();
    if (!Array.isArray(data)) return;
    for (const raw of data.slice(0, 50)) {
      const d = raw as Partial<SavedWatch> | null;
      if (!d || typeof d.session !== "string" || typeof d.number !== "number") continue;
      const w: Watch = {
        session: d.session,
        number: d.number,
        repo: typeof d.repo === "string" ? d.repo : null,
        last: d.last && typeof d.last === "object" ? (d.last as PrSnapshot) : null,
        failures: 0,
        lastError: null,
        checkedAt: null,
        timer: undefined,
        polling: null,
        autoMerge: validAutoMerge(d.autoMerge),
      };
      this.watches.set(w.session, w);
      // A few seconds after the window settles, then every minute.
      this.arm(w, 8000);
    }
    this.publish();
  }

  /** The folder closed: its watches stop (they're saved with it). */
  clear(): void {
    // Not saved: the folder's saved watches stay as they were.
    for (const w of this.watches.values()) clearTimeout(w.timer);
    this.watches.clear();
    this.publish();
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.watches.values()) clearTimeout(w.timer);
    this.watches.clear();
  }

  private stop(session: string): void {
    const w = this.watches.get(session);
    if (!w) return;
    clearTimeout(w.timer);
    this.watches.delete(session);
    this.services.persistence.scheduleSave();
  }

  private arm(w: Watch, delay = nextPollDelay(w.failures)): void {
    clearTimeout(w.timer);
    if (this.disposed) return;
    w.timer = setTimeout(() => void this.poll(w), delay);
  }

  private async threads(gh: ReturnType<typeof createGithubIpc>, number: number): Promise<unknown> {
    if (!number) return null;
    // Review comments are extra: a failure leaves the conversation's comments only.
    return gh.json<unknown>("prThreads", { number }).catch(() => null);
  }

  /** One look: what changed goes to the chat; merged or closed ends the watch. Never overlaps. */
  private poll(w: Watch): Promise<void> {
    if (w.polling) return w.polling;
    w.polling = (async () => {
      try {
        const gh = createGithubIpc(w.repo ?? undefined);
        const view = await gh.json<unknown>("prView", { number: w.number });
        const snapshot = prSnapshot(view, await this.threads(gh, w.number));
        if (this.watches.get(w.session) !== w) return;
        const events = diffPr(w.last, snapshot);
        w.last = snapshot;
        w.failures = 0;
        w.lastError = null;
        w.checkedAt = Date.now();
        // D352: the IDE merges it now that it's ready; that message says it all.
        const auto = w.autoMerge;
        let failure = "";
        if (auto?.mode === "ide" && mergeDecision(snapshot).ready) {
          const error = await gh.run("prMerge", { number: w.number, method: auto.method }).then(
            () => null,
            (err: unknown) => (err instanceof Error ? err.message : String(err)),
          );
          if (this.watches.get(w.session) !== w) return;
          if (error === null) {
            this.stop(w.session);
            await this.deliver(w.session, mergedByIdeText(snapshot, auto.method));
            return;
          }
          // It goes off: a merge that fails once would fail at every look.
          w.autoMerge = null;
          failure = mergeFailedText(snapshot, error);
        }
        const merged = auto && events.some((e) => e.kind === "merged");
        const news = [
          events.length
            ? `${prEventText(snapshot, events)}${merged ? `\n\nAuto-merge (${auto.method}) merged it, as the user asked.` : ""}`
            : "",
          failure,
        ]
          .filter(Boolean)
          .join("\n\n");
        if (news) {
          const sent = await this.deliver(w.session, news);
          if (!sent) {
            this.stop(w.session);
            return;
          }
        }
        if (endsWatch(events)) this.stop(w.session);
        else this.services.persistence.scheduleSave();
      } catch (err) {
        w.failures++;
        w.lastError = err instanceof Error ? err.message : String(err);
        w.checkedAt = Date.now();
      } finally {
        w.polling = null;
        if (this.watches.get(w.session) === w) this.arm(w);
        this.publish();
      }
    })();
    return w.polling;
  }

  /** Posts to the chat (loading it when it's put away). False: the chat is gone. */
  private async deliver(id: string, text: string): Promise<boolean> {
    const loaded = this.sessions.find(id);
    if (!loaded && !(await agentStoreIpc.stamps([id]).catch(() => [null]))[0]) return false;
    const session = loaded ?? this.sessions.get(id);
    await session.loaded();
    if (session.deleted) return false;
    deliverAutoMessage(session, text, "pr");
    this.sessions.changed();
    return true;
  }

  private infoOf(w: Watch): PrWatchInfo {
    return {
      session: w.session,
      number: w.number,
      title: w.last?.title ?? "",
      url: w.last?.url ?? "",
      status: w.last ? prStatusLine(w.last) : null,
      checkedAt: w.checkedAt,
      lastError: w.lastError,
      autoMerge: w.autoMerge && {
        method: w.autoMerge.method,
        by: w.autoMerge.mode,
        status: autoMergeLine(w.autoMerge, w.last),
      },
    };
  }

  private publish(): void {
    info.value = this.list();
  }
}

function watchTool(service: PrWatchService): AgentTool {
  return {
    spec: {
      name: "watch_pr",
      description:
        'Watch a GitHub pull request for this chat: the IDE checks it every minute through the GitHub CLI (don\'t poll it yourself) and messages you here when there\'s something to act on: a check failed, all checks passed, a merge conflict appeared, new review or conversation comments (with their text). It stops when the pull request is merged or closed. One pull request per chat. Without `number`: the one this chat opened, else the current branch\'s. action "unwatch" stops it; "status" says where it stands. action "auto_merge" (with `method`) has it merged once every check passed, it\'s approved and mergeable (GitHub\'s auto-merge where the repository allows it, else the IDE merges it): ONLY when the user asked for auto-merge; the user confirms it. "auto_merge_off" cancels it.',
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["watch", "unwatch", "status", "auto_merge", "auto_merge_off"],
            description: "Default watch",
          },
          number: { type: "integer", description: "The pull request's number" },
          method: {
            type: "string",
            enum: ["merge", "squash", "rebase"],
            description: "auto_merge's merge method (default merge)",
          },
        },
        required: [],
      },
    },
    readOnly: true,
    concurrent: false,
    verb: "Watching",
    target: (a) =>
      a.action === "unwatch"
        ? "stop watching"
        : a.action === "auto_merge"
          ? "auto-merge"
          : a.action === "auto_merge_off"
            ? "auto-merge off"
            : typeof a.number === "number"
              ? `#${a.number}`
              : "pull request",
    async run(args, host) {
      const action = typeof args.action === "string" ? args.action : "watch";
      if (action === "auto_merge" || action === "auto_merge_off")
        return autoMergeAction(service, host, action, args);
      if (action === "unwatch") {
        const n = service.unwatch(host.session);
        return {
          result: n ? `Stopped watching #${n}.` : "This chat wasn't watching a pull request.",
          summary: n ? `stopped #${n}` : "not watching",
        };
      }
      if (action === "status") {
        const w = prWatchOf(host.session);
        return {
          result: w
            ? `Watching #${w.number} ${w.title} (${w.url}): ${w.status ?? "not looked at yet"}.${w.autoMerge ? ` Auto-merge: ${w.autoMerge.status}.` : ""}${w.lastError ? ` The last look failed: ${w.lastError}` : ""}`
            : "This chat isn't watching a pull request.",
          summary: w ? `#${w.number}` : "not watching",
        };
      }
      const number =
        typeof args.number === "number" && args.number > 0 ? Math.floor(args.number) : undefined;
      try {
        const { info: w, snapshot } = await service.watch(host.session, number);
        const failing = snapshot.checks.filter((c) => c.outcome === "fail").map((c) => c.name);
        return {
          result: `Watching #${w.number} ${w.title} (${w.url}). Now: ${w.status}.${failing.length ? ` Failing already: ${failing.join(", ")}.` : ""}${snapshot.mergeable === "CONFLICTING" ? " It has a merge conflict already." : ""} You'll get a message here when that changes (checks, conflicts, comments) or it's merged or closed; go on meanwhile.`,
          summary: `#${w.number}`,
        };
      } catch (err) {
        return {
          result: `Error: couldn't watch the pull request: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

/**
 * watch_pr's auto_merge / auto_merge_off (D352). Turning it on asks the user once per pull request
 * (the model may only do it when the user asked; the card makes sure).
 */
async function autoMergeAction(
  service: PrWatchService,
  host: ToolHost,
  action: "auto_merge" | "auto_merge_off",
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  if (action === "auto_merge_off") {
    try {
      const n = await service.clearAutoMerge(host.session);
      return {
        result: n ? `Auto-merge is off for #${n}; the watch goes on.` : "Auto-merge wasn't on.",
        summary: n ? `off for #${n}` : "wasn't on",
      };
    } catch (err) {
      return {
        result: `Error: auto-merge is off here, but GitHub's couldn't be turned off: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
  const method = mergeMethod(args.method);
  const number =
    typeof args.number === "number" && args.number > 0 ? Math.floor(args.number) : undefined;
  try {
    // Watched first (the card names the pull request; a denial leaves just the watch).
    let w = prWatchOf(host.session);
    if (!w || (number !== undefined && w.number !== number))
      w = (await service.watch(host.session, number)).info;
    const key = service.watchedKey(host.session) ?? `#${w.number}`;
    if (!service.confirmed.has(key)) {
      const answer = await host.ask({
        title: `Auto-merge #${w.number}`,
        heading: "Merge automatically",
        detail: `Merge pull request #${w.number}${w.title ? ` (${w.title})` : ""} (${method}) once every check passed, it's approved (when reviews are required) and it merges cleanly: GitHub's auto-merge where the repository allows it, else the IDE merges it at its next look. You can turn it off from the chat's details or Background tasks.`,
        kind: "tool",
      });
      if (answer === "deny")
        return {
          result: `The user declined auto-merge for #${w.number} (the watch goes on).`,
          denied: true,
        };
      service.confirmed.add(key);
    }
    const { info, note } = await service.setAutoMerge(host.session, method, w.number);
    return {
      result: `Auto-merge is on for #${info.number} (${method}, ${info.autoMerge?.by === "github" ? "GitHub's auto-merge" : "the IDE merges it when it's ready"}). Now: ${info.autoMerge?.status ?? info.status}.${note} You'll get a message here when it's merged; watch_pr with action auto_merge_off cancels it.`,
      summary: `#${info.number} · ${method}`,
    };
  } catch (err) {
    return {
      result: `Error: couldn't turn auto-merge on: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

export function registerPrWatches(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): PrWatchService {
  const { dispatcher, state, persistence, workspace } = services;
  const service = new PrWatchService(services, sessions);
  sub.add({ dispose: () => service.dispose() });
  sub.add(
    persistence.register("agent.prWatches", {
      save: () => service.save(),
      restore: (data) => service.restore(data),
    }),
  );
  sub.add(workspace.onDidClose(() => service.clear()));

  const tool = watchTool(service);
  const previous = sessions.extraTools;
  sessions.extraTools = (session) => [...previous(session), tool];

  const sessionInput = s.string().describe("Session id (default: the active session)").optional();
  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "Agent", ...c }));

  register({
    id: "agent.watchPullRequest",
    title: "Watch pull request from chat",
    description:
      "Has a chat watch a GitHub pull request (D323): the IDE checks it every minute through the GitHub CLI and tells the chat's agent when a check fails, all checks pass, a merge conflict appears or new comments come; merged or closed ends it. `number`: default the chat's own pull request, else the current branch's. Replaces the chat's earlier watch.",
    input: s.object({ session: sessionInput, number: s.integer({ min: 1 }).optional() }),
    effects: ["read", "network"],
    when: "gitRepo",
    run: async ({ session, number }, ctx) => {
      const target = sessions.require(session);
      const { info: w } = await service.watch(target.id, number);
      if (ctx.caller.kind === "user")
        services.notifications.show("info", `Watching #${w.number} for this chat: ${w.status}.`);
      return w;
    },
  });

  register({
    id: "agent.unwatchPullRequest",
    title: "Stop watching pull request",
    description: "Stops a chat's pull request watch (D323).",
    input: s.object({ session: sessionInput }),
    effects: [],
    run: ({ session }) => {
      const id = session ?? sessions.active.peek();
      if (!id) throw new Error("No agent session.");
      return { stopped: service.unwatch(id) };
    },
  });

  register({
    id: "agent.checkPullRequestNow",
    title: "Check watched pull request now",
    description:
      "Looks at a chat's watched pull request now instead of at the next minute (D323); what changed goes to the chat as usual. Returns where it stands.",
    input: s.object({ session: sessionInput }),
    effects: ["read", "network"],
    agent: "hidden",
    run: async ({ session }) => {
      const id = session ?? sessions.active.peek();
      if (!id) throw new Error("No agent session.");
      return service.checkNow(id);
    },
  });

  register({
    id: "agent.autoMergePullRequest",
    title: "Auto-merge watched pull request",
    description:
      "Has a chat's watched pull request merged once it's ready (D352): every check passed, approved when reviews are required, mergeable. GitHub's auto-merge (gh pr merge --auto) where the repository allows it, else the IDE merges it at a look and tells the chat. `off: true` cancels it. Only the user turns it on here; the agent uses watch_pr's auto_merge, which asks the user.",
    input: s.object({
      session: sessionInput,
      method: s.enum(["merge", "squash", "rebase"] as const).optional(),
      off: s.boolean().optional(),
    }),
    effects: ["network", "write"],
    when: "gitRepo",
    run: async ({ session, method, off }, ctx) => {
      const target = sessions.require(session);
      if (off) return { number: await service.clearAutoMerge(target.id), autoMerge: null };
      // The agent goes through watch_pr, whose card makes sure the user asked.
      if (ctx.caller.kind === "agent" || ctx.caller.kind === "acp")
        throw new Error(
          "Auto-merge is turned on by the user. Use watch_pr with action auto_merge (it asks them).",
        );
      let how = method;
      if (!how && ctx.caller.kind === "user") {
        const picked = await services.quickInput.pick(
          [
            { id: "squash", label: "Squash and merge", icon: "git-merge" as const },
            { id: "merge", label: "Create a merge commit", icon: "git-merge" as const },
            { id: "rebase", label: "Rebase and merge", icon: "git-merge" as const },
          ],
          { placeholder: "Merge it how, once it's ready?" },
        );
        if (!picked) return { number: null, autoMerge: null };
        how = mergeMethod(picked.id);
      }
      const { info: w, note } = await service.setAutoMerge(target.id, mergeMethod(how));
      if (ctx.caller.kind === "user")
        services.notifications.show(
          "info",
          `Auto-merge is on for #${w.number}: ${w.autoMerge?.status ?? ""}.${note}`,
        );
      return w;
    },
  });

  sub.add(
    state.register("ide://agent/prWatches", {
      description:
        "Pull requests chats are watching (D323): each one's chat, number, title, link, where it stands (checks, mergeable, comments), when it was last looked at and the last error, and auto-merge when it's on (D352: method, by github or ide, what it waits for). The IDE looks every minute through the GitHub CLI and tells the chat what changed.",
      get: () => ({ watches: info.value }),
    }),
  );
  return service;
}
