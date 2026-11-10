// `npm run dev:fresh` (D164): the IDE in dev mode as a brand-new user sees it, to try first-run
// onboarding. Nothing of yours is touched or signed out:
// - a new profile in a temporary folder (no settings, keys, chats, recent folders);
// - the GitHub CLI's login hidden from this run only (its own empty config folder);
// - Ollama looked for at an address where nothing answers, so the setup card shows.
// `npm run dev:fresh-ollama` keeps your running Ollama visible instead. The profile is deleted
// when the run ends (`-- --keep-profile` keeps it).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const keepOllama = process.argv.includes("--keep-ollama");
const dir = mkdtempSync(join(tmpdir(), "ide-fresh-profile-"));
mkdirSync(join(dir, "config"), { recursive: true });
if (!keepOllama)
  writeFileSync(
    join(dir, "config", "settings.json"),
    `${JSON.stringify({ "agent.ollama.url": "http://127.0.0.1:9" }, null, 2)}\n`,
  );
const gh = join(dir, "gh");
mkdirSync(gh, { recursive: true });
console.log(`Fresh profile: ${dir}${keepOllama ? "" : " (Ollama hidden)"}`);

const env = { ...process.env, IDE_USER_DATA_DIR: dir, GH_CONFIG_DIR: gh };
delete env.GH_TOKEN;
delete env.GITHUB_TOKEN;
// One command string: passing an argument list with `shell: true` is deprecated (DEP0190).
const child = spawn("npm run dev", { stdio: "inherit", shell: true, env });
// The throwaway profile goes with the run (its settings and a GitHub CLI folder pile up in the
// temp folder otherwise), unless --keep-profile; a run killed by a signal is a failure (D174).
const keepProfile = process.argv.includes("--keep-profile");
child.on("exit", (code) => {
  if (!keepProfile) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  process.exit(code ?? 1);
});
