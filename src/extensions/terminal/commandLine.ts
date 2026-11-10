// Pure helpers for command marks (DOM-free, tested).

/** Rows searched on each side of the mark. */
const NEAR = 3;

/**
 * Where a command's line really is (D211, D217). On Windows, ConPTY redraws lines and can leave a
 * mark a row or two off the command: on a blank row next to the prompt, or below it on a row the
 * command's own output fills later (`npm run dev` prints a blank line, then `> app@1.0 dev`). The
 * dot then sat beside the wrong row and the sticky line showed only the command text.
 *
 * - The marked row holds the command: it's right; so is a marked row with text and the command
 *   on the next one (a prompt that spans two lines keeps its dot on the first).
 * - The command is on a row just above: that's it (a prompt's mark never comes after its
 *   command line).
 * - The marked row is blank and the command is just below: that's it.
 * - Otherwise the mark is trusted (a prompt that spans two lines keeps its dot on the first).
 */
export function correctedCommandLine(
  text: (y: number) => string | undefined,
  line: number,
  command: string,
): number {
  if (line < 0) return line;
  const head = command.trim().split("\n")[0]?.trim().slice(0, 40) ?? "";
  if (!head) return line;
  const here = text(line) ?? "";
  if (here.includes(head)) return line;
  // A two-line prompt: its first line marked, the command on the next one.
  if (here.trim() && text(line + 1)?.includes(head)) return line;
  for (let d = 1; d <= NEAR; d++) {
    const y = line - d;
    if (y >= 0 && text(y)?.includes(head)) return y;
  }
  if (here.trim()) return line;
  for (let d = 1; d <= NEAR; d++) if (text(line + d)?.includes(head)) return line + d;
  return line;
}

/**
 * Whether the sticky line shows a command (VS Code's terminal sticky scroll): its line is above
 * the top of the screen and its output is still on screen — a command that's still running too,
 * scrolled to the bottom (a dev server's log), unless a full-screen program owns the screen (the
 * alternate buffer: vim, less, htop).
 */
export function stickyApplies(o: {
  /** The command's line (-1: trimmed off the scrollback, its output still there). */
  line: number;
  /** The first row on screen. */
  top: number;
  /** The output's end (the next prompt's line), or undefined while it runs. */
  end: number | undefined;
  alternateBuffer: boolean;
}): boolean {
  if (o.alternateBuffer) return false;
  return o.line < o.top && (o.end === undefined || o.end > o.top);
}

/**
 * Text typed into a terminal as VS Code's `sendText` types it (D261): each line break is Enter
 * (`\r`; a bare `\n` isn't one to PowerShell or cmd), and with `addNewLine` one more Enter unless
 * the text already ends with one.
 */
export function typedText(text: string, addNewLine: boolean): string {
  const lines = text.replace(/\r?\n/g, "\r");
  return addNewLine && !lines.endsWith("\r") ? `${lines}\r` : lines;
}
