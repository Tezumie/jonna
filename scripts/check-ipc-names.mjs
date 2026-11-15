// Every backend command the front end calls by name must exist on the Rust side: a typo in a
// wrapper (`call<void>("fs_wirte", …)`) otherwise only shows when that one call runs. The names
// come from the literal first argument of `call(...)` in src/core/ipc (and anywhere else that
// imports `call`, which is itself a failure: wrappers live in src/core/ipc); the commands from
// the COMMANDS list in src-tauri/build.rs, the one list every registered command must be in
// (check-commands.mjs holds that side). Commands no front-end file calls are listed, not failed:
// injected pages call some of them.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const slashes = (path) => path.split("\\").join("/");

/** The names in build.rs's `const COMMANDS: &[&str] = &[ "a", "b", ];`. */
export function rustCommands(buildRs) {
  const start = buildRs.indexOf("const COMMANDS");
  if (start < 0) throw new Error("src-tauri/build.rs has no COMMANDS list");
  const open = buildRs.indexOf("&[", buildRs.indexOf("=", start));
  const close = buildRs.indexOf("];", open);
  if (open < 0 || close < 0) throw new Error("src-tauri/build.rs: COMMANDS isn't a `&[ … ];` list");
  // Line comments may sit between the names.
  const body = buildRs.slice(open + 2, close).replace(/\/\/.*$/gm, "");
  return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** The local names `call` is imported under from the invoke module ("call", "invokeCall"). */
function callNames(source) {
  const names = [];
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*\/invoke"/g)) {
    for (const part of m[1].split(",")) {
      const [imported, local] = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/);
      if (imported === "call") names.push(local ?? imported);
    }
  }
  return names;
}

/** `source` with its comments blanked (same length, same lines): prose says "call (the …)" too. */
export function withoutComments(source) {
  let out = "";
  let quote = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      out += ch;
      if (ch === "\\") out += source[++i] ?? "";
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
    } else if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i++;
      }
      i--;
    } else if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? source.length : end + 2;
      for (; i < stop; i++) out += source[i] === "\n" ? "\n" : " ";
      i--;
    } else out += ch;
  }
  return out;
}

/**
 * Each `name<…>(first, …)` in `source`: the first argument when it is a string literal
 * (`command`), or what stands there instead (`dynamic`: a wrapper passing its own parameter on).
 */
export function callSites(source, names) {
  const sites = [];
  if (!names.length) return sites;
  source = withoutComments(source);
  const finder = new RegExp(`(?<![.\\w$])(?:${names.join("|")})(?![\\w$])`, "g");
  for (const m of source.matchAll(finder)) {
    let at = m.index + m[0].length;
    const skipSpace = () => {
      while (/\s/.test(source[at] ?? "")) at++;
    };
    skipSpace();
    if (source[at] === "<") {
      // The type arguments: nested `<…>`, and `=>` inside a function type isn't a closer.
      let depth = 0;
      for (; at < source.length; at++) {
        const ch = source[at];
        if (ch === "<") depth++;
        else if (ch === ">" && source[at - 1] !== "=") {
          depth--;
          if (depth === 0) {
            at++;
            break;
          }
        }
      }
      skipSpace();
    }
    if (source[at] !== "(") continue; // an import, a definition's name, a mention
    at++;
    skipSpace();
    const line = source.slice(0, m.index).split("\n").length;
    const literal = /^(["'`])([^"'`\\$]*)\1/.exec(source.slice(at, at + 200));
    if (literal) sites.push({ line, command: literal[2] });
    else sites.push({ line, dynamic: /^[\w$.]*/.exec(source.slice(at, at + 60))?.[0] ?? "" });
  }
  return sites;
}

async function sourceFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(path);
  }
  return found;
}

async function main() {
  const commands = rustCommands(await readFile(join(root, "src-tauri/build.rs"), "utf8"));
  const known = new Set(commands);
  const called = new Map(); // name -> first "file:line"
  const problems = [];
  let sites = 0;
  let passedOn = 0;
  for (const file of await sourceFiles(join(root, "src"))) {
    const rel = slashes(relative(root, file));
    const source = await readFile(file, "utf8");
    const inFolder = rel.startsWith("src/core/ipc/");
    // In the folder `call` is also a file's own wrapper around the imported one (git.ts adds
    // the repository to every call), and the definition itself.
    const names = [...new Set([...callNames(source), ...(inFolder ? ["call"] : [])])];
    for (const site of callSites(source, names)) {
      // `function call<T>(command: string, …)`: the definition; `invokeCall<T>(cmd, …)`: a
      // file's own wrapper passing its parameter on (its callers' literals are checked).
      if (site.dynamic === "command" || site.dynamic === "cmd") {
        passedOn++;
        continue;
      }
      if (!inFolder) {
        problems.push(
          `${rel}:${site.line}: a raw backend call outside src/core/ipc (add a wrapper there)`,
        );
        continue;
      }
      sites++;
      if (site.dynamic !== undefined) {
        problems.push(
          `${rel}:${site.line}: the command name isn't a string literal (${site.dynamic || "?"}): this check can't see it`,
        );
        continue;
      }
      if (!called.has(site.command)) called.set(site.command, `${rel}:${site.line}`);
      if (!known.has(site.command))
        problems.push(
          `${rel}:${site.line}: "${site.command}" is not a backend command (src-tauri/build.rs COMMANDS)`,
        );
    }
  }
  if (sites === 0) problems.push("no backend calls found in src/core/ipc: the scan is broken");
  if (problems.length) {
    console.error(`ipc names: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  const uncalled = commands.filter((c) => !called.has(c));
  console.log(
    `ipc names: ok (${sites} calls, ${called.size} commands, all among the backend's ${commands.length}; ${passedOn} wrappers pass a name on)`,
  );
  if (uncalled.length)
    console.log(
      `ipc names: ${uncalled.length} backend command(s) no front-end file calls (fine when a page of the backend's own does): ${uncalled.join(", ")}`,
    );
}

// Run as a script; importable (the functions above) without running.
if (process.argv[1] && slashes(process.argv[1]) === slashes(fileURLToPath(import.meta.url)))
  await main();
