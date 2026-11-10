// Agent faces (D230): a small generated character for each agent, so a list of agents reads at a
// glance (who's working, who needs you). A face is a soft body shape in one of the theme's face
// colors with a pair of eyes; it's written in an agent's file as a short code (`icon: blob-3-dots`)
// and, when the file has none, derived from the agent's name, so every agent has a stable face.
// "Randomize" in the editor picks another. Our own design; drawn as SVG with theme tokens
// (`--face-1` … `--face-8`, `--face-eye`), no colors in code. DOM-free and tested.

export const FACE_SHAPES = [
  "round",
  "squircle",
  "blob",
  "drop",
  "cloud",
  "pebble",
  "bean",
  "peak",
] as const;
export type FaceShape = (typeof FACE_SHAPES)[number];

export const FACE_EYES = ["dots", "tall", "wide", "happy", "sleepy", "wink"] as const;
export type FaceEyes = (typeof FACE_EYES)[number];

/** How many face colors the theme defines (`--face-1` … `--face-8`). */
export const FACE_COLORS = 8;

export interface FaceSpec {
  shape: FaceShape;
  /** 1 … FACE_COLORS. */
  color: number;
  eyes: FaceEyes;
  /**
   * Set when the agent shows its model's logo instead (D270): the model's key, or "" for the
   * default model. The shape, color and eyes stay for where no logo is found.
   */
  model?: string;
}

/** The icon code that shows the agent's model's logo (D270); also what no icon means. */
export const MODEL_ICON = "model";

/** Whether an agent's icon code shows its model's logo: `model`, or none at all (D270). */
export function isModelIcon(icon: string | undefined | null): boolean {
  const code = (icon ?? "").trim().toLowerCase();
  return !code || code === MODEL_ICON;
}

/**
 * The main agent's face (the IDE's own agent, not a file): color 0 is its own neutral tone
 * (`--face-main`), so it never looks like one of the user's agents.
 */
export const MAIN_AGENT_FACE: FaceSpec = { shape: "squircle", color: 0, eyes: "dots" };

/** FNV-1a: a stable 32-bit hash of a string. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The face a name gets when its file sets none: the same name, the same face. */
export function faceFromSeed(seed: string): FaceSpec {
  const h = hash(seed.trim().toLowerCase());
  return {
    shape: FACE_SHAPES[h % FACE_SHAPES.length] ?? "round",
    color: (Math.floor(h / FACE_SHAPES.length) % FACE_COLORS) + 1,
    eyes:
      FACE_EYES[Math.floor(h / (FACE_SHAPES.length * FACE_COLORS)) % FACE_EYES.length] ?? "dots",
  };
}

/** Another face, different from `current` in at least its shape or color ("Randomize"). */
export function randomFace(current?: FaceSpec, random: () => number = Math.random): FaceSpec {
  const pick = <T>(list: readonly T[]): T =>
    list[Math.floor(random() * list.length) % list.length] as T;
  for (let i = 0; i < 8; i++) {
    const next: FaceSpec = {
      shape: pick(FACE_SHAPES),
      color: (Math.floor(random() * FACE_COLORS) % FACE_COLORS) + 1,
      eyes: pick(FACE_EYES),
    };
    if (!current || next.shape !== current.shape || next.color !== current.color) return next;
  }
  return { ...(current ?? MAIN_AGENT_FACE), color: ((current?.color ?? 0) % FACE_COLORS) + 1 };
}

/** The face without its model's logo: the character it shows otherwise. */
export function characterFace(face: FaceSpec): FaceSpec {
  return { shape: face.shape, color: face.color, eyes: face.eyes };
}

/** The icon code a face is written as: `model` for a model's logo, else its face code (D270). */
export function iconCode(face: FaceSpec): string {
  return face.model !== undefined ? MODEL_ICON : encodeFace(face);
}

/** The code written in an agent's file: `shape-color-eyes` (`blob-3-dots`). */
export function encodeFace(face: FaceSpec): string {
  return `${face.shape}-${face.color}-${face.eyes}`;
}

/** A face code back to a face; null when it isn't one (an unknown part, a color out of range). */
export function parseFace(code: string | undefined | null): FaceSpec | null {
  const m = /^([a-z]+)-(\d+)-([a-z]+)$/.exec((code ?? "").trim().toLowerCase());
  if (!m) return null;
  const shape = FACE_SHAPES.find((s) => s === m[1]);
  const eyes = FACE_EYES.find((e) => e === m[3]);
  const color = Number(m[2]);
  if (!shape || !eyes || !Number.isInteger(color) || color < 1 || color > FACE_COLORS) return null;
  return { shape, color, eyes };
}

/**
 * An agent's face: its file's code when valid; its model's logo when the code is `model` or there
 * is none (D270: `model` is the agent's model key, null for the default model); else the face its
 * name gives.
 */
