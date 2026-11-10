// Command suggestions while typing at a prompt (VS Code's terminal IntelliSense): where the cursor
// is in the command line (a program to run, or an argument), what to offer there (programs on
// PATH, shell builtins, history, files and folders, git subcommands and branches), how well each
// matches what's typed, and the text that replaces it. DOM-free and tested; suggestWidget.ts
// shows them.

export type ShellFamily = "posix" | "fish" | "pwsh" | "cmd";

export type SuggestionKind =
  | "command"
  | "builtin"
  | "alias"
  | "function"
  | "history"
  | "folder"
  | "file"
  | "git-command"
  | "git-branch";

export interface Suggestion {
  label: string;
  kind: SuggestionKind;
  /** The text that replaces `replaceFrom`…cursor. */
  insert: string;
  /** Where the replaced text starts in the line (the token, or the whole command for history). */
  replaceFrom: number;
  score: number;
  /** More about it for the details pane (what an alias runs, a function's definition). */
  detail?: string;
}

/** One of the user's aliases or functions, as their shell reported it (D229). */
export interface ShellGlobal {
  name: string;
  kind: "alias" | "function";
  /** What an alias runs; a function's definition (PowerShell). */
  detail?: string;
}

/** The marker line Rust's probe prints before the aliases and before the functions. */
const GLOBALS_MARK = "--shell-globals--";

