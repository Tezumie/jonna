// A status line command for tests (D357, agent-statusline-m7-99): reads the chat as JSON on stdin,
// prints one colored line (the model, the folder's name, the cost, the lines changed and the
// output style) and a second line that must not show; keeps every input in .statusline-log.jsonl.
import { appendFileSync } from "node:fs";

let input = "";
process.stdin.on("data", (d) => {
  input += d;
});
process.stdin.on("end", () => {
  const j = JSON.parse(input || "{}");
  appendFileSync(".statusline-log.jsonl", `${JSON.stringify(j)}\n`);
  const folder = String(j.workspace?.current_dir ?? "")
    .split(/[\\/]/)
    .pop();
  const esc = "\u001b";
  const cost = Number(j.cost?.total_cost_usd ?? 0).toFixed(2);
  // D373: OSC 8 links, a file at a line and a command (ESC \ ends each part).
  const st = `${esc}\\`;
  const link = (uri, text) => `${esc}]8;;${uri}${st}${text}${esc}]8;;${st}`;
  const readme = `file:///${String(j.workspace?.current_dir ?? "")
    .replace(/\\/g, "/")
    .replace(/^\//, "")}/README.md#L2`;
  process.stdout.write(
    `${esc}[32mpkgr-line ${j.model?.display_name}${esc}[0m | ${folder} | $${cost} | +${j.cost?.total_lines_added}/-${j.cost?.total_lines_removed} | ${esc}[1;34m${j.output_style?.name}${esc}[0m | ${link(readme, "readme-link")} | ${link("command:agent.showBackgroundTasks", "tasks-link")}\nsecond line\n`,
  );
});
