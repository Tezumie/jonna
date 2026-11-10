// Allowlist for the agent's run_command (agent.allowedCommands): entries are command prefixes
// matched on word boundaries ("npm test" allows "npm test -- foo", not "npm testx"), or ending in
// "*" for a raw prefix. Chained commands (&&, ;, |) must have every part allowed. DOM-free.

const SPLIT = /\s*(?:&&|\|\||;|\|)\s*/;

export function commandAllowed(command: string, allowlist: readonly string[]): boolean {
  const parts = command.trim().split(SPLIT).filter(Boolean);
  if (parts.length === 0 || /[`$]\(|`/.test(command)) return false;
  // Outside quotes: a redirect (`> file`, `< file`), a background `&` (a second command) or a
  // newline always asks — they'd let an allowed prefix run or overwrite anything. `2>&1` is fine.
  const bare = command.replace(/'[^']*'|"[^"]*"/g, "''").replace(/\d?>&\d/g, "");
  if (/[<>\r\n]|(^|[^&])&(?!&)/.test(bare.replace(/&&/g, ""))) return false;
  // Groups and script blocks run commands of their own (PowerShell evaluates `(…)` and `@(…)`
  // inside arguments): `npm test (Remove-Item src)` isn't `npm test` (D161).
  if (/[(){}]/.test(bare)) return false;
  return parts.every((part) =>
    allowlist.some((entry) => {
      const e = entry.trim();
      if (!e) return false;
      if (e.endsWith("*")) return part.startsWith(e.slice(0, -1));
      return part === e || part.startsWith(`${e} `);
    }),
  );
}

/** What "Always allow" remembers: the program and its first argument ("npm test", "git status"). */
export function permissionKey(command: string): string {
  const first = command.trim().split(SPLIT)[0] ?? "";
  const [program = "", arg] = first.split(/\s+/);
  // Interpreters run whatever follows: "always" covers this exact line, not every script
  // (`node x.js` mustn't allow `node -e …`, `cmd /c dir` mustn't allow `cmd /c del …`, D163).
  if (INTERPRETERS.has(commandWords(program)[0] ?? "")) return first.trim();
  // A subcommand ("npm test", "git status") is part of the key; a path or flag isn't ("ls -la",
  // "cat src/a.ts" → "ls", "cat").
  return arg && /^[a-z][\w:-]*$/i.test(arg) && !/[./\\]/.test(arg) ? `${program} ${arg}` : program;
}

/**
 * A leading `cd <dir> &&` (or `;`) into the open folder: models add it out of habit. Returns the
 * folder and the rest, so the command runs there without asking about `cd`.
 */
export function splitLeadingCd(command: string): { dir: string; rest: string } | null {
  // cmd's `cd /d C:\\x` changes the drive too: the flag isn't the folder.
  const m = /^\s*cd\s+(?:\/d\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)\s*([\s\S]+)$/i.exec(
    command,
  );
  if (!m) return null;
  const dir = m[1] ?? m[2] ?? m[3] ?? "";
  const rest = (m[4] ?? "").trim();
  return dir && rest ? { dir, rest } : null;
}

/**
 * Commands that still ask when the agent runs commands automatically (agent.runCommands "auto"):
 * deleting, killing, downloading and running what was downloaded, privilege changes, history
 * rewrites, publishing. Like VS Code's terminal auto-approve deny rules and Cursor's denylist.
 */
export const DEFAULT_DENIED_COMMANDS: readonly string[] = [
  "rm",
  "rmdir",
  "del",
  "erase",
  "rd",
  "Remove-Item",
  "ri",
  "mv",
  "move",
  "Move-Item",
  "kill",
  "pkill",
  "killall",
  "taskkill",
  "Stop-Process",
  "sudo",
  "su",
  "doas",
  "runas",
  "chmod",
  "chown",
  "icacls",
  "curl",
  "wget",
  "Invoke-WebRequest",
  "iwr",
  "Invoke-RestMethod",
  "irm",
  "Invoke-Expression",
  "iex",
  "eval",
  "dd",
  "mkfs",
  "format",
  "shutdown",
  "reboot",
  "Set-ExecutionPolicy",
  "reg",
  "git push",
  "git reset --hard",
  "git clean",
  "git checkout --",
  "git restore",
  "git rebase",
  "git branch -D",
  "npm publish",
  "cargo publish",
  "docker rm",
  "docker system prune",
  // D120: more ways to delete, overwrite, run or send things.
  "unlink",
  "shred",
  "truncate",
  "rimraf",
  "del-cli",
  "trash",
  "tee",
  "Set-Content",
  "Add-Content",
  "Clear-Content",
  "Out-File",
  "spps",
  "mi",
  "rni",
  "Rename-Item",
  "Start-Process",
  "saps",
  "start",
  "scp",
  "rsync",
  "ssh",
  "ftp",
  "git checkout .",
  "git checkout --",
  "git reset --hard",
  "git stash drop",
  "git stash clear",
  "git push --force",
  "git filter-branch",
  "pnpm publish",
  "yarn publish",
  // D161: PowerShell 5.1 aliases and commands that write or run things.
  "sc",
  "ac",
  "icm",
  "Invoke-Command",
  "Clear-Item",
  "cli",
];

/** Programs whose local-only reads are allowed in auto mode (D163). */
const LOCAL_FETCHERS = new Set([
  "curl",
  "wget",
  "invoke-webrequest",
  "iwr",
  "invoke-restmethod",
  "irm",
]);
const LOCAL_URL = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]\S*)?$/;
/** Flags that save, upload or post: not a plain read. */
const FETCH_WRITES =
  /^(?:-o|-O|--output|--remote-name|-T|--upload-file|-d|--data\S*|-F|--form|-X|--request|-outfile|-infile|-method|-body|--post-data|--post-file|-P|--directory-prefix)$/i;

