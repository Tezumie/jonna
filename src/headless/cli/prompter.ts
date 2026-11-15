// Node only. One place that reads what a person types and writes what they see, built on
// Node's `readline` (line editing and history on a terminal; plain lines on a pipe): the
// session's prompt, questions asked in between (a permission, a password), Ctrl+C, and output
// that arrives while a prompt is on screen (the prompt is taken away, the text printed, the
// prompt put back). No terminal library.
import { createInterface, type Interface } from "node:readline";
import { Transform, Writable } from "node:stream";

export interface PrompterStreams {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  /** Where prompts, echo and the session's text go. */
  output: NodeJS.WritableStream & { isTTY?: boolean; columns?: number };
}

interface Waiting {
  prompt: string;
  secret: boolean;
  resolve(line: string | null): void;
}

/** Lines entered at a terminal within this many milliseconds of each other are one paste. */
const PASTE_MS = 25;

/** Ctrl+C typed into a pipe arrives as this byte (a terminal turns it into a signal or a key). */
const ETX = 0x03;

export class Prompter {
  private readonly rl: Interface;
  private readonly out: PrompterStreams["output"];
  readonly isTTY: boolean;
  /** Lines typed (or piped) that nobody has read yet. */
  private readonly buffer: string[] = [];
  /** Questions waiting their turn; the first is the one on screen. */
  private readonly asks: Waiting[] = [];
  /** The session's own prompt, waiting for a line. */
  private reader: Waiting | null = null;
  /** What is on screen now: a question, the session's prompt, or nothing. */
  private shown: Waiting | null = null;
  private muted = false;
  private ended = false;
  /**
   * Lines entered at the session's prompt that arrived together (a paste of several lines):
   * they are one message, sent once no more of it is left on the line.
   */
  private pasted: string[] = [];
  private pasteTimer: ReturnType<typeof setTimeout> | undefined;
  /** The output's last character was a newline (or nothing was written yet). */
  private atLineStart = true;
  /** Ctrl+C (a key at a terminal, a signal, or the byte on a pipe). */
  onInterrupt: () => void = () => {};
  /** Input ended (Ctrl+D, the pipe closed). */
  onEnd: () => void = () => {};
  /** The output can't be written to any more (a closed pipe). */
  onBrokenOutput: () => void = () => {};

