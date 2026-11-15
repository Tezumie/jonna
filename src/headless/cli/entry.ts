// Node only. The file the launcher starts. It checks the Node version before loading anything
// else (the rest is loaded on demand, so an old Node gets a sentence, not a syntax error), then
// runs the command line.
const MINIMUM_NODE = 20;

const major = Number((process.versions.node ?? "0").split(".")[0]);
if (!(major >= MINIMUM_NODE)) {
  process.stderr.write(
    `Node.js ${MINIMUM_NODE} or newer is needed; this is ${process.versions.node}. Install a current Node.js (nodejs.org) and try again.\n`,
  );
  process.exit(2);
}

// A failure nobody caught is a bug: say it once, plainly, and leave with the failure code.
process.on("uncaughtException", (error: NodeJS.ErrnoException) => {
  // Writing to a pipe whose reader left (`| head`) isn't one.
  if (error.code === "EPIPE") return;
  try {
    process.stderr.write(`Unexpected error: ${error.stack ?? error.message}\n`);
  } catch {
    // Nowhere to say it.
  }
  process.exit(1);
});

// A promise nobody waited for that failed (a call still out when the host went away): the
// mode's own handling says what matters; the rest is noise unless asked for.
process.on("unhandledRejection", (reason) => {
  if (!process.argv.includes("--verbose")) return;
  try {
    process.stderr.write(
      `[unhandled] ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`,
    );
  } catch {
    // Nowhere to say it.
  }
});

void import("./main").then(({ main }) => main(process.argv.slice(2)));
