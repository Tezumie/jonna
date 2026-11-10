// Generating a commit message (D174), the way VS Code's and the commit-message tools do it: the
// model sees the changed files with their counts first, then the diff with each file capped (one
// big file can't crowd out the rest; lockfiles and minified files are listed, not shown), and a
// few recent subjects to match the repository's style. Small local models still sometimes answer
// with a review of the diff ("### Key features…"): such a reply is detected and turned into a
// message by a second, format-only request; whatever comes back is cleaned of Markdown.
// DOM-free and tested.

/** git.busy while a message is being written (the button is a stop button then). */
export const WRITING_COMMIT_MESSAGE = "Writing a commit message…";

export const COMMIT_SYSTEM = [
  "You write git commit messages for the user's staged changes.",
  "Output ONLY the commit message, nothing else: no introduction, no analysis, no headings, no Markdown, no emoji, no questions.",
  'Summary line: imperative mood ("Add …", "Fix …", "Improve …"), at most 72 characters, no trailing period. It names the main themes of the change; two themes can share it, joined with ";".',
  'Then, when the commit holds more than one change, a blank line and one line per meaningful change starting with "- " (at most 12), most important first.',
  'Each line says concretely what changed and where, in the past tense ("Added …", "Updated …", "Fixed …", "Improved …"): name the feature, component or behaviour from the diff (a function, a setting, a view, a test), and why when the diff shows it. Prefer "Added a pin button to recent folders on the welcome page" over "Update welcome.ts".',
  "Never write a line that only repeats a file name or says a file was updated. Group small related edits into one line; leave out formatting-only changes.",
  'If the repository\'s recent commits (given below) consistently follow another style (a prefix like "feat:" or a version), follow it.',
].join("\n");

export const REWRITE_SYSTEM = [
  "You turn a description of code changes into a git commit message.",
  "Output ONLY the commit message: a summary line in the imperative mood, at most 72 characters, no trailing period;",
  'then, for more than one change, a blank line and one line per change starting with "- " (at most 12), each saying concretely what changed and where, in the past tense ("Added …", "Fixed …"). No headings, no Markdown, no emoji, no commentary.',
].join("\n");

/**
 * Characters of diff in all, and per file at most / at least: the budget is shared out over the
 * files (one big file can't leave the others as bare names, which gave "Update roadmap" lines).
 */
const TOTAL_LIMIT = 20_000;
const FILE_LIMIT = 4000;
const FILE_MIN = 700;
const NOISE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|bun\.lockb?|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.min\.(js|css)$|\.map$/;

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  text: string;
  binary: boolean;
}

/** A unified diff (`git diff`) split by file, with +/- counts. */
export function splitDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      current = { path: head[2] ?? head[1] ?? "", added: 0, removed: 0, text: "", binary: false };
      files.push(current);
    }
    if (!current) continue;
    current.text += `${line}\n`;
    if (line.startsWith("Binary files")) current.binary = true;
    else if (line.startsWith("+") && !line.startsWith("+++")) current.added++;
    else if (line.startsWith("-") && !line.startsWith("---")) current.removed++;
  }
  return files;
}

