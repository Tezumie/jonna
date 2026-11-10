// Files the agent may not see (D199): `.aiignore` / `.cursorignore` in gitignore syntax, the
// `agent.ignoreFiles` setting, and defaults for secrets (.env files, private keys, credentials).
// The last rule that matches decides (`!` brings a file back), as in .gitignore; a rule that
// matches a folder covers everything in it. Paths are folder-relative with `/`. DOM-free, tested.
import { globToRegExp } from "../paths/glob";

/** On unless agent.ignoreDefaults is false. Examples (.env.example…) stay visible. */
export const DEFAULT_AGENT_IGNORE: readonly string[] = [
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "!.env.dist",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "*.jks",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  "!*.pub",
  ".netrc",
  ".pgpass",
  "credentials.json",
  ".aws/credentials",
  ".docker/config.json",
  "secrets.json",
  "*.secret",
  "*.secrets",
];

interface Rule {
  negate: boolean;
  dirOnly: boolean;
  regex: RegExp;
  /** The rule as written (for messages). */
  source: string;
}

/** One gitignore line as a rule (null: blank or a comment). */
export function parseIgnoreLine(line: string): Rule | null {
  let text = line.replace(/\r$/, "");
  // Trailing spaces don't count unless escaped.
  text = text.replace(/(?<!\\)\s+$/, "");
  if (!text || text.startsWith("#")) return null;
  let negate = false;
  if (text.startsWith("!")) {
    negate = true;
    text = text.slice(1);
  } else if (text.startsWith("\\!") || text.startsWith("\\#")) text = text.slice(1);
  const dirOnly = text.endsWith("/");
  if (dirOnly) text = text.replace(/\/+$/, "");
  if (!text) return null;
  // A slash anywhere but the end anchors the pattern to the folder; otherwise it matches a name at
  // any depth.
  const anchored = text.includes("/");
  const body = text.replace(/^\/+/, "");
  const glob = anchored ? body : `**/${body}`;
  try {
    // Case-insensitive everywhere: on Windows and macOS `.ENV` opens `.env`, and excluding a
    // little more on Linux is the safe side for a secrets guard.
    const re = globToRegExp(glob);
    return { negate, dirOnly, regex: new RegExp(re.source, "i"), source: line.trim() };
  } catch {
    return null;
  }
}

export class AgentIgnore {
  private readonly rules: Rule[];

  constructor(lines: readonly string[]) {
    this.rules = lines.map(parseIgnoreLine).filter((r): r is Rule => r !== null);
  }

  get size(): number {
    return this.rules.length;
  }

  /**
   * Whether `relative` (folder-relative, `/`) is excluded: the last rule matching it or one of
   * the folders it's in decides.
   */
  ignored(relative: string, isDir = false): boolean {
    // Windows spellings of the same file: `.env.`, `.env `, `.env::$DATA` (a stream) open `.env`.
    const parts = relative
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .replace(/^\/+/, "")
      .split("/")
      .filter((s) => s && s !== ".")
      .map((s) => s.replace(/:.*$/, "").replace(/[. ]+$/, "") || s);
    const path = parts.join("/");
    if (!path) return false;
    // The folders it's in, then itself.
    const candidates: { path: string; dir: boolean }[] = [];
    for (let i = 1; i < parts.length; i++)
      candidates.push({ path: parts.slice(0, i).join("/"), dir: true });
    candidates.push({ path, dir: isDir });
    let result = false;
    for (const c of candidates) {
      // A folder that's excluded can't have files brought back inside it (git's rule).
      if (result && c.dir) return true;
      for (const r of this.rules)
        if ((!r.dirOnly || c.dir) && r.regex.test(c.path)) result = !r.negate;
      if (result && c.dir && c !== candidates[candidates.length - 1]) return true;
    }
    return result;
  }
}
