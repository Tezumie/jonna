// The Node extension host (D255, docs/vscode-extensions-plan.md phase 1): an extension whose
// manifest says `"host": "node"` (and that the user allowed the "node" permission) runs here
// instead of the sandboxed worker. The `ide` API is the worker's (`createWorkerApi`, the same
// messages), carried as one JSON message per line on stdin and stdout; the extension's main file
// is loaded with Node's own `require`, so it can use npm packages, `fs` and child processes (what
// the permission allows). Its own output (console, process.stdout) goes to the extension's log,
// never onto the protocol's stdout. Built by build.mjs as a CommonJS file the IDE writes to its
// data folder and starts with `node`.
// A VS Code package (D256) gets the `vscode` shim for `require("vscode")` and VS Code's
// ExtensionContext instead of `ide`. Every VS Code package runs in one shared process (D295), as
// in VS Code: each has its own shim and its own side of the RPC, its messages tagged with its id
// (`x`), so another extension's exports are the live object its `activate` returned. An
// extension of the IDE's own format still gets a process of its own (untagged messages).
import {
  createWorkerApi,
  type FromWorker,
  type Tagged,
  type ToWorker,
  type WorkerApi,
} from "../core/extensions/rpc";
import { SharedExtensionRegistry } from "../core/extensions/vscode/extensionRegistry";
import { ExtensionResources, type TimerGlobals } from "../core/extensions/vscode/hostResources";
import {
  createVscodeShim,
  type ShimFileSystem,
  type VscodeInit,
} from "../core/extensions/vscode/index";
import { FileSystemError, FileType, Uri } from "../core/extensions/vscode/types";

declare const process: {
  stdin: { setEncoding(e: string): void; on(ev: string, cb: (chunk: string) => void): void };
  stdout: { write: (chunk: string) => boolean };
  stderr: { write: (chunk: string) => boolean };
  on(ev: string, cb: (err: unknown) => void): void;
  exit(code: number): never;
  chdir(dir: string): void;
  platform: string;
  env: Record<string, string | undefined>;
  versions: { node: string };
  dlopen: (module: unknown, filename: string, flags?: number) => void;
};
declare const require: ((id: string) => unknown) & { cache: Record<string, unknown> };
/** The host script's folder: `<data>/extension-host` (workerHost.ts writes it there). */
declare const __dirname: string;

// The host needs Node 18 (node: modules, fs.cp): an older one says so, instead of failing on
// the first call it lacks (D261). workerHost.ts puts this line in the error.
if (Number(process.versions.node.split(".")[0]) < 18) {
  process.stderr.write(
    `Node.js ${process.versions.node} is too old for extensions: install Node.js 18 or newer.
`,
  );
  process.exit(3);
}

const write = process.stdout.write.bind(process.stdout);
/** `x`: whose message it is in the shared host (D295); none in a process of one extension. */
const post = (message: FromWorker, x?: string): void => {
  const tagged: Tagged<FromWorker> = x === undefined ? message : { ...message, x };
  write(`${JSON.stringify(tagged)}\n`);
};

/** An extension running here: its side of the RPC and its folder. */
interface Slot {
  /** Its id in the shared host; "" in a process of its own. */
  key: string;
  path: string;
  handlers: ((m: ToWorker) => void)[];
  /** Runs its deactivate once (the IDE's "deactivate" call, or unloading it). */
  deactivate(): Promise<void>;
}
const slots = new Map<string, Slot>();
/** The VS Code packages: what `vscode.extensions` lists, and whose file is whose. */
const registry = new SharedExtensionRegistry(process.platform);
/** Each VS Code package's `vscode` module, by id. */
const shims = new Map<string, unknown>();
/** Each VS Code package's timers and native addons, released when it's unloaded. */
const resources = new ExtensionResources();
/** Unloads under way, by key: a start of the same extension waits for its own. */
const unloading = new Map<string, Promise<void>>();

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

/**
 * Whose output it is: in the shared host, the extension whose file is on the stack (VS Code
 * tells extensions apart the same way); otherwise untagged (the process's own extension, or the
 * shared host's log when no extension's file is on the stack).
 */
function ownerOf(stack: string | undefined): string | undefined {
  if (slots.has("")) return undefined;
  const owner = registry.ownerOfStack(stack);
  return owner && slots.has(owner) ? owner : undefined;
}

const postLog = (level: "log" | "info" | "warn" | "error", text: string, stack?: string) =>
  post({ t: "log", level, text }, ownerOf(stack ?? new Error().stack));
