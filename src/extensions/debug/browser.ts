// Debugging code in a browser (D196): launch.json's "chrome" / "msedge" configurations (also
// "pwa-chrome", "pwa-msedge", VS Code's js-debug names). The IDE starts Chrome or Edge with a
// remote-debugging port and a profile of its own, attaches to the page over the Chrome DevTools
// Protocol (the same CdpSession as Node, cdp.ts) and then opens `url`, so breakpoints are set
// before the page's scripts run. "request": "attach" attaches to a browser already started with
// --remote-debugging-port (`port`, default 9222), to the page whose address starts with `url`.
//
// Scripts are mapped to files like js-debug does: a URL's path under `webRoot` (default the
// folder), or through `pathMapping` ({ "/static/": "${workspaceFolder}/public/" }); Vite's
// `/@fs/…` paths are absolute files; source maps (inline, or served next to the script by the dev
// server) take a bundle back to its sources, `webpack://` ones included. DOM-free and tested.

export interface PageMapping {
  /** The folder the page's root URL path serves (js-debug's webRoot). */
  webRoot: string;
  /** URL path prefix → folder, longest prefix first. */
  pathMapping: Record<string, string>;
  windows: boolean;
  caseInsensitive: boolean;
}

const BROWSER_TYPES = /^(pwa-)?(chrome|msedge|edge)$/i;

/** Whether a launch.json type is a browser's. */
export function isBrowserType(type: string): boolean {
  return BROWSER_TYPES.test(type);
}

/** decodeURIComponent, or the text as is when it holds a malformed escape ("%zz"). */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A URL path segment as browsers write it: only what must be escaped is (":", "[", "@" stay). */
const encodeSegment = (s: string) =>
  encodeURI(s)
    .replace(/%5B/g, "[")
    .replace(/%5D/g, "]")
    .replace(/[?#]/g, (c) => encodeURIComponent(c));

const join = (dir: string, rel: string, windows: boolean): string => {
  const sep = windows ? "\\" : "/";
  const base = dir.replace(/[\\/]+$/, "");
  const tail = rel.replace(/^[\\/]+/, "");
  return tail ? `${base}${sep}${windows ? tail.replace(/\//g, "\\") : tail}` : base;
};

/** A script or source URL → the file it comes from (null: not served from the project). */
export function pageScriptPath(url: string, m: PageMapping): string | null {
  if (!url) return null;
  // webpack://name/./src/a.ts and webpack:///src/a.ts → under webRoot.
  const webpack = /^webpack:\/\/[^/]*\/(?:\.\/)?(.*)$/.exec(url);
  if (webpack)
    return webpack[1]?.startsWith("node_modules/")
      ? null
      : join(m.webRoot, webpack[1] ?? "", m.windows);
  if (url.startsWith("file://")) {
    let path = safeDecode(url.slice(7));
    if (m.windows) path = path.replace(/^\/([a-zA-Z]:)/, "$1").replace(/\//g, "\\");
    return path;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const path = safeDecode(parsed.pathname);
  // Vite serves files outside its root as /@fs/<absolute path>.
  if (path.startsWith("/@fs/")) {
    const abs = path.slice(4);
    return m.windows ? abs.replace(/^\/([a-zA-Z]:)/, "$1").replace(/\//g, "\\") : abs;
  }
  const prefixes = Object.keys(m.pathMapping).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    const p = prefix.endsWith("/") ? prefix : `${prefix}/`;
    if (path === prefix || path.startsWith(p))
      return join(m.pathMapping[prefix] ?? "", path.slice(p.length - 1), m.windows);
  }
  return join(m.webRoot, path, m.windows);
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** setBreakpointByUrl's regex for the scripts served from `path` (any host, any query). */
export function pageUrlRegex(path: string, m: PageMapping): string {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const file = norm(path);
  const fold = (s: string) =>
    m.caseInsensitive
      ? [...s]
          .map((c) =>
            c.toLowerCase() !== c.toUpperCase() ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c,
          )
          .join("")
      : s;
  const under = (root: string): string | null => {
    const r = norm(root);
    const same = m.caseInsensitive
      ? file.toLowerCase().startsWith(`${r.toLowerCase()}/`)
      : file.startsWith(`${r}/`);
    return same ? file.slice(r.length) : null;
  };
  // The URL paths that serve this file: through a mapping, under webRoot, and /@fs/.
  const urlPaths: string[] = [];
  for (const [prefix, dir] of Object.entries(m.pathMapping)) {
    const rest = under(dir);
    if (rest !== null) urlPaths.push(`${prefix.replace(/\/+$/, "")}${rest}`);
  }
  const rest = under(m.webRoot);
  if (rest !== null) urlPaths.push(rest);
  urlPaths.push(`/@fs${file.startsWith("/") ? "" : "/"}${file}`);
  // As the browser writes it, or fully escaped (servers differ): either matches.
  const alts = [...new Set(urlPaths)].flatMap((u) => {
    const light = u.split("/").map(encodeSegment).join("/");
    const full = u.split("/").map(encodeURIComponent).join("/");
    return [...new Set([light, full])].map((x) => fold(escapeRegex(x)));
  });

  return `^https?:\\/\\/[^\\/]+(?:${alts.join("|")})(?:[?#].*)?$`;
}

/** The page target to debug in `/json/list`: the one whose address starts with `url`, else the first page. */
export function pickPageTarget(
  targets: readonly { type?: string; url?: string; webSocketDebuggerUrl?: string }[],
  url?: string,
): string | null {
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const wanted = url?.replace(/\*.*$/, "");
  const match = wanted ? pages.find((t) => t.url?.startsWith(wanted)) : undefined;
  return (match ?? pages[0])?.webSocketDebuggerUrl ?? null;
}

/**
 * The browser pane's frame on the IDE's own WebView2 debugging port (D204): the frame or page
 * whose address starts with `origin` (the pane's proxy). Never the first page as a fallback —
 * that would be the IDE's own window.
 */
export function pickFrameTarget(
  targets: readonly { type?: string; url?: string; webSocketDebuggerUrl?: string }[],
  origin: string,
): string | null {
  if (!origin) return null;
  const hit = targets.find(
    (t) =>
      (t.type === "iframe" || t.type === "page") &&
      t.webSocketDebuggerUrl &&
      t.url?.startsWith(origin),
  );
  return hit?.webSocketDebuggerUrl ?? null;
}
