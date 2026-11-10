// The agent's edits under review (PLAN §8.3 "changeset review"). Since D199 they're written to
// disk as the agent makes them (Cursor's way), checkpointed first, so its own commands and tests
// see them; the changeset remembers what each file held before (`original`) for the review. The
// user accepts or rejects per file, per change (hunk) or everything: accepting keeps the file as
// it is (one workspace undo entry), rejecting puts back what it held (on top of anything typed
// since). Auto-apply mode accepts at once. A proposal made with `staged` (the memory tidy-up) stays
// off disk until accepted, as every proposal did before D199.

import { ReadTracker } from "../../core/agent/readTracker";
import {
  applyChange,
  changeAtLine,
  diffLines,
  diffStat,
  rebase,
  revertChange,
  splitLines,
} from "../../core/diff/index";
import { ChangedSinceError, type StepOptions } from "../../core/history/index";
import { agentStoreIpc } from "../../core/ipc/agent";
import { fsIpc } from "../../core/ipc/fs";
import { isWithin, pathKey, samePath } from "../../core/paths/index";
import { type ReadonlySignal, signal } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { firstChangedLine } from "./follow";
import { helperRootOf } from "./toolRoots";

/** What a turn's applied writes did to a file (its changes card's row). */
export interface AppliedStat {
  added: number;
  removed: number;
  created: boolean;
  deleted: boolean;
}

export interface PendingFile {
  path: string;
  /** Text when the agent first touched it (null: new file). */
  original: string | null;
  proposed: string;
  /** Turn that last changed it (checkpoint id). */
  turn: number;
  /** Accepting deletes the file (to the IDE's trash); `proposed` is then "". */
  deleted?: boolean;
  /**
   * Already on disk (D199): the agent's text was written when proposed; accepting only ends the
   * review and rejecting reverts it. Absent: a staged proposal, written on accept.
   */
  onDisk?: boolean;
}

/** One change of a file under review, in the lines of the file as it is now (D199). */
export interface ReviewHunk {
  /** 1-based first line in the current text (for a pure deletion: the line after it). */
  startLine: number;
  /** Lines it spans now (0: a deletion). */
  lines: number;
  added: number;
  removed: number;
}

/** The changes from `before` to `after`, in `after`'s lines (D199). */
export function reviewHunks(before: string, after: string): ReviewHunk[] {
  return diffLines(splitLines(before), splitLines(after)).map((c) => ({
    startLine: c.modifiedStart + 1,
    lines: c.modifiedEnd - c.modifiedStart,
    added: c.modifiedEnd - c.modifiedStart,
    removed: c.originalEnd - c.originalStart,
  }));
}

const BOM = "﻿";

const STALE =
  "The file changed since the agent proposed this, in the same lines; reject it and ask again.";

/** A proposal's text applied to the file as it is `now` (null: missing), or STALE. */
function merged(f: PendingFile, now: string | null): string {
  if (now === f.original) return f.proposed;
  if (now === null || f.original === null) throw new Error(STALE);
  const text = rebase(f.original, now, f.proposed);
  if (text === null) throw new Error(STALE);
  return text;
}

export async function readText(services: WorkbenchServices, path: string): Promise<string | null> {
  const open = services.quickDiff.bufferText(path);
  if (open !== null) return open;
  try {
    return new TextDecoder().decode(await fsIpc.read(path)).replace(/^﻿/, "");
  } catch {
    return null;
  }
}

/** Files larger than this aren't read whole for the agent (a UI freeze, and useless to a model). */
export const AGENT_READ_MAX_BYTES = 4 * 1024 * 1024;

/** A NUL byte in the first 8 KB means binary (git's heuristic, as the editor uses). */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

export type DiskRead =
  | { kind: "text"; text: string }
  | { kind: "missing" }
  | { kind: "folder" }
  | { kind: "tooLarge"; size: number }
  | { kind: "binary" };

/**
 * Reads a file from disk for the agent with the checks a plain read lacks: the size is looked at
 * before reading (a huge file would freeze the UI) and binary content isn't decoded into text.
 */
