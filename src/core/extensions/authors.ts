// An extension's authors (D185), like a GitHub repository's contributors: `authors` in the
// manifest (strings or { name, github?, url?, avatar? }), else npm's / VS Code's `author` and
// `contributors` ("Name <mail> (url)" strings or objects). Pictures come from GitHub (`github`, or
// a github.com `url`) or a brand mark the IDE ships (`avatar: "brand:anthropic"`); nothing else is
// loaded from elsewhere.

export interface ExtensionAuthor {
  name: string;
  /** GitHub user name: the picture and the profile link. */
  github?: string;
  url?: string;
  /** "brand:<id>": one of the IDE's brand marks (the AI providers' logos). */
  avatar?: string;
}

const MAX_AUTHORS = 12;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/?$/i;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** One entry: a string ("Name <mail> (url)") or an object. */
export function parseAuthor(raw: unknown): ExtensionAuthor | null {
  if (typeof raw === "string") {
    const m = /^([^<(]*)(?:<[^>]*>)?\s*(?:\(([^)]*)\))?/.exec(raw.trim());
    const name = str(m?.[1])?.slice(0, 80);
    if (!name) return null;
    const url = str(m?.[2]);
    return withGithub({ name, ...(url && /^https?:\/\//i.test(url) && { url }) });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const github = str(o.github);
  const name = str(o.name) ?? github;
  if (!name) return null;
  const url = str(o.url);
  const avatar = str(o.avatar);
  return withGithub({
    name: name.slice(0, 80),
    ...(github && GITHUB_LOGIN.test(github) && { github }),
    ...(url && /^https?:\/\//i.test(url) && { url }),
    ...(avatar && /^brand:[a-z0-9-]+$/.test(avatar) && { avatar }),
  });
}

/** A github.com profile URL gives the GitHub name too. */
function withGithub(a: ExtensionAuthor): ExtensionAuthor {
  if (a.github || !a.url) return a;
  const m = GITHUB_URL.exec(a.url);
  return m?.[1] ? { ...a, github: m[1] } : a;
}

/** The manifest's authors, first ones first, without repeats. */
export function parseAuthors(manifest: Record<string, unknown>): ExtensionAuthor[] {
  const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
  const raw = [
    ...list(manifest.authors),
    ...(manifest.authors === undefined ? list(manifest.author) : []),
    ...list(manifest.contributors),
  ];
  const out: ExtensionAuthor[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const a = parseAuthor(r);
    if (!a) continue;
    const key = (a.github ?? a.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
    if (out.length === MAX_AUTHORS) break;
  }
  return out;
}

/** "Claude", "Claude and Tezumie", "Claude, Tezumie and 2 more". */
export function authorsText(authors: readonly ExtensionAuthor[]): string {
  const names = authors.map((a) => a.name);
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}