const log =
  (level: "log" | "info" | "warn" | "error") =>
  (...args: unknown[]) =>
    postLog(level, format(args));
const consoleShim = {
  log: log("log"),
  info: log("info"),
  warn: log("warn"),
  error: log("error"),
  debug: log("log"),
  trace: log("log"),
};
Object.assign(globalThis as Record<string, unknown>, { console: { ...console, ...consoleShim } });
// Whatever the extension (or a package it uses) writes to stdout would break the protocol.
process.stdout.write = (chunk: string) => {
  postLog("log", String(chunk).replace(/\n$/, ""));
  return true;
};
const stackOf = (err: unknown) => (err instanceof Error ? err.stack : undefined);
process.on("uncaughtException", (err) => postLog("error", format([err]), stackOf(err)));
process.on("unhandledRejection", (err) =>
  postLog("error", format(["Unhandled rejection:", err]), stackOf(err)),
);

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let message: Tagged<ToWorker>;
    try {
      message = JSON.parse(line) as Tagged<ToWorker>;
    } catch {
      continue;
    }
    if (!message || typeof message !== "object") continue;
    const key = typeof message.x === "string" ? message.x : "";
    if (message.t === "init") void start(message, key);
    else if (message.t === "extensions")
      registry.setInstalled(Array.isArray(message.list) ? message.list : []);
    else if (message.t === "unload") void unload(key);
    else for (const h of slots.get(key)?.handlers ?? []) h(message);
  }
});
// The IDE closed the pipe (the window went, the extension stopped): end with it.
process.stdin.on("end", () => process.exit(0));

/** The shared host left the folder it started in (start()). */
let movedOut = false;

async function start(init: Extract<ToWorker, { t: "init" }>, key: string): Promise<void> {
  // Reloaded: the old one finishes unloading first (its modules forgotten).
  const previous = unloading.get(key) ?? (slots.has(key) ? unload(key) : undefined);
  if (previous) await previous;
  if (slots.has(key)) return;
  const x = key || undefined;
  // The shared host started in its first extension's folder (where the IDE lets a process start):
  // it moves to its own script's folder, so that extension can still be uninstalled (Windows
  // can't delete a process's working folder). VS Code's host runs in the app's folder too.
  if (x && !movedOut) {
    movedOut = true;
    try {
      process.chdir(__dirname);
    } catch {}
  }
  const handlers: ((m: ToWorker) => void)[] = [];
  const { api, onDeactivate, extensions } = createWorkerApi(
    { post: (m) => post(m, x), onMessage: (h) => handlers.push(h) },
    init.manifest,
  );
  let deactivate: (() => unknown) | undefined;
  let ran: Promise<unknown> | undefined;
  const runDeactivate = () => {
    ran ??= Promise.resolve().then(() => deactivate?.());
    return ran;
  };
  onDeactivate(runDeactivate);
  slots.set(key, {
    key,
    path: init.manifest.path ?? "",
    handlers,
    deactivate: () =>
      runDeactivate().then(
        () => undefined,
        () => undefined,
      ),
  });
  try {
    if (!init.file) throw new Error("The Node host needs the extension's main file.");
    if (init.vscode) {
      await startVscode(
        api,
        init.vscode,
        init.manifest.path ?? "",
        init.file,
        key,
        (handler) => {
          deactivate = handler;
        },
        extensions,
      );
      post({ t: "status", status: "active" }, x);
      return;
    }
    const exports = require(init.file) as {
      activate?: (ide: unknown) => unknown;
      deactivate?: () => unknown;
    };
    if (typeof exports.deactivate === "function") deactivate = exports.deactivate;
    if (typeof exports.activate === "function") await exports.activate(api);
    post({ t: "status", status: "active" }, x);
  } catch (err) {
    post(
      {
        t: "status",
        status: "failed",
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      },
      x,
    );
  }
}

/**
 * One extension stops in the shared host (disabled, reloaded, uninstalled): its deactivate runs
 * if the IDE's call didn't, and its modules are forgotten, so a new version loads afresh.
 */
function unload(key: string): Promise<void> {
  const running = unloading.get(key);
  if (running) return running;
  const slot = slots.get(key);
  const x = key || undefined;
  const done = (async () => {
    let native: string[] = [];
    if (slot) {
      await Promise.race([slot.deactivate(), new Promise((r) => setTimeout(r, 2000))]);
      if (slots.get(key) === slot) slots.delete(key);
      shims.delete(key);
      registry.remove(key);
      forgetModules(slot.path);
      // Its timers stop with it (VS Code's end with its whole host); its native addons can't be
      // unloaded: the IDE restarts the host before their folder is deleted (sharedHost.ts).
      if (key) native = resources.release(key).native;
    }
    post({ t: "unloaded", ...(native.length && { native }) }, x);
  })().finally(() => unloading.delete(key));
  unloading.set(key, done);
  return done;
}