  constructor(streams: PrompterStreams, history: readonly string[] = []) {
    this.out = streams.output;
    this.isTTY = streams.input.isTTY === true && streams.output.isTTY === true;
    this.out.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") this.onBrokenOutput();
    });
    // What readline writes (the prompt, the echo of what is typed) goes through here, so a
    // password's echo can be dropped.
    const target = this.out;
    const echo = new Writable({
      write: (chunk: Buffer | string, _encoding, done) => {
        if (!this.muted) target.write(chunk);
        done();
      },
    });
    Object.defineProperties(echo, {
      columns: { get: () => target.columns ?? 80 },
      isTTY: { get: () => this.isTTY },
    });
    target.on("resize", () => echo.emit("resize"));
    let input: NodeJS.ReadableStream = streams.input;
    if (!this.isTTY) {
      const filter = new Transform({
        transform: (chunk: Buffer, _encoding, done) => {
          if (chunk.includes(ETX)) {
            this.onInterrupt();
            done(null, Buffer.from(chunk.filter((byte) => byte !== ETX)));
          } else done(null, chunk);
        },
      });
      streams.input.pipe(filter);
      input = filter;
    }
    this.rl = createInterface({
      input,
      output: echo,
      terminal: this.isTTY,
      historySize: 500,
      history: [...history].reverse(),
      prompt: "",
    });
    this.rl.on("line", (line) => this.take(line));
    this.rl.on("SIGINT", () => this.onInterrupt());
    this.rl.on("close", () => this.end());
  }

  /** Writes text for the person; a prompt on screen is taken away first and put back after. */
  print(text: string): void {
    if (!text) return;
    const prompt = this.shown && this.isTTY ? this.shown : null;
    if (prompt) this.out.write("\r\x1b[2K");
    this.out.write(text);
    this.atLineStart = text.endsWith("\n");
    if (prompt) {
      if (!this.atLineStart) this.out.write("\n");
      this.atLineStart = true;
      this.display(prompt);
    }
  }

  /** `text` and a newline (starting on a new line when the last output didn't end one). */
  line(text = ""): void {
    this.print(`${this.atLineStart || this.shown ? "" : "\n"}${text}\n`);
  }

  /** Ends the current line when something was written on it. */
  freshLine(): void {
    if (!this.atLineStart && !this.shown) this.print("\n");
  }

  /** The terminal's width in columns. */
  get columns(): number {
    return this.out.columns ?? 80;
  }

  /**
   * The session's prompt: the next line typed, or null when input has ended. Lines typed while
   * nobody was reading (during a turn) come first, in order.
   */
  readLine(prompt: string): Promise<string | null> {
    return new Promise((resolve) => {
      const buffered = this.buffer.shift();
      if (buffered !== undefined) {
        // A piped line was never echoed: show what is being run.
        if (!this.isTTY) this.line(`${prompt}${buffered}`);
        resolve(buffered);
        return;
      }
      if (this.ended) {
        resolve(null);
        return;
      }
      this.reader = { prompt, secret: false, resolve };
      this.refresh();
    });
  }

  /**
   * A question asked in between: the line typed in answer, or null when it was cancelled
   * (Ctrl+C through `cancelAsks`, input ended). `secret`: what is typed isn't shown. On a pipe,
   * lines that arrived before the question answer it (nobody types there).
   */
  ask(prompt: string, options: { secret?: boolean } = {}): Promise<string | null> {
    return new Promise((resolve) => {
      if (!this.isTTY) {
        const buffered = this.buffer.shift();
        if (buffered !== undefined) {
          this.line(`${prompt}${options.secret ? "" : buffered}`);
          resolve(buffered);
          return;
        }
      }
      if (this.ended) {
        resolve(null);
        return;
      }
      this.asks.push({ prompt, secret: options.secret === true, resolve });
      this.refresh();
    });
  }

  /** A question is on screen or waiting. */
  get asking(): boolean {
    return this.asks.length > 0;
  }

  /** Cancels every waiting question (each resolves with null). */
  cancelAsks(): void {
    const waiting = this.asks.splice(0);
    if (this.shown && waiting.includes(this.shown)) this.hide();
    for (const ask of waiting) ask.resolve(null);
    this.refresh();
  }

  /** What is typed on the prompt's line so far (lines of a paste not sent yet included). */
  get typed(): string {
    return [...this.pasted, this.rl.line ?? ""].join(" ").trim();
  }

  /** Clears what is typed on the prompt's line. */
  clearTyped(): void {
    clearTimeout(this.pasteTimer);
    this.pasted = [];
    if (!this.isTTY) return;
    this.rl.write(null, { ctrl: true, name: "e" });
    this.rl.write(null, { ctrl: true, name: "u" });
  }

  /** Adds a line to the history (a whole message that was typed over several lines). */
  remember(line: string): void {
    const history = (this.rl as Interface & { history?: string[] }).history;
    if (history && line && history[0] !== line) history.unshift(line);
  }

  /** Stops reading. Pending prompts resolve with null. */
  close(): void {
    this.hide();
    this.rl.close();
    this.end();
  }

  private take(line: string): void {
    const waiting = this.shown ?? null;
    if (waiting && waiting === this.reader && this.isTTY) {
      // At a terminal, lines that come within a moment of each other were pasted together:
      // one message, not one per line.
      this.pasted.push(line);
      clearTimeout(this.pasteTimer);
      this.pasteTimer = setTimeout(() => this.settlePaste(), PASTE_MS);
      return;
    }
    if (waiting) {
      if (waiting.secret) {
        this.muted = false;
        this.out.write("\n");
      } else if (!this.isTTY) {
        // A pipe echoes nothing: the transcript shows what was entered after its prompt.
        this.out.write(`${line}\n`);
      }
      this.shown = null;
      this.atLineStart = true;
      if (waiting === this.reader) this.reader = null;
      else this.asks.splice(this.asks.indexOf(waiting), 1);
      waiting.resolve(line);
      this.refresh();
      return;
    }
    this.buffer.push(line);
    // A question waiting on a pipe takes it at once.
    this.refresh();
  }

  /** The lines entered together are the message, unless more of the paste waits on the line. */
  private settlePaste(): void {
    const waiting = this.reader;
    if (!waiting || !this.pasted.length) return;
    // What was pasted didn't end with a line end: its last line is still being edited, and
    // Enter sends everything.
    if (this.rl.line) return;
    const text = this.pasted.join("\n");
    this.pasted = [];
    if (this.shown === waiting) this.shown = null;
    this.atLineStart = true;
    this.reader = null;
    waiting.resolve(text);
    this.refresh();
  }

  /** Puts on screen what should be there: the first question, else the session's prompt. */
  private refresh(): void {
    const next = this.asks[0] ?? this.reader;
    if (next === this.shown) return;
    if (this.shown) this.hide();
    if (!next) return;
    if (!this.isTTY && this.buffer.length) {
      const line = this.buffer.shift() as string;
      this.line(`${next.prompt}${next.secret ? "" : line}`);
      if (next === this.reader) this.reader = null;
      else this.asks.shift();
      next.resolve(line);
      this.refresh();
      return;
    }
    if (this.ended) {
      if (next === this.reader) this.reader = null;
      else this.asks.shift();
      next.resolve(null);
      this.refresh();
      return;
    }
    if (!this.atLineStart) {
      this.out.write("\n");
      this.atLineStart = true;
    }
    this.display(next);
  }

  private display(waiting: Waiting): void {
    this.shown = waiting;
    if (waiting.secret) {
      // The prompt is written here and the echo dropped until the line is entered.
      this.rl.setPrompt("");
      this.out.write(waiting.prompt);
      this.muted = true;
    } else {
      this.rl.setPrompt(waiting.prompt);
      this.rl.prompt(true);
    }
    this.atLineStart = false;
  }

  private hide(): void {
    if (!this.shown) return;
    this.muted = false;
    if (this.isTTY) this.out.write("\r\x1b[2K");
    else this.out.write("\n");
    this.shown = null;
    this.atLineStart = true;
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.muted = false;
    const reader = this.reader;
    const asks = this.asks.splice(0);
    this.reader = null;
    this.shown = null;
    // What was piped before the end is still read, in order; then null.
    for (const ask of asks) ask.resolve(this.isTTY ? null : (this.buffer.shift() ?? null));
    clearTimeout(this.pasteTimer);
    if (reader)
      reader.resolve(this.pasted.length ? this.pasted.join("\n") : (this.buffer.shift() ?? null));
    this.pasted = [];
    this.onEnd();
  }
}
