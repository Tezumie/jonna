// Per-category auto-approve (D204), one settings shape for everything the agent may be asked
// about, after VS Code's chat.tools.*.autoApprove maps: `agent.autoApprove` is
//
//   {
//     "reads":    { "**/.env*": false },                    paths: false asks before reading
//     "edits":    { "**/.vscode/*.json": false },           paths: false asks before writing
//     "browser":  { "localhost": true, "*.bank.com": false } domains of the page or address
//     "web":      { "docs.rs": true, "*.github.com": true } domains web.fetch / web.search read
//     "commands": { "npm test": true, "git push": false, "/^cargo (build|test)\\b/": true },
//     "mcp":      { "github": true, "github/create_issue": false, "*/search*": true }
//   }
//
// Each entry maps a pattern to true (go ahead without asking) or false (always ask, even with
// full access). The most specific matching pattern wins; on a tie, false wins. No match: the
// category's usual behaviour (reads and edits don't ask; the rest follow the run mode). A path
// with a leading `/` is anchored at the folder's root, and one exact file beats any glob: that's
// what "Always" on a question saves (`/src/.env`; a domain for the browser and web, D207).
// DOM-free and tested; extensions/agent/autoApprove.ts applies it.
import { globToRegExp } from "../paths/glob";

export type ApproveCategory = "reads" | "edits" | "browser" | "web" | "commands" | "mcp";

export const APPROVE_CATEGORIES: readonly ApproveCategory[] = [
  "reads",
  "edits",
  "commands",
  "browser",
  "web",
  "mcp",
];

export type ApproveRules = Partial<Record<ApproveCategory, Record<string, boolean>>>;

export type ApproveDecision = "allow" | "ask" | null;

/** The setting's value, cleaned (unknown categories and non-boolean values dropped). */
export function readApproveRules(value: unknown): ApproveRules {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: ApproveRules = {};
  for (const category of APPROVE_CATEGORIES) {
    const map = (value as Record<string, unknown>)[category];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    const clean: Record<string, boolean> = {};
    for (const [pattern, allow] of Object.entries(map as Record<string, unknown>))
      if (typeof allow === "boolean" && pattern.trim()) clean[pattern.trim()] = allow;
    out[category] = clean;
  }
  return out;
}

/** A host from an address or a bare host ("https://docs.rs/x" → "docs.rs"). */
export function hostOf(subject: string): string {
  const s = subject.trim().toLowerCase();
  try {
    // A trailing dot is the same host (`www.bank.com.`): without it dropped, `*.bank.com` didn't
    // match and an Ask domain was a way around the question.
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(s))
      return new URL(s).hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {}
  return s
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/:?#].*$/, "")
    .replace(/\.$/, "");
}

/**
 * How well `pattern` matches `subject` in `category`: null for no match, else a specificity
 * (longer, more literal patterns are more specific).
 */
