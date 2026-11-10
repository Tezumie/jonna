// A stand-in for docker in UI tests (D266), on Windows with a WSL distribution named Ubuntu: its
// "containers" are that distribution. `run` records one (labels, mounts) in a state file next to
// the test folder and copies a bind-mounted local folder to the mount's target in WSL; `exec`
// runs the command there through wsl.exe (the dev container transport's `exec -i … sh -c`
// included); `ps`, `start`, `inspect`, `rm` and `build` answer from the state file. Anything
// else fails like an unknown command.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
// The test run's own file (scripts/ui-test.mjs sets it), wherever docker is started from.
const statePath =
  process.env.FAKE_DOCKER_STATE ?? join(dirname(resolve(process.cwd())), "fake-docker.json");
const load = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : []);
const save = (s) => writeFileSync(statePath, JSON.stringify(s, null, 2));
const fail = (text) => {
  process.stderr.write(`${text}\n`);
  process.exit(1);
};
const find = (state, id) => state.find((c) => c.id.startsWith(id) || c.name === id);
/** Options before the command's own arguments: `--flag value` pairs and lone flags. */
const VALUED = new Set([
  "-u",
  "-w",
  "-e",
  "--label",
  "--mount",
  "--entrypoint",
  "-f",
  "-t",
  "--filter",
  "--format",
  "--build-arg",
  "--target",
]);
function split(rest) {
  const opts = [];
  let i = 0;
  while (i < rest.length && rest[i].startsWith("-")) {
    if (VALUED.has(rest[i])) {
      opts.push([rest[i], rest[i + 1]]);
      i += 2;
    } else {
      opts.push([rest[i], true]);
      i++;
    }
  }
  return { opts, rest: rest.slice(i) };
}
const wsl = (argv, stdio = "inherit") =>
  spawn("wsl.exe", ["-d", "Ubuntu", ...argv], { stdio, windowsHide: true });

const [command, ...rest] = args;
const state = load();
switch (command) {
  case "version":
    console.log("28.0.0-fake");
    break;
  case "build":
    console.log("Successfully built (fake)");
    break;
  case "ps": {
    const { opts } = split(rest);
    const all = opts.some(([k]) => k === "-a");
    const filters = opts.filter(([k]) => k === "--filter").map(([, v]) => v.replace(/^label=/, ""));
    const format = opts.find(([k]) => k === "--format")?.[1] ?? "";
    for (const c of state) {
      if (!all && c.state !== "running") continue;
      if (!filters.every((f) => c.labels.includes(f))) continue;
      if (format.includes("json"))
        console.log(
          JSON.stringify({
            ID: c.id.slice(0, 12),
            Names: c.name,
            Image: c.image,
            Status: c.state === "running" ? "Up 1 minute" : "Exited",
            Labels: c.labels.join(","),
          }),
        );
      else console.log(`${c.id.slice(0, 12)}\t${c.state}`);
    }
    break;
  }
  case "run": {
    const { opts, rest: positional } = split(rest);
    const labels = opts.filter(([k]) => k === "--label").map(([, v]) => v);
    const mounts = opts.filter(([k]) => k === "--mount").map(([, v]) => v);
    const id = randomBytes(32).toString("hex");
    for (const m of mounts) {
      const kv = Object.fromEntries(m.split(",").map((p) => p.split("=")));
      if (kv.type !== "bind" || !kv.source || !kv.target) continue;
      // The local folder's files at the target, as a bind mount shows them.
      const r = spawnSync(
        "wsl.exe",
        [
          "-d",
          "Ubuntu",
          "-e",
          "sh",
          "-c",
          'src=$(wslpath -u "$1"); rm -rf "$2" && mkdir -p "$2" && cp -r "$src/." "$2"',
          "sh",
          kv.source,
          kv.target,
        ],
        { stdio: "inherit", windowsHide: true },
      );
      if (r.status !== 0) fail(`fake docker: couldn't copy ${kv.source} to ${kv.target}`);
    }
    state.push({
      id,
      name: `fake_${id.slice(0, 6)}`,
      image: positional[0] ?? "",
      labels,
      state: "running",
    });
    save(state);
    console.log(id);
    break;
  }
  case "start": {
    const c = find(state, rest[0] ?? "");
    if (!c) fail(`Error: No such container: ${rest[0]}`);
    c.state = "running";
    save(state);
    console.log(rest[0]);
    break;
  }
  case "rm": {
    const id = rest.filter((a) => !a.startsWith("-"))[0] ?? "";
    save(state.filter((c) => !(c.id.startsWith(id) || c.name === id)));
    console.log(id);
    break;
  }
  case "inspect": {
    const c = find(state, rest[rest.length - 1] ?? "");
    if (!c) fail("Error: No such object");
    console.log(
      JSON.stringify(
        Object.fromEntries(
          c.labels.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
        ),
      ),
    );
    break;
  }
  case "exec": {
    const { opts, rest: after } = split(rest);
    const [id, ...cmd] = after;
    if (!find(state, id ?? "")) fail(`Error: No such container: ${id}`);
    const dir = opts.find(([k]) => k === "-w")?.[1];
    const env = opts.filter(([k]) => k === "-e").map(([, v]) => v);
    const child = wsl([...(dir ? ["--cd", dir] : []), "-e", "env", ...env, ...cmd]);
    child.on("exit", (code) => process.exit(code ?? 1));
    break;
  }
  default:
    fail(`fake docker: unknown command ${command}`);
}