function localFetchOnly(args: readonly string[]): boolean {
  const urls = args.filter((a) => !a.startsWith("-") && /[:/.]/.test(a));
  if (!urls.length || !urls.every((u) => LOCAL_URL.test(u))) return false;
  return !args.some((a) => FETCH_WRITES.test(a) || /^-o\S/.test(a));
}

/** Prefix words that run the rest as the command (`env FOO=1 rm …`, `nohup rm …`). */
const PASSTHROUGH = new Set([
  "env",
  "command",
  "nohup",
  "time",
  "exec",
  "builtin",
  "nice",
  "stdbuf",
]);
/** Programs that run code given on their command line (`bash -c "rm …"`, `node -e`). */
const INTERPRETERS = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "cmd",
  "powershell",
  "pwsh",
  "node",
  "deno",
  "bun",
  "python",
  "python3",
  "py",
  "perl",
  "ruby",
  "php",
  "osascript",
  "wsl",
]);
const INLINE_CODE =
  /^(?:-c|\/c|\/k|-command|-c[a-z]*|-encodedcommand|-e|--eval|-ec|-p|--print|-r)$/i;

/**
 * One chained part as words: quotes and escapes removed, prefixes skipped, program normalised.
 * `backslashIsPath`: a backslash in the program separates folders (`C:\\Git\\cmd\\git.exe`), as on
 * Windows; false reads it as bash's escape (`r\\m` is rm). The denylist checks both readings.
 */
