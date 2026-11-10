// An agent hook for tests (D227): logs the event it got on stdin to .hook-log.jsonl and blocks
// (exit code 2) a run_command whose command line mentions "agent-ran".
import { appendFileSync } from "node:fs";

let input = "";
process.stdin.on("data", (d) => {
  input += d;
});
process.stdin.on("end", () => {
  const event = JSON.parse(input || "{}");
  appendFileSync(".hook-log.jsonl", `${JSON.stringify(event)}\n`);
  if (
    event.tool_name === "run_command" &&
    String(event.tool_input?.command).includes("agent-ran")
  ) {
    process.stderr.write("No echo commands here (test hook).");
    process.exit(2);
  }
  // D233: a message that never starts (its group routing must not take effect).
  if (
    event.hook_event_name === "UserPromptSubmit" &&
    String(event.prompt).includes("hook-blocks")
  ) {
    process.stderr.write("Blocked by the test hook.");
    process.exit(2);
  }
  // D371: a session's start adds context (plain output).
  if (event.hook_event_name === "SessionStart") process.stdout.write("session-start-marker");
});
