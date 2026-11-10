// Breakpoints (D143, D145): source lines, enabled or not, kept per workspace — with an optional
// condition, a hit count (`5`, `>5`, `%3`) and a log message (a logpoint prints instead of
// stopping, `{expr}` filled in). The debug extension sends them to running sessions and draws them
// (services.debugMarks); the session reports which ones it could place ("verified"). A triggered
// breakpoint waits for another one to be hit first (triggers.ts). DOM-free and tested.
import { pathKey } from "../../core/paths/index";
import { type Signal, signal } from "../../core/reactive/index";
import type { BreakpointGlyph } from "../../workbench/debugMarks";
import { renamedPath } from "../../workbench/gutterMarks";
import {
  dropDanglingTriggers,
  forgetSession,
  isWaiting,
  markTriggered,
  restoredTrigger,
  savedTrigger,
} from "./triggers";

export interface Breakpoint {
  id: number;
  /** Absolute path. */
  path: string;
  /** 1-based. */
  line: number;
  /** Stops only when this expression is true. */
  condition?: string;
  /** Stops from the Nth hit: "5" (= ">=5"), ">5", "==5", "%3" (every third). */
  hitCondition?: string;
  /** A logpoint: prints this (with `{expression}`s filled in) instead of stopping. */
  logMessage?: string;
  /**
   * A triggered breakpoint: the id of the breakpoint it waits for. It's set in a session only
   * once that one was hit there (VS Code's "Wait for breakpoint").
   */
  triggeredBy?: number;
  /** The sessions where its trigger was hit, so it's set there (not saved). */
  triggeredIn?: readonly string[];
  enabled: boolean;
  /** Set by a running session: placed (true), or not (false, with `message`). */
  verified?: boolean;
  message?: string;
}

/** What's saved per workspace. */
interface SavedBreakpoint {
  path: string;
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  /** The trigger's place (its id changes when restored). */
  triggeredBy?: { path: string; line: number };
  enabled: boolean;
}

/** Optional text fields: kept only when not empty. */
const OPTIONAL = ["condition", "hitCondition", "logMessage"] as const;
type Options = Partial<Pick<Breakpoint, (typeof OPTIONAL)[number]>>;
const options = (o: Options): Options => {
  const out: Options = {};
  for (const k of OPTIONAL) {
    const v = o[k]?.trim();
    if (v) out[k] = v;
  }
  return out;
};

/** A hit condition as VS Code writes it, or null when it isn't one. */
export function parseHitCondition(text: string): { op: ">=" | ">" | "==" | "%"; n: number } | null {
  const m = /^\s*(>=|>|==|=|%)?\s*(\d+)\s*$/.exec(text);
  if (!m) return null;
  const op = m[1] === "=" ? "==" : ((m[1] ?? ">=") as ">=" | ">" | "==" | "%");
  const n = Number(m[2]);
  return op === "%" && n === 0 ? null : { op, n };
}

export class BreakpointStore {
  readonly list: Signal<readonly Breakpoint[]> = signal([]);
  /** Stop on uncaught exceptions (VS Code's "Uncaught exceptions" checkbox). */
  readonly uncaught: Signal<boolean> = signal(false);
  /** Stop on every exception thrown, caught or not ("Caught exceptions"). */
  readonly caught: Signal<boolean> = signal(false);
  private nextId = 1;

  forPath(path: string): Breakpoint[] {
    const key = pathKey(path);
    return this.list.peek().filter((b) => pathKey(b.path) === key);
  }

  at(path: string, line: number): Breakpoint | undefined {
    return this.forPath(path).find((b) => b.line === line);
  }

  /**
   * Adds a breakpoint, or sets the one on that line to `opts` (enabled). `triggeredBy`: the id
   * of the breakpoint it waits for.
   */
  add(
    path: string,
    line: number,
    opts: (Options & { triggeredBy?: number }) | string = {},
  ): Breakpoint {
    const o = options(typeof opts === "string" ? { condition: opts } : opts);
    const trigger = typeof opts === "string" ? undefined : opts.triggeredBy;
    const existing = this.at(path, line);
    const t = trigger !== undefined && trigger !== existing?.id ? { triggeredBy: trigger } : {};
    if (existing) {
      this.set(
        this.list
          .peek()
          .map((b) =>
            b.id === existing.id
              ? { id: b.id, path: b.path, line: b.line, enabled: true, ...o, ...t }
              : b,
          ),
      );
      return this.get(existing.id) ?? existing;
    }
    const bp: Breakpoint = { id: this.nextId++, path, line, enabled: true, ...o, ...t };
    this.set([...this.list.peek(), bp]);
    return this.get(bp.id) ?? bp;
  }

  /** Sets the list, without trigger links to breakpoints that are gone. */
  private set(list: readonly Breakpoint[]): void {
    this.list.value = dropDanglingTriggers(list);
  }

  /** Adds a breakpoint on the line, or removes the one there. Returns it when added. */
  toggle(path: string, line: number): Breakpoint | null {
    const existing = this.at(path, line);
    if (existing) {
      this.remove(existing.id);
      return null;
    }
    return this.add(path, line);
  }

  get(id: number): Breakpoint | undefined {
    return this.list.peek().find((b) => b.id === id);
  }

  update(id: number, patch: Partial<Omit<Breakpoint, "id" | "path">>): void {
    this.set(
      this.list.peek().map((b) => {
        if (b.id !== id) return b;
        const next = { ...b, ...patch };
        for (const k of OPTIONAL) if (!next[k]?.trim()) delete next[k];
        // Another trigger (or none): it waits again everywhere.
        if ("triggeredBy" in patch && patch.triggeredBy !== b.triggeredBy) delete next.triggeredIn;
        if (next.triggeredBy === undefined) delete next.triggeredBy;
        return next;
      }),
    );
  }

