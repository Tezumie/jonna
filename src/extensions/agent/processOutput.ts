// The output of a command the agent runs in the background (Claude Code's BashOutput): kept in a
// bounded buffer, read in pieces — each read gets what arrived since the last one, optionally
// only the lines matching a pattern — with what had to be dropped counted, not lost silently.
// DOM-free and tested.

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-_]`,
  "g",
);

/** Most kept per process: older output goes (and is counted). */
export const BUFFER_LIMIT = 1_000_000;
/** Most one read returns: the rest stays for the next read. */
export const READ_LIMIT = 30_000;

export interface OutputRead {
  /** The new output (whole lines where it could), or the matching lines with `filter`. */
  text: string;
  /** Characters that arrived since the last read but were dropped from the buffer first. */
  dropped: number;
  /** More is waiting (the read hit its limit). */
  more: boolean;
  /** With a filter: lines looked at and lines that matched. */
  lines?: { seen: number; matched: number };
}

/** Escape sequences out, `\r\n` → `\n`, and a progress bar's redraws (`\r`) down to their last. */
export function cleanOutput(text: string): string {
  return text
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line.includes("\r") ? (line.split("\r").filter(Boolean).pop() ?? "") : line))
    .join("\n");
}

/** Longest pattern taken as a regular expression; longer ones match as plain text. */
const PATTERN_LIMIT = 200;
/** Only the start of a line is matched, so a huge minified line can't take long. */
export const FILTER_LINE_LIMIT = 2000;
/**
 * Patterns that can backtrack for ages on the webview's thread (`(\w+\s?)+`, `(a|a)*`, `\1`):
 * a quantified group with a quantifier or an alternation inside, or a backreference.
 */
const RISKY = /\((?:[^()\\]|\\.)*(?:[+*}]|\|)(?:[^()\\]|\\.)*\)\s*[+*{]|\\[1-9]|\\k</;

const plain = (pattern: string) =>
  new RegExp(pattern.slice(0, PATTERN_LIMIT).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

/**
 * A filter from the model's input: a regular expression, or plain text when it isn't one, is too
 * long, or could backtrack badly (it runs on the UI thread, D201).
 */
export function outputFilter(pattern: string | undefined): RegExp | null {
  if (!pattern) return null;
  if (pattern.length > PATTERN_LIMIT || RISKY.test(pattern)) return plain(pattern);
  try {
    return new RegExp(pattern, "i");
  } catch {
    return plain(pattern);
  }
}

export class OutputBuffer {
  /** Kept output (cleaned), starting at `start` in the whole stream. */
  private text = "";
  private start = 0;
  /** Where the next read begins, in the whole stream. */
  private cursor = 0;
  /** A partial line (or escape sequence) waiting for the rest. */
  private carry = "";

  constructor(private readonly limit = BUFFER_LIMIT) {}

  /** Characters received in all (after cleaning). */
  get total(): number {
    return this.start + this.text.length;
  }

  /** Characters not read yet (a partial line waiting for its end included). */
  get unread(): number {
    return this.total - Math.max(this.cursor, this.start) + this.carry.length;
  }

  append(chunk: string): void {
    // Cleaned by whole lines, so an escape sequence or a \r split across chunks is handled.
    const joined = this.carry + chunk;
    const cut = joined.lastIndexOf("\n");
    if (cut < 0) {
      // A line this long without a newline is taken as it is.
      if (joined.length > 4096) {
        this.carry = "";
        this.push(cleanOutput(joined));
      } else this.carry = joined;
      return;
    }
    this.carry = joined.slice(cut + 1);
    this.push(cleanOutput(joined.slice(0, cut + 1)));
  }

  /** The process ended (or a read wants it): what waited for a newline counts too. */
  end(): void {
    if (this.carry) this.push(cleanOutput(this.carry));
    this.carry = "";
  }

  /** Keeps at most the last `max` characters (an ended command's output, read less often). */
  shrink(max: number): void {
    if (this.text.length <= max) return;
    const drop = this.text.length - max;
    this.text = this.text.slice(drop);
    this.start += drop;
  }

  private push(text: string): void {
    this.text += text;
    if (this.text.length > this.limit) {
      const drop = this.text.length - Math.floor(this.limit * 0.8);
      this.text = this.text.slice(drop);
      this.start += drop;
    }
  }

  /** The output since the last read (and moves past it); `filter` keeps the matching lines. */
  read(filter: RegExp | null = null, limit = READ_LIMIT): OutputRead {
    // A prompt or a progress line without its newline yet is output too.
    this.end();
    const dropped = Math.max(0, this.start - this.cursor);
    const from = Math.max(this.cursor, this.start);
    const available = this.text.slice(from - this.start);
    if (!filter) {
      let piece = available;
      let more = false;
      if (piece.length > limit) {
        // Up to the last line break that fits, so the next read starts on a line.
        const nl = piece.lastIndexOf("\n", limit);
        piece = piece.slice(0, nl > limit / 2 ? nl + 1 : limit);
        more = true;
      }
      this.cursor = from + piece.length;
      return { text: piece, dropped, more };
    }
    // Filtered: whole lines only; a last line without its newline waits for the next read.
    const end = available.lastIndexOf("\n") + 1;
    const lines = available.slice(0, end).split("\n");
    lines.pop();
    const matched: string[] = [];
    let size = 0;
    let used = 0;
    let more = false;
    for (const line of lines) {
      if (filter.test(line.length > FILTER_LINE_LIMIT ? line.slice(0, FILTER_LINE_LIMIT) : line)) {
        if (size + line.length + 1 > limit && matched.length) {
          more = true;
          break;
        }
        matched.push(line);
        size += line.length + 1;
      }
      used += line.length + 1;
    }
    this.cursor = from + used;
    return {
      text: matched.length ? `${matched.join("\n")}\n` : "",
      dropped,
      more,
      lines: { seen: lines.length, matched: matched.length },
    };
  }

  /** The last `chars` of the output (for the user; the read position doesn't move). */
  tail(chars: number): string {
    if (chars <= 0) return "";
    const all = this.text + cleanOutput(this.carry);
    return all.length > chars ? all.slice(-chars) : all;
  }
}
