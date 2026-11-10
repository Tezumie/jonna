// Searching the folder's saved chats (D331, Claude Code's search_session_transcripts): titles,
// the user's messages and the agent's answers (not tool output), ranked by how many of the query's
// words a message has and how often, a phrase match counting most; a chat ranks by its title and
// its best messages, newer first on a tie. Each hit names the message by its number in the chat
// (1 = the first message) and its item id (agent.showMessage opens it there). The same scoring
// ranks the user guide's sections (guideSearch.ts). DOM-free and tested.

import type { Item } from "./conversation";

/** One message as searched: its number in the chat, who said it, its text. */
export interface ChatMessageText {
  n: number;
  item: string;
  role: "user" | "agent";
  text: string;
}

export interface SearchableChat {
  id: string;
  title: string;
  /** When it last changed (ms), for ties and the date shown. */
  updated: number;
  messages: readonly ChatMessageText[];
}

export interface ChatHit {
  id: string;
  title: string;
  updated: number;
  score: number;
  /** The best matching messages, in the chat's order. */
  matches: { n: number; item: string; role: "user" | "agent"; snippet: string }[];
}

export interface Query {
  terms: string[];
  /** The whole query as typed (lower case), when it has more than one word. */
  phrase: string | null;
}

/** Words too common to rank by. */
const STOP = new Set(
  "a an and are as at be by do for from how i in is it me my of on or the this that to was we what when where which who why with you".split(
    " ",
  ),
);

/** The query's words (lower case, two letters or more, common words left out unless all are). */
export function parseQuery(query: string): Query {
  const q = query.trim().toLowerCase();
  const words = q.match(/[\p{L}\p{N}_][\p{L}\p{N}_.\-/]*/gu) ?? [];
  const kept = words.filter((w) => w.length >= 2 && !STOP.has(w));
  const terms = [...new Set(kept.length ? kept : words.filter((w) => w.length >= 2))];
  return { terms, phrase: words.length > 1 ? q.replace(/\s+/g, " ") : null };
}

function count(haystack: string, needle: string): number {
  let n = 0;
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + needle.length)
  )
    n++;
  return n;
}

/**
 * How well `text` matches: each word found adds 1 + log of how often; the share of the query's
 * words found counts squared (a message with all of them beats one repeating one); the whole
 * phrase doubles it. 0 when no word is there.
 */
export function scoreText(text: string, query: Query): number {
  if (!query.terms.length) return 0;
  const t = text.toLowerCase();
  let sum = 0;
  let found = 0;
  for (const term of query.terms) {
    const c = count(t, term);
    if (!c) continue;
    found++;
    sum += 1 + Math.log(c);
  }
  if (!found) return 0;
  const coverage = found / query.terms.length;
  const phrase = query.phrase && t.includes(query.phrase) ? 2 : 1;
  return sum * coverage * coverage * phrase;
}

/** About `width` characters of `text` around its first match, on one line. */
export function snippetOf(text: string, query: Query, width = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const at = [query.phrase, ...query.terms]
    .filter((x): x is string => !!x)
    .map((x) => lower.indexOf(x))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  if (at === undefined || flat.length <= width)
    return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), flat.length - width));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

/** Harness messages that aren't part of the conversation as people read it. */
const SKIPPED_AUTO = new Set(["limit", "continue", "group", "verify"]);

/** A chat's messages as searched: the user's (and other chats' messages) and the answers. */
export function chatMessagesOf(items: readonly Item[]): ChatMessageText[] {
  const out: ChatMessageText[] = [];
  let n = 0;
  for (const it of items) {
    if (it.type === "user") {
      if (it.auto && SKIPPED_AUTO.has(it.auto)) continue;
      n++;
      if (it.text.trim()) out.push({ n, item: it.id, role: "user", text: it.text });
    } else if (it.type === "assistant" && it.text.trim()) {
      n++;
      out.push({ n, item: it.id, role: "agent", text: it.text });
    }
  }
  return out;
}

const TITLE_WEIGHT = 3;
const USER_WEIGHT = 1.2;
const MATCHES_PER_CHAT = 3;

/** The chats that match `query`, best first, at most `limit`. */
export function searchChats(
  chats: readonly SearchableChat[],
  query: string,
  limit = 10,
  now = Date.now(),
): ChatHit[] {
  const q = parseQuery(query);
  if (!q.terms.length) return [];
  const hits: ChatHit[] = [];
  for (const chat of chats) {
    const scored = chat.messages
      .map((m) => ({ m, s: scoreText(m.text, q) * (m.role === "user" ? USER_WEIGHT : 1) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    const title = scoreText(chat.title, q) * TITLE_WEIGHT;
    if (!title && !scored.length) continue;
    const best = scored.slice(0, MATCHES_PER_CHAT);
    const [first, ...rest] = best;
    // Newer chats win ties: up to a tenth of a point over the last 90 days.
    const age = Math.max(0, now - chat.updated) / (90 * 86_400_000);
    const score =
      title +
      (first?.s ?? 0) +
      0.25 * rest.reduce((n, x) => n + x.s, 0) +
      0.1 * Math.max(0, 1 - age);
    hits.push({
      id: chat.id,
      title: chat.title,
      updated: chat.updated,
      score: Math.round(score * 1000) / 1000,
      matches: best
        .map((x) => x.m)
        .sort((a, b) => a.n - b.n)
        .map((m) => ({ n: m.n, item: m.item, role: m.role, snippet: snippetOf(m.text, q) })),
    });
  }
  return hits
    .sort((a, b) => b.score - a.score || b.updated - a.updated)
    .slice(0, Math.max(1, limit));
}

/** The hits as the agent reads them: the chat, its date, each match by message number. */
export function hitsText(hits: readonly ChatHit[]): string {
  return hits
    .map((h) =>
      [
        `${h.id} · "${h.title}" · ${new Date(h.updated).toISOString().slice(0, 10)}`,
        ...h.matches.map(
          (m) => `  #${m.n} (${m.role === "user" ? "user" : "agent"}): ${m.snippet}`,
        ),
      ].join("\n"),
    )
    .join("\n");
}
