// Keeping every kind of breakpoint in step with each running session (D143, D204): line
// breakpoints (only the paths that changed are sent), function, data and instruction breakpoints,
// the exception settings, and verification across sessions (a breakpoint counts as placed when
// any session placed it). A triggered breakpoint goes only to the sessions that hit its trigger
// (triggers.ts). The controller (controller.ts) calls these when a session starts and when the
// breakpoints change.
import { pathKey } from "../../core/paths/index";
import { batch, type ReadonlySignal } from "../../core/reactive/index";
import type { BreakpointStore } from "./breakpoints";
import { exceptionBreakpointsArgs } from "./exceptionInfo";
import type { OtherBreakpoints } from "./otherBreakpoints";
import type { RunningSession } from "./runningSession";
import type {
  BreakpointResult,
  DebugCapabilities,
  FunctionBreakpointSpec,
  SessionSetup,
  SourceBreakpoint,
} from "./session";
import { sentTo } from "./triggers";

export class BreakpointSync {
  constructor(
    private readonly breakpoints: BreakpointStore,
    private readonly other: OtherBreakpoints,
    private readonly sessions: ReadonlySignal<readonly RunningSession[]>,
  ) {}

  /**
   * Breakpoints to send to `rs`, by path: the enabled ones, but not those still waiting for
   * their trigger there.
   */
  enabledByPath(rs: RunningSession): Map<string, SourceBreakpoint[]> {
    const out = new Map<string, SourceBreakpoint[]>();
    for (const b of this.breakpoints.list.peek()) {
      if (!b.enabled || !sentTo(b, rs.id)) continue;
      const list = out.get(b.path) ?? [];
      list.push({
        id: b.id,
        line: b.line,
        ...(b.condition ? { condition: b.condition } : {}),
        ...(b.hitCondition ? { hitCondition: b.hitCondition } : {}),
        ...(b.logMessage ? { logMessage: b.logMessage } : {}),
      });
      out.set(b.path, list);
    }
    return out;
  }

  enabledFunctions(): FunctionBreakpointSpec[] {
    return this.other.functions
      .peek()
      .filter((f) => f.enabled)
      .map((f) => ({
        name: f.name,
        ...(f.condition ? { condition: f.condition } : {}),
        ...(f.hitCondition ? { hitCondition: f.hitCondition } : {}),
      }));
  }

  /** What a new session gets before its program runs. */
  setupFor(rs: RunningSession): SessionSetup {
    return {
      breakpoints: () => (rs.noDebug ? new Map() : this.enabledByPath(rs)),
      exceptionStops: () => ({
        uncaught: !rs.noDebug && this.breakpoints.uncaught.peek(),
        caught: !rs.noDebug && this.breakpoints.caught.peek(),
      }),
      functionBreakpoints: () => (rs.noDebug ? [] : this.enabledFunctions()),
      exceptionFilters: (caps) => {
        // The adapter's own filters show in Breakpoints from now on.
        if (caps.exceptionFilters.length)
          batch(() => {
            this.other.filters.value = caps.exceptionFilters;
            this.other.filtersType.value = rs.config.type;
          });
        return this.exceptionFilterArgs(rs, caps);
      },
    };
  }

  /** Marks what `rs` got at its start as sent, so only later changes go out. */
  markSent(rs: RunningSession): void {
    for (const [path, list] of rs.noDebug ? [] : this.enabledByPath(rs)) {
      rs.sent.set(path, JSON.stringify(list));
      rs.sentIds.set(pathKey(path), sentIds(list));
    }
    rs.sentFunctions = JSON.stringify(rs.noDebug ? [] : this.enabledFunctions());
  }

  /** Everything changed while `rs` started. */
  syncAll(rs: RunningSession): void {
    void this.sync(rs);
    void this.syncFunctions(rs);
    void this.syncData(rs);
    void this.syncInstructions(rs);
  }

  sync(rs: RunningSession): Promise<void> {
    rs.syncing = rs.syncing.then(() => this.syncNow(rs)).catch(() => {});
    return rs.syncing;
  }

  private async syncNow(rs: RunningSession): Promise<void> {
    const session = rs.session;
    if (!session || rs.ended || rs.noDebug || !rs.inspectable) return;
    const now = this.enabledByPath(rs);
    const paths = new Set([...now.keys(), ...rs.sent.keys()]);
    for (const path of paths) {
      const list = now.get(path) ?? [];
      const key = JSON.stringify(list);
      if (rs.sent.get(path) === key) continue;
      rs.sent.set(path, key);
      rs.sentIds.set(pathKey(path), sentIds(list));
      if (!list.length) {
        rs.sent.delete(path);
        rs.sentIds.delete(pathKey(path));
      }
      await session.setBreakpoints(path, list).catch(() => {});
    }
  }

  async syncFunctions(rs: RunningSession): Promise<void> {
    const session = rs.session;
    if (!session || rs.ended || rs.noDebug || !session.setFunctionBreakpoints) return;
    if (!rs.capabilities.peek().functionBreakpoints) return;
    const list = this.enabledFunctions();
    const key = JSON.stringify(list);
    if (rs.sentFunctions === key) return;
    rs.sentFunctions = key;
    const results = await session.setFunctionBreakpoints(list).catch(() => null);
    if (results) this.functionsPlaced(results);
  }