  /** Removes it; breakpoints that waited for it become plain ones. */
  remove(id: number): void {
    this.set(this.list.peek().filter((b) => b.id !== id));
  }

  removeAll(path?: string): void {
    const key = path === undefined ? null : pathKey(path);
    this.set(key === null ? [] : this.list.peek().filter((b) => pathKey(b.path) !== key));
  }

  /** Session `sessionId` hit the triggers of `ids`: they're set there from now on. */
  markTriggered(sessionId: string, ids: readonly number[]): void {
    const next = markTriggered(this.list.peek(), ids, sessionId);
    if (next !== this.list.peek()) this.list.value = next;
  }

  /** Session `sessionId` ended: what it triggered waits again (VS Code resets per session). */
  sessionEnded(sessionId: string): void {
    const next = forgetSession(this.list.peek(), sessionId);
    if (next !== this.list.peek()) this.list.value = next;
  }

  setAllEnabled(enabled: boolean): void {
    this.list.value = this.list.peek().map((b) => ({ ...b, enabled }));
  }

  /**
   * Edits moved the breakpoints of `path` to `lines` (in `forPath` order). Two that land on the
   * same line (the lines between were deleted) become one.
   */
  moveLines(path: string, lines: readonly number[]): void {
    const own = this.forPath(path);
    if (own.length !== lines.length) return;
    const seen = new Set<number>();
    const drop = new Set<number>();
    const moved = new Map<number, number>();
    own.forEach((b, i) => {
      const line = lines[i] ?? b.line;
      if (seen.has(line)) drop.add(b.id);
      seen.add(line);
      if (line !== b.line) moved.set(b.id, line);
    });
    if (!moved.size && !drop.size) return;
    this.set(
      this.list
        .peek()
        .filter((b) => !drop.has(b.id))
        .map((b) => (moved.has(b.id) ? { ...b, line: moved.get(b.id) ?? b.line } : b)),
    );
  }

  /** A file or folder was renamed: its breakpoints go with it. */
  renamed(from: string, to: string): void {
    let changed = false;
    const next = this.list.peek().map((b) => {
      const p = renamedPath(b.path, from, to);
      if (p === null) return b;
      changed = true;
      return { ...b, path: p };
    });
    if (changed) this.list.value = next;
  }

  /** A session ended: nothing is placed any more. */
  clearVerification(): void {
    if (!this.list.peek().some((b) => b.verified !== undefined)) return;
    this.list.value = this.list.peek().map(({ verified: _v, message: _m, ...b }) => b);
  }

  /**
   * The dots for the editor, by pathKey. `session`: a session is running (unplaced = hollow). A
   * triggered breakpoint has the conditional mark (VS Code's icon for it); while it waits for
   * its trigger it's hollow too, since no session has it yet.
   */
  glyphs(session: boolean): Map<string, BreakpointGlyph[]> {
    const out = new Map<string, BreakpointGlyph[]>();
    for (const b of this.list.value) {
      const key = pathKey(b.path);
      const list = out.get(key) ?? [];
      list.push({
        line: b.line,
        state: !b.enabled
          ? "disabled"
          : session && isWaiting(b)
            ? "pending"
            : session && b.verified === false
              ? "unverified"
              : "verified",
        conditional: Boolean(b.condition || b.hitCondition || b.triggeredBy !== undefined),
        log: Boolean(b.logMessage),
      });
      out.set(key, list);
    }
    return out;
  }

  save(): { breakpoints: SavedBreakpoint[]; uncaught: boolean; caught: boolean } {
    const all = this.list.peek();
    return {
      breakpoints: all.map((b) => {
        const trigger = savedTrigger(all, b);
        return {
          path: b.path,
          line: b.line,
          enabled: b.enabled,
          ...options(b),
          ...(trigger ? { triggeredBy: trigger } : {}),
        };
      }),
      uncaught: this.uncaught.peek(),
      caught: this.caught.peek(),
    };
  }

  restore(data: unknown): void {
    const d = (data ?? {}) as { breakpoints?: unknown; uncaught?: unknown; caught?: unknown };
    const list: Breakpoint[] = [];
    const triggers = new Map<number, unknown>();
    for (const raw of Array.isArray(d.breakpoints) ? d.breakpoints : []) {
      const b = raw as Partial<SavedBreakpoint>;
      if (typeof b.path !== "string" || typeof b.line !== "number" || b.line < 1) continue;
      if (list.some((x) => pathKey(x.path) === pathKey(b.path ?? "") && x.line === b.line))
        continue;
      list.push({
        id: this.nextId++,
        path: b.path,
        line: Math.floor(b.line),
        enabled: b.enabled !== false,
        ...options({
          ...(typeof b.condition === "string" ? { condition: b.condition } : {}),
          ...(typeof b.hitCondition === "string" ? { hitCondition: b.hitCondition } : {}),
          ...(typeof b.logMessage === "string" ? { logMessage: b.logMessage } : {}),
        }),
      });
      const added = list[list.length - 1];
      if (added && b.triggeredBy) triggers.set(added.id, b.triggeredBy);
    }
    // Links once every breakpoint is back (a trigger may come later in the list).
    for (const [id, at] of triggers) {
      const b = list.find((x) => x.id === id);
      const trigger = restoredTrigger(list, at);
      if (b && trigger !== undefined && trigger !== id) b.triggeredBy = trigger;
    }
    this.set(list);
    this.uncaught.value = d.uncaught === true;
    this.caught.value = d.caught === true;
  }
}
