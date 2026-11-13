// Open VSX's answers, read defensively (D254: the extension store). Search results and an
// extension's details are its JSON (src-tauri/src/extensions/store.rs fetches them); these turn
// them into what the Extensions view, an extension's store page and the commands show; where a
// store README's images and links go. DOM-free and tested.

export interface StoreItem {
  /** `namespace.name`, lowercase: the id it installs under (a VS Code package's publisher.name). */
  id: string;
  namespace: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  /** Downloads on Open VSX, when it says. */
  downloads?: number;
  /** Average rating (0–5), when it has any. */
  rating?: number;
  /** Open VSX marks the namespace's owner as verified. */
  verified?: boolean;
  /** Its icon on Open VSX (an address `isStoreUrl` accepts); fetched by the backend. */
  iconUrl?: string;
}

/** An extension's page on Open VSX (`/api/{namespace}/{name}`): what its page shows. */
export interface StoreDetails extends StoreItem {
  /** Who published it (the namespace's display name, else the publisher's name). */
  publisher: string;
  /** When this version was released (ISO 8601). */
  released?: string;
  reviewCount?: number;
  /** The license's name ("MIT"). */
  license?: string;
  /** Web pages (http/https only). */
  homepage?: string;
  repository?: string;
  bugs?: string;
  categories: string[];
  /** Its tags without Open VSX's internal ones ("__web_extension"). */
  tags: string[];
  /** The .vsix's size in bytes, when Open VSX says. */
  size?: number;
  /** The VS Code versions it needs (`engines.vscode`). */
  engine?: string;
  preRelease?: boolean;
  deprecated?: boolean;
  /** An extension pack's members (namespace.name, as written), at most 50. */
  pack: string[];
  /** Its files on Open VSX (addresses `isStoreUrl` accepts). */
  files: { readme?: string; changelog?: string; manifest?: string; license?: string };
}

export interface StoreSearch {
  items: StoreItem[];
  total: number;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
const PART = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/;

/**
 * Whether the backend fetches from this address (the same hosts as src-tauri's
 * extensions/store.rs `allowed`): Open VSX's API and the storage its files are served from,
 * https only, no credentials.
 */
export function isStoreUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  return (
    u.protocol === "https:" &&
    !u.username &&
    !u.password &&
    (host === "open-vsx.org" ||
      host.endsWith(".open-vsx.org") ||
      host === "openvsx.eclipsecontent.org" ||
      host === "openvsxorg.blob.core.windows.net")
  );
}

/** A file address from Open VSX's JSON, when it's one the backend fetches. */
const storeFile = (v: unknown): string | undefined => {
  const s = str(v);
  return s && isStoreUrl(s) ? s : undefined;
};

/** A web page to open outside (http/https); a repository's "git+https://….git" as its page. */
export function webUrl(v: unknown): string | undefined {
  const s = str(v)
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
  return /^https?:\/\/[^\s/]+/i.test(s) && s.length < 2000 ? s : undefined;
}

/** The extension's page on the Open VSX website. */
export const storePageUrl = (item: { namespace: string; name: string }): string =>
  `https://open-vsx.org/extension/${encodeURIComponent(item.namespace)}/${encodeURIComponent(item.name)}`;

/** One extension from a search result or its details; null when it lacks a usable name. */
export function storeItem(raw: unknown): StoreItem | null {
  const x = obj(raw);
  const namespace = str(x.namespace);
  const name = str(x.name);
  const version = str(x.version);
  if (!PART.test(namespace) || !PART.test(name) || !PART.test(version)) return null;
  const downloads = num(x.downloadCount);
  const rating = num(x.averageRating);
  const iconUrl = storeFile(obj(x.files).icon);
  return {
    id: `${namespace}.${name}`.toLowerCase(),
    namespace,
    name,
    displayName: str(x.displayName) || name,
    description: str(x.description).slice(0, 500),
    version,
    ...(downloads !== undefined && { downloads }),
    ...(rating !== undefined && { rating: Math.min(5, rating) }),
    ...((x.verified === true || obj(x.namespaceAccess).verified === true) && { verified: true }),
    ...(iconUrl && { iconUrl }),
  };
}

