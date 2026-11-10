// The whole output of a foreground run_command whose result was cut (D311, after Claude Code's
// saved tool results): kept per chat in memory with an id ("out1"), read back by line with
// process_output (offset / limit / filter). DOM-free.

/** Outputs a chat keeps (the oldest goes first). */
const PER_CHAT = 5;
/** Characters kept over every chat (the oldest outputs go first). */
const TOTAL_CHARS = 16_000_000;
/** Lines one read returns by default, and at most. */
export const SAVED_READ_LINES = 300;
const MAX_READ_LINES = 2000;
/** Characters one read returns at most (cut at a line). */
const READ_CHARS = 30_000;

export interface SavedOutput {
  id: string;
  chat: string;
  command: string;
  text: string;
  /** Characters the run printed before what's kept (a run past the keeping limit). */
  dropped: number;
}

export class SavedOutputs {
  private readonly list: SavedOutput[] = [];
  private next = 1;

  /** Keeps `text` for chat `chat`; returns its id. */
  save(chat: string, command: string, text: string, dropped = 0): string {
    const id = `out${this.next++}`;
    this.list.push({ id, chat, command, text, dropped });
    const mine = this.list.filter((o) => o.chat === chat);
    for (const old of mine.slice(0, Math.max(0, mine.length - PER_CHAT))) this.remove(old);
    let total = this.list.reduce((n, o) => n + o.text.length, 0);
    while (total > TOTAL_CHARS && this.list.length > 1) {
      const old = this.list[0] as SavedOutput;
      total -= old.text.length;
      this.remove(old);
    }
    return id;
  }

  private remove(o: SavedOutput): void {
    const i = this.list.indexOf(o);
    if (i >= 0) this.list.splice(i, 1);
  }

  get(chat: string, id: string): SavedOutput | undefined {
    return this.list.find((o) => o.chat === chat && o.id === id);
  }

  ids(chat: string): string[] {
    return this.list.filter((o) => o.chat === chat).map((o) => o.id);
  }

  /** A chat's outputs go (the chat was deleted). */
  forget(chat: string): void {
    for (const o of this.list.filter((x) => x.chat === chat)) this.remove(o);
  }
}

/**
 * Lines of a saved output with their numbers: from `offset` (1-based), `limit` of them; with
 * `filter`, only the lines it matches (offset / limit then count those).
 */
export function readSaved(
  o: SavedOutput,
  args: { offset?: unknown; limit?: unknown },
  filter: RegExp | null,
): string {
  const all = o.text.split(/\r?\n/);
  if (all.length > 1 && all[all.length - 1] === "") all.pop();
  const numbered = all
    .map((text, i) => ({ n: i + 1, text }))
    .filter((l) => {
      if (!filter) return true;
      filter.lastIndex = 0;
      return filter.test(l.text);
    });
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
  const offset = num(args.offset, 1);
  const limit = Math.min(MAX_READ_LINES, num(args.limit, SAVED_READ_LINES));
  const head = `${o.id}: the whole output of \`${o.command}\` (${all.length} lines${o.dropped ? `; its first ${o.dropped} characters weren't kept` : ""})${filter ? `, ${numbered.length} lines match the filter` : ""}`;
  if (!numbered.length) return `${head}\n(no matching lines)`;
  if (offset > numbered.length)
    return `${head}\noffset ${offset} is past the end (${numbered.length} ${filter ? "matching " : ""}lines).`;
  const out: string[] = [];
  let chars = 0;
  for (const l of numbered.slice(offset - 1, offset - 1 + limit)) {
    const row = `${String(l.n).padStart(6)}| ${l.text.length > 2000 ? `${l.text.slice(0, 2000)}…` : l.text}`;
    if (out.length && chars + row.length > READ_CHARS) break;
    out.push(row);
    chars += row.length + 1;
  }
  const next = offset + out.length;
  const more =
    next <= numbered.length
      ? `\n… ${numbered.length - next + 1} more ${filter ? "matching " : ""}lines (offset ${next})`
      : "";
  return `${head}\n${out.join("\n")}${more}`;
}

/** Every chat's saved outputs (one store per window). */
export const savedOutputs = new SavedOutputs();
