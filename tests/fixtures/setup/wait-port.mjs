// `node ../setup/wait-port.mjs <port>`: waits (up to 15 s) until something listens on
// 127.0.0.1:<port>, for a program a test started in the background (`node --inspect=…`, whose
// start takes longer than a fixed sleep on a busy Windows machine).
import { connect } from "node:net";

const port = Number(process.argv[2]);
const deadline = Date.now() + 15000;
const attempt = () => {
  const socket = connect(port, "127.0.0.1", () => {
    socket.end();
    process.exitCode = 0;
  });
  socket.on("error", () => {
    if (Date.now() > deadline) process.exitCode = 1;
    else setTimeout(attempt, 200);
  });
};
attempt();