export async function readDiskForAgent(
  path: string,
  maxBytes = AGENT_READ_MAX_BYTES,
): Promise<DiskRead> {
  let size: number;
  try {
    const stat = await fsIpc.stat(path);
    if (stat.kind === "dir") return { kind: "folder" };
    size = stat.size;
  } catch {
    return { kind: "missing" };
  }
  if (size > maxBytes) return { kind: "tooLarge", size };
  let bytes: Uint8Array;
  try {
    bytes = await fsIpc.read(path);
  } catch {
    return { kind: "missing" };
  }
  if (looksBinary(bytes)) return { kind: "binary" };
  return { kind: "text", text: new TextDecoder().decode(bytes).replace(/^\uFEFF/, "") };
}

/**
 * A file's text for the agent to change: like `readText`, but a file that isn't plain UTF-8 text
 * (binary, UTF-16 from PowerShell 5.1's `>`, a legacy code page) or is too large is refused —
 * decoding it would write U+FFFD over every such byte on accept (D161).
 */
export async function editableText(
  services: WorkbenchServices,
  path: string,
): Promise<string | null> {
  const open = services.quickDiff.bufferText(path);
  const name = path.split(/[\\/]/).pop() ?? path;
  if (open !== null) {
    // Reopened in another encoding (D199): the agent's text would be saved in it, and a revert
    // read back as UTF-8. Same rule as on disk.
    const enc = services.quickDiff.bufferEncoding?.(path);
    if (enc && enc !== "utf8" && enc !== "utf8bom")
      throw new Error(
        `${name} is open in a legacy encoding, not UTF-8: editing it here could corrupt it. Ask the user to save it as UTF-8 first.`,
      );
    return open;
  }
  let size: number;
  try {
    const stat = await fsIpc.stat(path);
    if (stat.kind === "dir") throw new Error(`${name} is a folder.`);
    size = stat.size;
  } catch (err) {
    if (err instanceof Error && err.message.endsWith("is a folder.")) throw err;
    return null;
  }
  if (size > AGENT_READ_MAX_BYTES) throw new Error(`${name} is too large to edit here.`);
  let bytes: Uint8Array;
  try {
    bytes = await fsIpc.read(path);
  } catch {
    return null;
  }
  if (looksBinary(bytes) && !(bytes[0] === 0xff && bytes[1] === 0xfe))
    throw new Error(`${name} is a binary file; it can't be edited as text.`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    throw new Error(
      `${name} isn't UTF-8 text (UTF-16 or a legacy encoding): editing it here would corrupt it. Ask the user to convert it to UTF-8 first (or delete it and write a new file).`,
    );
  }
}

/** How many files' fingerprints a saved chat keeps (the most recently seen). */
const SEEN_SAVED = 400;

/**
 * A cheap fingerprint of a text (D221): its length and two 32-bit FNV-1a hashes over its UTF-16
 * units (different seeds), enough to tell a change, never to read the text back.
 */
