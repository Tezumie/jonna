// MCP server icons: `serverInfo.icons` from initialize (MCP 2025-11-25) and server.json's
// `icons` in the registry, both `[{ src, mimeType?, sizes?, theme? }]`. Anyone can publish them,
// so only two kinds are kept: data: images (PNG, JPEG, WebP, GIF; SVG only when it passes the
// same check as the ACP registry's icons: no script, handler, link or style) and https
// addresses, which the backend fetches (`remote_image`: public hosts, image types; the window's
// CSP loads nothing remote). One is picked for the theme and size. DOM-free and tested.
import { sanitizeSvg } from "../acp/registry";

export interface McpIcon {
  /** A data: URL, or an https address to fetch through the backend. */
  src: string;
  mimeType?: string;
  /** "48x48", "any". */
  sizes?: string[];
  /** The background it's drawn for. */
  theme?: "light" | "dark";
  /** A checked one-color SVG (currentColor): shown as a mask in the text color. */
  mono?: boolean;
}

const MAX_ICONS = 8;
/** A data: URL's length at most (about 190 KB of picture). */
const MAX_DATA_URL = 256 * 1024;
const RASTER = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;
const MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];
const SIZE = /^(\d{1,4}x\d{1,4}|any)$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** An https address with no user name or password (the backend refuses private hosts). */
function httpsUrl(src: string): boolean {
  try {
    const u = new URL(src);
    return u.protocol === "https:" && !u.username && !u.password && src.length <= 2048;
  } catch {
    return false;
  }
}

/** A data: SVG decoded, or null. */
function svgText(src: string): string | null {
  const b64 = /^data:image\/svg\+xml;base64,([A-Za-z0-9+/]+={0,2})$/.exec(src);
  try {
    if (b64)
      return new TextDecoder().decode(Uint8Array.from(atob(b64[1] ?? ""), (c) => c.charCodeAt(0)));
    const plain = /^data:image\/svg\+xml(?:;charset=[\w-]+)?(?:;utf8)?,(.*)$/s.exec(src);
    return plain ? decodeURIComponent(plain[1] ?? "") : null;
  } catch {
    return null;
  }
}

/** One icon as given, checked; null when it's none the IDE shows. */
export function parseIcon(v: unknown): McpIcon | null {
  if (!isObject(v) || typeof v.src !== "string") return null;
  const src = v.src.trim();
  const mimeType =
    typeof v.mimeType === "string" && MIME_TYPES.includes(v.mimeType.toLowerCase())
      ? v.mimeType.toLowerCase()
      : undefined;
  const sizes = Array.isArray(v.sizes)
    ? v.sizes.filter((s): s is string => typeof s === "string" && SIZE.test(s)).slice(0, 8)
    : [];
  const theme: McpIcon["theme"] = v.theme === "light" || v.theme === "dark" ? v.theme : undefined;
  const extra: Pick<McpIcon, "sizes" | "theme"> = {
    ...(sizes.length && { sizes }),
    ...(theme && { theme }),
  };
  if (src.startsWith("data:")) {
    if (src.length > MAX_DATA_URL) return null;
    const raster = RASTER.exec(src);
    if (raster) return { src, mimeType: raster[1] as string, ...extra };
    const svg = svgText(src);
    const checked = svg ? sanitizeSvg(svg) : null;
    return checked
      ? {
          src: checked.src,
          mimeType: "image/svg+xml",
          ...extra,
          ...(checked.mono && { mono: true }),
        }
      : null;
  }
  // A declared type that isn't a picture (or an unknown one): left out, as the spec allows.
  if (typeof v.mimeType === "string" && !mimeType) return null;
  return httpsUrl(src) ? { src, ...(mimeType && { mimeType }), ...extra } : null;
}

/** A list of icons checked (the ones the IDE can't show left out). */
export function parseIcons(v: unknown): McpIcon[] {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, MAX_ICONS * 2)
    .map(parseIcon)
    .filter((i): i is McpIcon => i !== null)
    .slice(0, MAX_ICONS);
}

/** The largest side an icon says it has (Infinity: "any" or an SVG; 0: not said). */
function largest(icon: McpIcon): number {
  if (icon.mimeType === "image/svg+xml" || icon.sizes?.includes("any"))
    return Number.POSITIVE_INFINITY;
  let best = 0;
  for (const s of icon.sizes ?? []) {
    const [w, h] = s.split("x").map(Number);
    best = Math.max(best, Math.min(w ?? 0, h ?? 0));
  }
  return best;
}

/**
 * The icon to show at `px` (device pixels) on a `theme` background: one for that theme (or for
 * any), then one that scales, else the smallest that's big enough, else the biggest; a data:
 * one over an address to fetch when they're as good.
 */
export function pickIcon(
  icons: readonly McpIcon[],
  theme: "light" | "dark",
  px = 40,
): McpIcon | null {
  if (!icons.length) return null;
  const forTheme = icons.filter((i) => !i.theme || i.theme === theme);
  const pool = forTheme.length ? forTheme : [...icons];
  const score = (i: McpIcon) => {
    const size = largest(i);
    // Scales: best; big enough: the smaller the better; too small (or unknown): the bigger the better.
    const fit =
      size === Number.POSITIVE_INFINITY
        ? 3_000_000
        : size >= px
          ? 2_000_000 - Math.min(size, 1_000_000)
          : size;
    return fit * 2 + (i.src.startsWith("data:") ? 1 : 0);
  };
  return pool.reduce((best, i) => (score(i) > score(best) ? i : best));
}
