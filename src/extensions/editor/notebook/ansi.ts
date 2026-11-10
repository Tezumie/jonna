// ANSI colors in notebook outputs (tracebacks, colored logs; D188): SGR sequences become spans
// colored with the terminal's palette tokens; any other escape sequence is dropped. DOM-free core
// (`ansiSegments`, tested) plus a small DOM builder.

export interface AnsiStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const token = (i: number, bright: boolean) =>
  `var(--terminal-ansi-${bright ? "bright-" : ""}${NAMES[i]})`;

/** A color the output itself chose (256-color or truecolor codes): data, not a theme color. */
const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0")).join("")}`;

/** xterm's 256-color palette: 16 named, a 6×6×6 cube, 24 greys. */
function color256(n: number): string {
  if (n < 8) return token(n, false);
  if (n < 16) return token(n - 8, true);
  if (n < 232) {
    const c = n - 16;
    const v = (x: number) => (x === 0 ? 0 : 55 + x * 40);
    return hex(v(Math.floor(c / 36)), v(Math.floor(c / 6) % 6), v(c % 6));
  }
  const g = 8 + (n - 232) * 10;
  return hex(g, g, g);
}

// Escape sequences (CSI, OSC, charset and keypad modes), built from a string: ESC and BEL.
const ESC = "\u001b";
const SEQUENCE = new RegExp(
  `${ESC}\\[([0-9;:]*)([A-Za-z])|${ESC}\\][^\u0007${ESC}]*(?:\u0007|${ESC}\\\\)|${ESC}[()][A-Z0-9]|${ESC}[=>]`,
  "g",
);

export function ansiSegments(text: string): AnsiSegment[] {
  const out: AnsiSegment[] = [];
  let style: AnsiStyle = {};
  let last = 0;
  const push = (t: string) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev && JSON.stringify(prev.style) === JSON.stringify(style)) prev.text += t;
    else out.push({ text: t, style: { ...style } });
  };
  for (const m of text.matchAll(SEQUENCE)) {
    push(text.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    if (m[2] !== "m") continue; // cursor moves, erases: dropped
    const codes = (m[1] || "0").split(/[;:]/).map((c) => Number(c) || 0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i] ?? 0;
      if (c === 0) style = {};
      else if (c === 1) style.bold = true;
      else if (c === 2) style.dim = true;
      else if (c === 3) style.italic = true;
      else if (c === 4) style.underline = true;
      else if (c === 7) style.inverse = true;
      else if (c === 22) {
        delete style.bold;
        delete style.dim;
      } else if (c === 23) delete style.italic;
      else if (c === 24) delete style.underline;
      else if (c === 27) delete style.inverse;
      else if (c >= 30 && c <= 37) style.fg = token(c - 30, false);
      else if (c >= 90 && c <= 97) style.fg = token(c - 90, true);
      else if (c >= 40 && c <= 47) style.bg = token(c - 40, false);
      else if (c >= 100 && c <= 107) style.bg = token(c - 100, true);
      else if (c === 39) delete style.fg;
      else if (c === 49) delete style.bg;
      else if (c === 38 || c === 48) {
        const key = c === 38 ? "fg" : "bg";
        if (codes[i + 1] === 5 && codes[i + 2] !== undefined) {
          style[key] = color256(codes[i + 2] ?? 0);
          i += 2;
        } else if (codes[i + 1] === 2 && codes[i + 4] !== undefined) {
          style[key] = hex(codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0);
          i += 4;
        }
      }
    }
  }
  push(text.slice(last));
  return out;
}

/** Spans for `text` (escaped: text nodes only). */
export function ansiNodes(text: string): Node[] {
  return ansiSegments(text).map(({ text: t, style }) => {
    if (!Object.keys(style).length) return document.createTextNode(t);
    const span = document.createElement("span");
    span.textContent = t;
    const fg = style.inverse ? (style.bg ?? "var(--bg-surface)") : style.fg;
    const bg = style.inverse ? (style.fg ?? "var(--fg-default)") : style.bg;
    if (fg) span.style.color = fg;
    if (bg) span.style.backgroundColor = bg;
    if (style.bold) span.style.fontWeight = "600";
    if (style.dim) span.style.opacity = "0.7";
    if (style.italic) span.style.fontStyle = "italic";
    if (style.underline) span.style.textDecoration = "underline";
    return span;
  });
}
