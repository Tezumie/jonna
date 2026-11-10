// The DOM-free part of the read-only git extensions get (D204, D208): a file's `git blame
// --porcelain` as hunks and `git log -L` output as commits with their diffs (served through
// services.gitAccess, `ide.git.*`), and GitHub review comment threads placed on lines. The blame
// gutter's drawing is the Git tools extension's (bundled-extensions/gittools). Tested.
import type { BlameCommit, BlameHunk, LineLogEntry } from "../../workbench/gitAccess";

export type { BlameCommit, BlameHunk, LineLogEntry };

/** `git blame --porcelain` → consecutive lines of one commit merged into hunks. */
export function parseBlamePorcelain(text: string): BlameHunk[] {
  const commits = new Map<string, BlameCommit>();
  const byLine: { line: number; hash: string }[] = [];
  const lines = text.split("\n");
  let current: BlameCommit | null = null;
  for (const raw of lines) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("\t")) {
      current = null;
      continue;
    }
    const head = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(line);
    if (head) {
      const hash = head[1] as string;
      const final = Number(head[2]);
      let c = commits.get(hash);
      if (!c) {
        c = {
          hash,
          author: "",
          authorMail: "",
          time: 0,
          summary: "",
          uncommitted: /^0+$/.test(hash),
          filename: "",
          previous: null,
        };
        commits.set(hash, c);
      }
      current = c;
      byLine.push({ line: final, hash });
      continue;
    }
    if (!current) continue;
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? "" : line.slice(space + 1);
    switch (key) {
      case "author":
        current.author = value;
        break;
      case "author-mail":
        current.authorMail = value.replace(/^<|>$/g, "");
        break;
      case "author-time":
        current.time = Number(value) || 0;
        break;
      case "summary":
        current.summary = value;
        break;
      case "filename":
        current.filename = value;
        break;
      case "previous":
        current.previous = value.split(" ")[0] ?? null;
        break;
    }
  }
  byLine.sort((a, b) => a.line - b.line);
  const hunks: BlameHunk[] = [];
  for (const { line, hash } of byLine) {
    const commit = commits.get(hash) as BlameCommit;
    const last = hunks[hunks.length - 1];
    if (last && last.commit === commit && last.end === line - 1) last.end = line;
    else hunks.push({ start: line, end: line, commit });
  }
  return hunks;
}

/** `git log -L` output in the record format git_log_lines asks for. */
export function parseLineLog(text: string): LineLogEntry[] {
  const out: LineLogEntry[] = [];
  for (const record of text.split("\x1e")) {
    if (!record.trim()) continue;
    const nl = record.indexOf("\n");
    const header = nl < 0 ? record : record.slice(0, nl);
    const body = nl < 0 ? "" : record.slice(nl + 1);
    const f = header.split("\0");
    const hash = (f[0] ?? "").trim();
    if (!/^[0-9a-f]{7,40}$/.test(hash)) continue;
    let added = 0;
    let removed = 0;
    let path: string | null = null;
    for (const l of body.split("\n")) {
      if (l.startsWith("+++ ")) {
        const p = l.slice(4).trim();
        path = p === "/dev/null" ? path : p.replace(/^b\//, "");
      } else if (l.startsWith("+") && !l.startsWith("+++")) added++;
      else if (l.startsWith("-") && !l.startsWith("---")) removed++;
    }
    out.push({
      hash,
      parents: (f[1] ?? "").split(" ").filter(Boolean),
      author: f[2] ?? "",
      email: f[3] ?? "",
      time: Number(f[4]) || 0,
      subject: f[5] ?? "",
      path,
      diff: body.replace(/^\n+/, "").trimEnd(),
      added,
      removed,
    });
  }
  return out;
}

/** A GitHub review thread (gh api graphql reviewThreads). */
export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  startLine?: number | null;
  diffSide?: string;
  comments: {
    nodes: {
      databaseId: number;
      body: string;
      createdAt: string;
      url: string;
      author: { login: string } | null;
    }[];
  };
}

/** The threads of a GraphQL reply (`data.repository.pullRequest.reviewThreads.nodes`). */
export function threadsOf(reply: unknown): ReviewThread[] {
  const nodes = (
    reply as {
      data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: unknown } } } };
    } | null
  )?.data?.repository?.pullRequest?.reviewThreads?.nodes;
  return Array.isArray(nodes)
    ? (nodes as ReviewThread[]).filter((t) => t && typeof t.path === "string")
    : [];
}

/** Where a thread sits in the file as it is in the pull request: its line, else the original. */
export function threadLine(t: ReviewThread): number | null {
  return t.line ?? t.originalLine ?? null;
}

/** Threads by repository path, sorted by line. */
export function threadsByPath(threads: readonly ReviewThread[]): Map<string, ReviewThread[]> {
  const out = new Map<string, ReviewThread[]>();
  for (const t of threads) out.set(t.path, [...(out.get(t.path) ?? []), t]);
  for (const list of out.values()) list.sort((a, b) => (threadLine(a) ?? 0) - (threadLine(b) ?? 0));
  return out;
}

/** A thread's hover text: each comment as "author: first lines". */
export function threadSummary(t: ReviewThread, maxComments = 5): string {
  const comments = t.comments.nodes;
  const lines = comments.slice(0, maxComments).map((c) => {
    const body = c.body.trim().replace(/\s+\n/g, "\n");
    return `${c.author?.login ?? "someone"}: ${body.length > 300 ? `${body.slice(0, 299)}…` : body}`;
  });
  if (comments.length > maxComments) lines.push(`… ${comments.length - maxComments} more`);
  return `${t.isResolved ? "Resolved · " : ""}${t.isOutdated ? "Outdated · " : ""}${lines.join("\n\n")}`;
}