export function textFingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return `${text.length.toString(36)}.${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
}

export class Changeset {
  private readonly list = signal<readonly PendingFile[]>([]);
  readonly files: ReadonlySignal<readonly PendingFile[]> = this.list;

  constructor(
    private readonly services: WorkbenchServices,
    private readonly session: string,
  ) {}

  get(path: string): PendingFile | undefined {
    return this.list.peek().find((f) => samePath(f.path, path));
  }

  /**
   * A fingerprint of each file as the agent last saw it (read_file, or its own write), so
   * write_file doesn't replace a file someone changed since without the agent knowing (Claude
   * Code's "file has been modified since read"). Saved with the chat (D221: a fingerprint, not
   * the text), so the check holds after a restart.
   */
  private readonly seen = new Map<string, string>();

  noteSeen(path: string, text: string): void {
    const key = pathKey(path);
    // Newest last: the saved list keeps the most recent files.
    this.seen.delete(key);
    this.seen.set(key, textFingerprint(text));
    this.reads.record(key, path, text);
  }

  /**
   * The text the agent last saw of each file (D308): a change by someone else since comes back to
   * it as a note (changeNotices.ts). In memory only; the fingerprints above are what's saved.
   */
  readonly reads = new ReadTracker();

  /** Whether the agent read (or wrote) `path` in this chat: edit_file needs it (D309). */
  hasSeen(path: string): boolean {
    return this.seen.has(pathKey(path));
  }

  /**
   * Whether `current` (the file now) differs from what the agent last saw of it; false when it
   * hasn't seen the file in this chat.
   */
  changedSinceSeen(path: string, current: string): boolean {
    const seen = this.seen.get(pathKey(path));
    return seen !== undefined && seen !== textFingerprint(current);
  }

  /** The fingerprints for the saved chat (the newest SEEN_SAVED files). */
  seenJSON(): Record<string, string> {
    return Object.fromEntries([...this.seen].slice(-SEEN_SAVED));
  }

  restoreSeen(data: unknown): void {
    if (!data || typeof data !== "object") return;
    for (const [key, value] of Object.entries(data))
      if (typeof value === "string") this.seen.set(key, value);
  }

  /** What the agent sees: a staged proposal's text, else the file (open buffer or disk). */
  async current(path: string): Promise<string | null> {
    const f = this.get(path);
    if (f && !f.onDisk) return f.proposed;
    return editableText(this.services, path);
  }

  /** A staged proposal's text, else undefined (the file itself is what the agent reads). */
  staged(path: string): string | undefined {
    const f = this.get(path);
    return f && !f.onDisk ? f.proposed : undefined;
  }

  /**
   * The agent's new text for `path`. Written to disk now (checkpointed), unless `staged` (or the
   * file already has a staged proposal): then it waits for accept.
   */
  async propose(
    path: string,
    text: string,
    turn: number,
    opts: { staged?: boolean } = {},
  ): Promise<PendingFile> {
    return this.serial(() => this.proposeNow(path, text, turn, opts));
  }

  /**
   * One change at a time (review item 9): a reject while the agent's write to the same file is
   * in flight would otherwise be undone by that write.
   */
  private chain: Promise<unknown> = Promise.resolve();
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  private async proposeNow(
    path: string,
    text: string,
    turn: number,
    opts: { staged?: boolean },
  ): Promise<PendingFile> {
    this.rejected.delete(`${turn}#${path}`);
    const existing = this.get(path);
    const staged = existing ? !existing.onDisk : opts.staged === true;
    const original = existing ? existing.original : await editableText(this.services, path);
    // What the file showed before this edit (on disk, or the staged proposal): where it starts.
    let previous: string | null = existing ? existing.proposed : original;
    if (!staged) {
      const now = existing ? await readText(this.services, path) : original;
      previous = now;
      await agentStoreIpc
        .checkpointAdd(this.session, turn, [{ path, content: now }])
        .catch(() => {});
      text = await this.write(path, text);
      this.track(path, turn, now, text);
    }
    const file: PendingFile = {
      path,
      original,
      proposed: text,
      turn,
      ...(!staged && { onDisk: true }),
    };
    const others = this.list.peek().filter((f) => !samePath(f.path, path));
    // Proposing the original text again means "no change".
    this.list.value = file.proposed === file.original ? others : [...others, file];
    this.noteSeen(path, text);
    if (previous !== text) this.edited(path, previous, text, staged);
    return file;
  }

  /**
   * A change someone else already wrote to disk (D208: an external agent writing files itself):
   * `before` is what the file held when the turn began (null: created), `after` what it holds now
   * (null: deleted). It's checkpointed and put under review like the IDE agent's own writes, so
   * rejecting puts `before` back.
   */
  async adopt(
    path: string,
    before: string | null,
    after: string | null,
    turn: number,
  ): Promise<void> {
    return this.serial(async () => {
      this.rejected.delete(`${turn}#${path}`);
      await agentStoreIpc
        .checkpointAdd(this.session, turn, [{ path, content: before }])
        .catch(() => {});
      this.writes++;
      this.track(path, turn, before, after);
      const existing = this.get(path);
      const original = existing ? existing.original : before;
      const others = this.list.peek().filter((f) => !samePath(f.path, path));
      if (after === null) {
        this.list.value =
          original === null
            ? others
            : [...others, { path, original, proposed: "", turn, deleted: true, onDisk: true }];
        return;
      }
      this.list.value =
        after === original
          ? others
          : [...others, { path, original, proposed: after, turn, onDisk: true }];
      this.noteSeen(path, after);
      if (before !== after) this.edited(path, before, after, false);
    });
  }

  /** Tells the window the agent changed a file and where (Follow the agent, D383). */
  private edited(path: string, before: string | null, after: string, staged: boolean): void {
    this.services.events?.emit("agent.didEdit", {
      session: this.session,
      path,
      line: firstChangedLine(before, after),
      staged,
    });
  }

  /** Proposes deleting a file: to the IDE's trash now (staged: on accept). */
  async proposeDelete(path: string, turn: number, opts: { staged?: boolean } = {}): Promise<void> {
    return this.serial(() => this.proposeDeleteNow(path, turn, opts));
  }

  private async proposeDeleteNow(
    path: string,
    turn: number,
    opts: { staged?: boolean },
  ): Promise<void> {
    this.rejected.delete(`${turn}#${path}`);
    const existing = this.get(path);
    const staged = existing ? !existing.onDisk : opts.staged === true;
    const others = this.list.peek().filter((f) => !samePath(f.path, path));
    // A file the agent created itself: deleting it drops the proposal (D163), and the file.
    if (existing && existing.original === null) {
      if (!staged) await this.trash(path, turn);
      this.list.value = others;
      return;
    }
    const original = existing ? existing.original : await readText(this.services, path);
    if (original === null) return;
    if (!staged) await this.trash(path, turn);
    this.list.value = [
      ...others,
      { path, original, proposed: "", turn, deleted: true, ...(!staged && { onDisk: true }) },
    ];
  }

  /** Moves the agent's file to the IDE's trash now (checkpointed). */
  private async trash(path: string, turn: number): Promise<void> {
    const now = await readText(this.services, path);
    if (now === null) return;
    await agentStoreIpc.checkpointAdd(this.session, turn, [{ path, content: now }]).catch(() => {});
    await fsIpc.trash(path);
    this.services.events.emit("files.didDelete", { path });
    this.track(path, turn, now, null);
  }

  /** The changes of `path` under review, in its current lines (D199: the inline review). */
  async hunks(path: string): Promise<ReviewHunk[]> {
    const f = this.get(path);
    if (!f || f.deleted) return [];
    if (!f.onDisk) return reviewHunks(f.original ?? "", f.proposed);
    const now = (await readText(this.services, path)) ?? "";
    return reviewHunks(this.reviewBase(f, now), now);
  }

  /**
   * The file as it is `now` without the agent's changes (D199): its edit undone on top of what the
   * user typed since, so the review shows only the agent's lines. Falls back to the original when
   * the user changed the same lines.
   */
  private reviewBase(f: PendingFile, now: string): string {
    if (f.original === null) return "";
    if (now === f.proposed) return f.original;
    return rebase(f.proposed, now, f.original) ?? f.original;
  }

  stat(file: PendingFile): { added: number; removed: number } {
    return diffStat(diffLines(splitLines(file.original ?? ""), splitLines(file.proposed)));
  }

  /** Totals for the changeset bar. */
  totals(): { files: number; added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const f of this.list.peek()) {
      const s = this.stat(f);
      added += s.added;
      removed += s.removed;
    }
    return { files: this.list.peek().length, added, removed };
  }

  /** What each file held before the agent's latest accepted change (null: it created it). */
  private readonly applied = new Map<string, string | null>();

  /**
   * What the agent wrote to each file in each turn that touched it: the text before that turn's
   * first write and after its last, for that turn's changes card (D154, per turn since D160).
   * Keyed `${turn}#${path}`.
   */
  private readonly spans = new Map<
    string,
    {
      before: string | null;
      after: string | null;
      stat?: { added: number; removed: number };
      /** Texts dropped (an older turn): only `stat` and the flags are left (D160). */
      settled?: { created: boolean; deleted: boolean };
    }
  >();
  /** The latest turn that wrote each file. */
  private readonly latestTurn = new Map<string, number>();

  private track(path: string, turn: number, before: string | null, after: string | null): void {
    const key = `${turn}#${path}`;
    const span = this.spans.get(key);
    if (span?.settled) {
      // A late accept on an older turn: its own change adds to the counts kept.
      const d = diffStat(diffLines(splitLines(before ?? ""), splitLines(after ?? "")));
      span.stat = {
        added: (span.stat?.added ?? 0) + d.added,
        removed: (span.stat?.removed ?? 0) + d.removed,
      };
      span.settled.deleted = after === null;
    } else if (span) {
      span.after = after;
      delete span.stat;
    } else this.spans.set(key, { before, after });
    this.latestTurn.set(path, Math.max(turn, this.latestTurn.get(path) ?? turn));
  }

  /** Applied stats saved with the chat (the texts themselves aren't): after a restart. */
  private savedStats = new Map<string, AppliedStat>();

  /** Files `turn` wrote to disk (accepted, not deleted): what format-on-finish formats (D179). */
  writtenIn(turn: number): string[] {
    const out: string[] = [];
    for (const [key, span] of this.spans) {
      const at = key.indexOf("#");
      if (Number(key.slice(0, at)) === turn && span.after !== null) out.push(key.slice(at + 1));
    }
    return out;
  }

  /** The applied stats per turn and file, for saving with the chat (D159, D160). */
  appliedJSON(): Record<string, AppliedStat> {
    const out: Record<string, AppliedStat> = Object.fromEntries(this.savedStats);
    for (const key of this.spans.keys()) {
      const at = key.indexOf("#");
      const stat = this.appliedStat(key.slice(at + 1), Number(key.slice(0, at)));
      if (stat) out[key] = stat;
    }
    return out;
  }

  restoreApplied(data: unknown): void {
    if (!data || typeof data !== "object") return;
    for (const [key, v] of Object.entries(data as Record<string, unknown>)) {
      const x = v as { added?: unknown; removed?: unknown; created?: unknown; deleted?: unknown };
      if (typeof x?.added !== "number" || typeof x.removed !== "number") continue;
      this.savedStats.set(key, {
        added: x.added,
        removed: x.removed,
        created: x.created === true,
        deleted: x.deleted === true,
      });
      const turn = /^(\d+)#(.*)$/.exec(key);
      if (turn?.[1] && turn[2] !== undefined)
        this.latestTurn.set(turn[2], Math.max(Number(turn[1]), this.latestTurn.get(turn[2]) ?? 0));
    }
  }

  /**
   * Lines added / removed by the agent's applied writes to `path` in `turn` (default: the latest
   * turn that wrote it).
   */
  appliedStat(path: string, turn?: number): AppliedStat | undefined {
    const t = turn ?? this.latestTurn.get(path);
    const key = `${t}#${path}`;
    const span = t === undefined ? undefined : this.spans.get(key);
    // Saved with the chat (per turn), or by path from chats saved before per-turn stats.
    if (!span) return this.savedStats.get(key) ?? this.savedStats.get(path);
    if (span.settled) return { added: 0, removed: 0, ...span.stat, ...span.settled };
    span.stat ??= diffStat(diffLines(splitLines(span.before ?? ""), splitLines(span.after ?? "")));
    return { ...span.stat, created: span.before === null, deleted: span.after === null };
  }

  /**
   * Keeps only the counts of turns before `turn` (their texts can be whole files, kept for the
   * session otherwise, D160).
   */
  settleSpans(turn: number): void {
    for (const [key, span] of this.spans) {
      if (span.settled || Number(key.slice(0, key.indexOf("#"))) >= turn) continue;
      span.stat ??= diffStat(
        diffLines(splitLines(span.before ?? ""), splitLines(span.after ?? "")),
      );
      span.settled = { created: span.before === null, deleted: span.after === null };
      span.before = null;
      span.after = null;
    }
  }

  /** The text before the agent's latest applied change to `path` (undefined: none this session). */
  appliedBefore(path: string): string | null | undefined {
    return this.applied.get(path);
  }

  /** Files written so far (a turn that wrote any reloads the browser's local pages, D160). */
  writes = 0;

  /** Writes `text`; returns what landed (an open file's save may trim or format it, D199). */
  private async write(path: string, text: string): Promise<string> {
    this.writes++;
    if (await this.services.quickDiff.writeBuffer(path, text))
      return this.services.quickDiff.bufferText(path) ?? text;
    const before = await fsIpc.read(path).catch(() => null);
    const bom = before ? new TextDecoder().decode(before.subarray(0, 3)) === BOM : false;
    await fsIpc.write(path, new TextEncoder().encode(bom ? BOM + text : text), "agent");
    this.services.events.emit(
      before ? "files.didChange" : "files.didCreate",
      before ? { path } : { path, kind: "file" },
    );
    return text;
  }

  /** Accepted edits as one workspace undo entry (Edit → Undo / Ctrl+Z in the explorer). */
  private record(all: { path: string; before: string | null; after: string | null }[]): void {
    for (const f of all) this.applied.set(f.path, f.before);
    // A headless helper's edits in its worktree aren't this folder's to undo from the explorer:
    // they're reviewed and merged as its branch.
    const worktree = helperRootOf(this.session);
    const files = worktree ? all.filter((f) => !isWithin(worktree, f.path)) : all;
    if (!files.length) return;
    let active = files;
    const first = files[0]?.path ?? "";
    this.services.history.push({
      label:
        files.length === 1
          ? `Accept agent edit to ${first.split(/[\\/]/).pop()}`
          : `Accept agent edits to ${files.length} files`,
      kind: "agent",
      paths: files.map((f) => f.path),
      // Undoing removes the files the agent created, redoing removes the ones it deleted:
      // asked first, like the explorer's (explorer.confirmUndo).
      ...((files.some((f) => f.before === null) || files.some((f) => f.after === null)) && {
        confirm: {
          ...(files.some((f) => f.before === null) && {
            undo: `Undo the agent's edits? This deletes the ${files.filter((f) => f.before === null).length} file(s) it created.`,
          }),
          ...(files.some((f) => f.after === null) && {
            redo: `Redo the agent's edits? This deletes the ${files.filter((f) => f.after === null).length} file(s) it deleted.`,
          }),
        },
      }),
      // The files still covered: all, until the user left changed ones out (D143).
      undo: async (opts) => {
        active = await this.replay(active, "before", opts);
      },
      redo: async (opts) => {
        active = await this.replay(active, "after", opts);
      },
    });
  }

  /**
   * Puts every file to `to` — all or none (D141): each must still hold the other side (else
   * nothing changes and it says which), and a failure half way restores the files done.
   */
  private async replay(
    files: { path: string; before: string | null; after: string | null }[],
    to: "before" | "after",
    opts?: StepOptions,
  ): Promise<typeof files> {
    const changed: typeof files = [];
    for (const f of files)
      if ((await readText(this.services, f.path)) !== (to === "before" ? f.after : f.before))
        changed.push(f);
    if (changed.length && !opts?.skipChanged)
      throw new ChangedSinceError(
        changed.map((f) => f.path.split(/[\\/]/).pop() ?? f.path),
        files.length,
      );
    const targets = files.filter((f) => !changed.includes(f));
    const set = async (path: string, text: string | null) => {
      if (text === null) {
        await fsIpc.trash(path);
        this.services.events.emit("files.didDelete", { path });
      } else await this.write(path, text);
    };
    const done: typeof files = [];
    try {
      for (const f of targets) {
        await set(f.path, to === "before" ? f.before : f.after);
        done.push(f);
      }
    } catch (err) {
      for (const f of done.reverse())
        await set(f.path, to === "before" ? f.after : f.before).catch(() => {});
      throw err;
    }
    return targets;
  }

  /** Writes pending files to disk (all, or `paths`), checkpointing their current text first. */
  /** Not serialized: a proposal made while accepting stays a proposal (D159). */
  async accept(paths?: readonly string[]): Promise<string[]> {
    // A file already being accepted (a double click on Accept) isn't accepted twice.
    const chosen = this.list
      .peek()
      .filter((f) => (!paths || paths.some((p) => samePath(p, f.path))) && !this.accepting.has(f));
    for (const f of chosen) this.accepting.add(f);
    const record: { path: string; before: string | null; after: string | null }[] = [];
    const failed: string[] = [];
    // One file failing (locked, its folder deleted) doesn't stop the rest; what was written is
    // still one undo entry and leaves the list.
    for (const f of chosen) {
      try {
        const now = await readText(this.services, f.path);
        // Already on disk (D199): accepting keeps the file as it is now.
        if (f.onDisk) {
          record.push({ path: f.path, before: f.original, after: now });
          continue;
        }
        await agentStoreIpc
          .checkpointAdd(this.session, f.turn, [{ path: f.path, content: now }])
          .catch(() => {});
        if (f.deleted) {
          if (now !== f.original) throw new Error(STALE);
          if (now !== null) {
            await fsIpc.trash(f.path);
            this.services.events.emit("files.didDelete", { path: f.path });
          }
          record.push({ path: f.path, before: now, after: null });
          this.track(f.path, f.turn, now, null);
          continue;
        }
        // The file changed since the proposal (the user typed, another chat's change was
        // applied): the agent's edits go on top of it, or it's reviewed again (D161).
        const text = merged(f, now);
        await this.write(f.path, text);
        record.push({ path: f.path, before: now, after: text });
        this.track(f.path, f.turn, now, text);
      } catch (err) {
        failed.push(`${f.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.record(record);
    const done = new Set(record.map((f) => f.path));
    // By the proposal itself, not its path: one the agent made while this was writing stays.
    const written = new Set(chosen.filter((f) => done.has(f.path)));
    this.list.value = this.list.peek().filter((f) => !written.has(f));
    for (const f of chosen) this.accepting.delete(f);
    if (failed.length)
      throw new Error(`Couldn't apply ${failed.length} file(s):\n${failed.join("\n")}`);
    return [...done];
  }

  /** Proposals being written by `accept` right now. */
  private readonly accepting = new Set<PendingFile>();
  /**
   * Proposals rejected, as `${turn}#${path}` (that turn's changes card says so, D159; per turn
   * and saved with the chat since D160).
   */
  private readonly rejected = new Set<string>();

  /** Whether the proposal of `path` made in `turn` (default: any turn) was rejected. */
  wasRejected(path: string, turn?: number): boolean {
    if (turn !== undefined) return this.rejected.has(`${turn}#${path}`);
    for (const key of this.rejected) if (key.endsWith(`#${path}`)) return true;
    return false;
  }

  rejectedJSON(): string[] {
    return [...this.rejected];
  }

  restoreRejected(data: unknown): void {
    if (Array.isArray(data))
      for (const key of data) if (typeof key === "string") this.rejected.add(key);
  }

  /**
   * Rejects proposals (all, or `paths`). A change already on disk is reverted: the file gets back
   * what it held before the agent's edits, on top of anything typed since (D199); a file that
   * changed in the same lines is left as it is and reported.
   */
  async reject(paths?: readonly string[]): Promise<string[]> {
    return this.serial(() => this.rejectNow(paths));
  }

  private async rejectNow(paths: readonly string[] | undefined): Promise<string[]> {
    const chosen = this.list.peek().filter((f) => !paths || paths.some((p) => samePath(p, f.path)));
    const done: PendingFile[] = [];
    const failed: string[] = [];
    for (const f of chosen) {
      try {
        if (f.onDisk) await this.revert(f);
        done.push(f);
      } catch (err) {
        failed.push(`${f.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.list.value = this.list.peek().filter((f) => !done.includes(f));
    for (const f of done) this.rejected.add(`${f.turn}#${f.path}`);
    if (failed.length)
      throw new Error(`Couldn't revert ${failed.length} file(s):\n${failed.join("\n")}`);
    return done.map((f) => f.path);
  }

  /** Puts back what `f` held before the agent's edits (written ones, D199). */
  private async revert(f: PendingFile): Promise<void> {
    if (f.deleted) {
      // On disk, not the buffer: a tab with unsaved edits stays open after a delete (review 7).
      const there = await fsIpc.stat(f.path).then(
        () => true,
        () => false,
      );
      if (there) throw new Error("A file is there again; it was left as it is.");
      // Straight to disk: an open tab of it would only take the text into its buffer.
      if (f.original !== null) {
        this.writes++;
        await fsIpc.write(f.path, new TextEncoder().encode(f.original), "agent");
        this.services.events.emit("files.didCreate", { path: f.path, kind: "file" });
      }
      this.track(f.path, f.turn, null, f.original);
      return;
    }
    const now = await readText(this.services, f.path);
    if (f.original === null) {
      // A file the agent created: removed, unless it changed since.
      if (now === null) return;
      if (now !== f.proposed)
        throw new Error("It changed since the agent created it; it was left as it is.");
      await fsIpc.trash(f.path);
      this.services.events.emit("files.didDelete", { path: f.path });
      this.track(f.path, f.turn, now, null);
      return;
    }
    if (now === null) throw new Error("It was deleted since; nothing was put back.");
    // Undo the agent's change on top of the file as it is now (three-way, like accept's merge).
    const text = now === f.proposed ? f.original : rebase(f.proposed, now, f.original);
    if (text === null)
      throw new Error("It changed since in the same lines as the agent's edit; revert it by hand.");
    await this.write(f.path, text);
    this.track(f.path, f.turn, now, text);
  }

  /**
   * Accepts or rejects only the change at `line` (a line of the file as it is now, or of a staged
   * proposal's text).
   */
  async hunk(path: string, line: number, action: "accept" | "reject"): Promise<void> {
    return this.serial(() => this.hunkNow(path, line, action));
  }

  private async hunkNow(path: string, line: number, action: "accept" | "reject"): Promise<void> {
    const f = this.get(path);
    if (!f) throw new Error("No pending change for this file.");
    if (f.deleted) throw new Error("Accept or reject the deletion of the whole file.");
    if (f.onDisk) return this.diskHunk(f, line, action);
    const original = splitLines(f.original ?? "");
    const proposed = splitLines(f.proposed);
    const change = changeAtLine(diffLines(original, proposed), line);
    if (!change) throw new Error(`No pending change at line ${line}.`);
    if (action === "reject") {
      await this.proposeNow(path, revertChange(original, proposed, change), f.turn, {});
      return;
    }
    const now = await readText(this.services, path);
    await agentStoreIpc
      .checkpointAdd(this.session, f.turn, [{ path, content: now }])
      .catch(() => {});
    const next = applyChange(original, proposed, change);
    // The agent changed the file again while this waited: don't overwrite its newer proposal.
    if (this.get(path) !== f) throw new Error("The agent changed this file again; review it anew.");
    // On top of what the file holds now (the user may have typed since the proposal, D161).
    const text = merged({ ...f, proposed: next }, now);
    await this.write(path, text);
    this.record([{ path, before: now, after: text }]);
    this.track(path, f.turn, now, text);
    const others = this.list.peek().filter((x) => x !== f);
    this.list.value = next === f.proposed ? others : [...others, { ...f, original: next }];
  }

  /**
   * One change of a file already on disk (D199): accepting moves it into the review's baseline;
   * rejecting writes the file without it.
   */
  private async diskHunk(f: PendingFile, line: number, action: "accept" | "reject"): Promise<void> {
    const nowText = (await readText(this.services, f.path)) ?? "";
    // Only the agent's lines: the user's typing since is part of the base (review item 6).
    const baseText = this.reviewBase(f, nowText);
    const original = splitLines(baseText);
    const now = splitLines(nowText);
    const change = changeAtLine(diffLines(original, now), line);
    if (!change) throw new Error(`No pending change at line ${line}.`);
    const others = this.list.peek().filter((x) => x !== f);
    // Kept as (original, proposed) pairs against the text now, so reviewBase stays right later.
    if (action === "accept") {
      const base = applyChange(original, now, change);
      this.list.value =
        base === nowText ? others : [...others, { ...f, original: base, proposed: nowText }];
      return;
    }
    const text = revertChange(original, now, change);
    await this.write(f.path, text);
    this.track(f.path, f.turn, nowText, text);
    if (this.get(f.path) !== f) return;
    this.list.value =
      text === baseText
        ? others
        : [...others, { ...f, original: f.original === null ? null : baseText, proposed: text }];
  }

  clear(): void {
    this.list.value = [];
  }

  /**
   * After a checkpoint restore to before `turn` (D200): `restored` holds what each file put back
   * now has (null: removed). Proposals from those turns that only waited (staged) go; a file on
   * disk back at its original text is no longer under review; one still changed by an earlier
   * turn stays under review with its restored text.
   */
  afterRestore(turn: number, restored: ReadonlyMap<string, string | null>): void {
    const next: PendingFile[] = [];
    for (const f of this.list.peek()) {
      if (f.turn < turn) {
        next.push(f);
        continue;
      }
      if (!f.onDisk) continue;
      const hit = [...restored].find(([p]) => samePath(p, f.path));
      if (!hit) {
        next.push(f);
        continue;
      }
      const now = hit[1];
      if (now === f.original) continue;
      const kept: PendingFile = { ...f, proposed: now ?? "", turn: Math.max(1, turn - 1) };
      if (now === null) kept.deleted = true;
      else delete kept.deleted;
      next.push(kept);
    }
    this.list.value = next;
  }

  toJSON(): PendingFile[] {
    return [...this.list.peek()];
  }

  restore(files: readonly PendingFile[]): void {
    this.list.value = files.filter(
      (f) => typeof f.path === "string" && typeof f.proposed === "string",
    );
  }
}
