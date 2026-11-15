// Colour and glyphs for a terminal: whether to use them at all (NO_COLOR, FORCE_COLOR, a
// terminal or not), and the few styles the renderers need as ANSI escapes. Pure: the caller says
// what the stream and the environment are.

export interface StyleEnvironment {
  /** The stream is a terminal. */
  isTTY: boolean;
  env: Readonly<Record<string, string | undefined>>;
  platform: string;
  /** `--color` / `--no-color`. */
  flag?: boolean;
}

/**
 * Colour is on when: `--color`; else not with `--no-color`, NO_COLOR (any non-empty value) or a
 * dumb terminal; FORCE_COLOR (anything but 0 or false) turns it on without a terminal; else
 * only on a terminal.
 */
export function colorEnabled(e: StyleEnvironment): boolean {
  if (e.flag !== undefined) return e.flag;
  if (e.env.NO_COLOR) return false;
  const force = e.env.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force.toLowerCase() !== "false";
  if (e.env.TERM === "dumb") return false;
  return e.isTTY;
}

/**
 * Whether the terminal draws characters beyond ASCII well. The legacy Windows console with a
 * raster font doesn't: there, only Windows Terminal, the VS Code family's terminals and ConEmu
 * are trusted. Elsewhere: a UTF-8 locale.
 */
export function unicodeEnabled(e: StyleEnvironment): boolean {
  if (!e.isTTY) return true; // a file or a pipe: UTF-8 bytes, read by whatever comes next
  if (e.platform === "win32")
    return Boolean(e.env.WT_SESSION || e.env.TERM_PROGRAM || e.env.ConEmuANSI || e.env.TERM);
  if (e.env.TERM === "linux") return false; // the kernel console
  const locale = e.env.LC_ALL || e.env.LC_CTYPE || e.env.LANG || "";
  return /utf-?8/i.test(locale) || locale === "";
}

export interface Style {
  readonly color: boolean;
  readonly unicode: boolean;
  bold(text: string): string;
  dim(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
  /** A glyph, or its ASCII stand-in where the terminal can't draw it. */
  glyph(unicode: string, ascii: string): string;
}

export const ESC = "\x1b";

const wrap = (on: boolean, open: number, close: number) => (text: string) =>
  on && text ? `${ESC}[${open}m${text}${ESC}[${close}m` : text;

export function makeStyle(color: boolean, unicode: boolean): Style {
  return {
    color,
    unicode,
    bold: wrap(color, 1, 22),
    dim: wrap(color, 2, 22),
    italic: wrap(color, 3, 23),
    underline: wrap(color, 4, 24),
    red: wrap(color, 31, 39),
    green: wrap(color, 32, 39),
    yellow: wrap(color, 33, 39),
    cyan: wrap(color, 36, 39),
    glyph: (u, a) => (unicode ? u : a),
  };
}

export const PLAIN: Style = makeStyle(false, false);

/** `text` without ANSI escapes (for measuring, and for output that must be plain). */
export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is the point
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

/**
 * Text from the model, a tool or a file made safe to print: control characters that move the
 * cursor, clear the screen or set the title are dropped (escape sequences whole); tabs and
 * newlines stay.
 */
export function sanitize(text: string): string {
  return (
    stripAnsi(text)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x9b]/g, "")
      .replace(/\r\n?/g, "\n")
  );
}

/** One line, cut to `width` columns with an ellipsis (code points, not bytes). */
export function clip(text: string, width: number, unicode = true): string {
  const line = text.replace(/\s+/g, " ").trim();
  const points = [...line];
  if (points.length <= width) return line;
  const mark = unicode ? "…" : "...";
  return points.slice(0, Math.max(0, width - mark.length)).join("") + mark;
}
