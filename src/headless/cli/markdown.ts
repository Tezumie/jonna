// Markdown lightly styled for a terminal, as it streams: an answer arrives in pieces, and each
// piece is printed at once (no redrawing, so it works in every console). Block marks are decided
// at the start of a line (a heading, a list item, a quote, a code fence), inline marks (bold,
// italic, code, links) as they open and close. A few characters are held back while what they
// are can't be told yet (a `*` that may become `**`, a link not closed yet); `end()` prints
// whatever is held. Without colour the text passes through as it is: Markdown reads fine plain.
// Wrapping is left to the terminal, so narrow windows need nothing special. Pure.
import { ESC, type Style, sanitize } from "./style";

const BOLD_ON = `${ESC}[1m`;
const BOLD_OFF = `${ESC}[22m`;
const ITALIC_ON = `${ESC}[3m`;
const ITALIC_OFF = `${ESC}[23m`;
const UNDERLINE_ON = `${ESC}[4m`;
const UNDERLINE_OFF = `${ESC}[24m`;
const CODE_ON = `${ESC}[36m`;
const CODE_OFF = `${ESC}[39m`;
const RESET = `${ESC}[0m`;

/** The longest a link may be held back before it is printed as plain text. */
const MAX_HELD_LINK = 400;

const isWord = (ch: string | undefined): boolean => !!ch && /[\p{L}\p{N}]/u.test(ch);
const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

export class MarkdownStream {
  /** Text not printed yet: a line's start not decided, or an inline mark not complete. */
  private held = "";
  /** At the start of a line: its block isn't decided yet. */
  private lineStart = true;
  private inFence = false;
  /** The fence's own mark (``` or ~~~), to know its end. */
  private fence = "";
  private bold = false;
  private italic: "" | "*" | "_" = "";
  private code = false;
  /** A style the line's block opened (a heading's): closed at the line's end. */
  private lineStyled = false;
  /** The last character printed on this line (for word boundaries). */
  private previous: string | undefined;

  constructor(private readonly style: Style) {}

  /** More of the text: what to print now. */
  write(delta: string): string {
    const clean = sanitize(delta);
    if (!this.style.color) return clean;
    const text = this.held + clean;
    this.held = "";
    return this.run(text, false);
  }

  /** The text has ended: what was held, and every style closed. A new text may follow. */
  end(): string {
    if (!this.style.color) return "";
    const text = this.held;
    this.held = "";
    let out = this.run(text, true);
    if (this.bold || this.italic || this.code || this.lineStyled) out += RESET;
    this.bold = false;
    this.italic = "";
    this.code = false;
    this.lineStyled = false;
    this.lineStart = true;
    this.inFence = false;
    this.previous = undefined;
    return out;
  }