/** A shell word written as `alias` prints it ('ls -l', 'it'\''s') with its quotes undone. */
function unquoteAliasValue(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'"))
    return v.slice(1, -1).replaceAll("'\\''", "'");
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

/**
 * The aliases and functions in what the probe printed (`pty::globals`): PowerShell's
 * `Get-Command` lines (`Alias<TAB>ll<TAB>Get-ChildItem`), or `alias` output (bash `alias ll='ls
 * -l'`, zsh `ll='ls -l'`, fish `alias ll 'ls -l'`) then function names. Helper functions (`_…`)
 * and names that can't be typed as a command are left out.
 */
export function parseShellGlobals(text: string, family: ShellFamily): ShellGlobal[] {
  const out: ShellGlobal[] = [];
  const seen = new Set<string>();
  const push = (g: ShellGlobal) => {
    if (!g.name || g.name.startsWith("_") || /[\s:/\\]/.test(g.name) || seen.has(g.name)) return;
    seen.add(g.name);
    out.push(g);
  };
  const parts = text.split(/\r?\n/);
  const start = parts.findIndex((l) => l.trim() === GLOBALS_MARK);
  if (start < 0) return out;
  const lines = parts.slice(start + 1);
  if (family === "pwsh") {
    for (const line of lines) {
      const [kind, name, definition] = line.split("\t");
      if (!name || (kind !== "Alias" && kind !== "Function")) continue;
      const def = definition?.trim();
      push({
        name,
        kind: kind === "Alias" ? "alias" : "function",
        ...(def && { detail: def }),
      });
    }
    return out;
  }
  const split = lines.findIndex((l) => l.trim() === GLOBALS_MARK);
  const aliases = split < 0 ? lines : lines.slice(0, split);
  const functions = split < 0 ? [] : lines.slice(split + 1);
  for (const line of aliases) {
    const m =
      /^alias\s+([^=\s]+)=(.*)$/.exec(line) ??
      /^alias\s+(\S+)\s+(.+)$/.exec(line) ??
      /^([^=\s'"]+)=(.*)$/.exec(line);
    if (!m?.[1]) continue;
    const value = unquoteAliasValue(m[2] ?? "");
    push({ name: m[1], kind: "alias", ...(value && { detail: value }) });
  }
  for (const line of functions)
    for (const name of line.split(/[,\s]+/)) if (name) push({ name, kind: "function" });
  return out;
}

/** The command line around the cursor, as `completionContext` reads it. */
export interface CompletionContext {
  /** Where the token being typed starts. */
  tokenStart: number;
  /** The token as typed (quotes included). */
  raw: string;
  /** The token's text (quotes and escapes undone). */
  token: string;
  /** The quote the token is inside, if it's unfinished. */
  quote: '"' | "'" | null;
  /** Words of the current command before the token (after the last |, &&, ||, ;). */
  words: string[];
  /** Where the current command starts in the line. */
  commandStart: number;
  position: "command" | "argument";
}

/** The shell family from a shell's program path. */
export function shellFamily(shell: string): ShellFamily {
  const name = (shell.split(/[\\/]/).pop() ?? shell).toLowerCase().replace(/\.exe$/, "");
  if (name === "pwsh" || name === "powershell") return "pwsh";
  if (name === "cmd") return "cmd";
  if (name === "fish") return "fish";
  return "posix";
}

/** Reads the command line before the cursor: the token being typed and the words before it. */
export function completionContext(
  line: string,
  cursor: number,
  family: ShellFamily = "posix",
): CompletionContext {
  const text = line.slice(0, cursor);
  const esc = family === "pwsh" ? "`" : family === "cmd" ? "^" : "\\";
  let words: string[] = [];
  let commandStart = 0;
  let tokenStart = -1;
  let token = "";
  let quote: '"' | "'" | null = null;
  const endWord = () => {
    if (tokenStart >= 0) words.push(token);
    tokenStart = -1;
    token = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (quote) {
      if (c === quote) quote = null;
      else if (c === esc && quote === '"' && i + 1 < text.length) token += text[++i] ?? "";
      else token += c;
      continue;
    }
    if (c === esc && i + 1 < text.length && family !== "cmd") {
      if (tokenStart < 0) tokenStart = i;
      token += text[++i] ?? "";
      continue;
    }
    if (c === '"' || c === "'") {
      if (tokenStart < 0) tokenStart = i;
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      endWord();
      continue;
    }
    if (c === "|" || c === ";" || c === "&") {
      endWord();
      words = [];
      commandStart = i + 1;
      while (/[|&;\s]/.test(text[commandStart] ?? "x") && commandStart < text.length)
        commandStart++;
      continue;
    }
    if (tokenStart < 0) tokenStart = i;
    token += c;
  }
  if (tokenStart < 0) tokenStart = cursor;
  // Variables before the program (`FOO=1 npm …`) aren't the program.
  const programWords = words.filter((w, i) => !(i === 0 && /^[A-Za-z_]\w*=/.test(w)));
  return {
    tokenStart,
    raw: text.slice(tokenStart),
    token,
    quote,
    words: programWords,
    commandStart,
    position: programWords.length === 0 ? "command" : "argument",
  };
}

/**
 * How well `label` matches `query` (higher is better, -1 for no match): a prefix beats a match
 * further in, a case-exact prefix beats one in another case, shorter labels first. Other matches
 * need the query's characters in order, starting at the label's start or after a separator.
 */
export function matchScore(label: string, query: string): number {
  if (!query) return 100 - Math.min(label.length, 99) / 100;
  const l = label.toLowerCase();
  const q = query.toLowerCase();
  if (l.startsWith(q)) {
    const exact = label.startsWith(query) ? 50 : 0;
    return 1000 + exact - Math.min(label.length, 200);
  }
  // In order, each character after the previous one; the first at a word start.
  let at = -1;
  let gaps = 0;
  for (const ch of q) {
    const next = l.indexOf(ch, at + 1);
    if (next < 0) return -1;
    if (at >= 0) gaps += next - at - 1;
    else if (next > 0 && !/[-_./\\ ]/.test(l[next - 1] ?? "")) return -1;
    at = next;
  }
  return 500 - gaps * 5 - Math.min(label.length, 200) / 10;
}

const POSIX_BUILTINS = (
  "alias bg bind builtin cd command declare dirs echo eval exec exit export false fg hash " +
  "help history jobs kill let local logout popd printf pushd pwd read readonly return set " +
  "shift shopt source test times trap true type ulimit umask unalias unset wait which"
).split(" ");
const FISH_BUILTINS = (
  "abbr alias begin builtin case cd command contains echo end exit fish_config for funced " +
  "funcsave function functions history if math printf read set set_color source status " +
  "string switch type while"
).split(" ");
const PWSH_BUILTINS = (
  "Clear-Host Copy-Item ForEach-Object Get-ChildItem Get-Command Get-Content Get-Help " +
  "Get-History Get-Item Get-Location Get-Module Get-Process Get-Service Import-Module " +
  "Invoke-History Invoke-RestMethod Invoke-WebRequest Measure-Object Move-Item New-Item " +
  "Out-File Pop-Location Push-Location Remove-Item Rename-Item Select-Object Select-String " +
  "Set-Content Set-ExecutionPolicy Set-Location Sort-Object Start-Process Stop-Process " +
  "Test-Path Where-Object Write-Host Write-Output cat cd cls copy cp dir echo exit gci ls " +
  "mkdir move mv pwd rm rmdir sl type"
).split(" ");
const CMD_BUILTINS = (
  "call cd cls copy del dir echo exit for if md mkdir move popd pushd rd ren rename rmdir " +
  "set start title type ver vol where"
).split(" ");

/** The builtins and common commands of a shell family. */
export function shellBuiltins(family: ShellFamily): readonly string[] {
  return family === "pwsh"
    ? PWSH_BUILTINS
    : family === "cmd"
      ? CMD_BUILTINS
      : family === "fish"
        ? FISH_BUILTINS
        : POSIX_BUILTINS;
}

export const GIT_SUBCOMMANDS = (
  "add am archive bisect blame branch bundle checkout cherry-pick clean clone commit config " +
  "describe diff fetch gc grep help init log ls-files merge mv notes pull push range-diff " +
  "rebase reflog remote reset restore rev-parse revert rm shortlog show sparse-checkout " +
  "stash status submodule switch tag worktree"
).split(" ");
/** Git subcommands whose arguments are often branch names. */
const GIT_TAKES_BRANCH = new Set(
  "branch checkout cherry-pick diff log merge pull push rebase reset show switch".split(" "),
);

/** What the context asks for. */
export interface SuggestNeeds {
  commands: boolean;
  /** List this folder (as typed: "", "src/", "~/x/", "C:\\a\\") for names starting with `base`. */
  paths: { dir: string; base: string } | null;
  git: "subcommand" | "branch" | null;
}

const isProgram = (word: string | undefined, name: string) =>
  !!word && (word === name || word.toLowerCase() === `${name}.exe`);

export function suggestNeeds(ctx: CompletionContext, family: ShellFamily): SuggestNeeds {
  const sep = family === "posix" || family === "fish" ? /\// : /[\\/]/;
  const split = (token: string) => {
    let cut = -1;
    for (let i = token.length - 1; i >= 0; i--)
      if (sep.test(token[i] ?? "")) {
        cut = i;
        break;
      }
    return { dir: token.slice(0, cut + 1), base: token.slice(cut + 1) };
  };
  if (ctx.position === "command") {
    // `./script`, `../bin/x`, `/usr/bin/…`: a path, not a program name.
    const pathLike = /[\\/]/.test(ctx.token) || ctx.token.startsWith(".");
    return { commands: !pathLike, paths: pathLike ? split(ctx.token) : null, git: null };
  }
  if (isProgram(ctx.words[0], "git")) {
    const rest = ctx.words.slice(1).filter((w) => !w.startsWith("-"));
    // `git -C dir …`: the folder isn't the subcommand.
    const ci = ctx.words.indexOf("-C");
    const sub = ci >= 0 ? ctx.words.slice(ci + 2).find((w) => !w.startsWith("-")) : rest[0];
    if (!sub && !ctx.token.startsWith("-"))
      return { commands: false, paths: null, git: "subcommand" };
    if (sub && GIT_TAKES_BRANCH.has(sub) && !ctx.token.startsWith("-"))
      return { commands: false, paths: split(ctx.token), git: "branch" };
  }
  if (ctx.token.startsWith("-")) return { commands: false, paths: null, git: null };
  return { commands: false, paths: split(ctx.token), git: null };
}

export interface SuggestSources {
  commands?: readonly string[];
  builtins?: readonly string[];
  /** The user's aliases and functions (D229). */
  globals?: readonly ShellGlobal[];
  /** Command lines run before, oldest first. */
  history?: readonly string[];
  /** The listed folder's entries (for `needs.paths`). */
  entries?: readonly { name: string; dir: boolean }[];
  branches?: readonly string[];
  /** The text of the line (history matches the whole command). */
  line?: string;
}

const NEEDS_QUOTING = /[\s'"$`&|;()<>*?!#~^%,{}[\]\\]/;

/** A word for the shell: quoted (or escaped) the shell's way when it has special characters. */
export function shellWord(word: string, family: ShellFamily, openQuote: '"' | "'" | null): string {
  if (openQuote) return word; // inside the user's quotes already
  // PowerShell also reads typographic quotes and dashes as ' " - (a file named "it’s.txt").
  const special = family === "pwsh" && /[@–-―‘-„]/.test(word);
  if (!special && !NEEDS_QUOTING.test(word.replace(/[\\/]/g, ""))) return word;
  if (family === "pwsh") return `'${word.replace(/['‘’‚‛]/g, "$&$&")}'`;
  if (family === "cmd") return `"${word}"`;
  return word.replace(/([\s'"$`&|;()<>*?!#~^%,{}[\]])/g, "\\$1");
}

const MAX_SHOWN = 50;

/** C0 controls and DEL: keys a shell acts on, never part of a word to type. */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The suggestions for a context, best first: `needs` decided what to gather, `sources` holds it.
 * Folders end with the separator (so typing goes on inside them); files and finished quotes get
 * the closing quote.
 */
export function rankSuggestions(
  ctx: CompletionContext,
  needs: SuggestNeeds,
  sources: SuggestSources,
  family: ShellFamily,
): Suggestion[] {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (
    label: string,
    kind: SuggestionKind,
    insert: string,
    from: number,
    query: string,
    detail?: string,
  ) => {
    const key = `${kind === "history" ? "h" : "x"}\u0000${label.toLowerCase()}`;
    if (seen.has(key)) return;
    // The insert is typed into the shell: a control character in it (a file named "x\rcmd", a
    // multi-line history entry) would press Enter, Tab or a readline key there.
    if (hasControlCharacter(insert)) return;
    const score = matchScore(label, query);
    if (score < 0) return;
    seen.add(key);
    const weight =
      kind === "folder" || kind === "git-command" || kind === "git-branch"
        ? 2
        : kind === "builtin" || kind === "alias" || kind === "function"
          ? 1
          : kind === "history"
            ? -300
            : 0;
    out.push({
      label,
      kind,
      insert,
      replaceFrom: from,
      score: score + weight,
      ...(detail && { detail }),
    });
  };
  if (needs.commands) {
    // The user's own first: an alias named like a builtin (`ls`) is what the shell runs.
    for (const g of sources.globals ?? [])
      add(
        g.name,
        g.kind,
        g.name,
        ctx.tokenStart,
        ctx.token,
        g.kind === "alias" && g.detail ? `Alias for ${g.detail}` : g.detail,
      );
    for (const b of sources.builtins ?? []) add(b, "builtin", b, ctx.tokenStart, ctx.token);
    for (const c of sources.commands ?? []) add(c, "command", c, ctx.tokenStart, ctx.token);
  }
  if (needs.git === "subcommand")
    for (const g of GIT_SUBCOMMANDS) add(g, "git-command", g, ctx.tokenStart, ctx.token);
  if (needs.git === "branch")
    for (const b of sources.branches ?? []) add(b, "git-branch", b, ctx.tokenStart, ctx.token);
  if (needs.paths && sources.entries) {
    const { dir, base } = needs.paths;
    const sep = family === "pwsh" || family === "cmd" ? (dir.includes("/") ? "/" : "\\") : "/";
    for (const e of sources.entries) {
      // A folder keeps its separator inside the quotes PowerShell's own completion adds.
      const full = `${dir}${e.name}${e.dir ? sep : ""}`;
      const word = shellWord(full, family, ctx.quote);
      const close = !e.dir && ctx.quote ? ctx.quote : "";
      const insert = `${ctx.quote ?? ""}${word}${close}`;
      // Matched on the name; the rest of the token is the folder it's in.
      if (matchScore(e.name, base) < 0) continue;
      add(
        e.dir ? `${e.name}${sep}` : e.name,
        e.dir ? "folder" : "file",
        insert,
        ctx.tokenStart,
        base,
      );
    }
  }
  // Command lines run before that start with what's typed of this command.
  const typed = (sources.line ?? "").slice(ctx.commandStart, ctx.tokenStart + ctx.raw.length);
  if (typed.trim()) {
    const lower = typed.toLowerCase();
    let shown = 0;
    for (const h of [...(sources.history ?? [])].reverse()) {
      if (shown >= 5) break;
      if (h.length <= typed.length || !h.toLowerCase().startsWith(lower)) continue;
      add(h, "history", h, ctx.commandStart, typed);
      shown++;
    }
  }
  out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return out.slice(0, MAX_SHOWN);
}

/**
 * The keys that make a suggestion the line's text: when the line already ends with the start of
 * the insert, only the rest; else backspaces over what was typed, then the insert.
 */
export function acceptKeys(line: string, cursor: number, s: Suggestion): string {
  const typed = line.slice(s.replaceFrom, cursor);
  if (s.insert.startsWith(typed)) return s.insert.slice(typed.length);
  return "\x7f".repeat([...typed].length) + s.insert;
}

/** Characters whose typing opens the suggestions even with nothing else typed yet. */
export function isTriggerCharacter(ch: string, family: ShellFamily): boolean {
  return ch === "/" || (ch === "\\" && (family === "pwsh" || family === "cmd"));
}
