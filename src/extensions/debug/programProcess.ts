// A program the debugger runs with its output captured (VS Code's `"console": "internalConsole"`
// and `"outputCapture": "std"`): started with pipes instead of a terminal, as js-debug does, so its
// stdout and stderr stay apart (the debug console colors stderr). There's no input, as in VS Code's
// internal console. Rust: the stdio host (src-tauri/src/lsp) with `"chunks"` framing, which passes
// the output on as it's written (a line without its end too, so a prompt shows at once) and
// fills `${env:NAME}` into the environment. The terminal runs (`TaskExecution`) and these share
// `ProgramRun`, so sessions take either.
import { lspIpc } from "../../core/ipc/process";
import type { TaskExecution } from "../../workbench/services";

/** A program the debugger started: in a terminal tab, or with pipes. */
export interface ProgramRun {
  readonly exited: Promise<number>;
  kill(): void;
  /**
   * Its output: `stderr` is known only for piped programs (a terminal has one stream). A new
   * listener gets the output so far first.
   */
  onOutput(listener: (text: string, stderr: boolean) => void): { dispose(): void };
}

/** A terminal run as a ProgramRun (its output is one stream: stdout). */
export function terminalRun(execution: TaskExecution): ProgramRun {
  return {
    exited: execution.exited,
    kill: () => execution.kill(),
    onOutput: (listener) => execution.onOutput((chunk) => listener(chunk, false)),
  };
}

let counter = 0;
/** The most output kept for listeners that come later (the inspector's address, the console). */
const MAX_KEPT = 2000;

/** Starts `command` with pipes; resolves once it runs. */
export async function startPiped(spec: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}): Promise<ProgramRun> {
  const id = `debug-program-${++counter}`;
  const kept: { text: string; stderr: boolean }[] = [];
  const listeners = new Set<(text: string, stderr: boolean) => void>();
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => {
    resolveExit = r;
  });
  const emit = (text: string, stderr: boolean) => {
    kept.push({ text, stderr });
    if (kept.length > MAX_KEPT) kept.shift();
    for (const l of listeners) l(text, stderr);
  };
  await lspIpc.start(
    id,
    { command: spec.command, args: spec.args, cwd: spec.cwd, env: spec.env, framing: "chunks" },
    (event) => {
      if (event.kind === "message") emit(event.body, false);
      else if (event.kind === "stderr") emit(event.line, true);
      else resolveExit(event.code ?? 1);
    },
  );
  return {
    exited,
    kill: () => void lspIpc.stop(id).catch(() => {}),
    onOutput: (listener) => {
      for (const k of kept) listener(k.text, k.stderr);
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}
