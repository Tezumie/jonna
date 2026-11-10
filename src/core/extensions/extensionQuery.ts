// The Extensions view's search syntax, as VS Code's (D284): free text plus filters —
// `@installed`, `@enabled`, `@disabled`, `@builtin`, `@updates` (`@outdated`), `@recommended`,
// `@popular`, `@recentlyPublished`, `@category:"…"`, `@tag:…`, `@id:publisher.name`,
// `publisher:"…"`, `ext:ts`, `@sort:installs|rating|name|publishedDate|updateDate`. Quotes allow
// spaces. What isn't a filter is the text. DOM-free.

export type ExtensionSort = "installs" | "rating" | "name" | "publishedDate" | "updateDate";

export interface ExtensionQuery {
  /** The words left once the filters are taken out, trimmed. */
  text: string;
  installed: boolean;
  enabled: boolean;
  disabled: boolean;
  builtin: boolean;
  updates: boolean;
  recommended: boolean;
  popular: boolean;
  recentlyPublished: boolean;
  category?: string;
  tag?: string;
  id?: string;
  publisher?: string;
  /** A file extension without the dot ("ts"). */
  ext?: string;
  sort?: ExtensionSort;
}

const SORTS: Record<string, ExtensionSort> = {
  installs: "installs",
  downloads: "installs",
  rating: "rating",
  name: "name",
  publisheddate: "publishedDate",
  updatedate: "updateDate",
};

const FLAGS = {
  "@installed": "installed",
  "@enabled": "enabled",
  "@disabled": "disabled",
  "@builtin": "builtin",
  "@updates": "updates",
  "@outdated": "updates",
  "@recommended": "recommended",
  "@popular": "popular",
  "@recentlypublished": "recentlyPublished",
} as const;

/** `key:value` filters; the value may be quoted ("…" with spaces), or missing while typing. */
const VALUED = /(@category|@tag|@id|@sort|publisher|ext):\s*(?:"([^"]*)"?|(\S+))?/gi;

export function parseExtensionQuery(raw: string): ExtensionQuery {
  const q: ExtensionQuery = {
    text: "",
    installed: false,
    enabled: false,
    disabled: false,
    builtin: false,
    updates: false,
    recommended: false,
    popular: false,
    recentlyPublished: false,
  };
  let rest = raw.replace(VALUED, (_all, key: string, quoted?: string, bare?: string) => {
    const value = (quoted ?? bare ?? "").trim();
    if (!value) return " ";
    switch (key.toLowerCase()) {
      case "@category":
        q.category = value;
        break;
      case "@tag":
        q.tag = value;
        break;
      case "@id":
        q.id = value.toLowerCase();
        break;
      case "publisher":
        q.publisher = value;
        break;
      case "ext":
        q.ext = value.replace(/^\*?\./, "").toLowerCase();
        break;
      case "@sort": {
        const sort = SORTS[value.toLowerCase()];
        if (sort) q.sort = sort;
        break;
      }
    }
    return " ";
  });
  rest = rest.replace(/@\w+/g, (word) => {
    const flag = FLAGS[word.toLowerCase() as keyof typeof FLAGS];
    if (!flag) return word;
    q[flag] = true;
    return " ";
  });
  q.text = rest.replace(/\s+/g, " ").trim();
  return q;
}

/** Whether the query says anything at all (text or a filter). */
export function isEmptyQuery(q: ExtensionQuery): boolean {
  return (
    !q.text &&
    !q.installed &&
    !q.enabled &&
    !q.disabled &&
    !q.builtin &&
    !q.updates &&
    !q.recommended &&
    !q.popular &&
    !q.recentlyPublished &&
    !q.category &&
    !q.tag &&
    !q.id &&
    !q.publisher &&
    !q.ext &&
    !q.sort
  );
}

/**
 * Whether the query looks at installed extensions only (VS Code: these filters never search the
 * marketplace).
 */
export function installedOnly(q: ExtensionQuery): boolean {
  return q.installed || q.enabled || q.disabled || q.builtin || q.updates || q.recommended;
}

