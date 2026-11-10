// The @-mentions added in D200 — @git, @commit, @branch, @chat (a past chat), @rules and
// @symbol — as the strings the composer keeps until a message is sent ("@commit <hash>
// <subject>"), their card labels, and the text helpers their context uses. DOM-free and tested;
// the context itself is gathered in extensions/agent/mentions.ts.

export type ContextMentionKind = "git" | "commit" | "branch" | "chat" | "rules" | "symbol";

/** The icons these cards use (a subset of the UI's icon names). */
export type MentionIcon =
  | "git-compare"
  | "history"
  | "git-branch"
  | "scroll-text"
  | "book-open"
  | "braces";

export interface ContextMention {
  id: `@${ContextMentionKind}`;
  label: string;
  description: string;
  icon: MentionIcon;
  /** Picked from a list after choosing it (a commit, a chat, a symbol). */
  needsPick?: boolean;
}

export const CONTEXT_MENTIONS: readonly ContextMention[] = [
  {
    id: "@git",
    label: "Git changes",
    description: "The uncommitted changes (the working tree's diff)",
    icon: "git-compare",
  },
  {
    id: "@commit",
    label: "Commit",
    description: "A commit's message and diff (pick one)",
    icon: "history",
    needsPick: true,
  },
  {
    id: "@branch",
    label: "Branch changes",
    description: "This branch's diff against the default branch",
    icon: "git-branch",
  },
  {
    id: "@chat",
    label: "Past chat",
    description: "Another chat's summary and transcript (pick one)",
    icon: "scroll-text",
    needsPick: true,
  },
  {
    id: "@rules",
    label: "Rules",
    description: "The project's rules files, in full, and when each applies",
    icon: "book-open",
  },
  {
    id: "@symbol",
    label: "Symbol",
    description: "A function, class or type's code (search by name)",
    icon: "braces",
    needsPick: true,
  },
];

export interface ParsedMention {
  kind: ContextMentionKind;
  /** The commit hash, chat id or `path:line`; "" for the plain ones. */
  arg: string;
  /** The subject, title or symbol name kept for the card. */
  name: string;
}

/** "@commit 1a2b3c Fix the build" → its parts; null for anything else. */
export function parseContextMention(value: string): ParsedMention | null {
  const m = /^@(git|commit|branch|chat|rules|symbol)(?:\s+(\S+)(?:\s+([\s\S]*))?)?$/.exec(value);
  if (!m) return null;
  return { kind: m[1] as ContextMentionKind, arg: m[2] ?? "", name: (m[3] ?? "").trim() };
}

export function formatContextMention(kind: ContextMentionKind, arg = "", name = ""): string {
  const clean = name.replace(/\s+/g, " ").trim();
  return [`@${kind}`, arg, clean].filter(Boolean).join(" ");
}

/** The card for a mention value: its label and icon (undefined: not one of these). */
export function contextMentionCard(
  value: string,
): { label: string; icon: MentionIcon } | undefined {
  const p = parseContextMention(value);
  if (!p) return undefined;
  const def = CONTEXT_MENTIONS.find((m) => m.id === `@${p.kind}`);
  if (!def) return undefined;
  const label =
    p.kind === "commit"
      ? `${p.arg.slice(0, 7)}${p.name ? ` ${p.name}` : ""}`
      : p.kind === "chat" || p.kind === "symbol"
        ? p.name || p.arg
        : def.label;
  return { label: label.slice(0, 60) || def.label, icon: def.icon };
}

/**
 * A long transcript for the prompt: its start (what the chat was about) and its end (where it
 * got to), within `limit` characters.
 */
export function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.25);
  const tail = limit - head;
  return `${text.slice(0, head)}\n\n… (${text.length - limit} characters left out) …\n\n${text.slice(-tail)}`;
}

/**
 * A symbol's code from its file: from its line to just before the next definition at the same or
 * a lower indent (or `maxLines`), with line numbers.
 */
export function symbolCode(text: string, line: number, maxLines = 120): string {
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, Math.min(lines.length - 1, line - 1));
  const indent = (s: string) => /^\s*/.exec(s)?.[0].length ?? 0;
  const own = indent(lines[start] ?? "");
  let end = start + 1;
  for (; end < lines.length && end - start < maxLines; end++) {
    const l = lines[end] ?? "";
    if (!l.trim()) continue;
    // Back at the definition's indent: a closing brace ends it (kept), anything else starts the next.
    if (indent(l) <= own) {
      if (/^\s*[}\])]/.test(l) || /^\s*end\b/.test(l)) end++;
      break;
    }
  }
  while (end > start + 1 && !lines[end - 1]?.trim()) end--;
  return lines
    .slice(start, end)
    .map((l, i) => `${start + i + 1}: ${l}`)
    .join("\n");
}

/**
 * A unified diff without the files `hidden` says the agent may not see (D200: .aiignore and the
 * default secrets also hold for @git, @branch and @commit). Each file's section starts at its
 * `diff --git a/… b/…` line; dropped files are named, so the model knows something was left out.
 */
export function withoutHiddenFiles(diff: string, hidden: (path: string) => boolean): string {
  const parts = diff.split(/^(?=diff --git )/m);
  const left: string[] = [];
  const kept = parts.filter((part) => {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part);
    if (!m?.[2]) return true;
    if (hidden(m[2]) || hidden(m[1] ?? "")) {
      left.push(m[2]);
      return false;
    }
    return true;
  });
  const out = kept.join("");
  return left.length ? `${out}\n(Left out, excluded from the agent: ${left.join(", ")})` : out;
}
