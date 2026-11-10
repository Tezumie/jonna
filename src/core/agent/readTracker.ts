// What the agent last saw of each file it read or wrote in a chat (D308), so a change made since
// by someone else (the user, a formatter, a git checkout, a command) comes back to it as a note
// with a short diff, as Claude Code's "changed on disk since you last read it". DOM-free: the
// extension reads the files and asks `observe` whether they changed.
import { diffLines, splitLines } from "../diff/index";

/** Files larger than this are remembered by a hash only: a change is named, not shown. */
export const KEEP_TEXT_CHARS = 256 * 1024;
/** Files remembered at most (the oldest go first). */
const MAX_FILES = 200;
/** Text kept at most over all files. */
const MAX_TOTAL_CHARS = 8_000_000;
/** A diff longer than this isn't shown: the note says the file changed, to read it again. */
export const MAX_NOTE_CHARS = 2500;
const MAX_NOTE_LINES = 60;

interface Tracked {
  path: string;
  /** The text the agent last saw, when small enough to keep. */
  text: string | null;
  hash: string;
  /** The file's size and time when it last matched (the extension's cheap "unchanged" check). */
  stamp: string | null;
}

/** A 2×32-bit FNV-1a hash and the length: enough to tell a change. */
export function textHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return `${text.length.toString(36)}.${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
}

export interface FileChange {
  note: string;
  /** The note shows the whole change (the agent knows the file as it is now). */
  shown: boolean;
  deleted: boolean;
}

export class ReadTracker {
  private readonly files = new Map<string, Tracked>();
  private total = 0;

  /** The agent saw `text` of `path` (read it, or wrote it). `key`: the path's comparison key. */
  record(key: string, path: string, text: string): void {
    this.forget(key);
    const kept = text.length <= KEEP_TEXT_CHARS ? text : null;
    this.files.set(key, { path, text: kept, hash: textHash(text), stamp: null });
    this.total += kept?.length ?? 0;
    // Oldest first out: by count, then by the text kept.
    for (const [k] of this.files) {
      if (this.files.size <= MAX_FILES && this.total <= MAX_TOTAL_CHARS) break;
      if (k === key) break;
      this.forget(k);
    }
  }

  forget(key: string): void {
    const old = this.files.get(key);
    if (!old) return;
    this.total -= old.text?.length ?? 0;
    this.files.delete(key);
  }

  has(key: string): boolean {
    return this.files.has(key);
  }

  /** The most recently seen files first, at most `limit`. */
  recent(limit: number): { key: string; path: string; stamp: string | null }[] {
    return [...this.files]
      .reverse()
      .slice(0, limit)
      .map(([key, f]) => ({ key, path: f.path, stamp: f.stamp }));
  }

  setStamp(key: string, stamp: string | null): void {
    const f = this.files.get(key);
    if (f) f.stamp = stamp;
  }

  /**
   * Compares the file as it is now (null: gone) with what the agent saw. Unchanged: null. Changed:
   * the note for the agent, and the file is remembered as it is now (each change is told once).
   */
  observe(key: string, now: string | null, name: string): FileChange | null {
    const f = this.files.get(key);
    if (!f) return null;
    if (now === null) {
      this.forget(key);
      return {
        note: `${name} was deleted (or moved) since you last read it.`,
        shown: true,
        deleted: true,
      };
    }
    if (textHash(now) === f.hash) return null;
    const note = changeNote(name, f.text, now);
    this.record(key, f.path, now);
    return { ...note, deleted: false };
  }
}

/**
 * The note for a file that changed: a short diff (- before, + now, with the line numbers it has
 * now), or, when the old text wasn't kept or the change is large, only that it changed.
 */
export function changeNote(
  name: string,
  before: string | null,
  after: string,
): { note: string; shown: boolean } {
  const tooLarge = (what: string) => ({
    note: `${name} changed since you last read it (by the user, a formatter or a command; ${what}). Read it again before you edit it.`,
    shown: false,
  });
  if (before === null || after.length > KEEP_TEXT_CHARS) return tooLarge("too large to show");
  const a = splitLines(before);
  const b = splitLines(after);
  const changes = diffLines(a, b);
  const strip = (l: string) => l.replace(/\r?\n$/, "");
  const rows: string[] = [];
  let added = 0;
  let removed = 0;
  for (const c of changes) {
    removed += c.originalEnd - c.originalStart;
    added += c.modifiedEnd - c.modifiedStart;
    const at = c.modifiedEnd > c.modifiedStart ? c.modifiedStart + 1 : c.modifiedStart;
    rows.push(
      c.modifiedEnd - c.modifiedStart > 1
        ? `@@ lines ${at}-${c.modifiedEnd} @@`
        : c.modifiedEnd > c.modifiedStart
          ? `@@ line ${at} @@`
          : `@@ removed after line ${at} @@`,
    );
    for (let i = c.originalStart; i < c.originalEnd; i++) rows.push(`-${strip(a[i] ?? "")}`);
    for (let i = c.modifiedStart; i < c.modifiedEnd; i++) rows.push(`+${strip(b[i] ?? "")}`);
  }
  // Only line endings or the last newline changed: nothing a line diff shows.
  if (!rows.length)
    return {
      note: `${name} changed since you last read it (whitespace or line endings only).`,
      shown: true,
    };
  const body = rows.join("\n");
  if (body.length > MAX_NOTE_CHARS || rows.length > MAX_NOTE_LINES)
    return tooLarge(`+${added} −${removed} lines, too many to show`);
  return {
    note: `${name} changed since you last read it (by the user, a formatter or a command). The changes (- before, + now; line numbers as it is now):\n${body}`,
    shown: true,
  };
}

/**
 * The notes of several files in one message, capped at `cap` characters; `included`: how many
 * notes it holds whole (the rest are only counted).
 */
export function changeNotesText(
  notes: readonly string[],
  cap = 6000,
): { text: string; included: number } | null {
  if (!notes.length) return null;
  const out: string[] = [];
  let size = 0;
  for (const [i, n] of notes.entries()) {
    if (out.length && size + n.length > cap) {
      out.push(
        `… ${notes.length - i} more files changed since you read them: read them again before editing them.`,
      );
      return { text: out.join("\n\n"), included: i };
    }
    out.push(n);
    size += n.length;
  }
  return { text: out.join("\n\n"), included: notes.length };
}