/** Ids in Open VSX's `dependencies` / `bundledExtensions` ({namespace, extension}). */
export function extensionRefs(list: unknown): string[] {
  return (Array.isArray(list) ? list : []).flatMap((d) => {
    const o = obj(d);
    const namespace = str(o.namespace);
    const name = str(o.extension);
    return PART.test(namespace) && PART.test(name) ? [`${namespace}.${name}`] : [];
  });
}

/** An extension's details: its search fields, plus what its page shows. */
export function storeDetails(raw: unknown): StoreDetails | null {
  const item = storeItem(raw);
  if (!item) return null;
  const x = obj(raw);
  const by = obj(x.publishedBy);
  const files = obj(x.files);
  const strings = (v: unknown, max: number) =>
    (Array.isArray(v) ? v : [])
      .map(str)
      .filter((s) => s && s.length <= 60 && !s.startsWith("__"))
      .slice(0, max);
  const sizes = Object.values(obj(x.downloadSizes))
    .map(num)
    .filter((n): n is number => n !== undefined);
  const released = str(x.timestamp);
  const reviewCount = num(x.reviewCount);
  const license = str(x.license).slice(0, 100);
  const homepage = webUrl(x.homepage);
  const repository = webUrl(x.repository);
  const bugs = webUrl(x.bugs);
  const engine = str(obj(x.engines).vscode).slice(0, 40);
  const readme = storeFile(files.readme);
  const changelog = storeFile(files.changelog);
  const manifest = storeFile(files.manifest);
  const licenseFile = storeFile(files.license);
  return {
    ...item,
    publisher:
      str(x.namespaceDisplayName) || str(by.fullName) || str(by.loginName) || item.namespace,
    ...(released && !Number.isNaN(Date.parse(released)) && { released }),
    ...(reviewCount !== undefined && { reviewCount }),
    ...(license && { license }),
    ...(homepage && { homepage }),
    ...(repository && { repository }),
    ...(bugs && { bugs }),
    categories: strings(x.categories, 12),
    tags: strings(x.tags, 30),
    ...(sizes[0] !== undefined && { size: sizes[0] }),
    ...(engine && { engine }),
    ...(x.preRelease === true && { preRelease: true }),
    ...(x.deprecated === true && { deprecated: true }),
    pack: extensionRefs(x.bundledExtensions).slice(0, 50),
    files: {
      ...(readme && { readme }),
      ...(changelog && { changelog }),
      ...(manifest && { manifest }),
      ...(licenseFile && { license: licenseFile }),
    },
  };
}

/**
 * Where a README's image comes from (README images never load from the page itself, D210):
 * a data: image as it is, Open VSX's own files (a relative path resolves against the README's
 * address, as Open VSX serves a version's files side by side) through the store's fetch, other
 * https images through the Markdown preview's remote images. Null: show its alt text.
 */
