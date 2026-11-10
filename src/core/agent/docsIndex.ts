// Documentation sites for @docs mentions (D204, Cursor's @Docs): a source is a URL; the crawler
// reads pages within the site's prefix (same origin, the start URL's folder and below), at most
// `maxPages`, following robots.txt and waiting between requests; each page is split into chunks
// under their headings and kept in a small lexical index (BM25 over words; no embeddings), so
// `@docs:<name> <question>` attaches the best-matching chunks. DOM-free and tested; the fetching
// (the agent's web fetch path in Rust) and the storage are extensions/agent/docs.ts.
// D207: sitemap.xml (robots.txt's Sitemap lines, else the usual places) seeds the crawl with the
// pages under the prefix that no link reaches; a page that's almost empty without its scripts
// is skipped as "needs JavaScript" (the IDE has no headless browser to render it); sources
// older than `agent.docs.refreshDays` are read again (staleDocs).

// ---- robots.txt -------------------------------------------------------------------------------

export interface RobotsRules {
  allow: string[];
  disallow: string[];
  /** Crawl-delay in seconds, when given. */
  delay?: number;
}

/**
 * The rules for us: the group naming `agent` (our user agent token) if there is one, else `*`.
 * Paths may use `*` and a final `$` as Google and Bing read them.
 */
export function parseRobots(text: string, agent = "ide-docs"): RobotsRules {
  const groups: { agents: string[]; rules: RobotsRules }[] = [];
  let current: { agents: string[]; rules: RobotsRules } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase();
    const value = (m[2] ?? "").trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: { allow: [], disallow: [] } };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" && value) current.rules.allow.push(value);
    else if (key === "disallow" && value) current.rules.disallow.push(value);
    else if (key === "crawl-delay" && Number.isFinite(Number(value)))
      current.rules.delay = Number(value);
  }
  const mine = groups.find((g) =>
    g.agents.some((a) => a !== "*" && agent.toLowerCase().includes(a)),
  );
  const any = groups.find((g) => g.agents.includes("*"));
  return (mine ?? any)?.rules ?? { allow: [], disallow: [] };
}

