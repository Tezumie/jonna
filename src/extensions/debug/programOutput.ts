// A Node program's own output in the debug console (VS Code's `"console": "internalConsole"` and
// `"outputCapture": "std"`): the program runs with pipes (programProcess.ts), and what it prints
// is copied, line by line and per stream (stderr shown as such), to the debug console — escape
// sequences out, carriage-return redraws resolved, and Node's own inspector messages ("Debugger
// listening on …", "Debugger attached.") left out, as VS Code's debugger does. A line printed
// without its end (a prompt, "Loading…") shows after PARTIAL_LINE_DELAY, and what follows
// continues it: the console joins output to an unfinished line (consoleSessions.ts), applying
// carriage returns to it. DOM-free and tested.
import { stripEscapes } from "../tasks/problemMatchers";
import type { LaunchConfig } from "./launch";

/** The program's output goes to the debug console (Node launch configurations). */
export function capturesOutput(config: LaunchConfig): boolean {
  return config.console === "internalConsole" || config.raw.outputCapture === "std";
}

const INSPECTOR_LINES = [
  /^Debugger listening on wss?:\/\//,
  /^For help,? see:? https:\/\/nodejs\.org\/(en\/)?docs\/inspector/,
  /^Debugger attached\.?$/,
  /^Debugger ending on wss?:\/\//,
  /^Waiting for the debugger to disconnect\.*$/,
];

/** A line kept until its end this long, at most: past it, it's let out as it is. */
const MAX_PENDING = 16_384;

/** What a line shows once a terminal drew it: the text after its last carriage return. */
export function drawn(line: string): string {
  if (!line.includes("\r")) return line;
  let out = "";
  for (const part of line.split("\r")) out = part + out.slice(part.length);
  return out;
}

/** How long an unfinished line waits for its end before it shows (VS Code shows it at once). */
export const PARTIAL_LINE_DELAY = 100;

export class ProgramOutput {
  private pending = "";
  /**
   * An unfinished line was let out (flush): what follows continues it in the console, so its
   * carriage returns are kept for the console to apply to the line shown ("10%" then "\r50%").
   */
  private open = false;

  /** A chunk of the terminal's output: the complete lines in it (null: none yet). */
  feed(chunk: string): string | null {
    this.pending += chunk;
    const end = this.pending.lastIndexOf("\n");
    if (end < 0) {
      if (this.pending.length <= MAX_PENDING) return null;
      return this.flush();
    }
    // With its line break: a carriage return held back by a flush pairs with it.
    const complete = this.pending
      .slice(0, end + 1)
      .replace(/\r+\n/g, "\n")
      .slice(0, -1);
    this.pending = this.pending.slice(end + 1);
    return this.lines(complete);
  }

  /**
   * The unfinished line (a prompt, the end of the output), if there is one, without a line break
   * of its own: the console appends text, so "Loading…" then " done" stay one line.
   */
  flush(final = false): string | null {
    let rest = this.pending;
    this.pending = "";
    if (!final) {
      // Kept for what comes next: a carriage return ending the text (the next text redraws the
      // line from its start, "10%\r" then "20%") and an escape sequence cut at the read's edge
      // (its tail would show as text, "32m").
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
      const held = /(?:\x1b(?:\[[0-?]*[ -/]*)?|\r+)$/.exec(rest)?.[0] ?? "";
      this.pending = held;
      rest = rest.slice(0, rest.length - held.length);
    }
    return rest ? this.lines(rest, false) : null;
  }

  private lines(text: string, ended = true): string | null {
    const continues = this.open;
    const kept = stripEscapes(text.replace(/\r+\n/g, "\n"))
      .split("\n")
      .map((l, i) => (i === 0 && continues ? l : drawn(l)))
      .filter((l) => !INSPECTOR_LINES.some((re) => re.test(drawn(l).trim())));
    this.open = !ended && kept.length > 0;
    return kept.length ? `${kept.join("\n")}${ended ? "\n" : ""}` : null;
  }
}

/**
 * Copies a program's output to `emit` as debug console text until it exits: per stream, escape
 * sequences out, carriage-return redraws resolved, Node's inspector lines left out
 * (ProgramOutput). An unfinished line shows within PARTIAL_LINE_DELAY.
 */
export function captureProgramOutput(
  output: (listener: (text: string, stderr: boolean) => void) => { dispose(): void },
  exited: Promise<number>,
  emit: (text: string, stderr: boolean) => void,
): void {
  const streams = { out: new ProgramOutput(), err: new ProgramOutput() };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = (text: string | null, stderr: boolean) => {
    if (text) emit(text, stderr);
  };
  const flush = () => {
    send(streams.out.flush(), false);
    send(streams.err.flush(), true);
  };
  const sub = output((chunk, stderr) => {
    send((stderr ? streams.err : streams.out).feed(chunk), stderr);
    // Not pushed back by more output: a program that keeps printing still shows its prompt (a
    // line cut this way is joined again by the console).
    timer ??= setTimeout(() => {
      timer = undefined;
      flush();
    }, PARTIAL_LINE_DELAY);
  });
  void exited.then(() => {
    clearTimeout(timer);
    sub.dispose();
    send(streams.out.flush(true), false);
    send(streams.err.flush(true), true);
  });
}
