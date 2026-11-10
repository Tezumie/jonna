// Auto-attach bootloader (D204): loaded into Node processes through NODE_OPTIONS=--require, by
// a debugged Node program (its child processes) and by a JavaScript debug terminal (every Node
// program started in it). It opens the process's inspector on a free local port, registers it with
// the IDE by writing a small JSON file into the registration folder the IDE polls, and waits until
// the IDE has set breakpoints (`inspector.waitForDebugger`, released by the IDE's
// `Runtime.runIfWaitingForDebugger`). Plain CommonJS, no dependencies, quiet on every failure: a
// program must run the same when the IDE isn't there.

(() => {
  const dir = process.env.IDE_DEBUG_ATTACH;
  if (!dir) return;
  let fs;
  let path;
  let inspector;
  try {
    // Worker threads are debugged through their parent's inspector (NodeWorker domain).
    const threads = require("worker_threads");
    if (!threads.isMainThread) return;
    fs = require("fs");
    path = require("path");
    inspector = require("inspector");
  } catch {
    return;
  }
  // fork() passes this process's execArgv on: an --inspect-brk the IDE started it with would
  // make each child wait on a port of its own that nobody knows about. Children register here.
  for (let i = process.execArgv.length - 1; i >= 0; i--)
    if (/^--inspect(-brk|-wait|-port)?(=|$)/.test(process.execArgv[i] || ""))
      process.execArgv.splice(i, 1);
  // Already being debugged (the IDE's own --inspect-brk launch, or the user's --inspect).
  if (inspector.url()) return;
  // The IDE keeps this file fresh while it listens; an old one means it went away.
  try {
    if (Date.now() - fs.statSync(path.join(dir, "alive")).mtimeMs > 15000) return;
  } catch {
    return;
  }
  const script = process.argv[1] || "";
  // REPLs and `node -e`: nothing to debug. Dependencies' scripts (npm, yarn, a bundler's
  // internals) are skipped unless they're tools that run the user's code (VS Code's "smart").
  if (!script) return;
  const slashed = script.replace(/\\/g, "/");
  const known =
    /\/node_modules\/(?:\.bin\/)?(?:jest|jest-cli|jest-worker|jest-circus|mocha|vitest|tinypool|ts-node|tsx|@swc-node|babel-node|@babel\/node|vite|next|nuxt|nodemon|webpack|webpack-dev-server|@nestjs\/cli|react-scripts|ava|tap|esbuild-register)(?:\/|$)/;
  if (
    process.env.IDE_DEBUG_ATTACH_MODE !== "always" &&
    slashed.includes("/node_modules/") &&
    !known.test(slashed)
  )
    return;
  try {
    inspector.open(0, "127.0.0.1", false);
  } catch {
    return;
  }
  const url = inspector.url();
  if (!url) return;
  const file = path.join(dir, `${process.pid}.json`);
  try {
    fs.writeFileSync(
      `${file}.tmp`,
      JSON.stringify({
        pid: process.pid,
        ppid: process.ppid,
        url,
        script,
        cwd: process.cwd(),
        args: process.argv.slice(2, 12),
      }),
    );
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    inspector.close();
    return;
  }
  inspector.waitForDebugger();
})();
