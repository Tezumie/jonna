// Node only. The process's streams as the modes use them: writes that never throw on a closed
// pipe (`| head`), reading all of standard input, and leaving with an exit code once what was
// written has gone out.
import { readFileSync } from "node:fs";
import { colorEnabled, makeStyle, type Style, unicodeEnabled } from "./style";

export interface Io {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  env: NodeJS.ProcessEnv;
  /** Writes to standard output; false once it can't be written to (the reader went away). */
  out(text: string): boolean;
  /** Writes to standard error. */
  err(text: string): void;
  /** Standard output was closed by its reader. */
  readonly broken: boolean;
  /** Told once when standard output breaks. */
  onBroken(listener: () => void): void;
  /** The style for a stream: colour and glyphs when it is a terminal that takes them. */
  style(stream: "stdout" | "stderr", flag: boolean | undefined): Style;
}

export function processIo(): Io {
  const { stdin, stdout, stderr, env } = process;
  let broken = false;
  const listeners: (() => void)[] = [];
  const onError = (which: "stdout" | "stderr") => (error: NodeJS.ErrnoException) => {
    // The reader closed the pipe: stop writing, quietly. Anything else is a real problem, but
    // there is nowhere left to say it.
    if (which === "stdout" && !broken) {
      broken = true;
      for (const listener of listeners.splice(0)) listener();
    }
    void error;
  };
  stdout.on("error", onError("stdout"));
  stderr.on("error", onError("stderr"));
  return {
    stdin,
    stdout,
    stderr,
    env,
    out: (text) => {
      if (broken || !text) return !broken;
      try {
        stdout.write(text);
      } catch {
        broken = true;
      }
      return !broken;
    },
    err: (text) => {
      if (!text) return;
      try {
        stderr.write(text);
      } catch {
        // Nowhere to say it.
      }
    },
    get broken() {
      return broken;
    },
    onBroken: (listener) => {
      if (broken) listener();
      else listeners.push(listener);
    },
    style: (which, flag) => {
      const stream = which === "stdout" ? stdout : stderr;
      const e = { isTTY: stream.isTTY === true, env, platform: process.platform, flag };
      return makeStyle(colorEnabled(e), unicodeEnabled(e));
    },
  };
}

/**
 * All of standard input as text (UTF-8, a byte order mark dropped). `firstByteMs`: give up when
 * nothing at all arrives in that time (a parent that left an unused pipe open); undefined: wait
 * for the end however long it takes.
 */
export function readStdin(stdin: NodeJS.ReadStream, firstByteMs?: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.off("end", done);
      stdin.off("error", done);
      stdin.pause();
      resolve(Buffer.concat(chunks).toString("utf8").replace(/^﻿/, ""));
    };
    const onData = (chunk: Buffer | string) => {
      clearTimeout(timer);
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    };
    stdin.on("data", onData);
    stdin.once("end", done);
    stdin.once("error", done);
    if (firstByteMs !== undefined) timer = setTimeout(done, firstByteMs);
    stdin.resume();
  });
}

/** A file's text, or an error that says which file. */
export function readTextFile(path: string): string {
  return readFileSync(path, "utf8").replace(/^﻿/, "");
}

/** Leaves with `code` once what was written to the streams has gone out. */
export function leave(code: number): Promise<never> {
  return new Promise<never>(() => {
    process.exitCode = code;
    let waiting = 2;
    const flushed = () => {
      if (--waiting === 0) process.exit(code);
    };
    const flush = (stream: NodeJS.WriteStream) => {
      if (stream.destroyed || stream.writableEnded) flushed();
      else {
        try {
          stream.write("", flushed);
        } catch {
          flushed();
        }
      }
    };
    flush(process.stdout);
    flush(process.stderr);
    setTimeout(() => process.exit(code), 2000).unref();
  });
}
