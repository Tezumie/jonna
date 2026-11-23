// What the browser's address bar means: a local dev server (shown in the tab through the preview
// proxy), a workspace file (served by the proxy as static files, reloaded on save) or another
// site (its own window). DOM-free, tested.
//
// A multi-root workspace (D251) has several folders: `Roots` is then the folder list, a file
// address is shown with its folder's name first ("api/index.html", read back the same way), and
// each folder is previewed by a proxy of its own (`rootFor`). With one folder it's its path.
import { isAbsolute, isWithin, relativePath, resolveInRoot } from "../../core/paths/index";
import { folderOf } from "../../core/workspace/workspaceFile";

/** A folder of a multi-root workspace. */
export interface RootFolder {
  path: string;
  name: string;
}

/** The workspace's folder (one), its folders (several), or null with nothing open. */
export type Roots = string | null | readonly RootFolder[];

/** `Roots` for a workspace: its folders when there are several, else its root. */
export function rootsOf(workspace: {
  root: { peek(): string | null };
  folders: { peek(): readonly RootFolder[] };
}): Roots {
  const folders = workspace.folders.peek();
  return folders.length > 1 ? folders : workspace.root.peek();
}

/** The folders of `roots` (one, unnamed, for a plain root). */
function foldersOf(roots: Roots): readonly RootFolder[] {
  if (roots === null) return [];
  return typeof roots === "string" ? [{ path: roots, name: "" }] : roots;
}

/** The folder whose proxy previews `path`: the one holding it, else the first. */
export function rootFor(roots: Roots, path: string): string | null {
  const folders = foldersOf(roots);
  return folderOf(folders, path)?.path ?? folders[0]?.path ?? null;
}

/** `text` (relative) inside the folders: "api/x.html" names a folder first when there are several. */
function resolveIn(folders: readonly RootFolder[], text: string): string | null {
  const [first] = folders;
  if (!first) return null;
  if (folders.length > 1) {
    const clean = text.replace(/^\.?[\\/]+/, "");
    const [head, ...rest] = clean.split(/[\\/]/);
    const named = folders.find((f) => f.name === head);
    if (named) return rest.length ? resolveInRoot(named.path, rest.join("/")) : named.path;
  }
  return resolveInRoot(first.path, text);
}

export type Address =
  | { kind: "local"; url: string }
  | { kind: "file"; path: string }
  | { kind: "external"; url: string };

const LOCAL_HOST = /^(localhost|[\w-]+\.localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/i;

/** True for http URLs on this machine (what the preview proxy serves). */
export function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" && LOCAL_HOST.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Reads what was typed: "localhost:5173", "http://127.0.0.1:3000/x", "https://example.com",
 * "example.com", "index.html" / "site/" (workspace files), or an absolute path inside the folder.
 */
export function parseAddress(input: string, roots: Roots): Address | null {
  const text = input.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) {
    return isLocalUrl(text) ? { kind: "local", url: text } : { kind: "external", url: text };
  }
  if (
    /^(localhost|[\w-]+\.localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(
      text,
    ) ||
    /^:\d+(\/|$)/.test(text)
  ) {
    const url = `http://${text.startsWith(":") ? `localhost${text}` : text}`;
    return { kind: "local", url };
  }
  const folders = foldersOf(roots);
  if (folders.length) {
    const path = isAbsolute(text) ? text : resolveIn(folders, text);
    if (
      path &&
      folders.some((f) => isWithin(f.path, path)) &&
      (isAbsolute(text) || !/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(text) || /\.html?$/i.test(text))
    )
      return { kind: "file", path };
  }
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(text))
    return { kind: "external", url: `https://${text}` };
  return null;
}

/**
 * The workspace files an address may show, for checks on what a caller may see (never for
 * opening): the file a file address names (as typed, as a `file:` URL, without its `?…` / `#…`),
 * and for a page on this machine the file its path names in each folder — static previews serve
 * a folder at its paths, and so do most dev servers.
 */
export function addressFiles(input: string, roots: Roots): string[] {
  const folders = foldersOf(roots);
  const text = input.trim();
  if (!text || !folders.length) return [];
  const spellings = new Set([text, text.split(/[?#]/)[0] ?? text]);
  if (/^file:/i.test(text)) {
    try {
      // "file:///C:/x/.env" → "C:/x/.env"; "file:///home/x/.env" stays absolute.
      const path = decodeURIComponent(new URL(text).pathname);
      spellings.add(path.replace(/^\/+(?=[A-Za-z]:[\\/])/, ""));
    } catch {
      spellings.add(text.replace(/^file:\/*/i, "/"));
    }
  }
  const out = new Set<string>();
  for (const spelling of spellings) {
    const address = parseAddress(spelling, roots);
    if (address?.kind === "file") out.add(address.path);
    if (address?.kind !== "local") continue;
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(address.url).pathname).replace(/^\/+/, "");
    } catch {
      continue;
    }
    if (!rel) continue;
    for (const folder of folders) {
      const path = resolveInRoot(folder.path, rel);
      if (isWithin(folder.path, path)) out.add(path);
    }
  }
  return [...out];
}

/** The proxy URL for a workspace file (static previews serve the whole folder). */
export function fileUrl(origin: string, root: string, path: string): string {
  const rel = relativePath(root, path).replaceAll("\\", "/");
  return `${origin}/${rel.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`;
}

/** A proxy URL back to the workspace path it serves (null for other origins). */
export function pathFromUrl(origin: string, root: string, url: string): string | null {
  if (!url.startsWith(`${origin}/`) && url !== origin) return null;
  const pathname = new URL(url).pathname;
  const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  return rel ? resolveInRoot(root, rel) : root;
}

/** Shown in the address bar: workspace files relative to the folder (with its name, of several). */
export function displayAddress(address: Address, roots: Roots): string {
  if (address.kind !== "file") return address.url;
  if (roots === null) return address.path;
  if (typeof roots === "string")
    return relativePath(roots, address.path).replaceAll("\\", "/") || "/";
  const folder = folderOf(roots, address.path);
  if (!folder) return address.path;
  const rel = relativePath(folder.path, address.path).replaceAll("\\", "/");
  if (roots.length === 1) return rel || "/";
  return rel ? `${folder.name}/${rel}` : `${folder.name}/`;
}
