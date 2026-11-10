// Parses computed CSS colors into hex for consumers that need it (Monaco, the terminal).
// Browsers serialize computed colors as `rgb()`, `rgba()` or `color(srgb r g b / a)` (color-mix
// results). DOM-free.

export interface Rgba {
  r: number; // 0–255
  g: number;
  b: number;
  a: number; // 0–1
}

export function parseCssColor(value: string): Rgba | null {
  // Values can come from a stored theme or an extension's: anything but a string isn't a color.
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex) return parseHex(hex);
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(
    v,
  );
  if (rgb) return { r: num(rgb[1]), g: num(rgb[2]), b: num(rgb[3]), a: alpha(rgb[4]) };
  const srgb =
    /^color\(\s*srgb\s+([\d.e+-]+)\s+([\d.e+-]+)\s+([\d.e+-]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(
      v,
    );
  if (srgb) {
    return {
      r: num(srgb[1]) * 255,
      g: num(srgb[2]) * 255,
      b: num(srgb[3]) * 255,
      a: alpha(srgb[4]),
    };
  }
  return null;
}

function parseHex(h: string): Rgba | null {
  const full = h.length <= 4 ? [...h].map((c) => c + c).join("") : h;
  if (full.length !== 6 && full.length !== 8) return null;
  const at = (i: number) => Number.parseInt(full.slice(i, i + 2), 16);
  return { r: at(0), g: at(2), b: at(4), a: full.length === 8 ? at(6) / 255 : 1 };
}

const num = (s: string | undefined) => Number(s ?? 0);
const alpha = (s: string | undefined) =>
  s === undefined ? 1 : s.endsWith("%") ? Number(s.slice(0, -1)) / 100 : Number(s);
const byte = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, "0");

/** `#rrggbb`, or `#rrggbbaa` when not opaque. */
export function toHex(c: Rgba): string {
  const base = `#${byte(c.r)}${byte(c.g)}${byte(c.b)}`;
  return c.a >= 1 ? base : `${base}${byte(c.a * 255)}`;
}

/** Composites `top` over an opaque `bottom` (for consumers without alpha support). */
export function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

/** Same color with a different alpha (e.g. "accent at 28%"). */
export function withAlpha(c: Rgba, a: number): Rgba {
  return { ...c, a };
}
