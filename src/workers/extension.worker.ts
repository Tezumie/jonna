// The worker an extension's code runs in (PLAN §9.4, D102): no DOM and no IPC. Before the
// extension's code runs, the network and storage APIs a worker would normally have are removed,
// so the only way out is the `ide` RPC, which the IDE checks against the extension's permissions.
// Built as a separate classic script (build.mjs) and started by the extensions host.
import { createWorkerApi, type FromWorker, type ToWorker } from "../core/extensions/rpc";
import { loadsModules } from "../core/extensions/sandbox";
import { lockCodeGeneration, lockdown } from "./lockdown";

const scope = self as unknown as Record<string, unknown> & {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
};
const post = scope.postMessage.bind(scope) as (message: FromWorker) => void;
const handlers: ((m: ToWorker) => void)[] = [];
scope.addEventListener("message", (e: MessageEvent) => {
  const data = e.data as ToWorker;
  if (data?.t === "init") void start(data);
  else for (const h of handlers) h(data);
});

function format(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ")
    .slice(0, 4000);
}

async function start(init: Extract<ToWorker, { t: "init" }>): Promise<void> {
  const { api, onDeactivate } = createWorkerApi(
    { post, onMessage: (h) => handlers.push(h) },
    init.manifest,
  );
  const log =
    (level: "log" | "info" | "warn" | "error") =>
    (...args: unknown[]) =>
      post({ t: "log", level, text: format(args) });
  const console = {
    log: log("log"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    debug: log("log"),
  };
  scope.console = console;
  scope.addEventListener(
    "error" as "message",
    ((e: ErrorEvent) => post({ t: "log", level: "error", text: e.message })) as unknown as (
      e: MessageEvent,
    ) => void,
  );
  lockdown();
  try {
    const module = { exports: {} as Record<string, unknown> };
    if (loadsModules(init.code))
      throw new Error(
        "Extensions can't load code with import(): put everything the extension runs in its main file.",
      );
    // The extension's own file, as a function of the API (CommonJS-style module object).
    const run = new Function(
      "ide",
      "module",
      "exports",
      "console",
      `${init.code}\n//# sourceURL=${init.filename}`,
    );
    lockCodeGeneration("Extensions can't create code at run time.");
    run(api, module, module.exports, console);
    const exports = module.exports as {
      activate?: (ide: unknown) => unknown;
      deactivate?: () => unknown;
    };
    if (typeof exports.deactivate === "function") onDeactivate(exports.deactivate);
    if (typeof exports.activate === "function") await exports.activate(api);
    post({ t: "status", status: "active" });
  } catch (err) {
    post({
      t: "status",
      status: "failed",
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
  }
}
