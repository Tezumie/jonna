const { fork } = require("node:child_process");
const { Worker } = require("node:worker_threads");
const path = require("node:path");
function handle(n) {
  return n * 2;
}
const worker = new Worker(path.join(__dirname, "worker.js"));
worker.on("exit", () => {});
const child = fork(path.join(__dirname, "child.js"));
child.on("exit", () => {
  console.log("child done", handle(21));
});