/** The request: branch, files with counts, recent subjects, then the capped diff. */
export function commitPrompt(input: {
  branch: string | null;
  diff: string;
  staged: boolean;
  recent?: readonly string[];
}): string {
  const files = splitDiff(input.diff);
  const out: string[] = [`Branch: ${input.branch ?? "(detached)"}`, ""];
  const recent = (input.recent ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (recent.length)
    out.push(
      "Recent commit messages in this repository (for style):",
      ...recent.map((s) => `- ${s}`),
      "",
    );
  if (!files.length) {
    // Not a git diff (or a single unparsed one): pass it on, capped.
    out.push(`${input.staged ? "Staged diff" : "Diff"}:`, input.diff.slice(0, TOTAL_LIMIT));
  } else {
    out.push(`Changed files (${files.length}):`);
    // Each file with the functions and sections its hunks touch (the "@@ … @@ context"), so a
    // file whose diff is cut still says what changed in it.
    for (const f of files)
      out.push(
        `- ${f.path}${f.binary ? " (binary)" : ` (+${f.added} -${f.removed})`}${hunkContext(f.text)}`,
      );
    out.push("", `${input.staged ? "Staged diff" : "Diff"}:`);
    let budget = TOTAL_LIMIT;
    let omitted = 0;
    const shown = files.filter((f) => !f.binary && !NOISE.test(f.path));
    let left = shown.length;
    for (const f of shown) {
      if (budget <= 200) {
        omitted++;
        left--;
        continue;
      }
      // An even share of what's left, so later files keep some room.
      const room = Math.min(FILE_LIMIT, budget, Math.max(FILE_MIN, Math.floor(budget / left)));
      left--;
      const text =
        f.text.length > room
          ? `${f.text.slice(0, room)}\n… (rest of this file's diff left out)\n`
          : f.text;
      out.push(text.trimEnd());
      budget -= text.length;
    }
    if (omitted)
      out.push(`… (${omitted} more file${omitted === 1 ? "" : "s"} left out; see the list above)`);
  }
  out.push("", "Write the commit message for these changes now. Output only the message.");
  return out.join("\n");
}

/** The hunk headers' context of a file's diff ("in: addRichProviders, Changes and safety"). */
export function hunkContext(text: string): string {
  const seen: string[] = [];
  for (const m of text.matchAll(/^@@[^@]*@@ ?(.*)$/gm)) {
    const ctx = (m[1] ?? "")
      .trim()
      .replace(/\s*\{\s*$/, "")
      .slice(0, 60);
    if (ctx && !seen.includes(ctx)) seen.push(ctx);
    if (seen.length >= 4) break;
  }
  return seen.length ? ` — in: ${seen.join("; ")}` : "";
}

/** Thinking, fences, quotes and a "Commit message:" label taken off. */
function strip(reply: string): string {
  let text = reply
    .replace(/\r\n/g, "\n")
    // A reasoning model's thoughts (closed, or still open while streaming) aren't the message.
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, "")
    .trim();
  const fence = /```[a-z]*\n([\s\S]*?)(\n```|$)/i.exec(text);
  if (fence?.[1]?.trim()) text = fence[1];
  return trimQuotes(
    text.replace(/^\s*(\*\*)?(suggested |proposed )?commit message:?(\*\*)?:?\s*/i, "").trim(),
  );
}

/** Quotes off both ends, without a regex (a long run of them would make one slow). */
function trimQuotes(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && "\"'`".includes(text[start] as string)) start++;
  while (end > start && "\"'`".includes(text[end - 1] as string)) end--;
  return text.slice(start, end).trim();
}

const CHATTER =
  /^(here('s| is| are)|sure|certainly|okay|ok,|the (diff|changes?|commit)|this (diff|change|commit)|i('ve| have| will)|below|based on)/i;

/**
 * Whether a reply is a commit message (a short first line that isn't a heading, a bullet or a
 * sentence about the diff), not an analysis of the changes.
 */
export function looksLikeCommitMessage(reply: string): boolean {
  const text = strip(reply);
  if (!text) return false;
  const lines = text.split("\n");
  const first = lines[0]?.trim() ?? "";
  if (!first || first.length > 100) return false;
  if (/^(#|[-*•]|\d+\.\s|>|---|\|)/.test(first) || CHATTER.test(first)) return false;
  if (/[\u{1F300}-\u{1FAFF}✅✨]/u.test(text)) return false;
  // Headings or a long, sectioned answer further down: an analysis.
  if (lines.some((l) => /^#{1,6}\s/.test(l.trim()))) return false;
  return lines.length <= 30;
}

/** A reply as a commit message: Markdown and emoji off, the summary line at most 72 characters. */
export function cleanCommitMessage(reply: string): string {
  const lines = strip(reply)
    .split("\n")
    .map((l) =>
      l
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
        .replace(/\u{FE0F}/gu, "")
        .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/^#{1,6}\s+/, "")
        .replace(/^\s*[*•]\s+/, "- ")
        .trimEnd(),
    );
  // At most one blank line in a row, none at the ends.
  const out: string[] = [];
  for (const l of lines) if (l.trim() || (out.length && out[out.length - 1]?.trim())) out.push(l);
  while (out.length && !out[out.length - 1]?.trim()) out.pop();
  if (!out.length) return "";
  let subject = trimQuotes((out[0] ?? "").replace(/^-\s+/, "").trim());
  if (subject.endsWith(".")) subject = subject.slice(0, -1).trimEnd();
  if (subject.length > 72) {
    const cut = subject.lastIndexOf(" ", 72);
    subject = subject.slice(0, cut > 40 ? cut : 72).trim();
  }
  const body = out.slice(1);
  // A body right under the subject gets the blank line git expects.
  if (body.length && body[0]?.trim()) body.unshift("");
  return [subject, ...body].join("\n");
}
