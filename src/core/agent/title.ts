// Chat titles from the model itself (D124), at almost no cost: the first message of a chat asks
// the model to start its reply with `<title>…</title>` (about 30 tokens in, 10 out, no extra
// request). The tag is taken out of the reply as it streams, so it never shows; a model that
// ignores the request leaves the title made from the user's message. DOM-free.

export const TITLE_REQUEST =
  "(Start your reply with a short title for this chat — 2 to 6 words, like <title>Fix login redirect</title> — then answer as usual.)";

const COMPLETE = /^\s*<title>([^<\n]{1,120})<\/title>[ \t]*\n*/i;
/** A reply that may still turn into `<title>…` (hide it until it's clear). */
const PARTIAL =
  /^\s*<(?:t(?:i(?:t(?:l(?:e(?:>[^<\n]{0,120}(?:<(?:\/(?:t(?:i(?:t(?:l(?:e)?)?)?)?)?)?)?)?)?)?)?)?)?$/i;

/**
 * The same title in a bare tag, as some models write it: `<Landing Page Ready>` on the first
 * line (D160). Words, starting with a capital: not an HTML tag (`<div>`, `<a href=…>`).
 */
const BARE = /^\s*<([A-Z][^<>\n=/]{1,80})>[ \t]*(?:\n+|$)/;
const BARE_PARTIAL = /^\s*<(?:[A-Z][^<>\n=/]{0,80})?$/;

export interface TitleSplit {
  /** The reply without the title tag (empty while a title may still be streaming). */
  text: string;
  /** The title, once its closing tag arrived. */
  title?: string;
  /** Still could be a title: show nothing yet. */
  pending: boolean;
}

export function splitTitle(raw: string): TitleSplit {
  const m = COMPLETE.exec(raw);
  if (m) return { text: raw.slice(m[0].length), title: cleanTitle(m[1] ?? ""), pending: false };
  if (PARTIAL.test(raw)) return { text: "", pending: true };
  const bare = BARE.exec(raw);
  if (bare && (bare[1] ?? "").includes(" "))
    return { text: raw.slice(bare[0].length), title: cleanTitle(bare[1] ?? ""), pending: false };
  if (BARE_PARTIAL.test(raw)) return { text: "", pending: true };
  return { text: raw, pending: false };
}

/** "  \"Fix the login redirect.\" " → "Fix the login redirect". */
export function cleanTitle(title: string): string {
  return title
    .replace(/[*_`#]/g, "")
    .replace(/^["'“‘\s]+|["'”’\s]+$/g, "")
    .replace(/[.!?:;,]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/** Wrapper tags some models put around a reply (agent-framework habits): shown without them. */
const WRAPPERS =
  "result|answer|final_answer|final|response|reply|output|attempt_completion|completion|message|summary";
const OPEN_AT_START = new RegExp(`^(\\s*)<(?:${WRAPPERS})>\\s*`, "i");
const CLOSE_AT_END = new RegExp(`\\s*</(?:${WRAPPERS})>\\s*$`, "i");
const ONLY_TAG = new RegExp(`^\\s*</?(?:${WRAPPERS})>\\s*$`, "i");

/**
 * A reply as shown (D163): `<result>`…`</result>` wrappers (free models copying agent
 * frameworks) are taken out at the start and end of lines, never inside code blocks.
 */
export function withoutWrapperTags(text: string): string {
  if (!text.includes("<")) return text;
  let fence: string | null = null;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) {
      const mark = f[1] as string;
      if (fence === null) fence = mark;
      else if (mark.startsWith(fence)) fence = null;
      out.push(line);
      continue;
    }
    if (fence !== null) {
      out.push(line);
      continue;
    }
    if (ONLY_TAG.test(line)) continue;
    out.push(line.replace(OPEN_AT_START, "$1").replace(CLOSE_AT_END, ""));
  }
  return out.join("\n");
}
