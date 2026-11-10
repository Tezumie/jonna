// The problem report (D204): its sections become a Markdown issue body, and the body goes into a
// new-issue URL up to a length browsers and GitHub accept (the rest is copied to the clipboard).
// DOM-free.

export interface ReportSection {
  id: string;
  title: string;
  /** What's included, as shown to the user (already redacted). */
  text: string;
  included: boolean;
}

/** A GitHub URL past about 8 KB is refused (414); this leaves room for the title. */
export const MAX_ISSUE_URL = 7_500;

function fence(text: string): string {
  // Longer than any run of backticks inside, so a log line with ```` can't close it early.
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}\n${text.trimEnd()}\n${ticks}`;
}

/** The issue body: what happened, then each included section in a code block. */
export function reportBody(description: string, sections: readonly ReportSection[]): string {
  const parts = [
    "### What happened",
    description.trim() || "_Describe what you did, what you expected and what happened._",
  ];
  for (const s of sections)
    if (s.included && s.text.trim()) parts.push(`### ${s.title}`, fence(s.text));
  return `${parts.join("\n\n")}\n`;
}

export interface IssueLink {
  url: string;
  /** The body was too long for the URL: it was cut, and the full one should go to the clipboard. */
  truncated: boolean;
}

const CUT_NOTE =
  "\n\n_The report was too long for the link: the full report is on your clipboard. Paste it here in place of this one._\n";

/**
 * `<issuesUrl>/new?title=…&body=…`. `issuesUrl` is a repository's issues page
 * (https://github.com/owner/repo/issues); a URL that already ends in /new is used as is.
 */
export function issueLink(
  issuesUrl: string,
  title: string,
  body: string,
  max = MAX_ISSUE_URL,
): IssueLink {
  const base = issuesUrl.replace(/\/+$/, "");
  const newUrl = /\/new$/.test(base) ? base : `${base}/new`;
  // A long title alone could pass the limit (the body is all that's cut): it's kept short.
  const chars = Array.from(title);
  const shortTitle = chars.length > 200 ? `${chars.slice(0, 199).join("")}…` : title;
  const build = (b: string) =>
    `${newUrl}?title=${encodeURIComponent(shortTitle)}&body=${encodeURIComponent(b)}`;
  const full = build(body);
  if (full.length <= max) return { url: full, truncated: false };
  // Never between a surrogate pair's halves (encodeURIComponent throws on a lone half).
  const prefix = (n: number) => {
    const code = body.charCodeAt(n - 1);
    return body.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
  };
  // The longest prefix that fits with the note (binary search on characters).
  let lo = 0;
  let hi = body.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (build(prefix(mid) + CUT_NOTE).length <= max) lo = mid;
    else hi = mid - 1;
  }
  return { url: build(prefix(lo) + CUT_NOTE), truncated: true };
}
