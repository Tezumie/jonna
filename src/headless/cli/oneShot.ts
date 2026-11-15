// Node only. One shot: a prompt in, the answer out, an exit code. The answer goes to standard
// output (text, one JSON object, or a line of JSON per event); what the agent does on the way goes
// to standard error when that is a terminal or with --verbose, so the output stays clean for
// whatever reads it.
import type { BrainChat, HostedBrain, RunResult } from "../run";
import { type CliArgs, mayAsk, type Terminals, UsageError } from "./args";
import { Asks } from "./asks";
import { composePrompt, limitsOf, policyOf } from "./config";
import type { Io } from "./io";
import { readStdin, readTextFile } from "./io";
import { ConfigError, openChat, start } from "./launch";
import {
  EXIT,
  endNote,
  exitCodeOf,
  failureRecord,
  jsonLine,
  jsonResult,
  resultRecord,
  textResult,
} from "./output";
import { Prompter } from "./prompter";
import { EventRenderer } from "./render";

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The prompt of the run: the argument or the file, with piped input as context; or the input. */
async function readPrompt(args: CliArgs, io: Io, tty: Terminals): Promise<string> {
  let typed = args.prompt;
  if (args.promptFile !== undefined) {
    try {
      typed = readTextFile(args.promptFile);
    } catch (err) {
      throw new ConfigError(`Couldn't read ${args.promptFile} (--prompt-file): ${messageOf(err)}`);
    }
  }
  let piped: string | undefined;
  if (!tty.stdin || args.stdinPrompt) {
    // With a prompt already given, input is extra: a pipe nobody writes to mustn't hold the run.
    piped = await readStdin(io.stdin, typed !== undefined && !args.stdinPrompt ? 1000 : undefined);
  }
  const prompt = composePrompt(typed, piped);
  if (!prompt)
    throw new UsageError(
      "No prompt: give one as a quoted argument, with --prompt-file, or on standard input.",
    );
  return prompt;
}

export async function runOneShot(args: CliArgs, io: Io, tty: Terminals): Promise<number> {
  const started = Date.now();
  const format = args.outputFormat;
  /** A failure before the run: the message on stderr, and a result record for JSON readers. */
  const fail = (
    code: number,
    reason: "usage" | "config" | "error" | "cancelled",
    error: string,
  ) => {
    io.err(`${error}\n`);
    if (format !== "text")
      io.out(jsonResult(failureRecord(reason, code, error, Date.now() - started)));
    return code;
  };

  if (args.resume === true)
    throw new UsageError(
      "--resume needs a chat's id in a one-shot run (see: sessions list); alone, it offers a list in a session at a terminal.",
    );
  let prompt: string;
  try {
    prompt = await readPrompt(args, io, tty);
  } catch (err) {
    if (err instanceof UsageError) throw err;
    return fail(EXIT.usage, "config", messageOf(err));
  }

  const ask = mayAsk(args, "run", tty);
  const errStyle = io.style("stderr", args.color);
  const prompter = ask ? new Prompter({ input: io.stdin, output: io.stderr }) : null;
  const asks = prompter ? new Asks(prompter, errStyle) : null;
  const showProgress = format === "text" && (args.verbose || io.stderr.isTTY === true);
  const renderer = showProgress
    ? new EventRenderer((text) => (prompter ? prompter.print(text) : io.err(text)), {
        style: errStyle,
        verbose: args.verbose,
        answer: false,
        columns: () => io.stderr.columns ?? 100,
      })
    : null;

  let brain: HostedBrain | null = null;
  let chat: BrainChat | null = null;
  const abort = new AbortController();
  let interrupts = 0;
  let hostGone: string | null = null;
  let finished = false;
  const onSignal = () => {
    interrupts++;
    if (interrupts > 1) {
      // The second one quits at once: the host ends when its input closes.
      process.exit(EXIT.interrupted);
    }
    io.err("\nInterrupted: stopping (again to quit at once)…\n");
    prompter?.cancelAsks();
    abort.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  if (prompter) prompter.onInterrupt = onSignal;
  io.onBroken(() => abort.abort());

  /** Resolves when the host goes away by itself: nothing it was asked will ever be answered. */
  let hostExit: (value: "gone") => void = () => {};
  const gone = new Promise<"gone">((resolve) => {
    hostExit = resolve;
  });

  try {
    const run = await start(args, {
      frontend: "cli",
      policy: policyOf(args, ask),
      ...(asks && { services: asks.servicePolicy() }),
      ...(args.verbose && { log: (text: string) => io.err(text) }),
    });
    brain = run.brain;
    brain.onHostExit((code, signal) => {
      if (finished) return;
      hostGone = `The host program ended unexpectedly (${signal ?? `exit code ${code}`}).`;
      hostExit("gone");
    });
    if (format === "text" || args.verbose)
      for (const note of run.notes) io.err(`${errStyle.dim(note)}\n`);
    const opened = await openChat(brain, args, true);
    chat = opened.chat;
    const live = brain;
    chat.onEvent((event) => {
      if (format === "stream-json") io.out(jsonLine(event));
      renderer?.handle(event);
      if (event.type === "permission.request" && asks) void asks.permission(live, event);
      else if (event.type === "permission.decision") asks?.decided(event.id);
      else if (event.type === "question" && asks) void asks.question(live, event);
      else if (event.type === "turn.end") prompter?.cancelAsks();
    });
    const hostPrompts = asks?.watchHostPrompts(live);
    let result: RunResult | "gone";
    try {
      result = await Promise.race([
        chat.send(prompt, { ...limitsOf(args), signal: abort.signal }),
        gone,
      ]);
    } finally {
      hostPrompts?.dispose();
    }
    finished = true;
    renderer?.flush();
    if (result === "gone") return fail(EXIT.failed, "error", hostGone ?? "The host program ended.");
    const record = resultRecord(result, Date.now() - started);
    if (format === "json") io.out(jsonResult(record));
    else if (format === "stream-json") io.out(jsonLine(record));
    else io.out(textResult(result));
    const note = endNote(result);
    if (note) io.err(`${errStyle.yellow(note)}\n`);
    if (result.pending.length)
      io.err(
        `${errStyle.dim(`${result.pending.length} file(s) changed and wait for review: ${result.pending.join(", ")} (accept or reject them in the app, or in a session: --resume ${result.session}, then /accept or /reject).`)}\n`,
      );
    if (args.verbose)
      io.err(
        `${errStyle.dim(`chat ${result.session} · ${result.steps} step(s)${result.cost !== null ? ` · $${result.cost}` : ""}`)}\n`,
      );
    // A reader that went away mid-run cut the run short.
    if (io.broken && result.reason === "cancelled") return EXIT.failed;
    return exitCodeOf(result);
  } catch (err) {
    finished = true;
    renderer?.flush();
    if (hostGone) return fail(EXIT.failed, "error", hostGone);
    if (abort.signal.aborted && !io.broken)
      return fail(EXIT.interrupted, "cancelled", "Interrupted.");
    if (err instanceof UsageError || err instanceof ConfigError)
      return fail(EXIT.usage, err instanceof UsageError ? "usage" : "config", err.message);
    return fail(EXIT.failed, "error", messageOf(err));
  } finally {
    finished = true;
    prompter?.close();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    // A second Ctrl+C while things shut down still quits at once.
    const hurry = () => process.exit(EXIT.interrupted);
    process.on("SIGINT", hurry);
    if (brain && !hostGone) {
      const closing = brain.dispose().catch(() => {});
      await Promise.race([closing, new Promise((done) => setTimeout(done, 8000).unref())]);
    }
    process.off("SIGINT", hurry);
  }
}