export function commandWords(part: string, backslashIsPath = true): string[] {
  // A quoted word is one word (`git -C "my dir" push`, `& "C:\\Program Files\\Git\\git.exe"`).
  const words = (
    part
      .trim()
      .replace(/^[&.]\s+/, "") // PowerShell's call operator / dot-sourcing
      .match(/(?:"[^"]*"|'[^']*'|\S)+/g) ?? []
  )
    .map((w) => w.replace(/["'`]/g, ""))
    .filter(Boolean);
  while (
    words.length &&
    (/^[A-Za-z_][\w]*=/.test(words[0] ?? "") || PASSTHROUGH.has(words[0] ?? ""))
  )
    words.shift();
  if (!words.length) return [];
  // `/bin/rm`, `C:\\Windows\\rm.exe`, `RM` → `rm`. The backslashes went only after this split:
  // removed first, `C:\\Windows\\taskkill.exe` was `c:windowstaskkill` and passed the denylist.
  const program = backslashIsPath ? (words[0] ?? "") : (words[0] ?? "").replace(/\\/g, "");
  words[0] =
    program
      .split(/[\\/]/)
      .pop()
      ?.toLowerCase()
      .replace(/\.(?:exe|cmd|bat|com|ps1)$/, "") ?? "";
  for (let i = 1; i < words.length; i++) words[i] = (words[i] ?? "").replace(/\\/g, "");
  if (words[0] === "git") {
    // Skip git's own options before the subcommand: `git -C dir -c k=v --no-pager push`, and
    // the long ones git also takes with their value apart (`git --git-dir .git push`).
    let i = 1;
    while (i < words.length && (words[i] ?? "").startsWith("-"))
      i += /^(?:-[Cc]|--git-dir|--work-tree|--namespace|--super-prefix|--config-env)$/.test(
        words[i] ?? "",
      )
        ? 2
        : 1;
    words.splice(1, i - 1);
  }
  return words.filter(Boolean);
}

/**
 * Each chained part of a line as the denylist reads it (program without its folder or `.exe`,
 * prefixes and git's options skipped), both ways of reading a backslash: what an
 * agent.autoApprove Ask pattern is also checked against, so `C:\\Git\\cmd\\git.exe push` or
 * `/usr/bin/git push` still asks for `"git push": false`.
 */
export function normalizedCommandParts(command: string): string[] {
  const out = new Set<string>();
  for (const part of command
    .replace(/\d?>&\d/g, "")
    .split(/\s*(?:&&|\|\||;|\||&|[\r\n]+)\s*/)
    .map((p) => p.trim())
    .filter(Boolean))
    for (const words of [commandWords(part), commandWords(part, false)])
      if (words.length) out.add(words.join(" "));
  return [...out];
}

/**
 * Whether a command must ask even in automatic mode (D117, hardened D120): a chained part matches
 * the denylist (by program and subcommand, the entry's other words anywhere after them, case
 * ignored), it runs code passed on its command line (`bash -c`, `powershell -Command`, `node -e`)
 * or through `xargs` / `find -exec|-delete`, it hides a command (`$(…)`, backticks), it writes
 * a file with a redirect, or it has a newline or a background `&` (a second command).
 */
export function commandDenied(command: string, denylist: readonly string[]): boolean {
  if (/[\r\n]/.test(command)) return true;
  if (/[`$]\(|`/.test(command.replace(/'[^']*'/g, "''"))) return true;
  const bare = command.replace(/'[^']*'|"[^"]*"/g, "''");
  if (/(^|[^&>])&(?![&>])/.test(bare.replace(/&&/g, "").replace(/\d?>&\d/g, ""))) return true;
  // Output piped into a shell or interpreter runs it: `curl … | sh`, `… | iex` (D163).
  if (
    /\|\s*(?:sudo\s+)?(?:bash|sh|zsh|fish|dash|ksh|cmd|powershell|pwsh|python3?|py|node|perl|ruby|php|iex|invoke-expression)\b/i.test(
      bare,
    )
  )
    return true;
  // Subshells, groups, script blocks and .NET calls hide the program from the checks below:
  // `( rm -rf src )`, `{ rm x; }`, `ls | % { ri $_ }`, `[IO.Directory]::Delete(…)` (D161).
  if (/[(){}]|\]::/.test(bare)) return true;
  // Shell keywords put the command after them: `if x; then rm …; fi`, `for …; do rm …; done`.
  for (const part of bare.trim().split(SPLIT))
    if (
      /^(?:!|if|then|elif|else|do|while|until|for|foreach|case|function|%|\?)(?:\s|$)/i.test(
        part.trim(),
      )
    )
      return true;
  // Every redirect into a file asks; only the null device is fine (`2>&1` isn't a file).
  for (const m of bare.matchAll(/\d*>>?\s*(&\d|[^\s;&|]+)?/g)) {
    const target = m[1] ?? "";
    if (/^&\d$/.test(target)) continue;
    if (!/^(?:\/dev\/null|\$null|nul)$/i.test(target)) return true;
  }
  // A program named in git's config or the environment runs without being the command's program:
  // `git -c alias.x='!rm -rf .' x`, `GIT_PAGER='rm …' git log`, `$env:GIT_SSH_COMMAND=…; git fetch`.
  for (const part of command.trim().split(SPLIT)) if (runsProgramIndirectly(part)) return true;
  const entries = denylist
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .map((e) => ({ raw: e, words: e.endsWith("*") ? [] : commandWords(e) }));
  const parts = command.trim().split(SPLIT).filter(Boolean);
  const denied = (part: string, backslashIsPath: boolean): boolean => {
    const words = commandWords(part, backslashIsPath);
    // `npx rimraf dist`, `pnpm dlx …`: the package is the program.
    const runner = words[0] === "npx" || words[0] === "bunx" || words[0] === "pnpx";
    const dlx = (words[0] === "pnpm" || words[0] === "yarn") && words[1] === "dlx";
    if (runner || dlx) {
      const rest = words.slice(dlx ? 2 : 1);
      while (rest[0]?.startsWith("-")) rest.shift();
      return rest.length > 0 && denied(rest.join(" "), backslashIsPath);
    }
    const [program = "", ...rest] = words;
    if (!program) return false;
    const lowerRest = rest.map((w) => w.toLowerCase());
    // Checking the project's own server (`curl http://localhost:3000/about`) is reading, not
    // downloading: allowed when every address is local and nothing is saved or sent (D163).
    if (LOCAL_FETCHERS.has(program) && localFetchOnly(lowerRest)) return false;
    if (INTERPRETERS.has(program) && lowerRest.some((w) => INLINE_CODE.test(w))) return true;
    if (program === "xargs") return true;
    if (program === "find" && lowerRest.some((w) => /^-(?:delete|exec|execdir|ok|okdir)$/.test(w)))
      return true;
    const joined = words.join(" ").toLowerCase();
    return entries.some(({ raw, words: e }) => {
      if (raw.endsWith("*")) return joined.startsWith(raw.slice(0, -1));
      if (e[0] !== program) return false;
      if (e.length === 1) return true;
      if (e[1] !== lowerRest[0]) return false;
      return e.slice(2).every((w) => lowerRest.slice(1).includes(w));
    });
  };
  // A backslash in the program: a Windows folder (`C:\\Windows\\taskkill.exe`) or bash's escape
  // (`r\\m`): either reading denied asks.
  return parts.some((p) => denied(p, true) || denied(p, false));
}

/**
 * Dev servers and watchers that models start in the foreground (where they'd be stopped at the
 * timeout and look as if they failed): run in the background even without `background: true`.
 */
export function looksLikeServer(command: string): boolean {
  const last =
    command
      .trim()
      .split(/\s*(?:&&|;|\|\|)\s*/)
      .pop() ?? "";
  if (/\s(?:--version|-v|--help|-h)\b/.test(last)) return false;
  return (
    /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch)\b/i.test(last) ||
    /^(?:npx\s+|bunx\s+)?(?:vite(?!\s+(?:build|optimize)\b)|next\s+dev|nuxt\s+dev|astro\s+dev|webpack\s+serve|nodemon|live-server|http-server|serve)(?:\s|$)/i.test(
      last,
    ) ||
    /^python3?\s+-m\s+http\.server\b/i.test(last) ||
    /^(?:flask\s+run|uvicorn|php\s+-S|rails\s+s(?:erver)?|hugo\s+server|jekyll\s+serve)\b/i.test(
      last,
    ) ||
    /\s--watch\b/.test(last)
  );
}

/** Programs that delete files (agent.deleteProtection, D179). */
export const DELETE_COMMANDS: readonly string[] = [
  "rm",
  "rmdir",
  "del",
  "erase",
  "rd",
  "Remove-Item",
  "ri",
  "unlink",
  "shred",
  "git clean",
  "git rm",
  "trash",
  "rimraf",
  "npx rimraf",
];

/**
 * Whether a command line may delete files: a delete program anywhere in it, or anything the
 * denylist checks can't see through (subshells, redirects into files, chained interpreters).
 * Deliberately cautious: with deletion protection on, a doubtful line asks.
 */
export function mayDeleteFiles(command: string): boolean {
  // find's -delete, rsync's --delete (and --delete-after…).
  return commandDenied(command, DELETE_COMMANDS) || /\s--?delete\b/.test(command);
}

/** git config keys whose value is a program (or shell line) git runs. */
const GIT_PROGRAM_KEY =
  /^(?:alias\..+|core\.(?:pager|editor|sshcommand|fsmonitor|hookspath|gitproxy|askpass)|sequence\.editor|diff\.external|gpg\.(?:.+\.)?program|pager\..+|.+\.(?:helper|textconv|command|cmd|clean|smudge|process|program|tool|path))$/;
/** Environment variables whose value a program runs (or that load code into it). */
const PROGRAM_ENV =
  /^(?:git_\w+|pager|editor|visual|lessopen|lessclose|ssh_askpass|bash_env|env|ld_preload|dyld_\w+|node_options|pythonstartup|prompt_command|sudo_askpass)$/;

/**
 * Whether a part of a command line runs a program that isn't its program word: git's `-c` with a
 * key that names a program, or such a variable set in front of it (bash) or before it (PowerShell).
 */
function runsProgramIndirectly(part: string): boolean {
  const text = part.trim().toLowerCase();
  // PowerShell: `$env:GIT_PAGER = 'rm …'`.
  const ps = /^\$env:([\w]+)\s*=/.exec(text);
  if (ps && PROGRAM_ENV.test(ps[1] ?? "")) return true;
  // bash: `NAME=value NAME2=value program …` (and `env NAME=value program`).
  for (const m of text.matchAll(/(?:^|\s)([a-z_][\w]*)=(?:'[^']*'|"[^"]*"|\S*)(?=\s|$)/g)) {
    const before = text.slice(0, m.index ?? 0).trim();
    const assignmentsOnly =
      before === "" ||
      /^(?:env(?:\s+-\S+)*\s*)?(?:[a-z_]\w*=(?:'[^']*'|"[^"]*"|\S*)\s*)*$/.test(before);
    if (assignmentsOnly && PROGRAM_ENV.test(m[1] ?? "")) return true;
  }
  // git -c key=value / -ckey=value / --config-env=key=var / --config-env key=var.
  if (!/(?:^|[\s\\/"'])git(?:\.exe)?["']?(?:\s|$)/.test(text)) return false;
  for (const m of text.matchAll(/(?:^|\s)(?:-c\s*|--config-env[=\s]\s*)["']?([\w.*-]+)=/g))
    if (GIT_PROGRAM_KEY.test(m[1] ?? "")) return true;
  return false;
}
