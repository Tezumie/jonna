// A command's output in a terminal with shell integration, for an extension's
// TerminalShellExecution.read() (VS Code's): what the terminal printed between the command's
// "executed" mark (OSC 633;C, or 133;C) and its "finished" one (633;D / 133;D), escape codes
// included, shell-integration sequences left out. The terminal's output arrives in chunks before
// the renderer parses the marks (and fires the command's start), so recent output is kept until
// the start and cut at the mark. DOM-free and unit-tested.

/** The "executed" mark: the command's output starts after it. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what's matched
const EXECUTED = /\x1b\](?:633|133);C(?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/g;
/** The "finished" mark: the output ends before it. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what's matched
const FINISHED = /\x1b\](?:633|133);D(?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/;
/** Shell integration's own sequences (prompt marks, the command line, properties). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what's removed
const INTEGRATION = /\x1b\](?:633|133);[^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Output kept while waiting for a command's start. */
const MAX_PENDING = 64 * 1024;
/** One command's output kept for a reader that comes late (per terminal and extension). */
export const MAX_COMMAND_OUTPUT = 256 * 1024;

export class CommandOutputCapture {
  /** Output since the last command ended (where the next one's start mark is). */
  private pending: string[] = [];
  private pendingLength = 0;
  /** A command is running: its output is kept (and sent while someone reads). */
  private running = false;
  /** The running command's output so far. */
  private output = "";
  private reading = false;

  /** `emit`: output of the running command, while it is being read. */
  constructor(private readonly emit: (text: string) => void) {}

  /** Output as the terminal received it. */
  write(text: string): void {
    if (!text) return;
    if (!this.running) {
      this.keep(text);
      return;
    }
    const end = FINISHED.exec(text);
    const part = end ? text.slice(0, end.index) : text;
    this.add(part);
    if (end) {
      // Its end is in this chunk: what follows belongs to the next prompt.
      this.running = false;
      this.reading = false;
      this.keep(text.slice(end.index));
    }
  }

  /** Recent output while no command runs (chunks, the oldest dropped past MAX_PENDING). */
  private keep(text: string): void {
    this.pending.push(text);
    this.pendingLength += text.length;
    while (this.pendingLength > MAX_PENDING && this.pending.length > 1)
      this.pendingLength -= this.pending.shift()?.length ?? 0;
  }

  /** The renderer saw a command start: its output is what came after the "executed" mark. */
  started(): void {
    const recent = this.pending.join("");
    this.pending = [];
    this.pendingLength = 0;
    let after = -1;
    for (const m of recent.matchAll(EXECUTED)) after = m.index + m[0].length;
    const early = after >= 0 ? recent.slice(after) : "";
    this.running = true;
    this.reading = false;
    this.output = "";
    const end = FINISHED.exec(early);
    if (end) {
      // Fast enough to have ended in the same chunk.
      this.add(early.slice(0, end.index));
      this.running = false;
      this.keep(early.slice(end.index));
      return;
    }
    this.add(early);
  }

  /** The command finished (the renderer saw its end). */
  ended(): void {
    this.running = false;
    this.reading = false;
  }

  /**
   * An extension reads the running command's output: what it printed so far, then the rest as it
   * comes (until it ends). Null: no command is running.
   */
  read(): string | null {
    if (!this.running && !this.output) return null;
    this.reading = this.running;
    return this.output;
  }

  private add(raw: string): void {
    const text = raw.replace(INTEGRATION, "");
    if (!text) return;
    if (this.output.length < MAX_COMMAND_OUTPUT)
      this.output += text.slice(0, MAX_COMMAND_OUTPUT - this.output.length);
    if (this.reading) this.emit(text);
  }
}