/** A filter's text, quoted when it has spaces: `publisher:"Red Hat"`, `@category:Themes`. */
export function filterText(key: string, value: string): string {
  return /[\s"]/.test(value) ? `${key}:"${value.replace(/"/g, "")}"` : `${key}:${value}`;
}

/** What the view knows of an installed extension, for the filters. */
export interface InstalledFacts {
  id: string;
  displayName: string;
  description: string;
  /** The publisher's name as shown, and its id part (the namespace). */
  publisher: string;
  categories: readonly string[];
  keywords: readonly string[];
  /** File extensions its languages claim, without dots. */
  fileExtensions: readonly string[];
  enabled: boolean;
  builtin: boolean;
  hasUpdate: boolean;
  recommended: boolean;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Whether an installed extension matches the query (its text and every filter). */
export function matchesInstalled(q: ExtensionQuery, e: InstalledFacts): boolean {
  if (q.enabled && !e.enabled) return false;
  if (q.disabled && e.enabled) return false;
  if (q.builtin && !e.builtin) return false;
  if (q.updates && !e.hasUpdate) return false;
  if (q.recommended && !e.recommended) return false;
  if (q.id && !same(q.id, e.id)) return false;
  if (q.publisher && !matchesPublisher(q.publisher, e.id.split(".")[0] ?? "", e.publisher))
    return false;
  if (q.category && !e.categories.some((c) => same(c, q.category ?? ""))) return false;
  if (q.tag && !e.keywords.some((k) => same(k, q.tag ?? ""))) return false;
  if (q.ext && !e.fileExtensions.some((x) => same(x.replace(/^\./, ""), q.ext ?? ""))) return false;
  if (!q.text) return true;
  const hay = `${e.id} ${e.displayName} ${e.description} ${e.publisher}`.toLowerCase();
  return q.text
    .toLowerCase()
    .split(" ")
    .every((word) => hay.includes(word));
}

/**
 * Open VSX namespaces that VS Code's Marketplace shows under one publisher name: Microsoft
 * publishes on Open VSX under several namespaces (ms-python, ms-vscode…), none named
 * "microsoft", so `publisher:"Microsoft"` looks in these.
 */
export const PUBLISHER_NAMESPACES: Readonly<Record<string, readonly string[]>> = {
  microsoft: [
    "ms-python",
    "ms-vscode",
    "ms-toolsai",
    "ms-azuretools",
    "ms-vscode-remote",
    "ms-dotnettools",
    "ms-edgedevtools",
    "ms-kubernetes-tools",
    "ms-mssql",
    "ms-playwright",
    "vscode",
  ],
};

/** The Open VSX namespaces a `publisher:` value stands for: its alias list, else the value itself
 * as a namespace ("Red Hat" → "redhat", "red-hat"). */
export function publisherNamespaces(publisher: string): string[] {
  const key = publisher.trim().toLowerCase();
  const alias = PUBLISHER_NAMESPACES[key];
  if (alias) return [...alias];
  const joined = key.replace(/\s+/g, "");
  const dashed = key.replace(/\s+/g, "-");
  return [...new Set([key, joined, dashed])].filter((n) => /^[a-z0-9][a-z0-9._-]*$/.test(n));
}

/** Whether `publisher` (a name typed or clicked) is this extension's: its namespace or name. */
export function matchesPublisher(publisher: string, namespace: string, name?: string): boolean {
  if (name && same(publisher, name)) return true;
  return publisherNamespaces(publisher).includes(namespace.toLowerCase());
}

/** Open VSX's sortBy for a sort (it has no name sort: that one is done here). */
export function storeSortBy(q: ExtensionQuery): string | undefined {
  if (q.popular || q.sort === "installs") return "downloadCount";
  if (q.sort === "rating") return "averageRating";
  if (q.recentlyPublished || q.sort === "publishedDate" || q.sort === "updateDate")
    return "timestamp";
  return undefined;
}
