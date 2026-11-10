// The user guide for the guide subagent (D333, like Claude Code's claude-code-guide agent): the
// guide's pages (docs/guide/*.md, bundled with the IDE by the help extension) split into sections
// at their headings and ranked for a question with the chat search's scoring; read_guide returns
// the best sections with their page and heading to cite, or a page whole. DOM-free and tested.

import { parseQuery, scoreText, snippetOf } from "./chatSearch";

export interface GuidePage {
  /** The file name ("05-agent.md"). */
  id: string;
  title: string;
  text: string;
}

export interface GuideSection {
  page: string;
  pageTitle: string;
  heading: string;
  text: string;
}

/** A page's sections: the text under each `##`/`###` heading (the intro under the title). */
export function guideSections(page: GuidePage): GuideSection[] {
  const out: GuideSection[] = [];
  let heading = page.title;
  let lines: string[] = [];
  let fence = false;
  const flush = () => {
    const text = lines.join("\n").trim();
    if (text) out.push({ page: page.id, pageTitle: page.title, heading, text });
    lines = [];
  };
  for (const line of page.text.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fence = !fence;
    const m = fence ? null : /^#{1,3}\s+(.+)$/.exec(line);
    if (m) {
      flush();
      heading = (m[1] ?? "").trim();
      continue;
    }
    lines.push(line);
  }
  flush();
  return out;
}

const HEADING_WEIGHT = 2;
/** The longest a section is returned whole; longer ones are cut around the match. */
const SECTION_CHARS = 2400;

/** The sections that answer `query` best, at most `limit`. */
export function searchGuide(
  pages: readonly GuidePage[],
  query: string,
  limit = 5,
): (GuideSection & { score: number })[] {
  const q = parseQuery(query);
  if (!q.terms.length) return [];
  return pages
    .flatMap(guideSections)
    .map((s) => ({
      ...s,
      score:
        scoreText(s.text, q) +
        HEADING_WEIGHT * scoreText(s.heading, q) +
        0.5 * scoreText(s.pageTitle, q),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
}

/** The sections as the agent reads them: where each is (to cite), then its text. */
export function guideResultText(
  sections: readonly (GuideSection & { score: number })[],
  query: string,
): string {
  const q = parseQuery(query);
  return sections
    .map(
      (s) =>
        `## ${s.pageTitle} › ${s.heading} (${s.page})\n${
          s.text.length <= SECTION_CHARS ? s.text : snippetOf(s.text, q, SECTION_CHARS)
        }`,
    )
    .join("\n\n");
}

/** The pages listed: id and title, for read_guide's `page`. */
export function guideIndexText(pages: readonly GuidePage[]): string {
  return pages.map((p) => `${p.id}: ${p.title}`).join("\n");
}
