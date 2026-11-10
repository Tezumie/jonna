// `node ../setup/kill-matching.mjs <text>`: ends the processes whose command line contains <text>
// and prints "was-running" when there was one (pkill -f on every OS; Git Bash has no pkill).
import { execFileSync } from "node:child_process";
import { writeSync } from "node:fs";

const text = process.argv[2] ?? "";
if (!text) process.exit(2);
let killed = 0;
if (process.platform === "win32") {
  const script = `$n = 0; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:KILL_TEXT) -and $_.ProcessId -ne ${process.pid} -and $_.ProcessId -ne ${process.ppid} -and $_.Name -ne 'powershell.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $n++ }; $n`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    env: { ...process.env, KILL_TEXT: text },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  killed = Number.parseInt(out.trim(), 10) || 0;
} else {
  // Not pkill: this process's own command line and its shell's (`bash -c "… <text>"`) contain the
  // text too, and pkill ended them (exit 143). pgrep's list, without this process and its parent.
  let pids = [];
  try {
    pids = execFileSync("pgrep", ["-f", text], { encoding: "utf8" })
      .split("\n")
      .map((x) => Number.parseInt(x, 10))
      .filter((pid) => pid && pid !== process.pid && pid !== process.ppid);
  } catch {
    pids = [];
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
      killed++;
    } catch {}
  }
}
// The exit code says it too: in Git Bash on Windows `node` runs through winpty (Git for Windows'
// alias), and the line can be missing from the command's captured output; tests check the code.
if (killed) writeSync(1, "was-running\n");
process.exitCode = killed ? 0 : 1;