/** robots.txt's `Sitemap:` lines (they stand outside the user-agent groups). */
export function robotsSitemaps(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(raw.replace(/#.*$/, ""));
    if (m?.[1] && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

const xmlText = (t: string) =>
  t
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();

/**
 * A sitemap's addresses: pages (`<urlset><url><loc>`) and, for a sitemap index, the sitemaps it
 * lists (`<sitemapindex><sitemap><loc>`).
 */
export function parseSitemap(xml: string): { pages: string[]; sitemaps: string[] } {
  const pages: string[] = [];
  const sitemaps: string[] = [];
  for (const m of xml.matchAll(/<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const loc = /<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/i.exec(m[2] ?? "")?.[1];
    if (!loc) continue;
    (m[1]?.toLowerCase() === "sitemap" ? sitemaps : pages).push(xmlText(loc));
  }
  return { pages, sitemaps };
}

/**
 * Whether a page needs its scripts to show anything (a single-page app's shell): it has scripts
 * and, without them, hardly any text (`text`: what htmlToText got).
 */
export function needsJavaScript(html: string, text: string): boolean {
  if (!/<script\b/i.test(html)) return false;
  const words = text
    .replace(/[#*_`>\-[\]()]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
  if (words.length >= 40) return false;
  return (
    words.length < 15 ||
    /<noscript\b[^>]*>[\s\S]*?javascript/i.test(html) ||
    /<div[^>]+id\s*=\s*["'](root|app|__next|___gatsby|__nuxt)["'][^>]*>\s*<\/div>/i.test(html)
  );
}

/** Sources to read again: indexed more than `days` days ago (0: never). */
export function staleDocs(
  sources: readonly { name: string; crawledAt?: number }[],
  days: number,
  now: number,
): string[] {
  if (!(days > 0)) return [];
  const limit = days * 86_400_000;
  return sources
    .filter((x) => x.crawledAt !== undefined && now - x.crawledAt >= limit)
    .map((x) => x.name);
}

function robotsPattern(rule: string): RegExp {
  const anchored = rule.endsWith("$");
  const body = (anchored ? rule.slice(0, -1) : rule)
    .split("*")
    .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** Whether `path` (with its query) may be fetched: the longest matching rule wins; Allow on a tie. */
export function robotsAllows(rules: RobotsRules, path: string): boolean {
  let best = { length: -1, allow: true };
  for (const [list, allow] of [
    [rules.allow, true],
    [rules.disallow, false],
  ] as const)
    for (const rule of list) {
      if (!robotsPattern(rule).test(path)) continue;
      if (rule.length > best.length || (rule.length === best.length && allow))
        best = { length: rule.length, allow };
    }
  return best.allow;
}

// ---- Links --------------------------------------------------------------------------------

const SKIP_EXT =
  /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|map|json|xml|zip|gz|tgz|tar|pdf|mp4|webm|mp3|woff2?|ttf|eot|wasm|exe|dmg|msi)$/i;

/** The folder a start URL covers: `https://x.dev/docs/intro` → `https://x.dev/docs/`. */
export function sitePrefix(start: string): string {
  const u = new URL(start);
  u.hash = "";
  u.search = "";
  const path = u.pathname.endsWith("/") ? u.pathname : u.pathname.replace(/[^/]*$/, "");
  return `${u.origin}${path}`;
}

/** A link to follow, normalized (no fragment, no query, no index.html), or null. */
export function crawlTarget(href: string, base: string, prefix: string): string | null {
  let u: URL;
  try {
    u = new URL(href, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.search = "";
  if (SKIP_EXT.test(u.pathname)) return null;
  u.pathname = u.pathname.replace(/\/index\.html?$/i, "/");
  const url = u.toString();
  // The prefix's folder itself (`/docs` for `/docs/`) counts too.
  return url.startsWith(prefix) || `${url}/` === prefix ? url : null;
}

/** Links in a page's HTML (`<a href>`), as written. */
export function extractLinks(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const href = (m[2] ?? m[3] ?? m[4] ?? "").trim().replace(/&amp;/g, "&");
    if (href && !href.startsWith("#") && !/^(javascript|mailto|tel|data):/i.test(href))
      out.push(href);
  }
  return out;
}

/** `<meta name="robots" content="noindex">` / nofollow on a page. */
export function metaRobots(html: string): { noindex: boolean; nofollow: boolean } {
  const m = /<meta\b[^>]*name\s*=\s*["']robots["'][^>]*>/i.exec(html);
  const content = (m && /content\s*=\s*["']([^"']*)["']/i.exec(m[0])?.[1]) ?? "";
  return { noindex: /noindex|none/i.test(content), nofollow: /nofollow|none/i.test(content) };
}

// ---- Chunks -------------------------------------------------------------------------------

export interface DocChunk {
  url: string;
  title: string;
  /** The heading it's under ("" for the page's start). */
  heading: string;
  text: string;
}

/**
 * A page's text (Markdown-like, from webText's htmlToText) in chunks of about `size` characters,
 * each under the nearest heading, split at paragraph ends.
 */
export function chunkPage(
  page: { url: string; title: string; text: string },
  size = 1200,
): DocChunk[] {
  const out: DocChunk[] = [];
  let heading = "";
  let buf: string[] = [];
  let length = 0;
  const flush = () => {
    const text = buf.join("\n\n").trim();
    if (text) out.push({ url: page.url, title: page.title, heading, text });
    buf = [];
    length = 0;
  };
  for (const block of page.text.split(/\n\s*\n/)) {
    const b = block.trim();
    if (!b) continue;
    const h = /^#{1,6}\s+(.+)$/.exec(b.split("\n")[0] ?? "");
    if (h) {
      flush();
      heading = (h[1] ?? "").trim();
      const rest = b.split("\n").slice(1).join("\n").trim();
      if (rest) {
        buf.push(rest);
        length += rest.length;
      }
      continue;
    }
    if (length + b.length > size && buf.length) flush();
    // A block longer than a chunk is cut at line ends.
    if (b.length > size * 1.5) {
      let rest = b;
      while (rest.length > size) {
        const cut = rest.lastIndexOf("\n", size) > size / 2 ? rest.lastIndexOf("\n", size) : size;
        buf.push(rest.slice(0, cut));
        flush();
        rest = rest.slice(cut).trimStart();
      }
      if (rest) {
        buf.push(rest);
        length += rest.length;
      }
      continue;
    }
    buf.push(b);
    length += b.length;
  }
  flush();
  return out;
}

// ---- Lexical index (BM25) -------------------------------------------------------------------

const STOP = new Set(
  "a an and are as at be but by for from has have how i if in into is it its of on or that the their then there these this to was what when where which who why will with you your can do does not".split(
    " ",
  ),
);

/** Words for the index: lower case, letters and digits (identifiers split at _ . - too), stop words out. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    let w = m[0];
    if (w.length < 2 || STOP.has(w)) continue;
    // A light stem: plurals and -ing / -ed, so "routes" finds "route".
    if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
    else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
    else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
    out.push(w);
  }
  return out;
}

export interface IndexedChunk extends DocChunk {
  /** Term → count in this chunk (heading and title words count twice). */
  tf: Record<string, number>;
  length: number;
}

export interface DocsIndex {
  version: 1;
  chunks: IndexedChunk[];
  /** Term → how many chunks have it. */
  df: Record<string, number>;
  avgLength: number;
}

export function buildIndex(chunks: readonly DocChunk[]): DocsIndex {
  const indexed: IndexedChunk[] = [];
  const df: Record<string, number> = {};
  let total = 0;
  for (const c of chunks) {
    const tf: Record<string, number> = {};
    const words = [...tokenize(c.text), ...tokenize(`${c.heading} ${c.heading} ${c.title}`)];
    for (const w of words) tf[w] = (tf[w] ?? 0) + 1;
    for (const w of Object.keys(tf)) df[w] = (df[w] ?? 0) + 1;
    total += words.length;
    indexed.push({ ...c, tf, length: words.length });
  }
  return {
    version: 1,
    chunks: indexed,
    df,
    avgLength: indexed.length ? total / indexed.length : 0,
  };
}

export interface DocHit {
  chunk: IndexedChunk;
  score: number;
}

/** The best `limit` chunks for `query` (BM25, k1 1.2, b 0.75); none when nothing matches. */
export function searchIndex(index: DocsIndex, query: string, limit = 5): DocHit[] {
  return capPerPage(lexicalHits(index, query), limit);
}

/** Every chunk `query`'s words match, best first (BM25). */
function lexicalHits(index: DocsIndex, query: string): DocHit[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !index.chunks.length) return [];
  const n = index.chunks.length;
  const k1 = 1.2;
  const b = 0.75;
  const hits: DocHit[] = [];
  for (const chunk of index.chunks) {
    let score = 0;
    for (const t of terms) {
      const f = chunk.tf[t];
      if (!f) continue;
      const df = index.df[t] ?? 0;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score +=
        (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * chunk.length) / (index.avgLength || 1)));
    }
    if (score > 0) hits.push({ chunk, score });
  }
  hits.sort((a, b2) => b2.score - a.score);
  return hits;
}

/** The first `limit` hits, at most two per page. */
function capPerPage(hits: readonly DocHit[], limit: number): DocHit[] {
  // One page's many chunks don't crowd out the rest: at most two per page.
  const perPage = new Map<string, number>();
  const out: DocHit[] = [];
  for (const h of hits) {
    const seen = perPage.get(h.chunk.url) ?? 0;
    if (seen >= 2) continue;
    perPage.set(h.chunk.url, seen + 1);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

/** Semantic matches considered per question (the nearest chunks; the rest are too far to help). */
const SEMANTIC_DEPTH = 50;
/** Reciprocal rank fusion's constant (the usual 60): a rank's weight is 1 / (k + rank). */
const RRF_K = 60;

/** The dot product of two vectors (cosine similarity for unit vectors, as stored). */
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

/**
 * @docs by words and meaning (D233): the BM25 ranking and the ranking by similarity to the
 * question's embedding (`vectors[i]` is chunk i's unit vector, null when it has none), fused by
 * reciprocal rank (a chunk high in either list comes first; one high in both, higher still). The
 * score is the fused one. Without vectors this is `searchIndex`.
 */
export function hybridSearch(
  index: DocsIndex,
  query: string,
  vectors: readonly (ArrayLike<number> | null)[],
  queryVector: ArrayLike<number>,
  limit = 5,
): DocHit[] {
  const fused = new Map<IndexedChunk, number>();
  const lexical = lexicalHits(index, query);
  lexical.forEach((h, rank) => {
    fused.set(h.chunk, 1 / (RRF_K + rank + 1));
  });
  const semantic: { chunk: IndexedChunk; sim: number }[] = [];
  index.chunks.forEach((chunk, i) => {
    const v = vectors[i];
    if (v) semantic.push({ chunk, sim: dot(v, queryVector) });
  });
  semantic.sort((a, b) => b.sim - a.sim);
  semantic.slice(0, SEMANTIC_DEPTH).forEach((h, rank) => {
    // Nothing at all alike (orthogonal or opposed) isn't a match.
    if (h.sim <= 0) return;
    fused.set(h.chunk, (fused.get(h.chunk) ?? 0) + 1 / (RRF_K + rank + 1));
  });
  const hits = [...fused].map(([chunk, score]) => ({ chunk, score }));
  hits.sort((a, b) => b.score - a.score);
  return capPerPage(hits, limit);
}

/** What an @docs mention attaches: the chunks with where they're from, within `budget`. */
export function renderDocHits(
  name: string,
  query: string,
  hits: readonly DocHit[],
  budget = 12_000,
): string {
  if (!hits.length)
    return `Docs ${name}: nothing matched "${query}". (The source may need a refresh on the Docs page.)`;
  const parts: string[] = [];
  let left = budget;
  for (const h of hits) {
    const head = `### ${h.chunk.title}${h.chunk.heading ? ` › ${h.chunk.heading}` : ""}\n${h.chunk.url}`;
    const text =
      h.chunk.text.length > left ? `${h.chunk.text.slice(0, Math.max(0, left))}…` : h.chunk.text;
    parts.push(`${head}\n\n${text}`);
    left -= head.length + text.length;
    if (left <= 0) break;
  }
  return `From the ${name} documentation${query ? ` (best matches for "${query}")` : ""}:\n\n${parts.join("\n\n---\n\n")}`;
}

// ---- The crawl ----------------------------------------------------------------------------

export interface CrawlDeps {
  /** GET a URL: its final address, status, content type and body text. */
  fetch(url: string): Promise<{ url: string; status: number; contentType: string; text: string }>;
  /** The page's readable text (webText's htmlToText) and title. */
  toText(html: string, url: string): { title: string; text: string };
  sleep(ms: number): Promise<void>;
  /** Stop early (cancelled). */
  cancelled?(): boolean;
  progress?(done: number, url: string): void;
  /**
   * A page that shows nothing without its scripts, rendered (D233, a hidden window): its text,
   * or null when it couldn't be. Absent: such pages are skipped as NEEDS_JAVASCRIPT.
   */
  render?(url: string): Promise<{ title: string; text: string } | null>;
}

/** The reason a page was skipped because it shows nothing without its scripts. */
export const NEEDS_JAVASCRIPT = "needs JavaScript";

export interface CrawlResult {
  pages: { url: string; title: string; text: string }[];
  skipped: { url: string; why: string }[];
}

/**
 * Breadth-first from `start`, within its prefix, at most `maxPages` pages, `delayMs` between
 * requests (or robots.txt's Crawl-delay when longer, up to 10 s), robots.txt and noindex /
 * nofollow followed.
 */
export async function crawl(
  start: string,
  options: { maxPages: number; delayMs: number },
  deps: CrawlDeps,
): Promise<CrawlResult> {
  const prefix = sitePrefix(start);
  const origin = new URL(start).origin;
  let robots: RobotsRules = { allow: [], disallow: [] };
  let sitemapList: string[] = [];
  try {
    const r = await deps.fetch(`${origin}/robots.txt`);
    if (r.status < 400 && !/html/i.test(r.contentType)) {
      robots = parseRobots(r.text);
      sitemapList = robotsSitemaps(r.text);
    }
  } catch {}
  const delay = Math.max(options.delayMs, Math.min(10_000, (robots.delay ?? 0) * 1000));
  const first = crawlTarget(start, start, prefix) ?? start;
  const queue = [first];
  const seen = new Set(queue);
  const pages: CrawlResult["pages"] = [];
  const skipped: CrawlResult["skipped"] = [];
  let requests = 0;
  // Pages that fail, redirect away or say noindex don't count as pages: the requests are capped
  // too, so a site of broken links isn't fetched without end. The queue is capped as well.
  const maxRequests = options.maxPages * 2 + 10;
  const maxQueued = Math.max(1000, options.maxPages * 20);

  // Sitemaps (D207): robots.txt's, else the folder's and the site's sitemap.xml. Only this
  // site's, at most five files (an index's children included); their pages under the prefix
  // join the queue after the start page.
  const sitemaps = (
    sitemapList.length
      ? sitemapList
      : [`${prefix}sitemap.xml`, `${origin}/sitemap.xml`].filter(
          (x, i, all) => all.indexOf(x) === i,
        )
  ).filter((x) => {
    try {
      return new URL(x).origin === origin;
    } catch {
      return false;
    }
  });
  const readSitemaps = new Set<string>();
  // Every fetch after the first waits (sitemaps and pages alike); `requests` counts pages.
  let fetches = 0;
  while (sitemaps.length && readSitemaps.size < 5 && !deps.cancelled?.()) {
    const at = sitemaps.shift() as string;
    if (readSitemaps.has(at)) continue;
    readSitemaps.add(at);
    const u = new URL(at);
    if (!robotsAllows(robots, `${u.pathname}${u.search}`)) continue;
    if (fetches++ > 0) await deps.sleep(delay);
    const r = await deps.fetch(at).catch(() => null);
    if (!r || r.status >= 400 || !/<(urlset|sitemapindex)\b/i.test(r.text)) continue;
    const found = parseSitemap(r.text);
    for (const child of found.sitemaps)
      if (!readSitemaps.has(child) && sitemaps.length < 20) {
        try {
          if (new URL(child).origin === origin) sitemaps.push(child);
        } catch {}
      }
    for (const loc of found.pages) {
      const next = crawlTarget(loc, at, prefix);
      if (next && !seen.has(next) && seen.size < maxQueued) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  while (
    queue.length &&
    pages.length < options.maxPages &&
    requests < maxRequests &&
    !deps.cancelled?.()
  ) {
    const url = queue.shift() as string;
    const u = new URL(url);
    if (!robotsAllows(robots, `${u.pathname}${u.search}`)) {
      skipped.push({ url, why: "robots.txt" });
      continue;
    }
    requests++;
    if (fetches++ > 0) await deps.sleep(delay);
    if (deps.cancelled?.()) break;
    let page: Awaited<ReturnType<CrawlDeps["fetch"]>>;
    try {
      page = await deps.fetch(url);
    } catch (err) {
      skipped.push({ url, why: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (page.status >= 400) {
      skipped.push({ url, why: `status ${page.status}` });
      continue;
    }
    // A redirect off the site isn't followed into.
    const landed = crawlTarget(page.url, page.url, prefix);
    if (!landed) {
      skipped.push({ url, why: `redirected outside ${prefix}` });
      continue;
    }
    const html = /html/i.test(page.contentType) || /<html|<body|<a\s/i.test(page.text);
    const meta = html ? metaRobots(page.text) : { noindex: false, nofollow: false };
    if (!meta.noindex) {
      const { title, text } = html
        ? deps.toText(page.text, landed)
        : { title: landed, text: page.text };
      if (html && needsJavaScript(page.text, text)) {
        const rendered = deps.render ? await deps.render(landed).catch(() => null) : null;
        if (rendered?.text.trim())
          pages.push({
            url: landed,
            title: rendered.title || title || landed,
            text: rendered.text,
          });
        else skipped.push({ url: landed, why: NEEDS_JAVASCRIPT });
      } else if (text.trim()) pages.push({ url: landed, title: title || landed, text });
      deps.progress?.(pages.length, landed);
    } else skipped.push({ url, why: "noindex" });
    if (!html || meta.nofollow) continue;
    for (const href of extractLinks(page.text)) {
      const next = crawlTarget(href, landed, prefix);
      if (next && !seen.has(next) && seen.size < maxQueued) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return { pages, skipped };
}
