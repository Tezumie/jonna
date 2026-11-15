// Node only: imported first by a worker script built for a Node worker thread. It gives the
// thread the few globals a web worker's script expects (`self`, `postMessage`, a `message`
// listener) over the thread's port, then takes away what a web worker never had and a script
// must not reach: the process (its environment, its built-in modules), the module loaders and
// buffers of raw memory. The worker scripts lock the rest down themselves (workers/lockdown.ts).
//
// A Node thread has no engine-level sandbox as a page's worker has: this removes the ordinary
// ways out and is not a security boundary against code written to escape it. The script itself
// is compiled in a context of its own (isolate.ts says exactly what that is and is not), which
// the worker script takes from here once, as `compileIsolated`. A workflow's script only runs
// when the run's policy names the tool or a person allowed it (full access alone doesn't).
import { parentPort } from "node:worker_threads";
import { compileIsolated } from "./isolate";

const port = parentPort;
if (!port) throw new Error("This script runs as a worker thread.");

const scope = globalThis as Record<string, unknown>;
scope.self = scope;
scope.postMessage = (message: unknown): void => port.postMessage(message);
scope.addEventListener = (type: string, listener: (event: { data: unknown }) => void): void => {
  if (type === "message") port.on("message", (data: unknown) => listener({ data }));
};

// For the worker script (workflow.worker.ts), which reads it as it loads and takes it away.
scope.compileIsolated = compileIsolated;

for (const name of ["process", "require", "module", "Buffer", "global", "navigator"]) {
  try {
    Object.defineProperty(scope, name, { value: undefined, configurable: false, writable: false });
  } catch {
    // Not configurable on this runtime: left as it is.
  }
}