  /** Function breakpoints placed (or not): verified when any session placed them. */
  functionsPlaced(results: readonly { verified: boolean }[]): void {
    const enabled = this.other.functions.peek().filter((f) => f.enabled);
    if (enabled.length !== results.length) return;
    batch(() =>
      enabled.forEach((f, i) => {
        const verified = (results[i]?.verified ?? false) || f.verified === true;
        if (f.verified !== verified) this.other.updateFunction(f.id, { verified });
      }),
    );
  }

  async syncData(rs: RunningSession): Promise<void> {
    const session = rs.session;
    if (!session?.setDataBreakpoints || rs.ended || !rs.capabilities.peek().dataBreakpoints) return;
    const own = this.other.data.peek().filter((d) => d.sessionId === rs.id && d.enabled);
    const list = own.map((d) => ({ dataId: d.dataId, accessType: d.accessType }));
    const key = JSON.stringify(list);
    if (rs.sentData === key) return;
    rs.sentData = key;
    const results = await session.setDataBreakpoints(list).catch(() => null);
    if (results)
      batch(() =>
        own.forEach((d, i) => {
          const verified = results[i]?.verified ?? false;
          if (d.verified !== verified) this.other.updateData(d.id, { verified });
        }),
      );
  }

  /** Instruction breakpoints (the disassembly view's) to every session that takes them. */
  async syncInstructions(rs: RunningSession): Promise<void> {
    const session = rs.session;
    if (
      !session?.setInstructionBreakpoints ||
      rs.ended ||
      rs.noDebug ||
      !rs.capabilities.peek().instructionBreakpoints
    )
      return;
    const enabled = this.other.instructions.peek().filter((b) => b.enabled);
    const list = enabled.map((b) => ({ instructionReference: b.address }));
    const key = JSON.stringify(list);
    if (rs.sentInstructions === key) return;
    rs.sentInstructions = key;
    const results = await session.setInstructionBreakpoints(list).catch(() => null);
    if (results)
      batch(() =>
        enabled.forEach((b, i) => {
          const verified = (results[i]?.verified ?? false) || b.verified === true;
          if (b.verified !== verified) this.other.updateInstruction(b.id, { verified });
        }),
      );
  }

  /** The adapter's exception filters (when it has some) or caught / uncaught. */
  private exceptionFilterArgs(rs: RunningSession, caps: DebugCapabilities) {
    if (rs.noDebug || !caps.exceptionFilters.length) return null;
    return exceptionBreakpointsArgs(
      caps.exceptionFilters,
      this.other.filterChoices.peek(),
      caps.exceptionFilterOptions,
    );
  }

  async applyExceptions(rs: RunningSession): Promise<void> {
    const session = rs.session;
    if (!session || rs.ended || !rs.inspectable) return;
    const args = this.exceptionFilterArgs(rs, rs.capabilities.peek());
    if (args && session.setExceptionFilters)
      await session.setExceptionFilters(args).catch(() => {});
    else
      await session
        .setExceptionStops({
          uncaught: !rs.noDebug && this.breakpoints.uncaught.peek(),
          caught: !rs.noDebug && this.breakpoints.caught.peek(),
        })
        .catch(() => {});
  }

  /** A session placed `path`'s breakpoints: a breakpoint is placed when any session placed it. */
  placed(rs: RunningSession, path: string, results: BreakpointResult[]): void {
    if (!rs.inspectable || rs.ended) return;
    const key = pathKey(path);
    rs.placed.set(key, results);
    this.verify(key);
  }

  /**
   * The placed state of `key`'s breakpoints from every session's report: each result lines up
   * with the ids sent to that session. One no session has (a triggered breakpoint still waiting)
   * is neither placed nor not.
   */
  verify(key: string): void {
    const enabled = this.breakpoints.list
      .peek()
      .filter((b) => b.enabled && pathKey(b.path) === key);
    const reports = this.sessions.peek().flatMap((s) => {
      const ids = s.sentIds.get(key);
      const results = s.placed.get(key);
      return ids && results && results.length === ids.length ? [{ ids, results }] : [];
    });
    if (!reports.length) return;
    batch(() =>
      enabled.forEach((b) => {
        const mine = reports
          .map(({ ids, results }) => results[ids.indexOf(b.id)])
          .filter((r): r is BreakpointResult => r !== undefined);
        const verified = mine.length ? mine.some((r) => r.verified) : undefined;
        const message = verified === false ? mine.find((r) => r.message)?.message : undefined;
        if (b.verified !== verified || b.message !== message)
          this.breakpoints.update(b.id, { verified, message });
      }),
    );
  }
}

/** The ids of a path's breakpoints as sent (the IDE always sets them). */
function sentIds(list: readonly SourceBreakpoint[]): number[] {
  return list.map((b) => b.id ?? -1);
}
