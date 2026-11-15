// Node only. Where a workflow's script runs with no window: a worker thread started from the
// worker script the headless build bundles beside the brain (`<script>.worker.mjs`,
// src/workers/node/). The agent's host takes it as its `workers` seam (agentHost.ts).
import { Worker } from "node:worker_threads";
import type { ScriptWorker, WorkerFactory } from "../../extensions/agent/agentHost";

/**
 * A worker factory over the bundled worker scripts in `directory` (a folder's URL: the brain
 * bundle's own, `new URL(".", import.meta.url)`). The thread gets no environment variables and
 * no arguments; its own console goes nowhere (a workflow's log comes as messages).
 */
export function nodeWorkers(directory: URL): WorkerFactory {
  return (script, name): ScriptWorker => {
    const worker = new Worker(new URL(`${script}.worker.mjs`, directory), {
      name,
      env: {},
      argv: [],
      execArgv: [],
      stdout: true,
      stderr: true,
    });
    // Never keeps the process alive by itself: the run that started it ends it.
    worker.unref();
    return {
      postMessage: (message) => worker.postMessage(message),
      onMessage: (listener) => {
        worker.on("message", (data: unknown) => listener(data));
      },
      onError: (listener) => {
        worker.on("error", (error: unknown) =>
          listener(error instanceof Error ? error.message : String(error ?? "")),
        );
      },
      terminate: () => void worker.terminate(),
    };
  };
}