/** Drops an extension's files from Node's module cache. */
function forgetModules(folder: string): void {
  if (!folder) return;
  const norm = (p: string) => {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? s.toLowerCase() : s;
  };
  const root = `${norm(folder)}/`;
  for (const file of Object.keys(require.cache))
    if (norm(file).startsWith(root)) delete require.cache[file];
}

type Stat = {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  ctimeMs: number;
  mtimeMs: number;
  size: number;
};
type Dirent = { name: string; isDirectory(): boolean; isSymbolicLink(): boolean };
type FsPromises = {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  stat(path: string): Promise<Stat>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  rm(path: string, options: { recursive: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  cp(
    from: string,
    to: string,
    options: { recursive: true; force: boolean; errorOnExist: boolean },
  ): Promise<void>;
  access(path: string): Promise<void>;
};

/** VS Code's FileSystemErrors for Node's codes (extensions test `err.code === "FileNotFound"`). */
function fsError(err: unknown, path: string): unknown {
  const code = (err as { code?: string })?.code;
  const uri = Uri.file(path);
  if (code === "ENOENT") return FileSystemError.FileNotFound(uri);
  if (code === "EEXIST") return FileSystemError.FileExists(uri);
  if (code === "ENOTDIR") return FileSystemError.FileNotADirectory(uri);
  if (code === "EISDIR") return FileSystemError.FileIsADirectory(uri);
  if (code === "EACCES" || code === "EPERM") return FileSystemError.NoPermissions(uri);
  return err;
}

function nodeFileSystem(): ShimFileSystem {
  const fsp = require("node:fs/promises") as FsPromises;
  const type = (s: { isDirectory(): boolean; isSymbolicLink(): boolean }) =>
    (s.isDirectory() ? FileType.Directory : FileType.File) |
    (s.isSymbolicLink() ? FileType.SymbolicLink : 0);
  const wrap = async <T>(path: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      throw fsError(err, path);
    }
  };
  const exists = (path: string) =>
    fsp.access(path).then(
      () => true,
      () => false,
    );
  return {
    readFile: (path) => wrap(path, async () => new Uint8Array(await fsp.readFile(path))),
    writeFile: (path, data) => wrap(path, () => fsp.writeFile(path, data)),
    stat: (path) =>
      wrap(path, async () => {
        const s = await fsp.stat(path);
        return { type: type(s), ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
      }),
    readDirectory: (path) =>
      wrap(path, async () =>
        (await fsp.readdir(path, { withFileTypes: true })).map(
          (d) => [d.name, type(d)] as [string, FileType],
        ),
      ),
    createDirectory: (path) =>
      wrap(path, () => fsp.mkdir(path, { recursive: true }).then(() => undefined)),
    delete: (path, o) => wrap(path, () => fsp.rm(path, { recursive: o.recursive })),
    rename: (from, to, o) =>
      wrap(from, async () => {
        if (!o.overwrite && (await exists(to))) throw FileSystemError.FileExists(Uri.file(to));
        await fsp.rename(from, to);
      }),
    copy: (from, to, o) =>
      wrap(from, () =>
        fsp.cp(from, to, { recursive: true, force: o.overwrite, errorOnExist: !o.overwrite }),
      ),
  };
}

/**
 * The shell the IDE's terminals and tasks start on Windows (VS Code's `env.shell`, D261): PowerShell
 * 7 when it's installed, else Windows PowerShell — not `%ComSpec%` (cmd.exe), which the IDE doesn't
 * use, so an extension quoting for `env.shell` quoted for the wrong shell.
 */
function windowsShell(): string {
  const fs = require("node:fs") as { existsSync(p: string): boolean };
  const env = process.env;
  const candidates = [
    ...(env.PATH ?? env.Path ?? "").split(";").map((d) => (d ? `${d}\\pwsh.exe` : "")),
    ...[env.ProgramFiles, env.ProgramW6432].map((d) => (d ? `${d}\\PowerShell\\7\\pwsh.exe` : "")),
  ].filter(Boolean);
  for (const c of candidates)
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // A PATH entry that can't be read: the next one.
    }
  return `${env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/** A short stable name for a folder (its storage folder's name). */
function folderHash(path: string): string {
  let h = 0x811c9dc5;
  const key = process.platform === "win32" ? path.toLowerCase() : path;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The shim of the extension whose main file is being required right now. */
let requiring: unknown;
let hooked = false;
let resourcesHooked = false;

/**
 * Each VS Code package's timers and native addons (hostResources.ts): timers are told apart by
 * the extension file on the stack, addons by the folder they load from (`process.dlopen`, which
 * `require` of a `.node` file and `node-gyp-build` both go through).
 */
function hookResources(): void {
  if (resourcesHooked) return;
  resourcesHooked = true;
  resources.trackTimers(globalThis as unknown as TimerGlobals, () =>
    slots.has("") ? undefined : registry.ownerOfStack(new Error().stack),
  );
  const dlopen = process.dlopen;
  if (typeof dlopen === "function")
    process.dlopen = function (this: unknown, ...args: unknown[]) {
      // As called (no `flags` passed means Node's default, not 0).
      (dlopen as (...a: unknown[]) => void).apply(this, args);
      // Only once it loaded: a failed load leaves nothing to unload.
      const filename = args[1];
      if (typeof filename === "string") resources.addNative(registry.ownerOf(filename), filename);
    } as typeof process.dlopen;
}

/**
 * `require("vscode")` is the requiring extension's own shim (D295), found by the requiring file's
 * folder as VS Code does; while an extension's main file loads, a file outside every extension
 * folder (a linked package) gets that extension's.
 */
function hookVscodeModule(): void {
  if (hooked) return;
  hooked = true;
  const Module = require("node:module") as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const load = Module._load;
  Module._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
    if (request === "vscode") {
      const file = (parent as { filename?: unknown } | null)?.filename;
      const owner = typeof file === "string" ? registry.ownerOf(file) : undefined;
      const shim =
        (owner !== undefined ? shims.get(owner) : undefined) ??
        requiring ??
        (shims.size === 1 ? [...shims.values()][0] : undefined);
      if (shim) return shim;
    }
    return load.call(this, request, parent, isMain);
  };
}

/** Starts a VS Code extension: `require("vscode")` is its shim, `activate` gets its context. */
async function startVscode(
  api: WorkerApi,
  init: VscodeInit,
  extensionPath: string,
  file: string,
  key: string,
  onDeactivate: (handler: () => unknown) => void,
  extensions: { activate(id: string): Promise<void> },
): Promise<void> {
  const path = require("node:path") as { join(...parts: string[]): string };
  const fs = require("node:fs") as { readFileSync(p: string, enc: string): string };
  const packageJSON = JSON.parse(
    fs.readFileSync(path.join(extensionPath, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  const id = api.extension.id;
  const storage = path.join(__dirname, "storage", id);
  const root = api.workspace.workspaceFolders?.[0]?.path;
  // The list the IDE sends the shared host comes first; a host without one uses the init's.
  if (!registry.list().length && init.others) registry.setInstalled(init.others);
  const shim = createVscodeShim({
    ide: api,
    activateExtension: (id) => extensions.activate(id),
    init,
    packageJSON,
    extensionPath,
    globalStoragePath: path.join(storage, "global"),
    ...(root && { workspaceStoragePath: path.join(storage, folderHash(root)) }),
    logPath: path.join(__dirname, "logs", id),
    fs: nodeFileSystem(),
    shell: process.platform === "win32" ? windowsShell() : (process.env.SHELL ?? "/bin/sh"),
    log: (level, text) => post({ t: "log", level, text }, key || undefined),
    registry,
    // The app's own folder isn't known here: the host script's (stable, the IDE's).
    appRoot: __dirname,
    readPackage: (extensionPath) => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(extensionPath, "package.json"), "utf8"),
        ) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    },
  });
  shims.set(key, shim.vscode);
  hookVscodeModule();
  hookResources();
  await shim.ready();
  let exports: { activate?: (context: unknown) => unknown; deactivate?: () => unknown };
  requiring = shim.vscode;
  try {
    exports = require(file) as typeof exports;
  } finally {
    requiring = undefined;
  }
  onDeactivate(async () => {
    shim.beginStop();
    try {
      if (typeof exports.deactivate === "function") await exports.deactivate();
    } finally {
      shim.dispose();
    }
  });
  shim.setExports(
    typeof exports.activate === "function" ? await exports.activate(shim.context) : undefined,
  );
}
