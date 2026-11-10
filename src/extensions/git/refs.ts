// What the Graph shows about a commit beyond its subject (D148): its refs as VS Code's badges
// (the current branch, other branches, remote branches, tags), the hosting site's page for it
// (GitHub, GitLab, Bitbucket…) and an author's initials and color. DOM-free and tested.

export type RefKind = "head" | "branch" | "remote" | "tag" | "detached";

export interface RefBadge {
  kind: RefKind;
  name: string;
  /**
   * A remote branch with the same name as a local one on the same commit ("origin/main" beside
   * "main"): shown as its icon only, the name in the hover.
   */
  compact: boolean;
}

const ORDER: Record<RefKind, number> = { head: 0, detached: 0, branch: 1, remote: 2, tag: 3 };

/** `git log --decorate` refs ("HEAD -> main", "origin/main", "tag: v1", "HEAD") → badges. */
export function parseRefs(refs: readonly string[], remotes: readonly string[]): RefBadge[] {
  const out: RefBadge[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    if (!ref) continue;
    if (ref.startsWith("HEAD -> ")) out.push({ kind: "head", name: ref.slice(8), compact: false });
    else if (ref === "HEAD") out.push({ kind: "detached", name: "HEAD", compact: false });
    else if (ref.startsWith("tag: ")) out.push({ kind: "tag", name: ref.slice(5), compact: false });
    else if (remotes.some((r) => ref.startsWith(`${r}/`))) {
      // origin/HEAD only says which branch the remote's default is.
      if (ref.endsWith("/HEAD")) continue;
      out.push({ kind: "remote", name: ref, compact: false });
    } else out.push({ kind: "branch", name: ref, compact: false });
  }
  const local = new Set(
    out.filter((b) => b.kind === "head" || b.kind === "branch").map((b) => b.name),
  );
  for (const b of out)
    if (b.kind === "remote") {
      const branch = b.name.slice(b.name.indexOf("/") + 1);
      b.compact = local.has(branch);
    }
  return out.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
}

/**
 * A remote's web page: `git@github.com:a/b.git`, `ssh://git@host/a/b`, `https://user@host/a/b.git`
 * → `https://host/a/b`; null for a local path or something unrecognized.
 */
export function webUrl(remote: string): string | null {
  const url = remote.trim();
  let host = "";
  let path = "";
  const scp = /^[\w.-]+@([\w.-]+):(?!\/\/)(.+)$/.exec(url);
  if (scp) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else {
    const m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([\w.-]+)(?::\d+)?\/(.+)$/.exec(url);
    if (!m) return null;
    host = m[1] ?? "";
    path = m[2] ?? "";
  }
  path = path.replace(/\.git\/?$/, "").replace(/\/+$/, "");
  if (!host.includes(".") || !path.includes("/")) return null;
  return `https://${host}/${path}`;
}

/** The hosting site's name for a web URL ("GitHub"), for "Open on …". */
export function siteName(web: string): string {
  const host = new URL(web).host.toLowerCase();
  if (host === "github.com" || host.endsWith(".github.com")) return "GitHub";
  if (host.includes("gitlab")) return "GitLab";
  if (host.includes("bitbucket")) return "Bitbucket";
  if (host.includes("codeberg")) return "Codeberg";
  return host;
}

/** A commit's page on the site ("/-/commit/" on GitLab, "/commits/" on Bitbucket). */
export function commitUrl(web: string, hash: string): string {
  const site = siteName(web);
  if (site === "GitLab") return `${web}/-/commit/${hash}`;
  if (site === "Bitbucket") return `${web}/commits/${hash}`;
  return `${web}/commit/${hash}`;
}

/** Up to two initials ("Ada Lovelace" → "AL", "tezumie" → "T"). */
export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const first = words[0]?.[0] ?? "?";
  const last = words.length > 1 ? (words.at(-1)?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** One of the graph's six colors, the same for the same person (by email). */
export function personColor(email: string): number {
  let hash = 0;
  for (const ch of email.toLowerCase()) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return hash % 6;
}

/** A folder name → a GitHub repository name ("My App!" → "My-App"). */
export function repoNameFrom(folder: string): string {
  return (
    folder
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 100) || "repository"
  );
}

export function validRepoName(v: string): string | undefined {
  const name = v.trim();
  if (!name) return "Type a name.";
  if (!/^([A-Za-z0-9-]+\/)?[A-Za-z0-9._-]+$/.test(name) || /(^|\/)(\.{1,2}(\/|$)|-)/.test(name))
    return "Letters, digits, . - and _ only (optionally owner/name).";
  return undefined;
}