export function matchScore(
  category: ApproveCategory,
  pattern: string,
  subject: string,
  /** Commands: compare a prefix without case (what an Ask pattern does: `GIT push` is git push). */
  foldCase = false,
): number | null {
  const p = pattern.trim();
  if (!p) return null;
  const literal = p.replace(/[*?]/g, "").length;
  switch (category) {
    case "reads":
    case "edits": {
      const path = subject.replace(/\\/g, "/").replace(/^\.\//, "");
      let glob = p.replace(/\\/g, "/").replace(/^\.\//, "");
      // A leading `/` anchors it at the folder's root, as in .gitignore (D207: what "Always"
      // writes, `/src/.env`); a pattern without a `/` matches the name in any folder (`.env`).
      const anchored = glob.startsWith("/");
      if (anchored) glob = glob.replace(/^\/+/, "");
      const inFolder = anchored || glob.includes("/");
      // One exact file is more specific than any glob that also matches it.
      if (inFolder && !/[*?[\]{}]/.test(glob))
        return glob.toLowerCase() === path.toLowerCase() ? 1e6 : null;
      const full = inFolder ? glob : `**/${glob}`;
      // Case-insensitive, as Windows and macOS file systems are.
      const re = globToRegExp(full);
      return new RegExp(re.source, re.flags.includes("i") ? re.flags : `${re.flags}i`).test(path)
        ? literal
        : null;
    }
    case "browser":
    case "web": {
      const host = hostOf(subject);
      const want = hostOf(p);
      if (!host) return null;
      if (want === "*") return 0;
      if (want.startsWith("*.")) {
        const base = want.slice(2);
        return host === base || host.endsWith(`.${base}`) ? literal : null;
      }
      return host === want || host.endsWith(`.${want}`) ? literal + (host === want ? 1 : 0) : null;
    }
    case "commands": {
      const re = /^\/(.+)\/([a-z]*)$/.exec(p);
      // Runs of spaces or tabs are one separator to the shell: `git  push` is `git push`.
      const fold = (s: string) => {
        const one = s.replace(/\s+/g, " ");
        return foldCase && !re ? one.toLowerCase() : one;
      };
      const line = fold(subject.trim());
      if (re) {
        try {
          return new RegExp(re[1] ?? "", re[2]?.replace(/[^imsu]/g, "")).test(line)
            ? literal
            : null;
        } catch {
          return null;
        }
      }
      const prefix = fold(p);
      if (prefix.endsWith("*")) return line.startsWith(prefix.slice(0, -1)) ? literal : null;
      return line === prefix || line.startsWith(`${prefix} `) ? literal : null;
    }
    case "mcp": {
      // "server", "server/tool" (or "server__tool"), with * wildcards.
      const subj = subject.replace("__", "/");
      const pat = p.replace("__", "/");
      const whole = pat.includes("/") ? pat : `${pat}/*`;
      const re = new RegExp(
        `^${whole
          .split("*")
          .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
        "i",
      );
      return re.test(subj) ? literal : null;
    }
  }
}

/**
 * The decision for `subject` (a workspace-relative path, an address or host, a command line, or
 * "server/tool"): "allow", "ask" or null (no rule matches).
 */
export function approveDecision(
  rules: ApproveRules,
  category: ApproveCategory,
  subject: string,
): ApproveDecision {
  const map = rules[category];
  if (!map) return null;
  let best: { score: number; allow: boolean } | null = null;
  for (const [pattern, allow] of Object.entries(map)) {
    // An Ask command matches without case (Windows runs `GIT push` as git push); Allow stays exact.
    const score = matchScore(category, pattern, subject, !allow);
    if (score === null) continue;
    if (!best || score > best.score || (score === best.score && !allow)) best = { score, allow };
  }
  return best ? (best.allow ? "allow" : "ask") : null;
}

/**
 * The pattern an "Always" answer saves (D207): the exact file, anchored at the folder's root
 * (`/src/.env`: more specific than the glob that asked, and only that file), or the page's
 * domain for the browser and the web. Null when there's nothing to save.
 */
export function alwaysPattern(category: ApproveCategory, subject: string): string | null {
  switch (category) {
    case "reads":
    case "edits": {
      const path = subject
        .replace(/\\/g, "/")
        .replace(/^(\.\/)+/, "")
        .replace(/^\/+/, "");
      return path && path !== "." && !path.startsWith("../") ? `/${path}` : null;
    }
    case "browser":
    case "web":
      return hostOf(subject) || null;
    default:
      return null;
  }
}

/** The rules with `pattern` set to allow in `category`. */
export function withAllowed(
  rules: ApproveRules,
  category: ApproveCategory,
  pattern: string,
): ApproveRules {
  return { ...rules, [category]: { ...(rules[category] ?? {}), [pattern]: true } };
}

/**
 * A command line is allowed by the rules only when every part of a chain (`&&`, `;`, `|`) is,
 * and it asks when any part asks: `npm test && git push` isn't `npm test`.
 */
export function commandDecision(rules: ApproveRules, line: string): ApproveDecision {
  const parts = line
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  // Substitutions and redirects run more than the line says: never allowed by a pattern.
  // So do (outside quotes) a background `&` or a newline (a second command the split above
  // doesn't see: `npm test & rm -rf ~`) and groups, which PowerShell evaluates inside arguments
  // (`npm test (Remove-Item src)`) — the same structure agent.allowedCommands refuses.
  const bare = line
    .replace(/'[^']*'|"[^"]*"/g, "''")
    .replace(/\d?>&\d/g, "")
    .replace(/&&/g, "");
  const risky = /[`$]\(|`|[<>]/.test(line.replace(/\d?>&\d/g, "")) || /[\r\n]|&|[(){}]/.test(bare);
  // Ask patterns also see the parts a background `&` or a newline separates (`ls & git push`).
  const askParts = line
    .replace(/\d?>&\d/g, "")
    .split(/\s*(?:&&|\|\||;|\||&|[\r\n]+)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  const each = parts.map((p) => approveDecision(rules, "commands", p));
  // A regular expression may be written for the whole line, but only to ask: an unanchored
  // `/^cargo test/` matches `cargo test && rm -rf ~` too, so allowing needs every part.
  const regexOnly: ApproveRules = {
    commands: Object.fromEntries(
      Object.entries(rules.commands ?? {}).filter(([p]) => /^\/.+\/[a-z]*$/.test(p)),
    ),
  };
  const whole = parts.length > 1 ? approveDecision(regexOnly, "commands", line.trim()) : null;
  if (
    each.includes("ask") ||
    whole === "ask" ||
    askParts.some((p) => approveDecision(rules, "commands", p) === "ask")
  )
    return "ask";
  if (risky) return null;
  if (each.every((d) => d === "allow")) return "allow";
  return null;
}

/** What a category's patterns are, for the page and command descriptions. */
export const CATEGORY_INFO: Record<
  ApproveCategory,
  { title: string; pattern: string; example: string; lead: string }
> = {
  reads: {
    title: "Reading files",
    pattern: "Path glob",
    example: "**/.env*",
    lead: "Reading files in the folder doesn't ask. Add a path with Ask to protect it (secrets, keys).",
  },
  edits: {
    title: "Editing files",
    pattern: "Path glob",
    example: "**/.vscode/*.json",
    lead: "Edits are written and kept for review. A path set to Ask asks before the agent writes it; Allow lets it change it even with Ask before every edit.",
  },
  commands: {
    title: "Running commands",
    pattern: "Command prefix, prefix* or /regex/",
    example: "npm test",
    lead: "Allow runs a command without asking; Ask always asks (as agent.allowedCommands and agent.deniedCommands do, which still count).",
  },
  browser: {
    title: "Browser",
    pattern: "Domain (*.example.com)",
    example: "localhost",
    lead: "The agent's clicks, typing and navigation in the browser tab, by the page's domain.",
  },
  web: {
    title: "Web pages and search",
    pattern: "Domain (*.example.com)",
    example: "docs.rs",
    lead: "Pages the agent reads with web fetch, by domain.",
  },
  mcp: {
    title: "MCP tools",
    pattern: "server or server/tool (* wildcards)",
    example: "github/create_issue",
    lead: "Allow runs a server's tools without asking; Ask asks even for read-only tools.",
  },
};