export function readmeImageSource(
  src: string,
  base: string | undefined,
): { kind: "data" | "store" | "remote"; url: string } | null {
  const s = src.trim();
  if (/^data:image\//i.test(s)) return { kind: "data", url: s };
  let url: URL;
  try {
    url = base ? new URL(s, base) : new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  // A relative path that climbed out of Open VSX resolves somewhere else: nothing.
  if (isStoreUrl(url.href)) return { kind: "store", url: url.href };
  return /^https:\/\//i.test(s) ? { kind: "remote", url: url.href } : null;
}

/** A README's link: absolute http(s) as it is, a relative one against the README's address. */
export function readmeLink(href: string, base: string | undefined): string | null {
  const s = href.trim();
  if (!s || s.startsWith("#")) return null;
  try {
    const url = base ? new URL(s, base) : new URL(s);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** "9.8M", "12K", "512". */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(Math.round(n));
}

/** `/api/-/search`'s JSON. */
export function parseStoreSearch(text: string): StoreSearch {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Open VSX's answer isn't JSON.");
  }
  const x = obj(value);
  if (str(x.error)) throw new Error(str(x.error));
  const list = Array.isArray(x.extensions) ? x.extensions : [];
  const items = list.map(storeItem).filter((i): i is StoreItem => i !== null);
  return { items, total: num(x.totalSize) ?? items.length };
}

/** An extension's details (`/api/{namespace}/{name}`); null for Open VSX's "not found". */
export function parseStoreDetails(text: string): StoreDetails | null {
  try {
    const x = obj(JSON.parse(text));
    return str(x.error) ? null : storeDetails(x);
  } catch {
    return null;
  }
}

/**
 * Whether `latest` is newer than `installed` (semver's order: numbers part by part, and a
 * pre-release before its release). Versions that don't parse aren't newer.
 */
export function isNewerVersion(latest: string, installed: string): boolean {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v.trim());
    return m ? { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null } : null;
  };
  const a = parse(latest);
  const b = parse(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (d) return d > 0;
  }
  if (a.pre === b.pre) return false;
  if (a.pre === null) return true; // 1.2.0 after 1.2.0-beta
  if (b.pre === null) return false;
  return a.pre.localeCompare(b.pre, undefined, { numeric: true }) > 0;
}

/**
 * Whether a version released at `released` (ISO 8601) has been out `delayHours` by `now` (D267:
 * a brand-new version waits before it's offered as an update; one with no date isn't held back).
 */
export function oldEnough(released: string | undefined, now: number, delayHours: number): boolean {
  if (!released || !(delayHours > 0)) return true;
  const at = Date.parse(released);
  return Number.isNaN(at) || now - at >= delayHours * 3_600_000;
}

/**
 * The update to offer (D267): the newest version newer than `installed` that is old enough and
 * that `fits` (its `engines.vscode` against the VS Code version the IDE follows: installing picks
 * a release that fits, so a newer one that doesn't isn't an update). `newestFirst` are the
 * store's versions; `detailsOf` reads one's date and engine, asked for at most `maxLookups`
 * versions besides the latest.
 */
export async function offeredUpdate(
  installed: string,
  latest: { version: string; released?: string; engine?: string },
  newestFirst: readonly string[],
  detailsOf: (version: string) => Promise<{ released?: string; engine?: string } | undefined>,
  now: number,
  delayHours: number,
  fits: (engine: string | undefined) => boolean = () => true,
  maxLookups = 4,
): Promise<string | null> {
  if (!isNewerVersion(latest.version, installed)) return null;
  if (oldEnough(latest.released, now, delayHours) && fits(latest.engine)) return latest.version;
  let looked = 0;
  for (const v of newestFirst) {
    if (v === latest.version) continue;
    if (!isNewerVersion(v, installed) || looked >= maxLookups) return null;
    looked++;
    const d = await detailsOf(v).catch(() => undefined);
    if (oldEnough(d?.released, now, delayHours) && fits(d?.engine)) return v;
  }
  return null;
}

/** The store's categories, as Open VSX names them (themes and icon packs first, D254). */
export const STORE_CATEGORIES = [
  "Themes",
  "Snippets",
  "Programming Languages",
  "Formatters",
  "Linters",
  "Keymaps",
  "Other",
] as const;

/** The versions Open VSX has of an extension (its details' `allVersions`), newest first (D258). */
export function storeVersions(text: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const all = obj(obj(raw).allVersions);
  return Object.keys(all)
    .filter((v) => PART.test(v) && /^\d/.test(v))
    .sort((a, b) => (isNewerVersion(a, b) ? -1 : isNewerVersion(b, a) ? 1 : 0))
    .slice(0, 200);
}