export function agentFace(icon: string | undefined, name: string, model?: string | null): FaceSpec {
  const face = parseFace(icon);
  if (face) return face;
  const seeded = faceFromSeed(name);
  return isModelIcon(icon) ? { ...seeded, model: model ?? "" } : seeded;
}

/** Body outlines in a 32×32 box; `eyeY` is where the eyes sit on that body. */
const BODIES: Record<FaceShape, { svg: string; eyeY: number; eyeX?: number }> = {
  round: { svg: '<circle cx="16" cy="16.5" r="12.5"/>', eyeY: 15.5 },
  squircle: { svg: '<rect x="3.5" y="4.5" width="25" height="24" rx="9"/>', eyeY: 15.5 },
  blob: {
    svg: '<path d="M17 3.5c6.8 0 11.5 5 11.5 11.8 0 7.9-5.3 13.7-12.9 13.7C9 29 3.5 24.4 3.5 17.6 3.5 9.6 9.3 3.5 17 3.5z"/>',
    eyeY: 15,
  },
  drop: {
    svg: '<path d="M5 4.5c10-.8 23.5 4.6 23.5 14.6 0 6.2-5.1 10.4-11.6 10.4C9.6 29.5 4 24.4 4 17.2 4 12.3 5.3 8.2 5 4.5z"/>',
    eyeY: 17,
    eyeX: 17,
  },
  cloud: {
    svg: '<path d="M10.5 8.6a6.2 6.2 0 0 1 11.2-.8 6 6 0 0 1 5.6 7 6.3 6.3 0 0 1-1.6 11.4c-2.3 1.9-5.6 2.8-9.7 2.8s-7.4-.9-9.7-2.8A6.3 6.3 0 0 1 4.7 14.8a6.1 6.1 0 0 1 5.8-6.2z"/>',
    eyeY: 17.5,
  },
  pebble: { svg: '<ellipse cx="16" cy="17.5" rx="13" ry="10.5"/>', eyeY: 16.5 },
  bean: {
    svg: '<path d="M7.6 7.8c4.2-4.8 13.1-4.3 17.2.7 4.2 5 5 13.2-.4 17.4-5.5 4.2-14.6 3.6-18.5-1.4C2 19.6 3.4 12.6 7.6 7.8z"/>',
    eyeY: 15.5,
  },
  peak: {
    svg: '<path d="M16 3.8c1.6 0 2.7 1 3.6 2.6l8.6 15.9c1.3 2.5-.3 5.2-3.1 5.2H6.9c-2.8 0-4.4-2.7-3.1-5.2l8.6-15.9c.9-1.6 2-2.6 3.6-2.6z"/>',
    eyeY: 19.5,
  },
};

/** The two eyes at (cx ± gap, y). */
function eyesSvg(style: FaceEyes, cx: number, y: number): string {
  const gap = 4.2;
  const left = cx - gap;
  const right = cx + gap;
  const dot = (x: number) => `<circle cx="${x}" cy="${y}" r="2.1"/>`;
  const arc = (x: number) =>
    `<path d="M${x - 2} ${y + 0.8}q2-2.8 4 0" fill="none" stroke-width="1.6" stroke-linecap="round"/>`;
  switch (style) {
    case "dots":
      return dot(left) + dot(right);
    case "tall":
      return [left, right]
        .map((x) => `<rect x="${x - 1.2}" y="${y - 2.4}" width="2.4" height="4.8" rx="1.2"/>`)
        .join("");
    case "wide":
      return [left, right].map((x) => `<ellipse cx="${x}" cy="${y}" rx="2.3" ry="1.6"/>`).join("");
    case "happy":
      return arc(left) + arc(right);
    case "sleepy":
      return [left, right]
        .map(
          (x) =>
            `<path d="M${x - 2} ${y}h4" fill="none" stroke-width="1.6" stroke-linecap="round"/>`,
        )
        .join("");
    case "wink":
      return dot(left) + arc(right);
  }
}

/**
 * The face as SVG markup (fills from theme tokens, so it follows light and dark). The eyes are a
 * group of their own (`.face-eyes`) so CSS can make a working agent look around or blink.
 */
export function faceSvg(face: FaceSpec, size = 24): string {
  const body = BODIES[face.shape];
  const color =
    face.color === 0 ? "main" : Math.min(FACE_COLORS, Math.max(1, Math.round(face.color)));
  return (
    `<svg class="face" viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true">` +
    `<g class="face-body" fill="var(--face-${color})">${body.svg}</g>` +
    `<g class="face-eyes" fill="var(--face-eye)" stroke="var(--face-eye)">${eyesSvg(face.eyes, body.eyeX ?? 16, body.eyeY)}</g>` +
    "</svg>"
  );
}
