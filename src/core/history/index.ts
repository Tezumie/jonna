// Workspace undo/redo (DESIGN: "history"): operations that text undo can't reach — creating,
// renaming, moving, copying and deleting files and folders, replace all, the agent's accepted
// edits — each recorded with how to undo and redo it. Text edits stay in each editor's own undo
// stack (kept across close/reopen by the editor), and every write the app makes to a file is also
// snapshotted on disk by local history (Rust `history`), so an older version can be restored
// even after undo is gone. Cheap by design: an entry is a label and two closures; nothing is
// copied until undo runs. DOM-free.
import { Emitter } from "../events/index";
import { signal } from "../reactive/index";

export type OperationKind = "file" | "replace" | "agent" | "text";

export interface Operation {
  /** Sentence case, for menus and the timeline: "Rename a.ts to b.ts". */
  label: string;
  kind: OperationKind;
  /** Files it touched (absolute), for "what changed" views. */
  paths: readonly string[];
  undo(options?: StepOptions): Promise<void>;
  redo(options?: StepOptions): Promise<void>;
  /**
   * Undoing / redoing it removes files (undo of a create, redo of a delete): the question to
   * confirm with first (VS Code's explorer.confirmUndo), e.g. "Delete notes.txt?".
   */
  confirm?: { undo?: string; redo?: string };
}

export interface StepOptions {
  /**
   * Leave the files that changed since alone and undo / redo the rest (the user chose that
   * after a ChangedSinceError, D143). Operations without per-file parts ignore it.
   */
  skipChanged?: boolean;
}

/**
 * A multi-file step found files changed since it ran, and changed nothing. The user can then
 * choose to step the other files (StepOptions.skipChanged).
 */
export class ChangedSinceError extends Error {
  constructor(
    readonly changed: readonly string[],
    readonly total: number,
  ) {
    super(
      `${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ` and ${changed.length - 3} more` : ""} changed since; nothing was changed.`,
    );
  }
}

export interface HistoryEntry {
  /** Unique per entry: `undo(id)` refuses when a different one is on top. */
  readonly id: number;
  readonly label: string;
  readonly kind: OperationKind;
  readonly paths: readonly string[];
  readonly timestamp: number;
  /** The question to ask before undoing (on the undo stack) or redoing (on the redo stack). */
  readonly confirm?: string;
  /**
   * When it last moved (pushed, undone or redone), ms: editors tie a file reload to it (the
   * undo stack's top was just done, the redo stack's top just undone).
   */
  readonly appliedAt: number;
}

const LIMIT = 100;

interface Recorded extends Operation {
  id: number;
  timestamp: number;
  appliedAt: number;
}

export class OperationHistory {
  private readonly done: Recorded[] = [];
  private readonly undone: Recorded[] = [];
  private readonly version = signal(0);
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  private busy: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  /** Bumped by every push: a step that ran meanwhile knows the stacks moved under it. */
  private pushes = 0;
  /** Bumped by clear(): a step that ran meanwhile belongs to the stacks that were dropped. */
  private clears = 0;

  /** Records an operation that just happened (clears redo, like any editor). Returns its id. */
  push(op: Operation): number {
    const now = Date.now();
    const id = this.nextId++;
    this.done.push({ ...op, id, timestamp: now, appliedAt: now });
    if (this.done.length > LIMIT) this.done.shift();
    this.undone.length = 0;
    this.pushes++;
    this.bump();
    return id;
  }

  /**
   * Undoes the newest operation. Returns its label, or null when there is nothing to undo.
   * With `expected` (an entry id), refuses when another entry is on top by the time it runs —
   * what the user confirmed is what runs.
   */
  undo(expected?: number, options?: StepOptions): Promise<string | null> {
    return this.step(this.done, this.undone, "undo", expected, options);
  }

  redo(expected?: number, options?: StepOptions): Promise<string | null> {
    return this.step(this.undone, this.done, "redo", expected, options);
  }

  /** What undo (or redo) would run next, or null. */
  peek(how: "undo" | "redo"): HistoryEntry | null {
    const op = (how === "undo" ? this.done : this.undone).at(-1);
    return op ? this.view(op, how) : null;
  }

  /**
   * Drops the next entry without running it (it can't be replayed: its files changed), so the
   * one before it can be undone.
   */
  discard(how: "undo" | "redo"): void {
    (how === "undo" ? this.done : this.undone).pop();
    this.bump();
  }

  /**
   * Runs one at a time, so a quick Ctrl+Z Ctrl+Z undoes two operations in order. A failed step
   * stays where it was: operations check before they change anything and reverse what they
   * did when they fail half way, so the files are as before and it can be tried again (or
   * discarded) — the stacks never lose track of the files.
   */
  private step(
    from: Recorded[],
    to: Recorded[],
    how: "undo" | "redo",
    expected?: number,
    options?: StepOptions,
  ): Promise<string | null> {
    const run = this.busy.then(async () => {
      const top = from.at(-1);
      if (top && expected !== undefined && top.id !== expected)
        throw new Error("Something else happened meanwhile; nothing was changed. Try again.");
      const op = from.pop();
      if (!op) return null;
      const fromIndex = from.length;
      const toIndex = to.length;
      const pushes = this.pushes;
      const clears = this.clears;
      // Started now: reloads the step causes come after this (editors tie them to it).
      op.appliedAt = Date.now();
      try {
        await op[how](options);
      } catch (err) {
        // Back where it was — unless it was a redo and a new operation cleared the redo stack.
        if (clears === this.clears && !(how === "redo" && pushes !== this.pushes))
          from.splice(Math.min(fromIndex, from.length), 0, op);
        this.bump();
        throw err;
      }
      if (clears !== this.clears) {
        // The history was cleared (folder switch) while it ran: it belongs to neither stack.
      } else if (how === "undo" && pushes !== this.pushes) {
        // A new operation was recorded while this undo ran: redo can't apply after it.
      } else to.splice(Math.min(toIndex, to.length), 0, op);
      this.bump();
      return op.label;
    });
    this.busy = run.catch(() => {});
    return run;
  }

  /** Forgets everything (folder switch). */
  clear(): void {
    this.clears++;
    this.done.length = 0;
    this.undone.length = 0;
    this.bump();
  }

  /** Reactive: the label undo would revert, or null. */
  undoLabel(): string | null {
    return this.read(this.done);
  }

  redoLabel(): string | null {
    return this.read(this.undone);
  }

  canUndo(): boolean {
    this.version.value;
    return this.done.length > 0;
  }

  canRedo(): boolean {
    this.version.value;
    return this.undone.length > 0;
  }

  /** Newest first (reactive). */
  entries(): { done: HistoryEntry[]; undone: HistoryEntry[] } {
    this.version.value;
    return {
      done: this.done.map((r) => this.view(r, "undo")).reverse(),
      undone: this.undone.map((r) => this.view(r, "redo")).reverse(),
    };
  }

  private view(r: Recorded, how: "undo" | "redo"): HistoryEntry {
    const confirm = r.confirm?.[how];
    return {
      id: r.id,
      label: r.label,
      kind: r.kind,
      paths: r.paths,
      timestamp: r.timestamp,
      appliedAt: r.appliedAt,
      ...(confirm && { confirm }),
    };
  }

  private read(list: Recorded[]): string | null {
    this.version.value;
    return list.at(-1)?.label ?? null;
  }

  private bump(): void {
    this.version.value = this.version.peek() + 1;
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}
