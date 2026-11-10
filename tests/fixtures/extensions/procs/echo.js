// A shipped script for the Procs test extension: answers ndjson pings, says hello on stderr.
const readline = require("node:readline");

process.stderr.write("echo starting\n");
process.stdout.write(`${JSON.stringify({ ready: true, cwd: process.cwd() })}\n`);
process.stdout.write("plain text line\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.quit) process.exit(3);
  process.stdout.write(`${JSON.stringify({ pong: message.ping, env: process.env.PROCS_FLAG })}\n`);
});