  private run(text: string, final: boolean): string {
    let out = "";
    let i = 0;
    while (i < text.length) {
      if (this.lineStart) {
        const newline = text.indexOf("\n", i);
        const line = newline < 0 ? text.slice(i) : text.slice(i, newline);
        if (newline < 0 && !final && this.undecided(line)) {
          this.held = text.slice(i);
          return out;
        }
        const consumed = this.startLine(line, newline >= 0 || final);
        out += consumed.out;
        i += consumed.length;
        if (consumed.whole) {
          if (newline >= 0) {
            out += "\n";
            i = newline + 1;
          } else i = text.length;
          continue;
        }
        this.lineStart = false;
        continue;
      }
      const ch = text[i] as string;
      if (ch === "\n") {
        out += this.endLine();
        out += "\n";
        i++;
        continue;
      }
      if (this.inFence) {
        // The rest of a code line, as it is.
        const newline = text.indexOf("\n", i);
        const end = newline < 0 ? text.length : newline;
        out += text.slice(i, end);
        i = end;
        continue;
      }
      const next = text[i + 1];
      const atEnd = i + 1 >= text.length;
      if (this.code) {
        if (ch === "`") {
          this.code = false;
          out += CODE_OFF;
        } else out += ch;
        this.previous = ch;
        i++;
        continue;
      }
      if (ch === "\\") {
        if (atEnd && !final) {
          this.held = text.slice(i);
          return out;
        }
        if (next !== undefined && /[\\`*_{}[\]()#+\-.!|>~]/.test(next)) {
          out += next;
          this.previous = next;
          i += 2;
        } else {
          out += ch;
          this.previous = ch;
          i++;
        }
        continue;
      }
      if (ch === "`") {
        this.code = true;
        out += CODE_ON;
        this.previous = ch;
        i++;
        continue;
      }
      if (ch === "*" || ch === "_") {
        if (atEnd && !final) {
          this.held = text.slice(i);
          return out;
        }
        if (next === ch) {
          // "**" or "__": bold, unless it stands alone between spaces.
          const after = text[i + 2];
          if (i + 2 >= text.length && !final) {
            this.held = text.slice(i);
            return out;
          }
          const opens = !this.bold && !isSpace(after) && !(ch === "_" && isWord(this.previous));
          const closes = this.bold && !isSpace(this.previous);
          if (opens || closes) {
            this.bold = !this.bold;
            out += this.bold ? BOLD_ON : BOLD_OFF;
            i += 2;
            continue;
          }
          out += ch + ch;
          this.previous = ch;
          i += 2;
          continue;
        }
        const closes =
          this.italic === ch && !isSpace(this.previous) && !(ch === "_" && isWord(next));
        const opens =
          !this.italic &&
          !isSpace(next) &&
          (ch === "*" ? !isWord(this.previous) || isSpace(this.previous) : !isWord(this.previous));
        if (closes) {
          this.italic = "";
          out += ITALIC_OFF;
        } else if (opens) {
          this.italic = ch;
          out += ITALIC_ON;
        } else {
          out += ch;
          this.previous = ch;
        }
        i++;
        continue;
      }
      if (ch === "[") {
        const newline = text.indexOf("\n", i);
        const end = newline < 0 ? text.length : newline;
        const rest = text.slice(i, end);
        const link = /^\[([^\]\n]*)\]\(([^)\s]*)\)/.exec(rest);
        if (link) {
          const [whole, label = "", url = ""] = link;
          out +=
            label && label !== url
              ? `${UNDERLINE_ON}${label}${UNDERLINE_OFF} ${this.style.dim(`(${url})`)}`
              : `${UNDERLINE_ON}${url}${UNDERLINE_OFF}`;
          this.previous = ")";
          i += whole.length;
          continue;
        }
        // Not closed yet, and it still may be: wait for the rest (not for ever).
        const mayBe = /^\[[^\]\n]*(\]\(?[^)\s]*)?$/.test(rest) && !/^\[[^\]\n]*\][^(]/.test(rest);
        if (newline < 0 && !final && mayBe && rest.length < MAX_HELD_LINK) {
          this.held = text.slice(i);
          return out;
        }
      }
      out += ch;
      this.previous = ch;
      i++;
    }
    return out;
  }

  /** A line's start that may still become a block mark (or a fence's end): wait for more. */
  private undecided(line: string): boolean {
    const rest = line.replace(/^[ \t]*/, "");
    // In a fence: the start of its closing mark, or the mark itself until the line ends.
    if (this.inFence)
      return (
        this.fence.startsWith(rest) ||
        (rest.startsWith(this.fence) && rest.slice(this.fence.length).trim() === "")
      );
    if (rest === "") return line.length < 8;
    // A fence's first line (its language) and a rule are short: taken whole.
    if (/^(`{3,}|~{3,})[^\n]*$/.test(rest) && rest.length < 40) return true;
    if (/^([-*_][ \t]*){1,}$/.test(rest) && rest.length < 40) return true;
    return /^(#{1,6}|`{1,2}|~{1,2}|[-+*]|\d{1,3}[.)]?|>|\|)$/.test(rest);
  }

  /**
   * Starts a line. `whole`: the line was printed in full (a fence mark, a rule, an empty line);
   * else `length` characters of it were consumed as its block mark and the rest follows inline.
   */
  private startLine(
    line: string,
    complete: boolean,
  ): { out: string; length: number; whole: boolean } {
    this.previous = undefined;
    const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
    const rest = line.slice(indent.length);
    const gutter = this.style.dim(this.style.glyph("│ ", "| "));
    if (this.inFence) {
      if (complete && rest.startsWith(this.fence) && rest.slice(this.fence.length).trim() === "") {
        this.inFence = false;
        return { out: "", length: line.length, whole: true };
      }
      return { out: gutter, length: 0, whole: false };
    }
    const fence = /^(`{3,}|~{3,})(.*)$/.exec(rest);
    if (fence && complete) {
      this.inFence = true;
      this.fence = (fence[1] ?? "```").slice(0, 3);
      const language = (fence[2] ?? "").trim();
      return {
        out: language ? this.style.dim(`${this.style.glyph("┌ ", "+ ")}${language}`) : "",
        length: line.length,
        whole: true,
      };
    }
    if (
      complete &&
      /^([-*_][ \t]*){3,}$/.test(rest) &&
      /^(-+|\*+|_+)$/.test(rest.replace(/\s/g, ""))
    )
      return {
        out: this.style.dim(this.style.glyph("─", "-").repeat(24)),
        length: line.length,
        whole: true,
      };
    if (complete && rest === "") return { out: "", length: line.length, whole: true };
    const heading = /^(#{1,6})[ \t]+/.exec(rest);
    if (heading) {
      this.lineStyled = true;
      const level = (heading[1] ?? "#").length;
      return {
        out: indent + BOLD_ON + (level === 1 ? UNDERLINE_ON : ""),
        length: indent.length + heading[0].length,
        whole: false,
      };
    }
    const bullet = /^[-+*][ \t]+/.exec(rest);
    if (bullet) {
      const task = /^\[([ xX])\][ \t]+/.exec(rest.slice(bullet[0].length));
      const mark = task
        ? task[1] === " "
          ? this.style.glyph("☐ ", "[ ] ")
          : this.style.glyph("☑ ", "[x] ")
        : this.style.glyph("• ", "- ");
      return {
        out: indent + mark,
        length: indent.length + bullet[0].length + (task ? task[0].length : 0),
        whole: false,
      };
    }
    const quote = /^>[ \t]?/.exec(rest);
    if (quote)
      return { out: indent + gutter, length: indent.length + quote[0].length, whole: false };
    return { out: "", length: 0, whole: false };
  }

  /** Closes what a line's end closes: its block style and any inline style left open. */
  private endLine(): string {
    let out = "";
    if (!this.inFence && (this.bold || this.italic || this.code || this.lineStyled)) out = RESET;
    if (!this.inFence) {
      this.bold = false;
      this.italic = "";
      this.code = false;
    }
    this.lineStyled = false;
    this.lineStart = true;
    return out;
  }
}

/** A whole Markdown text, styled. */
export function renderMarkdown(text: string, style: Style): string {
  const stream = new MarkdownStream(style);
  return stream.write(text) + stream.end();
}
